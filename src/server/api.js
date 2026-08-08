import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, allowedRoots } from './config.js';
import { json, fail, readJson, readBody, serveFile, send } from './http.js';
import { authRequired, checkPassword, sessionCookie, clearCookie, isAuthed } from './auth.js';
import { loadDb, saveDb } from './store.js';
import {
  findTitle, findSource, findSubtitle, playables, sourceFilePath, makeSource, makeTitle,
  ensureSeason, ensureEpisode, scanFolder, removeTitle, publicTitle, hlsLike, dashLike,
} from './library.js';
import {
  createUpload, getUpload, appendChunk, finishUpload, abortUpload, saveArtwork, saveSubtitleFile,
} from './uploads.js';
import * as discover from './discover.js';
import { id, srtToVtt, qualityLabel, formatBytes } from './util.js';

const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

export async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const route = segments.slice(1);
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  // --- unauthenticated endpoints -------------------------------------------
  if (route[0] === 'auth') return handleAuth(req, res, route, method);

  if (!isAuthed(req)) return fail(res, 401, 'Sign in to use Elbi.', { authRequired: true });

  switch (route[0]) {
    case 'library': return handleLibrary(req, res, url, method);
    case 'titles': return handleTitles(req, res, url, route, method);
    case 'uploads': return handleUploads(req, res, url, route, method);
    case 'stream': return handleStream(req, res, url, route);
    case 'subtitles': return handleSubtitles(req, res, route);
    case 'progress': return handleProgress(req, res, route, method);
    case 'mylist': return handleMyList(req, res, method);
    case 'profiles': return handleProfiles(req, res, route, method);
    case 'reset-profile': return handleResetProfile(req, res, route, method);
    case 'settings': return handleSettings(req, res, method);
    case 'scan': return handleScan(req, res, method);
    case 'artwork': return handleArtwork(req, res, url, method);
    case 'discover': return handleDiscover(req, res, url, route, method);
    case 'remote': return handleRemote(req, res, url);
    default: return fail(res, 404, `No API route /${route.join('/')}`);
  }
}

// --------------------------------------------------------------------------
// auth

async function handleAuth(req, res, route, method) {
  if (route[1] === 'status' && method === 'GET') {
    return json(res, 200, { authRequired: authRequired(), authed: isAuthed(req) });
  }
  if (route[1] === 'login' && method === 'POST') {
    const body = await readJson(req);
    if (!checkPassword(body.password)) return fail(res, 401, 'Wrong password.');
    const secure = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(secure) });
  }
  if (route[1] === 'logout' && method === 'POST') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
  }
  return fail(res, 404, 'Unknown auth route');
}

// --------------------------------------------------------------------------
// library snapshot

function handleLibrary(req, res, url, method) {
  if (method !== 'GET') return fail(res, 405, 'Method not allowed');
  const db = loadDb();
  const profileId = url.searchParams.get('profile') || db.profiles[0]?.id;
  return json(res, 200, {
    titles: db.titles.map(publicTitle),
    profiles: db.profiles,
    settings: db.settings,
    progress: db.progress[profileId] || {},
    myList: db.myList[profileId] || [],
    activeProfile: profileId,
    server: {
      authRequired: authRequired(),
      allowRemote: config.allowRemote,
      mediaDir: config.mediaDir,
      uploadsDir: config.uploadsDir,
      scanRoots: allowedRoots(),
    },
  });
}

// --------------------------------------------------------------------------
// titles / sources / episodes

