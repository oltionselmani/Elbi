import { $, el, clear, formatBytes, qualityLabel, toast, probeVideoFile, browserCodecs } from './util.js';
import { api } from './api.js';
import { state, refresh, upsertTitle, titleById } from './state.js';
import { openDetail, openSheet, closeSheet, refreshDetail } from './views.js';
import { applySubtitleStyle as applySubtitleStyleNow } from './player.js';

const CHUNK_SIZE = 8 * 1024 * 1024;

export function openAdd(tab = 'upload') {
  $('#addModal').hidden = false;
  document.body.classList.add('no-scroll');
  for (const btn of $('#addTabs').querySelectorAll('.tab')) {
    btn.classList.toggle('is-active', btn.dataset.tab === tab);
  }
  renderAddTab(tab);
}

export function closeAdd() {
  $('#addModal').hidden = true;
  if ($('#detailModal').hidden && $('#sheetModal').hidden) document.body.classList.remove('no-scroll');
}

export function bindAddTabs() {
  $('#addTabs').addEventListener('click', (event) => {
    const btn = event.target.closest('.tab');
    if (!btn) return;
    openAdd(btn.dataset.tab);
  });
}

function renderAddTab(tab) {
  const body = clear($('#addBody'));
  if (tab === 'upload') body.append(uploadPanel());
  else if (tab === 'scan') body.append(scanPanel());
  else if (tab === 'url') body.append(urlPanel());
  else body.append(newTitlePanel());
}

// ---------------------------------------------------------------------------
// upload

function uploadPanel({ attachTo = null, episodeOf = null } = {}) {
  const jobsHost = el('div.joblist');

  const input = el('input', {
    type: 'file',
    accept: 'video/*,.mkv,.mp4,.m4v,.webm,.mov,.avi,.ogv,.mpg,.mpeg,.ts',
    multiple: !attachTo,
    style: { display: 'none' },
  });

  const targetSelect = attachTo ? null : el('select', {}, [
    el('option', { value: '', text: 'Create a new title for each file' }),
    ...[...state.titles].sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => el('option', { value: t.id, text: `Add as another source of: ${t.name}` })),
  ]);

  const drop = el('div.dropzone', {
    onclick: () => input.click(),
    ondragover: (e) => { e.preventDefault(); drop.classList.add('is-over'); },
    ondragleave: () => drop.classList.remove('is-over'),
    ondrop: (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
      handleFiles([...e.dataTransfer.files]);
    },
  }, [
    el('h3', { text: attachTo ? `Add a file to “${attachTo.name}”` : 'Drop movie files here' }),
    el('p.muted', { text: 'or click to choose. Large files upload in chunks and resume if a chunk fails.' }),
  ]);

  input.addEventListener('change', () => {
    handleFiles([...input.files]);
    input.value = '';
  });

  async function handleFiles(files) {
    const videos = files.filter((f) => f.size > 0);
    if (!videos.length) return;
    for (const file of videos) {
      // Sequential: one big upload at a time keeps the connection usable.
      // eslint-disable-next-line no-await-in-loop
      await uploadOne(file, {
        jobsHost,
        titleId: attachTo?.id || targetSelect?.value || '',
        episode: episodeOf || null,
      });
    }
    await refresh();
    if (attachTo) refreshDetail(attachTo.id);
  }

  return el('div', {}, [
    el('div.note', {
      text: 'Browsers play .mp4 (H.264/AAC) and .webm reliably. .mkv works in Chrome and Edge only when the streams inside are H.264/VP9 with AAC/Opus — Elbi flags anything risky instead of showing you a black screen.',
    }),
    targetSelect ? el('label.field', {}, [el('span', { text: 'Where should these go?' }), targetSelect]) : null,
    drop,
    input,
    jobsHost,
  ]);
}

