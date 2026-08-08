import { $, el, clear, formatTime, formatBytes, qualityLabel, toast, codecDiagnosis, browserCodecs } from './util.js';
import { api, streamUrl, subtitleUrl } from './api.js';
import {
  state, playablesOf, progressFor, savedVolume, saveVolume, savedMuted, emit,
} from './state.js';
import { isSourceOffline } from './offline.js';

const dom = {};
let bound = false;

/** Everything about the current playback session. */
const session = {
  title: null,
  item: null,          // the playable (movie or episode)
  sources: [],
  sourceIndex: 0,
  queue: [],           // playables of this title, for "next episode"
  queueIndex: 0,
  pendingSeek: null,
  saveTimer: null,
  idleTimer: null,
  fps: { value: null, last: null, samples: [] },
  frameCbHandle: null,
  upnextTimer: null,
  lastTap: { time: 0, zone: null, count: 0 },
  tapTimer: null,
  seekBurst: { zone: null, amount: 0, timer: null },
  scrubbing: false,
  active: false,
  failed: new Set(),   // sources this browser has already refused to decode
};

function cache() {
  if (dom.root) return dom;
  Object.assign(dom, {
    root: $('#player'),
    video: $('#video'),
    ui: $('#playerUi'),
    zones: $('.player__zones'),
    spinner: $('#playerSpinner'),
    toast: $('#playerToast'),
    error: $('#playerError'),
    errorText: $('#playerErrorText'),
    errorSwitch: $('#playerErrorSwitch'),
    errorClose: $('#playerErrorClose'),
    title: $('#playerTitle'),
    subtitle: $('#playerSubtitle'),
    back: $('#playerBack'),
    scrub: $('#scrub'),
    scrubInput: $('#scrubInput'),
    scrubPlayed: $('#scrubPlayed'),
    scrubBuffer: $('#scrubBuffer'),
    scrubTip: $('#scrubTip'),
    btnPlay: $('#btnPlay'),
    btnBack: $('#btnBack'),
    btnFwd: $('#btnFwd'),
    btnMute: $('#btnMute'),
    btnFull: $('#btnFull'),
    btnPip: $('#btnPip'),
    btnNext: $('#btnNext'),
    volInput: $('#volInput'),
    timeNow: $('#timeNow'),
    timeTotal: $('#timeTotal'),
    qualityLabel: $('#qualityLabel'),
    menus: {
      quality: $('#menuQuality'),
      subs: $('#menuSubs'),
      more: $('#menuMore'),
    },
    stats: $('#statsPanel'),
    statsBody: $('#statsBody'),
    statsClose: $('#statsClose'),
    upnext: $('#upnext'),
    upnextTitle: $('#upnextTitle'),
    upnextPlay: $('#upnextPlay'),
    upnextCancel: $('#upnextCancel'),
    upnextCount: $('#upnextCount'),
  });
  return dom;
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24" class="icon"><path d="M8 5v14l11-7L8 5Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" class="icon"><path d="M6 5h4v14H6V5Zm8 0h4v14h-4V5Z"/></svg>',
  replay: '<svg viewBox="0 0 24 24" class="icon"><path d="M12 5V1L7 6l5 5V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z"/></svg>',
  volHigh: '<svg viewBox="0 0 24 24" class="icon"><path d="M4 9v6h4l5 4V5L8 9H4Zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4Zm-2.5 7.9A8 8 0 0 0 20 12a8 8 0 0 0-6-7.7v2.1A6 6 0 0 1 18 12a6 6 0 0 1-4 5.7v2.2Z"/></svg>',
  volLow: '<svg viewBox="0 0 24 24" class="icon"><path d="M4 9v6h4l5 4V5L8 9H4Zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4Z"/></svg>',
  volMute: '<svg viewBox="0 0 24 24" class="icon"><path d="M4 9v6h4l5 4V5L8 9H4Zm17.5-1.1L20.1 6.5 17.6 9l-2.5-2.5-1.4 1.4L16.2 10.4l-2.5 2.5 1.4 1.4 2.5-2.5 2.5 2.5 1.4-1.4-2.5-2.5 2.5-2.5Z"/></svg>',
  // The step count rides alongside as text, so it stays legible at 22px.
  back: '<svg viewBox="0 0 24 24" class="icon"><path d="M12 5V1L7 6l5 5V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z"/></svg>',
  fwd: '<svg viewBox="0 0 24 24" class="icon"><path d="M12 5V1l5 5-5 5V7a5 5 0 1 0 5 5h2a7 7 0 1 1-7-7Z"/></svg>',
  full: '<svg viewBox="0 0 24 24" class="icon"><path d="M4 9V4h5v2H6v3H4Zm11-5h5v5h-2V6h-3V4ZM4 15h2v3h3v2H4v-5Zm14 0h2v5h-5v-2h3v-3Z"/></svg>',
  exitFull: '<svg viewBox="0 0 24 24" class="icon"><path d="M9 4h2v5H6V7h3V4Zm4 0h2v3h3v2h-5V4ZM6 15h5v5H9v-3H6v-2Zm7 0h5v2h-3v3h-2v-5Z"/></svg>',
};

