import { Router } from 'express';
import QRCode from 'qrcode';
import { getLanIp } from '../net.js';

// Базовый URL, по которому комната доступна игрокам с других устройств:
// если ведущий открыл страницу через localhost — подменяем на LAN-IP сервера
export function externalBaseUrl(req) {
  const host = req.get('host'); // hostname:port
  const hostname = req.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    const lanIp = getLanIp();
    if (lanIp) return `${req.protocol}://${host.replace(hostname, lanIp)}`;
  }
  return `${req.protocol}://${host}`;
}

export function createRoomsRouter(rooms) {
  const router = Router();

  router.get('/api/rooms/:id', (req, res) => {
    const room = rooms.get(req.params.id);
    if (!room) return res.status(404).json({ ok: false, error: 'Комната не найдена' });
    res.json({
      ok: true,
      roomId: room.id,
      phase: room.phase,
      playersCount: room.players.size,
      joinUrl: `${externalBaseUrl(req)}/player/?room=${room.id}`,
    });
  });

  router.get('/api/qr', async (req, res, next) => {
    try {
      const text = String(req.query.text || '');
      if (!text || text.length > 500) {
        return res.status(400).json({ ok: false, error: 'Параметр text обязателен (до 500 символов)' });
      }
      const dataUrl = await QRCode.toDataURL(text, { margin: 1, width: 360 });
      res.json({ ok: true, dataUrl });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
