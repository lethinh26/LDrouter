ALTER TABLE combos ADD COLUMN fallback_on_total_timeout INTEGER NOT NULL DEFAULT 1;
-- Before this trigger existed, total timeout used the connect-timeout fallback
-- preference. Preserve that behavior for existing combos during the upgrade.
UPDATE combos SET fallback_on_total_timeout = fallback_on_connect_timeout;
ALTER TABLE combos ADD COLUMN slow_response_fallback_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE combos ADD COLUMN slow_response_threshold_seconds INTEGER NOT NULL DEFAULT 60;
ALTER TABLE combos ADD COLUMN slow_response_max_count INTEGER NOT NULL DEFAULT 3;
ALTER TABLE combos ADD COLUMN slow_response_generation INTEGER NOT NULL DEFAULT 1;

CREATE TABLE combo_member_slow_states (
  combo_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  consecutive_slow_count INTEGER NOT NULL DEFAULT 0,
  cooldown_until_ms INTEGER,
  probe_lease_until_ms INTEGER,
  last_latency_ms INTEGER,
  last_outcome TEXT NOT NULL DEFAULT 'unknown' CHECK (last_outcome IN ('slow','fast','error','unknown')),
  updated_at_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (combo_id, model_id),
  FOREIGN KEY (combo_id, model_id) REFERENCES combo_members(combo_id, model_id) ON DELETE CASCADE
);
CREATE INDEX idx_combo_slow_cooldown ON combo_member_slow_states(cooldown_until_ms);