const seekStep = () => Number(state.settings?.seekStep) || 5;
const tapStep = () => Number(state.settings?.doubleClickSeek) || 5;

// ---------------------------------------------------------------------------
// public entry point

/**
 * Open the player.
 * @param {object} opts { title, item?, sourceId?, startAt? }
 */
export async function play({ title, item, sourceId, startAt }) {
  cache();
  if (!bound) bindEvents();

  const queue = playablesOf(title);
  const target = item || queue[0];
  if (!target) return toast('This title has no episodes yet.', 'err');
  if (!target.sources.length) return toast('This title has no video source yet — add one first.', 'err');

  session.title = title;
  session.item = target;
  session.queue = queue;
  session.queueIndex = Math.max(0, queue.findIndex((p) => (p.episodeId || null) === (target.episodeId || null)));
  session.sources = rankSources(target.sources);
  session.active = true;
  session.upnextDismissed = false;
  session.failed = new Set();
  dom.upnext.hidden = true;

  const preferred = sourceId
    ? session.sources.findIndex((s) => s.id === sourceId)
    : pickDefaultSource(session.sources);
  session.sourceIndex = preferred >= 0 ? preferred : 0;

  const saved = progressFor(target.titleId, target.episodeId);
  const resumeAt = Number.isFinite(startAt) ? startAt : (saved && !saved.finished ? saved.position : 0);

  dom.root.hidden = false;
  document.body.classList.add('is-playing');
  hideError();
  renderChrome();
  await loadSource(session.sourceIndex, resumeAt, true);
  showUi();
  return undefined;
}

export function isOpen() {
  return session.active;
}

export function close() {
  if (!session.active) return;
  saveProgress(true);
  stopFpsLoop();
  clearTimeout(session.upnextTimer);
  clearInterval(session.saveTimer);
  session.saveTimer = null;
  dom.video.pause();
  dom.video.removeAttribute('src');
  dom.video.load();
  clearTracks();
  dom.root.hidden = true;
  dom.upnext.hidden = true;
  document.body.classList.remove('is-playing');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  session.active = false;
  session.title = null;
  session.item = null;
  emit();
}

// ---------------------------------------------------------------------------
// source handling

const SUPPORT_TIER = { direct: 0, adaptive: 1, maybe: 2, unsupported: 3 };

/** Sources the browser can definitely decode come first, then by resolution. */
function rankSources(sources) {
  return [...sources].sort((a, b) => {
    const ta = SUPPORT_TIER[a.playability?.level] ?? 2;
    const tb = SUPPORT_TIER[b.playability?.level] ?? 2;
    if (ta !== tb) return ta - tb;
    return (b.height || 0) - (a.height || 0);
  });
}

function pickDefaultSource(sources) {
  const offline = sources.findIndex((s) => isSourceOffline(session.title.id, s.id));
  if (offline >= 0) return offline;
  return 0; // rankSources already put the most playable first
}

function currentSource() {
  return session.sources[session.sourceIndex] || null;
}

async function loadSource(index, seekTo = 0, initial = false) {
  const source = session.sources[index];
  if (!source) return;
  session.sourceIndex = index;

  const wasPlaying = initial ? true : !dom.video.paused;
  session.pendingSeek = seekTo > 0 ? seekTo : null;

  clearTracks();
  stopFpsLoop();
  session.fps = { value: null, last: null, samples: [] };
  hideError();

  const src = streamUrl(session.title.id, source.id);

  if (source.streamType === 'hls' && !canPlayHlsNatively()) {
    const ok = await attachHls(src);
    if (!ok) return;
  } else {
    detachHls();
    dom.video.src = src;
  }

  dom.video.volume = savedVolume();
  dom.video.muted = savedMuted();
  dom.volInput.value = String(dom.video.volume);
  dom.video.load();

  attachTracks();
  renderChrome();

  if (wasPlaying) {
    dom.video.play().catch((err) => {
      // Autoplay with sound is blocked until the user interacts; retry muted.
      if (err?.name === 'NotAllowedError') {
        dom.video.muted = true;
        dom.video.play().catch(() => {});
        flash('Started muted — press M for sound');
      }
    });
  }
  return undefined;
}

function canPlayHlsNatively() {
  return dom.video.canPlayType('application/vnd.apple.mpegurl') !== '';
}

let hls = null;
async function attachHls(src) {
  try {
    if (!window.Hls) {
      // Optional drop-in: put hls.js at public/vendor/hls.js to enable HLS
      // in Chrome/Firefox. Absent, we say so instead of showing a black screen.
      await import('/vendor/hls.js');
    }
    if (!window.Hls?.isSupported?.()) throw new Error('unsupported');
    detachHls();
    hls = new window.Hls({ enableWorker: true });
    hls.loadSource(src);
    hls.attachMedia(dom.video);
    return true;
  } catch {
    showError(
      'This is an HLS stream (.m3u8) and your browser cannot play it natively. '
      + 'Safari can; for Chrome or Firefox, drop hls.js into public/vendor/hls.js and reload.',
    );
    return false;
  }
}

