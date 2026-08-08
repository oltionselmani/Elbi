import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function resolveDir(name, fallback) {
  const raw = process.env[name];
  const dir = raw && raw.trim() ? path.resolve(raw.trim()) : path.join(ROOT, fallback);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const config = {
  root: ROOT,
  host: process.env.ELBI_HOST || '0.0.0.0',
  port: envInt('ELBI_PORT', 8080),

  publicDir: path.join(ROOT, 'public'),
  dataDir: resolveDir('ELBI_DATA_DIR', 'data'),
  mediaDir: resolveDir('ELBI_MEDIA_DIR', 'media'),

  get uploadsDir() {
    const dir = path.join(this.mediaDir, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  },
  get artDir() {
    const dir = path.join(this.dataDir, 'art');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  },
  get tmpDir() {
    const dir = path.join(this.dataDir, 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  },

  // Optional shared password. When unset, Elbi is open (fine on a home LAN).
  password: process.env.ELBI_PASSWORD || '',
  // Extra folders the "scan" feature is allowed to import from, ':'-separated.
  extraScanDirs: (process.env.ELBI_SCAN_DIRS || '')
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s)),
  // Allow proxying/streaming remote URLs (Internet Archive browser, add-by-URL).
  allowRemote: process.env.ELBI_ALLOW_REMOTE !== '0',
  sessionTtlMs: envInt('ELBI_SESSION_DAYS', 30) * 24 * 60 * 60 * 1000,
};

/**
 * Server secret used to sign session cookies. Persisted so that sessions
 * survive a restart; generated on first boot.
 */
export function loadSecret() {
  const file = path.join(config.dataDir, '.secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* first boot */
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

/** Directories that files may legitimately be streamed from. */
export function allowedRoots() {
  return [config.mediaDir, ...config.extraScanDirs];
}
