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
  log: [],
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
  $('set-false-start').checked = Boolean(s.falseStart);
}

$('save-settings').addEventListener('click', async () => {
  try {
    const res = await call('settings:update', {
      picker: $('set-picker').value,
      answerTimeSec: Number($('set-answer-time').value),
      buzzTimeoutSec: Number($('set-buzz-timeout').value),
      showQuestionToPlayers: $('set-show-question').checked,
      falseStart: $('set-false-start').checked,
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

// ---------- Кнопки управления ----------
const act = (event, payload = {}) => () => call(event, payload).catch((e) => toast(e.message, 'error'));
$('buzz-open-btn').addEventListener('click', act('buzz:open'));
$('correct-btn').addEventListener('click', act('answer:judge', { correct: true }));
$('wrong-btn').addEventListener('click', act('answer:judge', { correct: false }));
$('reveal-btn').addEventListener('click', act('question:reveal'));
$('close-question-btn').addEventListener('click', act('question:close'));
$('skip-btn').addEventListener('click', act('question:skip'));
$('pause-btn').addEventListener('click', act('game:pause'));
$('undo-btn').addEventListener('click', act('score:undo'));
$('round-end-btn').addEventListener('click', () => {
  if (confirm('Завершить раунд досрочно? Несыгранные ячейки сгорят.')) act('round:end')();
});
$('game-end-btn').addEventListener('click', () => {
  if (confirm('Завершить игру и показать итоги?')) act('game:end')();
});

// Игра начинается после загрузки страницы: S.game создаём по первому игровому событию
function ensureGame() {
  if (!S.game) {
    S.game = {
      roundIndex: 0, roundsTotal: 0, roundTitle: '', pickerId: null,
      revealed: false, paused: false, deadlineTs: null,
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
  if (S.phase !== 'lobby' && S.phase !== 'game_over') renderPlayersCtrl();
});

socket.on('log:entry', (entry) => {
  S.log.push(entry);
  if (S.log.length > 100) S.log.shift();
  renderLog();
});

socket.on('settings:updated', (settings) => {
  S.settings = settings;
  if (S.phase === 'lobby') fillSettings(settings);
});

socket.on('game:phase', (p) => {
  ensureGame();
  S.phase = p.phase;
  S.game.roundIndex = p.roundIndex;
  S.game.pickerId = p.pickerId;
  S.game.buzz.winnerId = p.winnerId;
  S.game.revealed = p.revealed;
  S.game.paused = p.paused;
  S.game.deadlineTs = p.deadlineTs;
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

socket.on('buzz:state', ({ open, deadlineTs, lockedIds, paused }) => {
  ensureGame();
  S.game.buzz.open = open;
  S.game.buzz.lockedIds = lockedIds;
  if (paused !== undefined) S.game.paused = paused;
  S.game.deadlineTs = deadlineTs ?? S.game.deadlineTs;
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
  if (S.phase !== 'lobby' && S.phase !== 'game_over') renderPlayersCtrl();
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
  S.log = state.log || [];
  fillSettings(state.settings);
  render();
  renderLog();
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
    renderControls();
    renderPlayersCtrl();
  }
  if (isOver) renderStandings();
}

function renderPlayers() {
  playerList.replaceChildren();
  playersCount.textContent = `(${S.players.length})`;
  emptyHint.hidden = S.players.length > 0;
  for (const player of S.players) {
    const isSpectator = player.role === 'spectator';
    playerList.append(
      h('li', { class: `player-item${player.connected ? '' : ' offline'}` },
        avatarEl(player),
        h('span', { class: 'nick' }, player.nick),
        isSpectator ? h('span', { class: 'badge spectator' }, 'зритель') : null,
        h('button', { class: 'kick-btn', onclick: () => toggleRole(player) },
          isSpectator ? 'В игроки' : 'В зрители'),
        h('button', { class: 'kick-btn', onclick: () => kickPlayer(player) }, 'Кик'),
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

async function toggleRole(player) {
  const role = player.role === 'spectator' ? 'player' : 'spectator';
  try {
    await call('player:setRole', { playerId: player.id, role });
  } catch (e) {
    toast(e.message, 'error');
  }
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

function renderControls() {
  const g = S.game;
  $('buzz-open-btn').hidden = S.phase !== 'question';
  $('correct-btn').hidden = S.phase !== 'answer';
  $('wrong-btn').hidden = S.phase !== 'answer';
  $('reveal-btn').hidden = S.phase !== 'reveal' || g?.revealed;
  $('close-question-btn').hidden = S.phase !== 'reveal' || !g?.revealed;
  $('skip-btn').hidden = !['question', 'buzz', 'answer', 'reveal'].includes(S.phase);
  $('pause-btn').hidden = !['buzz', 'answer'].includes(S.phase);
  $('pause-btn').textContent = g?.paused ? 'Продолжить' : 'Пауза';
}

// Список игроков с управлением счётом и ролями
function renderPlayersCtrl() {
  const list = $('players-ctrl');
  list.replaceChildren();
  const price = S.game?.question?.price ?? 100;
  for (const p of S.players) {
    const isSpectator = p.role === 'spectator';
    const isPicker = S.game?.pickerId === p.id;

    const adjInput = h('input', {
      class: 'adj-input', type: 'number', placeholder: '±сумма', step: '50',
    });
    const applyAdj = async () => {
      const delta = Number.parseInt(adjInput.value, 10);
      if (!delta) return;
      adjInput.value = '';
      try {
        await call('score:adjust', { playerId: p.id, delta });
      } catch (e) {
        toast(e.message, 'error');
      }
    };
    adjInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyAdj(); });

    list.append(
      h('li', { class: `player-ctrl${p.connected ? '' : ' offline'}` },
        h('div', { class: 'row' },
          avatarEl(p, 32),
          h('span', { class: 'nick' }, p.nick),
          isPicker ? h('span', { class: 'badge' }, 'выбирает') : null,
          isSpectator ? h('span', { class: 'badge spectator' }, 'зритель') : null,
          h('span', { class: `score${p.score < 0 ? ' negative' : ''}` }, String(p.score)),
        ),
        h('div', { class: 'row' },
          h('button', {
            class: 'mini success', title: `+${price}`,
            onclick: () => call('score:adjust', { playerId: p.id, delta: price }).catch((e) => toast(e.message, 'error')),
          }, `+${price}`),
          h('button', {
            class: 'mini danger', title: `−${price}`,
            onclick: () => call('score:adjust', { playerId: p.id, delta: -price }).catch((e) => toast(e.message, 'error')),
          }, `−${price}`),
          adjInput,
          h('button', { class: 'mini secondary', onclick: applyAdj }, 'ОК'),
        ),
        h('div', { class: 'row' },
          !isSpectator && S.phase === 'board' && !isPicker
            ? h('button', {
                class: 'mini secondary',
                onclick: () => call('game:setPicker', { playerId: p.id }).catch((e) => toast(e.message, 'error')),
              }, 'Передать выбор')
            : null,
          h('button', { class: 'mini secondary', onclick: () => toggleRole(p) },
            isSpectator ? 'В игроки' : 'В зрители'),
          h('button', { class: 'mini secondary', onclick: () => kickPlayer(p) }, 'Кик'),
        ),
      ),
    );
  }
}

function renderLog() {
  const list = $('log-list');
  if (!list) return;
  list.replaceChildren();
  const fmt = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour12: false });
  for (const entry of [...S.log].reverse()) {
    list.append(h('li', {}, h('time', {}, fmt(entry.ts)), entry.text));
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
