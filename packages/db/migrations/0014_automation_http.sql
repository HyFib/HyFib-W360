-- 0014_automation_http: the automation HTTP step (P4-02). A step calls a company's own API over
-- https through the egress guard (packages/core/src/egress.ts): only domains the company allowed,
-- only public addresses, no redirects, limited size and time. Secrets for request headers are
-- stored encrypted, by name, and only the worker decrypts them. Calls are written ahead: the runner
-- records the call and waits in the step's transaction; the worker claims it (queued -> in_flight),
-- makes the request with no locks held and records the outcome. A call still in flight at its
-- deadline is marked unknown and never retried, because the server may have acted on it.

-- Domains a company's automations may call ------------------------------------------------------------
CREATE TABLE app.http_allowed_domains (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  -- A host name ("api.example.com") or all its subdomains ("*.example.com"), in lower case.
  domain text NOT NULL CHECK (
    char_length(domain) <= 253
    AND domain ~ '^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT http_allowed_domains_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT http_allowed_domains_domain_uq UNIQUE (tenant_id, domain),
  CONSTRAINT http_allowed_domains_created_by_fk FOREIGN KEY (tenant_id, created_by_membership_id)
    REFERENCES app.memberships (tenant_id, id)
);

-- Secrets for HTTP step headers -------------------------------------------------------------------------
-- The value is encrypted with the application keyring, bound to the row, and never shown again:
-- the web app only writes it, and the worker decrypts it when it makes a request. Steps refer to a
-- secret by name ({{secret.<name>}} in a header value), so the automation graph never holds it.
-- A secret is only ever sent to the domain it was saved for (one of the allowed domains then), so
-- whoever edits automations cannot send one company API's key to another allowed host.
CREATE TABLE app.http_secrets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{0,39}$'),
  domain text NOT NULL CHECK (
    char_length(domain) <= 253
    AND domain ~ '^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'),
  value_ciphertext text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_membership_id uuid NOT NULL,
  updated_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT http_secrets_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT http_secrets_name_uq UNIQUE (tenant_id, name),
  CONSTRAINT http_secrets_created_by_fk FOREIGN KEY (tenant_id, created_by_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT http_secrets_updated_by_fk FOREIGN KEY (tenant_id, updated_by_membership_id)
    REFERENCES app.memberships (tenant_id, id)
);
CREATE TRIGGER http_secrets_touch BEFORE UPDATE ON app.http_secrets
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- HTTP calls made by automation runs -----------------------------------------------------------------
-- One call per visit of a step. The request (URL, headers without secret values, body) is encrypted
-- and erased once the call has an outcome. The host and the step's path as written (placeholders not
-- filled in, no query) stay for the run page, so the row never holds a customer's values in plain
-- text. Values saved from the response are personal data like captured answers and are cleared
-- with them.
CREATE TABLE app.automation_http_calls (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  node_id text NOT NULL CHECK (node_id ~ '^[a-z0-9_-]{1,32}$'),
  node_visit integer NOT NULL CHECK (node_visit >= 1),
  method text NOT NULL CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  host text NOT NULL CHECK (char_length(host) BETWEEN 1 AND 253),
  path text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 300),
  request_ciphertext text,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'in_flight', 'succeeded', 'failed', 'unknown', 'canceled')),
  status_code smallint CHECK (status_code BETWEEN 100 AND 599),
  error_code text CHECK (char_length(error_code) <= 40),
  duration_ms integer CHECK (duration_ms >= 0),
  saved_values jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(saved_values) = 'object'),
  started_at timestamptz,
  lease_until timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_http_calls_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT automation_http_calls_visit_uq UNIQUE (tenant_id, run_id, node_id, node_visit),
  CONSTRAINT automation_http_calls_run_fk FOREIGN KEY (tenant_id, run_id)
    REFERENCES app.automation_runs (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT automation_http_calls_state CHECK (
    (state = 'queued' AND started_at IS NULL AND finished_at IS NULL AND status_code IS NULL)
    OR (state = 'in_flight' AND started_at IS NOT NULL AND lease_until IS NOT NULL
        AND finished_at IS NULL AND status_code IS NULL)
    OR (state = 'succeeded' AND finished_at IS NOT NULL AND status_code BETWEEN 200 AND 299)
    OR (state = 'failed' AND finished_at IS NOT NULL AND (status_code IS NULL OR status_code NOT BETWEEN 200 AND 299))
    OR (state IN ('unknown', 'canceled') AND finished_at IS NOT NULL AND status_code IS NULL)),
  CONSTRAINT automation_http_calls_values CHECK (saved_values = '{}'::jsonb OR state = 'succeeded')
);
CREATE INDEX automation_http_calls_run_idx ON app.automation_http_calls (tenant_id, run_id, created_at);
CREATE INDEX automation_http_calls_queued_idx ON app.automation_http_calls (created_at)
  WHERE state = 'queued';