async function uploadOne(file, { jobsHost, titleId, episode }) {
  const job = el('div.job', {}, [
    el('div.job__head', {}, [
      el('span.job__name', { text: file.name }),
      el('span.muted', { text: 'preparing…' }),
    ]),
    el('div.progress', {}, [el('i', { style: { width: '0%' } })]),
  ]);
  jobsHost.prepend(job);
  const status = job.querySelector('.muted');
  const bar = job.querySelector('.progress > i');

  const fail = (message) => {
    job.classList.add('job--error');
    status.textContent = message;
    bar.style.width = '100%';
    toast(`${file.name}: ${message}`, 'err');
  };

  try {
    status.textContent = 'reading metadata…';
    const meta = await probeVideoFile(file);

    status.textContent = 'starting…';
    const session = await api.startUpload({ filename: file.name, size: file.size, mime: file.type });

    let offset = 0;
    let attempts = 0;
    while (offset < file.size) {
      const end = Math.min(offset + CHUNK_SIZE, file.size);
      try {
        const res = await api.putChunk(session.id, offset, file.slice(offset, end));
        offset = res.received;
        attempts = 0;
      } catch (err) {
        // The server tells us what it actually holds; resync and carry on.
        if (err.status === 409 && Number.isFinite(err.payload?.received)) {
          offset = err.payload.received;
          continue;
        }
        attempts += 1;
        if (attempts > 3) throw err;
        status.textContent = `retrying (${attempts}/3)…`;
        await new Promise((r) => setTimeout(r, 800 * attempts));
        const check = await api.uploadStatus(session.id).catch(() => null);
        if (check) offset = check.received;
        continue;
      }
      const pct = (offset / file.size) * 100;
      bar.style.width = `${pct}%`;
      status.textContent = `${formatBytes(offset)} / ${formatBytes(file.size)} (${pct.toFixed(0)}%)`;
    }

    status.textContent = 'finishing…';
    const payload = { titleId: titleId || undefined, meta };
    if (!titleId) {
      payload.name = cleanName(file.name);
      payload.origin = 'upload';
    }
    if (meta.height) payload.label = qualityLabel(meta.height);
    if (episode) payload.episode = episode;

    const result = await api.completeUpload(session.id, payload);
    upsertTitle(result.title);

    job.classList.add('job--done');
    bar.style.width = '100%';
    status.textContent = `done · ${result.size}`;
    const detailBtn = el('button.btn.btn--sm', {
      type: 'button',
      style: { marginTop: '.5rem' },
      onclick: () => { closeAdd(); openDetail(result.title.id); },
    }, ['Open title']);
    job.append(detailBtn);
    toast(`Uploaded ${file.name}`, 'ok');
    return result;
  } catch (err) {
    fail(err.message || 'upload failed');
    return null;
  }
}

