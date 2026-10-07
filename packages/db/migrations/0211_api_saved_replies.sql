-- Saved replies through the public API (P5-08, ADR-291). A key with the new
-- `saved_replies.manage` scope adds, changes and deletes the company's saved replies, as members
-- who supervise the inbox do in Settings → Saved replies; granting it needs `inbox.supervise`. Keys
-- that send replies (`messages.reply`) read them. Existing keys keep their scopes (the key guard),
-- so they gain nothing. A plan version that chose its scopes (ADR-092) leaves the new one out until
-- a new version includes it; NULL includes it. As in 0210, both scope checks are replaced and
-- validated here: the tables hold one row per key and per plan version. The scopes are listed in
-- the order the API lists them.
ALTER TABLE app.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 32
  AND scopes <@ ARRAY['channels.read', 'templates.read', 'contacts.read', 'contacts.write',
                      'contacts.merge', 'contact_fields.manage', 'messages.send',
                      'messages.send_marketing', 'messages.reply', 'conversations.read',
                      'conversations.write', 'campaigns.read', 'campaigns.write',
                      'campaigns.stop', 'campaigns.resume', 'automations.start', 'orders.read',
                      'orders.write', 'orders.request_payment', 'deals.read', 'deals.write',
                      'pipelines.manage', 'tasks.read', 'tasks.write', 'notes.read',
                      'notes.write', 'teams.manage', 'availability.write',
                      'business_hours.read', 'business_hours.manage', 'saved_replies.manage',
                      'webhooks.manage']::text[]);

ALTER TABLE ops.plans DROP CONSTRAINT plans_api_scopes_check;
ALTER TABLE ops.plans ADD CONSTRAINT plans_api_scopes_check CHECK (
  api_scopes IS NULL
  OR (cardinality(api_scopes) BETWEEN 1 AND 32
      AND array_position(api_scopes, NULL) IS NULL
      AND api_scopes <@ ARRAY['channels.read', 'templates.read', 'contacts.read', 'contacts.write',
                              'contacts.merge', 'contact_fields.manage', 'messages.send',
                              'messages.send_marketing', 'messages.reply', 'conversations.read',
                              'conversations.write', 'campaigns.read', 'campaigns.write',
                              'campaigns.stop', 'campaigns.resume', 'automations.start',
                              'orders.read', 'orders.write', 'orders.request_payment',
                              'deals.read', 'deals.write', 'pipelines.manage', 'tasks.read',
                              'tasks.write', 'notes.read', 'notes.write', 'teams.manage',
                              'availability.write', 'business_hours.read',
                              'business_hours.manage', 'saved_replies.manage',
                              'webhooks.manage']::text[]));

-- A saved reply is now added and last changed by a member or by a key: `created_by_api_key_id` and
-- `updated_by_api_key_id` name the key (the audit log names it too). The runtime role inserts saved
-- replies with every column (0009) and now also updates the new editor column. The foreign keys and
-- the checks are added NOT VALID, so app.saved_replies is not read under this migration's lock: no
-- saved reply has a key yet. 0212 validates them. A key is deleted only with its company, after its
-- saved replies (ops.tenant_deletion_steps 130 before 860), and the foreign keys' checks find the
-- company's keys through UNIQUE (tenant_id, id). The last editor is the member when
-- `updated_by_membership_id` is set, otherwise the key: a web server from before this release
-- changes a reply naming its member and leaves `updated_by_api_key_id` as it was, so the editor
-- check asks for one or both, and such a change stays valid during a rollout or after a rollback.
ALTER TABLE app.saved_replies
  ADD COLUMN created_by_api_key_id uuid,
  ADD COLUMN updated_by_api_key_id uuid,
  ADD CONSTRAINT saved_replies_created_by_api_key_fk
    FOREIGN KEY (tenant_id, created_by_api_key_id) REFERENCES app.api_keys (tenant_id, id)
    NOT VALID,
  ADD CONSTRAINT saved_replies_updated_by_api_key_fk
    FOREIGN KEY (tenant_id, updated_by_api_key_id) REFERENCES app.api_keys (tenant_id, id)
    NOT VALID;
ALTER TABLE app.saved_replies ALTER COLUMN created_by_membership_id DROP NOT NULL;
ALTER TABLE app.saved_replies ALTER COLUMN updated_by_membership_id DROP NOT NULL;
ALTER TABLE app.saved_replies
  ADD CONSTRAINT saved_replies_creator
    CHECK (num_nonnulls(created_by_membership_id, created_by_api_key_id) = 1) NOT VALID,
  ADD CONSTRAINT saved_replies_editor
    CHECK (num_nonnulls(updated_by_membership_id, updated_by_api_key_id) >= 1) NOT VALID;
GRANT UPDATE (updated_by_api_key_id) ON app.saved_replies TO w360_app;
