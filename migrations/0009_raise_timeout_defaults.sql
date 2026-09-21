-- 0009_raise_timeout_defaults.sql
-- Raise the upstream timeout defaults. Long reasoning streams sit idle well past 60s between
-- SSE frames, and the 180s total ceiling cut them off: the production request log showed 55
-- `timeout_error` rows all ending at exactly 180s with a first token already delivered, i.e.
-- the total timer firing while the stream was still alive.
--
-- New defaults: connect 15s, first token 60s, stream idle 300s, total 600s.
-- Only rows still on the previous defaults are touched, so an admin-tuned value survives.
-- The column DEFAULT in `providers` stays at the old values (SQLite cannot ALTER a default
-- without a full table rebuild) — the application always writes the timeout columns
-- explicitly, so the column default only applies to raw SQL inserts.
UPDATE providers SET connect_timeout_ms = 15000 WHERE connect_timeout_ms = 10000;
UPDATE providers SET first_token_timeout_ms = 60000 WHERE first_token_timeout_ms = 30000;
UPDATE providers SET stream_idle_timeout_ms = 300000 WHERE stream_idle_timeout_ms = 60000;
UPDATE providers SET total_timeout_ms = 600000 WHERE total_timeout_ms = 180000;