function cleanName(filename) {
  return filename
    .replace(/\.[^.]+$/, '')
    .replace(/[._]+/g, ' ')
    .replace(/\b(1080p|720p|2160p|480p|4k|bluray|webrip|web-dl|x264|x265|hevc|aac|dts)\b.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || filename;
}

// ---------------------------------------------------------------------------
// scan

function scanPanel() {
  const roots = state.server.scanRoots || [];
  const input = el('input', { type: 'text', value: roots[0] || '', placeholder: '/path/to/your/movies' });
  const output = el('div');

  return el('div', {}, [
    el('h3', { text: 'Import files already on the server' }),
    el('p.muted', {
      text: 'Point Elbi at a folder and it registers every video inside — no copying, no uploading. Files named like "Show.S01E02.mp4" are grouped into a series; matching .srt/.vtt files come along as subtitles.',
    }),
    el('div.note', {}, [
      'Allowed folders: ',
      el('code', { text: roots.join('  ·  ') || '(none)' }),
      el('br'),
      'Add more with the ELBI_SCAN_DIRS environment variable, e.g. ',
      el('code', { text: 'ELBI_SCAN_DIRS=/mnt/movies:/mnt/shows node server.js' }),
    ]),
    el('label.field', {}, [el('span', { text: 'Folder to scan' }), input]),
    el('button.btn.btn--primary', {
      type: 'button',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Scanning…';
        clear(output);
        try {
          const report = await api.scan(input.value.trim());
          await refresh();
          output.append(el('div.note.note--ok', {
            text: `Added ${report.added} file${report.added === 1 ? '' : 's'}, skipped ${report.skipped} already in the library.`,
          }));
          if (report.titles.length) {
            output.append(el('p', { text: `New titles: ${report.titles.slice(0, 25).join(', ')}${report.titles.length > 25 ? '…' : ''}` }));
          }
          if (report.unplayable.length) {
            output.append(el('div.note.note--bad', {
              text: `These were imported but browsers cannot play them as-is: ${report.unplayable.slice(0, 10).join(', ')}. Remux them to .mp4 to watch in Elbi.`,
            }));
          }

          // Posters are a separate round of network calls, so they run after
          // the import is already reported rather than holding it up.
          if (report.newTitleIds?.length && state.settings?.autoMatchMetadata) {
            const looking = el('p.muted', { text: 'Looking up posters and details…' });
            output.append(looking);
            try {
              const found = await api.enrichMetadata({ titleIds: report.newTitleIds });
              await refresh();
              const more = found.remaining ? ` ${found.remaining} still to do — scan again or match them by hand.` : '';
              looking.textContent = found.matched.length
                ? `Matched ${found.matched.length} of ${found.considered} via ${found.provider}.${more}`
                : `No confident poster match for these (searched ${found.provider}). Use “Find poster & details” on a title to pick one.${more}`;
            } catch (err) {
              looking.textContent = `Posters could not be fetched: ${err.message}`;
            }
          }
        } catch (err) {
          output.append(el('div.note.note--bad', { text: err.message }));
        }
        btn.disabled = false;
        btn.textContent = 'Scan folder';
      },
    }, ['Scan folder']),
    output,
  ]);
}

// ---------------------------------------------------------------------------
// add by URL

function urlPanel({ attachTo = null } = {}) {
  const urlInput = el('input', { type: 'url', placeholder: 'https://example.com/movie.mp4', required: true });
  const nameInput = el('input', { type: 'text', placeholder: 'Title name' });
  const labelInput = el('input', { type: 'text', placeholder: '1080p' });
  const heightInput = el('input', { type: 'number', placeholder: '1080', min: '0' });
  const output = el('div');

  const targetSelect = attachTo ? null : el('select', {}, [
    el('option', { value: '', text: 'Create a new title' }),
    ...[...state.titles].sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => el('option', { value: t.id, text: `Add to: ${t.name}` })),
  ]);

  return el('div', {}, [
    el('h3', { text: attachTo ? `Add a URL to “${attachTo.name}”` : 'Stream from a direct URL' }),
    el('p.muted', {
      text: 'Paste a direct link to a video file (.mp4/.webm) or an HLS playlist (.m3u8). Elbi stores the link, not the file — nothing is downloaded until you ask for an offline copy.',
    }),
    el('label.field', {}, [el('span', { text: 'Video URL' }), urlInput]),
    targetSelect ? el('label.field', {}, [el('span', { text: 'Add to' }), targetSelect]) : null,
    attachTo || (targetSelect && targetSelect.value)
      ? null
      : el('label.field', {}, [el('span', { text: 'Title name' }), nameInput]),
    el('div.field-row', {}, [
      el('label.field', {}, [el('span', { text: 'Quality label' }), labelInput]),
      el('label.field', {}, [el('span', { text: 'Height in pixels (optional)' }), heightInput]),
    ]),
    el('button.btn.btn--primary', {
      type: 'button',
      onclick: async (e) => {
        const btn = e.currentTarget;
        const url = urlInput.value.trim();
        if (!url) return toast('Paste a URL first.', 'err');
        btn.disabled = true;
        clear(output);
        try {
          const height = Number(heightInput.value) || null;
          const source = {
            kind: 'url',
            url,
            label: labelInput.value.trim() || qualityLabel(height) || 'Stream',
            height,
          };
          let targetId = attachTo?.id || targetSelect?.value || '';
          if (!targetId) {
            const created = await api.createTitle({
              name: nameInput.value.trim() || guessNameFromUrl(url),
              origin: 'manual',
            });
            targetId = created.title.id;
          }
          const res = await api.addSource(targetId, source);
          upsertTitle(res.title);
          await refresh();
          output.append(el('div.note.note--ok', { text: 'Added. Open the title to play it.' }));
          if (attachTo) refreshDetail(attachTo.id);
          else {
            closeAdd();
            openDetail(targetId);
          }
        } catch (err) {
          output.append(el('div.note.note--bad', { text: err.message }));
        }
        btn.disabled = false;
        return undefined;
      },
    }, ['Add source']),
    output,
  ]);
}