-- A call's outcome is final: afterwards only the retention and erasure clean-ups change it.
CREATE FUNCTION app.guard_automation_http_call() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF pg_catalog.current_setting('w360.allow_retention_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'automation HTTP calls are deleted with their run' USING ERRCODE = 'W3403';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.run_id, NEW.node_id, NEW.node_visit, NEW.method, NEW.host, NEW.path,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.run_id, OLD.node_id, OLD.node_visit, OLD.method, OLD.host, OLD.path,
      OLD.created_at) THEN
    RAISE EXCEPTION 'what an automation HTTP call requested is fixed' USING ERRCODE = 'W3403';
  END IF;
  IF OLD.state IN ('succeeded', 'failed', 'unknown', 'canceled') THEN
    IF (NEW.state, NEW.status_code, NEW.error_code, NEW.duration_ms, NEW.started_at, NEW.lease_until,
        NEW.finished_at)
       IS DISTINCT FROM
       (OLD.state, OLD.status_code, OLD.error_code, OLD.duration_ms, OLD.started_at, OLD.lease_until,
        OLD.finished_at)
       OR (NEW.saved_values IS DISTINCT FROM OLD.saved_values AND NEW.saved_values <> '{}'::jsonb)
       OR (NEW.request_ciphertext IS DISTINCT FROM OLD.request_ciphertext
           AND NEW.request_ciphertext IS NOT NULL) THEN
      RAISE EXCEPTION 'a finished automation HTTP call cannot change' USING ERRCODE = 'W3403';
    END IF;
  ELSIF OLD.state = 'in_flight' AND NEW.state = 'queued' THEN
    RAISE EXCEPTION 'a call that may have been sent is never queued again' USING ERRCODE = 'W3403';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER automation_http_calls_guard BEFORE UPDATE OR DELETE ON app.automation_http_calls
  FOR EACH ROW EXECUTE FUNCTION app.guard_automation_http_call();

-- Runs: waiting for an HTTP call, and a budget of calls per run ----------------------------------------
ALTER TABLE app.automation_runs DROP CONSTRAINT automation_runs_waiting_for_check;
ALTER TABLE app.automation_runs ADD CONSTRAINT automation_runs_waiting_for_check
  CHECK (waiting_for IN ('reply', 'timer', 'http'));
ALTER TABLE app.automation_runs ADD COLUMN http_call_count integer NOT NULL DEFAULT 0
  CHECK (http_call_count >= 0);

ALTER TABLE app.automation_runs DROP CONSTRAINT automation_runs_end;
ALTER TABLE app.automation_runs ADD CONSTRAINT automation_runs_end CHECK (
  (status IN ('running', 'waiting') AND ended_at IS NULL AND end_reason IS NULL AND ended_by_membership_id IS NULL)
  OR (status = 'completed' AND ended_at IS NOT NULL AND end_reason IN ('end_node', 'no_next'))
  OR (status = 'handed_off' AND ended_at IS NOT NULL AND end_reason = 'handoff_node')
  OR (status = 'taken_over' AND ended_at IS NOT NULL AND end_reason IN ('agent_replied', 'assigned', 'take_over'))
  OR (status = 'stopped' AND ended_at IS NOT NULL
      AND end_reason IN ('stopped_by_member', 'conversation_resolved', 'opted_out', 'contact_erased',
                         'automation_archived'))
  OR (status = 'failed' AND ended_at IS NOT NULL
      AND end_reason IN ('budget_steps', 'budget_loop', 'budget_messages', 'budget_http', 'expired',
                         'send_blocked', 'send_failed', 'error')));

-- Step log: a request made, and the response (or its absence) handled.
ALTER TABLE app.automation_run_steps DROP CONSTRAINT automation_run_steps_outcome_check;
ALTER TABLE app.automation_run_steps ADD CONSTRAINT automation_run_steps_outcome_check
  CHECK (outcome IN ('started', 'sent', 'asked', 'answered', 'retried', 'timed_out', 'branched', 'updated',
    'waiting', 'resumed', 'handed_off', 'completed', 'failed', 'stopped', 'taken_over', 'requested',
    'responded'));

