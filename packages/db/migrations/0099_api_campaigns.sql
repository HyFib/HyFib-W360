-- Reading campaigns through the public API (P5-08, ADR-125). A key with the new `campaigns.read`
-- scope lists the company's campaigns and reads one with its results, as members who see campaigns
-- do; granting it needs `campaigns.read`. Existing keys keep their scopes (the key guard), so they
-- gain nothing. A plan version that chose its scopes (ADR-092) leaves the new one out until a new
-- version includes it; NULL includes it. As in 0092, both checks are replaced and validated here:
-- the tables hold one row per key and per plan version.

ALTER TABLE app.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 12
  AND scopes <@ ARRAY['templates.read', 'contacts.read', 'contacts.write', 'contact_fields.manage',
                      'messages.send', 'messages.send_marketing', 'messages.reply',
                      'conversations.read', 'conversations.write', 'campaigns.read',
                      'automations.start', 'webhooks.manage']::text[]);

ALTER TABLE ops.plans DROP CONSTRAINT plans_api_scopes_check;
ALTER TABLE ops.plans ADD CONSTRAINT plans_api_scopes_check CHECK (
  api_scopes IS NULL
  OR (cardinality(api_scopes) BETWEEN 1 AND 12
      AND array_position(api_scopes, NULL) IS NULL
      AND api_scopes <@ ARRAY['templates.read', 'contacts.read', 'contacts.write',
                              'contact_fields.manage', 'messages.send', 'messages.send_marketing',
                              'messages.reply', 'conversations.read', 'conversations.write',
                              'campaigns.read', 'automations.start', 'webhooks.manage']::text[]));
