import test from 'node:test';
import assert from 'node:assert/strict';
import { srtToVtt } from '../src/server/util.js';
import { normalizeIntro } from '../src/server/store.js';
import {
  decodeText, stripPromoCues, resolveLanguage, assertSubtitleUrl, LANGUAGES,
} from '../src/server/subsearch.js';

// ---------------------------------------------------------------------------
// SubRip -> WebVTT

test('srtToVtt keeps cues in separate blocks', () => {
  const srt = '1\r\n00:00:01,000 --> 00:00:02,000\r\nOne\r\n\r\n'
    + '2\r\n00:00:03,000 --> 00:00:04,000\r\nTwo\r\n\r\n'
    + '3\r\n00:00:05,000 --> 00:00:06,500\r\nThree\r\nsecond line\r\n';
  const vtt = srtToVtt(srt);

  const cueBlocks = vtt.split(/\n{2,}/).filter((b) => b.includes('-->'));
  assert.equal(cueBlocks.length, 3, 'each cue must stay its own block');
  // Two cues welded into one block is silent corruption: the parser reads the
  // second timing line as caption text and the cue never appears.
  for (const block of cueBlocks) {
    assert.equal((block.match(/-->/g) || []).length, 1, `merged block: ${JSON.stringify(block)}`);
  }
  assert.match(vtt, /^WEBVTT\n\n/);
  assert.match(vtt, /00:00:03\.000 --> 00:00:04\.000/, 'commas become dots');
  assert.match(vtt, /Three\nsecond line/, 'multi-line cue text survives');
});

test('srtToVtt tolerates files that already use LF and lack indices', () => {
  const vtt = srtToVtt('00:00:01,000 --> 00:00:02,000\nOnly cue\n');
  assert.equal(vtt.split(/\n{2,}/).filter((b) => b.includes('-->')).length, 1);
  // A number that is genuinely a caption must not be mistaken for an index.
  const numeric = srtToVtt('1\n00:00:01,000 --> 00:00:02,000\n1999\n');
  assert.match(numeric, /\n1999/);
});

// ---------------------------------------------------------------------------
// charset handling

test('subtitle text decodes from the codepage the service declares', () => {
  // "kërk" in CP1252: ë is 0xEB.
  const cp1252 = Buffer.from([0x6b, 0xeb, 0x72, 0x6b]);
  assert.equal(decodeText(cp1252, 'CP1252'), 'kërk');

  // Valid UTF-8 must win over a wrong declaration, or accents become mojibake.
  const utf8 = Buffer.from('Përkthimi: çështje', 'utf8');
  assert.equal(decodeText(utf8, 'CP1252'), 'Përkthimi: çështje');

  // A UTF-8 BOM is stripped rather than shown as a stray character.
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]), ''), 'Përkthimi: çështje');

  // An encoding label nobody recognises must not throw.
  assert.equal(typeof decodeText(cp1252, 'nonsense-99'), 'string');
});

// ---------------------------------------------------------------------------
// uploader advertising

test('promo cues are stripped from the edges but dialogue is kept', () => {
  const middle = Array.from({ length: 6 }, (_, i) => `00:${String(10 + i).padStart(2, '0')}:00.000 --> 00:${String(10 + i).padStart(2, '0')}:04.000\nDialogue ${i}`);
  const vtt = [
    'WEBVTT',
    '00:00:06.000 --> 00:00:12.000\nShtyp play. Titrat shfaqen.\ntryray.app',
    '00:02:08.000 --> 00:02:09.000\nPërkthimi: UniVerseHub',
    '00:30:00.000 --> 00:30:04.000\nShkoni te www.example.com dhe shikoni vetë.',
    ...middle,
    '02:20:44.000 --> 02:20:46.000\nAdvertise your product here',
  ].join('\n\n');

  const cleaned = stripPromoCues(vtt);
  assert.ok(!cleaned.includes('tryray.app'), 'leading advert should go');
  assert.ok(!cleaned.includes('Advertise your product'), 'trailing advert should go');
  assert.ok(cleaned.includes('Përkthimi: UniVerseHub'), 'a translator credit is not an advert');
  // Mid-film dialogue is never eligible, even when it names a website.
  assert.ok(cleaned.includes('www.example.com'), 'mid-film dialogue must survive');
  assert.match(cleaned, /^WEBVTT\n\n/);

  // Blocks stay well formed after filtering.
  for (const block of cleaned.split(/\n{2,}/).filter((b) => b.includes('-->'))) {
    assert.equal((block.match(/-->/g) || []).length, 1);
  }

  // On a short track the tail rule is held back, so a closing line of real
  // dialogue near a website mention is never mistaken for an advert.
  const shortTrack = stripPromoCues([
    'WEBVTT',
    '00:00:02.000 --> 00:00:05.000\nDownloaded from opensubtitles.org',
    '00:10:00.000 --> 00:10:03.000\nFind me at example.com.',
  ].join('\n\n'));
  assert.ok(!shortTrack.includes('opensubtitles.org'), 'the first cue is always eligible');
  assert.ok(shortTrack.includes('Find me at example.com.'), 'short tracks keep their last cue');
});

