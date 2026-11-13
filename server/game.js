import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
// Единственное место, где меняется room.phase. Допустимые переходы:
const ALLOWED = {
  lobby: ['board'],                              // game:start
  board: ['question', 'cat', 'auction', 'final', 'answer', 'game_over'], // answer — отмена вердикта (undo)
  question: ['buzz', 'board', 'game_over', 'final'],      // board/game_over — пропуск вопроса / стоп игры
  cat: ['answer', 'board', 'game_over', 'final'],         // кот в мешке: назначение → ответ
  auction: ['answer', 'board', 'game_over', 'final'],     // аукцион: ставки → ответ
  buzz: ['answer', 'reveal', 'board', 'game_over', 'final'], // buzz:press | таймаут | пропуск/стоп
  answer: ['buzz', 'reveal', 'board', 'game_over', 'final'], // вердикт ведущего
  reveal: ['board', 'game_over', 'answer', 'final'],      // question:close | undo
  final: ['game_over', 'answer'],                          // answer — undo последнего обычного ответа до ставок
  game_over: ['answer', 'final'],                         // undo обычного или финального вердикта
};

function assertTransition(room, to) {
  if (room.phase === to) return; // no-op (например, досрочный конец раунда из фазы board)
  if (!(ALLOWED[room.phase] || []).includes(to)) {
    throw new Error(`Недопустимый переход фазы: ${room.phase} → ${to}`);
  }
}

export function transition(room, to) {
  assertTransition(room, to);
  room.phase = to;
}

const fullRoom = (roomId) => `${roomId}:full`; // ведущий + табло + зрители

function clearTimer(room, key) {
  if (room._timers[key]) {
    clearTimeout(room._timers[key]);
    room._timers[key] = null;
  }
}

function clearAllTimers(room) {
  clearTimer(room, 'buzz');
  clearTimer(room, 'answer');
  clearTimer(room, 'final');
  clearTimer(room, 'disconnect');
}

export function logAction(io, rooms, room, text) {
  const entry = rooms.addLog(room, text);
  io.to(room.id).emit('log:entry', entry);
}

// ---------- рассылки ----------

function emitPhase(io, room) {
  io.to(room.id).emit('game:phase', {
    phase: room.phase,
    roundIndex: room.game?.roundIndex ?? null,
    pickerId: room.game?.pickerId ?? null,
    winnerId: room.game?.buzz.winnerId ?? null,
    questionId: room.game?.question?.id ?? null,
    answerAttemptId: room.game?.answerAttemptId ?? null,
    revealed: room.game?.revealed ?? false,
    paused: room.game?.paused ?? false,
    deadlineTs: room.game?.deadlineTs ?? null,
  });
}

function emitBoard(io, rooms, room) {
  io.to(room.id).emit('board:update', rooms.publicGame(room, 'board').board);
  io.to(room.id).emit('game:round', {
    roundIndex: room.game.roundIndex,
    roundsTotal: room.pack.rounds.length,
    roundTitle: room.pack.rounds[room.game.roundIndex].title,
  });
}

function emitScores(io, rooms, room) {
  io.to(room.id).emit('score:update', {
    scores: rooms.publicPlayers(room).map((p) => ({ id: p.id, score: p.score })),
  });
}

function emitBuzzState(io, room) {
  io.to(room.id).emit('buzz:state', {
    open: room.game.buzz.open,
    paused: room.game.paused ?? false,
    deadlineTs: room.game.deadlineTs,
    lockedIds: [...room.game.buzz.lockedIds],
  });
}

function sendQuestionToHost(io, room) {
  if (room.hostSocketId && room.game.question) {
    io.to(room.hostSocketId).emit('question:answer', { answer: room.game.question.answer });
  }
}

function emitQuestion(io, room) {
  const g = room.game;
  const payload = {
    questionId: g.question.id,
    themeIdx: g.question.themeIdx,
    qIdx: g.question.qIdx,
    themeTitle: g.question.themeTitle,
    price: g.question.price,
    text: g.question.text,
    media: g.question.media || [],
  };
  if (room.settings.showQuestionToPlayers) {
    io.to(room.id).emit('question:show', payload);
  } else {
    io.to(fullRoom(room.id)).emit('question:show', payload);
    // игрокам — только цена и тема, чтобы сбросить прошлый вопрос (текст не светим)
    io.to(room.id).except(fullRoom(room.id)).emit('question:show', { themeIdx: g.question.themeIdx, qIdx: g.question.qIdx, themeTitle: g.question.themeTitle, price: g.question.price });
  }
  sendQuestionToHost(io, room);
}

// Предзагрузка медиа раунда: host/board всегда, игроки — если видят вопросы
function emitRoundMedia(io, rooms, room) {
  const urls = rooms.roundMedia(room);
  io.to(fullRoom(room.id)).emit('round:media', { urls });
  if (room.settings.showQuestionToPlayers) {
    io.to(room.id).except(fullRoom(room.id)).emit('round:media', { urls });
  }
}

