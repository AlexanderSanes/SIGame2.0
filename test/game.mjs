import { io } from './socket-client.mjs';

const BASE = `http://localhost:${process.env.PORT || 3000}`;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(socket, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${event}`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function setupRoom() {
  const host = await connect();
  const { roomId, hostToken } = await call(host, 'room:create', {});
  await call(host, 'session:resume', { roomId, hostToken });
  await call(host, 'settings:update', { answerTimeSec: 3, buzzTimeoutSec: 5, picker: 'player', showQuestionToPlayers: false });
  const pa = await connect();
  const ja = await call(pa, 'room:join', { roomId, nick: 'Аня' });
  const pb = await connect();
  const jb = await call(pb, 'room:join', { roomId, nick: 'Борис' });
  return { host, roomId, hostToken, pa, pb, aId: ja.playerId, bId: jb.playerId };
}

let raceCount = 0;

async function raceOnce(ctx, t, q) {
  const { host, pa, pb, aId, bId } = ctx;
  await call(host, 'board:select', { themeIdx: t, qIdx: q });
  await call(host, 'buzz:open', {});
  const winnerP = waitFor(host, 'buzz:winner');
  const [ra, rb] = await Promise.all([call(pa, 'buzz:press', {}), call(pb, 'buzz:press', {})]);
  const winner = await winnerP;
  raceCount++;
  const acceptedCount = [ra.accepted, rb.accepted].filter(Boolean).length;
  check(`гонка #${raceCount}: ровно один победитель`, acceptedCount === 1,
    JSON.stringify({ ra, rb }));
  const winnerId = ra.accepted ? aId : bId;
  check(`гонка #${raceCount}: buzz:winner совпадает с ack`, winner.playerId === winnerId);
  return winnerId;
}

