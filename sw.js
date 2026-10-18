/*
 * 习惯记录已经合并到 LifeBoard。
 * 这个 Service Worker 用来替换旧启动页的 Service Worker：激活后只清理旧 App 自己留下的东西
 * （缓存 habit-app-*、启动页缓存 habit-launcher-*、存密钥的数据库 habit-launcher），然后注销自己，
 * 把打开着的旧页面刷新成提示页。不碰同一网站上 LifeBoard 的缓存和数据库，也保留 habit-app 数据库。
 */
var OLD_CACHE_PREFIXES = ['habit-app-', 'habit-launcher-'];

self.addEventListener('install', function () {
  self.skipWaiting();
});

function isOldCache(name) {
  return OLD_CACHE_PREFIXES.some(function (p) { return name.indexOf(p) === 0; });
}

function deleteDb(name) {
  return new Promise(function (resolve) {
    var done = false;
    function finish() { if (!done) { done = true; resolve(); } }
    try {
      var req = indexedDB.deleteDatabase(name);
      req.onsuccess = finish;
      req.onerror = finish;
      // 旧页面还开着连接时会先 blocked，它们收到 versionchange 后会关闭；最多等 5 秒
      req.onblocked = function () { setTimeout(finish, 5000); };
    } catch (e) {
      finish();
    }
  });
}

function retire() {
  var scope = self.registration.scope;
  // 刷新到提示页时加一个查询参数，避免浏览器拿 HTTP 缓存里的旧启动页
  var notice = scope + '?merged';
  return caches.keys()
    .then(function (keys) { return Promise.all(keys.filter(isOldCache).map(function (k) { return caches.delete(k); })); })
    .then(function () { return deleteDb('habit-launcher'); })
    .then(function () { return self.clients.claim(); })
    .then(function () { return self.clients.matchAll({ type: 'window' }); })
    .then(function (pages) {
      return self.registration.unregister().then(function () {
        return Promise.all(pages.map(function (page) {
          return 'navigate' in page ? page.navigate(notice).catch(function () {}) : null;
        }));
      });
    })
    .catch(function () { return self.registration.unregister(); });
}

self.addEventListener('activate', function (event) {
  event.waitUntil(retire());
});
