# Progress

## 2026-09-28 — Phase 5: warnings before a monthly limit (P5-01)

Status: **Implemented and locally verified with test data only.** A company's billing managers now
hear once when the month's automation runs or API requests reach 80% of the plan's limit, before
automations stop or the API refuses requests. The used-up notices no longer go out for a counter of
an earlier usage period.

### Completed

- **Design (ADR-062):** one warning per counter (company, metric and monthly period) at 80% of the
  limit rounded up, while still below it; none for limits of 1 to 4, where 80% rounds up to the
  limit itself; a month that jumps to the limit between two sweeps gets only the used-up notice.
- **Schema (migration 0036):** `app.usage_counters.warned_at` (the runtime role may update it, as
  it may `used` and `notified_at`; the company data export includes it, as the export's
  classification test requires) and `ops.usage_warnings_due`, which lists counters of active
  companies at or over the threshold of their current limit (with run packs for automation runs)
  and below it, neither warned nor announced (ids only; SECURITY DEFINER, executable by the app
  role only).
- **Domain:** `warningThreshold` (integer arithmetic matching `ceil(limit * 0.8)` in SQL) and the
  minute plan sweep's `warnBeforeLimit`. The three counter notices (the warning and both used-up
  notices) now lock the counter in the company's scope (`SELECT … FOR UPDATE` while unsent), check
  it against the company's current limit and period, and mark it in the transaction that queues the
  email. A counter of an earlier period is marked without an email. Before, the used-up notices set
  `notified_at` first and emailed without checking the period, so a lowered limit or a new paid
  period could make last period's count look like this month's. A counter no longer due, because
  its limit changed after the sweep listed it, is left unmarked for a later sweep.
- **Web:** the Billing plan card marks the month's automation runs or API requests at 80% or more
  of the limit as "nearly used up".
- **Tests:** `usage-warnings.test.ts` (7), the threshold in `plans/model.test.ts`, and the
  isolation suite now checks that `ops.api_quota_reached` (0035) and `ops.usage_warnings_due` are
  executable by the worker role only. `api-quota.spec.ts` now gives the company five API requests a
  month: at four the Billing plan card shows "4 of 5 (nearly used up)" (with no sideways scrolling
  on the phone), the fifth passes and the sixth is refused.
- **Docs:** ADR-062; ARCHITECTURE §6N and §7; RUNBOOKS (plans: the warning, and a usage email that
  did not come); BACKLOG P5-01; THREAT-MODEL T86 (and T85's e2e wording); FEATURE-MATRIX H-040 (and
  H-039's e2e wording).
- **Mutation checks:** 24 regressions tried one at a time; 23 make a test fail: the listing's
  threshold, upper bound, limit per metric, run packs, warned and company-status filters; the
  lock's earlier-period check and mark, the lock itself (caught by two calls waiting on a held
  counter), the limit per metric and the unsent filter; the warning's mark, range and texts; the
  sweep's call; both used-up notices' limit checks and marks; the threshold's rounding and bound;
  and the plan card's mark (through the e2e test). The 24th removed a guard for a limit of 0 that
  the general rule already covers (80% of 0 is not below 0), so the guard is gone.

### Test commands and results (local, 2026-09-28)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm test` (unit)                                                          | 317 passed. New: the threshold in `plans/model.test.ts` (5 → 4, 7 → 6, 10 → 8, 11 → 9, 1,000 → 800, a billion → 800 million; none without a limit, for 0 or for 1 to 4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 412 passed, including the new `usage-warnings.test.ts` 7: one warning at 80% for automation runs and API requests, then the used-up notice and no second warning (the listing checked directly too); none for a limit of 4 or a month that reaches the limit before a sweep sees 80%; run packs in the limit; none for a suspended company; counters of an earlier period marked without a warning or a used-up notice; a counter whose limit changed after the sweep listed it left unmarked; two sweeps waiting on a counter held by another transaction sending one warning. The isolation suite's function grants now include both notice listings, and the export classification test failed until the export spec listed `warned_at`. |
| `pnpm test:integration` against PostgreSQL 17.11 (Docker)                   | 412 passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 80 passed (40 × 2) in one full run (17.1 min), including the changed `api-quota.spec.ts` on both projects: staff give the company five API requests a month; after four the Billing plan card shows "4 of 5 (nearly used up)" with no sideways scrolling on the phone; the fifth passes and the sixth answers 429 with reason `quota_exceeded`.                                                                                                                                                                                                                                                                                                                                                                              |
| Mutation checks                                                             | 24 regressions tried one at a time; 23 make a test fail, the 24th removed a redundant guard (now gone)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Known gaps

- One warning per counter and period: a limit raised after the warning (run packs, a larger plan
  within the period) brings no second warning at 80% of the new limit; the used-up notice still
  comes.
- Thresholds chosen per company or member, in-app notices, and warnings for seats, numbers, teams
  or live automations (which refuse additions rather than run out during the month) are not built.
- Firefox and WebKit run the changed spec in CI only; only Chromium is installed locally.

## 2026-09-28 — Phase 5: monthly API requests and API access by plan (P5-01, P5-08)

Status: **Implemented and locally verified with test data only.** Each plan version now sets how
many public API requests a company may make per month, or leaves the API out; requests beyond the
month's limit are refused until the next period.

### Completed

- **Design (ADR-061):** `api_requests_monthly` per plan version: empty for no limit, 0 when the
  plan leaves the public API out. Versions published before keep no limit, which is what they gave.
  Every request that passes authentication and the rate limits counts, before it is read (a
  malformed request or an idempotent replay too; a failed authentication or a rate-limited request
  not), per monthly usage period like automation runs.
- **Schema (migration 0035):** the plan column (the guard keeps it unchangeable once published;
  staff may set it on drafts), the `api_requests` usage metric, `app.tenant_entitlements` with the
  limit (recreated, as its result gained a column), and `ops.api_quota_reached` for the notice.
- **Domain:** `consumeApiRequest` counts with one upsert that never passes the limit (and counts
  without a limit too); `admitApiRequest` turns a refusal into 403 `forbidden` / `not_in_plan` or
  429 `rate_limited` / `quota_exceeded` with `Retry-After` until the next period; creating and
  rotating keys are refused without the API; the minute plan sweep emails the billing managers
  once per period; the OpenAPI document names both reasons.
- **Web:** the public API wrapper counts each request after the rate limits. The platform plan
  form and page show the limit ("Not included" for 0); the platform company page, the Billing plan
  card and Settings → API keys show the month's use, and the API keys page says when the plan does
  not include the API and offers no new keys.
- **Docs:** ADR-061; ARCHITECTURE §6N and §7; SECURITY (Phase 5 API rules); THREAT-MODEL T85;
  BACKLOG P5-01 and P5-08; FEATURE-MATRIX H-039.
- **Mutation checks:** 26 guards broken one at a time; all 26 make a test fail: the published-version
  guard (caught only once the test tried retiring a version while changing its limit, the one change
  the guard allows), the entitlement, the upsert's limit and period and metric, the plan without the
  API, the key checks, the refusal's status, reason and Retry-After, the notice's claim and query,
  the plan form and new versions, the month's use shown, the OpenAPI text, and the web wrapper's
  check (through the e2e test).

### Test commands and results (local, 2026-09-28)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `pnpm test` (unit)                                                          | 315 passed. New: `api/quota.test.ts` (Retry-After in whole seconds, at least one) and, in `api/api.test.ts`, the error reason and the OpenAPI document naming `not_in_plan` and `quota_exceeded` on every route.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 405 passed, including the new `api-quota.test.ts` 4: requests counted without a limit; twelve concurrent requests admitting five of a limit of five, the others refused with Retry-After and not counted; the next period counted from zero; a larger plan within the period carrying the count on and a plan without a limit letting every request through; one notice to the billing managers however often the sweep runs; a plan without the API refusing every request, new and rotated keys (the existing key revoked, and new keys working again on a plan with the API); the limit of a published version unchangeable, even while retiring it, and carried into its next version. |
| `pnpm test:integration` against PostgreSQL 17.11 (Docker)                   | 405 passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 80 passed (40 × 2) in one full run (18.6 min), including the new `api-quota.spec.ts` on both projects: a key made while the company is complimentary; staff publish a plan with two API requests a month and put the company on it; two requests pass and the third answers 429 with reason `quota_exceeded` and Retry-After; the API keys page and the Billing plan card show two of two, with no sideways scrolling on the phone.                                                                                                                                                                                                                                         |
| Mutation checks                                                             | 26 guards broken one at a time; all 26 make a test fail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### Known gaps

- Packs of extra API requests, per-key or per-endpoint quotas, and alerts before the limit are not
  built. A company learns of the limit from the refusal, the email once it is reached, and its
  Billing and API keys pages.
- Firefox and WebKit run the new spec in CI only; only Chromium is installed locally.

## 2026-09-28 — Phase 5: usage and rates for companies (P5-07, part)

Status: **Billing → Usage and rates implemented and locally verified with test data only.**
Companies see Meta's rates in force for their billing currency, the next published change and what
it changes, and this month's estimated Meta charges. The page is read-only: Meta bills companies
directly, and nothing is stored or charged. No card has been entered from Meta's published rate
cards yet; platform staff do that.

### Completed

- **Design (ADR-060):** for owners, administrators and billing managers (`billing.read`; billing
  managers have no `reports.read`, so they could not see any estimate before). One repeatable-read,
  read-only snapshot in the company's scope: the billing currency from Settings → Messaging, the
  published card in force (the latest effective time not after now), the next published card (the
  earliest after now) and what it changes, and this month so far from the Reports estimate. Drafts
  and withdrawn cards are never shown; nothing is written.
- **Domain:** `billing/usage.ts` (`createBillingUsageService`, `compareRateCards`,
  `chargesByCategory`, `formatRateChange`, and the category labels, now shared with Reports).
  Reports' estimate is exported as `estimateMetaCharges`, so both pages compute the same numbers.
- **Web:** Billing links to Usage and rates. The page:
  - warns when the rates change, with how many prices change (or that no rates apply until then);
  - shows this month's statistics and the estimate by pricing category, the reasons messages could
    not be priced and, for members who can read reports, a link to the estimate by market;
  - lists the rates in force, with a missing price read as "not priced", never as zero;
  - lists what changes on the next card's date: old and new prices, the difference with a real
    minus sign and its percentage, new prices and prices no longer listed.

  Without a billing currency it says where to choose one, with a link for members who can change
  settings.

- **Found while building:** `formatUnitPrice` showed a whole price in a currency without minor
  units with a trailing point ("2. JPY"); it now shows "2 JPY" (unit test).
- **CI:** the end-to-end job now has 70 minutes and its test step 60 (were 60 and 50). On a66f64e
  the step took 39.9 minutes for 152 tests, all passing on the first attempt, where 148 tests had
  taken 33.5 on b2b7614: runners vary more than the new spec's minute, and 10 minutes of room was
  too little for one retry of the 5-minute cart reminder test on a slow runner.
- **Docs:** ADR-060; ARCHITECTURE §6B and §7; SECURITY (controls, the rate card rule, Phase 5
  rules); THREAT-MODEL T84; BACKLOG P5-07; FEATURE-MATRIX W-013 (planned → locally verified) and
  H-038.
- **Mutation checks:** 26 guards broken one at a time; all 26 make a test fail. They cover the
  permission, published cards only (in force and next), the currency (in force and next), the
  effective instant on both sides, the order of cards, list prices only, the changes, comparing
  cards (added and dropped prices, markets only on the next card, a missing price against zero),
  the change text (minus sign, percentage base, no percentage from zero, new and dropped prices),
  category totals and their order, the month, the company's time zone, the currency of the
  estimate, and whole prices in currencies without minor units.

### Test commands and results (local, 2026-09-28)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm test` (unit)                                                          | 313 passed. New: `billing/usage.test.ts` 5 (the changes between two cards market by market, identical cards, a zero price against no price, the change text, category totals and ties) and two lines in `campaigns/variables.test.ts` (whole prices in a currency without minor units).                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 401 passed, including the new `billing-usage.test.ts` 3: no currency (nothing to estimate) and who may read it (owners and billing managers; agents, marketers and supervisors refused); the card in force and the next one among withdrawn and draft cards before and after, a volume tier's price and another currency's cards, with what changes, and the switch at the next card's effective instant (not a millisecond before); this month's estimate equal to Reports' (priced, free, not yet priced and unknown-market messages), for this company only, the same for billing managers, with no ledger or wallet rows written.                                                                                                                |
| `pnpm test:integration` against PostgreSQL 17.11 (Docker)                   | 401 passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 78 passed (39 × 2) in one full run (15.6 min), including the new `billing-usage.spec.ts` on both projects (8.2 s and 10.0 s): a company chooses the currency Meta bills it in; platform staff's cards for it are in force since yesterday and change in two days; a customer writes and the reply is delivered, reported free by Meta; Billing links to Usage and rates, which announces the change and how many prices change, shows the rates in force (a price the card does not have read as not priced), what changes (a higher price with its difference and percentage, a new price, a price no longer listed), one delivered message counted free and an estimate of nothing to pay, with no sideways scrolling on the phone. |
| Mutation checks                                                             | 26 guards broken one at a time; all 26 make a test fail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Known gaps

- No card has been entered from Meta's published rate cards: platform staff enter the cards taking
  effect on 2026-10-01 from Meta's own rate card pages, which this environment cannot reach
  (research M-075).
- No alert or email before a change. The page has no per-number or per-campaign figures, no
  history of past cards and no exact charges: Meta's invoice is authoritative, and reconciling with
  `pricing_analytics` stays in the backlog (ADR-028).
- On a phone the two rate tables scroll sideways inside their cards, like every table in the app;
  the page itself does not.
- Firefox and WebKit run the new spec in CI only; only Chromium is installed locally.

## 2026-09-28 — Phase 5: daily settlement reconciliation (P5-05, part)

Status: **Daily settlement reconciliation with Razorpay implemented and locally verified with test
data only.** Every day the worker reads Razorpay's settlement report for the previous day, matches
every settled transaction against HyFib's records, records payments and refunds HyFib had missed
through the usual paths, and lists everything else for platform owners. Razorpay traffic comes from
the test-only stand-in; nothing reached Razorpay.

### Completed

- **Design (ADR-059):** the report (`GET /v1/settlements/recon/combined`, R-110, R-111) is read a
  page of up to 1,000 transactions at a time for India's calendar day. Its ids only look up HyFib's
  own records (top-ups by payment and order, card mandates, recorded refunds), never a company. A
  payment or refund HyFib missed is fetched and recorded exactly as its webhook would have been
  (credit only from a captured payment, once); nothing else changes automatically. One run per
  day and one item per transaction, kept with the billing records.
- **Schema (migration 0034):**
  - `ops.settlement_recon_runs` (pending, running, completed, failed; attempts, an attempt number
    that never resets and fences every write, a lease, the last error, who asked, totals) and
    `ops.settlement_recon_items` (the transaction without notes, descriptions, receipts or card
    fields; the match; a resolution with a note). No runtime role has privileges on them.
  - Worker functions (definer, `w360_app` only): `ops.settlement_recon_due` (creates the runs the
    schedule owes, fails a sixth attempt whose worker stopped, returns the due runs), `_claim`,
    `_facts`, `_record_items`, `_defer`, `_fail` and `_complete`. Each write names its attempt and
    is refused once another attempt holds the run.
  - Platform functions (definer, `w360_platform` only): the days, a day's items and the unsettled
    payments for platform administrators; reconciling a day and resolving an item for platform
    owners, with the reason or note in the platform audit log.
- **Domain:** `billing/settlement-recon.ts` (the schedule from 06:00 India time, filling a week of
  gaps after the first run; matching; missed payments and refunds applied through
  `applyPaymentById` and `applyRefundById`; retries after 5, 15, 60, 180 and 360 minutes for
  failures that may pass, failure on a refusal or after six attempts; attempts that lost their
  claim stop writing), `platform/reconciliation.ts` (the staff service and what each reason means),
  and the settlement report in the Razorpay client, a strict reader: an item with any field it
  cannot read is kept as unreadable, never read partly.
- **Worker:** the `billing.settlement-recon` queue, one attempt at a time; the minute billing sweep
  creates the runs and queues one signed job per due run.
- **Web:** Platform → Reconciliation lists the latest 90 days (status, counts, amounts), the paid
  top-ups no settlement has shown and, for owners, a form to reconcile a day. A day's page lists
  what needs a person first, with what each reason means and what to do, then what the check
  recorded, resolutions and matches; owners run the day again and resolve items with a note.
- **Found while building:**
  - Running a day again reset the attempts to zero, so items from an earlier run could look seen by
    the new attempt and survive although Razorpay no longer listed them. Writes are now fenced by an
    attempt number that never resets.
  - The dispute rule flagged only matched transactions, so a missed payment with a dispute was
    credited by the check without a person hearing of it, and flagged only when the day ran again
    (the integration test caught the change). A dispute on a transaction HyFib matched or recorded
    now waits for a person, decided after a missed payment or refund is applied; a transaction
    already waiting keeps its own reason and shows the dispute.
- **Tests:** the Razorpay stand-in serves the settlement report (with Razorpay's documented
  parameter errors) and settles payments and refunds on a day, in tests and through a test-only
  control route for e2e; the fake Checkout can close right after paying, so HyFib never hears of
  the payment.
- **CI:** the end-to-end job has 60 minutes and its test step 50 (were 45 and 40). The step took
  33.5 of its 40 minutes on b2b7614 (148 tests, all passing on the first attempt), and the new spec
  adds about a minute per browser, which left no room for one retry of a long test.
- **Docs:** ADR-059; ARCHITECTURE §7; SECURITY (controls, Phase 5 rules, platform roles);
  THREAT-MODEL T83; RUNBOOKS §9 (reconciliation); DEPLOYMENT (Razorpay); DATA-RETENTION;
  RELEASE-CHECKLIST; Razorpay research R-110, R-111 and two open questions; BACKLOG P5-05;
  FEATURE-MATRIX H-037.
- **Mutation checks:** 62 guards broken one at a time; all 62 make a test fail. They cover the
  schedule (days not over, backfilling, gaps, the next attempt time, a stopped sixth attempt),
  claims (the lease, six attempts, the attempt number), stale attempts recording, completing,
  deferring and failing, items Razorpay no longer lists, resolutions and recorded items kept on a
  day run again, totals, the refunded-payment lookup, the unsettled list (eight reconciled days,
  settled payments, refunded top-ups), the owner, reason, note, date, running and audit checks, the
  read check and grants, matching (amounts, mandates, applying missed payments and refunds,
  transfers, adjustments, currencies, disputes before and after applying), the outcomes of applying,
  writing what was recorded at once, paging, refusals and retries, superseded attempts, and the
  report reader's checks.

### Test commands and results (local, 2026-09-28)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pnpm test` (unit)                                                          | 308 passed. New: `billing/settlement-recon.test.ts` 7 (India's calendar day, the schedule's latest day around 06:00, matching payments and refunds, what is left to a person, disputes decided after applying, types) and 3 settlement-report tests in `billing/razorpay.test.ts` (the documented request and fields, unreadable items never read partly, parameters Razorpay would reject refused before calling).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 398 passed, including the new `settlement-recon.test.ts` 10: the schedule (the previous day from 06:00, a week of gaps after the first run, never before it, a day not over refused); missed payments and refunds recorded once through the usual paths with the receipt email, matches for companies found through HyFib's records, totals, no notes or card fields stored; every mismatch, review and not-HyFib class changing nothing (disputes on what HyFib matched or recorded waiting for a person, a missed payment with a dispute credited first); a day run again keeping what was recorded and resolved and removing what Razorpay no longer lists; paging; retries, refusals, six attempts and a stopped sixth attempt; a failure while recording, keeping what the attempt had recorded; a superseded attempt; staff access and privileges; the unsettled payments (eight reconciled days, settled payments and refunded top-ups left out). |
| `pnpm test:integration` against PostgreSQL 17.11 (Docker)                   | 398 passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 76 passed (38 × 2) in one full run (16.0 min), including the new `settlement-recon.spec.ts` on both projects: a customer pays and closes Checkout at once, so HyFib hears nothing and adds no credit; Razorpay settles the payment days later together with a payment of another integration; a platform owner reconciles the day and the minute billing sweep hands it to the worker; the missed payment is recorded by the check and credited with the usual receipt email; the other payment waits as not HyFib's and is resolved with a note; no page scrolls sideways on the phone.                                                                                                                                                                                                                                                                                                                                                  |
| Mutation checks                                                             | 62 guards broken one at a time; all 62 make a test fail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### Known gaps

- Not run against Razorpay test mode yet (staging, RELEASE-CHECKLIST). The documentation does not
  say which time zone the report's day uses, in what order items come and whether pages stay stable,
  when a day's report is complete, or how disputes and held items appear (research, open questions
  21 and 22).
- Alerts and emails, a CSV export of a run, matching settlements with bank statements (UTR), fee
  and tax accounting, companies' own Razorpay accounts, automatic handling of adjustments, disputes
  and transfers, and instant settlements are not built.
- Firefox and WebKit run the new spec in CI only; only Chromium is installed locally.

## 2026-09-28 — Fix: the egress fallback test on macOS

Status: **Fixed and verified locally on macOS; the fallback also checked on Linux with and without
IPv6.** The unit test "falls back to the next checked address when one cannot be reached"
(`egress.test.ts`) failed on macOS with "No complete response within 2 seconds" and passed in CI.
Only the test changed: the egress client and its guard are unchanged.

### Cause

- The test's first address, `127.0.0.2`, relied on all of 127.0.0.0/8 being loopback. On Linux it
  is, so a connection there is refused at once and the client tries the next address. macOS
  configures only `127.0.0.1` on `lo0`: a connection to `127.0.0.2` gets no answer, and the
  client's 2-second attempt timeout equals the test's 2-second deadline, so the fallback never ran.

### Completed

- **Unreachable address:** the first address is now `::1`. It is loopback too (the guard allows it
  for test targets), and the test server listens on `127.0.0.1` only, so the attempt fails at once:
  refused on macOS and on Linux with IPv6, `EADDRNOTAVAIL` with IPv6 disabled by sysctl,
  `EAFNOSUPPORT` without IPv6 sockets. A closed listener would not do: every checked address is
  dialled on the URL's port, and on macOS the only IPv4 loopback address is the server's own.
- **Attempts checked:** with the two addresses in different families, a response from `127.0.0.1`
  alone no longer shows a fallback (IPv4 could have been tried first), so the test records the
  attempts Node's address selection reports as failed (`net.client.socket` diagnostics channel) and
  expects exactly `::1`.
- **Mutation checks:** of 3 deliberate regressions in `egress.ts` (address selection off, only the
  first checked address handed to Node, the addresses reordered IPv4 first), the test catches all
  3, the reordering only through the attempt check.

