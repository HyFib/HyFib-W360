-- Reading the company's WhatsApp numbers through the public API (P5-08, ADR-171). A key with the
-- new `channels.read` scope lists the company's numbers, as members with `channels.read` see them
-- in Settings → Channels; granting it needs that permission, which every role but billing holds.
-- Existing keys keep their scopes (the key guard), so they gain nothing. A plan version that chose
-- its scopes (ADR-092) leaves the new one out until a new version includes it; NULL includes it.
-- As in 0100, 0115 and 0116, both checks are replaced and validated here: the tables hold one row
-- per key and per plan version. The scopes are listed in the order the API lists them.

ALTER TABLE app.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 16
  AND scopes <@ ARRAY['channels.read', 'templates.read', 'contacts.read', 'contacts.write',
                      'contact_fields.manage', 'messages.send', 'messages.send_marketing',
                      'messages.reply', 'conversations.read', 'conversations.write',
                      'campaigns.read', 'campaigns.stop', 'automations.start', 'orders.read',
                      'orders.write', 'webhooks.manage']::text[]);

ALTER TABLE ops.plans DROP CONSTRAINT plans_api_scopes_check;
ALTER TABLE ops.plans ADD CONSTRAINT plans_api_scopes_check CHECK (
  api_scopes IS NULL
  OR (cardinality(api_scopes) BETWEEN 1 AND 16
      AND array_position(api_scopes, NULL) IS NULL
      AND api_scopes <@ ARRAY['channels.read', 'templates.read', 'contacts.read', 'contacts.write',
                              'contact_fields.manage', 'messages.send', 'messages.send_marketing',
                              'messages.reply', 'conversations.read', 'conversations.write',
                              'campaigns.read', 'campaigns.stop', 'automations.start',
                              'orders.read', 'orders.write', 'webhooks.manage']::text[]));
