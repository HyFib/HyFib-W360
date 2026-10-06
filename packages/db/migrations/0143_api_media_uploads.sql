-- 0143_api_media_uploads: files a key uploads through the public API to send by id (P5-08,
-- ADR-219). A key uploads a file for one of the company's numbers (POST /api/v1/media); HyFib
-- uploads it to WhatsApp and records the media Meta answers as a media row without a message,
-- naming the number it was uploaded for and the key. A message that sends it gets a media row of
-- its own, as a member's file has (ADR-218).

-- The foreign keys and the check are added NOT VALID, so app.media_objects is not read under this
-- migration's lock: no row has the new columns yet. 0144 validates them. Numbers and keys are
-- deleted only with their company, after its media rows (ops.tenant_deletion_steps 180 before 790
-- and 860), and each check finds the company's rows through UNIQUE (tenant_id, id).
ALTER TABLE app.media_objects
  ADD COLUMN channel_account_id uuid,
  ADD COLUMN api_key_id uuid,
  ADD CONSTRAINT media_objects_channel_fk FOREIGN KEY (tenant_id, channel_account_id)
    REFERENCES app.channel_accounts (tenant_id, id) NOT VALID,
  ADD CONSTRAINT media_objects_api_key_fk FOREIGN KEY (tenant_id, api_key_id)
    REFERENCES app.api_keys (tenant_id, id) NOT VALID,
  -- A key's upload names its number and Meta's media, and belongs to no message.
  ADD CONSTRAINT media_objects_upload_check CHECK (
    api_key_id IS NULL
    OR (channel_account_id IS NOT NULL AND provider_media_id IS NOT NULL AND message_id IS NULL)
  ) NOT VALID;

-- A key's uploads are found by their id within the company; nothing lists them yet.
