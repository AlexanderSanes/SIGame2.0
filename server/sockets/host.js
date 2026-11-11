import { broadcastLobby } from './helpers.js';

export function registerHostHandlers(io, socket, rooms) {
  socket.on('room:create', (_payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = rooms.createRoom();
    reply({ ok: true, roomId: room.id, hostToken: room.hostToken });
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

    if (player.socketId) {
      const kickedSocket = io.sockets.sockets.get(player.socketId);
      if (kickedSocket) {
        kickedSocket.emit('room:kicked', { reason: 'Ведущий удалил вас из комнаты' });
        kickedSocket.leave(room.id);
        kickedSocket.data = {};
      }
    }
    rooms.removePlayer(room, playerId);
    broadcastLobby(io, rooms, room);
    reply({ ok: true });
  });
}
