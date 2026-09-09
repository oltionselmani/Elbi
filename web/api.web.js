/**
 * Elbi's server, in the browser.
 *
 * The hosted build is one HTML file with nothing behind it, so this stands in
 * for src/server/api.js: same call surface, same payload shapes, same rules
 * about what counts as finished and who has watched what. Everything the real
 * server keeps in library.json is kept in localStorage instead, and everything
 * it reads off disk — the clips, and any file you add yourself — is kept as a
 * Blob in IndexedDB and handed out as an object URL.
 *
 * What genuinely cannot work without a machine of your own is refused with a
 * plain explanation rather than a broken screen: scanning a folder, importing
 * from the Internet Archive, looking up posters, and searching for subtitles
 * all need a server that can reach a filesystem and the network.
 */

import { sampleTitles, sampleProgress, sampleMyList } from './samplelib.js';
import { MEDIA } from './media.js';

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload || {};
  }
}

// Nothing here can return 401, but app.js registers a handler and the shape of
// this module should not depend on that.
export function setUnauthorizedHandler() {}

const NO_SERVER = (what) => new ApiError(
  `${what} needs Elbi running on your own computer — this copy has no server behind it.`,
  503,
  { hostedBuild: true },
);

// --------------------------------------------------------------------------
// storage

const DB_KEY = 'elbi.web.db';
// Bumped when the sample library changes, so an existing browser picks up the
// new titles without losing anything the person added or watched.
const SEED_VERSION = 1;

const PROFILES = [
  { id: 'p_olti', name: 'Olti', color: '#8f3a24' },
  { id: 'p_elbi', name: 'Elbi', color: '#2c5f66' },
  { id: 'p_oltion', name: 'Oltion', color: '#7b6432' },
  { id: 'p_elbasana', name: 'Elbasana', color: '#5b3a63' },
];

const DEFAULT_SETTINGS = {
  seekStep: 5,
  doubleClickSeek: 5,
  autoplayNext: true,
  resumeRewind: 5,
  subtitleSize: 'medium',
  subtitleBackground: 'shadow',
  skipIntro: true,
  subtitleLanguage: 'alb',
  autoSubtitles: true,
  autoMatchMetadata: false,
  sleepTimerMinutes: 45,
  showWhoWatched: true,
};

let db = null;

function emptyDb() {
  return {
    seed: 0,
    titles: [],
    progress: {},
    myList: {},
    subtitleChoice: {},
    settings: { ...DEFAULT_SETTINGS },
  };
}

function readStored() {
  try {
    const raw = JSON.parse(localStorage.getItem(DB_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return emptyDb();
    return { ...emptyDb(), ...raw, settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) } };
  } catch {
    return emptyDb();
  }
}

function save() {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  } catch (err) {
    // Out of localStorage is worth knowing about rather than losing quietly.
    console.warn('[elbi] could not save the library:', err.message);
  }
}

// --------------------------------------------------------------------------
// media: sample clips from the bundle, added files from IndexedDB

