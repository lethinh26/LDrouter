-- Retire the client-specific integrations introduced by 0017-0021.
-- Identify their configuration by explicit integration ownership, not names
-- or slugs. Compatible providers with similar names must remain untouched.
-- Preserve the migration ledger, request history, usage and API-key identity.
PRAGMA secure_delete = ON;

CREATE TEMP TABLE retiring_provider_ids AS
SELECT provider_id AS id FROM provider_integrations;
CREATE TEMP TABLE retiring_model_ids AS
SELECT id FROM models WHERE provider_id IN (SELECT id FROM retiring_provider_ids);
CREATE TEMP TABLE retiring_combo_ids AS
SELECT id FROM combos WHERE combo_kind = 'codex_native';
CREATE TEMP TABLE affected_combo_ids AS
SELECT id FROM retiring_combo_ids
UNION SELECT combo_id FROM combo_members WHERE model_id IN (SELECT id FROM retiring_model_ids);
CREATE TEMP TABLE retiring_alias_ids AS
SELECT id FROM model_aliases WHERE
  (target_kind = 'model' AND target_id IN (SELECT id FROM retiring_model_ids)) OR
  (target_kind = 'combo' AND target_id IN (SELECT id FROM retiring_combo_ids));

DELETE FROM response_cache WHERE
  (target_kind = 'model' AND target_id IN (SELECT id FROM retiring_model_ids)) OR
  (target_kind = 'combo' AND target_id IN (SELECT id FROM affected_combo_ids)) OR
  (target_kind = 'alias' AND target_id IN (
    SELECT id FROM retiring_alias_ids UNION
    SELECT id FROM model_aliases WHERE target_kind = 'combo' AND target_id IN (SELECT id FROM affected_combo_ids)
  ));

-- A restricted key remains restricted even when its final permission is removed.
DELETE FROM api_key_model_permissions WHERE
  (target_kind = 'model' AND target_id IN (SELECT id FROM retiring_model_ids)) OR
  (target_kind = 'combo' AND target_id IN (SELECT id FROM retiring_combo_ids)) OR
  (target_kind = 'alias' AND target_id IN (SELECT id FROM retiring_alias_ids));
DELETE FROM model_aliases WHERE id IN (SELECT id FROM retiring_alias_ids);
DELETE FROM combo_members WHERE combo_id IN (SELECT id FROM retiring_combo_ids)
  OR model_id IN (SELECT id FROM retiring_model_ids);
DELETE FROM combo_adaptive_states WHERE combo_id IN (SELECT id FROM affected_combo_ids);
DELETE FROM combo_adaptive_exploration WHERE combo_id IN (SELECT id FROM affected_combo_ids);
DELETE FROM combos WHERE id IN (SELECT id FROM retiring_combo_ids);

-- Preserve standard combo identities, surviving member IDs and relative order.
UPDATE combos SET
  enabled = CASE WHEN EXISTS (SELECT 1 FROM combo_members WHERE combo_id = combos.id) THEN enabled ELSE 0 END,
  slow_response_generation = slow_response_generation + 1,
  config_version = config_version + 1,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id IN (SELECT id FROM affected_combo_ids);
UPDATE model_aliases SET
  enabled = CASE WHEN EXISTS (SELECT 1 FROM combo_members WHERE combo_id = model_aliases.target_id) THEN enabled ELSE 0 END,
  config_version = config_version + 1,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE target_kind = 'combo' AND target_id IN (SELECT id FROM affected_combo_ids);

DELETE FROM models WHERE id IN (SELECT id FROM retiring_model_ids);
DELETE FROM providers WHERE id IN (SELECT id FROM retiring_provider_ids);

DROP TRIGGER provider_connection_default;
DROP TABLE provider_connections;
DROP TABLE provider_integrations;
DROP TABLE gateway_oauth_used_refresh;
DROP TABLE gateway_oauth_grants;
DROP TABLE gateway_oauth_codes;
DROP TABLE subscription_quota_accounts;
ALTER TABLE combos DROP COLUMN combo_kind;

DROP TABLE retiring_alias_ids;
DROP TABLE affected_combo_ids;
DROP TABLE retiring_combo_ids;
DROP TABLE retiring_model_ids;
DROP TABLE retiring_provider_ids;