function detachHls() {
  if (hls) {
    try { hls.destroy(); } catch { /* ignore */ }
    hls = null;
  }
}

function clearTracks() {
  for (const track of [...dom.video.querySelectorAll('track')]) track.remove();
}

function attachTracks() {
  const subs = session.item.subtitles || [];
  subs.forEach((sub, i) => {
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = sub.label || `Track ${i + 1}`;
    track.srclang = sub.lang || 'und';
    track.src = subtitleUrl(session.title.id, sub.id);
    dom.video.append(track);
  });
  // Nothing is shown until the user picks a track from the menu.
  requestAnimationFrame(() => {
    for (const track of dom.video.textTracks) track.mode = 'disabled';
  });
}

// ---------------------------------------------------------------------------
// chrome rendering

function renderChrome() {
  const { title, item } = session;
  if (!title) return;
  dom.title.textContent = title.name;
  dom.subtitle.textContent = item.episodeId
    ? `S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')} · ${item.name}`
    : [title.year, title.rating].filter(Boolean).join(' · ');

  const source = currentSource();
  dom.qualityLabel.textContent = source
    ? (source.label || qualityLabel(source.height) || 'Source')
    : '—';

  dom.btnBack.innerHTML = `${ICONS.back}<span class="chiplabel">${seekStep()}</span>`;
  dom.btnFwd.innerHTML = `${ICONS.fwd}<span class="chiplabel">${seekStep()}</span>`;
  dom.btnBack.title = `Back ${seekStep()} seconds (← or double-click the left of the picture)`;
  dom.btnFwd.title = `Forward ${seekStep()} seconds (→ or double-click the right of the picture)`;
  dom.btnPlay.innerHTML = dom.video.paused ? ICONS.play : ICONS.pause;
  dom.btnFull.innerHTML = document.fullscreenElement ? ICONS.exitFull : ICONS.full;
  updateVolumeIcon();

  const next = session.queue[session.queueIndex + 1];
  dom.btnNext.hidden = !next;

  buildQualityMenu();
  buildSubsMenu();
  buildMoreMenu();
}

function buildQualityMenu() {
  const panel = dom.menus.quality.querySelector('[data-menu-panel]');
  clear(panel);
  panel.append(el('div.menu__label', { text: 'Quality / source' }));

  session.sources.forEach((source, i) => {
    const bits = [];
    if (source.width && source.height) bits.push(`${source.width}×${source.height}`);
    if (source.fps) bits.push(`${Math.round(source.fps)} fps`);
    if (source.size) bits.push(formatBytes(source.size));
    if (source.kind === 'url') bits.push(source.remoteHost || 'remote');
    if (isSourceOffline(session.title.id, source.id)) bits.push('offline ✓');

    const item = el('button.menu__item', {
      type: 'button',
      onclick: () => {
        closeMenus();
        if (i === session.sourceIndex) return;
        const at = dom.video.currentTime;
        loadSource(i, at);
        flash(`Quality: ${source.label || qualityLabel(source.height) || 'source'}`);
      },
    }, [
      el('span', {}, [
        el('strong', { text: source.label || qualityLabel(source.height) || `Source ${i + 1}` }),
        bits.length ? el('br') : null,
        bits.length ? el('small', { text: bits.join(' · ') }) : null,
      ]),
      i === session.sourceIndex ? el('span', { text: '✓' }) : null,
    ]);
    if (i === session.sourceIndex) item.classList.add('is-active');
    if (source.playability?.level === 'unsupported') {
      item.append(el('span.pill.pill--bad', { text: '!' }));
      item.title = source.playability.note;
    }
    panel.append(item);
  });

  if (session.sources.length < 2) {
    panel.append(el('div.menu__sep'));
    panel.append(el('div.menu__label', {
      text: 'Add another file to the same title to switch resolutions here.',
      style: { textTransform: 'none', letterSpacing: '0' },
    }));
  }
}

function buildSubsMenu() {
  const panel = dom.menus.subs.querySelector('[data-menu-panel]');
  clear(panel);
  panel.append(el('div.menu__label', { text: 'Subtitles' }));

  const tracks = [...dom.video.textTracks];
  const off = el('button.menu__item', {
    type: 'button',
    onclick: () => {
      for (const t of dom.video.textTracks) t.mode = 'disabled';
      closeMenus();
      buildSubsMenu();
      flash('Subtitles off');
    },
  }, [el('span', { text: 'Off' })]);
  if (!tracks.some((t) => t.mode === 'showing')) off.classList.add('is-active');
  panel.append(off);

  tracks.forEach((track, i) => {
    const item = el('button.menu__item', {
      type: 'button',
      onclick: () => {
        for (const t of dom.video.textTracks) t.mode = 'disabled';
        track.mode = 'showing';
        closeMenus();
        buildSubsMenu();
        flash(`Subtitles: ${track.label}`);
      },
    }, [el('span', { text: track.label || `Track ${i + 1}` })]);
    if (track.mode === 'showing') item.classList.add('is-active');
    panel.append(item);
  });

  if (!tracks.length) {
    panel.append(el('div.menu__label', {
      text: 'No subtitle tracks. Add .srt or .vtt from the title page.',
      style: { textTransform: 'none', letterSpacing: '0' },
    }));
  }
}

