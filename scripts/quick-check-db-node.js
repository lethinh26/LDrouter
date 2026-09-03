#!/usr/bin/env node
/* global console, process */
/* eslint-disable no-console */

import { getDb } from './src/server/db/index.js';
import * as schema from './src/server/db/schema.js';

const db = getDb();

console.log('=== Quick API Key Check ===\n');

try {
    const keys = db.select().from(schema.apiKeys).all();
    const providers = db.select().from(schema.providers).all();
    const models = db.select().from(schema.models).all();

    console.log(`API Keys: ${keys.length}`);
    if (keys.length > 0) {
        console.log('\nRecent keys:');
        keys.slice(-5).forEach(k => {
            console.log(`  - ${k.name}: enabled=${k.enabled}, prefix=${k.keyPrefix}`);
        });
    } else {
        console.log('\n⚠️ NO API KEYS FOUND! Create one via admin UI.');
    }

    console.log(`\nProviders: ${providers.length}`);
    console.log(`Models: ${models.length}`);

} catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
}
