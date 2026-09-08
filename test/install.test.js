import test from 'node:test';
import assert from 'node:assert/strict';
import { detectOs, detectBrowser, installState } from '../public/js/install.js';

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/122.0 Mobile/15E148 Safari/604.1',
  ipadOs: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Mobile Safari/537.36',
  desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
  desktopFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
};

test('an iPhone is recognised whatever browser is in front', () => {
  assert.equal(detectOs({ userAgent: UA.iphoneSafari }), 'ios');
  assert.equal(detectOs({ userAgent: UA.iphoneChrome }), 'ios');
});

test('an iPad claiming to be a Mac is still an iPad', () => {
  // iPadOS 13+ sends a desktop Safari UA. A Mac with a touchscreen does not
  // exist, so the touch points are what give it away.
  assert.equal(detectOs({ userAgent: UA.ipadOs, platform: 'MacIntel', touchPoints: 5 }), 'ios');
  // …and a real Mac must not be mistaken for one.
  assert.equal(detectOs({ userAgent: UA.macSafari, platform: 'MacIntel', touchPoints: 0 }), 'desktop');
});

test('android and desktop are told apart', () => {
  assert.equal(detectOs({ userAgent: UA.androidChrome }), 'android');
  assert.equal(detectOs({ userAgent: UA.desktopChrome }), 'desktop');
});

test('browsers that all claim to be Safari are told apart', () => {
  assert.equal(detectBrowser({ userAgent: UA.iphoneSafari }), 'safari');
  assert.equal(detectBrowser({ userAgent: UA.iphoneChrome }), 'chrome', 'CriOS is Chrome');
  assert.equal(detectBrowser({ userAgent: UA.androidChrome }), 'chrome');
  assert.equal(detectBrowser({ userAgent: UA.desktopFirefox }), 'firefox');
  assert.equal(detectBrowser({ userAgent: UA.macSafari }), 'safari');
});

test('an already-installed app says nothing at all', () => {
  // Nagging someone to install what they have installed is worse than silence.
  for (const userAgent of Object.values(UA)) {
    const state = installState({ userAgent, standalone: true, promptAvailable: true });
    assert.equal(state.installed, true, userAgent.slice(0, 30));
    assert.equal(state.method, 'none');
    assert.deepEqual(state.steps, []);
  }
});

test('where the browser offers to install, that is used instead of instructions', () => {
  const state = installState({ userAgent: UA.androidChrome, promptAvailable: true });
  assert.equal(state.method, 'prompt');
  assert.ok(state.title);
});

/**
 * The case this module exists for: Safari never offers anything, so without
 * being told, an iPhone user simply never installs it.
 */
test('an iPhone in Safari gets the Share → Add to Home Screen steps', () => {
  const state = installState({ userAgent: UA.iphoneSafari });
  assert.equal(state.method, 'ios-share');
  assert.equal(state.steps.length, 3);
  assert.match(state.steps.join(' '), /Share/);
  assert.match(state.steps.join(' '), /Add to Home Screen/);
});

test('an iPhone in Chrome is told to switch to Safari', () => {
  // Only Safari can do it on iOS, so the Share instructions would be a dead end.
  const state = installState({ userAgent: UA.iphoneChrome });
  assert.equal(state.method, 'ios-wrong-browser');
  assert.match(state.title, /Safari/);
});

test('android without a prompt is pointed at its own menu', () => {
  const state = installState({ userAgent: UA.androidChrome, promptAvailable: false });
  assert.equal(state.method, 'android-menu');
  assert.match(state.steps.join(' '), /Install app|Add to Home screen/i);
});

test('desktop Chrome is told where its install button is', () => {
  const state = installState({ userAgent: UA.desktopChrome });
  assert.equal(state.method, 'desktop-menu');
  assert.match(state.steps.join(' '), /address bar|Install/i);
});

test('a browser that cannot install is not given instructions that lead nowhere', () => {
  const firefox = installState({ userAgent: UA.desktopFirefox });
  assert.equal(firefox.method, 'none');
  assert.deepEqual(firefox.steps, []);

  const safari = installState({ userAgent: UA.macSafari, platform: 'MacIntel', touchPoints: 0 });
  assert.equal(safari.method, 'none');
});

test('an empty or unknown environment says nothing rather than guessing', () => {
  const state = installState({});
  assert.equal(state.installed, false);
  assert.equal(state.method, 'none');
});

test('every state that speaks has both a title and at least one step', () => {
  const envs = [
    { userAgent: UA.iphoneSafari },
    { userAgent: UA.iphoneChrome },
    { userAgent: UA.androidChrome },
    { userAgent: UA.androidChrome, promptAvailable: true },
    { userAgent: UA.desktopChrome },
  ];
  for (const env of envs) {
    const state = installState(env);
    assert.ok(state.title.length > 5, `${state.method} has no title`);
    assert.ok(state.steps.length >= 1, `${state.method} has no steps`);
    assert.ok(state.steps.every((s) => s.length > 5), `${state.method} has an empty step`);
  }
});
