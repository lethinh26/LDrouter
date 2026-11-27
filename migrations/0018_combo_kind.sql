-- Native Codex combos use only the signed-in client's identity; never enable
-- account rate-limit fallback or shared adaptive learning for this kind.
ALTER TABLE combos ADD COLUMN combo_kind TEXT NOT NULL DEFAULT 'standard'
  CHECK (combo_kind IN ('standard', 'codex_native'))
  CHECK (combo_kind = 'standard' OR (mode = 'fallback' AND fallback_on_429 = 0 AND slow_response_fallback_enabled = 0));
