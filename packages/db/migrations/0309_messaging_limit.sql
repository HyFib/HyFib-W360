-- 0309_messaging_limit: each WhatsApp number's messaging limit as Meta reports it (P2-10, ADR-398).
--
-- Onboarding's health read of a number (`GET /{phone-number-id}`, 0003) now also asks Meta for
-- `whatsapp_business_manager_messaging_limit`, the field that replaces the deprecated
-- `messaging_limit_tier` from Graph v24.0 (research M-059; Meta's SDK lists TIER_50, TIER_250,
-- TIER_2K, TIER_10K, TIER_100K, TIER_UNLIMITED and UNTIERED), and Settings → Channels shows it
-- beside the quality rating. `messaging_limit` keeps the text Meta gives, a value the SDK does not
-- list included: it is bounded by length, as the number's other facts from Meta are, never by a
-- list Meta may extend; null when Meta gave none, or refused the field.
-- `messaging_limit_checked_at` is the time of the last health read that asked Meta for the limit
-- and completed, with the limit, without one, or by a read without it after Meta refused it, so
-- "not reported by Meta" is told apart from never asked: it is null for every number whose health
-- was read before this release, until it is read again. Company data: exported with the number,
-- deleted with it (deletion step 790, whole rows).
--
-- Expand only: two nullable columns without a default, so the table is not rewritten. Both checks
-- hold for every existing row (all null) and are validated here at once: the table holds one row
-- per WhatsApp number. Web servers and workers of the release before never name the columns.
ALTER TABLE app.channel_accounts
  ADD COLUMN messaging_limit text
    CONSTRAINT channel_accounts_messaging_limit_check
      CHECK (char_length(messaging_limit) BETWEEN 1 AND 64),
  ADD COLUMN messaging_limit_checked_at timestamptz,
  ADD CONSTRAINT channel_accounts_messaging_limit_read_check
    CHECK (messaging_limit IS NULL OR messaging_limit_checked_at IS NOT NULL);

-- The worker's health read writes both, as it writes the number's other facts from Meta; the
-- runtime role already selects and inserts every column of the table (0003). The platform role may
-- read them as it reads those other facts (0003, operational metadata for its health screens: no
-- credential and no content), though no screen reads them yet. The definer role gets nothing: no
-- definer function reads them.
GRANT UPDATE (messaging_limit, messaging_limit_checked_at) ON app.channel_accounts TO w360_app;
GRANT SELECT (messaging_limit, messaging_limit_checked_at) ON app.channel_accounts
  TO w360_platform;
