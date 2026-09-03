-- Migration: Ensure all existing API keys have keyDigest populated
-- This fixes the issue where old keys stored without digest after restore
-- or from instances that didn't properly compute keyDigest on creation

BEGIN TRANSACTION;

-- Add missing keyDigest for any existing keys (should not happen if working correctly)
UPDATE apiKeys
SET keyDigest = substr(
    hex(sha256(keySecretEncrypted || keySecretNonce)),
    1, 64
)
WHERE keyDigest IS NULL OR keyDigest = '';

COMMIT;
