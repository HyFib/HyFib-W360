-- Contact custom fields in the public API and the contact webhooks (P5-08, P5-09, ADR-112).
--
-- The API's contact now carries the values of the company's custom fields, and so does the
-- contact in the contact webhooks (ADR-074), so a change of a custom field's value captures
-- `contact.updated` like a change of the name, number, email or tags: in the transaction that makes
-- it, whoever makes it (members, imports, automations, Flows, the API), once per contact and
-- transaction (app.capture_contact_webhook_event, 0047).

-- Only the keys of the company's fields are compared. A field's deletion removes the row before it
-- removes the values, so it captures nothing (the field is gone for every contact at once), and a
-- rename changes no value. An erasure is captured as contact.erased by the trigger of 0047.
CREATE FUNCTION app.webhook_capture_contact_fields() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.contact_fields f
              WHERE f.tenant_id = NEW.tenant_id
                AND (NEW.attributes -> f.key) IS DISTINCT FROM (OLD.attributes -> f.key)) THEN
    PERFORM app.capture_contact_webhook_event(NEW.tenant_id, NEW.id, 'contact.updated');
  END IF;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION app.webhook_capture_contact_fields() FROM PUBLIC;

CREATE TRIGGER contacts_webhook_fields AFTER UPDATE OF attributes ON app.contacts
  FOR EACH ROW WHEN (OLD.erased_at IS NULL AND NEW.erased_at IS NULL
    AND NEW.attributes IS DISTINCT FROM OLD.attributes)
  EXECUTE FUNCTION app.webhook_capture_contact_fields();