function guessNameFromUrl(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'Stream');
    return cleanName(name);
  } catch {
    return 'Stream';
  }
}

// ---------------------------------------------------------------------------
// new / edit title

function titleForm(existing = null) {
  const name = el('input', { type: 'text', value: existing?.name || '', required: true });
  const year = el('input', { type: 'number', value: existing?.year ?? '', min: '1880', max: '2200' });
  const type = el('select', {}, [
    el('option', { value: 'movie', text: 'Movie', selected: existing?.type !== 'series' }),
    el('option', { value: 'series', text: 'Series', selected: existing?.type === 'series' }),
  ]);
  const genres = el('input', { type: 'text', value: (existing?.genres || []).join(', '), placeholder: 'Action, Sci-Fi' });
  const rating = el('input', { type: 'text', value: existing?.rating || '', placeholder: 'PG-13' });
  const runtime = el('input', { type: 'number', value: existing?.runtimeMin ?? '', min: '0', placeholder: 'minutes' });
  const overview = el('textarea', { text: existing?.overview || '' });
  const posterUrl = el('input', { type: 'text', value: existing?.poster || '', placeholder: 'https://… or upload below' });
  const backdropUrl = el('input', { type: 'text', value: existing?.backdrop || '', placeholder: 'https://… or upload below' });
  const output = el('div');

  const artInput = (target, label) => {
    const file = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    file.addEventListener('change', async () => {
      if (!file.files[0]) return;
      try {
        const res = await api.uploadArtwork(file.files[0]);
        target.value = res.url;
        toast('Image uploaded.', 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
      file.value = '';
    });
    return el('span', {}, [
      el('button.btn.btn--ghost.btn--sm', { type: 'button', onclick: () => file.click() }, [label]),
      file,
    ]);
  };

  const form = el('div', {}, [
    el('label.field', {}, [el('span', { text: 'Name' }), name]),
    el('div.field-row', {}, [
      el('label.field', {}, [el('span', { text: 'Year' }), year]),
      el('label.field', {}, [el('span', { text: 'Type' }), type]),
    ]),
    el('div.field-row', {}, [
      el('label.field', {}, [el('span', { text: 'Genres (comma separated)' }), genres]),
      el('label.field', {}, [el('span', { text: 'Rating' }), rating]),
    ]),
    el('label.field', {}, [el('span', { text: 'Runtime (minutes)' }), runtime]),
    el('label.field', {}, [el('span', { text: 'Overview' }), overview]),
    el('label.field', {}, [el('span', { text: 'Poster (portrait)' }), posterUrl]),
    artInput(posterUrl, 'Upload poster image'),
    el('label.field', { style: { marginTop: '.8rem' } }, [el('span', { text: 'Backdrop (landscape)' }), backdropUrl]),
    artInput(backdropUrl, 'Upload backdrop image'),
    output,
  ]);

  const collect = () => ({
    name: name.value.trim(),
    year: year.value ? Number(year.value) : null,
    type: type.value,
    genres: genres.value.split(',').map((g) => g.trim()).filter(Boolean),
    rating: rating.value.trim(),
    runtimeMin: runtime.value ? Number(runtime.value) : null,
    overview: overview.value.trim(),
    poster: posterUrl.value.trim() || null,
    backdrop: backdropUrl.value.trim() || null,
  });

  return { form, collect, output };
}

function newTitlePanel() {
  const { form, collect, output } = titleForm();
  return el('div', {}, [
    el('h3', { text: 'Create an empty title' }),
    el('p.muted', { text: 'Useful when you want the artwork and details in place before the video arrives.' }),
    form,
    el('button.btn.btn--primary', {
      type: 'button',
      onclick: async (e) => {
        const fields = collect();
        if (!fields.name) return toast('A name is required.', 'err');
        e.currentTarget.disabled = true;
        try {
          const res = await api.createTitle(fields);
          await refresh();
          closeAdd();
          openDetail(res.title.id);
          toast(`Created “${res.title.name}”.`, 'ok');
        } catch (err) {
          output.append(el('div.note.note--bad', { text: err.message }));
          e.currentTarget.disabled = false;
        }
        return undefined;
      },
    }, ['Create title']),
  ]);
}

export function openEditTitle(title) {
  const { form, collect, output } = titleForm(title);
  const body = clear($('#sheetBody'));
  body.append(el('div', {}, [
    el('h2', { text: `Edit “${title.name}”` }),
    form,
    el('div.row-gap', {}, [
      el('button.btn.btn--primary', {
        type: 'button',
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const res = await api.patchTitle(title.id, collect());
            upsertTitle(res.title);
            await refresh();
            closeSheet();
            refreshDetail(title.id);
            toast('Saved.', 'ok');
          } catch (err) {
            output.append(el('div.note.note--bad', { text: err.message }));
            e.currentTarget.disabled = false;
          }
        },
      }, ['Save']),
      el('button.btn.btn--ghost', { type: 'button', onclick: closeSheet }, ['Cancel']),
    ]),
  ]));
  openSheet();
}

