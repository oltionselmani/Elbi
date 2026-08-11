#!/usr/bin/env node
/**
 * Generate the PWA PNG icons from scratch — no image library required.
 * Run: node scripts/make-icons.mjs
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

function crc32(buf) {
  let c;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Elbi mark: rounded red square, a white bar and a white play triangle. */
function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 512;
  const radius = 104 * s;
  const inner = { x: 40 * s, y: 40 * s, w: 432 * s, h: 432 * s, r: 76 * s };

  const inRounded = (x, y, rx, ry, rw, rh, r) => {
    if (x < rx || y < ry || x > rx + rw || y > ry + rh) return false;
    const cx = Math.min(Math.max(x, rx + r), rx + rw - r);
    const cy = Math.min(Math.max(y, ry + r), ry + rh - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      let [r, g, b, a] = [0, 0, 0, 0];

      if (inRounded(x, y, 0, 0, size, size, radius)) {
        [r, g, b, a] = [8, 8, 12, 255];
      }
      if (inRounded(x, y, inner.x, inner.y, inner.w, inner.h, inner.r)) {
        // Diagonal gradient from the lamp highlight #ff7a4a to its deep #b81d13.
        const t = ((x - inner.x) / inner.w + (y - inner.y) / inner.h) / 2;
        r = Math.round(255 + (184 - 255) * t);
        g = Math.round(122 + (29 - 122) * t);
        b = Math.round(74 + (19 - 74) * t);
        a = 255;
      }
      // Vertical bar (the "l" of Elbi).
      if (inRounded(x, y, 118 * s, 152 * s, 46 * s, 208 * s, 14 * s)) {
        [r, g, b, a] = [255, 255, 255, 255];
      }
      // Play triangle: (206,152) → (206,360) → (366,256).
      const tx = 206 * s;
      const ty0 = 152 * s;
      const ty1 = 360 * s;
      const txe = 366 * s;
      if (x >= tx && x <= txe) {
        const k = (x - tx) / (txe - tx);
        const top = ty0 + ((ty1 - ty0) / 2) * k;
        const bottom = ty1 - ((ty1 - ty0) / 2) * k;
        if (y >= top && y <= bottom) [r, g, b, a] = [255, 255, 255, 255];
      }

      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
    }
  }
  return png(size, size, px);
}

fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(outDir, `elbi-${size}.png`);
  fs.writeFileSync(file, draw(size));
  console.log(`wrote ${file}`);
}
