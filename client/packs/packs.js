import { h, toast } from '/shared/ui.js';

const $ = (id) => document.getElementById(id);

async function api(method, url, body = undefined) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || `Ошибка ${res.status}`);
    err.errors = data.errors;
    throw err;
  }
  return data;
}

// ============================================================ список пакетов

async function loadList() {
  $('view-list').hidden = false;
  $('view-editor').hidden = true;
  const { packs } = await api('GET', '/api/packs');
  const box = $('packs-list');
  box.replaceChildren();
  if (!packs.length) {
    box.append(h('p', { class: 'muted' }, 'Пакетов пока нет — создайте первый.'));
    return;
  }
  for (const p of packs) {
    box.append(h('div', { class: 'pack-row' },
      h('div', { class: 'pack-name' }, p.title),
      h('div', { class: 'pack-meta' }, `${p.rounds} раундов · ${p.themes} тем · ${p.questions} вопросов`),
      h('button', { onclick: () => openEditor(p.id) }, 'Редактировать'),
      h('button', { class: 'secondary', onclick: async () => {
        await api('POST', `/api/packs/${p.id}/duplicate`);
        toast('Пакет продублирован');
        loadList();
      } }, 'Дублировать'),
      h('a', { class: 'btn secondary', href: `/api/packs/${p.id}/export`, download: '' }, 'Экспорт'),
      h('button', { class: 'secondary', onclick: async () => {
        if (!confirm(`Удалить пакет «${p.title}»?`)) return;
        await api('DELETE', `/api/packs/${p.id}`);
        toast('Пакет удалён');
        loadList();
      } }, 'Удалить'),
    ));
  }
}

$('create-pack').addEventListener('click', () => {
  // черновик живёт только на клиенте: в БД попадёт после первого валидного сохранения
  pack = {
    id: null,
    title: 'Новый пакет',
    rounds: [{
      title: 'Раунд 1',
      themes: [{ title: 'Новая тема', questions: [{ price: 100, text: '', answer: '', type: 'normal', media: [], answerMedia: [] }] }],
    }],
  };
  $('view-list').hidden = true;
  $('view-editor').hidden = false;
  $('validation-errors').hidden = true;
  renderEditor();
});

$('import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const errBox = $('import-errors');
  errBox.hidden = true;
  try {
    const payload = JSON.parse(await file.text());
    await api('POST', '/api/packs/import', payload);
    toast(`Пакет «${payload.title}» импортирован`);
    loadList();
  } catch (err) {
    if (err.errors) showErrors(errBox, err.errors);
    else toast(err.message, 'error');
  }
});

// ============================================================ редактор

let pack = null; // { id, title, rounds: [...] }

async function openEditor(id) {
  const data = await api('GET', `/api/packs/${id}`);
  pack = data.pack;
  // дефолты для старых/руками-собранных пакетов
  for (const r of pack.rounds) {
    for (const t of r.themes) {
      for (const q of t.questions) {
        q.text ??= ''; q.type ??= 'normal'; q.media ??= []; q.answerMedia ??= [];
      }
    }
  }
  $('view-list').hidden = true;
  $('view-editor').hidden = false;
  $('validation-errors').hidden = true;
  renderEditor();
}

$('back-btn').addEventListener('click', loadList);

$('pack-title').addEventListener('input', (e) => { pack.title = e.target.value; });

$('add-round').addEventListener('click', () => {
  pack.rounds.push({ title: `Раунд ${pack.rounds.length + 1}`, themes: [] });
  renderEditor();
});

function renderEditor() {
  $('pack-title').value = pack.title;
  const box = $('rounds');
  box.replaceChildren();
  pack.rounds.forEach((round, ri) => {
    box.append(renderRound(round, ri));
  });
}

// --- drag & drop: перетаскивание элементов списка, индекс хранится в dataset.idx
function dnd(el, { onDrop }) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', el.dataset.dndId);
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('dragover', (e) => e.preventDefault());
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const fromId = e.dataTransfer.getData('text/plain');
    onDrop(fromId, el.dataset.dndId);
  });
}

