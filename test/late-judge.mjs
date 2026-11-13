// Проверка: вердикт ведущего ПОСЛЕ авто-«неверно» по таймеру ответа
// не должен менять счёт второй раз и должен вернуть ошибку.
import { io } from './socket-client.mjs';

const URL = 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const waitFor = (s, ev) => new Promise((res) => s.once(ev, res));

let pass = 0, fail = 0;
const check = (name, ok) => { console.log(`${ok ? '✔' : '✘'} ${name}`); ok ? pass++ : fail++; };

async function main() {
  const host = io(URL);
  await waitFor(host, 'connect');
  const created = await call(host, 'room:create', {});
  const { roomId, hostToken } = created;
  check('комната создана', created.ok);
  await call(host, 'session:resume', { roomId, hostToken });

  const pa = io(URL);
  await waitFor(pa, 'connect');
  const join = await call(pa, 'room:join', { roomId, nick: 'Вася' });
  check('игрок вошёл', join.ok);
  const { playerId: aId, sessionToken: aTok } = join;
  await call(pa, 'session:resume', { roomId, playerId: aId, sessionToken: aTok });

  // короткий таймер ответа
  const st = await call(host, 'settings:update', { answerTimeSec: 3 });
  check('настройка answerTimeSec=3', st.ok);

  await call(host, 'game:start', {});
  await call(host, 'board:select', { themeIdx: 0, qIdx: 0 });
  await call(host, 'buzz:open', {});
  const press = await call(pa, 'buzz:press', {});
  check('нажатие засчитано', press.ok && press.accepted);

  // ждём авто-«неверно» по таймеру ответа (3 сек + запас)
  await sleep(3600);
  const afterTimeout = (await call(host, 'session:resume', { roomId, hostToken })).state;
  const vAfterTimeout = afterTimeout.players.find((p) => p.id === aId);
  console.log(`   счёт после авто-таймера: ${vAfterTimeout.score}, фаза: ${afterTimeout.phase}`);

  // поздний вердикт «Верно» — должен быть отклонён
  const late = await call(host, 'answer:judge', { correct: true });
  check('поздний вердикт отклонён с ошибкой', !late.ok && !!late.error);

  const afterLate = (await call(host, 'session:resume', { roomId, hostToken })).state;
  const vAfterLate = afterLate.players.find((p) => p.id === aId);
  console.log(`   счёт после позднего вердикта: ${vAfterLate.score}`);
  check('счёт изменился ровно один раз (−100, цена вопроса)', vAfterLate.score === vAfterTimeout.score && vAfterTimeout.score === -100);

  host.close(); pa.close();
  console.log(`\nИтог: ${pass} пройдено, ${fail} провалено`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
