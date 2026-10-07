-- Reports through the public API (P5-08, ADR-297). A key with the new `reports.read` scope reads
-- the numbers the Reports page shows for a period, as members who read reports do; granting it
-- needs `reports.read`. Existing keys keep their scopes (the key guard), so they gain nothing. A
-- plan version that chose its scopes (ADR-092) leaves the new one out until a new version includes
-- it; NULL includes it. With it the API has 35 scopes. As in 0218, both scope checks are replaced
-- and validated here: the tables hold one row per key and per plan version. The scopes are listed
-- in the order the API lists them.
ALTER TABLE app.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 64
  AND scopes <@ ARRAY['channels.read', 'templates.read', 'templates.write', 'templates.submit',
                      'contacts.read', 'contacts.write', 'contacts.merge', 'contact_fields.manage',
                      'messages.send', 'messages.send_marketing', 'messages.reply',
                      'conversations.read', 'conversations.write', 'campaigns.read',
                      'campaigns.write', 'campaigns.stop', 'campaigns.resume', 'automations.start',
                      'orders.read', 'orders.write', 'orders.request_payment', 'deals.read',
                      'deals.write', 'pipelines.manage', 'tasks.read', 'tasks.write', 'notes.read',
                      'notes.write', 'teams.manage', 'availability.write', 'business_hours.read',
                      'business_hours.manage', 'saved_replies.manage', 'reports.read',
                      'webhooks.manage']::text[]);

ALTER TABLE ops.plans DROP CONSTRAINT plans_api_scopes_check;
ALTER TABLE ops.plans ADD CONSTRAINT plans_api_scopes_check CHECK (
  api_scopes IS NULL
  OR (cardinality(api_scopes) BETWEEN 1 AND 64
      AND array_position(api_scopes, NULL) IS NULL
      AND api_scopes <@ ARRAY['channels.read', 'templates.read', 'templates.write',
                              'templates.submit', 'contacts.read', 'contacts.write',
                              'contacts.merge', 'contact_fields.manage', 'messages.send',
                              'messages.send_marketing', 'messages.reply', 'conversations.read',
                              'conversations.write', 'campaigns.read', 'campaigns.write',
                              'campaigns.stop', 'campaigns.resume', 'automations.start',
                              'orders.read', 'orders.write', 'orders.request_payment', 'deals.read',
                              'deals.write', 'pipelines.manage', 'tasks.read', 'tasks.write',
                              'notes.read', 'notes.write', 'teams.manage', 'availability.write',
                              'business_hours.read', 'business_hours.manage',
                              'saved_replies.manage', 'reports.read', 'webhooks.manage']::text[]));
