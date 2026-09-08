import { $, el, clear, formatTime, formatRuntime, formatBytes, qualityLabel, toast, hashColor, badgeFor, badgeFontSize, nameFontSize } from './util.js';
import { api, streamUrl } from './api.js';
import {
  SORTS, STATUSES, TYPES, applyView, genreCounts, defaultView, normalizeView, isDefaultView,
} from './filters.js';
import { typicalFilmSize, roomForFilms, describeRoom } from './capacity.js';
import {
  state, playablesOf, progressFor, resumePointFor, continueWatching, allGenres, searchTitles,
  titleById, hasPlayableSource, upsertTitle, removeTitleLocal, refresh,
} from './state.js';
import { play } from './player.js';
import { isSourceOffline, downloadSource, removeDownload, activeJobs, onJobsChanged, cancelDownload } from './offline.js';

const view = () => $('#view');

// ---------------------------------------------------------------------------
// cards & rows

export function titleCard(title, { poster = false, item = null, showProgress = true } = {}) {
  const art = poster ? (title.poster || title.backdrop) : (title.backdrop || title.poster);
  const target = item || null;
  const progress = showProgress ? progressFor(title.id, target?.episodeId) : null;
  const pct = progress && progress.duration
    ? Math.min(100, (progress.position / progress.duration) * 100)
    : 0;

  const badges = [];
  const best = bestSource(title);
  if (best?.height) badges.push(el('span.pill', { text: qualityLabel(best.height) }));
  if (title.type === 'series') badges.push(el('span.pill', { text: `${title.episodeCount} ep` }));
  if (title.origin === 'archive.org') badges.push(el('span.pill', { text: 'Free' }));
  if (anyOffline(title)) badges.push(el('span.pill.pill--ok', { text: '↓' }));
  if (!hasPlayableSource(title)) badges.push(el('span.pill.pill--warn', { text: 'No file' }));

  const artNode = artBox(art, title.name);
  artNode.append(el('div.card__badges', {}, badges));
  const seen = seenByOthers(title.id);
  if (seen.length) artNode.append(seenStrip(seen));
  artNode.append(el('div.card__play', {}, [
    elSvg('<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7L8 5Z"/></svg>'),
  ]));

  const subBits = [];
  if (title.year) subBits.push(String(title.year));
  if (title.type === 'series') subBits.push(`${title.seasons.length} season${title.seasons.length === 1 ? '' : 's'}`);
  else if (title.runtimeMin) subBits.push(formatRuntime(title.runtimeMin));
  if (target?.episodeId) subBits.push(`S${target.season}·E${target.episode}`);

  const card = el('button.card', {
    type: 'button',
    title: title.name,
    onclick: () => openDetail(title.id, target?.episodeId),
  }, [
    artNode,
    pct > 0 ? el('div.card__bar', {}, [el('i', { style: { width: `${pct}%` } })]) : null,
    el('div.card__body', {}, [
      el('div.card__name', { text: title.name }),
      el('div.card__sub', {}, subBits.map((b) => el('span', { text: b }))),
    ]),
  ]);
  if (poster) card.classList.add('card--poster');
  return card;
}

/**
 * Everyone *except* you who has started or finished this title.
 *
 * Yours is left out on purpose: your own progress bar is already on the card,
 * and the point of this row is the question you'd otherwise have to ask out
 * loud — "has anyone seen this yet?"
 */
export function seenByOthers(titleId) {
  if (state.settings?.showWhoWatched === false) return [];
  return (state.watchedBy?.[titleId] || []).filter((p) => p.id !== state.activeProfile);
}

/** A row of small initials over the artwork: who in the house has seen it. */
function seenStrip(people) {
  const strip = el('div.seenby', {
    title: people.map((p) => `${p.name} — ${p.state === 'finished' ? 'watched' : 'part-way'}`).join('\n'),
  });
  for (const person of people.slice(0, 4)) {
    // "Olti" and "Oltion" both start with O, so badgeFor hands back however
    // many letters it takes to tell the household apart — which means the chip
    // has to grow sideways and shrink its type rather than assume one letter.
    const label = badgeFor(person.name, state.profiles.map((p) => p.name));
    strip.append(el(`span.seenby__face${person.state === 'watching' ? '.is-partial' : ''}`, {
      text: label,
      style: {
        '--who': person.color || hashColor(person.name),
        fontSize: badgeFontSize(label, 0.9),
      },
      'aria-label': `${person.name} has ${person.state === 'finished' ? 'watched this' : 'started this'}`,
    }));
  }
  if (people.length > 4) strip.append(el('span.seenby__more', { text: `+${people.length - 4}` }));
  return strip;
}

/**
 * Artwork with a built-in fallback: the name sits underneath, and a poster
 * that 404s simply removes itself and reveals it. Remote thumbnails
 * (archive.org, anything you paste in) fail often enough to matter.
 */
function artBox(url, label) {
  // The fallback is a designed state, not an absence: the title's initial set
  // huge behind its name, on a tint derived from the name itself.
  const fallback = el('div.card__fallback', {
    'data-initial': String(label || '?').trim()[0]?.toUpperCase() || '?',
    'aria-hidden': 'true',
    style: { '--tint': hashColor(label) },
  });
  const box = el('div.card__art', {}, [fallback]);
  if (url) {
    box.append(el('img.card__img', {
      src: imageSrc(url),
      alt: '',
      loading: 'lazy',
      decoding: 'async',
      onerror: (event) => event.currentTarget.remove(),
    }));
  }
  return box;
}

/**
 * Fetch third-party artwork through Elbi rather than from the browser. The
 * server is the machine with internet access in a LAN setup, and it keeps
 * browsing your library from reaching out to other hosts.
 */
export function imageSrc(url) {
  const value = String(url || '');
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    if (new URL(value).origin === location.origin) return value;
  } catch {
    return value;
  }
  if (!state.server.allowRemote) return value;
  return `/api/remote?url=${encodeURIComponent(value)}`;
}

function elSvg(markup) {
  const wrap = document.createElement('span');
  wrap.innerHTML = markup;
  return wrap.firstElementChild;
}

