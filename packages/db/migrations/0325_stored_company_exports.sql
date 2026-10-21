-- Stored company exports (P5-11, ADR-415).
--
-- The company export (ADR-055) was only streamed: a download that a browser or proxy timeout could
-- cut short, and that could not be fetched again. An owner can now ask for a stored export: a worker
-- job writes the same gzip-compressed JSON Lines file, from one read-only snapshot, into the
-- company's own rows below, sealed with the keyring part by part, and owners download it from
-- Settings → Company data until it expires, 7 days after it is ready.
--
-- HyFib has no object storage in use (the S3_* settings are read by nothing; received media are
-- fetched from Meta each time, ADR-216), so the file is kept in PostgreSQL, in parts of at most
-- 1 MiB of compressed bytes, each sealed with the keyring as every other value HyFib keeps sealed
-- (AES-256-GCM, its own associated data naming the company and the part), and at most 512 MiB
-- per export. A company keeps one ready file: when a new one is ready, older ready ones are expired
-- and their parts deleted, so a company holds at most 512 MiB, and twice that while a new one is
-- being written. A row of app.company_exports records one request: who asked, its status, its size and
-- SHA-256 once ready, its times and, if it failed, a reason code (never data, ADR-129).
CREATE TABLE app.company_exports (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  -- The owner who asked; kept when they later leave, so the list still says who asked.
  requested_by_membership_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired')),
  -- Runs started; the run writing parts is the one whose number is `attempts` (a fencing token: a
  -- run that lost its lease writes parts no one reads and cannot finish the export).
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  -- While running: until when the run holds the export; a run renews it as it writes.
  lease_until timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz,
  -- When the stored file was deleted (on expiry; a failed export's parts go when it fails).
  deleted_at timestamptz,
  byte_size bigint CHECK (byte_size BETWEEN 1 AND 536870912),
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  part_count integer CHECK (part_count BETWEEN 1 AND 512),
  -- Why it failed, as a code; a database error's SQLSTATE when that was the cause.
  failure_reason text
    CHECK (failure_reason IN ('too_large', 'requester_not_allowed', 'interrupted', 'timed_out',
                              'error')),
  failure_code text CHECK (failure_code ~ '^[0-9A-Z]{5}$'),
  CONSTRAINT company_exports_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT company_exports_requester_fk FOREIGN KEY (tenant_id, requested_by_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  -- Each status carries exactly what it means; a check that comes out null passes, so each part
  -- names its columns.
  CONSTRAINT company_exports_state CHECK (
    CASE status
      WHEN 'queued' THEN lease_until IS NULL AND finished_at IS NULL AND expires_at IS NULL
        AND deleted_at IS NULL AND byte_size IS NULL AND sha256 IS NULL AND part_count IS NULL
        AND failure_reason IS NULL AND failure_code IS NULL
      WHEN 'running' THEN lease_until IS NOT NULL AND started_at IS NOT NULL AND attempts >= 1
        AND finished_at IS NULL AND expires_at IS NULL AND deleted_at IS NULL
        AND byte_size IS NULL AND sha256 IS NULL AND part_count IS NULL
        AND failure_reason IS NULL AND failure_code IS NULL
      WHEN 'ready' THEN lease_until IS NULL AND finished_at IS NOT NULL AND expires_at IS NOT NULL
        AND expires_at > finished_at AND deleted_at IS NULL AND byte_size IS NOT NULL
        AND sha256 IS NOT NULL AND part_count IS NOT NULL AND attempts >= 1
        AND failure_reason IS NULL AND failure_code IS NULL
      WHEN 'failed' THEN lease_until IS NULL AND finished_at IS NOT NULL AND expires_at IS NULL
        AND byte_size IS NULL AND sha256 IS NULL AND part_count IS NULL
        AND failure_reason IS NOT NULL
      WHEN 'expired' THEN lease_until IS NULL AND finished_at IS NOT NULL
        AND expires_at IS NOT NULL AND deleted_at IS NOT NULL AND byte_size IS NOT NULL
        AND sha256 IS NOT NULL AND part_count IS NOT NULL
        AND failure_reason IS NULL AND failure_code IS NULL
    END)
);
-- One stored export waiting or being written per company at a time. The streamed export and the
-- worker's run also take the company's export lock (an advisory lock held for their snapshot
-- transaction), so no two exports of a company are ever read at once (ADR-415).
CREATE UNIQUE INDEX company_exports_active_uq ON app.company_exports (tenant_id)
  WHERE status IN ('queued', 'running');
-- The page's list (newest first) and the requester foreign key's lookups.
CREATE INDEX company_exports_list_idx ON app.company_exports (tenant_id, requested_at DESC);
CREATE INDEX company_exports_requester_idx
  ON app.company_exports (tenant_id, requested_by_membership_id);
-- The sweep's look, across companies, for exports to expire or to signal again.
CREATE INDEX company_exports_expiry_idx ON app.company_exports (expires_at)
  WHERE status = 'ready';
CREATE INDEX company_exports_pending_idx ON app.company_exports (requested_at)
  WHERE status IN ('queued', 'running');
SELECT ops.apply_tenant_rls('app.company_exports');
-- Owners ask (insert), the worker runs and finishes them, the sweep expires them (updates of the
-- state columns only). Nobody deletes a row: it records the request after its file is gone, until
-- the company is deleted.
GRANT SELECT, INSERT ON app.company_exports TO w360_app;
GRANT UPDATE (status, attempts, lease_until, started_at, finished_at, expires_at, deleted_at,
  byte_size, sha256, part_count, failure_reason, failure_code) ON app.company_exports TO w360_app;

-- The stored file, in order: part `seq` of the run `attempt`. Only the run whose number the export
-- records is read; parts of an earlier run are deleted when the export is ready.
CREATE TABLE app.company_export_parts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  export_id uuid NOT NULL,
  attempt smallint NOT NULL CHECK (attempt BETWEEN 1 AND 10),
  seq integer NOT NULL CHECK (seq BETWEEN 0 AND 511),
  -- The compressed bytes of the part, before sealing.
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 1048576),
  -- The part sealed with the keyring (`company-export-part:<company>:<part id>`), base64url text.
  ciphertext text NOT NULL CHECK (starts_with(ciphertext, 'v1:')),
  CONSTRAINT company_export_parts_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT company_export_parts_seq_uq UNIQUE (tenant_id, export_id, attempt, seq),
  CONSTRAINT company_export_parts_export_fk FOREIGN KEY (tenant_id, export_id)
    REFERENCES app.company_exports (tenant_id, id)
);
-- Sealed bytes do not compress: kept out of line uncompressed, so the keyring sweep's look at a
-- value's first 40 characters reads one slice, not the whole part.
ALTER TABLE app.company_export_parts ALTER COLUMN ciphertext SET STORAGE EXTERNAL;
SELECT ops.apply_tenant_rls('app.company_export_parts');
-- The worker writes and deletes parts, downloads read them, the keyring sweep re-seals them.
GRANT SELECT, INSERT, DELETE ON app.company_export_parts TO w360_app;
GRANT UPDATE (ciphertext) ON app.company_export_parts TO w360_app;

