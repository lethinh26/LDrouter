#!/bin/sh
set -e

DATA_DIR="/data"
DB_FILE="${DATA_DIR}/data.sqlite"

# On container restart/start, clean stale SQLite WAL files that may have been
# left over from the previous container instance. These files keep the old
# database state in memory and can cause data to appear "lost" after a restore.
if [ -f "$DB_FILE" ]; then
  # Check for and remove stale WAL/SHM files if they exist
  if [ -f "${DB_FILE}-wal" ]; then
    rm -f "${DB_FILE}-wal"
    echo "Removed stale WAL file"
  fi
  if [ -f "${DB_FILE}-shm" ]; then
    rm -f "${DB_FILE}-shm"
    echo "Removed stale SHM file"
  fi

  # Force checkpoint the current DB to ensure all data is in the main file
  # This prevents any uncommitted transaction data from being lost
  sqlite3 "$DB_FILE" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true
fi

exec node dist/cli.js "$@"
