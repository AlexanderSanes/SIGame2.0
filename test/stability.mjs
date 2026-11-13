// Изолированный E2E этапа 7: сам запускает сервер с новой БД; данные проекта не трогает.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fork, spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { io } from 'socket.io-client';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(process.env.TEST_TMPDIR || os.tmpdir()), 'sigame-stability-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let count = 0;
function check(name, cond) { assert.ok(cond, name); console.log(`  ✔ ${name}`); count++; }
async function freePort() {
  const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const port = s.address().port; await new Promise((r) => s.close(r)); return port;
}
const port = await freePort();
let base = `http://127.0.0.1:${port}`;
let server; let nginx; let nginxArgs; const clients = [];
const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: path.join(dir, 'server-data'), SNAPSHOT_INTERVAL_MS: '200', PUBLIC_URL: 'https://game.example.com' };
async function start() {
  server = fork(path.join(root, 'server/index.js'), [], { cwd: root, env, silent: true });
  let log = ''; server.stderr.on('data', (v) => { log += v; });
  for (let n = 0; n < 100; n++) {
    if (server.exitCode !== null) throw new Error(log);
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch {}
    await sleep(50);
  }
  throw new Error('Server startup timeout: ' + log);
}
async function stop() {
  const done = once(server, 'exit'); server.send('shutdown'); await done;
}
async function connect() {
  const s = io(base, { transports: ['polling', 'websocket'], reconnection: false }); clients.push(s);
  await new Promise((resolve, reject) => { s.once('connect', resolve); s.once('connect_error', reject); }); return s;
}
const call = (s, ev, p = {}) => new Promise((resolve, reject) => s.timeout(5000).emit(ev, p, (e, r) => e ? reject(e) : resolve(r)));
async function ok(s, ev, p) { const r = await call(s, ev, p); assert.equal(r.ok, true, `${ev}: ${r.error}`); return r; }
async function resume(token) { const s = await connect(); const r = await ok(s, 'session:resume', token); return { s, state: r.state }; }
async function restart(crash = false) {
  if (crash) {
    await sleep(400); // даём периодическому снимку записаться
    const exited = once(server, 'exit'); server.kill('SIGKILL'); await exited;
    for (const s of clients) s.disconnect();
  } else { for (const s of clients) s.disconnect(); await stop(); }
  await start();
}

