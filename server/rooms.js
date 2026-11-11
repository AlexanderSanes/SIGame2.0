import crypto from 'node:crypto';
import { config } from '../config.js';
import { saveSnapshot, deleteSnapshot, loadSnapshots } from './db.js';

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
      phase: 'lobby',
      players: new Map(),
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
      connected: p.connected,
    }));
  }

  buildState(room) {
    return {
      roomId: room.id,
      phase: room.phase,
      players: this.publicPlayers(room),
    };
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
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      players: [...room.players.values()].map((p) => ({
        id: p.id,
        sessionToken: p.sessionToken,
        nick: p.nick,
        avatarUrl: p.avatarUrl,
        joinedAt: p.joinedAt,
      })),
    };
  }

  _deserialize(data) {
    const room = {
      id: data.id,
      hostToken: data.hostToken,
      phase: data.phase,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      players: new Map(),
    };
    for (const p of data.players) {
      room.players.set(p.id, { ...p, connected: false, socketId: null });
    }
    return room;
  }
}
