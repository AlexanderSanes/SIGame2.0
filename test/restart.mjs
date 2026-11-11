// Тест восстановления после перезапуска сервера:
// 1) создаёт комнату и игрока, сохраняет токены в файл;
// 2) после перезапуска сервера проверяет session:resume обеих ролей.
import { io } from 'socket.io-client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://localhost:3000';
const sessionFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '.restart-session.json');

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

const call = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

const mode = process.argv[2];

if (mode === 'setup') {
  const socket = await connect();
  const created = await call(socket, 'room:create', {});
  const joined = await call(socket, 'room:join', { roomId: created.roomId, nick: 'Рестарт' });
  fs.writeFileSync(sessionFile, JSON.stringify({
    roomId: created.roomId,
    hostToken: created.hostToken,
    playerId: joined.playerId,
    sessionToken: joined.sessionToken,
  }));
  console.log(`setup: комната ${created.roomId}, игрок сохранён`);
  socket.disconnect();
  process.exit(0);
}

if (mode === 'verify') {
  const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  const socket = await connect();
  const playerResume = await call(socket, 'session:resume', {
    roomId: saved.roomId, playerId: saved.playerId, sessionToken: saved.sessionToken,
  });
  const hostResume = await call(socket, 'session:resume', {
    roomId: saved.roomId, hostToken: saved.hostToken,
  });
  console.log('player resume:', playerResume.ok, '| ник:', playerResume.state?.players?.[0]?.nick);
  console.log('host resume:', hostResume.ok, hostResume.role);
  socket.disconnect();
  fs.unlinkSync(sessionFile);
  const ok = playerResume.ok && hostResume.ok && hostResume.role === 'host';
  console.log(ok ? 'RESTART-ТЕСТ ПРОЙДЕН' : 'RESTART-ТЕСТ ПРОВАЛЕН');
  process.exit(ok ? 0 : 1);
}

console.error('usage: node test/restart.mjs [setup|verify]');
process.exit(1);
