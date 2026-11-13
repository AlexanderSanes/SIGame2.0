import crypto from 'node:crypto';
import { config } from '../config.js';
import { saveSnapshot, deleteSnapshot, loadSnapshots } from './db.js';
import { getPack, getDefaultPack } from './packs.js';

// Без похожих символов: 0, O, 1, I, L исключены
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateCode(length) {
  let code = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

const DEFAULT_SETTINGS = {
  picker: 'player',            // 'player' — выбирает игрок с правом выбора, 'host' — только ведущий
  answerTimeSec: 7,            // таймер на ответ после нажатия
  buzzTimeoutSec: 15,          // сколько кнопка открыта, потом вопрос сгорает
  showQuestionToPlayers: false, // показывать ли текст вопроса на телефонах игроков
  falseStart: false            // нажатие до «Разрешить ответы» блокирует игрока на вопрос
};

const HISTORY_LIMIT = 10;      // глубина undo
const LOG_LIMIT = 100;         // журнал действий ведущего

export class RoomManager {
  constructor() {
    /** @type {Map<string, object>} */
    this.rooms = new Map();
    this._snapshotTimers = new Map();
  }

  restore() {
    for (const data of loadSnapshots()) {
      const room = this._deserialize(data);
      this.rooms.set(room.id, room);
    }
    if (this.rooms.size > 0) {
      console.log(`[rooms] восстановлено комнат: ${this.rooms.size}`);
    }
  }

  createRoom(packId = null) {
    let id;
    do {
      id = generateCode(config.roomCodeLength);
    } while (this.rooms.has(id));

    // снапшот пакета копируется в комнату: правки пакета после создания игру не затрагивают
    const packData = getPack(packId) || getDefaultPack();
    const pack = { id: packData.id, title: packData.title, rounds: structuredClone(packData.rounds), final: structuredClone(packData.final ?? null) };

    const room = {
      id,
      pack,
      hostToken: crypto.randomUUID(),
      hostSocketId: null,
      phase: 'lobby',
      settings: { ...DEFAULT_SETTINGS },
      players: new Map(),
      game: null,
      history: [],
      log: [],
      _timers: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.rooms.set(id, room);
    this.scheduleSnapshot(room);
    return room;
  }

  get(roomId) {
    return typeof roomId === 'string' ? this.rooms.get(roomId.toUpperCase()) : undefined;
  }

  addPlayer(room, { nick, avatarUrl }) {
    const player = {
      id: crypto.randomUUID(),
      sessionToken: crypto.randomUUID(),
      nick,
      avatarUrl: avatarUrl || null,
      score: 0,
      role: 'player', // 'player' | 'spectator'
      connected: true,
      socketId: null,
      joinedAt: Date.now(),
    };
    room.players.set(player.id, player);
    this.touch(room);
    return player;
  }

  removePlayer(room, playerId) {
    const removed = room.players.delete(playerId);
    if (removed) this.touch(room);
    return removed;
  }

  isNickTaken(room, nick) {
    const normalized = nick.trim().toLowerCase();
    for (const p of room.players.values()) {
      if (p.nick.trim().toLowerCase() === normalized) return true;
    }
    return false;
  }

  findPlayerByToken(room, playerId, sessionToken) {
    const player = room.players.get(playerId);
    if (!player || player.sessionToken !== sessionToken) return null;
    return player;
  }

  deleteRoom(room) {
    clearTimeout(this._snapshotTimers.get(room.id));
    this._snapshotTimers.delete(room.id);
    for (const timer of Object.values(room._timers)) clearTimeout(timer);
    this.rooms.delete(room.id);
    deleteSnapshot(room.id);
  }

  publicPlayers(room) {
    return [...room.players.values()].map((p) => ({
      id: p.id,
      nick: p.nick,
      avatarUrl: p.avatarUrl,
      score: p.score,
      role: p.role || 'player',
      connected: p.connected,
    }));
  }

  pushHistory(room, entry) {
    room.history.push(entry);
    if (room.history.length > HISTORY_LIMIT) room.history.shift();
  }

  addLog(room, text) {
    const entry = { ts: Date.now(), text };
    room.log.push(entry);
    if (room.log.length > LOG_LIMIT) room.log.shift();
    this.touch(room);
    return entry;
  }

  // view: 'host' (всё + ответ), 'board' (текст вопроса, без ответа), 'player' (зависит от настройки)
  buildState(room, view = 'player', playerId = null) {
    const state = {
      roomId: room.id,
      phase: room.phase,
      packTitle: room.pack.title,
      settings: room.settings,
      players: this.publicPlayers(room),
      game: room.game ? this.publicGame(room, view) : null,
      log: room.log.slice(-50),
      canUndo: room.history.length > 0,
      standings: room.phase === 'game_over' ? this.standings(room) : null,
      // предзагрузка: игроку имеет смысл отдавать, только если он увидит вопросы
      roundMedia: (view !== 'player' || room.settings.showQuestionToPlayers)
        ? this.roundMedia(room) : [],
    };
    if (view === 'player' && playerId && state.game) {
      if (state.game.final) {
        state.game.final.myStake = room.game.final.bets[playerId] ?? null;
        state.game.final.myAnswer = room.game.final.answers[playerId] ?? null;
      }
      if (state.game.auction) state.game.auction.myBet = room.game.auction.bets[playerId]?.amount ?? null;
    }
    return state;
  }

  standings(room) {
    let prev = null; let place = 0;
    return this.publicPlayers(room).filter((p) => p.role !== 'spectator')
      .sort((a, b) => b.score - a.score).map((p, i) => {
        if (p.score !== prev) place = i + 1;
        prev = p.score;
        return { ...p, place };
      });
  }

  publicGame(room, view) {
    const g = room.game;
    const round = room.pack.rounds[g.roundIndex]; // undefined после game_over
    const state = {
      roundIndex: g.roundIndex,
      roundsTotal: room.pack.rounds.length,
      roundTitle: round?.title ?? null,
      pickerId: g.pickerId,
      revealed: g.revealed,
      paused: Boolean(g.paused),
      deadlineTs: g.deadlineTs,
      buzz: {
        open: g.buzz.open,
        winnerId: g.buzz.winnerId,
        lockedIds: [...g.buzz.lockedIds],
      },
      board: round ? {
        themes: round.themes.map((theme, t) => ({
          title: theme.title,
          questions: theme.questions.map((q, qi) => ({
            price: q.price,
            used: g.used[g.roundIndex][t][qi],
          })),
        })),
      } : null,
      question: null,
    };
    if (g.question) {
      const base = { themeIdx: g.question.themeIdx, qIdx: g.question.qIdx, price: g.question.price, type: g.question.type || 'normal' };
      const media = g.question.media || [];
      const withText = { ...base, themeTitle: g.question.themeTitle, text: g.question.text, media };
      if (view === 'host') {
        state.question = { ...withText, answer: g.question.answer, answerMedia: g.question.answerMedia || [] };
      } else if (!['cat', 'auction'].includes(room.phase)
          && !(room.phase === 'final' && g.final?.stage === 'stake')
          && (view === 'board' || room.settings.showQuestionToPlayers || room.phase === 'final')) {
        state.question = withText;
      } else {
        state.question = ['cat', 'auction'].includes(room.phase) || (room.phase === 'final' && g.final?.stage === 'stake') ? null : base;
      }
    }
    if (g.revealed && state.question) {
      state.question.answer = g.question.answer;
      state.question.answerMedia = g.question.answerMedia || [];
    }
    if (room.phase === 'cat') state.cat = { basePrice: g.question?.price };
    if (room.phase === 'auction' && g.auction) {
      state.auction = { minBet: g.auction.minBet, betCount: Object.keys(g.auction.bets).length,
        playersCount: [...room.players.values()].filter((p) => p.role !== 'spectator').length };
    }
    if (room.phase === 'final' && g.final) {
      state.final = {
        title: room.pack.final?.title ?? g.question?.themeTitle ?? '',
        stage: g.final.stage,
        eligibleIds: g.final.eligibleIds || [...room.players.values()].filter((p) => p.role !== 'spectator' && p.score > 0).map((p) => p.id),
        stakedIds: Object.keys(g.final.bets),
        answeredIds: Object.keys(g.final.answers),
      };
      if (view === 'host' && g.final.stage === 'judge') {
        state.final.entries = Object.entries(g.final.bets).map(([pid, bet]) => ({
          playerId: pid,
          nick: room.players.get(pid)?.nick ?? '?',
          bet,
          text: g.final.answers[pid] ?? null,
          verdict: g.final.verdicts[pid] ?? null,
        }));
      }
    }
    return state;
  }

  // Все локальные (не-youtube) медиа текущего раунда — для предзагрузки на клиентах
  roundMedia(room) {
    const g = room.game;
    if (!g) return [];
    const round = room.pack.rounds[g.roundIndex];
    const urls = new Set();
    if (round) {
      for (const theme of round.themes) {
        for (const q of theme.questions) {
          for (const m of [...(q.media || []), ...(q.answerMedia || [])]) {
            if (m.type !== 'youtube' && m.src) urls.add(m.src);
          }
        }
      }
    }
    for (const m of room.pack.final?.media || []) {
      if (m.type !== 'youtube' && m.src) urls.add(m.src);
    }
    return [...urls];
  }

  touch(room) {
    room.updatedAt = Date.now();
    this.scheduleSnapshot(room);
  }

  scheduleSnapshot(room) {
    if (this._snapshotTimers.has(room.id)) return;
    const timer = setTimeout(() => {
      this._snapshotTimers.delete(room.id);
      if (this.rooms.has(room.id)) {
        try { saveSnapshot(room.id, this._serialize(room)); }
        catch (error) { console.error('[snapshot]', error); }
      }
    }, 250);
    this._snapshotTimers.set(room.id, timer);
  }

  flushAll() {
    for (const room of this.rooms.values()) {
      clearTimeout(this._snapshotTimers.get(room.id));
      this._snapshotTimers.delete(room.id);
      saveSnapshot(room.id, this._serialize(room));
    }
  }

  _serialize(room) {
    return {
      id: room.id,
      hostToken: room.hostToken,
      pack: room.pack,
      phase: room.phase,
      settings: room.settings,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      players: [...room.players.values()].map((p) => ({
        id: p.id,
        sessionToken: p.sessionToken,
        nick: p.nick,
        avatarUrl: p.avatarUrl,
        score: p.score,
        role: p.role || 'player',
        joinedAt: p.joinedAt,
      })),
      history: room.history,
      log: room.log.slice(-50),
      snapshotVersion: 2,
      game: room.game && {
        ...room.game,
        remainingMs: room.game.deadlineTs == null ? null : Math.max(0, room.game.deadlineTs - Date.now()),
        buzz: { ...room.game.buzz, lockedIds: [...room.game.buzz.lockedIds] },
      },
    };
  }

  _deserialize(data) {
    const room = {
      id: data.id,
      hostToken: data.hostToken,
      // старые снапшоты без pack — берём пакет по умолчанию
      pack: data.pack?.rounds ? { ...data.pack, final: data.pack.final ?? null } : (() => { const p = getDefaultPack(); return { id: p.id, title: p.title, rounds: p.rounds, final: p.final ?? null }; })(),
      hostSocketId: null,
      // Снимки v2 сохраняют фазы; старые мигрируют к безопасной точке.
      // после рестарта сервера транзиентные фазы откатываем:
      // buzz/answer → показ вопроса, cat/auction → обратно к полю, final → сбор ставок заново
      phase: data.snapshotVersion === 2 ? data.phase : ['buzz', 'answer'].includes(data.phase) ? 'question'
        : ['cat', 'auction'].includes(data.phase) ? 'board'
        : data.phase,
      settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
      players: new Map(),
      game: null,
      history: Array.isArray(data.history) ? data.history : [],
      log: Array.isArray(data.log) ? data.log : [],
      _timers: {},
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
    for (const p of data.players) {
      room.players.set(p.id, { role: 'player', ...p, connected: false, socketId: null });
    }
    if (data.game) {
      room.game = data.snapshotVersion === 2 ? {
        ...data.game,
        deadlineTs: data.game.remainingMs == null ? null : Date.now() + data.game.remainingMs,
        buzz: { ...data.game.buzz, lockedIds: new Set(data.game.buzz?.lockedIds || []) },
      } : {
        roundIndex: data.game.roundIndex,
        pickerId: data.game.pickerId,
        used: data.game.used,
        question: ['cat', 'auction'].includes(data.phase) ? null : data.game.question,
        revealed: data.game.revealed,
        paused: false,
        deadlineTs: null,
        buzz: { open: false, winnerId: null, lockedIds: new Set(data.game.lockedIds || []) },
        finalPlayed: data.game.finalPlayed || false,
      };
      if (data.phase === 'final' && data.snapshotVersion !== 2) {
        room.game.final = { stage: 'stake', bets: {}, answers: {}, verdicts: {} };
      }
    }
    return room;
  }
}
