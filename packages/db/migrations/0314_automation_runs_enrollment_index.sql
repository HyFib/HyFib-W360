-- migrate:no-transaction
-- The runs an enrolment started (ADR-401): the index the foreign key of 0311
-- (`automation_runs_enrollment_fk`, validated by 0312) uses when an enrolment's row is deleted,
-- which happens only with its company (deletion step 692, after the company's runs at 690).
-- PostgreSQL proves the check's `enrollment_id = $n` implies the predicate, so the index can be
-- partial: only runs an enrolment started have one, so it stays small. Built concurrently, as 0053
-- built the key's, so runs keep being read and written while it is built. If this migration fails,
-- an INVALID index can remain: drop it with
-- `DROP INDEX CONCURRENTLY IF EXISTS app.automation_runs_enrollment_idx;` and run the migrations
-- again (docs/RUNBOOKS.md).
CREATE INDEX CONCURRENTLY automation_runs_enrollment_idx
  ON app.automation_runs (tenant_id, enrollment_id) WHERE enrollment_id IS NOT NULL;
