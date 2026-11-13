import { isIP } from 'node:net';
import { Buffer } from 'node:buffer';

// Ограничения до обработчиков: ошибочный payload не должен ронять процесс.
const buckets = new Map();
export function allow(key, max, windowMs, now = Date.now()) {
  let entry = buckets.get(key);
  if (!entry || now >= entry.until) {
    entry = { count: 0, until: now + windowMs };
    buckets.set(key, entry);
  }
  if (buckets.size > 10000) for (const [k, v] of buckets) if (now >= v.until) buckets.delete(k);
  return ++entry.count <= max;
}
export function socketLimits(socket) {
  const remote = socket.handshake.address;
  const forwarded = socket.request.headers['x-real-ip'];
  const clientIp = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) && typeof forwarded === 'string' && isIP(forwarded)
    ? forwarded : remote;
  socket.use(([event, payload, ack], next) => {
    const reject = (error) => { if (typeof ack === 'function') ack({ ok: false, error }); };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return reject('Ожидается объект запроса');
    const limit = event === 'room:join' ? 3 * 1024 * 1024 : 16 * 1024;
    try {
      if (Buffer.byteLength(JSON.stringify(payload)) > limit) return reject('Слишком большое сообщение');
    } catch { return reject('Некорректное сообщение'); }
    if (!allow(`socket:${socket.id}`, 600, 10000)) return reject('Слишком много запросов');
    if (event === 'room:create' && !allow(`create:${clientIp}`, 30, 60000)) return reject('Слишком много комнат; попробуйте позже');
    if (event === 'buzz:press' && !allow(`buzz:${socket.data.roomId}:${socket.data.playerId || socket.id}`, 20, 1000)) {
      return reject('Слишком частые нажатия');
    }
    next();
  });
}
export function httpSecurity(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; media-src 'self' https: http:; frame-src https://www.youtube-nocookie.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
  if (req.path.startsWith('/api/') && !allow(`http:${req.ip}`, 600, 60000)) {
    return res.status(429).json({ ok: false, error: 'Слишком много запросов' });
  }
  next();
}
export function safeMediaSource(src) {
  if (typeof src !== 'string' || src.length > 2048 || /[\u0000-\u0020\\]/.test(src)) return false;
  if (/^\/(uploads|testpack-media)\/[a-zA-Z0-9_.-]+$/.test(src)) return true;
  try { const u = new URL(src); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; }
  catch { return false; }
}
