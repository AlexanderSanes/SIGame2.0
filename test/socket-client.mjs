// Клиенты теста используют тот же контекст попытки, который получают браузеры.
// Общая карта позволяет тестовому ведущему дождаться контекста, уже доставленного
// нажавшему клиенту перед его ack. Явные ID негативных сценариев не подменяются.
import { io as socketIO } from 'socket.io-client';
const attempts = new Map();
export function io(...args) {
  const socket = socketIO(...args);
  let roomId = null;
  const update = (g) => {
    if (g && roomId) attempts.set(roomId, {
      questionId: g.questionId,
      answerAttemptId: g.answerAttemptId,
      playerId: g.winnerId ?? g.buzz?.winnerId,
    });
  };
  socket.on('game:phase', update);
  const emit = socket.emit.bind(socket);
  socket.emit = (event, payload, ack) => {
    if (event === 'answer:judge') payload = { ...attempts.get(roomId), ...payload };
    const reply = typeof ack === 'function' ? (...values) => {
      const response = values.find((v) => v && typeof v === 'object' && v.state);
      if (response?.state) {
        roomId = response.state.roomId;
        update(response.state.game);
      }
      ack(...values);
    } : ack;
    return emit(event, payload, reply);
  };
  return socket;
}
