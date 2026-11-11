import { validateNick, saveAvatar } from '../avatars.js';
import { broadcastLobby } from './helpers.js';

export function registerPlayerHandlers(io, socket, rooms) {
  socket.on('room:join', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const { roomId, nick, avatar } = payload || {};
      const room = rooms.get(roomId);
      if (!room) return reply({ ok: false, error: 'Комната не найдена' });
      if (room.phase !== 'lobby') return reply({ ok: false, error: 'Игра уже началась' });

      const trimmedNick = (nick || '').trim();
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

      socket.join(room.id);
      socket.data = { role: 'player', roomId: room.id, playerId: player.id };
      player.socketId = socket.id;
      rooms.touch(room);

      broadcastLobby(io, rooms, room);
      reply({
        ok: true,
        playerId: player.id,
        sessionToken: player.sessionToken,
        state: rooms.buildState(room),
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
    const room = rooms.get(roomId);
    if (room) {
      rooms.removePlayer(room, playerId);
      broadcastLobby(io, rooms, room);
    }
    socket.leave(roomId);
    socket.data = {};
    reply({ ok: true });
  });

  socket.on('disconnect', () => {
    const { role, roomId, playerId } = socket.data || {};
    if (role !== 'player') return;
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.get(playerId);
    if (!player || player.socketId !== socket.id) return;
    player.connected = false;
    player.socketId = null;
    rooms.touch(room);
    broadcastLobby(io, rooms, room);
  });
}
