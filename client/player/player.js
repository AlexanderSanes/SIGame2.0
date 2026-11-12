import { socket, call, onReconnect } from '/shared/socket.js';
import { h, toast, avatarEl, beep, vibrate } from '/shared/ui.js';

const roomId = new URLSearchParams(location.search).get('room')?.toUpperCase();
const storageKey = `sigame:player:${roomId}`;

const $ = (id) => document.getElementById(id);
const joinForm = $('join-form');
const lobby = $('lobby');
const gameEl = $('game');
const overEl = $('over');
const gone = $('gone');
const errorEl = $('error');
const nickInput = $('nick-input');
const avatarInput = $('avatar-input');
const avatarCanvas = $('avatar-canvas');
const playerList = $('player-list');
const buzzOverlay = $('buzz-overlay');
const buzzBtn = $('buzz-btn');

let avatarDataUrl = null;
let myId = null;
let countdownTimer = null;

// Локальное состояние, обновляемое событиями сервера
const S = {
  phase: 'lobby',
  players: [],
  settings: null,
  game: null,
};

$('room-code').textContent = roomId || '???';

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
$('join-btn').addEventListener('click', async () => {
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
    applyState(res.state);
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
    applyState(res.state);
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

// ---------- Выход (смена ника) ----------
$('leave-btn').addEventListener('click', async () => {
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

// Игра начинается после загрузки страницы: S.game создаём по первому игровому событию
function ensureGame() {
  if (!S.game) {
    S.game = {
      roundIndex: 0, roundsTotal: 0, roundTitle: '', pickerId: null,
      revealed: false, deadlineTs: null,
      buzz: { open: false, winnerId: null, lockedIds: [] },
      board: null, question: null,
    };
  }
}

// ---------- Игровые события ----------
socket.on('lobby:players', (players) => {
  S.players = players;
  if (!lobby.hidden) renderLobby();
  if (!gameEl.hidden) renderScores();
});

socket.on('game:phase', (p) => {
  ensureGame();
  S.phase = p.phase;
  S.game.roundIndex = p.roundIndex;
  S.game.pickerId = p.pickerId;
  S.game.buzz.winnerId = p.winnerId;
  S.game.revealed = p.revealed;
  S.game.paused = p.paused;
  S.game.deadlineTs = p.deadlineTs ?? S.game.deadlineTs;
  if (p.phase === 'board') S.game.question = null;
  render();
});

socket.on('player:role', ({ role }) => {
  toast(role === 'spectator' ? 'Ведущий перевёл вас в зрители' : 'Вы снова в игре');
});

socket.on('settings:updated', (settings) => {
  S.settings = settings;
});

socket.on('game:round', (p) => {
  ensureGame();
  S.game.roundIndex = p.roundIndex;
  S.game.roundTitle = p.roundTitle;
  S.game.roundsTotal = p.roundsTotal;
});

socket.on('board:update', (board) => {
  ensureGame();
  S.game.board = board;
  if (S.phase === 'board') render();
});

socket.on('question:show', (q) => {
  ensureGame();
  // новый вопрос — кнопка сброшена, никаких остатков от прошлого вопроса
  S.game.buzz = { open: false, winnerId: null, lockedIds: [] };
  S.game.paused = false;
  S.game.question = { ...S.game.question, ...q };
  render();
});

socket.on('buzz:state', ({ open, deadlineTs, lockedIds, paused }) => {
  ensureGame();
  S.game.buzz.open = open;
  S.game.buzz.lockedIds = lockedIds;
  if (paused !== undefined) S.game.paused = paused;
  S.game.deadlineTs = deadlineTs ?? S.game.deadlineTs;
  if (open && !paused && !lockedIds.includes(myId) && !isSpectator()) {
    vibrate(200);
    beep(880);
  }
  render();
});

socket.on('buzz:winner', ({ playerId, nick }) => {
  ensureGame();
  S.game.buzz.winnerId = playerId;
  if (playerId === myId) {
    beep(1320, 300);
    vibrate([100, 50, 100]);
  }
  render();
});

socket.on('score:update', ({ scores }) => {
  for (const { id, score } of scores) {
    const p = S.players.find((pl) => pl.id === id);
    if (p) p.score = score;
  }
  renderScores();
});

socket.on('answer:reveal', ({ answer }) => {
  if (S.game?.question) S.game.question.answer = answer;
  render();
});

socket.on('question:burned', () => {
  hideBuzz();
});

socket.on('game:over', ({ standings }) => {
  S.phase = 'game_over';
  S.standings = standings;
  render();
});

socket.on('room:kicked', ({ reason }) => {
  localStorage.removeItem(storageKey);
  myId = null;
  location.href = '/';
});

// ---------- Кнопка ----------
buzzBtn.addEventListener('click', () => {
  buzzBtn.disabled = true;
  socket.emit('buzz:press', {}, (res) => {
    if (res?.falseStart) {
      toast('Фальстарт! Ты пропускаешь этот вопрос', 'error');
      vibrate([80, 60, 80]);
    }
    if (!res?.accepted) buzzBtn.disabled = false;
  });
});

// ---------- Рендер ----------
function applyState(state) {
  S.phase = state.phase;
  S.players = state.players;
  S.settings = state.settings;
  S.game = state.game;
  render();
}

function render() {
  joinForm.hidden = true;
  gone.hidden = true;
  lobby.hidden = S.phase !== 'lobby';
  overEl.hidden = S.phase !== 'game_over';
  gameEl.hidden = S.phase === 'lobby' || S.phase === 'game_over';

  if (!lobby.hidden) renderLobby();
  if (!gameEl.hidden) renderGame();
  if (!overEl.hidden) renderStandings();
}

function renderLobby() {
  const me = S.players.find((p) => p.id === myId);
  $('my-nick').textContent = me?.nick || '';
  $('players-count').textContent = `(${S.players.length})`;
  playerList.replaceChildren();
  for (const player of S.players) {
    const nick = player.id === myId ? `${player.nick} (ты)` : player.nick;
    playerList.append(
      h('li', { class: `player-item${player.connected ? '' : ' offline'}` },
        avatarEl(player),
        h('span', { class: 'nick' }, nick),
      ),
    );
  }
}

function renderGame() {
  renderScores();
  renderBoard();
  renderStatus();
  renderBuzz();
}

function isSpectator() {
  return S.players.find((p) => p.id === myId)?.role === 'spectator';
}

function renderScores() {
  const strip = $('score-strip');
  strip.replaceChildren();
  for (const p of S.players) {
    if (p.role === 'spectator') continue;
    strip.append(
      h('span', { class: `score-chip${S.game?.buzz.winnerId === p.id ? ' winner' : ''}` },
        avatarEl(p, 28),
        h('span', {}, p.nick),
        h('span', { class: `points${p.score < 0 ? ' negative' : ''}` }, String(p.score)),
      ),
    );
  }
}

function renderBoard() {
  const boardCard = $('board-card');
  const g = S.game;
  if (S.phase !== 'board' || !g?.board) {
    boardCard.hidden = true;
    return;
  }
  boardCard.hidden = false;
  $('board-round').textContent = g.roundTitle || '';
  const iPick = S.settings?.picker === 'player' && g.pickerId === myId && !isSpectator();
  const picker = S.players.find((p) => p.id === g.pickerId);
  $('board-hint').textContent = isSpectator()
    ? 'Вы зритель — смотрите игру'
    : iPick
      ? 'Ты выбираешь вопрос'
      : `Выбирает: ${picker?.nick || 'ведущий'}`;

  const grid = $('board-grid');
  grid.replaceChildren();
  g.board.themes.forEach((theme, t) => {
    const cells = h('div', { class: 'board-cells' });
    theme.questions.forEach((q, qi) => {
      const cell = h('button', {
        class: `cell${q.used ? ' used' : ''}${iPick && !q.used ? ' pickable' : ''}`,
        ...(iPick && !q.used ? {} : { disabled: '' }),
        onclick: () => pickCell(t, qi),
      }, String(q.price));
      cells.append(cell);
    });
    grid.append(h('div', { class: 'board-row' }, h('div', { class: 'board-theme' }, theme.title), cells));
  });
}

async function pickCell(themeIdx, qIdx) {
  try {
    await call('board:select', { themeIdx, qIdx });
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderStatus() {
  const card = $('status-card');
  const g = S.game;
  if (S.phase === 'board' || S.phase === 'game_over' || !g) {
    card.hidden = true;
    stopCountdown();
    return;
  }
  card.hidden = false;
  $('q-price').textContent = g.question ? `${g.question.price}` : '';
  $('q-text').textContent = g.question?.text || '';
  $('q-answer').textContent = g.question?.answer && S.phase === 'reveal' && g.revealed
    ? `Ответ: ${g.question.answer}` : '';

  const winner = S.players.find((p) => p.id === g.buzz.winnerId);
  const texts = {
    question: 'Идёт вопрос… жди сигнала ведущего',
    buzz: g.buzz.open ? 'Жми кнопку!' : 'Приём ответов…',
    answer: winner ? (winner.id === myId ? 'Ты отвечаешь!' : `Отвечает: ${winner.nick}`) : '',
    reveal: 'Вопрос закрыт',
  };
  $('status-text').textContent = g.paused ? 'Пауза' : texts[S.phase] || '';

  if (g.paused) {
    stopCountdown();
    $('countdown').textContent = '⏸';
  } else if (g.deadlineTs && ['buzz', 'answer'].includes(S.phase)) {
    startCountdown(g.deadlineTs);
  } else {
    stopCountdown();
    $('countdown').textContent = '';
  }
}

function renderBuzz() {
  const g = S.game;
  if (!g) return;
  const meLocked = g.buzz.lockedIds.includes(myId);
  // во время чтения вопроса кнопка видна только если включён режим фальстарта
  const armedEarly = S.phase === 'question' && S.settings?.falseStart;
  const canBuzz = !isSpectator()
    && !g.buzz.winnerId
    && !meLocked
    && ((S.phase === 'buzz' && g.buzz.open && !g.paused) || armedEarly);
  buzzOverlay.hidden = !canBuzz;
  buzzBtn.disabled = !canBuzz;
  // «взведённая» кнопка до сигнала ведущего выглядит иначе — жать ещё рано
  buzzBtn.classList.toggle('armed', canBuzz && armedEarly);
  buzzBtn.textContent = canBuzz && armedEarly ? 'Жди сигнала…' : 'ОТВЕТИТЬ';
}

function hideBuzz() {
  buzzOverlay.hidden = true;
}

function startCountdown(deadlineTs) {
  stopCountdown();
  const tick = () => {
    const left = Math.max(0, Math.ceil((deadlineTs - Date.now()) / 1000));
    $('countdown').textContent = left > 0 ? String(left) : '';
    if (left <= 0) stopCountdown();
  };
  tick();
  countdownTimer = setInterval(tick, 200);
}

function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
}

function renderStandings() {
  const box = $('standings');
  box.replaceChildren();
  for (const row of S.standings || []) {
    box.append(
      h('div', { class: `standing-row${row.place === 1 ? ' first' : ''}` },
        h('span', { class: 'place' }, `${row.place}.`),
        avatarEl(row, 36),
        h('span', {}, row.nick),
        h('span', { class: 'points' }, String(row.score)),
      ),
    );
  }
}

function showGone(text) {
  joinForm.hidden = true;
  lobby.hidden = true;
  gone.hidden = false;
  $('gone-text').textContent = text;
}
