import { $, el, clear, formatTime, formatRuntime, formatBytes, qualityLabel, toast, hashColor, badgeFor, badgeFontSize } from './util.js';
import { api, streamUrl } from './api.js';
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
 * Artwork with a built-in fallback: the name sits underneath, and a poster
 * that 404s simply removes itself and reveals it. Remote thumbnails
 * (archive.org, anything you paste in) fail often enough to matter.
 */
function artBox(url, label) {
  const box = el('div.card__art', {}, [el('div.card__fallback', { text: label })]);
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
    ));
  }

  const myList = state.myList.map(titleById).filter(Boolean);
  if (myList.length) host.append(row('My list', myList.map((t) => titleCard(t))));

  const recent = [...state.titles].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 20);
  host.append(row('Recently added', recent.map((t) => titleCard(t))));

  const offline = state.titles.filter(anyOffline);
  if (offline.length) {
    host.append(row('Available offline', offline.map((t) => titleCard(t)), { hint: 'Plays with no network' }));
  }

  const series = state.titles.filter((t) => t.type === 'series');
  if (series.length) host.append(row('Series', series.map((t) => titleCard(t))));

  const free = state.titles.filter((t) => t.origin === 'archive.org');
  if (free.length) {
    host.append(row('Streaming — nothing to download', free.map((t) => titleCard(t, { poster: true })), { poster: true }));
  }

  for (const genre of allGenres().slice(0, 8)) {
    const inGenre = state.titles.filter((t) => (t.genres || []).includes(genre));
    if (inGenre.length >= 2) host.append(row(genre, inGenre.map((t) => titleCard(t))));
  }

  const noFile = state.titles.filter((t) => !hasPlayableSource(t));
  if (noFile.length) {
    host.append(row('Waiting for a video file', noFile.map((t) => titleCard(t)), {
      hint: 'Open one and add a file or URL',
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

  return el('section.hero', {}, [
    el('div.hero__art', art
      ? { style: { backgroundImage: `url("${cssUrl(imageSrc(art))}")` } }
      // No artwork yet: a deterministic wash beats a black rectangle.
      : { style: { background: `linear-gradient(115deg, ${hashColor(title.name)}, #101018 68%)` } }),
    art ? null : el('div.hero__watermark', { text: title.name, 'aria-hidden': 'true' }),
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

export function renderLibrary() {
  const host = clear(view());
  if (!state.titles.length) {
    host.append(emptyLibrary());
    return;
  }
  const sorted = [...state.titles].sort((a, b) => a.name.localeCompare(b.name));
  const counts = {
    titles: state.titles.length,
    sources: state.titles.reduce((n, t) => n + t.sourceCount, 0),
  };
  host.append(el('section.section', {}, [
    el('div.section__head', {}, [
      el('h2', { text: 'My library' }),
      el('span.section__hint', { text: `${counts.titles} titles · ${counts.sources} video files` }),
    ]),
    el('div.grid', {}, sorted.map((t) => titleCard(t, { poster: true }))),
  ]));
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
    : { style: { background: `linear-gradient(115deg, ${hashColor(title.name)}, #101018 72%)` } }, [
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
    title.overview ? el('p', { text: title.overview }) : el('p.muted', { text: 'No description yet.' }),
    title.type === 'series' ? episodeSection(title) : sourceSection(title, list[0]),
  ]);

  const right = el('div', {}, [
    el('dl.detail__facts', {}, [
      title.genres?.length ? el('dt', { text: 'Genres' }) : null,
      title.genres?.length ? el('dd', { text: title.genres.join(', ') }) : null,
      el('dt', { text: 'Added' }),
      el('dd', { text: new Date(title.addedAt).toLocaleDateString() }),
      el('dt', { text: 'Origin' }),
      el('dd', { text: originLabel(title) }),
      title.externalUrl ? el('dt', { text: 'Source page' }) : null,
      title.externalUrl ? el('dd', {}, [el('a', { href: title.externalUrl, target: '_blank', rel: 'noopener', text: 'archive.org', style: { textDecoration: 'underline' } })]) : null,
      title.license ? el('dt', { text: 'Licence' }) : null,
      title.license ? el('dd', { text: String(title.license) }) : null,
    ]),
    el('div.stack', { style: { marginTop: '1rem' } }, [
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

    const estimate = await (await import('./offline.js')).storageEstimate();
    if (estimate?.quota) {
      body.append(el('p.muted', {
        text: `Browser storage used: ${formatBytes(estimate.usage)} of about ${formatBytes(estimate.quota)}.`,
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
// profiles

export function renderProfileList(host, onPick, highlightId = null) {
  clear(host);
  const names = state.profiles.map((p) => p.name);
  for (const profile of state.profiles) {
    const label = badgeFor(profile.name, names);
    const face = el('div.profile__face', {
      style: { background: profile.color || hashColor(profile.name), fontSize: badgeFontSize(label) },
      text: label,
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
