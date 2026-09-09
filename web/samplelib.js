/**
 * The library the hosted build ships with.
 *
 * Five titles — four films and a series — over nine short clips. Everything the
 * app can show is represented at least once: two qualities of one film so the
 * quality menu and the slow-connection offer have somewhere to go, episodes
 * with marked intros for Skip Intro and Up Next, and subtitle tracks whose
 * language is spelled four different ways (sq, alb, sqi, Albanian) because that
 * is exactly what a real folder of downloaded subtitles looks like — and all
 * four have to switch themselves on.
 *
 * Media keys are resolved against the blobs the build inlines; see web/build.mjs.
 */

const SQ = 'Shqip';
const EN = 'English';

function vtt(cues) {
  return `WEBVTT\n\n${cues.map(([from, to, text]) => `${from} --> ${to}\n${text}`).join('\n\n')}\n`;
}

// --------------------------------------------------------------------------
// subtitles

const NEON_SQ = vtt([
  ['00:00:07.000', '00:00:10.500', 'Porti nuk fle kurrë.'],
  ['00:00:11.000', '00:00:14.500', 'Vetëm ndryshon se kush punon.'],
  ['00:00:15.000', '00:00:18.500', '— A e solle atë që kërkova?\n— E solla.'],
  ['00:00:19.000', '00:00:22.500', 'Atëherë mos u kthe më këtu.'],
  ['00:00:23.000', '00:00:27.000', 'Drita e fundit fiket në orën katër.'],
  ['00:00:27.500', '00:00:32.000', 'Pas asaj ore, askush nuk sheh asgjë.'],
]);

const NEON_EN = vtt([
  ['00:00:07.000', '00:00:10.500', 'The harbour never sleeps.'],
  ['00:00:11.000', '00:00:14.500', 'Only the shift changes.'],
  ['00:00:15.000', '00:00:18.500', '— Did you bring it?\n— I brought it.'],
  ['00:00:19.000', '00:00:22.500', "Then don't come back here."],
  ['00:00:23.000', '00:00:27.000', 'The last light goes out at four.'],
  ['00:00:27.500', '00:00:32.000', 'After that, nobody sees anything.'],
]);

const SALT_SQ = vtt([
  ['00:00:07.000', '00:00:11.000', 'Rruga e kripës zgjat njëmbëdhjetë ditë.'],
  ['00:00:11.500', '00:00:15.500', 'Babai im e bëri njëzet e katër herë.'],
  ['00:00:16.000', '00:00:20.000', 'Unë e bëj për herë të parë.'],
  ['00:00:20.500', '00:00:24.500', 'Uji mbaron para se të mbarojë shkretëtira.'],
  ['00:00:25.000', '00:00:29.000', 'Prandaj nisemi natën.'],
]);

const MOTHS_SQ = vtt([
  ['00:00:07.000', '00:00:11.000', 'I ruaja letrat, të gjitha.'],
  ['00:00:11.500', '00:00:15.000', 'Edhe ato që nuk i dërgove kurrë.'],
  ['00:00:15.500', '00:00:19.500', '— Si e dije?\n— E dija.'],
  ['00:00:20.000', '00:00:24.000', 'Fluturat e letrës vijnë te drita.'],
  ['00:00:24.500', '00:00:29.000', 'Edhe kur drita nuk i pret.'],
]);

const MOTHS_EN = vtt([
  ['00:00:07.000', '00:00:11.000', 'I kept the letters. All of them.'],
  ['00:00:11.500', '00:00:15.000', 'Even the ones you never sent.'],
  ['00:00:15.500', '00:00:19.500', '— How did you know?\n— I knew.'],
  ['00:00:20.000', '00:00:24.000', 'Paper moths come to the light.'],
  ['00:00:24.500', '00:00:29.000', 'Even when the light is not waiting.'],
]);

const PEAKS_SQ = vtt([
  ['00:00:07.000', '00:00:11.500', 'Në dimër, fshati mbetet me shtatë banorë.'],
  ['00:00:12.000', '00:00:16.000', 'Bora e mbyll rrugën deri në prill.'],
  ['00:00:16.500', '00:00:21.000', '— A ju vjen keq?\n— Për çfarë?'],
  ['00:00:21.500', '00:00:25.500', 'Malet nuk kërkojnë shoqëri.'],
]);

