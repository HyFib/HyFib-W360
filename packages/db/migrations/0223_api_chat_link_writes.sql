-- Chat links written through the public API (P5-08, ADR-300). A key with the new
-- `chat_links.write` scope creates links on the company's active numbers, changes them and archives
-- or restores them, as members who write campaigns do on the Growth pages; granting it needs
-- `campaigns.write`. Existing keys keep their scopes (the key guard), so they gain nothing. A plan
-- version that chose its scopes (ADR-092) leaves the new one out until a new version includes it;
-- NULL includes it. With it the API has 38 scopes. As in 0222, both scope checks are replaced and
-- validated here: the tables hold one row per key and per plan version. The scopes are listed in
-- the order the API lists them.
ALTER TABLE app.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 64
  AND scopes <@ ARRAY['channels.read', 'templates.read', 'templates.write', 'templates.submit',
                      'contacts.read', 'contacts.write', 'contacts.merge', 'contact_fields.manage',
                      'messages.send', 'messages.send_marketing', 'messages.reply',
                      'conversations.read', 'conversations.write', 'campaigns.read',
                      'campaigns.write', 'campaigns.stop', 'campaigns.resume', 'chat_links.read',
                      'chat_links.write', 'automations.start', 'flows.read', 'orders.read',
                      'orders.write', 'orders.request_payment', 'deals.read', 'deals.write',
                      'pipelines.manage', 'tasks.read', 'tasks.write', 'notes.read', 'notes.write',
                      'teams.manage', 'availability.write', 'business_hours.read',
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
                              'campaigns.stop', 'campaigns.resume', 'chat_links.read',
                              'chat_links.write', 'automations.start', 'flows.read',
                              'orders.read', 'orders.write', 'orders.request_payment',
                              'deals.read', 'deals.write', 'pipelines.manage', 'tasks.read',
                              'tasks.write', 'notes.read', 'notes.write', 'teams.manage',
                              'availability.write', 'business_hours.read',
                              'business_hours.manage', 'saved_replies.manage', 'reports.read',
                              'webhooks.manage']::text[]));

-- A link is now added by a member or by a key: `created_by_api_key_id` names the key (the audit log
-- names it too), and exactly one of the two is set. Dropping NOT NULL changes no row; the foreign
-- key and the check are added NOT VALID, so app.chat_links is not read under this migration's lock:
-- no link has a key yet. 0224 validates them. A key is deleted only with its company, after its
-- links (ops.tenant_deletion_steps 610 before 860), and the foreign key's checks find the company's
-- keys through UNIQUE (tenant_id, id). A web server from before this release always names the
-- member who adds a link, so the check holds while one still runs.
ALTER TABLE app.chat_links
  ALTER COLUMN created_by_membership_id DROP NOT NULL,
  ADD COLUMN created_by_api_key_id uuid,
  ADD CONSTRAINT chat_links_created_by_api_key_fk
    FOREIGN KEY (tenant_id, created_by_api_key_id) REFERENCES app.api_keys (tenant_id, id)
    NOT VALID,
  ADD CONSTRAINT chat_links_author
    CHECK (num_nonnulls(created_by_membership_id, created_by_api_key_id) = 1) NOT VALID;
