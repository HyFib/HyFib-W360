-- 0025_outgoing_webhooks: companies' webhook endpoints, the events captured for them and their
-- deliveries (P5-09, ADR-053). Events are captured by triggers in the transaction that makes the
-- change and hold ids and non-personal facts only; the worker builds each payload when it delivers.

-- Endpoints ------------------------------------------------------------------------------------------
-- The secret is stored encrypted by the application (it is needed to sign); the previous secret
-- also signs until it expires after a rotation.
CREATE TABLE app.webhook_endpoints (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  url text NOT NULL CHECK (char_length(url) BETWEEN 9 AND 2048 AND url ~ '^https?://[^[:space:]]+$'),
  description text CHECK (char_length(description) <= 200),
  event_types text[] NOT NULL CHECK (cardinality(event_types) BETWEEN 1 AND 4
    AND event_types <@ ARRAY['message.received', 'message.status', 'consent.changed',
                             'template.status_changed']::text[]),
  secret_ciphertext text NOT NULL CHECK (char_length(secret_ciphertext) <= 1000),
  secret_version integer NOT NULL DEFAULT 1 CHECK (secret_version >= 1),
  previous_secret_ciphertext text CHECK (char_length(previous_secret_ciphertext) <= 1000),
  previous_secret_expires_at timestamptz,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
  disabled_reason text CHECK (disabled_reason IN ('manual', 'failing')),
  disabled_at timestamptz,
  -- Since when every attempt has failed (cleared by a success); drives the automatic disabling.
  failing_since timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_by_user_id text NOT NULL REFERENCES auth.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK ((state = 'disabled') = (disabled_reason IS NOT NULL)),
  CHECK ((state = 'disabled') = (disabled_at IS NOT NULL)),
  CHECK ((previous_secret_ciphertext IS NULL) = (previous_secret_expires_at IS NULL)),
  CHECK (previous_secret_ciphertext IS NULL OR secret_version > 1)
);
CREATE INDEX webhook_endpoints_active_idx ON app.webhook_endpoints (tenant_id) WHERE state = 'active';

SELECT ops.apply_tenant_rls('app.webhook_endpoints');
CREATE POLICY definer_all ON app.webhook_endpoints TO w360_definer USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, DELETE ON app.webhook_endpoints TO w360_app;
GRANT UPDATE (url, description, event_types, secret_ciphertext, secret_version,
  previous_secret_ciphertext, previous_secret_expires_at, state, disabled_reason, disabled_at,
  failing_since, last_success_at, last_failure_at, updated_at) ON app.webhook_endpoints TO w360_app;
GRANT SELECT ON app.webhook_endpoints TO w360_definer;

-- Events ---------------------------------------------------------------------------------------------
-- What happened, without personal data: ids, the status reached and small facts. No foreign keys,
-- so erasure and retention of messages and contacts never wait on webhook history.
CREATE TABLE app.webhook_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  type text NOT NULL CHECK (type IN ('message.received', 'message.status', 'consent.changed',
                                     'template.status_changed', 'ping')),
  message_id uuid,
  conversation_id uuid,
  contact_id uuid,
  template_id uuid,
  status text CHECK (char_length(status) <= 32),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 2048),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX webhook_events_created_idx ON app.webhook_events (created_at);

SELECT ops.apply_tenant_rls('app.webhook_events');
CREATE POLICY definer_all ON app.webhook_events TO w360_definer USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON app.webhook_events TO w360_app;
GRANT SELECT, INSERT, DELETE ON app.webhook_events TO w360_definer;

-- Deliveries -------------------------------------------------------------------------------------------
-- One per event and endpoint. `delivering` holds a lease: a delivery whose lease expired (the worker
-- was lost) is attempted again, so delivery is at least once.
CREATE TABLE app.webhook_deliveries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  endpoint_id uuid NOT NULL,
  event_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivering', 'succeeded', 'failed')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_attempt_at timestamptz,
  last_status_code smallint CHECK (last_status_code BETWEEN 100 AND 599),
  last_error text CHECK (char_length(last_error) <= 64),
  last_duration_ms integer CHECK (last_duration_ms >= 0),
  delivered_at timestamptz,
  -- The delivery a member replayed (a new delivery of the same event).
  replay_of uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT webhook_deliveries_endpoint_fk FOREIGN KEY (tenant_id, endpoint_id)
    REFERENCES app.webhook_endpoints (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT webhook_deliveries_event_fk FOREIGN KEY (tenant_id, event_id)
    REFERENCES app.webhook_events (tenant_id, id) ON DELETE CASCADE,
  CHECK ((state = 'delivering') = (lease_until IS NOT NULL)),
  CHECK ((state = 'succeeded') = (delivered_at IS NOT NULL))
);
CREATE INDEX webhook_deliveries_due_idx ON app.webhook_deliveries (tenant_id, next_attempt_at)
  WHERE state = 'pending';
