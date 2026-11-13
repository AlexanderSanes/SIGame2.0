const list = document.querySelector('#rooms');
const status = document.querySelector('#status');
const refresh = document.querySelector('#refresh');
const phases = { lobby: 'Ожидание игроков', board: 'Выбор вопроса', question: 'Вопрос', buzz: 'Приём нажатий', answer: 'Ответ игрока', reveal: 'Разбор ответа', final: 'Финал', game_over: 'Игра завершена', paused: 'Пауза', cat: 'Кот в мешке', auction: 'Аукцион' };
async function request(url, method = 'GET') {
  const response = await fetch(url, { method });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить действие');
  return data;
}
function element(tag, text) {
  const node = document.createElement(tag); node.textContent = text; return node;
}
async function load() {
  refresh.disabled = true;
  try {
    const data = await request('/api/admin/rooms');
    document.querySelector('#policy').textContent = `Комнат: ${data.rooms.length}. Без подключений и активности удаляются через ${data.roomIdleMs / 3600000} ч. Проверка — раз в минуту по умолчанию. Управление доступно только на ПК сервера.`;
    list.replaceChildren();
    if (!data.rooms.length) list.append(element('p', 'Сохранённых комнат нет. Создайте игру на главной странице.'));
    for (const room of data.rooms) {
      const card = element('article', ''); card.className = 'card';
      card.append(element('h2', `${room.id} · ${room.title}`));
      card.append(element('p', `${phases[room.phase] || room.phase} · Участников: ${room.players} · Подключений: ${room.connections}`));
      card.append(element('p', `Создана: ${new Date(room.createdAt).toLocaleString('ru-RU')}. Активность: ${new Date(room.updatedAt).toLocaleString('ru-RU')}`));
      const enter = element('button', 'Открыть как ведущий');
      enter.onclick = async () => {
        enter.disabled = true;
        try {
          const auth = await request(`/api/admin/rooms/${room.id}/access`, 'POST');
          localStorage.setItem(`sigame:host:${auth.roomId}`, auth.hostToken);
          location.href = `/host/?room=${auth.roomId}`;
        } catch (error) { status.textContent = error.message; enter.disabled = false; }
      };
      const remove = element('button', 'Удалить комнату'); remove.className = 'danger';
      remove.onclick = async () => {
        if (!confirm(`Удалить комнату ${room.id} и весь её прогресс без возможности восстановления? Подключений: ${room.connections}. Пакет вопросов останется в библиотеке.`)) return;
        remove.disabled = true;
        try {
          await request(`/api/admin/rooms/${room.id}`, 'DELETE');
          localStorage.removeItem(`sigame:host:${room.id}`);
          status.textContent = `Комната ${room.id} удалена.`; await load();
        } catch (error) { status.textContent = error.message; remove.disabled = false; }
      };
      const board = element('a', 'Открыть табло'); board.href = `/room/${room.id}/screen`; board.className = 'btn secondary';
      card.append(enter, board, remove); list.append(card);
    }
  } catch (error) { status.textContent = error.message; }
  finally { refresh.disabled = false; }
}
refresh.onclick = load;
load();
