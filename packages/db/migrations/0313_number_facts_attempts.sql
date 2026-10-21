-- 0313_number_facts_attempts: when HyFib last tried to read each WhatsApp number's facts in the
-- daily refresh (P2-10, ADR-402).
--
-- The access check's job refreshes each active number's facts from Meta (`GET /{phone-number-id}`)
-- once its facts are 20 hours old. A read that fails stores nothing, so without a record of the
-- attempt a number Meta no longer has would be read again at every access check of the day (every
-- 30 minutes while a webhook subscription is unconfirmed), spending the account's management
-- allowance. `facts_attempted_at` is the time of the last refresh read made for the number,
-- whatever its outcome; the refresh tries a number again only 20 hours after it. Null for every
-- number until its first refresh read; setup never writes it. Operational metadata, no content:
-- exported with the number, deleted with it (deletion step 790, whole rows).
--
-- Expand only: one nullable column without a default, so the table is not rewritten. Web servers
-- and workers of the release before never name it.
ALTER TABLE app.channel_accounts ADD COLUMN facts_attempted_at timestamptz;

-- The worker's refresh writes it; the runtime role already selects every column of the table
-- (0003). No other role reads or writes it, and no definer function reads it.
GRANT UPDATE (facts_attempted_at) ON app.channel_accounts TO w360_app;
