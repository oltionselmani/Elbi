import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { config } from './config.js';
import { srtToVtt } from './util.js';

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);

/**
 * Subtitle search, aimed squarely at Albanian.
 *
 * opensubtitles' legacy REST host needs no API key, which is why it is used
 * here: the feature works on a fresh checkout with nothing to configure.
 * Downloads come back as gzipped SubRip in whatever legacy codepage the
 * uploader's editor used, so the pipeline is:
 *
 *     search -> download .gz -> gunzip -> decode declared charset -> SRT -> VTT
 *
 * Uploader advertising is stripped on the way through; those cues are injected
 * by the download site, not written by the translator.
 */

// ISO 639-2/B codes, which is what this API speaks, mapped to the 639-1 codes
// the <track> element wants. Albanian is the point of the exercise; the others
// are here so the same picker can fetch a second language.
export const LANGUAGES = [
  { id: 'alb', iso1: 'sq', name: 'Albanian' },
  { id: 'eng', iso1: 'en', name: 'English' },
  { id: 'ita', iso1: 'it', name: 'Italian' },
  { id: 'ger', iso1: 'de', name: 'German' },
  { id: 'fre', iso1: 'fr', name: 'French' },
  { id: 'spa', iso1: 'es', name: 'Spanish' },
  { id: 'gre', iso1: 'el', name: 'Greek' },
  { id: 'tur', iso1: 'tr', name: 'Turkish' },
  { id: 'srp', iso1: 'sr', name: 'Serbian' },
  { id: 'mac', iso1: 'mk', name: 'Macedonian' },
];

const BY_ID = new Map(LANGUAGES.map((l) => [l.id, l]));

export function resolveLanguage(input) {
  const raw = String(input || config.defaultSubtitleLang).trim().toLowerCase();
  if (BY_ID.has(raw)) return BY_ID.get(raw);
  const byIso = LANGUAGES.find((l) => l.iso1 === raw);
  if (byIso) return byIso;
  // Accept anything that looks like a language code rather than refusing —
  // the API knows more codes than this list does.
  if (/^[a-z]{2,3}$/.test(raw)) return { id: raw, iso1: raw.slice(0, 2), name: raw.toUpperCase() };
  throw Object.assign(new Error(`"${input}" is not a language code`), { status: 400 });
}

function requireRemote() {
  if (!config.allowRemote) {
    throw Object.assign(
      new Error('Subtitle search needs outbound network access, which is off (ELBI_ALLOW_REMOTE=0).'),
      { status: 403 },
    );
  }
}

const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();

