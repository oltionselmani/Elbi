import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The service worker's precache list has to keep up with what is actually
 * shipped. Anything missing from it is only cached opportunistically, which
 * silently fails for assets the browser requests before the worker claims the
 * page — the app then opens offline in fallback fonts with a blank icon.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const sw = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');

function shellAssets() {
  const start = sw.indexOf('const SHELL_ASSETS = [');
  assert.ok(start > -1, 'SHELL_ASSETS not found in sw.js');
  const open = sw.indexOf('[', start);
  const close = sw.indexOf('];', open);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${sw.slice(open, close + 1)};`)();
}

/** Files under public/ that the browser must be able to fetch offline. */
function shippedAssets() {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}/${entry.name}`);
      else if (/\.(css|js|woff2|png|svg|webmanifest)$/.test(entry.name)) out.push(`${prefix}/${entry.name}`);
    }
  };
  walk(publicDir, '');
  // sw.js registers itself and must never be cached by itself.
  return out.filter((p) => p !== '/sw.js');
}

const ASSETS = shellAssets();
const SHIPPED = shippedAssets();

test('every shipped asset is precached by the service worker', () => {
  const missing = SHIPPED.filter((p) => !ASSETS.includes(p));
  assert.deepEqual(
    missing, [],
    `these ship in public/ but are not in SHELL_ASSETS, so they will not be there offline:\n  ${missing.join('\n  ')}`,
  );
});

test('the precache list does not name anything that is not shipped', () => {
  const routes = new Set(['/', '/browse', '/index.html']);
  const ghosts = ASSETS.filter((p) => !routes.has(p) && !fs.existsSync(path.join(publicDir, p)));
  assert.deepEqual(ghosts, [], `SHELL_ASSETS names files that do not exist: ${ghosts.join(', ')}`);
});

test('all three type faces are precached', () => {
  for (const face of ['bebas-neue', 'plex-sans', 'plex-mono']) {
    assert.ok(
      ASSETS.some((p) => p.includes(face)),
      `${face} is not precached — the app would fall back to a system font offline`,
    );
  }
});

test('both installed-app icon sizes are precached', () => {
  for (const size of ['192', '512']) {
    assert.ok(
      ASSETS.some((p) => p.includes(`elbi-${size}`)),
      `the ${size}px icon is not precached — an installed PWA would show a blank tile offline`,
    );
  }
});

test('every icon the manifest declares is precached', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'));
  for (const icon of manifest.icons || []) {
    const src = icon.src.startsWith('/') ? icon.src : `/${icon.src}`;
    assert.ok(ASSETS.includes(src), `the manifest declares ${src} but it is not precached`);
  }
});

test('the shell cache is versioned, and downloaded videos are not', () => {
  assert.match(sw, /const SHELL_CACHE = `elbi-shell-\$\{VERSION\}`/, 'the shell cache must carry the version');
  assert.match(
    sw, /const VIDEO_CACHE = 'elbi-video-v1'/,
    'the video cache must stay unversioned so saved downloads survive an update',
  );
  // The activate handler deletes old caches; the video cache must be spared.
  const activate = sw.slice(sw.indexOf("addEventListener('activate'"), sw.indexOf("addEventListener('message'"));
  assert.ok(activate.includes('VIDEO_CACHE'), 'activate must keep VIDEO_CACHE when sweeping old caches');
});