function cssUrl(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

function bestSource(title) {
  const all = playablesOf(title).flatMap((p) => p.sources);
  return all.sort((a, b) => (b.height || 0) - (a.height || 0))[0] || null;
}

function anyOffline(title) {
  return playablesOf(title).some((p) => p.sources.some((s) => isSourceOffline(title.id, s.id)));
}

export function row(heading, cards, { hint = '', poster = false } = {}) {
  if (!cards.length) return null;
  const track = el('div.row', {}, cards);
  if (poster) track.classList.add('row--posters');

  const scroll = (dir) => track.scrollBy({ left: dir * Math.round(track.clientWidth * 0.86), behavior: 'smooth' });

  const prev = el('button.rownav.rownav--prev', { type: 'button', 'aria-label': 'Scroll left', text: '‹', onclick: () => scroll(-1) });
  const next = el('button.rownav.rownav--next', { type: 'button', 'aria-label': 'Scroll right', text: '›', onclick: () => scroll(1) });
  const wrap = el('div.rowwrap', {}, [prev, track, next]);

  // Arrows only earn their place when the row actually overflows.
  const syncNav = () => {
    const overflow = track.scrollWidth - track.clientWidth;
    prev.disabled = track.scrollLeft <= 4;
    next.disabled = overflow <= 4 || track.scrollLeft >= overflow - 4;
  };
  track.addEventListener('scroll', syncNav, { passive: true });
  new ResizeObserver(syncNav).observe(track);
  requestAnimationFrame(syncNav);

  return el('section.section', {}, [
    el('div.section__head', {}, [
      el('h2', { text: heading }),
      hint ? el('span.section__hint', { text: hint }) : null,
    ]),
    wrap,
  ]);
}

// ---------------------------------------------------------------------------
// browse

export function renderBrowse() {
  const host = clear(view());
  if (!state.titles.length) {
    host.append(emptyLibrary());
    return;
  }

  const featured = pickFeatured();
  if (featured) host.append(renderHero(featured));

  const resume = continueWatching();
  if (resume.length) {
    const rewind = Number(state.settings?.resumeRewind) || 0;
    host.append(row(
      'Continue watching',
      resume.map(({ title, item, entry }) => {
        const card = titleCard(title, { item });
        const remaining = entry.duration - entry.position;
        card.querySelector('.card__sub').append(
          el('span', { text: `${formatTime(remaining)} left` }),
        );
        return card;
      }),
      { hint: rewind ? `picks up ${rewind}s before you stopped` : 'picks up where you stopped' },
    ));
  }

  const myList = state.myList.map(titleById).filter(Boolean);
  if (myList.length) {
    const who = state.profiles.find((p) => p.id === state.activeProfile)?.name;
    host.append(row('My list', myList.map((t) => titleCard(t)), { hint: who ? `saved by ${who}` : '' }));
  }

  const recent = [...state.titles].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 20);
  const files = state.titles.reduce((n, t) => n + t.sourceCount, 0);
  host.append(row('Recently added', recent.map((t) => titleCard(t)), {
    hint: `${state.titles.length} titles · ${files} files`,
  }));

  const offline = state.titles.filter(anyOffline);
  if (offline.length) {
    host.append(row('Available offline', offline.map((t) => titleCard(t)), { hint: 'plays with no network' }));
  }

  const series = state.titles.filter((t) => t.type === 'series');
  if (series.length) {
    const episodes = series.reduce((n, t) => n + t.episodeCount, 0);
    host.append(row('Series', series.map((t) => titleCard(t)), { hint: `${episodes} episodes` }));
  }

  const free = state.titles.filter((t) => t.origin === 'archive.org');
  if (free.length) {
    host.append(row('Streaming — nothing to download', free.map((t) => titleCard(t, { poster: true })),
      { poster: true, hint: 'public domain · internet archive' }));
  }

  for (const genre of allGenres().slice(0, 8)) {
    const inGenre = state.titles.filter((t) => (t.genres || []).includes(genre));
    if (inGenre.length >= 2) host.append(row(genre, inGenre.map((t) => titleCard(t))));
  }

  const noFile = state.titles.filter((t) => !hasPlayableSource(t));
  if (noFile.length) {
    host.append(row('Waiting for a video file', noFile.map((t) => titleCard(t)), {
      hint: 'open one and add a file or URL',
    }));
  }
}

function pickFeatured() {
  const withArt = state.titles.filter((t) => (t.backdrop || t.poster) && hasPlayableSource(t));
  const pool = withArt.length ? withArt : state.titles.filter(hasPlayableSource);
  if (!pool.length) return state.titles[0] || null;
  // Rotate daily so the billboard is not always the same title.
  const day = Math.floor(Date.now() / 86_400_000);
  return pool[day % pool.length];
}

function renderHero(title) {
  const art = title.backdrop || title.poster;
  const progress = progressFor(title.id, playablesOf(title)[0]?.episodeId);

  const meta = [];
  if (title.year) meta.push(el('span', { text: String(title.year) }));
  if (title.rating) meta.push(el('span.pill', { text: title.rating }));
  if (title.type === 'series') meta.push(el('span', { text: `${title.seasons.length} season${title.seasons.length === 1 ? '' : 's'}` }));
  else if (title.runtimeMin) meta.push(el('span', { text: formatRuntime(title.runtimeMin) }));
  const best = bestSource(title);
  if (best?.height) meta.push(el('span.pill', { text: qualityLabel(best.height) }));
  if (best?.fps) meta.push(el('span.pill', { text: `${Math.round(best.fps)} fps` }));

  const hero = el('section.hero', {}, [
    el('div.hero__art', art
      ? { style: { backgroundImage: `url("${cssUrl(imageSrc(art))}")` } }
      // No artwork: let the lamp carry it rather than faking a poster.
      : { style: { background: `linear-gradient(118deg, ${hashColor(title.name)}, #08080c 72%)` } }),
    el('div.hero__inner', {}, [
      el('h1.hero__title', { text: title.name }),
      el('div.hero__meta', {}, meta),
      title.overview ? el('p.hero__overview', { text: title.overview }) : null,
      el('div.hero__actions', {}, [
        el('button.btn.btn--light', {
          type: 'button',
          onclick: () => startPlayback(title),
        }, [elSvg('<svg viewBox="0 0 24 24" class="icon"><path d="M8 5v14l11-7L8 5Z"/></svg>'),
          progress && !progress.finished
            ? `Resume · ${formatTime(resumePointFor(title.id, playablesOf(title)[0]?.episodeId))}`
            : 'Play']),
        el('button.btn', { type: 'button', onclick: () => openDetail(title.id) }, ['More info']),
      ]),
    ]),
  ]);
  if (!art) hero.classList.add('hero--bare');
  return hero;
}