// ---------- публичные действия ----------

export function startGame(io, rooms, room) {
  const pool = [...room.players.values()].filter((p) => p.connected && p.role !== 'spectator');
  if (!pool.length) throw new Error('Нужен хотя бы один подключённый игрок');
  transition(room, 'board');
  room.game = {
    roundIndex: 0,
    pickerId: pool[Math.floor(Math.random() * pool.length)].id,
    answerAttemptId: null,
    used: room.pack.rounds.map((r) => r.themes.map((t) => t.questions.map(() => false))),
    question: null,
    revealed: false,
    paused: false,
    deadlineTs: null,
    buzz: { open: false, winnerId: null, lockedIds: new Set() },
  };
  room.history = [];
  rooms.touch(room);
  emitBoard(io, rooms, room);
  emitPhase(io, room);
  emitRoundMedia(io, rooms, room);
  logAction(io, rooms, room, 'Игра началась');
}

export function selectCell(io, rooms, room, themeIdx, qIdx, byHost = false) {
  const g = room.game;
  if (!Number.isInteger(themeIdx) || !Number.isInteger(qIdx) || themeIdx < 0 || qIdx < 0) throw new Error('Некорректная ячейка');
  const theme = room.pack.rounds[g.roundIndex].themes[themeIdx];
  const q = theme?.questions[qIdx];
  if (!q) throw new Error('Ячейка не найдена');
  if (g.used[g.roundIndex][themeIdx][qIdx]) throw new Error('Ячейка уже сыграна');

  const type = q.type || 'normal';
  assertTransition(room, type === 'cat' ? 'cat' : type === 'auction' ? 'auction' : 'question');
  g.question = { id: randomUUID(), themeIdx, qIdx, price: q.price, text: q.text, answer: q.answer, themeTitle: theme.title, type, media: q.media || [], answerMedia: q.answerMedia || [] };
  g.revealed = false;
  g.paused = false;
  g.deadlineTs = null;
  g.disconnectedAnswer = null;
  g.answerAttemptId = null;
  g.buzz = { open: false, winnerId: null, lockedIds: new Set() };
  rooms.touch(room);

  if (type === 'cat') {
    // кот в мешке: вопрос не показываем, пока ведущий не выберет игрока и цену
    transition(room, 'cat');
    rooms.touch(room);
    io.to(room.id).emit('cat:pending', { themeTitle: theme.title, basePrice: q.price, themeIdx, qIdx });
    emitPhase(io, room);
    logAction(io, rooms, room, `Кот в мешке: ${theme.title}`);
    return;
  }
  if (type === 'auction') {
    // аукцион: скрытые ставки, вопрос показываем после закрытия приёма
    transition(room, 'auction');
    g.auction = { minBet: q.price, bets: {} }; // playerId → { amount, ts }
    rooms.touch(room);
    io.to(room.id).emit('auction:start', { themeTitle: theme.title, minBet: q.price });
    emitAuctionState(io, rooms, room);
    emitPhase(io, room);
    logAction(io, rooms, room, `Аукцион: ${theme.title}, от ${q.price}`);
    return;
  }

  transition(room, 'question');
  emitQuestion(io, room);
  emitBuzzState(io, room); // у всех клиентов кнопка гарантированно сброшена
  emitPhase(io, room);
  if (byHost) logAction(io, rooms, room, `Вопрос выбран ведущим: ${theme.title}, ${q.price}`);
}

function armAnswerTimer(io, rooms, room, delay) {
  clearTimer(room, 'answer');
  const attemptId = room.game.answerAttemptId;
  room._timers.answer = setTimeout(() => {
    if (room.game.answerAttemptId === attemptId) applyVerdict(io, rooms, room, false, { auto: true });
  }, delay);
}

// Ответ без кнопки: назначенный игрок сразу в фазу answer, таймер как обычно
function startDirectAnswer(io, rooms, room, playerId) {
  const g = room.game;
  const player = room.players.get(playerId);
  g.buzz.winnerId = playerId;
  g.answerAttemptId = randomUUID();
  transition(room, 'answer');
  g.deadlineTs = Date.now() + room.settings.answerTimeSec * 1000;
  rooms.touch(room);
  armAnswerTimer(io, rooms, room, room.settings.answerTimeSec * 1000);
  emitQuestion(io, room);
  emitBuzzState(io, room);
  io.to(room.id).emit('buzz:winner', { playerId, nick: player.nick });
  emitPhase(io, room);
  if (!player.connected) handlePlayerDisconnected(io, rooms, room, playerId);
}

// ---------- кот в мешке ----------

export function catAssign(io, rooms, room, playerId, price) {
  const g = room.game;
  if (room.phase !== 'cat') throw new Error('Сейчас нет кота в мешке');
  const player = room.players.get(playerId);
  if (!player || player.role === 'spectator') throw new Error('Игрок не найден');
  const p = strictInteger(price);
  if (!Number.isFinite(p) || p <= 0 || p > 100000) throw new Error('Цена: положительное целое');
  g.question.price = p;
  logAction(io, rooms, room, `Кот передан: ${player.nick}, цена ${p}`);
  startDirectAnswer(io, rooms, room, playerId);
}

