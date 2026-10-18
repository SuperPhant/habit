/* 习惯记录 · 启动页：设置密钥、下载 App、打开 App。不含 App 代码。 */
(function () {
  'use strict';

  var L = window.HabitLauncher;
  var params = new URLSearchParams(location.search);
  var scopeURL = new URL('./', location.href).href;
  var $ = function (id) { return document.getElementById(id); };
  var VIEWS = ['boot', 'install', 'error', 'setup'];
  var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  var isMobile = isIOS || /Android|Mobile/i.test(navigator.userAgent) || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  var busy = false;

  function show(view) {
    VIEWS.forEach(function (v) { $('view-' + v).hidden = v !== view; });
    window.scrollTo(0, 0);
  }

  function setBootText(t) { $('boot-text').textContent = t; }

  function showError(err, retry) {
    var d = L.describeError(err);
    $('error-title').textContent = d.title;
    $('error-detail').textContent = d.detail;
    $('btn-retry').onclick = function () { retry ? retry() : location.reload(); };
    show('error');
  }

  function showFatal(text) {
    showError({ code: 'unknown', message: text }, function () { location.reload(); });
  }

  function setupMessage(d, ok) {
    var box = $('setup-msg');
    if (!d) { box.hidden = true; return; }
    box.hidden = false;
    box.classList.toggle('ok', !!ok);
    $('setup-msg-title').textContent = d.title;
    $('setup-msg-detail').textContent = d.detail || '';
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function requestPersist() {
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
    } catch (e) { /* 不支持就算了 */ }
  }

  function waitForController(ms) {
    if (navigator.serviceWorker.controller) return Promise.resolve(true);
    return new Promise(function (resolve) {
      var t = setTimeout(function () { resolve(!!navigator.serviceWorker.controller); }, ms);
      navigator.serviceWorker.addEventListener('controllerchange', function () { clearTimeout(t); resolve(true); }, { once: true });
    });
  }

  function postToSW(msg) {
    var sw = navigator.serviceWorker.controller;
    if (sw) sw.postMessage(msg);
  }

  function openApp() {
    setBootText('正在打开…');
    show('boot');
    return waitForController(15000).then(function (ok) {
      if (ok) {
        location.replace(scopeURL + 'app/');
        return;
      }
      // 极少数情况（比如强制刷新）页面没有被 Service Worker 接管：普通刷新一次就好
      if (!sessionStorage.getItem('habit-reloaded')) {
        sessionStorage.setItem('habit-reloaded', '1');
        location.reload();
      } else {
        sessionStorage.removeItem('habit-reloaded');
        showFatal('离线功能还没准备好。请关闭页面后重新打开。');
      }
    });
  }

  function install(token) {
    show('install');
    $('install-bar').style.width = '0%';
    $('install-text').textContent = '正在连接 GitHub…';
    if (!navigator.onLine) {
      showError({ code: 'network' }, function () { install(token); });
      return Promise.resolve();
    }
    return waitForController(20000).then(function () {
      return L.installLatest(token, scopeURL, function (done, total) {
        $('install-bar').style.width = Math.round((done / total) * 100) + '%';
        $('install-text').textContent = '已下载 ' + done + ' / ' + total + ' 个文件';
      });
    }).then(function () {
      postToSW({ type: 'meta-changed' });
      $('install-text').textContent = '下载完成';
      return openApp();
    }).catch(function (e) {
      showError(e, function () { install(token); });
    });
  }

  function updatePreview() {
    var raw = $('token-input').value;
    var token = L.extractToken(raw);
    $('token-preview').textContent = raw ? (token ? '已识别密钥：' + L.maskToken(token) + '（共 ' + token.length + ' 位）' : '还没有识别到完整的密钥') : '';
    return token;
  }

  function verifyAndStart(raw) {
    if (busy) return;
    var token = L.extractToken(raw);
    if (!token) {
      setupMessage(L.describeError({ code: 'format' }));
      return;
    }
    busy = true;
    $('btn-verify').disabled = true;
    $('btn-verify').textContent = '正在验证…';
    setupMessage({ title: '正在验证密钥…', detail: '检查账号和仓库权限' }, true);
    L.validateToken(token).then(function (account) {
      return Promise.all([
        L.kvSet('token', token),
        L.kvSet('account', { login: account.login, id: account.id, savedAt: Date.now() })
      ]).then(function () {
        setupMessage({ title: '密钥可用', detail: '账号 ' + account.login + '，两个仓库都能访问。正在下载 App…' }, true);
        $('token-input').value = '';
        return L.getMeta().then(function (meta) {
          return L.hasCompleteCache(meta.current, scopeURL).then(function (cached) {
            if (cached) {
              postToSW({ type: 'check-update', force: true });
              return openApp();
            }
            return install(token);
          });
        });
      });
    }).catch(function (e) {
      setupMessage(L.describeError(e));
    }).then(function () {
      busy = false;
      $('btn-verify').disabled = false;
      $('btn-verify').textContent = '验证并开始';
    });
  }

  // ---------- 扫码 ----------
  var scanStream = null;
  var scanTimer = null;
  var lastBadAt = 0;

  function loadJsQR() {
    if (window.jsQR) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'vendor/jsQR.js';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('扫码组件加载失败')); };
      document.head.appendChild(s);
    });
  }

  function makeDetector() {
    if (!('BarcodeDetector' in window)) return Promise.resolve(null);
    return window.BarcodeDetector.getSupportedFormats().then(function (formats) {
      return formats.indexOf('qr_code') >= 0 ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
    }).catch(function () { return null; });
  }

  function stopScan() {
    clearTimeout(scanTimer);
    scanTimer = null;
    if (scanStream) scanStream.getTracks().forEach(function (t) { t.stop(); });
    scanStream = null;
    $('scan-video').srcObject = null;
    $('scanner').hidden = true;
  }

  function onScanned(text) {
    var token = L.extractToken(text);
    if (!token) {
      if (Date.now() - lastBadAt > 2000) {
        lastBadAt = Date.now();
        $('scan-text').textContent = '这个二维码里没有密钥。请扫「习惯记录 → 设置 → 在手机上使用」里的二维码';
      }
      return false;
    }
    stopScan();
    $('token-input').value = token;
    updatePreview();
    verifyAndStart(token);
    return true;
  }

  function startScan() {
    setupMessage(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setupMessage({ title: '这个浏览器不能用摄像头扫码', detail: '请改用「粘贴密钥」。iPhone 请用 Safari 添加到主屏幕后再打开。' });
      return;
    }
    $('scan-text').textContent = '正在打开摄像头…';
    $('scanner').hidden = false;
    var video = $('scan-video');
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then(function (stream) {
        scanStream = stream;
        video.srcObject = stream;
        return video.play().catch(function () {});
      })
      .then(function () { return makeDetector(); })
      .then(function (detector) {
        return (detector ? Promise.resolve() : loadJsQR()).then(function () { return detector; });
      })
      .then(function (detector) {
        if (!scanStream) return;
        $('scan-text').textContent = '把电脑屏幕上的二维码放进框里';
        var tick = function () {
          if (!scanStream) return;
          var next = function () { if (scanStream) scanTimer = setTimeout(tick, 180); };
          if (video.readyState < 2 || !video.videoWidth) { next(); return; }
          if (detector) {
            detector.detect(video).then(function (codes) {
              if (!(codes && codes.length && onScanned(codes[0].rawValue))) next();
            }, next);
            return;
          }
          var scale = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          var code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
          if (!(code && code.data && onScanned(code.data))) next();
        };
        tick();
      })
      .catch(function (e) {
        stopScan();
        var name = e && e.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setupMessage({ title: '没有摄像头权限', detail: isIOS ? '请到 iPhone 的「设置 → Safari → 相机」选择「询问」或「允许」，然后重新点「扫码导入密钥」。也可以改用粘贴。' : '请在浏览器的网站设置里允许使用相机，然后重新点「扫码导入密钥」。也可以改用粘贴。' });
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          setupMessage({ title: '没有找到摄像头', detail: '这台设备好像没有可用的摄像头，请改用粘贴。' });
        } else {
          setupMessage({ title: '无法打开摄像头', detail: ((e && e.message) || '未知错误') + '。请改用粘贴。' });
        }
      });
  }

  // ---------- 设置页 ----------
  var deferredInstall = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredInstall = e;
    if (!$('view-setup').hidden) $('install-card').hidden = false;
  });

  function showSetup(token, account) {
    document.body.classList.toggle('is-desktop', !isMobile);
    var urls = document.querySelectorAll('.url-text');
    for (var i = 0; i < urls.length; i++) urls[i].textContent = scopeURL;
    $('ios-tip').hidden = !(isIOS && !isStandalone);
    $('install-card').hidden = !deferredInstall;
    $('btn-create').href = L.tokenCreateUrl(new Date());
    $('current-key').hidden = !token;
    if (token) {
      $('current-key-mask').textContent = L.maskToken(token);
      $('current-key-account').textContent = account && account.login ? '（账号 ' + account.login + '）' : '';
    }
    show('setup');
  }

  function bindSetup() {
    $('btn-verify').onclick = function () { verifyAndStart($('token-input').value); };
    $('token-input').addEventListener('input', function () { updatePreview(); setupMessage(null); });
    $('btn-paste').onclick = function () {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        setupMessage({ title: '无法自动读取剪贴板', detail: '请长按（或右键）输入框，选择「粘贴」。' });
        $('token-input').focus();
        return;
      }
      navigator.clipboard.readText().then(function (text) {
        var token = L.extractToken(text);
        if (!token) {
          setupMessage({ title: '剪贴板里没有密钥', detail: '请回到 GitHub 点密钥旁边的复制按钮，再回来点「粘贴」。' });
          return;
        }
        $('token-input').value = token;
        updatePreview();
        verifyAndStart(token);
      }, function () {
        setupMessage({ title: '无法自动读取剪贴板', detail: '请长按（或右键）输入框，选择「粘贴」。' });
        $('token-input').focus();
      });
    };
    $('btn-scan').onclick = startScan;
    $('btn-scan-close').onclick = stopScan;
    $('btn-create').addEventListener('click', function () { this.href = L.tokenCreateUrl(new Date()); });
    $('btn-continue').onclick = function () { location.replace(scopeURL); };
    $('btn-forget').onclick = function () {
      if (!window.confirm('确定删除这台设备上的密钥吗？删除后需要重新扫码或粘贴密钥才能同步。（已经记录的数据还在。）')) return;
      Promise.all([L.kvDel('token'), L.kvDel('account')]).then(function () {
        $('current-key').hidden = true;
        setupMessage({ title: '已删除这台设备上的密钥', detail: '' }, true);
      });
    };
    $('btn-install').onclick = function () {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      deferredInstall.userChoice.then(function () { deferredInstall = null; $('install-card').hidden = true; });
    };
    $('btn-error-setup').onclick = function () { location.replace(scopeURL + '?setup'); };
  }

  // ---------- 启动 ----------
  function boot() {
    if (!L || !('serviceWorker' in navigator) || !window.caches || !window.indexedDB) {
      showFatal('这个浏览器不支持离线 App。请用最新版的 Safari（iPhone）、Chrome（安卓）或 Edge / Chrome（电脑）打开；不要用无痕/隐私模式。');
      return;
    }
    bindSetup();
    requestPersist();
    navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' }).catch(function () {
      showFatal('无法启用离线功能（Service Worker 注册失败）。如果开着无痕/隐私模式，请换成普通模式打开。');
    });
    Promise.all([L.kvGet('token'), L.kvGet('account'), L.getMeta()]).then(function (r) {
      var token = r[0], account = r[1], meta = r[2];
      if (!token || params.has('setup')) {
        showSetup(token, account);
        return null;
      }
      var applyFirst = meta.pending
        ? L.hasCompleteCache(meta.pending, scopeURL).then(function (ok) { return ok ? L.applyPending(scopeURL) : null; })
        : Promise.resolve(null);
      return applyFirst.then(function () { return L.getMeta(); }).then(function (m) {
        return L.hasCompleteCache(m.current, scopeURL).then(function (cached) {
          if (cached) {
            return waitForController(15000).then(function () {
              postToSW({ type: 'meta-changed' });
              postToSW({ type: 'check-update' });
              return openApp();
            });
          }
          setBootText('需要下载 App…');
          return install(token);
        });
      });
    }).catch(function (e) {
      showError(e);
    });
  }

  boot();
})();
