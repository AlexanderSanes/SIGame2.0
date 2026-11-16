import { socket, call, onReconnect } from '/shared/socket.js';
import { h, toast, avatarEl, copyText } from '/shared/ui.js';
import { renderMedia, preloadMedia } from '/shared/media.js';
import { playSound, muteButton } from '/shared/sounds.js';
import { roomJoinUrl, loadJoinQr } from '/shared/room-access.js';

const roomId = new URLSearchParams(location.search).get('room')?.toUpperCase();
const hostToken = roomId && localStorage.getItem(`sigame:host:${roomId}`);

const $ = (id) => document.getElementById(id);
const panel = $('panel');
const noAccess = $('no-access');
const playerList = $('player-list');
const playersCount = $('players-count');
const emptyHint = $('empty-hint');

let countdownTimer = null;
let lastTick = null;
let judgePending = false;
let lastMediaKey = null;      // какой вопрос уже отрендерен в #q-media
let lastAnswerRendered = false; // картинка ответа уже показана

const S = {
  phase: 'lobby',
  players: [],
  settings: null,
  game: null,
  log: [],
  special: null,   // { kind:'cat'|'auction'|'final', ... }
  finalAnswers: null, // entries от final:answers
};
document.querySelector('h1').append(muteButton());

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
  $('open-screen').href = `/room/${encodeURIComponent(roomId)}/screen`;
  const joinUrl = await roomJoinUrl(roomId);
  $('join-link').textContent = joinUrl;
  $('join-link').href = joinUrl;
  $('copy-link').onclick = async () => {
    const ok = await copyText(joinUrl);
    toast(ok ? 'Ссылка скопирована' : 'Не удалось скопировать — скопируйте вручную', ok ? 'info' : 'error');
  };
  try {
    await loadJoinQr($('qr'), joinUrl);
  } catch {
    toast('Не удалось сгенерировать QR-код', 'error');
  }
}

// ---------- Настройки и старт ----------
function fillSettings(s) {
  $('set-picker').value = s.picker;
  $('set-answer-time').value = s.unlimitedAnswerTime ? 0 : s.answerTimeSec;
  $('set-buzz-timeout').value = s.buzzTimeoutSec;
  $('set-show-question').checked = s.showQuestionToPlayers;
  $('set-false-start').checked = Boolean(s.falseStart);
}

async function saveSettings({ notify = true } = {}) {
  try {
    const res = await call('settings:update', {
      picker: $('set-picker').value,
      answerTimeSec: Number($('set-answer-time').value),
      buzzTimeoutSec: Number($('set-buzz-timeout').value),
      showQuestionToPlayers: $('set-show-question').checked,
      falseStart: $('set-false-start').checked,
    });
    S.settings = res.settings;
    if (notify) toast('Настройки сохранены');
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}

$('save-settings').addEventListener('click', () => saveSettings());

$('start-btn').addEventListener('click', async () => {
  try {
    if (!await saveSettings({ notify: false })) return;
    await call('game:start', {});
  } catch (e) {
    toast(e.message, 'error');
  }
});

// ---------- Загрузка медиафайлов ----------
const uploadedMedia = []; // { url, kind, bytes }
$('upload-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const kind = file.type.split('/')[0];
  if (!['image', 'audio', 'video'].includes(kind)) {
    toast('Поддерживаются только изображения, аудио и видео', 'error');
    return;
  }
  uploadFile(file, kind);
});

