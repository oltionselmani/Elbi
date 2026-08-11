import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SORTS, STATUSES, TYPES, applyView, genreCounts,
  defaultView, normalizeView, isDefaultView,
} from '../public/js/filters.js';

const LIBRARY = [
  { id: 'a', name: 'Zodiac', type: 'movie', year: 2007, runtimeMin: 157, addedAt: 300, genres: ['Thriller', 'Drama'], sourceCount: 1 },
  { id: 'b', name: 'Amélie', type: 'movie', year: 2001, runtimeMin: 122, addedAt: 500, genres: ['Comedy', 'Romance'], sourceCount: 1 },
  { id: 'c', name: 'Night Shift', type: 'series', year: 2019, runtimeMin: 45, addedAt: 400, genres: ['Drama'], sourceCount: 4 },
  { id: 'd', name: 'Metropolis', type: 'movie', year: 1927, runtimeMin: 153, addedAt: 100, genres: ['Science Fiction', 'Drama'], sourceCount: 1 },
  { id: 'e', name: 'Undated Reel', type: 'movie', year: null, runtimeMin: null, addedAt: null, genres: [], sourceCount: 1 },
];

const namesOf = (list) => list.map((t) => t.name);
const statusOf = (t) => ({ a: 'finished', b: 'watching', c: 'unwatched', d: 'unwatched', e: 'watching' }[t.id]);

test('the default view shows everything, A–Z', () => {
  const out = applyView(LIBRARY, defaultView(), { statusOf });
  assert.equal(out.length, LIBRARY.length);
  assert.deepEqual(namesOf(out), ['Amélie', 'Metropolis', 'Night Shift', 'Undated Reel', 'Zodiac']);
});

test('every sort order is total and stable', () => {
  for (const [key, { compare, label }] of Object.entries(SORTS)) {
    assert.ok(label, `${key} needs a label`);
    const out = applyView(LIBRARY, { sort: key }, { statusOf });
    assert.equal(out.length, LIBRARY.length, `${key} dropped titles`);
    // Sorting the result again must not move anything.
    assert.deepEqual(namesOf([...out].sort(compare)), namesOf(out), `${key} is not stable`);
  }
});

test('newest and oldest are genuine opposites, with undated titles last in both', () => {
  const newest = namesOf(applyView(LIBRARY, { sort: 'year' }, { statusOf }));
  const oldest = namesOf(applyView(LIBRARY, { sort: 'oldest' }, { statusOf }));

  assert.deepEqual(newest, ['Night Shift', 'Zodiac', 'Amélie', 'Metropolis', 'Undated Reel']);
  assert.deepEqual(oldest, ['Metropolis', 'Amélie', 'Zodiac', 'Night Shift', 'Undated Reel']);
  assert.equal(newest.at(-1), 'Undated Reel', 'a title with no year must not lead the newest list');
  assert.equal(oldest.at(-1), 'Undated Reel', 'nor the oldest list');
});

test('recently added puts the newest import first and undated ones last', () => {
  assert.deepEqual(
    namesOf(applyView(LIBRARY, { sort: 'added' }, { statusOf })),
    ['Amélie', 'Night Shift', 'Zodiac', 'Metropolis', 'Undated Reel'],
  );
});

test('longest sorts by runtime', () => {
  assert.deepEqual(
    namesOf(applyView(LIBRARY, { sort: 'runtime' }, { statusOf })).slice(0, 2),
    ['Zodiac', 'Metropolis'],
  );
});

test('filtering by type separates films from series', () => {
  assert.deepEqual(namesOf(applyView(LIBRARY, { type: 'series' }, { statusOf })), ['Night Shift']);
  assert.equal(applyView(LIBRARY, { type: 'movie' }, { statusOf }).length, 4);
  assert.equal(applyView(LIBRARY, { type: 'all' }, { statusOf }).length, 5);
});

