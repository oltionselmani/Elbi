/**
 * Noticing that a connection can't keep up.
 *
 * Streaming from a home machine to someone on the other side of the continent
 * is limited by that machine's *upload* speed, not by distance. When the link
 * can't sustain the bitrate the picture stops every few seconds, and a spinner
 * on its own tells you nothing you can act on.
 *
 * This counts stalls in a rolling window so the player can offer the two things
 * that actually help — a smaller file, or downloading it first — rather than
 * spinning silently.
 *
 * Pure: no DOM, no timers of its own, and the clock is passed in, so the
 * behaviour can be tested without waiting a minute per case.
 */

const DEFAULTS = {
  // Three stalls inside a minute is a struggling link. One or two is a seek,
  // a keyframe, or a moment of congestion — not worth interrupting anyone for.
  windowMs: 60_000,
  threshold: 3,
  // Having declined once, don't ask again for a good while.
  quietMs: 10 * 60_000,
};

export function createStallWatcher(options = {}) {
  const { windowMs, threshold, quietMs } = { ...DEFAULTS, ...options };
  let stalls = [];
  let mutedUntil = 0;
  let suggested = false;

  return {
    /** Call on every `waiting` event. Returns true when it is worth speaking up. */
    record(now) {
      stalls.push(now);
      stalls = stalls.filter((t) => now - t < windowMs);
      if (now < mutedUntil || suggested) return false;
      if (stalls.length < threshold) return false;
      suggested = true;
      return true;
    },

    /** The viewer said no. Stay quiet, then allow one more offer later. */
    dismiss(now) {
      mutedUntil = now + quietMs;
      suggested = false;
      stalls = [];
    },

    /** A new film, or a quality change: forget everything. */
    reset() {
      stalls = [];
      suggested = false;
      mutedUntil = 0;
    },

    /** How many stalls are inside the current window. */
    count(now) {
      return stalls.filter((t) => now - t < windowMs).length;
    },
  };
}

/**
 * The next source down from the one playing, or null when there isn't one.
 *
 * Sources are ranked highest-first by the player, so "smaller" is simply the
 * next entry along. A source with no known height sorts as unknown and is not
 * offered, since it might well be larger.
 */
export function nextSmallerSource(sources, currentId) {
  const list = Array.isArray(sources) ? sources : [];
  const index = list.findIndex((s) => s.id === currentId);
  if (index < 0) return null;

  const current = list[index];
  for (let i = index + 1; i < list.length; i += 1) {
    const candidate = list[i];
    if (!candidate) continue;
    // Only offer it if we can actually tell it is smaller.
    if (Number(candidate.height) && Number(current.height)
      && Number(candidate.height) < Number(current.height)) {
      return candidate;
    }
  }
  return null;
}