function uploadFile(file, kind) {
  const progress = $('upload-progress');
  const bar = $('upload-progress-bar');
  progress.hidden = false;
  bar.style.width = '0%';
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/upload?room=${roomId}&kind=${kind}`);
  xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
  xhr.setRequestHeader('x-host-token', hostToken);
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) bar.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
  };
  xhr.onload = () => {
    progress.hidden = true;
    let res = {};
    try { res = JSON.parse(xhr.responseText); } catch { /* не-json */ }
    if (xhr.status === 200 && res.ok) {
      uploadedMedia.push({ url: res.url, kind, bytes: res.bytes });
      renderMediaList();
      toast('Файл загружен');
    } else {
      toast(res.error || `Ошибка загрузки (${xhr.status})`, 'error');
    }
  };
  xhr.onerror = () => {
    progress.hidden = true;
    toast('Ошибка сети при загрузке', 'error');
  };
  xhr.send(file);
}

function renderMediaList() {
  const list = $('media-list');
  list.replaceChildren();
  for (const item of uploadedMedia) {
    const preview = item.kind === 'image'
      ? h('img', { class: 'media-thumb', src: item.url, alt: '' })
      : h('span', { class: 'media-kind' }, item.kind === 'audio' ? '♪' : '▶');
    list.append(
      h('li', { class: 'media-item' },
        preview,
        h('code', { class: 'media-url' }, item.url),
        h('button', {
          class: 'mini secondary',
          onclick: async () => {
            const ok = await copyText(item.url);
            toast(ok ? 'Ссылка скопирована' : 'Скопируйте вручную', ok ? 'info' : 'error');
          },
        }, 'Копировать'),
      ),
    );
  }
}

// ---------- Кнопки управления ----------
const act = (event, payload = {}) => () => call(event, payload).catch((e) => toast(e.message, 'error'));
$('buzz-open-btn').addEventListener('click', act('buzz:open'));
async function judgeAnswer(correct) {
  if (judgePending || S.phase !== 'answer') return;
  const g = S.game;
  const payload = { correct, playerId: g.buzz.winnerId, questionId: g.questionId, answerAttemptId: g.answerAttemptId };
  judgePending = true;
  renderControls();
  try { await call('answer:judge', payload); }
  catch (e) { toast(e.message, 'error'); }
  finally { judgePending = false; renderControls(); }
}
$('correct-btn').addEventListener('click', () => judgeAnswer(true));
$('wrong-btn').addEventListener('click', () => judgeAnswer(false));
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
  if(typeof entry.canUndo === 'boolean')S.canUndo=entry.canUndo;
  S.undoLabel=entry.undoLabel || '';
  $('undo-btn').disabled=!S.canUndo;
  $('undo-btn').textContent=S.undoLabel?`Отменить: ${S.undoLabel}`:'Отменить начисление';
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
  S.game.questionId = p.questionId;
  S.game.answerAttemptId = p.answerAttemptId;
  S.game.pickerId = p.pickerId;
  S.game.buzz.winnerId = p.winnerId;
  S.game.revealed = p.revealed;
  S.game.paused = p.paused;
  S.game.deadlineTs = p.deadlineTs;
  if (p.phase === 'board') { S.special = null; S.finalAnswers = null; }
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
  // новый вопрос — кнопка сброшена, никаких остатков от прошлого вопроса
  S.game.buzz = { open: false, winnerId: null, lockedIds: [] };
  S.game.paused = false;
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

socket.on('answer:reveal', ({ answer, answerMedia }) => {
  if (S.game?.question) {
    S.game.question.answer = answer;
    S.game.question.answerMedia = answerMedia || [];
  }
  if (S.game) S.game.revealed = true;
  render();
});

socket.on('round:media', ({ urls }) => preloadMedia(urls));

// ---------- особые механики ----------
socket.on('cat:pending', ({ basePrice }) => {
  playSound('special');
  S.special = { kind: 'cat', basePrice };
  render();
});
socket.on('auction:start', ({ minBet }) => {
  playSound('special');
  S.special = { kind: 'auction', minBet, betCount: 0, playersCount: 0 };
  render();
});
socket.on('auction:state', ({ betCount, playersCount }) => {
  if (S.special?.kind === 'auction') Object.assign(S.special, { betCount, playersCount });
  renderSpecial();
});
socket.on('auction:result', ({ bets }) => {
  if (S.special?.kind === 'auction') S.special.result = bets;
});
socket.on('final:start', ({ title }) => {
  playSound('special');
  S.special = { kind: 'final', title, stage: 'stake', stakedIds: [], answeredIds: [], eligibleIds: [] };
  S.finalAnswers = null;
  render();
});
socket.on('final:state', (p) => {
  if (S.special?.kind === 'final') Object.assign(S.special, p);
  renderSpecial();
});
socket.on('final:answers', ({ answer, entries }) => {
  S.finalAnswers = { answer, entries };
  renderSpecial();
});
socket.on('final:results', () => {
  toast('Финал: все вердикты вынесены — можно завершать игру');
});

// вердикт — звук (верно/неверно)
socket.on('answer:verdict', ({ correct }) => playSound(correct ? 'correct' : 'wrong'));

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
  $('pack-title').textContent = state.packTitle ? `Пакет: ${state.packTitle}` : '';
  S.game = state.game;
  S.standings = state.standings;
  S.special = null;
  S.finalAnswers = null;
  if (state.phase === 'cat' && state.game?.cat) {
    S.special = { kind: 'cat', ...state.game.cat };
  } else if (state.phase === 'auction' && state.game?.auction) {
    S.special = { kind: 'auction', ...state.game.auction };
  } else if (state.phase === 'final' && state.game?.final) {
    S.special = { kind: 'final', ...state.game.final };
    if (state.game.final.entries) {
      S.finalAnswers = { answer: state.game.question?.answer ?? '', entries: state.game.final.entries };
    }
  }
  S.log = state.log || [];
  S.canUndo = state.canUndo;
  S.undoLabel = state.undoLabel;
  fillSettings(state.settings);
  preloadMedia(state.roundMedia);
  render();
  renderLog();
}

function render() {
  document.body.dataset.phase = S.phase;
  const inLobby = S.phase === 'lobby';
  const isOver = S.phase === 'game_over';
  $('media-card').hidden = !inLobby;
  $('settings-card').hidden = !inLobby;
  $('players-card').hidden = !inLobby;
  $('game-panel').hidden = inLobby || isOver;
  $('over').hidden = !isOver;

  if (inLobby) renderPlayers();
  if (!inLobby && !isOver) {
    renderScores();
    renderBoard();
    renderQuestion();
    renderSpecial();
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
  const boardSignature=JSON.stringify([g.board,g.pickerId,S.settings?.picker]);
  if(grid.dataset.signature===boardSignature)return;
  grid.dataset.signature=boardSignature;
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
  $('q-answer').textContent = g.question.answer
    ? `Ответ: ${g.question.answer}` : '';

  // медиа рендерим один раз на вопрос, чтобы не дёргать воспроизведение
  const mediaKey = `${g.question.themeIdx}:${g.question.qIdx}:${g.roundIndex}`;
  if (mediaKey !== lastMediaKey) {
    lastMediaKey = mediaKey;
    lastAnswerRendered = false;
    $('q-media').replaceChildren();
    $('q-answer-media').replaceChildren();
    if (g.question.media?.length) {
      renderMedia($('q-media'), g.question.media, {
        interactive: true,
        onControl: (action, position) => socket.emit('media:control', { action, position }),
      });
    }
  }
  if (g.revealed && g.question.answerMedia?.length && !lastAnswerRendered) {
    lastAnswerRendered = true;
    renderMedia($('q-answer-media'), g.question.answerMedia, { interactive: false });
  }

  const winner = S.players.find((p) => p.id === g.buzz.winnerId);
  const texts = {
    question: 'Читайте вопрос, затем разрешите ответы',
    cat: 'Кот в мешке — назначьте игрока и цену ↓',
    auction: 'Аукцион — ждём ставки ↓',
    final: 'Финальный раунд ↓',
    buzz: 'Приём ответов…',
    answer: winner ? `Отвечает: ${winner.nick}` : '',
    reveal: 'Вопрос сгорел / никто не ответил верно',
  };
  $('status-text').textContent = g.paused ? 'Пауза' : texts[S.phase] || '';

  if (g.paused) {
    stopCountdown();
    $('countdown').textContent = '⏸';
  } else if (g.deadlineTs && ['buzz', 'answer', 'final'].includes(S.phase)) {
    startCountdown(g.deadlineTs);
  } else {
    stopCountdown();
    $('countdown').textContent = S.phase === 'answer' && S.settings?.unlimitedAnswerTime ? '∞' : '';
  }
}

// Панель особых фаз: назначение кота, приём ставок аукциона, финал
function renderSpecial() {
  const card = $('special-card');
  card.replaceChildren();
  const sp = S.special;
  if (!sp || !['cat', 'auction', 'final'].includes(S.phase)) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  if (S.phase === 'cat' && sp.kind === 'cat') {
    const players = S.players.filter((p) => p.role !== 'spectator');
    const select = h('select', {}, ...players.map((p) => h('option', { value: p.id }, p.nick)));
    const price = h('input', { type: 'number', min: '1', step: '50', value: String(sp.basePrice) });
    card.append(
      h('h2', {}, '🐈 Кот в мешке!'),
      h('p', { class: 'muted' }, 'Выберите игрока и назначьте цену вопроса'),
      h('div', { class: 'q-row' }, select, price,
        h('button', { onclick: async () => {
          try {
            await call('cat:assign', { playerId: select.value, price: Number(price.value) });
          } catch (e) { toast(e.message, 'error'); }
        } }, 'Передать вопрос')),
    );
    return;
  }

  if (S.phase === 'auction' && sp.kind === 'auction') {
    card.append(
      h('h2', {}, '🔨 Аукцион'),
      h('p', { class: 'center' }, `Ставок: ${sp.betCount}/${sp.playersCount} (минимум ${sp.minBet})`),
      h('button', { onclick: () => call('auction:close', {}).catch((e) => toast(e.message, 'error')) },
        'Закрыть приём ставок'),
    );
    return;
  }

  if (S.phase === 'final' && sp.kind === 'final') {
    if (sp.stage === 'stake') {
      card.append(
        h('h2', {}, `★ Финал: ${sp.title}`),
        h('p', { class: 'center' }, sp.eligibleIds.length ? `Ставок: ${sp.stakedIds.length}/${sp.eligibleIds.length}` : 'Нет игроков с положительным счётом. Можно завершить игру.'),
        h('button', { onclick: () => call('final:go', {}).catch((e) => toast(e.message, 'error')) },
          'Открыть вопрос (30 сек на ответы)'),
      );
      return;
    }
    if (sp.stage === 'answer') {
      card.append(
        h('h2', {}, `★ Финал: ${sp.title}`),
        h('p', { class: 'center' }, `Ответов: ${sp.answeredIds.length}/${sp.stakedIds.length}`),
        h('button', { onclick: () => call('final:go', {}).catch((e) => toast(e.message, 'error')) },
          'Закрыть приём ответов'),
      );
      return;
    }
    if (sp.stage === 'judge') {
      card.append(h('h2', {}, `★ Финал: проверка ответов`));
      if (S.finalAnswers) {
        card.append(h('p', { class: 'muted' }, `Правильный ответ: ${S.finalAnswers.answer}`));
        for (const e of S.finalAnswers.entries) {
          card.append(h('div', { class: 'q-row final-entry' },
            h('span', { class: 'grow' }, `${e.nick} (ставка ${e.bet}): ${e.text ?? '— без ответа —'}`),
            e.verdict === null || e.verdict === undefined
              ? h('span', {},
                  h('button', { class: 'mini success', onclick: () => call('final:judge', { playerId: e.playerId, correct: true }).catch((er) => toast(er.message, 'error')) }, 'Верно'),
                  ' ',
                  h('button', { class: 'mini danger', onclick: () => call('final:judge', { playerId: e.playerId, correct: false }).catch((er) => toast(er.message, 'error')) }, 'Неверно'))
              : h('span', { class: e.verdict ? 'points' : 'points negative' }, e.verdict ? `+${e.bet}` : `−${e.bet}`),
          ));
        }
      } else {
        card.append(h('p', { class: 'muted' }, 'Загрузка ответов…'));
      }
    }
  }
}

function renderControls() {
  const g = S.game;
  $('undo-btn').disabled=!S.canUndo;
  $('undo-btn').textContent=S.undoLabel?`Отменить: ${S.undoLabel}`:'Отменить начисление';
  $('round-end-btn').hidden = !['board', 'question', 'cat', 'auction', 'buzz', 'answer', 'reveal'].includes(S.phase);
  $('buzz-open-btn').hidden = S.phase !== 'question';
  $('correct-btn').hidden = S.phase !== 'answer';
  $('correct-btn').disabled = judgePending;
  $('wrong-btn').disabled = judgePending;
  $('wrong-btn').hidden = S.phase !== 'answer';
  $('reveal-btn').hidden = S.phase !== 'reveal' || g?.revealed;
  $('close-question-btn').hidden = S.phase !== 'reveal' || !g?.revealed;
  $('skip-btn').hidden = !['question', 'cat', 'auction', 'buzz', 'answer', 'reveal'].includes(S.phase);
  $('pause-btn').hidden = !['buzz', 'answer'].includes(S.phase);
  $('pause-btn').textContent = g?.paused ? 'Продолжить' : 'Пауза';
}

// Список игроков с управлением счётом и ролями
function renderPlayersCtrl() {
  const list = $('players-ctrl');
  const signature = JSON.stringify([S.players,S.phase,S.game?.pickerId,S.game?.question?.price]);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  const drafts = new Map([...list.querySelectorAll('.adj-input')].map(e=>[e.closest('[data-player-id]')?.dataset.playerId,e.value]));
  list.replaceChildren();
  const price = S.game?.question?.price ?? 100;
  for (const [index,p] of S.players.entries()) {
    const isSpectator = p.role === 'spectator';
    const isPicker = S.game?.pickerId === p.id;

    const adjInput = h('input', {
      class: 'adj-input', type: 'number', placeholder: '±сумма', step: '50',
    });
    adjInput.value = drafts.get(p.id) || '';
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
      h('li', { 'data-player-id': p.id, class: `player-ctrl${p.connected ? '' : ' offline'}` },
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
  const duration = Math.max(1, deadlineTs - Date.now());
  lastTick = null;
  const tick = () => {
    const left = Math.max(0, Math.ceil((deadlineTs - Date.now()) / 1000));
    $('countdown').textContent = left > 0 ? String(left) : '';
    $('countdown').style.setProperty('--remaining',String(Math.max(0,(deadlineTs-Date.now())/duration)));
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

onReconnect(auth);

document.addEventListener('keydown', (e) => {
  if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.target.closest('input,textarea,select,[contenteditable]')) return;
  const id = {' ':'buzz-open-btn',v:'correct-btn',x:'wrong-btn',p:'pause-btn'}[e.key.toLowerCase()];
  const button = id && $(id);
  if (button && !button.hidden && !button.disabled) { e.preventDefault(); button.click(); }
});
$('export-log').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([S.log.map(e => `${new Date(e.ts).toISOString()} ${e.text}`).join('\n')],{type:'text/plain;charset=utf-8'}));
  const a=document.createElement('a'); a.href=url; a.download=`sigame-${roomId}.txt`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
});
