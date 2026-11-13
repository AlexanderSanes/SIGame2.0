import { socket, call } from '/shared/socket.js';
import { h, avatarEl } from '/shared/ui.js';
import { renderMedia, applyMediaControl, preloadMedia } from '/shared/media.js';
import { playSound, muteButton } from '/shared/sounds.js';

const roomId = location.pathname.match(/\/room\/([A-Z2-9]+)\/screen/i)?.[1]?.toUpperCase();

const $ = (id) => document.getElementById(id);

const S = { phase: null, players: [], game: null, standings: null, special: null };
let lastMediaKey = null;
let lastAnswerRendered = false;
let currentPlayers = []; // отрендеренные аудио/видео текущего вопроса (для media:control)

document.body.append(muteButton());

// реакция игрока — всплывающий эмодзи на 2 секунды
socket.on('reaction:show', ({ nick, emoji }) => {
  const el = h('div', { class: 'reaction-float', style: `left:${10 + Math.random() * 80}%` },
    h('span', { class: 'reaction-emoji' }, emoji),
    h('span', { class: 'reaction-nick' }, nick));
  document.body.append(el);
  setTimeout(() => el.remove(), 2000);
});

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
  if (p.phase === 'board') S.special = null;
  render();
});
socket.on('game:round', (p) => { ensureGame(); Object.assign(S.game, p); });
socket.on('board:update', (board) => { ensureGame(); S.game.board = board; render(); });
socket.on('question:show', (q) => {
  ensureGame();
  // новый вопрос — кнопка сброшена, никаких остатков от прошлого вопроса
  S.game.buzz = { open: false, winnerId: null, lockedIds: [] };
  S.game.paused = false;
  S.game.question = { ...S.game.question, ...q };
  render();
});
socket.on('buzz:state', ({ open, lockedIds }) => {
  ensureGame();
  if (open && !S.game.buzz.open) playSound('open');
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
socket.on('answer:reveal', ({ answer, answerMedia }) => {
  if (S.game?.question) {
    S.game.question.answer = answer;
    S.game.question.answerMedia = answerMedia || [];
  }
  render();
});
socket.on('media:control', ({ action, position }) => applyMediaControl(currentPlayers, action, position));
socket.on('round:media', ({ urls }) => preloadMedia(urls));

// особые механики: сплэш + звук
socket.on('cat:pending', () => { playSound('special'); ensureGame(); S.game.question = null; S.special = { kind: 'cat' }; render(); });
socket.on('auction:start', () => { playSound('special'); ensureGame(); S.game.question = null; S.special = { kind: 'auction', betCount: 0, playersCount: 0 }; render(); });
socket.on('auction:state', ({ betCount, playersCount }) => {
  if (S.special?.kind === 'auction') Object.assign(S.special, { betCount, playersCount });
  render();
});
socket.on('final:start', ({ title }) => { playSound('special'); S.special = { kind: 'final', title, stage: 'stake', stakedIds: [], answeredIds: [], eligibleIds: [] }; render(); });
socket.on('final:state', (p) => { if (S.special?.kind === 'final') Object.assign(S.special, p); render(); });
socket.on('answer:verdict', ({ correct }) => playSound(correct ? 'correct' : 'wrong'));
socket.on('game:over', ({ standings }) => {
  S.phase = 'game_over';
  S.standings = standings;
  render();
});

function applyState(state) {
  S.phase = state.phase;
  S.players = state.players;
  S.game = state.game;
  S.standings = state.standings;
  S.special = state.phase === 'final' && state.game?.final
    ? { kind: 'final', ...state.game.final }
    : state.phase === 'auction' && state.game?.auction
      ? { kind: 'auction', ...state.game.auction }
      : state.phase === 'cat' ? { kind: 'cat' } : null;
  preloadMedia(state.roundMedia);
  lastMediaKey = null;
  render();
  const control=state.game?.mediaControl;
  if(control){const elapsed=control.action==='play'?Math.max(0,(Date.now()-control.timestamp)/1000):0;applyMediaControl(currentPlayers,control.action,Number.isFinite(control.position)?control.position+elapsed:null);}
}

function render() {
  document.body.dataset.phase = S.phase;
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
  renderSpecial();
  renderQuestion();
}

// Сплэш особых фаз, пока вопрос ещё не открыт
function renderSpecial() {
  let el = $('special-splash');
  if (!el) {
    el = h('div', { id: 'special-splash', class: 'card', hidden: '' });
    $('screen').append(el);
  }
  const sp = S.special;
  const show = sp && ['cat', 'auction'].includes(S.phase)
    || (S.phase === 'final' && sp?.stage !== 'answer' && sp?.stage !== 'judge');
  el.hidden = !show;
  if (!show) return;
  el.replaceChildren();
  if (S.phase === 'cat') {
    el.append(h('div', { class: 'special-splash-text' }, '🐈 Кот в мешке!'));
  } else if (S.phase === 'auction') {
    el.append(h('div', { class: 'special-splash-text' }, '🔨 Аукцион!'),
      h('p', { class: 'muted center' }, `Ставок: ${sp.betCount}/${sp.playersCount}`));
  } else if (S.phase === 'final') {
    el.append(h('div', { class: 'special-splash-text' }, `★ Финал: ${sp.title}`),
      h('p', { class: 'muted center' }, `Ставок: ${sp.stakedIds.length}/${sp.eligibleIds.length}`));
  }
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
  const boardSignature=JSON.stringify([g.board,g.pickerId,S.settings?.picker]);
  if(grid.dataset.signature===boardSignature)return;
  grid.dataset.signature=boardSignature;
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
  const show = ['question', 'buzz', 'answer', 'reveal', 'final'].includes(S.phase) && g?.question;
  card.hidden = !show;
  if (!show) return;
  $('q-price').textContent = `${g.question.themeTitle || ''} · ${g.question.price}`;
  $('q-text').textContent = g.question.text || '';
  $('q-answer').textContent = g.revealed && g.question.answer ? `Ответ: ${g.question.answer}` : '';

  // медиа рендерим один раз на вопрос, чтобы не дёргать воспроизведение
  const mediaKey = `${g.question.themeIdx}:${g.question.qIdx}:${g.roundIndex}`;
  if (mediaKey !== lastMediaKey) {
    lastMediaKey = mediaKey;
    lastAnswerRendered = false;
    currentPlayers = renderMedia($('q-media'), g.question.media, { interactive: false });
    $('q-answer-media').replaceChildren();
  }
  if (g.revealed && g.question.answerMedia?.length && !lastAnswerRendered) {
    lastAnswerRendered = true;
    renderMedia($('q-answer-media'), g.question.answerMedia, { interactive: false });
  }

  const winner = S.players.find((p) => p.id === g.buzz.winnerId);
  const texts = {
    question: 'Внимание, вопрос!',
    buzz: g.buzz.open ? 'Кнопка открыта!' : '',
    answer: winner ? `Отвечает: ${winner.nick}` : '',
    final: S.special?.stage === 'answer' ? 'Финал: пишем ответы!' : '',
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
