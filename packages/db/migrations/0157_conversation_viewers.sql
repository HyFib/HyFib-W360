-- 0157_conversation_viewers: which members have a conversation open (P3-06, ADR-243), so two members
-- do not answer the same customer at once. While a member has a conversation open, their browser
-- reports it every 20 seconds; the conversation shows the other active members seen within the last
-- 45 seconds who can still see it. One row per member and conversation, its time moved forward by
-- each report. A member leaving the conversation deletes their row, and rows not reported for an
-- hour are deleted by the worker's minute sweep (ops.purge_conversation_viewers). The rows say only
-- who looked at which conversation and when: nothing about the customer.
CREATE TABLE app.conversation_viewers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_viewers_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT conversation_viewers_member_uq UNIQUE (tenant_id, conversation_id, membership_id),
  CONSTRAINT conversation_viewers_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES app.conversations (tenant_id, id),
  CONSTRAINT conversation_viewers_membership_fk FOREIGN KEY (tenant_id, membership_id)
    REFERENCES app.memberships (tenant_id, id)
);
-- The sweep finds the rows by age, across companies.
CREATE INDEX conversation_viewers_seen_idx ON app.conversation_viewers (seen_at);
SELECT ops.apply_tenant_rls('app.conversation_viewers');
GRANT SELECT, INSERT, DELETE ON app.conversation_viewers TO w360_app;
GRANT UPDATE (seen_at) ON app.conversation_viewers TO w360_app;

-- Deleted with the company (ADR-055), before its conversations and memberships.
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (345, ARRAY['app.conversation_viewers']::regclass[], 'batch');
GRANT SELECT (tenant_id, id, seen_at), DELETE ON app.conversation_viewers TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.conversation_viewers FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.conversation_viewers FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));

-- The sweep reads and deletes, in every company, only rows not reported for an hour.
CREATE POLICY presence_purge_read ON app.conversation_viewers FOR SELECT TO w360_definer
  USING (seen_at < now() - interval '1 hour');
CREATE POLICY presence_purge_delete ON app.conversation_viewers FOR DELETE TO w360_definer
  USING (seen_at < now() - interval '1 hour');

-- Deletes up to p_limit (1 to 10,000) rows not reported for an hour, the oldest first. A row
-- reported again after it was listed is checked again and kept. Returns how many were deleted.
CREATE FUNCTION ops.purge_conversation_viewers(p_limit integer)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM app.conversation_viewers v
   WHERE v.id IN (SELECT o.id FROM app.conversation_viewers o
                   WHERE o.seen_at < now() - interval '1 hour'
                   ORDER BY o.seen_at
                   LIMIT least(greatest(coalesce(p_limit, 5000), 1), 10000))
     AND v.seen_at < now() - interval '1 hour';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.purge_conversation_viewers(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.purge_conversation_viewers(integer) TO w360_app;
ALTER FUNCTION ops.purge_conversation_viewers(integer) OWNER TO w360_definer;
