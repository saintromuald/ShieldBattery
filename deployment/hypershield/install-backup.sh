#!/usr/bin/env bash
set -Eeuo pipefail

ROLE="${1:-}"
if [[ "$ROLE" != "app" && "$ROLE" != "coordinator" ]]; then
  echo "Usage: sudo $0 app|coordinator" >&2
  exit 2
fi
if (( EUID != 0 )); then
  echo "Run as root." >&2
  exit 1
fi

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EXPECTED_ROOT="/opt/hypershield/src/deployment/hypershield"
if [[ "$ROOT" != "$EXPECTED_ROOT" ]]; then
  echo "Expected the deployment checkout at $EXPECTED_ROOT, found $ROOT" >&2
  exit 1
fi

install -m 0644 "$ROOT/hypershield-backup@.service" /etc/systemd/system/hypershield-backup@.service
install -m 0644 "$ROOT/hypershield-backup@.timer" /etc/systemd/system/hypershield-backup@.timer
systemctl daemon-reload
cat <<EOF
Installed the $ROLE backup units without enabling the timer.
Test with: systemctl start hypershield-backup@$ROLE.service
After success, enable with: systemctl enable --now hypershield-backup@$ROLE.timer
EOF