function buildMoreMenu() {
  const panel = dom.menus.more.querySelector('[data-menu-panel]');
  clear(panel);

  panel.append(el('div.menu__label', { text: 'Playback speed' }));
  for (const rate of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
    const item = el('button.menu__item', {
      type: 'button',
      onclick: () => {
        dom.video.playbackRate = rate;
        closeMenus();
        buildMoreMenu();
        flash(`Speed ${rate}×`);
      },
    }, [el('span', { text: rate === 1 ? 'Normal' : `${rate}×` })]);
    if (Math.abs(dom.video.playbackRate - rate) < 0.01) item.classList.add('is-active');
    panel.append(item);
  }

  panel.append(el('div.menu__sep'));
  panel.append(el('div.menu__label', { text: 'Skip amount' }));
  for (const step of [5, 10, 15, 30]) {
    const item = el('button.menu__item', {
      type: 'button',
      onclick: async () => {
        closeMenus();
        state.settings.seekStep = step;
        state.settings.doubleClickSeek = step;
        renderChrome();
        flash(`Skip ${step}s`);
        await api.patchSettings({ seekStep: step, doubleClickSeek: step }).catch(() => {});
      },
    }, [el('span', { text: `${step} seconds` })]);
    if (seekStep() === step) item.classList.add('is-active');
    panel.append(item);
  }

  panel.append(el('div.menu__sep'));
  panel.append(el('button.menu__item', {
    type: 'button',
    onclick: () => { closeMenus(); toggleStats(); },
  }, [el('span', { text: 'Stats for nerds' }), el('small', { text: 'S' })]));

  const source = currentSource();
  if (source?.kind === 'file') {
    panel.append(el('a.menu__item', {
      href: streamUrl(session.title.id, source.id, { download: true }),
      download: '',
      onclick: () => closeMenus(),
    }, [el('span', { text: 'Download this file' })]));
  }
}

// ---------------------------------------------------------------------------
// transport

function togglePlay() {
  if (dom.video.ended) {
    dom.video.currentTime = 0;
    dom.video.play().catch(() => {});
    return;
  }
  if (dom.video.paused) dom.video.play().catch(() => {});
  else dom.video.pause();
}

function seekBy(delta) {
  const duration = Number.isFinite(dom.video.duration) ? dom.video.duration : null;
  const target = dom.video.currentTime + delta;
  dom.video.currentTime = Math.max(0, duration ? Math.min(duration - 0.25, target) : target);
}

function seekTo(seconds) {
  const duration = Number.isFinite(dom.video.duration) ? dom.video.duration : null;
  dom.video.currentTime = Math.max(0, duration ? Math.min(duration - 0.25, seconds) : seconds);
}

function setVolume(value) {
  const v = Math.min(1, Math.max(0, value));
  dom.video.volume = v;
  if (v > 0) dom.video.muted = false;
  dom.volInput.value = String(v);
  saveVolume(v, dom.video.muted);
  updateVolumeIcon();
}

function updateVolumeIcon() {
  const v = dom.video.muted ? 0 : dom.video.volume;
  dom.btnMute.innerHTML = v === 0 ? ICONS.volMute : v < 0.5 ? ICONS.volLow : ICONS.volHigh;
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await dom.root.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    flash('Fullscreen was refused by the browser');
  }
  dom.btnFull.innerHTML = document.fullscreenElement ? ICONS.exitFull : ICONS.full;
}

async function togglePip() {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await dom.video.requestPictureInPicture();
  } catch {
    flash('Picture-in-picture is not available here');
  }
}

function playNext(auto = false) {
  const next = session.queue[session.queueIndex + 1];
  if (!next) return;
  dom.upnext.hidden = true;
  clearTimeout(session.upnextTimer);
  if (!next.sources.length) {
    flash('The next episode has no video file yet');
    return;
  }
  play({ title: session.title, item: next, startAt: 0 });
  if (auto) flash('Playing next episode');
}

// ---------------------------------------------------------------------------
// progress

