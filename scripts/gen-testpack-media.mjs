// Генерирует тестовые медиа-ассеты в client/testpack-media/ (запуск: node scripts/gen-testpack-media.mjs)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'testpack-media');
fs.mkdirSync(outDir, { recursive: true });

// --- минимальный PNG-энкодер (truecolor 8 бит, фильтр 0) ---
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(width, height, pixelAt) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelAt(x, y);
      const o = row + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// flag.png 320x200: триколор (белый/синий/красный)
const flag = encodePng(320, 200, (x, y) => {
  if (y < 67) return [240, 240, 240];
  if (y < 134) return [32, 56, 160];
  return [200, 32, 40];
});

// rings.png 400x240: пять цветных колец на тёмном фоне
const rings = encodePng(400, 240, (x, y) => {
  const cols = [[0, 140, 220], [240, 180, 0], [20, 20, 20], [0, 160, 60], [220, 40, 40]];
  const centers = [[100, 90], [200, 90], [300, 90], [150, 160], [250, 160]];
  for (let i = 0; i < 5; i++) {
    const d = Math.hypot(x - centers[i][0], y - centers[i][1]);
    if (d > 38 && d < 48) return cols[i];
  }
  return [24, 24, 40];
});

// tone.wav: синус 440 Гц, 1.5 с, 8 кГц, 16 бит mono
const rate = 8000, secs = 1.5, n = rate * secs;
const data = Buffer.alloc(n * 2);
for (let i = 0; i < n; i++) {
  data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.6 * 32767), i * 2);
}
const wav = Buffer.alloc(44);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + data.length, 4); wav.write('WAVE', 8);
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(data.length, 40);

fs.writeFileSync(path.join(outDir, 'flag.png'), flag);
fs.writeFileSync(path.join(outDir, 'rings.png'), rings);
fs.writeFileSync(path.join(outDir, 'tone.wav'), Buffer.concat([wav, data]));
console.log('OK:', fs.readdirSync(outDir).join(', '));
