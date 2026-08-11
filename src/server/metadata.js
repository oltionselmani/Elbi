import { config } from './config.js';

/**
 * Posters, synopses and cast for titles in the library.
 *
 * Two providers, in preference order:
 *
 *   1. TMDB — better artwork, certifications, per-episode data. Every TMDB
 *      endpoint answers 401 without a key, so this path only runs when
 *      ELBI_TMDB_KEY is set. Nothing about the key is ever written to disk
 *      or returned to the browser.
 *   2. Wikipedia + Wikidata — needs no key at all, so posters work out of the
 *      box. Wikipedia supplies the poster image and the synopsis; Wikidata
 *      supplies the structured fields (IMDb id, runtime, genres, director,
 *      cast). The trade-off is image size: en.wikipedia hosts film posters as
 *      low-resolution non-free files, typically ~220px wide.
 */

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size > 300) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function providerName() {
  return config.tmdbKey ? 'tmdb' : 'wikipedia';
}

export function providerStatus() {
  return {
    active: providerName(),
    tmdb: Boolean(config.tmdbKey),
    // Said plainly so the UI never implies TMDB is running when it is not.
    note: config.tmdbKey
      ? 'Matching against TMDB.'
      : 'No TMDB key set (ELBI_TMDB_KEY), so matches come from Wikipedia and Wikidata. Posters are lower resolution.',
  };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Wikimedia asks unauthenticated clients to make requests serially rather than
 * in parallel, and answers bursts with 429s. Requests to a given host are
 * therefore queued behind one another with a minimum gap, which turns a batch
 * enrichment from a burst into a steady trickle.
 */
const HOST_GAP_MS = { 'en.wikipedia.org': 300, 'www.wikidata.org': 300 };
const hostTails = new Map();

function politeSlot(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return Promise.resolve();
  }
  const gap = HOST_GAP_MS[host];
  if (!gap) return Promise.resolve();

  const previous = hostTails.get(host) || Promise.resolve();
  const mine = previous.then(() => sleep(gap));
  hostTails.set(host, mine.catch(() => {}));
  return previous;
}

/**
 * Wikimedia throttles bursts, and TMDB has its own rate limit, so a 429 is
 * retried with backoff rather than surfaced as a failure — the caller is
 * usually enriching a batch of titles and would otherwise lose the lot.
 */
