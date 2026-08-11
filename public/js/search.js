/**
 * Library search.
 *
 * Kept free of any browser API so it can be tested directly, and separate from
 * state.js so the ranking rules are readable in one place.
 *
 * Three things it does that a plain `includes()` did not:
 *
 *   - Folds accents, so "Shqiperia" finds "Shqipëria" and "Amelie" finds
 *     "Amélie". Typing the diacritic is optional, never required.
 *   - Searches the cast and director. Elbi fetches both and shows them on the
 *     detail sheet, so "DiCaprio" ought to find the film.
 *   - Ranks. A word in the title outranks the same word buried in a synopsis,
 *     and a near-miss spelling still surfaces rather than returning nothing.
 */

/** Lowercase, strip accents and punctuation: the form everything compares in. */
export function fold(input) {
  return String(input ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // combining marks: ë -> e, ç -> c
    .replace(/[‘’'`´]/g, '') // don't make apostrophes matter
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const names = (list) => (Array.isArray(list) ? list : [])
  .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
  .filter(Boolean)
  .join(' ');

/**
 * The searchable text of a title, by field.
 *
 * Weights are relative and only meaningful against each other: a title whose
 * *name* matches should always beat one that merely mentions the word in its
 * synopsis, however good the synopsis match is.
 */
function fieldsOf(title) {
  const episodes = (title.seasons || [])
    .flatMap((s) => (s.episodes || []).map((e) => e.name))
    .filter(Boolean)
    .join(' ');

  return [
    { text: fold(title.name), weight: 100 },
    { text: fold(title.year ? String(title.year) : ''), weight: 55 },
    { text: fold(names(title.cast)), weight: 45 },
    { text: fold(names(title.director)), weight: 45 },
    { text: fold((title.genres || []).join(' ')), weight: 30 },
    { text: fold(episodes), weight: 25 },
    { text: fold(title.tagline), weight: 18 },
    { text: fold(title.overview), weight: 12 },
    { text: fold((title.tags || []).join(' ')), weight: 10 },
  ];
}

/** Levenshtein distance, abandoned as soon as it exceeds `max`. */
export function editDistance(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

/** How much slack a typo gets: longer words tolerate more. */
function slackFor(term) {
  if (term.length >= 8) return 2;
  if (term.length >= 5) return 1;
  return 0;
}

/**
 * How well one search term matches one field, as a multiplier on that field's
 * weight. Exact beats prefix beats "somewhere inside" beats near-miss.
 */
function termScore(text, term) {
  if (!text || !term) return 0;
  if (text === term) return 3;
  if (text.startsWith(`${term} `)) return 2.4;

  const words = text.split(' ');
  if (words.includes(term)) return 2.2;
  if (words.some((w) => w.startsWith(term))) return 1.7;
  if (text.includes(term)) return 1.1;

  const slack = slackFor(term);
  if (slack > 0) {
    // A near-miss is worth surfacing, but never above a real match.
    const close = words.some((w) => Math.abs(w.length - term.length) <= slack
      && editDistance(w, term, slack) <= slack);
    if (close) return 0.5;
  }
  return 0;
}

/**
 * Score a title against every term. Terms are ANDed: a title that matches only
 * half of what you typed is not a result, it is noise.
 */
export function scoreTitle(title, terms) {
  const fields = fieldsOf(title);
  let total = 0;
  for (const term of terms) {
    let best = 0;
    for (const field of fields) {
      const hit = termScore(field.text, term) * field.weight;
      if (hit > best) best = hit;
    }
    if (best === 0) return 0;
    total += best;
  }
  // A shorter title matching the same words is the more precise answer.
  return total + Math.max(0, 20 - fold(title.name).length) / 100;
}

/** Titles matching `query`, best first. */
export function searchTitles(titles, query, { limit = 0 } = {}) {
  const terms = fold(query).split(' ').filter(Boolean);
  if (!terms.length) return [];

  const scored = [];
  for (const title of titles || []) {
    const score = scoreTitle(title, terms);
    if (score > 0) scored.push({ title, score });
  }
  scored.sort((a, b) => b.score - a.score
    || String(a.title.name).localeCompare(String(b.title.name)));

  const out = scored.map((s) => s.title);
  return limit > 0 ? out.slice(0, limit) : out;
}