-- Deleted with the company (ADR-055), first: nothing points at them. Parts before their exports.
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (37, ARRAY['app.company_export_parts']::regclass[], 'batch'),
  (38, ARRAY['app.company_exports']::regclass[], 'batch');
GRANT SELECT (tenant_id, id), DELETE ON app.company_export_parts TO w360_definer;
GRANT SELECT (tenant_id, id), DELETE ON app.company_exports TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.company_export_parts FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.company_export_parts FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_read ON app.company_exports FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.company_exports FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));

-- The sweep, every minute, across companies (ids only; what to do is decided again in the
-- company's own scope): ready exports past their expiry, exports waiting (a lost or retried-out
-- job, or one that found the export lock taken) and running exports whose lease ran out. Read as
-- the definer, which reads only these columns.
GRANT SELECT (tenant_id, id, status, requested_at, lease_until, expires_at)
  ON app.company_exports TO w360_definer;
CREATE POLICY definer_sweep_read ON app.company_exports FOR SELECT TO w360_definer USING (true);
CREATE FUNCTION ops.company_exports_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, id uuid, action text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT e.tenant_id, e.id,
         CASE WHEN e.status = 'ready' THEN 'expire' ELSE 'signal' END
    FROM app.company_exports e
   WHERE (e.status = 'ready' AND e.expires_at <= now())
      OR e.status = 'queued'
      OR (e.status = 'running' AND e.lease_until < now())
   ORDER BY coalesce(e.expires_at, e.requested_at)
   LIMIT least(greatest(coalesce(p_limit, 1), 1), 500)
$$;
REVOKE EXECUTE ON FUNCTION ops.company_exports_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.company_exports_due(integer) TO w360_app;
ALTER FUNCTION ops.company_exports_due(integer) OWNER TO w360_definer;