### Test commands and results (local, 2026-09-28)

| Command                                                                | Result                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                   | 0 problems / all files formatted / all workspace packages pass                                                                                                                                         |
| `pnpm test` (unit, macOS, Node 24.21)                                  | 298 passed; the fallback test in 6 ms (before the fix it failed after 2 s), and `egress.test.ts` passed 15 runs in a row                                                                               |
| The egress client with `::1` then `127.0.0.1`, Linux (Docker, Node 22) | Answered from `127.0.0.1` in each setup. IPv6 on: `::1` refused (`ECONNREFUSED`), 33 ms. IPv6 disabled by sysctl: `EADDRNOTAVAIL`, 22 ms. `AF_INET6` sockets refused by seccomp: `EAFNOSUPPORT`, 14 ms |

## 2026-09-28 — Fix: the ledger's balance check under PostgreSQL 17 (migration 0033)

Status: **Fixed and verified locally on PostgreSQL 17.11 and 18.6.** CI on f74a824 (staff refunds)
failed the PostgreSQL 17 integration job: 11 tests, every one that asks for a staff refund.

### Completed

- **Cause:** `app.assert_ledger_transaction_balanced()`, the deferred constraint trigger that checks
  at commit that every ledger transaction balances (0004), ran with the privileges of whichever role
  fired it. PostgreSQL 17 fires deferred triggers as the role current at `COMMIT`. A platform
  owner's refund request is the first posting made for the platform role, which cannot read
  `app.ledger_entries`: `ops.platform_request_credit_refund` (definer) holds the credit, and the
  commit failed with "permission denied for table ledger_entries". PostgreSQL 18 fires AFTER
  triggers as the role that queued them (the definer), so the PostgreSQL 18 job and every local run
  (18.6) passed.
- **Fix (migration 0033):** the check is now SECURITY DEFINER, owned by `w360_definer`, with its
  pinned search path. It reads only the entries of the transaction named by the inserted row, and a
  trigger function cannot be called directly, so no role gains anything. Migration 0032 was already
  pushed, so it is fixed forward.
- **Test:** `billing.test.ts` checks the function's owner and security, and fires the deferred
  check as the platform role after a definer posting: a balanced posting passes and an unbalanced
  one is refused. Without the fix, both parts fail on PostgreSQL 17 (checked); on 18 the owner check
  catches it.

### Test commands and results (local, 2026-09-28)

| Command                                                   | Result                                                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`      | 0 problems / all files formatted / all workspace packages pass                                |
| `pnpm test:integration` against PostgreSQL 17.11 (Docker) | Before the fix: `credit-refunds.test.ts` 10 of 11 failed with the CI error. After: 388 passed |
| `pnpm test:integration` (PostgreSQL 18.6)                 | 388 passed                                                                                    |

### Known gaps

- Local runs use PostgreSQL 18; a change to definer functions or deferred triggers should also run
  the integration suite against a PostgreSQL 17 container (`TEST_DATABASE_ADMIN_URL`), as CI does.

## 2026-09-28 — Phase 5: staff refunds of unused service credit (P5-05, part)

Status: **Staff refunds of unused service credit implemented and locally verified with test data
only.** A platform owner refunds part or all of a paid top-up from the company's platform page; the
credit is held at once, the worker asks Razorpay, and the refund is recorded from what Razorpay
reports. Razorpay traffic comes from the test-only stand-in; nothing reached Razorpay.

### Completed

- **Design (ADR-058):** a hold while Razorpay processes the refund, never a debit at request time
  (a debit would take credit the company keeps if the refund fails). Only unused credit is refunded,
  at most what is left of the payment, one open refund per top-up, platform owners only, with a
  reason in the platform audit log. Staff see a company's balances, top-ups and refunds without a
  support grant: payments to HyFib, not company content.
- **Schema (migration 0032):**
  - `app.credit_refunds` (requested, submitted, processed, failed): company RLS, column grants that
    keep the staff reason and who asked from the company role, and a restrictive policy that lets
    the company role move an open request only between requested and submitted.
  - `ops.platform_request_credit_refund` (definer, platform role only): checks the owner, the
    reason, that the company is not being deleted, the payment and, under the wallet's row lock,
    the unused credit; holds the credit (90 days), records the request and writes the platform
    audit log in one transaction.
  - `ops.platform_company_billing` (balances, the latest 50 paid top-ups and refunds, for staff)
    and `ops.credit_refunds_due` (the sweep's input).
  - `app.billing_fail_credit_refund` fails a request and releases its hold together.
  - `app.billing_record_refund` is replaced: a refund of a top-up with an open request (the same
    refund id, or no id stored yet and the same amount) releases the request's hold and marks it
    processed in the transaction that posts the refund.
- **Domain:** `billing/credit-refunds.ts` (the worker's step: the attempt written down first,
  `X-Refund-Idempotency: crf_<id>` with the same body every try, retries for anything uncertain,
  checks every 15 minutes, then hourly, then every 6 hours; emails and audit), `refund.failed`
  handling in the Razorpay receipt processor (fetched first), `platform/billing.ts` (the staff
  service and the form's refund limits), refunds in progress in the Billing overview and on
  receipts, statement labels ("Reserved for a refund", "Refund reservation released") with their
  receipt links. A due company deletion waits for refunds in progress.
- **Worker:** the `billing.credit-refund` queue and handler; the minute billing sweep queues one
  signed job per due request.
- **Web:** a Service credit card on the platform company page (balances, top-ups, refunds with
  their reason and who asked, and the refund form for platform owners); refunds in progress on the
  company's Billing page and receipts; a note on the deletion card when a due deletion waits.
- **Found while building:**
  - Postings made in one transaction share its time, and statements broke that tie by the posting's
    random id, so a refund could be listed before the release of its reservation, with a
    misleading balance in between. Statements, the latest changes on Billing and receipts now keep
    the order the postings were made in (their first ledger entry's id).
  - A refund still open when a company's deletion ran would have been stranded: the worker drops
    jobs for deleted companies. New refunds are refused once deletion is asked for, and a due
    deletion waits for refunds in progress.
  - The operations console could list a quarantined webhook event without its Retry control (from
    P5-10): Meta and Razorpay receipt processing wrote the quarantine entry and the receipt's
    `quarantined` status in two transactions, and a page rendered between them saw the entry with
    the receipt still processing. The local e2e run caught it once (`platform-ops.spec.ts` waited
    for Retry on such a page). Both processors now write the entries with the receipt's outcome in
    one transaction.
- **Tests:** the Razorpay stand-in can create refunds pending and finish them (in tests and through
  two test-only control routes for e2e).
- **Docs:** ADR-058; ARCHITECTURE §7; SECURITY (controls, Phase 5 rules, platform roles);
  THREAT-MODEL T82; RUNBOOKS §9 (refunds); DEPLOYMENT (`refund.failed` webhook event);
  DATA-RETENTION; RELEASE-CHECKLIST (a Razorpay test-mode run on staging); BACKLOG P5-05;
  FEATURE-MATRIX H-036.
- **Mutation checks:** 31 guards broken one at a time; all 31 make a test fail. They cover the
  request function's checks (owner, reason, deletion, spent credit, what is left of the payment,
  paid top-ups, the hold, the audit), staff reads, the due list, recording (the request completed,
  the match before the refund id is stored), failing (the hold released, never after processing),
  the company role's policy and column grants, the idempotency key, 409 and lost responses, the
  write-ahead attempt, recording an immediate refund, late failures, `refund.failed` trusted
  without a fetch, the deletion wait, statement order, labels and receipt links, the overview and
  receipt lists, and the form's refund limits.

### Test commands and results (local, 2026-09-28)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm test` (unit)                                                          | 298 passed. New: `billing/credit-refunds.test.ts` 2 (check intervals; labels for a refund's reservation and its release) and `platform/billing.test.ts` 3 (the form's limits: what is left of each payment, capped by the unused credit; refunded top-ups, ones with nothing left and ones with a refund in progress left out).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 388 passed, including the new `credit-refunds.test.ts` 11: the hold, audit and staff and company views; owners only, checked by the database too; a short reason, bad amounts, more than what is left of the payment or than the unused credit, an unpaid payment and a second open refund refused; one Razorpay call with the idempotency key and the processed webhook recording it once; a refund processed at once and one found by the worker's check; a lost response, a 409 and a 503 never making a second refund; the webhook arriving before the refund id is stored; a refusal and a failed refund giving the credit back (webhook and check), and a failed Dashboard refund changing nothing; a processed request never failed; company isolation. `company-data.test.ts` 15 (new: a due deletion waits for a refund in progress, and no refund starts once deletion is asked for). |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 74 passed (37 × 2) in one full run (14.9 min), including the new `credit-refunds.spec.ts` on both projects: a platform owner's refund with a reason and the confirmation; the worker's submission after the minute billing sweep; the company's Billing page (the refund in progress, the credit set aside, the note on the payment), the receipt and the email while it is in progress; the processed webhook recording it once; staff seeing it refunded. The first full run (72 passed, 2 failed) caught the confirmation disappearing on phones and the console's quarantine race, both fixed above.                                                                                                                                                                                                                                                                         |
| Mutation checks                                                             | 31 guards broken one at a time; all 31 make a test fail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### Known gaps

- Not run against Razorpay test mode yet (staging, RELEASE-CHECKLIST). Refunds asked for by
  companies, refunds of spent credit, instant refunds, several open refunds of one top-up, a
  platform-wide refunds list and the daily reconciliation report are not built.
- A refund Razorpay processes after its hold expired (90 days) is recorded as a plain refund.
- Firefox and WebKit run the new spec in CI only; only Chromium is installed locally.

## 2026-09-28 — Phase 5: billing statements and receipts (P5-07, part)

Status: **Monthly statements and payment receipts implemented and locally verified with test
data only.** Companies read their service credit month by month and download each month as CSV.
Every paid top-up has a receipt, and the billing managers are emailed a link to it. Payments come
from the Razorpay stand-in only. Receipts are payment confirmations, not tax invoices.

### Completed

- **Design (ADR-057):** statements are calendar months in the company's time zone, computed on
  request from the append-only ledger in one repeatable-read, read-only snapshot. Opening balances
  are the entries before the month, and closing balances are the opening plus every line. Receipts
  confirm payments and say they are not tax invoices; GST documents wait for tax review. The
  payment method Razorpay reported is recorded with the credit. Each credit is emailed with its
  receipt link.
- **Schema:**
  - Migration 0029 adds `app.topups.payment_method`, the definer function
    `app.billing_record_payment_method` (sets it once, only for the payment id that credited the
    top-up), and an insert policy that keeps a new top-up from carrying a method.
  - Migrations 0030 and 0031 build `ledger_entries_account_time_idx` (covering, for opening
    balances) and `ledger_transactions_reference_idx` (a top-up's refunds and chargebacks)
    concurrently, one statement per file: the runner sends a no-transaction file as one query,
    which would put two concurrent builds in one implicit transaction.
- **Domain (`billing/history.ts`):**
  - month helpers (calendar months in a time zone, daylight-saving safe through campaigns/schedule);
  - `statementMonths` (every month since the wallet was created, with totals and closing balances);
  - `statement` (100 lines per page, balances carried across pages);
  - `statementCsv` (opening and closing rows, exact rupees, audited as
    `billing.statement_exported`);
  - `receipt` (references, method, the saved card for automatic top-ups, refunds and chargebacks);
  - `creditFromPayment` now records the method (also when a payment is seen again) and emails every
    credit with its receipt link;
  - the CSV guard lets plain negative numbers through as numbers.
- **Web:** Billing → Statements (months), a month's statement (summary, lines, pages, print, CSV
  download), a receipt page per paid top-up, Receipt links in the Payments table and on statement
  lines, and a link to the statements from the credit history. The page chrome is hidden when
  printing.
- **Found while building:**
  - Billing scrolled sideways on phones. Screen-reader-only text in table cells escaped the
    table's scroll box, which was not positioned, and widened the page. The shared `Table` now
    positions its box, fixing every table, and the billing pages constrain their grid columns.
  - A stale "Plans: subscription plans are planned" card on Billing is removed; the plan card above
    it already explains plans.
  - One-time payments were labelled "Card payment", but Checkout also takes UPI and net banking.
    They now read "One-time payment".
- **Tests:**
  - The Razorpay stand-in can report a payment method.
  - The e2e fake Checkout moved into `tests/e2e/razorpay-checkout.ts`, shared by the billing specs.
- **Docs:** ADR-057; ARCHITECTURE §7; SECURITY (controls and Phase 5 rules); THREAT-MODEL T81;
  RUNBOOKS §9; DATA-RETENTION; RELEASE-CHECKLIST (statements and receipts on staging, tax
  decision); BACKLOG (P5-02, P5-03, P5-05, P5-07); FEATURE-MATRIX H-035.
- **Mutation checks:** 29 guards broken one at a time; all 29 make a test fail. They cover:
  - month boundaries in both queries;
  - line order and running balances;
  - each total;
  - months outside the wallet's life;
  - page clamping and months carried forward;
  - the CSV audit and the CSV number rule;
  - receipts for unpaid top-ups and receipt contents;
  - `billing.read`;
  - recording the method, and the definer function's three conditions;
  - the insert policy;
  - the emails.

### Test commands and results (local, 2026-09-28)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm test` (unit)                                                          | 293 passed. New: `billing/history.test.ts` 6 (month parsing, labels and steps, months in a time zone, Kolkata and London bounds, a midnight removed in Asunción and doubled in Havana, method labels) and 1 in `contacts/csv.test.ts` (plain negative numbers stay numbers, nothing longer does).                                                                                                                                                                                                                                                                                    |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 376 passed, including the new `billing-history.test.ts` 9: a UPI payment's receipt and its email with the receipt link; a redelivered payment adding nothing; a method filled in later; a refund on the receipt; no receipt for an unpaid top-up; runtime code unable to set a method (update, insert, another payment id or company, a recorded method); four fixture months that carry balances forward and reconcile; a time-zone change; 205 lines over three pages; the CSV rows and audit entry; this month matching the wallet balance; `billing.read` and company isolation. |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 72 passed (36 × 2) in one full run (12.9 min). New `billing-history.spec.ts` on both projects: a Checkout payment; Billing without sideways scrolling on a phone; the receipt (amount, "not a tax invoice", card through Razorpay, the payment id, the print button); the payment-received email linking to the receipt; the statements list with the month to date; the statement's credit line with its receipt link; the CSV download with the opening row, the credit line in exact rupees and the month-to-date row.                                             |
| Mutation checks                                                             | 29 guards broken one at a time; all 29 make a test fail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Known gaps

- Tax invoices and GST documents (tax review), PDF files, statements for custom ranges, stored or
  emailed monthly statements, staff views of statements and monthly rollups for high posting
  volumes are not built.
- The usage and rate card view and paying for plans in HyFib (other P5-07 screens) are not built.
- Firefox and WebKit run the new spec in CI only; only Chromium is installed locally.

## 2026-09-28 — Phase 5: step-up re-authentication (P5-07, part)

Status: **Step-up re-authentication implemented and locally verified.** Actions a stolen session
could use to take a company's data or money, or to keep access after the session is gone, now need
a sign-in within the last 15 minutes; the member signs in again (with two-factor when it is on) and
comes back to the page.

### Completed

- **Design (ADR-056):** a new sign-in instead of a password or code prompt, because re-entering the
  password alone skips two-factor and the library checks a signed-in user's two-factor code without
  its attempt limit; the window is the library's `freshAge` (15 minutes), now set from the domain's
  `RECENT_SIGN_IN_MINUTES`. SEC-8's verification endpoint is settled by it.
- **Domain:** `signedInAt` in the tenant context (the session's creation time passed by the web to
  `resolveTenantContext`; null without a browser session); `authz/step-up.ts`
  (`recentSignInUntil`, `hasRecentSignIn`, `assertRecentSignIn` with the existing
  `step_up_required` error). Enforced in: the company export and the deletion request, card
  mandate setup, auto-recharge settings unless turning them off, the company's Razorpay keys, API
  key creation and rotation, webhook endpoint creation, changes and secret rotation, invitations
  and role changes that make someone an owner, and turning off the company-wide two-factor
  requirement. Revoking, cancelling, turning off and deleting never ask.
- **Web:** `SignInAgain` (signs out and returns to the page after sign-in) and `ActionFailure` (the
  prompt when an action answers `step_up_required`, otherwise the error) in nine forms; the Company
  data page, adding a card on Billing and creating a key show the prompt instead of the action when
  the sign-in is older; the export route answers 403 with the message.
- **Docs:** ADR-056 (and ADR-055's "not built" list), ARCHITECTURE §3.4 and §6Q, SECURITY (sessions,
  payments, known gaps), THREAT-MODEL T2, T9, T77 and T78 (T77 and T78 now mitigated), RUNBOOKS §11,
  BACKLOG (P5-04, P5-07, P5-11, SEC-8), FEATURE-MATRIX (W-148, H-015).
- **Mutation checks:** 21 guards broken one at a time (each of the protected service functions,
  the safe-direction conditions for auto-recharge, owners, invitations and the two-factor
  requirement, the window's boundary and length, a context without a sign-in time, and the context
  taking the session's time); all 21 make a test fail.

### Test commands and results (local, 2026-09-28)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm test` (unit)                                                          | 286 passed. New: `authz/step-up.test.ts` 3 (the 15-minute window and its boundary, contexts without a sign-in time, the refusal and its message).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 367 passed, including the new `step-up.test.ts` 3 (every protected action refused to a member who signed in 16 minutes ago before any audit entry, key, endpoint, payment account, invitation, role or setting changes, and a context without a sign-in time refused; the same actions allowed a minute after signing in again; revoking a key, turning automatic top-ups or an endpoint off, deleting an endpoint, inviting an agent, changing to a role other than owner, turning the two-factor requirement on or keeping it off, and cancelling a deletion allowed 90 minutes after signing in). Test helpers now pass the session's start. |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 70 passed (35 × 2) in one full run (13.7 min). New `step-up.spec.ts` on both projects: right after signing up the export and a new key are offered; with the session aged an hour (a fixture step as the auth role) the Company data and API keys pages show "Sign in again" instead of the export link, the deletion form and the key form, and rotating a key from the page is refused with the same prompt; signing in again returns to the API keys page, where the key rotates.                                                                                                                                             |
| Mutation checks                                                             | 21 guards broken one at a time; all 21 make a test fail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### Known gaps

- WebAuthn or passkeys as the step-up factor, per-action windows, and a step-up for platform staff
  actions (their MFA is checked on every platform request) are not built.
- The remaining P5-07 screens (full transaction history and statements, usage and rate card,
  receipts and invoices) are not built; invoices need a tax review.

## 2026-09-28 — Phase 5: company export and deletion (P5-11)

Status: **Company export and deletion implemented and locally verified with test data only.**
Owners download a full copy of their company's data and can have the company deleted: 14 days as
suspended and cancellable, then a resumable worker job that removes HyFib from the company's
providers, deletes every company row and keeps only billing records, plan history and platform
evidence. Provider calls were verified against the Graph, Shopify and Razorpay stand-ins only.

### Completed

- **Design (ADR-055):** a streamed export with every table and column classified; deletion typed
  with the company address, due after 14 days, cancellable by owners until it starts; a worker job
  in bounded, resumable steps through SECURITY DEFINER functions; provider clean-up once with every
  outcome recorded; a tombstone company row; what is kept and why; backups and restores.
- **Schema (migration 0028):** the register `ops.tenant_deletions`, the step order
  `ops.tenant_deletion_steps` (86 steps over 87 tables, children before parents), the definer
  role's per-table `SELECT (tenant_id, id)`/`DELETE` grants with policies matching
  `ops.deleting_tenant_id()`, and `app.request_tenant_deletion`, `app.cancel_tenant_deletion`,
  `ops.tenant_deletions_due`, `ops.start_tenant_deletion`, `ops.record_tenant_deletion_cleanup`,
  `ops.delete_tenant_data` and `ops.finish_tenant_deletion` (executable by the runtime role only).
- **Domain:** `tenancy/export-spec.ts` (85 exported tables with their columns, 15 excluded tables
  and every omitted column with a reason), `tenancy/export.ts` (keyset pages from one read-only,
  repeatable-read transaction, an advisory lock per company, audit and emails first),
  `tenancy/deletion.ts` (status, request, cancel, with audit entries and emails to owners and
  administrators), `tenancy/deletion-run.ts` (start, provider clean-up, batches for up to five
  minutes, finish with the final emails), Graph `unsubscribeApp`, the store worker's removal for a
  deletion, a `tenant.notice` email, `tenant.delete` allowed while suspended and a pending-deletion
  message in the permission layer.
- **Worker:** the `tenant.delete` queue (`exclusive`, one run per company) and handler; the minute
  billing sweep queues a run for every due or unfinished deletion.
- **Web:** Settings → Company data (the export download, the deletion form with the typed address,
  the scheduled state with its due date and a cancel button, the started state), the streaming
  export route, a "being deleted" banner in the company layout and the company switcher, and a
  Deletion card on the platform company page.
- **Docs:** ADR-055, ARCHITECTURE §6Q, SECURITY (control, matrix, rules), THREAT-MODEL T77–T80,
  DATA-RETENTION (export and deletion semantics now built), RUNBOOKS §8 and §10Q,
  RELEASE-CHECKLIST, FEATURE-MATRIX (H-015), BACKLOG (P5-11 built).
- **Found while building:**
  - **Contact erasure left the number and text in past send requests** (`app.send_intents.request`);
    erasure now redacts them (fixed in 0028; the erasure test checks it).
  - **Public entry points treated a company pending deletion as unknown,** so a Shopify redaction or
    a payment received during the grace period would have been dropped. The six lookups now treat
    it like a suspended company. The growth suite had asserted that a company "being deleted"
    opens nothing (a P4-05 choice from before pending deletion had a meaning); it now expects the
    suspended behaviour, and that a deleted company's links open nothing (ADR-044's text notes the
    change).
  - **The ended-run guard no longer froze `pending_message_id` and `http_call_count`** (lost when
    0022 replaced the function); both are frozen again and tested.
  - **Every deletion request would have failed:** the email's date formatting combined
    `dateStyle`/`timeStyle` with `timeZoneName`, which `Intl.DateTimeFormat` rejects. The new
    integration suite caught it; the parts are spelled out and unit-tested.
  - **The export email said "downloaded"** although it is sent before the first line and also for
    a refused or interrupted export; it now says the export was started.
  - **Mutation checks:** 33 guards broken one at a time (the owner check, the typed address, a
    second request, cancelling after the start, the restored suspension and restriction, the due
    date, releasing the bindings, who is notified, recording the clean-up once and only known
    keys, deleting only for a started deletion, the definer's delete policy, finishing while rows
    remain, the step order, a table left out, each of the six lookups, the send-request redaction,
    both frozen run columns, visiting providers once, cancelling the card mandate, the Graph
    method, one export at a time, the export's audit entry, members' accounts in the export,
    administrators emailed, cancelling while pending). All 33 make a test fail.

