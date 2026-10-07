-- Reading CRM notes through the public API (P5-08, P4-04, ADR-279). A key with the new
-- `notes.read` scope lists the notes on the timelines of the company's contacts and deals and reads
-- each one; granting it needs `crm.read`. Existing keys keep their scopes (the key guard), so they
-- gain nothing. A plan version that chose its scopes (ADR-092) leaves the new one out until a new
-- version includes it; NULL includes it. As in 0184, both scope checks are replaced and validated
-- here: the tables hold one row per key and per plan version. The scopes are listed in the order
-- the API lists them. Notes are read from `app.crm_activities`, which the runtime role reads
-- already, so no grant changes.
ALTER TABLE app.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 25
  AND scopes <@ ARRAY['channels.read', 'templates.read', 'contacts.read', 'contacts.write',
                      'contacts.merge', 'contact_fields.manage', 'messages.send',
                      'messages.send_marketing', 'messages.reply', 'conversations.read',
                      'conversations.write', 'campaigns.read', 'campaigns.write',
                      'campaigns.stop', 'campaigns.resume', 'automations.start', 'orders.read',
                      'orders.write', 'deals.read', 'deals.write', 'tasks.read', 'tasks.write',
                      'notes.read', 'notes.write', 'webhooks.manage']::text[]);

ALTER TABLE ops.plans DROP CONSTRAINT plans_api_scopes_check;
ALTER TABLE ops.plans ADD CONSTRAINT plans_api_scopes_check CHECK (
  api_scopes IS NULL
  OR (cardinality(api_scopes) BETWEEN 1 AND 25
      AND array_position(api_scopes, NULL) IS NULL
      AND api_scopes <@ ARRAY['channels.read', 'templates.read', 'contacts.read', 'contacts.write',
                              'contacts.merge', 'contact_fields.manage', 'messages.send',
                              'messages.send_marketing', 'messages.reply', 'conversations.read',
                              'conversations.write', 'campaigns.read', 'campaigns.write',
                              'campaigns.stop', 'campaigns.resume', 'automations.start',
                              'orders.read', 'orders.write', 'deals.read', 'deals.write',
                              'tasks.read', 'tasks.write', 'notes.read', 'notes.write',
                              'webhooks.manage']::text[]));
