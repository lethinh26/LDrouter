ALTER TABLE api_keys ADD COLUMN total_token_limit INTEGER CHECK (total_token_limit IS NULL OR total_token_limit > 0);
CREATE INDEX idx_usage_month_key ON usage_monthly(api_key_id);