CREATE INDEX webhook_deliveries_lease_idx ON app.webhook_deliveries (lease_until)
  WHERE state = 'delivering';
CREATE INDEX webhook_deliveries_endpoint_idx
  ON app.webhook_deliveries (tenant_id, endpoint_id, created_at DESC, id DESC);
CREATE INDEX webhook_deliveries_event_idx ON app.webhook_deliveries (tenant_id, event_id);
CREATE INDEX webhook_deliveries_created_idx ON app.webhook_deliveries (created_at);

SELECT ops.apply_tenant_rls('app.webhook_deliveries');
CREATE POLICY definer_all ON app.webhook_deliveries TO w360_definer USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON app.webhook_deliveries TO w360_app;
GRANT UPDATE (state, attempts, next_attempt_at, lease_until, last_attempt_at, last_status_code,
  last_error, last_duration_ms, delivered_at) ON app.webhook_deliveries TO w360_app;
GRANT SELECT, INSERT, DELETE ON app.webhook_deliveries TO w360_definer;

-- A new delivery wakes the worker. The notification carries nothing (so a transaction sends one,
-- however many deliveries it adds): the worker reads which companies have due deliveries from the
-- table, and the minute sweep finds anything a lost notification missed.
CREATE FUNCTION app.notify_webhook_delivery() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM pg_catalog.pg_notify('w360_webhooks', '');
  RETURN NULL;
END
$$;
CREATE TRIGGER webhook_deliveries_notify AFTER INSERT ON app.webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION app.notify_webhook_delivery();

-- Capture ------------------------------------------------------------------------------------------
-- These run with the rights of whoever makes the change (the runtime role in the company's scope, or
-- a definer function), so RLS keeps every event in the company of the row that caused it.
CREATE FUNCTION app.webhook_subscribed(p_tenant uuid, p_type text) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active' AND p_type = ANY (e.event_types));
$$;

CREATE FUNCTION app.capture_webhook_event(p_tenant uuid, p_type text, p_message uuid,
  p_conversation uuid, p_contact uuid, p_template uuid, p_status text, p_detail jsonb,
  p_occurred_at timestamptz) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_event uuid := gen_random_uuid();
BEGIN
  IF NOT app.webhook_subscribed(p_tenant, p_type) THEN
    RETURN;
  END IF;
  INSERT INTO app.webhook_events (id, tenant_id, type, message_id, conversation_id, contact_id,
    template_id, status, detail, occurred_at)
  VALUES (v_event, p_tenant, p_type, p_message, p_conversation, p_contact, p_template, p_status,
    coalesce(p_detail, '{}'::jsonb), coalesce(p_occurred_at, now()));
  INSERT INTO app.webhook_deliveries (id, tenant_id, endpoint_id, event_id)
  SELECT gen_random_uuid(), p_tenant, e.id, v_event
    FROM app.webhook_endpoints e
   WHERE e.tenant_id = p_tenant AND e.state = 'active' AND p_type = ANY (e.event_types);
END
$$;

-- message.received (an inbound message from a contact) and message.status (an outbound message
-- reaching a status a receiver can act on; queued and sending are internal).
CREATE FUNCTION app.webhook_capture_message() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'message.received', NEW.id,
      NEW.conversation_id, NULL, NULL, NULL, jsonb_build_object('messageType', NEW.type),
      coalesce(NEW.provider_timestamp, NEW.created_at));
  ELSE
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'message.status', NEW.id,
      NEW.conversation_id, NULL, NEW.template_id, NEW.status,
      jsonb_strip_nulls(jsonb_build_object('errorCode', NEW.error_code,
        'errorTitle', left(NEW.error_title, 200))),
      NEW.status_at);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER messages_webhook_received AFTER INSERT ON app.messages
  FOR EACH ROW WHEN (NEW.direction = 'inbound' AND NEW.sender_type = 'contact')
  EXECUTE FUNCTION app.webhook_capture_message();
