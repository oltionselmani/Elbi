import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'elbi-cred-'));
process.env.ELBI_DATA_DIR = tmpRoot;
delete process.env.ELBI_PASSWORD;

const { config } = await import('../src/server/config.js');
const {
  setCredentials, readCredentials, verifyCredentials, credentialsSet,
  hashPassword, normalizeEmail, credentialFingerprint,
} = await import('../src/server/credentials.js');
const {
  authRequired, usesEmailLogin, checkSignIn, isAuthed, sessionCookie,
} = await import('../src/server/auth.js');

const EMAIL = 'someone@example.com';
const PASSWORD = 'a-long-enough-password';

const reqWith = (setCookie) => ({
  headers: { cookie: String(setCookie).split(';')[0] },
  socket: { remoteAddress: '10.0.0.9' },
});

test('with nothing set up there is no login at all', () => {
  assert.equal(credentialsSet(), false);
  assert.equal(authRequired(), false);
  assert.equal(usesEmailLogin(), false);
});

test('setting a credential turns the login on', () => {
  setCredentials(EMAIL, PASSWORD);
  assert.equal(credentialsSet(), true);
  assert.equal(authRequired(), true);
  assert.equal(usesEmailLogin(), true);
});

test('the password itself is never stored', () => {
  const raw = fs.readFileSync(path.join(tmpRoot, 'credentials.json'), 'utf8');
  assert.ok(!raw.includes(PASSWORD), 'the plaintext password must not be in the file');
  const record = JSON.parse(raw);
  assert.equal(record.email, EMAIL);
  assert.ok(record.hash && record.salt, 'a salt and a hash are stored instead');
  assert.equal(record.password, undefined);
});

test('the credential file is written owner-only', () => {
  const mode = fs.statSync(path.join(tmpRoot, 'credentials.json')).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test('the right email and password are accepted', () => {
  assert.equal(verifyCredentials(EMAIL, PASSWORD), true);
  assert.equal(checkSignIn({ email: EMAIL, password: PASSWORD }), true);
});

test('the email is not case- or whitespace-sensitive', () => {
  assert.equal(verifyCredentials('  SomeOne@Example.COM  ', PASSWORD), true);
  assert.equal(normalizeEmail('  A@B.COM '), 'a@b.com');
});

test('a wrong password, a wrong email, or neither is refused', () => {
  assert.equal(verifyCredentials(EMAIL, 'not-the-password'), false);
  assert.equal(verifyCredentials('someone-else@example.com', PASSWORD), false);
  assert.equal(verifyCredentials('', ''), false);
  assert.equal(verifyCredentials(EMAIL, `${PASSWORD}x`), false);
  assert.equal(verifyCredentials(EMAIL, PASSWORD.slice(0, -1)), false);
  assert.equal(checkSignIn({ email: EMAIL, password: undefined }), false);
  assert.equal(checkSignIn({}), false);
});

test('the same password hashes differently every time it is set', () => {
  const a = hashPassword(PASSWORD);
  const b = hashPassword(PASSWORD);
  assert.notEqual(a.salt, b.salt, 'a fresh salt each time');
  assert.notEqual(a.hash, b.hash, 'so two identical passwords do not share a hash');
  // …but the same salt reproduces the same hash, which is what verifying needs.
  assert.equal(hashPassword(PASSWORD, a.salt).hash, a.hash);
});

test('hashing is slow enough to make guessing impractical', () => {
  const started = Date.now();
  hashPassword('some-password');
  const ms = Date.now() - started;
  // A bare sha256 would be well under a millisecond. Anything in this range
  // makes a wordlist attack cost hours per thousand guesses rather than
  // seconds. The upper bound catches a parameter change that would make
  // signing in feel broken.
  assert.ok(ms >= 20, `hashing took only ${ms}ms — far too cheap to guess against`);
  assert.ok(ms < 3000, `hashing took ${ms}ms, which is too slow to sign in with`);
});

test('a wrong email costs the same as a wrong password', () => {
  // If a bad address returned instantly, the response time alone would say
  // which addresses exist.
  const time = (fn) => {
    const started = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - started) / 1e6;
  };
  const badPassword = time(() => verifyCredentials(EMAIL, 'wrong-password-here'));
  const badEmail = time(() => verifyCredentials('nobody@example.com', 'wrong-password-here'));
  const ratio = Math.max(badEmail, badPassword) / Math.max(1, Math.min(badEmail, badPassword));
  assert.ok(ratio < 5, `wrong email took ${badEmail.toFixed(0)}ms vs ${badPassword.toFixed(0)}ms for a wrong password`);
});

test('a signed-in session is accepted', () => {
  assert.equal(isAuthed(reqWith(sessionCookie(false))), true);
});

test('changing the password logs every device out', () => {
  const cookie = sessionCookie(false);
  assert.equal(isAuthed(reqWith(cookie)), true);
  setCredentials(EMAIL, 'a-completely-different-one');
  assert.equal(
    isAuthed(reqWith(cookie)), false,
    'a session signed under the old password must stop working',
  );
  assert.equal(isAuthed(reqWith(sessionCookie(false))), true, 'and a fresh one works');
});

test('changing the email logs every device out too', () => {
  const cookie = sessionCookie(false);
  setCredentials('new-address@example.com', 'a-completely-different-one');
  assert.equal(isAuthed(reqWith(cookie)), false);
});

test('the fingerprint changes with the credential and is never the password', () => {
  setCredentials(EMAIL, PASSWORD);
  const first = credentialFingerprint();
  assert.ok(first.length > 0);
  assert.ok(!first.includes(PASSWORD));
  setCredentials(EMAIL, 'yet-another-password');
  assert.notEqual(credentialFingerprint(), first);
});

test('a too-short password or a non-address is refused', () => {
  assert.throws(() => setCredentials(EMAIL, 'short'), /at least 8/);
  assert.throws(() => setCredentials('not-an-email', PASSWORD), /email address/);
});

test('"remember this device" decides whether the cookie outlives the browser', () => {
  const remembered = sessionCookie(false, { remember: true });
  const notRemembered = sessionCookie(false, { remember: false });
  assert.match(remembered, /Max-Age=\d+/, 'a remembered device gets a persistent cookie');
  assert.ok(!/Max-Age/.test(notRemembered), 'otherwise it is a session cookie');
  // Both are still real sessions.
  assert.equal(isAuthed(reqWith(remembered)), true);
  assert.equal(isAuthed(reqWith(notRemembered)), true);
});

test('a remembered cookie is capped at what browsers actually honour', () => {
  const previous = config.sessionTtlMs;
  try {
    config.sessionTtlMs = 10 * 365 * 24 * 60 * 60 * 1000; // ten years
    const age = Number(/Max-Age=(\d+)/.exec(sessionCookie(false))[1]);
    assert.ok(age <= 400 * 24 * 60 * 60, `Max-Age=${age} exceeds the 400-day ceiling browsers enforce`);
  } finally {
    config.sessionTtlMs = previous;
  }
});

test('every cookie is HttpOnly and SameSite, and Secure over https', () => {
  const plain = sessionCookie(false);
  assert.match(plain, /HttpOnly/, 'script must not be able to read the session');
  assert.match(plain, /SameSite=Lax/);
  assert.ok(!/Secure/.test(plain), 'not Secure on plain http, or it would never be set');
  assert.match(sessionCookie(true), /Secure/);
});

test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
