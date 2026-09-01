// Migration runner for LateDev Router.
// Migrations are raw SQL files in /migrations, applied in version order.

import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

interface MigrationFile {
  version: number;
  name: string;
  sql: string;
}

export function runMigrations(raw: Database.Database, log: Logger, migrationsDir: string): void {
  // Ensure migration tracking table
  raw.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  const applied = new Set(
    (raw.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version)
  );

  if (!fs.existsSync(migrationsDir)) {
    log.warn({ migrationsDir }, 'migrations directory missing — assuming fresh schema bootstrap');
    // Create the table schema directly as a single bootstrap migration.
    const bootstrap = generateBootstrapMigration();
    raw.exec(bootstrap.sql);
    raw.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(bootstrap.version, bootstrap.name);
    ensureSettingsRow(raw, log);
    log.info({ version: bootstrap.version }, 'applied bootstrap migration');
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

  const parsed: MigrationFile[] = files.map((f) => {
    const full = path.join(migrationsDir, f);
    const sql = fs.readFileSync(full, 'utf8');
    const ver = parseInt(f.split('_')[0] ?? '0', 10);
    return { version: ver, name: f.replace(/^\d+_/, '').replace(/\.sql$/, ''), sql };
  });

  // Always ensure a version 1 bootstrap exists on fresh databases
  if (!parsed.some((m) => m.version === 1) && applied.size === 0) {
    const bootstrap = generateBootstrapMigration();
    parsed.unshift(bootstrap);
  }

  for (const m of parsed) {
    if (applied.has(m.version)) continue;
    log.info({ version: m.version, name: m.name }, 'applying migration');
    const tx = raw.transaction(() => {
      raw.exec(m.sql);
      raw.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
    });
    tx();
  }

  ensureSettingsRow(raw, log);
}

function ensureSettingsRow(raw: Database.Database, log: Logger): void {
  const row = raw.prepare('SELECT id FROM app_settings WHERE id = 1').get() as { id: number } | undefined;
  if (!row) {
    raw.prepare('INSERT INTO app_settings (id) VALUES (1)').run();
    log.info('initialized app_settings row');
  }
}

function generateBootstrapMigration(): MigrationFile {
  // The complete bootstrap SQL. Version 1 contains the entire initial schema;
  // subsequent migrations (0002+) are loaded from the migrations folder and
  // applied on top. Keeping this at version 1 (not SCHEMA_VERSION) matters:
  // file migrations use the same 1-based numbering, so a bootstrap stamped
  // with a higher version would block the real file migrations.
  const schemaSql = buildInitialSchemaSql();
  return {
    version: 1,
    name: 'initial_schema',
    sql: schemaSql,
  };
}

function buildInitialSchemaSql(): string {
  // The full DDL — every table, index, and pragma setting we need.
  return `
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY,
      setup_complete INTEGER NOT NULL DEFAULT 0,
      retention_days INTEGER NOT NULL DEFAULT 30,
      content_log_mode TEXT NOT NULL DEFAULT 'metadata',
      db_size_limit_mb INTEGER NOT NULL DEFAULT 2048,
      trust_proxy_hops INTEGER NOT NULL DEFAULT 0,
      schema_version INTEGER NOT NULL DEFAULT 0,
      app_version TEXT NOT NULL DEFAULT '0.0.0',
      gateway_cache_enabled INTEGER NOT NULL DEFAULT 0,
      gateway_cache_default_ttl_seconds INTEGER NOT NULL DEFAULT 300,
      gateway_cache_max_size_mb INTEGER NOT NULL DEFAULT 256,
      master_key_version INTEGER NOT NULL DEFAULT 1,
      master_key_configured INTEGER NOT NULL DEFAULT 0,
      notifications_enabled INTEGER NOT NULL DEFAULT 1,
      notification_sound_enabled INTEGER NOT NULL DEFAULT 1,
      admin_ip_allow TEXT,
      admin_ip_block TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS admin_account (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      totp_secret_encrypted TEXT,
      totp_secret_nonce TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS admin_recovery_codes (
      id TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL REFERENCES admin_account(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_recovery_admin ON admin_recovery_codes(admin_id);

    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      token_digest TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      ip TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_session_expires ON admin_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS login_attempts (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      ip TEXT NOT NULL,
      success INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_login_user_time ON login_attempts(username, created_at);
    CREATE INDEX IF NOT EXISTS idx_login_ip_time ON login_attempts(ip, created_at);

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK (type IN ('openai','anthropic')),
      base_url TEXT NOT NULL,
      encrypted_api_key TEXT NOT NULL,
      api_key_nonce TEXT NOT NULL,
      api_key_version INTEGER NOT NULL DEFAULT 1,
      custom_headers_encrypted TEXT,
      custom_headers_nonce TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      connect_timeout_ms INTEGER NOT NULL DEFAULT 10000,
      first_token_timeout_ms INTEGER NOT NULL DEFAULT 30000,
      stream_idle_timeout_ms INTEGER NOT NULL DEFAULT 60000,
      total_timeout_ms INTEGER NOT NULL DEFAULT 180000,
      max_retries INTEGER NOT NULL DEFAULT 2,
      retry_base_ms INTEGER NOT NULL DEFAULT 500,
      retry_max_ms INTEGER NOT NULL DEFAULT 8000,
      cb_failure_threshold INTEGER NOT NULL DEFAULT 5,
      cb_cooldown_seconds INTEGER NOT NULL DEFAULT 60,
      health_state TEXT NOT NULL DEFAULT 'unknown' CHECK (health_state IN ('healthy','degraded','down','circuit_open','unknown')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
      upstream_model_id TEXT NOT NULL,
      public_model_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      upstream_available INTEGER NOT NULL DEFAULT 1,
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      max_context_tokens INTEGER,
      max_output_tokens INTEGER,
      discovered_metadata_json TEXT,
      cache_override_enabled INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_seen_upstream_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_model_public ON models(public_model_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_provider_upstream ON models(provider_id, upstream_model_id);
    CREATE INDEX IF NOT EXISTS idx_model_enabled ON models(enabled);

    CREATE TABLE IF NOT EXISTS combos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      public_model_id TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL CHECK (mode IN ('fallback','weighted_round_robin')),
      enabled INTEGER NOT NULL DEFAULT 1,
      max_total_attempts INTEGER NOT NULL DEFAULT 3,
      fallback_on_connection INTEGER NOT NULL DEFAULT 1,
      fallback_on_connect_timeout INTEGER NOT NULL DEFAULT 1,
      fallback_on_first_token_timeout INTEGER NOT NULL DEFAULT 1,
      fallback_on_408 INTEGER NOT NULL DEFAULT 1,
      fallback_on_429 INTEGER NOT NULL DEFAULT 1,
      fallback_on_5xx INTEGER NOT NULL DEFAULT 1,
      cache_override_enabled INTEGER,
      config_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS combo_members (
      id TEXT PRIMARY KEY,
      combo_id TEXT NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL,
      weight INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_combo_model ON combo_members(combo_id, model_id);
    CREATE INDEX IF NOT EXISTS idx_combo_pos ON combo_members(combo_id, position);

    CREATE TABLE IF NOT EXISTS model_aliases (
      id TEXT PRIMARY KEY,
      alias TEXT NOT NULL UNIQUE,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('model','combo')),
      target_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_digest TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      rpm_limit INTEGER,
      tpm_limit INTEGER,
      daily_token_limit INTEGER,
      monthly_token_limit INTEGER,
      max_concurrent INTEGER,
      max_output_tokens_per_request INTEGER,
      allow_all_models INTEGER NOT NULL DEFAULT 0,
      cache_override_enabled INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_key_prefix ON api_keys(key_prefix);

    CREATE TABLE IF NOT EXISTS api_key_model_permissions (
      id TEXT PRIMARY KEY,
      api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('model','combo','alias')),
      target_id TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_key_target ON api_key_model_permissions(api_key_id, target_kind, target_id);

    CREATE TABLE IF NOT EXISTS api_key_ip_rules (
      id TEXT PRIMARY KEY,
      api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('allow','deny')),
      cidr TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ip_rule_key ON api_key_ip_rules(api_key_id);

    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      completed_at TEXT,
      api_key_id TEXT,
      key_prefix_snapshot TEXT,
      client_ip TEXT NOT NULL,
      protocol TEXT NOT NULL CHECK (protocol IN ('openai','anthropic')),
      endpoint TEXT NOT NULL,
      requested_model TEXT NOT NULL,
      resolved_target_kind TEXT NOT NULL CHECK (resolved_target_kind IN ('model','combo','alias','unknown')),
      resolved_target_id TEXT,
      final_model_id TEXT,
      streaming INTEGER NOT NULL,
      http_status INTEGER NOT NULL,
      success INTEGER NOT NULL,
      total_latency_ms INTEGER NOT NULL DEFAULT 0,
      ttft_ms INTEGER,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      attempts_count INTEGER NOT NULL DEFAULT 0,
      error_type TEXT,
      error_message TEXT,
      request_payload_json TEXT,
      response_payload_json TEXT,
      gateway_cache_hit INTEGER NOT NULL DEFAULT 0,
      partial_stream INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_request_created ON requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_request_success ON requests(success, created_at);
    CREATE INDEX IF NOT EXISTS idx_request_apikey ON requests(api_key_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_request_final_model ON requests(final_model_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_request_requested ON requests(requested_model, created_at);
    CREATE INDEX IF NOT EXISTS idx_request_protocol ON requests(protocol, created_at);

    CREATE TABLE IF NOT EXISTS request_attempts (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status_code INTEGER,
      success INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      ttft_ms INTEGER,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      stream_started INTEGER NOT NULL DEFAULT 0,
      partial_response INTEGER NOT NULL DEFAULT 0,
      selection_reason TEXT NOT NULL,
      failure_reason TEXT,
      error_message TEXT,
      upstream_request_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_attempt_request ON request_attempts(request_id, attempt_number);
    CREATE INDEX IF NOT EXISTS idx_attempt_provider_model ON request_attempts(provider_id, model_id, started_at);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      action TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'admin',
      ip TEXT,
      success INTEGER NOT NULL,
      target_type TEXT,
      target_id TEXT,
      target_name TEXT,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at);

    CREATE TABLE IF NOT EXISTS response_cache (
      id TEXT PRIMARY KEY,
      cache_key TEXT NOT NULL UNIQUE,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('model','combo','alias')),
      target_id TEXT NOT NULL,
      target_config_version INTEGER NOT NULL DEFAULT 1,
      protocol TEXT NOT NULL CHECK (protocol IN ('openai','anthropic')),
      response_json TEXT NOT NULL,
      usage_json TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      expires_at TEXT NOT NULL,
      last_hit_at TEXT,
      hit_count INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_cache_expires ON response_cache(expires_at);
    CREATE INDEX IF NOT EXISTS idx_cache_target ON response_cache(target_kind, target_id);

    CREATE TABLE IF NOT EXISTS usage_daily (
      day TEXT NOT NULL,
      api_key_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_usage_day_key ON usage_daily(day, api_key_id);

    CREATE TABLE IF NOT EXISTS usage_monthly (
      month TEXT NOT NULL,
      api_key_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_usage_month_key ON usage_monthly(month, api_key_id);

    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      schema_version INTEGER NOT NULL,
      app_version TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      path TEXT NOT NULL,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS csrf_tokens (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      token TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_csrf_session ON csrf_tokens(session_id);
    CREATE INDEX IF NOT EXISTS idx_csrf_expires ON csrf_tokens(expires_at);
  `;
}

export function checksumOfBuffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Public so migration tooling can dump the bootstrap as a real SQL file
// (single source of truth with the fresh-schema bootstrap path).
export function buildBootstrapMigrationSql(): string {
  return buildInitialSchemaSql();
}
