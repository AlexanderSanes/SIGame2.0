import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from './socket-client.mjs';

const BASE = `http://localhost:${process.env.PORT || 3000}`;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const uploadsDir = path.join(root, 'data', 'uploads');

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

const call = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

function waitFor(socket, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${event}`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function upload(roomId, hostToken, kind, buffer, contentType) {
  const res = await fetch(`${BASE}/api/upload?room=${roomId}&kind=${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'x-host-token': hostToken || '' },
    body: buffer,
  });
  let json = {};
  try { json = await res.json(); } catch { /* не-json */ }
  return { status: res.status, ...json };
}

// --- минимальный валидный MP4: free + ftyp ---
function fakeMp4() {
  const head = Buffer.alloc(16);
  head.writeUInt32BE(16, 0);
  head.write('ftyp', 4, 'ascii');
  head.write('isom', 8, 'ascii');
  return head;
}

async function setupRoom(settings = {}) {
  const host = await connect();
  const { roomId, hostToken } = await call(host, 'room:create', {});
  await call(host, 'session:resume', { roomId, hostToken });
  if (Object.keys(settings).length) await call(host, 'settings:update', settings);
  const board = await connect();
  await call(board, 'board:watch', { roomId });
  const player = await connect();
  const join = await call(player, 'room:join', { roomId, nick: 'Маша' });
  return { host, board, player, roomId, hostToken, playerId: join.playerId, sessionToken: join.sessionToken };
}

