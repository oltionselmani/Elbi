import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { id, slug, VIDEO_EXTENSIONS } from './util.js';

/**
 * Resumable raw-binary uploads.
 *
 * The browser slices the File and PUTs each slice as a plain body — no
 * multipart parsing, no buffering a whole movie in memory, and an interrupted
 * upload resumes from the byte count the server reports.
 */
const sessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function partPath(uploadId) {
  return path.join(config.tmpDir, `${uploadId}.part`);
}

export function createUpload({ filename, size, mime }) {
  const clean = sanitizeFilename(filename);
  const ext = path.extname(clean).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) {
    throw Object.assign(
      new Error(`"${ext || 'no extension'}" is not a video file. Supported: ${[...VIDEO_EXTENSIONS].join(', ')}`),
      { status: 400 },
    );
  }
  const uploadId = id('u_');
  const session = {
    id: uploadId,
    filename: clean,
    size: Number(size) || 0,
    mime: mime || '',
    received: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    writing: false,
  };
  sessions.set(uploadId, session);
  fs.writeFileSync(partPath(uploadId), '');
  sweep();
  return session;
}

export function getUpload(uploadId) {
  const session = sessions.get(uploadId);
  if (!session) throw Object.assign(new Error('Unknown or expired upload session'), { status: 404 });
  return session;
}

/**
 * Append one chunk. `offset` must equal how many bytes we already hold, which
 * makes retries idempotent-ish and prevents interleaved writes corrupting the file.
 */
export async function appendChunk(uploadId, offset, req) {
  const session = getUpload(uploadId);
  if (session.writing) throw Object.assign(new Error('A chunk is already being written'), { status: 409 });

  const at = Number(offset);
  if (!Number.isFinite(at) || at < 0) throw Object.assign(new Error('Invalid offset'), { status: 400 });
  if (at !== session.received) {
    throw Object.assign(
      new Error(`Offset mismatch: server holds ${session.received} bytes`),
      { status: 409, received: session.received },
    );
  }

  session.writing = true;
  let written = 0;
  try {
    const out = fs.createWriteStream(partPath(uploadId), { flags: 'a' });
    req.on('data', (chunk) => { written += chunk.length; });
    await pipeline(req, out);
  } finally {
    session.writing = false;
  }

  session.received += written;
  session.updatedAt = Date.now();

  if (session.size && session.received > session.size) {
    await abortUpload(uploadId);
    throw Object.assign(new Error('Upload exceeded the declared size'), { status: 400 });
  }
  return session;
}

/** Move the finished .part into the media library under a unique final name. */
export async function finishUpload(uploadId) {
  const session = getUpload(uploadId);
  if (session.size && session.received !== session.size) {
    throw Object.assign(
      new Error(`Incomplete upload: ${session.received} of ${session.size} bytes`),
      { status: 400, received: session.received },
    );
  }
  const target = await uniquePath(config.uploadsDir, session.filename);
  await fsp.rename(partPath(uploadId), target).catch(async (err) => {
    if (err.code !== 'EXDEV') throw err;
    // tmp and media can live on different filesystems.
    await fsp.copyFile(partPath(uploadId), target);
    await fsp.unlink(partPath(uploadId)).catch(() => {});
  });
  sessions.delete(uploadId);
  const stat = await fsp.stat(target);
  return { path: target, size: stat.size, filename: path.basename(target) };
}

export async function abortUpload(uploadId) {
  sessions.delete(uploadId);
  await fsp.unlink(partPath(uploadId)).catch(() => {});
}

/** Save a poster/backdrop image uploaded from the browser. */
export async function saveArtwork(buffer, filename) {
  const ext = path.extname(sanitizeFilename(filename)).toLowerCase();
  const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif'];
  if (!allowed.includes(ext)) {
    throw Object.assign(new Error(`Image must be one of ${allowed.join(', ')}`), { status: 400 });
  }
  const name = `${id('art_')}${ext}`;
  await fsp.writeFile(path.join(config.artDir, name), buffer);
  return `/art/${name}`;
}

/** Save a subtitle file uploaded from the browser. */
export async function saveSubtitleFile(buffer, filename) {
  const ext = path.extname(sanitizeFilename(filename)).toLowerCase();
  if (!['.vtt', '.srt'].includes(ext)) {
    throw Object.assign(new Error('Subtitles must be .vtt or .srt'), { status: 400 });
  }
  const dir = path.join(config.dataDir, 'subtitles');
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${id('sub_')}${ext}`);
  await fsp.writeFile(target, buffer);
  return target;
}

export function sanitizeFilename(input) {
  const base = path.basename(String(input || 'video.mp4'));
  const ext = path.extname(base);
  const stem = slug(base.slice(0, base.length - ext.length));
  return `${stem}${ext.toLowerCase().replace(/[^.a-z0-9]/g, '')}`;
}

async function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await fsp.access(candidate);
      candidate = path.join(dir, `${stem}-${n}${ext}`);
      n += 1;
    } catch {
      return candidate;
    }
  }
}

function sweep() {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.updatedAt > SESSION_TTL_MS) {
      sessions.delete(key);
      fs.unlink(partPath(key), () => {});
    }
  }
}
