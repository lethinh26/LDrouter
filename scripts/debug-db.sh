#!/bin/bash
# Debug script to check if database and API keys exist on VPS

echo "=== LateDev Router Database Debug ==="
echo ""

# Check if SQLite is installed
if command -v sqlite3 &> /dev/null; then
    echo "✓ SQLite3 found"
else
    echo "✗ SQLite3 not found - using node to inspect"
fi

DB_FILE="/data/data.sqlite"

# Check if DB file exists
if [ -f "$DB_FILE" ]; then
    echo "✓ Database file exists at: $DB_FILE"

    # Get file size
    SIZE=$(ls -lh "$DB_FILE" | awk '{print $5}')
    echo "  Size: $SIZE"

    # Check if we can read it (requires sqlite3)
    if command -v sqlite3 &> /dev/null; then
        echo ""
        echo "=== Tables ==="
        sqlite3 "$DB_FILE" ".tables"

        echo ""
        echo "=== API Keys Count ==="
        COUNT=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM apiKeys;" 2>/dev/null || echo "ERROR")
        echo "Total API keys: $COUNT"

        if [ "$COUNT" -gt 0 ]; then
            echo ""
            echo "=== API Key Names ==="
            sqlite3 "$DB_FILE" "SELECT id, name, enabled, expiresAt FROM apiKeys;" 2>/dev/null

            echo ""
            echo "=== API Key Digests (SHA-256 hashes) ==="
            sqlite3 "$DB_FILE" "SELECT id, substr(keyDigest, 1, 16) || '...' as digest FROM apiKeys;" 2>/dev/null
        fi

        echo ""
        echo "=== Providers Count ==="
        PROVIDERS=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM providers;" 2>/dev/null || echo "ERROR")
        echo "Total providers: $PROVIDERS"

        echo ""
        echo "=== Models Count ==="
        MODELS=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM models;" 2>/dev/null || echo "ERROR")
        echo "Total models: $MODELS"

        echo ""
        echo "=== Admin Account ==="
        ADMIN=$(sqlite3 "$DB_FILE" "SELECT username FROM adminAccount;" 2>/dev/null || echo "NOT FOUND")
        echo "Admin account: $ADMIN"

        echo ""
        echo "=== Settings ==="
        sqlite3 "$DB_FILE" "SELECT * FROM appSettings LIMIT 1;" 2>/dev/null
    else
        echo "Cannot query database without sqlite3 CLI"
    fi
else
    echo "✗ Database file NOT FOUND at: $DB_FILE"
    echo ""
    echo "Checking /data directory:"
    ls -la /data/ 2>/dev/null || echo "/data directory doesn't exist!"
fi

echo ""
echo "=== Environment Variables ==="
echo "LATEDEV_DATA_DIR: ${LATEDEV_DATA_DIR:-(not set)}"
echo "LATEDEV_MASTER_KEY: ${LATEDEV_MASTER_KEY:+SET (hidden)}"

echo ""
echo "Done!"