async function fetchJson(url, { timeoutMs = 15000, headers = {}, label = 'metadata provider', attempt = 0 } = {}) {
  await politeSlot(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'Elbi/1.0 (self-hosted media library)', ...headers },
    });
    if (res.status === 429 && attempt < 4) {
      const retryAfter = Number(res.headers.get('retry-after'));
      clearTimeout(timer);
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter, 10) * 1000
        : 800 * 2 ** attempt);
      return fetchJson(url, { timeoutMs, headers, label, attempt: attempt + 1 });
    }
    if (!res.ok) {
      const detail = res.status === 401
        ? `${label} rejected the API key (401). Check ELBI_TMDB_KEY.`
        : res.status === 429
          ? `${label} is rate-limiting this server; try again shortly.`
          : `${label} replied ${res.status}`;
      throw Object.assign(new Error(detail), { status: res.status === 429 ? 429 : 502 });
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw Object.assign(new Error(`${label} timed out`), { status: 504 });
    if (err.status) throw err;
    throw Object.assign(new Error(`Could not reach ${label}: ${err.message}`), { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// TMDB

/**
 * v3 keys go in the query string; v4 read tokens are JWTs and must be sent as
 * a bearer header. Sending the wrong one is a silent 401, so pick by shape.
 */
function tmdbAuth() {
  const key = config.tmdbKey;
  const isJwt = key.split('.').length === 3 && key.startsWith('ey');
  return isJwt
    ? { headers: { Authorization: `Bearer ${key}` }, query: {} }
    : { headers: {}, query: { api_key: key } };
}

function tmdbUrl(path, params = {}) {
  const auth = tmdbAuth();
  const url = new URL(`${config.tmdbBase}${path}`);
  for (const [k, v] of Object.entries({ ...auth.query, ...params })) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return { url: url.toString(), headers: auth.headers };
}

function tmdbImage(path, size) {
  return path ? `${config.tmdbImageBase}/${size}${path}` : null;
}

async function tmdbSearch({ name, year, type }) {
  const isSeries = type === 'series';
  const { url, headers } = tmdbUrl(isSeries ? '/search/tv' : '/search/movie', {
    query: name,
    include_adult: 'false',
    ...(year ? (isSeries ? { first_air_date_year: year } : { year }) : {}),
  });
  const data = await fetchJson(url, { headers, label: 'TMDB' });
  return (data?.results || []).slice(0, 10).map((r) => ({
    provider: 'tmdb',
    ref: String(r.id),
    type: isSeries ? 'series' : 'movie',
    name: r.title || r.name || '',
    year: yearOf(r.release_date || r.first_air_date),
    overview: r.overview || '',
    poster: tmdbImage(r.poster_path, 'w342'),
    popularity: Number(r.popularity) || 0,
  }));
}

async function tmdbDetail(ref, type) {
  const isSeries = type === 'series';
  const { url, headers } = tmdbUrl(`${isSeries ? '/tv' : '/movie'}/${encodeURIComponent(ref)}`, {
    append_to_response: isSeries ? 'credits,content_ratings,external_ids' : 'credits,release_dates',
  });
  const d = await fetchJson(url, { headers, label: 'TMDB' });

  const runtime = isSeries
    ? (Array.isArray(d.episode_run_time) ? d.episode_run_time[0] : null)
    : d.runtime;

  return {
    provider: 'tmdb',
    ref: String(d.id),
    type: isSeries ? 'series' : 'movie',
    name: d.title || d.name || '',
    year: yearOf(d.release_date || d.first_air_date),
    overview: d.overview || '',
    tagline: d.tagline || '',
    genres: (d.genres || []).map((g) => g.name).filter(Boolean),
    poster: tmdbImage(d.poster_path, 'w500'),
    backdrop: tmdbImage(d.backdrop_path, 'w1280'),
    rating: isSeries ? tmdbTvRating(d) : tmdbMovieRating(d),
    runtimeMin: Number.isFinite(Number(runtime)) && Number(runtime) > 0 ? Math.round(Number(runtime)) : null,
    voteAverage: Number(d.vote_average) ? Number(d.vote_average.toFixed(1)) : null,
    imdbId: d.imdb_id || d.external_ids?.imdb_id || '',
    tmdbId: String(d.id),
    cast: (d.credits?.cast || []).slice(0, 12).map((c) => ({ name: c.name, role: c.character || '' })),
    director: (d.credits?.crew || [])
      .filter((c) => c.job === 'Director' || (isSeries && c.job === 'Creator'))
      .map((c) => c.name).slice(0, 3),
    sourceUrl: `https://www.themoviedb.org/${isSeries ? 'tv' : 'movie'}/${d.id}`,
  };
}

function tmdbMovieRating(d) {
  for (const entry of d.release_dates?.results || []) {
    if (entry.iso_3166_1 !== 'US') continue;
    const cert = (entry.release_dates || []).map((r) => r.certification).find(Boolean);
    if (cert) return cert;
  }
  return '';
}

function tmdbTvRating(d) {
  const us = (d.content_ratings?.results || []).find((r) => r.iso_3166_1 === 'US');
  return us?.rating || '';
}

// ---------------------------------------------------------------------------
// Wikipedia + Wikidata (keyless fallback)

/**
 * Search Wikipedia in a single request.
 *
 * `generator=search` runs the search and feeds its hits straight into the
 * property modules, so titles, poster images, intro text and Wikidata ids all
 * come back together. Fetching each page's summary separately instead means
 * one round trip per candidate, which Wikimedia answers with 429s.
 */
async function wikiSearch({ name, year, type }) {
  const hint = type === 'series' ? 'television series' : 'film';
  const url = `${config.wikiBase}/w/api.php?${new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: [name, year || '', hint].filter(Boolean).join(' '),
    gsrlimit: '6',
    prop: 'pageimages|extracts|pageprops',
    piprop: 'original|thumbnail',
    pithumbsize: '500',
    pilimit: '6',
    exintro: '1',
    explaintext: '1',
    exlimit: '6',
    ppprop: 'wikibase_item',
    format: 'json',
    formatversion: '2',
  })}`;
  const data = await fetchJson(url, { label: 'Wikipedia' });
  const pages = data?.query?.pages || [];

  const summaries = pages
    .map((page) => {
      const summary = {
        title: page.title,
        overview: String(page.extract || '').trim(),
        poster: page.original?.source || page.thumbnail?.source || null,
        wikidata: page.pageprops?.wikibase_item || '',
        year: yearFromTitle(page.title) || yearFromText(page.extract),
        pageUrl: `${config.wikiBase}/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
      };
      // Cache under the page title so the detail step needs no second request.
      cacheSet(`wiki:${page.title}`, summary);
      return summary;
    })
    .filter((s) => !/\(disambiguation\)$/i.test(s.title))
    .sort((a, b) => nameCloseness(b.title, name) - nameCloseness(a.title, name));

  // `pageimages` indexes only freely-licensed files, so a 1927 poster comes
  // back but a modern non-free one does not. The REST summary endpoint returns
  // both, so it fills the gaps — sequentially and only for the few candidates
  // most likely to be picked, because bursts of these earn a 429.
  let budget = 4;
  for (const summary of summaries) {
    if (summary.poster || budget <= 0) continue;
    budget -= 1;
    const full = await wikiSummary(summary.title).catch(() => null);
    if (full?.poster) summary.poster = full.poster;
  }

  return summaries.map((s) => ({
    provider: 'wikipedia',
    ref: s.title,
    type,
    name: cleanWikiTitle(s.title),
    year: s.year,
    overview: s.overview,
    poster: s.poster,
    popularity: 0,
  }));
}

/** Rough ordering so the poster budget is spent on the likeliest matches. */
function nameCloseness(pageTitle, wanted) {
  const a = normalizeName(cleanWikiTitle(pageTitle));
  const b = normalizeName(wanted);
  if (a === b) return 2;
  if (a.startsWith(b) || b.startsWith(a)) return 1;
  return 0;
}

/**
 * The REST summary for one page. Cached under its own key: the generator query
 * also caches a `wiki:` entry, and that one may legitimately lack the poster,
 * so sharing a key would make this call a permanent no-op.
 */
async function wikiSummary(pageTitle) {
  const key = `wikirest:${pageTitle}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const url = `${config.wikiBase}/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`;
  const d = await fetchJson(url, { label: 'Wikipedia' });
  return cacheSet(key, {
    title: d.title || pageTitle,
    overview: String(d.extract || '').trim(),
    poster: d.originalimage?.source || d.thumbnail?.source || null,
    wikidata: d.wikibase_item || '',
    year: yearFromTitle(d.title) || yearFromText(d.description) || yearFromText(d.extract),
    pageUrl: d.content_urls?.desktop?.page || `${config.wikiBase}/wiki/${encodeURIComponent(pageTitle)}`,
  });
}

/** "Metropolis (1927 film)" carries its year more reliably than its prose does. */
function yearFromTitle(title) {
  const m = String(title || '').match(/\((?:.*?\b)?(1[89]\d{2}|20\d{2})\b[^)]*\)/);
  return m ? Number.parseInt(m[1], 10) : null;
}

async function wikiDetail(ref, type) {
  // Prefer whatever the search already gathered, and only pay for the REST
  // summary when it is missing something this needs.
  const fromSearch = cacheGet(`wiki:${ref}`);
  let summary = fromSearch;
  if (!summary || !summary.poster || !summary.wikidata) {
    const full = await wikiSummary(ref).catch(() => null);
    if (full) {
      summary = {
        ...(summary || {}),
        ...full,
        poster: full.poster || summary?.poster || null,
        overview: full.overview || summary?.overview || '',
        wikidata: full.wikidata || summary?.wikidata || '',
      };
    }
  }
  if (!summary) summary = await wikiSummary(ref);

  const base = {
    provider: 'wikipedia',
    ref,
    type,
    name: cleanWikiTitle(summary.title),
    year: summary.year,
    overview: summary.overview,
    tagline: '',
    genres: [],
    poster: summary.poster,
    backdrop: null,
    rating: '',
    runtimeMin: null,
    voteAverage: null,
    imdbId: '',
    tmdbId: '',
    cast: [],
    director: [],
    sourceUrl: summary.pageUrl,
  };
  if (!summary.wikidata) return base;

  const facts = await wikidataFacts(summary.wikidata).catch(() => null);
  if (!facts) return base;
  return {
    ...base,
    genres: facts.genres,
    runtimeMin: facts.runtimeMin,
    imdbId: facts.imdbId,
    cast: facts.cast.map((name) => ({ name, role: '' })),
    director: facts.director,
    year: base.year || facts.year,
  };
}

/**
 * Wikidata holds the structured fields Wikipedia's summary endpoint drops.
 * Claim values are entity ids, so labels take a second round trip — batched
 * into one request rather than one per id.
 */
async function wikidataFacts(entityId) {
  const key = `wd:${entityId}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const url = `https://www.wikidata.org/w/api.php?${new URLSearchParams({
    action: 'wbgetentities', ids: entityId, props: 'claims', format: 'json', origin: '*',
  })}`;
  const data = await fetchJson(url, { label: 'Wikidata' });
  const claims = data?.entities?.[entityId]?.claims || {};

  const values = (prop) => (claims[prop] || [])
    .map((c) => c.mainsnak?.datavalue?.value)
    .filter((v) => v !== undefined && v !== null);

  const genreIds = values('P136').map((v) => v.id).filter(Boolean).slice(0, 6);
  const directorIds = values('P57').map((v) => v.id).filter(Boolean).slice(0, 3);
  const castIds = values('P161').map((v) => v.id).filter(Boolean).slice(0, 10);

  const labels = await wikidataLabels([...genreIds, ...directorIds, ...castIds]);

  // P2047 is a quantity with a unit; Q7727 is "minute". Anything else is left
  // alone rather than guessed at.
  let runtimeMin = null;
  const duration = values('P2047')[0];
  if (duration && String(duration.unit || '').endsWith('Q7727')) {
    const amount = Number.parseFloat(String(duration.amount).replace('+', ''));
    if (Number.isFinite(amount) && amount > 0) runtimeMin = Math.round(amount);
  }

  const facts = {
    imdbId: values('P345')[0] || '',
    runtimeMin,
    year: yearFromText(values('P577')[0]?.time || ''),
    genres: genreIds.map((id) => labels[id]).filter(Boolean).map(titleCase),
    director: directorIds.map((id) => labels[id]).filter(Boolean),
    cast: castIds.map((id) => labels[id]).filter(Boolean),
  };
  return cacheSet(key, facts);
}

async function wikidataLabels(ids) {
  const unique = [...new Set(ids)].slice(0, 50);
  if (!unique.length) return {};
  const url = `https://www.wikidata.org/w/api.php?${new URLSearchParams({
    action: 'wbgetentities', ids: unique.join('|'), props: 'labels', languages: 'en', format: 'json', origin: '*',
  })}`;
  const data = await fetchJson(url, { label: 'Wikidata' }).catch(() => null);
  const out = {};
  for (const [id, entity] of Object.entries(data?.entities || {})) {
    const label = entity?.labels?.en?.value;
    if (label) out[id] = label;
  }
  return out;
}

function cleanWikiTitle(title) {
  // "Inception (2010 film)" -> "Inception"
  return String(title).replace(/\s*\((?:[^)]*\b(?:film|series|TV|miniseries)\b[^)]*)\)\s*$/i, '').trim();
}

// ---------------------------------------------------------------------------
// public API

/** Candidate matches for a title, best first. */
export async function search({ name, year = null, type = 'movie' } = {}) {
  const clean = String(name || '').trim();
  if (!clean) throw Object.assign(new Error('A title name is required'), { status: 400 });
  const kind = type === 'series' ? 'series' : 'movie';
  const key = `search:${providerName()}:${kind}:${clean.toLowerCase()}:${year || ''}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const results = config.tmdbKey
    ? await tmdbSearch({ name: clean, year, type: kind })
    : await wikiSearch({ name: clean, year, type: kind });

  const ranked = results
    .map((r) => ({ ...r, score: scoreCandidate(r, clean, year) }))
    .sort((a, b) => b.score - a.score);
  return cacheSet(key, { provider: providerName(), results: ranked });
}

