-- Old samples have no workload identity or successful completion evidence.
ALTER TABLE combos ADD COLUMN max_request_duration_seconds INTEGER
  CHECK (max_request_duration_seconds IS NULL OR max_request_duration_seconds BETWEEN 1 AND 3600);
DROP TABLE combo_member_slow_states;
UPDATE combos SET slow_response_generation = slow_response_generation + 1;

CREATE UNIQUE INDEX uniq_combo_member_identity ON combo_members(id, combo_id, model_id);
CREATE TABLE combo_adaptive_states (
  combo_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  workload TEXT NOT NULL CHECK (workload IN ('stream:plain:short', 'complete:plain:short:short', 'complete:plain:short:long', 'stream:plain:long', 'complete:plain:long:short', 'complete:plain:long:long', 'stream:reasoning:short', 'complete:reasoning:short:short', 'complete:reasoning:short:long', 'stream:reasoning:long', 'complete:reasoning:long:short', 'complete:reasoning:long:long')),
  generation INTEGER NOT NULL,
  samples_json TEXT NOT NULL DEFAULT '[]',
  consecutive_slow_count INTEGER NOT NULL DEFAULT 0,
  relative_slow_count INTEGER NOT NULL DEFAULT 0,
  degraded TEXT CHECK (degraded IN ('absolute','relative')),
  comparator_model_id TEXT,
  probe_due_ms INTEGER,
  probe_lease_until_ms INTEGER,
  probe_token TEXT,
  recovery_successes INTEGER NOT NULL DEFAULT 0,
  probe_failures INTEGER NOT NULL DEFAULT 0,
  last_latency_ms INTEGER,
  last_outcome TEXT NOT NULL DEFAULT 'unknown' CHECK (last_outcome IN ('success','soft_timeout','error','cancel','unknown')),
  updated_at_ms INTEGER NOT NULL DEFAULT 0,
  last_observation_ms INTEGER,
  last_start_ms INTEGER,
  last_start_sequence INTEGER NOT NULL DEFAULT 0,
  baseline_latency_ms INTEGER,
  suspect_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(member_id, workload),
  FOREIGN KEY(member_id, combo_id, model_id) REFERENCES combo_members(id, combo_id, model_id) ON DELETE CASCADE
);
CREATE INDEX idx_adaptive_combo_workload ON combo_adaptive_states(combo_id, workload);
CREATE INDEX idx_adaptive_updated ON combo_adaptive_states(updated_at_ms);

CREATE TABLE combo_adaptive_exploration (
  combo_id TEXT NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  workload TEXT NOT NULL CHECK (workload IN ('stream:plain:short', 'complete:plain:short:short', 'complete:plain:short:long', 'stream:plain:long', 'complete:plain:long:short', 'complete:plain:long:long', 'stream:reasoning:short', 'complete:reasoning:short:short', 'complete:reasoning:short:long', 'stream:reasoning:long', 'complete:reasoning:long:short', 'complete:reasoning:long:long')),
  generation INTEGER NOT NULL,
  next_due_ms INTEGER NOT NULL,
  PRIMARY KEY(combo_id, workload)
);

-- Administrative combo settings and membership edits own their generation
-- updates in the Admin API. Invalidate latency evidence for physical provider
-- and model changes regardless of the path that updates their configuration.
-- Health, labels, timestamps, and discovery metadata do not reset the policy.
CREATE TRIGGER trg_adaptive_provider_config
AFTER UPDATE OF type, base_url, encrypted_api_key, api_key_nonce, api_key_version, custom_headers_encrypted, custom_headers_nonce, enabled, connect_timeout_ms, first_token_timeout_ms, stream_idle_timeout_ms, total_timeout_ms, max_retries, retry_base_ms, retry_max_ms, cb_failure_threshold, cb_cooldown_seconds ON providers
WHEN OLD.type IS NOT NEW.type
  OR OLD.base_url IS NOT NEW.base_url
  OR OLD.encrypted_api_key IS NOT NEW.encrypted_api_key
  OR OLD.api_key_nonce IS NOT NEW.api_key_nonce
  OR OLD.api_key_version IS NOT NEW.api_key_version
  OR OLD.custom_headers_encrypted IS NOT NEW.custom_headers_encrypted
  OR OLD.custom_headers_nonce IS NOT NEW.custom_headers_nonce
  OR OLD.enabled IS NOT NEW.enabled
  OR OLD.connect_timeout_ms IS NOT NEW.connect_timeout_ms
  OR OLD.first_token_timeout_ms IS NOT NEW.first_token_timeout_ms
  OR OLD.stream_idle_timeout_ms IS NOT NEW.stream_idle_timeout_ms
  OR OLD.total_timeout_ms IS NOT NEW.total_timeout_ms
  OR OLD.max_retries IS NOT NEW.max_retries
  OR OLD.retry_base_ms IS NOT NEW.retry_base_ms
  OR OLD.retry_max_ms IS NOT NEW.retry_max_ms
  OR OLD.cb_failure_threshold IS NOT NEW.cb_failure_threshold
  OR OLD.cb_cooldown_seconds IS NOT NEW.cb_cooldown_seconds
BEGIN
  DELETE FROM combo_adaptive_states WHERE combo_id IN (SELECT DISTINCT cm.combo_id FROM combo_members cm JOIN models m ON cm.model_id=m.id WHERE m.provider_id=NEW.id);
  DELETE FROM combo_adaptive_exploration WHERE combo_id IN (SELECT DISTINCT cm.combo_id FROM combo_members cm JOIN models m ON cm.model_id=m.id WHERE m.provider_id=NEW.id);
  UPDATE combos SET slow_response_generation = slow_response_generation + 1 WHERE id IN (SELECT DISTINCT cm.combo_id FROM combo_members cm JOIN models m ON cm.model_id=m.id WHERE m.provider_id=NEW.id);
END;
CREATE TRIGGER trg_adaptive_model_config
AFTER UPDATE OF provider_id, upstream_model_id, enabled, upstream_available, capabilities_json, max_context_tokens, max_output_tokens ON models
WHEN OLD.provider_id IS NOT NEW.provider_id
  OR OLD.upstream_model_id IS NOT NEW.upstream_model_id
  OR OLD.enabled IS NOT NEW.enabled
  OR OLD.upstream_available IS NOT NEW.upstream_available
  OR OLD.capabilities_json IS NOT NEW.capabilities_json
  OR OLD.max_context_tokens IS NOT NEW.max_context_tokens
  OR OLD.max_output_tokens IS NOT NEW.max_output_tokens
BEGIN
  DELETE FROM combo_adaptive_states WHERE combo_id IN (SELECT DISTINCT combo_id FROM combo_members WHERE model_id=NEW.id);
  DELETE FROM combo_adaptive_exploration WHERE combo_id IN (SELECT DISTINCT combo_id FROM combo_members WHERE model_id=NEW.id);
  UPDATE combos SET slow_response_generation = slow_response_generation + 1 WHERE id IN (SELECT DISTINCT combo_id FROM combo_members WHERE model_id=NEW.id);
END;
