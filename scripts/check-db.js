#!/usr/bin/env node
/**
 * Debug script to verify database and API keys are accessible
 * Run inside running container: docker exec latedev-router /bin/sh -c 'node /app/scripts/check-db.js'
 * Or copy to VPS and run directly
 */

import { getDb } from './src/server/db/index.js';
import { eq, sql } from 'drizzle-orm';
import * as schema from './src/server/db/schema.js';
import fs from 'fs';

const DATA_DIR = process.env.LATEDEV_DATA_DIR || '/data';
const DB_FILE = process.env.LATEDEV_DB_URL || `${DATA_DIR}/data.sqlite`;

console.log('=== LateDev Router Database Checker ===\n');

// Check database file exists
if (!fs.existsSync(DB_FILE)) {
    console.error(`❌ Database file NOT FOUND: ${DB_FILE}`);
    console.log('\nCheck your Docker volume mount!');
    console.log('Your docker-compose.yml should have:');
    console.log('  volumes:');
    console.log('    - latedev-router-data:/data');
    console.log('\nOr bind mount:');
    console.log('  - /path/to/data:/data');
    process.exit(1);
}

console.log(`✓ Database file: ${DB_FILE}`);
console.log(`✓ File size: ${fs.statSync(DB_FILE).size} bytes\n`);

try {
    const db = getDb();

    // Count records
    const apiKeyCount = db.select().from(schema.apiKeys).all().length;
    const providerCount = db.select().from(schema.providers).all().length;
    const modelCount = db.select().from(schema.models).all().length;

    console.log('📊 Record counts:');
    console.log(`  - API Keys: ${apiKeyCount}`);
    console.log(`  - Providers: ${providerCount}`);
    console.log(`  - Models: ${modelCount}\n`);

    if (apiKeyCount === 0) {
        console.error('❌ No API keys found in database!');
        console.log('   This explains why 9router gets "Invalid API key".');
        console.log('   You need to create an API key via admin UI or restore from backup.\n');
        process.exit(1);
    }

    // Show API key details
    console.log('🔑 API Key Details:');
    const apiKeys = db.select().from(schema.apiKeys).all();
    for (const key of apiKeys) {
        const digestPreview = key.keyDigest ? `${key.keyDigest.slice(0, 16)}...` : '(MISSING!)';
        console.log(`\n  ID: ${key.id}`);
        console.log(`  Name: ${key.name}`);
        console.log(`  Enabled: ${key.enabled ? '✅' : '❌'}`);
        console.log(`  Expires: ${key.expiresAt || 'never'}${key.expiresAt ? ' ≤ Now? ' + (new Date(key.expiresAt) < new Date() ? 'YES!' : 'NO') : ''}`);
        console.log(`  KeyPrefix: ${key.keyPrefix}`);
        console.log(`  KeyDigest: ${digestPreview}`);

        if (!key.keyDigest || key.keyDigest === '') {
            console.error('  ⚠️  WARNING: keyDigest is empty! This key will never authenticate!');
        }
    }

    // Check if any keys without digest
    const missingDigest = db.select().from(schema.apiKeys)
        .where(sql`keyDigest IS NULL OR keyDigest = ''`)
        .all();

    if (missingDigest.length > 0) {
        console.error(`\n❌ ${missingDigest.length} API keys are missing keyDigest!`);
        console.error('These keys cannot authenticate because they were not properly created.');
        console.error('You may need to recreate them or fix the database migration.\n');
        process.exit(1);
    }

    console.log('\n✅ All checks passed! Database looks healthy.\n');

} catch (err) {
    console.error('❌ Error reading database:', err.message);
    if (err.stack) {
        console.error(err.stack);
    }
    process.exit(1);
}
