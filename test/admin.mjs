import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { io } from './socket-client.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigame-admin-'));
const probe = net.createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(r => probe.close(r));
const base = `http://localhost:${port}`;
let child;
const sockets = [];
async function start() {
  child = fork('server/index.js', [], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir }, silent: true });
  child.stdout.resume(); child.stderr.pipe(process.stderr);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Server timeout');
}
async function stop() { const ended = once(child, 'exit'); child.send('shutdown'); await ended; }
const call = (socket, event, payload = {}) => new Promise((resolve, reject) => socket.timeout(3000).emit(event, payload, (e, result) => e ? reject(e) : resolve(result)));
try {
  await start();
  const socket = io(base, { transports: ['websocket'], reconnection: false }); sockets.push(socket); await once(socket, 'connect');
  const auth = await call(socket, 'room:create'); assert.equal(auth.ok, true);
  await call(socket, 'session:resume', { roomId: auth.roomId, hostToken: auth.hostToken });
  const url = `${base}/api/admin/rooms`;
  const list = await (await fetch(url)).json();
  assert.equal(list.rooms.length, 1); assert.equal(list.rooms[0].connections, 1);
  assert.equal(JSON.stringify(list).includes(auth.hostToken), false);
  for (const headers of [{ Origin: 'https://evil.example' }, { 'X-Forwarded-For': '127.0.0.1' }]) {
    assert.equal((await fetch(url, { headers })).status, 403);
    assert.equal((await fetch(`${url}/${auth.roomId}`, { method: 'DELETE', headers })).status, 403);
    assert.equal((await fetch(`${url}/${auth.roomId}/access`, { method: 'POST', headers })).status, 403);
  }
  const invalidHostStatus = await new Promise((resolve, reject) => {
    http.get(url, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(invalidHostStatus, 403);
  const access = await fetch(`${url}/${auth.roomId}/access`, { method: 'POST' });
  assert.equal(access.headers.get('cache-control'), 'no-store');
  assert.equal((await access.json()).hostToken, auth.hostToken);
  const deleted = once(socket, 'room:deleted');
  assert.equal((await fetch(`${url}/${auth.roomId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await deleted)[0].roomId, auth.roomId);
  assert.equal((await call(socket, 'session:resume', { roomId: auth.roomId, hostToken: auth.hostToken })).ok, false);
  assert.equal((await fetch(`${url}/${auth.roomId}`, { method: 'DELETE' })).status, 404);
  await new Promise(r => setTimeout(r, 400));
  socket.disconnect(); await stop(); await start();
  assert.equal((await (await fetch(url)).json()).rooms.length, 0);
  assert.equal((await fetch(`${base}/admin/`)).status, 200);
  console.log('PASS: admin list, recovery, deletion, socket notification, restart persistence, origin/host/proxy protection');
} finally {
  sockets.forEach(s => s.disconnect());
  if (child?.exitCode === null) await stop();
}