try {
  await start();
  if (process.env.NGINX_BIN) {
    const prefix = path.join(dir, 'nginx'); fs.mkdirSync(path.join(prefix, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(prefix, 'temp'), { recursive: true });
    const proxyPort = await freePort();
    let config = fs.readFileSync(path.join(root, 'deploy/nginx.conf'), 'utf8').replace(/^\uFEFF/, '')
      .replace('127.0.0.1:3000', `127.0.0.1:${port}`).replace('listen 80;', `listen 127.0.0.1:${proxyPort};`)
      .replaceAll('/etc/nginx/sigame.htpasswd', path.join(prefix, 'passwords').replaceAll('\\', '/'));
    fs.writeFileSync(path.join(prefix, 'passwords'), 'host:{SHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=\n'); // test-only password: password
    fs.writeFileSync(path.join(prefix, 'test.conf'), `worker_processes 1;\nevents { worker_connections 128; }\nhttp { ${config} }`);
    nginxArgs = ['-p', prefix.replaceAll('\\', '/') + '/', '-c', 'test.conf'];
    const valid = spawnSync(process.env.NGINX_BIN, [...nginxArgs, '-t'], { encoding: 'utf8', windowsHide: true });
    assert.equal(valid.status, 0, valid.stderr);
    nginx = spawn(process.env.NGINX_BIN, [...nginxArgs, '-g', 'daemon off;'], { windowsHide: true, stdio: 'ignore' });
    base = `http://127.0.0.1:${proxyPort}`;
    for (let n = 0; n < 100; n++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await sleep(50); }
    check('nginx: конфигурация валидна, healthcheck проходит через proxy', (await fetch(base + '/healthz')).ok);
    check('nginx: редактор требует авторизацию', (await fetch(base + '/packs/')).status === 401);
    check('nginx: авторизованный редактор открывается', (await fetch(base + '/packs/', { headers: { Authorization: 'Basic ' + Buffer.from('host:password').toString('base64') } })).ok);
  }
  const host = await connect();
  for (let n = 0; n < 50 && host.io.engine.transport.name !== 'websocket'; n++) await sleep(50);
  check('Socket.IO обновляет polling до WebSocket', host.io.engine.transport.name === 'websocket');
  const created = await ok(host, 'room:create', { packId: 'test-pack-special' });
  const ht = { roomId: created.roomId, hostToken: created.hostToken };
  await ok(host, 'session:resume', ht);
  const a = await connect(); const b = await connect();
  const pa = await ok(a, 'room:join', { roomId: ht.roomId, nick: 'Первый' });
  const pb = await ok(b, 'room:join', { roomId: ht.roomId, nick: 'Второй' });
  const at = { roomId: ht.roomId, playerId: pa.playerId, sessionToken: pa.sessionToken };
  const bt = { roomId: ht.roomId, playerId: pb.playerId, sessionToken: pb.sessionToken };
  await ok(host, 'settings:update', { answerTimeSec: 30, buzzTimeoutSec: 60 });
  await ok(host, 'game:start');
  await ok(host, 'board:select', { themeIdx: 0, qIdx: 0 });
  await ok(host, 'buzz:open'); await ok(a, 'buzz:press');
  a.disconnect();
  await sleep(10500);
  let r = await resume(ht);
  check('через 10 секунд без отвечающего кнопка снова открыта', r.state.phase === 'buzz' && r.state.game.buzz.open);
  check('отключение не списало очки', r.state.players.find((p) => p.id === pa.playerId).score === 0);
  await ok(b, 'buzz:press'); await ok(host, 'answer:judge', { correct: true });
  await ok(host, 'board:select', { themeIdx: 0, qIdx: 2 });
  await ok(host, 'buzz:open');
  await ok(host, 'game:pause');
  await restart(true);
  let hr = await resume(ht); let br = await resume(bt); let ar = await resume(at);
  check('аварийный рестарт восстанавливает паузу и поле из периодического снимка', hr.state.phase === 'buzz' && hr.state.game.paused);
  await ok(hr.s, 'game:pause'); await ok(br.s, 'buzz:press');
  br.s.disconnect(); await sleep(150); br = await resume(bt);
  check('возврат отвечающего до 10 секунд продолжает ответ', br.state.phase === 'answer' && br.state.game.buzz.winnerId === pb.playerId && br.state.game.deadlineTs - Date.now() > 20000);
  await restart();
  hr = await resume(ht); br = await resume(bt); ar = await resume(at);
  check('после рестарта восстановлены токены, счёт и текущий отвечающий', hr.state.phase === 'answer' && hr.state.game.buzz.winnerId === pb.playerId && br.state.players.find((p) => p.id === pb.playerId).score === 100);
  await ok(hr.s, 'answer:judge', { correct: true });
  check('игра после рестарта продолжается с правильным начислением', (await resume(bt)).state.players.find((p) => p.id === pb.playerId).score === 400);
  await ok(hr.s, 'board:select', { themeIdx: 1, qIdx: 0 });
  await ok(br.s, 'auction:bet', { amount: 200 });
  await restart(); hr = await resume(ht); br = await resume(bt); ar = await resume(at);
  check('аукцион после рестарта сохраняет свою скрытую ставку', hr.state.phase === 'auction' && br.state.game.auction.myBet === 200 && ar.state.game.auction.myBet === null);
  await ok(hr.s, 'auction:close'); await ok(hr.s, 'answer:judge', { correct: true });
  await ok(hr.s, 'round:end');
  await ok(br.s, 'final:stake', { amount: 300 });
  await restart(); hr = await resume(ht); br = await resume(bt); ar = await resume(at);
  check('финал после рестарта сохраняет ставки и не раскрывает их другим', br.state.game.final.myStake === 300 && ar.state.game.final.myStake === null && !ar.state.game.question);
  await ok(hr.s, 'final:go'); await ok(br.s, 'final:answer', { text: 'Канберра' });
  await restart(); hr = await resume(ht); br = await resume(bt);
  check('финальный ответ и оставшееся время переживают рестарт', br.state.game.final.myAnswer === 'Канберра' && hr.state.game.final.stage === 'answer' && hr.state.game.deadlineTs > Date.now());
  await ok(hr.s, 'final:go'); await ok(hr.s, 'final:judge', { playerId: pb.playerId, correct: true });
  await restart(); hr = await resume(ht); br = await resume(bt);
  check('вердикт финала не начисляется повторно после рестарта', hr.state.game.final.entries[0].verdict === true && br.state.players.find((p) => p.id === pb.playerId).score === 900);
  await ok(hr.s, 'game:end'); await restart(); hr = await resume(ht);
  check('итоговая таблица восстановлена после рестарта', hr.state.phase === 'game_over' && hr.state.standings[0].score === 900);
  let limited = 0;
  for (let n = 0; n < 45; n++) if ((await call(hr.s, 'buzz:press')).error?.includes('частые')) limited++;
  check('спам кнопки ограничен сервером', limited > 0);
  check('неверный тип сообщения отклоняется', !(await call(hr.s, 'settings:update', null)).ok);
  check('большое сообщение отклоняется', !(await call(hr.s, 'final:answer', { text: 'x'.repeat(20000) })).ok);
  const headers = { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from('host:password').toString('base64') };
  const pack = { title: 'Проверка финала', rounds: [{ title: 'Р', themes: [{ title: 'Т', questions: [{ price: 1, text: '<script>alert(1)</script>', answer: 'О' }] }] }], final: { title: 'Ф', text: 'В', answer: 'О' } };
  const saved = await (await fetch(base + '/api/packs', { method: 'POST', headers, body: JSON.stringify(pack) })).json();
  check('API создания сохраняет финальный вопрос', saved.ok && saved.pack.final?.title === 'Ф');
  pack.final.title = 'Изменённый финал';
  const updated = await (await fetch(base + '/api/packs/' + saved.pack.id, { method: 'PUT', headers, body: JSON.stringify(pack) })).json();
  check('API обновления сохраняет финальный вопрос', updated.ok && updated.pack.final?.title === 'Изменённый финал');
  const health = await fetch(base + '/healthz');
  check('сервер продолжает работать, включена CSP', health.ok && health.headers.get('content-security-policy').includes("script-src 'self'"));
  const qr = await (await fetch(base + '/api/rooms/' + ht.roomId)).json();
  check('QR использует PUBLIC_URL за proxy', qr.joinUrl.startsWith('https://game.example.com/'));
  for (const c of clients) c.disconnect(); await stop(); server = null;

  // Проверка очистки на другой изолированной БД, без искусственного ожидания двух часов.
  process.env.DATA_DIR = path.join(dir, 'cleanup-data');
  const { config } = await import('../config.js');
  const { RoomManager } = await import('../server/rooms.js');
  const { seedPacks, createPack, importPack, validatePack } = await import('../server/packs.js');
  const { cleanup } = await import('../server/maintenance.js');
  const { socketLimits } = await import('../server/security.js');
  let passedLimits = 0;
  for (const ip of ['192.0.2.1', '192.0.2.2']) {
    let middleware;
    socketLimits({ id: ip, data: {}, handshake: { address: '127.0.0.1' },
      request: { headers: { 'x-real-ip': ip } }, use(fn) { middleware = fn; } });
    for (let n = 0; n < 20; n++) middleware(['room:create', {}, () => {}], () => passedLimits++);
    const circular = {}; circular.self = circular;
    let rejected = false;
    middleware(['settings:update', circular, () => { rejected = true; }], () => {});
    check('циклический payload отклонён без исключения: ' + ip, rejected);
  }
  check('лимиты создания за nginx разделены по реальному IP', passedLimits === 40);
  const { db } = await import('../server/db.js');
  seedPacks(); const rooms = new RoomManager(); const now = Date.now();
  const idle = rooms.createRoom(); idle.updatedAt = now - config.roomIdleMs - 1;
  const active = rooms.createRoom(); active.updatedAt = idle.updatedAt;
  const used = '/uploads/kept.png'; const undo = '/uploads/undo.png'; const unused = '/uploads/orphan.png';
  active.history.push({ question: { media: [{ src: undo }] } });
  createPack({ title: 'Медиа', rounds: [{ title: 'Р', themes: [{ title: 'Т', questions: [{ price: 1, text: 'В', answer: 'О', media: [{ src: used, type: 'image' }] }] }] }] });
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  for (const url of [used, undo, unused]) { const f = path.join(config.uploadsDir, path.basename(url)); fs.writeFileSync(f, 'test'); fs.utimesSync(f, new Date(now - config.mediaGraceMs - 1000), new Date(now - config.mediaGraceMs - 1000)); }
  const mock = { sockets: { adapter: { rooms: new Map([[active.id, new Set(['connected-host'])]]) } } };
  const cleaned = cleanup(mock, rooms, now);
  check('очистка закрывает пустую комнату спустя два часа', cleaned.closed === 1 && !rooms.get(idle.id));
  check('очистка сохраняет комнату с подключённым ведущим', !!rooms.get(active.id));
  check('очистка удаляет старое неиспользуемое медиа', cleaned.removed === 1 && !fs.existsSync(path.join(config.uploadsDir, 'orphan.png')));
  check('очистка сохраняет медиа пакета и undo', fs.existsSync(path.join(config.uploadsDir, 'kept.png')) && fs.existsSync(path.join(config.uploadsDir, 'undo.png')));
  const bad = importPack({ format: 'sigame-pack@1', title: 'Bad', rounds: [{ title: 'Р', themes: [{ title: 'Т', questions: [{ price: 1, text: 'В', answer: 'О' }] }] }], files: { '/uploads/../sigame.db': 'AAAA' } });
  check('импорт отклоняет обход пути', !bad.ok);
  const invalid = validatePack({ title: 'XSS', rounds: [{ title: 'Р', themes: [{ title: 'Т', questions: [{ price: 1, text: 'В', answer: 'О', media: [{ type: 'image', src: 'javascript:alert(1)' }] }] }] }] });
  check('опасная схема URL запрещена', !invalid.ok);
  // Текст вопросов не интерпретируется как HTML: общий h() создаёт текстовые узлы.
  const ui = fs.readFileSync(path.join(root, 'client/shared/ui.js'), 'utf8');
  const literal = '<img src=x onerror=alert(1)>';
  const dom = { createElement: () => ({ children: [], setAttribute() {}, addEventListener() {}, append(v) { this.children.push(v); } }),
    createTextNode: (text) => ({ nodeType: 3, text }) };
  const context = vm.createContext({ document: dom, literal });
  vm.runInContext(ui.slice(0, ui.indexOf('export function toast')).replace('export function h', 'function h') + '\nresult = h(\'p\', {}, literal);', context);
  check('XSS-текст остаётся текстовым узлом', context.result.children[0].nodeType === 3 && context.result.children[0].text === literal);
  rooms.flushAll(); const restored = new RoomManager(); restored.restore();
  check('удалённая комната не восстанавливается из SQLite', !restored.get(idle.id));
  for (const room of rooms.rooms.values()) rooms.deleteRoom(room);
  db.close();
  console.log(`Итого этап 7: ${count} проверок пройдено; временные данные: ${dir}`);
} finally {
  for (const c of clients) c.disconnect();
  if (server && server.exitCode === null) { try { await stop(); } catch { server.kill(); } }
  if (nginx) { spawnSync(process.env.NGINX_BIN, [...nginxArgs, '-s', 'quit'], { windowsHide: true }); }
}
