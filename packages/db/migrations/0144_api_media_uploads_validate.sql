-- Checks the media rows already stored against the foreign keys and the check 0143 added as NOT
-- VALID (ADR-219). VALIDATE takes a lock that lets media rows keep being written while the table is
-- read.
ALTER TABLE app.media_objects VALIDATE CONSTRAINT media_objects_channel_fk;
ALTER TABLE app.media_objects VALIDATE CONSTRAINT media_objects_api_key_fk;
ALTER TABLE app.media_objects VALIDATE CONSTRAINT media_objects_upload_check;