const IDB_NAME = 'elbi-web';
const IDB_STORE = 'media';
const mediaUrls = new Map();
const subtitleUrls = new Map();

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, run) {
  const conn = await openIdb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = conn.transaction(IDB_STORE, mode);
      const req = run(tx.objectStore(IDB_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    conn.close();
  }
}

function base64ToBlob(base64, type) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** A stable https URL for one media key, or '' when the blob has gone. */
export function assetUrl(key) {
  if (!key) return null;
  return mediaUrls.get(key) || key;
}

// --------------------------------------------------------------------------
// boot

async function loadMedia() {
  for (const [key, entry] of Object.entries(MEDIA)) {
    mediaUrls.set(key, URL.createObjectURL(base64ToBlob(entry.b64, entry.type)));
  }
  try {
    const keys = await idb('readonly', (store) => store.getAllKeys());
    for (const key of keys) {
      const blob = await idb('readonly', (store) => store.get(key));
      if (blob) mediaUrls.set(key, URL.createObjectURL(blob));
    }
  } catch (err) {
    console.warn('[elbi] could not read saved files:', err.message);
  }
}

function seed() {
  const mine = db.titles.filter((t) => t.origin !== 'sample');
  const sizes = Object.fromEntries(Object.entries(MEDIA).map(([key, entry]) => [key, entry.size]));
  db.titles = [...sampleTitles(sizes), ...mine];

  // Only a brand-new browser gets the household's viewing history; re-seeding
  // an existing one must never overwrite what people have actually watched.
  if (!db.seed) {
    db.progress = sampleProgress();
    db.myList = sampleMyList();
  }
  db.seed = SEED_VERSION;
  save();
}

const ready = (async () => {
  db = readStored();
  await loadMedia();
  if (db.seed !== SEED_VERSION) seed();
})();

// --------------------------------------------------------------------------
// shapes the client expects

function playables(title) {
  if (title.type === 'series') {
    return (title.seasons || []).flatMap((s) => (s.episodes || []).map((e) => ({
      key: `${title.id}:${e.id}`, sources: e.sources || [], episode: e,
    })));
  }
  return [{ key: `${title.id}:-`, sources: title.sources || [], episode: null }];
}

function publicSource(source) {
  const { media, ...rest } = source;
  return { ...rest, filename: source.filename || media || null };
}

function publicSubtitle(sub) {
  return { id: sub.id, label: sub.label || 'Subtitles', lang: sub.lang || 'und', kind: sub.kind, origin: sub.origin || '' };
}

/** Keys become object URLs on the way out; the stored copy keeps the key. */
function publicTitle(title) {
  const out = {
    ...title,
    poster: assetUrl(title.poster),
    backdrop: assetUrl(title.backdrop),
    sources: (title.sources || []).map(publicSource),
    subtitles: (title.subtitles || []).map(publicSubtitle),
    seasons: (title.seasons || []).map((season) => ({
      ...season,
      episodes: (season.episodes || []).map((episode) => ({
        ...episode,
        still: assetUrl(episode.still),
        sources: (episode.sources || []).map(publicSource),
        subtitles: (episode.subtitles || []).map(publicSubtitle),
      })),
    })),
  };
  out.episodeCount = out.seasons.reduce((n, s) => n + s.episodes.length, 0);
  out.sourceCount = out.sources.length
    + out.seasons.reduce((n, s) => n + s.episodes.reduce((m, e) => m + e.sources.length, 0), 0);
  return out;
}

function watchedByTitle() {
  const out = {};
  for (const title of db.titles) {
    const items = playables(title);
    if (!items.length) continue;
    const who = [];
    for (const profile of PROFILES) {
      const entries = db.progress[profile.id] || {};
      let finished = 0;
      let started = 0;
      for (const item of items) {
        const entry = entries[item.key];
        if (!entry) continue;
        if (entry.finished) finished += 1;
        else if (entry.position > 0) started += 1;
      }
      if (!finished && !started) continue;
      who.push({
        id: profile.id,
        name: profile.name,
        color: profile.color,
        state: finished === items.length ? 'finished' : 'watching',
      });
    }
    if (who.length) out[title.id] = who;
  }
  return out;
}

// --------------------------------------------------------------------------
// lookups

function findTitle(id) {
  return db.titles.find((t) => t.id === id) || null;
}

function findSource(titleId, sourceId) {
  const title = findTitle(titleId);
  if (!title) return null;
  for (const item of playables(title)) {
    const source = item.sources.find((s) => s.id === sourceId);
    if (source) return source;
  }
  return null;
}

function findSubtitle(titleId, subId) {
  const title = findTitle(titleId);
  if (!title) return null;
  const all = [
    ...(title.subtitles || []),
    ...(title.seasons || []).flatMap((s) => (s.episodes || []).flatMap((e) => e.subtitles || [])),
  ];
  return all.find((s) => s.id === subId) || null;
}

function container(title, episodeId) {
  if (!episodeId) return title.type === 'series' ? null : title.sources;
  for (const season of title.seasons || []) {
    const episode = (season.episodes || []).find((e) => e.id === episodeId);
    if (episode) return episode.sources;
  }
  return null;
}

let counter = 0;
function id(prefix) {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

function qualityLabel(height) {
  if (!height) return '';
  if (height >= 2000) return '4K';
  if (height >= 1400) return '1440p';
  if (height >= 1000) return '1080p';
  if (height >= 700) return '720p';
  if (height >= 460) return '480p';
  return `${height}p`;
}

/**
 * SubRip to WebVTT — the same normalisation the server does, including hours
 * padded to two digits, because a browser drops the whole file otherwise.
 * Mirrors srtToVtt in src/server/util.js.
 */
const SRT_TIMESTAMP = /(\d{1,3}):([0-5]\d):([0-5]\d)[,.](\d{1,3})/g;
function srtToVtt(srt) {
  const body = String(srt)
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^[ \t]*\d+[ \t]*\n(?=\d{1,3}:\d{2}:\d{2}[,.]\d{1,3})/gm, '')
    .replace(SRT_TIMESTAMP, (_m, h, m, s, frac) => `${h.padStart(2, '0')}:${m}:${s}.${frac.padEnd(3, '0').slice(0, 3)}`);
  return `WEBVTT\n\n${body.trim()}\n`;
}

// --------------------------------------------------------------------------
// uploads

const uploads = new Map();

// --------------------------------------------------------------------------
// the API

function snapshot(profileId) {
  const active = PROFILES.some((p) => p.id === profileId) ? profileId : PROFILES[0].id;
  return {
    titles: db.titles.map(publicTitle),
    watchedBy: watchedByTitle(),
    profiles: PROFILES,
    settings: db.settings,
    progress: db.progress[active] || {},
    subtitleChoice: db.subtitleChoice[active] || {},
    myList: db.myList[active] || [],
    activeProfile: active,
    server: {
      authRequired: false,
      allowRemote: false,
      metadataProvider: 'none',
      mediaDir: 'this browser',
      uploadsDir: 'this browser',
      scanRoots: [],
      hosted: true,
    },
  };
}

/** Everything below runs only once the library and its media are in place. */
function call(fn) {
  return async (...args) => {
    await ready;
    return fn(...args);
  };
}

export const api = {
  authStatus: call(() => ({ authRequired: false, authed: true, emailLogin: false })),
  login: call(() => ({ ok: true, remember: true })),
  logout: call(() => ({ ok: true })),

  library: call((profileId) => snapshot(profileId)),

  createTitle: call((fields) => {
    if (!fields.name || !String(fields.name).trim()) throw new ApiError('A name is required.', 400);
    const title = {
      id: id('t_'),
      type: fields.type === 'series' ? 'series' : 'movie',
      name: String(fields.name).trim(),
      year: fields.year ?? null,
      overview: fields.overview || '',
      genres: Array.isArray(fields.genres) ? fields.genres : [],
      poster: fields.poster || null,
      backdrop: null,
      rating: '',
      runtimeMin: fields.runtimeMin ?? null,
      tagline: '',
      cast: [],
      director: [],
      voteAverage: null,
      imdbId: '',
      tmdbId: '',
      metadata: null,
      intro: null,
      addedAt: Date.now(),
      origin: fields.origin || 'manual',
      sources: [],
      seasons: [],
      subtitles: [],
    };
    db.titles.push(title);
    save();
    return { title: publicTitle(title) };
  }),

  patchTitle: call((titleId, fields) => {
    const title = findTitle(titleId);
    if (!title) throw new ApiError('No such title', 404);
    const editable = ['name', 'year', 'overview', 'tagline', 'genres', 'poster', 'backdrop', 'rating', 'runtimeMin', 'type', 'cast', 'director'];
    for (const key of editable) {
      if (!(key in fields)) continue;
      if (key === 'genres') title.genres = Array.isArray(fields.genres) ? fields.genres.map(String) : [];
      else if (key === 'cast') {
        title.cast = (Array.isArray(fields.cast) ? fields.cast : [])
          .map((c) => (typeof c === 'string' ? { name: c, character: '' } : { name: String(c.name || ''), character: String(c.character || '') }))
          .filter((c) => c.name);
      } else if (key === 'director') {
        title.director = (Array.isArray(fields.director) ? fields.director : []).map(String).filter(Boolean);
      } else if (key === 'type') title.type = fields.type === 'series' ? 'series' : 'movie';
      else if (key === 'year' || key === 'runtimeMin') title[key] = fields[key] === null ? null : Number(fields[key]) || null;
      else title[key] = fields[key] === null ? null : String(fields[key]);
    }
    save();
    return { title: publicTitle(title) };
  }),

  deleteTitle: call(async (titleId) => {
    const title = findTitle(titleId);
    if (!title) throw new ApiError('No such title', 404);
    for (const item of playables(title)) {
      for (const source of item.sources) await forgetMedia(source.media);
    }
    db.titles = db.titles.filter((t) => t.id !== titleId);
    save();
    return { removed: true };
  }),

  addSource: call(() => { throw NO_SERVER('Adding a source by URL'); }),

  deleteSource: call(async (titleId, sourceId) => {
    const title = findTitle(titleId);
    if (!title) throw new ApiError('No such title', 404);
    for (const item of playables(title)) {
      const index = item.sources.findIndex((s) => s.id === sourceId);
      if (index < 0) continue;
      await forgetMedia(item.sources[index].media);
      item.sources.splice(index, 1);
      save();
      return { title: publicTitle(title) };
    }
    throw new ApiError('No such source', 404);
  }),

  addEpisode: call((titleId, payload) => {
    const title = findTitle(titleId);
    if (!title) throw new ApiError('No such title', 404);
    title.type = 'series';
    const number = Number(payload.season) || 1;
    let season = title.seasons.find((s) => s.number === number);
    if (!season) {
      season = { number, name: `Season ${number}`, episodes: [] };
      title.seasons.push(season);
      title.seasons.sort((a, b) => a.number - b.number);
    }
    const epNumber = Number(payload.number) || season.episodes.length + 1;
    let episode = season.episodes.find((e) => e.number === epNumber);
    if (!episode) {
      episode = {
        id: id('e_'), number: epNumber, name: payload.name || `Episode ${epNumber}`,
        overview: '', still: null, runtimeMin: null, intro: null, sources: [], subtitles: [],
      };
      season.episodes.push(episode);
      season.episodes.sort((a, b) => a.number - b.number);
    }
    save();
    return { title: publicTitle(title) };
  }),

  deleteEpisode: call(async (titleId, episodeId) => {
    const title = findTitle(titleId);
    if (!title) throw new ApiError('No such title', 404);
    for (const season of title.seasons) {
      const index = season.episodes.findIndex((e) => e.id === episodeId);
      if (index < 0) continue;
      for (const source of season.episodes[index].sources) await forgetMedia(source.media);
      season.episodes.splice(index, 1);
      title.seasons = title.seasons.filter((s) => s.episodes.length);
      save();
      return { title: publicTitle(title) };
    }
    throw new ApiError('No such episode', 404);
  }),

  deleteSubtitle: call((titleId, subId) => {
    const title = findTitle(titleId);
    if (!title) throw new ApiError('No such title', 404);
    const lists = [title.subtitles, ...(title.seasons || []).flatMap((s) => s.episodes.map((e) => e.subtitles))];
    for (const list of lists) {
      const index = list.findIndex((s) => s.id === subId);
      if (index < 0) continue;
      const [gone] = list.splice(index, 1);
      const url = subtitleUrls.get(gone.id);
      if (url) {
        URL.revokeObjectURL(url);
        subtitleUrls.delete(gone.id);
      }
      save();
      return { title: publicTitle(title) };
    }
    throw new ApiError('No such subtitle', 404);
  }),

  uploadSubtitle: call(async (titleId, file, { label, lang, episodeId }) => {
    const title = findTitle(titleId);
    if (!title) throw new ApiError('No such title', 404);
    const text = await file.text();
    const isVtt = /^\s*WEBVTT/.test(text) || /\.vtt$/i.test(file.name || '');
    const track = {
      id: id('sub_'),
      label: label || file.name || 'Subtitles',
      lang: lang || 'und',
      kind: 'vtt',
      origin: 'upload',
      vtt: isVtt ? text : srtToVtt(text),
    };
    let list = title.subtitles;
    if (episodeId) {
      for (const season of title.seasons) {
        const episode = season.episodes.find((e) => e.id === episodeId);
        if (episode) list = episode.subtitles;
      }
    }
    list.push(track);
    save();
    return { title: publicTitle(title) };
  }),

  uploadArtwork: call(async (file) => {
    const key = `m_${id('art_')}`;
    await idb('readwrite', (store) => store.put(file, key));
    mediaUrls.set(key, URL.createObjectURL(file));
    return { url: key };
  }),

  // Uploads land in IndexedDB in the same chunks the real server writes to disk,
  // so a big file does not have to be held in one piece in memory.
  startUpload: call((meta) => {
    const session = {
      id: id('u_'),
      filename: meta.filename || 'video',
      size: Number(meta.size) || 0,
      mime: meta.mime || 'video/mp4',
      parts: [],
      received: 0,
    };
    uploads.set(session.id, session);
    return { id: session.id, received: 0, filename: session.filename };
  }),

  uploadStatus: call((uploadId) => {
    const session = uploads.get(uploadId);
    if (!session) throw new ApiError('No such upload', 404);
    return { id: session.id, received: session.received, size: session.size };
  }),

  putChunk: call((uploadId, offset, blob) => {
    const session = uploads.get(uploadId);
    if (!session) throw new ApiError('No such upload', 404);
    if (Number(offset) !== session.received) {
      throw new ApiError(`Expected the chunk at ${session.received}, not ${offset}.`, 409, { received: session.received });
    }
    session.parts.push(blob);
    session.received += blob.size;
    return { received: session.received, size: session.size };
  }),

  cancelUpload: call((uploadId) => {
    uploads.delete(uploadId);
    return { ok: true };
  }),

  completeUpload: call(async (uploadId, payload) => {
    const session = uploads.get(uploadId);
    if (!session) throw new ApiError('No such upload', 404);
    const blob = new Blob(session.parts, { type: session.mime });
    uploads.delete(uploadId);

    const key = `m_${uploadId}`;
    await idb('readwrite', (store) => store.put(blob, key));
    mediaUrls.set(key, URL.createObjectURL(blob));

    let title = payload.titleId ? findTitle(payload.titleId) : null;
    let created = false;
    if (!title) {
      ({ title } = await api.createTitle({
        type: payload.type === 'series' ? 'series' : 'movie',
        name: payload.name || session.filename,
        year: payload.year ?? null,
        overview: payload.overview || '',
        genres: payload.genres || [],
        poster: payload.poster || null,
        origin: 'upload',
      }));
      title = findTitle(title.id);
      created = true;
    }

    const meta = payload.meta || {};
    const source = {
      id: id('s_'),
      kind: 'file',
      label: payload.label || (meta.height ? qualityLabel(meta.height) : '') || 'Source',
      addedAt: Date.now(),
      width: meta.width ?? null,
      height: meta.height ?? null,
      fps: meta.fps ?? null,
      durationSec: meta.durationSec ?? null,
      size: blob.size,
      mime: session.mime,
      codec: meta.codec || '',
      streamType: 'progressive',
      playability: { level: 'direct', note: '' },
      filename: session.filename,
      remoteHost: null,
      media: key,
    };

    if (payload.episode) {
      await api.addEpisode(title.id, payload.episode);
      const season = title.seasons.find((s) => s.number === (Number(payload.episode.season) || 1));
      const episode = season.episodes.find((e) => e.number === (Number(payload.episode.number) || season.episodes.length));
      episode.sources.push(source);
    } else {
      title.sources.push(source);
    }
    if (meta.durationSec && !title.runtimeMin) title.runtimeMin = Math.round(meta.durationSec / 60);
    save();

    return {
      title: publicTitle(title),
      sourceId: source.id,
      createdTitle: created,
      size: `${(blob.size / 1024 / 1024).toFixed(1)} MB`,
    };
  }),

  saveProgress: call((payload) => {
    const profileId = payload.profileId || PROFILES[0].id;
    if (!PROFILES.some((p) => p.id === profileId)) throw new ApiError('Unknown profile', 400);
    if (!findTitle(payload.titleId)) throw new ApiError('No such title', 404);

    const key = `${payload.titleId}:${payload.episodeId || '-'}`;
    const position = Math.max(0, Number(payload.position) || 0);
    const duration = Math.max(0, Number(payload.duration) || 0);
    db.progress[profileId] = db.progress[profileId] || {};

    const nearEnd = duration > 0 && position >= Math.max(duration * 0.96, duration - 90);
    if (nearEnd || (duration > 0 && position < 5)) {
      delete db.progress[profileId][key];
      if (nearEnd) {
        db.progress[profileId][key] = { position, duration, sourceId: payload.sourceId || null, finished: true, updatedAt: Date.now() };
      }
    } else {
      db.progress[profileId][key] = { position, duration, sourceId: payload.sourceId || null, finished: false, updatedAt: Date.now() };
    }
    save();
    return { progress: db.progress[profileId] };
  }),

  clearProgress: call((profileId, key) => {
    if (db.progress[profileId]) {
      delete db.progress[profileId][key];
      save();
    }
    return { progress: db.progress[profileId] || {} };
  }),

  addToList: call((profileId, titleId) => {
    if (!findTitle(titleId)) throw new ApiError('No such title', 404);
    const list = new Set(db.myList[profileId] || []);
    list.add(titleId);
    db.myList[profileId] = [...list];
    save();
    return { myList: db.myList[profileId] };
  }),

  removeFromList: call((profileId, titleId) => {
    const list = new Set(db.myList[profileId] || []);
    list.delete(titleId);
    db.myList[profileId] = [...list];
    save();
    return { myList: db.myList[profileId] };
  }),

  setSubtitleChoice: call((profileId, titleId, label) => {
    const forProfile = db.subtitleChoice[profileId] || (db.subtitleChoice[profileId] = {});
    if (label === null || label === undefined || label === '') delete forProfile[titleId];
    else forProfile[titleId] = String(label).slice(0, 120);
    save();
    return { subtitleChoice: forProfile };
  }),

  resetProfile: call((profileId) => {
    if (!PROFILES.some((p) => p.id === profileId)) throw new ApiError('No such profile', 404);
    db.progress[profileId] = {};
    save();
    return { progress: {} };
  }),

  patchSettings: call((fields) => {
    const clamp = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback);
    const s = db.settings;
    if ('seekStep' in fields) s.seekStep = clamp(Number(fields.seekStep), 1, 120, 5);
    if ('doubleClickSeek' in fields) s.doubleClickSeek = clamp(Number(fields.doubleClickSeek), 1, 120, 5);
    if ('autoplayNext' in fields) s.autoplayNext = Boolean(fields.autoplayNext);
    if ('resumeRewind' in fields) s.resumeRewind = clamp(Number(fields.resumeRewind), 0, 60, 5);
    if ('subtitleSize' in fields && ['small', 'medium', 'large', 'huge'].includes(fields.subtitleSize)) s.subtitleSize = fields.subtitleSize;
    if ('subtitleBackground' in fields && ['none', 'shadow', 'box'].includes(fields.subtitleBackground)) s.subtitleBackground = fields.subtitleBackground;
    if ('skipIntro' in fields) s.skipIntro = Boolean(fields.skipIntro);
    if ('autoMatchMetadata' in fields) s.autoMatchMetadata = Boolean(fields.autoMatchMetadata);
    if ('showWhoWatched' in fields) s.showWhoWatched = Boolean(fields.showWhoWatched);
    if ('autoSubtitles' in fields) s.autoSubtitles = Boolean(fields.autoSubtitles);
    if ('sleepTimerMinutes' in fields) s.sleepTimerMinutes = clamp(Number(fields.sleepTimerMinutes), 5, 240, 45);
    if ('subtitleLanguage' in fields) s.subtitleLanguage = String(fields.subtitleLanguage || 'alb').toLowerCase();
    save();
    return { settings: s };
  }),

  setIntro: call((titleId, { intro, episodeId, applyTo }) => {
    const title = findTitle(titleId);
    if (!title) throw new ApiError('No such title', 404);
    const range = intro && Number.isFinite(Number(intro.start)) && Number.isFinite(Number(intro.end))
      && Number(intro.end) - Number(intro.start) >= 1
      ? { start: Math.max(0, Math.round(Number(intro.start) * 100) / 100), end: Math.round(Number(intro.end) * 100) / 100 }
      : null;

    if (!episodeId) {
      title.intro = range;
    } else {
      for (const season of title.seasons || []) {
        for (const episode of season.episodes || []) {
          const here = episode.id === episodeId;
          const sameSeason = season.episodes.some((e) => e.id === episodeId);
          if (here || (applyTo === 'all') || (applyTo === 'season' && sameSeason)) episode.intro = range;
        }
      }
    }
    save();
    return { title: publicTitle(title) };
  }),

  // Everything past here wants a filesystem or the wider internet.
  scan: call(() => { throw NO_SERVER('Scanning a folder'); }),
  discover: call(() => { throw NO_SERVER('The Internet Archive library'); }),
  discoverItem: call(() => { throw NO_SERVER('The Internet Archive library'); }),
  discoverAdd: call(() => { throw NO_SERVER('The Internet Archive library'); }),
  metadataStatus: call(() => ({ provider: 'none', configured: false })),
  matchOptions: call(() => { throw NO_SERVER('Looking up posters and synopses'); }),
  applyMatch: call(() => { throw NO_SERVER('Looking up posters and synopses'); }),
  enrichMetadata: call(() => { throw NO_SERVER('Looking up posters and synopses'); }),
  searchSubtitles: call(() => { throw NO_SERVER('Searching for subtitles'); }),
  fetchSubtitle: call(() => { throw NO_SERVER('Searching for subtitles'); }),

  // The generic verbs exist only so nothing calls into a hole.
  get: call(() => { throw NO_SERVER('That'); }),
  post: call(() => { throw NO_SERVER('That'); }),
  patch: call(() => { throw NO_SERVER('That'); }),
  del: call(() => { throw NO_SERVER('That'); }),
};

async function forgetMedia(key) {
  if (!key || !key.startsWith('m_')) return;
  const url = mediaUrls.get(key);
  if (url) URL.revokeObjectURL(url);
  mediaUrls.delete(key);
  try {
    await idb('readwrite', (store) => store.delete(key));
  } catch { /* it is already gone */ }
}

/**
 * Where the video actually is.
 *
 * The real app answers /api/stream from disk with byte ranges; here the file is
 * already in the browser, so the object URL is handed straight to the <video>.
 * Seeking, downloading and offline playback all work off that.
 */
export function streamUrl(titleId, sourceId) {
  const source = findSource(titleId, sourceId);
  return source ? assetUrl(source.media) || '' : '';
}

export function subtitleUrl(titleId, subtitleId) {
  const existing = subtitleUrls.get(subtitleId);
  if (existing) return existing;
  const track = findSubtitle(titleId, subtitleId);
  if (!track) return '';
  const url = URL.createObjectURL(new Blob([track.vtt || 'WEBVTT\n'], { type: 'text/vtt' }));
  subtitleUrls.set(subtitleId, url);
  return url;
}
