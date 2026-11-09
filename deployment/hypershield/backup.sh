#!/usr/bin/env bash
set -Eeuo pipefail

ROLE="${1:-}"
if [[ "$ROLE" != "app" && "$ROLE" != "coordinator" ]]; then
  echo "Usage: $0 app|coordinator" >&2
  exit 2
fi
if (( EUID != 0 )); then
  echo "Backups must run as root to read deployment secrets and Docker volumes." >&2
  exit 1
fi

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${HYPERSHIELD_BACKUP_CONFIG:-/opt/hypershield/backup.env}"
if [[ ! -r "$CONFIG" ]]; then
  echo "Missing backup configuration: $CONFIG" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$CONFIG"
: "${RESTIC_REPOSITORY_BASE:?set RESTIC_REPOSITORY_BASE}"
: "${RESTIC_PASSWORD_FILE:?set RESTIC_PASSWORD_FILE}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY}"
export RESTIC_REPOSITORY="${RESTIC_REPOSITORY_BASE%/}/${ROLE}"
export RESTIC_PASSWORD_FILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

exec 9> "/opt/hypershield/backups/.backup-${ROLE}.lock"
flock -n 9 || exit 0

STAGING="/opt/hypershield/backups/staging-${ROLE}"
install -d -m 0700 "$STAGING"
DUMP="$STAGING/hypershield-postgres.dump"
SNAPSHOT="$STAGING/relay-ledger.sqlite"
trap 'rm -f -- "$DUMP" "$SNAPSHOT"' EXIT

if [[ "$ROLE" == app ]]; then
  APP_DIR="$ROOT/appserver"
  rm -f -- "$DUMP"
  docker compose --env-file "$APP_DIR/.env" -f "$APP_DIR/docker-compose.yml" \
    exec -T db sh -c 'pg_dump -U postgres -Fc -d "$SB_DB"' > "$DUMP"
  test -s "$DUMP"

  PATHS=("$DUMP" "$APP_DIR/.env" "$ROOT/public-object-prefixes.txt")
  [[ ! -f "$APP_DIR/google-credentials.json" ]] || PATHS+=("$APP_DIR/google-credentials.json")
  restic backup "${PATHS[@]}" --tag hypershield --tag app

  : "${OBJECT_STORAGE_ENDPOINT:?set OBJECT_STORAGE_ENDPOINT}"
  : "${OBJECT_STORAGE_APPLICATION_BUCKET:?set OBJECT_STORAGE_APPLICATION_BUCKET}"
  : "${OBJECT_STORAGE_BACKUP_BUCKET:?set OBJECT_STORAGE_BACKUP_BUCKET}"
  : "${OBJECT_STORAGE_READER_ACCESS_KEY_ID:?set OBJECT_STORAGE_READER_ACCESS_KEY_ID}"
  : "${OBJECT_STORAGE_READER_SECRET_ACCESS_KEY:?set OBJECT_STORAGE_READER_SECRET_ACCESS_KEY}"

  # Configure separate source and destination remotes entirely through the environment.
  export RCLONE_CONFIG_HS_SOURCE_TYPE=s3
  export RCLONE_CONFIG_HS_SOURCE_PROVIDER=DigitalOcean
  export RCLONE_CONFIG_HS_SOURCE_ENV_AUTH=false
  export RCLONE_CONFIG_HS_SOURCE_ENDPOINT="$OBJECT_STORAGE_ENDPOINT"
  export RCLONE_CONFIG_HS_SOURCE_ACCESS_KEY_ID="$OBJECT_STORAGE_READER_ACCESS_KEY_ID"
  export RCLONE_CONFIG_HS_SOURCE_SECRET_ACCESS_KEY="$OBJECT_STORAGE_READER_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_HS_SOURCE_ACL=private
  export RCLONE_CONFIG_HS_DEST_TYPE=s3
  export RCLONE_CONFIG_HS_DEST_PROVIDER=DigitalOcean
  export RCLONE_CONFIG_HS_DEST_ENV_AUTH=false
  export RCLONE_CONFIG_HS_DEST_ENDPOINT="$OBJECT_STORAGE_ENDPOINT"
  export RCLONE_CONFIG_HS_DEST_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID"
  export RCLONE_CONFIG_HS_DEST_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_HS_DEST_ACL=private

  VERSION_PATH="objects/versions/$(date -u +%Y%m%dT%H%M%SZ)"
  rclone sync \
    "HS_SOURCE:${OBJECT_STORAGE_APPLICATION_BUCKET}" \
    "HS_DEST:${OBJECT_STORAGE_BACKUP_BUCKET}/objects/current" \
    --backup-dir "HS_DEST:${OBJECT_STORAGE_BACKUP_BUCKET}/${VERSION_PATH}" \
    --fast-list --transfers=4 --checkers=8 --stats=0
  # Expire by the dated backup-directory name, not by a file's original modification time.
  CUTOFF="$(date -u -d '90 days ago' +%Y%m%dT%H%M%SZ)"
  VERSION_DIRS="$(rclone lsf "HS_DEST:${OBJECT_STORAGE_BACKUP_BUCKET}/objects/versions" \
    --dirs-only --fast-list)"
  while IFS= read -r VERSION_DIR; do
    VERSION_DIR="${VERSION_DIR%/}"
    [[ "$VERSION_DIR" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || continue
    if [[ "$VERSION_DIR" < "$CUTOFF" ]]; then
      rclone purge "HS_DEST:${OBJECT_STORAGE_BACKUP_BUCKET}/objects/versions/${VERSION_DIR}" \
        --fast-list --stats=0
    fi
  done <<< "$VERSION_DIRS"
else
  COORDINATOR_DIR="$ROOT/coordinator"
  LEDGER="$COORDINATOR_DIR/data/relay-ledger.sqlite"
  rm -f -- "$SNAPSHOT"

  PATHS=("$COORDINATOR_DIR/.env" "$COORDINATOR_DIR/config")
  if [[ -f "$LEDGER" ]]; then
    sqlite3 "$LEDGER" ".backup '$SNAPSHOT'"
    test -s "$SNAPSHOT"
    PATHS=("$SNAPSHOT" "${PATHS[@]}")
  fi
  [[ ! -d "$COORDINATOR_DIR/data/acme" ]] || PATHS+=("$COORDINATOR_DIR/data/acme")
  restic backup "${PATHS[@]}" --tag hypershield --tag coordinator
fi

restic forget --tag "$ROLE" --keep-daily 7 --keep-weekly 4 --keep-monthly 3 --prune
echo "HyperShield $ROLE backup completed successfully."
