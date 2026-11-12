import { TEST_PACK } from './testpack.js';

// Единственное место, где меняется room.phase. Допустимые переходы:
const ALLOWED = {
  lobby: ['board'],                        // game:start
  board: ['question'],                     // board:select
  question: ['buzz'],                      // buzz:open
  buzz: ['answer', 'reveal'],              // buzz:press | таймаут
  answer: ['buzz', 'reveal', 'board', 'game_over'], // вердикт ведущего
  reveal: ['board', 'game_over'],          // question:close
  game_over: [],
};

export function transition(room, to) {
  if (!(ALLOWED[room.phase] || []).includes(to)) {
    throw new Error(`Недопустимый переход фазы: ${room.phase} → ${to}`);
  }
  room.phase = to;
}

const fullRoom = (roomId) => `${roomId}:full`; // ведущий + табло

function clearTimer(room, key) {
  if (room._timers[key]) {
    clearTimeout(room._timers[key]);
    room._timers[key] = null;
  }
}

// ---------- рассылки ----------

function emitPhase(io, room) {
  io.to(room.id).emit('game:phase', {
    phase: room.phase,
    roundIndex: room.game?.roundIndex ?? null,
    pickerId: room.game?.pickerId ?? null,
    winnerId: room.game?.buzz.winnerId ?? null,
    revealed: room.game?.revealed ?? false,
    deadlineTs: room.game?.deadlineTs ?? null,
  });
}

function emitBoard(io, rooms, room) {
  io.to(room.id).emit('board:update', rooms.publicGame(room, 'board').board);
  io.to(room.id).emit('game:round', {
    roundIndex: room.game.roundIndex,
    roundsTotal: TEST_PACK.rounds.length,
    roundTitle: TEST_PACK.rounds[room.game.roundIndex].title,
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
    deadlineTs: room.game.deadlineTs,
    lockedIds: [...room.game.buzz.lockedIds],
  });
}

function sendQuestionToHost(io, room) {
  if (room.hostSocketId && room.game.question) {
    io.to(room.hostSocketId).emit('question:answer', { answer: room.game.question.answer });
  }
}

// ---------- публичные действия ----------

export function startGame(io, rooms, room) {
  transition(room, 'board');
  const players = [...room.players.values()];
  const connected = players.filter((p) => p.connected);
  const pool = connected.length ? connected : players;
  room.game = {
    roundIndex: 0,
    pickerId: pool[Math.floor(Math.random() * pool.length)].id,
    used: TEST_PACK.rounds.map((r) => r.themes.map((t) => t.questions.map(() => false))),
    question: null,
    revealed: false,
    deadlineTs: null,
    buzz: { open: false, winnerId: null, lockedIds: new Set() },
  };
  rooms.touch(room);
  emitBoard(io, rooms, room);
  emitPhase(io, room);
}

export function selectCell(io, rooms, room, themeIdx, qIdx) {
  const g = room.game;
  const theme = TEST_PACK.rounds[g.roundIndex].themes[themeIdx];
  const q = theme?.questions[qIdx];
  if (!q) throw new Error('Ячейка не найдена');
  if (g.used[g.roundIndex][themeIdx][qIdx]) throw new Error('Ячейка уже сыграна');

  transition(room, 'question');
  g.question = { themeIdx, qIdx, price: q.price, text: q.text, answer: q.answer, themeTitle: theme.title };
  g.revealed = false;
  g.deadlineTs = null;
  g.buzz = { open: false, winnerId: null, lockedIds: new Set() };
  rooms.touch(room);

  const payload = { themeTitle: theme.title, price: q.price, text: q.text };
  if (room.settings.showQuestionToPlayers) {
    io.to(room.id).emit('question:show', payload);
  } else {
    io.to(fullRoom(room.id)).emit('question:show', payload);
    // игрокам — только цена и тема, чтобы сбросить прошлый вопрос (текст не светим)
    io.to(room.id).except(fullRoom(room.id)).emit('question:show', { themeTitle: theme.title, price: q.price });
  }
  sendQuestionToHost(io, room);
  emitPhase(io, room);
}

export function openBuzz(io, rooms, room) {
  const g = room.game;
  transition(room, 'buzz');
  g.buzz.open = true;
  g.deadlineTs = Date.now() + room.settings.buzzTimeoutSec * 1000;
  rooms.touch(room);
  room._timers.buzz = setTimeout(() => onBuzzTimeout(io, rooms, room), room.settings.buzzTimeoutSec * 1000);
  emitBuzzState(io, room);
  emitPhase(io, room);
}