function reorder(arr, fromIdx, toIdx) {
  if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
  const [item] = arr.splice(fromIdx, 1);
  arr.splice(toIdx, 0, item);
}

function renderRound(round, ri) {
  const themesBox = h('div', {});
  round.themes.forEach((theme, ti) => themesBox.append(renderTheme(round, ri, theme, ti)));

  const head = h('div', { class: 'round-head' },
    h('span', { class: 'drag-handle', title: 'Перетащить раунд' }, '⠿'),
    h('input', { value: round.title, 'data-path': `rounds.${ri}.title`,
      oninput: (e) => { round.title = e.target.value; } }),
    h('button', { class: 'small-danger', onclick: () => {
      if (confirm(`Удалить «${round.title}» со всеми темами?`)) {
        pack.rounds.splice(ri, 1);
        renderEditor();
      }
    } }, 'Удалить раунд'),
  );

  const block = h('div', { class: 'round-block' }, head, themesBox,
    h('button', { class: 'secondary media-add', onclick: () => {
      round.themes.push({ title: 'Новая тема', questions: [] });
      renderEditor();
    } }, '+ Тема'),
  );

  block.dataset.dndId = `r${ri}`;
  dnd(block, {
    onDrop: (fromId, toId) => {
      if (!fromId.startsWith('r') || !toId.startsWith('r')) return;
      reorder(pack.rounds, Number(fromId.slice(1)), Number(toId.slice(1)));
      renderEditor();
    },
  });
  return block;
}

function renderTheme(round, ri, theme, ti) {
  const questionsBox = h('div', {});
  theme.questions.forEach((q, qi) => questionsBox.append(renderQuestion(ri, ti, q, qi)));

  const head = h('div', { class: 'theme-head' },
    h('span', { class: 'drag-handle', title: 'Перетащить тему' }, '⠿'),
    h('input', { value: theme.title, placeholder: 'Название темы',
      'data-path': `rounds.${ri}.themes.${ti}.title`,
      oninput: (e) => { theme.title = e.target.value; } }),
    h('button', { class: 'small-danger', onclick: () => {
      if (confirm(`Удалить тему «${theme.title}»?`)) {
        round.themes.splice(ti, 1);
        renderEditor();
      }
    } }, 'Удалить'),
  );

  const block = h('div', { class: 'theme-block' }, head, questionsBox,
    h('button', { class: 'secondary media-add', onclick: () => {
      theme.questions.push({ price: (theme.questions.length + 1) * 100, text: '', answer: '', type: 'normal', media: [], answerMedia: [] });
      renderEditor();
    } }, '+ Вопрос'),
  );

  block.dataset.dndId = `t${ri}:${ti}`;
  dnd(block, {
    onDrop: (fromId, toId) => {
      if (!fromId.startsWith('t') || !toId.startsWith('t')) return;
      const [fR, fT] = fromId.slice(1).split(':').map(Number);
      const [tR, tT] = toId.slice(1).split(':').map(Number);
      if (fR !== tR) return; // темы не таскаем между раундами
      reorder(pack.rounds[fR].themes, fT, tT);
      renderEditor();
    },
  });
  return block;
}

const QUESTION_TYPES = [
  ['normal', 'Обычный'],
  ['cat', 'Кот в мешке'],
  ['auction', 'Аукцион'],
];

