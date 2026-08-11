import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The help overlay is only worth having if it tells the truth, so these tests
 * pin the shortcut table to the handler that implements it. player.js is
 * browser-only (it touches document at import time), so the table is read out
 * of the source rather than imported.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'public/js/player.js'), 'utf8');

/** The SHORTCUTS table, evaluated on its own. */
function shortcutTable() {
  const start = source.indexOf('export const SHORTCUTS = [');
  assert.ok(start > -1, 'SHORTCUTS table not found in player.js');
  const open = source.indexOf('[', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '[') depth += 1;
    else if (source[i] === ']') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`return ${source.slice(open, end + 1)};`)();
}

/** Every `case '<key>':` label inside onKeydown. */
function handledKeys() {
  const start = source.indexOf('function onKeydown(');
  assert.ok(start > -1, 'onKeydown not found');
  const body = source.slice(start, source.indexOf('\nfunction ', start + 10));
  const keys = new Set();
  for (const m of body.matchAll(/case '((?:[^'\\]|\\.)*)':/g)) {
    keys.add(m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
  }
  // The digit keys are handled as a range in the default branch.
  if (/\/\^\[0-9\]\$\//.test(body)) for (let d = 0; d <= 9; d += 1) keys.add(String(d));
  return keys;
}

const SHORTCUTS = shortcutTable();
const HANDLED = handledKeys();

test('the shortcut table is well formed', () => {
  assert.ok(SHORTCUTS.length >= 5, 'expected several groups');
  for (const group of SHORTCUTS) {
    assert.ok(group.group, 'every group needs a heading');
    assert.ok(group.items.length, `${group.group} has no entries`);
    for (const item of group.items) {
      assert.ok(Array.isArray(item.handles) && item.handles.length, `${item.label}: no keys`);
      assert.ok(Array.isArray(item.show) && item.show.length, `${item.label}: nothing to draw`);
      assert.ok(item.label && item.label.length > 3, 'every entry needs a description');
    }
  }
});

test('every documented key is actually handled by the player', () => {
  for (const group of SHORTCUTS) {
    for (const item of group.items) {
      for (const key of item.handles) {
        assert.ok(
          HANDLED.has(key),
          `the help overlay promises "${key}" (${item.label}) but onKeydown never handles it`,
        );
      }
    }
  }
});

test('every handled key is documented', () => {
  const documented = new Set(SHORTCUTS.flatMap((g) => g.items.flatMap((i) => i.handles)));
  for (const key of HANDLED) {
    assert.ok(
      documented.has(key),
      `onKeydown handles "${key}" but it is missing from the shortcut list`,
    );
  }
});

test('no key is claimed by two different actions', () => {
  const seen = new Map();
  for (const group of SHORTCUTS) {
    for (const item of group.items) {
      for (const key of item.handles) {
        assert.ok(!seen.has(key), `"${key}" is listed for both "${seen.get(key)}" and "${item.label}"`);
        seen.set(key, item.label);
      }
    }
  }
});

test('the panel the overlay renders into exists in the markup', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  for (const el of ['keysPanel', 'keysBody', 'keysClose']) {
    assert.ok(html.includes(`id="${el}"`), `#${el} is missing from index.html`);
  }
  assert.ok(
    /id="keysPanel"[^>]*hidden/.test(html),
    'the shortcut panel must start hidden',
  );
});

test('the shortcut panel is styled', () => {
  const css = fs.readFileSync(path.join(root, 'public/css/elbi.css'), 'utf8');
  for (const rule of ['.keys {', '.keys__body', '.keys kbd']) {
    assert.ok(css.includes(rule), `${rule} is missing from elbi.css`);
  }
});
