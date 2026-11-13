import { db } from './db.js';
import { restoreTimers } from './game.js';
import { maintenance } from './maintenance.js';
import { httpSecurity } from './security.js';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import { config } from '../config.js';
import { RoomManager } from './rooms.js';
import { initSockets } from './sockets/index.js';
import { createRoomsRouter } from './routes/rooms.js';
import { createAdminRouter, localAdmin } from './routes/admin.js';
import { createPacksRouter } from './routes/packs.js';
import { createUploadRouter } from './media.js';
import { seedPacks } from './packs.js';

const app = express();
app.set('trust proxy', 'loopback'); // чтобы req.protocol/host были корректны за nginx
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5 * 1024 * 1024, // аватарки до 2 МБ приходят data URL внутри WS
});

seedPacks();
const rooms = new RoomManager();
rooms.restore();
app.use(httpSecurity);
app.get('/healthz', (_req, res) => {
  try { db.prepare('SELECT 1').get(); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});

app.use(createPacksRouter()); // до express.json(): у импорта пакетов свой лимит тела
app.use(express.json());
app.use(createAdminRouter(rooms, io));
app.use('/admin', localAdmin);
app.use(createRoomsRouter(rooms));
app.use(createUploadRouter(rooms));
app.use('/avatars', express.static(config.avatarsDir));
app.use('/uploads', express.static(config.uploadsDir, { maxAge: '1h' }));
// Табло: /room/ABCDE/screen
app.get('/room/:id/screen', (req, res) => {
  res.sendFile(path.join(config.clientDir, 'board', 'index.html'));
});
app.use(express.static(config.clientDir));

initSockets(io, rooms);
for (const room of rooms.rooms.values()) restoreTimers(io, rooms, room);
const stopMaintenance = maintenance(io, rooms);
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopMaintenance();
  rooms.flushAll();
  for (const room of rooms.rooms.values()) {
    for (const timer of Object.values(room._timers)) clearTimeout(timer);
  }
  io.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Используется изолированным тестом перезапуска; доступно только родительскому IPC-процессу.
if (process.send) process.on('message', (message) => { if (message === 'shutdown') shutdown(); });

app.use((error, _req, res, _next) => {
  const status = error.status >= 400 && error.status < 500 ? error.status : 500;
  if (status === 500) console.error('[http]', error);
  res.status(status).json({ ok: false, error: status === 413 ? 'Слишком большой запрос' : status === 500 ? 'Внутренняя ошибка сервера' : 'Некорректный запрос' });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[server] Порт ${config.port} уже занят. Если игра уже запущена, откройте http://localhost:${config.port}. Для второго сервера задайте другой PORT (PowerShell: $env:PORT=3001; npm start).`);
  } else {
    console.error('[server] Не удалось запустить сервер:', error);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log(`[server] http://localhost:${config.port}`);
});
