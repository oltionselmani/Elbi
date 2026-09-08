/**
 * "How much more will fit?" — in films, not bytes.
 *
 * "6.2 GB free" is a number; "room for about four more films" is a decision.
 * Getting from one to the other needs a believable size for one film, and the
 * obvious way to guess — average whatever is already saved — falls apart on the
 * first run, when nothing is saved, and again when the only saved item happens
 * to be a two-minute clip. That produced "room for roughly 42406 more films".
 *
 * So the estimate comes from the library's own files, which is the right
 * question anyway ("films like the ones I actually have"), and is clamped to a
 * range a real film can plausibly occupy.
 *
 * Pure: no DOM, no storage API.
 */

/** A 480p film is rarely under this; a 4K remux is rarely over it. */
const MIN_FILM_BYTES = 250 * 1024 * 1024;      // 250 MB
const MAX_FILM_BYTES = 25 * 1024 * 1024 * 1024; // 25 GB
const FALLBACK_FILM_BYTES = 1.5 * 1024 * 1024 * 1024; // a middling 1080p film

/**
 * A believable size for one film, from the sizes actually present.
 *
 * The median rather than the mean: one 4K remux among twenty ordinary films
 * should not drag the estimate up, and one short clip should not drag it down.
 */
export function typicalFilmSize(sizes) {
  const usable = (Array.isArray(sizes) ? sizes : [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  if (!usable.length) return FALLBACK_FILM_BYTES;

  const mid = Math.floor(usable.length / 2);
  const median = usable.length % 2
    ? usable[mid]
    : (usable[mid - 1] + usable[mid]) / 2;

  return Math.min(MAX_FILM_BYTES, Math.max(MIN_FILM_BYTES, median));
}

/**
 * Roughly how many more films fit in `freeBytes`.
 * Never negative, and never a precise-looking number it cannot justify.
 */
export function roomForFilms(freeBytes, typicalBytes) {
  const free = Number(freeBytes);
  const each = Number(typicalBytes);
  if (!Number.isFinite(free) || free <= 0) return 0;
  if (!Number.isFinite(each) || each <= 0) return 0;
  return Math.max(0, Math.floor(free / each));
}

/**
 * The sentence to show. Deliberately vague past a point: claiming "room for
 * 87 more films" from a storage quota is false precision, and browsers only
 * report the quota approximately in the first place.
 */
export function describeRoom(count) {
  if (count <= 0) return 'not enough room for another film';
  if (count === 1) return 'room for about one more film';
  if (count > 40) return 'room for plenty more';
  return `room for about ${count} more films`;
}
