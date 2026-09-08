import { $, el, clear, formatTime, formatBytes, qualityLabel, toast, codecDiagnosis, browserCodecs } from './util.js';
import { api, streamUrl, subtitleUrl } from './api.js';
import {
  state, playablesOf, progressFor, resumePointFor, savedVolume, saveVolume, savedMuted, emit,
} from './state.js';
import { isSourceOffline, downloadSource } from './offline.js';
import { trackToShow } from './langs.js';
import { createStallWatcher, nextSmallerSource } from './stalls.js';

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
  resumedFrom: null,   // { stoppedAt, resumeAt } when this is a resume
  subOffset: 0,        // subtitle timing nudge, in seconds
  cueBase: new WeakMap(), // original cue times, so offsets stay absolute
  intro: null,         // { start, end } marked intro range for this playable
  introDismissed: false,
  marking: null,       // { start } while an intro is being marked live
  sleep: null,         // { mode, endsAt?, tick } sleep timer
  chosenTrack: null,   // the subtitle track we picked, held against the browser's own
  stalls: null,        // watches for a connection that cannot keep up
};

/**
 * Every key the player answers to, and what it does.
 *
 * This table is the single source of truth: `onKeydown` and the help overlay
 * both read from it, and a test asserts the two never drift apart. `handles`
 * lists the raw `event.key` values; `show` is how the key is drawn on screen.
 */
export const SHORTCUTS = [
  {
    group: 'Playing',
    items: [
      { handles: [' ', 'k'], show: ['Space', 'K'], label: 'Play or pause' },
      { handles: ['f'], show: ['F'], label: 'Fullscreen' },
      { handles: ['i'], show: ['I'], label: 'Picture in picture' },
      { handles: ['Escape'], show: ['Esc'], label: 'Leave fullscreen, then close the player' },
    ],
  },
  {
    group: 'Moving around',
    items: [
      { handles: ['ArrowLeft', 'ArrowRight'], show: ['←', '→'], label: 'Seek by your chosen step' },
      { handles: ['j', 'l'], show: ['J', 'L'], label: 'Ten seconds back or forward' },
      { handles: [',', '.'], show: [',', '.'], label: 'A single frame either way — pauses first' },
      { handles: ['Home', 'End'], show: ['Home', 'End'], label: 'To the very start, or the very end' },
      {
        handles: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
        show: ['0', '…', '9'],
        label: 'Jump to that tenth of the runtime',
      },
    ],
  },
  {
    group: 'Sound',
    items: [
      { handles: ['ArrowUp', 'ArrowDown'], show: ['↑', '↓'], label: 'Volume up or down' },
      { handles: ['m'], show: ['M'], label: 'Mute' },
    ],
  },
  {
    group: 'Speed',
    items: [
      { handles: ['<', '>'], show: ['<', '>'], label: 'Slower or faster, a quarter at a time' },
    ],
  },
  {
    group: 'Subtitles',
    items: [
      { handles: ['c'], show: ['C'], label: 'Next subtitle track, or off' },
      { handles: ['[', ']'], show: ['[', ']'], label: 'Nudge the timing a quarter second' },
    ],
  },
  {
    group: 'This title',
    items: [
      { handles: ['q'], show: ['Q'], label: 'Switch quality' },
      { handles: ['n'], show: ['N'], label: 'Next episode' },
      { handles: ['I'], show: ['Shift', 'I'], label: 'Mark the intro — once at its start, once at its end' },
    ],
  },
  {
    group: 'Telling you things',
    items: [
      { handles: ['s'], show: ['S'], label: 'Stats for nerds' },
      { handles: ['?'], show: ['?'], label: 'This list' },
    ],
  },
];

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
    slowLink: $('#slowLink'),
    slowLinkText: $('#slowLinkText'),
    slowLinkSwitch: $('#slowLinkSwitch'),
    slowLinkSave: $('#slowLinkSave'),
    slowLinkDismiss: $('#slowLinkDismiss'),
    keys: $('#keysPanel'),
    keysBody: $('#keysBody'),
    keysClose: $('#keysClose'),
    skipIntro: $('#skipIntro'),
    skipIntroBar: $('#skipIntroBar'),
    sleepChip: $('#sleepChip'),
    sleepChipLabel: $('#sleepChipLabel'),
    sleepOverlay: $('#sleepOverlay'),
    sleepWhere: $('#sleepWhere'),
    sleepResume: $('#sleepResume'),
    sleepStop: $('#sleepStop'),
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
  session.intro = introOf(target);
  session.introDismissed = false;
  session.marking = null;
  session.stalls = createStallWatcher();
  dom.upnext.hidden = true;
  dom.skipIntro.hidden = true;
  hideSlowLink();

  const preferred = sourceId
    ? session.sources.findIndex((s) => s.id === sourceId)
    : pickDefaultSource(session.sources);
  session.sourceIndex = preferred >= 0 ? preferred : 0;

  // Resuming rewinds a few seconds (see resumePointFor) so you get a run-up
  // rather than restarting mid-sentence.
  const saved = progressFor(target.titleId, target.episodeId);
  const resumeAt = Number.isFinite(startAt)
    ? startAt
    : resumePointFor(target.titleId, target.episodeId);
  session.resumedFrom = (!Number.isFinite(startAt) && saved && !saved.finished && resumeAt > 0)
    ? { stoppedAt: saved.position, resumeAt }
    : null;

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
  cancelSleepTimer();
  dom.root.hidden = true;
  dom.upnext.hidden = true;
  dom.skipIntro.hidden = true;
  hideSlowLink();
  session.stalls = null;
  if (dom.keys) dom.keys.hidden = true;
  dom.stats.hidden = true;
  document.body.classList.remove('is-playing');
  setFaux(false);
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