async function fetchOpenSubtitles(pathSegments, timeoutMs = 20000) {
  const url = `${config.subsBase}/search/${pathSegments.join('/')}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res = await fetch(url, {
      signal: controller.signal,
      // This host rejects requests without a User-Agent it recognises.
      headers: { 'User-Agent': config.subsUserAgent, Accept: 'application/json' },
      // Redirects are handled by hand: see canonicalRedirect below.
      redirect: 'manual',
    });

    if (res.status >= 300 && res.status < 400) {
      const next = canonicalRedirect(res.headers.get('location'));
      if (!next) throw Object.assign(new Error('Subtitle search redirected somewhere unusable'), { status: 502 });
      res = await fetch(next, {
        signal: controller.signal,
        headers: { 'User-Agent': config.subsUserAgent, Accept: 'application/json' },
        redirect: 'manual',
      });
    }

    if (res.status === 429) {
      throw Object.assign(new Error('The subtitle service is rate-limiting; try again in a minute.'), { status: 429 });
    }
    if (!res.ok) throw Object.assign(new Error(`Subtitle search replied ${res.status}`), { status: 502 });
    const text = await res.text();
    // An empty body is a legitimate "no matches", not a parse failure.
    const data = text.trim() ? JSON.parse(text) : [];
    const value = Array.isArray(data) ? data : [];
    if (cache.size > 200) cache.clear();
    cache.set(url, { at: Date.now(), value });
    return value;
  } catch (err) {
    if (err.name === 'AbortError') throw Object.assign(new Error('Subtitle search timed out'), { status: 504 });
    if (err.status) throw err;
    if (err instanceof SyntaxError) {
      throw Object.assign(new Error('The subtitle service returned something that was not JSON.'), { status: 502 });
    }
    throw Object.assign(new Error(`Could not reach the subtitle service: ${err.message}`), { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Path segments are `key-value` pairs; the value must not smuggle a slash.
 *
 * Lowercasing is not cosmetic. This API treats a mixed-case path as
 * non-canonical and answers 302 — to `https://_/…`, a Location header with a
 * placeholder where the hostname should be. Sending the canonical form is what
 * keeps the request a single 200.
 */
function segment(key, value) {
  const clean = String(value)
    .toLowerCase()
    .replace(/[^\w\s.'&:-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${key}-${encodeURIComponent(clean)}`;
}

/**
 * Rebuild a redirect against the configured host. The upstream sends a broken
 * hostname, so only the path is trusted — and it is never allowed to leave
 * the /search/ prefix.
 */
function canonicalRedirect(location) {
  if (!location) return null;
  let pathname;
  try {
    pathname = new URL(location, config.subsBase).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith('/search/')) return null;
  return `${config.subsBase}${pathname}`;
}

/**
 * Candidates for one title, best first. An IMDb id (which the metadata match
 * fills in) gives an exact lookup; otherwise it falls back to a text query.
 */
export async function search({
  query = '', imdbId = '', season = null, episode = null, lang, limit = 12,
} = {}) {
  requireRemote();
  const language = resolveLanguage(lang);

  const parts = [];
  if (episode !== null && episode !== undefined && episode !== '') parts.push(segment('episode', Number(episode) || 0));
  const cleanImdb = String(imdbId || '').replace(/^tt/i, '').replace(/\D/g, '');
  if (cleanImdb) parts.push(`imdbid-${cleanImdb}`);
  else if (String(query).trim()) parts.push(segment('query', query));
  else throw Object.assign(new Error('Searching needs a title name or an IMDb id'), { status: 400 });
  if (season !== null && season !== undefined && season !== '') parts.push(segment('season', Number(season) || 0));
  parts.push(`sublanguageid-${encodeURIComponent(language.id)}`);

  // Path order matters to this API: keys are sorted alphabetically.
  parts.sort();

  let rows = await fetchOpenSubtitles(parts);

  // An IMDb lookup on a series returns the whole show; keep the asked-for episode.
  if (season !== null && season !== undefined && season !== '') {
    const wantSeason = Number(season);
    const wantEpisode = Number(episode);
    const filtered = rows.filter((r) => Number(r.SeriesSeason) === wantSeason
      && (!Number.isFinite(wantEpisode) || Number(r.SeriesEpisode) === wantEpisode));
    if (filtered.length) rows = filtered;
  }

  return {
    language: { id: language.id, iso1: language.iso1, name: language.name },
    results: rows
      .map(shapeCandidate)
      .filter((r) => r.downloadUrl)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(40, Number(limit) || 12))),
  };
}

function shapeCandidate(row) {
  const downloads = Number.parseInt(row.SubDownloadsCnt, 10) || 0;
  const rating = Number.parseFloat(row.SubRating) || 0;
  return {
    id: String(row.IDSubtitleFile || row.IDSubtitle || ''),
    filename: row.SubFileName || 'subtitles.srt',
    movieName: row.MovieName || '',
    year: Number.parseInt(row.MovieYear, 10) || null,
    season: Number.parseInt(row.SeriesSeason, 10) || null,
    episode: Number.parseInt(row.SeriesEpisode, 10) || null,
    lang: (row.ISO639 || '').toLowerCase(),
    langName: row.LanguageName || '',
    format: (row.SubFormat || 'srt').toLowerCase(),
    encoding: row.SubEncoding || '',
    downloads,
    rating,
    fps: Number.parseFloat(row.MovieFPS) || null,
    hearingImpaired: row.SubHearingImpaired === '1',
    // The API exposes machine translations; they read badly, so they sink.
    machineTranslated: row.SubAutoTranslation === '1',
    trusted: row.SubFromTrusted === '1',
    imdbId: row.IDMovieImdb ? `tt${String(row.IDMovieImdb).padStart(7, '0')}` : '',
    uploader: row.UserNickName || '',
    downloadUrl: row.SubDownloadLink || '',
    score: candidateScore({ downloads, rating, row }),
  };
}

function candidateScore({ downloads, rating, row }) {
  // Downloads span several orders of magnitude, so they are compressed before
  // being weighed against a 0-10 rating.
  let score = Math.log10(downloads + 1) * 2;
  if (rating > 0) score += rating / 2;
  if (row.SubFromTrusted === '1') score += 1.5;
  if (row.SubAutoTranslation === '1') score -= 6;
  if (row.MatchedBy === 'moviehash') score += 3;
  else if (row.MatchedBy === 'imdbid') score += 1;
  if ((row.SubFormat || 'srt').toLowerCase() !== 'srt') score -= 1;
  return Number(score.toFixed(3));
}

const MAX_SUBTITLE_BYTES = 4 * 1024 * 1024;

/**
 * Download one candidate and return ready-to-serve WebVTT.
 * The URL must belong to the configured subtitle host: it arrives from a
 * search result, but it reaches here through the browser, so it is checked
 * rather than trusted.
 */
export async function download({ url, encoding = '', format = 'srt' } = {}) {
  requireRemote();
  const target = assertSubtitleUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  let res;
  try {
    res = await fetch(target, {
      signal: controller.signal,
      headers: { 'User-Agent': config.subsUserAgent, Accept: '*/*' },
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw Object.assign(new Error('Subtitle download timed out'), { status: 504 });
    throw Object.assign(new Error(`Subtitle download failed: ${err.message}`), { status: 502 });
  }
  clearTimeout(timer);

  if (res.status === 429 || res.status === 407) {
    throw Object.assign(
      new Error('The subtitle service has hit its free download limit for now. Try again later.'),
      { status: 429 },
    );
  }
  if (!res.ok) throw Object.assign(new Error(`Subtitle download replied ${res.status}`), { status: 502 });

  const raw = Buffer.from(await res.arrayBuffer());
  if (!raw.length) throw Object.assign(new Error('The subtitle file was empty'), { status: 502 });
  if (raw.length > MAX_SUBTITLE_BYTES) {
    throw Object.assign(new Error('That subtitle file is implausibly large; refusing it.'), { status: 413 });
  }

  const bytes = await decompress(raw);
  const text = decodeText(bytes, encoding);
  const cleaned = stripPromoCues(String(format).toLowerCase() === 'vtt' ? text : srtToVtt(text));
  if (!/\d{2}:\d{2}:\d{2}\.\d{3}\s*-->/.test(cleaned)) {
    throw Object.assign(new Error('That download did not contain readable subtitle timings.'), { status: 502 });
  }
  return cleaned;
}

export function assertSubtitleUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw Object.assign(new Error('That is not a valid subtitle URL'), { status: 400 });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw Object.assign(new Error('Only http(s) subtitle URLs are supported'), { status: 400 });
  }
  const allowed = new Set([
    new URL(config.subsBase).hostname.toLowerCase(),
    'dl.opensubtitles.org',
    'www.opensubtitles.org',
    'opensubtitles.org',
  ]);
  const host = url.hostname.toLowerCase();
  const ok = [...allowed].some((h) => host === h || host.endsWith(`.${h}`));
  if (!ok) {
    throw Object.assign(new Error(`Refusing to download subtitles from ${host}`), { status: 400 });
  }
  return url;
}

/** gzip and zlib both show up here; plain text is passed straight through. */
async function decompress(buffer) {
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return gunzip(buffer);
  if (buffer[0] === 0x78) return inflate(buffer).catch(() => buffer);
  return buffer;
}

/**
 * Legacy subtitles are rarely UTF-8. The API declares the codepage it detected;
 * that is honoured, with a UTF-8 sniff first because a correct UTF-8 file
 * decoded as CP1252 turns every accent into mojibake.
 */
export function decodeText(bytes, declaredEncoding) {
  const buffer = Buffer.from(bytes);
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  if (isValidUtf8(buffer)) return buffer.toString('utf8');

  const declared = normalizeEncoding(declaredEncoding);
  for (const label of [declared, 'windows-1252', 'windows-1250', 'iso-8859-1'].filter(Boolean)) {
    try {
      return new TextDecoder(label, { fatal: false }).decode(buffer);
    } catch { /* unknown label — fall through to the next */ }
  }
  return buffer.toString('latin1');
}

function normalizeEncoding(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'utf-8' || raw === 'utf8' || raw === 'ascii') return '';
  if (/^cp(\d+)$/.test(raw)) return `windows-${raw.slice(2)}`;
  if (/^windows-?\d+$/.test(raw)) return raw.replace('windows', 'windows-').replace('--', '-');
  return raw;
}

