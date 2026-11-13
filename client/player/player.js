import { socket, call, onReconnect } from '/shared/socket.js';
import { h, toast, avatarEl, vibrate } from '/shared/ui.js';
import { renderMedia, preloadMedia } from '/shared/media.js';
import { playSound, muteButton } from '/shared/sounds.js';

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
let lastTick = null;          // последняя прозвучавшая секунда тиканья
let lastMediaKey = null;      // какой вопрос уже отрендерен в #q-media
let lastAnswerRendered = false; // картинка ответа уже показана

// Локальное состояние, обновляемое событиями сервера
const S = {
  phase: 'lobby',
  players: [],
  settings: null,
  game: null,
  special: null, // { kind:'auction'|'final', ... }
};

const REACTION_EMOJIS = ['👍', '😂', '😮', '👏', '🔥'];

// --- реакции ---
const reactionBar = $('reaction-bar');
for (const emoji of REACTION_EMOJIS) {
  const btn = h('button', { class: 'reaction-btn' }, emoji);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    setTimeout(() => { btn.disabled = false; }, 1500);
    const res = await call('reaction:send', { emoji });
    if (res?.ok === false && res.retryAfterMs) toast('Не так быстро 🙂');
  });
  reactionBar.append(btn);
}

$('room-code').textContent = roomId || '???';
document.querySelector('h1').append(muteButton());

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
  if (p.phase === 'board') { S.game.question = null; S.special = null; }
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
    playSound('open');
  }
  render();
});