test('filtering by genre is case-insensitive and exact', () => {
  assert.deepEqual(namesOf(applyView(LIBRARY, { genre: 'Drama' }, { statusOf })), ['Metropolis', 'Night Shift', 'Zodiac']);
  assert.deepEqual(namesOf(applyView(LIBRARY, { genre: 'drama' }, { statusOf })), ['Metropolis', 'Night Shift', 'Zodiac']);
  // "Drama" must not match "Dramatic" or vice versa.
  assert.deepEqual(applyView([{ name: 'X', genres: ['Dramatic'] }], { genre: 'Drama' }, { statusOf }), []);
});

test('filtering by watch status uses the caller’s per-profile answer', () => {
  assert.deepEqual(namesOf(applyView(LIBRARY, { status: 'finished' }, { statusOf })), ['Zodiac']);
  assert.deepEqual(namesOf(applyView(LIBRARY, { status: 'watching' }, { statusOf })), ['Amélie', 'Undated Reel']);
  assert.deepEqual(namesOf(applyView(LIBRARY, { status: 'unwatched' }, { statusOf })), ['Metropolis', 'Night Shift']);
});

test('filters combine', () => {
  const out = applyView(LIBRARY, { type: 'movie', genre: 'Drama', sort: 'year' }, { statusOf });
  assert.deepEqual(namesOf(out), ['Zodiac', 'Metropolis'], 'films, tagged Drama, newest first');
});

test('a status filter with no statusOf given is ignored rather than emptying the grid', () => {
  assert.equal(applyView(LIBRARY, { status: 'finished' }, {}).length, LIBRARY.length);
});

test('applyView never mutates the list it is given', () => {
  const before = namesOf(LIBRARY);
  applyView(LIBRARY, { sort: 'year' }, { statusOf });
  applyView(LIBRARY, { sort: 'runtime' }, { statusOf });
  assert.deepEqual(namesOf(LIBRARY), before, 'the caller’s array was reordered in place');
});

test('normalizeView rejects anything it does not recognise', () => {
  assert.deepEqual(normalizeView({ sort: 'nonsense', status: 'bogus', type: 'weird' }), defaultView());
  assert.deepEqual(normalizeView(null), defaultView());
  assert.deepEqual(normalizeView('a string'), defaultView());
  assert.deepEqual(normalizeView({ sort: 'year', genre: 'Drama' }),
    { sort: 'year', genre: 'Drama', status: 'all', type: 'all' });
  // A hostile genre is kept as a string and simply matches nothing.
  assert.equal(typeof normalizeView({ genre: { evil: true } }).genre, 'string');
});

test('isDefaultView knows when the clear button is pointless', () => {
  assert.equal(isDefaultView(defaultView()), true);
  assert.equal(isDefaultView({}), true);
  assert.equal(isDefaultView({ sort: 'year' }), false);
  assert.equal(isDefaultView({ genre: 'Drama' }), false);
  assert.equal(isDefaultView({ status: 'finished' }), false);
  assert.equal(isDefaultView({ type: 'series' }), false);
});

test('genreCounts offers only genres that exist, most common first', () => {
  assert.deepEqual(genreCounts(LIBRARY), [
    { name: 'Drama', count: 3 },
    { name: 'Comedy', count: 1 },
    { name: 'Romance', count: 1 },
    { name: 'Science Fiction', count: 1 },
    { name: 'Thriller', count: 1 },
  ]);
  assert.deepEqual(genreCounts([]), []);
  assert.deepEqual(genreCounts(null), []);
  // Blank and whitespace-only genres are not offered as filters.
  assert.deepEqual(genreCounts([{ genres: ['', '   ', 'Real'] }]), [{ name: 'Real', count: 1 }]);
});

test('every status and type has a human label', () => {
  for (const [key, label] of Object.entries(STATUSES)) assert.ok(label && label !== key, key);
  for (const [key, label] of Object.entries(TYPES)) assert.ok(label, key);
});

test('an empty library filters to nothing without throwing', () => {
  assert.deepEqual(applyView([], { genre: 'Drama', status: 'finished' }, { statusOf }), []);
  assert.deepEqual(applyView(null, defaultView(), { statusOf }), []);
});

test('titles with no genres survive an unfiltered view', () => {
  const out = applyView(LIBRARY, { sort: 'name' }, { statusOf });
  assert.ok(namesOf(out).includes('Undated Reel'));
});
