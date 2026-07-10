#!/usr/bin/env bash
# Installs the daily backup cron job for this bot instance.
# Run once, from the bot's directory:  ./setup-cron.sh
#
# Idempotent: re-running won't create duplicate entries.

set -euo pipefail
cd "$(dirname "$0")"
BOT_DIR="$(pwd)"
CRON_LINE="0 3 * * * cd $BOT_DIR && ./backup.sh >> backup.log 2>&1"
MARKER="# panchi-bot-backup"

if [ ! -x "./backup.sh" ]; then
  echo "backup.sh not found or not executable in $BOT_DIR — aborting." >&2
  exit 1
fi

if ! grep -q "BACKUP_PASSPHRASE" .env 2>/dev/null; then
  echo "WARNING: BACKUP_PASSPHRASE not found in .env — backup.sh will fail until you set it." >&2
fi

EXISTING_CRON=$(crontab -l 2>/dev/null || true)

if echo "$EXISTING_CRON" | grep -qF "$MARKER"; then
  echo "Cron job already installed. Nothing to do."
  exit 0
fi

{
  echo "$EXISTING_CRON"
  echo "$MARKER"
  echo "$CRON_LINE"
} | crontab -

echo "Installed daily backup cron job (3am):"
echo "  $CRON_LINE"
echo ""
echo "IMPORTANT: this only backs up locally to ./backups/. You still need an"
echo "off-VPS copy — uncomment and configure the rclone or scp line at the"
echo "bottom of backup.sh, or if this VPS disk dies, your backups die with it."