socket.on('buzz:winner', ({ playerId, nick }) => {
  ensureGame();
  S.game.buzz.winnerId = playerId;
  if (playerId === myId) {
    playSound('press');
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

socket.on('answer:reveal', ({ answer, answerMedia }) => {
  if (S.game?.question) {
    S.game.question.answer = answer;
    S.game.question.answerMedia = answerMedia || [];
  }
  render();
});

// вердикт ведущего — звук и вибрация, если это про меня
socket.on('answer:verdict', ({ playerId, correct }) => {
  playSound(correct ? 'correct' : 'wrong');
  if (playerId === myId) vibrate(correct ? [50, 50, 200] : [200]);
});

// ---------- особые механики ----------
socket.on('cat:pending', () => {
  playSound('special');
  ensureGame();
  S.game.question = null; // до назначения прошлый вопрос не висит на экране
  toast('Кот в мешке! 🐈');
});

socket.on('auction:start', ({ minBet }) => {
  playSound('special');
  ensureGame();
  S.game.question = null;
  S.special = { kind: 'auction', minBet, myBet: null, betCount: 0, playersCount: 0 };
});
socket.on('auction:state', ({ betCount, playersCount }) => {
  if (S.special?.kind === 'auction') Object.assign(S.special, { betCount, playersCount });
  renderSpecial();
});
socket.on('auction:result', () => {
  if (S.special?.kind === 'auction') S.special.closed = true;
});

socket.on('final:start', () => {
  playSound('special');
  S.special = { kind: 'final', stage: 'stake', stakedIds: [], answeredIds: [], eligibleIds: [], myStake: null, myAnswer: null };
});
socket.on('final:state', (p) => {
  if (S.special?.kind === 'final') Object.assign(S.special, p);
  renderSpecial();
});
socket.on('final:results', ({ entries }) => {
  const mine = entries.find((e) => e.playerId === myId);
  if (mine) toast(mine.verdict ? `Финал: верно! +${mine.bet}` : `Финал: неверно −${mine.bet}`, mine.verdict ? 'success' : 'error');
});

socket.on('round:media', ({ urls }) => preloadMedia(urls));

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
  preloadMedia(state.roundMedia);
  render();
}

function render() {
  joinForm.hidden = true;
  gone.hidden = true;
  lobby.hidden = S.phase !== 'lobby';
  overEl.hidden = S.phase !== 'game_over';
  gameEl.hidden = S.phase === 'lobby' || S.phase === 'game_over';
  reactionBar.hidden = gameEl.hidden || isSpectator();

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

  // медиа приходит только если ведущий включил показ вопроса игрокам
  const mediaKey = g.question ? `${g.question.themeIdx}:${g.question.qIdx}:${g.roundIndex}` : null;
  if (mediaKey !== lastMediaKey) {
    lastMediaKey = mediaKey;
    lastAnswerRendered = false;
    $('q-media').replaceChildren();
    $('q-answer-media').replaceChildren();
    if (g.question?.media?.length) {
      renderMedia($('q-media'), g.question.media, { interactive: false });
    }
  }
  if (g.revealed && g.question?.answerMedia?.length && !lastAnswerRendered) {
    lastAnswerRendered = true;
    renderMedia($('q-answer-media'), g.question.answerMedia, { interactive: false });
  }

  const winner = S.players.find((p) => p.id === g.buzz.winnerId);
  const texts = {
    question: 'Идёт вопрос… жди сигнала ведущего',
    cat: 'Кот в мешке! 🐈 Ведущий выбирает, кому достанется вопрос',
    auction: 'Аукцион! Сделай свою ставку',
    final: S.special?.stage === 'stake' ? 'Финальный раунд! Сделай ставку'
      : S.special?.stage === 'answer' ? 'Пиши ответ — 30 секунд!'
      : 'Ведущий проверяет ответы…',
    buzz: g.buzz.open ? 'Жми кнопку!' : 'Приём ответов…',
    answer: winner ? (winner.id === myId ? 'Ты отвечаешь!' : `Отвечает: ${winner.nick}`) : '',
    reveal: 'Вопрос закрыт',
  };
  $('status-text').textContent = g.paused ? 'Пауза' : texts[S.phase] || '';
  renderSpecial();

  if (g.paused) {
    stopCountdown();
    $('countdown').textContent = '⏸';
  } else if (g.deadlineTs && ['buzz', 'answer', 'final'].includes(S.phase)) {
    startCountdown(g.deadlineTs);
  } else {
    stopCountdown();
    $('countdown').textContent = '';
  }
}

// Панели особых механик: ставки аукциона, ставка и ответ финала
function renderSpecial() {
  const box = $('special');
  box.replaceChildren();
  const sp = S.special;
  const g = S.game;
  if (!sp || !g || isSpectator()) return;

  if (S.phase === 'auction' && sp.kind === 'auction') {
    const me = S.players.find((p) => p.id === myId);
    const min = sp.minBet;
    const max = Math.max(me?.score ?? 0, min);
    if (sp.myBet != null) {
      box.append(h('p', { class: 'center' }, `Ставка принята: ${sp.myBet}`),
        h('p', { class: 'muted center' }, `Ставок: ${sp.betCount}/${sp.playersCount}`));
      return;
    }
    const input = h('input', { type: 'number', min: String(min), max: String(max), value: String(min) });
    box.append(
      h('p', { class: 'muted center' }, `Ставка от ${min} до ${max}`),
      h('div', { class: 'q-row' }, input,
        h('button', { onclick: async () => {
          const res = await call('auction:bet', { amount: Number(input.value) });
          if (res?.ok) { sp.myBet = Number(input.value); renderSpecial(); }
          else toast(res?.error || 'Ставка не принята', 'error');
        } }, 'Поставить')),
    );
    return;
  }

  if (S.phase === 'final' && sp.kind === 'final') {
    const me = S.players.find((p) => p.id === myId);
    if (sp.stage === 'stake') {
      if (!sp.eligibleIds.includes(myId)) {
        box.append(h('p', { class: 'muted center' }, 'Финал для игроков с положительным счётом'));
        return;
      }
      if (sp.myStake != null) {
        box.append(h('p', { class: 'center' }, `Ставка принята: ${sp.myStake}`));
        return;
      }
      const input = h('input', { type: 'number', min: '0', max: String(me?.score ?? 0), value: '0' });
      box.append(
        h('p', { class: 'muted center' }, `Твоя ставка: от 0 до ${me?.score ?? 0}`),
        h('div', { class: 'q-row' }, input,
          h('button', { onclick: async () => {
            const res = await call('final:stake', { amount: Number(input.value) });
            if (res?.ok) { sp.myStake = Number(input.value); renderSpecial(); }
            else toast(res?.error || 'Ставка не принята', 'error');
          } }, 'Поставить')),
      );
      return;
    }
    if (sp.stage === 'answer') {
      if (sp.myStake == null) {
        box.append(h('p', { class: 'muted center' }, 'Ты не делал ставку — наблюдай'));
        return;
      }
      if (sp.myAnswer != null) {
        box.append(h('p', { class: 'center' }, 'Ответ отправлен ✔'));
        return;
      }
      const input = h('input', { type: 'text', maxlength: '500', placeholder: 'Твой ответ…' });
      box.append(h('div', { class: 'q-row' }, input,
        h('button', { onclick: async () => {
          const res = await call('final:answer', { text: input.value });
          if (res?.ok) { sp.myAnswer = input.value; renderSpecial(); }
          else toast(res?.error || 'Ответ не принят', 'error');
        } }, 'Отправить')));
    }
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
  lastTick = null;
  const tick = () => {
    const left = Math.max(0, Math.ceil((deadlineTs - Date.now()) / 1000));
    $('countdown').textContent = left > 0 ? String(left) : '';
    if (left > 0 && left <= 5 && left !== lastTick) {
      lastTick = left;
      playSound('tick');
    }
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
