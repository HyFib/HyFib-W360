-- 0318_validate_campaign_recipient_variant: validates the check 0317 added NOT VALID (ADR-405), as
-- 0312 validated 0311's. Validation reads app.campaign_recipients without blocking its writes; every
-- row written since 0317 was checked when written, and rows from before hold the default A.
ALTER TABLE app.campaign_recipients VALIDATE CONSTRAINT campaign_recipients_variant;
