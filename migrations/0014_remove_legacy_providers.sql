-- Remove the retired provider types and their credentials without deleting historical
-- requests, attempts or aggregate statistics. Keep foreign-key enforcement enabled.
PRAGMA secure_delete = ON;

-- Capture affected configuration before rebuilding the FK graph. Use provider type,
-- not slugs or model names: compatible providers may expose similarly named models.
CREATE TEMP TABLE retired_models AS
SELECT m.id FROM models m JOIN providers p ON p.id = m.provider_id
WHERE p.type NOT IN ('openai', 'anthropic');

CREATE TEMP TABLE affected_combos AS
SELECT DISTINCT combo_id AS id FROM combo_members
WHERE model_id IN (SELECT id FROM retired_models);

CREATE TEMP TABLE retired_aliases AS
SELECT id FROM model_aliases
WHERE target_kind = 'model' AND target_id IN (SELECT id FROM retired_models);

-- Drop stale cache entries, including responses cached through an affected combo
-- or its alias (the cached payload does not identify the winning physical model).
DELETE FROM response_cache WHERE
  (target_kind = 'model' AND target_id IN (SELECT id FROM retired_models)) OR
  (target_kind = 'combo' AND target_id IN (SELECT id FROM affected_combos)) OR
  (target_kind = 'alias' AND target_id IN (
    SELECT id FROM model_aliases WHERE id IN (SELECT id FROM retired_aliases)
    OR (target_kind = 'combo' AND target_id IN (SELECT id FROM affected_combos))
  ));

-- Do not change api_keys.allow_all_models. A restricted key losing its last
-- permission remains restricted, and therefore cannot access any target.
DELETE FROM api_key_model_permissions WHERE
  (target_kind = 'model' AND target_id IN (SELECT id FROM retired_models)) OR
  (target_kind = 'alias' AND target_id IN (SELECT id FROM retired_aliases));
DELETE FROM model_aliases WHERE id IN (SELECT id FROM retired_aliases);

-- Removing a member cascades to its existing slow-response state. Keep the
-- surviving member IDs and positions, so relative fallback order is unchanged.
DELETE FROM combo_members WHERE model_id IN (SELECT id FROM retired_models);
UPDATE combos SET
  enabled = CASE WHEN EXISTS (SELECT 1 FROM combo_members WHERE combo_id = combos.id) THEN enabled ELSE 0 END,
  config_version = config_version + 1,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id IN (SELECT id FROM affected_combos);
UPDATE model_aliases SET
  enabled = CASE WHEN EXISTS (SELECT 1 FROM combo_members WHERE combo_id = model_aliases.target_id) THEN enabled ELSE 0 END,
  config_version = config_version + 1,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE target_kind = 'combo' AND target_id IN (SELECT id FROM affected_combos);

