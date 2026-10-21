-- 0319_automation_http_dropped_values: the answers an automation HTTP call left out for safety
-- (P4-02, ADR-406).
--
-- An HTTP step saves values from a successful response: a JSON path, a header, the body as text or
-- the status. The worker leaves a value out when its header is refused (a credential or session
-- header, a header the step sends a secret in, or one named like a company secret, which may have
-- been added after publishing) or when it holds a secret the request carried (a server echoing the
-- request). `dropped_values` records each such answer's name with its reason code
-- (`refused_header`, `secret_header`, `echoed_secret`), never the value, so the run page can say
-- why an answer is empty and operators know a secret was echoed. Operational metadata, no
-- customer content: exported with the call, deleted with its run, kept as the call's outcome is.
--
-- Expand only: a column with a constant default is added without rewriting the table, and the
-- checks hold for every existing row ('{}'). Workers of the release before never name it; the
-- guard below is the same as 0014's with the column added to what a finished call keeps.
ALTER TABLE app.automation_http_calls
  ADD COLUMN dropped_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT automation_http_calls_dropped_values CHECK (
    jsonb_typeof(dropped_values) = 'object'
    AND (dropped_values = '{}'::jsonb OR state = 'succeeded'));

-- The worker records it with the call's outcome; the runtime role already selects every column of
-- the table (0014). No other role writes it, and no definer function reads it.
GRANT UPDATE (dropped_values) ON app.automation_http_calls TO w360_app;

-- A call's outcome is final: afterwards only the retention and erasure clean-ups change it, and
-- the answers it left out are part of that outcome.
CREATE OR REPLACE FUNCTION app.guard_automation_http_call() RETURNS trigger
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
        NEW.finished_at, NEW.dropped_values)
       IS DISTINCT FROM
       (OLD.state, OLD.status_code, OLD.error_code, OLD.duration_ms, OLD.started_at, OLD.lease_until,
        OLD.finished_at, OLD.dropped_values)
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
