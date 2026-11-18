#!/usr/bin/env bash
set -euo pipefail
umask 022

if [[ $EUID != 0 || $# != 3 ]]; then
  echo 'Использование от root: setup-actions.sh <публичный SSH-ключ> <путь к node> <HTTPS URL>' >&2
  exit 2
fi
key_file=$(readlink -f "$1")
node_bin=$(readlink -f "$2")
public_url=${3%/}
[[ $public_url =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]]
test -x "$node_bin"
test -x "$(dirname "$node_bin")/npm"
ssh-keygen -lf "$key_file" >/dev/null
scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
app=/opt/sigame
test -d "$app/server"
test -d "$app/node_modules"
systemctl is-active --quiet sigame

if ! id sigame-deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash sigame-deploy
fi
# Заблокированный пароль может блокировать также вход по ключу в OpenSSH.
# Строка x не является допустимым хэшем пароля, вход идёт только по ключу.
usermod --password x sigame-deploy
chown root:root /home/sigame-deploy
chmod 755 /home/sigame-deploy
install -d -m 755 -o root -g root /home/sigame-deploy/.ssh
install -d -m 700 -o sigame-deploy -g sigame-deploy /var/cache/sigame-deploy
install -m 755 "$scripts/deploy.sh" /usr/local/sbin/sigame-deploy
install -m 755 "$scripts/ssh-command.sh" /usr/local/sbin/sigame-deploy-ssh
printf 'restrict,command="/usr/local/sbin/sigame-deploy-ssh" %s\n' "$(cat "$key_file")" \
  > /home/sigame-deploy/.ssh/authorized_keys
chown root:root /home/sigame-deploy/.ssh/authorized_keys
chmod 644 /home/sigame-deploy/.ssh/authorized_keys
printf 'sigame-deploy ALL=(root) NOPASSWD: /usr/local/sbin/sigame-deploy\n' \
  > /etc/sudoers.d/sigame-deploy
chmod 440 /etc/sudoers.d/sigame-deploy
visudo -cf /etc/sudoers.d/sigame-deploy
printf 'NODE_BIN=%q\nPUBLIC_URL=%q\n' "$node_bin" "$public_url" > /etc/sigame-deploy.conf
chmod 600 /etc/sigame-deploy.conf

install -d -m 755 "$app/releases"
if [[ ! -L $app/current ]]; then
  bootstrap=$(mktemp -d "$app/releases/bootstrap-XXXXXXXX")
  chmod 755 "$bootstrap"
  cp -a "$app/client" "$app/server" "$app/node_modules" \
    "$app/config.js" "$app/package.json" "$app/package-lock.json" "$bootstrap/"
  ln -s "$bootstrap" "$app/current"
fi

install -d -m 755 /etc/systemd/system/sigame.service.d
cat > /etc/systemd/system/sigame.service.d/deployment.conf <<EOF
[Service]
WorkingDirectory=$app/current
ExecStart=
ExecStart=$node_bin $app/current/server/index.js
EOF
systemctl daemon-reload
echo 'Ручной деплой подготовлен. Новая схема путей применяется при следующем запуске службы.'
