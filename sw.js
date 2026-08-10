const CACHE_NAME = 'jujudosa-shell-v2';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './logo.png',
  './avatar.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// index.html(및 페이지 이동)은 항상 네트워크를 먼저 시도해서 최신 버전을 받는다.
// 오프라인일 때만 캐시로 폴백. 그 외 정적 자산(아이콘 등)은 기존처럼 캐시 우선.
// Firebase/Cloudflare Worker API 호출은 그대로 네트워크로 직행(캐시 안 함).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isShellAsset = url.origin === self.location.origin;
  if (!isShellAsset) return; // let Firebase/Worker/API calls pass straight through

  const isHTML = req.mode === 'navigate' ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('index.html');

  if (isHTML) {
    event.respondWith(
      fetch(req).then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        return res;
      }).catch(() => cached);
    })
  );
});
