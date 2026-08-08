export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Tiny DOM builder: el('div.card', {onclick}, [children]) */
export function el(spec, props = {}, children = []) {
  const [tagAndId, ...classes] = String(spec).split('.');
  const [tag, id] = tagAndId.split('#');
  const node = document.createElement(tag || 'div');
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(' ');

  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }

  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatRuntime(minutes) {
  const m = Math.round(Number(minutes) || 0);
  if (!m) return '';
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

export function qualityLabel(height) {
  if (!height) return '';
  if (height >= 4320) return '8K';
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  return `${height}p`;
}

export function debounce(fn, ms = 200) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function throttle(fn, ms = 200) {
  let last = 0;
  let pending = null;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    } else {
      clearTimeout(pending);
      pending = setTimeout(() => {
        last = Date.now();
        fn(...args);
      }, ms - (now - last));
    }
  };
}

const TOAST_HOST = () => document.getElementById('toasts');

export function toast(message, kind = 'info', ms = 4200) {
  const host = TOAST_HOST();
  if (!host) return;
  const node = el('div.toast', { text: message });
  node.classList.add(`toast--${kind}`);
  host.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    node.style.transition = 'opacity .25s, transform .25s';
    setTimeout(() => node.remove(), 260);
  }, ms);
}

/** Deterministic colour from a string — used for profile and poster fallbacks. */
export function hashColor(input) {
  let hash = 0;
  for (const ch of String(input)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue} 52% 34%)`;
}

export function initials(name) {
  return String(name || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join('') || '?';
}

/**
 * A badge that stays distinguishable within a set. "Olti" and "Oltion" share an
 * initial, and one is a prefix of the other, so no shortening separates them —
 * in that case fall back to the whole name and let badgeFontSize shrink it.
 */
export function badgeFor(name, allNames = []) {
  const clean = String(name || '?').trim();
  if (!clean) return '?';
  const others = allNames.map((n) => String(n).trim()).filter((n) => n !== clean);
  if (!others.length) return initials(clean);

  // Multi-word names already read as distinct initials.
  if (clean.split(/\s+/).filter(Boolean).length > 1) return initials(clean);

  const collides = (candidate) => others.some(
    (other) => other.slice(0, candidate.length).toLowerCase() === candidate.toLowerCase(),
  );
  for (let len = 1; len <= 4; len += 1) {
    const prefix = clean.slice(0, len);
    if (prefix.length < len) break; // ran out of name
    if (!collides(prefix)) {
      return len === 1 ? prefix.toUpperCase() : prefix[0].toUpperCase() + prefix.slice(1).toLowerCase();
    }
  }
  return clean;
}

/** Keep a long badge inside its tile. */
export function badgeFontSize(label, base = 2.2) {
  const length = String(label).length;
  if (length <= 2) return `${base}rem`;
  if (length <= 4) return `${base * 0.62}rem`;
  return `${base * 0.42}rem`;
}

export function escapeHtml(input) {
  return String(input).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * What this browser can actually decode. Worth asking directly: Chromium
 * builds without proprietary codecs (and some Linux distro builds) have no
 * H.264 or AAC at all, which otherwise shows up as an unexplained black screen.
 */
let codecCache = null;
export function browserCodecs() {
  if (codecCache) return codecCache;
  const v = document.createElement('video');
  const can = (type) => v.canPlayType(type) !== '';
  codecCache = {
    h264: can('video/mp4; codecs="avc1.42E01E"'),
    hevc: can('video/mp4; codecs="hvc1.1.6.L93.B0"'),
    av1: can('video/mp4; codecs="av01.0.05M.08"'),
    vp8: can('video/webm; codecs="vp8"'),
    vp9: can('video/webm; codecs="vp9"'),
    theora: can('video/ogg; codecs="theora"'),
    aac: can('audio/mp4; codecs="mp4a.40.2"'),
    opus: can('audio/webm; codecs="opus"'),
    mkv: can('video/x-matroska; codecs="avc1.42E01E"'),
    hls: can('application/vnd.apple.mpegurl'),
  };
  return codecCache;
}

/** Human explanation for why a particular file would not decode here. */
export function codecDiagnosis(source) {
  const codecs = browserCodecs();
  const mime = String(source?.mime || '');
  const codec = String(source?.codec || '').toLowerCase();

  if (/theora/.test(codec) && !codecs.theora) {
    return 'This rendition is Ogg Theora, which your browser cannot decode (Chrome removed Theora in 2024). Firefox still plays it.';
  }
  if (/mpeg-4 part 2|divx|xvid/.test(codec)) {
    return 'This rendition is MPEG-4 Part 2 (DivX/Xvid), which browsers do not decode. Pick an H.264 rendition if one is listed.';
  }
  if (/mp4|matroska|quicktime/.test(mime) && !codecs.h264) {
    return 'This browser has no H.264 decoder, so most .mp4 files will not play in it. '
      + 'Chrome, Edge, Safari and Firefox normally do — some Linux Chromium builds ship without it.';
  }
  if (/mp4/.test(mime) && !codecs.aac) {
    return 'This browser has no AAC decoder, so the audio track cannot be played.';
  }
  return '';
}

/** Read width/height/duration/fps from a local File without uploading it. */
export function probeVideoFile(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load?.();
      resolve(result);
    };
    const timer = setTimeout(() => done({}), 12000);

    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.addEventListener('error', () => { clearTimeout(timer); done({}); });
    video.addEventListener('loadedmetadata', async () => {
      const base = {
        width: video.videoWidth || null,
        height: video.videoHeight || null,
        durationSec: Number.isFinite(video.duration) ? Math.round(video.duration) : null,
      };
      const fps = await measureFps(video).catch(() => null);
      clearTimeout(timer);
      done({ ...base, fps });
    });
    video.src = url;
  });
}

/**
 * Measure real frame rate with requestVideoFrameCallback, which reports the
 * media timestamp of each presented frame. Falls back to null where the API
 * is missing (Firefox), rather than inventing a number.
 */
export function measureFps(video, frames = 24) {
  return new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback !== 'function') return resolve(null);
    let first = null;
    let count = 0;
    const bail = setTimeout(() => resolve(null), 4000);

    const step = (_now, meta) => {
      if (first === null) {
        first = meta;
      } else {
        count += 1;
        const dt = meta.mediaTime - first.mediaTime;
        const df = (meta.presentedFrames ?? count) - (first.presentedFrames ?? 0);
        if (count >= frames && dt > 0.2 && df > 0) {
          clearTimeout(bail);
          const fps = df / dt;
          return resolve(Number.isFinite(fps) && fps > 1 && fps < 480 ? Math.round(fps * 100) / 100 : null);
        }
      }
      video.requestVideoFrameCallback(step);
      return undefined;
    };

    video.requestVideoFrameCallback(step);
    // Metadata-only elements are paused; nudge playback so frames get presented.
    const wasMuted = video.muted;
    video.muted = true;
    const playing = video.play();
    if (playing?.catch) {
      playing.catch(() => {
        clearTimeout(bail);
        resolve(null);
      });
    }
    setTimeout(() => {
      if (!video.paused && video.dataset.elbiKeepPlaying !== '1') video.pause();
      video.muted = wasMuted;
    }, 2200);
  });
}
