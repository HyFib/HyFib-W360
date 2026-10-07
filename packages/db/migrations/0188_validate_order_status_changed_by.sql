-- 0188_validate_order_status_changed_by: validates what 0187 added NOT VALID (ADR-270).
-- Validation reads the table without blocking its writes.
ALTER TABLE app.commerce_orders VALIDATE CONSTRAINT commerce_orders_status_changed_by_api_key_fk;
ALTER TABLE app.commerce_orders VALIDATE CONSTRAINT commerce_orders_status_changed_by;
