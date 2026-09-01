#!/usr/bin/env bash
# Nightly SQLite backup, run from cron on the box (docs/deploy.md §2). Uses SQLite's own
# online backup through the running container, so the copy is consistent even mid-write.
# Keeps the last 14. NOTE: this lands on the same disk as the live file — copy the newest
# one off the box too (the runbook shows a one-line scp for that).
set -euo pipefail
cd "$HOME/letsmeet"
umask 077
mkdir -p backups
docker compose exec -T letsmeet node -e "
  require('better-sqlite3')('/data/letsmeet.db').backup('/data/backup.tmp')
    .then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })"
mv data/backup.tmp "backups/letsmeet-$(date +%F).db"
ls -1t backups/letsmeet-*.db | tail -n +15 | xargs -r rm --
