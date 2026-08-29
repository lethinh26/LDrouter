-- 0002_source_api_key_secrets.sql
-- Add columns for encrypted API key secret storage.
-- Allows admin to retrieve the full key after creation (encrypted at rest).

ALTER TABLE api_keys ADD COLUMN key_secret_encrypted TEXT;
ALTER TABLE api_keys ADD COLUMN key_secret_nonce TEXT;
ALTER TABLE api_keys ADD COLUMN key_secret_version INTEGER NOT NULL DEFAULT 1;