// ---------- аукцион ----------

function emitAuctionState(io, rooms, room) {
  const g = room.game;
  const total = [...room.players.values()].filter((p) => p.role !== 'spectator').length;
  io.to(room.id).emit('auction:state', { betCount: Object.keys(g.auction?.bets || {}).length, playersCount: total });
}

export function auctionBet(io, rooms, room, playerId, amount) {
  const g = room.game;
  if (room.phase !== 'auction') throw new Error('Сейчас ставки не принимаются');
  const player = room.players.get(playerId);
  if (!player?.connected || player.role === 'spectator') throw new Error('Игрок не найден');
  const min = g.auction.minBet;
  const max = Math.max(player.score, min); // при счёте ниже цены ячейки можно поставить только минимум
  const bet = strictInteger(amount);
  if (!Number.isFinite(bet) || bet < min || bet > max) {
    throw new Error(`Ставка от ${min} до ${max}`);
  }
  g.auction.bets[playerId] = { amount: bet, ts: Date.now() };
  rooms.touch(room);
  emitAuctionState(io, rooms, room);
  logAction(io, rooms, room, `Ставка принята: ${player.nick}`);
  return { min, max };
}

export function auctionClose(io, rooms, room) {
  const g = room.game;
  if (room.phase !== 'auction') throw new Error('Аукцион не идёт');
  const entries = Object.entries(g.auction.bets).filter(([id]) => {
    const p = room.players.get(id);
    return p && p.role !== 'spectator';
  });
  io.to(room.id).emit('auction:result', {
    bets: entries.map(([id, b]) => ({ playerId: id, amount: b.amount })),
  });
  if (!entries.length) {
    logAction(io, rooms, room, 'Аукцион: ставок нет, вопрос сгорел');
    g.auction = null;
    advance(io, rooms, room);
    return;
  }
  // больше всех; при равенстве — кто поставил раньше
  entries.sort((a, b) => b[1].amount - a[1].amount || a[1].ts - b[1].ts);
  const [winnerId, bet] = entries[0];
  const player = room.players.get(winnerId);
  g.question.price = bet.amount;
  logAction(io, rooms, room, `Аукцион выигран: ${player.nick}, ставка ${bet.amount}`);
  g.auction = null;
  startDirectAnswer(io, rooms, room, winnerId);
}

export function openBuzz(io, rooms, room) {
  const g = room.game;
  transition(room, 'buzz');
  g.buzz.open = true;
  g.paused = false;
  g.deadlineTs = Date.now() + room.settings.buzzTimeoutSec * 1000;
  rooms.touch(room);
  room._timers.buzz = setTimeout(() => onBuzzTimeout(io, rooms, room), room.settings.buzzTimeoutSec * 1000);
  emitBuzzState(io, room);
  emitPhase(io, room);
  logAction(io, rooms, room, 'Ответы разрешены');
}

// Возвращает { accepted } — вызывающий хендлер отвечает клиенту через ack
export function pressBuzz(io, rooms, room, playerId) {
  const g = room.game;
  const player = room.players.get(playerId);
  if (!player?.connected || player.role === 'spectator') return { accepted: false };

  // фальстарт: нажатие до «Разрешить ответы» блокирует игрока на этот вопрос
  if (room.phase === 'question' && room.settings.falseStart) {
    if (!g.buzz.lockedIds.has(playerId)) {
      g.buzz.lockedIds.add(playerId);
      rooms.touch(room);
      emitBuzzState(io, room);
      logAction(io, rooms, room, `Фальстарт: ${player.nick} заблокирован на этот вопрос`);
    }
    return { accepted: false, falseStart: true };
  }

  if (room.phase !== 'buzz' || !g.buzz.open || g.paused) return { accepted: false };
  if (g.buzz.winnerId) return { accepted: false };          // гонка решается здесь: первый обработанный выиграл
  if (g.buzz.lockedIds.has(playerId)) return { accepted: false };

  clearTimer(room, 'buzz');
  g.buzz.winnerId = playerId;
  g.buzz.open = false;
  g.answerAttemptId = randomUUID();
  transition(room, 'answer');
  g.deadlineTs = Date.now() + room.settings.answerTimeSec * 1000;
  rooms.touch(room);
  armAnswerTimer(io, rooms, room, room.settings.answerTimeSec * 1000);

  emitBuzzState(io, room);
  io.to(room.id).emit('buzz:winner', { playerId, nick: player.nick });
  emitPhase(io, room);
  return { accepted: true };
}