-- Same guard as 0012, with the HTTP call count among the columns an ended run keeps.
CREATE OR REPLACE FUNCTION app.guard_automation_run() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF pg_catalog.current_setting('w360.allow_retention_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'automation runs cannot be deleted' USING ERRCODE = 'W3403';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.automation_id, NEW.version_id, NEW.conversation_id, NEW.contact_id,
      NEW.channel_account_id, NEW.mode, NEW.trigger_type, NEW.trigger_message_id,
      NEW.started_by_membership_id, NEW.started_by_user_id, NEW.started_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.automation_id, OLD.version_id, OLD.conversation_id, OLD.contact_id,
      OLD.channel_account_id, OLD.mode, OLD.trigger_type, OLD.trigger_message_id,
      OLD.started_by_membership_id, OLD.started_by_user_id, OLD.started_at) THEN
    RAISE EXCEPTION 'what started an automation run is fixed' USING ERRCODE = 'W3403';
  END IF;
  IF OLD.status NOT IN ('running', 'waiting') THEN
    IF (NEW.status, NEW.current_node_id, NEW.node_visit, NEW.waiting_for, NEW.wait_until,
        NEW.input_message_id, NEW.pending_message_id, NEW.retries, NEW.failures, NEW.step_count,
        NEW.message_count, NEW.http_call_count, NEW.visits, NEW.next_step_at, NEW.ended_at,
        NEW.end_reason, NEW.end_detail, NEW.ended_by_membership_id)
       IS DISTINCT FROM
       (OLD.status, OLD.current_node_id, OLD.node_visit, OLD.waiting_for, OLD.wait_until,
        OLD.input_message_id, OLD.pending_message_id, OLD.retries, OLD.failures, OLD.step_count,
        OLD.message_count, OLD.http_call_count, OLD.visits, OLD.next_step_at, OLD.ended_at,
        OLD.end_reason, OLD.end_detail, OLD.ended_by_membership_id)
       OR (NEW.variables IS DISTINCT FROM OLD.variables AND NEW.variables <> '{}'::jsonb) THEN
      RAISE EXCEPTION 'an ended automation run cannot change' USING ERRCODE = 'W3403';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- Queued calls whose job was lost: the worker's sweep signals them again (ids only). -----------------
CREATE FUNCTION ops.automation_http_calls_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, call_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT h.tenant_id, h.id
    FROM app.automation_http_calls h
    JOIN app.tenants t ON t.id = h.tenant_id AND t.status = 'active'
   WHERE h.state = 'queued' AND h.created_at <= now() - interval '30 seconds'
   ORDER BY h.created_at
   LIMIT least(greatest(p_limit, 1), 500)
$$;
CREATE POLICY definer_access ON app.automation_http_calls TO w360_definer USING (true) WITH CHECK (true);
GRANT SELECT (tenant_id, id, run_id, state, created_at, saved_values, request_ciphertext)
  ON app.automation_http_calls TO w360_definer;
GRANT UPDATE (saved_values, request_ciphertext, state, error_code, finished_at, lease_until)
  ON app.automation_http_calls TO w360_definer;
GRANT EXECUTE ON FUNCTION ops.automation_http_calls_due(integer) TO w360_app;
ALTER FUNCTION ops.automation_http_calls_due(integer) OWNER TO w360_definer;

