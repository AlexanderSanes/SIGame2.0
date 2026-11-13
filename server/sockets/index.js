import { bindSession } from './session.js';
import { socketLimits } from '../security.js';
import { registerPlayerHandlers } from './player.js';
import { registerHostHandlers } from './host.js';
import { registerGameHandlers } from './game.js';
import { registerBoardHandlers } from './board.js';
import { broadcastLobby } from './helpers.js';

export function initSockets(io, rooms) {
  io.on('connection', (socket) => {
    socketLimits(socket);
    socket.on('diagnostics:ping',(_payload,ack)=>{if(typeof ack==='function')ack({ok:true});});
    socket.on('disconnect', () => {
      const room = rooms.get(socket.data?.roomId);
      if (room && room.hostSocketId === socket.id) { room.hostSocketId = null; rooms.touch(room); }
    });
    // Единая точка авторизации обеих ролей (в т.ч. переподключение)
    socket.on('session:resume', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const { roomId, hostToken, playerId, sessionToken } = payload || {};
        const room = rooms.get(roomId);
        if (!room) return reply({ ok: false, error: 'Комната не найдена' });

        if (hostToken) {
          if (hostToken !== room.hostToken) {
            return reply({ ok: false, error: 'Неверный токен ведущего' });
          }
          bindSession(io, socket, rooms, room, 'host');
          return reply({ ok: true, role: 'host', state: rooms.buildState(room, 'host') });
        }

        if (playerId && sessionToken) {
          const player = rooms.findPlayerByToken(room, playerId, sessionToken);
          if (!player) return reply({ ok: false, error: 'Сессия не найдена' });
          bindSession(io, socket, rooms, room, 'player', player.id);
          rooms.touch(room);
          broadcastLobby(io, rooms, room);
          const view = player.role === 'spectator' ? 'board' : 'player';
          return reply({ ok: true, role: player.role || 'player', state: rooms.buildState(room, view, player.id) });
        }

        reply({ ok: false, error: 'Нужен hostToken или playerId + sessionToken' });
      } catch (e) {
        console.error('[session:resume]', e);
        reply({ ok: false, error: 'Внутренняя ошибка сервера' });
      }
    });

    registerPlayerHandlers(io, socket, rooms);
    registerHostHandlers(io, socket, rooms);
    registerGameHandlers(io, socket, rooms);
    registerBoardHandlers(io, socket, rooms);
  });
}
