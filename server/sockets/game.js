import * as game from '../game.js';

const clampInt = (v, min, max, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export function registerGameHandlers(io, socket, rooms) {
  const reply = (ack) => (typeof ack === 'function' ? ack : () => {});
  const roomOf = () => rooms.get(socket.data?.roomId);
  const isHost = () => socket.data?.role === 'host';
  const isPlayer = () => socket.data?.role === 'player';

  socket.on('game:start', (_p, ack) => {
    const done = reply(ack);
    try {
      if (!isHost()) return done({ ok: false, error: 'Только ведущий может начать игру' });
      const room = roomOf();
      if (!room) return done({ ok: false, error: 'Комната не найдена' });
      if (room.phase !== 'lobby') return done({ ok: false, error: 'Игра уже идёт' });
      if (room.players.size < 1) return done({ ok: false, error: 'Нужен хотя бы один игрок' });
      game.startGame(io, rooms, room);
      done({ ok: true });
    } catch (e) {
      done({ ok: false, error: e.message });
    }
  });

  socket.on('settings:update', (payload, ack) => {
    const done = reply(ack);
    if (!isHost()) return done({ ok: false, error: 'Только ведущий меняет настройки' });
    const room = roomOf();
    if (!room) return done({ ok: false, error: 'Комната не найдена' });
    if (room.phase !== 'lobby') return done({ ok: false, error: 'Настройки меняются только в лобби' });
    const s = room.settings;
    if (payload.picker !== undefined) {
      if (!['player', 'host'].includes(payload.picker)) return done({ ok: false, error: 'picker: player|host' });
      s.picker = payload.picker;
    }
    if (payload.answerTimeSec !== undefined) s.answerTimeSec = clampInt(payload.answerTimeSec, 3, 30, s.answerTimeSec);
    if (payload.buzzTimeoutSec !== undefined) s.buzzTimeoutSec = clampInt(payload.buzzTimeoutSec, 5, 60, s.buzzTimeoutSec);
    if (payload.showQuestionToPlayers !== undefined) s.showQuestionToPlayers = Boolean(payload.showQuestionToPlayers);
    if (payload.falseStart !== undefined) s.falseStart = Boolean(payload.falseStart);
    rooms.touch(room);
    io.to(room.id).emit('settings:updated', s);
    game.logAction(io, rooms, room, 'Настройки комнаты обновлены');
    done({ ok: true, settings: s });
  });

  socket.on('board:select', (payload, ack) => {
    const done = reply(ack);
    try {
      const room = roomOf();
      if (!room) return done({ ok: false, error: 'Комната не найдена' });
      if (room.phase !== 'board') return done({ ok: false, error: 'Сейчас нельзя выбирать ячейку' });
      const isPickerPlayer = isPlayer() && socket.data.playerId === room.game.pickerId;
      const allowed = isHost() || (room.settings.picker === 'player' && isPickerPlayer);
      if (!allowed) return done({ ok: false, error: 'Сейчас выбирает другой игрок' });
      game.selectCell(io, rooms, room, payload?.themeIdx, payload?.qIdx, isHost());
      done({ ok: true });
    } catch (e) {
      done({ ok: false, error: e.message });
    }
  });

  socket.on('buzz:open', (_p, ack) => {
    const done = reply(ack);
    try {
      if (!isHost()) return done({ ok: false, error: 'Только ведущий открывает кнопку' });
      const room = roomOf();
      if (!room) return done({ ok: false, error: 'Комната не найдена' });
      if (room.phase !== 'question') return done({ ok: false, error: 'Сначала выберите вопрос' });
      game.openBuzz(io, rooms, room);
      done({ ok: true });
    } catch (e) {
      done({ ok: false, error: e.message });
    }
  });

  socket.on('buzz:press', (_p, ack) => {
    const done = reply(ack);
    if (!isPlayer()) return done({ ok: false, error: 'Только игроки жмут кнопку' });
    const room = roomOf();
    if (!room) return done({ ok: false, error: 'Комната не найдена' });
    const { accepted, falseStart } = game.pressBuzz(io, rooms, room, socket.data.playerId);
    done({ ok: true, accepted, falseStart: Boolean(falseStart) });
  });

  socket.on('answer:judge', (payload, ack) => {
    const done = reply(ack);
    try {
      if (!isHost()) return done({ ok: false, error: 'Только ведущий судит ответы' });
      const room = roomOf();
      if (!room) return done({ ok: false, error: 'Комната не найдена' });
      game.judge(io, rooms, room, Boolean(payload?.correct));
      done({ ok: true });
    } catch (e) {
      done({ ok: false, error: e.message });
    }
  });

  socket.on('question:reveal', (_p, ack) => {
    const done = reply(ack);
    try {
      if (!isHost()) return done({ ok: false, error: 'Только ведущий' });
      const room = roomOf();
      if (!room) return done({ ok: false, error: 'Комната не найдена' });
      game.revealAnswer(io, rooms, room);
      done({ ok: true });
    } catch (e) {
      done({ ok: false, error: e.message });
    }
  });

  socket.on('question:close', (_p, ack) => {
    const done = reply(ack);
    try {
      if (!isHost()) return done({ ok: false, error: 'Только ведущий' });
      const room = roomOf();
      if (!room) return done({ ok: false, error: 'Комната не найдена' });
      game.closeQuestion(io, rooms, room);
      done({ ok: true });
    } catch (e) {
      done({ ok: false, error: e.message });
    }
  });

  // ---------- пульт ведущего ----------

  // score:adjust { playerId, delta } — ручная корректировка (в т.ч. ±цена вопроса)
  socket.on('score:adjust', (payload, ack) => {
    const done = reply(ack);
    try {
      if (!isHost()) return done({ ok: false, error: 'Только ведущий' });
      const room = roomOf();
      if (!room) return done({ ok: false, error: 'Комната не найдена' });
      const delta = Number.parseInt(payload?.delta, 10);
      if (!Number.isFinite(delta) || delta === 0) return done({ ok: false, error: 'Сумма должна быть ненулевым числом' });
      if (Math.abs(delta) > 100000) return done({ ok: false, error: 'Слишком большая сумма' });
      game.adjustScore(io, rooms, room, payload?.playerId, delta);
      done({ ok: true });
    } catch (e) {
      done({ ok: false, error: e.message });
    }
  });

  socket.on('score:undo', (_p, ack) => {
    const done = reply(ack);
    try {
      if (!isHost()) return done({ ok: false, error: 'Только ведущий' });
      const room = roomOf();
      if (!room) return done({ ok: false, error: 'Комната не найдена' });
      game.undo(io, rooms, room);
      done({ ok: true });
    } catch (e) {
      done({ ok: false, error: e.message });
    }
  });

  socket.on('game:setPicker', (payload, ack) => {
    const done = reply(ack);
    try {
      if (!isHost()) return done({ ok: false, error: 'Только ведущий' });
      const room = roomOf();
      if (!room) return done({ ok: false, error: 'Комната не найдена' });
      game.setPicker(io, rooms, room, payload?.playerId);
      done({ ok: true });
    } catch (e) {
      done({ ok: false, error: e.message });
    }
  });

  socket.on('question:skip', (_p, ack) => {
    const done = reply(ack);
    try {
      if (!isHost()) return done({ ok: false, error: 'Только ведущий' });
      const room = roomOf();
      if (!room) return done({ ok: false, error: 'Комната не найдена' });
      game.skipQuestion(io, rooms, room);
      done({ ok: true });
    } catch (e) {
      done({ ok: false, error: e.message });
    }
  });

  socket.on('game:pause', (_p, ack) => {
    const done = reply(ack);
    try {
      if (!isHost()) return done({ ok: false, error: 'Только ведущий' });
      const room = roomOf();
      if (!room) return done({ ok: false, error: 'Комната не найдена' });
      game.togglePause(io, rooms, room);
      done({ ok: true });
    } catch (e) {
      done({ ok: false, error: e.message });
    }
  });

  socket.on('round:end', (_p, ack) => {
    const done = reply(ack);
    try {
      if (!isHost()) return done({ ok: false, error: 'Только ведущий' });
      const room = roomOf();
      if (!room) return done({ ok: false, error: 'Комната не найдена' });
      game.endRound(io, rooms, room);
      done({ ok: true });
    } catch (e) {
      done({ ok: false, error: e.message });
    }
  });

  // media:control { action: 'play'|'pause' } — общие контролы аудио/видео вопроса
  socket.on('media:control', (payload, ack) => {
    const done = reply(ack);
    if (!isHost()) return done({ ok: false, error: 'Только ведущий управляет медиа' });
    const room = roomOf();
    if (!room) return done({ ok: false, error: 'Комната не найдена' });
    const action = payload?.action;
    if (!['play', 'pause'].includes(action)) return done({ ok: false, error: 'action: play|pause' });
    io.to(room.id).emit('media:control', { action });
    done({ ok: true });
  });

  socket.on('game:end', (_p, ack) => {
    const done = reply(ack);
    try {
      if (!isHost()) return done({ ok: false, error: 'Только ведущий' });
      const room = roomOf();
      if (!room) return done({ ok: false, error: 'Комната не найдена' });
      game.endGame(io, rooms, room);
      done({ ok: true });
    } catch (e) {
      done({ ok: false, error: e.message });
    }
  });
}
