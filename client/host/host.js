import { socket, call, onReconnect } from '/shared/socket.js';
import { h, toast, avatarEl } from '/shared/ui.js';

const roomId = new URLSearchParams(location.search).get('room')?.toUpperCase();
const hostToken = roomId && localStorage.getItem(`sigame:host:${roomId}`);

const $ = (id) => document.getElementById(id);
const panel = $('panel');
const noAccess = $('no-access');
const playerList = $('player-list');
const playersCount = $('players-count');
const emptyHint = $('empty-hint');

let countdownTimer = null;

const S = {
  phase: 'lobby',
  players: [],
  settings: null,
  game: null,
};

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
    applyState(state);
  } catch (e) {
    noAccess.hidden = false;
    toast(e.message, 'error');
  }
}

async function renderHeader() {
  $('room-code').textContent = roomId;
  // joinUrl приходит с сервера: если ведущий сидит через localhost,
  // сервер подставит LAN-IP, чтобы ссылка/QR работали с телефонов
  let joinUrl = `${location.origin}/player/?room=${roomId}`;
  try {
    const info = await (await fetch(`/api/rooms/${roomId}`)).json();
    if (info.ok) joinUrl = info.joinUrl;
  } catch { /* остаёмся на location.origin */ }
  $('join-link').textContent = joinUrl;
  try {
    const res = await fetch(`/api/qr?text=${encodeURIComponent(joinUrl)}`);
    const { dataUrl } = await res.json();
    $('qr').src = dataUrl;
  } catch {
    toast('Не удалось сгенерировать QR-код', 'error');
  }
  $('copy-link').onclick = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      toast('Ссылка скопирована');
    } catch {
      toast('Не удалось скопировать — скопируйте вручную', 'error');
    }
  };
  $('open-screen').onclick = () => window.open(`/room/${roomId}/screen`, '_blank');
}

// ---------- Настройки и старт ----------
function fillSettings(s) {
  $('set-picker').value = s.picker;
  $('set-answer-time').value = s.answerTimeSec;
  $('set-buzz-timeout').value = s.buzzTimeoutSec;
  $('set-show-question').checked = s.showQuestionToPlayers;
}

$('save-settings').addEventListener('click', async () => {
  try {
    const res = await call('settings:update', {
      picker: $('set-picker').value,
      answerTimeSec: Number($('set-answer-time').value),
      buzzTimeoutSec: Number($('set-buzz-timeout').value),
      showQuestionToPlayers: $('set-show-question').checked,
    });
    S.settings = res.settings;
    toast('Настройки сохранены');
  } catch (e) {
    toast(e.message, 'error');
  }
});

$('start-btn').addEventListener('click', async () => {
  try {
    await call('game:start', {});
  } catch (e) {
    toast(e.message, 'error');
  }
});

// ---------- Игровые кнопки ----------
$('buzz-open-btn').addEventListener('click', () => call('buzz:open', {}).catch((e) => toast(e.message, 'error')));
$('correct-btn').addEventListener('click', () => call('answer:judge', { correct: true }).catch((e) => toast(e.message, 'error')));
$('wrong-btn').addEventListener('click', () => call('answer:judge', { correct: false }).catch((e) => toast(e.message, 'error')));
$('reveal-btn').addEventListener('click', () => call('question:reveal', {}).catch((e) => toast(e.message, 'error')));
$('close-question-btn').addEventListener('click', () => call('question:close', {}).catch((e) => toast(e.message, 'error')));

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

// ---------- События ----------
socket.on('lobby:players', (players) => {
  S.players = players;
  if (S.phase === 'lobby') renderPlayers();
  renderScores();
});

socket.on('game:phase', (p) => {
  ensureGame();
  S.phase = p.phase;
  S.game.roundIndex = p.roundIndex;
  S.game.pickerId = p.pickerId;
  S.game.buzz.winnerId = p.winnerId;
  S.game.revealed = p.revealed;
  if (p.deadlineTs) S.game.deadlineTs = p.deadlineTs;
  render();
});

socket.on('game:round', (p) => {
  ensureGame();
  Object.assign(S.game, p);
});

socket.on('board:update', (board) => {
  ensureGame();
  S.game.board = board;
  if (S.phase === 'board') render();
});

