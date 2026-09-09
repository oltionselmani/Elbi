/**
 * The two or three things worth doing once on a new device.
 *
 * Both matter and neither is discoverable. Installing gives an icon, full
 * screen, and — on iOS — a more generous storage allowance, which is what keeps
 * downloads from being evicted. Downloading a film is the only thing that lets
 * it play when the machine holding the library is switched off. Telling someone
 * that in a message they will lose is worse than the app keeping a short list
 * and ticking items off as they happen.
 *
 * It disappears the moment everything is done, and never appears at all when
 * there is nothing to act on.
 *
 * Pure: every input is passed in, so each combination is testable.
 */

export function readinessSteps({
  installed = false,
  installMethod = 'none',
  persistSupported = false,
  persisted = false,
  downloadCount = 0,
  libraryCount = 0,
} = {}) {
  const steps = [];

  // Only offered where the browser can actually do it; 'none' means it cannot,
  // and a step nobody can complete is worse than no step.
  if (installMethod !== 'none' || installed) {
    steps.push({
      id: 'install',
      label: 'Add Elbi to your home screen',
      hint: 'Opens full screen like an app, and keeps downloads safer.',
      done: installed,
      action: installed ? null : 'install',
    });
  }

  // Nothing to protect until something is saved, and pointless where the
  // browser does not support it.
  if (persistSupported && downloadCount > 0) {
    steps.push({
      id: 'protect',
      label: 'Protect your downloads',
      hint: 'Stops the browser clearing saved films when space runs low.',
      done: persisted,
      action: persisted ? null : 'protect',
    });
  }

  // Downloading is meaningless with an empty library.
  if (libraryCount > 0) {
    steps.push({
      id: 'download',
      label: 'Save a film to watch offline',
      hint: 'It then plays with the computer switched off.',
      done: downloadCount > 0,
      action: downloadCount > 0 ? null : 'download',
    });
  }

  return steps;
}

/** Should the card be shown at all? */
export function shouldShowReadiness(steps) {
  const list = Array.isArray(steps) ? steps : [];
  if (!list.length) return false;
  // Everything done: say nothing. A checklist of ticks is clutter.
  return list.some((s) => !s.done);
}

/** "1 of 3 done" — for the heading. */
export function readinessProgress(steps) {
  const list = Array.isArray(steps) ? steps : [];
  return { done: list.filter((s) => s.done).length, total: list.length };
}
