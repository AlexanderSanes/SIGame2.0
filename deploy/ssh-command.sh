#!/usr/bin/env bash
set -euo pipefail

# Эта команда закреплена за отдельным SSH-ключом в authorized_keys.
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  exec sudo -n /usr/local/sbin/sigame-deploy "${BASH_REMATCH[1]}"
fi

echo 'Допустима только команда deploy с полным SHA коммита.' >&2
exit 2