const SHIFT_SQ = (a, b, c, d) => vtt([
  ['00:00:07.000', '00:00:11.000', a],
  ['00:00:11.500', '00:00:15.500', b],
  ['00:00:16.000', '00:00:20.500', c],
  ['00:00:21.000', '00:00:26.000', d],
]);

// --------------------------------------------------------------------------
// titles

function file(id, media, { label, w, h, seconds, size }) {
  return {
    id,
    kind: 'file',
    label,
    width: w,
    height: h,
    fps: 8,
    durationSec: seconds,
    size,
    mime: 'video/webm',
    codec: 'vp8',
    streamType: 'progressive',
    playability: { level: 'direct', note: '' },
    filename: media,
    remoteHost: null,
    addedAt: Date.UTC(2024, 4, 2),
    media,
  };
}

function sub(id, { label, lang, vtt: text, origin = 'sample' }) {
  return { id, label, lang, kind: 'vtt', origin, vtt: text };
}

/** Fresh copies each time, so nothing the app does leaks back into the seed. */
export function sampleTitles(sizes = {}) {
  const size = (name) => sizes[name] ?? null;

  return [
    {
      id: 't_neon_harbour',
      type: 'movie',
      name: 'Neon Harbour',
      year: 2021,
      overview: 'A dock worker agrees to look the other way for one night, and spends the rest of the film discovering how long one night can be.',
      tagline: 'Every port keeps its own hours.',
      genres: ['Thriller', 'Crime'],
      poster: 'neon-harbour-poster.jpg',
      backdrop: 'neon-harbour-backdrop.jpg',
      rating: '15',
      runtimeMin: 108,
      cast: [{ name: 'Lira Dema', character: 'Vera' }, { name: 'Arben Koci', character: 'The foreman' }],
      director: ['Mira Vata'],
      voteAverage: 7.4,
      intro: { start: 0, end: 7 },
      addedAt: Date.UTC(2024, 4, 2),
      origin: 'sample',
      sources: [
        file('s_neon_1080', 'neon-harbour-1080p.webm', { label: '1080p', w: 1920, h: 1080, seconds: 34, size: size('neon-harbour-1080p.webm') }),
        file('s_neon_480', 'neon-harbour-480p.webm', { label: '480p', w: 854, h: 480, seconds: 34, size: size('neon-harbour-480p.webm') }),
      ],
      subtitles: [
        sub('sub_neon_sq', { label: SQ, lang: 'sq', vtt: NEON_SQ }),
        sub('sub_neon_en', { label: EN, lang: 'en', vtt: NEON_EN }),
      ],
      seasons: [],
    },

    {
      id: 't_salt_road',
      type: 'movie',
      name: 'The Salt Road',
      year: 2019,
      overview: 'Eleven days across the flats with a father’s route, a son’s map, and not quite enough water for either.',
      tagline: 'Some inheritances you have to walk.',
      genres: ['Drama', 'Adventure'],
      poster: 'salt-road-poster.jpg',
      backdrop: 'salt-road-backdrop.jpg',
      rating: '12',
      runtimeMin: 96,
      cast: [{ name: 'Endrit Zela', character: 'Ilir' }],
      director: ['Teuta Beqiri'],
      voteAverage: 7.9,
      intro: null,
      addedAt: Date.UTC(2024, 6, 18),
      origin: 'sample',
      sources: [
        file('s_salt_720', 'salt-road-720p.webm', { label: '720p', w: 1280, h: 720, seconds: 30, size: size('salt-road-720p.webm') }),
      ],
      // Spelled the ISO 639-2/B way, which is what most subtitle sites hand out.
      subtitles: [sub('sub_salt_sq', { label: SQ, lang: 'alb', vtt: SALT_SQ })],
      seasons: [],
    },

    {
      id: 't_paper_moths',
      type: 'movie',
      name: 'Paper Moths',
      year: 2023,
      overview: 'Two people who wrote to each other for a decade meet for an afternoon, and find that the letters were the easy part.',
      tagline: 'Ten years of paper, one afternoon of weather.',
      genres: ['Drama', 'Romance'],
      poster: 'paper-moths-poster.jpg',
      backdrop: 'paper-moths-backdrop.jpg',
      rating: 'PG',
      runtimeMin: 91,
      cast: [{ name: 'Nora Ismaili', character: 'Ana' }, { name: 'Petrit Hoxha', character: 'Marko' }],
      director: ['Mira Vata'],
      voteAverage: 8.1,
      intro: null,
      addedAt: Date.UTC(2025, 0, 9),
      origin: 'sample',
      sources: [
        file('s_moths_1080', 'paper-moths-1080p.webm', { label: '1080p', w: 1920, h: 1080, seconds: 30, size: size('paper-moths-1080p.webm') }),
      ],
      // 639-2/T this time. Same language, third spelling.
      subtitles: [
        sub('sub_moths_sq', { label: SQ, lang: 'sqi', vtt: MOTHS_SQ }),
        sub('sub_moths_en', { label: EN, lang: 'eng', vtt: MOTHS_EN }),
      ],
      seasons: [],
    },

    {
      id: 't_quiet_peaks',
      type: 'movie',
      name: 'The Quiet Peaks',
      year: 2018,
      overview: 'A winter with the seven people who stay when the road closes.',
      tagline: '',
      genres: ['Documentary'],
      poster: 'quiet-peaks-poster.jpg',
      backdrop: 'quiet-peaks-backdrop.jpg',
      rating: 'U',
      runtimeMin: 74,
      cast: [],
      director: ['Agron Leka'],
      voteAverage: 7.2,
      intro: null,
      addedAt: Date.UTC(2023, 10, 30),
      origin: 'sample',
      sources: [
        file('s_peaks_720', 'quiet-peaks-720p.webm', { label: '720p', w: 1280, h: 720, seconds: 26, size: size('quiet-peaks-720p.webm') }),
      ],
      // The plain-English spelling, which plenty of files use.
      subtitles: [sub('sub_peaks_sq', { label: SQ, lang: 'albanian', vtt: PEAKS_SQ })],
      seasons: [],
    },

    {
      id: 't_night_shift',
      type: 'series',
      name: 'Night Shift',
      year: 2022,
      overview: 'The hours between midnight and six, in a city that files them under nothing happened.',
      tagline: 'Nothing happens after midnight. Officially.',
      genres: ['Crime', 'Drama'],
      poster: 'night-shift-poster.jpg',
      backdrop: 'night-shift-backdrop.jpg',
      rating: '15',
      runtimeMin: 48,
      cast: [{ name: 'Blerta Rama', character: 'Sgt. Kola' }, { name: 'Driton Ahmeti', character: 'Bekim' }],
      director: ['Teuta Beqiri'],
      voteAverage: 8.4,
      intro: null,
      addedAt: Date.UTC(2024, 8, 21),
      origin: 'sample',
      sources: [],
      subtitles: [],
      seasons: [
        {
          number: 1,
          name: 'Season 1',
          episodes: [
            {
              id: 'e_ns_s01e01',
              number: 1,
              name: 'Handover',
              overview: 'A shift begins with a report nobody wants to sign.',
              still: 'night-shift-backdrop.jpg',
              runtimeMin: 48,
              intro: { start: 0, end: 7 },
              sources: [file('s_ns_101', 'night-shift-s01e01-720p.webm', { label: '720p', w: 1280, h: 720, seconds: 30, size: size('night-shift-s01e01-720p.webm') })],
              subtitles: [sub('sub_ns_101', {
                label: SQ,
                lang: 'sq',
                vtt: SHIFT_SQ(
                  'Ndërrimi fillon në mesnatë.',
                  'Raporti i mbrëmjes është bosh.',
                  '— Kush e nënshkroi?\n— Askush.',
                  'Atëherë e nënshkruajmë ne.',
                ),
              })],
            },
            {
              id: 'e_ns_s01e02',
              number: 2,
              name: 'The Long Way Round',
              overview: 'Two calls, one address, and a route that takes an hour too long.',
              still: 'night-shift-backdrop.jpg',
              runtimeMin: 46,
              intro: { start: 0, end: 7 },
              sources: [file('s_ns_102', 'night-shift-s01e02-720p.webm', { label: '720p', w: 1280, h: 720, seconds: 28, size: size('night-shift-s01e02-720p.webm') })],
              subtitles: [sub('sub_ns_102', {
                label: SQ,
                lang: 'sq',
                vtt: SHIFT_SQ(
                  'E njëjta adresë, dy herë brenda natës.',
                  'Rruga e shkurtër ishte e mbyllur.',
                  '— Sa zgjati?\n— Një orë më shumë se duhej.',
                  'Njëqind minuta që askush nuk i shënoi.',
                ),
              })],
            },
            {
              id: 'e_ns_s01e03',
              number: 3,
              name: 'Six O’Clock',
              overview: 'The shift ends. The paperwork does not.',
              still: 'night-shift-backdrop.jpg',
              runtimeMin: 51,
              intro: { start: 0, end: 7 },
              sources: [file('s_ns_103', 'night-shift-s01e03-720p.webm', { label: '720p', w: 1280, h: 720, seconds: 28, size: size('night-shift-s01e03-720p.webm') })],
              subtitles: [sub('sub_ns_103', {
                label: SQ,
                lang: 'sq',
                vtt: SHIFT_SQ(
                  'Në gjashtë, qyteti zgjohet.',
                  'Ne shkruajmë atë që pamë.',
                  '— Dhe atë që nuk pamë?\n— Atë e harrojmë.',
                  'Deri natën tjetër.',
                ),
              })],
            },
          ],
        },
        {
          number: 2,
          name: 'Season 2',
          episodes: [
            {
              id: 'e_ns_s02e01',
              number: 1,
              name: 'New Rota',
              overview: 'A new sergeant, the same six hours.',
              still: 'night-shift-backdrop.jpg',
              runtimeMin: 49,
              intro: { start: 0, end: 7 },
              sources: [file('s_ns_201', 'night-shift-s02e01-720p.webm', { label: '720p', w: 1280, h: 720, seconds: 28, size: size('night-shift-s02e01-720p.webm') })],
              subtitles: [sub('sub_ns_201', {
                label: SQ,
                lang: 'sq',
                vtt: SHIFT_SQ(
                  'Ndërrim i ri, orar i njëjtë.',
                  'Emrat ndryshojnë. Nata jo.',
                  '— A e njihni rrugën?\n— Shumë mirë.',
                  'Kjo është problemi.',
                ),
              })],
            },
          ],
        },
      ],
    },
  ];
}

