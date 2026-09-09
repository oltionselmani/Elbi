/**
 * Render the sample library that ships inside the hosted build.
 *
 * The hosted copy has no server and no films of its own, so it carries a few
 * short clips instead — enough for every part of the app to be real rather than
 * mocked: two qualities of the same film so the quality menu has something to
 * switch between, a series with episodes so Up Next and Skip Intro work, and
 * Albanian and English subtitle tracks so the language handling can be seen.
 *
 * Chromium draws the frames (it has a JPEG encoder, node does not) and the
 * ffmpeg that ships with Playwright muxes them into VP8/WebM. Output lands in
 * web/sample/media and is committed, so an ordinary build needs neither.
 *
 *   node web/sample/make.mjs
 */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEDIA = path.join(HERE, 'media');
const CHROME = process.env.ELBI_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FFMPEG = process.env.ELBI_FFMPEG || '/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux';

// --------------------------------------------------------------------------
// what the library contains

const LOOKS = {
  harbour: { sky: ['#0a1024', '#1b2f4d', '#3a4f6b'], glow: '#ff8a3d', motif: 'harbour' },
  road: { sky: ['#2a1a10', '#6b3f22', '#c98b4b'], glow: '#ffd9a0', motif: 'road' },
  moths: { sky: ['#120c1c', '#2e2145', '#584077'], glow: '#e7d5ff', motif: 'moths' },
  peaks: { sky: ['#0b1418', '#1d3a3c', '#4d7d72'], glow: '#cfe9d6', motif: 'peaks' },
  shift: { sky: ['#100c0c', '#33191c', '#6b2f33'], glow: '#ff5a4d', motif: 'shift' },
};

const CLIPS = [
  { file: 'neon-harbour-1080p.webm', look: 'harbour', label: 'Neon Harbour', w: 1920, h: 1080, seconds: 34 },
  { file: 'neon-harbour-480p.webm', look: 'harbour', label: 'Neon Harbour', w: 854, h: 480, seconds: 34 },
  { file: 'salt-road-720p.webm', look: 'road', label: 'The Salt Road', w: 1280, h: 720, seconds: 30 },
  { file: 'paper-moths-1080p.webm', look: 'moths', label: 'Paper Moths', w: 1920, h: 1080, seconds: 30 },
  { file: 'quiet-peaks-720p.webm', look: 'peaks', label: 'The Quiet Peaks', w: 1280, h: 720, seconds: 26 },
  { file: 'night-shift-s01e01-720p.webm', look: 'shift', label: 'Night Shift · S01E01', w: 1280, h: 720, seconds: 30, intro: true },
  { file: 'night-shift-s01e02-720p.webm', look: 'shift', label: 'Night Shift · S01E02', w: 1280, h: 720, seconds: 28, intro: true },
  { file: 'night-shift-s01e03-720p.webm', look: 'shift', label: 'Night Shift · S01E03', w: 1280, h: 720, seconds: 28, intro: true },
  { file: 'night-shift-s02e01-720p.webm', look: 'shift', label: 'Night Shift · S02E01', w: 1280, h: 720, seconds: 28, intro: true },
];

const POSTERS = [
  { file: 'neon-harbour-poster.jpg', look: 'harbour', title: 'Neon Harbour', year: '2021' },
  { file: 'salt-road-poster.jpg', look: 'road', title: 'The Salt Road', year: '2019' },
  { file: 'paper-moths-poster.jpg', look: 'moths', title: 'Paper Moths', year: '2023' },
  { file: 'quiet-peaks-poster.jpg', look: 'peaks', title: 'The Quiet Peaks', year: '2018' },
  { file: 'night-shift-poster.jpg', look: 'shift', title: 'Night Shift', year: '2022' },
];

const BACKDROPS = [
  { file: 'neon-harbour-backdrop.jpg', look: 'harbour', title: '' },
  { file: 'salt-road-backdrop.jpg', look: 'road', title: '' },
  { file: 'paper-moths-backdrop.jpg', look: 'moths', title: '' },
  { file: 'quiet-peaks-backdrop.jpg', look: 'peaks', title: '' },
  { file: 'night-shift-backdrop.jpg', look: 'shift', title: '' },
];

// --------------------------------------------------------------------------
// drawing, in the page

/**
 * One frame of a clip. Deliberately simple shapes over a moving gradient:
 * flat colour compresses to almost nothing, which is what keeps nine clips
 * inside a single HTML file.
 */
