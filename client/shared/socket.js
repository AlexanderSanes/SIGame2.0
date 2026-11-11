// Требует, чтобы перед модулем был подключен /socket.io/socket.io.js (глобальный io)
export const socket = window.io();

// emit с ack в виде Promise; при ok:false кидает Error с текстом сервера
export function call(event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(10000).emit(event, payload, (err, res) => {
      if (err) return reject(new Error('Сервер не отвечает'));
      if (!res?.ok) return reject(new Error(res?.error || 'Неизвестная ошибка'));
      resolve(res);
    });
  });
}

export function onReconnect(handler) {
  socket.io.on('reconnect', handler);
}
