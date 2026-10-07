-- 0203_validate_api_order_payment_requests: validates what 0202 added NOT VALID (ADR-283).
-- Validation reads the table without blocking its writes.
ALTER TABLE app.commerce_payment_links
  VALIDATE CONSTRAINT commerce_payment_links_created_by_api_key_fk;
ALTER TABLE app.commerce_payment_links VALIDATE CONSTRAINT commerce_payment_links_creator;
