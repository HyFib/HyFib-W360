-- 0212_validate_api_saved_replies: validates what 0211 added NOT VALID (ADR-291). Validation reads
-- the table without blocking its writes.
ALTER TABLE app.saved_replies VALIDATE CONSTRAINT saved_replies_created_by_api_key_fk;
ALTER TABLE app.saved_replies VALIDATE CONSTRAINT saved_replies_updated_by_api_key_fk;
ALTER TABLE app.saved_replies VALIDATE CONSTRAINT saved_replies_creator;
ALTER TABLE app.saved_replies VALIDATE CONSTRAINT saved_replies_editor;
