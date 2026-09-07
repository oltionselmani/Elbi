/**
 * Subtitle language matching.
 *
 * The same language arrives under three different codes depending on where the
 * track came from, which is why "my language is Albanian" never used to line up
 * with an actual track:
 *
 *   - the preference is stored as ISO 639-2/B  ("alb"), because that is what
 *     the subtitle search API speaks
 *   - a downloaded track is tagged ISO 639-1   ("sq"), from the API's response
 *   - a sibling ".srt" is tagged whatever the file was named ("sq", "alb",
 *     "al", "shqip", "albanian"…)
 *
 * Everything is folded to one canonical code before being compared, so all
 * three forms of Albanian are the same language.
 *
 * Pure — no DOM — so the table can be tested directly.
 */

/** canonical 639-1 code -> every spelling seen in the wild. */
const ALIASES = {
  sq: ['sq', 'alb', 'sqi', 'al', 'shqip', 'shqipe', 'albanian'],
  en: ['en', 'eng', 'english'],
  it: ['it', 'ita', 'italian', 'italiano'],
  de: ['de', 'ger', 'deu', 'german', 'deutsch'],
  fr: ['fr', 'fre', 'fra', 'french', 'francais', 'français'],
  es: ['es', 'spa', 'spanish', 'espanol', 'español'],
  el: ['el', 'gre', 'ell', 'greek'],
  tr: ['tr', 'tur', 'turkish', 'turkce', 'türkçe'],
  sr: ['sr', 'srp', 'scc', 'serbian', 'srpski'],
  mk: ['mk', 'mac', 'mkd', 'macedonian'],
  hr: ['hr', 'hrv', 'scr', 'croatian', 'hrvatski'],
  bs: ['bs', 'bos', 'bosnian'],
  pt: ['pt', 'por', 'portuguese'],
  nl: ['nl', 'dut', 'nld', 'dutch'],
  ru: ['ru', 'rus', 'russian'],
  ar: ['ar', 'ara', 'arabic'],
};

const CANONICAL = new Map();
for (const [code, spellings] of Object.entries(ALIASES)) {
  for (const spelling of spellings) CANONICAL.set(spelling, code);
}

/**
 * Fold a language code or name to its canonical form.
 * An unknown code is returned lowercased and stripped rather than discarded —
 * two tracks both tagged "und" should still not be treated as a match, but two
 * tagged with the same unrecognised code should.
 */
export function normalizeLang(input) {
  const raw = String(input ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
  if (!raw) return '';
  // "pt-BR", "en_US", "sq (Albanian)" -> the leading code.
  const head = raw.split(/[-_ (,;/]/)[0].trim();
  if (CANONICAL.has(raw)) return CANONICAL.get(raw);
  if (CANONICAL.has(head)) return CANONICAL.get(head);
  return head;
}

/** True when two codes name the same language. "und" never matches anything. */
export function sameLanguage(a, b) {
  const left = normalizeLang(a);
  const right = normalizeLang(b);
  if (!left || !right) return false;
  if (left === 'und' || right === 'und') return false;
  return left === right;
}

/**
 * Which track should come on by itself.
 *
 * Only a track in the language you asked for is turned on automatically. A
 * lone track in some other language is left off on purpose: subtitles you did
 * not ask for, in a language you may not read, are worse than none.
 *
 * `tracks` is anything with `.language`/`.srclang` and `.label`.
 */
export function pickDefaultTrack(tracks, preferredLang) {
  const list = [...(tracks || [])];
  if (!list.length || !preferredLang) return null;

  const langOf = (t) => t.srclang || t.language || '';
  const matches = list.filter((t) => sameLanguage(langOf(t), preferredLang));
  if (!matches.length) return null;

  // Prefer a plain track over a forced/SDH one — those carry only signage or
  // sound effects and are not what "turn on subtitles" means.
  const plain = matches.find((t) => !/\b(forced|sdh|cc|hearing)\b/i.test(t.label || ''));
  return plain || matches[0];
}

/**
 * Choose the track to show when a title opens.
 *
 * A choice you made for this title always wins — including having switched
 * them off. Only when there is no such choice does the language preference
 * decide.
 *
 * Returns the track to show, or null for none.
 */
export function trackToShow(tracks, { remembered = null, preferredLang = '', auto = true } = {}) {
  const list = [...(tracks || [])];
  if (!list.length) return null;

  if (remembered === 'off') return null;
  if (remembered) {
    const byLabel = list.find((t) => t.label === remembered);
    if (byLabel) return byLabel;
    // Labels change — a file renamed, a track re-downloaded from another
    // uploader. Fall back to the language that label was in, if we can tell.
    const byLang = list.find((t) => sameLanguage(t.srclang || t.language, remembered));
    if (byLang) return byLang;
  }

  return auto ? pickDefaultTrack(list, preferredLang) : null;
}