const LS_SUB_CHOICE = 'elbi.subtitle.';

/**
 * Which track this person last chose for this title.
 *
 * The server is the record, so switching subtitles off on the laptop is still
 * off when the film is picked up on a phone. localStorage is kept as a mirror
 * rather than the source: it is what answers while offline, and what covers
 * the moment between choosing a track and the write landing.
 */
function subtitleMemory(titleId) {
  const remote = state.subtitleChoice?.[titleId];
  if (remote) return remote;
  try { return localStorage.getItem(LS_SUB_CHOICE + titleId); } catch { return null; }
}

function rememberSubtitle(titleId, label) {
  if (state.subtitleChoice) state.subtitleChoice[titleId] = label;
  try { localStorage.setItem(LS_SUB_CHOICE + titleId, label); } catch { /* private mode */ }
  // Best effort: a failed write only costs this device its cross-device sync,
  // and the local mirror above still answers.
  if (state.activeProfile) {
    api.setSubtitleChoice(state.activeProfile, titleId, label).catch(() => {});
  }
}

function attachTracks() {
  const subs = session.item.subtitles || [];
  session.subOffset = 0;
  session.cueBase = new WeakMap();

  session.chosenTrack = null;

  subs.forEach((sub, i) => {
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = sub.label || `Track ${i + 1}`;
    track.srclang = sub.lang || 'und';
    track.src = subtitleUrl(session.title.id, sub.id);
    // The file loads well after our choice is made, and Chrome may switch a
    // track on for itself at that moment — so re-assert once it lands.
    track.addEventListener('load', enforceTrackChoice);
    dom.video.append(track);
  });

  applySubtitleStyle();

  // What this title was last watched with wins; failing that, a track in the
  // language you asked for comes on by itself. Before this, a film you had
  // never opened started with subtitles off no matter what — so "my subtitles
  // are Albanian" only took effect on films you had already picked them for.
  const remembered = subtitleMemory(session.title.id);
  requestAnimationFrame(() => {
    const tracks = [...dom.video.textTracks];
    for (const track of tracks) track.mode = 'disabled';

    // textTracks exposes `language`; the <track> elements carry `srclang`.
    const choices = tracks.map((t, i) => ({
      track: t,
      label: t.label,
      srclang: t.language || subs[i]?.lang || '',
    }));
    const picked = trackToShow(choices, {
      remembered,
      preferredLang: state.settings?.subtitleLanguage || '',
      auto: state.settings?.autoSubtitles !== false,
    });
    if (picked) showTrack(picked.track, { quiet: true });

    buildSubsMenu();
  });
}

/**
 * Hold the picked track against the browser's own opinion.
 *
 * Chrome runs its own automatic text-track selection when a track file
 * finishes loading, choosing by the browser's UI language. That lands *after*
 * we have made our choice, so a film with an English and an Albanian track
 * ended up with both switched on and two languages painted on top of each
 * other. Whenever the track list changes, anything showing that we did not
 * choose goes back off.
 */
let enforcing = false;
function enforceTrackChoice() {
  if (enforcing || !session.active) return;
  const wanted = session.chosenTrack || null;
  const tracks = [...dom.video.textTracks];
  const stray = tracks.filter((t) => t.mode === 'showing' && t !== wanted);
  const lost = wanted && wanted.mode !== 'showing';
  if (!stray.length && !lost) return;

  enforcing = true;
  for (const t of stray) t.mode = 'disabled';
  if (lost) wanted.mode = 'showing';
  enforcing = false;
}

