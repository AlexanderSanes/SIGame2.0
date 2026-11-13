import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from './db.js';
import { TEST_PACK, TEST_PACK_SPECIAL } from './testpack.js';

// ---------- zod-схема пакета ----------

const mediaItem = z.object({
  type: z.enum(['image', 'audio', 'video', 'youtube']),
  src: z.string().min(1, 'Пустая ссылка на медиа'),
});

const question = z.object({
  price: z.number().int('Цена должна быть целым числом').positive('Цена должна быть положительной'),
  text: z.string().default(''),
  answer: z.string().min(1, 'Нет правильного ответа'),
  // пометка для этапа 6, игровая логика пока не различает типы
  type: z.enum(['normal', 'cat', 'auction']).default('normal'),
  media: z.array(mediaItem).default([]),
  answerMedia: z.array(mediaItem).default([]),
}).refine((q) => q.text.trim().length > 0 || q.media.length > 0, {
  message: 'Нужен текст вопроса или медиа',
});

const theme = z.object({
  title: z.string().min(1, 'Нет названия темы'),
  questions: z.array(question).min(1, 'В теме нет вопросов'),
});

const round = z.object({
  title: z.string().min(1, 'Нет названия раунда'),
  themes: z.array(theme).min(1, 'В раунде нет тем'),
});

export const packSchema = z.object({
  title: z.string().min(1, 'Нет названия пакета'),
  rounds: z.array(round).min(1, 'В пакете нет раундов'),
  // финальный раунд (необязателен): одна тема, ставки, письменные ответы
  final: z.object({
    title: z.string().min(1, 'Нет названия финальной темы'),
    text: z.string().default(''),
    answer: z.string().min(1, 'Нет правильного ответа'),
    media: z.array(mediaItem).default([]),
  }).refine((f) => f.text.trim().length > 0 || f.media.length > 0, {
    message: 'Нужен текст вопроса или медиа',
  }).nullable().default(null),
});

// Плоский список ошибок с человекочитаемыми путями для списка в редакторе
export function validatePack(pack) {
  const res = packSchema.safeParse(pack);
  if (res.success) return { ok: true, data: res.data, errors: [] };
  const errors = res.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    label: humanPath(issue.path),
    message: issue.message,
  }));
  return { ok: false, errors };
}

function humanPath(p) {
  // [rounds, 0, themes, 1, questions, 2, answer] → «Раунд 1 → тема 2 → вопрос 3»
  const names = { rounds: 'Раунд', themes: 'тема', questions: 'вопрос' };
  const parts = [];
  for (let i = 0; i < p.length; i += 2) {
    const key = p[i];
    const idx = p[i + 1];
    if (names[key] !== undefined && typeof idx === 'number') {
      parts.push(`${names[key]} ${idx + 1}`);
    } else {
      break;
    }
  }
  return parts.length ? parts.join(' → ') : 'Пакет';
}

// ---------- хранилище (SQLite) ----------

const stmtList = db.prepare('SELECT id, title, created_at, updated_at FROM packages ORDER BY updated_at DESC');
const stmtGet = db.prepare('SELECT id, title, data, created_at, updated_at FROM packages WHERE id = ?');
const stmtInsert = db.prepare('INSERT INTO packages (id, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
const stmtUpdate = db.prepare('UPDATE packages SET title = ?, data = ?, updated_at = ? WHERE id = ?');
const stmtDelete = db.prepare('DELETE FROM packages WHERE id = ?');

export function listPacks() {
  return stmtList.all().map((row) => {
    const data = JSON.parse(getRaw(row.id).data);
    let themes = 0; let questions = 0;
    for (const r of data.rounds) {
      themes += r.themes.length;
      for (const t of r.themes) questions += t.questions.length;
    }
    return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at, rounds: data.rounds.length, themes, questions };
  });
}

function getRaw(id) {
  return stmtGet.get(id);
}

