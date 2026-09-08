import crypto from 'node:crypto';
import { config, loadSecret } from './config.js';
import { credentialsSet, credentialFingerprint, verifyCredentials } from './credentials.js';

const COOKIE = 'elbi_session';
let secret = null;

function getSecret() {
  if (!secret) secret = loadSecret();
  return secret;
}

export function authRequired() {
  return credentialsSet() || Boolean(config.password);
}

/** True once an email/password has been set up, as opposed to a bare password. */
export function usesEmailLogin() {
  return credentialsSet();
}

/**
 * Sessions are signed with the server secret *and* the current credential, so
 * changing the password (or the email) silently invalidates every cookie that
 * was minted under the old one. Signing with the secret alone meant a password
 * change locked nobody out — the whole point of changing it.
 *
 * Neither the password nor its hash leaves the server: they only ever
 * contribute to the key, so the cookie itself stays a plain `expiry.mac` pair.
 */
function signingKey() {
  return crypto.createHash('sha256')
    .update(getSecret())
    .update('\0')
    .update(config.password)
    .update('\0')
    .update(credentialFingerprint())
    .digest();
}

function sign(value) {
  return crypto.createHmac('sha256', signingKey()).update(value).digest('base64url');
}

function mintToken(ttlMs = config.sessionTtlMs) {
  const expires = Date.now() + ttlMs;
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

/**
 * Check a sign-in.
 *
 * An email/password credential takes precedence when one has been set up;
 * ELBI_PASSWORD remains as the simpler shared-password mode for a LAN.
 */
export function checkSignIn({ email = '', password = '' } = {}) {
  if (!authRequired()) return true;
  if (credentialsSet()) return verifyCredentials(email, password);

  const a = Buffer.from(String(password ?? ''));
  const b = Buffer.from(config.password);
  // Hash both sides so the comparison is constant-time regardless of length.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Older name, kept for the shared-password path and its tests. */
export function checkPassword(candidate) {
  return checkSignIn({ password: candidate });
}

// --------------------------------------------------------------------------
// login throttling
//
// Without this, the login endpoint answers a wrong password in about a
// millisecond, so a shared household password falls to roughly 800 guesses a
// second over a LAN. Failures are counted per client and the lockout doubles,
// which costs a person who fat-fingers their own password almost nothing and
// costs a script the entire keyspace.

const FREE_ATTEMPTS = 5;
const MAX_LOCKOUT_MS = 15 * 60 * 1000;
const FORGET_AFTER_MS = 60 * 60 * 1000;

const failures = new Map(); // client -> { count, lockedUntil, seen }

/**
 * Who is knocking. `X-Forwarded-For` is only believed when the operator opts in
 * with ELBI_TRUST_PROXY: trusting it unconditionally would let an attacker
 * spoof a fresh identity per request and walk straight past the limiter.
 */
export function clientKey(req) {
  if (config.trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket?.remoteAddress || 'unknown';
}

function prune(now) {
  if (failures.size < 512) return;
  for (const [key, entry] of failures) {
    if (now - entry.seen > FORGET_AFTER_MS) failures.delete(key);
  }
}

/** Milliseconds this client must wait, or 0 when it may try now. */
export function loginLockout(key, now = Date.now()) {
  const entry = failures.get(key);
  if (!entry) return 0;
  if (now - entry.seen > FORGET_AFTER_MS) {
    failures.delete(key);
    return 0;
  }
  return Math.max(0, entry.lockedUntil - now);
}

export function noteLoginFailure(key, now = Date.now()) {
  prune(now);
  const entry = failures.get(key) || { count: 0, lockedUntil: 0, seen: now };
  entry.count += 1;
  entry.seen = now;
  if (entry.count > FREE_ATTEMPTS) {
    const step = entry.count - FREE_ATTEMPTS; // 1, 2, 3, …
    entry.lockedUntil = now + Math.min(2 ** step * 1000, MAX_LOCKOUT_MS);
  }
  failures.set(key, entry);
  return loginLockout(key, now);
}

export function noteLoginSuccess(key) {
  failures.delete(key);
}

/** Test hook: forget every recorded failure. */
export function resetLoginThrottle() {
  failures.clear();
}

/**
 * Browsers clamp a cookie's lifetime to 400 days, so asking for longer only
 * looks longer. This is the ceiling, not a suggestion.
 */
const MAX_COOKIE_AGE_S = 400 * 24 * 60 * 60;

/**
 * `remember` is the "remember this device" tick on the sign-in form: the
 * cookie is given the full session lifetime and survives closing the browser,
 * so a phone is asked once and then not again. Without it the cookie is a
 * session cookie, which is what you want on someone else's computer.
 */
export function sessionCookie(secureHint, { remember = true } = {}) {
  const ttlS = Math.min(Math.floor(config.sessionTtlMs / 1000), MAX_COOKIE_AGE_S);
  const attrs = [
    `${COOKIE}=${mintToken(ttlS * 1000)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (remember) attrs.push(`Max-Age=${ttlS}`);
  if (secureHint) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
