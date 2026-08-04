// Generates PWA icons (flashcard glyph on indigo) without any image deps:
// draws pixels directly and writes minimal PNGs via zlib.
import { deflateSync } from 'node:zlib';
import { writeFileSync, existsSync } from 'node:fs';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// signed distance to a rounded rectangle centered at 0,0
function roundedRect(x, y, hw, hh, r) {
  const dx = Math.abs(x) - (hw - r);
  const dy = Math.abs(y) - (hh - r);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - r;
}

const BG = [79, 70, 229];       // indigo-600
const CARD = [255, 255, 255];
const BAR1 = [165, 180, 252];   // indigo-300
const BAR2 = [199, 210, 254];   // indigo-200

function drawIcon(size, opaque) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size;
  const rot = -8 * (Math.PI / 180);
  const cos = Math.cos(rot), sin = Math.sin(rot);

  for (let py = 0; py < s; py++) {
    for (let px = 0; px < s; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      // 2x2 supersampling
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const x = px + ox, y = py + oy;
        let sr, sg, sb, sa;
        const dBg = roundedRect(x - s / 2, y - s / 2, s / 2, s / 2, s * 0.21);
        if (opaque || dBg < 0) {
          [sr, sg, sb] = BG; sa = 255;
          // rotate into card space
          const rx = (x - s / 2) * cos - (y - s / 2) * sin;
          const ry = (x - s / 2) * sin + (y - s / 2) * cos;
          if (roundedRect(rx, ry, s * 0.31, s * 0.22, s * 0.05) < 0) {
            [sr, sg, sb] = CARD;
            // text-line bars on the card
            if (roundedRect(rx + s * 0.06, ry + s * 0.08, s * 0.17, s * 0.035, s * 0.03) < 0) [sr, sg, sb] = BAR1;
            if (roundedRect(rx - s * 0.02, ry + s * 0.0, s * 0.21, s * 0.035, s * 0.03) < 0) [sr, sg, sb] = BAR2;
          }
        } else {
          sr = sg = sb = sa = 0;
        }
        r += sr; g += sg; b += sb; a += sa;
      }
      const i = (py * s + px) * 4;
      rgba[i] = r / 4; rgba[i + 1] = g / 4; rgba[i + 2] = b / 4; rgba[i + 3] = a / 4;
    }
  }
  return encodePng(s, rgba);
}

export function generateIcons() {
  const targets = [
    ['public/icon-192.png', 192, false],
    ['public/icon-512.png', 512, false],
    ['public/apple-touch-icon.png', 180, true],
  ];
  for (const [path, size, opaque] of targets) {
    if (!existsSync(path)) {
      writeFileSync(path, drawIcon(size, opaque));
      console.log(`generated ${path}`);
    }
  }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) generateIcons();