async function handleTitles(req, res, url, route, method) {
  const [, titleId, sub, subId] = route;

  if (!titleId) {
    if (method === 'POST') {
      const body = await readJson(req);
      if (!body.name || !String(body.name).trim()) return fail(res, 400, 'A name is required.');
      const db = loadDb();
      const title = makeTitle({ ...body, name: String(body.name).trim() });
      db.titles.push(title);
      await saveDb();
      return json(res, 201, { title: publicTitle(title) });
    }
    return fail(res, 405, 'Method not allowed');
  }

  const title = findTitle(titleId);
  if (!title) return fail(res, 404, 'No such title');

  // /api/titles/:id
  if (!sub) {
    if (method === 'GET') return json(res, 200, { title: publicTitle(title) });
    if (method === 'PATCH') {
      const body = await readJson(req);
      const editable = ['name', 'year', 'overview', 'genres', 'poster', 'backdrop', 'rating', 'runtimeMin', 'type'];
      for (const key of editable) {
        if (!(key in body)) continue;
        if (key === 'genres') title.genres = Array.isArray(body.genres) ? body.genres.map(String) : [];
        else if (key === 'type') title.type = body.type === 'series' ? 'series' : 'movie';
        else if (key === 'year' || key === 'runtimeMin') title[key] = body[key] === null ? null : Number(body[key]) || null;
        else title[key] = body[key] === null ? null : String(body[key]);
      }
      await saveDb();
      return json(res, 200, { title: publicTitle(title) });
    }
    if (method === 'DELETE') {
      const deleteFiles = url.searchParams.get('deleteFiles') === '1';
      const result = await removeTitle(titleId, deleteFiles);
      return json(res, 200, result);
    }
    return fail(res, 405, 'Method not allowed');
  }

  // /api/titles/:id/sources[/:sourceId]
  if (sub === 'sources') {
    if (method === 'POST') {
      const body = await readJson(req);
      const source = await buildSourceFromBody(body);
      const target = resolveSourceContainer(title, body.episodeId);
      if (!target) return fail(res, 404, 'No such episode');
      target.push(source);
      await saveDb();
      return json(res, 201, { title: publicTitle(title) });
    }
    if (method === 'DELETE' && subId) {
      let removed = false;
      for (const p of playables(title)) {
        const index = p.sources.findIndex((s) => s.id === subId);
        if (index >= 0) {
          p.sources.splice(index, 1);
          removed = true;
          break;
        }
      }
      if (!removed) return fail(res, 404, 'No such source');
      await saveDb();
      return json(res, 200, { title: publicTitle(title) });
    }
    return fail(res, 405, 'Method not allowed');
  }

  // /api/titles/:id/episodes[/:episodeId]
  if (sub === 'episodes') {
    if (method === 'POST') {
      const body = await readJson(req);
      title.type = 'series';
      const season = ensureSeason(title, Number(body.season) || 1);
      const episode = ensureEpisode(season, Number(body.episode) || season.episodes.length + 1, body.name);
      if (body.name) episode.name = String(body.name);
      if (body.overview) episode.overview = String(body.overview);
      if (body.source) episode.sources.push(await buildSourceFromBody(body.source));
      await saveDb();
      return json(res, 201, { title: publicTitle(title), episodeId: episode.id });
    }
    if (method === 'DELETE' && subId) {
      for (const season of title.seasons) {
        const index = season.episodes.findIndex((e) => e.id === subId);
        if (index >= 0) {
          season.episodes.splice(index, 1);
          if (!season.episodes.length) {
            title.seasons = title.seasons.filter((s) => s !== season);
          }
          await saveDb();
          return json(res, 200, { title: publicTitle(title) });
        }
      }
      return fail(res, 404, 'No such episode');
    }
    return fail(res, 405, 'Method not allowed');
  }

  // /api/titles/:id/subtitles[/:subtitleId]
  if (sub === 'subtitles') {
    if (method === 'POST') {
      const filename = url.searchParams.get('filename') || 'subtitles.vtt';
      const label = url.searchParams.get('label') || 'Subtitles';
      const lang = (url.searchParams.get('lang') || 'und').slice(0, 8);
      const episodeId = url.searchParams.get('episodeId');
      const buffer = await readBody(req, 8 * 1024 * 1024);
      if (!buffer.length) return fail(res, 400, 'Empty subtitle file');
      const savedPath = await saveSubtitleFile(buffer, filename);
      const entry = { id: id('sub_'), kind: 'file', path: savedPath, label, lang };
      const pool = resolveSubtitleContainer(title, episodeId);
      if (!pool) return fail(res, 404, 'No such episode');
      pool.push(entry);
      await saveDb();
      return json(res, 201, { title: publicTitle(title) });
    }
    if (method === 'DELETE' && subId) {
      const pools = [title.subtitles, ...(title.seasons.flatMap((s) => s.episodes.map((e) => e.subtitles)))];
      for (const pool of pools) {
        const index = (pool || []).findIndex((s) => s.id === subId);
        if (index >= 0) {
          pool.splice(index, 1);
          await saveDb();
          return json(res, 200, { title: publicTitle(title) });
        }
      }
      return fail(res, 404, 'No such subtitle track');
    }
    return fail(res, 405, 'Method not allowed');
  }

  return fail(res, 404, 'Unknown title route');
}

function resolveSourceContainer(title, episodeId) {
  if (!episodeId) return title.sources;
  for (const season of title.seasons) {
    const episode = season.episodes.find((e) => e.id === episodeId);
    if (episode) return episode.sources;
  }
  return null;
}

function resolveSubtitleContainer(title, episodeId) {
  if (!episodeId) return title.subtitles;
  for (const season of title.seasons) {
    const episode = season.episodes.find((e) => e.id === episodeId);
    if (episode) return episode.subtitles;
  }
  return null;
}

