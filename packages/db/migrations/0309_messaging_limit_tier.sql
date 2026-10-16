-- 0309_messaging_limit_tier: each WhatsApp number's messaging limit tier as Meta reports it (P2-10,
-- ADR-398).
--
-- Onboarding's health read of a number (`GET /{phone-number-id}`, 0003) now also asks Meta for
-- `messaging_limit_tier`, which Meta's OpenAPI description lists for that read ("Current messaging
-- limit tier for the account number": TIER_50, TIER_250, TIER_1K, TIER_10K, TIER_100K or
-- TIER_UNLIMITED), and Settings → Channels shows it beside the quality rating, named as Meta names
-- it. `messaging_limit_tier` keeps the text Meta gives, a tier the description does not list
-- included: it is bounded by length, as the number's other facts from Meta are, never by a list Meta
-- may extend; null when Meta gave none. `messaging_limit_checked_at` is when a health read that asked
-- for the tier succeeded, so "not reported by Meta" is told apart from never asked: it is null for
-- every number whose health was read before this release, until it is read again. Company data:
-- exported with the number, deleted with it (deletion step 790, whole rows).
--
-- Expand only: two nullable columns without a default, so the table is not rewritten. Both checks
-- hold for every existing row (all null) and are validated here at once: the table holds one row per
-- WhatsApp number. Web servers and workers of the release before never name the columns.
ALTER TABLE app.channel_accounts
  ADD COLUMN messaging_limit_tier text
    CONSTRAINT channel_accounts_messaging_limit_tier_check
      CHECK (char_length(messaging_limit_tier) BETWEEN 1 AND 64),
  ADD COLUMN messaging_limit_checked_at timestamptz,
  ADD CONSTRAINT channel_accounts_messaging_limit_read_check
    CHECK (messaging_limit_tier IS NULL OR messaging_limit_checked_at IS NOT NULL);

-- The worker's health read writes both, as it writes the number's other facts from Meta; the
-- runtime role already selects and inserts every column of the table (0003). The platform role may
-- read them as it reads those other facts (0003, operational metadata for its health screens: no
-- credential and no content). The definer role gets nothing: no definer function reads them.
GRANT UPDATE (messaging_limit_tier, messaging_limit_checked_at) ON app.channel_accounts TO w360_app;
GRANT SELECT (messaging_limit_tier, messaging_limit_checked_at) ON app.channel_accounts
  TO w360_platform;
