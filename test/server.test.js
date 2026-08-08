import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * End-to-end exercise of the real HTTP server against a throwaway data dir.
 * Env has to be set before server.js is imported, since config reads it once.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'elbi-test-'));
const scanDir = path.join(tmpRoot, 'external');
fs.mkdirSync(scanDir, { recursive: true });

process.env.ELBI_DATA_DIR = path.join(tmpRoot, 'data');
process.env.ELBI_MEDIA_DIR = path.join(tmpRoot, 'media');
process.env.ELBI_SCAN_DIRS = scanDir;
process.env.ELBI_PORT = '0';
process.env.ELBI_HOST = '127.0.0.1';
process.env.ELBI_LOG = '0';
process.env.ELBI_ALLOW_REMOTE = '0';

let server;
let base;

before(async () => {
  ({ default: server } = await import('../server.js'));
  if (!server.listening) {
    await new Promise((resolve) => server.once('listening', resolve));
  }
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

async function call(method, urlPath, body, extra = {}) {
  const init = { method, ...extra };
  if (body !== undefined && !(body instanceof Uint8Array)) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json', ...(extra.headers || {}) };
  } else if (body instanceof Uint8Array) {
    init.body = body;
    init.headers = { 'Content-Type': 'application/octet-stream', ...(extra.headers || {}) };
  }
  const res = await fetch(base + urlPath, init);
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, headers: res.headers, body: payload };
}

/** A byte pattern we can verify byte-for-byte after a round trip. */
function fakeVideo(size) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buf[i] = i % 251;
  return buf;
}

test('serves the app shell and its client routes', async () => {
  const home = await call('GET', '/');
  assert.equal(home.status, 200);
  assert.ok(home.body.includes('<title>Elbi</title>'));

  const deep = await call('GET', '/library');
  assert.equal(deep.status, 200, 'client-side routes fall back to the shell');

  const sw = await call('GET', '/sw.js');
  assert.equal(sw.status, 200);
  assert.equal(sw.headers.get('service-worker-allowed'), '/');

  const missing = await call('GET', '/definitely-not-here.txt');
  assert.equal(missing.status, 404);
});

test('starts with one profile and an empty library', async () => {
  const res = await call('GET', '/api/library');
  assert.equal(res.status, 200);
  assert.equal(res.body.titles.length, 0);
  assert.equal(res.body.profiles.length, 1);
  assert.equal(res.body.settings.seekStep, 5);
  assert.equal(res.body.server.allowRemote, false);
});

let titleId;
let sourceId;
const VIDEO = fakeVideo(3 * 1024 * 1024 + 777); // deliberately not chunk-aligned

test('uploads a file in chunks and registers it as a title', async () => {
  const start = await call('POST', '/api/uploads', {
    filename: 'The Test Movie 2021 1080p.mp4',
    size: VIDEO.length,
    mime: 'video/mp4',
  });
  assert.equal(start.status, 201);
  const uploadId = start.body.id;

  const chunkSize = 1024 * 1024;
  let offset = 0;
  while (offset < VIDEO.length) {
    const end = Math.min(offset + chunkSize, VIDEO.length);
    const res = await call('PUT', `/api/uploads/${uploadId}?offset=${offset}`, VIDEO.subarray(offset, end));
    assert.equal(res.status, 200);
    assert.equal(res.body.received, end);
    offset = res.body.received;
  }

  const done = await call('POST', `/api/uploads/${uploadId}/complete`, {
    name: 'The Test Movie',
    year: 2021,
    meta: { width: 1920, height: 1080, fps: 23.98, durationSec: 5400 },
  });
  assert.equal(done.status, 201);
  assert.equal(done.body.createdTitle, true);

  titleId = done.body.title.id;
  sourceId = done.body.sourceId;

  const source = done.body.title.sources[0];
  assert.equal(source.height, 1080);
  assert.equal(source.label, '1080p');
  assert.equal(source.fps, 23.98);
  assert.equal(source.size, VIDEO.length);
  assert.equal(source.playability.level, 'direct');
  assert.equal(done.body.title.runtimeMin, 90);
});