async function buildSourceFromBody(body = {}) {
  if (body.kind === 'url') {
    await discover.assertPublicUrl(body.url);
    return makeSource(body);
  }
  if (!body.path) throw Object.assign(new Error('A file path or URL is required'), { status: 400 });
  const abs = path.isAbsolute(body.path) ? body.path : path.join(config.mediaDir, body.path);
  const contained = sourceFilePath({ kind: 'file', path: abs });
  if (!contained) throw Object.assign(new Error('That file is outside the media roots'), { status: 400 });
  const stat = await fsp.stat(contained).catch(() => null);
  if (!stat?.isFile()) throw Object.assign(new Error('That file does not exist'), { status: 404 });
  return makeSource({ ...body, path: contained, size: stat.size });
}

// --------------------------------------------------------------------------
// uploads

async function handleUploads(req, res, url, route, method) {
  const uploadId = route[1];

  if (!uploadId) {
    if (method !== 'POST') return fail(res, 405, 'Method not allowed');
    const body = await readJson(req);
    const session = createUpload(body);
    return json(res, 201, { id: session.id, received: 0, filename: session.filename });
  }

  if (route[2] === 'complete' && method === 'POST') {
    const body = await readJson(req);
    const saved = await finishUpload(uploadId);
    const db = loadDb();

    let title = body.titleId ? findTitle(body.titleId) : null;
    let created = false;
    if (!title) {
      title = makeTitle({
        type: body.type === 'series' ? 'series' : 'movie',
        name: body.name || saved.filename,
        year: body.year ?? null,
        overview: body.overview || '',
        genres: body.genres || [],
        poster: body.poster || null,
        origin: 'upload',
      });
      db.titles.push(title);
      created = true;
    }

    const meta = body.meta || {};
    const source = makeSource({
      kind: 'file',
      path: saved.path,
      size: saved.size,
      width: meta.width ?? null,
      height: meta.height ?? null,
      fps: meta.fps ?? null,
      durationSec: meta.durationSec ?? null,
      codec: meta.codec || '',
      label: body.label || (meta.height ? qualityLabel(meta.height) : ''),
    });

    if (body.episode) {
      title.type = 'series';
      const season = ensureSeason(title, Number(body.episode.season) || 1);
      const episode = ensureEpisode(season, Number(body.episode.number) || season.episodes.length + 1, body.episode.name);
      episode.sources.push(source);
    } else {
      title.sources.push(source);
    }
    if (meta.durationSec && !title.runtimeMin) title.runtimeMin = Math.round(meta.durationSec / 60);

    await saveDb();
    return json(res, 201, {
      title: publicTitle(title),
      sourceId: source.id,
      createdTitle: created,
      size: formatBytes(saved.size),
    });
  }

  if (method === 'GET') {
    const session = getUpload(uploadId);
    return json(res, 200, { id: session.id, received: session.received, size: session.size });
  }

  if (method === 'PUT' || method === 'PATCH') {
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_CHUNK_BYTES) {
      return fail(res, 413, `Chunks must be at most ${formatBytes(MAX_CHUNK_BYTES)}`);
    }
    const session = await appendChunk(uploadId, offset, req);
    return json(res, 200, { received: session.received, size: session.size });
  }

  if (method === 'DELETE') {
    await abortUpload(uploadId);
    return json(res, 200, { ok: true });
  }

  return fail(res, 405, 'Method not allowed');
}

// --------------------------------------------------------------------------
// streaming

async function handleStream(req, res, url, route) {
  const [, titleId, sourceId] = route;
  const found = findSource(titleId, sourceId);
  if (!found) return fail(res, 404, 'No such source');
  const { source } = found;

  if (source.kind === 'url') {
    const adaptive = hlsLike(source.url) || dashLike(source.url);

    // Adaptive manifests have to be fetched by the browser from their own
    // origin — their segment URLs are relative to it — so those redirect.
    // Everything else streams through Elbi, because the server is the machine
    // known to reach the source: a phone on the LAN, a client behind a
    // firewall, or a host that blocks hotlinking would all fail on a redirect.
    if (adaptive || url.searchParams.get('redirect') === '1') {
      res.writeHead(302, { Location: source.url, 'Cache-Control': 'no-store' });
      return res.end();
    }
    return discover.proxyRemote(req, res, source.url);
  }

  const filePath = sourceFilePath(source);
  if (!filePath) return fail(res, 410, 'That file has moved outside the media folder');

  const download = url.searchParams.get('download') === '1';
  return serveFile(req, res, filePath, {
    contentType: source.mime,
    cacheControl: 'private, max-age=0, must-revalidate',
    headers: download
      ? { 'Content-Disposition': `attachment; filename="${path.basename(filePath).replace(/"/g, '')}"` }
      : {},
  });
}

