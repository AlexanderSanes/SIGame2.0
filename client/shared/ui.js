export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  for (const child of children) {
    el.append(child?.nodeType ? child : document.createTextNode(child ?? ''));
  }
  return el;
}

export function toast(message, type = 'info') {
  const el = h('div', { class: `toast toast-${type}` }, message);
  document.body.append(el);
  setTimeout(() => el.classList.add('visible'), 10);
  setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

export function avatarEl(player, size = 44) {
  if (player.avatarUrl) {
    return h('img', {
      class: 'avatar',
      src: player.avatarUrl,
      width: size,
      height: size,
      alt: '',
    });
  }
  const initial = (player.nick || '?').trim().charAt(0).toUpperCase();
  return h('span', { class: 'avatar avatar-placeholder', style: `width:${size}px;height:${size}px;font-size:${size / 2}px` }, initial);
}
