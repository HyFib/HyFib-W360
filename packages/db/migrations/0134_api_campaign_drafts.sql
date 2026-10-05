-- Creating and editing campaign drafts through the public API (P5-08, ADR-186). A key with the new
-- `campaigns.write` scope creates drafts and edits them as members do; members still submit and
-- start them, so a draft a key wrote sends nothing until a member allowed to send campaigns starts
-- it under their own authority. Granting it needs `campaigns.write`, the permission members create
-- and edit drafts with. Existing keys keep their scopes (the key guard), so they gain nothing. A
-- plan version that chose its scopes (ADR-092) leaves the new one out until a new version includes
-- it; NULL includes it. As in 0124, both checks are replaced and validated here: the tables hold
-- one row per key and per plan version. The scopes are listed in the order the API lists them.

ALTER TABLE app.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 18
  AND scopes <@ ARRAY['channels.read', 'templates.read', 'contacts.read', 'contacts.write',
                      'contact_fields.manage', 'messages.send', 'messages.send_marketing',
                      'messages.reply', 'conversations.read', 'conversations.write',
                      'campaigns.read', 'campaigns.write', 'campaigns.stop', 'campaigns.resume',
                      'automations.start', 'orders.read', 'orders.write',
                      'webhooks.manage']::text[]);

ALTER TABLE ops.plans DROP CONSTRAINT plans_api_scopes_check;
ALTER TABLE ops.plans ADD CONSTRAINT plans_api_scopes_check CHECK (
  api_scopes IS NULL
  OR (cardinality(api_scopes) BETWEEN 1 AND 18
      AND array_position(api_scopes, NULL) IS NULL
      AND api_scopes <@ ARRAY['channels.read', 'templates.read', 'contacts.read', 'contacts.write',
                              'contact_fields.manage', 'messages.send', 'messages.send_marketing',
                              'messages.reply', 'conversations.read', 'conversations.write',
                              'campaigns.read', 'campaigns.write', 'campaigns.stop',
                              'campaigns.resume', 'automations.start', 'orders.read',
                              'orders.write', 'webhooks.manage']::text[]));