function showTrack(track, { quiet = false } = {}) {
  for (const t of dom.video.textTracks) t.mode = 'disabled';
  session.chosenTrack = track || null;
  if (!track) {
    rememberSubtitle(session.title.id, 'off');
    if (!quiet) flash('Subtitles off');
    buildSubsMenu();
    return;
  }
  track.mode = 'showing';
  rememberSubtitle(session.title.id, track.label);
  const wasLifted = cuesLifted;
  cuesLifted = null;
  setTimeout(() => liftCues(wasLifted ?? true), 80);
  // Cues only exist once the track is no longer disabled, so any pending
  // timing offset has to be re-applied here rather than at load time.
  setTimeout(() => applySubtitleOffset(session.subOffset || 0, true), 60);
  if (!quiet) flash(`Subtitles: ${track.label}`);
  buildSubsMenu();
}

function showingTrack() {
  return [...dom.video.textTracks].find((t) => t.mode === 'showing') || null;
}

/**
 * Shift the visible track in time. Handy when an .srt was cut for a different
 * release and every line lands a second or two early.
 */
function applySubtitleOffset(seconds, silent = false) {
  const track = showingTrack();
  session.subOffset = Math.round(seconds * 4) / 4;
  if (!track?.cues?.length) return;

  for (const cue of track.cues) {
    let base = session.cueBase.get(cue);
    if (!base) {
      base = { start: cue.startTime, end: cue.endTime };
      session.cueBase.set(cue, base);
    }
    // Cue times are writable; clamp so a large negative shift stays valid.
    const start = Math.max(0, base.start + session.subOffset);
    const end = Math.max(start + 0.05, base.end + session.subOffset);
    try {
      cue.startTime = start;
      cue.endTime = end;
    } catch { /* some cue kinds are read-only; skip them */ }
  }
  // Chrome keeps painting the old cue boxes after their times are rewritten;
  // cycling the track's mode forces it to lay the active cues out again.
  if (track) {
    track.mode = 'hidden';
    track.mode = 'showing';
  }

  const readout = document.getElementById('subOffsetLabel');
  if (readout) {
    readout.textContent = `${session.subOffset > 0 ? '+' : ''}${session.subOffset.toFixed(2)}s`;
  }
  if (!silent) {
    flash(session.subOffset === 0
      ? 'Subtitle timing reset'
      : `Subtitles ${session.subOffset > 0 ? '+' : ''}${session.subOffset.toFixed(2)}s`);
  }
}