test('rejects a chunk written at the wrong offset', async () => {
  const start = await call('POST', '/api/uploads', { filename: 'x.mp4', size: 100 });
  const uploadId = start.body.id;
  await call('PUT', `/api/uploads/${uploadId}?offset=0`, new Uint8Array(10));
  const bad = await call('PUT', `/api/uploads/${uploadId}?offset=999`, new Uint8Array(10));
  assert.equal(bad.status, 409);
  assert.equal(bad.body.received, 10, 'the client is told where to resume from');
  await call('DELETE', `/api/uploads/${uploadId}`);
});

test('refuses to accept a non-video upload', async () => {
  const res = await call('POST', '/api/uploads', { filename: 'payload.sh', size: 10 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not a video file/);
});

test('streams the whole file and honours range requests', async () => {
  const full = await fetch(`${base}/api/stream/${titleId}/${sourceId}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(Number(full.headers.get('content-length')), VIDEO.length);
  const bytes = Buffer.from(await full.arrayBuffer());
  assert.ok(bytes.equals(VIDEO), 'the bytes come back exactly as uploaded');

  const mid = await fetch(`${base}/api/stream/${titleId}/${sourceId}`, {
    headers: { Range: 'bytes=1000-1999' },
  });
  assert.equal(mid.status, 206);
  assert.equal(mid.headers.get('content-range'), `bytes 1000-1999/${VIDEO.length}`);
  const midBytes = Buffer.from(await mid.arrayBuffer());
  assert.equal(midBytes.length, 1000);
  assert.ok(midBytes.equals(VIDEO.subarray(1000, 2000)));

  const openEnded = await fetch(`${base}/api/stream/${titleId}/${sourceId}`, {
    headers: { Range: `bytes=${VIDEO.length - 10}-` },
  });
  assert.equal(openEnded.status, 206);
  assert.equal(Number(openEnded.headers.get('content-length')), 10);

  const past = await fetch(`${base}/api/stream/${titleId}/${sourceId}`, {
    headers: { Range: `bytes=${VIDEO.length + 5}-` },
  });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), `bytes */${VIDEO.length}`);
});

test('remote sources are refused while ELBI_ALLOW_REMOTE=0', async () => {
  const res = await call('POST', `/api/titles/${titleId}/sources`, {
    kind: 'url',
    url: 'https://example.com/movie.mp4',
  });
  assert.equal(res.status, 403);
  const discover = await call('GET', '/api/discover');
  assert.equal(discover.status, 403);
});

test('a file source cannot point outside the allowed roots', async () => {
  const res = await call('POST', `/api/titles/${titleId}/sources`, {
    kind: 'file',
    path: '/etc/passwd',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /outside the media roots/);
});

test('static file serving refuses path traversal', async () => {
  const res = await fetch(`${base}/../../etc/passwd`);
  assert.notEqual(res.status, 200);
});

test('scan imports movies and groups episodes into a series', async () => {
  await fsp.writeFile(path.join(scanDir, 'Deep Water 2018 720p.mp4'), fakeVideo(2048));
  await fsp.writeFile(path.join(scanDir, 'Night Shift S01E01 1080p.mp4'), fakeVideo(2048));
  await fsp.writeFile(path.join(scanDir, 'Night Shift S01E02 1080p.mp4'), fakeVideo(2048));
  await fsp.writeFile(path.join(scanDir, 'Night Shift S01E01 1080p.en.srt'),
    '1\n00:00:01,000 --> 00:00:02,000\nHi\n');
  await fsp.writeFile(path.join(scanDir, 'Old Reel.avi'), fakeVideo(512));

  const res = await call('POST', '/api/scan', { dir: scanDir });
  assert.equal(res.status, 200);
  assert.equal(res.body.added, 4);
  assert.deepEqual(res.body.unplayable, ['Old Reel.avi']);

  const lib = await call('GET', '/api/library');
  const series = lib.body.titles.find((t) => t.name === 'Night Shift');
  assert.ok(series, 'the two episode files became one series');
  assert.equal(series.type, 'series');
  assert.equal(series.seasons.length, 1);
  assert.equal(series.seasons[0].episodes.length, 2);
  assert.equal(series.episodeCount, 2);

  const movie = lib.body.titles.find((t) => t.name === 'Deep Water');
  assert.ok(movie);
  assert.equal(movie.year, 2018);
  assert.equal(movie.sources[0].height, 720);

  // Subtitles found next to a video are attached and served as WebVTT.
  const episode = series.seasons[0].episodes[0];
  assert.equal(episode.subtitles.length, 1);
  const vtt = await call('GET', `/api/subtitles/${series.id}/${episode.subtitles[0].id}.vtt`);
  assert.equal(vtt.status, 200);
  assert.ok(vtt.body.startsWith('WEBVTT'));

  // Re-scanning is idempotent.
  const again = await call('POST', '/api/scan', { dir: scanDir });
  assert.equal(again.body.added, 0);
  assert.equal(again.body.skipped, 4);
});

test('scanning outside the permitted roots is rejected', async () => {
  const res = await call('POST', '/api/scan', { dir: '/etc' });
  assert.equal(res.status, 400);
});

test('watch progress is stored, and finishing a title clears it from Continue Watching', async () => {
  const lib = await call('GET', '/api/library');
  const profileId = lib.body.profiles[0].id;

  const mid = await call('POST', '/api/progress', {
    profileId, titleId, position: 1200, duration: 5400,
  });
  assert.equal(mid.status, 200);
  assert.equal(mid.body.progress[`${titleId}:-`].position, 1200);
  assert.equal(mid.body.progress[`${titleId}:-`].finished, false);

  const end = await call('POST', '/api/progress', {
    profileId, titleId, position: 5390, duration: 5400,
  });
  assert.equal(end.body.progress[`${titleId}:-`].finished, true);
});

test('my list add/remove round trip', async () => {
  const lib = await call('GET', '/api/library');
  const profileId = lib.body.profiles[0].id;

  const added = await call('POST', '/api/mylist', { profileId, titleId });
  assert.deepEqual(added.body.myList, [titleId]);

  const removed = await call('DELETE', '/api/mylist', { profileId, titleId });
  assert.deepEqual(removed.body.myList, []);
});

test('titles can be edited and settings persisted', async () => {
  const patched = await call('PATCH', `/api/titles/${titleId}`, {
    overview: 'A test movie.',
    genres: ['Drama', 'Thriller'],
    rating: 'PG-13',
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.title.overview, 'A test movie.');
  assert.deepEqual(patched.body.title.genres, ['Drama', 'Thriller']);

  const settings = await call('PATCH', '/api/settings', { seekStep: 10, doubleClickSeek: 15 });
  assert.equal(settings.body.settings.seekStep, 10);
  assert.equal(settings.body.settings.doubleClickSeek, 15);
  // Out-of-range values are clamped rather than accepted.
  const clamped = await call('PATCH', '/api/settings', { seekStep: 9999 });
  assert.equal(clamped.body.settings.seekStep, 120);
});

test('deleting a title removes it and its uploaded file when asked', async () => {
  const before2 = await call('GET', '/api/library');
  const uploaded = before2.body.titles.find((t) => t.id === titleId);
  const filename = uploaded.sources[0].filename;
  const onDisk = path.join(process.env.ELBI_MEDIA_DIR, 'uploads', filename);
  assert.ok(fs.existsSync(onDisk));

  const res = await call('DELETE', `/api/titles/${titleId}?deleteFiles=1`);
  assert.equal(res.status, 200);
  assert.equal(res.body.removed, true);
  assert.equal(fs.existsSync(onDisk), false, 'the uploaded file is gone');

  const after2 = await call('GET', '/api/library');
  assert.equal(after2.body.titles.some((t) => t.id === titleId), false);
});

test('a scanned file is never deleted from disk', async () => {
  const lib = await call('GET', '/api/library');
  const movie = lib.body.titles.find((t) => t.name === 'Deep Water');
  const onDisk = path.join(scanDir, 'Deep Water 2018 720p.mp4');

  await call('DELETE', `/api/titles/${movie.id}?deleteFiles=1`);
  assert.ok(fs.existsSync(onDisk), 'files Elbi did not upload stay where they are');
});

test('the library survives a restart', async () => {
  const { resetCache, loadDb } = await import('../src/server/store.js');
  const { flush } = await import('../src/server/store.js');
  await flush();
  resetCache();
  const db = loadDb();
  assert.ok(db.titles.some((t) => t.name === 'Night Shift'), 'library.json was written to disk');
});