### Test commands and results (local, 2026-09-28)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pnpm test` (unit)                                                          | 283 passed. New: `tenancy/company-data.test.ts` 4 (dates in the company's time zone, the export spec's tables, columns, omitted-column reasons and member columns).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 364 passed, including the new `company-data.test.ts` 14 (every company table deleted or kept on purpose, each once; children deleted before parents and nothing kept pointing at deleted rows; the definer's read and delete policies on every step table and the functions refusing companies not being deleted or not started; every table and column of the export classified, secrets omitted and readable by the runtime role; a busy company's export with row counts, members' accounts, no other company, no tokens, the audit entry and emails; owners only, one at a time, available while pending; requests needing an owner and the typed address, the company then suspended with emails and audit; cancellation restoring active, suspended with HyFib's reason, or restricted after a lapsed plan, and refused once started; runs not due; a full run with WhatsApp, Shopify and a card mandate at the stand-ins (tombstone, kept records, each provider called once, final emails without the company, the other company untouched, jobs refused, the address reusable, later webhooks quarantined, the platform record); a resumed run; a refused Meta token recorded and the deletion finished; cleanup outcomes validated and recorded once; the six public lookups while pending), the erasure test checking send requests, the ended-run guard's two columns, the growth test's new expectation and the new function grants in the isolation suite. |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 68 passed (34 × 2) in one full run (12.2 min). New `company-data.spec.ts` on both projects: an owner downloads the export (file name, gzip JSON Lines with the header, the owner as the only member and the end line, no `tenant_id`), the email arrives; the delete button stays disabled until the address is typed exactly; the deletion is scheduled (banner, due date, requester, email) with the export still available, then cancelled (banner gone, email); and a due deletion (moved on by a fixture step as the definer role) is run by the real worker from the minute sweep, the owner gets "Company deleted" and the company's pages answer 404.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Mutation checks                                                             | 33 guards broken one at a time; all 33 make a test fail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### Known gaps

- Not built: step-up re-authentication before exporting or deleting, deletion started by platform
  staff, stored exports with a download link, other formats, a shorter grace period.
- Provider clean-up was verified against stand-ins only; `DELETE /{WABA-ID}/subscribed_apps`,
  Shopify's `appUninstall` and Razorpay token deletion still need a staging run
  (RELEASE-CHECKLIST).
- The kept records (billing, plan history, the register) and their periods need a legal and tax
  review; the Razorpay customer record is not deleted.
- Deleted data stays in backups until they expire; re-applying deletions after a restore is a
  manual runbook step (RUNBOOKS §8), not yet drilled.
- A very large company's export holds one read-only transaction for as long as the download takes;
  a reader that stops for a minute ends it (`idle_in_transaction_session_timeout`).
- Firefox and WebKit run in CI only.

## 2026-09-28 — CI: the Firefox stall in the cart reminder test

Status: **Cause found and worked around in the test browser; verified locally and in CI.**
The stall came from Playwright's Firefox driver, not from HyFib: no page, worker or database code
changed.

### Cause

- On 0251ce1 (CI run 36392541160) `stores.spec.ts:411` waited in `page.goto` of the store page until
  its 5-minute timeout in Firefox, passed on retry, and the job ran out of time. The server side was
  ruled out: every database wait of web and worker is bounded (statement 15 s, lock 5 s, pool
  checkout 10 s, idle transaction 60 s), and the store page reads with plain selects in a read-only
  transaction, which never wait for the worker's store lease.
- Playwright 1.63's Firefox (155.0, build 1543) can lose a protocol message after
  Cross-Origin-Opener-Policy replaces a page's browsing context. The replacement gets a new driver
  channel with the same identifier (`process-<pid>`) whose message ids start again at 1, while the
  browser end still holds answers the old channel never acknowledged; a new message with a colliding
  id is answered from that cache and never delivered. When the lost message is a navigation's
  "committed" event, `page.goto` never settles. Upstream: microsoft/playwright#42731 (same versions)
  and #42183. Playwright's main branch fixed it with Firefox build 1551 on 2026-09-22; no stable
  release ships it yet (1.63.0 is the latest, 1.64 is in alpha).
- Every HyFib page sends `Cross-Origin-Opener-Policy: same-origin`, and the cart reminder test
  crosses that boundary on its first page (from about:blank) and in two round trips through the
  Shopify stand-in on another origin (connecting the store, allowing customer access). The lost
  message can be any later one on the replaced channel, so the stall can come well after the
  crossing; here it came after a reload loop and two saves.
- Evidence from CI: on 38796f2 (run 36395830637, whose report was uploaded because the job failed)
  the cart test failed on both attempts in Firefox. On the retry, `page.goto` of the store page
  never returned, although its trace shows the page's document (200 in 39 ms), all its scripts and
  its link prefetches loading within half a second, with no request of the old page in flight, and
  the failure screenshot shows the rendered store page. On the first attempt, a `toBeVisible` check
  with a 1-second timeout never returned after a reload (a lost execution context message), so the
  reload loop stopped reloading and ran out its 45 seconds; the worker had read the store 2 seconds
  after "Read the store now", so it was not involved.
- Evidence (local, Firefox build 1543, one fresh context per trial, four at a time): the upstream
  reproduction page left `goto` pending 208 times in 600 with COOP enforced and 0 in 600 with
  enforcement off; the cart test's navigation pattern on HyFib's own sign-in page (first navigation,
  then three round trips to another origin without COOP) left a `goto` pending in 125 of 150
  contexts with COOP enforced and in none of 1,050 navigations with enforcement off; a driver build
  instrumented to log messages answered from that cache showed the lost `pageNavigationCommitted`
  behind a stuck `goto`. In the cart test itself, the instrumented driver saw the page's browsing
  context replaced 3 times in a run with COOP enforced (each a new driver channel under the old
  identifier: the first page and the two round trips through the stand-in) and never with
  enforcement off. The CI stall itself was not reproduced with the full test locally, where
  contexts run one at a time and the race is much rarer (0 stalls in 280 such navigations in the
  test runner): the cart test passed 8 of 8 times under CPU load and 5 of 5 with the instrumented
  driver.
- Found alongside, not the cause: Firefox fails `page.reload` and `page.goto` with
  `NS_BINDING_ABORTED` when a test navigates while the page's router is still fetching
  (`templates.spec.ts` in 6 of the last 39 CI runs, `automations.spec.ts` in 3, all passing on
  retry). Firefox cancels the page's in-flight requests as soon as a navigation starts, and Next.js
  answers a failed router request by loading the current page again, which aborts the test's
  navigation (reproduced against a small local server). See Known gaps.

### Completed

- **Firefox runs without COOP enforcement** (`tests/e2e/playwright.config.ts`):
  `browser.tabs.remote.useCrossOriginOpenerPolicy=false`, so no browsing context is replaced and no
  driver channel restarts. Chromium and WebKit still enforce COOP, no test relies on Firefox
  enforcing it, and the header itself is unchanged. Remove it with the Playwright upgrade that ships
  Firefox build 1551 or later.
- **Navigations are bounded:** `navigationTimeout: 30_000`, so a navigation that never settles, for
  any reason, fails within 30 seconds and is retried in CI instead of holding its test until the
  test's own timeout (5 minutes for the cart reminder test).
- **CI keeps evidence:** the end-to-end step stops at 40 minutes (the job has 45); the server logs and
  the job, store and database state (from 7b62ff0) are printed on failure or cancellation; and the
  Playwright report with `test-results` and the web and worker logs are uploaded for every run, one
  artifact per attempt, so a test that passed on retry keeps its failed attempt's trace.

### Test commands and results (2026-09-28)

| Command                                                                                          | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                                             | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm test:e2e` (all four projects, on the P5-10 tree)                                           | 116 passed, 12 skipped: in each project the web request, webhook and Flows data endpoint tests call a target through `E2E_HTTP_HOST`, which needs the hosts entry CI adds                                                                                                                                                                                                                                                                                           |
| `pnpm test:e2e --project=firefox --repeat-each=5 --retries=0 stores.spec.ts -g "cart reminders"` | 5 passed                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| CI, run 36411204063 on 86dad15 (the fix plus a temporary job, since reverted)                    | lint, types and unit tests, integration on PostgreSQL 17 and 18, build and security scans passed. The temporary Firefox job measured the round trips on HyFib's sign-in page (COOP enforced: 51 of 60 contexts left a `goto` pending; enforcement off: none in 420 navigations), then ran `stores.spec.ts` 6 times (30 passed) and the cart reminder test 10 more times (10 passed), without retries. The four-project e2e job: 128 passed (28.6 min), none retried |

### Known gaps

- Firefox end-to-end runs do not enforce COOP until the Playwright upgrade; Chromium and WebKit do.
- The `NS_BINDING_ABORTED` failures above remain and pass on retry. `templates.spec.ts` reloads just
  after the template editor's `router.refresh()`, which repeats the refresh its save action already
  asked for; tests that navigate straight after an in-page refresh should wait for the page to
  settle or move through the app's links.

## 2026-09-28 — Phase 5: platform operations console (P5-10)

Status: **Operations console implemented and locally verified with test data only.** Platform staff
see where companies are stuck or failing, what the job system is doing and whose sending needs a
review under `/platform/ops`, from counts, states, error codes, labels and times. No message text,
contact, payload, email address, secret or full URL reaches the console. Dead-lettered jobs are now
recorded by the worker instead of sitting unread in pg-boss. Nothing ran against a production
company.

### Completed

- **Design (ADR-054):** four SECURITY DEFINER read functions that refuse anyone but a platform
  administrator; direct reads only of what the platform role could already read; queue counts from
  pg-boss's `getQueues()`; dead letters recorded by the worker without error messages; no redrive
  button (the minute sweeps re-signal durable rows); two audited repairs; health and signal rules
  that are HyFib's own heuristics, never automatic suspension.
- **Schema (migrations 0026 and 0027):** `ops.dead_letters` (the worker role may only insert, the
  platform role reads, `ops.purge_dead_letters` deletes after 30 days), `ops.url_host`,
  `ops.platform_ops_health`, `ops.platform_ops_activity` (at most 93 days back),
  `ops.platform_ops_signup_sessions`, `ops.platform_ops_integration_failures`,
  `ops.platform_retry_webhook_receipt`, the definer role's column grants and a read policy on
  signup sessions; 0027 indexes consent events by company and time, built concurrently.
- **Domain:** `platform/ops-model.ts` (health issues and levels, review signals, quarantine ids
  allowed on screen, labels), `platform/ops.ts` (overview, company health, onboarding,
  integrations, queues, signals, usage, receipt retry, quarantine resolution with a platform audit
  entry), `jobs/dead-letters.ts` (the recorded row: a company, kind and reference only when the
  envelope's signature verifies; an error's name and code only; idempotent recording that returns
  the rows actually added; the purge) and a pg-boss queue inspector.
- **Worker:** consumes `dead-letter` (batches of 20 with pg-boss metadata; recording retried three
  times with backoff), purges old dead letters in the messaging sweep, and logs every failed job
  attempt with its queue and job ids (added while chasing the Firefox stall below).
- **Web:** `/platform/ops` with Overview, Onboarding, Integrations, Queues, Signals and Usage (7, 30
  or 90 days), a Health card on each company's platform page, Retry and Resolve forms (a reason is
  required) and an Operations link on `/platform`.
- **Docs:** ADR-054, ARCHITECTURE §4, §6P and §8, SECURITY (control and platform rules),
  THREAT-MODEL T75 and T76 (and a broken table cell in T71 fixed), DATA-RETENTION (dead-letter
  records), RUNBOOKS §1, §3, §4 and §10P (the owner-role receipt reset becomes a fallback),
  RELEASE-CHECKLIST, FEATURE-MATRIX (H-034), BACKLOG (P5-10 built).
- **Found while building:**
  - **The dead-letter queue had no consumer.** Jobs that used their last retry sat in pg-boss for
    30 days, visible only with SQL, and pg-boss cannot list them with a limit. The worker now
    records them (above).
  - **Handler errors were never logged by the worker** (pg-boss kept them only in the job's
    output), which made the worker hard to rule out while the Firefox cart reminder stall was
    chased. Every failed attempt is now logged with its queue and job ids (pushed first, in
    7b62ff0).
  - **A quarantined receipt was offered for retry in two tables,** and once its quarantine entry was
    resolved the receipt stayed "needing attention" for good. The receipts table now leaves
    quarantined receipts to the quarantine table, matching the overview's count.
  - **The security events table appeared on both Integrations and Signals;** it is on Signals only.
  - **Tables made the pages wider than a phone.** A grid with implicit `auto` columns grows to its
    widest table; `grid-cols-1` lets each table scroll inside its card. A table cell styled as a
    grid now holds a grid inside it instead.
  - **The first refusal test reached only the first function a page calls,** so removing the
    administrator check from any later function would have passed. Each function is now called
    directly by a non-administrator.
  - **Recording dead letters reported the batch size,** so a repeated batch was logged as recorded
    again; it now returns the rows actually added (the worker role cannot use `RETURNING`).
  - **A dead letter from an undeclared queue was shown with an invented policy** ("no retries, then
    dead-lettered"); it now reads "Not declared by this release".
  - **The end-to-end test's own race:** reloading right after clicking a tab cancelled the
    client-side navigation, so the test waits for the page before reloading until the worker's
    quarantine shows.
  - **Firefox stall (open since P5-09):** CI on 7b62ff0 ran all 124 end-to-end tests green on the
    first attempt, with no retries. The cause was later found in Playwright's Firefox driver, not
    in the worker (see "CI: the Firefox stall in the cart reminder test" above); the worker's
    attempt logs and the new CI step (job, store and database state after a failure) remain for
    other failures.
  - **Mutation checks:** 21 guards broken one at a time (the administrator check in each of the
    five functions, the host-only label, retrying from another status or without a body, the audit
    entry, the purge age, imported opt-outs, completed signups, the activity window, attribution
    without a verified signature, error messages kept, duplicate recording, resolving twice, the
    quarantine id allow-list, the minimum message count for send failures, the usage windows, and
    offering a retry for an erased receipt). On the first run 20 made a test fail; the survivor
    (an erased receipt still offered for retry, which the database would refuse) now has a test,
    and all 21 fail a test.

### Test commands and results (local, 2026-09-28)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm test` (unit)                                                          | 279 passed. New: `platform/ops-model.test.ts` 11 (health issues and levels at each threshold, the worst quality of active numbers, integration failure wording, review signals at their thresholds, quarantine ids), `jobs/dead-letters.test.ts` 4 (only the error's name and code, pg-boss timeouts, attribution only with a verified signature, malformed metadata).                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 350 passed, including the new `platform-ops.test.ts` 11 (each function refusing a non-administrator and the runtime role refused; a company's numbers, sending, endpoints, quality and 30-day activity counted without its message text; the overview, signals and usage; the activity window; failed and abandoned signups but not completed ones; a failing endpoint labelled by its host only; an exhausted receipt retried with its audit entry, and refusals for a processed receipt, an erased or old body, an unknown receipt and a non-administrator; a quarantined event resolved once, audited; a job dead-lettered by real pg-boss recorded once with its company only through its verified signature and without its error message; the 30-day purge) and the new function grants in the isolation suite. |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 64 passed (32 × 2) in one full run (10.6 min). New `platform-ops.spec.ts` on both projects: staff with two-factor authentication open Operations from `/platform`; the new company is listed without an active number; a signed event from an unknown WhatsApp account is quarantined by the worker, shown without its text, retried and resolved with reasons; queue policies (`commerce.store`: 5 retries, then dead-lettered; `billing.auto-recharge`: no retries); signals; usage over 7 days; both repairs in the platform audit log; the company's Health card; no sideways scrolling on any of these pages.                                                                                                                                                                                     |
| Mutation checks                                                             | 21 guards broken one at a time; all 21 make a test fail (one needed the new erased-receipt test)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Known gaps

- Not built: alerts (email or pager) on these conditions, trends over time, number quality from
  Meta's `phone_number_quality_update` webhook (quality is as of the last health check), API
  request counts, exports, the age of the oldest waiting job, redrive from the console,
  acknowledging or snoozing an issue.
- Every page reads every company: fine for the test envelope (100 companies), not for thousands;
  paging and precomputed rollups come with growth.
- The health and signal thresholds are HyFib's own heuristics and have not met real traffic.
- Firefox and WebKit run in CI only; no production company has been seen in the console.

## 2026-09-28 — Phase 5: outgoing webhooks (P5-09)

Status: **Outgoing webhooks implemented and locally verified; delivered only to local test
receivers.** Companies add HTTPS endpoints in Settings → Webhooks and receive signed JSON POSTs for
received messages, message status, consent changes and template status. Events are captured by
database triggers in the company's scope, payloads are built when delivered, and delivery goes
through the egress guard with bounded retries, replays and automatic disabling. Delivery is at least
once, never claimed exactly once. No request reached a customer's system.

### Completed

- **Design (ADR-053):** up to 10 endpoints per company (`developer.manage`); four event types plus
  `ping` for tests; events hold ids and non-personal facts only and payloads are built at delivery
  (an erased contact is sent without personal data); a per-company `webhook.deliver` job (policy
  `stately`) woken through LISTEN and the minute sweep, which read due companies from the database
  and never from a notification; signatures `t=<time>,v1=<HMAC-SHA256 of "<t>.<body>">`; eight
  attempts over about 45 hours; automatic disabling after 72 hours of failures; 30-day retention.
- **Schema (migration 0025):** `app.webhook_endpoints` (encrypted secrets with versions, the
  previous secret's expiry, on/off with the reason, health), `app.webhook_events`,
  `app.webhook_deliveries` (states, attempts, lease, results, replays), row-level security, column
  grants, the capture triggers on messages, consent events and template status events
  (`app.capture_webhook_event`, SECURITY INVOKER), the notification trigger, and the SECURITY
  DEFINER sweeps `ops.webhook_dispatch_due` and `ops.purge_webhook_data`.
- **Domain (`webhooks/`):** the endpoint service (create with the secret shown once, edit, turn off
  and on, rotate with a 24-hour overlap, delete, test events, delivery history, replays; audited with
  the host only), payload building for each event type, signing and verification, and the delivery
  worker (claims in batches of 10 with `SKIP LOCKED` and a lease, requests with no transaction open,
  outcomes recorded under endpoint-then-delivery locks and dropped when a newer attempt owns the
  delivery, the retry schedule, interrupted attempts, disabling with a system audit entry and an
  email to owners and administrators, dispatch and retention helpers). The OpenAPI document
  describes every event under `webhooks`.
- **Worker:** the `webhook.deliver` handler, a LISTEN connection that coalesces notifications into at
  most one database lookup every 250 ms (reconnecting with backoff), and the sweep and retention in
  the per-minute messaging sweep.
- **Web:** Settings → Webhooks (owners and administrators): endpoints with state, events, last-24-hour
  counts, health and secret version; adding one (the secret shown once, kept only in the page's
  memory); test events; rotation; turning off and on; deletion; each endpoint's deliveries (all or
  failed), replays and its settings.
- **Docs:** ADR-053, ARCHITECTURE §6O, SECURITY (control, Phase 5 rules, secret rotation, gaps),
  THREAT-MODEL T71 to T74, DATA-RETENTION, RUNBOOKS §10O, RELEASE-CHECKLIST, FEATURE-MATRIX (H-014,
  W-138, W-139, W-144), BACKLOG (P5-09 built; SEC-3 users).
