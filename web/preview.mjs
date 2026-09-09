/**
 * Serve dist/elbi.html the way the artifact host serves it.
 *
 *   node web/build.mjs && node web/preview.mjs   → http://127.0.0.1:4173
 *
 * The published page is a fragment: the host wraps it in a document with a
 * charset, a viewport and a small reset. Previewing it any other way would test
 * something that is not what people see, so the same wrapper goes on here.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'dist', 'elbi.html');
const PORT = Number(process.env.PORT || 4173);

// The host's own reset, reproduced so the preview is honest about it.
const HEAD = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { color-scheme: light; }
body { margin: 0; font: 14px system-ui, sans-serif; background: #faf9f7; }
img { max-width: 100%; }
[hidden] { display: none !important; }
</style>
</head>
<body>
`;

const server = http.createServer((req, res) => {
  if (!fs.existsSync(FILE)) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Run: node web/build.mjs');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`${HEAD}${fs.readFileSync(FILE, 'utf8')}\n</body></html>\n`);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Elbi (hosted build) → http://127.0.0.1:${PORT}`);
});