export function judge(io, rooms, room, correct, expected = {}) {
  if (room.phase !== 'answer') throw new Error('Сейчас некому судить');
  if (typeof correct !== 'boolean') throw new Error('Вердикт должен быть true или false');
  const g = room.game;
  if (!expected.questionId || expected.questionId !== g.question.id
      || !expected.answerAttemptId || expected.answerAttemptId !== g.answerAttemptId
      || expected.playerId !== g.buzz.winnerId) {
    throw new Error('Попытка ответа устарела — обновите состояние вопроса');
  }
  clearTimer(room, 'answer');
  applyVerdict(io, rooms, room, correct);
}

function applyVerdict(io, rooms, room, correct, { auto = false } = {}) {
  const g = room.game;
  if (room.phase !== 'answer' || !g.buzz.winnerId) return;
  clearTimer(room, 'disconnect');
  g.disconnectedAnswer = null;
  const winnerId = g.buzz.winnerId;
  const player = room.players.get(winnerId);
  if (!player) { // игрок удалён, пока шёл его ответ
    g.buzz.winnerId = null;
    resumeBuzzOrReveal(io, rooms, room);
    return;
  }
  const price = g.question.price;

  rooms.pushHistory(room, {
    type: 'verdict',
    playerId: winnerId,
    prevScore: player.score,
    question: { ...g.question },
    prevPickerId: g.pickerId,
    prevRoundIndex: g.roundIndex,
    prevFinalPlayed: Boolean(g.finalPlayed),
    prevLockedIds: [...g.buzz.lockedIds],
  });

  player.score += correct ? price : -price;
  rooms.touch(room);
  emitScores(io, rooms, room);
  io.to(room.id).emit('answer:verdict', { playerId: winnerId, correct, delta: correct ? price : -price });
  logAction(io, rooms, room,
    `${correct ? 'Верно' : auto ? 'Неверно (таймаут)' : 'Неверно'}: ${player.nick} ${correct ? '+' : '−'}${price}`);

  if (correct) {
    g.pickerId = winnerId;
    advance(io, rooms, room);
    return;
  }

  // кот/аукцион: отвечает один игрок, неверный ответ сразу закрывает вопрос
  if (g.question.type && g.question.type !== 'normal') {
    goToReveal(io, rooms, room);
    return;
  }

  g.buzz.lockedIds.add(winnerId);
  g.buzz.winnerId = null;
  resumeBuzzOrReveal(io, rooms, room);
}

function resumeBuzzOrReveal(io, rooms, room) {
  const g = room.game;
  const eligible = [...room.players.values()]
    .filter((p) => p.connected && p.role !== 'spectator' && !g.buzz.lockedIds.has(p.id));
  if (eligible.length > 0) {
    transition(room, 'buzz');
    g.buzz.open = true;
    g.paused = false;
    g.deadlineTs = Date.now() + room.settings.buzzTimeoutSec * 1000;
    rooms.touch(room);
    room._timers.buzz = setTimeout(() => onBuzzTimeout(io, rooms, room), room.settings.buzzTimeoutSec * 1000);
    emitBuzzState(io, room);
    emitPhase(io, room);
  } else {
    goToReveal(io, rooms, room);
  }
}

function onBuzzTimeout(io, rooms, room) {
  room._timers.buzz = null;
  if (room.phase !== 'buzz') return;
  room.game.buzz.open = false;
  emitBuzzState(io, room);
  goToReveal(io, rooms, room);
}

function goToReveal(io, rooms, room) {
  transition(room, 'reveal');
  room.game.deadlineTs = null;
  rooms.touch(room);
  io.to(room.id).emit('question:burned', {});
  sendQuestionToHost(io, room);
  emitPhase(io, room);
}

export function revealAnswer(io, rooms, room) {
  if (room.phase !== 'reveal') throw new Error('Сейчас нечего показывать');
  room.game.revealed = true;
  rooms.touch(room);
  io.to(room.id).emit('answer:reveal', {
    answer: room.game.question.answer,
    answerMedia: room.game.question.answerMedia || [],
  });
  emitPhase(io, room);
  logAction(io, rooms, room, 'Показан правильный ответ');
}

export function closeQuestion(io, rooms, room) {
  if (room.phase !== 'reveal') throw new Error('Вопрос ещё не закрыт');
  advance(io, rooms, room);
}

// Общий финал вопроса: ячейка сыграна, дальше board / следующий раунд / конец игры
function advance(io, rooms, room) {
  const g = room.game;
  const q = g.question;
  const roundDone = g.used[g.roundIndex].every((theme, t) => theme.every((used, qi) =>
    used || (q && q.themeIdx === t && q.qIdx === qi)));
  const nextRound = g.roundIndex + (roundDone ? 1 : 0);
  const nextPhase = nextRound < room.pack.rounds.length ? 'board'
    : room.pack.final && !g.finalPlayed ? 'final' : 'game_over';
  assertTransition(room, nextPhase);
  if (q) g.used[g.roundIndex][q.themeIdx][q.qIdx] = true;
  g.question = null;
  g.revealed = false;
  g.paused = false;
  g.deadlineTs = null;
  g.disconnectedAnswer = null;
  g.answerAttemptId = null;
  g.buzz = { open: false, winnerId: null, lockedIds: new Set() };
  g.roundIndex = nextRound;
  if (nextPhase === 'final') { startFinal(io, rooms, room); return; }
  if (nextPhase === 'game_over') { finishGame(io, rooms, room); return; }
  transition(room, 'board');
  rooms.touch(room);
  if (roundDone) logAction(io, rooms, room, `Раунд ${g.roundIndex + 1}: ${room.pack.rounds[g.roundIndex].title}`);
  emitBoard(io, rooms, room);
  emitPhase(io, room);
  if (roundDone) emitRoundMedia(io, rooms, room);
}

