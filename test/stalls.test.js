import test from 'node:test';
import assert from 'node:assert/strict';
import { createStallWatcher, nextSmallerSource } from '../public/js/stalls.js';

const T = 1_000_000; // a fixed "now" to build times from

test('one or two stalls are not worth interrupting anyone for', () => {
  const w = createStallWatcher();
  assert.equal(w.record(T), false, 'a single stall is a seek or a hiccup');
  assert.equal(w.record(T + 1000), false);
});

test('three stalls inside a minute is a struggling link', () => {
  const w = createStallWatcher();
  w.record(T);
  w.record(T + 5_000);
  assert.equal(w.record(T + 10_000), true);
});

test('stalls spread out over time never trigger it', () => {
  const w = createStallWatcher();
  // One stall every two minutes: annoying, but not a link that cannot cope.
  assert.equal(w.record(T), false);
  assert.equal(w.record(T + 120_000), false);
  assert.equal(w.record(T + 240_000), false);
  assert.equal(w.record(T + 360_000), false);
});

test('it only speaks up once, not on every stall after the third', () => {
  const w = createStallWatcher();
  w.record(T);
  w.record(T + 1000);
  assert.equal(w.record(T + 2000), true);
  assert.equal(w.record(T + 3000), false, 'the offer is already on screen');
  assert.equal(w.record(T + 4000), false);
});

test('dismissing it buys a long silence, then one more chance', () => {
  const w = createStallWatcher();
  w.record(T); w.record(T + 1000);
  assert.equal(w.record(T + 2000), true);

  w.dismiss(T + 3000);
  // Still struggling, but the viewer said no.
  assert.equal(w.record(T + 4000), false);
  assert.equal(w.record(T + 5000), false);
  assert.equal(w.record(T + 6000), false);

  // Ten minutes later it may ask again.
  const later = T + 3000 + 10 * 60_000 + 1;
  assert.equal(w.record(later), false, 'the window starts empty again');
  assert.equal(w.record(later + 1000), false);
  assert.equal(w.record(later + 2000), true);
});

test('reset forgets everything, for a new film or a quality change', () => {
  const w = createStallWatcher();
  w.record(T); w.record(T + 1000);
  w.reset();
  assert.equal(w.record(T + 2000), false, 'the earlier stalls belong to the old source');
  assert.equal(w.count(T + 2000), 1);
});

test('count only reports stalls inside the window', () => {
  const w = createStallWatcher();
  w.record(T);
  w.record(T + 30_000);
  assert.equal(w.count(T + 30_000), 2);
  assert.equal(w.count(T + 70_000), 1, 'the first has aged out');
  assert.equal(w.count(T + 200_000), 0);
});

test('the thresholds can be tightened for testing or taste', () => {
  const w = createStallWatcher({ threshold: 2, windowMs: 5000 });
  w.record(T);
  assert.equal(w.record(T + 1000), true);
});

// --------------------------------------------------------------------------

const SOURCES = [
  { id: 'a', height: 1080 },
  { id: 'b', height: 720 },
  { id: 'c', height: 480 },
];

test('the next source down is offered', () => {
  assert.equal(nextSmallerSource(SOURCES, 'a').id, 'b');
  assert.equal(nextSmallerSource(SOURCES, 'b').id, 'c');
});

test('there is nothing to offer below the smallest', () => {
  assert.equal(nextSmallerSource(SOURCES, 'c'), null);
});

test('a source of unknown size is never offered as smaller', () => {
  // It might well be bigger — offering it would make the stalling worse.
  const mixed = [{ id: 'a', height: 1080 }, { id: 'b', height: null }, { id: 'c', height: 480 }];
  assert.equal(nextSmallerSource(mixed, 'a').id, 'c', 'skip the unknown, take the one we can vouch for');

  const allUnknown = [{ id: 'a', height: null }, { id: 'b', height: null }];
  assert.equal(nextSmallerSource(allUnknown, 'a'), null);
});

test('a source that is not actually smaller is skipped', () => {
  const odd = [{ id: 'a', height: 720 }, { id: 'b', height: 1080 }, { id: 'c', height: 360 }];
  assert.equal(nextSmallerSource(odd, 'a').id, 'c', 'never offer a bigger file as the fix');
});

test('an unknown or missing source list is handled', () => {
  assert.equal(nextSmallerSource(SOURCES, 'nope'), null);
  assert.equal(nextSmallerSource([], 'a'), null);
  assert.equal(nextSmallerSource(null, 'a'), null);
  assert.equal(nextSmallerSource(undefined, undefined), null);
});
