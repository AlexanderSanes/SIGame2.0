import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

fs.mkdirSync(config.dataDir, { recursive: true });

const db = new Database(path.join(config.dataDir, 'sigame.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS room_snapshots (
    room_id   TEXT PRIMARY KEY,
    data      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS packages (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

export { db };

const stmtSave = db.prepare(`
  INSERT INTO room_snapshots (room_id, data, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(room_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);
const stmtDelete = db.prepare('DELETE FROM room_snapshots WHERE room_id = ?');
const stmtLoadAll = db.prepare('SELECT room_id, data FROM room_snapshots');

export function saveSnapshot(roomId, data) {
  stmtSave.run(roomId, JSON.stringify(data), Date.now());
}

export function deleteSnapshot(roomId) {
  stmtDelete.run(roomId);
}

export function loadSnapshots() {
  return stmtLoadAll.all().map((row) => JSON.parse(row.data));
}
