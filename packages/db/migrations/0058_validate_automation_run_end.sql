-- Checks the runs already stored against the end check 0057 replaced NOT VALID (ADR-079).
-- VALIDATE takes a lock that lets runs keep being written while the table is read.
ALTER TABLE app.automation_runs VALIDATE CONSTRAINT automation_runs_end;