function finishGame(io, rooms, room) {
  clearAllTimers(room);
  transition(room, 'game_over');
  rooms.touch(room);
  emitPhase(io, room);
  io.to(room.id).emit('game:over', { standings: buildStandings(room) });
}

function buildStandings(room) {
  const sorted = [...room.players.values()]
    .filter((p) => p.role !== 'spectator')
    .sort((a, b) => b.score - a.score);
  let place = 0;
  let prevScore = null;
  return sorted.map((p, i) => {
    if (p.score !== prevScore) place = i + 1;
    prevScore = p.score;
    return { place, id: p.id, nick: p.nick, avatarUrl: p.avatarUrl, score: p.score };
  });
}

// ---------- финальный раунд ----------

const FINAL_ANSWER_MS = 30 * 1000;

function finalEligible(room) {
  return [...room.players.values()].filter((p) => p.role !== 'spectator' && p.score > 0);
}

function emitFinalState(io, rooms, room) {
  const g = room.game;
  const eligibleIds = g.final.eligibleIds || finalEligible(room).map((p) => p.id);
  io.to(room.id).emit('final:state', {
    stage: g.final.stage,
    eligibleIds,
    stakedIds: Object.keys(g.final.bets),
    answeredIds: Object.keys(g.final.answers),
    deadlineTs: g.deadlineTs,
  });
}

function startFinal(io, rooms, room) {
  transition(room, 'final');
  const g = room.game;
  const f = room.pack.final;
  g.finalPlayed = true;
  g.final = { stage: 'stake', bets: {}, answers: {}, verdicts: {}, eligibleIds: finalEligible(room).map((p) => p.id) };
  g.question = { id: randomUUID(), themeIdx: -1, qIdx: -1, price: 0, text: f.text, answer: f.answer, themeTitle: f.title, type: 'final', media: f.media || [], answerMedia: [] };
  g.disconnectedAnswer = null;
  g.answerAttemptId = null;
  g.buzz = { open: false, winnerId: null, lockedIds: new Set() };
  g.deadlineTs = null;
  rooms.touch(room);
  io.to(room.id).emit('final:start', { title: f.title });
  emitFinalState(io, rooms, room);
  emitPhase(io, room);
  logAction(io, rooms, room, `Финальный раунд: ${f.title}`);
}

export function finalStake(io, rooms, room, playerId, amount) {
  const g = room.game;
  if (room.phase !== 'final' || g.final.stage !== 'stake') throw new Error('Сейчас ставки не принимаются');
  const player = room.players.get(playerId);
  if (!player?.connected || player.role === 'spectator') throw new Error('Игрок не найден');
  if (!(g.final.eligibleIds || finalEligible(room).map((p) => p.id)).includes(playerId)) throw new Error('В финале играют только с положительным счётом');
  const bet = strictInteger(amount);
  if (!Number.isFinite(bet) || bet < 0 || bet > player.score) {
    throw new Error(`Ставка от 0 до ${player.score}`);
  }
  g.final.bets[playerId] = bet;
  rooms.touch(room);
  emitFinalState(io, rooms, room);
  logAction(io, rooms, room, `Финал: ставка от ${player.nick}`);
}

// Ведущий открывает вопрос: 30 секунд на письменные ответы
export function finalStartAnswers(io, rooms, room) {
  const g = room.game;
  if (room.phase !== 'final' || g.final.stage !== 'stake') throw new Error('Сначала ставки');
  g.final.stage = 'answer';
  g.deadlineTs = Date.now() + FINAL_ANSWER_MS;
  rooms.touch(room);
  room._timers.final = setTimeout(() => finalCloseAnswers(io, rooms, room), FINAL_ANSWER_MS);
  // финальный вопрос видят все, включая игроков
  const q = g.question;
  io.to(room.id).emit('question:show', { themeIdx: -1, qIdx: -1, themeTitle: q.themeTitle, price: 0, text: q.text, media: q.media });
  emitFinalState(io, rooms, room);
  emitPhase(io, room);
  logAction(io, rooms, room, 'Финал: вопрос открыт, 30 секунд на ответы');
}

