-- 0059_api_webhook_endpoints: managing webhook endpoints through the public API (P5-08, P5-09,
-- ADR-081). A key with the new `webhooks.manage` scope creates, reads, changes, rotates the secret
-- of and deletes the endpoints keys created; the endpoints members created in settings stay out of
-- its reach. An endpoint now records the key that created it, or the member as before. Existing
-- keys keep their scopes (the key guard), so they gain nothing.

ALTER TABLE app.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 10
  AND scopes <@ ARRAY['templates.read', 'contacts.read', 'contacts.write', 'messages.send',
                      'messages.send_marketing', 'messages.reply', 'conversations.read',
                      'conversations.write', 'automations.start', 'webhooks.manage']::text[]);

-- Who created an endpoint: a member (as before) or a key, exactly one. The runtime role inserts the
-- new column through its table grant and cannot update either (0025's column grants). A company has
-- at most 10 endpoints, so the table is small and the constraints are validated here.
ALTER TABLE app.webhook_endpoints
  ALTER COLUMN created_by_user_id DROP NOT NULL,
  ADD COLUMN created_by_api_key_id uuid,
  ADD CONSTRAINT webhook_endpoints_creator
    CHECK ((created_by_user_id IS NULL) <> (created_by_api_key_id IS NULL)),
  ADD CONSTRAINT webhook_endpoints_api_key_fk FOREIGN KEY (tenant_id, created_by_api_key_id)
    REFERENCES app.api_keys (tenant_id, id);
