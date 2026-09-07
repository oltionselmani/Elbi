import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLang, sameLanguage, pickDefaultTrack, trackToShow } from '../public/js/langs.js';

/**
 * The bug these guard against: the subtitle *preference* is stored as ISO
 * 639-2/B ("alb", because that is what the search API speaks) while a
 * downloaded track comes back tagged ISO 639-1 ("sq"). Nothing compared the
 * two, so "my subtitles are Albanian" never matched an actual Albanian track.
 */

test('all three spellings of Albanian are the same language', () => {
  assert.equal(normalizeLang('alb'), 'sq', 'ISO 639-2/B, as the preference is stored');
  assert.equal(normalizeLang('sqi'), 'sq', 'ISO 639-2/T');
  assert.equal(normalizeLang('sq'), 'sq', 'ISO 639-1, as a downloaded track is tagged');
  assert.equal(normalizeLang('Albanian'), 'sq', 'as a file might be named');
  assert.equal(normalizeLang('shqip'), 'sq');

  assert.equal(sameLanguage('alb', 'sq'), true, 'this pairing is the whole bug');
  assert.equal(sameLanguage('sq', 'sqi'), true);
  assert.equal(sameLanguage('alb', 'eng'), false);
});

test('normalizeLang copes with the shapes real tracks carry', () => {
  assert.equal(normalizeLang('pt-BR'), 'pt');
  assert.equal(normalizeLang('en_US'), 'en');
  assert.equal(normalizeLang('  EN  '), 'en');
  assert.equal(normalizeLang('Türkçe'), 'tr');
  assert.equal(normalizeLang(''), '');
  assert.equal(normalizeLang(null), '');
  assert.equal(normalizeLang(undefined), '');
});

test('an unknown code still matches itself but never something else', () => {
  assert.equal(sameLanguage('xyz', 'xyz'), true);
  assert.equal(sameLanguage('xyz', 'abc'), false);
});

test('"und" is not a language and never matches', () => {
  assert.equal(sameLanguage('und', 'und'), false, 'two unknown tracks are not the same language');
  assert.equal(sameLanguage('und', 'sq'), false);
  assert.equal(sameLanguage('', 'sq'), false);
});

// --------------------------------------------------------------------------

const track = (label, srclang) => ({ label, srclang });

test('a track in your language is picked automatically, whatever it is tagged', () => {
  const tracks = [track('English', 'en'), track('Shqip', 'sq')];
  assert.equal(pickDefaultTrack(tracks, 'alb').label, 'Shqip');
  assert.equal(pickDefaultTrack(tracks, 'eng').label, 'English');
});

test('a lone track in another language is left off', () => {
  // Subtitles you did not ask for, in a language you may not read, are worse
  // than none — so this must not fall back to "whatever is available".
  assert.equal(pickDefaultTrack([track('German', 'ger')], 'alb'), null);
  assert.equal(pickDefaultTrack([], 'alb'), null);
  assert.equal(pickDefaultTrack([track('Shqip', 'sq')], ''), null, 'no preference, no automatic track');
});

test('a forced or SDH track loses to a plain one in the same language', () => {
  const tracks = [track('Albanian (forced)', 'sq'), track('Albanian', 'sq')];
  assert.equal(pickDefaultTrack(tracks, 'alb').label, 'Albanian');

  const sdh = [track('Albanian SDH', 'sq'), track('Shqip', 'alb')];
  assert.equal(pickDefaultTrack(sdh, 'alb').label, 'Shqip');

  // But a forced track is better than nothing when it is all there is.
  assert.equal(pickDefaultTrack([track('Albanian forced', 'sq')], 'alb').label, 'Albanian forced');
});

// --------------------------------------------------------------------------

test('what you chose for a title beats the language preference', () => {
  const tracks = [track('English', 'en'), track('Shqip', 'sq')];
  assert.equal(
    trackToShow(tracks, { remembered: 'English', preferredLang: 'alb' }).label, 'English',
    'having picked English for this film, it stays English',
  );
});

test('having switched subtitles off for a title keeps them off', () => {
  const tracks = [track('Shqip', 'sq')];
  assert.equal(trackToShow(tracks, { remembered: 'off', preferredLang: 'alb' }), null);
});

test('with no choice recorded, the language preference decides', () => {
  const tracks = [track('English', 'en'), track('Shqip', 'sq')];
  assert.equal(trackToShow(tracks, { remembered: null, preferredLang: 'alb' }).label, 'Shqip');
  // This is the case that used to yield nothing at all.
  assert.notEqual(trackToShow(tracks, { preferredLang: 'alb' }), null);
});

test('turning the automatic behaviour off restores pick-it-yourself', () => {
  const tracks = [track('Shqip', 'sq')];
  assert.equal(trackToShow(tracks, { preferredLang: 'alb', auto: false }), null);
  // …but a remembered choice is still honoured.
  assert.equal(trackToShow(tracks, { remembered: 'Shqip', preferredLang: 'alb', auto: false }).label, 'Shqip');
});

test('a remembered label that no longer exists falls back to its language', () => {
  // The file was renamed, or the track re-downloaded from another uploader.
  const tracks = [track('Albanian (opensubtitles)', 'sq')];
  assert.equal(
    trackToShow(tracks, { remembered: 'sq', preferredLang: 'eng' }).label,
    'Albanian (opensubtitles)',
  );
});

test('a title with no tracks at all shows nothing and does not throw', () => {
  assert.equal(trackToShow([], { remembered: 'Shqip', preferredLang: 'alb' }), null);
  assert.equal(trackToShow(null, { preferredLang: 'alb' }), null);
});

test('the language a track is tagged with may come from either field', () => {
  // textTracks exposes `language`; a <track> element carries `srclang`.
  assert.equal(pickDefaultTrack([{ label: 'Shqip', language: 'sq' }], 'alb').label, 'Shqip');
  assert.equal(pickDefaultTrack([{ label: 'Shqip', srclang: 'alb' }], 'sq').label, 'Shqip');
});
