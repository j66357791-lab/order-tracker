/* PWA Service Worker - 接单后台
 * 策略：实时系统，API/socket.io 绝不缓存；静态页面用 stale-while-revalidate
 */
const CACHE_NAME = 'jiedan-v1';
const APP_SHELL = [
  '/login.html',
  '/index.html',
  '/dispatch.html',
  '/writer.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// 安装：缓存应用外壳
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

// 激活：清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 请求拦截
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 只处理同源 GET 请求
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;

  // API 和 socket.io：绝不缓存，实时系统必须走网络
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 静态资源：stale-while-revalidate（缓存优先，后台更新）
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
