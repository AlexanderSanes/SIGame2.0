import { registerPlayerHandlers } from './player.js';
import { registerHostHandlers } from './host.js';
import { broadcastLobby } from './helpers.js';

export function initSockets(io, rooms) {
  io.on('connection', (socket) => {
    // Единая точка авторизации обеих ролей (в т.ч. переподключение)
    socket.on('session:resume', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const { roomId, hostToken, playerId, sessionToken } = payload || {};
      const room = rooms.get(roomId);
      if (!room) return reply({ ok: false, error: 'Комната не найдена' });

      if (hostToken) {
        if (hostToken !== room.hostToken) {
          return reply({ ok: false, error: 'Неверный токен ведущего' });
        }
        socket.join(room.id);
        socket.data = { role: 'host', roomId: room.id };
        return reply({ ok: true, role: 'host', state: rooms.buildState(room) });
      }

      if (playerId && sessionToken) {
        const player = rooms.findPlayerByToken(room, playerId, sessionToken);
        if (!player) return reply({ ok: false, error: 'Сессия не найдена' });
        player.connected = true;
        player.socketId = socket.id;
        socket.join(room.id);
        socket.data = { role: 'player', roomId: room.id, playerId: player.id };
        rooms.touch(room);
        broadcastLobby(io, rooms, room);
        return reply({ ok: true, role: 'player', state: rooms.buildState(room) });
      }

      reply({ ok: false, error: 'Нужен hostToken или playerId + sessionToken' });
    });

    registerPlayerHandlers(io, socket, rooms);
    registerHostHandlers(io, socket, rooms);
  });
}