function paintFrame({ look, label, width, height, t, seconds, intro }) {
  const ctx = this.getContext('2d');
  const { sky, glow, motif } = look;
  const drift = t / seconds;

  const sun = ctx.createLinearGradient(0, 0, width * 0.3, height);
  sun.addColorStop(0, sky[0]);
  sun.addColorStop(0.55 + Math.sin(t / 7) * 0.06, sky[1]);
  sun.addColorStop(1, sky[2]);
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, width, height);

  const halo = ctx.createRadialGradient(
    width * (0.25 + drift * 0.5), height * 0.34, 0,
    width * (0.25 + drift * 0.5), height * 0.34, height * 0.7,
  );
  halo.addColorStop(0, `${glow}55`);
  halo.addColorStop(1, 'transparent');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, width, height);

  const horizon = height * 0.66;

  if (motif === 'harbour' || motif === 'shift') {
    // A skyline of blocks, panning slowly, with lit windows.
    const pan = drift * width * 0.5;
    for (let i = -2; i < 26; i += 1) {
      const seed = (i * 9301 + 49297) % 233280 / 233280;
      const bw = width / 18 * (0.6 + seed * 0.9);
      const bh = height * (0.12 + seed * 0.34);
      const x = i * (width / 12) - pan;
      ctx.fillStyle = `rgba(4,6,12,${0.55 + seed * 0.35})`;
      ctx.fillRect(x, horizon - bh, bw, bh + height);
      ctx.fillStyle = glow;
      for (let wy = 0; wy < bh - 12; wy += Math.max(14, height / 40)) {
        for (let wx = 6; wx < bw - 10; wx += Math.max(12, width / 70)) {
          const lit = ((i * 31 + wy * 7 + wx * 3 + Math.floor(t * 2)) % 17) < 4;
          if (!lit) continue;
          ctx.globalAlpha = 0.35 + seed * 0.4;
          ctx.fillRect(x + wx, horizon - bh + wy + 8, Math.max(3, width / 320), Math.max(4, height / 200));
        }
      }
      ctx.globalAlpha = 1;
    }
    // Water, with a wobbling reflection.
    const water = ctx.createLinearGradient(0, horizon, 0, height);
    water.addColorStop(0, `${sky[1]}cc`);
    water.addColorStop(1, '#05070d');
    ctx.fillStyle = water;
    ctx.fillRect(0, horizon, width, height - horizon);
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = glow;
    for (let y = horizon + 6; y < height; y += Math.max(6, height / 90)) {
      const wob = Math.sin((y + t * 40) / 18) * width * 0.02;
      ctx.fillRect(width * 0.32 + wob, y, width * 0.1, Math.max(2, height / 400));
    }
    ctx.globalAlpha = 1;
  } else if (motif === 'road') {
    // Dunes and a road running to the vanishing point.
    for (let d = 0; d < 4; d += 1) {
      ctx.beginPath();
      ctx.moveTo(0, height);
      for (let x = 0; x <= width; x += width / 40) {
        const y = horizon + d * height * 0.06
          + Math.sin(x / (width / 4) + d * 1.7 + t / 5) * height * 0.03;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fillStyle = `rgba(${40 + d * 22},${24 + d * 16},${14 + d * 10},0.9)`;
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,240,220,.5)';
    ctx.lineWidth = Math.max(2, height / 260);
    ctx.setLineDash([height / 26, height / 22]);
    ctx.lineDashOffset = -t * height * 0.9;
    ctx.beginPath();
    ctx.moveTo(width * 0.5, horizon + height * 0.02);
    ctx.lineTo(width * 0.5 + width * 0.06, height);
    ctx.stroke();
    ctx.setLineDash([]);
  } else if (motif === 'moths') {
    // Slow drifting motes against a bruised sky.
    for (let i = 0; i < 60; i += 1) {
      const seed = (i * 7919) % 1000 / 1000;
      const x = ((seed * 1.4 + t / (12 + seed * 20)) % 1.2 - 0.1) * width;
      const y = ((seed * 0.8 + Math.sin(t / 3 + i) * 0.04 + i / 60) % 1) * height;
      const r = Math.max(1.5, (height / 300) * (0.5 + seed * 2));
      ctx.globalAlpha = 0.2 + seed * 0.5;
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else if (motif === 'peaks') {
    for (let d = 3; d >= 0; d -= 1) {
      ctx.beginPath();
      ctx.moveTo(0, height);
      const step = width / 8;
      for (let x = -step; x <= width + step; x += step) {
        const seed = Math.sin((x / step + d * 3.1) * 12.9898) * 43758.5453;
        const jag = (seed - Math.floor(seed));
        ctx.lineTo(x + Math.sin(t / 9 + d) * 6, horizon - height * (0.05 + d * 0.07 + jag * 0.16));
      }
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fillStyle = `rgba(${12 + d * 16},${26 + d * 20},${28 + d * 18},.95)`;
      ctx.fill();
    }
  }

  // Grain, so a still frame does not look like a flat PNG.
  ctx.globalAlpha = 0.05;
  for (let i = 0; i < 220; i += 1) {
    ctx.fillStyle = i % 2 ? '#fff' : '#000';
    ctx.fillRect(
      ((i * 3571 + Math.floor(t * 991)) % width),
      ((i * 7919 + Math.floor(t * 577)) % height),
      2, 2,
    );
  }
  ctx.globalAlpha = 1;

  // Title card over the opening seconds — which is also what the intro marker
  // in the library points at, so Skip Intro has something to skip.
  if (t < 7) {
    const fade = t < 5 ? 1 : 1 - (t - 5) / 2;
    ctx.globalAlpha = Math.min(1, fade) * (t < 0.6 ? t / 0.6 : 1);
    ctx.fillStyle = 'rgba(3,4,8,.55)';
    ctx.fillRect(0, 0, width, height);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${Math.round(height / 11)}px "Bebas Neue", Impact, sans-serif`;
    ctx.fillText(label.toUpperCase(), width / 2, height / 2);
    ctx.globalAlpha *= 0.75;
    ctx.font = `${Math.round(height / 34)}px system-ui, sans-serif`;
    ctx.fillText(intro ? 'opening titles' : 'a sample clip', width / 2, height / 2 + height / 13);
    ctx.globalAlpha = 1;
  }

  // Running clock, so a frozen picture is obvious at a glance.
  const mm = String(Math.floor(t / 60)).padStart(2, '0');
  const ss = String(Math.floor(t % 60)).padStart(2, '0');
  ctx.textAlign = 'right';
  ctx.font = `${Math.round(height / 26)}px ui-monospace, monospace`;
  ctx.fillStyle = 'rgba(255,255,255,.72)';
  ctx.fillText(`${mm}:${ss}`, width - height / 22, height - height / 20);

  ctx.fillStyle = '#ff4d2e';
  const barW = width / 6;
  ctx.fillRect(((t / seconds) * (width + barW)) - barW, height - height / 60, barW, height / 60);
}

function paintPoster({ look, title, year, width, height, wide }) {
  const ctx = this.getContext('2d');
  const { sky, glow } = look;
  const g = ctx.createLinearGradient(0, 0, width * 0.4, height);
  g.addColorStop(0, sky[0]);
  g.addColorStop(0.6, sky[1]);
  g.addColorStop(1, sky[2]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);

  const halo = ctx.createRadialGradient(width * 0.62, height * 0.3, 0, width * 0.62, height * 0.3, height * 0.6);
  halo.addColorStop(0, `${glow}66`);
  halo.addColorStop(1, 'transparent');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, width, height);

  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = glow;
  ctx.lineWidth = Math.max(1, width / 300);
  for (let i = 0; i < 9; i += 1) {
    ctx.beginPath();
    ctx.arc(width * 0.62, height * 0.3, height * (0.08 + i * 0.06), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const shade = ctx.createLinearGradient(0, height * 0.45, 0, height);
  shade.addColorStop(0, 'transparent');
  shade.addColorStop(1, 'rgba(3,4,8,.92)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, width, height);

  // A low skyline, so the card reads as a still and not as a gradient.
  ctx.fillStyle = 'rgba(2,3,7,.85)';
  for (let i = 0; i < 22; i += 1) {
    const seed = Math.abs(Math.sin((i + 1) * 12.9898) * 43758.5453) % 1;
    const bw = width / 14 * (0.5 + seed);
    ctx.fillRect(i * (width / 13) - width * 0.05, height * (0.62 + seed * 0.12), bw, height);
  }

  // A backdrop is a still from the film, so it carries no lettering — the sheet
  // puts the name over it already.
  if (!title) return;

  ctx.textAlign = wide ? 'left' : 'center';
  const x = wide ? width * 0.06 : width / 2;
  const room = wide ? width * 0.6 : width * 0.86;
  ctx.fillStyle = '#fff';

  // Fit rather than guess: a long name at a fixed size runs off the card.
  const words = title.toUpperCase().split(' ');
  const lines = !wide && words.length > 2 ? [words.slice(0, -1).join(' '), words.at(-1)] : [title.toUpperCase()];
  let size = Math.round(width / (wide ? 13 : 6.5));
  for (;;) {
    ctx.font = `700 ${size}px "Bebas Neue", Impact, Haettenschweiler, sans-serif`;
    if (size <= 12 || lines.every((line) => ctx.measureText(line).width <= room)) break;
    size -= 2;
  }
  const base = height * (wide ? 0.82 : 0.845) - (lines.length - 1) * size * 0.95;
  lines.forEach((line, i) => ctx.fillText(line, x, base + i * size * 0.95));

  if (year) {
    ctx.globalAlpha = 0.7;
    ctx.font = `${Math.round(width / (wide ? 44 : 24))}px system-ui, sans-serif`;
    ctx.fillText(year, x, height * (wide ? 0.9 : 0.925));
    ctx.globalAlpha = 1;
  }
}

// --------------------------------------------------------------------------
// driving it

const BATCH = 20;

async function renderClip(page, clip) {
  const fps = 8;
  const total = clip.seconds * fps;
  const frameDir = path.join(MEDIA, '.frames');
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });

  for (let start = 0; start < total; start += BATCH) {
    const batch = await page.evaluate(({ clip: c, look, start: from, count, fps: rate }) => {
      const canvas = document.createElement('canvas');
      canvas.width = c.w;
      canvas.height = c.h;
      const out = [];
      for (let i = from; i < from + count; i += 1) {
        window.paintFrame.call(canvas, {
          look, label: c.label, width: c.w, height: c.h, t: i / rate, seconds: c.seconds, intro: c.intro,
        });
        out.push(canvas.toDataURL('image/jpeg', 0.62).split(',')[1]);
      }
      return out;
    }, { clip, look: LOOKS[clip.look], start, count: Math.min(BATCH, total - start), fps });

    batch.forEach((b64, i) => {
      fs.writeFileSync(path.join(frameDir, `f${String(start + i).padStart(5, '0')}.jpg`), Buffer.from(b64, 'base64'));
    });
  }

  // image2 is not compiled into the bundled ffmpeg, so the frames go in as one
  // concatenated MJPEG stream — from a file rather than stdin, because tens of
  // megabytes through a synchronous pipe is how this fails.
  const files = fs.readdirSync(frameDir).sort();
  const reel = path.join(MEDIA, '.reel.mjpeg');
  fs.writeFileSync(reel, Buffer.concat(files.map((f) => fs.readFileSync(path.join(frameDir, f)))));
  const out = path.join(MEDIA, clip.file);
  execFileSync(FFMPEG, [
    // image2pipe guesses the codec from the file extension, and .mjpeg is not
    // one it knows, so it is named explicitly.
    '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', reel,
    '-c:v', 'libvpx', '-b:v', clip.h >= 1080 ? '260k' : clip.h >= 720 ? '170k' : '90k',
    '-crf', '40', '-deadline', 'good', '-cpu-used', '2',
    '-pix_fmt', 'yuv420p', '-an', out,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  fs.rmSync(reel, { force: true });
  fs.rmSync(frameDir, { recursive: true, force: true });
  return fs.statSync(out).size;
}

async function renderStill(page, spec, { width, height, wide }) {
  const b64 = await page.evaluate(({ spec: s, look, width: w, height: h, wide: isWide }) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    window.paintPoster.call(canvas, { look, title: s.title, year: s.year, width: w, height: h, wide: isWide });
    return canvas.toDataURL('image/jpeg', 0.78).split(',')[1];
  }, { spec, look: LOOKS[spec.look], width, height, wide });
  const out = path.join(MEDIA, spec.file);
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  return fs.statSync(out).size;
}

fs.mkdirSync(MEDIA, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.addScriptTag({ content: `window.paintFrame = ${paintFrame.toString()}; window.paintPoster = ${paintPoster.toString()};` });

let bytes = 0;
for (const spec of POSTERS) {
  bytes += await renderStill(page, spec, { width: 400, height: 600, wide: false });
  process.stdout.write(`poster ${spec.file}\n`);
}
for (const spec of BACKDROPS) {
  bytes += await renderStill(page, spec, { width: 960, height: 540, wide: true });
  process.stdout.write(`backdrop ${spec.file}\n`);
}
// --stills re-draws only the artwork, which takes a second rather than minutes.
if (!process.argv.includes('--stills')) {
  for (const clip of CLIPS) {
    const size = await renderClip(page, clip);
    bytes += size;
    process.stdout.write(`clip ${clip.file} — ${(size / 1024).toFixed(0)} KB\n`);
  }
}
await browser.close();

console.log(`\n${(bytes / 1024 / 1024).toFixed(2)} MB of sample media in ${MEDIA}`);