function saveProgress(force = false) {
  const { title, item } = session;
  if (!title || !item) return;
  const position = dom.video.currentTime;
  const duration = Number.isFinite(dom.video.duration) ? dom.video.duration : 0;
  if (!duration || (!force && position < 3)) return;

  const payload = {
    profileId: state.activeProfile,
    titleId: title.id,
    episodeId: item.episodeId,
    sourceId: currentSource()?.id || null,
    position,
    duration,
  };

  // A page being closed can't await fetch; sendBeacon survives unload.
  if (force && navigator.sendBeacon) {
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    if (navigator.sendBeacon('/api/progress', blob)) {
      applyLocalProgress(payload);
      return;
    }
  }
  api.saveProgress(payload)
    .then((res) => { state.progress = res.progress || state.progress; emit(); })
    .catch(() => applyLocalProgress(payload));
}

function applyLocalProgress({ titleId, episodeId, position, duration, sourceId }) {
  const key = `${titleId}:${episodeId || '-'}`;
  const finished = duration > 0 && position >= Math.max(duration * 0.96, duration - 90);
  state.progress[key] = { position, duration, sourceId, finished, updatedAt: Date.now() };
  emit();
}

// ---------------------------------------------------------------------------
// stats + fps

function toggleStats() {
  dom.stats.hidden = !dom.stats.hidden;
  if (!dom.stats.hidden) renderStats();
}

let statsTimer = null;
function renderStats() {
  clearTimeout(statsTimer);
  if (dom.stats.hidden || !session.active) return;

  const video = dom.video;
  const source = currentSource();
  const quality = video.getVideoPlaybackQuality?.() || {};
  const buffered = bufferedAhead();
  const declared = source?.height ? `${source.width || '?'}×${source.height}` : '—';

  const rows = [
    ['Title', session.title?.name || '—'],
    ['Source', source?.label || '—'],
    ['Origin', source?.kind === 'url' ? (source.remoteHost || 'remote') : (source?.filename || 'local file')],
    ['Container', source?.mime || '—'],
    ['Resolution', video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : 'unknown'],
    ['Declared', declared],
    ['Frame rate', session.fps.value ? `${session.fps.value.toFixed(2)} fps` : (source?.fps ? `${source.fps} fps (stored)` : 'measuring…')],
    ['Dropped frames', quality.droppedVideoFrames !== undefined
      ? `${quality.droppedVideoFrames} of ${quality.totalVideoFrames}` : 'n/a'],
    ['Playback rate', `${video.playbackRate}×`],
    ['Volume', video.muted ? 'muted' : `${Math.round(video.volume * 100)}%`],
    ['Position', `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`],
    ['Buffer ahead', buffered === null ? '—' : `${buffered.toFixed(1)}s`],
    ['Avg bitrate', avgBitrate(source, video.duration)],
    ['Offline copy', source && isSourceOffline(session.title.id, source.id) ? 'yes' : 'no'],
    ['Network', networkLabel(video)],
    ['Browser codecs', Object.entries(browserCodecs())
      .filter(([, ok]) => ok).map(([name]) => name).join(' ') || 'none detected'],
  ];

  clear(dom.statsBody);
  for (const [key, value] of rows) {
    dom.statsBody.append(el('dt', { text: key }), el('dd', { text: String(value) }));
  }
  statsTimer = setTimeout(renderStats, 500);
}

function avgBitrate(source, duration) {
  if (!source?.size || !Number.isFinite(duration) || duration <= 0) return '—';
  const bps = (source.size * 8) / duration;
  return bps > 1e6 ? `${(bps / 1e6).toFixed(2)} Mbps` : `${Math.round(bps / 1e3)} kbps`;
}

function bufferedAhead() {
  const { buffered, currentTime } = dom.video;
  for (let i = 0; i < buffered.length; i += 1) {
    if (currentTime >= buffered.start(i) && currentTime <= buffered.end(i)) {
      return buffered.end(i) - currentTime;
    }
  }
  return null;
}

function networkLabel(video) {
  const states = ['empty', 'idle', 'loading', 'no source'];
  const ready = ['nothing', 'metadata', 'current data', 'future data', 'enough data'];
  return `${states[video.networkState] ?? '?'} / ${ready[video.readyState] ?? '?'}`;
}

/**
 * Continuously measure the presented frame rate. This is the real number the
 * browser is painting, not a value read from a container header.
 */
function startFpsLoop() {
  if (typeof dom.video.requestVideoFrameCallback !== 'function') return;
  stopFpsLoop();
  const step = (_now, meta) => {
    const prev = session.fps.last;
    session.fps.last = meta;
    if (prev) {
      const dt = meta.mediaTime - prev.mediaTime;
      const df = (meta.presentedFrames ?? 0) - (prev.presentedFrames ?? 0);
      if (dt > 0 && df > 0 && dt < 1) {
        const instant = df / dt;
        if (instant > 1 && instant < 480) {
          session.fps.samples.push(instant);
          if (session.fps.samples.length > 90) session.fps.samples.shift();
          const sorted = [...session.fps.samples].sort((a, b) => a - b);
          session.fps.value = sorted[Math.floor(sorted.length / 2)]; // median resists stutter
        }
      }
    }
    session.frameCbHandle = dom.video.requestVideoFrameCallback(step);
  };
  session.frameCbHandle = dom.video.requestVideoFrameCallback(step);
}

