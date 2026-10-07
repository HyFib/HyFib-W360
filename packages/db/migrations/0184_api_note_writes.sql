-- Adding notes to the CRM timeline through the public API (P5-08, P4-04, ADR-268). A key with the
-- new `notes.write` scope adds a note to a contact's or a deal's timeline as members do on the
-- contact and deal pages; granting it needs `crm.write`. Existing keys keep their scopes (the key
-- guard), so they gain nothing. A plan version that chose its scopes (ADR-092) leaves the new one
-- out until a new version includes it; NULL includes it. As in 0175, both scope checks are replaced
-- and validated here: the tables hold one row per key and per plan version. The scopes are listed in
-- the order the API lists them. A note written through the API is an `app.crm_activities` row with
-- no member actor, naming the key in its data, as the API's deal and task activities already are
-- (0013 allows it), so no other table changes.
ALTER TABLE app.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 24
  AND scopes <@ ARRAY['channels.read', 'templates.read', 'contacts.read', 'contacts.write',
                      'contacts.merge', 'contact_fields.manage', 'messages.send',
                      'messages.send_marketing', 'messages.reply', 'conversations.read',
                      'conversations.write', 'campaigns.read', 'campaigns.write',
                      'campaigns.stop', 'campaigns.resume', 'automations.start', 'orders.read',
                      'orders.write', 'deals.read', 'deals.write', 'tasks.read', 'tasks.write',
                      'notes.write', 'webhooks.manage']::text[]);

ALTER TABLE ops.plans DROP CONSTRAINT plans_api_scopes_check;
ALTER TABLE ops.plans ADD CONSTRAINT plans_api_scopes_check CHECK (
  api_scopes IS NULL
  OR (cardinality(api_scopes) BETWEEN 1 AND 24
      AND array_position(api_scopes, NULL) IS NULL
      AND api_scopes <@ ARRAY['channels.read', 'templates.read', 'contacts.read', 'contacts.write',
                              'contacts.merge', 'contact_fields.manage', 'messages.send',
                              'messages.send_marketing', 'messages.reply', 'conversations.read',
                              'conversations.write', 'campaigns.read', 'campaigns.write',
                              'campaigns.stop', 'campaigns.resume', 'automations.start',
                              'orders.read', 'orders.write', 'deals.read', 'deals.write',
                              'tasks.read', 'tasks.write', 'notes.write',
                              'webhooks.manage']::text[]));
