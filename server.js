#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { config } from './src/server/config.js';
import { handleApi } from './src/server/api.js';
import fs from 'node:fs';
import { json, fail, serveFile, staticTarget } from './src/server/http.js';
import { isAuthed, authRequired } from './src/server/auth.js';
import { loadDb, flush } from './src/server/store.js';

const SPA_ROUTES = ['/', '/browse', '/search', '/library', '/discover', '/watch', '/settings', '/profiles'];

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return fail(res, 400, 'Bad request URL');
  }

  res.on('finish', () => {
    if (process.env.ELBI_LOG === '0') return;
    const ms = Date.now() - started;
    if (url.pathname.startsWith('/api/stream') && res.statusCode === 206) return; // too chatty while seeking
    console.log(`${req.method} ${url.pathname}${url.search} → ${res.statusCode} (${ms}ms)`);
  });

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Allow': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Origin': req.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
      });
      return res.end();
    }

    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }

    // Uploaded artwork.
    if (url.pathname.startsWith('/art/')) {
      if (!isAuthed(req)) return fail(res, 401, 'Sign in to use Elbi.', { authRequired: true });
      const target = staticTarget(config.artDir, url.pathname.slice('/art'.length));
      if (!target) return fail(res, 403, 'Forbidden');
      return await serveFile(req, res, target, { cacheControl: 'public, max-age=31536000, immutable' });
    }

    // The service worker must be served from the root to control the whole app.
    if (url.pathname === '/sw.js') {
      return await serveFile(req, res, path.join(config.publicDir, 'sw.js'), {
        cacheControl: 'no-cache',
        headers: { 'Service-Worker-Allowed': '/' },
      });
    }

    const target = staticTarget(config.publicDir, url.pathname);
    if (target && isFile(target)) {
      const immutable = /\.(css|js|svg|png|jpg|jpeg|webp|woff2?)$/.test(target) && url.search.includes('v=');
      return await serveFile(req, res, target, {
        cacheControl: immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
      });
    }

    // Client-side routing: "/" and the app's own routes render the shell.
    if (req.method === 'GET' || req.method === 'HEAD') {
      const isAppRoute = SPA_ROUTES.some((r) => url.pathname === r || url.pathname.startsWith(`${r}/`));
      if (isAppRoute) {
        return await serveFile(req, res, path.join(config.publicDir, 'index.html'), {
          cacheControl: 'no-cache',
        });
      }
    }
    return fail(res, 404, 'Not found');
  } catch (err) {
    const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
    // A browser hanging up mid-upload or mid-seek is routine, not a fault.
    const clientHungUp = ['ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(err?.code)
      || err?.message === 'aborted';
    if (status >= 500 && !clientHungUp) console.error('[elbi]', req.method, url.pathname, err);
    if (!res.headersSent) {
      const payload = { error: err?.message || 'Server error' };
      // Fields the client needs in order to recover (e.g. where to resume an upload).
      for (const field of ['received', 'authRequired']) {
        if (err?.[field] !== undefined) payload[field] = err[field];
      }
      return json(res, status, payload);
    }
    if (!res.writableEnded) res.destroy();
  }
});

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

// Large uploads and long movie streams should not be cut off by idle timeouts.
server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 72_000;

function localAddresses() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

server.listen(config.port, config.host, () => {
  const db = loadDb();
  const banner = [
    '',
    '  ███████ ██      ██████  ██',
    '  ██      ██      ██   ██ ██',
    '  █████   ██      ██████  ██',
    '  ██      ██      ██   ██ ██',
    '  ███████ ███████ ██████  ██',
    '',
    `  Local     http://localhost:${config.port}`,
    ...localAddresses().map((ip) => `  Network   http://${ip}:${config.port}`),
    '',
    `  Media     ${config.mediaDir}`,
    `  Data      ${config.dataDir}`,
    `  Titles    ${db.titles.length}`,
    `  Password  ${authRequired() ? 'enabled' : 'not set (open access — set ELBI_PASSWORD before exposing this to the internet)'}`,
    `  Remote    ${config.allowRemote ? 'enabled (stream & browse public-domain films)' : 'disabled'}`,
    '',
  ];
  console.log(banner.join('\n'));
});

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (closing) process.exit(0);
    closing = true;
    console.log('\n[elbi] shutting down…');
    server.close();
    await flush();
    process.exit(0);
  });
}

export default server;
