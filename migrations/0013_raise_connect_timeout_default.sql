-- 0013_raise_connect_timeout_default.sql
-- Raise the default provider connect timeout from 15s to 60s.
-- Only providers still using the previous default are changed; explicitly tuned values survive.
UPDATE providers SET connect_timeout_ms = 60000 WHERE connect_timeout_ms = 15000;