function emptyLibrary() {
  return el('div.empty', {}, [
    el('h3', { text: 'Your library is empty' }),
    el('p', { text: 'Add the movies you already have, or stream a public-domain film without downloading anything.' }),
    el('div.row-gap', { style: { justifyContent: 'center' } }, [
      el('button.btn.btn--primary', {
        type: 'button',
        onclick: async () => (await import('./add.js')).openAdd('upload'),
      }, ['Upload a movie']),
      el('button.btn.btn--ghost', {
        type: 'button',
        onclick: async () => (await import('./add.js')).openAdd('scan'),
      }, ['Scan a folder']),
      el('button.btn.btn--ghost', {
        type: 'button',
        onclick: () => { location.hash = ''; history.pushState({}, '', '/discover'); window.dispatchEvent(new PopStateEvent('popstate')); },
      }, ['Browse free films']),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// library / search / results grid

const LIBRARY_VIEW_KEY = 'elbi.libraryView';

/** The saved filter/sort choice, so it survives a reload. */
function libraryView() {
  try {
    return normalizeView(JSON.parse(localStorage.getItem(LIBRARY_VIEW_KEY) || '{}'));
  } catch {
    return defaultView();
  }
}

function setLibraryView(patch) {
  const next = normalizeView({ ...libraryView(), ...patch });
  try {
    localStorage.setItem(LIBRARY_VIEW_KEY, JSON.stringify(next));
  } catch { /* private browsing; the view just won't persist */ }
  renderLibrary();
}

/** Where a title stands for the person watching: not started, part-way, done. */
function watchStatusOf(title) {
  const items = playablesOf(title);
  if (!items.length) return 'unwatched';
  let started = 0;
  let finished = 0;
  for (const item of items) {
    const entry = progressFor(title.id, item.episodeId);
    if (!entry) continue;
    if (entry.finished) finished += 1;
    else if (entry.position > 0) started += 1;
  }
  if (finished === items.length) return 'finished';
  if (started || finished) return 'watching';
  return 'unwatched';
}

/**
 * The library grid. `only` pins it to films or series — that is what the Films
 * and TV shows shelves are — in which case the type chips are dropped, since
 * the shelf you are standing on already answers that question.
 */
export function renderLibrary({ only = null, heading = 'My library' } = {}) {
  const host = clear(view());
  const pool = only
    ? state.titles.filter((t) => (t.type === 'series' ? 'series' : 'movie') === only)
    : state.titles;

  if (!state.titles.length) {
    host.append(emptyLibrary());
    return;
  }
  if (!pool.length) {
    host.append(el('section.section', {}, [
      el('div.section__head', {}, [el('h2', { text: heading })]),
      el('div.empty', {}, [
        el('p', {
          text: only === 'series'
            ? 'No TV shows yet. Files named like "Show.S01E02.mkv" are grouped into a series automatically.'
            : 'No films yet — everything in your library is a series.',
        }),
      ]),
    ]));
    return;
  }

  const current = only ? { ...libraryView(), type: 'all' } : libraryView();
  const shown = applyView(pool, current, { statusOf: watchStatusOf });
  const sources = shown.reduce((n, t) => n + t.sourceCount, 0);

  const hint = shown.length === pool.length
    ? `${pool.length} titles · ${sources} video files`
    : `${shown.length} of ${pool.length} titles · ${sources} video files`;

  host.append(el('section.section', {}, [
    el('div.section__head', {}, [
      el('h2', { text: heading }),
      el('span.section__hint', { text: hint }),
    ]),
    libraryToolbar(current, { pool, hideType: Boolean(only) }),
    shown.length
      ? el('div.grid', {}, shown.map((t) => titleCard(t, { poster: true })))
      : el('div.empty', {}, [
        el('p', { text: 'Nothing in your library matches those filters.' }),
        el('button.btn.btn--primary', {
          type: 'button',
          onclick: () => setLibraryView(defaultView()),
        }, ['Show everything']),
      ]),
  ]));
}

/** Sort order, media type, watch status and genre — one row above the grid. */
function libraryToolbar(current, { pool = state.titles, hideType = false } = {}) {
  const bar = el('div.filters');

  const group = (label, children) => el('div.filters__group', {}, [
    el('span.filters__label', { text: label }),
    el('div.filters__chips', {}, children),
  ]);

  const chip = (text, active, onclick, extra = '') => el(`button.chip${active ? '.is-active' : ''}`, {
    type: 'button',
    'aria-pressed': active ? 'true' : 'false',
    onclick,
  }, [el('span', { text }), extra ? el('small', { text: extra }) : null].filter(Boolean));

  bar.append(group('Sort', Object.entries(SORTS).map(([key, { label }]) => chip(
    label, current.sort === key, () => setLibraryView({ sort: key }),
  ))));

  if (!hideType) {
    bar.append(group('Show', Object.entries(TYPES).map(([key, label]) => chip(
      label, current.type === key, () => setLibraryView({ type: key }),
    ))));
  }

  bar.append(group('Watched', Object.entries(STATUSES).map(([key, label]) => chip(
    label, current.status === key, () => setLibraryView({ status: key }),
  ))));

  // Only offer genres that exist on this shelf, so no chip is a dead end.
  const genres = genreCounts(pool);
  if (genres.length) {
    bar.append(group('Genre', [
      chip('Any', !current.genre, () => setLibraryView({ genre: '' })),
      ...genres.slice(0, 14).map(({ name, count }) => chip(
        name,
        current.genre.toLowerCase() === name.toLowerCase(),
        () => setLibraryView({ genre: current.genre.toLowerCase() === name.toLowerCase() ? '' : name }),
        String(count),
      )),
    ]));
  }

  if (!isDefaultView(current)) {
    bar.append(el('button.btn.btn--ghost.filters__clear', {
      type: 'button',
      onclick: () => setLibraryView(defaultView()),
    }, ['Clear filters']));
  }

  return bar;
}

export function renderSearch(query) {
  const host = clear(view());
  const results = searchTitles(query);
  host.append(el('section.section', {}, [
    el('div.section__head', {}, [
      el('h2', { text: results.length ? `Results for “${query}”` : `Nothing in your library matches “${query}”` }),
      el('span.section__hint', { text: `${results.length} title${results.length === 1 ? '' : 's'}` }),
    ]),
    results.length
      ? el('div.grid', {}, results.map((t) => titleCard(t, { poster: true })))
      : el('div.empty', {}, [
        el('p', { text: 'Try the free-films tab — it searches thousands of public-domain movies you can stream right away.' }),
        el('button.btn.btn--primary', {
          type: 'button',
          onclick: () => { history.pushState({}, '', `/discover?q=${encodeURIComponent(query)}`); window.dispatchEvent(new PopStateEvent('popstate')); },
        }, ['Search free films']),
      ]),
  ]));
}

// ---------------------------------------------------------------------------
// detail sheet

export function openDetail(titleId, episodeId = null) {
  const title = titleById(titleId);
  if (!title) return;
  const modal = $('#detailModal');
  const body = clear($('#detailBody'));
  body.append(detailContent(title, episodeId));
  modal.hidden = false;
  document.body.classList.add('no-scroll');
}

export function closeDetail() {
  $('#detailModal').hidden = true;
  document.body.classList.remove('no-scroll');
}

function refreshDetail(titleId) {
  if ($('#detailModal').hidden) return;
  const title = titleById(titleId);
  if (!title) return closeDetail();
  const body = clear($('#detailBody'));
  body.append(detailContent(title));
  return undefined;
}

function detailContent(title, focusEpisodeId = null) {
  const art = title.backdrop || title.poster;
  const list = playablesOf(title);
  const first = focusEpisodeId ? list.find((p) => p.episodeId === focusEpisodeId) : null;
  const progress = progressFor(title.id, (first || list[0])?.episodeId);
  const inList = state.myList.includes(title.id);

  const meta = [];
  if (title.year) meta.push(el('span', { text: String(title.year) }));
  if (title.rating) meta.push(el('span.pill', { text: title.rating }));
  if (title.type === 'series') meta.push(el('span', { text: `${title.episodeCount} episodes` }));
  else if (title.runtimeMin) meta.push(el('span', { text: formatRuntime(title.runtimeMin) }));
  if (title.origin === 'archive.org') meta.push(el('span.pill', { text: 'Public domain' }));

  const hero = el('div.detail__hero', art
    ? { style: { backgroundImage: `url("${cssUrl(imageSrc(art))}")` } }
    : { style: { background: `linear-gradient(118deg, ${hashColor(title.name)}, #0d0d13 74%)` } }, [
    el('div.detail__heroin', {}, [
      el('h1', { text: title.name, style: { fontSize: 'clamp(1.4rem,3.4vw,2.4rem)' } }),
      el('div.hero__meta', {}, meta),
      el('div.row-gap', {}, [
        el('button.btn.btn--light', {
          type: 'button',
          disabled: !hasPlayableSource(title),
          onclick: () => { closeDetail(); startPlayback(title, first); },
          // Show where it will actually start, which is a little before you stopped.
          title: progress && !progress.finished
            ? `You stopped at ${formatTime(progress.position)}`
            : '',
        }, [progress && !progress.finished
          ? `Resume · ${formatTime(resumePointFor(title.id, (first || list[0])?.episodeId))}`
          : 'Play']),
        el('button.btn', {
          type: 'button',
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              if (inList) await api.removeFromList(state.activeProfile, title.id);
              else await api.addToList(state.activeProfile, title.id);
              await refresh();
              refreshDetail(title.id);
            } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
          },
        }, [inList ? '✓ In my list' : '+ My list']),
        progress && !progress.finished ? el('button.btn.btn--ghost', {
          type: 'button',
          onclick: async () => {
            await api.clearProgress(state.activeProfile, `${title.id}:${(first || list[0])?.episodeId || '-'}`)
              .catch((err) => toast(err.message, 'err'));
            await refresh();
            refreshDetail(title.id);
          },
        }, ['Clear progress']) : null,
      ]),
    ]),
  ]);

  const left = el('div', {}, [
    title.tagline ? el('p.detail__tagline', { text: `“${title.tagline}”` }) : null,
    title.overview ? el('p', { text: title.overview }) : el('p.muted', { text: 'No description yet.' }),
    title.type === 'series' ? episodeSection(title) : sourceSection(title, list[0]),
  ]);

  const castNames = (title.cast || []).map((c) => c.name).filter(Boolean);
  const right = el('div', {}, [
    el('dl.detail__facts', {}, [
      title.genres?.length ? el('dt', { text: 'Genres' }) : null,
      title.genres?.length ? el('dd', { text: title.genres.join(', ') }) : null,
      title.director?.length ? el('dt', { text: title.director.length > 1 ? 'Directors' : 'Director' }) : null,
      title.director?.length ? el('dd', { text: title.director.join(', ') }) : null,
      castNames.length ? el('dt', { text: 'Cast' }) : null,
      castNames.length ? el('dd', { text: castNames.slice(0, 8).join(', ') }) : null,
      title.voteAverage ? el('dt', { text: 'Score' }) : null,
      title.voteAverage ? el('dd', { text: `${title.voteAverage} / 10` }) : null,
      seenByOthers(title.id).length ? el('dt', { text: 'Seen by' }) : null,
      seenByOthers(title.id).length ? el('dd', {
        text: seenByOthers(title.id)
          .map((p) => (p.state === 'finished' ? p.name : `${p.name} (part-way)`))
          .join(', '),
      }) : null,
      el('dt', { text: 'Added' }),
      el('dd', { text: new Date(title.addedAt).toLocaleDateString() }),
      el('dt', { text: 'Origin' }),
      el('dd', { text: originLabel(title) }),
      title.externalUrl ? el('dt', { text: 'Source page' }) : null,
      title.externalUrl ? el('dd', {}, [el('a', { href: title.externalUrl, target: '_blank', rel: 'noopener', text: 'archive.org', style: { textDecoration: 'underline' } })]) : null,
      title.license ? el('dt', { text: 'Licence' }) : null,
      title.license ? el('dd', { text: String(title.license) }) : null,
      title.metadata?.url ? el('dt', { text: 'Matched from' }) : null,
      title.metadata?.url ? el('dd', {}, [el('a', {
        href: title.metadata.url, target: '_blank', rel: 'noopener',
        text: title.metadata.provider === 'tmdb' ? 'TMDB' : 'Wikipedia',
        style: { textDecoration: 'underline' },
      })]) : null,
    ]),
    el('div.stack', { style: { marginTop: '1rem' } }, [
      el('button.btn.btn--ghost.btn--sm', {
        type: 'button',
        onclick: () => openMatchPicker(title),
      }, [title.poster ? 'Re-match poster & details' : 'Find poster & details']),
      el('button.btn.btn--ghost.btn--sm', {
        type: 'button',
        onclick: () => openSubtitleSearch(title, first || list[0]),
      }, ['Find subtitles online']),
      el('button.btn.btn--ghost.btn--sm', {
        type: 'button',
        onclick: async () => (await import('./add.js')).openAddSource(title),
      }, ['+ Add video file or URL']),
      title.type !== 'series' ? null : el('button.btn.btn--ghost.btn--sm', {
        type: 'button',
        onclick: async () => (await import('./add.js')).openAddEpisode(title),
      }, ['+ Add episode']),
      el('button.btn.btn--ghost.btn--sm', {
        type: 'button',
        onclick: async () => (await import('./add.js')).openEditTitle(title),
      }, ['Edit details']),
      el('button.btn.btn--ghost.btn--sm', {
        type: 'button',
        onclick: async () => (await import('./add.js')).openSubtitleForm(title),
      }, ['Add subtitles']),
      el('button.btn.btn--danger.btn--sm', {
        type: 'button',
        onclick: () => confirmDelete(title),
      }, ['Remove from library']),
    ]),
  ]);

  return el('div', {}, [hero, el('div.detail__body', {}, [left, right])]);
}

function originLabel(title) {
  return {
    upload: 'Uploaded to Elbi',
    scan: 'Imported from a folder',
    'archive.org': 'Internet Archive (streamed)',
    manual: 'Added by hand',
  }[title.origin] || title.origin || 'unknown';
}

function sourceSection(title, item) {
  const sources = item?.sources || [];
  const subs = item?.subtitles || [];

  return el('div', {}, [
    el('h3', { text: `Video files (${sources.length})`, style: { marginTop: '1.2rem', fontSize: '1rem' } }),
    sources.length
      ? el('div.sourcelist', {}, sources.map((s) => sourceRow(title, item, s)))
      : el('div.note', { text: 'No video yet. Use “Add video file or URL” to attach one.' }),
    subs.length ? el('h3', { text: `Subtitles (${subs.length})`, style: { marginTop: '1.2rem', fontSize: '1rem' } }) : null,
    subs.length ? el('div.sourcelist', {}, subs.map((sub) => el('div.sourceitem', {}, [
      el('div.sourceitem__main', {}, [
        el('div.sourceitem__name', { text: sub.label }),
        el('div.sourceitem__meta', { text: sub.lang }),
      ]),
      el('button.iconbtn', {
        type: 'button', title: 'Remove subtitle track',
        onclick: async () => {
          const res = await api.deleteSubtitle(title.id, sub.id).catch((err) => toast(err.message, 'err'));
          if (res?.title) { upsertTitle(res.title); refreshDetail(title.id); }
        },
      }, ['✕']),
    ]))) : null,
  ]);
}

function sourceRow(title, item, source) {
  const bits = [];
  if (source.width && source.height) bits.push(`${source.width}×${source.height}`);
  else if (source.height) bits.push(qualityLabel(source.height));
  if (source.fps) bits.push(`${Math.round(source.fps)} fps`);
  if (source.size) bits.push(formatBytes(source.size));
  if (source.durationSec) bits.push(formatTime(source.durationSec));
  if (source.codec) bits.push(source.codec);
  bits.push(source.kind === 'url' ? (source.remoteHost || 'remote URL') : (source.filename || 'local file'));

  const offline = isSourceOffline(title.id, source.id);
  const canDownload = source.kind === 'file' || source.streamType === 'progressive';

  const node = el('div.sourceitem', {}, [
    el('div.sourceitem__main', {}, [
      el('div.sourceitem__name', {}, [
        source.label || qualityLabel(source.height) || 'Source',
        offline ? el('span.pill.pill--ok', { text: 'offline', style: { marginLeft: '.4rem' } }) : null,
        source.playability?.level === 'unsupported'
          ? el('span.pill.pill--bad', { text: 'needs converting', style: { marginLeft: '.4rem' } })
          : source.playability?.level === 'maybe'
            ? el('span.pill.pill--warn', { text: 'may not play', style: { marginLeft: '.4rem' } })
            : null,
      ]),
      el('div.sourceitem__meta', { text: bits.join(' · ') }),
    ]),
    el('button.btn.btn--sm', {
      type: 'button',
      onclick: () => { closeDetail(); play({ title, item, sourceId: source.id }); },
    }, ['Play']),
    source.kind === 'file' ? el('a.iconbtn', {
      href: streamUrl(title.id, source.id, { download: true }),
      download: '',
      title: 'Save this file to your device',
    }, ['⤓']) : null,
    canDownload ? el('button.iconbtn', {
      type: 'button',
      title: offline ? 'Remove offline copy' : 'Save for offline playback',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        if (offline) {
          await removeDownload(title.id, source.id);
          toast('Offline copy removed.', 'info');
        } else {
          await downloadSource(title, source);
        }
        btn.disabled = false;
        refreshDetail(title.id);
      },
    }, [offline ? '🗑' : '↓']) : null,
    el('button.iconbtn', {
      type: 'button',
      title: 'Remove this source',
      onclick: async () => {
        if (!confirm(`Remove "${source.label}" from ${title.name}? The file itself stays on disk.`)) return;
        const res = await api.deleteSource(title.id, source.id).catch((err) => toast(err.message, 'err'));
        if (res?.title) {
          upsertTitle(res.title);
          await removeDownload(title.id, source.id).catch(() => {});
          refreshDetail(title.id);
        }
      },
    }, ['✕']),
  ]);

  if (source.playability?.note) {
    node.title = source.playability.note;
  }
  return node;
}

function episodeSection(title) {
  const wrap = el('div', {}, [el('h3', { text: 'Episodes', style: { marginTop: '1.2rem', fontSize: '1rem' } })]);
  if (!title.seasons.length) {
    wrap.append(el('div.note', { text: 'No episodes yet. Use “Add episode”.' }));
    return wrap;
  }

  const select = el('select', {
    onchange: (e) => renderSeason(Number(e.target.value)),
  }, title.seasons.map((s) => el('option', { value: String(s.number), text: s.name || `Season ${s.number}` })));
  wrap.append(el('label.field', {}, [el('span', { text: 'Season' }), select]));

  const listHost = el('div');
  wrap.append(listHost);

  /**
   * Save a whole season in one go.
   *
   * The point of downloading is usually "I want this before I lose the
   * connection", and doing that episode by episode is the thing that stops
   * people bothering. Downloads run one at a time so they do not fight each
   * other for the same link.
   */
  const saveSeason = el('button.btn.btn--ghost.btn--sm', {
    type: 'button',
    style: { marginBottom: '.6rem' },
    onclick: async (event) => {
      const btn = event.currentTarget;
      const number = Number(select.value);
      const season = title.seasons.find((sn) => sn.number === number) || title.seasons[0];
      const pending = playablesOf(title)
        .filter((p) => p.season === season.number)
        .map((p) => ({ item: p, source: rankedFirst(p.sources) }))
        .filter((x) => x.source && !isSourceOffline(title.id, x.source.id));

      if (!pending.length) return toast('Every episode in this season is already saved.', 'info');

      btn.disabled = true;
      let saved = 0;
      for (const { source } of pending) {
        // eslint-disable-next-line no-await-in-loop
        const ok = await downloadSource(title, source);
        if (!ok) break;
        saved += 1;
      }
      btn.disabled = false;
      toast(
        saved === pending.length
          ? `Saved ${saved} episode${saved === 1 ? '' : 's'} for offline.`
          : `Saved ${saved} of ${pending.length} — the rest were not downloaded.`,
        saved ? 'ok' : 'err',
      );
      refreshDetail(title.id);
      return undefined;
    },
  }, ['↓ Save this season offline']);
  wrap.append(saveSeason);

  /** The best source to save: highest quality Elbi would play by default. */
  function rankedFirst(sources) {
    return [...(sources || [])]
      .filter((src) => src.kind === 'file' || src.streamType === 'progressive')
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0] || null;
  }

  function renderSeason(number) {
    const season = title.seasons.find((s) => s.number === number) || title.seasons[0];
    clear(listHost);
    for (const episode of season.episodes) {
      const item = playablesOf(title).find((p) => p.episodeId === episode.id);
      const prog = progressFor(title.id, episode.id);
      const pct = prog?.duration ? Math.min(100, (prog.position / prog.duration) * 100) : 0;
      const best = (episode.sources || [])[0];

      listHost.append(el('div.epitem', {
        onclick: () => {
          if (!episode.sources.length) return toast('That episode has no video file yet.', 'err');
          closeDetail();
          return play({ title, item });
        },
      }, [
        el('div.epitem__num', { text: String(episode.number) }),
        el('div.epitem__still', episode.still || title.backdrop
          ? { style: { backgroundImage: `url("${cssUrl(imageSrc(episode.still || title.backdrop))}")` } } : {}),
        el('div', {}, [
          el('div.epitem__name', { text: episode.name }),
          el('div.epitem__desc', {
            text: episode.overview || [
              best?.height ? qualityLabel(best.height) : null,
              best?.size ? formatBytes(best.size) : null,
              episode.sources.length ? `${episode.sources.length} source${episode.sources.length === 1 ? '' : 's'}` : 'no file',
            ].filter(Boolean).join(' · '),
          }),
          pct > 0 ? el('div.progress', { style: { marginTop: '.35rem' } }, [el('i', { style: { width: `${pct}%` } })]) : null,
        ]),
        el('button.iconbtn', {
          type: 'button',
          title: 'Find subtitles for this episode',
          onclick: (e) => { e.stopPropagation(); openSubtitleSearch(title, item); },
        }, ['CC']),
        el('button.iconbtn', {
          type: 'button',
          title: 'Remove episode',
          onclick: async (e) => {
            e.stopPropagation();
            if (!confirm(`Remove episode "${episode.name}"?`)) return;
            const res = await api.deleteEpisode(title.id, episode.id).catch((err) => toast(err.message, 'err'));
            if (res?.title) { upsertTitle(res.title); refreshDetail(title.id); }
          },
        }, ['✕']),
      ]));
    }
  }

  renderSeason(title.seasons[0].number);
  return wrap;
}

function confirmDelete(title) {
  const hasUploads = playablesOf(title).some((p) => p.sources.some((s) => s.kind === 'file'));
  const body = clear($('#sheetBody'));
  let deleteFiles = false;

  body.append(el('div', {}, [
    el('h2', { text: `Remove “${title.name}”?` }),
    el('p.muted', { text: 'This removes the title from your library. Files that Elbi did not upload are never touched.' }),
    hasUploads ? el('label.checkline', {}, [
      el('input', { type: 'checkbox', onchange: (e) => { deleteFiles = e.target.checked; } }),
      el('span', { text: 'Also delete the uploaded video files from disk' }),
    ]) : null,
    el('div.row-gap', {}, [
      el('button.btn.btn--danger', {
        type: 'button',
        onclick: async () => {
          try {
            await api.deleteTitle(title.id, deleteFiles);
            for (const p of playablesOf(title)) {
              for (const s of p.sources) await removeDownload(title.id, s.id).catch(() => {});
            }
            removeTitleLocal(title.id);
            closeSheet();
            closeDetail();
            toast(`Removed “${title.name}”.`, 'ok');
          } catch (err) {
            toast(err.message, 'err');
          }
        },
      }, ['Remove']),
      el('button.btn.btn--ghost', { type: 'button', onclick: closeSheet }, ['Cancel']),
    ]),
  ]));
  openSheet();
}

// ---------------------------------------------------------------------------
// playback entry

export function startPlayback(title, item = null) {
  const list = playablesOf(title);
  if (!list.length || !list.some((p) => p.sources.length)) {
    toast('Add a video file to this title first.', 'err');
    return;
  }
  let target = item;
  if (!target) {
    // Resume the most recently watched unfinished item, else the first playable.
    let best = null;
    for (const p of list) {
      const prog = progressFor(title.id, p.episodeId);
      if (prog && !prog.finished && prog.position > 5 && p.sources.length) {
        if (!best || prog.updatedAt > best.updatedAt) best = { item: p, updatedAt: prog.updatedAt };
      }
    }
    target = best?.item || list.find((p) => p.sources.length && !progressFor(title.id, p.episodeId)?.finished)
      || list.find((p) => p.sources.length);
  }
  play({ title, item: target });
}

// ---------------------------------------------------------------------------
// discover (Internet Archive)

let discoverAbort = null;

export async function renderDiscover(query = '', collection = '') {
  const host = clear(view());

  if (!state.server.allowRemote) {
    host.append(el('div.empty', {}, [
      el('h3', { text: 'Remote sources are switched off' }),
      el('p', { text: 'This server runs with ELBI_ALLOW_REMOTE=0, so streaming from the Internet Archive is disabled.' }),
    ]));
    return;
  }

  const input = el('input.inputlike', {
    type: 'search',
    value: query,
    placeholder: 'Search public-domain films…',
    style: { maxWidth: '340px' },
  });
  const collections = ['', 'feature_films', 'film_noir', 'silent_films', 'classic_cartoons', 'sci-fi_horror'];
  const select = el('select.inputlike', { style: { maxWidth: '200px' } }, collections.map((c) => el('option', {
    value: c, text: c ? c.replace(/_/g, ' ') : 'All collections', selected: c === collection,
  })));

  const results = el('div.grid');
  const status = el('p.muted', { text: 'Loading…' });

  const runSearch = async () => {
    discoverAbort?.abort();
    discoverAbort = new AbortController();
    clear(results);
    status.textContent = 'Searching the Internet Archive…';
    try {
      const data = await api.discover({ q: input.value, collection: select.value }, discoverAbort.signal);
      status.textContent = data.results.length
        ? `${data.results.length} shown of ${data.total.toLocaleString()} public-domain titles`
        : 'Nothing matched that search.';
      for (const entry of data.results) results.append(discoverCard(entry));
    } catch (err) {
      if (err.name === 'AbortError') return;
      status.textContent = `Could not reach the Internet Archive: ${err.message}`;
    }
  };

  let debounceTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 420);
  });
  select.addEventListener('change', runSearch);

  host.append(el('section.section', { style: { paddingTop: '1.5rem' } }, [
    el('div.section__head', {}, [
      el('h2', { text: 'Free films — stream without downloading' }),
      el('span.section__hint', { text: 'Public-domain titles hosted by the Internet Archive' }),
    ]),
    el('div.row-gap', { style: { marginBottom: '1rem' } }, [input, select]),
    status,
    results,
  ]));

  await runSearch();
}

