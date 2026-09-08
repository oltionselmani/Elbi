#!/usr/bin/env node
/**
 * Set the email and password used to sign in.
 *
 *   node scripts/set-login.js
 *   node scripts/set-login.js you@example.com
 *
 * The password is asked for interactively and never echoed, never passed as an
 * argument (arguments are visible to anyone who can run `ps`), and never
 * written anywhere but data/credentials.json — which is gitignored and written
 * owner-only. Only a scrypt hash is stored; the password itself is not kept.
 */
import readline from 'node:readline';
import { setCredentials, readCredentials } from '../src/server/credentials.js';
import { config } from '../src/server/config.js';

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

/** Read a line without printing it back. */
function askHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    let value = '';
    const onData = (chunk) => {
      const str = chunk.toString('utf8');
      for (const ch of str) {
        if (ch === '\n' || ch === '\r' || ch === '') {
          if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
          stdin.removeListener('data', onData);
          stdin.pause();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '') { // Ctrl-C
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === '' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const existing = readCredentials();
if (existing) {
  console.log(`A sign-in already exists for ${existing.email}. Continuing replaces it.\n`);
}

const email = process.argv[2] || await ask('Email: ');
const password = await askHidden('Password (not shown): ');
const again = await askHidden('Again: ');

if (password !== again) {
  console.error('\nThose did not match. Nothing was changed.');
  process.exit(1);
}

// Not a strength meter, just the two failures that actually matter here.
if (password.length < 8) {
  console.error('\nUse at least 8 characters. Nothing was changed.');
  process.exit(1);
}

try {
  const saved = setCredentials(email, password);
  console.log(`\nSaved. Sign in as ${saved.email}.`);
  console.log(`Stored (hashed) in ${config.dataDir}/credentials.json — keep that file, it is not in git.`);
  console.log('\nEveryone signed in elsewhere has been logged out, because the');
  console.log('credential is part of what signs a session.');
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}
