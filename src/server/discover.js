import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';
import { qualityLabel } from './util.js';

/**
 * "Watch without downloading" — a live browser over the Internet Archive's
 * public-domain feature-film collections. Elbi proxies the two archive.org
 * JSON endpoints so the browser never hits CORS and so the whole feature can
 * be switched off with ELBI_ALLOW_REMOTE=0.
 */

const SEARCH_URL = 'https://archive.org/advancedsearch.php';
const METADATA_URL = 'https://archive.org/metadata';
const COLLECTIONS = ['feature_films', 'film_noir', 'silent_films', 'classic_cartoons', 'sci-fi_horror'];

const searchCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function cacheGet(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (searchCache.size > 200) searchCache.clear();
  searchCache.set(key, { at: Date.now(), value });
}

function requireRemote() {
  if (!config.allowRemote) {
    throw Object.assign(
      new Error('Remote sources are disabled on this server (ELBI_ALLOW_REMOTE=0).'),
      { status: 403 },
    );
  }
}

async function fetchJson(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'Elbi/1.0 (self-hosted media library)' },
    });
    if (!res.ok) {
      throw Object.assign(new Error(`archive.org replied ${res.status}`), { status: 502 });
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw Object.assign(new Error('archive.org timed out'), { status: 504 });
    }
    if (err.status) throw err;
    throw Object.assign(new Error(`Could not reach archive.org: ${err.message}`), { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}

/** Escape Lucene syntax so a user's search text can never change the query shape. */
function escapeLucene(input) {
  return String(input).replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, '\\$1').trim();
}

export async function search({ q = '', collection = '', page = 1, rows = 40 } = {}) {
  requireRemote();
  const pageNum = Math.max(1, Math.min(50, Number.parseInt(page, 10) || 1));
  const rowCount = Math.max(1, Math.min(60, Number.parseInt(rows, 10) || 40));
  const chosen = COLLECTIONS.includes(collection) ? collection : '';

  const clauses = ['mediatype:movies'];
  clauses.push(chosen ? `collection:${chosen}` : `(${COLLECTIONS.map((c) => `collection:${c}`).join(' OR ')})`);
  const text = escapeLucene(q);
  if (text) clauses.push(`(title:(${text}) OR description:(${text}) OR creator:(${text}))`);

  const params = new URLSearchParams();
  params.set('q', clauses.join(' AND '));
  for (const field of ['identifier', 'title', 'year', 'description', 'creator', 'downloads', 'runtime']) {
    params.append('fl[]', field);
  }
  params.set('rows', String(rowCount));
  params.set('page', String(pageNum));
  params.set('output', 'json');
  if (!text) {
    params.set('sort[]', 'downloads desc');
  }

  const url = `${SEARCH_URL}?${params.toString()}`;
  const cached = cacheGet(url);
  if (cached) return cached;

  const data = await fetchJson(url);
  const docs = data?.response?.docs || [];
  const result = {
    total: data?.response?.numFound || 0,
    page: pageNum,
    collections: COLLECTIONS,
    results: docs.map((doc) => ({
      identifier: doc.identifier,
      name: cleanTitle(doc.title || doc.identifier),
      year: normalizeYear(doc.year),
      overview: truncate(stripTags(firstOf(doc.description)), 400),
      creator: firstOf(doc.creator) || '',
      downloads: doc.downloads || 0,
      poster: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
      pageUrl: `https://archive.org/details/${encodeURIComponent(doc.identifier)}`,
    })),
  };
  cacheSet(url, result);
  return result;
}

