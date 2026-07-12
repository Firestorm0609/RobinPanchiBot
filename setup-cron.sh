#!/usr/bin/env bash
# Installs the daily backup cron job for THIS bot instance.
# Run once, from the bot's directory:  ./setup-cron.sh
#
# Idempotent per-directory: the cron marker is derived from this instance's
# own path, so cloning the bot into a second folder and running this again
# installs a SEPARATE cron entry instead of silently detecting the first
# instance's marker and skipping.

set -euo pipefail
cd "$(dirname "$0")"
BOT_DIR="$(pwd)"
# Marker is unique per bot directory (not a fixed string) — this is the fix:
# previously every clone shared the same "# panchi-bot-backup" marker, so a
# second instance's setup-cron.sh would see the first instance's marker
# already in the crontab and skip installing its own job entirely.
MARKER="# panchi-bot-backup: $BOT_DIR"
CRON_LINE="0 3 * * * cd $BOT_DIR && ./backup.sh >> backup.log 2>&1"

if [ ! -x "./backup.sh" ]; then
  echo "backup.sh not found or not executable in $BOT_DIR — aborting." >&2
  exit 1
fi

if ! grep -q "BACKUP_PASSPHRASE" .env 2>/dev/null; then
  echo "WARNING: BACKUP_PASSPHRASE not found in .env — backup.sh will fail until you set it." >&2
fi

EXISTING_CRON=$(crontab -l 2>/dev/null || true)

if echo "$EXISTING_CRON" | grep -qF "$MARKER"; then
  echo "Cron job already installed for $BOT_DIR. Nothing to do."
  exit 0
fi

{
  echo "$EXISTING_CRON"
  echo "$MARKER"
  echo "$CRON_LINE"
} | crontab -

echo "Installed daily backup cron job (3am) for $BOT_DIR:"
echo "  $CRON_LINE"
echo ""
echo "IMPORTANT: this only backs up locally to ./backups/. You still need an"
echo "off-VPS copy — uncomment and configure the rclone or scp line at the"
echo "bottom of backup.sh, or if this VPS disk dies, your backups die with it."
