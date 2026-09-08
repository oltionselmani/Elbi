/**
 * Getting Elbi onto a home screen as an app.
 *
 * Android and desktop Chrome fire `beforeinstallprompt` and will show a real
 * install button. **Safari never offers anything** — on an iPhone the only way
 * in is Share → Add to Home Screen, and there is no way for a page to trigger
 * it. So the app has to say so, in the right words for the browser in front of
 * it, or people simply never install it.
 *
 * On iOS this matters beyond the icon: an installed web app gets a more
 * generous storage allowance and is far less likely to have its downloads
 * evicted than a Safari tab.
 *
 * Pure: everything about the environment is passed in, so each combination can
 * be tested without needing that device.
 */

/** Which operating system, from the bits of environment that reveal it. */
export function detectOs({ userAgent = '', platform = '', touchPoints = 0 } = {}) {
  const ua = String(userAgent);
  if (/iPhone|iPod/i.test(ua)) return 'ios';
  // An iPad on iPadOS 13+ claims to be a Mac. A Mac with a touchscreen does
  // not exist, so touch points give it away.
  if (/iPad/i.test(ua) || (/Mac/i.test(platform || ua) && Number(touchPoints) > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

/** Which browser, only to the degree it changes the instructions. */
export function detectBrowser({ userAgent = '' } = {}) {
  const ua = String(userAgent);
  // Order matters: Edge and Chrome both claim Safari, Chrome claims Safari.
  if (/EdgiOS|Edg\//i.test(ua)) return 'edge';
  if (/CriOS|Chrome\//i.test(ua)) return 'chrome';
  if (/FxiOS|Firefox\//i.test(ua)) return 'firefox';
  if (/Safari\//i.test(ua)) return 'safari';
  return 'other';
}

/**
 * What to tell this person, if anything.
 *
 * `installed` short-circuits everything: an app that nags you to install it
 * when it is already installed is worse than one that says nothing.
 */
export function installState(env = {}) {
  const { standalone = false, promptAvailable = false } = env;
  const os = detectOs(env);
  const browser = detectBrowser(env);

  if (standalone) return { installed: true, os, browser, method: 'none', title: '', steps: [] };

  // Where the browser will do it for us, let it — one tap beats five steps.
  if (promptAvailable) {
    return {
      installed: false, os, browser, method: 'prompt',
      title: 'Add Elbi to your home screen',
      steps: ['It opens full screen, like an app, and keeps your downloads safer.'],
    };
  }

  if (os === 'ios') {
    // Only Safari can add to the home screen on iOS; other browsers there are
    // Safari underneath but do not expose it reliably.
    if (browser !== 'safari') {
      return {
        installed: false, os, browser, method: 'ios-wrong-browser',
        title: 'Open Elbi in Safari to install it',
        steps: [
          'On iPhone and iPad, only Safari can add an app to the home screen.',
          'Copy this address, open Safari, and paste it there.',
        ],
      };
    }
    return {
      installed: false, os, browser, method: 'ios-share',
      title: 'Add Elbi to your home screen',
      steps: [
        'Tap the Share button at the bottom of Safari.',
        'Scroll down and tap “Add to Home Screen”.',
        'Tap “Add”. Elbi then opens full screen, like any other app.',
      ],
    };
  }

  if (os === 'android') {
    return {
      installed: false, os, browser, method: 'android-menu',
      title: 'Add Elbi to your home screen',
      steps: ['Open the ⋮ menu in your browser.', 'Tap “Install app” or “Add to Home screen”.'],
    };
  }

  // Desktop without a prompt: Firefox and Safari cannot install, so saying
  // nothing is better than giving instructions that lead nowhere.
  if (browser === 'chrome' || browser === 'edge') {
    return {
      installed: false, os, browser, method: 'desktop-menu',
      title: 'Install Elbi as an app',
      steps: ['Click the install icon in the address bar, or the ⋮ menu → “Install Elbi”.'],
    };
  }
  return { installed: false, os, browser, method: 'none', title: '', steps: [] };
}

/** Read the current environment from the browser. */
export function readEnv(promptAvailable = false) {
  const nav = typeof navigator === 'undefined' ? {} : navigator;
  const standalone = (typeof window !== 'undefined'
    && (window.matchMedia?.('(display-mode: standalone)')?.matches
      // iOS Safari predates display-mode and uses its own flag.
      || nav.standalone === true)) || false;
  return {
    userAgent: nav.userAgent || '',
    platform: nav.platform || '',
    touchPoints: nav.maxTouchPoints || 0,
    standalone,
    promptAvailable,
  };
}
