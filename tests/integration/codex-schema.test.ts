import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/server/db/migrate';
import { discoverProviderModels, probeProvider } from '../../src/server/providers';

const migrationsDir = path.resolve(process.cwd(), 'migrations');
const logger = { info() {}, warn() {} } as never;

describe('Codex schema migration', () => {
  it('fails closed for direct Codex probe and discovery seams', async () => {
    const cfg = {
      type: 'codex' as const,
      baseUrl: 'https://example.test',
      apiKey: '',
      customHeaders: {},
      connectTimeoutMs: 1000,
      totalTimeoutMs: 1000,
    };

    await expect(probeProvider(cfg)).resolves.toMatchObject({
      ok: false,
      detail: 'Codex providers require the Codex account adapter',
    });
    await expect(discoverProviderModels(cfg)).rejects.toThrow('Codex providers require the Codex account adapter');
  });

  it('creates codex accounts and nullable attempt account references on an empty database', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-codex-schema-')), 'test.db');
    const raw = new Database(dbPath);

    try {
      runMigrations(raw, logger, migrationsDir);

      expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_accounts'").get()).toBeTruthy();
      expect(raw.prepare("SELECT name FROM pragma_table_info('request_attempts') WHERE name = 'codex_account_id'").get()).toBeTruthy();
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_codex_account_provider_enabled_priority'").get()).toBeTruthy();
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_codex_account_provider_email'").get()).toBeTruthy();
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_codex_account_provider_chatgpt'").get()).toBeTruthy();

      const columns = raw.prepare(`SELECT name, "notnull" FROM pragma_table_info('codex_accounts')`).all() as { name: string; notnull: number }[];
      expect(columns.find((column) => column.name === 'encrypted_access_token')?.notnull).toBe(1);
      expect(columns.find((column) => column.name === 'encrypted_refresh_token')?.notnull).toBe(1);
      expect(columns.find((column) => column.name === 'encrypted_id_token')?.notnull).toBe(0);
      expect(raw.prepare(`SELECT "notnull" FROM pragma_table_info('request_attempts') WHERE name = 'codex_account_id'`).get()).toEqual({ notnull: 0 });
    } finally {
      raw.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it('upgrades an existing database while preserving provider graph data and foreign-key integrity', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-codex-upgrade-')), 'test.db');
    const raw = new Database(dbPath);

    try {
      const initialSchema = fs.readFileSync(path.join(migrationsDir, '0001_initial_schema.sql'), 'utf8');
      raw.exec(initialSchema);
      raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\')))');
      raw.prepare('INSERT INTO schema_migrations (version, name) VALUES (1, ?)').run('initial_schema');
      raw.prepare("INSERT INTO providers (id, name, slug, type, base_url, encrypted_api_key, api_key_nonce) VALUES ('provider-1', 'OpenAI', 'openai', 'openai', 'https://example.test', 'encrypted', 'nonce')").run();
      raw.prepare("INSERT INTO models (id, provider_id, upstream_model_id, public_model_id, display_name) VALUES ('model-1', 'provider-1', 'gpt-test', 'openai/gpt-test', 'GPT Test')").run();
      raw.prepare("INSERT INTO requests (id, client_ip, protocol, endpoint, requested_model, resolved_target_kind, streaming, http_status, success) VALUES ('request-1', '127.0.0.1', 'openai', '/v1/chat/completions', 'openai/gpt-test', 'model', 0, 200, 1)").run();
      raw.prepare("INSERT INTO request_attempts (id, request_id, provider_id, model_id, attempt_number, started_at, success, selection_reason) VALUES ('attempt-1', 'request-1', 'provider-1', 'model-1', 1, '2026-09-12T00:00:00Z', 1, 'test')").run();

      runMigrations(raw, logger, migrationsDir);

      expect(raw.prepare('SELECT name FROM providers WHERE id = ?').get('provider-1')).toEqual({ name: 'OpenAI' });
      expect(raw.prepare('SELECT provider_id FROM models WHERE id = ?').get('model-1')).toEqual({ provider_id: 'provider-1' });
      expect(raw.prepare('SELECT request_id, provider_id, model_id FROM request_attempts WHERE id = ?').get('attempt-1')).toEqual({ request_id: 'request-1', provider_id: 'provider-1', model_id: 'model-1' });
      expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      raw.prepare("INSERT INTO providers (id, name, slug, type, base_url) VALUES ('codex-provider', 'Codex', 'codex', 'codex', 'https://example.test')").run();
      expect(raw.prepare('SELECT type FROM providers WHERE id = ?').get('codex-provider')).toEqual({ type: 'codex' });
    } finally {
      raw.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it('allows a Codex provider without an API key while retaining required API keys for existing providers', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'latedev-codex-provider-')), 'test.db');
    const raw = new Database(dbPath);

    try {
      runMigrations(raw, logger, migrationsDir);
      raw.prepare("INSERT INTO providers (id, name, slug, type, base_url, api_key_nonce) VALUES (?, ?, ?, 'codex', ?, ?)").run('codex-1', 'Codex', 'codex', 'https://example.test', '');
      expect(raw.prepare('SELECT type, encrypted_api_key FROM providers WHERE id = ?').get('codex-1')).toMatchObject({ type: 'codex', encrypted_api_key: null });
      expect(raw.prepare("INSERT INTO providers (id, name, slug, type, base_url, encrypted_api_key, api_key_nonce) VALUES (?, ?, ?, 'openai', ?, ?, ?)").run('openai-1', 'OpenAI', 'openai', 'https://example.test', 'encrypted', 'nonce')).toBeTruthy();
      expect(raw.prepare("SELECT type FROM providers WHERE id = 'openai-1'").get()).toEqual({ type: 'openai' });
    } finally {
      raw.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});