/** Node has no isUtf8 in every release path, so decode strictly and see. */
function isValidUtf8(buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

const PROMO = [
  /opensubtitles|osdb|addic7ed|subscene|podnapisi/i,
  /subtitles?\s+(by|downloaded|search|provided)/i,
  /advertise your product|support us and become|become vip member/i,
  // Injected ads rotate their domain (getray.app became tryray.app mid-2026),
  // so the shape of a bare URL is matched rather than any particular brand.
  /\b[a-z0-9][a-z0-9-]{1,30}\.(com|org|net|app|io|tv|me|co)\b/i,
].map((re) => re.source).join('|');
const PROMO_RE = new RegExp(PROMO, 'i');

/**
 * Drop cues that advertise the download site rather than translate the film.
 * Only very short cues at the very start or end are eligible, so a line of
 * real dialogue that happens to mention a website survives.
 */
export function stripPromoCues(vtt) {
  const text = String(vtt).replace(/\r\n?/g, '\n');
  const header = 'WEBVTT';
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const kept = [];
  const cueBlocks = [];

  for (const block of blocks) {
    if (block.startsWith(header) || !/-->/.test(block)) {
      kept.push(block);
      continue;
    }
    cueBlocks.push(block);
  }

  // Only the outermost cues are candidates. On a short track — a forced
  // narrative title, a few signs — "second from the end" is still the middle
  // of the film, so the tail rule is held back until there is a real tail.
  const eligible = new Set(
    (cueBlocks.length > 6
      ? [0, 1, cueBlocks.length - 2, cueBlocks.length - 1]
      : [0]
    ).filter((i) => i >= 0),
  );
  const filtered = cueBlocks.filter((block, index) => {
    if (!eligible.has(index)) return true;
    const body = block.split('\n').filter((line) => !/-->/.test(line)).join(' ');
    return !(PROMO_RE.test(body) && body.length < 200);
  });

  const head = kept.length ? kept.join('\n\n') : header;
  return `${head.startsWith(header) ? head : `${header}\n\n${head}`}\n\n${filtered.join('\n\n')}\n`;
}