function discoverCard(entry) {
  const artNode = artBox(entry.poster, entry.name);
  artNode.append(el('div.card__badges', {}, [el('span.pill.pill--brand', { text: 'Free' })]));

  return el('button.card.card--poster', {
    type: 'button',
    onclick: () => openDiscoverDetail(entry.identifier),
  }, [
    artNode,
    el('div.card__body', {}, [
      el('div.card__name', { text: entry.name }),
      el('div.card__sub', {}, [
        entry.year ? el('span', { text: String(entry.year) }) : null,
        entry.creator ? el('span', { text: entry.creator.slice(0, 26) }) : null,
      ]),
    ]),
  ]);
}

async function openDiscoverDetail(identifier) {
  const body = clear($('#sheetBody'));
  body.append(el('p.muted', { text: 'Loading details…' }));
  openSheet();

  let detail;
  try {
    detail = await api.discoverItem(identifier);
  } catch (err) {
    clear(body).append(el('div.note.note--bad', { text: err.message }));
    return;
  }

  clear(body).append(el('div', {}, [
    el('h2', { text: detail.name }),
    el('p.muted', { text: [detail.year, detail.creator].filter(Boolean).join(' · ') }),
    el('div.row-gap', { style: { alignItems: 'flex-start', marginBottom: '1rem' } }, [
      el('img', { src: imageSrc(detail.poster), alt: '', style: { width: '150px', borderRadius: '8px' }, loading: 'lazy' }),
      el('div', { style: { flex: '1', minWidth: '220px' } }, [
        el('p', { text: detail.overview || 'No description provided.' }),
        el('p.muted', { text: `Licence: ${detail.license}` }),
      ]),
    ]),
    el('h3', { text: `Available renditions (${detail.sources.length})`, style: { fontSize: '1rem' } }),
    el('div.sourcelist', {}, detail.sources.map((s) => el('div.sourceitem', {
      title: s.playability?.note || '',
    }, [
      el('div.sourceitem__main', {}, [
        el('div.sourceitem__name', {}, [
          s.label,
          s.playability?.level === 'direct'
            ? el('span.pill.pill--ok', { text: 'plays', style: { marginLeft: '.4rem' } })
            : el('span.pill.pill--warn', { text: 'may not play', style: { marginLeft: '.4rem' } }),
        ]),
        el('div.sourceitem__meta', {
          text: [s.height ? `${s.height}p` : null, s.size ? formatBytes(s.size) : null, s.codec || s.format]
            .filter(Boolean).join(' · '),
        }),
      ]),
    ]))),
    detail.sources.some((s) => s.playability?.level === 'direct')
      ? null
      : el('div.note', {
        text: 'None of this item’s renditions are H.264, so your browser may refuse them. Elbi will try each one in turn.',
      }),
    el('div.row-gap', { style: { marginTop: '1rem' } }, [
      el('button.btn.btn--primary', {
        type: 'button',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = 'Adding…';
          try {
            const res = await api.discoverAdd(identifier);
            upsertTitle(res.title);
            await refresh();
            closeSheet();
            toast(res.alreadyAdded ? 'Already in your library.' : `Added “${res.title.name}”.`, 'ok');
            openDetail(res.title.id);
          } catch (err) {
            toast(err.message, 'err');
            btn.disabled = false;
            btn.textContent = 'Add to my library';
          }
        },
      }, ['Add to my library']),
      el('a.btn.btn--ghost', { href: detail.pageUrl, target: '_blank', rel: 'noopener' }, ['View on archive.org']),
    ]),
  ]));
}

