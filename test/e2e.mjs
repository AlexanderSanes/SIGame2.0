import { io } from './socket-client.mjs';

const PORT = process.env.PORT || 3000;
const BASE = `http://localhost:${PORT}`;

// 1x1 px PNG
const TINY_AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let passed = 0;
let failed = 0;

function check(name, condition, extra = '') {
  if (condition) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.error(`  ✘ ${name} ${extra}`);
  }
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

function call(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function waitFor(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${event}`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function main() {
  console.log('E2E тест этапа 1 (MVP: комнаты и лобби)\n');

  // 0. HTTP
  const landing = await fetch(`${BASE}/`);
  check('GET / отдаёт 200', landing.status === 200);
  const qr = await (await fetch(`${BASE}/api/qr?text=${encodeURIComponent('http://x/player/?room=ABCDE')}`)).json();
  check('GET /api/qr возвращает data URL', qr.ok && qr.dataUrl.startsWith('data:image/png'));  // 1. Создание комнаты
  const host = await connect();
  const created = await call(host, 'room:create', {});
  check('room:create возвращает код и hostToken', created.ok && /^[A-Z2-9]{5}$/.test(created.roomId) && !!created.hostToken);
  const { roomId, hostToken } = created;

  const roomInfo = await (await fetch(`${BASE}/api/rooms/${roomId}`)).json();
  check('GET /api/rooms/:id возвращает joinUrl', roomInfo.ok && roomInfo.joinUrl?.includes(`/player/?room=${roomId}`));
  check('joinUrl без localhost (подставлен LAN-IP)', !roomInfo.joinUrl?.includes('localhost'), `→ ${roomInfo.joinUrl}`);

  const hostAuth = await call(host, 'session:resume', { roomId, hostToken });
  check('host session:resume → role host', hostAuth.ok && hostAuth.role === 'host' && hostAuth.state.phase === 'lobby');

  const badHost = await connect();
  const badAuth = await call(badHost, 'session:resume', { roomId, hostToken: 'wrong' });
  check('неверный hostToken отклоняется', !badAuth.ok);
  badHost.disconnect();

  // 2. Вход игроков
  const p1 = await connect();
  const lobbySeenByHost = waitFor(host, 'lobby:players');
  const j1 = await call(p1, 'room:join', { roomId, nick: 'Игрок1', avatar: TINY_AVATAR });
  check('room:join игрока 1', j1.ok && j1.playerId && j1.sessionToken);
  check('аватар сохранён и доступен по URL', !!j1.state.players.find((p) => p.avatarUrl));
  const hostSaw1 = await lobbySeenByHost;
  check('ведущий получил lobby:players (1 игрок)', hostSaw1.length === 1);

  const avatarUrl = j1.state.players[0].avatarUrl;
  const avatarResp = await fetch(`${BASE}${avatarUrl}`);
  check('аватарка отдаётся по HTTP', avatarResp.status === 200);

  const p2 = await connect();
  const lobbySeenByP1 = waitFor(p1, 'lobby:players');
  const j2 = await call(p2, 'room:join', { roomId, nick: 'Игрок2' });
  check('room:join игрока 2', j2.ok);
  const p1Saw2 = await lobbySeenByP1;
  check('игрок 1 видит двоих в лобби', p1Saw2.length === 2);

  // 3. Валидации
  const dup = await connect();
  const dupJoin = await call(dup, 'room:join', { roomId, nick: 'игрок1' });
  check('дубль ника (в другом регистре) отклоняется', !dupJoin.ok && /занят/.test(dupJoin.error));
  const shortNick = await call(dup, 'room:join', { roomId, nick: 'я' });
  check('короткий ник отклоняется', !shortNick.ok);
  const badRoom = await call(dup, 'room:join', { roomId: 'ZZZZZ', nick: 'НормНик' });
  check('несуществующая комната отклоняется', !badRoom.ok);
  const badAvatar = await call(dup, 'room:join', { roomId, nick: 'НормНик', avatar: 'data:image/gif;base64,R0lGOD' });
  check('gif-аватар отклоняется', !badAvatar.ok && /jpg|png|webp/.test(badAvatar.error));
  dup.disconnect();

  // 4. Кик
  const kickedPromise = waitFor(p1, 'room:kicked');
  const lobbyAfterKick = waitFor(p2, 'lobby:players');
  const kickRes = await call(host, 'player:kick', { playerId: j1.playerId });
  check('player:kick от ведущего', kickRes.ok);
  await kickedPromise;
  check('кикнутый получил room:kicked', true);
  const afterKick = await lobbyAfterKick;
  check('лобби обновилось: остался 1 игрок', afterKick.length === 1 && afterKick[0].nick === 'Игрок2');

  const kickByPlayer = await call(p2, 'player:kick', { playerId: j2.playerId });
  check('player:kick от игрока отклоняется', !kickByPlayer.ok);

  // кикнутый может вернуться под тем же ником (ник освободился)
  const rejoin = await call(p1, 'room:join', { roomId, nick: 'Игрок1' });
  check('кикнутый входит заново под тем же ником', rejoin.ok);

  // 5. Переподключение
  p2.disconnect();
  await new Promise((r) => setTimeout(r, 200));
  const p2new = await connect();
  const resume = await call(p2new, 'session:resume', {
    roomId, playerId: j2.playerId, sessionToken: j2.sessionToken,
  });
  check('session:resume игрока после переподключения', resume.ok && resume.role === 'player');
  check('state:full содержит обоих игроков', resume.state.players.length === 2);

  const badResume = await call(p2new, 'session:resume', {
    roomId, playerId: j2.playerId, sessionToken: 'wrong',
  });
  check('неверный sessionToken отклоняется', !badResume.ok);

  // 6. Выход игрока (смена ника)
  const lobbyAfterLeave = waitFor(host, 'lobby:players');
  const leave = await call(p2new, 'player:leave', {});
  check('player:leave принят', leave.ok);
  const afterLeave = await lobbyAfterLeave;
  check('после выхода в лобби остался 1 игрок', afterLeave.length === 1 && afterLeave[0].nick === 'Игрок1');
  const rejoinNewNick = await call(p2new, 'room:join', { roomId, nick: 'НовыйНик' });
  check('после выхода можно зайти под другим ником', rejoinNewNick.ok);
  // ник вышедшего освободился
  const p3 = await connect();
  const reuseNick = await call(p3, 'room:join', { roomId, nick: 'Игрок2' });
  check('ник вышедшего игрока свободен', reuseNick.ok);
  p3.disconnect();

  host.disconnect();
  p1.disconnect();
  p2new.disconnect();

  console.log(`\nИтог: ${passed} пройдено, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('Тест упал с ошибкой:', e);
  process.exit(1);
});
