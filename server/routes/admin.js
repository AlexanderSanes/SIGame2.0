import { Router } from 'express';
import { config } from '../../config.js';

export function adminAccess(req, res, next) {
  const address = req.socket.remoteAddress;
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
  const hostname = req.hostname;
  const localHost = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
  const forwarded = ['forwarded', 'x-forwarded-for', 'x-real-ip', 'x-forwarded-host',
    'x-forwarded-proto', 'x-sigame-admin-proxy'].some(h => req.get(h));
  const origin = req.get('origin');
  const requestOrigin = `${req.protocol}://${req.get('host')}`;
  const direct = local && localHost && !forwarded && (!origin || origin === requestOrigin);
  const readOnly = req.method === 'GET' || req.method === 'HEAD';
  // Nginx перезаписывает маркер и ставит его только для защищённых Basic Auth маршрутов.
  const proxied = config.adminProxyEnabled && config.host === '127.0.0.1' && local
    && req.get('x-sigame-admin-proxy') === '1' && req.protocol === 'https'
    && requestOrigin === config.publicUrl
    && (origin === requestOrigin || (!origin && readOnly));
  if (!direct && !proxied) {
    return res.status(403).json({ ok: false, error: 'Управление доступно через localhost или защищённый HTTPS-вход' });
  }
  res.set('Cache-Control', 'no-store');
  next();
}

export function createAdminRouter(rooms, io) {
  const router = Router();
  router.use('/api/admin', adminAccess);
  router.get('/api/admin/rooms', (_req, res) => {
    const list = [...rooms.rooms.values()].map(room => ({
      id: room.id, title: room.pack.title, phase: room.phase,
      players: room.players.size,
      connections: io.sockets.adapter.rooms.get(room.id)?.size || 0,
      createdAt: room.createdAt, updatedAt: room.updatedAt,
    })).sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ ok: true, rooms: list, roomIdleMs: config.roomIdleMs });
  });
  // Ключи не попадают в список, URL или логи; восстановление требует явного действия.
  router.post('/api/admin/rooms/:id/access', (req, res) => {
    const room = rooms.get(req.params.id);
    if (!room) return res.status(404).json({ ok: false, error: 'Комната не найдена' });
    res.json({ ok: true, roomId: room.id, hostToken: room.hostToken });
  });
  router.delete('/api/admin/rooms/:id', (req, res) => {
    const room = rooms.get(req.params.id);
    if (!room) return res.status(404).json({ ok: false, error: 'Комната не найдена' });
    // Удаляем состояние до отключения клиентов, чтобы disconnect не создал новый снимок.
    rooms.deleteRoom(room);
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data?.roomId !== room.id) continue;
      socket.emit('room:deleted', { roomId: room.id });
      for (const channel of socket.rooms) if (channel !== socket.id) socket.leave(channel);
      socket.data = {};
    }
    res.json({ ok: true });
  });
  return router;
}
