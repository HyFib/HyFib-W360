-- Checks the notes already stored against the author check and the foreign key 0060 added as NOT
-- VALID (ADR-084). VALIDATE takes a lock that lets notes keep being written while the table is read.
ALTER TABLE app.conversation_notes VALIDATE CONSTRAINT conversation_notes_author;
ALTER TABLE app.conversation_notes VALIDATE CONSTRAINT conversation_notes_api_key_fk;
