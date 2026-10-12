CREATE TABLE daily_model_stats (
  day TEXT NOT NULL,
  model_id TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL DEFAULT 0,
  successful_requests INTEGER NOT NULL DEFAULT 0,
  failed_requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  gateway_cache_hits INTEGER NOT NULL DEFAULT 0,
  fallback_requests INTEGER NOT NULL DEFAULT 0,
  latency_success_sum_ms INTEGER NOT NULL DEFAULT 0,
  latency_success_count INTEGER NOT NULL DEFAULT 0,
  ttft_sum_ms INTEGER NOT NULL DEFAULT 0,
  ttft_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model_id)
);
CREATE TABLE daily_provider_stats (
  day TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  successful_attempts INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  latency_success_sum_ms INTEGER NOT NULL DEFAULT 0,
  latency_success_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider_id)
);
CREATE TABLE daily_api_key_stats (
  day TEXT NOT NULL,
  api_key_id TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL DEFAULT 0,
  successful_requests INTEGER NOT NULL DEFAULT 0,
  failed_requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, api_key_id)
);
CREATE TABLE daily_stats_backfill_marker (id INTEGER PRIMARY KEY CHECK (id = 1), completed_at TEXT NOT NULL);
CREATE INDEX idx_daily_model_day ON daily_model_stats(day);
CREATE INDEX idx_daily_provider_day ON daily_provider_stats(day);
CREATE INDEX idx_daily_api_key_day ON daily_api_key_stats(day);

INSERT INTO daily_model_stats (day,model_id,requests,successful_requests,failed_requests,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,gateway_cache_hits,fallback_requests,latency_success_sum_ms,latency_success_count,ttft_sum_ms,ttft_count)
SELECT substr(created_at,1,10), COALESCE(final_model_id,''), COUNT(*), SUM(success), COUNT(*)-SUM(success), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens), SUM(reasoning_tokens), SUM(gateway_cache_hit), SUM(attempts_count > 1), SUM(CASE WHEN success=1 THEN total_latency_ms ELSE 0 END), SUM(success), SUM(CASE WHEN success=1 AND ttft_ms IS NOT NULL THEN ttft_ms ELSE 0 END), SUM(success AND ttft_ms IS NOT NULL)
FROM requests GROUP BY substr(created_at,1,10), final_model_id;
INSERT INTO daily_api_key_stats (day,api_key_id,requests,successful_requests,failed_requests,input_tokens,output_tokens,total_tokens)
SELECT substr(created_at,1,10), COALESCE(api_key_id,''), COUNT(*), SUM(success), COUNT(*)-SUM(success), SUM(input_tokens), SUM(output_tokens), SUM(total_tokens)
FROM requests GROUP BY substr(created_at,1,10), api_key_id;
INSERT INTO daily_provider_stats (day,provider_id,attempts,successful_attempts,failed_attempts,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,latency_success_sum_ms,latency_success_count)
SELECT substr(a.started_at,1,10), a.provider_id, COUNT(*), SUM(a.success), COUNT(*)-SUM(a.success), SUM(a.input_tokens), SUM(a.output_tokens), SUM(a.cache_read_tokens), SUM(a.cache_write_tokens), SUM(a.reasoning_tokens), SUM(CASE WHEN a.success=1 THEN a.latency_ms ELSE 0 END), SUM(a.success)
FROM request_attempts a GROUP BY substr(a.started_at,1,10), a.provider_id;
INSERT INTO daily_stats_backfill_marker (id,completed_at) VALUES (1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