// ---------------------------------------------------------------------------
// downloads sheet

export function openDownloads() {
  const body = clear($('#sheetBody'));
  const render = async () => {
    clear(body);
    const index = (await import('./offline.js')).offlineIndex();
    const entries = Object.entries(index);
    const jobs = activeJobs();

    body.append(el('h2', { text: 'Downloads' }));
    body.append(el('p.muted', {
      text: 'Saved videos play with the network off, seeking included. They live in this browser’s storage on this device.',
    }));

    const offline = await import('./offline.js');
    const estimate = await offline.storageEstimate();
    if (estimate?.quota) {
      const free = Math.max(0, estimate.quota - estimate.usage);
      // Judge "one film" by the library's own files rather than by whatever
      // happens to be saved — one short clip would otherwise imply room for
      // tens of thousands more.
      const librarySizes = state.titles
        .flatMap((t) => playablesOf(t).flatMap((p) => p.sources.map((src) => src.size)));
      const typical = typicalFilmSize(librarySizes);
      body.append(el('p.muted', {
        text: `${formatBytes(estimate.usage)} used of about ${formatBytes(estimate.quota)}`
          + ` — ${formatBytes(free)} free, ${describeRoom(roomForFilms(free, typical))}.`,
      }));
    }

    // Whether these survive is the thing worth knowing before relying on them.
    const persistence = await offline.persistenceStatus();
    if (persistence.supported && !persistence.persisted) {
      const note = el('div.note.note--bad', {}, [
        el('p', {
          text: 'These downloads are not protected. The browser may delete them if '
            + 'storage runs low, or if you do not open Elbi for a while — which is '
            + 'exactly when you would be relying on them.',
          style: { margin: '0 0 .6rem' },
        }),
        el('button.btn.btn--primary.btn--sm', {
          type: 'button',
          onclick: async () => {
            const granted = await offline.requestPersistence();
            toast(
              granted
                ? 'Protected — your downloads will not be cleared.'
                : 'The browser declined. Adding Elbi to your home screen usually persuades it.',
              granted ? 'ok' : 'err',
            );
            render();
          },
        }, ['Protect my downloads']),
      ]);
      body.append(note);
    } else if (persistence.persisted) {
      body.append(el('div.note.note--ok', {
        text: 'Protected — these stay on this device until you delete them, '
          + 'and play with the server switched off.',
      }));
    }

    if (jobs.length) {
      body.append(el('h3', { text: 'In progress', style: { fontSize: '1rem', marginTop: '1rem' } }));
      body.append(el('div.joblist', {}, jobs.map((job) => {
        const pct = job.total ? Math.min(100, (job.received / job.total) * 100) : 0;
        return el('div.job', {}, [
          el('div.job__head', {}, [
            el('span.job__name', { text: job.name }),
            el('span.muted', {
              text: job.total ? `${formatBytes(job.received)} / ${formatBytes(job.total)}` : formatBytes(job.received),
            }),
          ]),
          el('div.progress', {}, [el('i', { style: { width: `${pct}%` } })]),
          el('div.row-gap', { style: { marginTop: '.4rem' } }, [
            el('button.btn.btn--ghost.btn--sm', { type: 'button', onclick: () => cancelDownload(job.key) }, ['Cancel']),
          ]),
        ]);
      })));
    }

    body.append(el('h3', { text: `Saved (${entries.length})`, style: { fontSize: '1rem', marginTop: '1rem' } }));
    if (!entries.length) {
      body.append(el('div.note', {
        text: 'Nothing saved yet. Open a title, then use the ↓ button next to a video file.',
      }));
      return;
    }

    body.append(el('div.joblist', {}, entries.map(([key, entry]) => el('div.job', {}, [
      el('div.job__head', {}, [
        el('span.job__name', { text: entry.name }),
        el('span.muted', { text: formatBytes(entry.size) }),
      ]),
      el('div.row-gap', {}, [
        el('button.btn.btn--sm', {
          type: 'button',
          onclick: () => {
            const title = titleById(entry.titleId);
            if (!title) return toast('That title is no longer in your library.', 'err');
            closeSheet();
            const item = playablesOf(title).find((p) => p.sources.some((s) => s.id === entry.sourceId));
            return play({ title, item, sourceId: entry.sourceId });
          },
        }, ['Play']),
        el('button.btn.btn--ghost.btn--sm', {
          type: 'button',
          onclick: async () => {
            await removeDownload(entry.titleId, entry.sourceId);
            toast('Removed.', 'info');
            render();
          },
        }, ['Delete']),
      ]),
    ]))));
  };

  const stop = onJobsChanged(() => { if (!$('#sheetModal').hidden) render(); });
  $('#sheetModal').addEventListener('elbi:closed', stop, { once: true });

  render();
  openSheet();
}