-- 0288's lookup of sealed values, with the stored exports' parts, so the keyring sweep re-seals
-- them under the primary key and the console counts them (a key is removed only once nothing is
-- sealed with it). Replaced as 0288 replaced it: dropped as its owner, created again and handed
-- back. The definer reads the parts' ids and sealed text, every company's (it runs for the sweep).
GRANT SELECT (tenant_id, id, ciphertext) ON app.company_export_parts TO w360_definer;
CREATE POLICY definer_read ON app.company_export_parts FOR SELECT TO w360_definer USING (true);
SET ROLE w360_definer;
DROP FUNCTION ops.sealed_value_keys();
RESET ROLE;
CREATE FUNCTION ops.sealed_value_keys()
  RETURNS TABLE (kind text, tenant_id uuid, id uuid, key_id text)
  LANGUAGE sql STABLE
  AS $$
  SELECT v.kind, v.tenant_id, v.id,
         CASE WHEN starts_with(v.head, 'v1:') THEN split_part(v.head, ':', 2) END
    FROM (
      SELECT 'whatsapp_token'::text, w.tenant_id, w.id, substr(w.credential_ciphertext, 1, 40)
        FROM app.whatsapp_accounts w WHERE w.credential_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'registration_pin', c.tenant_id, c.id, substr(c.registration_pin_ciphertext, 1, 40)
        FROM app.channel_accounts c WHERE c.registration_pin_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'http_secret', h.tenant_id, h.id, substr(h.value_ciphertext, 1, 40)
        FROM app.http_secrets h
      UNION ALL
      SELECT 'http_request', r.tenant_id, r.id, substr(r.request_ciphertext, 1, 40)
        FROM app.automation_http_calls r
       WHERE r.request_ciphertext IS NOT NULL AND r.state IN ('queued', 'in_flight')
      UNION ALL
      SELECT 'payment_key_secret', p.tenant_id, p.id, substr(p.key_secret_ciphertext, 1, 40)
        FROM app.commerce_payment_accounts p
      UNION ALL
      SELECT 'payment_webhook_secret', p.tenant_id, p.id, substr(p.webhook_secret_ciphertext, 1, 40)
        FROM app.commerce_payment_accounts p
      UNION ALL
      SELECT 'flow_private_key', f.tenant_id, f.id, substr(f.private_key_ciphertext, 1, 40)
        FROM app.flow_keys f WHERE f.private_key_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'store_credentials', s.tenant_id, s.id, substr(s.credentials_ciphertext, 1, 40)
        FROM app.commerce_stores s WHERE s.credentials_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'store_webhook_secret', s.tenant_id, s.id, substr(s.webhook_secret_ciphertext, 1, 40)
        FROM app.commerce_stores s WHERE s.webhook_secret_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'store_access_code', s.tenant_id, s.id, substr(s.access_code_ciphertext, 1, 40)
        FROM app.commerce_stores s WHERE s.access_code_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'webhook_secret', e.tenant_id, e.id, substr(e.secret_ciphertext, 1, 40)
        FROM app.webhook_endpoints e
      UNION ALL
      SELECT 'webhook_previous_secret', e.tenant_id, e.id,
             substr(e.previous_secret_ciphertext, 1, 40)
        FROM app.webhook_endpoints e WHERE e.previous_secret_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'webhook_headers', e.tenant_id, e.id, substr(e.headers_ciphertext, 1, 40)
        FROM app.webhook_endpoints e WHERE e.headers_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'webhook_oauth_secret', e.tenant_id, e.id,
             substr(e.oauth_client_secret_ciphertext, 1, 40)
        FROM app.webhook_endpoints e WHERE e.oauth_client_secret_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'webhook_oauth_private_key', e.tenant_id, e.id,
             substr(e.oauth_private_key_ciphertext, 1, 40)
        FROM app.webhook_endpoints e WHERE e.oauth_private_key_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'webhook_oauth_next_private_key', e.tenant_id, e.id,
             substr(e.oauth_next_private_key_ciphertext, 1, 40)
        FROM app.webhook_endpoints e WHERE e.oauth_next_private_key_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'provider_receipt', NULL::uuid, b.id, substr(b.body_ciphertext, 1, 40)
        FROM ops.webhook_receipts b WHERE b.body_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'queued_email', NULL::uuid, m.id, substr(m.payload_ciphertext, 1, 40)
        FROM ops.email_outbox m WHERE m.payload_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'alert_channel', NULL::uuid, a.id, substr(a.url_ciphertext, 1, 40)
        FROM ops.platform_alert_channel a
      UNION ALL
      SELECT 'company_export_part', x.tenant_id, x.id, substr(x.ciphertext, 1, 40)
        FROM app.company_export_parts x
    ) v (kind, tenant_id, id, head)
$$;
REVOKE EXECUTE ON FUNCTION ops.sealed_value_keys() FROM PUBLIC;
ALTER FUNCTION ops.sealed_value_keys() OWNER TO w360_definer;
