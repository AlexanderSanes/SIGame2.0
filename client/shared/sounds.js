// Звуки игры на WebAudio, без файлов. Mute — настройка клиента (localStorage).
let ctx = null;
const MUTE_KEY = 'sigame:muted';

export function isMuted() {
  return localStorage.getItem(MUTE_KEY) === '1';
}
export function toggleMute() {
  localStorage.setItem(MUTE_KEY, isMuted() ? '0' : '1');
  return isMuted();
}

function tone(freq, startAt, durationMs, type = 'sine', gain = 0.12) {
  if (isMuted()) return;
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const vol = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    const t0 = ctx.currentTime + startAt / 1000;
    vol.gain.setValueAtTime(gain, t0);
    vol.gain.exponentialRampToValueAtTime(0.001, t0 + durationMs / 1000);
    osc.connect(vol).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + durationMs / 1000);
  } catch { /* звук опционален */ }
}

export function playSound(name) {
  switch (name) {
    case 'open':    tone(880, 0, 200); break;                                   // кнопка открыта
    case 'press':   tone(1320, 0, 120); tone(1560, 120, 160); break;            // моё нажатие принято
    case 'correct': tone(660, 0, 150); tone(880, 150, 150); tone(1100, 300, 300); break;
    case 'wrong':   tone(220, 0, 300, 'sawtooth', 0.08); tone(160, 250, 400, 'sawtooth', 0.08); break;
    case 'tick':    tone(1200, 0, 60, 'square', 0.05); break;                   // последние 5 секунд
    case 'special': tone(520, 0, 120); tone(780, 120, 120); tone(1040, 240, 250); break; // кот/аукцион/финал
  }
}

// Кнопка mute для шапки страницы
export function muteButton() {
  const btn = document.createElement('button');
  btn.className = 'mute-btn';
  const sync = () => { btn.textContent = isMuted() ? '🔇' : '🔊'; };
  btn.addEventListener('click', () => { toggleMute(); sync(); if (!isMuted()) playSound('tick'); });
  window.addEventListener?.('storage', (event) => { if (event.key === MUTE_KEY) sync(); });
  sync();
  return btn;
}
