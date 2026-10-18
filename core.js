/*
 * 习惯记录 · 启动页核心逻辑（启动页页面和 Service Worker 共用）。
 * 这里只有通用的“下载 / 缓存 / 更新”逻辑，不含 App 代码，也不含任何个人数据或密钥。
 */
(function (root) {
  'use strict';

  var CONFIG = {
    owner: 'SuperPhant',
    appRepo: 'habit-tracker',
    dataRepo: 'habit-tracker-data',
    branch: 'main',
    appDir: 'app/',
    apiBase: 'https://api.github.com'
  };

  var DB_NAME = 'habit-launcher';
  var DB_VERSION = 1;
  var STORE = 'kv';
  var APP_CACHE_PREFIX = 'habit-app-';

  // ---------- 本地存储（IndexedDB，页面、Service Worker、App 都能读） ----------
  var dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { dbPromise = null; reject(req.error); };
      req.onblocked = function () { dbPromise = null; reject(new Error('本地数据库被占用，请关闭其他标签页后重试')); };
    });
    return dbPromise;
  }

  function kvOp(mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var store = tx.objectStore(STORE);
        var result;
        var req = fn(store);
        if (req) req.onsuccess = function () { result = req.result; };
        tx.oncomplete = function () { resolve(result); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('写入本地数据库失败')); };
      });
    });
  }

  function kvGet(key) { return kvOp('readonly', function (s) { return s.get(key); }); }
  function kvSet(key, value) { return kvOp('readwrite', function (s) { return s.put(value, key); }); }
  function kvDel(key) { return kvOp('readwrite', function (s) { return s.delete(key); }); }

  // ---------- 错误 ----------
  function LauncherError(code, message, detail) {
    var e = new Error(message);
    e.name = 'LauncherError';
    e.code = code;
    e.detail = detail || null;
    return e;
  }

  var REPOS_HINT = '在 GitHub 网页上打开：右上角头像 → Settings → Developer settings → Personal access tokens → Fine-grained tokens，点这把密钥，在 Repository access 里勾选 ' + CONFIG.appRepo + ' 和 ' + CONFIG.dataRepo + '，保存；或者按下面的步骤重新生成一把。';

  /** 把错误翻译成给用户看的中文：{ title, detail } */
  function describeError(e) {
    var code = (e && (e.code || e.kind)) || 'unknown';
    switch (code) {
      case 'format':
        return { title: '这看起来不是 GitHub 密钥', detail: '密钥一般以 github_pat_ 开头，很长。请回到 GitHub 重新点复制按钮，再粘贴到这里。' };
      case 'unauthorized':
        return { title: '密钥无效（GitHub 返回 401）', detail: '这把密钥可能复制不完整、已过期，或者已经在 GitHub 上删除了。请按下面的步骤重新生成一把。' };
      case 'wrong-account':
        return { title: '密钥不是 ' + CONFIG.owner + ' 账号的', detail: '这把密钥属于 GitHub 账号「' + ((e.detail && e.detail.login) || '其他账号') + '」。请切换到 ' + CONFIG.owner + ' 账号重新生成：在 GitHub 网页右上角点头像，确认显示的是 ' + CONFIG.owner + '（不是的话先切换账号或退出后用 ' + CONFIG.owner + ' 登录），再点“去 GitHub 生成密钥”。' };
      case 'repo-access':
        return { title: '密钥没有勾选仓库：' + ((e.detail && e.detail.missing) || []).join('、'), detail: '生成密钥时 Repository access 要选 Only select repositories，并勾选 ' + CONFIG.appRepo + ' 和 ' + CONFIG.dataRepo + ' 两个仓库。' + REPOS_HINT };
      case 'forbidden':
        return { title: '没有权限（GitHub 返回 403）', detail: '密钥的权限不够。请确认 Repository permissions 里的 Contents 是 Read and write，并且勾选了 ' + CONFIG.appRepo + ' 和 ' + CONFIG.dataRepo + '。' };
      case 'ratelimit':
        return { title: 'GitHub 暂时限制了请求次数', detail: '短时间内请求太多了（403/429）。请过几分钟再试。' };
      case 'notfound':
        return { title: '找不到仓库或文件（GitHub 返回 404）', detail: '可能是密钥没有勾选 ' + CONFIG.appRepo + ' 仓库，或者仓库里还没有 App 代码。' + REPOS_HINT };
      case 'network':
        return { title: '网络连接失败', detail: '请检查网络后重试。如果这台设备已经下载过 App，离线时也能直接打开。' };
      case 'server':
        return { title: 'GitHub 服务暂时出错', detail: 'GitHub 返回了 5xx 错误，一般过一会儿就好，请稍后重试。' };
      case 'no-app':
        return { title: '私有仓库里没有找到 App', detail: '仓库 ' + CONFIG.owner + '/' + CONFIG.appRepo + ' 的 main 分支上没有 app/index.html。' };
      case 'too-big':
        return { title: 'App 文件太多', detail: 'GitHub 返回的文件列表不完整，无法下载。' };
      case 'storage':
        return { title: '这台设备的存储空间不够或被禁用了', detail: '请清理一些空间，或者不要使用无痕/隐私浏览模式。' };
      default:
        return { title: '出错了', detail: (e && e.message) || '未知错误，请重试。' };
    }
  }

  // ---------- GitHub API ----------
  function apiFetch(path, token, accept) {
    var headers = { Accept: accept || 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28' };
    return fetch(CONFIG.apiBase + path, { headers: headers, cache: 'no-store' }).then(function (res) {
      if (res.ok) return res;
      return res.text().then(function (text) {
        var message = '';
        try { message = JSON.parse(text).message || ''; } catch (err) { message = ''; }
        var remaining = res.headers.get('x-ratelimit-remaining');
        var code = 'unknown';
        if (res.status === 401) code = 'unauthorized';
        else if (res.status === 403 || res.status === 429) code = (remaining === '0' || /rate limit/i.test(message) || res.status === 429) ? 'ratelimit' : 'forbidden';
        else if (res.status === 404) code = 'notfound';
        else if (res.status >= 500) code = 'server';
        throw LauncherError(code, 'GitHub ' + res.status + (message ? '：' + message : ''), { status: res.status });
      });
    }, function () {
      throw LauncherError('network', '网络连接失败');
    });
  }

  function apiJSON(path, token) {
    return apiFetch(path, token).then(function (res) {
      return res.json().catch(function () { throw LauncherError('unknown', 'GitHub 返回的内容无法解析'); });
    });
  }

  // ---------- 密钥 ----------
  var TOKEN_RE = /(github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/;

  /** 从粘贴或扫码得到的文字里找出密钥 */
  function extractToken(text) {
    var m = TOKEN_RE.exec(String(text || '').replace(/\s+/g, ''));
    return m ? m[1] : null;
  }

  /** 打码显示：只露出开头和最后 4 位 */
  function maskToken(token) {
    if (!token) return '';
    var prefix = /^github_pat_/.test(token) ? 'github_pat_' : token.slice(0, 4);
    return prefix + '••••••••' + token.slice(-4);
  }

  /** 校验密钥：必须是 owner 账号的，并且能访问两个私有仓库 */
  function validateToken(token) {
    if (!extractToken(token) || extractToken(token) !== token) return Promise.reject(LauncherError('format', '密钥格式不对'));
    return apiJSON('/user', token).then(function (user) {
      if (!user || !user.login) throw LauncherError('unknown', 'GitHub 返回的账号信息不完整');
      if (String(user.login).toLowerCase() !== CONFIG.owner.toLowerCase()) throw LauncherError('wrong-account', '账号不对', { login: user.login });
      var repos = [CONFIG.appRepo, CONFIG.dataRepo];
      return Promise.all(repos.map(function (repo) {
        return apiJSON('/repos/' + CONFIG.owner + '/' + repo, token).then(function () { return null; }, function (err) {
          if (err.code === 'notfound' || err.code === 'forbidden') return repo;
          throw err;
        });
      })).then(function (results) {
        var missing = results.filter(Boolean);
        if (missing.length) throw LauncherError('repo-access', '仓库没有勾选', { missing: missing });
        return { login: user.login, id: user.id };
      });
    });
  }

  // ---------- 下载和缓存 App ----------
  var MIME = {
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8',
    webmanifest: 'application/manifest+json; charset=utf-8', svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
    txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8',
    woff: 'font/woff', woff2: 'font/woff2', wasm: 'application/wasm', map: 'application/json; charset=utf-8'
  };

  function mimeType(path) {
    var name = path.split('/').pop();
    var dot = name.lastIndexOf('.');
    if (dot < 0) return /^(LICENSE|NOTICE|COPYING)/i.test(name) ? 'text/plain; charset=utf-8' : 'application/octet-stream';
    return MIME[name.slice(dot + 1).toLowerCase()] || 'application/octet-stream';
  }

  function base64ToBytes(b64) {
    var bin = atob(String(b64).replace(/\s+/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function cacheName(sha) { return APP_CACHE_PREFIX + sha; }

  /** 私有仓库 main 分支最新的 commit sha（一个很小的请求） */
  function getLatestSha(token) {
    var path = '/repos/' + CONFIG.owner + '/' + CONFIG.appRepo + '/commits/' + encodeURIComponent(CONFIG.branch);
    return apiFetch(path, token, 'application/vnd.github.sha').then(function (res) { return res.text(); }).then(function (text) {
      var sha = String(text).trim();
      if (!/^[0-9a-f]{40}$/.test(sha)) throw LauncherError('unknown', 'GitHub 返回的版本号格式不对');
      return sha;
    });
  }

  function pool(items, limit, worker) {
    var i = 0;
    var running = [];
    function next() {
      if (i >= items.length) return Promise.resolve();
      var item = items[i++];
      return worker(item).then(next);
    }
    for (var k = 0; k < Math.min(limit, items.length); k++) running.push(next());
    return Promise.all(running);
  }

  /**
   * 下载某个版本的 app/ 目录到 Cache Storage（缓存名 habit-app-<sha>）。
   * 和上一个版本相同的文件直接从旧缓存复制，只下载变化的文件。
   */
  function downloadVersion(token, sha, opts) {
    opts = opts || {};
    var scope = opts.scope;
    var previous = opts.previous && opts.previous.files ? opts.previous : null;
    var treePath = '/repos/' + CONFIG.owner + '/' + CONFIG.appRepo + '/git/trees/' + sha + '?recursive=1';
    return apiJSON(treePath, token).then(function (tree) {
      if (!tree || !Array.isArray(tree.tree)) throw LauncherError('unknown', 'GitHub 返回的文件列表格式不对');
      if (tree.truncated) throw LauncherError('too-big', '文件列表不完整');
      var files = tree.tree.filter(function (t) { return t.type === 'blob' && t.path.indexOf(CONFIG.appDir) === 0; });
      if (!files.some(function (f) { return f.path === CONFIG.appDir + 'index.html'; })) throw LauncherError('no-app', '没有 app/index.html');
      var stats = { total: files.length, done: 0, fetched: 0, reused: 0 };
      var manifest = {};
      return Promise.all([caches.open(cacheName(sha)), previous ? caches.has(cacheName(previous.sha)).then(function (has) { return has ? caches.open(cacheName(previous.sha)) : null; }) : null])
        .then(function (cs) {
          var cache = cs[0], prevCache = cs[1];
          function one(f) {
            var url = scope + f.path;
            return cache.match(url).then(function (hit) {
              if (hit && hit.headers.get('X-Blob-Sha') === f.sha) { stats.reused++; return null; }
              var fromPrev = prevCache && previous.files[f.path] === f.sha ? prevCache.match(url) : Promise.resolve(null);
              return fromPrev.then(function (old) {
                if (old) { stats.reused++; return cache.put(url, old); }
                return apiJSON('/repos/' + CONFIG.owner + '/' + CONFIG.appRepo + '/git/blobs/' + f.sha, token).then(function (blob) {
                  var body = blob.encoding === 'base64' ? base64ToBytes(blob.content) : new TextEncoder().encode(blob.content);
                  stats.fetched++;
                  return cache.put(url, new Response(body, { headers: { 'Content-Type': mimeType(f.path), 'X-Blob-Sha': f.sha, 'Cache-Control': 'no-cache' } }));
                });
              });
            }).then(function () {
              manifest[f.path] = f.sha;
              stats.done++;
              if (opts.onProgress) opts.onProgress(stats.done, stats.total);
            });
          }
          return pool(files, 4, one);
        })
        .then(function () {
          return { sha: sha, files: manifest, count: files.length, fetched: stats.fetched, reused: stats.reused, downloadedAt: Date.now() };
        }, function (err) {
          if (err && (err.name === 'QuotaExceededError' || err.code === 22)) throw LauncherError('storage', '存储空间不够');
          throw err;
        });
    });
  }

  function getMeta() {
    return kvGet('appMeta').then(function (m) { return m || {}; });
  }

  /** 缓存里这个版本的文件是否齐全 */
  function hasCompleteCache(ver, scope) {
    if (!ver || !ver.sha) return Promise.resolve(false);
    return caches.has(cacheName(ver.sha)).then(function (has) {
      if (!has) return false;
      return caches.open(cacheName(ver.sha)).then(function (cache) {
        return cache.keys().then(function (keys) {
          if (ver.count && keys.length < ver.count) return false;
          return cache.match(scope + CONFIG.appDir + 'index.html').then(function (r) { return !!r; });
        });
      });
    });
  }

  /** 删掉不再需要的 App 版本缓存（只删本 App 自己的缓存） */
  function cleanupCaches(keepShas) {
    var keep = keepShas.filter(Boolean).map(cacheName);
    return caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf(APP_CACHE_PREFIX) === 0 && keep.indexOf(k) < 0; }).map(function (k) { return caches.delete(k); }));
    });
  }

  /** 首次安装（或缓存丢失后重装）：下载最新版本并设为当前版本 */
  function installLatest(token, scope, onProgress) {
    return Promise.all([getLatestSha(token), getMeta()]).then(function (r) {
      var sha = r[0], meta = r[1];
      return downloadVersion(token, sha, { scope: scope, previous: meta.current, onProgress: onProgress }).then(function (ver) {
        return getMeta().then(function (m) {
          m.current = ver;
          m.pending = null;
          m.lastCheckAt = Date.now();
          return kvSet('appMeta', m).then(function () { return cleanupCaches([sha]); }).then(function () { return ver; });
        });
      });
    });
  }

  /** 检查更新（一个请求）；有新版本就在后台下载好，状态记为 pending */
  function checkForUpdate(scope) {
    return Promise.all([kvGet('token'), getMeta()]).then(function (r) {
      var token = r[0], meta = r[1];
      if (!token) return { status: 'no-token' };
      if (!meta.current) return { status: 'not-installed' };
      return getLatestSha(token).then(function (sha) {
        if (sha === meta.current.sha) {
          return getMeta().then(function (m) {
            m.pending = null;
            m.lastCheckAt = Date.now();
            return kvSet('appMeta', m);
          }).then(function () { return cleanupCaches([meta.current.sha]); }).then(function () { return { status: 'latest', sha: sha }; });
        }
        var ready = meta.pending && meta.pending.sha === sha ? hasCompleteCache(meta.pending, scope) : Promise.resolve(false);
        return ready.then(function (isReady) {
          if (isReady) return { status: 'ready', sha: sha };
          return downloadVersion(token, sha, { scope: scope, previous: meta.current }).then(function (ver) {
            return getMeta().then(function (m) {
              m.pending = ver;
              m.lastCheckAt = Date.now();
              return kvSet('appMeta', m).then(function () { return cleanupCaches([m.current && m.current.sha, ver.sha]); });
            }).then(function () { return { status: 'ready', sha: sha, fetched: ver.fetched, reused: ver.reused }; });
          });
        });
      });
    });
  }

  /** 把已下载好的新版本设为当前版本 */
  function applyPending(scope) {
    return getMeta().then(function (meta) {
      if (!meta.pending) return { applied: false, sha: meta.current && meta.current.sha };
      return hasCompleteCache(meta.pending, scope).then(function (ok) {
        if (!ok) {
          meta.pending = null;
          return kvSet('appMeta', meta).then(function () { return { applied: false, sha: meta.current && meta.current.sha }; });
        }
        meta.current = meta.pending;
        meta.pending = null;
        return kvSet('appMeta', meta).then(function () { return cleanupCaches([meta.current.sha]); }).then(function () {
          return { applied: true, sha: meta.current.sha };
        });
      });
    });
  }

  /** 生成 GitHub 新建密钥的链接（名称、说明、账号、有效期、权限都预填好） */
  function tokenCreateUrl(now) {
    var d = now || new Date();
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    var name = '习惯记录 ' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes());
    var desc = '习惯记录：下载 App 和同步数据（只需要勾选 ' + CONFIG.appRepo + ' 和 ' + CONFIG.dataRepo + '）';
    return 'https://github.com/settings/personal-access-tokens/new?name=' + encodeURIComponent(name) +
      '&description=' + encodeURIComponent(desc) + '&target_name=' + encodeURIComponent(CONFIG.owner) +
      '&expires_in=none&contents=write';
  }

  root.HabitLauncher = {
    CONFIG: CONFIG,
    APP_CACHE_PREFIX: APP_CACHE_PREFIX,
    kvGet: kvGet,
    kvSet: kvSet,
    kvDel: kvDel,
    LauncherError: LauncherError,
    describeError: describeError,
    extractToken: extractToken,
    maskToken: maskToken,
    validateToken: validateToken,
    getLatestSha: getLatestSha,
    downloadVersion: downloadVersion,
    installLatest: installLatest,
    checkForUpdate: checkForUpdate,
    applyPending: applyPending,
    getMeta: getMeta,
    hasCompleteCache: hasCompleteCache,
    cleanupCaches: cleanupCaches,
    mimeType: mimeType,
    tokenCreateUrl: tokenCreateUrl
  };
})(typeof self !== 'undefined' ? self : this);
