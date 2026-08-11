import path from 'node:path';
import crypto from 'node:crypto';

export function id(prefix = '') {
  return prefix + crypto.randomBytes(9).toString('base64url');
}

export function slug(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 80) || 'untitled';
}

/**
 * Resolve `candidate` and confirm it stays inside one of `roots`.
 * Returns the resolved absolute path, or null when it escapes.
 */
export function containedPath(candidate, roots) {
  if (!candidate) return null;
  const resolved = path.resolve(candidate);
  for (const root of roots) {
    const base = path.resolve(root);
    if (resolved === base) return resolved;
    if (resolved.startsWith(base + path.sep)) return resolved;
  }
  return null;
}

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ogv': 'video/ogg',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ts': 'video/mp2t',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'application/x-subrip; charset=utf-8',
  '.ass': 'text/x-ssa; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export function mimeFor(filePath) {
  return MIME[path.extname(String(filePath)).toLowerCase()] || 'application/octet-stream';
}

export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.webm', '.mkv', '.mov', '.avi', '.ogv', '.mpg', '.mpeg', '.ts',
]);

export const SUBTITLE_EXTENSIONS = new Set(['.vtt', '.srt']);

/**
 * Containers browsers can play directly. Anything else needs a remux —
 * the UI surfaces this instead of failing silently on playback.
 */
const BROWSER_SAFE = new Set(['.mp4', '.m4v', '.webm']);

export function playability(filePath) {
  const ext = path.extname(String(filePath)).toLowerCase();
  if (BROWSER_SAFE.has(ext)) return { level: 'direct', note: '' };
  if (ext === '.mov') {
    return { level: 'maybe', note: 'QuickTime containers play only when they hold H.264/AAC.' };
  }
  if (ext === '.ogv') {
    return {
      level: 'maybe',
      note: 'Ogg Theora — Firefox plays it, but Chrome removed Theora support in 2024.',
    };
  }
  if (ext === '.mkv') {
    return {
      level: 'maybe',
      note:
        'Matroska (.mkv) plays in Chrome/Edge only when the streams inside are H.264/VP9 + AAC/Opus. Remux to .mp4 if it stays black.',
    };
  }
  return {
    level: 'unsupported',
    note: `Browsers cannot play "${ext}" natively. Remux it to .mp4 (H.264/AAC) or .webm first.`,
  };
}

/** Parse "Some.Movie.Name.2014.1080p.BluRay.x264.mkv" into usable metadata. */
export function parseFilename(filename) {
  const base = path.basename(String(filename), path.extname(String(filename)));
  // Separators become spaces first: "_" is a word character, so \b never fires
  // between "720p" and "_WEBRip" in the raw filename.
  const normalized = base.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  let working = normalized;

  const result = { name: working, year: null, height: null, tags: [] };

  const yearMatch = working.match(/\b(19\d{2}|20\d{2})\b/);
  if (yearMatch) {
    result.year = Number.parseInt(yearMatch[1], 10);
    working = working.slice(0, yearMatch.index).trim() || working;
  }

  const resMatch = normalized.match(/\b(\d{3,4})[pP]\b/);
  if (resMatch) result.height = Number.parseInt(resMatch[1], 10);
  else if (/\b(4k|uhd|2160)\b/i.test(normalized)) result.height = 2160;

  for (const tag of ['HDR', 'DolbyVision', 'x265', 'x264', 'HEVC', 'AV1', 'BluRay', 'WEB-DL', 'WEBRip', 'REMUX', 'IMAX']) {
    if (new RegExp(`\\b${tag.replace(/-/g, '[- ]?')}\\b`, 'i').test(normalized)) result.tags.push(tag);
  }

  // Strip release-group noise that follows the year / resolution.
  working = working
    .replace(/\b(2160p|1440p|1080p|960p|720p|576p|480p|360p|240p|4k|uhd)\b.*$/i, '')
    .replace(/\b(bluray|brrip|bdrip|web[- ]?dl|webrip|hdtv|dvdrip|remux|proper|repack|extended|unrated|directors? cut)\b.*$/i, '')
    .replace(/\b(x264|x265|h ?264|h ?265|hevc|av1|xvid|divx|aac|ac3|dts|ddp?5 1|atmos|truehd)\b.*$/i, '')
    .replace(/[-–—\s]+$/, '')
    .trim();

  if (working) result.name = working;
  result.name = result.name.replace(/\s{2,}/g, ' ').trim() || base;
  // Title-case names that arrived all-lowercase from the filesystem.
  if (result.name === result.name.toLowerCase()) {
    result.name = result.name.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }
  return result;
}

/** Detect "S01E02" / "1x02" episode markers. */
export function parseEpisode(filename) {
  const base = path.basename(String(filename));
  let m = base.match(/\bS(\d{1,2})[ ._-]?E(\d{1,3})\b/i);
  if (m) return { season: Number.parseInt(m[1], 10), episode: Number.parseInt(m[2], 10) };
  m = base.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (m) return { season: Number.parseInt(m[1], 10), episode: Number.parseInt(m[2], 10) };
  return null;
}

/** 1080 -> "1080p", 2160 -> "4K". */
export function qualityLabel(height) {
  if (!height) return 'Auto';
  if (height >= 4320) return '8K';
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  return `${height}p`;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/**
 * Convert SubRip to WebVTT so the browser's <track> element can use it.
 *
 * The cue-index line is dropped with a horizontal-whitespace class rather than
 * `\s`: `\s` matches newlines, so it would also eat the blank line separating
 * the previous cue from this one, welding every cue in the file into a single
 * block that the parser then reads as one long caption.
 */
export function srtToVtt(srt) {
  const body = String(srt)
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^[ \t]*\d+[ \t]*\n(?=\d{2}:\d{2}:\d{2}[,.]\d{3})/gm, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body.trim()}\n`;
}

export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return { invalid: true };
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return { invalid: true };

  let start;
  let end;
  if (rawStart === '') {
    // Suffix range: last N bytes.
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true };
  if (start >= size) return { unsatisfiable: true };
  end = Math.min(end, size - 1);
  if (end < start) return { invalid: true };
  return { start, end, length: end - start + 1 };
}
