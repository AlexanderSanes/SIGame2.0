import { socket, call, onReconnect } from '/shared/socket.js';
import { h, toast, avatarEl } from '/shared/ui.js';

const roomId = new URLSearchParams(location.search).get('room')?.toUpperCase();
const storageKey = `sigame:player:${roomId}`;

const joinForm = document.getElementById('join-form');
const lobby = document.getElementById('lobby');
const gone = document.getElementById('gone');
const errorEl = document.getElementById('error');
const nickInput = document.getElementById('nick-input');
const avatarInput = document.getElementById('avatar-input');
const avatarCanvas = document.getElementById('avatar-canvas');
const playerList = document.getElementById('player-list');

let avatarDataUrl = null;
let myId = null;

document.getElementById('room-code').textContent = roomId || '???';

if (!roomId) {
  showGone('Некорректная ссылка на комнату');
} else {
  tryResume();
}

// ---------- Аватар: центр-кроп в квадрат + сжатие до 256px ----------
avatarInput.addEventListener('change', () => {
  const file = avatarInput.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    errorEl.textContent = 'Файл больше 2 МБ';
    avatarInput.value = '';
    return;
  }
  const img = new Image();
  img.onload = () => {
    const side = Math.min(img.width, img.height);
    const sx = (img.width - side) / 2;
    const sy = (img.height - side) / 2;
    const ctx = avatarCanvas.getContext('2d');
    ctx.clearRect(0, 0, 256, 256);
    ctx.drawImage(img, sx, sy, side, side, 0, 0, 256, 256);
    avatarDataUrl = avatarCanvas.toDataURL('image/jpeg', 0.85);
    URL.revokeObjectURL(img.src);
  };
  img.onerror = () => {
    errorEl.textContent = 'Не удалось прочитать картинку';
    avatarInput.value = '';
  };
  img.src = URL.createObjectURL(file);
});

// ---------- Вход ----------
document.getElementById('join-btn').addEventListener('click', async () => {
  errorEl.textContent = '';
  const nick = nickInput.value.trim();
  if (nick.length < 2) {
    errorEl.textContent = 'Ник: минимум 2 символа';
    return;
  }
  try {
    const res = await call('room:join', { roomId, nick, avatar: avatarDataUrl });
    myId = res.playerId;
    localStorage.setItem(storageKey, JSON.stringify({
      playerId: res.playerId,
      sessionToken: res.sessionToken,
    }));
    showLobby(res.state);
  } catch (e) {
    if (e.message === 'Комната не найдена') showGone('Комната не найдена');
    else errorEl.textContent = e.message;
  }
});

// ---------- Переподключение ----------
async function tryResume() {
  const saved = localStorage.getItem(storageKey);
  if (!saved) {
    joinForm.hidden = false;
    return;
  }
  try {
    const { playerId, sessionToken } = JSON.parse(saved);
    const res = await call('session:resume', { roomId, playerId, sessionToken });
    myId = playerId;
    showLobby(res.state);
  } catch (e) {
    if (e.message === 'Сессия не найдена') {
      localStorage.removeItem(storageKey);
      joinForm.hidden = false;
    } else if (e.message === 'Комната не найдена') {
      showGone('Комната не найдена');
    } else {
      joinForm.hidden = false;
    }
  }
}

onReconnect(() => {
  if (myId) tryResume();
});

// ---------- Лобби ----------
function showLobby(state) {
  joinForm.hidden = true;
  gone.hidden = true;
  lobby.hidden = false;
  renderPlayers(state.players);
}

function renderPlayers(players) {
  const me = players.find((p) => p.id === myId);
  document.getElementById('my-nick').textContent = me?.nick || '';
  document.getElementById('players-count').textContent = `(${players.length})`;
  playerList.replaceChildren();
  for (const player of players) {
    const nick = player.id === myId ? `${player.nick} (ты)` : player.nick;
    playerList.append(
      h('li', { class: `player-item${player.connected ? '' : ' offline'}` },
        avatarEl(player),
        h('span', { class: 'nick' }, nick),
      ),
    );
  }
}

function showGone(text) {
  joinForm.hidden = true;
  lobby.hidden = true;
  gone.hidden = false;
  document.getElementById('gone-text').textContent = text;
}

// ---------- Выход (смена ника) ----------
document.getElementById('leave-btn').addEventListener('click', async () => {
  try {
    await call('player:leave', {});
  } catch { /* даже при ошибке сети выходим локально */ }
  localStorage.removeItem(storageKey);
  myId = null;
  lobby.hidden = true;
  joinForm.hidden = false;
  nickInput.value = '';
  nickInput.focus();
});

socket.on('lobby:players', (players) => {
  if (!lobby.hidden) renderPlayers(players);
});

socket.on('room:kicked', ({ reason }) => {
  localStorage.removeItem(storageKey);
  myId = null;
  lobby.hidden = true;
  joinForm.hidden = false;
  toast(reason || 'Вас удалили из комнаты', 'error');
});