/** ::cue cannot be styled from a stylesheet variable, so the rule is rewritten. */
export function applySubtitleStyle() {
  const sizes = { small: '2.6vh', medium: '3.4vh', large: '4.4vh', huge: '5.6vh' };
  const size = sizes[state.settings?.subtitleSize] || sizes.medium;
  const background = state.settings?.subtitleBackground || 'shadow';

  const paint = background === 'box'
    ? 'background: rgba(0, 0, 0, .78);'
    : background === 'none'
      ? 'background: transparent;'
      : 'background: transparent; text-shadow: 0 2px 4px #000, 0 0 8px rgba(0,0,0,.9);';

  let style = document.getElementById('elbi-cue-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'elbi-cue-style';
    document.head.append(style);
  }
  style.textContent = `
    #video::cue {
      font-size: ${size};
      line-height: 1.3;
      color: #fff;
      font-family: inherit;
      ${paint}
    }
  `;
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
  dom.btnFull.innerHTML = document.fullscreenElement || faux() ? ICONS.exitFull : ICONS.full;
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
  const active = showingTrack();

  const off = el('button.menu__item', {
    type: 'button',
    onclick: () => { closeMenus(); showTrack(null); },
  }, [el('span', { text: 'Off' })]);
  if (!active) off.classList.add('is-active');
  panel.append(off);

  tracks.forEach((track, i) => {
    const item = el('button.menu__item', {
      type: 'button',
      onclick: () => { closeMenus(); showTrack(track); },
    }, [
      el('span', { text: track.label || `Track ${i + 1}` }),
      track.language ? el('small', { text: track.language }) : null,
    ]);
    if (track === active) item.classList.add('is-active');
    panel.append(item);
  });

  if (!tracks.length) {
    panel.append(el('div.menu__label', {
      text: 'No subtitle tracks yet. Add a .srt or .vtt from the title page.',
      style: { textTransform: 'none', letterSpacing: '0' },
    }));
    return;
  }

  panel.append(el('div.menu__sep'));
  panel.append(el('div.menu__label', { text: 'Text size' }));
  for (const [value, label] of [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['huge', 'Huge']]) {
    const item = el('button.menu__item', {
      type: 'button',
      onclick: async () => {
        state.settings.subtitleSize = value;
        applySubtitleStyle();
        buildSubsMenu();
        await api.patchSettings({ subtitleSize: value }).catch(() => {});
      },
    }, [el('span', { text: label })]);
    if ((state.settings.subtitleSize || 'medium') === value) item.classList.add('is-active');
    panel.append(item);
  }

  panel.append(el('div.menu__label', { text: 'Background' }));
  for (const [value, label] of [['shadow', 'Drop shadow'], ['box', 'Black box'], ['none', 'None']]) {
    const item = el('button.menu__item', {
      type: 'button',
      onclick: async () => {
        state.settings.subtitleBackground = value;
        applySubtitleStyle();
        buildSubsMenu();
        await api.patchSettings({ subtitleBackground: value }).catch(() => {});
      },
    }, [el('span', { text: label })]);
    if ((state.settings.subtitleBackground || 'shadow') === value) item.classList.add('is-active');
    panel.append(item);
  }

  panel.append(el('div.menu__sep'));
  panel.append(el('div.menu__label', { text: 'Timing' }));
  panel.append(el('div', {
    style: { display: 'flex', gap: '.3rem', alignItems: 'center', padding: '.3rem .6rem .5rem' },
  }, [
    el('button.btn.btn--ghost.btn--sm', {
      type: 'button', title: 'Show subtitles earlier',
      onclick: () => applySubtitleOffset((session.subOffset || 0) - 0.25),
    }, ['−0.25s']),
    el('span', {
      id: 'subOffsetLabel',
      style: { flex: '1', textAlign: 'center', fontVariantNumeric: 'tabular-nums', fontSize: '.8rem' },
      text: `${(session.subOffset || 0) > 0 ? '+' : ''}${(session.subOffset || 0).toFixed(2)}s`,
    }),
    el('button.btn.btn--ghost.btn--sm', {
      type: 'button', title: 'Show subtitles later',
      onclick: () => applySubtitleOffset((session.subOffset || 0) + 0.25),
    }, ['+0.25s']),
  ]));
  if (session.subOffset) {
    panel.append(el('button.menu__item', {
      type: 'button',
      onclick: () => applySubtitleOffset(0),
    }, [el('span', { text: 'Reset timing' })]));
  }
  panel.append(el('div.menu__label', {
    text: 'Shortcuts: C cycles tracks, [ and ] nudge timing.',
    style: { textTransform: 'none', letterSpacing: '0' },
  }));
}

function buildMoreMenu() {
  const panel = dom.menus.more.querySelector('[data-menu-panel]');
  clear(panel);

  // --- sleep timer ---------------------------------------------------------
  panel.append(el('div.menu__label', { text: 'Sleep timer' }));

  const offItem = el('button.menu__item', {
    type: 'button',
    onclick: () => { closeMenus(); cancelSleepTimer({ quiet: !sleepActive() }); buildMoreMenu(); },
  }, [el('span', { text: 'Off' })]);
  if (!sleepActive()) offItem.classList.add('is-active');
  panel.append(offItem);

  for (const minutes of SLEEP_CHOICES) {
    const item = el('button.menu__item', {
      type: 'button',
      onclick: () => { closeMenus(); startSleepTimer(minutes); },
    }, [el('span', { text: `${minutes} minutes` })]);
    if (session.sleep?.mode === 'clock') {
      const left = Math.round((session.sleep.endsAt - Date.now()) / 60_000);
      if (left === minutes) item.classList.add('is-active');
    }
    panel.append(item);
  }
  if (session.queue.length > 1) {
    const item = el('button.menu__item', {
      type: 'button',
      onclick: () => { closeMenus(); startSleepTimer('episode'); },
    }, [el('span', { text: 'End of this episode' })]);
    if (session.sleep?.mode === 'episode') item.classList.add('is-active');
    panel.append(item);
  }

  // --- intro marker --------------------------------------------------------
  panel.append(el('div.menu__sep'));
  panel.append(el('div.menu__label', { text: 'Skip intro' }));

  if (session.marking) {
    panel.append(el('button.menu__item.is-active', {
      type: 'button',
      onclick: () => { closeMenus(); markIntro('episode'); },
    }, [
      el('span', { text: 'Mark intro end here' }),
      el('small', { text: `from ${formatTime(session.marking.start)}` }),
    ]));
    panel.append(el('button.menu__item', {
      type: 'button',
      onclick: () => { closeMenus(); session.marking = null; flash('Marking cancelled'); buildMoreMenu(); },
    }, [el('span', { text: 'Cancel marking' })]));
  } else if (session.intro) {
    panel.append(el('div.menu__note', {
      text: `Marked ${formatTime(session.intro.start)}–${formatTime(session.intro.end)}`,
    }));
    panel.append(el('button.menu__item', {
      type: 'button',
      onclick: () => { closeMenus(); skipIntroNow(); },
    }, [el('span', { text: 'Skip it now' })]));
    if (session.item?.episodeId) {
      panel.append(el('button.menu__item', {
        type: 'button',
        onclick: () => { closeMenus(); applyIntroToSeason(); },
      }, [el('span', { text: 'Apply to whole season' })]));
    }
    panel.append(el('button.menu__item', {
      type: 'button',
      onclick: () => { closeMenus(); clearIntro(); },
    }, [el('span', { text: 'Clear marker' })]));
  } else {
    panel.append(el('button.menu__item', {
      type: 'button',
      onclick: () => { closeMenus(); markIntro('episode'); },
    }, [el('span', { text: 'Mark intro start here' }), el('small', { text: '⇧I' })]));
  }

  panel.append(el('div.menu__sep'));
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
    onclick: () => { closeMenus(); toggleShortcuts(true); },
  }, [el('span', { text: 'Keyboard shortcuts' }), el('small', { text: '?' })]));
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

