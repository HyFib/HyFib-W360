-- Asking for payment of WhatsApp orders through the public API (P5-08, P4-06a, ADR-283). A key with
-- the new `orders.request_payment` scope asks a customer to pay a received or confirmed order with a
-- Payment Link from the company's own Razorpay account, as members do on the order page, and
-- cancels an order's open link; granting it needs `inbox.reply`. Existing keys keep their scopes
-- (the key guard), so they gain nothing. A plan version that chose its scopes (ADR-092) leaves the
-- new one out until a new version includes it; NULL includes it. As in 0198, both scope checks are
-- replaced and validated here: the tables hold one row per key and per plan version. The scopes
-- are listed in the order the API lists them.
ALTER TABLE app.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 26
  AND scopes <@ ARRAY['channels.read', 'templates.read', 'contacts.read', 'contacts.write',
                      'contacts.merge', 'contact_fields.manage', 'messages.send',
                      'messages.send_marketing', 'messages.reply', 'conversations.read',
                      'conversations.write', 'campaigns.read', 'campaigns.write',
                      'campaigns.stop', 'campaigns.resume', 'automations.start', 'orders.read',
                      'orders.write', 'orders.request_payment', 'deals.read', 'deals.write',
                      'tasks.read', 'tasks.write', 'notes.read', 'notes.write',
                      'webhooks.manage']::text[]);

ALTER TABLE ops.plans DROP CONSTRAINT plans_api_scopes_check;
ALTER TABLE ops.plans ADD CONSTRAINT plans_api_scopes_check CHECK (
  api_scopes IS NULL
  OR (cardinality(api_scopes) BETWEEN 1 AND 26
      AND array_position(api_scopes, NULL) IS NULL
      AND api_scopes <@ ARRAY['channels.read', 'templates.read', 'contacts.read', 'contacts.write',
                              'contacts.merge', 'contact_fields.manage', 'messages.send',
                              'messages.send_marketing', 'messages.reply', 'conversations.read',
                              'conversations.write', 'campaigns.read', 'campaigns.write',
                              'campaigns.stop', 'campaigns.resume', 'automations.start',
                              'orders.read', 'orders.write', 'orders.request_payment',
                              'deals.read', 'deals.write', 'tasks.read', 'tasks.write',
                              'notes.read', 'notes.write', 'webhooks.manage']::text[]));

-- A Payment Link is now asked for by a member or by a key: `created_by_api_key_id` names the key
-- (the audit log names it too, and the link's message in the chat is sent as the key). The runtime
-- role inserts links with every column (0018), so it needs no new grant, and the definer role reads
-- none of the creator columns. The foreign key and the creator check are added NOT VALID, so
-- app.commerce_payment_links is not read under this migration's lock: no link has a key yet. 0203
-- validates them. A key is deleted only with its company, after its links
-- (ops.tenant_deletion_steps 520 before 860), and the foreign key's check finds the company's keys
-- through UNIQUE (tenant_id, id).
ALTER TABLE app.commerce_payment_links
  ADD COLUMN created_by_api_key_id uuid,
  ADD CONSTRAINT commerce_payment_links_created_by_api_key_fk
    FOREIGN KEY (tenant_id, created_by_api_key_id) REFERENCES app.api_keys (tenant_id, id) NOT VALID;
ALTER TABLE app.commerce_payment_links ALTER COLUMN created_by_membership_id DROP NOT NULL;
ALTER TABLE app.commerce_payment_links
  ADD CONSTRAINT commerce_payment_links_creator
    CHECK (num_nonnulls(created_by_membership_id, created_by_api_key_id) = 1) NOT VALID;
