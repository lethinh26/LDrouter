// Migration runner for LateDev Router. SQL files are immutable and applied in order.
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CURRENT_SCHEMA_VERSION = 17;

interface MigrationFile {
  version: number;
  name: string;
  sql: string;
}

export function runMigrations(raw: Database.Database, log: Logger, migrationsDir: string, expectedVersion?: number): void {
  // Both fresh and existing databases use exactly the same migration assets.
  // Missing or partial assets must fail closed, never create an incompatible schema.
  if (!fs.existsSync(migrationsDir)) throw new Error('Database migrations directory missing');
  const parsed: MigrationFile[] = fs.readdirSync(migrationsDir)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort()
    .map((file) => ({
      version: Number.parseInt(file.split('_')[0] ?? '0', 10),
      name: file.replace(/^\d+_/, '').replace(/\.sql$/, ''),
      sql: fs.readFileSync(path.join(migrationsDir, file), 'utf8'),
    }));
  const latest = parsed.at(-1)?.version ?? 0;
  if (latest === 0 || parsed.some((migration, index) => migration.version !== index + 1)
      || (expectedVersion !== undefined && latest !== expectedVersion)) {
    throw new Error('Database migration assets are incomplete or incompatible');
  }

  raw.pragma('foreign_keys = ON');
  raw.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  const applied = (raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[])
    .map((row) => row.version);
  if (applied.some((version, index) => version !== index + 1 || version > latest)) {
    throw new Error('Database migration history is incomplete or newer than this application');
  }
  // Verify a claimed 0014 before any subsequent migration can change its DB.
  if (latest >= 14 && applied.includes(14)) assertRetiredProvidersRemoved(raw, parsed[13]!);
  if (latest >= 15 && applied.includes(15)) assertAdaptiveSchema(raw);
  if (latest >= 17 && applied.includes(17)) assertIntegrationSchema(raw, parsed[16]!);

  for (const migration of parsed.slice(applied.length)) {
    log.info({ version: migration.version, name: migration.name }, 'applying migration');
    const tx = raw.transaction(() => {
      raw.exec(migration.sql);
      // The destructive table rebuild must never be committed with invalid references.
      if (migration.version === 14) {
        assertRetiredProvidersRemoved(raw, migration);
        if (raw.prepare('PRAGMA foreign_key_check').all().length > 0) {
          throw new Error('Database migration produced invalid foreign keys');
        }
      }
      if (migration.version === 15) {
        assertAdaptiveSchema(raw);
        if (raw.prepare('PRAGMA foreign_key_check').all().length > 0) {
          throw new Error('Database migration produced invalid adaptive foreign keys');
        }
      }
      if (migration.version === 17) assertIntegrationSchema(raw, migration);
      raw.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(migration.version, migration.name);
    });
    tx.immediate();
  }

  raw.transaction(() => {
    ensureSettingsRow(raw, log);
    raw.prepare('UPDATE app_settings SET schema_version = ? WHERE id = 1').run(latest);
  })();
}

function assertIntegrationSchema(raw: Database.Database, migration: MigrationFile): void {
  const expected = migration.sql.match(/^CREATE TABLE provider_integrations \([\s\S]*?^\);/m)?.[0];
  const actual = raw.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='provider_integrations'").get() as { sql: string } | undefined;
  const normalize = (ddl: string) => ddl.replace(/\r\n/g, '\n').replace(/;$/, '');
  if (!expected || !actual?.sql || normalize(expected) !== normalize(actual.sql) ||
      raw.prepare('PRAGMA foreign_key_check(provider_integrations)').all().length > 0 ||
      raw.prepare(`SELECT 1 FROM provider_integrations i JOIN providers p ON p.id=i.provider_id
        WHERE NOT ((i.provider_kind='codex' AND i.auth_mode='client_oauth' AND p.type='openai'
          AND p.base_url='https://chatgpt.com' AND p.encrypted_api_key IS NULL AND p.api_key_nonce IS NULL
          AND p.custom_headers_encrypted IS NULL AND p.custom_headers_nonce IS NULL)
          OR (i.provider_kind='claude_code' AND i.auth_mode='api_key' AND p.type='anthropic'
          AND p.base_url='https://api.anthropic.com' AND p.encrypted_api_key IS NOT NULL AND p.api_key_nonce IS NOT NULL
          AND p.custom_headers_encrypted IS NULL AND p.custom_headers_nonce IS NULL)) LIMIT 1`).get()) {
    throw new Error('Database schema is inconsistent with provider integration migration (0017)');
  }
}