async function main() {
  console.log('E2E тест этапа 2 (игровое ядро)\n');

  const ctx = await setupRoom();
  const { host, roomId, hostToken, pa, pb, aId, bId } = ctx;

  // --- приватность вопроса (настройка выключена): игроку приходит только тема и цена ---
  let playerSawQuestion = false;
  let playerSawPrice = false;
  pa.on('question:show', (q) => {
    if (q.text) playerSawQuestion = true;
    if (q.price && !q.text) playerSawPrice = true;
  });

  // --- запуск ---
  const started = await call(host, 'game:start', {});
  check('game:start', started.ok);

  const state = (await call(host, 'session:resume', { roomId, hostToken })).state;
  check('фаза board, выбран picker', state.phase === 'board' && [aId, bId].includes(state.game.pickerId));
  check('поле: 2 темы × 3 вопроса', state.game.board.themes.length === 2
    && state.game.board.themes.every((t) => t.questions.length === 3));

  // не-picker не может выбрать ячейку, ведущий — может
  const nonPicker = state.game.pickerId === aId ? pb : pa;
  const rejected = await call(nonPicker, 'board:select', { themeIdx: 0, qIdx: 0 });
  check('board:select чужого игрока отклоняется', !rejected.ok);

  // игрок без buzz:open не может нажать
  const hostShow = waitFor(host, 'question:show');
  const hostAnswer = waitFor(host, 'question:answer');
  await call(host, 'board:select', { themeIdx: 0, qIdx: 0 });
  const show = await hostShow;
  const ans = await hostAnswer;
  check('ведущий получил текст вопроса и ответ', !!show.text && !!ans.answer);
  await sleep(300);
  check('игрок НЕ получил текст вопроса (настройка выкл)', !playerSawQuestion);
  check('игрок получил тему и цену без текста', playerSawPrice);
  const early = await call(pa, 'buzz:press', {});
  check('buzz:press до buzz:open не засчитывается', !early.accepted);
  // возвращаемся: переоткрываем ячейку заново — она уже в фазе question, открываем кнопку
  await call(host, 'buzz:open', {});
  const w = waitFor(host, 'buzz:winner');
  const [r1, r2] = await Promise.all([call(pa, 'buzz:press', {}), call(pb, 'buzz:press', {})]);
  await w;
  raceCount++;
  check(`гонка #${raceCount}: ровно один победитель`, [r1.accepted, r2.accepted].filter(Boolean).length === 1);
  await call(host, 'answer:judge', { correct: true });

  // --- остальные 5 ячеек раунда 1 ---
  for (const [t, q] of [[0, 1], [0, 2], [1, 0], [1, 1], [1, 2]]) {
    await raceOnce(ctx, t, q);
    await call(host, 'answer:judge', { correct: true });
  }
  const roundEvt = (await call(host, 'session:resume', { roomId, hostToken })).state;
  check('переход ко 2 раунду', roundEvt.game.roundIndex === 1 && roundEvt.phase === 'board');

  // --- раунд 2: ещё 3 гонки ---
  for (const q of [0, 1, 2]) {
    await raceOnce(ctx, 0, q);
    await call(host, 'answer:judge', { correct: true });
  }

  // --- неверный ответ: минус очки, блок, право второго ---
  const before = (await call(host, 'session:resume', { roomId, hostToken })).state;
  const anyaBefore = before.players.find((p) => p.id === aId).score;
  const borisBefore = before.players.find((p) => p.id === bId).score;
  await call(host, 'board:select', { themeIdx: 1, qIdx: 0 });
  await call(host, 'buzz:open', {});
  const wA = waitFor(host, 'buzz:winner');
  const ra = await call(pa, 'buzz:press', {});
  await wA;
  check('Аня нажала первой', ra.accepted);
  const wrong = await call(host, 'answer:judge', { correct: false });
  check('вердикт «неверно» принят', wrong.ok);
  const lockedPress = await call(pa, 'buzz:press', {});
  check('ответивший неверно заблокирован в этом вопросе', !lockedPress.accepted);
  const rb = await call(pb, 'buzz:press', {});
  check('второй игрок может ответить', rb.accepted);
  await call(host, 'answer:judge', { correct: true });
  const stateAfterWrong = (await call(host, 'session:resume', { roomId, hostToken })).state;
  const anya = stateAfterWrong.players.find((p) => p.id === aId);
  const boris = stateAfterWrong.players.find((p) => p.id === bId);
  check('дельта очков: −200 Ане, +200 Борису',
    anya.score === anyaBefore - 200 && boris.score === borisBefore + 200,
    `Аня ${anyaBefore}→${anya.score}, Борис ${borisBefore}→${boris.score}`);
  check('после «верно» picker = Борис', stateAfterWrong.game.pickerId === bId);

  // --- таймаут кнопки: вопрос сгорает ---
  await call(host, 'board:select', { themeIdx: 1, qIdx: 1 });
  await call(host, 'buzz:open', {});
  const burned = await waitFor(host, 'question:burned', 7000);
  check('никто не нажал за 2 сек → вопрос сгорел', !!burned);
  const revealEvt = waitFor(host, 'answer:reveal');
  await call(host, 'question:reveal', {});
  const rev = await revealEvt;
  check('ведущий показал ответ', !!rev.answer);
  const boardBack = waitFor(host, 'board:update');
  await call(host, 'question:close', {});
  const boardAfter = await boardBack;
  check('после закрытия — возврат к полю, ячейка использована', boardAfter.themes[1].questions[1].used === true);

  // --- таймаут ответа: авто-«неверно» ---
  await call(host, 'board:select', { themeIdx: 1, qIdx: 2 });
  await call(host, 'buzz:open', {});
  const wA2 = waitFor(host, 'buzz:winner');
  await call(pa, 'buzz:press', {});
  await wA2;
  const verdictP = waitFor(host, 'answer:verdict', 6000);
  const verdict = await verdictP; // авто-неверно по таймеру 3 сек
  check('таймер ответа: авто-«неверно»', verdict.correct === false && verdict.playerId === aId);
  const rb2 = await call(pb, 'buzz:press', {});
  check('после авто-неверно второй жмёт', rb2.accepted);

  // --- последняя ячейка → конец игры ---
  const overP = waitFor(host, 'game:over');
  await call(host, 'answer:judge', { correct: true });
  const over = await overP;
  check('game:over с итоговой таблицей', Array.isArray(over.standings) && over.standings.length === 2);
  check('места отсортированы по очкам',
    over.standings[0].score >= over.standings[1].score && over.standings[0].place === 1);
  check('фаза game_over', (await call(host, 'session:resume', { roomId, hostToken })).state.phase === 'game_over');

  // --- вторая комната: дожим гонок до 20 ---
  const ctx2 = await setupRoom();
  await call(ctx2.host, 'game:start', {});
  for (const [t, q] of [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]]) {
    await raceOnce(ctx2, t, q);
    await call(ctx2.host, 'answer:judge', { correct: true });
  }
  // раунд 2 комнаты 2: ещё 5 гонок
  for (const [t, q] of [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1]]) {
    await raceOnce(ctx2, t, q);
    await call(ctx2.host, 'answer:judge', { correct: true });
  }
  check('всего гонок проведено: 20', raceCount === 20, `фактически ${raceCount}`);

  console.log(`\nИтог: ${passed} пройдено, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('Тест упал с ошибкой:', e);
  process.exit(1);
});
