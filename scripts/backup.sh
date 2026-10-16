#!/bin/sh
# Back up the database and the uploads it points at, as one pair.
#   scripts/backup.sh [target-dir]        (default: ./backups)
# Writes <target>/<stamp>/declutter.sql (db/backup.mjs, DATABASE_URL from .env)
# and copies uploads/ into <target>/uploads/. The uploads copy never deletes,
# so every SQL snapshot in <target> still finds its photos.
# Restore: mysql <db> < <target>/<stamp>/declutter.sql; rsync -a <target>/uploads/ uploads/
set -eu

cd "$(dirname "$0")/.."
target="${1:-backups}"
stamp="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$target/$stamp" "$target/uploads"

node db/backup.mjs "$target/$stamp/declutter.sql"
if [ -d uploads ]; then
  if command -v rsync >/dev/null 2>&1; then
    rsync -a uploads/ "$target/uploads/"
  else
    cp -Rp uploads/. "$target/uploads/"
  fi
fi
echo "backup: $target/$stamp/declutter.sql + $target/uploads/ ($(du -sh "$target/uploads" | cut -f1))"
