-- 0007_qoder_accounts.sql
-- Widen the provider type CHECK for 'qoder' and add the Qoder account pool.
-- Rebuilt in dependency order for the same reason as 0005: renaming `providers`
-- retargets child foreign keys to `providers_legacy`, so the whole dependent graph
-- is rebuilt rather than disabling enforcement.
-- `codex_accounts` is part of that graph: it holds REFERENCES providers(id), so the
-- rename would repoint it at providers_legacy (which this file then drops), leaving it
-- referencing a missing table. 0005 could leave it alone only because 0005 created it.
-- `request_attempts` too: it holds REFERENCES codex_accounts.
--
-- Statement order is deliberate. The legacy tables are dropped before any index is
-- (re)created: a rename carries the table's indexes along under their original names,
-- so `CREATE INDEX IF NOT EXISTS` would be a no-op and the DROP would then take the
-- index with the legacy table.
ALTER TABLE request_attempts RENAME TO request_attempts_legacy;
ALTER TABLE combo_members RENAME TO combo_members_legacy;
ALTER TABLE models RENAME TO models_legacy;
ALTER TABLE codex_accounts RENAME TO codex_accounts_legacy;
ALTER TABLE providers RENAME TO providers_legacy;

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('openai','anthropic','codex','qoder')),
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

CREATE TABLE combo_members (
  id TEXT PRIMARY KEY,
  combo_id TEXT NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1
);
INSERT INTO combo_members SELECT * FROM combo_members_legacy;

-- Column list is explicit here because 0006 appended the usage columns after
-- created_at/updated_at, so `SELECT *` cannot carry them across.
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
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  codex_usage_json TEXT,
  codex_usage_updated_at TEXT,
  codex_usage_error TEXT,
  codex_autostart_enabled INTEGER NOT NULL DEFAULT 0,
  last_pinged_reset_at TEXT,
  last_pinged_reset_key TEXT,
  last_ping_at TEXT
);
INSERT INTO codex_accounts (
  id, provider_id, email, workspace_id, chatgpt_account_id, plan_type,
  encrypted_access_token, access_token_nonce, access_token_version,
  encrypted_refresh_token, refresh_token_nonce, refresh_token_version,
  encrypted_id_token, id_token_nonce, id_token_version, token_expires_at, last_refresh_at,
  auth_method, enabled, health_state, last_error, consecutive_failures, priority,
  created_at, updated_at, codex_usage_json, codex_usage_updated_at, codex_usage_error,
  codex_autostart_enabled, last_pinged_reset_at, last_pinged_reset_key, last_ping_at
)
SELECT
  id, provider_id, email, workspace_id, chatgpt_account_id, plan_type,
  encrypted_access_token, access_token_nonce, access_token_version,
  encrypted_refresh_token, refresh_token_nonce, refresh_token_version,
  encrypted_id_token, id_token_nonce, id_token_version, token_expires_at, last_refresh_at,
  auth_method, enabled, health_state, last_error, consecutive_failures, priority,
  created_at, updated_at, codex_usage_json, codex_usage_updated_at, codex_usage_error,
  codex_autostart_enabled, last_pinged_reset_at, last_pinged_reset_key, last_ping_at
FROM codex_accounts_legacy;

CREATE TABLE qoder_accounts (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  label TEXT,
  email TEXT,
  qoder_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  encrypted_pat TEXT NOT NULL,
  pat_nonce TEXT NOT NULL,
  pat_version INTEGER NOT NULL DEFAULT 1,
  encrypted_job_token TEXT NOT NULL,
  job_token_nonce TEXT NOT NULL,
  job_token_version INTEGER NOT NULL DEFAULT 1,
  job_token_expires_at TEXT NOT NULL,
  catalog_json TEXT,
  catalog_fetched_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  health_state TEXT NOT NULL DEFAULT 'unknown' CHECK (health_state IN ('healthy','degraded','down','unknown')),
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE request_attempts (
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
  upstream_request_id TEXT,
  codex_account_id TEXT REFERENCES codex_accounts(id) ON DELETE SET NULL,
  qoder_account_id TEXT REFERENCES qoder_accounts(id) ON DELETE SET NULL
);
-- Column list is explicit: `qoder_account_id` is new, so `SELECT *` would be one
-- value short of the 24 target columns.
INSERT INTO request_attempts (
  id, request_id, attempt_number, provider_id, model_id, started_at, completed_at, status_code,
  success, latency_ms, ttft_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  reasoning_tokens, stream_started, partial_response, selection_reason, failure_reason, error_message,
  upstream_request_id, codex_account_id
)
SELECT
  id, request_id, attempt_number, provider_id, model_id, started_at, completed_at, status_code,
  success, latency_ms, ttft_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  reasoning_tokens, stream_started, partial_response, selection_reason, failure_reason, error_message,
  upstream_request_id, codex_account_id
FROM request_attempts_legacy;

DROP TABLE request_attempts_legacy;
DROP TABLE combo_members_legacy;
DROP TABLE models_legacy;
DROP TABLE codex_accounts_legacy;
DROP TABLE providers_legacy;

CREATE UNIQUE INDEX uniq_model_public ON models(public_model_id);
CREATE UNIQUE INDEX uniq_provider_upstream ON models(provider_id, upstream_model_id);
CREATE INDEX idx_model_enabled ON models(enabled);
CREATE UNIQUE INDEX uniq_combo_model ON combo_members(combo_id, model_id);
CREATE INDEX idx_combo_pos ON combo_members(combo_id, position);
CREATE INDEX idx_codex_account_provider_enabled_priority ON codex_accounts(provider_id, enabled, priority);
CREATE INDEX idx_codex_account_provider_email ON codex_accounts(provider_id, email);
CREATE INDEX idx_codex_account_provider_chatgpt ON codex_accounts(provider_id, chatgpt_account_id);
CREATE INDEX idx_qoder_account_provider_enabled_priority ON qoder_accounts(provider_id, enabled, priority);
CREATE INDEX idx_qoder_account_provider_user ON qoder_accounts(provider_id, qoder_user_id);
CREATE INDEX idx_attempt_request ON request_attempts(request_id, attempt_number);
CREATE INDEX idx_attempt_provider_model ON request_attempts(provider_id, model_id, started_at);
CREATE INDEX idx_attempt_codex_account ON request_attempts(codex_account_id, started_at);
CREATE INDEX idx_attempt_qoder_account ON request_attempts(qoder_account_id, started_at);