export function finalAnswer(io, rooms, room, playerId, text) {
  const g = room.game;
  if (room.phase !== 'final' || g.final.stage !== 'answer') throw new Error('Ответы не принимаются');
  if (g.final.bets[playerId] === undefined) throw new Error('Вы не делали ставку');
  const clean = String(text ?? '').trim().slice(0, 500);
  if (!clean) throw new Error('Пустой ответ');
  g.final.answers[playerId] = clean;
  rooms.touch(room);
  emitFinalState(io, rooms, room);
  return true;
}

export function finalCloseAnswers(io, rooms, room) {
  const g = room.game;
  if (room.phase !== 'final' || g.final.stage !== 'answer') return;
  clearTimer(room, 'final');
  clearTimer(room, 'disconnect');
  g.final.stage = 'judge';
  g.deadlineTs = null;
  rooms.touch(room);
  emitFinalState(io, rooms, room);
  sendFinalAnswersToHost(io, room);
  emitPhase(io, room);
  logAction(io, rooms, room, 'Финал: приём ответов закрыт');
}

function sendFinalAnswersToHost(io, room) {
  if (!room.hostSocketId) return;
  const g = room.game;
  io.to(room.hostSocketId).emit('final:answers', {
    answer: g.question.answer,
    entries: Object.entries(g.final.bets).map(([playerId, bet]) => {
      const p = room.players.get(playerId);
      return { playerId, nick: p?.nick ?? '?', bet, text: g.final.answers[playerId] ?? null, verdict: g.final.verdicts[playerId] ?? null };
    }),
  });
}

export function finalJudge(io, rooms, room, playerId, correct) {
  const g = room.game;
  if (room.phase !== 'final' || g.final.stage !== 'judge') throw new Error('Сейчас нечего судить');
  const bet = g.final.bets[playerId];
  if (bet === undefined) throw new Error('Игрок не участвовал в финале');
  if (g.final.verdicts[playerId] !== undefined) throw new Error('Вердикт уже вынесен');
  const player = room.players.get(playerId);
  if (!player || player.role === 'spectator') throw new Error('Участник финала больше не играет');
  if (typeof correct !== 'boolean') throw new Error('Вердикт должен быть true или false');
  rooms.pushHistory(room, { type: 'finalVerdict', playerId, prevScore: player.score });
  player.score += correct ? bet : -bet;
  g.final.verdicts[playerId] = Boolean(correct);
  rooms.touch(room);
  emitScores(io, rooms, room);
  io.to(room.id).emit('answer:verdict', { playerId, correct: Boolean(correct), delta: correct ? bet : -bet });
  logAction(io, rooms, room, `Финал: ${player.nick} ${correct ? `+${bet}` : `−${bet}`}`);
  sendFinalAnswersToHost(io, room);
  // все вердикты вынесены — показываем итоги финала всем
  if (Object.keys(g.final.verdicts).length === Object.keys(g.final.bets).length) {
    io.to(room.id).emit('final:results', {
      entries: Object.entries(g.final.bets).map(([pid, b]) => ({
        playerId: pid, bet: b, text: g.final.answers[pid] ?? null, verdict: g.final.verdicts[pid],
      })),
    });
  }
}

// ---------- пульт ведущего ----------

export function strictInteger(value) {
  if (typeof value === 'string' && !/^-?\d+$/.test(value)) return NaN;
  if (typeof value !== 'number' && typeof value !== 'string') return NaN;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : NaN;
}

export function adjustScore(io, rooms, room, playerId, delta) {
  const player = room.players.get(playerId);
  if (!player) throw new Error('Игрок не найден');
  rooms.pushHistory(room, { type: 'adjust', playerId, prevScore: player.score });
  player.score += delta;
  rooms.touch(room);
  emitScores(io, rooms, room);
  logAction(io, rooms, room,
    `Корректировка: ${player.nick} ${delta > 0 ? '+' : '−'}${Math.abs(delta)} → ${player.score}`);
}