// --------------------------------------------------------------------------
// subtitles (always served as WebVTT — <track> understands nothing else)

async function handleSubtitles(req, res, route) {
  const [, titleId, rawId] = route;
  const subtitleId = String(rawId || '').replace(/\.vtt$/i, '');
  const sub = findSubtitle(titleId, subtitleId);
  if (!sub) return fail(res, 404, 'No such subtitle track');

  const headers = {
    'Content-Type': 'text/vtt; charset=utf-8',
    'Cache-Control': 'private, max-age=3600',
    'Access-Control-Allow-Origin': '*',
  };

  if (sub.kind === 'url') {
    try {
      await discover.assertPublicUrl(sub.url);
      const upstream = await fetch(sub.url, { headers: { 'User-Agent': 'Elbi/1.0' } });
      if (!upstream.ok) return fail(res, 502, `Subtitle source replied ${upstream.status}`);
      const text = await upstream.text();
      return send(res, 200, /\.srt(\?|$)/i.test(sub.url) ? srtToVtt(text) : text, headers);
    } catch (err) {
      return fail(res, err.status || 502, err.message);
    }
  }

  const filePath = sourceFilePath({ kind: 'file', path: sub.path })
    || (sub.path?.startsWith(config.dataDir) ? sub.path : null);
  if (!filePath) return fail(res, 410, 'Subtitle file is no longer reachable');

  const text = await fsp.readFile(filePath, 'utf8').catch(() => null);
  if (text === null) return fail(res, 404, 'Subtitle file is missing');
  return send(res, 200, /\.srt$/i.test(filePath) ? srtToVtt(text) : text, headers);
}

// --------------------------------------------------------------------------
// progress / my list / profiles / settings

async function handleProgress(req, res, route, method) {
  const db = loadDb();
  if (method === 'POST') {
    const body = await readJson(req);
    const profileId = body.profileId || db.profiles[0]?.id;
    if (!db.profiles.some((p) => p.id === profileId)) return fail(res, 400, 'Unknown profile');
    if (!findTitle(body.titleId)) return fail(res, 404, 'No such title');

    const key = `${body.titleId}:${body.episodeId || '-'}`;
    const position = Math.max(0, Number(body.position) || 0);
    const duration = Math.max(0, Number(body.duration) || 0);
    db.progress[profileId] = db.progress[profileId] || {};

    // Treat the last 4% (or final 90s) as finished so it leaves Continue Watching.
    const nearEnd = duration > 0 && position >= Math.max(duration * 0.96, duration - 90);
    if (nearEnd || (duration > 0 && position < 5)) {
      delete db.progress[profileId][key];
      if (nearEnd) {
        db.progress[profileId][key] = {
          position, duration, sourceId: body.sourceId || null, finished: true, updatedAt: Date.now(),
        };
      }
    } else {
      db.progress[profileId][key] = {
        position, duration, sourceId: body.sourceId || null, finished: false, updatedAt: Date.now(),
      };
    }
    await saveDb();
    return json(res, 200, { progress: db.progress[profileId] });
  }

  if (method === 'DELETE') {
    const profileId = route[1];
    const key = route.slice(2).join(':');
    if (db.progress[profileId]) {
      delete db.progress[profileId][key];
      await saveDb();
    }
    return json(res, 200, { progress: db.progress[profileId] || {} });
  }
  return fail(res, 405, 'Method not allowed');
}

async function handleMyList(req, res, method) {
  const db = loadDb();
  if (method !== 'POST' && method !== 'DELETE') return fail(res, 405, 'Method not allowed');
  const body = await readJson(req);
  const profileId = body.profileId || db.profiles[0]?.id;
  if (!db.profiles.some((p) => p.id === profileId)) return fail(res, 400, 'Unknown profile');
  const list = new Set(db.myList[profileId] || []);
  if (method === 'POST') {
    if (!findTitle(body.titleId)) return fail(res, 404, 'No such title');
    list.add(body.titleId);
  } else {
    list.delete(body.titleId);
  }
  db.myList[profileId] = [...list];
  await saveDb();
  return json(res, 200, { myList: db.myList[profileId] });
}

async function handleProfiles(req, res, route, method) {
  const db = loadDb();
  if (method === 'GET') return json(res, 200, { profiles: db.profiles, fixed: true });
  // The roster is fixed in code (see store.js); there is nothing to create,
  // rename or remove, so say so plainly instead of half-supporting it.
  return fail(res, 403, `Elbi has a fixed set of profiles: ${db.profiles.map((p) => p.name).join(', ')}.`);
}