async function main() {
  console.log('Этап 4: медиа\n');

  // ---------- Загрузка файлов ----------
  console.log('— загрузка —');
  const ctx = await setupRoom({ buzzTimeoutSec: 5 });
  const { roomId, hostToken } = ctx;

  const png = fs.readFileSync(path.join(root, 'client', 'testpack-media', 'flag.png'));
  const wav = fs.readFileSync(path.join(root, 'client', 'testpack-media', 'tone.wav'));

  const upPng = await upload(roomId, hostToken, 'image', png, 'image/png');
  check('PNG загружен', upPng.status === 200 && upPng.ok && upPng.url.endsWith('.png'), JSON.stringify(upPng));
  check('PNG лежит в data/uploads', upPng.url && fs.existsSync(path.join(uploadsDir, path.basename(upPng.url))));

  const upWav = await upload(roomId, hostToken, 'audio', wav, 'audio/wav');
  check('WAV загружен', upWav.status === 200 && upWav.ok && upWav.url.endsWith('.wav'), JSON.stringify(upWav));

  const upMp4 = await upload(roomId, hostToken, 'video', fakeMp4(), 'video/mp4');
  check('MP4 загружен', upMp4.status === 200 && upMp4.ok && upMp4.url.endsWith('.mp4'), JSON.stringify(upMp4));

  const big = Buffer.alloc(6 * 1024 * 1024, 1);
  const upBig = await upload(roomId, hostToken, 'image', big, 'image/png');
  check('картинка >5 МБ → 413', upBig.status === 413 && !upBig.ok, JSON.stringify(upBig));

  const upWrong = await upload(roomId, hostToken, 'audio', png, 'image/png');
  check('PNG как audio → 400', upWrong.status === 400 && !upWrong.ok, JSON.stringify(upWrong));

  const upNoAuth = await upload(roomId, 'wrong-token', 'image', png, 'image/png');
  check('без hostToken → 403', upNoAuth.status === 403 && !upNoAuth.ok);

  const upNoRoom = await upload('ZZZZZ', hostToken, 'image', png, 'image/png');
  check('несуществующая комната → 403', upNoRoom.status === 403);

  const fileRes = await fetch(`${BASE}${upPng.url}`);
  check('загруженный файл отдаётся по /uploads', fileRes.status === 200);

  // ---------- Медиа в игре: табло и ведущий видят, игрок без настройки — нет ----------
  console.log('— показ вопроса с медиа —');
  const roundMediaP = waitFor(ctx.host, 'round:media');
  await call(ctx.host, 'game:start', {});
  const roundMedia = await roundMediaP;
  check('round:media при старте игры', Array.isArray(roundMedia.urls) && roundMedia.urls.some((u) => u.includes('flag.png')), JSON.stringify(roundMedia));

  // География 300 (0,2) — вопрос с картинкой
  const hostQ = waitFor(ctx.host, 'question:show');
  const boardQ = waitFor(ctx.board, 'question:show');
  const playerQ = waitFor(ctx.player, 'question:show');
  await call(ctx.host, 'board:select', { themeIdx: 0, qIdx: 2 });
  const [hq, bq, pq] = await Promise.all([hostQ, boardQ, playerQ]);
  check('ведущий получил media вопроса', Array.isArray(hq.media) && hq.media[0]?.type === 'image', JSON.stringify(hq.media));
  check('табло получило media вопроса', Array.isArray(bq.media) && bq.media[0]?.src?.includes('flag.png'));
  check('игрок без настройки: нет текста и media', pq.text === undefined && pq.media === undefined, JSON.stringify(pq));

  // state по session:resume: player-view без media, board-view с media
  const hostState = (await call(ctx.host, 'session:resume', { roomId, hostToken })).state;
  check('state host: question.media + answerMedia', Array.isArray(hostState.game.question.media) && Array.isArray(hostState.game.question.answerMedia));
  const boardState = (await call(ctx.board, 'board:watch', { roomId })).state;
  check('state board: question.media есть', Array.isArray(boardState.game.question.media));
  check('state board: roundMedia непустой', Array.isArray(boardState.roundMedia) && boardState.roundMedia.length > 0);

  // media:control от ведущего доезжает до табло
  const ctrlP = waitFor(ctx.board, 'media:control');
  const ack = await call(ctx.host, 'media:control', { action: 'play' });
  const ctrl = await ctrlP;
  check('media:control play дошёл до табло', ack.ok && ctrl.action === 'play');

  const badAck = await call(ctx.player, 'media:control', { action: 'play' });
  check('игроку media:control запрещён', badAck.ok === false);

  // reveal: answerMedia в payload
  await call(ctx.host, 'buzz:open', {});
  await waitFor(ctx.board, 'question:burned', 8000); // никто не жмёт → вопрос сгорает за 5 сек
  const revealP = waitFor(ctx.board, 'answer:reveal');
  await call(ctx.host, 'question:reveal', {});
  const rev = await revealP;
  check('answer:reveal с answerMedia (массив)', Array.isArray(rev.answerMedia));

  ctx.host.close(); ctx.board.close(); ctx.player.close();

  // ---------- showQuestionToPlayers: игрок видит медиа ----------
  console.log('— показ вопроса игрокам —');
  const ctx2 = await setupRoom({ showQuestionToPlayers: true, buzzTimeoutSec: 5 });
  const rq2 = waitFor(ctx2.host, 'round:media');
  await call(ctx2.host, 'game:start', {});
  await rq2;
  const playerQ2 = waitFor(ctx2.player, 'question:show');
  await call(ctx2.host, 'board:select', { themeIdx: 0, qIdx: 2 });
  const pq2 = await playerQ2;
  check('игрок с настройкой получил text+media', pq2.text !== undefined && Array.isArray(pq2.media) && pq2.media[0]?.type === 'image', JSON.stringify(pq2));
  const pState = (await call(ctx2.player, 'session:resume', {
    roomId: ctx2.roomId, playerId: ctx2.playerId, sessionToken: ctx2.sessionToken,
  })).state;
  check('state игрока с настройкой: media в question', Array.isArray(pState.game.question.media));
  check('state игрока с настройкой: roundMedia непустой', Array.isArray(pState.roundMedia) && pState.roundMedia.length > 0);

  ctx2.host.close(); ctx2.board.close(); ctx2.player.close();

  console.log(`\nИтого: ${passed} пройдено, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('Тест упал:', e);
  process.exit(1);
});
