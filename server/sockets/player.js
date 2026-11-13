import { bindSession, detachSession } from './session.js';
import * as game from '../game.js';
import { validateNick, saveAvatar } from '../avatars.js';
import { broadcastLobby } from './helpers.js';

export function registerPlayerHandlers(io, socket, rooms) {
  socket.on('room:join', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const { roomId, nick, avatar } = payload || {};
      const room = rooms.get(roomId);
      if (!room) return reply({ ok: false, error: 'Комната не найдена' });

      const trimmedNick = typeof nick === 'string' ? nick.trim() : '';
      const nickError = validateNick(trimmedNick);
      if (nickError) return reply({ ok: false, error: nickError });
      if (rooms.isNickTaken(room, trimmedNick)) {
        return reply({ ok: false, error: 'Этот ник уже занят в комнате' });
      }

      const player = rooms.addPlayer(room, { nick: trimmedNick, avatarUrl: null });
      if (avatar) {
        try {
          player.avatarUrl = saveAvatar(player.id, avatar);
        } catch (e) {
          rooms.removePlayer(room, player.id);
          return reply({ ok: false, error: e.message });
        }
      }

      // Финал уже сформирован: новые участники наблюдают, не меняя ставки и итоги.
      if (['final', 'game_over'].includes(room.phase)) player.role = 'spectator';
      bindSession(io, socket, rooms, room, 'player', player.id);
      if (room.phase === 'board' && !room.game.pickerId) game.setPicker(io, rooms, room, player.id);
      rooms.touch(room);

      broadcastLobby(io, rooms, room);
      reply({
        ok: true,
        playerId: player.id,
        sessionToken: player.sessionToken,
        state: rooms.buildState(room, player.role === 'spectator' ? 'board' : 'player', player.id),
      });
    } catch (e) {
      console.error('[room:join]', e);
      reply({ ok: false, error: 'Внутренняя ошибка сервера' });
    }
  });

  // Игрок сам выходит из комнаты (смена ника/профиля)
  socket.on('player:leave', (_payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const { role, roomId, playerId } = socket.data || {};
    if (role !== 'player') return reply({ ok: false, error: 'Вы не игрок этой комнаты' });
    detachSession(io, socket, rooms, { removePlayer: true });
    reply({ ok: true });
  });

  socket.on('disconnect', () => {
    const { role, roomId, playerId } = socket.data || {};
    if (role !== 'player') return;
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.get(playerId);
    if (!player || player.socketId !== socket.id) return;
    const remaining = [...io.sockets.sockets.values()].find((s) => s.connected && s.data?.roomId === roomId && s.data?.playerId === playerId);
    player.connected = Boolean(remaining);
    player.socketId = remaining?.id ?? null;
    if (!remaining) game.handlePlayerDisconnected(io, rooms, room, playerId);
    rooms.touch(room);
    broadcastLobby(io, rooms, room);
  });
}
