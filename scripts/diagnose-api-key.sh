#!/bin/sh
# Full diagnosis of API key persistence issue

echo "=== LateDev Router API Key Diagnosis ==="
echo ""

DATA_DIR="${LATEDEV_DATA_DIR:-/data}"
DB_FILE="${DATA_DIR}/data.sqlite"

echo "1. Environment & Paths:"
echo "   LATEDEV_DATA_DIR: $DATA_DIR"
echo "   DB_FILE: $DB_FILE"
echo ""

echo "2. Database File Check:"
if [ -f "$DB_FILE" ]; then
    echo "   ✓ Exists: $(ls -lh $DB_FILE | awk '{print $5}')"

    # Check if it's readable/writable
    if [ -r "$DB_FILE" ] && [ -w "$DB_FILE" ]; then
        echo "   ✓ Readable/Writable"
    else
        echo "   ❌ Permission issues!"
        ls -la "$DB_FILE"
    fi
else
    echo "   ❌ NOT FOUND - data may be lost!"
    echo ""
    echo "Available files in $DATA_DIR:"
    ls -la "$DATA_DIR" 2>/dev/null || echo "   Directory doesn't exist!"
    exit 1
fi
echo ""

echo "3. SQLite Query (requires sqlite3):"
if command -v sqlite3 >/dev/null 2>&1; then
    echo "   Running queries..."

    # Total records
    TOTAL_KEYS=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM apiKeys;" 2>/dev/null)
    echo "   Total API keys in database: $TOTAL_KEYS"

    if [ "$TOTAL_KEYS" -eq 0 ]; then
        echo "   ⚠️ WARNING: No API keys found!"
        echo "   This explains 'Invalid API key' errors."
    else
        echo "   Recent keys:"
        sqlite3 "$DB_FILE" "SELECT id, name, enabled, createdAt FROM apiKeys ORDER BY createdAt DESC LIMIT 3;" 2>/dev/null
    fi

    echo ""
    echo "4. Checking for migration issues:"
    VERSION=$(sqlite3 "$DB_FILE" "SELECT schemaVersion FROM appSettings WHERE id=1;" 2>/dev/null)
    echo "   Schema version: ${VERSION:-(not set)}"

    echo ""
    echo "5. Table structure sanity check:"
    sqlite3 "$DB_FILE" ".schema apiKeys" 2>/dev/null | grep -E "(keyDigest|keySecret)" && echo "   ✓ keyDigest column exists"

else
    echo "   ⚠️ sqlite3 CLI not available"
    echo "   Install with: apk add sqlite3 (Alpine) or apt-get install sqlite3 (Debian)"
fi

echo ""
echo "6. Volume Mount Verification:"
echo "   From your host machine, run:"
echo "   docker inspect <container> | grep -A 5 'Source.*Mountpoint'"
echo "   Ensure it points to $DATA_DIR"
echo ""

echo "7. Recommendations:"
if [ "$TOTAL_KEYS" = "0" ]; then
    echo "   ⚠️ CRITICAL: Create new API key via admin UI"
    echo "   Or restore from backup if you have one"
elif [ "$VERSION" = "" ]; then
    echo "   ⚠️ Schema version missing - database may be corrupted"
    echo "   Consider restoring from backup"
else
    echo "   ✓ Database looks healthy"
    echo "   If API keys still don't work, check:"
    echo "   - Admin session expired?"
    echo "   - Master key matches between restarts?"
    echo "   - Logs for specific error messages"
fi

echo ""
echo "Done! Run these commands on your VPS:"
echo "  docker exec latedev-router /bin/sh -c 'apk add sqlite3 > /dev/null 2>&1; sh /scripts/quick-check-db.sh'"
echo ""