function stopFpsLoop() {
  if (session.frameCbHandle && typeof dom.video?.cancelVideoFrameCallback === 'function') {
    dom.video.cancelVideoFrameCallback(session.frameCbHandle);
  }
  session.frameCbHandle = null;
  session.fps.last = null;
}

// ---------------------------------------------------------------------------
// UI feedback

let flashTimer = null;
function flash(message) {
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { dom.toast.hidden = true; }, 1400);
}

function showError(message) {
  dom.errorText.textContent = message;
  dom.error.hidden = false;
  dom.errorSwitch.hidden = session.sources.length < 2;
  dom.spinner.hidden = true;
}
function hideError() {
  dom.error.hidden = true;
}

function showUi() {
  dom.root.classList.remove('is-idle');
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    if (!dom.video.paused && !session.scrubbing && !anyMenuOpen()) {
      dom.root.classList.add('is-idle');
      closeMenus();
    }
  }, 2800);
}

function anyMenuOpen() {
  return Object.values(dom.menus).some((menu) => !menu.querySelector('[data-menu-panel]').hidden);
}

function closeMenus() {
  for (const menu of Object.values(dom.menus)) {
    menu.querySelector('[data-menu-panel]').hidden = true;
  }
}

// ---------------------------------------------------------------------------
// double-tap seeking

function handleZoneTap(zone, event) {
  const now = performance.now();
  const isDouble = now - session.lastTap.time < 320 && session.lastTap.zone === zone;

  if (isDouble) {
    clearTimeout(session.tapTimer);
    session.lastTap = { time: now, zone, count: session.lastTap.count + 1 };
    if (zone === 'mid') {
      toggleFullscreen();
    } else {
      const amount = zone === 'back' ? -tapStep() : tapStep();
      seekBy(amount);
      showRipple(zone, amount, event);
    }
    return;
  }

  session.lastTap = { time: now, zone, count: 1 };
  clearTimeout(session.tapTimer);
  // Wait out the double-tap window before treating it as a single tap.
  session.tapTimer = setTimeout(() => {
    if (matchMedia('(hover: none)').matches) {
      // Touch: a single tap just toggles the controls.
      if (dom.root.classList.contains('is-idle')) showUi();
      else dom.root.classList.add('is-idle');
    } else {
      togglePlay();
    }
    session.seekBurst.amount = 0;
  }, 260);
}

/** Accumulate repeated taps the way mobile players do: -5, -10, -15… */
function showRipple(zone, amount, event) {
  const node = dom.zones.querySelector(zone === 'back' ? '.zone--left' : '.zone--right');
  if (!node) return;

  if (session.seekBurst.zone === zone) session.seekBurst.amount += amount;
  else session.seekBurst = { zone, amount, timer: null };

  const label = node.querySelector('.zone__label');
  label.textContent = `${session.seekBurst.amount > 0 ? '+' : ''}${session.seekBurst.amount}s`;

  node.classList.remove('is-hit');
  void node.offsetWidth; // restart the CSS animation
  node.classList.add('is-hit');

  clearTimeout(session.seekBurst.timer);
  session.seekBurst.timer = setTimeout(() => {
    session.seekBurst = { zone: null, amount: 0, timer: null };
    node.classList.remove('is-hit');
  }, 900);

  if (event) showUi();
}

// ---------------------------------------------------------------------------
// event wiring

