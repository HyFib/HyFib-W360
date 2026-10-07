-- 0217_validate_api_template_drafts: validates what 0216 added NOT VALID (ADR-295). Validation reads
-- the table without blocking its writes.
ALTER TABLE app.message_templates VALIDATE CONSTRAINT message_templates_created_by_api_key_fk;
ALTER TABLE app.message_templates VALIDATE CONSTRAINT message_templates_creator;
