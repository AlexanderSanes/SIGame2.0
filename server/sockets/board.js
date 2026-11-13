import { bindSession } from './session.js';
// Табло: пассивный зритель, входит по коду комнаты без токена
export function registerBoardHandlers(io, socket, rooms) {
  socket.on('board:watch', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = rooms.get(payload?.roomId);
    if (!room) return reply({ ok: false, error: 'Комната не найдена' });
    bindSession(io, socket, rooms, room, 'board');
    reply({ ok: true, state: rooms.buildState(room, 'board') });
  });
}