/**
 * Go fullscreen by whatever route this browser actually allows.
 *
 * 1. The standard Fullscreen API on the player container — keeps our controls.
 * 2. iOS Safari cannot fullscreen a <div> at all, only a <video>, so fall back
 *    to the native video presentation there.
 * 3. Embedded in an iframe without allow="fullscreen" (or anywhere else the
 *    request is refused), expand to fill the viewport with CSS instead.
 */
function faux() {
  return dom.root.classList.contains('is-faux-fullscreen');
}

function setFaux(on) {
  dom.root.classList.toggle('is-faux-fullscreen', on);
  document.body.classList.toggle('is-faux-fullscreen', on);
  dom.btnFull.innerHTML = on ? ICONS.exitFull : ICONS.full;
}

async function toggleFullscreen() {
  // Leaving, by whichever route we entered.
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    try {
      await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
    } catch { /* already gone */ }
    setFaux(false);
    return;
  }
  if (faux()) {
    setFaux(false);
    return;
  }

  const request = dom.root.requestFullscreen || dom.root.webkitRequestFullscreen;
  if (request) {
    try {
      await request.call(dom.root, { navigationUI: 'hide' });
      setFaux(false);
      dom.btnFull.innerHTML = ICONS.exitFull;
      return;
    } catch { /* refused — fall through */ }
  }

  // iOS: only the video element can present fullscreen.
  if (typeof dom.video.webkitEnterFullscreen === 'function') {
    try {
      dom.video.webkitEnterFullscreen();
      return;
    } catch { /* fall through */ }
  }

  setFaux(true);
  flash('Filling the window — this page cannot use the browser\'s fullscreen');
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
// skip intro

/**
 * The marked range for a playable. Episodes carry their own; a movie's lives
 * on the title. State is re-read from the store rather than cached on the item,
 * so a marker set during playback takes effect on the very next tick.
 */
function introOf(item) {
  if (!item) return null;
  const title = state.titles.find((t) => t.id === item.titleId) || session.title;
  if (!title) return null;
  if (!item.episodeId) return title.intro || null;
  for (const season of title.seasons || []) {
    const episode = (season.episodes || []).find((e) => e.id === item.episodeId);
    if (episode) return episode.intro || null;
  }
  return null;
}

/**
 * Show the button only while the intro is actually on screen, and only when
 * there is somewhere worth jumping to. Dismissing it — or seeking past the
 * range — keeps it down for the rest of the sitting.
 */
function updateSkipIntro(currentTime) {
  const intro = session.intro;
  if (!intro || !state.settings?.skipIntro || session.introDismissed) {
    if (!dom.skipIntro.hidden) dom.skipIntro.hidden = true;
    return;
  }
  const inside = currentTime >= intro.start && currentTime < intro.end - 0.5;
  if (!inside) {
    if (!dom.skipIntro.hidden) dom.skipIntro.hidden = true;
    return;
  }
  dom.skipIntro.hidden = false;
  const span = Math.max(0.001, intro.end - intro.start);
  const done = Math.min(1, Math.max(0, (currentTime - intro.start) / span));
  dom.skipIntroBar.style.width = `${done * 100}%`;
}

