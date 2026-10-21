-- 0315_api_automation_enrollments: API keys enrol contacts or a segment in an automation (P4-01,
-- ADR-403).
--
-- Since 0311 (ADR-401) only members started enrolments, so every enrolment named its member. A key
-- holding `automations.start` and `contacts.read` (and `campaigns.read` for a segment) now starts
-- one through `POST /api/v1/automations/{id}/enrollments` and may stop any running enrolment, so an
-- enrolment names exactly one starter, a member or a key, and an enrolment a key stopped names the
-- key. Each batch re-checks the key as a fresh request would (not revoked, not expired, its scopes
-- within the plan, the API in the plan) and ends the enrolment with its own reason when it may no
-- longer go on. Rows hold ids only; a key is never deleted (0024), so its enrolments keep naming it.
--
-- app.automation_enrollments is small (at most one running enrolment per automation, each ended
-- one a row), so its checks are replaced validated, under this migration's brief lock.

ALTER TABLE app.automation_enrollments
  ALTER COLUMN created_by_membership_id DROP NOT NULL,
  ALTER COLUMN created_by_user_id DROP NOT NULL,
  ADD COLUMN created_by_api_key_id uuid,
  ADD COLUMN stopped_by_api_key_id uuid,
  ADD CONSTRAINT automation_enrollments_created_by_key_fk FOREIGN KEY (tenant_id, created_by_api_key_id)
    REFERENCES app.api_keys (tenant_id, id),
  ADD CONSTRAINT automation_enrollments_stopped_by_key_fk FOREIGN KEY (tenant_id, stopped_by_api_key_id)
    REFERENCES app.api_keys (tenant_id, id),
  -- Exactly one starter: a member (with the user its job is signed with) or a key (whose jobs act
  -- for the company, signed with no user).
  ADD CONSTRAINT automation_enrollments_starter CHECK (
    num_nonnulls(created_by_membership_id, created_by_api_key_id) = 1
    AND (created_by_membership_id IS NULL) = (created_by_user_id IS NULL)),
  DROP CONSTRAINT automation_enrollments_end,
  ADD CONSTRAINT automation_enrollments_end CHECK (
    (status = 'running' AND ended_at IS NULL AND end_reason IS NULL)
    OR (status = 'completed' AND ended_at IS NOT NULL AND end_reason IS NULL)
    OR (status = 'stopped' AND ended_at IS NOT NULL
        AND end_reason IN ('stopped_by_member', 'member_removed', 'automation_paused',
                           'automation_unavailable', 'channel_unavailable', 'not_in_plan',
                           'inputs_changed', 'marketing_not_allowed', 'stopped_by_api',
                           'api_key_revoked', 'api_key_expired', 'api_not_in_plan',
                           'api_scope_missing'))
    OR (status = 'failed' AND ended_at IS NOT NULL AND end_reason = 'stalled')),
  -- Who stopped it, named exactly with its reason. IS NOT DISTINCT FROM also holds a running
  -- enrolment (no end reason) to naming nobody, which 0311's '=' left unchecked.
  DROP CONSTRAINT automation_enrollments_stopped_by,
  ADD CONSTRAINT automation_enrollments_stopped_by CHECK (
    (end_reason IS NOT DISTINCT FROM 'stopped_by_member') = (stopped_by_membership_id IS NOT NULL)
    AND (end_reason IS NOT DISTINCT FROM 'stopped_by_api') = (stopped_by_api_key_id IS NOT NULL));

-- The key foreign keys' lookups when company deletion removes the keys (step 860, after the
-- enrolments' step 692 has removed the rows); partial, as most enrolments name no key.
CREATE INDEX automation_enrollments_created_by_key_idx
  ON app.automation_enrollments (tenant_id, created_by_api_key_id)
  WHERE created_by_api_key_id IS NOT NULL;
CREATE INDEX automation_enrollments_stopped_by_key_idx
  ON app.automation_enrollments (tenant_id, stopped_by_api_key_id)
  WHERE stopped_by_api_key_id IS NOT NULL;

-- As 0311's: the starter is inserted with the enrolment and never changes; the stopper is set once,
-- by a stop. The table-level SELECT and INSERT of 0311 cover the new columns.
GRANT UPDATE (stopped_by_api_key_id) ON app.automation_enrollments TO w360_app;