-- Account fields are intentionally excluded; provider/model IDs in attempts
-- are historical snapshots and are deliberately not foreign keys.
CREATE TABLE request_attempts_next (
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
INSERT INTO request_attempts_next SELECT
  id, request_id, attempt_number, provider_id, model_id, started_at, completed_at,
  status_code, success, latency_ms, ttft_ms, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, reasoning_tokens, stream_started,
  partial_response, selection_reason, failure_reason, error_message, upstream_request_id
FROM request_attempts;
DROP TABLE request_attempts;
ALTER TABLE request_attempts_next RENAME TO request_attempts;
CREATE INDEX idx_attempt_request ON request_attempts(request_id, attempt_number);
CREATE INDEX idx_attempt_provider_model ON request_attempts(provider_id, model_id, started_at);

-- No table references the account pools now. Drop their credentials entirely.
DROP TABLE codex_accounts;
DROP TABLE qoder_accounts;

-- Rebuild the provider CHECK constraint and its dependent graph, copying only
-- supported providers and models. Rebuild children before dropping their old
-- parents, then rename the new parents so SQLite updates the FK references.
CREATE TABLE providers_next (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('openai','anthropic')),
  base_url TEXT NOT NULL,
  encrypted_api_key TEXT,
  api_key_nonce TEXT,
  api_key_version INTEGER NOT NULL DEFAULT 1,
  custom_headers_encrypted TEXT,
  custom_headers_nonce TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  connect_timeout_ms INTEGER NOT NULL DEFAULT 60000,
  first_token_timeout_ms INTEGER NOT NULL DEFAULT 60000,
  stream_idle_timeout_ms INTEGER NOT NULL DEFAULT 300000,
  total_timeout_ms INTEGER NOT NULL DEFAULT 600000,
  max_retries INTEGER NOT NULL DEFAULT 2,
  retry_base_ms INTEGER NOT NULL DEFAULT 500,
  retry_max_ms INTEGER NOT NULL DEFAULT 8000,
  cb_failure_threshold INTEGER NOT NULL DEFAULT 5,
  cb_cooldown_seconds INTEGER NOT NULL DEFAULT 60,
  health_state TEXT NOT NULL DEFAULT 'unknown' CHECK (health_state IN ('healthy','degraded','down','circuit_open','unknown')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO providers_next (
  id, name, slug, type, base_url, encrypted_api_key, api_key_nonce,
  api_key_version, custom_headers_encrypted, custom_headers_nonce, enabled,
  connect_timeout_ms, first_token_timeout_ms, stream_idle_timeout_ms, total_timeout_ms,
  max_retries, retry_base_ms, retry_max_ms, cb_failure_threshold, cb_cooldown_seconds,
  health_state, created_at, updated_at
)
SELECT id, name, slug, type, base_url, encrypted_api_key, api_key_nonce,
  api_key_version, custom_headers_encrypted, custom_headers_nonce, enabled,
  connect_timeout_ms, first_token_timeout_ms, stream_idle_timeout_ms, total_timeout_ms,
  max_retries, retry_base_ms, retry_max_ms, cb_failure_threshold, cb_cooldown_seconds,
  health_state, created_at, updated_at
FROM providers WHERE type IN ('openai','anthropic');

CREATE TABLE models_next (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers_next(id) ON DELETE RESTRICT,
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
INSERT INTO models_next (
  id, provider_id, upstream_model_id, public_model_id, display_name, enabled,
  upstream_available, capabilities_json, max_context_tokens, max_output_tokens,
  discovered_metadata_json, cache_override_enabled, created_at, updated_at, last_seen_upstream_at
)
SELECT id, provider_id, upstream_model_id, public_model_id, display_name, enabled,
  upstream_available, capabilities_json, max_context_tokens, max_output_tokens,
  discovered_metadata_json, cache_override_enabled, created_at, updated_at, last_seen_upstream_at
FROM models WHERE provider_id IN (SELECT id FROM providers_next);

CREATE TABLE combo_members_next (
  id TEXT PRIMARY KEY,
  combo_id TEXT NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES models_next(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
INSERT INTO combo_members_next (id, combo_id, model_id, position, enabled)
SELECT id, combo_id, model_id, position, enabled FROM combo_members;
-- The parent key must be unique before copying the slow-state child rows.
CREATE UNIQUE INDEX uniq_combo_model_next ON combo_members_next(combo_id, model_id);

CREATE TABLE combo_member_slow_states_next (
  combo_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  consecutive_slow_count INTEGER NOT NULL DEFAULT 0,
  cooldown_until_ms INTEGER,
  probe_lease_until_ms INTEGER,
  last_latency_ms INTEGER,
  last_outcome TEXT NOT NULL DEFAULT 'unknown' CHECK (last_outcome IN ('slow','fast','error','unknown')),
  updated_at_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (combo_id, model_id),
  FOREIGN KEY (combo_id, model_id) REFERENCES combo_members_next(combo_id, model_id) ON DELETE CASCADE
);
INSERT INTO combo_member_slow_states_next (
  combo_id, model_id, consecutive_slow_count, cooldown_until_ms, probe_lease_until_ms,
  last_latency_ms, last_outcome, updated_at_ms
)
SELECT combo_id, model_id, consecutive_slow_count, cooldown_until_ms, probe_lease_until_ms,
  last_latency_ms, last_outcome, updated_at_ms FROM combo_member_slow_states
WHERE (combo_id, model_id) IN (SELECT combo_id, model_id FROM combo_members_next);

DROP TABLE combo_member_slow_states;
DROP TABLE combo_members;
DROP TABLE models;
DROP TABLE providers;
ALTER TABLE providers_next RENAME TO providers;
ALTER TABLE models_next RENAME TO models;
ALTER TABLE combo_members_next RENAME TO combo_members;
ALTER TABLE combo_member_slow_states_next RENAME TO combo_member_slow_states;

CREATE UNIQUE INDEX uniq_model_public ON models(public_model_id);
CREATE UNIQUE INDEX uniq_provider_upstream ON models(provider_id, upstream_model_id);
CREATE INDEX idx_model_enabled ON models(enabled);
CREATE UNIQUE INDEX uniq_combo_model ON combo_members(combo_id, model_id);
DROP INDEX uniq_combo_model_next;
CREATE INDEX idx_combo_pos ON combo_members(combo_id, position);
CREATE INDEX idx_combo_slow_cooldown ON combo_member_slow_states(cooldown_until_ms);

DROP TABLE retired_models;
DROP TABLE affected_combos;
DROP TABLE retired_aliases;
