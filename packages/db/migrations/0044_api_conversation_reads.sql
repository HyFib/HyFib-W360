-- 0044_api_conversation_reads: reading conversations and messages through the public API (P5-08,
-- ADR-072). A key with the new `conversations.read` scope lists the company's conversations and
-- reads their messages. Keys keep their scopes (the key guard), so existing keys gain nothing: a key
-- that should read conversations is created with the scope. The pages are served by the index of
-- 0045, built concurrently in its own migration.

ALTER TABLE app.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 7
  AND scopes <@ ARRAY['templates.read', 'contacts.read', 'contacts.write', 'messages.send',
                      'messages.send_marketing', 'messages.reply', 'conversations.read']::text[]);
