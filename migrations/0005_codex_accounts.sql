-- 0005_codex_accounts.sql
-- Rebuild the provider graph without retargeting child foreign keys to legacy tables.
-- SQLite rewrites REFERENCES providers to providers_legacy when providers is renamed;
-- rebuild the dependent graph in dependency order instead of disabling enforcement.
ALTER TABLE combo_members RENAME TO combo_members_legacy;
ALTER TABLE models RENAME TO models_legacy;
ALTER TABLE providers RENAME TO providers_legacy;

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('openai','anthropic','codex')),
  base_url TEXT NOT NULL,
  encrypted_api_key TEXT,
  api_key_nonce TEXT,
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
INSERT INTO providers SELECT * FROM providers_legacy;

CREATE TABLE models (
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
INSERT INTO models SELECT * FROM models_legacy;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_model_public ON models(public_model_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_provider_upstream ON models(provider_id, upstream_model_id);
CREATE INDEX IF NOT EXISTS idx_model_enabled ON models(enabled);

CREATE TABLE combo_members (
  id TEXT PRIMARY KEY,
  combo_id TEXT NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1
);
INSERT INTO combo_members SELECT * FROM combo_members_legacy;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_combo_model ON combo_members(combo_id, model_id);
CREATE INDEX IF NOT EXISTS idx_combo_pos ON combo_members(combo_id, position);

DROP TABLE combo_members_legacy;
DROP TABLE models_legacy;
DROP TABLE providers_legacy;

CREATE TABLE codex_accounts (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  email TEXT,
  workspace_id TEXT,
  chatgpt_account_id TEXT,
  plan_type TEXT,
  encrypted_access_token TEXT NOT NULL,
  access_token_nonce TEXT NOT NULL,
  access_token_version INTEGER NOT NULL DEFAULT 1,
  encrypted_refresh_token TEXT NOT NULL,
  refresh_token_nonce TEXT NOT NULL,
  refresh_token_version INTEGER NOT NULL DEFAULT 1,
  encrypted_id_token TEXT,
  id_token_nonce TEXT,
  id_token_version INTEGER NOT NULL DEFAULT 1,
  token_expires_at TEXT NOT NULL,
  last_refresh_at TEXT,
  auth_method TEXT NOT NULL DEFAULT 'oauth' CHECK (auth_method IN ('oauth','access_token')),
  enabled INTEGER NOT NULL DEFAULT 1,
  health_state TEXT NOT NULL DEFAULT 'unknown' CHECK (health_state IN ('healthy','degraded','down','unknown')),
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_codex_account_provider_enabled_priority ON codex_accounts(provider_id, enabled, priority);
CREATE INDEX idx_codex_account_provider_email ON codex_accounts(provider_id, email);
CREATE INDEX idx_codex_account_provider_chatgpt ON codex_accounts(provider_id, chatgpt_account_id);
ALTER TABLE request_attempts ADD COLUMN codex_account_id TEXT REFERENCES codex_accounts(id) ON DELETE SET NULL;
CREATE INDEX idx_attempt_codex_account ON request_attempts(codex_account_id, started_at);
