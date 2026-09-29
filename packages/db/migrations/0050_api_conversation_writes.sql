-- 0050_api_conversation_writes: resolving and reopening conversations through the public API (P5-08,
-- ADR-075). A key with the new `conversations.write` scope marks the company's conversations
-- resolved or open again, as members do in the inbox. The runtime role already writes a
-- conversation's status in the company's scope, and the triggers that follow a status change (reply
-- turns, cases, webhook events) already run for it, so only the scopes a key may hold change. Keys
-- keep their scopes (the key guard), so existing keys gain nothing.

ALTER TABLE app.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 8
  AND scopes <@ ARRAY['templates.read', 'contacts.read', 'contacts.write', 'messages.send',
                      'messages.send_marketing', 'messages.reply', 'conversations.read',
                      'conversations.write']::text[]);
