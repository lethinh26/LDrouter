#!/bin/sh
set -e

# Docker entrypoint for LateDev Router
# Cleans up stale SQLite WAL/Shm files on startup to prevent data corruption

DATA_DIR="${LATEDEV_DATA_DIR:-/data}"
DB_FILE="${LATEDEV_DB_URL:-$DATA_DIR/data.sqlite}"

# Remove stale WAL and shared memory files from previous instances
# These can cause issues after container restarts or database restores
for suffix in "-wal" "-shm"; do
    STALE="$DB_FILE$suffix"
    if [ -f "$STALE" ]; then
        echo "Removing stale file: $STALE"
        rm -f "$STALE"
    fi
done

# Execute the main application
exec "$@"
