import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { listPacks, getPack } from './packs.js';

function references(value, used) {
  if (typeof value === 'string' && /^\/(uploads|avatars)\/[a-zA-Z0-9_.-]+$/.test(value)) used.add(value);
  else if (Array.isArray(value)) for (const v of value) references(v, used);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) references(v, used);
}
export function cleanup(io, rooms, now = Date.now()) {
  let closed = 0; let removed = 0;
  for (const room of rooms.rooms.values()) {
    const connected = io.sockets.adapter.rooms.get(room.id)?.size || 0;
    if (!connected && now - room.updatedAt >= config.roomIdleMs) { rooms.deleteRoom(room); closed++; }
  }
  // Сначала собираем все ссылки; ошибка чтения БД отменяет удаление файлов.
  const used = new Set();
  for (const pack of listPacks()) references(getPack(pack.id), used);
  for (const room of rooms.rooms.values()) references(rooms._serialize(room), used);
  for (const [dir, prefix] of [[config.uploadsDir, '/uploads/'], [config.avatarsDir, '/avatars/']]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || used.has(prefix + entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (now - fs.statSync(file).mtimeMs >= config.mediaGraceMs) { fs.unlinkSync(file); removed++; }
    }
  }
  return { closed, removed };
}
export function maintenance(io, rooms) {
  const snapshot = setInterval(() => {
    try { const start=performance.now();rooms.flushAll();const durationMs=Math.round(performance.now()-start);if(durationMs>100)console.warn(JSON.stringify({event:'slow_snapshot',durationMs,rooms:rooms.rooms.size})); } catch (e) { console.error('[snapshot]', e); }
  }, config.snapshotIntervalMs);
  const sweep = setInterval(() => {
    try { const result=cleanup(io, rooms);if(result.closed||result.removed)console.info(JSON.stringify({event:'cleanup',...result})); } catch (e) { console.error('[cleanup]', e); }
  }, config.cleanupIntervalMs);
  snapshot.unref(); sweep.unref();
  return () => { clearInterval(snapshot); clearInterval(sweep); };
}
