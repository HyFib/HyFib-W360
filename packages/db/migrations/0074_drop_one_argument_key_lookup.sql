-- Drops the one-argument API key lookup (P5-08, ADR-076). Migration 0051 kept it, rebuilt on the
-- lookup with the client's address so that it refuses every key that lists networks, only for web
-- servers of the previous release during a rolling deploy. Every release since calls
-- ops.api_key_authenticate(text, inet), so nothing calls it any more: one definer function fewer
-- that reads the keys.
DROP FUNCTION ops.api_key_authenticate(text);
