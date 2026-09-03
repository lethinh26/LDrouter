#!/bin/sh
# Quick database check - runs inside container without Node.js

DB_FILE="${DATA_DIR:-/data}/data.sqlite"

if [ ! -f "$DB_FILE" ]; then
    echo "❌ Database NOT found at $DB_FILE"
    echo "Check your Docker volume mount!"
    exit 1
fi

echo "✓ Database found: $DB_FILE ($(ls -lh $DB_FILE | awk '{print $5}'))"
echo ""

# Check table count (requires sqlite3)
if command -v sqlite3 >/dev/null 2>&1; then
    echo "📊 Tables in database:"
    echo ""

    echo "API Keys:"
    COUNT=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM apiKeys;" 2>/dev/null || echo "ERROR")
    echo "  Total: $COUNT"

    if [ "$COUNT" -gt 0 ]; then
        echo ""
        echo "Recent API keys (last 5):"
        sqlite3 "$DB_FILE" -header -column "SELECT id, name, enabled, substr(keyDigest,1,8) || '...' as digest_prefix FROM apiKeys ORDER BY createdAt DESC LIMIT 5;" 2>/dev/null

        # Check for any missing keyDigest
        MISSING=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM apiKeys WHERE keyDigest IS NULL OR keyDigest = '';" 2>/dev/null)
        if [ "$MISSING" -gt 0 ]; then
            echo ""
            echo "⚠️ WARNING: $MISSING keys have missing keyDigest!"
        fi
    fi

    echo ""
    echo "Providers:"
    sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM providers;" 2>/dev/null | while read count; do echo "  Total: $count"; done

    echo ""
    echo "Models:"
    sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM models;" 2>/dev/null | while read count; do echo "  Total: $count"; done

else
    echo "⚠️ sqlite3 not installed - cannot query database"
    echo "Try: docker exec latedev-router apt-get update && apt-get install -y sqlite3"
fi

echo ""
echo "Done!"
