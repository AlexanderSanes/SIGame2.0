import { h } from './ui.js';

export function parseYoutubeId(src) {
  const m = /(?:youtube\.com\/(?:watch\?[^#]*v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,20})/.exec(src || '');
  return m ? m[1] : null;
}

// Рендер списка медиа вопроса. interactive=true — у ведущего: контролы и события onControl('play'|'pause')
export function renderMedia(container, mediaList, { interactive = false, onControl = null } = {}) {
  container.replaceChildren();
  if (!mediaList?.length) return [];
  const players = []; // аудио/видео элементы для applyMediaControl
  for (const item of mediaList) {
    if (!item?.src) continue;
    if (item.type === 'image') {
      container.append(h('img', { class: 'media-img', src: item.src, alt: 'Изображение к вопросу' }));
    } else if (item.type === 'audio' || item.type === 'video') {
      const el = h(item.type === 'audio' ? 'audio' : 'video', {
        class: item.type === 'audio' ? 'media-audio' : 'media-video',
        src: item.src,
        preload: 'auto',
        playsinline: '',
      });
      const volume=()=>{el.volume=Math.min(1,Math.max(0,Number(localStorage.getItem('sigame:media-volume') ?? 1)));};
      volume();
      if (interactive) {
        el.controls = true;
        el.addEventListener('play', () => onControl?.('play', el.currentTime));
        el.addEventListener('pause', () => onControl?.('pause', el.currentTime));
        el.addEventListener('seeked', () => onControl?.(el.paused ? 'pause' : 'play', el.currentTime));
      } else {
        el.loop = item.type === 'video'; // видео на табло крутим по кругу
        tryAutoplay(el, container);
      }
      players.push(el);
      container.append(el);
    } else if (item.type === 'youtube') {
      const id = parseYoutubeId(item.src);
      if (id) {
        const params = interactive ? 'rel=0' : 'rel=0&autoplay=1&mute=1';
        container.append(h('iframe', {
          class: 'media-youtube',
          src: `https://www.youtube-nocookie.com/embed/${id}?${params}`,
          allow: 'accelerometer; autoplay; encrypted-media; picture-in-picture',
          allowfullscreen: '',
        }));
      }
    }
  }
  return players;
}

// Автоплей со звуком часто заблокирован — показываем кнопку-разблокировку
function tryAutoplay(el, container) {
  const promise = el.play();
  if (!promise?.catch) return;
  promise.catch(() => {
    if (!el.isConnected) return;
    const btn = h('button', { class: 'btn btn-primary media-unlock', type: 'button' }, '▶ Включить звук');
    btn.addEventListener('click', () => {
      el.muted = false;
      el.play().catch(() => {});
      btn.remove();
    });
    container.append(btn);
  });
}

// Применить команду ведущего к отрендеренным аудио/видео
export function applyMediaControl(players, action, position = null) {
  for (const el of players) {
    if (Number.isFinite(position)) {
      const seek=()=>{try{el.currentTime=Math.min(position,Number.isFinite(el.duration)?el.duration:position);}catch{}};
      if(el.readyState)seek();else el.addEventListener('loadedmetadata',seek,{once:true});
    }
    if (action === 'play') el.play().catch(() => {});
    else if (action === 'pause') el.pause();
  }
}

// Предзагрузка медиа раунда, чтобы открытие вопроса было мгновенным
const queue = []; const loaded = new Set(); let active = 0;
export function preloadMedia(urls) {
  for (const url of urls || []) {
    if (!/\.(png|jpe?g|gif|webp)$/i.test(url) || loaded.has(url)) continue;
    loaded.add(url); queue.push(url);
  }
  while (active < 3 && queue.length) {
    const url=queue.shift(); active++; const img=new Image();
    const done=()=>{active--;preloadMedia([]);};
    img.onload=done; img.onerror=()=>{loaded.delete(url);done();}; img.src=url;
  }
}
