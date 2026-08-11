import test from 'node:test';
import assert from 'node:assert/strict';
import { searchTitles, scoreTitle, fold, editDistance } from '../public/js/search.js';

const LIBRARY = [
  {
    name: 'Inception',
    year: 2010,
    overview: 'A thief who steals corporate secrets through dream-sharing technology.',
    genres: ['Action', 'Science Fiction'],
    cast: [{ name: 'Leonardo DiCaprio', role: 'Cobb' }, { name: 'Elliot Page', role: 'Ariadne' }],
    director: [{ name: 'Christopher Nolan' }],
    tags: ['BluRay'],
    seasons: [],
  },
  {
    name: 'Shqipëria e Re',
    year: 1957,
    overview: 'A documentary about postwar reconstruction.',
    genres: ['Documentary'],
    cast: [],
    director: ['Endri Çela'],
    seasons: [],
  },
  {
    name: 'Amélie',
    year: 2001,
    overview: 'A shy waitress decides to change the lives of those around her.',
    genres: ['Comedy', 'Romance'],
    cast: [{ name: 'Audrey Tautou', role: 'Amélie' }],
    director: [{ name: 'Jean-Pierre Jeunet' }],
    seasons: [],
  },
  {
    name: 'Night Shift',
    year: 2019,
    overview: 'Paramedics work the small hours in a city that never sleeps.',
    genres: ['Drama'],
    cast: [],
    director: [],
    seasons: [{ episodes: [{ name: 'The Long Dark' }, { name: 'Dreamers' }] }],
  },
  {
    name: 'The Dream Merchants',
    year: 1980,
    overview: 'Two rivals build a studio from nothing.',
    genres: ['Drama'],
    cast: [{ name: 'Nora Beqiri' }],
    director: [],
    seasons: [],
  },
];

const namesOf = (results) => results.map((t) => t.name);

test('fold strips accents and case so diacritics are optional to type', () => {
  assert.equal(fold('Shqipëria e Re'), 'shqiperia e re');
  assert.equal(fold('Amélie'), 'amelie');
  assert.equal(fold('Endri Çela'), 'endri cela');
  assert.equal(fold("L'Année dernière"), 'lannee derniere');
  assert.equal(fold('  Multiple   Spaces  '), 'multiple spaces');
  assert.equal(fold(null), '');
});

test('a title is found without typing its diacritics', () => {
  assert.deepEqual(namesOf(searchTitles(LIBRARY, 'shqiperia')), ['Shqipëria e Re']);
  assert.deepEqual(namesOf(searchTitles(LIBRARY, 'amelie')), ['Amélie']);
  // …and typing them still works.
  assert.deepEqual(namesOf(searchTitles(LIBRARY, 'Shqipëria')), ['Shqipëria e Re']);
});

test('cast and director are searchable', () => {
  assert.deepEqual(namesOf(searchTitles(LIBRARY, 'dicaprio')), ['Inception']);
  assert.deepEqual(namesOf(searchTitles(LIBRARY, 'nolan')), ['Inception']);
  assert.deepEqual(namesOf(searchTitles(LIBRARY, 'tautou')), ['Amélie']);
  // A director stored as a bare string works the same as {name}.
  assert.deepEqual(namesOf(searchTitles(LIBRARY, 'cela')), ['Shqipëria e Re']);
});

test('a name match outranks the same word in a synopsis', () => {
  const results = namesOf(searchTitles(LIBRARY, 'dream'));
  assert.equal(results[0], 'The Dream Merchants', `ranked: ${results.join(', ')}`);
  // Inception only mentions dreams in its overview, Night Shift in an episode.
  assert.ok(results.includes('Inception'));
  assert.ok(results.length >= 2);
});

test('every term has to match — half a query is not a result', () => {
  assert.deepEqual(namesOf(searchTitles(LIBRARY, 'inception nolan')), ['Inception']);
  assert.deepEqual(searchTitles(LIBRARY, 'inception spielberg'), []);
});

test('terms may match different fields of the same title', () => {
  assert.deepEqual(namesOf(searchTitles(LIBRARY, 'dicaprio 2010')), ['Inception']);
  assert.deepEqual(namesOf(searchTitles(LIBRARY, 'nolan action')), ['Inception']);
});

test('a small typo still finds the film', () => {
  assert.deepEqual(namesOf(searchTitles(LIBRARY, 'incepton')), ['Inception']);
  assert.deepEqual(namesOf(searchTitles(LIBRARY, 'dicapri')), ['Inception']);
  assert.deepEqual(namesOf(searchTitles(LIBRARY, 'shqiperja')), ['Shqipëria e Re']);
});

test('a near-miss never outranks an exact match', () => {
  const library = [
    { name: 'Dune', year: 2021, seasons: [] },
    { name: 'June', year: 1999, seasons: [] },
    { name: 'Dunes of Mars', year: 2015, seasons: [] },
  ];
  assert.equal(namesOf(searchTitles(library, 'dune'))[0], 'Dune');
});

test('short words are not fuzzy-matched, or everything matches everything', () => {
  // "cat" must not drag in "cast", "car", "bat"…
  const library = [
    { name: 'Cat', seasons: [] },
    { name: 'Bat', seasons: [] },
    { name: 'Car', seasons: [] },
  ];
  assert.deepEqual(namesOf(searchTitles(library, 'cat')), ['Cat']);
});

test('episode names are searchable', () => {
  assert.deepEqual(namesOf(searchTitles(LIBRARY, 'long dark')), ['Night Shift']);
});

test('genres and years are searchable', () => {
  assert.deepEqual(namesOf(searchTitles(LIBRARY, 'documentary')), ['Shqipëria e Re']);
  assert.deepEqual(namesOf(searchTitles(LIBRARY, '2001')), ['Amélie']);
  assert.deepEqual(namesOf(searchTitles(LIBRARY, 'romance')), ['Amélie']);
});

test('an empty or punctuation-only query returns nothing, not everything', () => {
  for (const q of ['', '   ', null, undefined, '!!!', '---']) {
    assert.deepEqual(searchTitles(LIBRARY, q), [], `"${q}" should match nothing`);
  }
});

test('search copes with titles missing every optional field', () => {
  const sparse = [{ name: 'Bare' }];
  assert.deepEqual(namesOf(searchTitles(sparse, 'bare')), ['Bare']);
  assert.deepEqual(searchTitles(sparse, 'nothing'), []);
  assert.deepEqual(searchTitles(null, 'bare'), []);
});

test('limit caps the result list', () => {
  assert.equal(searchTitles(LIBRARY, 'drama', { limit: 1 }).length, 1);
  assert.ok(searchTitles(LIBRARY, 'drama').length >= 2);
});

test('scoreTitle returns zero for a title that does not match', () => {
  assert.equal(scoreTitle(LIBRARY[0], ['spielberg']), 0);
  assert.ok(scoreTitle(LIBRARY[0], ['inception']) > 0);
});

test('editDistance is correct and gives up past its ceiling', () => {
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('same', 'same'), 0);
  assert.equal(editDistance('a', 'b'), 1);
  assert.ok(editDistance('kitten', 'sitting', 1) > 1, 'must bail out rather than compute the true distance');
});

test('results are stable when scores tie', () => {
  const library = [
    { name: 'Zebra Nights', genres: ['Drama'], seasons: [] },
    { name: 'Alpha Nights', genres: ['Drama'], seasons: [] },
  ];
  assert.deepEqual(namesOf(searchTitles(library, 'drama')), ['Alpha Nights', 'Zebra Nights']);
});