function assertAdaptiveSchema(raw: Database.Database): void {
  const names = new Set((raw.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as { name: string }[]).map(row => row.name.toLowerCase()));
  const columns = (table: string) => new Set((raw.prepare('SELECT name FROM pragma_table_xinfo(?)').all(table) as { name: string }[]).map(row => row.name));
  const requiredState = [
    'combo_id','member_id','model_id','workload','generation','samples_json','consecutive_slow_count',
    'relative_slow_count','degraded','comparator_model_id','probe_due_ms','probe_lease_until_ms',
    'probe_token','recovery_successes','probe_failures','last_latency_ms','last_outcome','updated_at_ms',
    'last_observation_ms','last_start_ms','last_start_sequence','baseline_latency_ms','suspect_count',
  ];
  const state = columns('combo_adaptive_states');
  const exploration = columns('combo_adaptive_exploration');
  if (names.has('combo_member_slow_states') || !names.has('combo_adaptive_states') ||
      !names.has('combo_adaptive_exploration') || !columns('combos').has('max_request_duration_seconds') ||
      requiredState.some(name => !state.has(name)) ||
      ['combo_id','workload','generation','next_due_ms'].some(name => !exploration.has(name))) {
    throw new Error('Database schema is inconsistent with adaptive combo migration (0015)');
  }
}

function assertRetiredProvidersRemoved(raw: Database.Database, migration: MigrationFile): void {
  const invalidSchema = () => new Error('Database schema is inconsistent with retired provider removal (0014)');
  const accountObjects = raw.prepare(
    "SELECT 1 FROM sqlite_schema WHERE name COLLATE NOCASE IN ('codex_accounts','qoder_accounts') LIMIT 1",
  ).get();
  const attemptColumns = (raw.prepare("PRAGMA table_xinfo('request_attempts')").all() as { name: string }[])
    .map(column => column.name.toLowerCase());
  if (accountObjects || !attemptColumns.includes('request_id') ||
      attemptColumns.includes('codex_account_id') || attemptColumns.includes('qoder_account_id')) {
    throw invalidSchema();
  }

  // SQLite has no CHECK-constraint introspection pragma. Compare the provider
  // table DDL to the immutable 0014 definition rather than trusting a substring
  // or probing it with writes. SQLite's ALTER TABLE RENAME quotes the new name;
  // normalize that and platform line endings, not the constraint expression.
  const expected = migration.sql.match(/^CREATE TABLE providers_next \([\s\S]*?^\);/m)?.[0];
  const actual = raw.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='providers'").get() as { sql: string } | undefined;
  const normalize = (ddl: string) => ddl.replace(/\r\n/g, '\n').replace(/;$/, '')
    .replace(/^CREATE TABLE (?:providers_next|"providers"|providers)(?=\s*\()/, 'CREATE TABLE providers');
  if (!expected || !actual?.sql || normalize(expected) !== normalize(actual.sql)) throw invalidSchema();
  if (raw.prepare("SELECT 1 FROM providers WHERE type IS NULL OR type NOT IN ('openai','anthropic') LIMIT 1").get()) {
    throw invalidSchema();
  }
}

function ensureSettingsRow(raw: Database.Database, log: Logger): void {
  const row = raw.prepare('SELECT id FROM app_settings WHERE id = 1').get() as { id: number } | undefined;
  if (!row) {
    raw.prepare('INSERT INTO app_settings (id) VALUES (1)').run();
    log.info('initialized app_settings row');
  }
}

export function checksumOfBuffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
