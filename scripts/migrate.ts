// Standalone migration CLI.

import process from 'node:process';
import { loadConfig } from '../src/server/config/index';
import { openDb } from '../src/server/db/index';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const { db } = openDb(cfg.dbFile);
  void db;
   
  console.log(`Migrations applied. Database: ${cfg.dbFile}`);
}

main().catch((err) => {
   
  console.error('Migration error:', err);
  process.exit(1);
});