/**
 * A household that has already been watching for a while.
 *
 * Without this the home page opens empty and half the app — Continue Watching,
 * who has already seen a title, the finished ticks — has nothing to show. The
 * positions are deliberately mid-clip so resuming does something visible.
 */
export function sampleProgress() {
  const day = 24 * 60 * 60 * 1000;
  const ago = (days) => Date.now() - days * day;
  return {
    p_olti: {
      't_neon_harbour:-': { position: 14, duration: 34, sourceId: 's_neon_1080', finished: false, updatedAt: ago(1) },
      't_night_shift:e_ns_s01e01': { position: 30, duration: 30, sourceId: 's_ns_101', finished: true, updatedAt: ago(4) },
      't_night_shift:e_ns_s01e02': { position: 11, duration: 28, sourceId: 's_ns_102', finished: false, updatedAt: ago(2) },
    },
    p_elbi: {
      't_paper_moths:-': { position: 30, duration: 30, sourceId: 's_moths_1080', finished: true, updatedAt: ago(6) },
      't_neon_harbour:-': { position: 34, duration: 34, sourceId: 's_neon_480', finished: true, updatedAt: ago(9) },
      't_salt_road:-': { position: 12, duration: 30, sourceId: 's_salt_720', finished: false, updatedAt: ago(3) },
    },
    p_oltion: {
      't_night_shift:e_ns_s01e01': { position: 30, duration: 30, sourceId: 's_ns_101', finished: true, updatedAt: ago(12) },
      't_night_shift:e_ns_s01e02': { position: 28, duration: 28, sourceId: 's_ns_102', finished: true, updatedAt: ago(11) },
      't_night_shift:e_ns_s01e03': { position: 28, duration: 28, sourceId: 's_ns_103', finished: true, updatedAt: ago(10) },
      't_night_shift:e_ns_s02e01': { position: 28, duration: 28, sourceId: 's_ns_201', finished: true, updatedAt: ago(8) },
    },
    p_elbasana: {
      't_quiet_peaks:-': { position: 9, duration: 26, sourceId: 's_peaks_720', finished: false, updatedAt: ago(5) },
    },
  };
}

export function sampleMyList() {
  return { p_olti: ['t_salt_road'], p_elbi: ['t_night_shift'] };
}

export const SAMPLE_IDS = [
  't_neon_harbour', 't_salt_road', 't_paper_moths', 't_quiet_peaks', 't_night_shift',
];
