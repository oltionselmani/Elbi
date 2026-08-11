import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, allowedRoots } from './config.js';
import { loadDb, saveDb } from './store.js';
import {
  id, containedPath, mimeFor, playability, parseFilename, parseEpisode,
  qualityLabel, VIDEO_EXTENSIONS, SUBTITLE_EXTENSIONS,
} from './util.js';

export function findTitle(titleId) {
  return loadDb().titles.find((t) => t.id === titleId) || null;
}

/** Every playable unit in a title: the movie itself, or each episode. */
export function playables(title) {
  if (!title) return [];
  if (title.type === 'series') {
    const out = [];
    for (const season of title.seasons || []) {
      for (const episode of season.episodes || []) {
        out.push({
          key: `${title.id}:${episode.id}`,
          titleId: title.id,
          episodeId: episode.id,
          season: season.number,
          episode: episode.number,
          name: episode.name || `Episode ${episode.number}`,
          intro: episode.intro || null,
          sources: episode.sources || [],
          subtitles: episode.subtitles || [],
        });
      }
    }
    return out;
  }
  return [{
    key: `${title.id}:-`,
    titleId: title.id,
    episodeId: null,
    season: null,
    episode: null,
    name: title.name,
    intro: title.intro || null,
    sources: title.sources || [],
    subtitles: title.subtitles || [],
  }];
}

export function findPlayable(titleId, episodeId) {
  const title = findTitle(titleId);
  if (!title) return null;
  const list = playables(title);
  if (!episodeId || episodeId === '-') return list[0] || null;
  return list.find((p) => p.episodeId === episodeId) || null;
}

export function findSource(titleId, sourceId) {
  const title = findTitle(titleId);
  if (!title) return null;
  for (const p of playables(title)) {
    const source = (p.sources || []).find((s) => s.id === sourceId);
    if (source) return { title, playable: p, source };
  }
  return null;
}

/** Absolute on-disk path for a file source, or null when it escapes the roots. */
export function sourceFilePath(source) {
  if (!source || source.kind !== 'file' || !source.path) return null;
  const abs = path.isAbsolute(source.path) ? source.path : path.join(config.mediaDir, source.path);
  return containedPath(abs, allowedRoots());
}

export function makeSource(fields) {
  const source = {
    id: id('s_'),
    kind: fields.kind === 'url' ? 'url' : 'file',
    label: fields.label || '',
    addedAt: Date.now(),
    width: fields.width ?? null,
    height: fields.height ?? null,
    fps: fields.fps ?? null,
    durationSec: fields.durationSec ?? null,
    size: fields.size ?? null,
    mime: fields.mime || '',
    codec: fields.codec || '',
  };
  if (source.kind === 'url') {
    source.url = String(fields.url);
    source.mime = source.mime || guessRemoteMime(source.url);
    source.streamType = hlsLike(source.url) ? 'hls' : dashLike(source.url) ? 'dash' : 'progressive';
    // Callers that know the codec (the Internet Archive importer) pass it in;
    // otherwise a progressive URL is assumed playable until it proves otherwise.
    source.playability = fields.playability
      || { level: source.streamType === 'progressive' ? 'direct' : 'adaptive', note: '' };
  } else {
    source.path = fields.path;
    source.mime = source.mime || mimeFor(fields.path);
    source.streamType = 'progressive';
    source.playability = playability(fields.path);
  }
  if (!source.label) source.label = qualityLabel(source.height) || 'Source';
  return source;
}

export function hlsLike(url) {
  return /\.m3u8(\?|$)/i.test(String(url));
}
export function dashLike(url) {
  return /\.mpd(\?|$)/i.test(String(url));
}
function guessRemoteMime(url) {
  try {
    return mimeFor(new URL(url).pathname);
  } catch {
    return 'video/mp4';
  }
}

export function makeTitle(fields = {}) {
  return {
    id: id('t_'),
    type: fields.type === 'series' ? 'series' : 'movie',
    name: fields.name || 'Untitled',
    year: fields.year ?? null,
    overview: fields.overview || '',
    genres: Array.isArray(fields.genres) ? fields.genres : [],
    poster: fields.poster || null,
    backdrop: fields.backdrop || null,
    rating: fields.rating || '',
    runtimeMin: fields.runtimeMin ?? null,
    tagline: fields.tagline || '',
    cast: Array.isArray(fields.cast) ? fields.cast : [],
    director: Array.isArray(fields.director) ? fields.director : [],
    voteAverage: fields.voteAverage ?? null,
    imdbId: fields.imdbId || '',
    tmdbId: fields.tmdbId || '',
    metadata: null,
    // Marked intro range for a movie; episodes carry their own.
    intro: null,
    addedAt: Date.now(),
    origin: fields.origin || 'manual',
    sources: [],
    seasons: [],
    subtitles: [],
  };
}

