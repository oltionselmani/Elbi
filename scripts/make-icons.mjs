#!/usr/bin/env node
/**
 * Build every icon Elbi ships from one master image.
 *
 *   node scripts/make-icons.mjs
 *
 * Input is assets/elbi-logo.png. Output is the PNG set the web app manifest
 * points at, plus a Windows .ico for the desktop shortcut. No image library:
 * node's zlib is enough to read and write a PNG, and the only other thing
 * needed is an area-average downscale, which is a dozen lines.
 *
 * Re-run it after replacing assets/elbi-logo.png and the whole set follows.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASTER = path.join(ROOT, 'assets', 'elbi-logo.png');
const OUT = path.join(ROOT, 'public', 'icons');

// --------------------------------------------------------------------------
// PNG

function crc32(buf) {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
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

/** RGBA pixels → a PNG file. */
function encodePng(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;   // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** A PNG file → { width, height, pixels } as RGBA. */
function decodePng(file) {
  if (file.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let header = null;
  const idat = [];

  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('ascii', offset + 4, offset + 8);
    const data = file.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (!header) throw new Error('PNG has no header');
  if (header.depth !== 8) throw new Error(`only 8-bit PNGs are supported, this is ${header.depth}-bit`);
  if (header.interlace) throw new Error('interlaced PNGs are not supported');
  const channels = CHANNELS[header.colorType];
  if (!channels) throw new Error(`unsupported colour type ${header.colorType} (palettes are not handled)`);

  const { width, height } = header;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const lines = Buffer.alloc(stride * height);

  // Undo the per-line filters. Each one predicts a byte from its neighbours.
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const from = y * (stride + 1) + 1;
    const to = y * stride;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[from + i];
      const a = i >= channels ? lines[to + i - channels] : 0;
      const b = y > 0 ? lines[to - stride + i] : 0;
      const c = y > 0 && i >= channels ? lines[to - stride + i - channels] : 0;
      let value;
      if (filter === 0) value = x;
      else if (filter === 1) value = x + a;
      else if (filter === 2) value = x + b;
      else if (filter === 3) value = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`unknown PNG filter ${filter}`);
      lines[to + i] = value & 0xff;
    }
  }

  // Everything becomes RGBA, so the rest of the script has one shape to think about.
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const s = i * channels;
    const d = i * 4;
    if (channels === 4) {
      lines.copy(pixels, d, s, s + 4);
    } else if (channels === 3) {
      pixels[d] = lines[s]; pixels[d + 1] = lines[s + 1]; pixels[d + 2] = lines[s + 2]; pixels[d + 3] = 255;
    } else if (channels === 2) {
      pixels[d] = pixels[d + 1] = pixels[d + 2] = lines[s];
      pixels[d + 3] = lines[s + 1];
    } else {
      pixels[d] = pixels[d + 1] = pixels[d + 2] = lines[s];
      pixels[d + 3] = 255;
    }
  }
  return { width, height, pixels };
}

// --------------------------------------------------------------------------
// resizing

/**
 * Area-average downscale: every output pixel is the mean of the input pixels it
 * covers. Slower than picking a nearest neighbour and far kinder to lettering,
 * which is the whole of this logo.
 */
function resize(image, size) {
  const out = Buffer.alloc(size * size * 4);
  const scale = image.width / size;
  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * scale);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale));
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale));
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let sy = y0; sy < y1 && sy < image.height; sy += 1) {
        for (let sx = x0; sx < x1 && sx < image.width; sx += 1) {
          const i = (sy * image.width + sx) * 4;
          const alpha = image.pixels[i + 3];
          // Weight colour by alpha so transparent edges do not drag it dark.
          r += image.pixels[i] * alpha;
          g += image.pixels[i + 1] * alpha;
          b += image.pixels[i + 2] * alpha;
          a += alpha;
          n += 1;
        }
      }
      const d = (y * size + x) * 4;
      out[d] = a ? Math.round(r / a) : 0;
      out[d + 1] = a ? Math.round(g / a) : 0;
      out[d + 2] = a ? Math.round(b / a) : 0;
      out[d + 3] = Math.round(a / n);
    }
  }
  return { width: size, height: size, pixels: out };
}

/** Paste one square image into the middle of a solid square of another size. */
function onBackground(image, size, inset, [br, bg, bb]) {
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    out[i * 4] = br; out[i * 4 + 1] = bg; out[i * 4 + 2] = bb; out[i * 4 + 3] = 255;
  }
  const inner = Math.round(size * (1 - inset * 2));
  const small = resize(image, inner);
  const offset = Math.round((size - inner) / 2);
  for (let y = 0; y < inner; y += 1) {
    for (let x = 0; x < inner; x += 1) {
      const s = (y * inner + x) * 4;
      const d = ((y + offset) * size + (x + offset)) * 4;
      const alpha = small.pixels[s + 3] / 255;
      out[d] = Math.round(small.pixels[s] * alpha + out[d] * (1 - alpha));
      out[d + 1] = Math.round(small.pixels[s + 1] * alpha + out[d + 1] * (1 - alpha));
      out[d + 2] = Math.round(small.pixels[s + 2] * alpha + out[d + 2] * (1 - alpha));
      out[d + 3] = 255;
    }
  }
  return { width: size, height: size, pixels: out };
}

// --------------------------------------------------------------------------
// ICO, for the Windows shortcut

function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);   // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach((entry, i) => {
    const at = i * 16;
    directory[at] = entry.size >= 256 ? 0 : entry.size;      // 0 means 256
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 2] = 0;   // palette
    directory[at + 3] = 0;   // reserved
    directory.writeUInt16LE(1, at + 4);    // colour planes
    directory.writeUInt16LE(32, at + 6);   // bits per pixel
    directory.writeUInt32LE(entry.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((e) => e.png)]);
}

// --------------------------------------------------------------------------

if (!fs.existsSync(MASTER)) {
  console.error(`No master image at ${MASTER}. Put the logo there and run this again.`);
  process.exit(1);
}

const master = decodePng(fs.readFileSync(MASTER));
if (master.width !== master.height) {
  console.error(`The master must be square; this one is ${master.width}×${master.height}.`);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const write = (name, buffer) => {
  fs.writeFileSync(path.join(OUT, name), buffer);
  console.log(`  ${name.padEnd(24)} ${(buffer.length / 1024).toFixed(1)} KB`);
};

console.log(`from assets/elbi-logo.png (${master.width}×${master.height}):`);
for (const size of [32, 192, 512]) {
  const scaled = resize(master, size);
  write(`elbi-${size}.png`, encodePng(size, size, scaled.pixels));
}

// Android crops a maskable icon to whatever shape the launcher uses, so the
// artwork is pulled into the safe circle and the corners are filled in.
const maskable = onBackground(master, 512, 0.14, [0, 0, 0]);
write('elbi-maskable-512.png', encodePng(512, 512, maskable.pixels));

// Windows shortcuts want an .ico, and it may simply carry PNGs inside.
write('elbi.ico', ico([16, 32, 48, 256].map((size) => ({
  size,
  png: encodePng(size, size, resize(master, size).pixels),
}))));
