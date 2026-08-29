// Regenerate migrations/0001_initial_schema.sql from the single source of truth.
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildBootstrapMigrationSql } from '../src/server/db/migrate';

mkdirSync('migrations', { recursive: true });
writeFileSync('migrations/0001_initial_schema.sql', buildBootstrapMigrationSql().trim() + '\n');
console.log('migrations/0001_initial_schema.sql regenerated');