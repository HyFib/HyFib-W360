-- Checks the campaigns already stored against the submitter check and the foreign key 0140 added
-- as NOT VALID (ADR-202). VALIDATE takes a lock that lets campaigns keep being written while the
-- table is read.
ALTER TABLE app.campaigns VALIDATE CONSTRAINT campaigns_one_submitter;
ALTER TABLE app.campaigns VALIDATE CONSTRAINT campaigns_submitted_by_api_key_fk;
