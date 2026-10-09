-- 0252_validate_contact_change_parts: validates the checks 0251 added NOT VALID (ADR-329). The rows
-- already there all predate the columns, so none has parts and every map is empty; VALIDATE takes
-- a lock that lets contacts keep changing while the table is read.
ALTER TABLE app.contact_changes VALIDATE CONSTRAINT contact_changes_parts_check;
ALTER TABLE app.contact_changes VALIDATE CONSTRAINT contact_changes_replaced_check;