function bindEvents() {
  bound = true;
  const video = dom.video;

  video.addEventListener('loadedmetadata', () => {
    dom.timeTotal.textContent = formatTime(video.duration);
    if (session.pendingSeek) {
      seekTo(session.pendingSeek);
      session.pendingSeek = null;
    }
    renderChrome();
  });

  video.addEventListener('play', () => {
    dom.btnPlay.innerHTML = ICONS.pause;
    startFpsLoop();
    showUi();
    if (!session.saveTimer) session.saveTimer = setInterval(() => saveProgress(), 5000);
  });

  video.addEventListener('pause', () => {
    dom.btnPlay.innerHTML = ICONS.play;
    dom.root.classList.remove('is-idle');
    saveProgress();
  });

  video.addEventListener('timeupdate', () => {
    if (session.scrubbing) return;
    const { currentTime, duration } = video;
    dom.timeNow.textContent = formatTime(currentTime);
    if (Number.isFinite(duration) && duration > 0) {
      const pct = (currentTime / duration) * 100;
      dom.scrubPlayed.style.width = `${pct}%`;
      dom.scrubInput.value = String(Math.round((currentTime / duration) * 1000));
      maybeOfferNext(currentTime, duration);
    }
  });

  video.addEventListener('progress', () => {
    const { buffered, duration } = video;
    if (!buffered.length || !Number.isFinite(duration) || !duration) return;
    dom.scrubBuffer.style.width = `${(buffered.end(buffered.length - 1) / duration) * 100}%`;
  });

  video.addEventListener('waiting', () => { dom.spinner.hidden = false; });
  video.addEventListener('canplay', () => { dom.spinner.hidden = true; });
  video.addEventListener('playing', () => { dom.spinner.hidden = true; hideError(); });
  video.addEventListener('ratechange', buildMoreMenu);
  video.addEventListener('volumechange', () => {
    updateVolumeIcon();
    dom.volInput.value = String(video.muted ? 0 : video.volume);
    saveVolume(video.volume, video.muted);
  });

  video.addEventListener('ended', () => {
    saveProgress(true);
    dom.btnPlay.innerHTML = ICONS.replay;
    const next = session.queue[session.queueIndex + 1];
    if (next && state.settings.autoplayNext) startUpNextCountdown(next);
  });

  video.addEventListener('error', () => {
    const source = currentSource();
    const code = video.error?.code;
    const reasons = {
      1: 'Loading was aborted.',
      2: 'The network dropped while loading this file.',
      3: 'The file could not be decoded — the codec inside is not one this browser supports.',
      4: 'This file format is not supported by your browser.',
    };

    // A decode failure on one rendition is not a dead end when the title has
    // others: try the next one automatically before bothering the viewer.
    if ((code === 3 || code === 4) && session.sources.length > 1) {
      const untried = session.sources.findIndex((s, i) => i !== session.sourceIndex && !session.failed.has(s.id));
      session.failed.add(source?.id);
      if (untried >= 0) {
        const at = video.currentTime || session.pendingSeek || 0;
        flash(`${source?.label || 'That source'} won't decode — trying ${session.sources[untried].label}`);
        loadSource(untried, at);
        return;
      }
    }

    // Prefer a concrete explanation over the browser's generic message.
    const diagnosis = codecDiagnosis(source);
    const hint = diagnosis || source?.playability?.note || '';
    showError(`${reasons[code] || 'Playback failed.'}${hint ? ` ${hint}` : ''}`);
  });

  // --- zones (single/double tap) -------------------------------------------
  for (const node of dom.zones.querySelectorAll('[data-zone]')) {
    node.addEventListener('pointerup', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      handleZoneTap(node.dataset.zone, event);
    });
    // The browser's own dblclick would also fire; suppress its default effects.
    node.addEventListener('dblclick', (event) => event.preventDefault());
  }

  // --- controls -------------------------------------------------------------
  dom.btnPlay.addEventListener('click', togglePlay);
  dom.btnBack.addEventListener('click', () => { seekBy(-seekStep()); showRipple('back', -seekStep()); });
  dom.btnFwd.addEventListener('click', () => { seekBy(seekStep()); showRipple('fwd', seekStep()); });
  dom.btnMute.addEventListener('click', () => {
    video.muted = !video.muted;
    flash(video.muted ? 'Muted' : 'Unmuted');
  });
  dom.volInput.addEventListener('input', (e) => setVolume(Number(e.target.value)));
  dom.btnFull.addEventListener('click', toggleFullscreen);
  dom.btnPip.addEventListener('click', togglePip);
  dom.btnNext.addEventListener('click', () => playNext());
  dom.back.addEventListener('click', close);
  dom.statsClose.addEventListener('click', () => { dom.stats.hidden = true; });
  dom.errorClose.addEventListener('click', close);
  dom.errorSwitch.addEventListener('click', () => {
    const next = (session.sourceIndex + 1) % session.sources.length;
    loadSource(next, video.currentTime);
  });

  document.addEventListener('fullscreenchange', () => {
    dom.btnFull.innerHTML = document.fullscreenElement ? ICONS.exitFull : ICONS.full;
  });

  // --- scrubbing ------------------------------------------------------------
  dom.scrubInput.addEventListener('input', () => {
    if (!Number.isFinite(video.duration)) return;
    session.scrubbing = true;
    const ratio = Number(dom.scrubInput.value) / 1000;
    dom.scrubPlayed.style.width = `${ratio * 100}%`;
    dom.timeNow.textContent = formatTime(ratio * video.duration);
  });
  const commitScrub = () => {
    if (!session.scrubbing || !Number.isFinite(video.duration)) return;
    session.scrubbing = false;
    seekTo((Number(dom.scrubInput.value) / 1000) * video.duration);
  };
  dom.scrubInput.addEventListener('change', commitScrub);
  dom.scrubInput.addEventListener('pointerup', commitScrub);

  dom.scrub.addEventListener('pointermove', (event) => {
    if (!Number.isFinite(video.duration)) return;
    const rect = dom.scrub.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    dom.scrubTip.hidden = false;
    dom.scrubTip.textContent = formatTime(ratio * video.duration);
    dom.scrubTip.style.left = `${ratio * rect.width}px`;
  });
  dom.scrub.addEventListener('pointerleave', () => { dom.scrubTip.hidden = true; });

  // --- menus ----------------------------------------------------------------
  for (const menu of Object.values(dom.menus)) {
    const toggle = menu.querySelector('[data-menu-toggle]');
    const panel = menu.querySelector('[data-menu-panel]');
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const willOpen = panel.hidden;
      closeMenus();
      panel.hidden = !willOpen;
      showUi();
    });
  }
  dom.root.addEventListener('click', (event) => {
    if (!event.target.closest('.menu')) closeMenus();
  });

  // --- up next --------------------------------------------------------------
  dom.upnextPlay.addEventListener('click', () => playNext());
  dom.upnextCancel.addEventListener('click', () => {
    dom.upnext.hidden = true;
    clearTimeout(session.upnextTimer);
    session.upnextDismissed = true;
  });

  // --- pointer idle ---------------------------------------------------------
  for (const evt of ['pointermove', 'pointerdown', 'keydown']) {
    dom.root.addEventListener(evt, showUi);
  }

  // --- keyboard -------------------------------------------------------------
  document.addEventListener('keydown', onKeydown);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && session.active) saveProgress(true);
  });
  window.addEventListener('pagehide', () => { if (session.active) saveProgress(true); });
}