// ---------------------------------------------------------------------------
// per-title helpers used by the detail sheet

export function openAddSource(title) {
  const body = clear($('#sheetBody'));
  const tabs = el('div.tabs');
  const host = el('div');

  const showFile = () => { clear(host).append(uploadPanel({ attachTo: title })); setActive('file'); };
  const showUrl = () => { clear(host).append(urlPanel({ attachTo: title })); setActive('url'); };

  const fileTab = el('button.tab.is-active', { type: 'button', onclick: showFile }, ['Upload a file']);
  const urlTab = el('button.tab', { type: 'button', onclick: showUrl }, ['Add a URL']);
  const setActive = (which) => {
    fileTab.classList.toggle('is-active', which === 'file');
    urlTab.classList.toggle('is-active', which === 'url');
  };
  tabs.append(fileTab, urlTab);

  body.append(el('h2', { text: `Add a source to “${title.name}”` }), tabs, host);
  showFile();
  openSheet();
}

export function openAddEpisode(title) {
  const season = el('input', { type: 'number', value: '1', min: '1' });
  const number = el('input', { type: 'number', value: String(nextEpisodeNumber(title, 1)), min: '1' });
  const name = el('input', { type: 'text', placeholder: 'Episode title' });
  const uploadHost = el('div');
  const output = el('div');

  season.addEventListener('change', () => {
    number.value = String(nextEpisodeNumber(title, Number(season.value) || 1));
  });

  const body = clear($('#sheetBody'));
  body.append(el('div', {}, [
    el('h2', { text: `Add an episode to “${title.name}”` }),
    el('div.field-row', {}, [
      el('label.field', {}, [el('span', { text: 'Season' }), season]),
      el('label.field', {}, [el('span', { text: 'Episode number' }), number]),
    ]),
    el('label.field', {}, [el('span', { text: 'Episode name' }), name]),
    el('button.btn.btn--primary', {
      type: 'button',
      onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          const res = await api.addEpisode(title.id, {
            season: Number(season.value) || 1,
            episode: Number(number.value) || 1,
            name: name.value.trim(),
          });
          upsertTitle(res.title);
          await refresh();
          refreshDetail(title.id);
          clear(uploadHost).append(
            el('p.muted', { text: 'Episode created. Now upload its video file:' }),
            uploadPanel({
              attachTo: titleById(title.id),
              episodeOf: { season: Number(season.value) || 1, number: Number(number.value) || 1, name: name.value.trim() },
            }),
          );
        } catch (err) {
          output.append(el('div.note.note--bad', { text: err.message }));
        }
        e.currentTarget.disabled = false;
      },
    }, ['Create episode']),
    output,
    uploadHost,
  ]));
  openSheet();
}