/** Clear one profile's watch history without touching anyone else's. */
async function handleResetProfile(req, res, route, method) {
  if (method !== 'POST') return fail(res, 405, 'Method not allowed');
  const db = loadDb();
  const profileId = route[1];
  if (!db.profiles.some((p) => p.id === profileId)) return fail(res, 404, 'No such profile');
  db.progress[profileId] = {};
  await saveDb();
  return json(res, 200, { progress: {} });
}

async function handleSettings(req, res, method) {
  const db = loadDb();
  if (method === 'GET') return json(res, 200, { settings: db.settings });
  if (method !== 'PATCH') return fail(res, 405, 'Method not allowed');
  const body = await readJson(req);
  if ('seekStep' in body) db.settings.seekStep = clamp(Number(body.seekStep), 1, 120, 5);
  if ('doubleClickSeek' in body) db.settings.doubleClickSeek = clamp(Number(body.doubleClickSeek), 1, 120, 5);
  if ('autoplayNext' in body) db.settings.autoplayNext = Boolean(body.autoplayNext);
  if ('resumeRewind' in body) db.settings.resumeRewind = clamp(Number(body.resumeRewind), 0, 60, 5);
  if ('subtitleSize' in body && ['small', 'medium', 'large', 'huge'].includes(body.subtitleSize)) {
    db.settings.subtitleSize = body.subtitleSize;
  }
  if ('subtitleBackground' in body && ['none', 'shadow', 'box'].includes(body.subtitleBackground)) {
    db.settings.subtitleBackground = body.subtitleBackground;
  }
  await saveDb();
  return json(res, 200, { settings: db.settings });
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

// --------------------------------------------------------------------------
// scan / artwork

async function handleScan(req, res, method) {
  if (method !== 'POST') return fail(res, 405, 'Method not allowed');
  const body = await readJson(req);
  const dir = body.dir ? String(body.dir) : config.mediaDir;
  const report = await scanFolder(dir);
  return json(res, 200, { ...report, dir });
}

async function handleArtwork(req, res, url, method) {
  if (method !== 'POST') return fail(res, 405, 'Method not allowed');
  const filename = url.searchParams.get('filename') || 'poster.jpg';
  const buffer = await readBody(req, 12 * 1024 * 1024);
  if (!buffer.length) return fail(res, 400, 'Empty image');
  const urlPath = await saveArtwork(buffer, filename);
  return json(res, 201, { url: urlPath });
}

// --------------------------------------------------------------------------
// discover (Internet Archive)

async function handleDiscover(req, res, url, route, method) {
  if (route[1] && route[2] === 'add' && method === 'POST') {
    const detail = await discover.item(route[1]);
    const body = await readJson(req).catch(() => ({}));
    const db = loadDb();
    const existing = db.titles.find((t) => t.origin === 'archive.org' && t.externalId === route[1]);
    if (existing) return json(res, 200, { title: publicTitle(existing), alreadyAdded: true });

    const title = makeTitle({
      type: 'movie',
      name: body.name || detail.name,
      year: detail.year,
      overview: detail.overview,
      poster: detail.poster,
      backdrop: detail.poster,
      runtimeMin: detail.runtimeMin,
      genres: ['Public domain'],
      origin: 'archive.org',
    });
    title.externalId = route[1];
    title.externalUrl = detail.pageUrl;
    title.license = detail.license;

    for (const source of detail.sources) {
      title.sources.push(makeSource({
        kind: 'url',
        url: source.url,
        label: source.label,
        height: source.height,
        width: source.width,
        size: source.size,
        durationSec: source.durationSec,
        codec: source.codec,
        playability: source.playability,
      }));
    }
    for (const sub of detail.subtitles) {
      title.subtitles.push({ id: id('sub_'), kind: 'url', url: sub.url, label: sub.label, lang: sub.lang });
    }
    db.titles.push(title);
    await saveDb();
    return json(res, 201, { title: publicTitle(title) });
  }

  if (method !== 'GET') return fail(res, 405, 'Method not allowed');

  if (route[1]) {
    const detail = await discover.item(route[1]);
    return json(res, 200, detail);
  }
  const result = await discover.search({
    q: url.searchParams.get('q') || '',
    collection: url.searchParams.get('collection') || '',
    page: url.searchParams.get('page') || 1,
  });
  return json(res, 200, result);
}

async function handleRemote(req, res, url) {
  const target = url.searchParams.get('url');
  if (!target) return fail(res, 400, 'A url parameter is required');
  return discover.proxyRemote(req, res, target);
}
