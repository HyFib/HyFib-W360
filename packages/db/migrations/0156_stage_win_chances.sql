-- 0156_stage_win_chances: how likely a stage's open deals are to be won (P4-04, ADR-242), for the
-- CRM board's weighted pipeline and its forecast of the deals expected to close this month. A whole
-- percentage that owners and administrators set per stage in Settings → Pipelines; NULL (the
-- default) means not set, and the weighted figures leave such a stage out. Additive: a nullable
-- column without a default, so the table is not rewritten and the runtime role, whose SELECT and
-- INSERT on the table are table-wide, reads and inserts it at once.
ALTER TABLE app.crm_stages ADD COLUMN win_percent smallint
  CONSTRAINT crm_stages_win_percent_check CHECK (win_percent BETWEEN 0 AND 100);
GRANT UPDATE (win_percent) ON app.crm_stages TO w360_app;
