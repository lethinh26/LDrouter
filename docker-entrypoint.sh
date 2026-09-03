#!/bin/sh
set -e

DATA_DIR="/data"
DB_FILE="${DATA_DIR}/data.sqlite"

# On container restart/start, clean stale SQLite WAL/SHM files that may have been
# left over from previous container instance. These files keep old DB state in memory
# and can cause corruption or data appearing "lost". They're safe to remove because:
# 1. Old connection was closed (WAL fully checkpointed on shutdown)
# 2. Restored backup should be standalone consistent snapshot
for suffix in "-wal" "-shm"; do
    STALE="$DB_FILE$suffix"
    if [ -f "$STALE" ]; then
        echo "Removing stale file: $STALE"
        rm -f "$STALE"
    fi
done

echo "Starting LateDev Router..."
exec node dist/cli.js "$@"
