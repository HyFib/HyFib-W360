-- Reading CRM deals through the public API (P5-08, ADR-253). A key with the new `deals.read` scope
-- lists the company's CRM pipelines with their stages and its deals, and reads each deal, as members
-- holding `crm.read` read them on the CRM board; granting it needs `crm.read`. Existing keys keep
-- their scopes (the key guard), so they gain nothing. A plan version that chose its scopes (ADR-092)
-- leaves the new one out until a new version includes it; NULL includes it. As in 0153, both checks
-- are replaced and validated here: the tables hold one row per key and per plan version. The scopes
-- are listed in the order the API lists them.

ALTER TABLE app.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 20
  AND scopes <@ ARRAY['channels.read', 'templates.read', 'contacts.read', 'contacts.write',
                      'contacts.merge', 'contact_fields.manage', 'messages.send',
                      'messages.send_marketing', 'messages.reply', 'conversations.read',
                      'conversations.write', 'campaigns.read', 'campaigns.write',
                      'campaigns.stop', 'campaigns.resume', 'automations.start', 'orders.read',
                      'orders.write', 'deals.read', 'webhooks.manage']::text[]);

ALTER TABLE ops.plans DROP CONSTRAINT plans_api_scopes_check;
ALTER TABLE ops.plans ADD CONSTRAINT plans_api_scopes_check CHECK (
  api_scopes IS NULL
  OR (cardinality(api_scopes) BETWEEN 1 AND 20
      AND array_position(api_scopes, NULL) IS NULL
      AND api_scopes <@ ARRAY['channels.read', 'templates.read', 'contacts.read', 'contacts.write',
                              'contacts.merge', 'contact_fields.manage', 'messages.send',
                              'messages.send_marketing', 'messages.reply', 'conversations.read',
                              'conversations.write', 'campaigns.read', 'campaigns.write',
                              'campaigns.stop', 'campaigns.resume', 'automations.start',
                              'orders.read', 'orders.write', 'deals.read',
                              'webhooks.manage']::text[]));