- **Found while building:**
  - **An unreachable notice on the API keys page (removed).** The page showed a "Reading only" alert
    for suspended and restricted companies, but those companies lose `developer.manage`, so the page
    answers 404 before the alert could render. The API's own behaviour for them (reading only, 423
    for writes) is unchanged and documented in the runbook.
  - **A normalised URL longer than the column allows (fixed before commit).** Percent-encoding can
    lengthen an entered URL past 2048 characters; the service now refuses it as a form error instead
    of failing on the table's check.
  - **The CI end-to-end job reached its 30-minute limit (limit raised to 45).** The suite now has
    124 tests run one at a time across four browsers; green runs already took 27 to 29 minutes
    including set-up, and on 0251ce1 the existing Firefox cart reminder test stalled in
    `page.goto` until its 5-minute timeout, passed on retry, and the job was cancelled at 30
    minutes. The stall was a Playwright driver bug in Firefox, since worked around (see "CI: the
    Firefox stall in the cart reminder test" above).
  - **The loopback allowance also lifts the port rule.** A privileged-port URL passes the URL check
    wherever `W360_EGRESS_ALLOW_LOOPBACK` is set (local and test only); the test for that rule uses
    the production policy.
  - **Mutation checks:** 20 guards broken one at a time (claiming deliveries not yet due, 3xx as
    success, the retry schedule, the disabling threshold, the interrupted-attempt limit, the previous
    secret's expiry, the lost-outcome check, claiming for a turned-off endpoint, retrying after it was
    turned off, stopping after a batch of ended deliveries, disabling without failing waiting
    deliveries, the notice's recipients, clearing the failing state, the lease window, the event id
    header, test events and replays to a turned-off endpoint, the endpoint limit's lock, failing only
    waiting deliveries). 19 make a test fail; the survivor (building an erased contact's number from
    the row without checking `erased_at`) is equivalent, because `app.erase_contact` clears the
    number and name in the same statement.

### Test commands and results (local, 2026-09-28, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass (on 5015970)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `pnpm test` (unit)                                                          | 264 passed. New: `webhooks/webhooks.test.ts` 11 (signature format and verification with its 5-minute tolerance, two secrets, tampering, the retry schedule, inbound summaries per message type, payload schemas for every event including erased contacts, error labels, hosts, the endpoint-disabled email escaping what it shows, the OpenAPI `webhooks` section with its headers and schemas).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 339 passed, including the new `webhooks.test.ts` 22 with a local receiver (endpoints: secret shown once and stored encrypted, the egress URL rules, the limit under twelve concurrent additions, developers only; capture per subscribed type with one delivery per active endpoint and none after a rollback; signed `message.received` with the contact and text; `message.status` for accepted, delivered and failed with its error; `template.status_changed`; an erased contact sent without number, name or text; a deleted message ending as `event_gone`; the retry schedule over eight attempts; an edited URL used for the next attempt; timeouts and redirects as failures; interrupted attempts and the attempt limit; outcomes dropped after a newer attempt, a deletion or a turn-off; ended deliveries not holding up others; automatic disabling with its emails and audit entry; turning off, replays and test events; deletion; rotation overlap and expiry; loopback, metadata and rebinding addresses refused; dispatch skipping suspended companies with one job per company; retention; isolation, row security and column grants) and the webhook function grants in the isolation suite. `webhooks.test.ts` was rerun after the last service change (URL length): 22 passed. |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 62 passed (31 × 2) in one full run (11.6 min). New `webhooks.spec.ts` on both projects: an endpoint added in Settings → Webhooks (secret shown once, not on the page after a reload), a signed test event verified with the secret, a received message from Meta's webhook delivered with the contact, the delivery history, a replay with the same event id, a rotation signing with both secrets, turning off and on, deletion; no sideways scrolling. After the last two changes (URL length, the API keys page), a rebuild of 5015970 and `api.spec.ts` plus `webhooks.spec.ts` again: 4 passed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Mutation checks                                                             | 20 guards broken one at a time; 19 make a test fail, and the survivor is the equivalent mutant above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Known gaps

- Not built: filters beyond the event type, custom headers, mutual TLS, fixed egress addresses for
  receivers' allowlists, endpoints per number, ending a rotated secret's overlap early, events for
  conversations, campaigns, automations, contact changes and orders, and managing endpoints through
  the public API (W-139).
- Delivery throughput is not load tested; one company's job sends 10 requests at a time.
- Firefox and WebKit run in CI only; deliveries reach local test receivers only.

## 2026-09-28 — Phase 5: public API (P5-08)

Status: **Public API v1 implemented and locally verified; sends reach only the local Graph
stand-in.** Companies create API keys in Settings → API keys and call `/api/v1` to send approved
templates, create contacts, record consent and read the status of messages the API sent. Keys are
hashed, scoped within their creator's permissions, rotated with an overlap and revoked at once;
sends go through the members' checks and the existing send pipeline, and an `Idempotency-Key`
makes retries safe. No request reached Meta.

### Completed

- **Design (ADR-052):** keys belong to the company; five scopes (`templates.read`, `contacts.read`,
  `contacts.write`, `messages.send` for utility templates, `messages.send_marketing`), each granted
  only by a member holding the matching permission; a request acts in its company's scope as the
  key; template sends only (session, media and interactive messages are not in v1); idempotency
  keys stored with the request's own transaction; keyset cursors; an OpenAPI document from the
  validation schemas.
- **Schema (migration 0024):** `app.api_keys` (SHA-256 of the token only, unreadable by the runtime
  role; a guard trigger keeps token, scopes and author fixed, a revocation final and an expiry only
  sooner; never deleted), `ops.api_key_authenticate` (SECURITY DEFINER; refuses revoked and expired
  keys and companies being deleted; records the last use at most once a minute without waiting),
  `app.api_idempotency_keys` and `ops.purge_api_idempotency_keys`, `app.messages.api_key_id`, and
  `api_key` as a consent actor.
- **Keys (`api/keys.ts`):** `w360_` + 12 base32 characters (the public prefix) + 32 random bytes;
  creation with name, scopes and expiry (30, 90, 365 days or never), at most 20 active keys under a
  company lock, rotation to a key with the same scopes and lifetime with 0 to 72 hours of overlap,
  immediate revocation, all audited with the prefix only.
- **Requests (`apps/web/src/server/api.ts`):** bearer authentication, failed attempts limited per
  client address, token buckets per key and per company (429 with `Retry-After`), JSON content type
  and a 64 KB body limit, `Idempotency-Key` checks, error bodies with a request id, no tokens in logs.
  Writing scopes are refused while the company is suspended or restricted.
- **Resources (`api/resources.ts`):** templates with their variables and numbers; contacts in pages
  with cursors, by number and by id; create or return the existing contact (suppressed numbers
  refused); consent with evidence; template sends with the members' checks (approval, category
  scope, variables, number selection, consent, suppression, erasure, marketing frequency cap under
  the campaign lock), queued through the send pipeline and re-checked before dispatch; the status of
  API messages.
- **Web:** Settings → API keys (owners and administrators): base URL, example, key list with state,
  prefix, scopes, author, last use and expiry, creation with the scopes the member may grant, the
  token shown once with a copy button, rotation with an overlap and revocation. `GET
/api/v1/openapi.json` publishes the document (cacheable for 5 minutes).
- **Docs:** ADR-052, ARCHITECTURE §6N, SECURITY (control, Phase 5 rules, key rotation, gaps),
  THREAT-MODEL T67 to T70, DATA-RETENTION, RUNBOOKS §10N, RELEASE-CHECKLIST, FEATURE-MATRIX (new
  H-033; W-058, W-086, W-134 to W-137, W-140, W-141, W-142, W-144), BACKLOG (P5-08 built).
- **Found while building:**
  - **Contacts list and CSV export showed no tags and no consent (fixed, own commit).** Drizzle
    leaves the table name out of a select without joins, so the correlated subqueries for tags and
    consent compared the subquery's own `id`. Every contact showed no tags and unknown consent in
    the list and the export. The subqueries now use `outerColumn`; the contacts suite checks the
    values. The API's contact queries had the same mistake before their first test run.
  - **A test that depended on file order (fixed, own commit).** Two cart reminder assertions looked
    contacts up by number across companies; the contacts erasure test creates the same number in
    another company, so the assertion failed whenever that file ran first.
  - **The Templates page scrolled sideways on phones (fixed).** Its outer grid had an automatic
    column that grew to the table's width, so a long template name widened the whole page (the new
    e2e test's click on "Refresh from Meta" landed on overlapping text on mobile). It now uses one
    shrinkable column, as other pages do, and the API e2e test checks for sideways scrolling there.
  - **Review fixes for P5-01 (own commit):** retrying a failed number's setup now checks the number
    limit; the staff plan form sends only the add-ons the chosen plan sells.
  - **Mutation checks:** 16 API guards removed one at a time. Two survived at first: a 0-hour
    rotation that only expired the old key (the test now requires it revoked), and removing the
    key-limit lock (the six racing creations started after the first had committed because the pool
    had one open connection; the test now opens six connections first, and the mutation fails the
    test in three of three runs). Removing the outer once-a-minute check in the last-use update
    changes nothing, because the update repeats the condition (an equivalent mutant); removing both
    fails the test.

### Test commands and results (local, 2026-09-28, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm test` (unit)                                                          | 253 passed. New: `api/api.test.ts` 13 (token shape and hashing, bearer parsing, scopes and their permissions, key states, the idempotency key format, error mapping without internals, the OpenAPI document against the route handlers and its references); `plans/model.test.ts` +1 (add-ons a plan sells).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 317 passed, including the new `api.test.ts` 20 (key creation, validation and granting within permissions, the 20-key limit under six concurrent creations, authentication and last use, suspended, restricted and deleting companies, rotation with and without overlap, key guards, scopes, contacts create and upsert with suppression, cursor pages, consent with evidence, idempotent replays, reuse refused, failures stored nothing, recycling after 24 hours, templates list, sends through the Graph stand-in with concurrent retries and delivery status, template, variable, number and suppression checks, marketing scope, opt-in and cap, opt-out after queueing, status of API messages only, isolation, the sweep), a retry test in `plans.test.ts`, list and export checks in `contacts.test.ts`, and the API function grants in the isolation suite. |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 60 passed (30 × 2) in one full run (10.1 min). New `api.spec.ts` on both projects: a key created in Settings → API keys (token shown once, only its prefix listed afterwards), the OpenAPI document without a key, 401 without one, templates, 403 without the contacts scope, a contact created, 400 without an `Idempotency-Key`, a template sent with a retry replayed, the worker's send to the Graph stand-in read back as `accepted`, exactly one request at the stand-in, the revoked key refused; no sideways scrolling on the Templates and API keys pages.                                                                                                                                                                                                                                                                                   |
| Mutation checks                                                             | 16 API guards and 3 fixes (contact tags, contact consent, the retry limit) broken one at a time; each makes a test fail, apart from the equivalent mutant above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Known gaps

- Not built: monthly API quotas per plan, API access as a plan module, session, media and
  interactive messages through the API, conversation and message lists, starting automations,
  bulk sends in one call, outgoing webhooks (P5-09), IP allowlists per key and reminders before keys
  expire.
- The rate limits are not exercised by automated tests.
- Firefox and WebKit run in CI only; sends reach the Graph stand-in only.

## 2026-09-28 — Phase 5: plans and entitlements (P5-01)

Status: **Plans and entitlements implemented and locally verified; paying for a plan in HyFib is not
built.** Platform owners keep a catalog of immutable plan versions (no prices in code), every company
has a plan state, staff put companies on plans, time moves trials, paid periods and grace periods on,
a lapsed plan restricts the company, and seats, WhatsApp numbers, teams, live automations and monthly
automation runs are limited where they are added. Nothing is charged: staff set paid periods after a
payment settled elsewhere (Razorpay Subscriptions stay in P5-07). No request reached a provider.

### Completed

- **Design (ADR-051):** a platform catalog of plan versions (draft → published, immutable → retired)
  with an INR price per 1, 3 or 12 months, trial and grace days, limits (no value: no limit),
  add-ons (extra seats and numbers up to a maximum, automation run packs) and modules (automations,
  WhatsApp Flows, CRM, commerce; the rest is in every plan). One plan state per company:
  complimentary, trialing, active, past_due, expired, canceled. A default trial for new companies,
  else complimentary; companies from before plans are complimentary.
