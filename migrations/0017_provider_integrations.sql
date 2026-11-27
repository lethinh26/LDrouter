-- Separate client integration identity from the immutable compatible protocol.
-- No OAuth credentials are stored here: client_oauth is a request-scoped mode.
CREATE TABLE provider_integrations (
  provider_id TEXT PRIMARY KEY NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  provider_kind TEXT NOT NULL CHECK (provider_kind IN ('codex', 'claude_code')),
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('api_key', 'client_oauth')),
  CHECK ((provider_kind = 'codex' AND auth_mode = 'client_oauth') OR
         (provider_kind = 'claude_code' AND auth_mode = 'api_key'))
);
