import { streamUrl } from './api.js';
import { formatBytes, toast } from './util.js';
import { state, emit, playablesOf } from './state.js';

/**
 * Offline downloads.
 *
 * A picked source is streamed into Cache Storage; the service worker then
 * answers /api/stream/<title>/<source> from that cache — including real HTTP
 * range responses, so seeking still works with the network switched off.
 */

const VIDEO_CACHE = 'elbi-video-v1';
const LS_KEY = 'elbi.downloads';

const jobs = new Map();      // key -> { key, name, received, total, state, abort }
const jobListeners = new Set();

export function onJobsChanged(fn) {
  jobListeners.add(fn);
  return () => jobListeners.delete(fn);
}
function emitJobs() {
  for (const fn of jobListeners) {
    try { fn(activeJobs()); } catch { /* ignore */ }
  }
}
export function activeJobs() {
  return [...jobs.values()];
}

/**
 * What to call a saved file in the Downloads list.
 *
 * Two episodes of the same show both read "Night Shift — 720p" without the
 * episode number, which makes the list useless for deciding what to delete.
 */
function downloadName(title, source) {
  const quality = source.label || 'source';
  const item = playablesOf(title).find((p) => p.sources.some((src) => src.id === source.id));
  if (item?.episodeId) {
    const code = `S${String(item.season ?? 1).padStart(2, '0')}E${String(item.episode ?? 1).padStart(2, '0')}`;
    return `${title.name} · ${code} — ${quality}`;
  }
  return `${title.name} — ${quality}`;
}

function keyOf(titleId, sourceId) {
  return `${titleId}:${sourceId}`;
}
function canonicalUrl(titleId, sourceId) {
  return `${location.origin}/api/stream/${titleId}/${sourceId}`;
}

function loadIndex() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function saveIndex(index) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(index)); } catch { /* quota */ }
  state.offlineSources = new Set(Object.keys(index));
  emit();
}

export function offlineIndex() {
  return loadIndex();
}

export function isSourceOffline(titleId, sourceId) {
  return state.offlineSources.has(keyOf(titleId, sourceId));
}

export function offlineCount() {
  return state.offlineSources.size;
}

/** Reconcile the bookkeeping with what Cache Storage actually holds. */
export async function initOffline() {
  const index = loadIndex();
  if (!('caches' in window)) {
    state.offlineSources = new Set();
    return;
  }
  try {
    const cache = await caches.open(VIDEO_CACHE);
    const keys = new Set((await cache.keys()).map((req) => req.url));
    let changed = false;
    for (const [key, entry] of Object.entries(index)) {
      if (!keys.has(entry.url)) {
        delete index[key];
        changed = true;
      }
    }
    if (changed) saveIndex(index);
    else state.offlineSources = new Set(Object.keys(index));
  } catch {
    state.offlineSources = new Set(Object.keys(index));
  }
  emit();
}