-- Retention: values saved from responses are cleared with the run's captured answers (30 days after
-- it ends); calls are deleted with their run (180 days). Same body as 0011 plus the calls.
SET ROLE w360_definer;
DROP FUNCTION ops.apply_automation_retention(integer);
RESET ROLE;
CREATE FUNCTION ops.apply_automation_retention(p_limit integer)
  RETURNS TABLE (cleared integer, deleted integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_limit integer := least(greatest(p_limit, 1), 5000);
  v_cleared integer;
  v_deleted integer;
BEGIN
  UPDATE app.automation_http_calls h SET saved_values = '{}'::jsonb, request_ciphertext = NULL
   WHERE h.id IN (
     SELECT x.id FROM app.automation_http_calls x
       JOIN app.automation_runs r ON r.tenant_id = x.tenant_id AND r.id = x.run_id
      WHERE r.ended_at < now() - interval '30 days'
        AND (x.saved_values <> '{}'::jsonb OR x.request_ciphertext IS NOT NULL)
      ORDER BY r.ended_at
      LIMIT v_limit);
  UPDATE app.automation_runs r SET variables = '{}'::jsonb
   WHERE r.id IN (
     SELECT x.id FROM app.automation_runs x
      WHERE x.ended_at < now() - interval '30 days' AND x.variables <> '{}'::jsonb
      ORDER BY x.ended_at
      LIMIT v_limit);
  GET DIAGNOSTICS v_cleared = ROW_COUNT;
  PERFORM pg_catalog.set_config('w360.allow_retention_purge', 'on', true);
  DELETE FROM app.automation_runs r
   WHERE r.id IN (
     SELECT x.id FROM app.automation_runs x
      WHERE x.ended_at < now() - interval '180 days'
      ORDER BY x.ended_at
      LIMIT v_limit);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  PERFORM pg_catalog.set_config('w360.allow_retention_purge', 'off', true);
  RETURN QUERY SELECT v_cleared, v_deleted;
END
$$;
GRANT EXECUTE ON FUNCTION ops.apply_automation_retention(integer) TO w360_app;
ALTER FUNCTION ops.apply_automation_retention(integer) OWNER TO w360_definer;

-- Contact erasure: also clears values saved from HTTP responses and cancels calls not yet made.
-- Same body as 0013 plus the HTTP block (see the note on replacing definer functions in 0011).
SET ROLE w360_definer;
DROP FUNCTION app.erase_contact(uuid, boolean);
RESET ROLE;
CREATE FUNCTION app.erase_contact(p_contact_id uuid, p_suppress boolean) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_user text := app.current_user_id();
  v_contact record;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  -- Conversations first: every other writer (ingestion, replies, the automation runner) locks the
  -- conversation before its run and before the contact, so erasure takes the same order.
  PERFORM 1 FROM app.conversations cv
    WHERE cv.tenant_id = v_tenant AND cv.contact_id = p_contact_id
    ORDER BY cv.id FOR UPDATE;
  SELECT c.id, c.phone_e164, c.erased_at INTO v_contact
    FROM app.contacts c WHERE c.tenant_id = v_tenant AND c.id = p_contact_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contact not found' USING ERRCODE = 'W3404';
  END IF;
  IF v_contact.erased_at IS NOT NULL THEN
    RETURN false;
  END IF;
  IF p_suppress AND v_contact.phone_e164 IS NOT NULL THEN
    INSERT INTO app.suppressions (id, tenant_id, phone_e164, reason, created_by_user_id)
    VALUES (gen_random_uuid(), v_tenant, v_contact.phone_e164, 'erased', v_user)
    ON CONFLICT (tenant_id, phone_e164) DO NOTHING;
  END IF;
  INSERT INTO app.consent_events (id, tenant_id, contact_id, purpose, action, source, actor_type, actor_id, occurred_at)
  SELECT gen_random_uuid(), v_tenant, p_contact_id, p.purpose, 'opt_out', 'erasure',
         CASE WHEN v_user IS NULL THEN 'system' ELSE 'user' END, v_user, now()
    FROM (VALUES ('marketing'), ('utility')) AS p (purpose);

  -- Automation runs: captured answers are cleared and active runs stop (no further bot messages).
  UPDATE app.automation_runs r SET variables = '{}'::jsonb
   WHERE r.tenant_id = v_tenant AND r.contact_id = p_contact_id;
  UPDATE app.automation_runs r
     SET status = 'stopped', end_reason = 'contact_erased', ended_at = now(), current_node_id = NULL,
         waiting_for = NULL, wait_until = NULL, input_message_id = NULL, next_step_at = NULL
   WHERE r.tenant_id = v_tenant AND r.contact_id = p_contact_id AND r.status IN ('running', 'waiting');

  -- Automation HTTP calls: values saved from responses are cleared, calls not yet made are
  -- cancelled, and calls in flight become unknown (a call already sent cannot be recalled, and the
  -- result the worker records later is not kept).
  UPDATE app.automation_http_calls h SET saved_values = '{}'::jsonb, request_ciphertext = NULL
   WHERE h.tenant_id = v_tenant
     AND (h.saved_values <> '{}'::jsonb OR h.request_ciphertext IS NOT NULL)
     AND h.run_id IN (SELECT r.id FROM app.automation_runs r
                       WHERE r.tenant_id = v_tenant AND r.contact_id = p_contact_id);
  UPDATE app.automation_http_calls h
     SET state = 'canceled', error_code = 'contact_erased', finished_at = now()
   WHERE h.tenant_id = v_tenant AND h.state = 'queued'
     AND h.run_id IN (SELECT r.id FROM app.automation_runs r
                       WHERE r.tenant_id = v_tenant AND r.contact_id = p_contact_id);
  UPDATE app.automation_http_calls h
     SET state = 'unknown', error_code = 'contact_erased', finished_at = now(), lease_until = NULL
   WHERE h.tenant_id = v_tenant AND h.state = 'in_flight'
     AND h.run_id IN (SELECT r.id FROM app.automation_runs r
                       WHERE r.tenant_id = v_tenant AND r.contact_id = p_contact_id);

  -- CRM: the timeline (with notes) and tasks go; deals keep what reports need, without free text.
  PERFORM pg_catalog.set_config('w360.contact_erasure', 'on', true);
  DELETE FROM app.crm_activities a WHERE a.tenant_id = v_tenant AND a.contact_id = p_contact_id;
  PERFORM pg_catalog.set_config('w360.contact_erasure', 'off', true);
  DELETE FROM app.crm_tasks t WHERE t.tenant_id = v_tenant AND t.contact_id = p_contact_id;
  UPDATE app.crm_deals d SET title = 'Deal (contact erased)', lost_reason = NULL
   WHERE d.tenant_id = v_tenant AND d.contact_id = p_contact_id;

  UPDATE app.send_intents s
     SET state = 'canceled', lease_until = NULL, resolved_at = now(), last_error_code = 'contact_erased',
         last_error = 'Not sent: the contact was erased.'
   WHERE s.tenant_id = v_tenant AND s.state IN ('queued', 'deferred')
     AND s.message_id IN (SELECT m.id FROM app.messages m JOIN app.conversations cv
                            ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
                           WHERE m.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  UPDATE app.messages m
     SET content = '{"redacted": true}'::jsonb,
         status = CASE WHEN m.status IN ('queued', 'sending') THEN 'canceled' ELSE m.status END,
         status_rank = CASE WHEN m.status IN ('queued', 'sending') THEN 5 ELSE m.status_rank END,
         status_at = CASE WHEN m.status IN ('queued', 'sending') THEN now() ELSE m.status_at END,
         error_title = NULL
   WHERE m.tenant_id = v_tenant
     AND m.conversation_id IN (SELECT cv.id FROM app.conversations cv
                                WHERE cv.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  PERFORM pg_catalog.set_config('w360.contact_erasure', 'on', true);
  UPDATE app.message_status_events e
     SET recipient_wa_id = NULL, recipient_bsuid = NULL
   WHERE e.tenant_id = v_tenant AND (e.recipient_wa_id IS NOT NULL OR e.recipient_bsuid IS NOT NULL)
     AND e.message_id IN (SELECT m.id FROM app.messages m JOIN app.conversations cv
                            ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
                           WHERE m.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  PERFORM pg_catalog.set_config('w360.contact_erasure', 'off', true);
  DELETE FROM app.media_objects mo
   WHERE mo.tenant_id = v_tenant
     AND mo.message_id IN (SELECT m.id FROM app.messages m JOIN app.conversations cv
                             ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
                            WHERE m.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  DELETE FROM app.conversation_notes n
   WHERE n.tenant_id = v_tenant
     AND n.conversation_id IN (SELECT cv.id FROM app.conversations cv
                                WHERE cv.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  UPDATE app.conversations cv SET last_message_preview = NULL
   WHERE cv.tenant_id = v_tenant AND cv.contact_id = p_contact_id;
  DELETE FROM app.contact_identities i WHERE i.tenant_id = v_tenant AND i.contact_id = p_contact_id;
  DELETE FROM app.contact_tags t WHERE t.tenant_id = v_tenant AND t.contact_id = p_contact_id;
  UPDATE app.contacts c
     SET display_name = NULL, phone_e164 = NULL, email = NULL, attributes = '{}'::jsonb, erased_at = now()
   WHERE c.tenant_id = v_tenant AND c.id = p_contact_id;
  RETURN true;
END
$$;
GRANT EXECUTE ON FUNCTION app.erase_contact(uuid, boolean) TO w360_app;
ALTER FUNCTION app.erase_contact(uuid, boolean) OWNER TO w360_definer;

-- Row level security and privileges --------------------------------------------------------------
SELECT ops.apply_tenant_rls('app.http_allowed_domains');
SELECT ops.apply_tenant_rls('app.http_secrets');
SELECT ops.apply_tenant_rls('app.automation_http_calls');

GRANT SELECT, INSERT, DELETE ON app.http_allowed_domains TO w360_app;
GRANT SELECT, INSERT, DELETE ON app.http_secrets TO w360_app;
GRANT UPDATE (domain, value_ciphertext, version, updated_by_membership_id, updated_at)
  ON app.http_secrets TO w360_app;
GRANT SELECT, INSERT ON app.automation_http_calls TO w360_app;
GRANT UPDATE (request_ciphertext, state, status_code, error_code, duration_ms, saved_values, started_at,
  lease_until, finished_at) ON app.automation_http_calls TO w360_app;
GRANT UPDATE (http_call_count) ON app.automation_runs TO w360_app;
