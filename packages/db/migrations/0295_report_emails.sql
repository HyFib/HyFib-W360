-- Report emails (P3-05, ADR-376).
--
-- Reports were computed only when a member opened the page. A member who can read reports can now
-- choose, for themselves, an email of the company's report totals each week (Monday to Sunday) or
-- each month, sent at 07:00 in the company's time zone after the period ended. A row is one
-- member's choice of one frequency: `next_send_at` is when its next email is due, `attempted_at`
-- when the worker last started on it (the sweep signals a company again at most once an hour while
-- an attempt fails), and the last period emailed is kept to show on the Reports page. Rows hold ids,
-- times and dates, never report numbers: the email carries those.
CREATE TABLE app.report_email_subscriptions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  membership_id uuid NOT NULL,
  frequency text NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
  next_send_at timestamptz NOT NULL,
  attempted_at timestamptz,
  last_period_from date,
  last_period_to date,
  last_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_email_subscriptions_tenant_id_id_uq UNIQUE (tenant_id, id),
  -- One row per member and frequency: a member may choose both.
  CONSTRAINT report_email_subscriptions_member_uq UNIQUE (tenant_id, membership_id, frequency),
  CONSTRAINT report_email_subscriptions_membership_fk FOREIGN KEY (tenant_id, membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT report_email_subscriptions_last_sent CHECK (
    (last_period_from IS NULL) = (last_period_to IS NULL)
    AND (last_period_from IS NULL) = (last_sent_at IS NULL)
    AND (last_period_from IS NULL OR last_period_from <= last_period_to))
);
-- The sweep's look for emails that are due, across companies.
CREATE INDEX report_email_subscriptions_due_idx ON app.report_email_subscriptions (next_send_at);
SELECT ops.apply_tenant_rls('app.report_email_subscriptions');
GRANT SELECT, INSERT, DELETE ON app.report_email_subscriptions TO w360_app;
GRANT UPDATE (next_send_at, attempted_at, last_period_from, last_period_to, last_sent_at,
  updated_at) ON app.report_email_subscriptions TO w360_app;

-- Deleted with the company (ADR-055), a batch at a time, before its memberships (810).
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (175, ARRAY['app.report_email_subscriptions']::regclass[], 'batch');
GRANT SELECT (tenant_id, id), DELETE ON app.report_email_subscriptions TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.report_email_subscriptions FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.report_email_subscriptions FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));

-- The sweep: companies with a report email due at p_now, active companies only, each once, those
-- whose last attempt started more than an hour ago or never. Whether an email is still due, and
-- for whom, is decided again in the company's own scope. Ids only.
CREATE FUNCTION ops.due_report_email_companies(p_now timestamptz, p_limit integer)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.tenant_id
    FROM app.report_email_subscriptions s
    JOIN app.tenants tn ON tn.id = s.tenant_id AND tn.status = 'active'
   WHERE s.next_send_at <= p_now
     AND (s.attempted_at IS NULL OR s.attempted_at <= p_now - interval '1 hour')
   GROUP BY s.tenant_id
   ORDER BY min(s.next_send_at), s.tenant_id
   LIMIT least(greatest(p_limit, 1), 500)
$$;
CREATE POLICY sweep_read ON app.report_email_subscriptions FOR SELECT TO w360_definer USING (true);
GRANT SELECT (next_send_at, attempted_at) ON app.report_email_subscriptions TO w360_definer;
REVOKE EXECUTE ON FUNCTION ops.due_report_email_companies(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.due_report_email_companies(timestamptz, integer) TO w360_app;
ALTER FUNCTION ops.due_report_email_companies(timestamptz, integer) OWNER TO w360_definer;
