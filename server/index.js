import path from 'node:path';
import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import { config } from '../config.js';
import { RoomManager } from './rooms.js';
import { initSockets } from './sockets/index.js';
import { createRoomsRouter } from './routes/rooms.js';
import { createPacksRouter } from './routes/packs.js';
import { createUploadRouter } from './media.js';
import { seedPacks } from './packs.js';

const app = express();
app.set('trust proxy', true); // чтобы req.protocol/host были корректны за nginx
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5 * 1024 * 1024, // аватарки до 2 МБ приходят data URL внутри WS
});

const rooms = new RoomManager();
rooms.restore();
seedPacks();

app.use(createPacksRouter()); // до express.json(): у импорта пакетов свой лимит тела
app.use(express.json());
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

server.listen(config.port, () => {
  console.log(`[server] http://localhost:${config.port}`);
});
