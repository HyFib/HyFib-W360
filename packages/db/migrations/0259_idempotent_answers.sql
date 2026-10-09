-- Answers kept with an Idempotency-Key up to 256 KiB (P5-08, ADR-339).
--
-- A successful answer to a request sent with an Idempotency-Key is kept for 24 hours, so that a
-- retry gets it again (0024), and its check held it to 64 KiB as jsonb. Some answers give more than
-- their request carried, and within their limits they can pass 64 KiB: a webhook endpoint's whole
-- configuration (POST /webhook-endpoints and POST /webhook-endpoints/{id}/rotate-secret, whose key
-- is required: about 105 KB with every list full of text in Tamil), an order with its 100 items
-- (POST /orders/{id}/request-payment, about 105 KB) and a template with its history and numbers
-- (POST /message-templates/{id}/submit, about 113 KB). Each such request failed with an internal
-- error every time, and its work was rolled back. The check now takes 256 KiB; the services refuse
-- an answer they cannot keep with a reason instead (ADR-339). The table holds a day's keys, so the
-- new check is validated here.
ALTER TABLE app.api_idempotency_keys
  DROP CONSTRAINT api_idempotency_keys_response_check,
  ADD CONSTRAINT api_idempotency_keys_response_check CHECK (pg_column_size(response) <= 262144);
