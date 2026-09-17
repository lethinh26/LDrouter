-- 0008_qoder_credits.sql
-- Qoder per-account Credits snapshots. Qoder meters usage in Credits, not tokens:
-- its SSE stream carries no usage block at all, so the only upstream truth about
-- consumption is the quota API (openapi /api/v2/quota/usage).
ALTER TABLE qoder_accounts ADD COLUMN credits_json TEXT;
ALTER TABLE qoder_accounts ADD COLUMN credits_updated_at TEXT;
ALTER TABLE qoder_accounts ADD COLUMN credits_error TEXT;
