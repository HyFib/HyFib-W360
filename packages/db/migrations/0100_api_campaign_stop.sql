-- Pausing and cancelling campaigns through the public API (P5-08, ADR-128). A key with the new
-- `campaigns.stop` scope pauses a scheduled or running campaign and cancels one that has not
-- finished, as members holding `campaigns.send` do; granting it needs `campaigns.send`. Existing
-- keys keep their scopes (the key guard), so they gain nothing. A plan version that chose its
-- scopes (ADR-092) leaves the new one out until a new version includes it; NULL includes it. As in
-- 0099, both checks are replaced and validated here: the tables hold one row per key and per plan
-- version.

ALTER TABLE app.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 13
  AND scopes <@ ARRAY['templates.read', 'contacts.read', 'contacts.write', 'contact_fields.manage',
                      'messages.send', 'messages.send_marketing', 'messages.reply',
                      'conversations.read', 'conversations.write', 'campaigns.read',
                      'campaigns.stop', 'automations.start', 'webhooks.manage']::text[]);

ALTER TABLE ops.plans DROP CONSTRAINT plans_api_scopes_check;
ALTER TABLE ops.plans ADD CONSTRAINT plans_api_scopes_check CHECK (
  api_scopes IS NULL
  OR (cardinality(api_scopes) BETWEEN 1 AND 13
      AND array_position(api_scopes, NULL) IS NULL
      AND api_scopes <@ ARRAY['templates.read', 'contacts.read', 'contacts.write',
                              'contact_fields.manage', 'messages.send', 'messages.send_marketing',
                              'messages.reply', 'conversations.read', 'conversations.write',
                              'campaigns.read', 'campaigns.stop', 'automations.start',
                              'webhooks.manage']::text[]));

-- A campaign a key paused says so (`api`), as one a member paused says `manual`. The check only
-- gains a value, so every existing row still satisfies it; campaigns are made by hand, so the
-- table is small and validating it here holds its lock briefly.
ALTER TABLE app.campaigns DROP CONSTRAINT campaigns_pause_reason_check;
ALTER TABLE app.campaigns ADD CONSTRAINT campaigns_pause_reason_check CHECK (
  pause_reason IN ('manual', 'api', 'budget_reached', 'message_cap_reached', 'template_not_approved',
                   'channel_inactive', 'launcher_removed', 'launcher_not_permitted',
                   'rate_card_missing'));
