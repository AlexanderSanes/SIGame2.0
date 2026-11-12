import { socket, call } from '/shared/socket.js';
import { h, avatarEl } from '/shared/ui.js';

const roomId = location.pathname.match(/\/room\/([A-Z2-9]+)\/screen/i)?.[1]?.toUpperCase();

const $ = (id) => document.getElementById(id);

const S = { phase: null, players: [], game: null, standings: null };

socket.on('connect', watch);
onReconnectSafe();

async function watch() {
  try {
    const { state } = await call('board:watch', { roomId });
    applyState(state);
  } catch (e) {
    $('empty').hidden = false;
    $('screen').hidden = true;
    $('empty-text').textContent = e.message;
  }
}

function onReconnectSafe() {
  socket.io.on('reconnect', watch);
}

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

socket.on('lobby:players', (players) => { S.players = players; renderScores(); });
socket.on('game:phase', (p) => {
  ensureGame();
  S.phase = p.phase;
  S.game.roundIndex = p.roundIndex;
  S.game.pickerId = p.pickerId;
  S.game.buzz.winnerId = p.winnerId;
  S.game.revealed = p.revealed;
  S.game.paused = p.paused;
  render();
});
socket.on('game:round', (p) => { ensureGame(); Object.assign(S.game, p); });
socket.on('board:update', (board) => { ensureGame(); S.game.board = board; render(); });
socket.on('question:show', (q) => { ensureGame(); S.game.question = { ...S.game.question, ...q }; render(); });
socket.on('buzz:state', ({ open, lockedIds }) => {
  ensureGame();
  S.game.buzz.open = open;
  S.game.buzz.lockedIds = lockedIds;
  render();
});
socket.on('buzz:winner', ({ playerId }) => { ensureGame(); S.game.buzz.winnerId = playerId; render(); });
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
socket.on('game:over', ({ standings }) => {
  S.phase = 'game_over';
  S.standings = standings;
  render();
});

function applyState(state) {
  S.phase = state.phase;
  S.players = state.players;
  S.game = state.game;
  render();
}

function render() {
  $('empty').hidden = true;
  const isOver = S.phase === 'game_over';
  $('screen').hidden = isOver;
  $('over').hidden = !isOver;
  if (isOver) {
    renderStandings();
    return;
  }
  renderScores();
  renderBoard();
  renderQuestion();
}

function renderScores() {
  const strip = $('score-strip');
  strip.replaceChildren();
  for (const p of S.players) {
    if (p.role === 'spectator') continue;
    strip.append(
      h('span', { class: `score-chip${S.game?.buzz.winnerId === p.id ? ' winner' : ''}` },
        avatarEl(p, 40),
        h('span', {}, p.nick),
        h('span', { class: `points${p.score < 0 ? ' negative' : ''}` }, String(p.score)),
      ),
    );
  }
}

function renderBoard() {
  const card = $('board-card');
  const g = S.game;
  card.hidden = !(S.phase === 'board' && g?.board);
  if (card.hidden) return;
  $('board-round').textContent = g.roundTitle || '';
  const grid = $('board-grid');
  grid.replaceChildren();
  g.board.themes.forEach((theme) => {
    const cells = h('div', { class: 'board-cells' });
    theme.questions.forEach((q) => {
      cells.append(h('div', { class: `cell${q.used ? ' used' : ''}` }, String(q.price)));
    });
    grid.append(h('div', { class: 'board-row' }, h('div', { class: 'board-theme' }, theme.title), cells));
  });
}

function renderQuestion() {
  const card = $('question-card');
  const g = S.game;
  const show = ['question', 'buzz', 'answer', 'reveal'].includes(S.phase) && g?.question;
  card.hidden = !show;
  if (!show) return;
  $('q-price').textContent = `${g.question.themeTitle || ''} · ${g.question.price}`;
  $('q-text').textContent = g.question.text || '';
  $('q-answer').textContent = g.revealed && g.question.answer ? `Ответ: ${g.question.answer}` : '';

  const winner = S.players.find((p) => p.id === g.buzz.winnerId);
  const texts = {
    question: 'Внимание, вопрос!',
    buzz: g.buzz.open ? 'Кнопка открыта!' : '',
    answer: winner ? `Отвечает: ${winner.nick}` : '',
    reveal: '',
  };
  $('status-text').textContent = g.paused ? 'Пауза' : texts[S.phase] || '';
}

function renderStandings() {
  const box = $('standings');
  box.replaceChildren();
  for (const row of S.standings || []) {
    box.append(
      h('div', { class: `standing-row${row.place === 1 ? ' first' : ''}` },
        h('span', { class: 'place' }, `${row.place}.`),
        avatarEl(row, 48),
        h('span', {}, row.nick),
        h('span', { class: 'points' }, String(row.score)),
      ),
    );
  }
}
