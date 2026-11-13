// Этап 5: пакеты вопросов — CRUD, валидация, экспорт/импорт, игра на пакете
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const BASE = 'http://localhost:3000';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}`); }
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}
const call = (s, ev, p) => new Promise((res, rej) =>
  s.emit(ev, p, (r) => (r?.ok === false ? rej(new Error(r.error)) : res(r))));

async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function main() {
  // ---------- список и seed ----------
  let r = await api('GET', '/api/packs');
  check('GET /api/packs → ok', r.data.ok === true);
  const seeded = r.data.packs.find((p) => p.id === 'test-pack');
  check('тестовый пакет засеян из TEST_PACK', Boolean(seeded));
  check('у записи есть счётчики раундов/вопросов', seeded?.rounds === 2 && seeded?.questions === 12);

  // ---------- загрузка медиа без комнаты (медиатека редактора) ----------
  const png = fs.readFileSync(path.join(root, 'client', 'testpack-media', 'flag.png'));
  const up = await fetch(`${BASE}/api/upload?kind=image`, { method: 'POST', body: png });
  const upData = await up.json();
  check('upload без room (для редактора пакетов)', upData.ok === true && upData.url.startsWith('/uploads/'));
  const mediaUrl = upData.url;

  // ---------- создание: невалидный пакет не попадает в БД ----------
  const valid = {
    title: 'Мой пакет',
    rounds: [{
      title: 'Раунд 1',
      themes: [{
        title: 'Картинки',
        questions: [
          { price: 100, text: 'Что на картинке?', answer: 'Флаг', type: 'normal',
            media: [{ type: 'image', src: mediaUrl }], answerMedia: [{ type: 'image', src: mediaUrl }] },
          { price: 200, text: '', answer: 'Ничего', type: 'cat',
            media: [{ type: 'image', src: mediaUrl }], answerMedia: [] },
        ],
      }],
    }],
  };

  const invalid = {
    title: 'Мой пакет',
    rounds: [{
      title: 'Раунд 1',
      themes: [{
        title: 'Тема',
        questions: [
          { price: -100, text: 'Вопрос?', answer: 'Ответ', media: [], answerMedia: [] },
          { price: 200, text: '', answer: '', media: [], answerMedia: [] },
        ],
      }],
    }],
  };
  r = await api('POST', '/api/packs', invalid);
  check('невалидный пакет отклонён (400)', r.status === 400 && r.data.ok === false);
  check('ошибки содержат label и message', r.data.errors.every((e) => e.label && e.message));
  check('поймана отрицательная цена', r.data.errors.some((e) => e.path.includes('questions.0.price')));
  check('пойман вопрос без текста и медиа', r.data.errors.some((e) => e.path.includes('questions.1')));
  check('пойман пустой ответ', r.data.errors.some((e) => e.path.includes('answer')));
  r = await api('GET', '/api/packs');
  check('невалидный пакет НЕ появился в списке', !r.data.packs.some((p) => p.title === 'Мой пакет'));

  // ---------- создание валидного ----------
  r = await api('POST', '/api/packs', valid);
  check('валидный пакет создан', r.data.ok === true);
  const packId = r.data.pack.id;
  check('медиа сохранились', r.data.pack.rounds[0].themes[0].questions[0].media[0].src === mediaUrl);

  // ---------- уникальность названий ----------
  r = await api('POST', '/api/packs', valid);
  check('POST с тем же названием отклонён', r.status === 400 && r.data.errors.some((e) => e.path === 'title'));
  r = await api('POST', '/api/packs', { ...valid, title: 'мой пакет ' });
  check('название без учёта регистра/пробелов тоже отклонено', r.status === 400);
  r = await api('PUT', `/api/packs/${packId}`, { ...valid, title: 'Тестовый пакет' });
  check('PUT на чужое название отклонён', r.status === 400 && r.data.errors.some((e) => e.path === 'title'));
  r = await api('PUT', `/api/packs/${packId}`, valid);
  check('PUT с собственным названием разрешён', r.data.ok === true);
  r = await api('PUT', `/api/packs/${packId}`, invalid);
  check('PUT невалидных данных отклонён, пакет не испорчен', r.status === 400);
  r = await api('GET', `/api/packs/${packId}`);
  check('после отклонённого PUT данные прежние', r.data.pack.rounds[0].themes[0].questions.length === 2);

  // ---------- дублирование ----------
  r = await api('POST', `/api/packs/${packId}/duplicate`);
  check('дублирование создаёт копию', r.data.ok === true && r.data.pack.id !== packId);
  check('копия получила уникальное имя', r.data.pack.title === 'Мой пакет (копия)');
  const dupId = r.data.pack.id;
  r = await api('POST', `/api/packs/${packId}/duplicate`);
  check('вторая копия — «(копия 2)»', r.data.pack.title === 'Мой пакет (копия 2)');
  await api('DELETE', `/api/packs/${r.data.pack.id}`);
  r = await api('GET', `/api/packs/${packId}`);
  check('копия с тем же содержимым', (await api('GET', `/api/packs/${dupId}`)).data.pack.rounds[0].themes[0].questions[0].answer === 'Флаг');

  // ---------- экспорт → удаление → импорт ----------
  const exp = await fetch(`${BASE}/api/packs/${packId}/export`);
  const exported = await exp.json();
  check('экспорт: формат sigame-pack@1', exported.format === 'sigame-pack@1');
  check('экспорт: медиа в base64 внутри', typeof exported.files[mediaUrl] === 'string' && exported.files[mediaUrl].length > 0);

  // удаляем файл с диска, чтобы проверить, что импорт восстанавливает медиа
  const diskPath = path.join(root, 'data', 'uploads', path.basename(mediaUrl));
  fs.rmSync(diskPath, { force: true });
  check('медиафайл удалён с диска перед импортом', !fs.existsSync(diskPath));

  r = await api('DELETE', `/api/packs/${packId}`);
  check('пакет удалён', r.data.ok === true);
  r = await api('GET', `/api/packs/${packId}`);
  check('удалённый пакет → 404', r.status === 404);

  r = await api('POST', '/api/packs/import', exported);
  check('импорт восстанавливает пакет', r.data.ok === true);
  const restored = r.data.pack;
  check('структура восстановлена полностью',
    restored.rounds[0].themes[0].questions[1].type === 'cat'
    && restored.rounds[0].themes[0].questions[0].answerMedia[0].src === mediaUrl);
  check('медиафайл восстановлен на диске', fs.existsSync(diskPath));
  const fileRes = await fetch(`${BASE}${mediaUrl}`);
  check('медиафайл отдаётся по HTTP', fileRes.status === 200);

  r = await api('POST', '/api/packs/import', { hello: 'world' });
  check('импорт мусора отклонён с ошибками', r.status === 400 && Array.isArray(r.data.errors));

  // ---------- игра на выбранном пакете ----------
  const host = await connect();
  const created = await call(host, 'room:create', { packId: restored.id });
  check('room:create с packId', Boolean(created.roomId));
  await call(host, 'session:resume', { roomId: created.roomId, hostToken: created.hostToken });
  const player = await connect();
  await call(player, 'room:join', { roomId: created.roomId, nick: 'Вася' });
  const questionShown = new Promise((res) => host.on('question:show', res));
  await call(host, 'game:start', {});
  await call(host, 'board:select', { themeIdx: 0, qIdx: 0 });
  const q = await questionShown;
  check('в игре вопрос из выбранного пакета', q.text === 'Что на картинке?' && q.media?.[0]?.src === mediaUrl);
  host.close(); player.close();

  // дубль чистим за собой
  await api('DELETE', `/api/packs/${dupId}`);

  console.log(`\nИтого: ${passed} пройдено, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
