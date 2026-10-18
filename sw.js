/*
 * 习惯记录 · 启动页 Service Worker
 * 1. 缓存启动页自身（离线也能打开）
 * 2. 在 ./app/ 路径下，从 Cache Storage 提供已下载的 App 文件（带正确的 Content-Type）
 * 3. 后台检查和下载新版本
 */
importScripts('core.js');

var LAUNCHER_VERSION = '32f358613699';
var SHELL_CACHE = 'habit-launcher-' + LAUNCHER_VERSION;
var SHELL_FILES = [
  'index.html', 'launcher.css', 'launcher.js', 'core.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'vendor/jsQR.js'
];
var L = self.HabitLauncher;
var SCOPE = self.registration.scope; // 例如 https://superphant.github.io/habit/
var SCOPE_PATH = new URL(SCOPE).pathname;

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return cache.addAll(SHELL_FILES.map(function (f) { return new Request(SCOPE + f, { cache: 'reload' }); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf('habit-launcher-') === 0 && k !== SHELL_CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

var memMeta = null;
function currentVersion(fresh) {
  if (!fresh && memMeta) return Promise.resolve(memMeta.current || null);
  return L.getMeta().then(function (m) { memMeta = m; return m.current || null; }, function () { return null; });
}

function textResponse(status, text) {
  return new Response(text, { status: status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

function serveApp(request, rel) {
  var isNav = request.mode === 'navigate';
  var path = /\/$/.test(rel) ? rel + 'index.html' : rel;
  return currentVersion(isNav).then(function (cur) {
    if (!cur) return null;
    return caches.match(SCOPE + path, { cacheName: L.APP_CACHE_PREFIX + cur.sha, ignoreSearch: true });
  }).then(function (hit) {
    if (hit) return hit;
    // App 还没下载或缓存被系统清掉了：回到启动页处理
    if (isNav) return Response.redirect(SCOPE + '?repair=1', 302);
    return textResponse(404, '找不到文件：' + path);
  });
}

function serveShell(request, rel) {
  var key = rel === '' ? 'index.html' : rel;
  return caches.match(SCOPE + key, { cacheName: SHELL_CACHE, ignoreSearch: true }).then(function (hit) {
    if (hit) return hit;
    return fetch(request).catch(function () {
      return request.mode === 'navigate'
        ? new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>习惯记录</title><p style="font:16px sans-serif;padding:24px">现在离线，启动页还没缓存好。请联网后再打开一次。</p>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        : textResponse(504, '离线');
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.indexOf(SCOPE_PATH) !== 0) return;
  var rel = url.pathname.slice(SCOPE_PATH.length);
  if (rel === 'sw.js') return;
  if (rel === 'app') {
    event.respondWith(Response.redirect(SCOPE + 'app/' + url.search, 302));
    return;
  }
  if (rel.indexOf('app/') === 0) {
    event.respondWith(serveApp(request, rel));
    return;
  }
  if (rel === '' || SHELL_FILES.indexOf(rel) >= 0) event.respondWith(serveShell(request, rel));
});

// ---------- 后台检查更新 ----------
var checking = null;
function broadcast(msg) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    list.forEach(function (c) { c.postMessage(msg); });
  });
}

function runCheck(force) {
  if (checking) return checking;
  checking = L.getMeta().then(function (meta) {
    if (!force && meta.lastCheckAt && Date.now() - meta.lastCheckAt < 60 * 1000) {
      return { ok: true, status: meta.pending ? 'ready' : 'recent', sha: meta.pending ? meta.pending.sha : meta.current && meta.current.sha };
    }
    return L.checkForUpdate(SCOPE).then(function (r) {
      memMeta = null;
      var result = { ok: true, status: r.status, sha: r.sha, fetched: r.fetched, reused: r.reused };
      if (r.status === 'ready') return broadcast({ type: 'update-ready', sha: r.sha }).then(function () { return result; });
      return result;
    });
  }).catch(function (e) {
    return { ok: false, error: L.describeError(e), code: e && e.code };
  }).then(function (r) {
    checking = null;
    return r;
  });
  return checking;
}

function status() {
  return L.getMeta().then(function (m) {
    return {
      ok: true,
      launcherVersion: LAUNCHER_VERSION,
      current: m.current ? { sha: m.current.sha, downloadedAt: m.current.downloadedAt } : null,
      pending: m.pending ? { sha: m.pending.sha, downloadedAt: m.pending.downloadedAt } : null,
      lastCheckAt: m.lastCheckAt || null,
      checking: !!checking
    };
  });
}

self.addEventListener('message', function (event) {
  var msg = event.data || {};
  var port = event.ports && event.ports[0];
  function reply(data) { if (port) port.postMessage(data); }
  var work = null;
  if (msg.type === 'check-update') work = runCheck(!!msg.force);
  else if (msg.type === 'get-status') work = status();
  else if (msg.type === 'apply-update') {
    work = L.applyPending(SCOPE).then(function (r) { memMeta = null; return { ok: true, applied: r.applied, sha: r.sha }; });
  } else if (msg.type === 'meta-changed') {
    memMeta = null;
    work = Promise.resolve({ ok: true });
  }
  if (work) {
    event.waitUntil(work.then(reply, function (e) { reply({ ok: false, error: L.describeError(e) }); }));
  }
});
