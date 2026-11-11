import os from 'node:os';

// Первый внешний IPv4-адрес машины (для ссылок/QR, когда ведущий сидит через localhost)
export function getLanIp() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface || []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}
