// 서비스워커 — 오프라인 구동과 자동 갱신
//
// 앱 껍데기는 캐시에서 즉시 내주고 뒤에서 새 버전을 받아둔다(stale-while-revalidate).
// 다음 실행 때 새 버전이 뜬다. GitHub API 응답은 절대 캐시하지 않는다.

const CACHE = 'srs-shell-v6';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/todo.js',
  './js/coach.js',
  './js/db.js',
  './js/fsrs.js',
  './js/github.js',
  './js/parser.js',
  './js/queue.js',
  './js/sync.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // GitHub API 등은 그대로 통과

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      const network = fetch(request)
        .then((res) => {
          if (res && res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => null);

      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      const fresh = await network;
      if (fresh) return fresh;
      if (request.mode === 'navigate') {
        const fallback = await cache.match('./index.html');
        if (fallback) return fallback;
      }
      return new Response('오프라인', { status: 503, statusText: 'offline' });
    })
  );
});
