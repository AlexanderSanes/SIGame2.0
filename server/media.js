import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from '../config.js';

// Определение формата по «магическим байтам» — content-type от клиента не доверяем
const SIGNATURES = [
  { kind: 'image', ext: 'png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { kind: 'image', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: 'image', ext: 'gif', test: (b) => b.toString('ascii', 0, 4) === 'GIF8' },
  { kind: 'image', ext: 'webp', test: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { kind: 'audio', ext: 'mp3', test: (b) => b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  { kind: 'audio', ext: 'wav', test: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE' },
  { kind: 'audio', ext: 'ogg', test: (b) => b.toString('ascii', 0, 4) === 'OggS' },
  { kind: 'video', ext: 'mp4', test: (b) => b.toString('ascii', 4, 8) === 'ftyp' },
  { kind: 'video', ext: 'webm', test: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
];

export function sniff(buffer) {
  if (buffer.length < 12) return null;
  return SIGNATURES.find((s) => s.test(buffer)) || null;
}

export function createUploadRouter(rooms) {
  const router = express.Router();
  fs.mkdirSync(config.uploadsDir, { recursive: true });

  // Бинарное тело без multipart: Content-Type = тип файла, прогресс рисует XHR
  router.post(
    '/api/upload',
    express.raw({ type: () => true, limit: `${Math.ceil(config.uploadLimits.video / 1024 / 1024)}mb` }),
    (req, res) => {
      // С ?room — загрузка ведущего в комнату (нужен hostToken).
      // Без ?room — загрузка в общую медиатеку из редактора пакетов.
      if (req.query.room) {
        const room = rooms.get(req.query.room);
        if (!room || req.get('x-host-token') !== room.hostToken) {
          return res.status(403).json({ ok: false, error: 'Нет доступа' });
        }
      }
      const kind = req.query.kind;
      if (!['image', 'audio', 'video'].includes(kind)) {
        return res.status(400).json({ ok: false, error: 'kind: image|audio|video' });
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return res.status(400).json({ ok: false, error: 'Пустой файл' });
      }
      const limit = config.uploadLimits[kind];
      if (body.length > limit) {
        return res.status(413).json({
          ok: false,
          error: `Файл больше ${Math.round(limit / 1024 / 1024)} МБ`,
        });
      }
      const sig = sniff(body);
      if (!sig || sig.kind !== kind) {
        return res.status(400).json({ ok: false, error: 'Формат файла не соответствует типу' });
      }
      const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 24);
      const fileName = `${hash}.${sig.ext}`;
      const filePath = path.join(config.uploadsDir, fileName);
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, body);
      res.json({ ok: true, url: `/uploads/${fileName}`, bytes: body.length });
    },
  );

  return router;
}