function skipIntroNow() {
  if (!session.intro) return;
  seekTo(session.intro.end);
  session.introDismissed = true;
  dom.skipIntro.hidden = true;
  flash('Skipped intro');
}

/** Mark the intro live: press once at the start, once at the end. */
async function markIntro(applyTo = 'episode') {
  const at = Math.max(0, dom.video.currentTime);
  if (!session.marking) {
    session.marking = { start: at };
    flash(`Intro starts at ${formatTime(at)} — play on, then mark the end`);
    buildMoreMenu();
    return;
  }
  const start = session.marking.start;
  session.marking = null;
  if (at - start < 1) {
    flash('That intro would be under a second — start again');
    buildMoreMenu();
    return;
  }

  const intro = { start, end: at };
  try {
    const res = await api.setIntro(session.title.id, {
      intro,
      episodeId: session.item.episodeId,
      applyTo: session.item.episodeId ? applyTo : 'episode',
    });
    upsertPlayedTitle(res.title);
    session.intro = intro;
    session.introDismissed = false;
    flash(res.applied > 1
      ? `Intro marked on ${res.applied} episodes (${formatTime(start)}–${formatTime(at)})`
      : `Intro marked ${formatTime(start)}–${formatTime(at)}`);
  } catch (err) {
    flash(err.message || 'Could not save the intro marker');
  }
  buildMoreMenu();
}

/** Copy this episode's marker onto every episode in the same season. */
async function applyIntroToSeason() {
  if (!session.intro || !session.item?.episodeId) return;
  try {
    const res = await api.setIntro(session.title.id, {
      intro: session.intro,
      episodeId: session.item.episodeId,
      applyTo: 'season',
    });
    upsertPlayedTitle(res.title);
    flash(`Intro applied to ${res.applied} episodes`);
  } catch (err) {
    flash(err.message || 'Could not apply the marker');
  }
  buildMoreMenu();
}

async function clearIntro() {
  try {
    const res = await api.setIntro(session.title.id, { intro: null, episodeId: session.item.episodeId });
    upsertPlayedTitle(res.title);
    session.intro = null;
    dom.skipIntro.hidden = true;
    flash('Intro marker cleared');
  } catch (err) {
    flash(err.message || 'Could not clear the marker');
  }
  buildMoreMenu();
}

/** Keep the shared library in step with a title the player just changed. */
function upsertPlayedTitle(title) {
  if (!title) return;
  const index = state.titles.findIndex((t) => t.id === title.id);
  if (index >= 0) state.titles[index] = title;
  session.title = title;
  emit();
}

// ---------------------------------------------------------------------------
// sleep timer

const SLEEP_CHOICES = [15, 30, 45, 60, 90];

function sleepActive() {
  return Boolean(session.sleep);
}

function startSleepTimer(mode) {
  cancelSleepTimer();
  if (!mode) return;

  if (mode === 'episode') {
    session.sleep = { mode: 'episode' };
    dom.sleepChip.hidden = false;
    dom.sleepChipLabel.textContent = 'End of episode';
    flash('Sleeping after this episode');
  } else {
    const minutes = Number(mode);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    session.sleep = { mode: 'clock', endsAt: Date.now() + minutes * 60_000 };
    dom.sleepChip.hidden = false;
    flash(`Sleeping in ${minutes} minutes`);
  }
  // A wall-clock tick, not a playback one: pausing the film should not stop
  // the countdown any more than it stops the viewer falling asleep.
  session.sleep.tick = setInterval(tickSleep, 1000);
  tickSleep();
  buildMoreMenu();
}

function cancelSleepTimer({ quiet = true } = {}) {
  if (session.sleep?.tick) clearInterval(session.sleep.tick);
  session.sleep = null;
  dom.sleepChip.hidden = true;
  dom.sleepOverlay.hidden = true;
  if (!quiet) flash('Sleep timer off');
}

function tickSleep() {
  const sleep = session.sleep;
  if (!sleep) return;
  if (sleep.mode !== 'clock') return;
  const remaining = Math.max(0, sleep.endsAt - Date.now());
  dom.sleepChipLabel.textContent = formatTime(Math.ceil(remaining / 1000));
  if (remaining <= 0) fireSleep();
}