// ---------------------------------------------------------------------------
// metadata match sheet

/**
 * Pick the right film. Auto-matching handles the obvious cases; this exists
 * for the rest — two films with the same name, or a filename the scanner read
 * badly enough that the top hit is wrong.
 */
export function openMatchPicker(title) {
  const body = clear($('#sheetBody'));
  let query = title.name;
  let year = title.year || '';

  const results = el('div.stack');
  const status = el('p.muted', { text: 'Searching…' });

  const run = async () => {
    clear(results);
    status.textContent = 'Searching…';
    try {
      const data = await api.matchOptions(title.id, { q: query, year });
      status.textContent = data.status?.note || '';
      if (!data.results?.length) {
        results.append(el('div.note', { text: `Nothing found for “${query}”. Try a shorter name, or drop the year.` }));
        return;
      }
      for (const option of data.results) {
        const thumb = option.poster
          // Not lazy: there are at most six, and a picker whose posters have
          // not arrived is a picker you cannot pick from.
          ? el('img.matchopt__art', { src: imageSrc(option.poster), alt: '' })
          : el('div.matchopt__art.matchopt__art--none', { text: '?' });
        results.append(el('button.matchopt', {
          type: 'button',
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              const res = await api.applyMatch(title.id, { provider: option.provider, ref: option.ref });
              upsertTitle(res.title);
              refreshDetail(title.id);
              closeSheet();
              toast(`Matched to “${res.matched}” via ${res.provider}.`, 'ok');
            } catch (err) {
              toast(err.message, 'err');
              btn.disabled = false;
            }
          },
        }, [
          thumb,
          el('div.matchopt__text', {}, [
            el('strong', { text: option.name }),
            el('span.matchopt__meta', {
              text: [option.year || 'year unknown', `${Math.round(option.score * 100)}% match`].join(' · '),
            }),
            el('span.matchopt__blurb', { text: (option.overview || '').slice(0, 180) }),
          ]),
        ]));
      }
    } catch (err) {
      status.textContent = '';
      results.append(el('div.note.note--bad', { text: err.message }));
    }
  };

  const nameInput = el('input', { type: 'text', value: query, oninput: (e) => { query = e.target.value; } });
  const yearInput = el('input', { type: 'number', value: String(year || ''), placeholder: 'Year', oninput: (e) => { year = e.target.value; } });

  body.append(
    el('h2', { text: 'Find poster & details' }),
    el('form.matchform', {
      onsubmit: (e) => { e.preventDefault(); run(); },
    }, [
      el('label.field', {}, [el('span', { text: 'Title' }), nameInput]),
      el('label.field', {}, [el('span', { text: 'Year' }), yearInput]),
      el('button.btn.btn--primary', { type: 'submit' }, ['Search']),
    ]),
    status,
    results,
  );
  run();
  openSheet();
}

