import { io } from 'socket.io-client';

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

const hostState = async (host, roomId, hostToken) =>
  (await call(host, 'session:resume', { roomId, hostToken })).state;

async function main() {
  console.log('E2E тест этапа 3 (пульт ведущего)\n');

  // --- подготовка: комната, два игрока, фальстарт включён ---
  const host = await connect();
  const { roomId, hostToken } = await call(host, 'room:create', {});
  await call(host, 'session:resume', { roomId, hostToken });
  const st = await call(host, 'settings:update', { falseStart: true, answerTimeSec: 30, buzzTimeoutSec: 60 });
  check('настройка falseStart сохранена', st.ok && st.settings.falseStart === true);

  const pa = await connect();
  const ja = await call(pa, 'room:join', { roomId, nick: 'Аня' });
  await call(pa, 'session:resume', { roomId, playerId: ja.playerId, sessionToken: ja.sessionToken });
  const pb = await connect();
  const jb = await call(pb, 'room:join', { roomId, nick: 'Борис' });
  await call(pb, 'session:resume', { roomId, playerId: jb.playerId, sessionToken: jb.sessionToken });
  const aId = ja.playerId;
  const bId = jb.playerId;

  await call(host, 'game:start', {});
  let state = await hostState(host, roomId, hostToken);
  check('игра началась', state.phase === 'board');

  // --- фальстарт: нажатие до «Разрешить ответы» блокирует на вопрос ---
  await call(host, 'board:select', { themeIdx: 0, qIdx: 0 });
  const early = await call(pb, 'buzz:press', {});
  check('фальстарт не засчитан', early.ok && !early.accepted && early.falseStart === true);
  state = await hostState(host, roomId, hostToken);
  check('фальстартящий в lockedIds', state.game.buzz.lockedIds.includes(bId));

  await call(host, 'buzz:open', {});
  const lockedPress = await call(pb, 'buzz:press', {});
  check('заблокированный не может нажать после открытия', !lockedPress.accepted);
  const aPress = await call(pa, 'buzz:press', {});
  check('второй игрок нажимает нормально', aPress.accepted);

  // --- undo после «неверно» ---
  await call(host, 'answer:judge', { correct: false });
  state = await hostState(host, roomId, hostToken);
  // Борис залочен фальстартом, Аня ответила неверно → жать некому → reveal
  check('неверно: −100 и фаза reveal (больше некому жать)',
    state.phase === 'reveal' && state.players.find((p) => p.id === aId).score === -100);

  const undoWrong = await call(host, 'score:undo', {});
  state = await hostState(host, roomId, hostToken);
  check('undo после неверного: счёт возвращён, фаза answer, отвечает тот же',
    undoWrong.ok && state.phase === 'answer'
    && state.players.find((p) => p.id === aId).score === 0
    && state.game.buzz.winnerId === aId);

  // --- undo после «верно» ---
  await call(host, 'answer:judge', { correct: true });
  state = await hostState(host, roomId, hostToken);
  check('верно: +100, переход к полю, picker — ответивший',
    state.phase === 'board'
    && state.players.find((p) => p.id === aId).score === 100
    && state.game.pickerId === aId);

  await call(host, 'score:undo', {});
  state = await hostState(host, roomId, hostToken);
  check('undo после верного: счёт и состояние вопроса как было',
    state.phase === 'answer'
    && state.players.find((p) => p.id === aId).score === 0
    && state.game.question?.price === 100);

  await call(host, 'answer:judge', { correct: true });
  state = await hostState(host, roomId, hostToken);
  check('повторный вердикт после undo работает', state.players.find((p) => p.id === aId).score === 100);

  // --- ручная корректировка и её undo ---
  await call(host, 'score:adjust', { playerId: aId, delta: 250 });
  await call(host, 'score:adjust', { playerId: bId, delta: -200 });
  state = await hostState(host, roomId, hostToken);
  check('ручная корректировка применяется',
    state.players.find((p) => p.id === aId).score === 350
    && state.players.find((p) => p.id === bId).score === -200);
  await call(host, 'score:undo', {});
  state = await hostState(host, roomId, hostToken);
  check('undo ручной корректировки', state.players.find((p) => p.id === bId).score === 0);
  const badAdj = await call(host, 'score:adjust', { playerId: aId, delta: 0 });
  check('нулевая корректировка отклоняется', !badAdj.ok);

  // --- передача права выбора ---
  const sp = await call(host, 'game:setPicker', { playerId: bId });
  state = await hostState(host, roomId, hostToken);
  check('передача права выбора', sp.ok && state.game.pickerId === bId);

  // --- пропуск вопроса ---
  await call(pb, 'board:select', { themeIdx: 1, qIdx: 0 });
  const skip = await call(host, 'question:skip', {});
  state = await hostState(host, roomId, hostToken);
  check('пропуск вопроса: ячейка сгорела, назад к полю',
    skip.ok && state.phase === 'board' && state.game.board.themes[1].questions[0].used === true);

  // --- пауза: нажатия не принимаются, после продолжения — принимаются ---
  await call(host, 'board:select', { themeIdx: 1, qIdx: 1 });
  await call(host, 'buzz:open', {});
  await call(host, 'game:pause', {});
  state = await hostState(host, roomId, hostToken);
  check('пауза включена, таймер заморожен', state.game.paused === true && state.game.deadlineTs === null);
  const pausedPress = await call(pa, 'buzz:press', {});
  check('на паузе нажатие не принимается', !pausedPress.accepted);
  await call(host, 'game:pause', {});
  state = await hostState(host, roomId, hostToken);
  check('пауза снята, дедлайн восстановлен', state.game.paused === false && state.game.deadlineTs > Date.now());
  const resumedPress = await call(pa, 'buzz:press', {});
  check('после продолжения нажатие принимается', resumedPress.accepted);
  await call(host, 'answer:judge', { correct: true }); // Аня +200 → 550

  // --- зритель: не жмёт кнопку, не в standings ---
  const toSpec = await call(host, 'player:setRole', { playerId: bId, role: 'spectator' });
  state = await hostState(host, roomId, hostToken);
  check('перевод в зрители', toSpec.ok && state.players.find((p) => p.id === bId).role === 'spectator');

  await call(host, 'board:select', { themeIdx: 0, qIdx: 1 });
  await call(host, 'buzz:open', {});
  const specPress = await call(pb, 'buzz:press', {});
  check('зритель не может нажать кнопку', !specPress.accepted);
  await call(pa, 'buzz:press', {});
  await call(host, 'answer:judge', { correct: false }); // Аня −200 → 350, жать некому → reveal
  state = await hostState(host, roomId, hostToken);
  check('с зрителем вопрос уходит в reveal после неверного', state.phase === 'reveal');

  const backRole = await call(host, 'player:setRole', { playerId: bId, role: 'player' });
  state = await hostState(host, roomId, hostToken);
  check('возврат в игроки', backRole.ok && state.players.find((p) => p.id === bId).role === 'player');

  // --- досрочное завершение раунда и игры ---
  await call(host, 'round:end', {});
  state = await hostState(host, roomId, hostToken);
  check('раунд завершён досрочно → раунд 2', state.phase === 'board' && state.game.roundIndex === 1);

  await call(host, 'game:end', {});
  state = await hostState(host, roomId, hostToken);
  check('игра завершена досрочно', state.phase === 'game_over');

  // --- undo из финала ---
  await call(host, 'score:undo', {});
  state = await hostState(host, roomId, hostToken);
  check('undo из game_over возвращает фазу answer и счёт',
    state.phase === 'answer' && state.players.find((p) => p.id === aId).score === 550);

  // --- журнал ---
  check('журнал ведётся (≥10 записей)', state.log.length >= 10, `log: ${state.log.length}`);
  check('в журнале есть корректировка и фальстарт',
    state.log.some((e) => e.text.includes('Корректировка')) && state.log.some((e) => e.text.includes('Фальстарт')));

  // --- права доступа ---
  const adjByPlayer = await call(pa, 'score:adjust', { playerId: bId, delta: 100 });
  check('игрок не может крутить счёт', !adjByPlayer.ok);
  const undoByPlayer = await call(pa, 'score:undo', {});
  check('игрок не может делать undo', !undoByPlayer.ok);
  const roleByPlayer = await call(pa, 'player:setRole', { playerId: bId, role: 'spectator' });
  check('игрок не может менять роли', !roleByPlayer.ok);

  host.close(); pa.close(); pb.close();
  console.log(`\nИтог: ${passed} пройдено, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
