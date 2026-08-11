import { api } from './api.js';

const LS_PROFILE = 'elbi.profile';
const LS_VOLUME = 'elbi.volume';
const LS_MUTED = 'elbi.muted';

const listeners = new Set();

export const state = {
  ready: false,
  titles: [],
  profiles: [],
  progress: {},
  myList: [],
  settings: {
    seekStep: 5,
    doubleClickSeek: 5,
    autoplayNext: true,
    resumeRewind: 5,
    subtitleSize: 'medium',
    subtitleBackground: 'shadow',
    skipIntro: true,
    subtitleLanguage: 'alb',
    autoMatchMetadata: true,
    sleepTimerMinutes: 45,
  },
  server: {},
  activeProfile: null,
  query: '',
  online: navigator.onLine,
  offlineSources: new Set(),
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) {
    try { fn(state); } catch (err) { console.error('[elbi] listener failed', err); }
  }
}

export function savedProfileId() {
  try { return localStorage.getItem(LS_PROFILE); } catch { return null; }
}
export function rememberProfile(id) {
  try { localStorage.setItem(LS_PROFILE, id); } catch { /* private mode */ }
  state.activeProfile = id;
}
export function forgetProfile() {
  try { localStorage.removeItem(LS_PROFILE); } catch { /* ignore */ }
  state.activeProfile = null;
}

export function savedVolume() {
  // Number(null) is 0, so an absent key must not fall through as "silent".
  const stored = localStorage.getItem(LS_VOLUME);
  if (stored === null || stored === '') return 1;
  const raw = Number(stored);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 1;
}
export function saveVolume(value, muted) {
  try {
    localStorage.setItem(LS_VOLUME, String(value));
    localStorage.setItem(LS_MUTED, muted ? '1' : '0');
  } catch { /* ignore */ }
}
export function savedMuted() {
  return localStorage.getItem(LS_MUTED) === '1';
}

/** Pull the whole library; the payload is small enough that this stays simple. */
export async function refresh() {
  const data = await api.library(state.activeProfile || savedProfileId() || undefined);
  state.titles = data.titles;
  state.profiles = data.profiles;
  state.progress = data.progress || {};
  state.myList = data.myList || [];
  state.settings = data.settings;
  state.server = data.server;
  if (!state.activeProfile || !state.profiles.some((p) => p.id === state.activeProfile)) {
    state.activeProfile = data.activeProfile;
  }
  state.ready = true;
  emit();
  return state;
}

/** Merge a title the server just returned, then notify. */
export function upsertTitle(title) {
  const index = state.titles.findIndex((t) => t.id === title.id);
  if (index >= 0) state.titles[index] = title;
  else state.titles.push(title);
  emit();
}

export function removeTitleLocal(titleId) {
  state.titles = state.titles.filter((t) => t.id !== titleId);
  emit();
}

export function titleById(id) {
  return state.titles.find((t) => t.id === id) || null;
}

export function progressKey(titleId, episodeId) {
  return `${titleId}:${episodeId || '-'}`;
}

export function progressFor(titleId, episodeId) {
  return state.progress[progressKey(titleId, episodeId)] || null;
}

/**
 * Where playback should actually start. Stopping at 27:47 resumes at 27:42:
 * a few seconds of run-up beats landing in the middle of a sentence.
 */
export function resumePointFor(titleId, episodeId) {
  const entry = progressFor(titleId, episodeId);
  if (!entry || entry.finished) return 0;
  const rewind = Number(state.settings?.resumeRewind);
  return Math.max(0, entry.position - (Number.isFinite(rewind) ? rewind : 5));
}

/** Every playable unit of a title, in order. */
export function playablesOf(title) {
  if (!title) return [];
  if (title.type === 'series') {
    return (title.seasons || []).flatMap((season) => (season.episodes || []).map((episode) => ({
      titleId: title.id,
      episodeId: episode.id,
      season: season.number,
      episode: episode.number,
      name: episode.name,
      overview: episode.overview,
      still: episode.still,
      sources: episode.sources || [],
      subtitles: [...(episode.subtitles || []), ...(title.subtitles || [])],
    })));
  }
  return [{
    titleId: title.id,
    episodeId: null,
    season: null,
    episode: null,
    name: title.name,
    overview: title.overview,
    still: title.backdrop,
    sources: title.sources || [],
    subtitles: title.subtitles || [],
  }];
}

/** Where playback should resume: the in-progress episode, else the first unwatched. */
export function nextUpFor(title) {
  const list = playablesOf(title);
  if (!list.length) return null;

  let best = null;
  for (const item of list) {
    const p = progressFor(item.titleId, item.episodeId);
    if (p && !p.finished && p.position > 5) {
      if (!best || p.updatedAt > best.updatedAt) {
        best = { item, updatedAt: p.updatedAt, resumeAt: resumePointFor(item.titleId, item.episodeId) };
      }
    }
  }
  if (best) return { ...best.item, resumeAt: best.resumeAt };

  const unwatched = list.find((item) => !progressFor(item.titleId, item.episodeId)?.finished);
  return { ...(unwatched || list[0]), resumeAt: 0 };
}

export function playableCount(title) {
  return playablesOf(title).reduce((n, p) => n + p.sources.length, 0);
}

export function hasPlayableSource(title) {
  return playablesOf(title).some((p) => p.sources.length > 0);
}

/** Continue Watching, most recent first. */
export function continueWatching() {
  const rows = [];
  for (const [key, entry] of Object.entries(state.progress)) {
    if (!entry || entry.finished) continue;
    const [titleId, episodePart] = key.split(':');
    const title = titleById(titleId);
    if (!title) continue;
    const episodeId = episodePart === '-' ? null : episodePart;
    const item = playablesOf(title).find((p) => (p.episodeId || null) === episodeId);
    if (!item || !item.sources.length) continue;
    rows.push({ title, item, entry });
  }
  return rows.sort((a, b) => (b.entry.updatedAt || 0) - (a.entry.updatedAt || 0));
}

export function allGenres() {
  const counts = new Map();
  for (const title of state.titles) {
    for (const genre of title.genres || []) {
      counts.set(genre, (counts.get(genre) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
}

export function searchTitles(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  return state.titles.filter((title) => {
    const haystack = [
      title.name, title.year, title.overview, ...(title.genres || []), ...(title.tags || []),
      ...(title.seasons || []).flatMap((s) => s.episodes.map((e) => e.name)),
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

window.addEventListener('online', () => { state.online = true; emit(); });
window.addEventListener('offline', () => { state.online = false; emit(); });
