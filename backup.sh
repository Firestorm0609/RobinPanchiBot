#!/usr/bin/env bash
# Encrypted backup of the bot's SQLite database.
# Usage: ./backup.sh
# Cron (daily at 3am):  0 3 * * * cd /path/to/bot && ./backup.sh >> backup.log 2>&1
#
# Requires: sqlite3 CLI, gpg
# Set BACKUP_PASSPHRASE in your .env (a long random string, NOT the same as MASTER_KEY).

set -euo pipefail
cd "$(dirname "$0")"
set -a; source .env; set +a

DB_PATH="data/panchi.sqlite"
BACKUP_DIR="backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SNAPSHOT="$BACKUP_DIR/panchi_${TIMESTAMP}.sqlite"
ENCRYPTED="${SNAPSHOT}.gpg"

if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "BACKUP_PASSPHRASE not set in .env — aborting." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# Use sqlite3's own .backup command (safe on a live WAL-mode DB, unlike a raw cp)
sqlite3 "$DB_PATH" ".backup '$SNAPSHOT'"

# Encrypt with a symmetric passphrase (AES256)
gpg --batch --yes --passphrase "$BACKUP_PASSPHRASE" --symmetric --cipher-algo AES256 -o "$ENCRYPTED" "$SNAPSHOT"
rm "$SNAPSHOT" # don't leave an unencrypted copy on disk

echo "Backup written to $ENCRYPTED"

# ---- Off-VPS copy (pick one, uncomment and configure) ----
# rclone copy "$ENCRYPTED" remote:panchi-backups/
# scp "$ENCRYPTED" user@backup-host:/backups/panchi/

# Keep only the last 30 local encrypted backups
ls -1t "$BACKUP_DIR"/*.gpg 2>/dev/null | tail -n +31 | xargs -r rm --
