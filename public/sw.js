/* Elbi service worker — app shell caching, offline library, and range-capable
   playback of videos saved into Cache Storage. */

const VERSION = 'v2';
const SHELL_CACHE = `elbi-shell-${VERSION}`;
const DATA_CACHE = `elbi-data-${VERSION}`;
const VIDEO_CACHE = 'elbi-video-v1'; // unversioned: downloads must survive updates

/**
 * Everything the app needs to open with no network at all.
 *
 * The fonts and the app icons have to be listed explicitly rather than left to
 * the opportunistic caching further down. On a first visit the browser asks for
 * them while the worker is still installing — before `clients.claim()` — so the
 * fetch handler never sees those requests and never stores them. The result was
 * a library that opened offline in fallback system fonts, with a blank icon on
 * the home screen, until some later online visit happened to re-request them.
 *
 * A test asserts this list covers every asset actually shipped in public/.
 */
const SHELL_ASSETS = [
  '/',
  '/browse',
  '/index.html',
  '/css/elbi.css',
  '/js/app.js',
  '/js/api.js',
  '/js/state.js',
  '/js/util.js',
  '/js/search.js',
  '/js/filters.js',
  '/js/capacity.js',
  '/js/install.js',
  '/js/langs.js',
  '/js/stalls.js',
  '/js/player.js',
  '/js/views.js',
  '/js/add.js',
  '/js/offline.js',
  '/manifest.webmanifest',
  '/icons/elbi.svg',
  '/icons/elbi-192.png',
  '/icons/elbi-512.png',
  '/fonts/bebas-neue-400.woff2',
  '/fonts/plex-sans-400.woff2',
  '/fonts/plex-sans-500.woff2',
  '/fonts/plex-sans-600.woff2',
  '/fonts/plex-sans-700.woff2',
  '/fonts/plex-mono-400.woff2',
  '/fonts/plex-mono-500.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll fails the whole install if any single asset 404s; be forgiving.
    await Promise.all(SHELL_ASSETS.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith('elbi-') && ![SHELL_CACHE, DATA_CACHE, VIDEO_CACHE].includes(name))
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/stream/')) {
    event.respondWith(handleStream(event));
    return;
  }
  if (url.pathname === '/api/library') {
    event.respondWith(handleLibrary(request));
    return;
  }
  if (url.pathname.startsWith('/api/')) return; // everything else is live-only

  event.respondWith(handleShell(request, url));
});

/** Serve a downloaded video from Cache Storage, honouring Range requests. */
async function handleStream(event) {
  const url = new URL(event.request.url);
  const canonical = `${url.origin}${url.pathname}`;
  const cache = await caches.open(VIDEO_CACHE);
  const cached = await cache.match(canonical);

  if (!cached) {
    try {
      return await fetch(event.request);
    } catch {
      return new Response(
        'Elbi could not reach the server, and this video has not been saved for offline playback.',
        { status: 504, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      );
    }
  }

  const rangeHeader = event.request.headers.get('range');
  const blob = await cached.blob();
  const size = blob.size;
  const type = cached.headers.get('Content-Type') || 'video/mp4';

  if (!rangeHeader) {
    return new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        'X-Elbi-Source': 'offline',
      },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }

  let start;
  let end;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '') {
    const suffix = parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(rawStart, 10);
    end = rawEnd === '' ? size - 1 : parseInt(rawEnd, 10);
  }
  if (!Number.isFinite(start) || start >= size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  end = Math.min(Number.isFinite(end) ? end : size - 1, size - 1);
  if (end < start) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }

  return new Response(blob.slice(start, end + 1, type), {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'X-Elbi-Source': 'offline',
    },
  });
}

/** Network-first for the library, with the last good copy kept for offline. */
async function handleLibrary(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set('X-Elbi-Source', 'offline-cache');
      return new Response(cached.body, { status: cached.status, headers });
    }
    return new Response(JSON.stringify({ error: 'Offline and no cached library available.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/** Cache-first for static assets, network-first for the app shell HTML. */
async function handleShell(request, url) {
  const cache = await caches.open(SHELL_CACHE);
  const isDocument = request.mode === 'navigate' || request.destination === 'document';

  if (isDocument) {
    try {
      const response = await fetch(request);
      if (response.ok) cache.put('/index.html', response.clone());
      return response;
    } catch {
      return (await cache.match('/index.html'))
        || (await cache.match('/'))
        || new Response('Elbi is offline and the app shell is not cached yet.', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
    }
  }

  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) {
    // Refresh in the background so the next load is current.
    fetch(request).then((res) => { if (res.ok) cache.put(request, res.clone()); }).catch(() => {});
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response.ok && /\.(css|js|svg|png|jpg|jpeg|webp|woff2?|webmanifest)$/.test(url.pathname)) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 504, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}
