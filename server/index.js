import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import { config } from '../config.js';
import { RoomManager } from './rooms.js';
import { initSockets } from './sockets/index.js';
import { createRoomsRouter } from './routes/rooms.js';

const app = express();
app.set('trust proxy', true); // чтобы req.protocol/host были корректны за nginx
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5 * 1024 * 1024, // аватарки до 2 МБ приходят data URL внутри WS
});

const rooms = new RoomManager();
rooms.restore();

app.use(express.json());
app.use(createRoomsRouter(rooms));
app.use('/avatars', express.static(config.avatarsDir));
app.use(express.static(config.clientDir));

initSockets(io, rooms);

server.listen(config.port, () => {
  console.log(`[server] http://localhost:${config.port}`);
});