export function ensureSeason(title, number) {
  let season = title.seasons.find((s) => s.number === number);
  if (!season) {
    season = { number, name: `Season ${number}`, episodes: [] };
    title.seasons.push(season);
    title.seasons.sort((a, b) => a.number - b.number);
  }
  return season;
}

export function ensureEpisode(season, number, name) {
  let episode = season.episodes.find((e) => e.number === number);
  if (!episode) {
    episode = {
      id: id('e_'),
      number,
      name: name || `Episode ${number}`,
      overview: '',
      still: null,
      intro: null,
      sources: [],
      subtitles: [],
    };
    season.episodes.push(episode);
    season.episodes.sort((a, b) => a.number - b.number);
  }
  return episode;
}

/** Sources already registered, keyed by absolute path — used to skip re-imports. */
function indexedFilePaths() {
  const set = new Set();
  for (const title of loadDb().titles) {
    for (const p of playables(title)) {
      for (const source of p.sources) {
        const abs = sourceFilePath(source);
        if (abs) set.add(abs);
      }
    }
  }
  return set;
}

async function walk(dir, depth = 0, out = []) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, depth + 1, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Import every video file under `dir` that is not already in the library.
 * Files named "Show.S01E02.*" are grouped into a series; the rest become movies.
 * Sibling .srt/.vtt files with a matching stem are attached as subtitles.
 */
export async function scanFolder(dir) {
  const root = containedPath(dir, allowedRoots());
  if (!root) {
    throw Object.assign(
      new Error('That folder is outside the media roots. Add it to ELBI_SCAN_DIRS to allow it.'),
      { status: 400 },
    );
  }
  const stat = await fsp.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw Object.assign(new Error('Folder not found'), { status: 404 });

  const files = await walk(root);
  const known = indexedFilePaths();
  const db = loadDb();

  const videos = files.filter((f) => VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase()));
  const subs = files.filter((f) => SUBTITLE_EXTENSIONS.has(path.extname(f).toLowerCase()));

  const report = { added: 0, skipped: 0, titles: [], newTitleIds: [], unplayable: [] };

  for (const file of videos.sort()) {
    if (known.has(file)) {
      report.skipped += 1;
      continue;
    }
    const info = parseFilename(file);
    const ep = parseEpisode(file);
    const fileStat = await fsp.stat(file).catch(() => null);

    const source = makeSource({
      kind: 'file',
      path: file,
      height: info.height,
      size: fileStat?.size ?? null,
      label: info.height ? qualityLabel(info.height) : path.extname(file).slice(1).toUpperCase(),
    });
    attachSiblingSubtitles(source, file, subs);
    if (source.playability.level === 'unsupported') report.unplayable.push(path.basename(file));

    if (ep) {
      const showName = info.name.replace(/\bS\d{1,2}\s*E?\d{0,3}\b/i, '').replace(/\s{2,}/g, ' ').trim() || info.name;
      let title = db.titles.find(
        (t) => t.type === 'series' && t.name.toLowerCase() === showName.toLowerCase(),
      );
      if (!title) {
        title = makeTitle({ type: 'series', name: showName, year: info.year, origin: 'scan' });
        db.titles.push(title);
        report.titles.push(title.name);
        report.newTitleIds.push(title.id);
      }
      const season = ensureSeason(title, ep.season);
      const episode = ensureEpisode(season, ep.episode);
      episode.sources.push(source);
      if (source.subtitles) episode.subtitles.push(...source.subtitles);
    } else {
      let title = db.titles.find(
        (t) => t.type === 'movie'
          && t.name.toLowerCase() === info.name.toLowerCase()
          && (t.year ?? null) === (info.year ?? null),
      );
      if (!title) {
        title = makeTitle({ type: 'movie', name: info.name, year: info.year, origin: 'scan' });
        title.tags = info.tags;
        db.titles.push(title);
        report.titles.push(title.name);
        report.newTitleIds.push(title.id);
      }
      title.sources.push(source);
      if (source.subtitles) title.subtitles.push(...source.subtitles);
    }
    delete source.subtitles;
    report.added += 1;
  }

  await saveDb();
  return report;
}

