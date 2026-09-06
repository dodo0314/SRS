// 서비스워커 — 오프라인 구동과 자동 갱신
//
// 앱 껍데기는 캐시에서 즉시 내주고 뒤에서 새 버전을 받아둔다(stale-while-revalidate).
// 다음 실행 때 새 버전이 뜬다. GitHub API 응답은 절대 캐시하지 않는다.

const CACHE = 'srs-shell-v18';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/course.js',
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
    caches
      .open(CACHE)
      // HTTP 캐시를 우회해 원본에서 받는다. Pages의 max-age 때문에
      // 배포 직후 파일별로 신구가 섞이는 것을 막는다.
      .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
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

// 설정의 "지금 갱신" — 셸 파일 전부를 브라우저 캐시와 Pages CDN 캐시(10분)까지
// 우회해(고유 쿼리) 다시 받아 현재 캐시에 넣는다. 끝나면 포트로 알린다.
async function refreshShell() {
  const cache = await caches.open(CACHE);
  const stamp = Date.now();
  await Promise.all(
    SHELL.map(async (url) => {
      try {
        const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}fresh=${stamp}`, { cache: 'reload' });
        if (res && res.ok) await cache.put(new Request(url), res);
      } catch {
        // 오프라인 등 — 받은 것만 갱신하고 넘어간다
      }
    })
  );
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'refresh-shell') {
    event.waitUntil(
      refreshShell().then(() => {
        if (event.ports && event.ports[0]) event.ports[0].postMessage({ ok: true });
      })
    );
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // GitHub API 등은 그대로 통과

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      const network = fetch(request, { cache: 'no-cache' })
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
