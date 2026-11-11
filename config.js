import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT) || 3000,
  rootDir: root,
  dataDir: path.join(root, 'data'),
  avatarsDir: path.join(root, 'data', 'avatars'),
  clientDir: path.join(root, 'client'),
  maxAvatarBytes: 2 * 1024 * 1024,
  roomCodeLength: 5,
};
