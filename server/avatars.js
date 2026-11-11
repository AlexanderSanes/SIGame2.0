import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

fs.mkdirSync(config.avatarsDir, { recursive: true });

const AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,(.+)$/s;
const EXT_BY_MIME = { jpeg: '.jpg', png: '.png', webp: '.webp' };

export const NICK_RE = /^[\p{L}\p{N} _\-.!?]{2,20}$/u;

export function validateNick(nick) {
  if (typeof nick !== 'string') return 'Ник должен быть строкой';
  const trimmed = nick.trim();
  if (!NICK_RE.test(trimmed)) return 'Ник: 2–20 символов (буквы, цифры, пробел, - _ . ! ?)';
  return null;
}

// data URL -> { fileName, avatarUrl } | throws Error с текстом для клиента
export function saveAvatar(playerId, dataUrl) {
  const match = AVATAR_RE.exec(dataUrl || '');
  if (!match) throw new Error('Аватар: только jpg, png или webp');
  const [, mime, base64] = match;
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) throw new Error('Аватар: пустой файл');
  if (buffer.length > config.maxAvatarBytes) throw new Error('Аватар: максимум 2 МБ');
  const fileName = `${playerId}${EXT_BY_MIME[mime]}`;
  fs.writeFileSync(path.join(config.avatarsDir, fileName), buffer);
  return `/avatars/${fileName}`;
}