export async function downloadSource(title, source) {
  if (!('caches' in window)) {
    toast('This browser has no Cache Storage, so offline downloads are unavailable.', 'err');
    return false;
  }
  const key = keyOf(title.id, source.id);
  if (jobs.has(key)) {
    toast('That download is already running.', 'info');
    return false;
  }
  if (source.streamType === 'hls' || source.streamType === 'dash') {
    toast('Adaptive streams (HLS/DASH) cannot be saved for offline playback.', 'err');
    return false;
  }

  const controller = new AbortController();
  const job = {
    key,
    titleId: title.id,
    sourceId: source.id,
    name: downloadName(title, source),
    received: 0,
    total: source.size || 0,
    state: 'running',
    abort: () => controller.abort(),
  };
  jobs.set(key, job);
  emitJobs();

  try {
    // Always same-origin: /api/stream proxies remote sources itself, so the
    // response body is readable and can be written into the cache.
    const fetchUrl = streamUrl(title.id, source.id);
    const response = await fetch(fetchUrl, { signal: controller.signal, credentials: 'same-origin' });
    if (!response.ok || !response.body) throw new Error(`Server replied ${response.status}`);

    const total = Number(response.headers.get('content-length')) || source.size || 0;
    job.total = total;

    // Tee so the cache write and the progress meter share one download.
    const [toCache, toMeter] = response.body.tee();

    const headers = new Headers();
    headers.set('Content-Type', response.headers.get('content-type') || source.mime || 'video/mp4');
    if (total) headers.set('Content-Length', String(total));
    headers.set('X-Elbi-Offline', '1');

    const cache = await caches.open(VIDEO_CACHE);
    const writing = cache.put(
      new Request(canonicalUrl(title.id, source.id)),
      new Response(toCache, { status: 200, headers }),
    );

    const reader = toMeter.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      job.received += value.byteLength;
      emitJobs();
    }
    await writing;

    // A stream that ends early still ends cleanly, so "we reached the end" is
    // not the same as "we got the film". Without this, a download cut short
    // was filed as complete and only revealed itself later — offline, halfway
    // through, with nothing to explain why the picture stopped.
    if (total && job.received !== total) {
      throw new Error(
        `Only ${formatBytes(job.received)} of ${formatBytes(total)} arrived. The download was cut short.`,
      );
    }

    const index = loadIndex();
    index[key] = {
      url: canonicalUrl(title.id, source.id),
      titleId: title.id,
      sourceId: source.id,
      name: job.name,
      size: job.received || total,
      mime: headers.get('Content-Type'),
      savedAt: Date.now(),
    };
    saveIndex(index);

    job.state = 'done';
    emitJobs();
    toast(`Saved for offline: ${job.name} (${formatBytes(job.received)})`, 'ok');
    setTimeout(() => { jobs.delete(key); emitJobs(); }, 4000);
    return true;
  } catch (err) {
    jobs.delete(key);
    emitJobs();
    await caches.open(VIDEO_CACHE)
      .then((cache) => cache.delete(canonicalUrl(title.id, source.id)))
      .catch(() => {});
    if (err.name === 'AbortError') {
      toast('Download cancelled.', 'info');
      return false;
    }
    const quota = /quota|storage|space/i.test(err.message || '');
    toast(
      quota
        ? 'Ran out of browser storage. Remove another download, or keep the file on the server and stream it instead.'
        : `Download failed: ${err.message}`,
      'err',
    );
    return false;
  }
}

export function cancelDownload(key) {
  jobs.get(key)?.abort();
}

export async function removeDownload(titleId, sourceId) {
  const key = keyOf(titleId, sourceId);
  const index = loadIndex();
  const entry = index[key];
  delete index[key];
  saveIndex(index);
  if ('caches' in window) {
    const cache = await caches.open(VIDEO_CACHE);
    await cache.delete(entry?.url || canonicalUrl(titleId, sourceId));
  }
  return true;
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

/**
 * Whether saved films are safe from being cleared.
 *
 * This is the fact that decides whether a download is still there next week.
 * Without persistence a browser is free to evict Cache Storage under space
 * pressure — and Safari clears data for sites it has not seen in a while,
 * which is exactly the situation of someone who saved a film and then did not
 * open the app for a fortnight.
 */
export async function persistenceStatus() {
  if (!navigator.storage?.persisted) return { supported: false, persisted: false };
  try {
    return { supported: true, persisted: await navigator.storage.persisted() };
  } catch {
    return { supported: false, persisted: false };
  }
}

/** Ask the browser not to evict our downloads under storage pressure. */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function registerServiceWorker() {
  // The hosted copy is a single page with no /sw.js behind it — and nothing for
  // one to do, since the library is already in the browser. Asking anyway just
  // logs a failure on every load.
  if (window.ELBI_HOSTED) return null;
  if (!('serviceWorker' in navigator)) return null;
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(location.hostname)) {
    // Browsers only allow service workers on https or localhost.
    console.info('[elbi] service worker skipped: needs https or localhost.');
    return null;
  }
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return reg;
  } catch (err) {
    console.warn('[elbi] service worker registration failed:', err.message);
    return null;
  }
}