// Отмена последнего действия с очками: ручной корректировки или вердикта.
// Вердикт откатывается к фазе answer (игрок отвечает заново, таймер свежий).
export function undo(io, rooms, room) {
  const entry = room.history[room.history.length - 1];
  if (!entry) throw new Error('История пуста — нечего отменять');
  const untouchedFinal = room.phase === 'final' && room.game.final?.stage === 'stake' && !Object.keys(room.game.final.bets).length;
  if (entry.type === 'verdict' && !['board', 'buzz', 'reveal', 'game_over'].includes(room.phase) && !untouchedFinal) {
    throw new Error('Отмена вердикта возможна только сразу после него');
  }
  if (entry.type === 'finalVerdict' && !['final', 'game_over'].includes(room.phase)) throw new Error('Финал уже не активен');
  if (entry.type === 'verdict') {
    const player = room.players.get(entry.playerId);
    if (!player || player.role === 'spectator') throw new Error('Отвечающий больше не участвует в игре');
    assertTransition(room, 'answer');
  }
  room.history.pop();

  // Ручная корректировка не меняет игровую попытку и её таймеры.
  if (entry.type === 'verdict') clearAllTimers(room);
  const player = room.players.get(entry.playerId);
  if (player) {
    player.score = entry.prevScore;
    rooms.touch(room);
    emitScores(io, rooms, room);
  }

  if (entry.type === 'verdict') {
    const g = room.game;
    g.roundIndex = entry.prevRoundIndex;
    g.finalPlayed = entry.prevFinalPlayed || false;
    g.final = null;
    g.used[entry.prevRoundIndex][entry.question.themeIdx][entry.question.qIdx] = false;
    g.question = { ...entry.question, id: entry.question.id || randomUUID() };
    g.pickerId = entry.prevPickerId;
    g.revealed = false;
    g.paused = false;
    g.disconnectedAnswer = null;
    g.answerAttemptId = randomUUID();
    g.buzz = { open: false, winnerId: entry.playerId, lockedIds: new Set(entry.prevLockedIds) };
    transition(room, 'answer');
    g.deadlineTs = Date.now() + room.settings.answerTimeSec * 1000;
    rooms.touch(room);
    armAnswerTimer(io, rooms, room, room.settings.answerTimeSec * 1000);
    emitBoard(io, rooms, room);
    emitQuestion(io, room);
    emitBuzzState(io, room);
    if (player) io.to(room.id).emit('buzz:winner', { playerId: entry.playerId, nick: player.nick });
    emitPhase(io, room);
  }
  if (entry.type === 'finalVerdict') {
    delete room.game.final.verdicts[entry.playerId];
    if (room.phase === 'game_over') {
      transition(room, 'final');
      io.to(room.id).emit('final:start', { title: room.pack.final.title });
    }
    emitFinalState(io, rooms, room);
    sendFinalAnswersToHost(io, room);
    emitPhase(io, room);
  }
  logAction(io, rooms, room, `Отмена: ${player?.nick || '?'} → счёт ${entry.prevScore}`);
}

export function setPicker(io, rooms, room, playerId) {
  if (room.phase !== 'board') throw new Error('Передать выбор можно только на игровом поле');
  const player = room.players.get(playerId);
  if (!player || player.role === 'spectator') throw new Error('Игрок не найден');
  room.game.pickerId = playerId;
  rooms.touch(room);
  emitPhase(io, room);
  logAction(io, rooms, room, `Право выбора: ${player.nick}`);
}

export function skipQuestion(io, rooms, room) {
  if (!['question', 'cat', 'auction', 'buzz', 'answer', 'reveal'].includes(room.phase)) {
    throw new Error('Нечего пропускать');
  }
  clearAllTimers(room);
  room.game.auction = null;
  logAction(io, rooms, room, `Вопрос пропущен (${room.game.question?.price ?? '—'})`);
  advance(io, rooms, room);
}

export function togglePause(io, rooms, room) {
  const g = room.game;
  if (!['buzz', 'answer'].includes(room.phase)) {
    throw new Error('Пауза возможна только во время приёма ответов');
  }
  if (!g.paused) {
    g.paused = true;
    g.pausedRemainingMs = Math.max(0, (g.deadlineTs || Date.now()) - Date.now());
    clearAllTimers(room);
    g.deadlineTs = null;
  } else {
    g.paused = false;
    g.deadlineTs = Date.now() + (g.pausedRemainingMs || 0);
    g.pausedRemainingMs = null;
    const left = g.deadlineTs - Date.now();
    if (room.phase === 'buzz') {
      room._timers.buzz = setTimeout(() => onBuzzTimeout(io, rooms, room), left);
    } else if (!room.players.get(g.buzz.winnerId)?.connected) {
      handlePlayerDisconnected(io, rooms, room, g.buzz.winnerId);
    } else {
      g.disconnectedAnswer = null;
      armAnswerTimer(io, rooms, room, left);
    }
  }
  rooms.touch(room);
  emitBuzzState(io, room);
  emitPhase(io, room);
  logAction(io, rooms, room, g.paused ? 'Пауза' : 'Продолжили');
}

export function endRound(io, rooms, room) {
  const g = room.game;
  if (!g) throw new Error('Игра не идёт');
  if (room.phase === 'final') throw new Error('В финале используйте «Завершить игру»');
  if (!['board', 'question', 'cat', 'auction', 'buzz', 'answer', 'reveal'].includes(room.phase)
      || !g.used[g.roundIndex]) throw new Error('Сейчас нельзя завершить раунд');
  const nextRound = g.roundIndex + 1;
  const nextPhase = nextRound < room.pack.rounds.length ? 'board'
    : room.pack.final && !g.finalPlayed ? 'final' : 'game_over';
  assertTransition(room, nextPhase);
  clearAllTimers(room);
  g.used[g.roundIndex] = g.used[g.roundIndex].map((theme) => theme.map(() => true));
  g.question = null;
  g.revealed = false;
  g.paused = false;
  g.deadlineTs = null;
  g.disconnectedAnswer = null;
  g.answerAttemptId = null;
  g.buzz = { open: false, winnerId: null, lockedIds: new Set() };
  g.roundIndex += 1;
  logAction(io, rooms, room, 'Раунд завершён досрочно');
  if (g.roundIndex >= room.pack.rounds.length) {
    if (room.pack.final && !g.finalPlayed) {
      startFinal(io, rooms, room);
      return;
    }
    finishGame(io, rooms, room);
    return;
  }
  transition(room, 'board');
  rooms.touch(room);
  emitBoard(io, rooms, room);
  emitPhase(io, room);
  emitRoundMedia(io, rooms, room);
}

