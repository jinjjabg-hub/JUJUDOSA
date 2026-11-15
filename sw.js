const CACHE_NAME = 'jujudosa-shell-v5';
const SHELL_FILES = [
  './',
  './index.html',
  './plans.js',
  './track.js',
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

// 매일 아침 알림: 서버는 내용 없는 신호만 보내고, 문구는 여기서 고정으로 띄운다.
self.addEventListener('push', (event) => {
  event.waitUntil(self.registration.showNotification('주주도사', {
    body: '오늘의 흐름이 도착했습니다. 오늘 일진을 살펴보시지요.',
    icon: './icon-192.png', badge: './icon-192.png', tag: 'jujudosa-daily', renotify: false
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL('./index.html?from=push', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { if ('navigate' in c) c.navigate(target).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(target);
  }));
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

  // .js(요금제 plans.js·측정 track.js 등)도 네트워크 우선: 값을 바꾸면 다음 접속에 바로 반영되게 한다.
  const isHTML = req.mode === 'navigate' ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('index.html') ||
    url.pathname.endsWith('.js');

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
