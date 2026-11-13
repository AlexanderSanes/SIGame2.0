import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

const positiveMs = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));

export const config = {
  port: Number(process.env.PORT) || 3000,
  rootDir: root,
  host: process.env.HOST || '0.0.0.0',
  publicUrl: process.env.PUBLIC_URL?.replace(/\/$/, '') || '',
  snapshotIntervalMs: positiveMs('SNAPSHOT_INTERVAL_MS', 10000),
  cleanupIntervalMs: positiveMs('CLEANUP_INTERVAL_MS', 60000),
  roomIdleMs: positiveMs('ROOM_IDLE_MS', 2 * 60 * 60 * 1000),
  mediaGraceMs: positiveMs('MEDIA_GRACE_MS', 24 * 60 * 60 * 1000),
  disconnectGraceMs: 10000,
  dataDir,
  avatarsDir: path.join(dataDir, 'avatars'),
  uploadsDir: path.join(dataDir, 'uploads'),
  clientDir: path.join(root, 'client'),
  maxAvatarBytes: 2 * 1024 * 1024,
  uploadLimits: {
    image: 5 * 1024 * 1024,
    audio: 10 * 1024 * 1024,
    video: 100 * 1024 * 1024,
  },
  roomCodeLength: 5,
};