// ---------------------------------------------------------------------------
// subtitle search sheet

const SUB_LANG_LABEL = { alb: 'Albanian', eng: 'English', ita: 'Italian', ger: 'German', fre: 'French' };

/** Search and attach subtitles, defaulting to Albanian. */
export function openSubtitleSearch(title, item = null) {
  const body = clear($('#sheetBody'));
  let lang = state.settings?.subtitleLanguage || 'alb';

  const results = el('div.stack');
  const status = el('p.muted', {});

  const run = async () => {
    clear(results);
    status.textContent = 'Searching…';
    try {
      const data = await api.searchSubtitles({
        titleId: title.id,
        episodeId: item?.episodeId || '',
        lang,
      });
      if (!data.results?.length) {
        status.textContent = '';
        results.append(el('div.note', {
          text: `No ${data.language.name} subtitles found for “${title.name}”.`
            + (title.imdbId ? '' : ' Matching the title on TMDB or Wikipedia first usually helps — it fills in the IMDb id used for the lookup.'),
        }));
        return;
      }
      status.textContent = `${data.results.length} ${data.language.name} tracks, most-downloaded first.`;
      for (const option of data.results) {
        const tags = [`${option.downloads.toLocaleString()} downloads`];
        if (option.rating > 0) tags.push(`rated ${option.rating}`);
        if (option.hearingImpaired) tags.push('SDH');
        if (option.machineTranslated) tags.push('machine translated');
        if (option.trusted) tags.push('trusted uploader');

        results.append(el('div.sourceitem', {}, [
          el('div.sourceitem__main', {}, [
            el('div.sourceitem__name', { text: option.filename }),
            el('div.sourceitem__meta', { text: tags.join(' · ') }),
          ]),
          el('button.btn.btn--sm', {
            type: 'button',
            onclick: (e) => attach(e.currentTarget, option),
          }, ['Use this']),
        ]));
      }
    } catch (err) {
      status.textContent = '';
      results.append(el('div.note.note--bad', { text: err.message }));
    }
  };

  const attach = async (btn, option) => {
    btn.disabled = true;
    btn.textContent = 'Fetching…';
    try {
      const res = await api.fetchSubtitle(title.id, {
        url: option.downloadUrl,
        encoding: option.encoding,
        format: option.format,
        lang,
        episodeId: item?.episodeId || null,
        label: SUB_LANG_LABEL[lang] || option.langName || 'Subtitles',
      });
      upsertTitle(res.title);
      refreshDetail(title.id);
      closeSheet();
      toast(`${res.language} subtitles added — ${res.cues} cues.`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
      btn.textContent = 'Use this';
    }
  };

  const picker = el('select', {
    onchange: (e) => { lang = e.target.value; run(); },
  }, [
    ['alb', 'Albanian'], ['eng', 'English'], ['ita', 'Italian'], ['ger', 'German'],
    ['fre', 'French'], ['spa', 'Spanish'], ['gre', 'Greek'], ['tur', 'Turkish'],
    ['srp', 'Serbian'], ['mac', 'Macedonian'],
  ].map(([value, label]) => el('option', { value, text: label, selected: value === lang })));

  body.append(
    el('h2', { text: 'Find subtitles' }),
    el('p.muted', {
      text: item?.episodeId
        ? `Searching for ${title.name} — season ${item.season}, episode ${item.episode}.`
        : `Searching opensubtitles.org for “${title.name}”.`,
    }),
    el('label.field', {}, [el('span', { text: 'Language' }), picker]),
    status,
    results,
  );
  run();
  openSheet();
}

// ---------------------------------------------------------------------------
// profiles

export function renderProfileList(host, onPick, highlightId = null) {
  clear(host);
  for (const profile of state.profiles) {
    const face = el('div.profile__face', {
      style: {
        background: profile.color || hashColor(profile.name),
        fontSize: nameFontSize(profile.name),
      },
      text: profile.name,
    });
    const node = el('button.profile', {
      type: 'button',
      onclick: () => onPick(profile),
      'aria-label': `Watch as ${profile.name}`,
    }, [face, el('div.profile__name', { text: profile.name })]);
    // The last person to watch on this device is marked, not auto-selected.
    if (profile.id === highlightId) {
      node.classList.add('profile--last');
      node.append(el('div.profile__hint', { text: 'last used' }));
    }
    host.append(node);
  }
}

// ---------------------------------------------------------------------------
// sheet helpers

export function openSheet() {
  $('#sheetModal').hidden = false;
  document.body.classList.add('no-scroll');
}

export function closeSheet() {
  const modal = $('#sheetModal');
  modal.hidden = true;
  modal.dispatchEvent(new CustomEvent('elbi:closed'));
  if ($('#detailModal').hidden && $('#addModal').hidden) document.body.classList.remove('no-scroll');
}

export { refreshDetail };
