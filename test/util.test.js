import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  parseFilename, parseEpisode, parseRange, srtToVtt, containedPath,
  qualityLabel, playability, formatBytes, slug, mimeFor,
} from '../src/server/util.js';

test('parseFilename pulls a clean name, year and resolution out of release names', () => {
  const a = parseFilename('The.Quiet.Harbour.2014.1080p.BluRay.x264-GROUP.mkv');
  assert.equal(a.name, 'The Quiet Harbour');
  assert.equal(a.year, 2014);
  assert.equal(a.height, 1080);
  assert.ok(a.tags.includes('BluRay'));
  assert.ok(a.tags.includes('x264'));

  const b = parseFilename('another_movie_2019_720p_WEBRip.mp4');
  assert.equal(b.name, 'Another Movie');
  assert.equal(b.year, 2019);
  assert.equal(b.height, 720);

  const c = parseFilename('Home Video.mp4');
  assert.equal(c.name, 'Home Video');
  assert.equal(c.year, null);
  assert.equal(c.height, null);

  assert.equal(parseFilename('Dune.Part.Two.2024.2160p.mkv').height, 2160);
  assert.equal(parseFilename('Some.Doc.4K.mkv').height, 2160);
});

test('parseEpisode understands both S01E02 and 1x02', () => {
  assert.deepEqual(parseEpisode('Show.Name.S01E02.1080p.mkv'), { season: 1, episode: 2 });
  assert.deepEqual(parseEpisode('Show Name 3x11.mp4'), { season: 3, episode: 11 });
  assert.deepEqual(parseEpisode('Show.Name.s02e07.mp4'), { season: 2, episode: 7 });
  assert.equal(parseEpisode('Just A Movie 2019.mp4'), null);
});

test('parseRange implements the byte-range cases the video element sends', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99, length: 100 });
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999, length: 500 });
  assert.deepEqual(parseRange('bytes=-200', 1000), { start: 800, end: 999, length: 200 });
  // An end past EOF is clamped, not rejected.
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999, length: 100 });
  assert.deepEqual(parseRange('bytes=1000-', 1000), { unsatisfiable: true });
  assert.deepEqual(parseRange('bytes=abc', 1000), { invalid: true });
  assert.deepEqual(parseRange('bytes=-', 1000), { invalid: true });
  assert.equal(parseRange(undefined, 1000), null);
});

test('containedPath refuses to escape the allowed roots', () => {
  const root = path.resolve('/srv/media');
  assert.equal(containedPath('/srv/media/a/b.mp4', [root]), path.resolve('/srv/media/a/b.mp4'));
  assert.equal(containedPath('/srv/media', [root]), root);
  assert.equal(containedPath('/srv/media/../secrets/id_rsa', [root]), null);
  assert.equal(containedPath('/etc/passwd', [root]), null);
  // A sibling directory that merely shares a prefix must not match.
  assert.equal(containedPath('/srv/media-private/x.mp4', [root]), null);
});

test('srtToVtt produces a valid WebVTT body', () => {
  const srt = '1\n00:00:01,000 --> 00:00:04,500\nHello there\n\n2\n00:00:05,000 --> 00:00:06,000\nSecond line\n';
  const vtt = srtToVtt(srt);
  assert.ok(vtt.startsWith('WEBVTT\n'));
  assert.ok(vtt.includes('00:00:01.000 --> 00:00:04.500'));
  assert.ok(vtt.includes('Hello there'));
  assert.ok(!/^\s*1\s*$/m.test(vtt), 'cue index lines should be dropped');
});

test('qualityLabel names the common resolutions', () => {
  assert.equal(qualityLabel(2160), '4K');
  assert.equal(qualityLabel(1440), '1440p');
  assert.equal(qualityLabel(1080), '1080p');
  assert.equal(qualityLabel(480), '480p');
  assert.equal(qualityLabel(null), 'Auto');
});

test('playability tells the truth about container support', () => {
  assert.equal(playability('a.mp4').level, 'direct');
  assert.equal(playability('a.webm').level, 'direct');
  assert.equal(playability('a.mkv').level, 'maybe');
  assert.equal(playability('a.mov').level, 'maybe');
  // Chrome dropped Theora in 2024, so .ogv is no longer a safe bet.
  assert.equal(playability('a.ogv').level, 'maybe');
  assert.equal(playability('a.avi').level, 'unsupported');
  assert.ok(playability('a.avi').note.includes('.mp4'));
});

test('assorted helpers', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GB');
  assert.equal(slug('The Quiet: Harbour!'), 'the-quiet-harbour');
  assert.equal(slug(''), 'untitled');
  assert.equal(mimeFor('x.mp4'), 'video/mp4');
  assert.equal(mimeFor('x.vtt'), 'text/vtt; charset=utf-8');
  assert.equal(mimeFor('x.unknown'), 'application/octet-stream');
});
