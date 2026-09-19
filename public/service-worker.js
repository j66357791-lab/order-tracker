/* PWA Service Worker - 接单后台 v2
 * 策略：HTML页面 network-first（总是最新），静态资源 stale-while-revalidate（先回缓存秒开，后台静默更新）
 * 【2026-09-17 修复】图片原为"命中缓存永不回源"的永久缓存，换图后老用户永远看到旧图；
 * 现改为后台更新式缓存，升级缓存版本号清掉历史永久缓存
 */
const CACHE_VERSION = 'jiedan-v15-20260919';
// 【v22.0】游戏美术资源专用缓存：由游戏页的"资源包下载"显式写入，SW 对这类请求 cache-first。
// 注意：activate 的清理逻辑必须把这个缓存列入白名单，否则每次 SW 激活都会把已下载的资源包清空。
const GAME_CACHE = 'fanfanle-assets-v2';
const KEEP_CACHES = [CACHE_VERSION, GAME_CACHE];
const APP_SHELL = [
  '/portal.html',
  '/member.html',
  '/login.html',
  '/index.html',
  '/dispatch.html',
  '/writer.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/assets/banner-fanfanle.jpg',
  '/assets/banner-shanhai.jpg',
];

// 安装：跳过等待，立即激活
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

// 激活：清理所有旧版本缓存（保留白名单：主缓存 + 游戏资源包缓存）
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !KEEP_CACHES.includes(k)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 请求拦截
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;

  // API 和 socket.io：绝不缓存
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 【v22.0】翻翻乐游戏美术资源：cache-first。
  // 这些资源由游戏页"资源包下载"显式写入 GAME_CACHE；命中即秒开（离线也能玩），
  // 未命中走网络并顺手写入。之前这条走 stale-while-revalidate 且只查主缓存，
  // 而预载只写了 HTTP 缓存——两者不通，导致"显示已下载、进游戏还要重新加载"。
  if (url.pathname.startsWith('/assets/game/')) {
    event.respondWith(
      caches.open(GAME_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => {
          if (cached) return cached;
          return fetch(event.request).then((response) => {
            if (response && response.status === 200) cache.put(event.request, response.clone());
            return response;
          }).catch(() => Response.error());
        })
      )
    );
    return;
  }

  // 【2026-09-15】图片/游戏美术资源：stale-while-revalidate（首次网络取回，之后先回缓存秒开 + 后台拉新）
  if (/\.(png|jpe?g|webp|gif|mp3|wav|mp4)$/i.test(url.pathname) ||
      url.pathname.startsWith('/assets/') || url.pathname.startsWith('/games/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        // 【2026-09-17 修复】先回缓存保证秒开，同时后台拉新替换——换图后老用户刷新即可看到新图
        const networkFetch = fetch(event.request).then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => cached || Response.error());   // 网络失败且无缓存：不能把 undefined 交给 respondWith
        return cached || networkFetch;
      })
    );
    return;
  }

  // HTML 页面：network-first（总是获取最新版本）
  if (url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match(url.pathname.indexOf('member') >= 0 ? '/portal.html' : '/index.html')))
    );
    return;
  }

  // 【v20.4 修复】/admin/ 下的壳文件（app.js / app.css / mod-*.js）必须 network-first：
  // 原来走下面的"先回缓存、后台更新"，部署新版本后第一次打开管理后台会拿到上一版
  // 的 app.js（导航项、样式都是旧的），刷新一次才对——表现为"页面布局突然不对"。
  if (url.pathname.startsWith('/admin/')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || Response.error()))
    );
    return;
  }

  // 其他静态资源：stale-while-revalidate（先回缓存，后台更新）
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached || Response.error());
      return cached || networkFetch;
    })
  );
});
