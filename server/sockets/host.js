import { detachSession } from './session.js';
import { broadcastLobby } from './helpers.js';
import * as game from '../game.js';

const fullRoom = (roomId) => `${roomId}:full`;

export function registerHostHandlers(io, socket, rooms) {
  socket.on('room:create', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = rooms.createRoom(payload?.packId || null);
    reply({ ok: true, roomId: room.id, hostToken: room.hostToken, packTitle: room.pack.title });
  });

  socket.on('player:kick', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const { role, roomId } = socket.data || {};
    if (role !== 'host') return reply({ ok: false, error: 'Только ведущий может кикать' });

    const room = rooms.get(roomId);
    if (!room) return reply({ ok: false, error: 'Комната не найдена' });

    const playerId = payload?.playerId;
    const player = room.players.get(playerId);
    if (!player) return reply({ ok: false, error: 'Игрок не найден' });

    for (const member of io.sockets.sockets.values()) {
      if (member.data?.roomId === room.id && member.data?.playerId === playerId) {
        member.emit('room:kicked', { reason: 'Ведущий удалил вас из комнаты' });
        detachSession(io, member, rooms, { notify: false, disconnectPlayer: false });
      }
    }
    rooms.removePlayer(room, playerId);
    game.handlePlayerRemoved(io, rooms, room, playerId);
    game.logAction(io, rooms, room, `Игрок удалён: ${player.nick}`);
    broadcastLobby(io, rooms, room);
    reply({ ok: true });
  });

  // player:setRole { playerId, role: 'player' | 'spectator' } — перевод в зрители и обратно
  socket.on('player:setRole', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const { role, roomId } = socket.data || {};
    if (role !== 'host') return reply({ ok: false, error: 'Только ведущий' });

    const room = rooms.get(roomId);
    if (!room) return reply({ ok: false, error: 'Комната не найдена' });

    const newRole = payload?.role;
    if (!['player', 'spectator'].includes(newRole)) return reply({ ok: false, error: 'role: player|spectator' });

    const player = room.players.get(payload?.playerId);
    if (!player) return reply({ ok: false, error: 'Игрок не найден' });
    if (player.role === newRole) return reply({ ok: true });

    player.role = newRole;
    rooms.touch(room);

    // зритель видит вопрос как табло: пересаживаем его сокет в «полную» комнату
    for (const playerSocket of io.sockets.sockets.values()) {
      if (playerSocket.data?.roomId !== room.id || playerSocket.data?.playerId !== player.id) continue;
      if (newRole === 'spectator') playerSocket.join(fullRoom(room.id));
      else playerSocket.leave(fullRoom(room.id));
      playerSocket.emit('player:role', { role: newRole });
    }
    // зритель не может быть текущим отвечающим/выбирающим
    if (newRole === 'spectator') game.handlePlayerRemoved(io, rooms, room, player.id);

    game.logAction(io, rooms, room,
      newRole === 'spectator' ? `${player.nick} переведён в зрители` : `${player.nick} возвращён в игроки`);
    broadcastLobby(io, rooms, room);
    reply({ ok: true });
  });
}
