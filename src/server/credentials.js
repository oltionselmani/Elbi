import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * The sign-in credential: an email address and a password stored as a scrypt
 * hash.
 *
 * It lives in data/credentials.json, which is gitignored, and never in the
 * repository or in an environment variable that shows up in `ps`. A password
 * hash is still worth guessing offline if it leaks, so it is never committed
 * and the file is written owner-only.
 *
 * scrypt rather than a bare SHA: a single sha256 of a short password falls to
 * a wordlist in seconds, while these parameters cost roughly 100ms and 32MB
 * per guess, which makes a wordlist attack impractical.
 */

const FILE = () => path.join(config.dataDir, 'credentials.json');

// N=2^15 costs about 100ms and 32MB per hash on ordinary hardware. Stored
// alongside the hash so the cost can be raised later without stranding
// anyone's existing password.
const PARAMS = { N: 32768, r: 8, p: 1, keylen: 64 };

/** scrypt needs to be told it may use more than the 32MB default. */
const maxmemFor = ({ N, r }) => Math.max(64 * 1024 * 1024, N * r * 256);

export function hashPassword(password, saltHex = null, params = PARAMS) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, params.keylen, {
    N: params.N, r: params.r, p: params.p, maxmem: maxmemFor(params),
  });
  return { salt: salt.toString('hex'), hash: key.toString('hex'), params };
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/** Write the credential, replacing whatever was there. */
export function setCredentials(email, password) {
  const clean = normalizeEmail(email);
  if (!clean.includes('@')) {
    throw Object.assign(new Error('That does not look like an email address'), { status: 400 });
  }
  if (String(password).length < 8) {
    throw Object.assign(new Error('Use at least 8 characters'), { status: 400 });
  }
  const { salt, hash, params } = hashPassword(password);
  const record = { email: clean, salt, hash, params, updatedAt: new Date().toISOString() };
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(record, null, 2), { mode: 0o600 });
  return { email: clean };
}

export function readCredentials() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (!raw?.email || !raw?.hash || !raw?.salt) return null;
    return { ...raw, params: { ...PARAMS, ...(raw.params || {}) } };
  } catch {
    return null;
  }
}

export function credentialsSet() {
  return readCredentials() !== null;
}

/**
 * Check an email and password.
 *
 * The password is hashed even when the email is wrong, so a wrong address and
 * a wrong password take the same time — otherwise the response time alone
 * would tell an attacker which addresses exist.
 */
export function verifyCredentials(email, password) {
  const record = readCredentials();
  if (!record) return false;

  const candidate = hashPassword(password ?? '', record.salt, record.params);
  const a = Buffer.from(candidate.hash, 'hex');
  const b = Buffer.from(record.hash, 'hex');
  const passwordOk = a.length === b.length && crypto.timingSafeEqual(a, b);
  const emailOk = normalizeEmail(email) === record.email;
  return passwordOk && emailOk;
}

/**
 * A fingerprint of the current credential, mixed into the session signing key
 * so that changing the password or the email invalidates every session that
 * was issued under the old one.
 */
export function credentialFingerprint() {
  const record = readCredentials();
  if (!record) return '';
  return `${record.email}:${record.hash}`;
}