function onKeydown(event) {
  if (!session.active) return;
  const tag = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  const video = dom.video;
  const key = event.key;
  let handled = true;

  switch (key) {
    case ' ':
    case 'k': togglePlay(); break;
    case 'ArrowRight': seekBy(seekStep()); showRipple('fwd', seekStep()); break;
    case 'ArrowLeft': seekBy(-seekStep()); showRipple('back', -seekStep()); break;
    case 'l': seekBy(10); showRipple('fwd', 10); break;
    case 'j': seekBy(-10); showRipple('back', -10); break;
    case 'ArrowUp': setVolume(video.volume + 0.05); flash(`Volume ${Math.round(video.volume * 100)}%`); break;
    case 'ArrowDown': setVolume(video.volume - 0.05); flash(`Volume ${Math.round(video.volume * 100)}%`); break;
    case 'm': video.muted = !video.muted; flash(video.muted ? 'Muted' : 'Unmuted'); break;
    case 'f': toggleFullscreen(); break;
    case 'i': togglePip(); break;
    case 's': toggleStats(); break;
    case 'c': cycleSubtitles(); break;
    case 'q': cycleQuality(); break;
    case 'n': playNext(); break;
    case 'Escape':
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else close();
      break;
    case '>': video.playbackRate = Math.min(4, video.playbackRate + 0.25); flash(`Speed ${video.playbackRate}×`); break;
    case '<': video.playbackRate = Math.max(0.25, video.playbackRate - 0.25); flash(`Speed ${video.playbackRate}×`); break;
    case ',': video.pause(); seekBy(-1 / 30); flash('Previous frame'); break;
    case '.': video.pause(); seekBy(1 / 30); flash('Next frame'); break;
    case 'Home': seekTo(0); break;
    case 'End': if (Number.isFinite(video.duration)) seekTo(video.duration - 1); break;
    default:
      if (/^[0-9]$/.test(key) && Number.isFinite(video.duration)) {
        seekTo((Number(key) / 10) * video.duration);
        flash(`${Number(key) * 10}%`);
      } else {
        handled = false;
      }
  }

  if (handled) {
    event.preventDefault();
    showUi();
  }
}

function cycleSubtitles() {
  const tracks = [...dom.video.textTracks];
  if (!tracks.length) return flash('No subtitle tracks');
  const active = tracks.findIndex((t) => t.mode === 'showing');
  for (const t of tracks) t.mode = 'disabled';
  const next = active + 1;
  if (next < tracks.length) {
    tracks[next].mode = 'showing';
    flash(`Subtitles: ${tracks[next].label}`);
  } else {
    flash('Subtitles off');
  }
  buildSubsMenu();
  return undefined;
}

function cycleQuality() {
  if (session.sources.length < 2) return flash('Only one source for this title');
  const next = (session.sourceIndex + 1) % session.sources.length;
  loadSource(next, dom.video.currentTime);
  flash(`Quality: ${session.sources[next].label}`);
  return undefined;
}

function maybeOfferNext(currentTime, duration) {
  const next = session.queue[session.queueIndex + 1];
  if (!next || session.upnextDismissed || !state.settings.autoplayNext) return;
  const remaining = duration - currentTime;
  if (remaining <= 25 && remaining > 0 && dom.upnext.hidden) startUpNextCountdown(next);
}

function startUpNextCountdown(next) {
  clearTimeout(session.upnextTimer);
  dom.upnextTitle.textContent = next.episodeId
    ? `S${String(next.season).padStart(2, '0')}E${String(next.episode).padStart(2, '0')} · ${next.name}`
    : next.name;
  dom.upnext.hidden = false;

  let remaining = 10;
  const tick = () => {
    dom.upnextCount.textContent = `(${remaining})`;
    if (remaining <= 0) {
      playNext(true);
      return;
    }
    remaining -= 1;
    session.upnextTimer = setTimeout(tick, 1000);
  };
  tick();
}
