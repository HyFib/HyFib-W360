-- 0321_saved_reply_files: saved replies that carry a file (P3-06, ADR-411, W-087).
--
-- A saved reply (0009) was text only. It may now carry one file, a photo, video, recording or
-- document of the types members send from the inbox (ADR-218), that the reply box attaches when a
-- member inserts the reply; the member reviews it and sends it through the inbox's own file path.
-- HyFib has no object storage (ADR-218, ADR-219), and Meta keeps an uploaded file only 30 days and
-- for one number (research M-046), so the file is kept here, once per company: two replies with the
-- same file (same bytes, type and name) share one row. A row is never changed; the service deletes
-- it, under the company's saved-replies lock, once no reply names it any more.
--
-- Both tables are new and empty: their foreign keys read nothing under this migration's locks, and
-- app.saved_replies itself is not altered.

CREATE TABLE app.saved_reply_files (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  -- The kind of message the file goes as, from its type, as checkReplyFile decides it
  -- (messaging/file-replies.ts); the pairs below are REPLY_FILE_TYPES, which a test keeps equal.
  kind text NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'document')),
  mime_type text NOT NULL,
  -- The name it was uploaded under, cleaned as mediaFilename cleans names (at most 150 characters).
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 150),
  -- 16 MB, HyFib's limit for a file through its servers (REPLY_FILE_MAX_BYTES).
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 16777216),
  -- Lower-case hex SHA-256 of the content, checked against it on insert.
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea NOT NULL,
  -- Only members add files (Settings → Saved replies); keys do not.
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_reply_files_tenant_id_id_uq UNIQUE (tenant_id, id),
  -- Stored once: the same bytes, type and name are one row of the company.
  CONSTRAINT saved_reply_files_content_uq UNIQUE (tenant_id, sha256, mime_type, filename),
  CONSTRAINT saved_reply_files_type CHECK (
    (kind, mime_type) IN (
      ('image', 'image/jpeg'), ('image', 'image/png'),
      ('video', 'video/mp4'), ('video', 'video/3gpp'),
      ('audio', 'audio/aac'), ('audio', 'audio/amr'), ('audio', 'audio/mp4'),
      ('audio', 'audio/mpeg'), ('audio', 'audio/ogg'),
      ('document', 'application/pdf'), ('document', 'text/plain'),
      ('document', 'application/msword'),
      ('document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      ('document', 'application/vnd.ms-excel'),
      ('document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      ('document', 'application/vnd.ms-powerpoint'),
      ('document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
    )
  ),
  CONSTRAINT saved_reply_files_content CHECK (
    octet_length(content) = size_bytes AND sha256 = encode(pg_catalog.sha256(content), 'hex')
  ),
  CONSTRAINT saved_reply_files_created_by_fk FOREIGN KEY (tenant_id, created_by_membership_id)
    REFERENCES app.memberships (tenant_id, id)
);
-- Stored out of line and uncompressed: the preview answers a media player's Range requests with
-- `substring(content from … for …)`, which then reads only the TOAST chunks of that part instead of
-- decompressing the whole value. The files are mostly photos, videos, recordings, PDFs and Office
-- files, which are compressed already (pglz would save little and cost CPU on every insert); a
-- plain-text document loses its compression, bounded by the 16 MB and 100 MB limits.
ALTER TABLE app.saved_reply_files ALTER COLUMN content SET STORAGE EXTERNAL;
SELECT ops.apply_tenant_rls('app.saved_reply_files');
-- Inserted whole and deleted, never updated. `content` is read to send, preview and export a file.
GRANT SELECT, INSERT, DELETE ON app.saved_reply_files TO w360_app;

-- Which reply carries which file: at most one file per reply, and one file for any number of
-- replies. Deleting a reply deletes its row here (the cascade); the service then deletes the file
-- if no other reply names it. A file named here cannot be deleted (no cascade from the file).
CREATE TABLE app.saved_reply_attachments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  saved_reply_id uuid NOT NULL,
  file_id uuid NOT NULL,
  attached_by_membership_id uuid NOT NULL,
  attached_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_reply_attachments_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT saved_reply_attachments_reply_uq UNIQUE (tenant_id, saved_reply_id),
  CONSTRAINT saved_reply_attachments_reply_fk FOREIGN KEY (tenant_id, saved_reply_id)
    REFERENCES app.saved_replies (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT saved_reply_attachments_file_fk FOREIGN KEY (tenant_id, file_id)
    REFERENCES app.saved_reply_files (tenant_id, id),
  CONSTRAINT saved_reply_attachments_attached_by_fk FOREIGN KEY (tenant_id, attached_by_membership_id)
    REFERENCES app.memberships (tenant_id, id)
);
-- The file foreign key's checks and the service's "does another reply name it" read.
CREATE INDEX saved_reply_attachments_file_idx ON app.saved_reply_attachments (tenant_id, file_id);
SELECT ops.apply_tenant_rls('app.saved_reply_attachments');
-- Replacing a reply's file deletes its row and inserts another.
GRANT SELECT, INSERT, DELETE ON app.saved_reply_attachments TO w360_app;

-- Deleted with the company (ADR-055): the attachments before the replies (130) and the files they
-- name, the files before the members (810) who added them.
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (125, ARRAY['app.saved_reply_attachments']::regclass[], 'batch'),
  (126, ARRAY['app.saved_reply_files']::regclass[], 'batch');
GRANT SELECT (tenant_id, id), DELETE ON app.saved_reply_attachments TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.saved_reply_attachments FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.saved_reply_attachments FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
GRANT SELECT (tenant_id, id), DELETE ON app.saved_reply_files TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.saved_reply_files FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.saved_reply_files FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