function fireSleep() {
  const where = dom.video.currentTime;
  cancelSleepTimer();
  dom.video.pause();
  saveProgress(true);
  dom.upnext.hidden = true;
  clearTimeout(session.upnextTimer);
  session.upnextDismissed = true;
  dom.sleepWhere.textContent = `Paused at ${formatTime(where)} — your place is saved.`;
  dom.sleepOverlay.hidden = false;
  showUi();
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
// a connection that cannot keep up

/**
 * Streaming from a home machine to someone far away is limited by that
 * machine's upload speed. When the link cannot sustain the bitrate, the
 * picture stops every few seconds and a spinner explains nothing. Offer the
 * two things that actually help: a smaller file, or downloading it first.
 */
function offerForSlowLink() {
  const source = currentSource();
  const smaller = nextSmallerSource(session.sources, source?.id);
  const canSave = source?.kind === 'file' && !isSourceOffline(session.title.id, source.id);

  // Nothing useful to offer: don't interrupt with a problem and no answer.
  if (!smaller && !canSave) return;

  dom.slowLinkText.textContent = smaller
    ? `This ${source.label || 'file'} keeps stopping. A smaller copy will play smoothly.`
    : 'This keeps stopping. Downloading it first will play without interruptions.';

  dom.slowLinkSwitch.hidden = !smaller;
  if (smaller) {
    dom.slowLinkSwitch.textContent = `Switch to ${smaller.label || qualityLabel(smaller.height)}`;
    dom.slowLinkSwitch.onclick = () => {
      hideSlowLink();
      const index = session.sources.findIndex((s) => s.id === smaller.id);
      if (index >= 0) {
        session.stalls?.reset();
        loadSource(index, dom.video.currentTime);
      }
    };
  }

  dom.slowLinkSave.hidden = !canSave;
  if (canSave) {
    dom.slowLinkSave.onclick = () => {
      hideSlowLink();
      // Downloading competes with playback for the same link, so pause first.
      dom.video.pause();
      saveProgress(true);
      downloadSource(session.title, source);
      flash('Downloading — you can watch it when it finishes');
    };
  }

  dom.slowLink.hidden = false;
  showUi();
}

function hideSlowLink() {
  if (dom.slowLink) dom.slowLink.hidden = true;
}

// ---------------------------------------------------------------------------
// keyboard help

/** Show, hide, or flip the shortcut list. */
function toggleShortcuts(force) {
  const panel = dom.keys;
  if (!panel) return;
  const show = force === undefined ? panel.hidden : force;
  if (show && !panel.dataset.built) {
    renderShortcuts();
    panel.dataset.built = '1';
  }
  panel.hidden = !show;
  if (show) showUi();
}

function shortcutsOpen() {
  return Boolean(dom.keys && !dom.keys.hidden);
}

function renderShortcuts() {
  const body = dom.keysBody;
  clear(body);
  for (const { group, items } of SHORTCUTS) {
    body.append(el('h4.keys__group', { text: group }));
    const list = el('dl.keys__list');
    for (const item of items) {
      const combo = el('dt');
      item.show.forEach((token, i) => {
        // A bare "…" is a range marker between two keys, not a key of its own.
        if (token === '…') combo.append(el('span.keys__join', { text: '…' }));
        else combo.append(el('kbd', { text: token }));
        if (i < item.show.length - 1 && token !== '…' && item.show[i + 1] !== '…') {
          combo.append(el('span.keys__join', { text: '/' }));
        }
      });
      list.append(combo, el('dd', { text: item.label }));
    }
    body.append(list);
  }
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


/**
 * Lift the cues clear of the control bar while it is on screen. VTTCue.line
 * counts lines from the bottom when negative, which is the only portable way
 * to move cues — ::cue cannot position them.
 */
let cuesLifted = null;
function liftCues(lifted) {
  if (cuesLifted === lifted) return;
  cuesLifted = lifted;
  const track = showingTrack();
  if (!track?.cues) return;
  for (const cue of track.cues) {
    try { cue.line = lifted ? -4 : 'auto'; } catch { /* not a VTTCue */ }
  }
}

function showUi() {
  dom.root.classList.remove('is-idle');
  liftCues(true);
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    if (!dom.video.paused && !session.scrubbing && !anyMenuOpen()) {
      dom.root.classList.add('is-idle');
      liftCues(false);
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

/** How long a second tap still counts as a double. The single-tap fallback
 *  waits longer than this, so a slow double-click never fires play/pause first. */
const TAP_WINDOW_MS = 320;
const SINGLE_TAP_MS = TAP_WINDOW_MS + 60;

function handleZoneTap(zone, event) {
  const now = performance.now();
  const isDouble = now - session.lastTap.time < TAP_WINDOW_MS && session.lastTap.zone === zone;

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
  }, SINGLE_TAP_MS);
}

/** Accumulate repeated taps the way mobile players do: -5, -10, -15… */
function showRipple(zone, amount, event) {
  const node = dom.zones.querySelector(zone === 'back' ? '.zone--left' : '.zone--right');
  if (!node) return;

  // Clear the pending reset *before* the object is replaced — swapping
  // direction mid-burst used to orphan the old timer, which then fired later
  // and wiped a counter that was still being added to.
  clearTimeout(session.seekBurst.timer);
  if (session.seekBurst.zone === zone) session.seekBurst.amount += amount;
  else session.seekBurst = { zone, amount, timer: null };

  const label = node.querySelector('.zone__label');
  label.textContent = `${session.seekBurst.amount > 0 ? '+' : ''}${session.seekBurst.amount}s`;

  node.classList.remove('is-hit');
  void node.offsetWidth; // restart the CSS animation
  node.classList.add('is-hit');

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
    if (session.resumedFrom) {
      const { stoppedAt, resumeAt } = session.resumedFrom;
      flash(`Resuming at ${formatTime(resumeAt)} — you stopped at ${formatTime(stoppedAt)}`);
      session.resumedFrom = null;
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
    updateSkipIntro(currentTime);
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

  video.addEventListener('waiting', () => {
    dom.spinner.hidden = false;
    // Only count a stall during real playback — seeking and startup buffer too.
    if (!session.active || video.paused || session.scrubbing) return;
    if (session.stalls?.record(Date.now())) offerForSlowLink();
  });
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
    dom.skipIntro.hidden = true;
    // "Stop after this episode" is exactly this moment: let the episode finish,
    // then stop instead of rolling into the next one.
    if (session.sleep?.mode === 'episode') {
      fireSleep();
      return;
    }
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
  dom.keysClose.addEventListener('click', () => toggleShortcuts(false));
  dom.slowLinkDismiss.addEventListener('click', () => {
    hideSlowLink();
    session.stalls?.dismiss(Date.now());
  });
  // Chrome enables a track by itself when one loads; put ours back.
  dom.video.textTracks.addEventListener?.('change', enforceTrackChoice);
  dom.errorClose.addEventListener('click', close);
  dom.errorSwitch.addEventListener('click', () => {
    const next = (session.sourceIndex + 1) % session.sources.length;
    loadSource(next, video.currentTime);
  });

  for (const evt of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(evt, () => {
      const on = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
      dom.btnFull.innerHTML = on || faux() ? ICONS.exitFull : ICONS.full;
    });
  }

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
      // A panel keeps its scroll position across rebuilds, so a menu reopened
      // after a long scroll would otherwise show its middle.
      if (willOpen) panel.scrollTop = 0;
      showUi();
    });
  }
  dom.root.addEventListener('click', (event) => {
    if (!event.target.closest('.menu')) closeMenus();
  });

  // --- skip intro + sleep timer ---------------------------------------------
  dom.skipIntro.addEventListener('click', skipIntroNow);
  dom.sleepChip.addEventListener('click', () => cancelSleepTimer({ quiet: false }));
  dom.sleepResume.addEventListener('click', () => {
    dom.sleepOverlay.hidden = true;
    session.upnextDismissed = false;
    video.play().catch(() => {});
  });
  dom.sleepStop.addEventListener('click', () => { dom.sleepOverlay.hidden = true; close(); });

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
    // Shift+I marks the intro: press at its first frame, again at its last.
    case 'I': markIntro(); break;
    case 's': toggleStats(); break;
    case 'c': cycleSubtitles(); break;
    case 'q': cycleQuality(); break;
    case 'n': playNext(); break;
    case '?': toggleShortcuts(); break;
    case '[': applySubtitleOffset((session.subOffset || 0) - 0.25); break;
    case ']': applySubtitleOffset((session.subOffset || 0) + 0.25); break;
    case 'Escape':
      // Unwind one layer at a time: the help list, then fullscreen, then out.
      if (shortcutsOpen()) toggleShortcuts(false);
      else if (document.fullscreenElement || faux()) toggleFullscreen();
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
  if (!tracks.length) return flash('No subtitle tracks — add a .srt or .vtt from the title page');
  const active = tracks.indexOf(showingTrack());
  const next = active + 1;
  showTrack(next < tracks.length ? tracks[next] : null);
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