/** Playable renditions for one archive.org item, best quality first. */
export async function item(identifier) {
  requireRemote();
  if (!/^[\w.@-]{1,200}$/.test(String(identifier))) {
    throw Object.assign(new Error('Invalid archive.org identifier'), { status: 400 });
  }
  const url = `${METADATA_URL}/${encodeURIComponent(identifier)}`;
  const cached = cacheGet(url);
  if (cached) return cached;

  const data = await fetchJson(url);
  if (!data?.metadata) throw Object.assign(new Error('That archive.org item does not exist'), { status: 404 });

  const meta = data.metadata;
  const files = Array.isArray(data.files) ? data.files : [];

  const playable = files
    .filter((f) => /\.(mp4|m4v|ogv|webm)$/i.test(f.name || ''))
    .filter((f) => !/\b(thumb|sample)\b/i.test(f.name))
    .map((f) => {
      const height = Number.parseInt(f.height, 10) || heightFromName(f.name);
      const support = rateArchiveFormat(f.format, f.name);
      return {
        name: f.name,
        size: Number.parseInt(f.size, 10) || null,
        height: height || null,
        width: Number.parseInt(f.width, 10) || null,
        format: f.format || '',
        codec: support.codec,
        playability: { level: support.level, note: support.note },
        durationSec: parseDuration(f.length),
        url: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURI(f.name)}`,
        label: height ? qualityLabel(height) : (f.format || 'Source'),
      };
    })
    // Codec support first — a 480p H.264 file beats a 720p one no browser can decode.
    .sort((a, b) => tier(a) - tier(b) || (b.height || 0) - (a.height || 0) || (b.size || 0) - (a.size || 0));

  const subtitles = files
    .filter((f) => /\.(vtt|srt)$/i.test(f.name || ''))
    .map((f) => ({
      label: f.name,
      lang: (f.name.match(/[._-]([a-z]{2,3})\.(vtt|srt)$/i)?.[1] || 'und').toLowerCase(),
      url: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURI(f.name)}`,
    }));

  const result = {
    identifier,
    name: cleanTitle(meta.title || identifier),
    year: normalizeYear(meta.year || meta.date),
    overview: truncate(stripTags(firstOf(meta.description)), 1200),
    creator: firstOf(meta.creator) || '',
    license: meta.licenseurl || meta.rights || 'Public domain / see archive.org item page',
    poster: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
    pageUrl: `https://archive.org/details/${encodeURIComponent(identifier)}`,
    runtimeMin: playable[0]?.durationSec ? Math.round(playable[0].durationSec / 60) : null,
    sources: playable.slice(0, 8),
    subtitles,
  };
  if (!result.sources.length) {
    throw Object.assign(
      new Error('This archive.org item has no browser-playable video file (only formats like .avi/.mpg).'),
      { status: 422 },
    );
  }
  cacheSet(url, result);
  return result;
}

const TIERS = { direct: 0, maybe: 1, unsupported: 2 };
function tier(source) {
  return TIERS[source.playability.level] ?? 2;
}

/**
 * archive.org's `format` field names the codec, and the difference matters:
 * "h.264" plays everywhere, while "MPEG4" there means MPEG-4 Part 2 (DivX-era),
 * which Chrome cannot decode, and "Ogg Video" is Theora, which Chrome dropped
 * in 2024. Say so rather than handing the player a file it will reject.
 */