function attachSiblingSubtitles(source, videoFile, subtitleFiles) {
  const stem = videoFile.slice(0, -path.extname(videoFile).length);
  const matches = subtitleFiles.filter((s) => {
    const subStem = s.slice(0, -path.extname(s).length);
    return subStem === stem || subStem.startsWith(`${stem}.`);
  });
  if (!matches.length) return;
  source.subtitles = matches.map((file) => {
    const extra = file.slice(stem.length).replace(/^\./, '').replace(path.extname(file), '');
    return {
      id: id('sub_'),
      kind: 'file',
      path: file,
      lang: (extra.split('.').pop() || 'und').slice(0, 8) || 'und',
      label: extra ? extra.replace(/\./g, ' ') : 'Subtitles',
    };
  });
}

/** Remove a title, optionally deleting uploaded files it owns. */
export async function removeTitle(titleId, deleteFiles) {
  const db = loadDb();
  const index = db.titles.findIndex((t) => t.id === titleId);
  if (index < 0) return { removed: false };
  const [title] = db.titles.splice(index, 1);

  const deleted = [];
  if (deleteFiles) {
    for (const p of playables(title)) {
      for (const source of p.sources) {
        const abs = sourceFilePath(source);
        // Only ever delete from Elbi's own uploads folder — never a scanned library.
        if (abs && abs.startsWith(config.uploadsDir + path.sep)) {
          await fsp.unlink(abs).catch(() => {});
          deleted.push(path.basename(abs));
        }
      }
    }
  }

  for (const key of Object.keys(db.progress)) {
    for (const entry of Object.keys(db.progress[key])) {
      if (entry.startsWith(`${titleId}:`)) delete db.progress[key][entry];
    }
  }
  for (const key of Object.keys(db.myList)) {
    db.myList[key] = (db.myList[key] || []).filter((t) => t !== titleId);
  }

  await saveDb();
  return { removed: true, deleted };
}

/** Shape a title for the client: adds derived fields, hides absolute paths. */
export function publicTitle(title) {
  const out = {
    id: title.id,
    type: title.type,
    name: title.name,
    year: title.year,
    overview: title.overview,
    genres: title.genres,
    poster: title.poster,
    backdrop: title.backdrop,
    rating: title.rating,
    runtimeMin: title.runtimeMin,
    tagline: title.tagline || '',
    cast: title.cast || [],
    director: title.director || [],
    voteAverage: title.voteAverage ?? null,
    imdbId: title.imdbId || '',
    tmdbId: title.tmdbId || '',
    metadata: title.metadata || null,
    intro: title.intro || null,
    addedAt: title.addedAt,
    origin: title.origin,
    tags: title.tags || [],
    sources: (title.sources || []).map(publicSource),
    subtitles: (title.subtitles || []).map(publicSubtitle),
    seasons: (title.seasons || []).map((season) => ({
      number: season.number,
      name: season.name,
      episodes: (season.episodes || []).map((episode) => ({
        id: episode.id,
        number: episode.number,
        name: episode.name,
        overview: episode.overview,
        still: episode.still,
        runtimeMin: episode.runtimeMin ?? null,
        intro: episode.intro || null,
        sources: (episode.sources || []).map(publicSource),
        subtitles: (episode.subtitles || []).map(publicSubtitle),
      })),
    })),
  };
  out.episodeCount = out.seasons.reduce((n, s) => n + s.episodes.length, 0);
  out.sourceCount = out.sources.length + out.seasons.reduce(
    (n, s) => n + s.episodes.reduce((m, e) => m + e.sources.length, 0), 0,
  );
  return out;
}

function publicSource(source) {
  return {
    id: source.id,
    kind: source.kind,
    label: source.label,
    width: source.width ?? null,
    height: source.height ?? null,
    fps: source.fps ?? null,
    durationSec: source.durationSec ?? null,
    size: source.size ?? null,
    mime: source.mime,
    codec: source.codec || '',
    streamType: source.streamType || 'progressive',
    playability: source.playability || { level: 'direct', note: '' },
    filename: source.kind === 'file' && source.path ? path.basename(source.path) : null,
    remoteHost: source.kind === 'url' ? safeHost(source.url) : null,
    addedAt: source.addedAt,
  };
}

function publicSubtitle(sub) {
  return {
    id: sub.id,
    label: sub.label || 'Subtitles',
    lang: sub.lang || 'und',
    kind: sub.kind,
    origin: sub.origin || '',
  };
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function findSubtitle(titleId, subtitleId) {
  const title = findTitle(titleId);
  if (!title) return null;
  const pools = [title.subtitles || []];
  for (const p of playables(title)) pools.push(p.subtitles || []);
  for (const pool of pools) {
    const hit = pool.find((s) => s.id === subtitleId);
    if (hit) return hit;
  }
  return null;
}
