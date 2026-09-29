-- 0060_api_conversation_notes: internal notes through the public API (P5-08, ADR-084). A key with
-- `conversations.write` adds internal notes to a conversation, which the team reads in the inbox
-- and WhatsApp never receives. A note now records the key that wrote it, or the member as before:
-- exactly one of them. The runtime role inserts the new column through its table grant (0003) and
-- has no UPDATE on notes, so a note's author cannot change.

-- The check and the foreign key are added NOT VALID, so app.conversation_notes is not read under
-- this migration's lock: every note already there has a member and no key. 0062 validates them;
-- 0061 builds the index the foreign key's checks use.
ALTER TABLE app.conversation_notes
  ALTER COLUMN author_membership_id DROP NOT NULL,
  ADD COLUMN author_api_key_id uuid,
  ADD CONSTRAINT conversation_notes_author
    CHECK ((author_membership_id IS NULL) <> (author_api_key_id IS NULL)) NOT VALID,
  ADD CONSTRAINT conversation_notes_api_key_fk FOREIGN KEY (tenant_id, author_api_key_id)
    REFERENCES app.api_keys (tenant_id, id) NOT VALID;