socket.on('question:show', (q) => {
  ensureGame();
  S.game.question = { ...S.game.question, ...q };
  render();
});

socket.on('question:answer', ({ answer }) => {
  ensureGame();
  if (S.game.question) S.game.question.answer = answer;
  render();
});

socket.on('buzz:state', ({ open, deadlineTs, lockedIds }) => {
  ensureGame();
  S.game.buzz.open = open;
  S.game.buzz.lockedIds = lockedIds;
  if (deadlineTs) S.game.deadlineTs = deadlineTs;
  render();
});

socket.on('buzz:winner', ({ playerId }) => {
  ensureGame();
  S.game.buzz.winnerId = playerId;
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
  if (S.game) S.game.revealed = true;
  render();
});

socket.on('game:over', ({ standings }) => {
  S.phase = 'game_over';
  S.standings = standings;
  render();
});

// ---------- Рендер ----------
function applyState(state) {
  S.phase = state.phase;
  S.players = state.players;
  S.settings = state.settings;
  S.game = state.game;
  fillSettings(state.settings);
  render();
}

function render() {
  const inLobby = S.phase === 'lobby';
  const isOver = S.phase === 'game_over';
  $('lobby-card').hidden = !inLobby;
  $('settings-card').hidden = !inLobby;
  $('players-card').hidden = !inLobby;
  $('game-panel').hidden = inLobby || isOver;
  $('over').hidden = !isOver;

  if (inLobby) renderPlayers();
  if (!inLobby && !isOver) {
    renderScores();
    renderBoard();
    renderQuestion();
  }
  if (isOver) renderStandings();
}

function renderPlayers() {
  playerList.replaceChildren();
  playersCount.textContent = `(${S.players.length})`;
  emptyHint.hidden = S.players.length > 0;
  for (const player of S.players) {
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

function renderScores() {
  const strip = $('score-strip');
  strip.replaceChildren();
  for (const p of S.players) {
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
  const picker = S.players.find((p) => p.id === g.pickerId);
  $('board-hint').textContent = S.settings?.picker === 'player'
    ? `Выбирает: ${picker?.nick || '—'} (или вы сами)`
    : 'Выберите ячейку';

  const grid = $('board-grid');
  grid.replaceChildren();
  g.board.themes.forEach((theme, t) => {
    const cells = h('div', { class: 'board-cells' });
    theme.questions.forEach((q, qi) => {
      cells.append(h('button', {
        class: `cell${q.used ? ' used' : ''}`,
        ...(q.used ? { disabled: '' } : {}),
        onclick: () => selectCell(t, qi),
      }, String(q.price)));
    });
    grid.append(h('div', { class: 'board-row' }, h('div', { class: 'board-theme' }, theme.title), cells));
  });
}

async function selectCell(themeIdx, qIdx) {
  try {
    await call('board:select', { themeIdx, qIdx });
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderQuestion() {
  const card = $('question-card');
  const g = S.game;
  if (S.phase === 'board' || !g?.question) {
    card.hidden = true;
    stopCountdown();
    return;
  }
  card.hidden = false;
  $('q-price').textContent = `${g.question.themeTitle || ''} · ${g.question.price}`;
  $('q-text').textContent = g.question.text || '';
  $('q-answer').textContent = g.question.answer && (S.phase === 'question' || S.phase === 'reveal' || S.game.revealed)
    ? `Ответ: ${g.question.answer}` : '';

  const winner = S.players.find((p) => p.id === g.buzz.winnerId);
  const texts = {
    question: 'Читайте вопрос, затем разрешите ответы',
    buzz: 'Приём ответов…',
    answer: winner ? `Отвечает: ${winner.nick}` : '',
    reveal: 'Вопрос сгорел / никто не ответил верно',
  };
  $('status-text').textContent = texts[S.phase] || '';

  $('buzz-open-btn').hidden = S.phase !== 'question';
  $('verdict-btns').hidden = S.phase !== 'answer';
  $('reveal-btn').hidden = S.phase !== 'reveal' || g.revealed;
  $('close-question-btn').hidden = S.phase !== 'reveal' || !g.revealed;

  if (g.deadlineTs && ['buzz', 'answer'].includes(S.phase)) {
    startCountdown(g.deadlineTs);
  } else {
    stopCountdown();
    $('countdown').textContent = '';
  }
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

onReconnect(auth);
