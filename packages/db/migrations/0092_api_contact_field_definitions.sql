-- Defining contact fields through the public API (P5-08, ADR-115). A key with the new
-- `contact_fields.manage` scope adds custom contact fields, renames them and deletes them with their
-- values, as owners and administrators do in Settings; granting it needs `tenant.settings.manage`.
-- Existing keys keep their scopes (the key guard), so they gain nothing. A plan version that chose
-- its scopes (ADR-092) leaves the new one out until a new version includes it; NULL includes it.

ALTER TABLE app.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 11
  AND scopes <@ ARRAY['templates.read', 'contacts.read', 'contacts.write', 'contact_fields.manage',
                      'messages.send', 'messages.send_marketing', 'messages.reply',
                      'conversations.read', 'conversations.write', 'automations.start',
                      'webhooks.manage']::text[]);

ALTER TABLE ops.plans DROP CONSTRAINT plans_api_scopes_check;
ALTER TABLE ops.plans ADD CONSTRAINT plans_api_scopes_check CHECK (
  api_scopes IS NULL
  OR (cardinality(api_scopes) BETWEEN 1 AND 11
      AND array_position(api_scopes, NULL) IS NULL
      AND api_scopes <@ ARRAY['templates.read', 'contacts.read', 'contacts.write',
                              'contact_fields.manage', 'messages.send', 'messages.send_marketing',
                              'messages.reply', 'conversations.read', 'conversations.write',
                              'automations.start', 'webhooks.manage']::text[]));