export function endGame(io, rooms, room) {
  if (!room.game) throw new Error('Игра не идёт');
  logAction(io, rooms, room, 'Игра завершена досрочно');
  finishGame(io, rooms, room);
}

// Кик/выход игрока посреди игры: перевыбрать picker, разобрать зависший ответ
export function handlePlayerRemoved(io, rooms, room, playerId) {
  const g = room.game;
  if (!g) return;
  room.history = room.history.filter((e) => e.playerId !== playerId || (room.players.has(playerId) && e.type === 'adjust'));
  if (g.auction) { delete g.auction.bets[playerId]; emitAuctionState(io, rooms, room); }
  if (g.final && room.phase === 'final') {
    g.final.eligibleIds = (g.final.eligibleIds || finalEligible(room).map((p) => p.id)).filter((id) => id !== playerId);
    delete g.final.bets[playerId];
    delete g.final.answers[playerId];
    delete g.final.verdicts[playerId];
    room.history = room.history.filter((e) => !(e.type === 'finalVerdict' && e.playerId === playerId));
    emitFinalState(io, rooms, room);
    if (g.final.stage === 'judge') sendFinalAnswersToHost(io, room);
  }
  if (g.pickerId === playerId) {
    const next = [...room.players.values()].find((p) => p.connected && p.role !== 'spectator');
    g.pickerId = next?.id ?? null;
  }
  if (room.phase === 'answer' && g.buzz.winnerId === playerId) {
    clearTimer(room, 'disconnect');
    g.disconnectedAnswer = null;
    clearTimer(room, 'answer');
    g.buzz.winnerId = null;
    if (g.question.type && g.question.type !== 'normal') goToReveal(io, rooms, room);
    else resumeBuzzOrReveal(io, rooms, room);
  }
  rooms.touch(room);
  emitPhase(io, room);
}


// После перезапуска время простоя не съедает оставшееся игровое время.
export function restoreTimers(io, rooms, room) {
  const g = room.game;
  if (!g || g.paused) return;
  if (room.phase === 'answer') {
    handlePlayerDisconnected(io, rooms, room, g.buzz.winnerId);
  } else if (g.deadlineTs != null) {
    const delay = Math.max(0, g.deadlineTs - Date.now());
    if (room.phase === 'buzz') room._timers.buzz = setTimeout(() => onBuzzTimeout(io, rooms, room), delay);
    if (room.phase === 'final' && g.final?.stage === 'answer') {
      room._timers.final = setTimeout(() => finalCloseAnswers(io, rooms, room), delay);
    }
  }
}

export function handlePlayerDisconnected(io, rooms, room, playerId) {
  const g = room.game;
  if (room.phase !== 'answer' || g?.buzz.winnerId !== playerId || g.paused) return;
  const remainingMs = g.disconnectedAnswer?.remainingMs ?? Math.max(0, (g.deadlineTs || Date.now()) - Date.now());
  clearTimer(room, 'answer');
  clearTimer(room, 'disconnect');
  g.disconnectedAnswer = { playerId, remainingMs };
  g.deadlineTs = Date.now() + config.disconnectGraceMs;
  rooms.touch(room);
  emitPhase(io, room);
  room._timers.disconnect = setTimeout(() => {
    room._timers.disconnect = null;
    if (room.phase !== 'answer' || g.buzz.winnerId !== playerId) return;
    g.disconnectedAnswer = null;
    g.buzz.lockedIds.add(playerId);
    g.buzz.winnerId = null;
    logAction(io, rooms, room, 'Отвечающий отключился: ответ передан остальным без изменения счёта');
    if (g.question.type && g.question.type !== 'normal') goToReveal(io, rooms, room);
    else resumeBuzzOrReveal(io, rooms, room);
  }, config.disconnectGraceMs);
}

export function handlePlayerReconnected(io, rooms, room, playerId) {
  const g = room.game;
  if (room.phase !== 'answer' || g?.disconnectedAnswer?.playerId !== playerId) return;
  clearTimer(room, 'disconnect');
  const remainingMs = g.disconnectedAnswer.remainingMs;
  g.disconnectedAnswer = null;
  if (g.paused) {
    g.pausedRemainingMs = remainingMs;
    rooms.touch(room);
    return;
  }
  g.deadlineTs = Date.now() + remainingMs;
  armAnswerTimer(io, rooms, room, remainingMs);
  rooms.touch(room);
  emitPhase(io, room);
}
