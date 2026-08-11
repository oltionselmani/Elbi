import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Auth is exercised in its own file because config reads the environment once,
 * at import, and these tests need a password set before that happens.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'elbi-auth-'));
process.env.ELBI_DATA_DIR = tmpRoot;
process.env.ELBI_PASSWORD = 'the-first-password';

const { config } = await import('../src/server/config.js');
const {
  isAuthed, sessionCookie, checkPassword, authRequired,
  clientKey, loginLockout, noteLoginFailure, noteLoginSuccess, resetLoginThrottle,
} = await import('../src/server/auth.js');

/** A request carrying the cookie that `sessionCookie()` just handed out. */
function reqWith(setCookieHeader, extra = {}) {
  return {
    headers: { cookie: String(setCookieHeader).split(';')[0], ...(extra.headers || {}) },
    socket: { remoteAddress: extra.remoteAddress || '10.0.0.5' },
  };
}

test('a freshly minted session is accepted', () => {
  assert.equal(authRequired(), true);
  assert.equal(isAuthed(reqWith(sessionCookie(false))), true);
});

test('changing the password revokes every session minted under the old one', () => {
  const cookie = sessionCookie(false);
  assert.equal(isAuthed(reqWith(cookie)), true, 'valid before the change');

  const previous = config.password;
  try {
    config.password = 'a-completely-different-password';
    assert.equal(
      isAuthed(reqWith(cookie)), false,
      'the old cookie must stop working — otherwise changing the password locks nobody out',
    );
    // And a session minted under the new password works.
    assert.equal(isAuthed(reqWith(sessionCookie(false))), true);
  } finally {
    config.password = previous;
  }

  // Back on the original password, the original cookie is good again.
  assert.equal(isAuthed(reqWith(cookie)), true);
});

test('clearing the password entirely also invalidates signed sessions', () => {
  const cookie = sessionCookie(false);
  const previous = config.password;
  try {
    config.password = '';
    // With no password Elbi is open, so isAuthed short-circuits to true; the
    // token itself must still have stopped verifying.
    assert.equal(authRequired(), false);
    config.password = 'yet-another';
    assert.equal(isAuthed(reqWith(cookie)), false);
  } finally {
    config.password = previous;
  }
});

test('a tampered or truncated cookie is refused', () => {
  const cookie = sessionCookie(false);
  const value = cookie.split(';')[0].split('=')[1];
  const [payload, mac] = [value.slice(0, value.lastIndexOf('.')), value.slice(value.lastIndexOf('.') + 1)];

  for (const bad of [
    `elbi_session=${payload}.${mac.slice(0, -1)}`,
    `elbi_session=${payload}.`,
    `elbi_session=${payload}`,
    `elbi_session=${Date.now() + 99999}.${mac}`,
    'elbi_session=',
    'elbi_session=....',
  ]) {
    assert.equal(isAuthed({ headers: { cookie: bad }, socket: {} }), false, `accepted "${bad}"`);
  }
});

test('an expired session is refused', () => {
  // Mint with a TTL already in the past.
  const previous = config.sessionTtlMs;
  try {
    config.sessionTtlMs = -1000;
    assert.equal(isAuthed(reqWith(sessionCookie(false))), false);
  } finally {
    config.sessionTtlMs = previous;
  }
});

test('checkPassword compares the whole password, not a prefix', () => {
  assert.equal(checkPassword('the-first-password'), true);
  assert.equal(checkPassword('the-first-passwor'), false);
  assert.equal(checkPassword('the-first-passwordX'), false);
  assert.equal(checkPassword(''), false);
  assert.equal(checkPassword(undefined), false);
});

// --------------------------------------------------------------------------
// login throttling

test('login lockout backs off exponentially and clears on success', () => {
  resetLoginThrottle();
  const who = '203.0.113.9';
  const now = 1_000_000;

  // The first few misses are free — a person mistyping their own password
  // should not be punished.
  for (let i = 1; i <= 5; i += 1) {
    assert.equal(noteLoginFailure(who, now), 0, `attempt ${i} should not lock`);
  }

  const sixth = noteLoginFailure(who, now);
  assert.ok(sixth > 0, 'the sixth failure must start a lockout');
  const seventh = noteLoginFailure(who, now);
  assert.ok(seventh > sixth, 'the lockout must grow with each further failure');

  // It expires on its own.
  assert.equal(loginLockout(who, now + seventh + 1), 0);

  // A correct password wipes the slate.
  noteLoginSuccess(who);
  assert.equal(loginLockout(who, now), 0);
  assert.equal(noteLoginFailure(who, now), 0, 'counting restarts after a success');
});

test('the lockout is capped so a locked-out household is not stranded', () => {
  resetLoginThrottle();
  const who = '203.0.113.10';
  const now = 2_000_000;
  let last = 0;
  for (let i = 0; i < 60; i += 1) last = noteLoginFailure(who, now);
  assert.ok(last <= 15 * 60 * 1000, `lockout ran away to ${last}ms`);
  assert.ok(last >= 60 * 1000, 'a sustained attack should still be locked out for minutes');
});

test('failures are tracked per client, not globally', () => {
  resetLoginThrottle();
  const now = 3_000_000;
  for (let i = 0; i < 10; i += 1) noteLoginFailure('198.51.100.1', now);
  assert.ok(loginLockout('198.51.100.1', now) > 0);
  assert.equal(loginLockout('198.51.100.2', now), 0, 'one attacker must not lock out the whole house');
});

test('X-Forwarded-For is ignored unless the operator opts in', () => {
  const req = {
    headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    socket: { remoteAddress: '10.0.0.5' },
  };
  const previous = config.trustProxy;
  try {
    config.trustProxy = false;
    assert.equal(clientKey(req), '10.0.0.5', 'a forgeable header must not name the client by default');
    config.trustProxy = true;
    assert.equal(clientKey(req), '1.2.3.4', 'behind a trusted proxy the real client is the first hop');
  } finally {
    config.trustProxy = previous;
  }
});

test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