- **Schema (migration 0023):** `ops.plans` (guarded like rate cards: drafts editable, published
  versions immutable even for the platform role, retire only, never deleted), `ops.plan_settings`
  (the default trial, which must be published with trial days), `app.tenant_plans` (one row per
  company, created by a trigger with the company, backfilled complimentary as `w360_definer`,
  guarded so only published versions are assigned and add-ons stay within what the version sells),
  `app.usage_counters`, the `restricted` company status with a trigger that restricts an active
  company when its plan lapses and lifts it when access returns (suspension wins),
  `app.tenant_entitlements`, the sweep functions (`ops.plan_transitions_due`,
  `ops.usage_limits_reached`, `app.apply_plan_transition` in the company's own scope),
  `ops.platform_tenant_usage` (counts only), `app.accept_invitation` with the seat check, and seven
  lookup functions that now treat restricted companies like suspended ones.
- **Limits (`plans/entitlements.ts`):** checked where things are added, under a per-company advisory
  lock per kind: seats (active members plus waiting invitations) when inviting, resending an expired
  invitation and restoring a suspended member, and in SQL when an invitation is accepted; WhatsApp
  numbers when a number is connected (or connected again); teams when created; live automations
  when published or turned on. A lower limit removes nothing.
- **Automation runs:** each live run started by a customer message or a store event consumes the
  month's counter atomically (never past the limit; test runs are not counted); months start on the
  usage anchor's day; store events beyond it are skipped as `automation_quota`. The billing sweep
  emails billing managers once when a month is used up.
- **Modules:** the tenant context drops the write permissions of modules the plan leaves out
  (reading stays, with the plan's reason when refused); automation starts, order messages and cart
  reminders (`not_in_plan`) and sending products or flows from a conversation check the module.
- **Time (`plans/sweep.ts`, the minute billing sweep):** trials that ended expire; paid periods that
  ended become past_due for the version's grace days, then expire; each change is audited as the
  system and emailed to billing managers; one company's failure is logged and retried without
  holding up the others.
- **Platform:** plan catalog screens (list, new plan, version page with publish, new version,
  retire or discard, draft editing), the default trial, a Plan card on each company (state, limits,
  usage counts, assignment form with version check and reason), plan columns in the company list,
  and reactivation that restricts a company whose plan lapsed. Only platform owners change the
  catalog.
- **Company pages:** a plan card on Billing (state, price, add-ons, modules, usage against limits),
  banners for a restricted company and an overdue payment, limit hints on Members, Teams, WhatsApp
  numbers and Automations, "not in your plan" notices on the four plan modules, a plan column in
  Settings → Modules, and the inbox hides form and product sending when the plan leaves them out.
- **Docs:** ADR-051, ARCHITECTURE §7, SECURITY (plans control, permission rules, platform roles),
  THREAT-MODEL T64 to T66, DATA-RETENTION, RUNBOOKS §10M, RELEASE-CHECKLIST, FEATURE-MATRIX (W-001
  to W-009, W-014, new H-032), BACKLOG (P5-01 built; P5-06 note), and two stale module descriptions
  in Settings → Modules corrected (automations from store orders with templates; store connectors
  exist).
- **Found while building:**
  - **The backfill wrote nothing (fixed before commit).** Forced RLS on companies applies to the
    migration role too, so the first backfill inserted no plan states. It now runs as `w360_definer`
    after its policies exist.
  - **Lock order (designed out before commit).** The sweep, plan changes and status changes all
    lock the company row before its plan state, so they cannot deadlock; the same for the default
    trial and retiring a version.
  - **A billing notice link (fixed).** Billing emails linked to `/c/<slug>/settings/billing`, which
    does not exist; they now link to `/c/<slug>/billing`.
  - **Mutation checks:** 12 guards (the counter's limit, the seat checks in the service and in SQL,
    the module filter, the dispatch and store-event quota, reactivation, the notice claim, the
    order-message module check, the team limit, the restriction trigger, published immutability):
    each removed alone fails a test. The notice claim survived at first (the listing already skips
    announced counters); it is now a function the test calls twice.

### Test commands and results (local, 2026-09-28, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm test` (unit)                                                          | 239 passed. New: `plans/model.test.ts` 5 (usage periods on the anchor day, short months and leap years, contiguous periods; module write permissions; which plan states restrict)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 296 passed, including the new `plans.test.ts` 12 (catalog immutability and owner-only changes, default trial and complimentary companies, assignment with both audit logs and version conflicts, add-on checks, restriction and plan-aware reactivation, the sweep through trial end, grace and expiry with one notice each, seat races at acceptance and invitation, teams and live automations with downgrades, numbers, the run quota from customer messages with run packs and uncounted test runs, twelve concurrent starts counting five, modules, isolation) and 2 new in `stores.test.ts` (order messages skipped without commerce; store-event starts skipped beyond the month's runs or without automations). The tenant-isolation suite covers the two new tables and checks the new functions' grants |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 58 passed (29 × 2) in one full run (9.8 min). New `plans.spec.ts` on both projects: a platform owner with two-factor publishes a plan and puts a company on it; the company's Billing page, seat hint, automation notice and Modules column; ending the plan restricts the company                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Mutation checks                                                             | 12 guards broken one at a time; each makes a test fail (one only after the test change above)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Known gaps

- Not built: paying for plans in HyFib (Razorpay Subscriptions), self-serve plan changes and trials
  of higher plans, proration, plan invoices and receipts, usage alerts before a limit is reached,
  emails to companies when staff change their plan, API quotas (P5-08) and AI credits (Phase 6).
- The number limit is checked when a number finishes connecting, after Meta's signup; the channels
  page shows the limit before the signup starts.
- Firefox and WebKit run in CI only; plans are checked against the stand-ins only (no provider is
  involved).

## 2026-09-28 — Phase 4: store events in automations (P4-06e)

Status: **Store events in automations implemented and locally verified; production blocked on
checks with a Shopify development store (and a WooCommerce test site), approved templates on a
sandbox number and a test recipient, and on the Shopify app approvals of P4-06b.** A store's rule
for an order event can start a published automation instead of sending its template, and every
automation can send approved templates, including questions answered with the template's quick
replies, outside the customer service window. Every Phase 4 slice in the backlog (P4-01 to P4-06e)
is now built; their remaining work, the store follow-ups not built (P4-06f) and the Phase 4 gate's
checks with real providers (release checklist) stay open. No request
reached Shopify or Meta: both were the test-only stand-ins in `tests/support/`, and the customer's
taps were webhooks signed by the tests.

### Completed

- **Design (ADR-050):** the rule for a store and event says what happens: send its template, as
  before, or start a chosen automation whose trigger is "An order event in a store" (`store_event`),
  which never matches a customer message. Every guarantee of ADR-048 stays: one store message per
  order and event, nothing about the past, test orders and late events recorded without sending, the
  delay and the sending hours. Order placed, shipped, delivered (Shopify) and cancelled can start
  automations; the cash on delivery confirmation and the cart reminders keep their templates.
- **Schema (migration 0022):** runs gain the order they are about (a composite foreign key, set null
  when the order is deleted) and the event, and the `store_event` trigger type, with a check that
  only store-event and test runs carry an order; `app.guard_automation_run` keeps the event fixed
  and lets the order reference only be cleared. Rules gain `action` and `automation_id` (a composite
  foreign key; only the four order events may start automations; an enabled rule needs its template
  or its automation). Store messages gain the `started` state and the run they started (set null
  when retention deletes the run; unique). Column grants for the two rule columns and the store
  message's run.
- **Starting a run (`stores/order-automations.ts`):** at the store message's send time, under its
  row lock, the order message checks run first; then the automation (active, its live version starts
  from order events and allows the rule's number), the number (active, not suppressed), consent, the
  conversation (created resolved like a template's; not assigned, no active run) and fewer than 10
  runs in it in the last hour. The run, its first step log line and the store message's `started`
  state are written in one transaction, so a repeated job or the sweep starts nothing more.
- **Template steps:** "Send a template" and "Ask with a template" (a branch per quick-reply button,
  one for any other reply, one for no reply within the timeout). Variables are texts with
  placeholders; each quick reply carries the bot button id (run, step, visit and position, now 0 to 9) as its payload, so a tap answers only the step and visit that sent it. When a step runs, the
  runner checks again the template (approved, utility or marketing, the variables and quick replies
  the step expects), the number (active, of the template's account), the contact (not erased, a
  number), a value for every variable, consent for the template's category and, for marketing, the
  company's frequency cap under the campaign runner's company lock, which the runner only tries (it
  holds the conversation's lock; a busy lock retries the step two seconds later).
- **Checks in the builder:** in store-event automations, a message or question that a path reaches
  before the customer's reply is refused (templates only until then) and a hand-off there warns;
  order fields (`{{order.number}}` and eight more) are allowed only in store-event automations;
  template steps are checked against the company's synced templates; the warning after a wait or a
  question timeout over 23 hours now appears only when a message that is not a template can follow.
  Publishing or testing with a marketing template needs `campaigns.send`.
- **Runs in closed conversations:** a store-event run continues while its conversation stays
  resolved as it was at the start; the customer's reply reopens it and reaches the run; a
  conversation resolved again later stops the run.
- **Order data:** each step reads the order as it is now (`stores/order-values.ts`); a deleted or
  redacted order gives no values and a template variable left empty fails the step without sending.
- **Pages:** the trigger and both template steps in the builder (template choice, variables, a
  branch per quick reply, the timeout, the order fields listed), the simulator with a sample order
  and tappable quick replies, a test with a chosen order, "Order messages that start it" on the
  automation page, the order on the run page; the rule form's "What happens" choice and automation,
  and "Automation started" with a link to the run in the store's report and on the order page.
- **Docs:** ADR-050, ARCHITECTURE §6E and §6M, SECURITY (the store automation controls, Phase 4
  rules), THREAT-MODEL T60 to T63, DATA-RETENTION, RUNBOOKS §10L, RELEASE-CHECKLIST, FEATURE-MATRIX
  (W-076, W-084, W-116, W-118, H-022, H-029, new H-031), BACKLOG (P4-01 and P4-06e built, P4-06f).
- **Found while building:**
  - **Deadlock (designed out before commit).** The campaign runner holds the company lock while it
    writes conversations, and the automation runner holds a conversation's lock when a template step
    counts the frequency cap, so waiting for the company lock could deadlock. The runner only tries
    it and retries the step shortly.
  - **Tests with an order (fixed before commit).** A test of a store-event automation needed only
    `commerce.read`, but its steps send the customer's details to the tester's conversation. It now
    also needs `contacts.read`, as seeing store orders does, and orders are offered only then.
  - **The long-wait warning (fixed before commit).** It said that every later message of a run
    would fail after a day without the customer, also when only templates follow. It now follows
    the paths after the wait or timeout.
  - **A deleted draft (fixed before commit).** A switched-off rule can name an automation that was
    never published, and deleting that draft failed on the rule's foreign key. The key now clears
    the reference, and a rule that sends its template no longer keeps an automation.
  - **Mutation checks:** 68 guards across the graph checks, the interpreter, the runner, the start,
    the rule checks, the store message service, the automation service and the migration's foreign
    keys were broken one at a time. One survived at first (a quick reply added to the template after
    the step's buttons); a new unit case catches it. With the guards added later (two permission
    checks, four in the long-wait warning, two for the rule's automation reference), all 76 make a
    test fail.

### Test commands and results (local, 2026-09-28, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pnpm test` (unit)                                                          | 234 passed. New: `automations/templates.test.ts` 25 (the trigger, bot button ids up to position 9, template step parsing, order placeholders, sending and asking with templates, taps from another run, step or visit, the reply rule on every path, a hand-off before a reply, order fields, the company's copy of the template, answers saved on button branches, loops, and the warning after a day without the customer)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 282 passed, including `stores.test.ts` 29 (5 new: an order starting its automation, the template sent outside the window with the order's values and bot payloads, a repeated job starting nothing, the customer's tap, a stale tap, a customer message starting nothing, and the report, order page, run and automation pages with their permissions; every reason not to start; every check when a step runs, including the company lock tried and retried, the frequency cap, a template changed at Meta, a conversation resolved later and a deleted order; rule checks, permissions and isolation, a test with a chosen order (refused without `contacts.read`), references cleared by the order's deletion, retention and a deleted draft; a keyword automation following up with a template after the window closed). The tenant-isolation suite passes unchanged (no new tables) |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 56 passed (28 × 2) in one full run (9.5 min) on the final code. New in `stores.spec.ts`, on both projects: an automation started by order events built around an "Ask with a template" step (the reply rule shown until it starts with the template), tried in the simulator with a sample order and a quick-reply tap, and published; the store's "Order placed" rule set to start it; a new order, the template sent through the Graph stand-in with the order's values and a bot payload per quick reply; the customer's signed tap answered with the order's details; and the report's "Automation started" row linking the run, whose page names the order. An earlier full run was stopped after 20 passing tests to rebuild with the last fixes                                                                                                                    |
| Mutation checks                                                             | 76 guards broken one at a time; each makes the unit or integration tests fail (one only after the new unit case above)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### Known gaps

- Not built: messages per shipment or on tracking changes, cash on delivery confirmations and cart
  reminders starting automations, conditions on order fields, changing the order from a run,
  enrolling contacts or segments in a sequence without a customer message or an order event,
  templates with media headers or variable buttons in template steps (P4-06f, P4-01 remaining).
- Verified against the stand-ins only. Approved templates on a sandbox number, the quick-reply taps
  on Android and iOS, a development store's order starting an automation, and Firefox and WebKit
  locally (they run in CI) are release checklist items.

## 2026-09-27 — Phase 4: cart reminders (P4-06d)

Status: **Cart reminders implemented and locally verified; production blocked on checks with a
Shopify development store, an approved marketing template on a sandbox number and a test
recipient, and on the Shopify app approvals of P4-06b (protected customer data including phone).**
A connected Shopify store reminds customers about a checkout they left, with up to two approved
marketing templates a manager chose, only to customers with marketing opt-in: from HyFib's own
records or, when a manager allows customer access, from the WhatsApp consent Shopify records. No
request reached Shopify or Meta: both were the test-only stand-ins in `tests/support/`. Store events
in automations are the next slice (P4-06e).

### Completed

- **Research (`docs/research/store-connectors.md` §4, SH-037 to SH-043):** `abandonedCheckouts` is
  readable with `read_orders` offline (SH-037; whether the staff permission for abandoned checkouts
  also applies to an offline token is unconfirmed), filtered by `updated_at` with no sort by update
  time (SH-038); a checkout has no phone of its own, only the customer and the addresses (SH-039,
  SH-040); Shopify 2026-07 records WhatsApp marketing consent per phone number, readable with
  `read_customers` (SH-041); more access means authorizing again (SH-042); `completedAt` says a
  checkout was completed, and orders cannot be joined to checkouts (SH-043).
- **GraphQL checked:** the checkout query validates with graphql-js against the 2026-07 and 2025-10
  Admin schemas, the query with customers and consent against 2026-07 (it is used only from that
  version), and a deliberately wrong field is refused.
- **Schema (migration 0021, ADR-049):** the checkout read, customer access and store consent on
  stores; `commerce_store_checkouts` (number, name, Shopify's consent, total in minor units, ten
  items, https recovery address, completion, sticky redaction enforced by a constraint), with FORCE
  RLS, composite foreign keys and column grants; store messages about a checkout (unique per
  checkout and event) and the two cart rules with their delay ranges; consent events from a
  `store`, unique per contact, purpose, action and time; `ops.commerce_store_by_connect` and
  `ops.commerce_store_work_due` replaced; `app.erase_contact` replaced to redact checkouts too.
- **Reading and reminders (`cart-reminders.ts`, the store job):** while a cart reminder is on, every
  15 minutes (and at once from "Read the store now"), the checkouts updated since the cursor, paged
  in full over runs of ten pages; the cursor moves to the read's start less two minutes and never
  back, and starts when the first reminder is switched on. Each page is saved (an older copy never
  replaces a newer one), its reminders recorded (a waiting one moves when the customer comes back; a
  sent one never changes) and its consent imported, in one transaction. Read errors stay on the store
  and never fail the order sync; checkouts are deleted 30 days after their last update.
- **Sending:** every order message check again, plus the checkout still open, no order from the
  number since it began, at most three days, the second reminder only after a sent first one (and
  waiting while the first waits), a marketing template, and the company's marketing frequency cap
  under the campaign runner's company lock, now for every store message with a marketing template.
- **Customer access and store consent:** "Allow customer access in Shopify" authorizes the store
  again with `read_customers` (the same checks as connecting); the worker exchanges the code, and the
  new token replaces the old one because Shopify keeps one per store (SH-007): without
  `read_customers` the store keeps working without it, and without the connector's own scopes it
  fails and asks to be connected again. With the store consent setting on (`commerce.manage` and
  `contacts.write`, Shopify 2026-07), `SUBSCRIBED` and `UNSUBSCRIBED` states with their time become
  consent events (source `store`, actor the shop), once, never for a suppressed number, and only while
  the setting is on as each page is saved.
- **Pages:** a Cart reminders card on the store's Order messages page (customer access, the store
  consent setting, read errors, a 30-day report of reminders sent, checkouts recovered after a
  reminder and their value per currency, leaving out failed or unconfirmed reminders), a form per
  reminder (marketing templates only, checkout variables, the delay ranges), the checkout named in
  the report table, a confirmation on "Read the store now", and consent a store recorded labelled on
  the contact page.
- **Docs:** ADR-049, ARCHITECTURE §6L, SECURITY (cart reminder controls and Phase 4 rules),
  THREAT-MODEL T57 to T59 (and the missing status of T54 to T56), DATA-RETENTION, RUNBOOKS §10K,
  DEPLOYMENT (Shopify step 9), RELEASE-CHECKLIST, FEATURE-MATRIX (W-116, W-118, H-022, H-030),
  BACKLOG (P4-06d built, P4-06e).
- **Found while building:**
  - **Customer access exchange (fixed before commit).** The first version kept the old token when
    Shopify granted fewer scopes than the store connector needs. Shopify keeps one current token per
    store (SH-007), so the exchange had already retired the old one and the store would have failed
    later with a misleading message. The new token is now stored, and the store fails at once with a
    request to connect it again.
  - **Consent setting turned off during a read (fixed before commit).** The import checked the
    setting as the job loaded it, so consent read after a manager turned it off was still recorded.
    Each page now reads the setting again under a share lock.
  - **"Read the store now"** did not read checkouts until the next 15-minute read; it now makes that
    read due too, and says the store will be read in a moment.
  - **Report:** reminders WhatsApp failed or never confirmed counted as sent (and could make a
    checkout "recovered"); they are left out.
  - **Mutation checks:** 52 guards were broken one at a time. 16 survived at first, each for want of
    a test: an older copy from Shopify, a sent reminder when the customer comes back, the setting
    turned off during a read, suppressed numbers in the consent import, reads without the setting,
    a checkout left inside the clock margin, a grant without the connector's scopes, an exchange
    racing a credential change, reads after the opt-in was withdrawn, an older order from the same
    number, a template recategorised at Meta, the API version and `contacts.write` for the setting,
    a checkout completed just before its reminder, customer access for a store that is not
    connected, and `customers/redact` by customer id. New checks now make all 52 fail.
  - **e2e:** the first run reloaded the store page while the browser was still navigating to the
    Order messages page; the test now waits for the page before polling.

### Test commands and results (local, 2026-09-27, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm test` (unit)                                                          | 209 passed. New: 6 cart reminder tests (which checkouts call for reminders, delay ranges apart from the order messages, checkout values and variables of the other subject refused, the store's consent states, the checkout parser's number and consent)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 277 passed, including `stores.test.ts` 24 (4 new: reminders recorded, moved while waiting and unchanged once sent, an older copy from Shopify, the clock margin, completed checkouts and orders from the number (and an older order that is not), "Read the store now", the recovery report without failed reminders; the second reminder, marketing opt-in, three days, the frequency cap and a template recategorised at Meta; customer access requested, refused, granted without the connector's scopes and exchanged while credentials changed, the store's consent imported once, never for suppressed numbers and not after the setting was turned off, reads without the setting, the API version and `contacts.write`, `customers/redact` by customer id; read errors kept on the store, erasure, pruning, paging past one run, the opt-in withdrawn, a store that is not connected, WooCommerce, permissions and isolation). The tenant-isolation suite covers the new table |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 54 passed (27 × 2) in one full run (9.4 min) on the final code. New in `stores.spec.ts`, on both projects: customer access approved in Shopify (the stand-in approves at once) and exchanged by the worker, the store consent setting saved, the first cart reminder set up with a marketing template and checkout variables, a checkout with Shopify's subscribed consent read after "Read the store now", the waiting reminder brought forward in the database and sent by the minute sweep through the Graph stand-in with the customer's name, the items and the recovery address, the opt-in "Recorded by the store" on the contact page, and the checkout counted as recovered with its total. The first run of the new test failed on its own page navigation (see above); earlier the new test passed on both projects on its own                                                                                                                               |
| GraphQL check (graphql-js, the Admin introspection schemas)                 | all ten operations validate against 2026-07; the checkout query without customers also against 2025-10 (the query with customers and consent exists from 2026-07 only, and is used only then); deliberately wrong checkout and consent fields are refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Mutation checks                                                             | 52 guards broken one at a time; each makes the unit or integration tests fail (16 only after the new checks above)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Known gaps

- Not built: store events as automation triggers (P4-06e), WooCommerce carts (no API, WC-023),
  checkout webhooks, discount codes, writing consent back to Shopify, revenue attribution.
- Verified against the stand-ins only. Reading checkouts with a real offline token (the staff
  permission, SH-037), customer access on an installed store (SH-042), Shopify's consent at a real
  checkout (SH-041), an approved marketing template on a sandbox number, and Firefox and WebKit
  locally (they run in CI) are release checklist items.
- The e2e test brings a waiting reminder's send time forward in the database (the shortest wait is
  30 minutes); the waiting itself is covered by the integration tests with a fixed clock.

## 2026-09-27 — Phase 4: order messages (P4-06c)

Status: **Order messages implemented and locally verified; production blocked on checks with a
Shopify development store (and a WooCommerce test site), an approved sandbox number, approved
utility templates and a test recipient, and on the Shopify app approvals of P4-06b.** A connected
store sends the approved WhatsApp template a manager chose when an order is placed, paid for on
delivery, shipped, delivered (Shopify) or cancelled, and the customer's cash on delivery answer
shows on the order. No request reached Shopify, a WooCommerce site or Meta: all three were the
test-only stand-ins in `tests/support/`, and the customer's taps were webhooks signed by the tests.
Abandoned carts and store events in automations are the next slice (P4-06d).

### Completed

- **Research (`docs/research/store-connectors.md` §3, SH-030 to SH-036 and WC-021 to WC-023;
  `docs/research/meta-whatsapp.md` §16, M-175 to M-178):** Shopify shipments, tracking and payment
  gateway names are readable with `read_orders`, while the fulfillment topics need
  `read_fulfillments`; whether a delivery changes an order or sends `orders/updated` is unconfirmed
  (SH-034); abandoned checkouts carry no phone of their own (SH-035); WooCommerce's core cash on
  delivery gateway id is `cod`, orders carry `date_completed_gmt`, and there is no delivered status
  and no cart API. From Meta: opt-in before business-initiated messages (M-175), order and shipment
  confirmations as utility and cart reminders as marketing examples (M-176), quick-reply payloads
  in template sends (M-177) and taps arriving as `button` messages with `context.id` (M-178, the
  official OpenAPI description; the policy pages were seen as search results only).
- **GraphQL checked again:** the order query with `paymentGatewayNames` and
  `fulfillments(first: 10) { … trackingInfo(first: 1) … }` validates with graphql-js against the
  2026-07 and 2025-10 Admin schemas, and the same check refuses a deliberately wrong field.
- **Schema (migration 0020, ADR-048):** order milestones on store orders (payment names, cash on
  delivery, shipped, delivered, tracking, last delivery check; a check constraint keeps tracking
  numbers and addresses off redacted orders), message settings on stores (the opt-in confirmation
  and its member, sending hours, test orders), rules unique per store and event, store messages
  unique per order and event with state and answer shape checks, composite foreign keys, FORCE RLS
  and column grants; `ops.commerce_store_messages_due` (definer, active companies only); contacts
  may come from a `store`; `app.erase_contact` replaced to erase tracking too.
- **Events and timing (`messages-model.ts`, `order-messages.ts`):** each read of the store copy
  compares every order's milestones before and after, in the read's own transaction, and records at
  most one message per order and event from the second a rule was switched on; test orders, events
  first seen over 48 hours late and the plain confirmation of a cash on delivery order are recorded
  as skipped; a message is due at the event plus the rule's delay, never before now, moved into the
  sending hours in the company's time zone; one `commerce.store-message` job per message and the
  minute sweep for lost jobs; Shopify orders in transit read again every three hours for 14 days
  while the delivered message is on.
- **Sending (`commerce.store-message` worker):** every check again under the message's row lock
  (store connected, opt-in, rule on since before the event, sending hours, the order present, not
  erased and not cancelled, a number, the template approved and sendable, the number active on the
  template's account, the cash on delivery buttons, variables, suppression before any contact is
  created, erasure, opt-out and marketing opt-in), then the contact (source `store`), a conversation
  (a new one starts resolved), a system message naming the store and event, and a send intent
  through the existing pipeline; template sends now set quick-reply payloads (`buildTemplateSend`).
- **Cash on delivery answers (ingest):** a tap on the message's own confirm or cancel button, in its
  conversation and replying to it, is kept as the answer (the newest tap wins); it is not a consent
  keyword, a campaign reply or an automation trigger; a confirmation stays quiet and a cancellation
  reopens the conversation for the team.
- **Pages (`commerce.read`; changes need `commerce.manage`; marketing templates also
  `campaigns.send`):** a store's Order messages page (the opt-in confirmation, sending hours, Shopify
  test orders, one form per event with the template, number, variables, buttons and delay, and a
  report of the last 50 messages with statuses, reasons and answers); the order page shows payment
  and shipping and its WhatsApp messages (with `contacts.read`); the inbox names the store and
  event on system messages; segments can pick contacts that came from a store order. Settings and
  rule changes are audited, and rules carry edit versions.
- **Docs:** ADR-048, ARCHITECTURE §6K, SECURITY (order message controls and Phase 4 rules),
  THREAT-MODEL T54 to T56, DATA-RETENTION, RUNBOOKS §10J, DEPLOYMENT (Shopify step 8),
  RELEASE-CHECKLIST, BACKLOG (P4-06c built, P4-06d).
- **Found while building:**
  - Drizzle's `for('update', { of })` qualified the table name, which PostgreSQL refuses ("FOR
    UPDATE must specify unqualified relation names"); the answer path now locks the store message
    row alone and reads its message separately.
  - Store timestamps are whole seconds, so a rule switched on at 10:00:00.700 would have ignored an
    order placed at 10:00:00; a rule now starts at its whole second.
  - Mutation checks: of 30 deliberate regressions (the rule start, the cash on delivery message
    replacing the confirmation, lateness, test orders, shipped and cancelled once, one message per
    order and event, a re-enabled rule, sending hours at send time, cancelled orders, suppression
    before a contact exists, consent at send time, erased customers, the button payloads, the
    answer's conversation and reply, older taps, taps as keywords, quiet confirmations, the transit
    interval, a rule's start kept on edit, the opt-in requirement and its withdrawal, tracking kept
    off erased orders, failed shipments, cash on delivery names, approved templates, active numbers,
    quick-reply buttons, delivered for WooCommerce), four survived at first: the answer's
    conversation (a separate contact check refused the same taps; the two are now one check), one
    message per order and event (no test produced the same event twice), tracking after erasure
    (no test read the order again) and failed shipments (no fixture had one before a real
    shipment). New checks (a WooCommerce order completed, reopened and completed again; erasure
    without suppression followed by a read from a store that still has the tracking; cancelled and
    failed shipments in the Shopify fixtures) now make all 30 fail.

### Test commands and results (local, 2026-09-27, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm test` (unit)                                                          | 203 passed. New: 14 order message tests (events before and after a rule starts, the cash on delivery message replacing the confirmation, shipped, delivered and cancelled once, lateness and test orders, the delay and sending hours in Asia/Kolkata, order values and variables with fallbacks, button payloads on quick-reply buttons, Shopify shipments, WooCommerce milestones, cash on delivery names)                                                                                                                                                                                                                                                                                                                                                                                                          |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 273 passed, including `stores.test.ts` 20 (7 new: Shopify orders placed, shipped, delivered by the transit re-read and cancelled, and the contact made from an order found by a segment; cash on delivery taps and taps from another customer or replying to another message; the past, test orders, late events, opt-outs, suppression, missing numbers and erasure; sending hours, rules switched off and on, templates, numbers and the opt-in changed before sending; every check again at send time and a rule's start kept on edit; WooCommerce completion, cancellation, cash on delivery by gateway and no delivered message; permissions, audit, edit conflicts and isolation). The tenant-isolation suite covers the two new tables, and `ops.commerce_store_messages_due` is on its app-only function list |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 52 passed (26 × 2) in each of two full runs (7.4 and 6.9 min), the second after the last code change. New in `stores.spec.ts`, on both projects: a rule refused before the opt-in, the opt-in confirmed and the cash on delivery rule saved on the Order messages page, a new order paid on delivery signalled by a signed `orders/create` delivery, the template sent through the Graph stand-in with the order's values and both button payloads, the report, the customer's signed tap, and "Customer asked to cancel" on the order page                                                                                                                                                                                                                                                            |
| GraphQL check (graphql-js, the Admin introspection schemas)                 | the order query with shipments and payment gateways validates against 2026-07 and 2025-10; a deliberately wrong field is refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Known gaps

- Not built: abandoned carts and store events as automation triggers (P4-06d), messages per
  shipment or on tracking changes, discount codes, store customers, recovered-revenue reports,
  WooCommerce deliveries (WooCommerce reports none).
- Verified against the stand-ins only. Real templates on a sandbox number, the taps on Android and
  iOS, Shopify's delivery timing (SH-034) and Firefox and WebKit locally (they run in CI) are
  release checklist items.
- The opt-in is the company's own confirmation: HyFib cannot see what a store's checkout asked
  (M-175). A cash on delivery answer is recorded for the team; HyFib does not change the order in the
  store (its Shopify scopes are read-only).

## 2026-09-27 — Phase 4: store connectors (P4-06b)

Status: **Store connectors implemented and locally verified; production blocked on HyFib's Shopify
app (public distribution review, protected customer data approval) and checks on a Shopify
development store and a WooCommerce test site.** Companies connect their Shopify and WooCommerce
stores; HyFib reads orders and products into a copy it keeps in step and shows a customer's store
orders next to their conversation. No request reached Shopify or a WooCommerce site: both were the
test-only stand-ins in `tests/support/`, which answer and sign the way the research describes.
Messages on store events (order confirmations, shipping updates) are the next slice (P4-06c).

### Completed

- **Research (`docs/research/store-connectors.md`, SH-001 to SH-029 and WC-001 to WC-020):**
  Shopify's authorization code grant, callback HMAC, expiring offline tokens, the Admin GraphQL API
  (cost-based throttling, the 60-day order limit, protected customer data), subscriptions with
  `includeFields`, delivery headers, the compliance topics and uninstall, read from the 2026-07
  Admin schema bundled in Shopify's dev MCP package and from the source of Shopify's official
  libraries; WooCommerce's key approval and handover, REST v3 and webhooks (signature, creation
  ping, delivery ids, disabling after failures), read from the plugin source and the source of its
  official REST documentation. shopify.dev pages were seen only as search summaries: the token
  lifetimes, retry schedule, `shop/redact` timing and compliance deadlines are listed as
  unconfirmed and are release checklist items.
- **GraphQL checked against Shopify's schemas:** the eight named operations HyFib sends (shop,
  orders, orders by id, products, products by id, subscriptions, subscription create, uninstall)
  validate with graphql-js against the 2026-07 and 2025-10 Admin introspection schemas, and the
  variables (the subscription input for all seven topics with `includeFields`, the order search and
  node ids) are valid for their types. Re-run at the end of the slice.
- **Schema (migration 0019, ADR-047):** stores (state machine, sealed and versioned access, the
  handshake, webhook address and secret, cursors, lease), store orders with items, products,
  signalled fetches, delivery ids and Shopify privacy requests, all cascading from the store, with
  composite foreign keys, FORCE RLS and column grants; four definer functions for the callbacks,
  webhooks and the sweep; `app.erase_contact` replaced to redact store orders.
- **Clients and worker (`commerce.store`):** the Shopify code exchange and refresh (tokens stored
  only if the access was not changed meanwhile), Admin GraphQL with throttling and withheld
  customer data, subscriptions and `appUninstall`; WooCommerce REST with Basic authentication over
  https, webhooks created, re-enabled and deleted; one job per store under a lease, reading
  signalled items and what changed since the cursor (whole seconds, page tokens within a second),
  60 days of orders and up to 20,000 products at first, hourly reads, six-hourly webhook checks,
  the next job queued in the transaction that ends a run, removal with a 30-minute deadline.
- **Webhooks and handshakes:** `/api/webhooks/shopify` and `/api/webhooks/woocommerce/<address id>`
  verify, deduplicate and only signal reads or mark deletions; Shopify's uninstall and compliance
  topics act on the shop named in the signed body; `/api/stores/shopify/callback` needs the signed
  query and the member who started the handshake; `/api/stores/woocommerce/callback` takes the key
  handover for a waiting handshake only.
- **Pages (`commerce.read`; orders and products also need `contacts.read`; managing needs
  `commerce.manage`):** Commerce → Stores (stores, both connect forms, REST keys as a fallback), a
  store page (status, errors, facts, read now, connect again, remove, privacy requests, the calling
  code, a note while the first read runs), orders with search, an order page with the matching
  contact, products; a "Store orders" panel next to conversations.
- **Configuration and CI:** `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` (and `_PREVIOUS`),
  `SHOPIFY_API_VERSION`, `SHOPIFY_TEST_BASE_URL` (local and test only); the Playwright global setup
  starts both stand-ins (`E2E_SHOPIFY_PORT`, `E2E_WOO_PORT`), and the CI e2e job sets them with an
  ephemeral client secret.
- **Found while building:**
  - A signal repeated in the same millisecond as the one being read, or from a web instance whose
    clock lags, would have been deleted with it; every repeat now moves the signal's time forward.
  - The store page said nothing between "Connected" and the end of the first read (the e2e test
    first failed there); it now says the first read is running.
  - Mutation checks: of 20 deliberate regressions (the stale-copy guards for orders and products,
    sticky redaction of details and of the redaction time, delivery dedupe, the three signature
    checks, the uninstall body check, the page token within a second, queueing the next job, the
    credentials version on refresh, the signal time check and its advance, `shop/redact` on
    installed stores, handshake expiry, unsigned bodies taken as pings, the approving member,
    Read/Write keys, the product limit), eight of the first 19 survived the suite and the product
    limit had no test. New tests (a signal during a read with equal clocks through a stand-in hook,
    a refresh racing a credential change, the next job queued, redaction kept over two reads, a
    products stale copy, late approvals, an unsigned delivery, the product limit) now make all 20
    fail.

### Test commands and results (local, 2026-09-27, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm test` (unit)                                                          | 189 passed. New: 14 store model tests (shop and site addresses, the authorize addresses, token shapes, Shopify callback and webhook signatures with an independent signer, WooCommerce signatures, amounts to minor units, customer numbers, dates, the four record parsers, HTTP error mapping, throttle waits) and 3 Shopify configuration tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 266 passed, including `stores.test.ts` 13: Shopify connect, first read and contact link; forged, stale and replayed callbacks, another member, another company and an agent; signed webhooks, repeats, forgeries, stale copies and deletions; 130 orders in one second, lost subscriptions, token refresh, throttling and a refused refresh; a signal during a read; a refresh racing a credential change; withheld customer data; uninstall, customer redaction kept over two reads, data requests, shop redaction and removal; WooCommerce key handover, webhooks, pings, unsigned and forged deliveries, a disabled webhook re-enabled and revoked keys; read-only and foreign keys; erasure and isolation; late approvals and expired handshakes; the product limit. The tenant-isolation suite covers the seven new tables |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 50 tests (25 × 2): 49 passed in one full run. The one failure (`flows.spec.ts`, the data endpoint, on Chromium) came from this container losing its hosts entry for the local test host (the endpoint call ended `egress_failed`); with the entry restored it passed, as it had on mobile Chromium in the same run. `stores.spec.ts`, both platforms: approval in the store's admin (the stand-ins approve at once), the first read, orders and products, the panel next to the customer's chat, a webhook-driven update and removal; it also passed in two earlier separate runs per project                                                                                                                                                                                                                    |

### Known gaps

- Not built: messages on store events (P4-06c: order confirmation, shipping updates, cash on
  delivery, abandoned carts), store customers, discount codes, writing to stores, other platforms.
- Verified against the stand-ins only. HyFib's Shopify app (public distribution, protected customer
  data), a development store, a WooCommerce test site, the unconfirmed Shopify timings and Firefox
  and WebKit locally (they run in CI) are release checklist items.