// Возвращает { accepted } — вызывающий хендлер отвечает клиенту через ack
export function pressBuzz(io, rooms, room, playerId) {
  const g = room.game;
  if (room.phase !== 'buzz' || !g.buzz.open) return { accepted: false };
  if (g.buzz.winnerId) return { accepted: false };          // гонка решается здесь: первый обработанный выиграл
  if (g.buzz.lockedIds.has(playerId)) return { accepted: false };
  const player = room.players.get(playerId);
  if (!player?.connected) return { accepted: false };

  g.buzz.winnerId = playerId;
  g.buzz.open = false;
  clearTimer(room, 'buzz');
  transition(room, 'answer');
  g.deadlineTs = Date.now() + room.settings.answerTimeSec * 1000;
  rooms.touch(room);
  room._timers.answer = setTimeout(
    () => applyVerdict(io, rooms, room, false),
    room.settings.answerTimeSec * 1000,
  );

  emitBuzzState(io, room);
  io.to(room.id).emit('buzz:winner', { playerId, nick: player.nick });
  emitPhase(io, room);
  return { accepted: true };
}

export function judge(io, rooms, room, correct) {
  if (room.phase !== 'answer') throw new Error('Сейчас некому судить');
  clearTimer(room, 'answer');
  applyVerdict(io, rooms, room, correct);
}

function applyVerdict(io, rooms, room, correct) {
  const g = room.game;
  if (room.phase !== 'answer' || !g.buzz.winnerId) return;
  const winnerId = g.buzz.winnerId;
  const player = room.players.get(winnerId);
  const price = g.question.price;

  player.score += correct ? price : -price;
  rooms.touch(room);
  emitScores(io, rooms, room);
  io.to(room.id).emit('answer:verdict', { playerId: winnerId, correct, delta: correct ? price : -price });

  if (correct) {
    g.pickerId = winnerId;
    advance(io, rooms, room);
    return;
  }

  g.buzz.lockedIds.add(winnerId);
  g.buzz.winnerId = null;
  const eligible = [...room.players.values()].filter((p) => p.connected && !g.buzz.lockedIds.has(p.id));
  if (eligible.length > 0) {
    transition(room, 'buzz');
    g.buzz.open = true;
    g.deadlineTs = Date.now() + room.settings.buzzTimeoutSec * 1000;
    rooms.touch(room);
    room._timers.buzz = setTimeout(() => onBuzzTimeout(io, rooms, room), room.settings.buzzTimeoutSec * 1000);
    emitBuzzState(io, room);
    emitPhase(io, room);
  } else {
    goToReveal(io, rooms, room, 'answer');
  }
}

function onBuzzTimeout(io, rooms, room) {
  room._timers.buzz = null;
  if (room.phase !== 'buzz') return;
  room.game.buzz.open = false;
  emitBuzzState(io, room);
  goToReveal(io, rooms, room, 'buzz');
}

function goToReveal(io, rooms, room, fromPhase) {
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
  io.to(room.id).emit('answer:reveal', { answer: room.game.question.answer });
  emitPhase(io, room);
}

export function closeQuestion(io, rooms, room) {
  if (room.phase !== 'reveal') throw new Error('Вопрос ещё не закрыт');
  advance(io, rooms, room);
}

// Общий финал вопроса: ячейка сыграна, дальше board / следующий раунд / конец игры
function advance(io, rooms, room) {
  const g = room.game;
  g.used[g.roundIndex][g.question.themeIdx][g.question.qIdx] = true;
  g.question = null;
  g.revealed = false;
  g.deadlineTs = null;
  g.buzz = { open: false, winnerId: null, lockedIds: new Set() };

  const roundUsed = g.used[g.roundIndex];
  const roundDone = roundUsed.every((theme) => theme.every(Boolean));
  if (roundDone) {
    g.roundIndex += 1;
    if (g.roundIndex >= TEST_PACK.rounds.length) {
      transition(room, 'game_over');
      rooms.touch(room);
      emitPhase(io, room);
      io.to(room.id).emit('game:over', { standings: buildStandings(room) });
      return;
    }
  }

  transition(room, 'board');
  rooms.touch(room);
  emitBoard(io, rooms, room);
  emitPhase(io, room);
}

function buildStandings(room) {
  const sorted = [...room.players.values()].sort((a, b) => b.score - a.score);
  let place = 0;
  let prevScore = null;
  return sorted.map((p, i) => {
    if (p.score !== prevScore) place = i + 1;
    prevScore = p.score;
    return { place, id: p.id, nick: p.nick, avatarUrl: p.avatarUrl, score: p.score };
  });
}
