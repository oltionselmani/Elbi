import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const DB_FILE = () => path.join(config.dataDir, 'library.json');

/**
 * The household. This roster is fixed: no passwords, no adding, no deleting —
 * picking a name on the way in is only there to keep Continue Watching and
 * My List separate per person. IDs are derived from the name rather than
 * random, so watch history survives a wiped library.json.
 */
export const PROFILES = [
  { id: 'p_olti', name: 'Olti', color: '#8f3a24' },
  { id: 'p_elbi', name: 'Elbi', color: '#2c5f66' },
  { id: 'p_oltion', name: 'Oltion', color: '#7b6432' },
  { id: 'p_elbasana', name: 'Elbasana', color: '#5b3a63' },
];

function emptyDb() {
  return {
    version: 1,
    titles: [],
    profiles: PROFILES.map((p) => ({ ...p })),
    progress: {},
    myList: {},
    settings: {
      seekStep: 5,
      doubleClickSeek: 5,
      autoplayNext: true,
      // Resuming drops you slightly before where you stopped, so you get a
      // moment to re-orient instead of landing mid-sentence.
      resumeRewind: 5,
      subtitleSize: 'medium',
      subtitleBackground: 'shadow',
    },
  };
}

/** Fill in anything a hand-edited or older library.json is missing. */
function normalize(db) {
  const base = emptyDb();
  const out = { ...base, ...(db && typeof db === 'object' ? db : {}) };
  out.titles = Array.isArray(out.titles) ? out.titles : [];
  out.profiles = Array.isArray(out.profiles) ? out.profiles : [];
  out.progress = out.progress && typeof out.progress === 'object' ? out.progress : {};
  out.myList = out.myList && typeof out.myList === 'object' ? out.myList : {};
  out.settings = { ...base.settings, ...(out.settings || {}) };

  for (const title of out.titles) {
    title.sources = Array.isArray(title.sources) ? title.sources : [];
    title.seasons = Array.isArray(title.seasons) ? title.seasons : [];
    title.subtitles = Array.isArray(title.subtitles) ? title.subtitles : [];
    title.genres = Array.isArray(title.genres) ? title.genres : [];
    title.type = title.type === 'series' ? 'series' : 'movie';
  }

  // The roster is authoritative in code, not in the file: a library.json from
  // an older build (or a hand-edit) is brought back in line here, while any
  // watch history recorded against those profile IDs is left untouched.
  out.profiles = PROFILES.map((p) => ({ ...p }));
  return out;
}

let cache = null;
let writeChain = Promise.resolve();

export function loadDb() {
  if (cache) return cache;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(DB_FILE(), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Keep a copy rather than silently discarding a corrupt library.
      try {
        fs.copyFileSync(DB_FILE(), `${DB_FILE()}.corrupt-${Date.now()}`);
        console.error(`[elbi] library.json was unreadable (${err.message}); kept a .corrupt copy and started fresh.`);
      } catch { /* nothing further we can do */ }
    }
  }
  cache = normalize(raw);
  return cache;
}

/**
 * Serialise writes and swap the file in atomically, so a crash mid-write
 * can never leave a half-written library behind.
 */
export function saveDb() {
  const snapshot = JSON.stringify(cache, null, 2);
  writeChain = writeChain.then(async () => {
    const target = DB_FILE();
    const tmp = path.join(config.tmpDir, `library.${process.pid}.${Date.now()}.json`);
    await fsp.writeFile(tmp, snapshot, 'utf8');
    await fsp.rename(tmp, target);
  }).catch((err) => {
    console.error('[elbi] failed to persist library:', err.message);
  });
  return writeChain;
}

export async function flush() {
  await writeChain;
}

/** Test hook: drop the in-memory cache so the next read hits disk. */
export function resetCache() {
  cache = null;
}
