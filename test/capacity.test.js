import test from 'node:test';
import assert from 'node:assert/strict';
import { typicalFilmSize, roomForFilms, describeRoom } from '../public/js/capacity.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

test('an empty library falls back to a plausible film size', () => {
  const size = typicalFilmSize([]);
  assert.ok(size >= 250 * MB && size <= 25 * GB, `${size} is not a film-sized number`);
  assert.equal(typicalFilmSize(null), size);
  assert.equal(typicalFilmSize(undefined), size);
});

test('the median is used, so one huge remux does not skew it', () => {
  const ordinary = [1.4 * GB, 1.5 * GB, 1.6 * GB];
  const withRemux = [...ordinary, 60 * GB];
  const before = typicalFilmSize(ordinary);
  const after = typicalFilmSize(withRemux);
  assert.ok(Math.abs(after - before) < 0.5 * GB,
    `one 60 GB file moved the estimate from ${(before / GB).toFixed(1)}GB to ${(after / GB).toFixed(1)}GB`);
});

/**
 * The bug this exists for: averaging a couple of twenty-kilobyte test clips
 * implied room for 42,406 more films.
 */
test('a stray tiny file cannot imply room for tens of thousands of films', () => {
  const typical = typicalFilmSize([20 * 1024, 25 * 1024]);
  assert.ok(typical >= 250 * MB, `a 20 KB clip must not be treated as a film (${typical} bytes)`);
  assert.ok(roomForFilms(833 * MB, typical) < 10, 'a phone-sized quota is not thousands of films');
});

test('an absurdly large file is clamped too', () => {
  assert.ok(typicalFilmSize([500 * GB]) <= 25 * GB);
});

test('zero, negative and non-numeric sizes are ignored', () => {
  const clean = typicalFilmSize([1.5 * GB, 0, -5, null, undefined, NaN, 'big']);
  assert.ok(clean >= 250 * MB && clean <= 25 * GB);
  // All rubbish means no information, so the fallback applies.
  assert.equal(typicalFilmSize([0, -1, NaN]), typicalFilmSize([]));
});

test('roomForFilms divides, floors, and never goes negative', () => {
  assert.equal(roomForFilms(10 * GB, 2 * GB), 5);
  assert.equal(roomForFilms(5 * GB, 2 * GB), 2, 'a partial film does not count');
  assert.equal(roomForFilms(0, 2 * GB), 0);
  assert.equal(roomForFilms(-5 * GB, 2 * GB), 0);
  assert.equal(roomForFilms(10 * GB, 0), 0, 'never divide by zero');
  assert.equal(roomForFilms(NaN, 2 * GB), 0);
  assert.equal(roomForFilms(10 * GB, NaN), 0);
});

test('the wording matches the number, and stops claiming false precision', () => {
  assert.match(describeRoom(0), /not enough room/);
  assert.match(describeRoom(1), /one more film/);
  assert.match(describeRoom(4), /about 4 more films/);
  // A storage quota is approximate, so "87 more films" would be made-up precision.
  assert.match(describeRoom(87), /plenty more/);
  assert.match(describeRoom(42406), /plenty more/);
  assert.ok(!/\d/.test(describeRoom(42406)), 'no invented number for a huge quota');
});

test('a realistic phone: 32 GB free, ordinary 1080p films', () => {
  const typical = typicalFilmSize([1.4 * GB, 2.1 * GB, 1.7 * GB]);
  const room = roomForFilms(32 * GB, typical);
  assert.ok(room >= 15 && room <= 25, `expected a sane count, got ${room}`);
  assert.match(describeRoom(room), /about \d+ more films/);
});