- Keyring rotation of existing ciphertexts, now including store access, needs the re-encryption job
  (SEC-10). WooCommerce keys can be revoked only by the store's owner.

## 2026-09-27 — Phase 4: commerce on WhatsApp (P4-06a)

Status: **Commerce on WhatsApp implemented and locally verified; production blocked on checks with an
approved sandbox number, a connected catalog and a company's Razorpay test keys.** Companies read
the catalogs connected to their WhatsApp accounts, send products in conversations, receive the
orders customers send from their cart, and ask for payment with Payment Links from their own
Razorpay account. No request reached Meta or Razorpay: both were the local stand-ins, and webhooks
were signed by the tests the way Meta and Razorpay do. Store connectors (Shopify, WooCommerce) are
the next slice (P4-06b).

### Completed

- **Research (M-169 to M-174, R-106 to R-109):** product, multi-product and catalog messages, the
  order webhook, product enquiries, the catalog edges and product fields (official OpenAPI
  description and Meta's Python SDK, high confidence); which permission reading catalogs needs
  (M-173, low to medium confidence: partner documentation); payments inside WhatsApp (M-174, not
  used). Payment Links: single-use reference ids, finding a link by reference (the list's response
  envelope unconfirmed, R-107), the webhook payload and cancelling (Razorpay's documentation and
  Node SDK).
- **Schema (migration 0018, ADR-046):** catalog reads, catalogs, products, orders and items, the
  company's Razorpay account (keyring-encrypted secrets), written-ahead Payment Links and webhook
  event ids, with composite foreign keys, FORCE RLS and column grants; definer functions
  `ops.commerce_payment_webhook_target` and `ops.commerce_work_due`; `app.erase_contact` replaced to
  clear order notes and cancel open links.
- **Worker (`commerce.sync`, `commerce.link`, `commerce.account`):** catalogs and products read from
  Meta (up to 10 catalogs and 5,000 products each, removed products and disconnected catalogs
  marked after complete reads only, a daily re-read, Meta's permission refusals explained); each
  Payment Link created once with a single-use reference (after a lost response it is looked up,
  never created again), cancelled on request, fetched every 15 minutes on its first day and every
  six hours after that, and at once on a signed notification; a payment recorded only when Razorpay
  reports the link paid in full; the link sent in the chat while the service window is open; the
  company's keys checked. Locks follow the conversation → order → link order used by replies and
  erasure.
- **Orders and the merchant webhook:** orders captured from the Meta webhook in the message's
  transaction, with prices converted to minor units exactly and product names from HyFib's catalog
  copy; `/api/webhooks/razorpay-links/<address id>` verifies the company's own secret, records the
  event id and only signals a fetch.
- **Pages (`commerce.read`; catalog reads and keys need `commerce.manage`; sending, statuses and
  payment requests are replies):** Commerce → Orders with status filters and paging, an order page
  (items, total, note, status buttons, Payment Links with their address and not-sent reason, request
  and cancel), Catalogs with the read state and "Read from Meta", products with search, and Payments
  (write-only keys, the webhook address and events). The inbox has a "Send products" card (one
  product, several products or the whole catalog), an Orders panel, and message bubbles for orders,
  product messages and payment requests. The Commerce module is now listed as available.
- **Found while building:**
  - Correlated count subqueries in single-table selects bound to the subquery's own columns
    (drizzle drops table names there), so Settings → Pipelines always showed 0 open deals per stage.
    A new `outerColumn()` helper names the outer column; the CRM test now checks the counts, and the
    platform rate card list (which happened to work) uses it too.
  - Payment Link work locked the link before the order, the opposite of erasure and the order pages;
    the worker now locks conversation, order, then link.
  - A check that found the link busy was dropped, so a payment notified during a scheduled check
    waited up to 15 minutes; it is now retried.
  - Why a link was not sent in the chat was overwritten by the next check; it is now kept in its own
    column (`send_error`).
  - The order page's "creating" and "cancelling" notes lived in buttons that disappear once the link
    exists, so they vanished; they are now shown on the link itself.
  - Mutation checks: of 15 deliberate regressions (signature, paid status, float prices, order
    visibility in the list and the page, erasure of notes and links, unchecked keys, the service
    window, deduplication, live keys, lookup and recovery after a lost response, the busy lease, the
    not-sent reason), one survived (the lookup before creating again was covered only by the
    duplicate-reference recovery); a test now requires a single create request, and all 15 fail the
    tests.

### Review fixes (Codex on PR #8)

- **A cart with an unreadable item kept a total** (P1): the total of the items HyFib could read was
  shown as the cart's, and payment could be requested for less than the customer ordered. Such an
  order now has no total (`dropped_items` says how many items were left out; the order page and the
  chat say so) and payment cannot be requested.
- **Order pages skipped orders received in the same second:** the list's cursor now carries the time
  and the id, matching its order.
- **Key checks could apply to newer keys:** a check, or a rejection seen while creating a link, now
  records its result only for the version of the keys it used.
- **Totals above HyFib's cap on one Payment Link (₹50 crore)** now get a clear refusal instead of a
  database error, and the order page says why.
- **A link Razorpay returned without an https address** was kept open with nothing to send or copy;
  it now carries the reason, with a way to cancel it and ask again.
- Each fix has a test that fails without it (six deliberate reversions checked).

### Test commands and results (local, 2026-09-27, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm test` (unit)                                                          | 172 passed. New: 13 commerce model tests (webhook prices to minor units, order parsing with dropped items, limits, unknown totals and notes; product, list and catalog message shapes and limits; member order transitions; references; the payment message) and 4 Payment Link client tests (create request without partial payments or Razorpay notifications, response checks, lookup by reference in either list shape, cancel refusal)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 253 passed, including `commerce.test.ts` 7: catalogs read with paging, removals, Meta's permission refusal and disconnection, the daily re-read; product messages (single, list, catalog) in the window with refusals; orders with exact amounts, redelivery, unknown totals, member statuses, stale versions, visibility by assignment and payment preconditions; Payment Links end to end (keys checked, test keys only, a lost create response looked up with a single create request, the chat message, a busy lease retried, forged, foreign and duplicate notifications, payment only from Razorpay, cancel, cancel racing payment, expiry with the not-sent reason kept, revoked keys); a cart with an unreadable item, the Payment Link cap, orders paged within one second, key checks and rejections racing new keys, a link without an address; erasure and isolation. Also the CRM open-deal counts and the platform rate card list |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 46 passed (23 tests × 2), including `commerce.spec.ts`: a catalog read from Meta through the worker and searched, one product and a product list sent from a conversation (the requests WhatsApp received checked), a signed order webhook shown in the chat with its exact total, the order confirmed, the company's test keys saved and checked, payment requested (the link created once and sent in the chat), a forged notification refused, the payment recorded only after the link was paid at Razorpay and a signed notification arrived (a redelivery ignored), and the order fulfilled. After the last small page changes, `commerce.spec.ts` passed again on both projects; earlier it also passed 3 times in a row per project. After the review fixes below, `commerce.spec.ts` and `inbox.spec.ts` passed on both projects                                                                                        |

### Known gaps

- Not built: store connectors (P4-06b), product enquiries (`referred_product`), payments inside
  WhatsApp (`order_details`), writing to catalogs and stock, refunds from HyFib, order reports and
  exports, sending products from automations.
- Verified against the Graph and Razorpay stand-ins only. The catalog permission (M-173), the price
  text format (M-172), the list envelope for finding a link by reference (R-107) and Firefox and
  WebKit locally (they run in CI) are release checklist items.
- Keyring rotation of existing ciphertexts, now including companies' Razorpay secrets, needs the
  re-encryption job (SEC-10).

## 2026-09-27 — Phase 4: WhatsApp Flows (P4-03)

Status: **WhatsApp Flows implemented and locally verified; production blocked on checks with an
approved sandbox number and a real account's keys.** Companies write forms as Flow JSON, send them
to Meta as drafts, publish them, send them in conversations and save the answers on the contact.
Forms that fetch data use HyFib's encrypted endpoint, which forwards requests to the company's own
endpoint. No request reached Meta and no WhatsApp client opened a form: Meta was the local Graph
stand-in, and endpoint requests were encrypted and signed by the tests the way WhatsApp does.

### Completed

- **Research (M-161 to M-168):** flow creation, JSON upload with validation errors, publish,
  deprecate, delete and read (official OpenAPI description, high confidence); the business public
  key per phone number (M-164); the flow message (M-165); the completion webhook `nfm_reply`
  (M-166, medium confidence: third-party sources); endpoint status codes and encryption (Meta's
  sample endpoint, M-167); `flow_token_signature` (M-168, low confidence, not used). M-163 now also
  records the `health_status` fields (with M-107).
- **Schema (migration 0017, ADR-045):** `flows`, `flow_keys`, `flow_key_uploads`, `flow_sends` and
  `flow_responses`, with composite foreign keys, FORCE RLS and column grants; definer functions
  `ops.flow_endpoint_target` (the endpoint's lookup by public id) and `ops.flow_work_due` (the
  sweep); `app.erase_contact` replaced to delete answers and end tokens.
- **Worker (`flow.sync`, `flow.keys`):** every operation at Meta is written ahead on the flow row and
  performed once; a lost create response is recovered by adopting the flow whose name carries the
  flow's reference; publish, deprecate and delete read Meta's status first; operations waiting over
  two minutes are signalled again and those over 30 minutes fail with a message. Keys: one RSA-2048
  key per WhatsApp account, uploaded to every active number and read back, replaced with a 24-hour
  overlap, private keys deleted when retired.
- **Endpoint (`/api/flows/endpoint/<public id>`):** signature (432), decryption with the current or
  previous key (421), health checks and error notices answered by HyFib, HyFib's flow tokens only
  (427 with a message), suspended companies refused, forwarding through the egress guard to the
  company's endpoint on an allowed domain with its secret only for that host, the company's own 427
  passed on, and codes-only logging.
- **Pages (`flows.read`; drafts and settings need `flows.write`, publishing and key replacement
  `flows.publish`):** Flows list with archived view, New flow with the example form and live checks,
  and a flow page with status, Meta's validation errors with line and column, health, preview,
  lifecycle buttons (irreversible actions confirmed), the draft editor or the published JSON,
  answer and endpoint settings, the endpoint address and key state per number, and completed forms.
  The inbox has a "Send a form" card while the window is open, and shows sent and completed forms
  in the thread. The Flows module is now listed as available.
- **Found while building:**
  - Saving an unchanged draft said the changes were being sent to Meta; it now says nothing changed,
    and saving a restored draft (or one whose upload failed) sends it to Meta again. Unchanged saves
    are no longer audited.
  - Operations that ran out of time said Meta did not answer, also when the company had been
    suspended and nothing was sent; the message now names both causes.
  - The published Flow JSON widened the flow page on phones; the page grid now keeps it scrolling
    inside its card.
  - Mutation checks found two untested rules (a secret re-pointed to another domain, a completion by
    someone other than the form's contact); both now have integration tests, and all seven
    deliberate regressions tried (signature, expiry, secret domain, contact match, lost create
    response, draft sending, erasure) fail the tests.
  - PR #7's Firefox e2e run failed with `NS_BINDING_ABORTED` when the automations test left an inbox
    page with `page.goto` while a live refresh was in flight (Next.js answers a cancelled refresh by
    loading the current page again). The test now leaves inbox pages through the app navigation.

### Test commands and results (local, 2026-09-27, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `pnpm test` (unit)                                                          | 155 passed. New: 7 Flows tests (request decryption with the previous key during rotation and the inverted IV in answers; refusals of wrong keys, tampered data and malformed fields; Flow JSON checks on the starter form, errors and data flows; the flow message; health status)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 245 passed, including `flows.test.ts` 7: the lifecycle with permissions, validation errors, one operation at a time, publishing, new drafts, deprecation, deletion, restoring and re-sending a draft, and audit; a lost create response adopted without a second flow, refusals and the 30-minute limit; keys uploaded to every number, a mismatch, rotation and retirement; sending in the window (drafts to testers only), completion with answer outcomes, a completion by another contact, unknown tokens and answer visibility by role; erasure; the endpoint (signature, unknown flow, wrong key, health check, error notice, unknown and expired tokens, forwarding with the secret, the company's 427, failures, a removed domain, a secret moved to another domain, suspension, rotation); isolation |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 44 passed (22 tests × 2), including `flows.spec.ts`: a form created with live checks, sent to Meta, mapped, published after confirmation, sent in a conversation, completed by a signed `nfm_reply` with its answers shown in the chat, the contact renamed and the flow page listing the answers; and a data flow whose key is uploaded, answering an encrypted health check through the route, refusing a bad signature (432) and a token HyFib did not issue (427), and forwarding a data exchange from a test send to a local company endpoint with its secret                                                                                                                                                                                                                             |

### Known gaps

- Not built: a visual form builder, sending flows from automations, campaigns or templates, flows
  that open with `data_exchange`, Meta's flow metrics and `flow_token_signature`.
- Verified against the Graph stand-in only. Whether one key per account is accepted on every
  number, the `nfm_reply` shape (third-party sources) and Meta's wait for the endpoint are release
  checklist items, as are Firefox and WebKit locally (they run in CI).
- Keyring rotation of existing ciphertexts, now including flow private keys, needs the
  re-encryption job (SEC-10).

## 2026-09-27 — Phase 4: growth tools (P4-05)

Status: **Growth tools implemented and locally verified; production blocked on checks with real
devices and a real click-to-WhatsApp test ad.** Companies can share chat links and QR codes that
open WhatsApp with a pre-filled message, see clicks per day and the conversations each link
started, add a WhatsApp button to their website, and see which click-to-WhatsApp ads started
conversations. Nothing about visitors is stored. No message was exchanged with WhatsApp and no ad
traffic was received: the webhooks in the tests are signed test payloads.

### Completed

- **Research (M-160):** a chat link is `https://wa.me/<number>?text=<urlencoded text>`, the number
  in full international form with digits only; the customer still sends the pre-filled message
  themselves. WhatsApp's Help Center page was blocked by this environment's network policy, so the
  row cites it through search results (OFF-DOC-SNIP). The ad referral object is research M-130.
- **Schema (migration 0016, ADR-044):** `chat_links` (number, name, pre-filled message, a reference
  code unique per company, a slug unique across companies, archived, version), `chat_link_clicks`
  (one count per link and company day), `chat_widgets` and `conversation_sources` (one row per
  attributed inbound message: a link, or an ad's id, type, address and headline). Two definer
  functions for the public routes, `ops.follow_chat_link` (counts the click, returns what the
  redirect needs) and `ops.chat_widget_config`, return nothing for archived links, numbers that are
  not active, disabled buttons or companies being deleted. `app.erase_contact` is replaced to delete
  the contact's sources and clear referral objects stored on its messages before 0016.
- **Ingestion:** an inbound message with a `referral` object records the ad (without the ad click
  id, media addresses or ad text; the raw object is no longer stored on the message); otherwise a
  complete "(ref ABC234)" marker records the link with that code, only if the link opens the number
  the message arrived on.
- **Growth pages (`campaigns.read`; changes need `campaigns.write` and are audited):** Chat links
  (clicks and conversations over 30 days, archived links, a form with a preview of the customer's
  message), the link page (short and direct links to copy, QR code as PNG and SVG, clicks per day
  in the company time zone, edit, archive or restore), Website button (script tag, a note for sites
  with a Content Security Policy, forms, badges when a button cannot show) and Ads (ads that started
  conversations in the last 30 days). The inbox says which link or ad a conversation came from.
- **Public routes:** `/l/<slug>` answers 302 to the wa.me address rebuilt from the stored link
  (`no-store`, no referrer, no cookie) or a 404 page; `/widget/<id>.js` serves the button script
  (cross-origin, cacheable for five minutes) or a 404 comment. The script stores nothing, loads
  nothing and sends nothing; it draws text only, in a shadow root with inline styles, and adds one
  button per page.
- **Found while building:**
  - A button whose number was disconnected would still have been drawn on sites and led to "not
    available"; the button lookup now applies the same conditions as the short link, and the
    Website button page says when a button's number is not active.
  - The button first used a closed shadow root, which hides nothing from the host page (it controls
    the page anyway) but kept accessibility tools and tests from reading the button; it now uses an
    open one.
  - Chromium does not let a page on a public origin load a script from a loopback address (Private
    Network Access). This does not affect production, where the app is public; the e2e test serves
    its embedding page from a loopback origin of its own.

### Test commands and results (local, 2026-09-27, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm test` (unit)                                                          | 148 passed. New: 6 growth tests (codes and slugs over their alphabets, the pre-filled text and wa.me format, finding a code in a message, ad referrals without the click id or media addresses, button text colour, and the widget script run against a stub DOM: text only, the short link, one button per page)                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 238 passed, including `growth.test.ts` 8: links with permissions for five roles, validation, versions, archive and audit; clicks per company day and nothing for unknown or malformed slugs, archived links, a number that needs reconnecting or a company being deleted (a suspended company's links still open); limits; attribution on the link's number only (not another number of the company or another company); ad sources without the click id, media addresses or ad text; erasure of sources and legacy referral objects; buttons served only while shown and while their link can open; isolation, including a direct query in another company's scope |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 40 passed (20 tests × 2), including growth: a link created in the UI with its QR code, the short link's 302 to wa.me with `no-store` and `no-referrer`, the click count, the attributed conversation in the inbox, an ad listed under Ads, the button embedded on a page of another origin (it opens the short link; no other request, cookie or storage) and archiving stopping the link and the button. In the full run, 39 passed and the desktop web-request test failed with `dns_failed`: this sandbox had lost its hosts entry for the local test API name. With the entry restored, that test passed on its own.                             |

### Known gaps

- Not built: connecting ad accounts (ad sync, spend, cost per conversation), conversion reporting to
  Meta (W-072), campaign parameters on links, and a free public link generator.
- Verified with signed test webhooks and local browsers only; Firefox and WebKit run in CI only.
  Real devices, a printed QR code and a real click-to-WhatsApp test ad are release checklist items,
  as are edge rate limits for the public routes.

## 2026-09-27 — Phase 4: automation web requests and the egress guard (P4-02)

Status: **HTTP step implemented and locally verified against a local target server; production
blocked.** Automations can call a company's own API and branch on the result. Every call goes
through the new egress guard; calls to a real company API through a production egress path are a
release item. With this slice the "integration idempotency" part of the Phase 4 gate is verified
locally for the HTTP step; commerce (P4-06) is still open.

### Completed

- **Egress guard (`packages/core/src/egress.ts`, ADR-042):** https only, port 443 or 1024+, no URL
  credentials; one DNS resolution with every answer checked against blocked IPv4 and IPv6 ranges
  (private, loopback, link-local, CGNAT, multicast, reserved, documentation, metadata, mapped,
  NAT64, 6to4, unique- and site-local), then a socket pinned to the checked address with the name
  only in SNI and Host; IP literals checked in every notation; no redirects; a fresh connection per
  request; 64 KiB request, 256 KiB response, 10 s; reserved headers and line breaks refused; each
  error says whether the request may have been sent. `W360_EGRESS_ALLOW_LOOPBACK` (http:// and
  loopback test targets) is refused by web and worker configuration outside `APP_ENV=local|test`.
- **Schema (migration 0014):** `http_allowed_domains` (exact names or `*.` wildcards),
  `http_secrets` (encrypted value bound to the row, the one domain it may be sent to, version),
  `automation_http_calls` (one per step visit: method, host, path, the request encrypted until the
  call finishes, state, status or error code, duration, saved values); a trigger keeps a finished
  call final and refuses to queue a call that may have been sent; runs wait for `http` and count
  calls (budget 20, `budget_http`); `ops.automation_http_calls_due` for the sweep; retention and
  contact erasure replaced to clear saved values and cancel calls not yet made.
- **Step and runner (ADR-043):** "Call a web address" (method, address with URL-encoded
  placeholders, up to 10 headers, a JSON body with escaped placeholders, values saved from a JSON
  response by path, success and failure branches) with publish checks (allowed host, no
  placeholders in the host, secrets only in header values and only to their domain, valid JSON).
  The step's transaction writes the call ahead and the run waits up to two minutes; the
  `automation.http` worker claims a queued call, re-checks the current domains and secrets, sends it
  with no locks held and records the outcome, then signals the run. A call is only sent from
  `queued`; one that may have been received without a result is `unknown` at the deadline and never
  repeated; one not made by then (or whose job runs late, for example after a suspension) is
  cancelled. Saved values are kept only for a run that can still use them.
- **Web:** Settings → Web requests (domains; secrets saved write-only for one domain, replaced or
  deleted; a warning about servers that echo headers); the step editor (method, address, headers
  with a ready bearer-token header, body, values to save, both branches); the simulator shows the
  request it would make, sends nothing and lets the tester choose success (with values) or failure;
  run pages list each call with its outcome; the inbox banner says when a run waits for a web
  request; labels for every refusal and egress code.
- **Found while building:**
  - Customer text rendered into a header (a WhatsApp profile name or an answer containing
    `{{secret.x}}`) would have been read as a placeholder by the worker and filled with the secret.
    Header values are now rendered into text and secret parts, so rendered values are never parsed
    again, and customer text is percent-encoded unless it is printable ASCII (a name in another
    script can no longer make the call fail).
  - Anyone who can edit automations could have sent a secret meant for one allowed domain to
    another; secrets are now saved for one domain and the worker refuses a mismatch.
  - The runner read the call without a lock before settling it at the deadline, so a success
    recorded in between would have taken the failure branch; the runner now locks the call.
  - A queued call whose job ran after the run's deadline would have been sent late; it is now
    cancelled.
- **Review fixes (Codex on PR #6):**
  - The call record stored the rendered path, so a customer's value placed in the address outlived
    an erasure; it now keeps the step's path as written (placeholders not filled in).
  - A call left in flight by a worker that died stayed "in progress", with its encrypted request,
    when the run ended before its deadline; ending a run (and erasing its contact, migration 0015)
    now settles such calls as unknown and erases the request.
  - Name resolution now counts against the 10-second deadline, and at most two system lookups run
    at once per worker (they cannot be cancelled), so a slow name cannot hold the thread pool.
  - Every checked address is tried in turn, so one unreachable address (an AAAA record on an
    IPv4-only network, a dead pool member) no longer fails the call.

### Test commands and results (local, 2026-09-27, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm test` (unit)                                                          | 142 passed. New: 13 egress tests (blocked ranges and notations, pinning and Host, fallback to the next checked address, redirects, size and time limits including name resolution, the lookup limit, headers, DNS and connection failures) and HTTP step interpreter tests (rendering, waiting, saved values only on success, customer text never read as a secret, the call budget, publish checks including a secret's domain) |
| `pnpm test:integration` (PostgreSQL 18.x)                                   | 230 passed, including `automation-http.test.ts` 11: a call made once with its secret and values saved, error statuses and refusals by current settings, a crash leaving the call in flight and a late result both ending as unknown, a timeout, cancellation on take-over, at the deadline and for a late job, the lost-job sweep, retention, erasure, settings and isolation                                                    |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 38 passed (19 tests × 2), including web requests: Settings → Web requests, a step built in the editor with a stored secret, tried in the simulator, published, and a live run in which the worker calls a local target once with the secret and answers with the result, and the run page's call list                                                                                                             |

### Known gaps

- Not built: retries a company opts into for idempotent requests, form-encoded bodies, response
  headers or non-JSON bodies as values, OAuth client flows, calls from outgoing webhooks and imports
  (they must use the same guard), a network egress policy in deployment (release checklist).
- Verified only against a local target server; Firefox and WebKit run in CI only.

## 2026-09-27 — Phase 4: CRM (P4-04)

Status: **CRM implemented and locally verified, production blocked on email delivery only.**
Pipelines, deals, tasks, notes, the timeline and the deal reports work on HyFib's own data and send
nothing to Meta. Task reminders are emailed through the outbox; locally they arrive in Mailpit, and
delivery through the production SMTP provider is a release item.

### Completed

- **Schema (migration 0013):** pipelines with one ISO 4217 currency each (no runtime UPDATE grant)
  and ordered stages, both archived instead of deleted; deals (a contact for life, optionally the
  conversation they came from, a value in the currency's minor unit, owner, open/won/lost with a
  lost reason, expected close date, version); tasks (assignee, optionally a contact or one of its
  deals, due and reminder times, reminder state with the reason when skipped); the append-only
  timeline (a trigger refuses edits and deletes except inside contact erasure). Composite foreign
  keys keep references in the company, a deal's stage in its pipeline and a task's or entry's deal
  on the same contact. `ops.crm_reminders_due` (definer, ids of active companies only);
  `app.erase_contact` replaced to delete the contact's timeline, notes and tasks and blank deal
  titles and lost reasons; four metric definitions (deal outcomes v2, win rate, time to win, open
  pipeline).
- **Service:** pipelines (`tenant.settings.manage`, audited, 20 in use at most; removed stages are
  archived only when empty), deals (from a contact or a conversation the member can see; edit,
  move, won/lost/reopen), the board with owner filters and per-stage totals, tasks (mine or
  everyone's, open or closed; done, cancel, reopen, edit), notes, contact and deal timelines, and
  the member's overdue and due-today counts. Every change locks the row, checks its version and
  appends its timeline entry in one transaction. Amounts are parsed exactly (no floats) with the
  currency's ISO decimals.
- **Reminders (queue `crm.reminder`):** a delayed job at the reminder time and the minute sweep for
  lost jobs; the email is queued in the transaction that marks the reminder sent, so it goes out
  once; skipped with a reason when the task closed, the assignee lost CRM access or it is more than
  a day late.
- **Web:** CRM in the navigation (board, won and lost lists, deal page, tasks page),
  Settings → Pipelines, a CRM card on the contact page and next to the conversation in the inbox
  (deals, open tasks, timeline; add a deal, task or note), a "Your tasks" card on the overview,
  and a Deals section with CSV export in Reports. Task times are wall-clock times in the company
  time zone.
- **Found while building:**
  - The money helpers caught and hid errors (falling back to two decimals or a plain string); they
    no longer catch anything, since currency codes are validated when a pipeline is created.
  - "End of today" for due-today counts drifted by up to an hour on daylight-saving days; it is now
    computed from the calendar (unit tests for 23- and 25-hour days).
  - The contact CRM view returned an empty result for another company's contact; it now answers
    "not found", like every other lookup.
  - The pipeline limit counts pipelines in use, not archived ones; the settings page said otherwise.
- **Review fixes (independent review of the slice):**
  - A note, task or deal written while the contact was being erased could survive the erasure (and
    a deal change during an erasure could deadlock with it, or leave a timeline entry). Every CRM
    write now takes a key-share lock on the contact before its deal or task, in erasure's order.
  - A deal created, moved or reopened while an administrator removed its stage (or archived the
    pipeline) could end up open in an archived stage, off the board. Deal writers now share the
    pipeline row, which settings changes lock before counting open deals; a first attempt that also
    locked the stage rows deadlocked with settings changes in the new test and was replaced.
  - A closed deal whose stage had been removed could never be reopened (stages cannot be restored);
    it now reopens in the pipeline's first stage.
  - The deal owner list hid an owner who had lost CRM access; "Deal saved.", "Task saved." and
    "Pipeline saved." vanished when the saved form reloaded; the won and lost lists stopped at 50
    with no way further and their cursor dropped microseconds (skipping deals changed in the same
    millisecond); an impossible date such as 31 February caused an internal error instead of a
    validation message.

### Test commands and results (local, 2026-09-27, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm test` (unit)                                                          | 124 passed. New: 7 CRM tests — ISO currencies and decimals, exact parsing and its refusals, round trips and formatting, day boundaries across daylight-saving changes and month and year ends                                                                                                                                                                                                                                                                                                                                     |
| `pnpm test:integration` (PostgreSQL 18.x)                                   | 219 passed, including CRM 14: pipelines (settings, audit, archive and restore, limit), deals (stage moves, won/lost/reopen, versions, timeline), conversation visibility, notes and tasks on the timeline, reminders emailed exactly once with a fixed clock and their skips, the sweep, erasure (also racing a note and a change, with locks held on a second connection), a stage removed while a deal is created, reopening into a removed stage, paging through deals changed at the same moment, the deals report, isolation |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 36 passed (18 tests × 2), including a pipeline created in settings, a deal added from a contact and from a conversation, a stage move, a task whose reminder email arrives in Mailpit, a note, a win, the board, the tasks page and the reports, with no horizontal overflow on the new pages                                                                                                                                                                                                                      |

Firefox and WebKit run in CI only (not available in this environment).

### Known gaps

- Not built: custom deal fields, products on deals, deal import and export, forecasting, moving a
  deal to another pipeline from the UI (the service supports it), automation steps that create
  deals or tasks, and CRM connectors.
- Reminder emails have been delivered only to Mailpit; a production SMTP delivery is a release item.

## 2026-09-27 — Phase 4: automation engine (P4-01)

Status: **automation engine implemented and locally verified, production blocked.** Runs, the
hand-off to people, restart recovery and reports work on HyFib's own data. Bot messages, including
reply buttons with a header and footer, are verified only against the test-only Graph stand-in,
which checks them against the limits in Meta's OpenAPI spec; a real sandbox run is a release item.
The Phase 4 gate is partly met: "published flow survives restart" and "handoff" are verified
locally; "integration idempotency" waits for the HTTP step (P4-02) and commerce (P4-06).

### Completed

- **Schema (migration 0011):** automations with an editable draft (trigger, steps, number);
  immutable versions (published, and test snapshots of the draft) with a definition hash; runs
  pinned to a version with a durable position (current step, visits, wait state, captured answers,
  budget counters, consecutive failures); an append-only step log; one active run per conversation
  (partial unique index). Reply turns gain a start reason (customer or hand-off) and an `automated`
  end, and the turn trigger skips conversations an automation is handling.
  `ops.conversations_to_route` skips them too; `ops.automation_runs_due` and
  `ops.apply_automation_retention` are new definer functions (ids only). Contact erasure clears
  captured answers and stops the contact's active runs. Twelve metric definition rows: new versions
  of the inbox and member figures that leave automated time out, plus automation runs and outcomes.
- **Model and interpreter (browser-safe):** eight step types (message, question with reply buttons,
  question with a typed answer and format check, condition, contact update, wait, hand-off, end);
  checks for missing and unreachable steps, unknown teams, fields and placeholders, WhatsApp's
  interactive limits and loops that never wait. A pure interpreter is shared by the worker and the
  simulator. Reply-button ids name the run, step and visit; a typed reply equal to a button title
  counts as that button.
- **Dispatch and runner:** ingestion hands a reply to a waiting run, or starts the best matching
  automation (exact keyword, contained keyword, new conversation, any message). A run starts only
  in an unassigned conversation of an active company, subject to business-hours filters, cooldowns
  and 10 runs per conversation per hour.
  - Each step is one transaction (conversation lock, then run lock).
  - Bot messages go through the normal send pipeline, with window, number and WhatsApp id checks.
  - Budgets of 200 steps, 20 visits per step, 50 messages and 7 days.
  - A step that keeps raising an error fails the run after five attempts.
  - The minute sweep re-signals overdue runs and applies retention.
  - Suspended companies defer runs; test runs stop when the tester leaves or loses permission.
- **Hand-off lock:** a member's reply or template send, an assignment, Take over or a resolve ends
  the run and cancels its unclaimed bot sends. Routing skips conversations an automation handles. A
  run that hands off routes the conversation (to a chosen team, or like a new conversation) and opens
  a hand-off turn.
- **Web:**
  - Automations list and editor: trigger, steps with per-step fields, live checks and a generated
    diagram.
  - An in-browser simulator.
  - Save, publish with a note, pause, turn on, archive, restore and delete draft.
  - Test runs on a real conversation, and versions.
  - Run list and run pages with step logs and captured answers (captured answers only for members
    who can see the conversation).
  - Inbox: an "Automation" badge, labelled bot messages and a banner with Take over.
  - Reports → Automations: outcomes, failures by reason, per automation and per day, and a CSV
    export.
- **Found while building:**
  - The definer role could not read columns used in erasure's `CASE` expressions, so erasure now
    updates runs in two statements.
  - Erasure now locks conversations before contacts (the order every writer uses), avoiding a
    deadlock with the runner.
  - `GROUPING()` rejects parameterised expressions, so report rows are told apart by their null
    columns.
  - Versions of a metric definition must stay adjacent in the registry.
  - Mobile layouts needed `minmax(0,1fr)` columns.
  - A step that kept raising an error would have held the conversation for up to seven days; it now
    fails after five attempts.
- **Review fixes (Codex on PR #5):**
  - A run moved on (or completed) as soon as its message was queued, even if Meta then rejected it.
    Runs now wait for Meta to accept each message (migration 0012 records the pending message; the
    send worker signals the run when the send is settled). A rejected, cancelled, unknown or late
    message, or a failure Meta reports later, fails the run with `send_failed` and hands the
    conversation to people.
  - A marketing opt-out keyword was taken as the answer to a waiting question; any opt-out now stops
    the run.
  - An answer used before the question that saves it (for example in the first message) passed the
    checks. Answers are now checked along the paths that reach each step: never saved there is an
    error, saved on only some paths a warning ("is set" rules excepted).
  - Each bot message now takes a send job and an automation signal, so the worker polls the
    webhook, send and automation queues every second instead of every two.

### Test commands and results (local, 2026-09-27, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm test` (unit)                                                          | 117 passed. New: 13 automation tests — graph checks (targets, reachability, answers saved on the way to each step, loops, teams and fields, WhatsApp limits), trigger ranking, and the interpreter (taps, typed titles, stale and forged ids, answers and formats, conditions, timers, budgets, placeholders)                                                                                                                                                                        |
| `pnpm test:integration` (PostgreSQL 18.x)                                   | 205 passed, including automations 15: versions and pinning, roles, a full flow with a team hand-off, no competing replies, hours, cooldown and hourly cap, concurrent arrivals, crash and lost-signal recovery with real pg-boss consumers, a step that keeps failing, Meta rejecting, later failing or not accepting a message, timers and budgets, opt-outs (all and marketing), erasure, test runs (and a tester losing permission), reports, suspension and retention, isolation |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 32 passed (16 tests × 2), including an automation built in the editor, tried in the simulator, published with a note, run by the worker from a signed webhook, a typed button title handing over to people, the run log, Take over, the automation report and pause, with no horizontal overflow on the new pages                                                                                                                                                     |

### Known gaps

- Not built: the HTTP step (P4-02), Flows and catalog steps, starting runs from the API or
  campaigns, template follow-ups outside the service window, fuzzy keywords, a drag-and-drop
  canvas, and usage billing for automations.
- No run on a real WhatsApp number yet (release checklist). Migration 0011 re-checks the reply-turn
  constraints under a table lock; rehearse it on production-sized data.

## 2026-09-26 — Phase 3: inbox teams, routing, business hours, CSAT (P3-06)

Status: **implementation complete for the advanced inbox, production blocked** (routing, timers,
saved replies and mentions work on HyFib's own data; CSAT surveys are WhatsApp interactive messages
verified only against the test-only Graph stand-in, which checks them against the limits in Meta's
OpenAPI spec; a real tap from a sandbox number is a release item).

### Completed

- **Schema (migrations 0009, 0010):** teams, team members and member availability;
  `conversations.team_id` and a number's default team (`channel_accounts.default_team_id`);
  business hours and closed days; `app.conversation_cases` (open → resolve, maintained by triggers,
  immutable once resolved); saved replies; note mentions (deleted with their note); CSAT surveys
  (sent or skipped with a reason, first answer only, guarded by a trigger); the reply-turn trigger
  ignores CSAT taps; `ops.conversations_to_route` (definer, ids only) for the routing sweep; eleven
  metric definition rows (four new versions whose text said business hours were not supported, and
  business-hours first response, overdue, resolution time, CSAT surveys, response rate, score and
  CSAT per member). The team index is built concurrently in its own migration.
- **Routing:** keyword teams (whole words, any script) before the number's team; round robin to
  the next available member below the team's limit; one advisory lock per company; a minute sweep;
  immediate routing when a member becomes available or a team is saved; release of a member's
  conversations when they are suspended, removed, leave or lose inbox access; routing decisions in
  the audit log. Teams never change visibility (ADR-029).
- **Business hours and timers:** weekly ranges and closed days in the company time zone
  (daylight-saving aware); reply-due timers in the inbox list and thread, paused outside business
  hours; a longest-waiting order; team, number and customer filters.
- **Reports:** first response in business hours, overdue now, answered within target counted in
  business hours when business hours are on, resolution times from cases, a CSAT section with
  delivered and answered denominators and skip reasons, CSAT per member, new CSV columns and a CSAT
  export.
- **Saved replies, mentions, collisions:** supervisors manage saved replies with `{{name}}`,
  `{{agent}}` and `{{company}}` placeholders filled for the conversation; notes mention members who
  can see the conversation (Inbox → Mentions with an unread count); a reply is refused once when
  another member replied after the sender's last seen message.
- **CSAT:** on resolve, one question with three reply buttons inside the service window for contacts
  who have not opted out, at most once a day per conversation, re-checked at send time; the first
  tap matching the survey's button id and message context is recorded; taps never reopen the
  conversation, start a reply turn or count as keywords or campaign replies. Research rows M-157
  and M-158 record the reply-button limits and webhook shape from Meta's OpenAPI spec, fetched
  directly from GitHub (developers.facebook.com is blocked here).
- **Web:** Settings → Inbox (target, business hours, closed days, CSAT), Settings → Teams (teams,
  routing, who is taking conversations), Settings → Saved replies; inbox availability switch, filters,
  mentions view, timers, team control, saved-reply picker, mention picker, CSAT status and messages;
  reports sections. The response target moved from Settings → Messaging to Settings → Inbox.
- **Found while testing:** paging through the longest-waiting order repeated the first row on the
  next page, because turn start times carry microseconds and cursors milliseconds; the order and
  cursor now use millisecond-truncated times. Drizzle writes `FOR UPDATE OF` with a schema-qualified
  table name, which PostgreSQL rejects; the CSAT answer lock uses a plain row lock instead.

### Test commands and results (local, 2026-09-26, fresh database)

| Command                                                      | Result                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`         | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                               |
| `pnpm test` (unit)                                           | 104 passed (adds business-time arithmetic across closing times, weekends, closed days and 23/25-hour days, open/closed status, paused timers, range parsing, keyword matching and rotation)                                                                                                                                                                                                  |
| `pnpm test:integration` (PostgreSQL 18.x)                    | 190 passed: inbox advanced 14 (teams, number and keyword routing, rotation, limits with six simultaneous customers, the sweep, release on suspension, team moves, cases, list filters and timers, saved replies, mentions, collisions), CSAT 6, reports 16 (adds business-hours figures, resolution times and CSAT against hand-computed values with a fixed clock), plus the earlier suites |
| `pnpm test:e2e --project=chromium --project=mobile-chromium` | 30 passed (15 tests × 2), including settings for business hours, closed days, CSAT, a round-robin team and a saved reply, routing to the available owner, the team filter, a saved reply sent, the CSAT question and a tap, the CSAT report, and no horizontal overflow on the new pages                                                                                                     |

### Known gaps (tracked in BACKLOG.md)

Per-team SLA targets and calendars, breach notifications, presence and typing indicators,
conversation tags, private team queues, mention emails, CSAT outside the service window, a CSAT run
with a real WABA.

## 2026-09-26 — Phase 3: reports (P3-05)

Status: **implementation complete for reports, production blocked** (every number is computed from
HyFib's own records, so reports are only as real as the messaging behind them: delivery statuses
and pricing come from Meta's webhooks, verified here only with the test-only Graph stand-in; cost
estimates need platform staff to publish Meta's current rate cards, none ship with HyFib).

### Completed

- **Schema (migrations 0007, 0008):** `ops.metric_definitions` (what each number counts,
  denominator, window, time-zone rule, missing-data semantics, freshness; immutable, versioned, and
  kept identical to the registry in `packages/domain/src/reports/definitions.ts` by a test);
  `app.conversation_turns` (reply turns: start at the first customer message without a member reply,
  end on a member reply or when the conversation is resolved) maintained by triggers on
  `app.messages` and `app.conversations`, so every write path is covered; the company's
  first-response target; `campaigns.estimate_currency`; a `(tenant_id, created_at)` index on
  messages built concurrently in its own migration.
- **Reports service:** one repeatable-read, read-only snapshot per report, periods of whole days in
  the company's time zone (daylight-saving days have their real length; a skipped midnight starts
  the day at its first real instant; at most 92 days):
  - messaging outcomes by day and sender with explicit denominators, and Meta's failure codes;
  - estimated Meta charges: delivered messages Meta marked billable, priced at the list price of the
    published rate card in force when each message was recorded, by the recipient's market and
    Meta's pricing category; free and not-yet-priced messages, and each reason a billable message
    could not be priced, are listed instead of guessed;
  - inbox queue now (open, unassigned, waiting, longest wait, reply windows closing, waiting past the
    target, by assignee) and reply turns of the period (median and 90th-percentile first response,
    share within the target, resolved without a reply, reply-time spread, per day);
  - member activity (replies and templates sent, turns answered first with their median, resolves
    from the audit log; members who can reply are listed even when quiet);
  - campaign funnels for campaigns started in the period;
  - automation outcomes, deal outcomes and retention cohorts reported as not available, with the
    reason.
- **Exports:** one CSV per section, formula-safe, `reports.export` only, audited before any data is
  returned (`report.exported` with the period).
- **Inbox:** resolving or reopening a conversation is audited (`conversation.status_changed`);
  Settings → Messaging → Inbox response target.
- **Web:** Reports page (period presets and custom dates, the sections above, definitions of every
  number) and export route; the Reports module is now available.
- **Found while building and testing:**
  - a campaign's estimates used the company's current billing currency on every tick, so changing
    the currency during a run would have mixed currencies; the currency is now fixed per campaign
    the first time it is known;
  - the inbox live stream started "now", so a message arriving between the page render and the
    browser connecting stayed hidden until the next event; pages now pass the event-log position
    read before loading their data and the stream replays from there;
  - several pages scrolled sideways on phones (grids let wide tables stretch the page, header
    buttons did not wrap); 17 company pages (lists, forms and settings) were measured at 412 px
    and now fit, and e2e tests assert no horizontal overflow on the reports and contacts pages
    (detail pages were not measured);
  - the integration fixture minted WhatsApp ids from a per-file counter, so two test files could
    collide (seen once on PostgreSQL 17 in CI); ids are now random.
- **Review findings on the campaigns slice (PR #4), fixed with regression tests:**
  - when the member whose authority a campaign used left, sends the worker rejected stayed
    "queued" with failed messages and the pause did not release the rest, so a resumed campaign
    never reached those recipients; rejected and unclaimed sends now return their recipients to
    pending (also after a company suspension) and the counters are recomputed;
  - opt-outs were credited to the last campaign message even when it had failed, and reply and
    opt-out rates could exceed their delivered denominator; only messages WhatsApp accepted are
    credited now, rates count delivered recipients only, and a 131050 failure is recorded before
    its opt-out so the failing message itself is never credited.

### Test commands and results (local, 2026-09-26, fresh database)

| Command                                                      | Result                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`         | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                     |
| `pnpm test` (unit)                                           | 96 passed (adds report periods: presets, company date, 23- and 25-hour days, skipped midnights, validation; exact export amounts)                                                                                                                                                                                                  |
| `pnpm test:integration` (PostgreSQL 18.x)                    | 166 passed: reports 12 (definitions persisted = registry and immutable, turns through real ingest/reply/resolve paths and immutable, report numbers against hand-computed values, exports and permissions, isolation), campaigns 17 (adds the launcher-removed regression and failed-message attribution), plus the earlier suites |
| `pnpm test:e2e --project=chromium --project=mobile-chromium` | 28 passed (14 tests × 2), including a response target set, two customers writing, one answered, the report's numbers, a CSV export and a rejected over-long period                                                                                                                                                                 |

### Known gaps (tracked in BACKLOG.md)

Business-hours calendars for response times; reconciling estimates with Meta's
`pricing_analytics` (research M-078, not verified); automation, deal and retention reports (their
modules are not built); scheduled report emails.

## 2026-09-26 — Phase 3: campaigns and saved segments (P3-04)

Status: **implementation complete for campaigns and segments, production blocked** (campaign
sends are verified only against the test-only Graph stand-in; a real Meta app, app review and a
sandbox WABA with test recipients are external prerequisites; cost estimates need platform staff to
copy Meta's current rate cards, none ship with HyFib; the 10,000-recipient run happened locally, not
in staging). Reports (P3-05) are not built yet.

### Completed

- **Schema (migration 0006):** segments; campaigns (template, number, variable mapping, audience,
  wall-clock schedule, window, pacing, caps, approval, lifecycle, counters); campaign recipients (ids
  and outcomes only) and campaign history (append-only); `messages.campaign_id`; company campaign
  settings (approval, marketing frequency cap, estimate currency); platform rate cards (immutable
  once published, guarded by triggers); `ops.campaigns_due` (definer, app role only). **Found by the
  10,000-recipient test:** with statistics stale after a bulk import, the planner used the
  `(tenant_id, purpose, status)` consent index and the `(tenant_id, whatsapp_account_id, wa_id)`
  identity index for per-contact lookups, making the snapshot quadratic (6.4 s and 1.7 M buffer hits
  for 10,000 contacts, a statement timeout in the test). The migration drops that consent index and
  adds a per-contact identity index; the same query now takes about 0.1 s.
- **Segments:** tags, consent, typed custom fields, creation date (company time zone), source, recent
  inbound messages, calling code and campaign responses (retargeting), all/any, parameterised SQL,
  preview, version-checked edits, archive.
- **Campaigns:** draft editor with a live preview and a review panel; submission freezes the
  audience; optional four-eyes approval; scheduling in IANA time zones (gaps move forward, repeated
  times use the first occurrence); sending window; deadline; pacing; marketing frequency cap; message
  and estimated spending caps; pause/resume (resumer takes over); idempotent cancel; test sends to
  existing contacts through the normal consent checks; per-recipient outcomes, last-touch reply and
  opt-out attribution within 72 hours, results with explicit denominators, failure codes explained,
  formula-safe audited CSV export.
- **Runner:** `campaign.run` ticks under the campaign's row lock and a per-company advisory lock,
  re-check each recipient with fresh data and queue ordinary messages through the Phase 2 pipeline
  (batch insert of messages, intents and jobs); the send worker refuses messages of paused or
  cancelled campaigns; the messaging sweep re-signals lost ticks. **Found by tests:** automatic pauses
  for a spending or message cap first released the sends queued in the same tick; only authority,
  template and number problems release queued sends now.
- **Platform:** rate-card console (CSV in Meta's layout, publish, withdraw with a reason; platform
  audit log).
- **Web:** Campaigns (list, new, draft/review, approval, controls, results, history, recipients,
  export), Contacts → Segments, Settings → Messaging → Campaigns, Platform → Meta rate cards. The
  Campaigns module is now available.

### Test commands and results (local, 2026-09-26, fresh database)

| Command                                                      | Result                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`         | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                     |
| `pnpm test` (unit)                                           | 90 passed (adds time zones and daylight saving, sending windows, variable mapping, cost arithmetic and prefixes, rate-card CSV)                                                                                                                                                                    |
| `pnpm test:integration` (PostgreSQL 18.x)                    | 153 passed: campaigns 16 (segments, lifecycle and attribution, live re-checks, test sends, cancel races, approval, pause/resume, launcher losing permission, schedules and windows, frequency cap, spending and message caps, isolation, 10,000 recipients), isolation 45, plus the earlier suites |
| `pnpm test:e2e --project=chromium --project=mobile-chromium` | 26 passed (13 tests × 2), including a campaign drafted, reviewed, started, queued by the worker, sent to the Graph stand-in, delivery counted, recipients and export                                                                                                                               |

10,000-recipient run (local, one machine, PostgreSQL 18 in Docker): snapshot 629 ms; 21 runner ticks
queued all 10,000 messages in 7.0 s. Real sending is paced by the per-number rate (default 20 per
second, about 8.5 minutes for 10,000) and by Meta's limits; that part was not measured.

### Known gaps (tracked in BACKLOG.md)

Reports (P3-05); the 10,000-recipient run in staging with real dispatch; per-recipient time zones;
A/B variants; reading the number's messaging tier from Meta; campaign sends through the public API;
media-header templates.

## 2026-09-26 — Phase 3: contacts, consent and templates

Status: **implementation complete for contacts, consent and templates, production blocked**
(template submission, sync and sends are verified only against the test-only Graph stand-in; a real
Meta app with `whatsapp_business_management`, app review and a sandbox WABA are external
prerequisites; Meta's opt-in guidance (M-131) and per-market consent law still need review).
Campaigns and reports (P3-04, P3-05) are not built.

### Completed

- **Schema (migration 0005):** contact email, typed custom values, source and erasure time; one
  contact per number (unique index); tags, custom field definitions, import runs; append-only
  consent events with trigger-maintained state (definer trigger); suppression list; company
  messaging settings; message templates with status history; template sync bookkeeping per WABA;
  `messages.template_id`; `app.erase_contact` and `ops.template_sync_due` (definer, app role only);
  a status-history guard that lets only the erasure function clear recipient ids. Found by the new
  tests: PostgreSQL regular expressions cap repetition counts at 255, so the template-name check is
  a character class plus a length check.
- **Contacts:** create, edit (numbers from WhatsApp are read-only), tags, typed custom fields,
  search and filters with keyset pages, CSV import (preview, explicit mapping, national or
  international numbers, never guessed; row errors by row number; consent only with an attestation
  and never over an opt-out), streaming formula-safe export, erasure. Inbound identities join the
  contact that already has the number, and the WhatsApp id Meta returns on a template send becomes
  an identity.
- **Consent:** keyword opt-outs/opt-ins from inbound text, quick-reply and interactive replies
  (company-configurable lists), member-recorded consent with a note, import consent, Meta 131050
  opt-outs, erasure opt-outs. Opt-outs win ties and the one-second uncertainty of Meta timestamps
  (found by a test in which a STOP sent in the same second as an agent's opt-in lost).
- **Templates:** editor with live preview and local validation; write-ahead submission; sync from
  the paged Graph listing (default-fields fallback), adoption of lost create responses and of
  templates made in WhatsApp Manager, failure of submissions Meta never received; deletion; template
  webhooks as sync signals through verified WABA bindings; per-minute sweep.
- **Template sends:** from a contact page (utility: inbox or campaign permission; marketing:
  campaign permission) and from the inbox when the 24-hour window has closed; consent, suppression
  and template approval re-checked right before dispatch; 132015/132016 mark the template paused or
  disabled; 131050 records an opt-out.
- **Web:** Contacts (list, add, detail, import, export), Templates (list per account with refresh,
  editor, detail with history), Settings → Messaging (keywords, marketing opt-in requirement,
  suppression list, custom fields); the inbox renders template messages and offers templates when
  the window is closed. Contacts and Templates modules are now available.

### Test commands and results (local, 2026-09-26, fresh database)

| Command                                                      | Result                                                                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`         | 0 problems / all files formatted / all workspace packages pass                                                                                               |
| `pnpm test` (unit)                                           | 72 passed (adds phone normalisation, CSV reader/writer, consent keywords and timing, template definitions)                                                   |
| `pnpm test:integration` (PostgreSQL 18.x)                    | 136 passed: contacts/consent/erasure 13, templates 12, isolation 44 (new function-privilege assertions), messaging 21, billing 30, jobs/email 14, services 2 |
| `pnpm test:e2e --project=chromium --project=mobile-chromium` | 24 passed (12 tests × 2), including contact creation, consent, CSV import/export and a template drafted, submitted, approved, synced and sent from the inbox |

Firefox and WebKit are not installed in this sandbox; they run in CI. Meta traffic in these tests
comes from the test-only Graph stand-in (`tests/support/graph-stand-in.ts`); no template has been
submitted to the real Graph API.

### Known gaps (tracked in BACKLOG.md)

Campaigns and saved segments (P3-04), reports (P3-05), safe contact merge (H-019), number masking
(W-044), media headers and other template types, URL buttons with variables (example format
unconfirmed, M-151), editing approved templates, sandbox verification of template submission, sync
fields (`rejected_reason`, `quality_score`) and template webhook payloads.

## 2026-09-26 — Phase 5 financial core (section 8A)

Status: **implementation complete for the wallet, top-up and auto-recharge slice, production
blocked** (Razorpay merchant activation, Recurring Payments for card mandates and a sandbox run are
external prerequisites; no request has reached the real Razorpay API; GST treatment of service
credit needs tax review; subscriptions are not built).

### Completed

- **Schema (migration 0004):** wallets, five ledger accounts per wallet, append-only ledger
  transactions and entries (balances by trigger, deferred balance check at commit), holds, Razorpay
  customers, card mandates (provider references and safe card metadata only), auto-recharge
  settings and attempts (one active attempt per wallet by partial unique index), top-ups. FORCE RLS
  everywhere, restrictive policies so runtime code can never mark a top-up paid or an attempt
  succeeded, support reads behind `billing.read` grants, and SECURITY DEFINER functions for every
  posting (credit, refund, dispute loss, hold/settle/release, auto-recharge decision) plus sweep
  and provider-id resolution functions.
- **Domain:** Razorpay client with classified results (retryable / permanent / auth / unknown) and
  constant-time signature checks; payment application from authoritative fetches only (payments,
  refunds, disputes, tokens); webhook receipt processing with quarantine; top-up reconciliation
  with backoff and expiry; the auto-recharge state machine with write-ahead unknown states and
  reconciliation by receipt / order payments; card mandate setup with the ₹1 authorisation refunded
  by idempotency key and abandoned tokens deleted; billing service for the web; owner/billing-role
  email notices; holds API for billable services.
- **Worker:** `billing.event-process`, `billing.auto-recharge` (check or advance), and a per-minute
  `ops.billing-sweep` (stale receipts, reconciliation, candidates, expired holds).
- **Web:** `/api/webhooks/razorpay`; Billing page (balance, add credit through Standard Checkout,
  card mandate, auto-recharge settings and attempts, payments, credit history) with the Razorpay
  CSP, COOP and Permissions-Policy scoped to that page. Found by the new e2e test: a CSP belongs to
  the loaded document, so provider pages (Billing, Channels) are now full page loads and reload
  once if reached by client-side navigation.
- **CI fix (0366b00):** WebKit e2e failed because input typed before hydration was reset by
  react-hook-form (and a pre-hydration click would have submitted the form natively). Client forms
  and click-handler buttons are disabled until hydration; regression test added. All 8 CI checks
  green on `0366b00`.

### Test commands and results (local, 2026-09-26, fresh database)

| Command                                                      | Result                                                                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`         | 0 problems / all files formatted / all 9 workspace packages pass                                           |
| `pnpm test` (unit)                                           | 49 passed (adds Razorpay signatures, client classification, Razorpay config)                               |
| `pnpm test:integration` (PostgreSQL 18.x)                    | 111 passed: billing 30, isolation 44, messaging 21, jobs/email 14, services 2                              |
| `pnpm test:e2e --project=chromium --project=mobile-chromium` | 20 passed (10 tests × 2), including a card top-up through the billing page and the signed Razorpay webhook |

Razorpay traffic in these tests comes from a test-only stand-in (`tests/support/razorpay-stand-in.ts`);
in the e2e run Playwright replaces `checkout.js` inside the test browser only. The configuration
refuses a non-official Razorpay origin outside `APP_ENV=local|test` and live keys outside
production.

### Known gaps (tracked in BACKLOG.md)

Plans and subscriptions (P5-01), statements, receipts and GST invoices, refunds initiated from the
platform console, step-up re-authentication for payment settings, Razorpay sandbox verification of
every flow and of the Checkout CSP, billable services that use holds (phase 6).

## 2026-09-26 — Phase 2 messaging slice

Status: **implementation complete for the phase 2 slice, production blocked** (Meta app, business
verification, app review and Embedded Signup configuration are external prerequisites; no message
has been exchanged with the real WhatsApp Cloud API).

### Completed

- **Schema (migration 0003):** WhatsApp accounts and numbers, onboarding sessions, contacts with
  per-WABA identities (BSUID first, phone optional), conversations (optimistic versions), notes,
  messages, immutable status history, send intents, media metadata, company event log (xid8
  cursors, NOTIFY hint), provider asset bindings, encrypted webhook receipts, quarantine, token
  buckets, retention functions. FORCE RLS and composite FKs on every tenant table; definer functions
  granted before ownership transfer.
- **Hardening (migration 0002, from review):** membership directories behind `members.read` support
  grants; platform seat counts and owner lookup through narrow definer functions; PUBLIC execute
  removed from every function (it had been granted by PostgreSQL's global default), with a
  structural test.
- **Domain:** webhook signature verification (current + previous secret), durable receipts,
  idempotent ingestion with quarantine and monotonic statuses, outbound send state machine
  (retries with jitter, per-number token bucket and fairness groups, unknown outcomes never resent
  automatically, manual resolution, cancellation on suspension or sender removal), Embedded Signup
  onboarding with server-side verification, resumable setup jobs, inbox service (visibility,
  assignment and status with row locks and versions, notes, read state), live-update event log with
  visibility filtering, retention.
- **Worker:** `webhook.process`, `message.send` (re-signals at `retryAt` in the number's group),
  `channel.onboard`, and a per-minute messaging sweep (lost signals, dead workers, retention).
- **Web:** `/api/webhooks/meta` (handshake, streaming 4 MB cap, signature, receipt before 200),
  `/api/c/{slug}/events` (SSE with replay, 30 s re-validation, polling mode), Inbox (views, thread,
  composer with per-member-and-company drafts and idempotency keys, window indicator, assignment,
  resolve/reopen, notes, unknown-outcome decisions, live updates), Settings → Channels (Embedded
  Signup, setup status, retry, disconnect) with Facebook CSP/COOP scoped to that page.
- **CI fixes:** WebKit dropped `Secure` cookies on loopback http (cookie security now follows the
  https origin; staging/production refuse non-https in any build mode); runtime images no longer
  ship npm/corepack/yarn (HIGH CVEs in npm's bundled dependencies); reviewed gitleaks false positive
  recorded. All 8 CI checks green on `e01bc26`.

### Test commands and results (local, 2026-09-26, fresh database)

| Command                                                                 | Result                                                                                                               |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check`                                       | 0 problems / all files formatted                                                                                     |
| `pnpm typecheck`                                                        | all 9 workspace packages pass                                                                                        |
| `pnpm test` (unit)                                                      | 39 passed (adds config safety, IP parsing)                                                                           |
| `pnpm test:integration` (PostgreSQL 18.x)                               | 81 passed: isolation 44, messaging 21, jobs/email 14 (+2 service tests)                                              |
| `pnpm test:e2e --project=chromium --project=mobile-chromium`            | 16 passed (8 tests × 2): live inbox (signed webhook → SSE → reply → delivery receipt), forms disabled until hydrated |
| Webhook smoke (`curl`)                                                  | handshake 200 with challenge; wrong verify token 403; unsigned 401; 5 MB body 413                                    |
| `docker build` web and worker; Trivy 0.74.0 (HIGH/CRITICAL, fixed only) | both images build; no findings                                                                                       |

Meta traffic in these tests comes from a test-only Graph API stand-in (`tests/support/`), which the
configuration refuses outside `APP_ENV=local|test`. Firefox and WebKit run in CI.

### Known gaps (tracked in BACKLOG.md)

Media download and storage, templates and template sends, message search, token health checks,
platform quarantine screen, messaging-limit display, collision warnings, Meta-side deregistration.

## 2026-09-26 — Phase 0 and Phase 1 vertical slice

### Completed

- **Phase 0:** repository assessment (empty repository: README + LICENSE only); toolchain research
  and pinning (ADR-002); research files for the WATI benchmark (164 capabilities), Meta WhatsApp
  platform (148 claims, Graph API v26.0) and Razorpay/RBI (105 claims) under
  `docs/research/`; dated feature matrix with truthful status (`docs/FEATURE-MATRIX.md`, generated);
  architecture, decisions, threat model, security, backlog, Meta setup, deployment, runbooks,
  retention, release checklist.
- **Phase 1:**
  - PostgreSQL roles (owner/app/auth/platform/definer), schemas `app`/`auth`/`ops`, FORCE RLS,
    column grants, SECURITY DEFINER entry points (create company, invitation preview/accept,
    last-owner guard, tenant status, account recovery), append-only audit tables.
  - Forward-only migration runner with checksums and pg-boss installation/queue declaration.
  - Better Auth identity (verified email required, TOTP 2FA, DB sessions, DB rate limits,
    enumeration protection).
  - Domain services: tenant context resolution, permission matrix, tenancy (companies, members,
    invitations, audit), platform administration, job signing/authorization, email outbox/delivery.
  - Web: sign-up/in, verification, reset, two-factor, onboarding, invitations, company overview,
    settings (general, members, security, audit log, modules), account (profile, 2FA, password,
    sessions), platform area (companies, suspension, support grants, MFA recovery); CSP nonces and
    security headers.
  - Worker: email delivery, outbox sweeper schedule, health probes, graceful shutdown.
  - Docker images (web, worker+migrate), compose dev stack, CI workflows (quality, integration on
    PG 17/18, build, e2e on Chromium/Firefox/WebKit/mobile, security, containers), Dependabot.

### Test commands and results (local, 2026-09-26)

| Command                                                                                                               | Result                                                                          |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm lint`                                                                                                           | 0 errors, 0 warnings                                                            |
| `pnpm format:check`                                                                                                   | all files formatted                                                             |
| `pnpm typecheck`                                                                                                      | all 9 workspace packages pass                                                   |
| `pnpm test` (unit)                                                                                                    | 24 passed (crypto, money, ids, permission matrix, job envelope, AppError brand) |
| `pnpm test:integration` (PostgreSQL 18.x in Docker)                                                                   | 54 passed: tenant isolation 40, jobs/email 14                                   |
| `pnpm build`                                                                                                          | web (22 routes) and worker bundles built                                        |
| `pnpm test:e2e --project=chromium --project=mobile-chromium` (local Chromium build 1194 via `PW_CHROMIUM_EXECUTABLE`) | 10 passed (5 tests × 2 projects)                                                |
| `pnpm audit --audit-level=high`                                                                                       | no known vulnerabilities                                                        |
| `docker build` web and worker images; run against local DB                                                            | both start; readiness OK; headers verified                                      |

Firefox and WebKit e2e runs happen in CI (browsers are not installed in this sandbox).

First CI run on PR #1 (commit `d9687b7`, 2026-09-26): lint/types/unit, integration on PostgreSQL 17
and 18, and the web/worker build passed; e2e passed on Chromium, Firefox and mobile but failed on
WebKit; both container scans and the secret scan failed. Root causes and fixes:

- WebKit drops `Secure` cookies on `http://localhost`, and the auth cookies were marked secure
  whenever `NODE_ENV=production` (CI runs `next start` over loopback http). Cookie security now
  follows the https origin, and staging/production refuse non-https origins in any build mode.
- Trivy flagged HIGH CVEs in the npm copy bundled with the Node base image (`brace-expansion`,
  `ip-address`, `tar`). The runtime images no longer ship npm, npx, corepack or yarn; local Trivy
  0.74.0 scans of both images report no HIGH/CRITICAL fixed vulnerabilities.
- gitleaks matched an empty `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=` in `.env.example` together with the
  next line (false positive; no value was committed). The fingerprint is recorded in
  `.gitleaksignore` and the variables are now separated by a comment.

Review round 1 (Codex on `d9687b7`), fixed in the following commit:

- Platform staff read company membership directories only through a `members.read` support grant;
  the console uses aggregate seat counts and an owners-only lookup (definer functions, platform
  administrators only). The company page loads by id instead of searching the newest 200.
- Support-access revocation is mirrored into the company audit log.
- Invitation issuance takes a per-company transaction lock, so the daily quota holds under
  concurrency (integration test: six concurrent requests at 99/100 yield exactly one invitation).
- Client IPs are resolved from `X-Forwarded-For` right-to-left past `TRUSTED_PROXIES` and validated
  with Node's IP parser; malformed values are dropped instead of failing the audited transaction.
- Found while testing: every `app`/`ops` function was executable by PUBLIC (a per-schema default
  cannot revoke the global default), and grants issued after transferring functions to
  `w360_definer` were no-ops. Migration `0002_platform_access_hardening` revokes PUBLIC, sets the
  global default for the migration role and re-grants as the owner; a structural test now fails if
  any function is executable by PUBLIC.

### Running end-to-end tests locally

```bash
bash scripts/local-db.sh up && docker compose -f infra/docker-compose.yml up -d mailpit
set -a; . ./.env; set +a; export APP_ENV=test
pnpm db:migrate && pnpm build
(cd apps/web && npx next start --port 3000 &) ; (cd apps/worker && NODE_ENV=production node dist/main.js &)
E2E_DATABASE_URL_AUTH=$DATABASE_URL_AUTH pnpm test:e2e --project=chromium
```

The inbox e2e test needs the test-only Meta settings in `.env` (web and worker):
`META_APP_ID`, `META_APP_SECRET` (any random value), `META_GRAPH_API_VERSION=v26.0`,
`META_WEBHOOK_VERIFY_TOKEN`, `META_GRAPH_BASE_URL=http://127.0.0.1:4010` and `E2E_GRAPH_PORT=4010`;
Playwright's global setup starts the Graph stand-in on that port. Without them the test is skipped.
The billing e2e test similarly needs `RAZORPAY_KEY_ID=rzp_test_…`, `RAZORPAY_KEY_SECRET` and
`RAZORPAY_WEBHOOK_SECRET` (random values), `RAZORPAY_API_BASE_URL=http://127.0.0.1:4020` and
`E2E_RAZORPAY_PORT=4020`.
The web request e2e test calls a local target server: set `W360_EGRESS_ALLOW_LOOPBACK=true` for the
web, the worker and Playwright, and `E2E_HTTP_HOST` to a name that resolves to 127.0.0.1 (for example
add `127.0.0.1 api.w360-e2e.test` to `/etc/hosts`, as CI does). Without them the test is skipped.

### Blockers (external)

- Network policy of this build environment blocked `wati.io`, `developers.facebook.com`,
  `business.whatsapp.com` and `razorpay.com`; research relies on search summaries and official GitHub
  sources and must be re-verified.
- Meta: business verification, Tech Provider app review, Embedded Signup configuration.
- Razorpay: merchant activation (Orders, Subscriptions, Recurring Payments card mandates).
- Owner decisions: SMTP provider and sending domain, hosting provider/region, legal entity for billing.

### Next task

Phase 3 foundations that unblock real usage: contacts with consent provenance and suppression,
message templates (drafts, Meta submission, approval sync) and template sends, then campaigns with
send-time consent checks. In parallel: phase 2 follow-ups (media storage, token health, quarantine
screen) and P5-01 plans and subscriptions.
