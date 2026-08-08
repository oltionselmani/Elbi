import fsp from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { mimeFor, parseRange } from './util.js';

export function send(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  const payload = body === null || body === undefined ? '' : body;
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  res.writeHead(status, { 'Content-Length': buf.length, ...headers });
  if (res.req?.method === 'HEAD') res.end();
  else res.end(buf);
}

export function json(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

export function fail(res, status, message, extra = {}) {
  json(res, status, { error: message, ...extra });
}

const MAX_JSON_BODY = 2 * 1024 * 1024;

export function readBody(req, limit = MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, limit = MAX_JSON_BODY) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

/**
 * Serve a file with full HTTP range support — this is what makes seeking in
 * a <video> work, and what the offline service worker mirrors.
 */
export async function serveFile(req, res, filePath, options = {}) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  if (stat.isDirectory()) {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  const type = options.contentType || mimeFor(filePath);
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Last-Modified': stat.mtime.toUTCString(),
    ETag: etag,
    'Cache-Control': options.cacheControl || 'public, max-age=0, must-revalidate',
    ...(options.headers || {}),
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  const range = parseRange(req.headers.range, stat.size);

  if (range?.unsatisfiable) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
    res.end();
    return;
  }

  if (range && !range.invalid) {
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'Content-Length': range.length,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await streamTo(res, createReadStream(filePath, { start: range.start, end: range.end }));
    return;
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await streamTo(res, createReadStream(filePath));
}

async function streamTo(res, stream) {
  try {
    await pipeline(stream, res);
  } catch (err) {
    // Clients abort mid-seek constantly; that is not an error worth logging.
    const benign = ['ERR_STREAM_PREMATURE_CLOSE', 'EPIPE', 'ECONNRESET'];
    if (!benign.includes(err?.code)) console.error('[elbi] stream error:', err.message);
    if (!res.writableEnded) res.destroy();
  }
}

/** Resolve a URL path inside a static root, refusing traversal. */
export function staticTarget(rootDir, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const normalized = path.posix.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const target = path.join(rootDir, normalized);
  const resolvedRoot = path.resolve(rootDir);
  const resolved = path.resolve(target);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return null;
  return resolved;
}