function nextEpisodeNumber(title, seasonNumber) {
  const season = (title.seasons || []).find((s) => s.number === seasonNumber);
  if (!season || !season.episodes.length) return 1;
  return Math.max(...season.episodes.map((e) => e.number)) + 1;
}

export function openSubtitleForm(title) {
  const file = el('input', { type: 'file', accept: '.srt,.vtt' });
  const label = el('input', { type: 'text', placeholder: 'English' });
  const lang = el('input', { type: 'text', placeholder: 'en', maxlength: '8' });
  const output = el('div');

  const episodes = (title.seasons || []).flatMap((s) => s.episodes.map((e) => ({
    id: e.id, label: `S${s.number}E${e.number} · ${e.name}`,
  })));
  const target = episodes.length
    ? el('select', {}, [
      el('option', { value: '', text: 'Whole title (all episodes)' }),
      ...episodes.map((e) => el('option', { value: e.id, text: e.label })),
    ])
    : null;

  const body = clear($('#sheetBody'));
  body.append(el('div', {}, [
    el('h2', { text: `Subtitles for “${title.name}”` }),
    el('p.muted', { text: '.srt files are converted to WebVTT automatically.' }),
    el('label.field', {}, [el('span', { text: 'Subtitle file' }), file]),
    el('div.field-row', {}, [
      el('label.field', {}, [el('span', { text: 'Label' }), label]),
      el('label.field', {}, [el('span', { text: 'Language code' }), lang]),
    ]),
    target ? el('label.field', {}, [el('span', { text: 'Attach to' }), target]) : null,
    el('button.btn.btn--primary', {
      type: 'button',
      onclick: async (e) => {
        if (!file.files[0]) return toast('Choose a .srt or .vtt file.', 'err');
        e.currentTarget.disabled = true;
        try {
          const res = await api.uploadSubtitle(title.id, file.files[0], {
            label: label.value.trim() || file.files[0].name,
            lang: lang.value.trim() || 'und',
            episodeId: target?.value || '',
          });
          upsertTitle(res.title);
          await refresh();
          closeSheet();
          refreshDetail(title.id);
          toast('Subtitles added.', 'ok');
        } catch (err) {
          output.append(el('div.note.note--bad', { text: err.message }));
          e.currentTarget.disabled = false;
        }
        return undefined;
      },
    }, ['Upload subtitles']),
    output,
  ]));
  openSheet();
}

// ---------------------------------------------------------------------------
// settings sheet

