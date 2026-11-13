// Запускать против отдельной тестовой копии сервера, не пользовательской БД.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { io } from 'socket.io-client';

const BASE = process.env.TEST_BASE || 'http://localhost:3000';
const sockets = [];
let checks = 0;
function check(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✔ ${name}`);
  checks++;
}
async function connect() {
  const s = io(BASE, { transports: ['websocket'], reconnection: false });
  sockets.push(s);
  await new Promise((resolve, reject) => { s.once('connect', resolve); s.once('connect_error', reject); });
  return s;
}
const call = (s, event, payload = {}) => new Promise((resolve, reject) => {
  s.timeout(5000).emit(event, payload, (err, result) => err ? reject(err) : resolve(result));
});
async function ok(s, event, payload) {
  const r = await call(s, event, payload);
  assert.equal(r.ok, true, `${event}: ${r.error}`);
  return r;
}

// Выполняем реальные applyState/renderSpecial/renderControls ведущего с минимальным DOM.
const source = fs.readFileSync(new URL('../client/host/host.js', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function hostUI(state) {
  const elements = new Map();
  function node(tag = '', props = {}, ...children) {
    return { tag, ...props, children, append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; } };
  }
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, node());
    return elements.get(id);
  };
  const S = {};
  const ctx = vm.createContext({ S, $, h: node, fillSettings() {}, preloadMedia() {},
    renderLog() {}, render() {}, call() {}, toast() {}, state });
  vm.runInContext(section('function applyState(state)', 'function render()')
    + section('function renderSpecial()', '// Список игроков с управлением'), ctx);
  vm.runInContext('applyState(state); renderSpecial(); renderControls();', ctx);
  const text = (n) => typeof n === 'string' ? n : (n?.children || []).map(text).join(' ');
  return { S, $, text: text($('special-card')) };
}

try {
  const host = await connect();
  const { roomId, hostToken } = await ok(host, 'room:create', { packId: 'test-pack-special' });
  await ok(host, 'session:resume', { roomId, hostToken });
  const player = await connect();
  const { playerId } = await ok(player, 'room:join', { roomId, nick: 'Финал' });
  await ok(host, 'game:start');
  // Свежий сокет ведущего моделирует перезагрузку страницы и session:resume.
  async function refresh() {
    const s = await connect();
    return (await ok(s, 'session:resume', { roomId, hostToken })).state;
  }
  await ok(host, 'board:select', { themeIdx: 0, qIdx: 1 });
  check('кот: панель назначения восстановлена', hostUI(await refresh()).text.includes('Передать вопрос'));
  await ok(host, 'question:skip');
  await ok(host, 'board:select', { themeIdx: 1, qIdx: 0 });
  check('аукцион: панель приёма ставок восстановлена', hostUI(await refresh()).text.includes('Закрыть приём ставок'));
  await ok(host, 'question:skip');
  await ok(host, 'score:adjust', { playerId, delta: 1000 });
  await ok(host, 'round:end');
  let state = await refresh();
  check('финал: после обновления доступно открытие вопроса', hostUI(state).text.includes('Открыть вопрос'));
  check('финал: восстановлено название темы', hostUI(state).text.includes('Столицы мира'));
  check('финал: завершение обычного раунда скрыто', hostUI(state).$('round-end-btn').hidden);
  let r = await call(host, 'round:end');
  check('финал: команда round:end отклонена понятной ошибкой', !r.ok && r.error.includes('Завершить игру'));
  assert.deepEqual((await refresh()).game, state.game);
  check('отклонённая команда не меняет состояние финала', true);
  await ok(player, 'final:stake', { amount: 400 });
  await ok(host, 'final:go');
  state = await refresh();
  check('ответы: после обновления доступно закрытие приёма', hostUI(state).text.includes('Закрыть приём ответов'));
  check('ответы: таймер сохранён', state.game.deadlineTs > Date.now());
  await call(host, 'round:end');
  check('отклонённая команда не сбрасывает таймер', (await refresh()).game.deadlineTs === state.game.deadlineTs);
  await ok(player, 'final:answer', { text: 'Канберра' });
  await ok(host, 'final:go');
  state = await refresh();
  const ui = hostUI(state);
  check('судейство: восстановлены ответ игрока и ставка', ui.text.includes('Канберра') && ui.text.includes('400'));
  check('судейство: восстановлены кнопки вердикта', ui.text.includes('Верно') && ui.text.includes('Неверно'));
  await ok(host, 'final:judge', { playerId, correct: true });
  state = await refresh();
  check('судейство: после обновления сохранён вердикт', state.game.final.entries[0].verdict === true);
  check('судейство: начисление не повторяется при обновлении', state.players.find((p) => p.id === playerId).score === 1400);
  const board = await connect();
  const boardState = (await ok(board, 'board:watch', { roomId })).state;
  check('табло не получает скрытые ответы и ставки', !boardState.game.final.entries && !boardState.game.question.answer);
  await ok(host, 'game:end');
  r = await call(host, 'round:end');
  check('после конца игры round:end отклонён', !r.ok);
  const ordinary = structuredClone(state);
  ordinary.phase = 'board';
  const ordinaryUI = hostUI(ordinary);
  check('обычный раунд: кнопка завершения доступна', !ordinaryUI.$('round-end-btn').hidden);
  check('возврат к обычному полю очищает специальную панель', ordinaryUI.S.special === null && ordinaryUI.$('special-card').hidden);
  console.log(`Итого: ${checks} проверок пройдено`);
} finally {
  for (const s of sockets) s.close();
}
