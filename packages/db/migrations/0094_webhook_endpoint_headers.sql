-- Custom headers on webhook endpoints (P5-09, ADR-118).
--
-- An endpoint may carry up to 5 headers its receiver asks for (an Authorization or API key header the
-- receiver issued), sent with every delivery attempt, test event and replay. Their names are kept as
-- written, so members and keys see which headers are set. Their values are secrets: they are kept
-- only in headers_ciphertext, encrypted with the keyring and bound to the company and the endpoint,
-- and never shown again. A company has at most 10 endpoints, so the table is small and the check is
-- validated here.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN header_names text[] NOT NULL DEFAULT '{}',
  ADD COLUMN headers_ciphertext text,
  ADD CONSTRAINT webhook_endpoints_headers CHECK (
    cardinality(header_names) <= 5
    AND (cardinality(header_names) = 0) = (headers_ciphertext IS NULL));

-- The runtime role sets them when it adds an endpoint (its table grant) and replaces them when an
-- endpoint changes (0025 grants updates column by column).
GRANT UPDATE (header_names, headers_ciphertext) ON app.webhook_endpoints TO w360_app;