function renderQuestion(ri, ti, q, qi) {
  const base = `rounds.${ri}.themes.${ti}.questions.${qi}`;

  const typeSelect = h('select', { 'data-path': `${base}.type`, onchange: (e) => { q.type = e.target.value; } },
    ...QUESTION_TYPES.map(([value, label]) =>
      h('option', { value, ...(q.type === value ? { selected: '' } : {}) }, label)));

  const card = h('div', { class: 'question-card', 'data-qcard': base },
    h('div', { class: 'q-row' },
      h('span', { class: 'drag-handle', title: 'Перетащить вопрос' }, '⠿'),
      h('label', {}, 'Цена', h('input', { type: 'number', min: '1', step: '50', value: q.price,
        'data-path': `${base}.price`, oninput: (e) => { q.price = Number(e.target.value); } })),
      h('label', {}, 'Тип', typeSelect),
      h('label', { class: 'grow' }, 'Правильный ответ',
        h('input', { value: q.answer, 'data-path': `${base}.answer`, oninput: (e) => { q.answer = e.target.value; } })),
      h('button', { class: 'small-danger', onclick: () => {
        pack.rounds[ri].themes[ti].questions.splice(qi, 1);
        renderEditor();
      } }, 'Удалить'),
    ),
    h('div', { class: 'q-row' },
      h('textarea', { placeholder: 'Текст вопроса', 'data-path': `${base}.text`,
        oninput: (e) => { q.text = e.target.value; } }, q.text),
    ),
    h('div', { class: 'q-row' },
      h('span', { class: 'muted', style: 'font-size:12px' }, 'Медиа вопроса:'),
      mediaChips(q.media, () => renderEditor()),
      mediaAdder(q.media, ['image', 'audio', 'video', 'youtube'], () => renderEditor()),
    ),
    h('div', { class: 'q-row' },
      h('span', { class: 'muted', style: 'font-size:12px' }, 'Медиа ответа:'),
      mediaChips(q.answerMedia, () => renderEditor()),
      mediaAdder(q.answerMedia, ['image'], () => renderEditor()),
    ),
  );

  card.dataset.dndId = `q${ri}:${ti}:${qi}`;
  dnd(card, {
    onDrop: (fromId, toId) => {
      if (!fromId.startsWith('q') || !toId.startsWith('q')) return;
      const [fR, fT, fQ] = fromId.slice(1).split(':').map(Number);
      const [tR, tT, tQ] = toId.slice(1).split(':').map(Number);
      if (fR !== tR) return; // вопросы не таскаем между раундами
      const fromTheme = pack.rounds[fR].themes[fT];
      const [item] = fromTheme.questions.splice(fQ, 1);
      const toTheme = pack.rounds[tR].themes[tT];
      toTheme.questions.splice(fT === tT && fQ < tQ ? tQ - 1 : tQ, 0, item);
      renderEditor();
    },
  });
  return card;
}

// --- медиа-чипы и добавление ---

function mediaLabel(item) {
  const short = item.src.length > 40 ? `…${item.src.slice(-30)}` : item.src;
  return { image: '🖼', audio: '🔊', video: '🎬', youtube: '▶' }[item.type] + ' ' + short;
}

function mediaChips(list, onChange) {
  const box = h('span', { class: 'media-chips' });
  list.forEach((item, i) => {
    const chip = h('span', { class: 'media-chip', title: item.src });
    if (item.type === 'image') chip.append(h('img', { src: item.src, alt: '' }));
    chip.append(h('span', {}, mediaLabel(item)));
    chip.append(h('button', { title: 'Убрать', onclick: () => { list.splice(i, 1); onChange(); } }, '✕'));
    box.append(chip);
  });
  return box;
}

function mediaAdder(list, kinds, onChange) {
  const box = h('span', { style: 'display:inline-flex;gap:4px' });
  if (kinds.some((k) => k !== 'youtube')) {
    const input = h('input', { type: 'file', hidden: '',
      accept: kinds.map((k) => `${k}/*`).join(',') });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const kind = ['image', 'audio', 'video'].find((k) => file.type.startsWith(`${k}/`));
      if (!kind || !kinds.includes(kind)) {
        toast('Неподдерживаемый тип файла', 'error');
        return;
      }
      try {
        const res = await fetch(`/api/upload?kind=${kind}`, { method: 'POST', body: file });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);
        list.push({ type: kind, src: data.url });
        onChange();
      } catch (e) {
        toast(e.message || 'Ошибка загрузки', 'error');
      }
    });
    box.append(h('button', { class: 'secondary media-add', onclick: () => input.click() }, '+ файл'), input);
  }
  if (kinds.includes('youtube')) {
    box.append(h('button', { class: 'secondary media-add', onclick: () => {
      const url = prompt('Ссылка на YouTube:');
      if (url?.trim()) {
        list.push({ type: 'youtube', src: url.trim() });
        onChange();
      }
    } }, '+ YouTube'));
  }
  return box;
}

