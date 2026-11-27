-- First-party gateway authorization only. No upstream credentials are stored.
CREATE TABLE gateway_oauth_codes (
    code_digest TEXT NOT NULL PRIMARY KEY CHECK (length(code_digest)=64 AND code_digest NOT GLOB '*[^0-9a-f]*'),
    key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    key_digest TEXT NOT NULL CHECK (length(key_digest)=64 AND key_digest NOT GLOB '*[^0-9a-f]*'),
    challenge TEXT NOT NULL CHECK (length(challenge)=43 AND challenge NOT GLOB '*[^A-Za-z0-9_-]*'),
    redirect_uri TEXT NOT NULL CHECK (redirect_uri='http://127.0.0.1:43127/callback'),
    session_id TEXT NOT NULL REFERENCES admin_sessions(id) ON DELETE CASCADE,
    expires_at_ms INTEGER NOT NULL CHECK (typeof(expires_at_ms)='integer' AND expires_at_ms>0)
);

CREATE TABLE gateway_oauth_grants (
    id TEXT NOT NULL PRIMARY KEY,
    key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    key_digest TEXT NOT NULL CHECK (length(key_digest)=64 AND key_digest NOT GLOB '*[^0-9a-f]*'),
    access_digest TEXT NOT NULL UNIQUE CHECK (length(access_digest)=64 AND access_digest NOT GLOB '*[^0-9a-f]*'),
    refresh_digest TEXT NOT NULL UNIQUE CHECK (length(refresh_digest)=64 AND refresh_digest NOT GLOB '*[^0-9a-f]*'),
    access_expires_at_ms INTEGER NOT NULL CHECK (typeof(access_expires_at_ms)='integer' AND access_expires_at_ms>created_at_ms),
    refresh_expires_at_ms INTEGER NOT NULL CHECK (typeof(refresh_expires_at_ms)='integer' AND refresh_expires_at_ms>=access_expires_at_ms),
    absolute_expires_at_ms INTEGER NOT NULL CHECK (typeof(absolute_expires_at_ms)='integer' AND absolute_expires_at_ms>=refresh_expires_at_ms),
    created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms)='integer' AND created_at_ms>0),
    last_refreshed_at_ms INTEGER CHECK (last_refreshed_at_ms IS NULL OR (typeof(last_refreshed_at_ms)='integer' AND last_refreshed_at_ms>=created_at_ms AND last_refreshed_at_ms<absolute_expires_at_ms)),
    revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR (typeof(revoked_at_ms)='integer' AND revoked_at_ms>=created_at_ms))
);

CREATE TABLE gateway_oauth_used_refresh (
    token_digest TEXT NOT NULL PRIMARY KEY CHECK (length(token_digest)=64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
    grant_id TEXT NOT NULL REFERENCES gateway_oauth_grants(id) ON DELETE CASCADE
);

CREATE INDEX idx_gateway_oauth_codes_key ON gateway_oauth_codes(key_id);
CREATE INDEX idx_gateway_oauth_codes_expiry ON gateway_oauth_codes(expires_at_ms);
CREATE INDEX idx_gateway_oauth_codes_session ON gateway_oauth_codes(session_id);
CREATE INDEX idx_gateway_oauth_grants_key ON gateway_oauth_grants(key_id);
CREATE INDEX idx_gateway_oauth_grants_expiry ON gateway_oauth_grants(absolute_expires_at_ms);
CREATE INDEX idx_gateway_oauth_used_refresh_grant ON gateway_oauth_used_refresh(grant_id);
