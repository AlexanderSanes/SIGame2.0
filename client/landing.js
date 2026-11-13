import { call } from '/shared/socket.js';
import { toast } from '/shared/ui.js';

const createBtn = document.getElementById('create-btn');
const joinBtn = document.getElementById('join-btn');
const codeInput = document.getElementById('code-input');
const errorEl = document.getElementById('error');
const packSelect = document.getElementById('pack-select');

(async () => {
  try {
    const res = await fetch('/api/packs');
    const data = await res.json();
    for (const p of data.packs || []) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.title} (${p.rounds} раундов, ${p.questions} вопросов)`;
      packSelect.append(opt);
    }
  } catch {
    toast('Не удалось загрузить список пакетов', 'error');
  }
})();

createBtn.addEventListener('click', async () => {
  createBtn.disabled = true;
  try {
    const { roomId, hostToken } = await call('room:create', { packId: packSelect.value || null });
    localStorage.setItem(`sigame:host:${roomId}`, hostToken);
    location.href = `/host/?room=${roomId}`;
  } catch (e) {
    toast(e.message, 'error');
    createBtn.disabled = false;
  }
});

joinBtn.addEventListener('click', goToRoom);
codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') goToRoom();
});
codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase();
  errorEl.textContent = '';
});

async function goToRoom() {
  const code = codeInput.value.trim().toUpperCase();
  if (code.length < 4) {
    errorEl.textContent = 'Введите код комнаты';
    return;
  }
  joinBtn.disabled = true;
  try {
    const res = await fetch(`/api/rooms/${code}`);
    const data = await res.json();
    if (!data.ok) {
      errorEl.textContent = data.error || 'Комната не найдена';
      return;
    }
    if (data.phase !== 'lobby') {
      errorEl.textContent = 'Игра в этой комнате уже началась';
      return;
    }
    location.href = `/player/?room=${code}`;
  } catch {
    errorEl.textContent = 'Нет связи с сервером';
  } finally {
    joinBtn.disabled = false;
  }
}
