-- 0006_codex_usage.sql
-- Codex per-account usage snapshots and 5-hour window auto-start state.
ALTER TABLE codex_accounts ADD COLUMN codex_usage_json TEXT;
ALTER TABLE codex_accounts ADD COLUMN codex_usage_updated_at TEXT;
ALTER TABLE codex_accounts ADD COLUMN codex_usage_error TEXT;
ALTER TABLE codex_accounts ADD COLUMN codex_autostart_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE codex_accounts ADD COLUMN last_pinged_reset_at TEXT;
ALTER TABLE codex_accounts ADD COLUMN last_pinged_reset_key TEXT;
ALTER TABLE codex_accounts ADD COLUMN last_ping_at TEXT;
