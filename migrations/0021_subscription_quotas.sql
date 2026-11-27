-- Operator-managed quota observations, never upstream credentials or routes.
CREATE TABLE subscription_quota_accounts (
  id TEXT NOT NULL PRIMARY KEY,
  provider_kind TEXT NOT NULL CHECK(provider_kind IN ('codex','claude_code')),
  name TEXT NOT NULL COLLATE NOCASE CHECK(length(trim(name)) BETWEEN 1 AND 128),
  account_fingerprint TEXT CHECK(account_fingerprint IS NULL OR (provider_kind = 'codex' AND length(account_fingerprint) = 64 AND account_fingerprint NOT GLOB '*[^a-f0-9]*')),
  snapshot_json TEXT CHECK(snapshot_json IS NULL OR (length(snapshot_json) <= 32768 AND json_valid(snapshot_json))),
  created_at_ms INTEGER NOT NULL CHECK(typeof(created_at_ms) = 'integer' AND created_at_ms > 0),
  updated_at_ms INTEGER NOT NULL CHECK(typeof(updated_at_ms) = 'integer' AND updated_at_ms >= created_at_ms),
  UNIQUE(provider_kind,name),
  UNIQUE(provider_kind,account_fingerprint)
);
