-- 0207_validate_api_pipeline_management: validates what 0206 added NOT VALID (ADR-286).
-- Validation reads the table without blocking its writes.
ALTER TABLE app.crm_pipelines VALIDATE CONSTRAINT crm_pipelines_created_by_api_key_fk;
ALTER TABLE app.crm_pipelines VALIDATE CONSTRAINT crm_pipelines_creator;
