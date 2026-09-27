-- Combos are ordered fallback lists. Remove weighted routing and its member weights.
CREATE TABLE combos_ordered (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  public_model_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('fallback')),
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

CREATE TABLE combo_members_ordered (
  id TEXT PRIMARY KEY,
  combo_id TEXT NOT NULL REFERENCES combos_ordered(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

INSERT INTO combos_ordered (
  id, name, slug, public_model_id, mode, enabled, max_total_attempts,
  fallback_on_connection, fallback_on_connect_timeout, fallback_on_first_token_timeout,
  fallback_on_408, fallback_on_429, fallback_on_5xx, cache_override_enabled,
  config_version, created_at, updated_at
)
SELECT
  id, name, slug, public_model_id, 'fallback', enabled, max_total_attempts,
  fallback_on_connection, fallback_on_connect_timeout, fallback_on_first_token_timeout,
  fallback_on_408, fallback_on_429, fallback_on_5xx, cache_override_enabled,
  config_version, created_at, updated_at
FROM combos;

INSERT INTO combo_members_ordered (id, combo_id, model_id, position, enabled)
SELECT id, combo_id, model_id, position, enabled
FROM combo_members;

DROP TABLE combo_members;
DROP TABLE combos;
ALTER TABLE combos_ordered RENAME TO combos;
ALTER TABLE combo_members_ordered RENAME TO combo_members;

CREATE UNIQUE INDEX uniq_combo_slug ON combos(slug);
CREATE UNIQUE INDEX uniq_combo_public ON combos(public_model_id);
CREATE UNIQUE INDEX uniq_combo_model ON combo_members(combo_id, model_id);
CREATE INDEX idx_combo_pos ON combo_members(combo_id, position);
