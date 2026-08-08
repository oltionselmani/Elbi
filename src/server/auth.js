import crypto from 'node:crypto';
import { config, loadSecret } from './config.js';

const COOKIE = 'elbi_session';
let secret = null;

function getSecret() {
  if (!secret) secret = loadSecret();
  return secret;
}

export function authRequired() {
  return Boolean(config.password);
}

function sign(value) {
  return crypto.createHmac('sha256', getSecret()).update(value).digest('base64url');
}

function mintToken() {
  const expires = Date.now() + config.sessionTtlMs;
  const payload = `${expires}`;
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const expires = Number.parseInt(payload, 10);
  return Number.isFinite(expires) && expires > Date.now();
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

export function isAuthed(req) {
  if (!authRequired()) return true;
  const cookies = parseCookies(req.headers.cookie);
  return verifyToken(cookies[COOKIE]);
}

export function checkPassword(candidate) {
  if (!authRequired()) return true;
  const a = Buffer.from(String(candidate ?? ''));
  const b = Buffer.from(config.password);
  // Hash both sides so the comparison is constant-time regardless of length.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function sessionCookie(secureHint) {
  const attrs = [
    `${COOKIE}=${mintToken()}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`,
  ];
  if (secureHint) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
