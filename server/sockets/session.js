import * as game from '../game.js';
import { broadcastLobby } from './helpers.js';

// Одна точка снятия всех подписок при выходе или смене роли/комнаты.
export function detachSession(io, socket, rooms, { removePlayer = false, notify = true, disconnectPlayer = true } = {}) {
  const { roomId, playerId, role } = socket.data || {};
  const room = rooms.get(roomId);
  for (const channel of socket.rooms) if (channel !== socket.id) socket.leave(channel);
  socket.data = {};
  if (!room) return;
  if (role === 'host' && room.hostSocketId === socket.id) room.hostSocketId = null;
  if (role === 'player') {
    const player = room.players.get(playerId);
    if (removePlayer) {
      for (const member of io.sockets.sockets.values()) {
        if (member !== socket && member.data?.roomId === roomId && member.data?.playerId === playerId) {
          member.emit('session:replaced', { reason: 'Профиль игрока вышел из комнаты в другой вкладке' });
          for (const channel of member.rooms) if (channel !== member.id) member.leave(channel);
          member.data = {};
        }
      }
      rooms.removePlayer(room, playerId);
      game.handlePlayerRemoved(io, rooms, room, playerId);
    } else if (disconnectPlayer && player?.socketId === socket.id) {
      const remaining = [...io.sockets.sockets.values()].find((s) => s.connected && s.data?.roomId === roomId && s.data?.playerId === playerId);
      player.connected = Boolean(remaining);
      player.socketId = remaining?.id ?? null;
      if (!remaining) game.handlePlayerDisconnected(io, rooms, room, playerId);
    }
    if (notify) broadcastLobby(io, rooms, room);
  }
  rooms.touch(room);
}

export function bindSession(io, socket, rooms, room, role, playerId = null) {
  const old = socket.data || {};
  if (old.roomId !== room.id || old.role !== role || (old.playerId || null) !== playerId) {
    detachSession(io, socket, rooms);
  }
  const player = playerId && room.players.get(playerId);
  // Восстановление сессии тоже удаляет устаревшие подписки :full.
  for (const channel of socket.rooms) if (channel !== socket.id) socket.leave(channel);
  socket.join(room.id);
  if (role === 'host' || role === 'board' || player?.role === 'spectator') socket.join(`${room.id}:full`);
  socket.data = { role, roomId: room.id, ...(playerId ? { playerId } : {}) };
  if (role === 'host') room.hostSocketId = socket.id;
  if (player) {
    player.connected = true;
    player.socketId = socket.id;
    game.handlePlayerReconnected(io, rooms, room, playerId);
  }
  rooms.touch(room);
}
