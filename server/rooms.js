import crypto from 'node:crypto';
import { config } from '../config.js';
import { saveSnapshot, deleteSnapshot, loadSnapshots } from './db.js';
import { TEST_PACK } from './testpack.js';

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

  createRoom() {
    let id;
    do {
      id = generateCode(config.roomCodeLength);
    } while (this.rooms.has(id));

    const room = {
      id,
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
    return this.rooms.get((roomId || '').toUpperCase());
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
  buildState(room, view = 'player') {
    return {
      roomId: room.id,
      phase: room.phase,
      settings: room.settings,
      players: this.publicPlayers(room),
      game: room.game ? this.publicGame(room, view) : null,
      log: room.log.slice(-50),
      canUndo: room.history.length > 0,
    };
  }

  publicGame(room, view) {
    const g = room.game;
    const round = TEST_PACK.rounds[g.roundIndex]; // undefined после game_over
    const state = {
      roundIndex: g.roundIndex,
      roundsTotal: TEST_PACK.rounds.length,
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
      const base = { themeIdx: g.question.themeIdx, qIdx: g.question.qIdx, price: g.question.price };
      const withText = { ...base, themeTitle: g.question.themeTitle, text: g.question.text };
      if (view === 'host') {
        state.question = { ...withText, answer: g.question.answer };
      } else if (view === 'board' || room.settings.showQuestionToPlayers) {
        state.question = withText;
      } else {
        state.question = base;
      }
    }
    return state;
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
        saveSnapshot(room.id, this._serialize(room));
      }
    }, 250);
    this._snapshotTimers.set(room.id, timer);
  }

  _serialize(room) {
    return {
      id: room.id,
      hostToken: room.hostToken,
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
      game: room.game && {
        roundIndex: room.game.roundIndex,
        pickerId: room.game.pickerId,
        used: room.game.used,
        question: room.game.question,
        revealed: room.game.revealed,
        lockedIds: [...room.game.buzz.lockedIds],
      },
    };
  }

  _deserialize(data) {
    const room = {
      id: data.id,
      hostToken: data.hostToken,
      hostSocketId: null,
      // после рестарта сервера транзиентные фазы откатываем к показу вопроса
      phase: ['buzz', 'answer'].includes(data.phase) ? 'question' : data.phase,
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
      room.game = {
        roundIndex: data.game.roundIndex,
        pickerId: data.game.pickerId,
        used: data.game.used,
        question: data.game.question,
        revealed: data.game.revealed,
        paused: false,
        deadlineTs: null,
        buzz: { open: false, winnerId: null, lockedIds: new Set(data.game.lockedIds || []) },
      };
    }
    return room;
  }
}
