-- Template drafts through the public API (P5-08, ADR-295). A key with the new `templates.write`
-- scope adds drafts, changes their content and deletes drafts Meta never received, as members who
-- write templates do on the Templates page; granting it needs `templates.write`. Existing keys keep
-- their scopes (the key guard), so they gain nothing. A plan version that chose its scopes (ADR-092)
-- leaves the new one out until a new version includes it; NULL includes it. With it the API has 33
-- scopes, so a key or plan may now hold up to 64. As in 0211, both scope checks are replaced and
-- validated here: the tables hold one row per key and per plan version. The scopes are listed in the
-- order the API lists them.
ALTER TABLE app.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 64
  AND scopes <@ ARRAY['channels.read', 'templates.read', 'templates.write', 'contacts.read',
                      'contacts.write', 'contacts.merge', 'contact_fields.manage',
                      'messages.send', 'messages.send_marketing', 'messages.reply',
                      'conversations.read', 'conversations.write', 'campaigns.read',
                      'campaigns.write', 'campaigns.stop', 'campaigns.resume',
                      'automations.start', 'orders.read', 'orders.write',
                      'orders.request_payment', 'deals.read', 'deals.write',
                      'pipelines.manage', 'tasks.read', 'tasks.write', 'notes.read',
                      'notes.write', 'teams.manage', 'availability.write',
                      'business_hours.read', 'business_hours.manage', 'saved_replies.manage',
                      'webhooks.manage']::text[]);

ALTER TABLE ops.plans DROP CONSTRAINT plans_api_scopes_check;
ALTER TABLE ops.plans ADD CONSTRAINT plans_api_scopes_check CHECK (
  api_scopes IS NULL
  OR (cardinality(api_scopes) BETWEEN 1 AND 64
      AND array_position(api_scopes, NULL) IS NULL
      AND api_scopes <@ ARRAY['channels.read', 'templates.read', 'templates.write',
                              'contacts.read', 'contacts.write', 'contacts.merge',
                              'contact_fields.manage', 'messages.send',
                              'messages.send_marketing', 'messages.reply', 'conversations.read',
                              'conversations.write', 'campaigns.read', 'campaigns.write',
                              'campaigns.stop', 'campaigns.resume', 'automations.start',
                              'orders.read', 'orders.write', 'orders.request_payment',
                              'deals.read', 'deals.write', 'pipelines.manage', 'tasks.read',
                              'tasks.write', 'notes.read', 'notes.write', 'teams.manage',
                              'availability.write', 'business_hours.read',
                              'business_hours.manage', 'saved_replies.manage',
                              'webhooks.manage']::text[]));

-- A draft is now added by a member or by a key: `created_by_api_key_id` names the key (the audit
-- log names it too); templates found at Meta have neither. The foreign key and the check are added
-- NOT VALID, so app.message_templates is not read under this migration's lock: no template has a
-- key yet. 0217 validates them. A key is deleted only with its company, after its templates
-- (ops.tenant_deletion_steps 730 before 860), and the foreign key's checks find the company's keys
-- through UNIQUE (tenant_id, id). A deleted draft Meta never received is reused when one of the
-- same name and language is added again, and now names whoever added it again: the runtime role may
-- update both creator columns. A web server from before this release reuses such a draft without
-- naming its author, which leaves the earlier author, a member or a key, so the check holds.
ALTER TABLE app.message_templates
  ADD COLUMN created_by_api_key_id uuid,
  ADD CONSTRAINT message_templates_created_by_api_key_fk
    FOREIGN KEY (tenant_id, created_by_api_key_id) REFERENCES app.api_keys (tenant_id, id)
    NOT VALID,
  ADD CONSTRAINT message_templates_creator
    CHECK (num_nonnulls(created_by_user_id, created_by_api_key_id) <= 1) NOT VALID;
GRANT UPDATE (created_by_user_id, created_by_api_key_id) ON app.message_templates TO w360_app;
