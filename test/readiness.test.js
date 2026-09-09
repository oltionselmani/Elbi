import test from 'node:test';
import assert from 'node:assert/strict';
import { readinessSteps, shouldShowReadiness, readinessProgress } from '../public/js/readiness.js';

const ids = (steps) => steps.map((s) => s.id);

test('a fresh phone with a library is offered install and download', () => {
  const steps = readinessSteps({
    installed: false, installMethod: 'ios-share', libraryCount: 12, downloadCount: 0,
  });
  assert.deepEqual(ids(steps), ['install', 'download']);
  assert.equal(steps.every((s) => !s.done), true);
  assert.equal(shouldShowReadiness(steps), true);
});

test('once everything is done the card disappears', () => {
  const steps = readinessSteps({
    installed: true, installMethod: 'ios-share',
    persistSupported: true, persisted: true,
    libraryCount: 12, downloadCount: 3,
  });
  assert.equal(steps.every((s) => s.done), true);
  assert.equal(shouldShowReadiness(steps), false, 'a list of ticks is clutter');
});

test('a step nobody can complete is never shown', () => {
  // Firefox on desktop cannot install a web app at all.
  const steps = readinessSteps({ installMethod: 'none', libraryCount: 5 });
  assert.deepEqual(ids(steps), ['download'], 'no install step where installing is impossible');
});

test('an already-installed app still shows the step, ticked', () => {
  // It reads as progress rather than vanishing, which is less confusing than
  // an item that was there a moment ago.
  const steps = readinessSteps({ installed: true, installMethod: 'none', libraryCount: 2 });
  assert.ok(ids(steps).includes('install'));
  assert.equal(steps.find((s) => s.id === 'install').done, true);
});

test('protecting downloads is only offered once something is saved', () => {
  const nothing = readinessSteps({ persistSupported: true, downloadCount: 0, libraryCount: 4 });
  assert.equal(ids(nothing).includes('protect'), false, 'nothing to protect yet');

  const saved = readinessSteps({ persistSupported: true, downloadCount: 1, libraryCount: 4 });
  assert.ok(ids(saved).includes('protect'));
});

test('protection is not offered where the browser has no such notion', () => {
  const steps = readinessSteps({ persistSupported: false, downloadCount: 2, libraryCount: 4 });
  assert.equal(ids(steps).includes('protect'), false);
});

test('downloading is not suggested with an empty library', () => {
  const steps = readinessSteps({ installMethod: 'ios-share', libraryCount: 0 });
  assert.deepEqual(ids(steps), ['install'], 'nothing to download yet');
});

test('an empty environment offers nothing and shows nothing', () => {
  const steps = readinessSteps({});
  assert.deepEqual(steps, []);
  assert.equal(shouldShowReadiness(steps), false);
  assert.equal(shouldShowReadiness(null), false);
});

test('every step has a label, a hint, and an action unless it is done', () => {
  const steps = readinessSteps({
    installMethod: 'ios-share', persistSupported: true, downloadCount: 1, libraryCount: 3,
  });
  assert.equal(steps.length, 3);
  for (const step of steps) {
    assert.ok(step.label.length > 5, `${step.id} has no label`);
    assert.ok(step.hint.length > 10, `${step.id} has no hint`);
    if (step.done) assert.equal(step.action, null);
    else assert.ok(step.action, `${step.id} is undone but has nothing to press`);
  }
});

test('progress counts what is done against what is offered', () => {
  const steps = readinessSteps({
    installed: true, installMethod: 'ios-share',
    persistSupported: true, persisted: false, downloadCount: 1, libraryCount: 3,
  });
  assert.deepEqual(readinessProgress(steps), { done: 2, total: 3 });
  assert.deepEqual(readinessProgress([]), { done: 0, total: 0 });
});

test('the realistic first-run order works step by step', () => {
  const env = { installMethod: 'ios-share', persistSupported: true, libraryCount: 8 };

  let steps = readinessSteps({ ...env });
  assert.deepEqual(ids(steps), ['install', 'download']);

  // They install it.
  steps = readinessSteps({ ...env, installed: true });
  assert.equal(steps.find((s) => s.id === 'install').done, true);
  assert.equal(shouldShowReadiness(steps), true, 'still one to go');

  // They save a film — which introduces the protect step.
  steps = readinessSteps({ ...env, installed: true, downloadCount: 1 });
  assert.deepEqual(ids(steps), ['install', 'protect', 'download']);
  assert.equal(shouldShowReadiness(steps), true);

  // They protect it. Done, and the card goes.
  steps = readinessSteps({ ...env, installed: true, downloadCount: 1, persisted: true });
  assert.equal(shouldShowReadiness(steps), false);
});