export function getPack(id) {
  const row = getRaw(id);
  if (!row) return null;
  const data = JSON.parse(row.data);
  return { id: row.id, title: row.title, rounds: data.rounds, final: data.final ?? null, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function titleTaken(title, excludeId = null) {
  const normalized = (title || '').trim().toLowerCase();
  if (!normalized) return false;
  return stmtList.all().some((row) =>
    row.id !== excludeId && row.title.trim().toLowerCase() === normalized);
}

export function createPack(pack) {
  const id = crypto.randomUUID();
  const now = Date.now();
  stmtInsert.run(id, pack.title, JSON.stringify({ rounds: pack.rounds, final: pack.final ?? null }), now, now);
  return getPack(id);
}

export function savePack(id, pack) {
  if (!getRaw(id)) return null;
  stmtUpdate.run(pack.title, JSON.stringify({ rounds: pack.rounds, final: pack.final ?? null }), Date.now(), id);
  return getPack(id);
}

export function deletePack(id) {
  return stmtDelete.run(id).changes > 0;
}

// Уникальное имя для копий/импорта: «Название (копия)», «Название (копия 2)»…
function uniqueCopyTitle(base) {
  let title = `${base} (копия)`;
  for (let n = 2; titleTaken(title); n += 1) {
    title = `${base} (копия ${n})`;
  }
  return title;
}

export function duplicatePack(id) {
  const src = getPack(id);
  if (!src) return null;
  const newId = crypto.randomUUID();
  const now = Date.now();
  stmtInsert.run(newId, uniqueCopyTitle(src.title), JSON.stringify({ rounds: src.rounds, final: src.final ?? null }), now, now);
  return getPack(newId);
}

// ---------- экспорт/импорт ----------
// Формат: один JSON, локальные медиа (/uploads/...) — base64 в поле files.
// Плюсы: ноль зависимостей (zip потребовал бы архиватор), один атомарный файл,
// импорт идемпотентен — файлы content-addressed, повторная запись по тому же хэшу безопасна.

const EXPORT_FORMAT = 'sigame-pack@1';

function localMediaUrls(rounds, final = null) {
  const urls = new Set();
  for (const m of final?.media || []) {
    if (m.src?.startsWith('/uploads/')) urls.add(m.src);
  }
  for (const r of rounds) {
    for (const t of r.themes) {
      for (const q of t.questions) {
        for (const m of [...(q.media || []), ...(q.answerMedia || [])]) {
          if (m.src?.startsWith('/uploads/')) urls.add(m.src);
        }
      }
    }
  }
  return [...urls];
}

export function exportPack(id) {
  const pack = getPack(id);
  if (!pack) return null;
  const files = {};
  for (const url of localMediaUrls(pack.rounds, pack.final)) {
    const filePath = path.join(config.uploadsDir, path.basename(url));
    if (fs.existsSync(filePath)) files[url] = fs.readFileSync(filePath).toString('base64');
  }
  return { format: EXPORT_FORMAT, title: pack.title, rounds: pack.rounds, final: pack.final, files };
}

export function importPack(payload) {
  if (!payload || payload.format !== EXPORT_FORMAT) {
    return { ok: false, errors: [{ label: 'Пакет', message: 'Неизвестный формат файла' }] };
  }
  const check = validatePack({ title: payload.title, rounds: payload.rounds, final: payload.final ?? null });
  if (!check.ok) return { ok: false, errors: check.errors };
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  for (const [url, b64] of Object.entries(payload.files || {})) {
    if (!url.startsWith('/uploads/')) continue;
    const buf = Buffer.from(b64, 'base64');
    const filePath = path.join(config.uploadsDir, path.basename(url));
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buf);
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  const title = titleTaken(check.data.title) ? uniqueCopyTitle(payload.title) : check.data.title;
  stmtInsert.run(id, title, JSON.stringify({ rounds: check.data.rounds, final: check.data.final }), now, now);
  return { ok: true, pack: getPack(id) };
}

// Встроенные пакеты: тестовый — при пустой таблице, особые — если ещё не засеян
export function seedPacks() {
  if (stmtList.all().length === 0) {
    const now = Date.now();
    const normalized = packSchema.parse({ title: TEST_PACK.title, rounds: TEST_PACK.rounds });
    stmtInsert.run(TEST_PACK.id, normalized.title, JSON.stringify({ rounds: normalized.rounds, final: normalized.final }), now, now);
  }
  if (!getRaw(TEST_PACK_SPECIAL.id)) {
    const now = Date.now();
    const normalized = packSchema.parse({ title: TEST_PACK_SPECIAL.title, rounds: TEST_PACK_SPECIAL.rounds, final: TEST_PACK_SPECIAL.final });
    stmtInsert.run(TEST_PACK_SPECIAL.id, normalized.title, JSON.stringify({ rounds: normalized.rounds, final: normalized.final }), now, now);
  }
}

// Пакет по умолчанию для комнаты, если packId не указан/не найден:
// встроенный тестовый, иначе самый свежий из списка
export function getDefaultPack() {
  const builtin = getPack(TEST_PACK.id);
  if (builtin) return builtin;
  const row = stmtList.all()[0];
  return row ? getPack(row.id) : null;
}