function rateArchiveFormat(format, name) {
  const f = String(format || '').toLowerCase();
  const ext = String(name || '').toLowerCase().split('.').pop();

  if (/h\.?264|avc|mpeg4 \(h/.test(f)) {
    return { codec: 'H.264', level: 'direct', note: '' };
  }
  if (ext === 'webm' || /vp8|vp9|webm/.test(f)) {
    return { codec: 'VP8/VP9', level: 'direct', note: '' };
  }
  if (/ogg|theora/.test(f) || ext === 'ogv') {
    return {
      codec: 'Theora',
      level: 'maybe',
      note: 'Ogg Theora — Firefox plays it, but Chrome removed Theora support in 2024.',
    };
  }
  if (/mpeg4|mpeg-4|divx|xvid/.test(f)) {
    return {
      codec: 'MPEG-4 Part 2',
      level: 'maybe',
      note: 'MPEG-4 Part 2 (DivX/Xvid). Most browsers cannot decode this; pick an H.264 rendition if the item has one.',
    };
  }
  if (ext === 'mp4' || ext === 'm4v') {
    return { codec: format || 'unknown', level: 'maybe', note: 'Unlabelled MP4 — it may or may not hold H.264.' };
  }
  return { codec: format || 'unknown', level: 'maybe', note: '' };
}

function heightFromName(name) {
  const m = String(name).match(/(\d{3,4})p/i);
  return m ? Number.parseInt(m[1], 10) : null;
}

function parseDuration(value) {
  if (!value) return null;
  const str = String(value);
  if (/^\d+(\.\d+)?$/.test(str)) return Math.round(Number.parseFloat(str));
  const parts = str.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return Math.round(parts.reduce((acc, n) => acc * 60 + n, 0));
}

function firstOf(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}
function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}
function truncate(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
function cleanTitle(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 200);
}
function normalizeYear(value) {
  const m = String(firstOf(value) || '').match(/(1[89]\d{2}|20\d{2})/);
  return m ? Number.parseInt(m[1], 10) : null;
}

const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

/**
 * Reject URLs that resolve to the loopback/private network, so "add by URL"
 * cannot be turned into a port scanner against the host running Elbi.
 */
export async function assertPublicUrl(rawUrl) {
  requireRemote();
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw Object.assign(new Error('That is not a valid URL'), { status: 400 });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw Object.assign(new Error('Only http(s) URLs are supported'), { status: 400 });
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host)
    ? [host]
    : (await dns.lookup(host, { all: true }).catch(() => []))
      .map((a) => a.address);

  if (!addresses.length) {
    throw Object.assign(new Error(`Could not resolve ${url.hostname}`), { status: 400 });
  }
  for (const address of addresses) {
    if (net.isIPv4(address) && PRIVATE_V4.some((re) => re.test(address))) {
      throw Object.assign(new Error('Refusing to fetch a private/loopback address'), { status: 400 });
    }
    if (net.isIPv6(address)) {
      const lower = address.toLowerCase();
      if (lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) {
        throw Object.assign(new Error('Refusing to fetch a private/loopback address'), { status: 400 });
      }
    }
  }
  return url;
}

/**
 * Same-origin proxy for a remote source. Needed for offline downloads, where
 * the service worker must be able to read the response body.
 */
export async function proxyRemote(req, res, rawUrl) {
  const url = await assertPublicUrl(rawUrl);
  const headers = {
    'User-Agent': 'Elbi/1.0 (self-hosted media library)',
    Accept: '*/*',
  };
  if (req.headers.range) headers.Range = req.headers.range;

  const controller = new AbortController();
  req.on('close', () => controller.abort());
  // Bound the connect phase only — once headers arrive the body may legitimately
  // stream for hours, so the timer is cleared rather than covering the transfer.
  const connectTimer = setTimeout(() => controller.abort(), 25_000);

  let upstream;
  try {
    upstream = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
  } catch (err) {
    clearTimeout(connectTimer);
    if (req.destroyed || res.writableEnded) return;
    const timedOut = controller.signal.aborted;
    res.writeHead(timedOut ? 504 : 502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(timedOut ? 'Upstream timed out' : `Upstream fetch failed: ${err.message}`);
    return;
  }
  clearTimeout(connectTimer);

  const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
  const out = { 'Cache-Control': 'public, max-age=3600' };
  for (const name of passthrough) {
    const value = upstream.headers.get(name);
    if (value) out[name.replace(/(^|-)([a-z])/g, (_, a, b) => a + b.toUpperCase())] = value;
  }
  res.writeHead(upstream.status, out);

  if (req.method === 'HEAD' || !upstream.body) {
    res.end();
    return;
  }
  try {
    for await (const chunk of upstream.body) {
      if (!res.write(chunk)) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
    res.end();
  } catch {
    if (!res.writableEnded) res.destroy();
  }
}