// ---------------------------------------------------------------------------
// language codes

test('language codes resolve from either ISO form', () => {
  assert.deepEqual(resolveLanguage('sq'), { id: 'alb', iso1: 'sq', name: 'Albanian' });
  assert.deepEqual(resolveLanguage('alb'), { id: 'alb', iso1: 'sq', name: 'Albanian' });
  assert.equal(resolveLanguage('ALB').id, 'alb');
  // Albanian is the default the whole feature is built around.
  assert.equal(resolveLanguage(undefined).id, 'alb');
  // The API knows more codes than this list, so plausible ones pass through.
  assert.equal(resolveLanguage('nld').id, 'nld');
  assert.throws(() => resolveLanguage('not a code'), /not a language code/);

  // Every entry must carry both codes, since <track srclang> wants 639-1.
  for (const lang of LANGUAGES) {
    assert.match(lang.id, /^[a-z]{3}$/, lang.name);
    assert.match(lang.iso1, /^[a-z]{2}$/, lang.name);
  }
});

// ---------------------------------------------------------------------------
// download URL containment

test('subtitle downloads are confined to the subtitle service', () => {
  assert.ok(assertSubtitleUrl('https://dl.opensubtitles.org/en/download/src-api/filead/1.gz'));
  assert.ok(assertSubtitleUrl('https://rest.opensubtitles.org/search/query-x'));

  // The URL reaches the server via the browser, so it is checked, not trusted.
  assert.throws(() => assertSubtitleUrl('https://evil.example.com/x.gz'), /Refusing to download/);
  assert.throws(() => assertSubtitleUrl('file:///etc/passwd'), /valid subtitle URL|Only http/);
  assert.throws(() => assertSubtitleUrl('not a url'), /valid subtitle URL/);
  // A lookalike host must not slip through a naive "endsWith" check.
  assert.throws(() => assertSubtitleUrl('https://notopensubtitles.org/x.gz'), /Refusing to download/);
});

// ---------------------------------------------------------------------------
// skip-intro markers

test('intro markers reject ranges that would render a useless button', () => {
  assert.deepEqual(normalizeIntro({ start: 12, end: 92 }), { start: 12, end: 92 });
  // Sub-second and backwards ranges are refused rather than stored.
  assert.equal(normalizeIntro({ start: 5, end: 5 }), null);
  assert.equal(normalizeIntro({ start: 90, end: 12 }), null);
  assert.equal(normalizeIntro({ start: 0, end: 0.5 }), null);

  assert.equal(normalizeIntro(null), null);
  assert.equal(normalizeIntro({ start: 'x', end: 10 }), null);
  assert.equal(normalizeIntro('nonsense'), null);

  // A negative start would make the button seek before the file begins.
  assert.deepEqual(normalizeIntro({ start: -30, end: 40 }), { start: 0, end: 40 });
  // Times are rounded to centiseconds so the stored value stays readable.
  assert.deepEqual(normalizeIntro({ start: 1.23456, end: 40.98765 }), { start: 1.23, end: 40.99 });
});
