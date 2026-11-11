export function broadcastLobby(io, rooms, room) {
  io.to(room.id).emit('lobby:players', rooms.publicPlayers(room));
}
