-- One immutable built-in namespace per integration kind. Provider rows remain
-- transport/credential identities so historical model UUIDs and ACLs survive.
CREATE TABLE provider_connections (
  provider_id TEXT PRIMARY KEY NOT NULL REFERENCES provider_integrations(provider_id) ON DELETE CASCADE,
  namespace_mode TEXT NOT NULL DEFAULT 'legacy' CHECK (namespace_mode IN ('legacy', 'canonical'))
);

-- Preserve every pre-existing public ID, credential, combo and permission.
INSERT INTO provider_connections (provider_id, namespace_mode)
SELECT provider_id, 'legacy' FROM provider_integrations;

-- Compatibility API and older test fixtures can still insert integration
-- identities. New built-in connections opt into the canonical namespace
-- explicitly, in the same transaction as provider creation.
CREATE TRIGGER provider_connection_default AFTER INSERT ON provider_integrations
BEGIN
  INSERT INTO provider_connections(provider_id, namespace_mode) VALUES (NEW.provider_id, 'legacy');
END;