/** Full metadata for one candidate. */
export async function detail({ provider, ref, type = 'movie' } = {}) {
  if (!ref) throw Object.assign(new Error('A provider reference is required'), { status: 400 });
  const kind = type === 'series' ? 'series' : 'movie';
  const which = provider || providerName();
  const key = `detail:${which}:${kind}:${ref}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  if (which === 'tmdb') {
    if (!config.tmdbKey) {
      throw Object.assign(new Error('TMDB is not configured on this server (set ELBI_TMDB_KEY).'), { status: 400 });
    }
    return cacheSet(key, await tmdbDetail(ref, kind));
  }
  return cacheSet(key, await wikiDetail(ref, kind));
}

/**
 * Pick a match without asking. Only returns something when the top candidate
 * is a confident match — a wrong poster is worse than no poster.
 */
export async function autoMatch({ name, year = null, type = 'movie' } = {}) {
  const { results } = await search({ name, year, type });
  const best = results[0];
  if (!best || best.score < 0.6) return null;
  // A clear runner-up means the title is ambiguous; leave it to the user.
  if (results[1] && results[1].score >= best.score - 0.05 && !exactName(best.name, name)) return null;
  return detail({ provider: best.provider, ref: best.ref, type });
}

/** 0..1 confidence that a candidate is the title we asked about. */
function scoreCandidate(candidate, name, year) {
  const a = normalizeName(candidate.name);
  const b = normalizeName(name);
  let score = 0;
  if (a === b) score = 1;
  else if (a.startsWith(b) || b.startsWith(a)) score = 0.8;
  else if (a.includes(b) || b.includes(a)) score = 0.65;
  else score = tokenOverlap(a, b) * 0.6;

  if (year && candidate.year) {
    const gap = Math.abs(Number(candidate.year) - Number(year));
    if (gap === 0) score += 0.15;
    else if (gap === 1) score += 0.05;
    else score -= Math.min(0.35, 0.08 * gap);
  }
  if (!candidate.poster) score -= 0.1;
  return Math.max(0, Math.min(1, score));
}

function tokenOverlap(a, b) {
  const at = new Set(a.split(' ').filter(Boolean));
  const bt = new Set(b.split(' ').filter(Boolean));
  if (!at.size || !bt.size) return 0;
  let shared = 0;
  for (const t of at) if (bt.has(t)) shared += 1;
  return shared / Math.max(at.size, bt.size);
}

function exactName(a, b) {
  return normalizeName(a) === normalizeName(b);
}

function normalizeName(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function yearOf(dateString) {
  const m = String(dateString || '').match(/^(\d{4})/);
  return m ? Number.parseInt(m[1], 10) : null;
}

function yearFromText(text) {
  const m = String(text || '').match(/(1[89]\d{2}|20\d{2})/);
  return m ? Number.parseInt(m[1], 10) : null;
}

function titleCase(input) {
  return String(input).replace(/^\w/, (c) => c.toUpperCase());
}

/** Fields from a provider result that are safe to write onto a title. */
export function mergeIntoTitle(title, meta, { overwrite = false } = {}) {
  const changed = [];
  const set = (key, value) => {
    if (value === null || value === undefined || value === '') return;
    if (Array.isArray(value) && !value.length) return;
    const current = title[key];
    const empty = current === null || current === undefined || current === ''
      || (Array.isArray(current) && !current.length);
    if (!overwrite && !empty) return;
    if (JSON.stringify(current) === JSON.stringify(value)) return;
    title[key] = value;
    changed.push(key);
  };

  set('overview', meta.overview);
  set('poster', meta.poster);
  set('backdrop', meta.backdrop || meta.poster);
  set('genres', meta.genres);
  set('rating', meta.rating);
  set('runtimeMin', meta.runtimeMin);
  set('year', meta.year);
  set('tagline', meta.tagline);
  set('cast', meta.cast);
  set('director', meta.director);
  set('voteAverage', meta.voteAverage);

  // Identifiers are always refreshed: they are how later lookups (subtitle
  // search especially) stay accurate, and they are not user-authored content.
  if (meta.imdbId) { title.imdbId = meta.imdbId; changed.push('imdbId'); }
  if (meta.tmdbId) { title.tmdbId = meta.tmdbId; changed.push('tmdbId'); }
  title.metadata = {
    provider: meta.provider,
    ref: meta.ref,
    url: meta.sourceUrl || '',
    matchedAt: Date.now(),
  };
  return [...new Set(changed)];
}
