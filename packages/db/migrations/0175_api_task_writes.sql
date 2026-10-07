-- Creating CRM tasks through the public API (P5-08, P4-04, ADR-259). A key with the new
-- `tasks.write` scope creates tasks as members do on the Tasks page and the contact and deal pages;
-- granting it needs `crm.write`. Existing keys keep their scopes (the key guard), so they gain
-- nothing. A plan version that chose its scopes (ADR-092) leaves the new one out until a new version
-- includes it; NULL includes it. As in 0173, both scope checks are replaced and validated here: the
-- tables hold one row per key and per plan version. The scopes are listed in the order the API lists
-- them.
ALTER TABLE app.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 23
  AND scopes <@ ARRAY['channels.read', 'templates.read', 'contacts.read', 'contacts.write',
                      'contacts.merge', 'contact_fields.manage', 'messages.send',
                      'messages.send_marketing', 'messages.reply', 'conversations.read',
                      'conversations.write', 'campaigns.read', 'campaigns.write',
                      'campaigns.stop', 'campaigns.resume', 'automations.start', 'orders.read',
                      'orders.write', 'deals.read', 'deals.write', 'tasks.read', 'tasks.write',
                      'webhooks.manage']::text[]);

ALTER TABLE ops.plans DROP CONSTRAINT plans_api_scopes_check;
ALTER TABLE ops.plans ADD CONSTRAINT plans_api_scopes_check CHECK (
  api_scopes IS NULL
  OR (cardinality(api_scopes) BETWEEN 1 AND 23
      AND array_position(api_scopes, NULL) IS NULL
      AND api_scopes <@ ARRAY['channels.read', 'templates.read', 'contacts.read', 'contacts.write',
                              'contacts.merge', 'contact_fields.manage', 'messages.send',
                              'messages.send_marketing', 'messages.reply', 'conversations.read',
                              'conversations.write', 'campaigns.read', 'campaigns.write',
                              'campaigns.stop', 'campaigns.resume', 'automations.start',
                              'orders.read', 'orders.write', 'deals.read', 'deals.write',
                              'tasks.read', 'tasks.write', 'webhooks.manage']::text[]));

-- A task is now created by a member, a run of an automation (0158) or a key:
-- `created_by_api_key_id` names the key (the activity of a task about a contact names it too). The
-- runtime role inserts tasks with every column (0013), so it needs no new grant. The foreign key and
-- the replaced creator check are added NOT VALID, so app.crm_tasks is not read under this
-- migration's lock: no task has a key yet. 0176 validates them. A key is deleted only with its
-- company, after its tasks (ops.tenant_deletion_steps 290 before 860), and the foreign key's check
-- finds the company's keys through UNIQUE (tenant_id, id).
ALTER TABLE app.crm_tasks
  ADD COLUMN created_by_api_key_id uuid,
  ADD CONSTRAINT crm_tasks_created_by_api_key_fk FOREIGN KEY (tenant_id, created_by_api_key_id)
    REFERENCES app.api_keys (tenant_id, id) NOT VALID;
ALTER TABLE app.crm_tasks
  DROP CONSTRAINT crm_tasks_creator,
  ADD CONSTRAINT crm_tasks_creator
    CHECK (num_nonnulls(created_by_membership_id, created_by_automation_id,
                        created_by_api_key_id) = 1) NOT VALID;