CREATE TRIGGER messages_webhook_status AFTER UPDATE OF status ON app.messages
  FOR EACH ROW WHEN (NEW.direction = 'outbound' AND NEW.status IS DISTINCT FROM OLD.status
    AND NEW.status IN ('accepted', 'sent', 'delivered', 'read', 'played', 'failed', 'canceled',
                       'unknown_outcome'))
  EXECUTE FUNCTION app.webhook_capture_message();

-- consent.changed (every recorded opt-in or opt-out, whatever its source).
CREATE FUNCTION app.webhook_capture_consent() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM app.capture_webhook_event(NEW.tenant_id, 'consent.changed', NULL, NULL, NEW.contact_id,
    NULL, NULL, jsonb_build_object('purpose', NEW.purpose, 'action', NEW.action,
      'source', NEW.source), NEW.occurred_at);
  RETURN NULL;
END
$$;
CREATE TRIGGER consent_events_webhook AFTER INSERT ON app.consent_events
  FOR EACH ROW EXECUTE FUNCTION app.webhook_capture_consent();

-- template.status_changed (statuses Meta reports, and deletion; HyFib's own submission steps are not
-- sent).
CREATE FUNCTION app.webhook_capture_template() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM app.capture_webhook_event(NEW.tenant_id, 'template.status_changed', NULL, NULL, NULL,
    NEW.template_id, NEW.status, jsonb_strip_nulls(jsonb_build_object('reason', left(NEW.reason, 500))),
    NEW.occurred_at);
  RETURN NULL;
END
$$;
CREATE TRIGGER template_status_events_webhook AFTER INSERT ON app.template_status_events
  FOR EACH ROW WHEN (NEW.status IN ('pending', 'approved', 'rejected', 'paused', 'disabled',
    'in_appeal', 'flagged', 'archived', 'deleted', 'limit_exceeded', 'locked'))
  EXECUTE FUNCTION app.webhook_capture_template();

REVOKE EXECUTE ON FUNCTION app.webhook_subscribed(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.capture_webhook_event(uuid, text, uuid, uuid, uuid, uuid, text, jsonb,
  timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.webhook_subscribed(uuid, text) TO w360_app, w360_definer;
GRANT EXECUTE ON FUNCTION app.capture_webhook_event(uuid, text, uuid, uuid, uuid, uuid, text, jsonb,
  timestamptz) TO w360_app, w360_definer;
REVOKE EXECUTE ON FUNCTION app.notify_webhook_delivery() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.webhook_capture_message() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.webhook_capture_consent() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.webhook_capture_template() FROM PUBLIC;

-- Sweeps -------------------------------------------------------------------------------------------------
-- Active companies with deliveries that are due, or whose lease expired (the minute sweep enqueues a
-- delivery job for each; notifications cover new deliveries in between).
CREATE FUNCTION ops.webhook_dispatch_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql SECURITY DEFINER STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT DISTINCT d.tenant_id
    FROM app.webhook_deliveries d
    JOIN app.tenants t ON t.id = d.tenant_id
   WHERE t.status = 'active'
     AND ((d.state = 'pending' AND d.next_attempt_at <= now())
          OR (d.state = 'delivering' AND d.lease_until < now()))
   LIMIT p_limit;
$$;
REVOKE EXECUTE ON FUNCTION ops.webhook_dispatch_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.webhook_dispatch_due(integer) TO w360_app;
ALTER FUNCTION ops.webhook_dispatch_due(integer) OWNER TO w360_definer;

-- Deletes deliveries and events 30 days after they were created (the retention sweep).
CREATE FUNCTION ops.purge_webhook_data(p_limit integer)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_deliveries integer;
  v_events integer;
BEGIN
  DELETE FROM app.webhook_deliveries
   WHERE id IN (SELECT d.id FROM app.webhook_deliveries d
                 WHERE d.created_at < now() - interval '30 days' ORDER BY d.created_at LIMIT p_limit);
  GET DIAGNOSTICS v_deliveries = ROW_COUNT;
  DELETE FROM app.webhook_events
   WHERE id IN (SELECT e.id FROM app.webhook_events e
                 WHERE e.created_at < now() - interval '30 days'
                   AND NOT EXISTS (SELECT 1 FROM app.webhook_deliveries d
                                    WHERE d.tenant_id = e.tenant_id AND d.event_id = e.id)
                 ORDER BY e.created_at LIMIT p_limit);
  GET DIAGNOSTICS v_events = ROW_COUNT;
  RETURN v_deliveries + v_events;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.purge_webhook_data(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.purge_webhook_data(integer) TO w360_app;
ALTER FUNCTION ops.purge_webhook_data(integer) OWNER TO w360_definer;