// --- валидация и сохранение ---

function clientValidate(p) {
  const errors = [];
  const label = (ri, ti, qi) => [
    ri != null && `Раунд ${ri + 1}`,
    ti != null && `тема ${ti + 1}`,
    qi != null && `вопрос ${qi + 1}`,
  ].filter(Boolean).join(' → ') || 'Пакет';
  if (!p.title?.trim()) errors.push({ path: 'title', label: 'Пакет', message: 'Нет названия пакета' });
  if (!p.rounds?.length) errors.push({ path: 'rounds', label: 'Пакет', message: 'В пакете нет раундов' });
  p.rounds?.forEach((r, ri) => {
    if (!r.title?.trim()) errors.push({ path: `rounds.${ri}.title`, label: label(ri), message: 'Нет названия раунда' });
    if (!r.themes?.length) errors.push({ path: `rounds.${ri}.themes`, label: label(ri), message: 'В раунде нет тем' });
    r.themes?.forEach((t, ti) => {
      if (!t.title?.trim()) errors.push({ path: `rounds.${ri}.themes.${ti}.title`, label: label(ri, ti), message: 'Нет названия темы' });
      if (!t.questions?.length) errors.push({ path: `rounds.${ri}.themes.${ti}.questions`, label: label(ri, ti), message: 'В теме нет вопросов' });
      t.questions?.forEach((q, qi) => {
        if (!Number.isInteger(q.price) || q.price <= 0) {
          errors.push({ path: `rounds.${ri}.themes.${ti}.questions.${qi}.price`, label: label(ri, ti, qi), message: 'Цена должна быть положительным целым числом' });
        }
        if (!q.text?.trim() && !(q.media?.length)) {
          errors.push({ path: `rounds.${ri}.themes.${ti}.questions.${qi}.text`, label: label(ri, ti, qi), message: 'Нужен текст вопроса или медиа' });
        }
        if (!q.answer?.trim()) {
          errors.push({ path: `rounds.${ri}.themes.${ti}.questions.${qi}.answer`, label: label(ri, ti, qi), message: 'Нет правильного ответа' });
        }
      });
    });
  });
  return errors;
}

function showErrors(box, errors) {
  box.hidden = false;
  box.replaceChildren(
    h('h3', {}, `Пакет не сохранён: ${errors.length} ошибок`),
    h('ul', {}, ...errors.map((e) => h('li', {},
      h('a', { href: '#', onclick: (ev) => {
        ev.preventDefault();
        const el = document.querySelector(`[data-path="${e.path}"]`) || document.querySelector(`[data-qcard="${e.path}"]`);
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          el.focus?.();
          const card = el.closest?.('.question-card');
          if (card) {
            card.classList.add('invalid');
            setTimeout(() => card.classList.remove('invalid'), 2000);
          }
        }
      } }, `${e.label}: ${e.message}`)))),
  );
  box.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

$('save-btn').addEventListener('click', async () => {
  const errBox = $('validation-errors');
  errBox.hidden = true;
  const errors = clientValidate(pack);
  if (errors.length) {
    showErrors(errBox, errors);
    return;
  }
  try {
    const payload = { title: pack.title.trim(), rounds: pack.rounds };
    const { pack: saved } = pack.id
      ? await api('PUT', `/api/packs/${pack.id}`, payload)
      : await api('POST', '/api/packs', payload);
    pack = saved;
    toast('Пакет сохранён');
    renderEditor();
  } catch (e) {
    if (e.errors) showErrors(errBox, e.errors);
    else toast(e.message, 'error');
  }
});

loadList();
