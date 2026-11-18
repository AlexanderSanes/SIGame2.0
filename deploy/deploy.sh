#!/usr/bin/env bash
set -euo pipefail
umask 022

if [[ $EUID != 0 || $# != 1 || ! $1 =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Использование от root: sigame-deploy <полный SHA коммита>' >&2
  exit 2
fi

# Файл создаётся setup-actions.sh и доступен для записи только root.
source /etc/sigame-deploy.conf
export PATH="$(dirname "$NODE_BIN"):/usr/sbin:/usr/bin:/sbin:/bin"
sha=$1
app=/opt/sigame
releases=$app/releases
data=/var/lib/sigame
backups=/var/backups/sigame

exec 9>/run/lock/sigame-deploy.lock
flock -n 9 || { echo 'Другой деплой уже выполняется.' >&2; exit 1; }
test -L "$app/current"
previous=$(readlink -f "$app/current")
test -d "$previous"
systemctl is-active --quiet sigame

stage=$(mktemp -d "$releases/.prepare-XXXXXXXX")
chmod 755 "$stage"
archive=$(mktemp /tmp/sigame-release-XXXXXXXX.tar.gz)
switch_link=$app/.current-next
rollback_needed=false

finish() {
  status=$?
  trap - EXIT HUP INT TERM
  if $rollback_needed; then
    echo 'Проверка обновления не прошла, возвращаем предыдущий код.' >&2
    systemctl stop sigame || true
    ln -sfn "$previous" "$switch_link"
    mv -Tf "$switch_link" "$app/current"
    if ! systemctl start sigame; then
      echo 'Не удалось запустить предыдущую версию, проверьте journalctl -u sigame.' >&2
    fi
  fi
  rm -f -- "$archive" "$switch_link"
  # Удаляется только временный каталог этой установки, созданный mktemp выше.
  rm -rf -- "$stage"
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

echo "Подготовка коммита $sha"
curl --fail --silent --show-error --location --retry 3 --max-time 120 \
  "https://codeload.github.com/AlexanderSanes/SIGame2.0/tar.gz/$sha" -o "$archive"
tar -xzf "$archive" --strip-components=1 --no-same-owner -C "$stage"
test -f "$stage/package-lock.json"
test -f "$stage/server/index.js"
printf '%s\n' "$sha" > "$stage/.release-sha"

# npm выполняется пользователем без доступа к рабочей БД и прав root.
chown -R sigame-deploy:sigame-deploy "$stage"
runuser -u sigame-deploy -- env PATH="$PATH" \
  npm ci --omit=dev --prefix "$stage" --cache /var/cache/sigame-deploy --no-audit --no-fund
chown -R root:root "$stage"
find "$stage" -type d -exec chmod 755 {} +
find "$stage" -type f -exec chmod a+r,go-w {} +

release=$releases/$sha
if [[ -e $release ]]; then
  # Повторный запуск того же коммита использует уже установленный каталог.
  test "$(cat "$release/.release-sha")" = "$sha"
else
  mv "$stage" "$release"
  # finish может удалить лишь первоначальный временный путь.
fi

room_ids() {
  curl --fail --silent --show-error --max-time 10 \
    http://127.0.0.1:3000/api/admin/rooms | "$NODE_BIN" --input-type=module -e '
      import fs from "node:fs";
      const { rooms } = JSON.parse(fs.readFileSync(0, "utf8"));
      console.log(JSON.stringify(rooms.map(room => room.id).sort()));
    '
}

before=$(room_ids)
rollback_needed=true
systemctl stop sigame
test "$(systemctl show -p Result --value sigame)" = success

install -d -m 700 "$backups"
backup=$(mktemp -d "$backups/$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:12}-XXXXXXXX")
chmod 700 "$backup"
tar -czf "$backup/data.tar.gz" -C "$data" .
printf '%s\n' "$previous" > "$backup/previous-release"
printf '%s\n' "$before" > "$backup/room-ids.json"

ln -sfn "$release" "$switch_link"
mv -Tf "$switch_link" "$app/current"
systemctl start sigame

healthy=false
for attempt in {1..30}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:3000/healthz \
    | "$NODE_BIN" -e 'if(JSON.parse(require("fs").readFileSync(0)).ok!==true)process.exit(1)' 2>/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
$healthy
test "$(room_ids)" = "$before"
curl --fail --silent --show-error --retry 3 --max-time 20 "$PUBLIC_URL/healthz" \
  | "$NODE_BIN" -e 'if(JSON.parse(require("fs").readFileSync(0)).ok!==true)process.exit(1)'
systemctl is-active --quiet sigame
rollback_needed=false
echo "DEPLOYED $sha"
echo "Резервная копия данных: $backup"
