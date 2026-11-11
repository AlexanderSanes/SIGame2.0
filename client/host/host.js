import { socket, call, onReconnect } from '/shared/socket.js';
import { h, toast, avatarEl } from '/shared/ui.js';

const roomId = new URLSearchParams(location.search).get('room')?.toUpperCase();
const hostToken = roomId && localStorage.getItem(`sigame:host:${roomId}`);

const panel = document.getElementById('panel');
const noAccess = document.getElementById('no-access');
const playerList = document.getElementById('player-list');
const playersCount = document.getElementById('players-count');
const emptyHint = document.getElementById('empty-hint');

if (!roomId || !hostToken) {
  noAccess.hidden = false;
} else {
  auth();
}

async function auth() {
  try {
    const { state } = await call('session:resume', { roomId, hostToken });
    panel.hidden = false;
    renderHeader();
    renderPlayers(state.players);
  } catch (e) {
    noAccess.hidden = false;
    toast(e.message, 'error');
  }
}

async function renderHeader() {
  document.getElementById('room-code').textContent = roomId;
  // joinUrl приходит с сервера: если ведущий сидит через localhost,
  // сервер подставит LAN-IP, чтобы ссылка/QR работали с телефонов
  let joinUrl = `${location.origin}/player/?room=${roomId}`;
  try {
    const info = await (await fetch(`/api/rooms/${roomId}`)).json();
    if (info.ok) joinUrl = info.joinUrl;
  } catch { /* остаёмся на location.origin */ }
  document.getElementById('join-link').textContent = joinUrl;
  try {
    const res = await fetch(`/api/qr?text=${encodeURIComponent(joinUrl)}`);
    const { dataUrl } = await res.json();
    document.getElementById('qr').src = dataUrl;
  } catch {
    toast('Не удалось сгенерировать QR-код', 'error');
  }
  document.getElementById('copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      toast('Ссылка скопирована');
    } catch {
      toast('Не удалось скопировать — скопируйте вручную', 'error');
    }
  });
}

function renderPlayers(players) {
  playerList.replaceChildren();
  playersCount.textContent = `(${players.length})`;
  emptyHint.hidden = players.length > 0;
  for (const player of players) {
    const kickBtn = h('button', {
      class: 'kick-btn',
      onclick: () => kickPlayer(player),
    }, 'Кик');
    playerList.append(
      h('li', { class: `player-item${player.connected ? '' : ' offline'}` },
        avatarEl(player),
        h('span', { class: 'nick' }, player.nick),
        kickBtn,
      ),
    );
  }
}

async function kickPlayer(player) {
  if (!confirm(`Удалить игрока «${player.nick}»?`)) return;
  try {
    await call('player:kick', { playerId: player.id });
  } catch (e) {
    toast(e.message, 'error');
  }
}

socket.on('lobby:players', renderPlayers);
onReconnect(auth);