export function openSettings() {
  const body = clear($('#sheetBody'));
  const seek = el('input', { type: 'number', min: '1', max: '120', value: String(state.settings.seekStep) });
  const dbl = el('input', { type: 'number', min: '1', max: '120', value: String(state.settings.doubleClickSeek) });
  const rewind = el('input', {
    type: 'number', min: '0', max: '60', value: String(state.settings.resumeRewind ?? 5),
  });
  const autoplay = el('input', { type: 'checkbox', checked: state.settings.autoplayNext });
  const subSize = el('select', {}, [
    ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['huge', 'Huge'],
  ].map(([value, label]) => el('option', {
    value, text: label, selected: (state.settings.subtitleSize || 'medium') === value,
  })));
  const subBg = el('select', {}, [
    ['shadow', 'Drop shadow'], ['box', 'Black box'], ['none', 'None'],
  ].map(([value, label]) => el('option', {
    value, text: label, selected: (state.settings.subtitleBackground || 'shadow') === value,
  })));
  const subLang = el('select', {}, [
    ['alb', 'Albanian'], ['eng', 'English'], ['ita', 'Italian'], ['ger', 'German'],
    ['fre', 'French'], ['spa', 'Spanish'], ['gre', 'Greek'], ['tur', 'Turkish'],
    ['srp', 'Serbian'], ['mac', 'Macedonian'],
  ].map(([value, label]) => el('option', {
    value, text: label, selected: (state.settings.subtitleLanguage || 'alb') === value,
  })));
  const skipIntro = el('input', { type: 'checkbox', checked: state.settings.skipIntro !== false });
  const autoMatch = el('input', { type: 'checkbox', checked: state.settings.autoMatchMetadata !== false });

  body.append(el('div', {}, [
    el('h2', { text: 'Settings' }),
    el('div.field-row', {}, [
      el('label.field', {}, [el('span', { text: 'Arrow-key skip (seconds)' }), seek]),
      el('label.field', {}, [el('span', { text: 'Double-click skip (seconds)' }), dbl]),
    ]),
    el('label.field', {}, [
      el('span', { text: 'Rewind when resuming (seconds)' }),
      rewind,
    ]),
    el('p.muted', {
      style: { marginTop: '-.5rem', fontSize: '.82rem' },
      text: 'Stop at 27:47 and playback picks up at 27:42, so you catch the run-up instead of landing mid-sentence. Set to 0 to resume exactly where you stopped.',
    }),
    el('label.checkline', {}, [autoplay, el('span', { text: 'Autoplay the next episode' })]),

    el('h3', { text: 'Subtitles', style: { marginTop: '1.2rem', fontSize: '1rem' } }),
    el('p.muted', {
      text: 'Applies to every title. While watching, the subtitles menu also nudges timing with [ and ] when an .srt runs out of sync.',
    }),
    el('div.field-row', {}, [
      el('label.field', {}, [el('span', { text: 'Text size' }), subSize]),
      el('label.field', {}, [el('span', { text: 'Background' }), subBg]),
    ]),
    el('label.field', {}, [el('span', { text: 'Language to search for' }), subLang]),
    el('p.muted', {
      style: { marginTop: '-.5rem', fontSize: '.82rem' },
      text: 'Used by “Find subtitles online”, which searches opensubtitles.org. Downloads are converted to WebVTT and re-encoded to UTF-8, so Albanian ë and ç survive.',
    }),

    el('h3', { text: 'Skip intro & posters', style: { marginTop: '1.2rem', fontSize: '1rem' } }),
    el('label.checkline', {}, [skipIntro, el('span', { text: 'Show a “Skip intro” button over marked intros' })]),
    el('p.muted', {
      style: { marginTop: '-.35rem', fontSize: '.82rem' },
      text: 'Mark an intro from the player’s ⋮ menu (or Shift+I): once at its first frame, once at its last. On a series you can then apply it to the whole season.',
    }),
    el('label.checkline', {}, [autoMatch, el('span', { text: 'Look up posters and details for newly imported titles' })]),
    el('p.muted', {
      style: { marginTop: '-.35rem', fontSize: '.82rem' },
      text: state.server.metadataProvider === 'tmdb'
        ? 'Matching against TMDB.'
        : 'No TMDB key is set on this server, so matches come from Wikipedia and Wikidata — keyless, but the posters are lower resolution. Set ELBI_TMDB_KEY to use TMDB.',
    }),

    el('h3', { text: 'Keyboard shortcuts', style: { marginTop: '1.2rem', fontSize: '1rem' } }),
    el('div.sourcelist', {}, [
      ['Space / K', 'Play or pause'],
      ['← / →', `Skip ${state.settings.seekStep}s back or forward`],
      ['Double-click left / right', `Skip ${state.settings.doubleClickSeek}s back or forward`],
      ['Double-click centre', 'Fullscreen'],
      ['J / L', 'Skip 10s'],
      ['↑ / ↓', 'Volume'],
      ['0 – 9', 'Jump to 0 % – 90 %'],
      [', / .', 'Previous / next frame'],
      ['< / >', 'Slower / faster'],
      ['M', 'Mute'], ['F', 'Fullscreen'], ['I', 'Picture-in-picture'],
      ['Shift + I', 'Mark intro start, then intro end'],
      ['C', 'Cycle subtitles'], ['[ / ]', 'Nudge subtitle timing'],
      ['Q', 'Cycle quality'], ['N', 'Next episode'],
      ['S', 'Stats for nerds'], ['Esc', 'Leave the player'],
    ].map(([keys, what]) => el('div.sourceitem', {}, [
      el('div.sourceitem__main', {}, [el('div.sourceitem__name', { text: keys })]),
      el('span.muted', { text: what }),
    ]))),

    el('h3', { text: 'What this browser can play', style: { marginTop: '1.2rem', fontSize: '1rem' } }),
    el('p.muted', { text: 'Elbi streams files as they are, so playback depends on your browser’s decoders.' }),
    el('div.row-gap', {}, Object.entries(browserCodecs()).map(([name, ok]) => el(
      ok ? 'span.pill.pill--ok' : 'span.pill.pill--bad',
      { text: `${name} ${ok ? '✓' : '✕'}` },
    ))),
    browserCodecs().h264 ? null : el('div.note.note--bad', {
      text: 'This browser has no H.264 decoder, so most .mp4 files will not play here. Chrome, Edge, Safari and Firefox normally do — some Linux Chromium builds ship without it.',
    }),

    el('h3', { text: 'This server', style: { marginTop: '1.2rem', fontSize: '1rem' } }),
    el('dl.detail__facts', {}, [
      el('dt', { text: 'Media folder' }), el('dd', { text: state.server.mediaDir || '—' }),
      el('dt', { text: 'Uploads land in' }), el('dd', { text: state.server.uploadsDir || '—' }),
      el('dt', { text: 'Scannable folders' }), el('dd', { text: (state.server.scanRoots || []).join(', ') || '—' }),
      el('dt', { text: 'Password' }), el('dd', { text: state.server.authRequired ? 'enabled' : 'not set' }),
      el('dt', { text: 'Remote streaming' }), el('dd', { text: state.server.allowRemote ? 'enabled' : 'disabled' }),
    ]),

    el('div.row-gap', { style: { marginTop: '1.2rem' } }, [
      el('button.btn.btn--primary', {
        type: 'button',
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const res = await api.patchSettings({
              seekStep: Number(seek.value),
              doubleClickSeek: Number(dbl.value),
              resumeRewind: Number(rewind.value),
              autoplayNext: autoplay.checked,
              subtitleSize: subSize.value,
              subtitleBackground: subBg.value,
              subtitleLanguage: subLang.value,
              skipIntro: skipIntro.checked,
              autoMatchMetadata: autoMatch.checked,
            });
            state.settings = res.settings;
            // Cue styling is injected at runtime, so refresh it immediately.
            applySubtitleStyleNow();
            closeSheet();
            toast('Settings saved.', 'ok');
          } catch (err) {
            toast(err.message, 'err');
            e.currentTarget.disabled = false;
          }
        },
      }, ['Save settings']),
      state.server.authRequired ? el('button.btn.btn--ghost', {
        type: 'button',
        onclick: async () => { await api.logout(); location.reload(); },
      }, ['Sign out']) : null,
    ]),
  ]));
  openSheet();
}
