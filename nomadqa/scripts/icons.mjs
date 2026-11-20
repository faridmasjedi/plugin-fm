// Draws the NomadQA icons (a violet rounded square with a white check mark) as PNGs, with Node only.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const clamp = (v) => Math.max(0, Math.min(1, v));
function icon(size) {
  const s = size;
  const r = s * 0.22;
  const violet = [91, 63, 209];
  return png(s, (x, y) => {
    // Rounded square coverage
    const qx = Math.max(Math.abs(x - s / 2) - (s / 2 - r), 0);
    const qy = Math.max(Math.abs(y - s / 2) - (s / 2 - r), 0);
    const inside = clamp(r - Math.hypot(qx, qy) + 0.5);
    // Check mark, two strokes
    const w = s * 0.085;
    const d = Math.min(
      segDist(x, y, s * 0.27, s * 0.53, s * 0.43, s * 0.69),
      segDist(x, y, s * 0.43, s * 0.69, s * 0.74, s * 0.33)
    );
    const mark = clamp(w - d + 0.5);
    const c = violet.map((v) => Math.round(v + (255 - v) * mark));
    return [...c, Math.round(255 * inside)];
  });
}
const dir = fileURLToPath(new URL('../extension/icons/', import.meta.url));
for (const size of [16, 32, 48, 128]) writeFileSync(`${dir}${size}.png`, icon(size));
console.log('icons written');
