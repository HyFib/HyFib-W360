# Runbooks

Last updated 2026-10-03. Procedures marked **(phase N)** apply once that capability ships. Every
action on customer data requires a support grant (`/platform`) with a reason; every platform action is
audited. Never paste tokens, message content or card data into tickets or chat.

## 1. Triage basics

- Correlation ids: responses carry `x-request-id`; server-action errors show a reference to users.
  Search logs by `correlationId`.
- A failed query is logged as a `DatabaseQueryError` (ADR-129): its message is PostgreSQL's own when
  that names only objects (a constraint, table or column) or is one of our functions' sentences,
  otherwise "Database query failed (SQLSTATE …)"; `code` is the SQLSTATE, `constraint`, `table` and
  `column` name what failed and the stack's frames show where the query was awaited. The query's
  parameters, PostgreSQL's detail (a unique violation's key, a check's whole row) and the value a
  data exception (SQLSTATE 22…) quotes are never logged, nor kept in a receipt's `last_error` or a
  failed job's output. Find the statement from the frames and the request (`requestId`,
  `correlationId`) or job, then reproduce it with the company's data under a support grant; do not
  turn on statement logging with parameters to find it (DEPLOYMENT, first-time database setup).
- Health: web `/api/health/ready`, worker `:9464/ready`.
- Queues (as owner or with a read-only diagnostic role):
  ```sql
  SELECT name, state, count(*) FROM pgboss.job GROUP BY 1, 2 ORDER BY 1, 2;
  SELECT name, count(*) FROM pgboss.job WHERE name = 'dead-letter' GROUP BY 1;
  ```
- Email backlog: `SELECT status, count(*) FROM ops.email_outbox GROUP BY 1;`
- Without SQL: `/platform/ops` (platform staff, section 10P) shows the companies needing attention,
  integration failures, Meta and Razorpay receipts needing attention, quarantine, queue counts and
  recent dead letters.

## 2. Email not arriving

1. Check `ops.email_outbox` for the recipient (metadata only): `status`, `attempts`, `last_error`.
2. `pending` with rising attempts → SMTP outage or credentials: check provider status, verify
   `SMTP_*` secrets, rotate if needed. Rows retry automatically (backoff, max 12 attempts); the
   sweeper re-signals lost jobs every minute.
3. `failed` with `permanent:` → recipient rejected (5xx). Confirm the address with the user; the
   user can request a new verification/reset/invitation email.
4. `sending` stuck → worker died mid-send; the lease expires in 2 minutes and the sweeper recovers it.
   A duplicate email is possible (at-least-once).

## 3. Backlog growth / queue lag

Platform administrators are emailed "Queue … is falling behind" (or "N queues are falling behind")
when a queue's oldest ready job has waited longer than the queue's limit (ADR-096: 15 minutes, 60
for template, catalog and store syncs, the settlement reconciliation and company deletion). The
email names each queue with its waiting jobs and oldest wait; Operations → Queues shows the same
for every queue at the worker's last check, which it makes every minute. A queue stays late until
its oldest job has waited under half its limit, and is emailed about again only after that, at most
every 15 minutes. If the Queues tab says **the worker is not checking the queues**, the minute
sweep is not running: nobody is emailed about late queues until it does, so start with the worker
(`:9464/ready`, its logs, whether its pod or container runs).

1. Identify the queue (Operations → Queues, or `pgboss.job` counts by `name` and
   `state='created'`; the oldest wait is
   `SELECT min(start_after) FROM pgboss.job WHERE name = … AND state < 'active' AND start_after <= now()`).
2. Check worker health and logs; scale worker replicas horizontally (safe). A queue whose handler
   takes one or two jobs at a time (see `apps/worker/src/main.ts`) drains slowly after a burst: that
   is why its limit is longer. A limit is changed in the queue catalog
   (`packages/contracts/src/jobs.ts`, `maxWaitMinutes`) and applies with the next release.
3. If a poison job fails repeatedly, it moves to `dead-letter` after its retry limit, and the
   worker records it in `ops.dead_letters` (Operations → Queues: queue, kind, company when its
   signature verified, retries, error name and code, never the message). The worker log's
   `job attempt failed` entries carry the error for each attempt; the failed job itself (ids only,
   with its output) stays in its queue for the queue's retention (1 to 7 days) and its copy in
   `dead-letter` for 30 days. Fix the cause. Most queues' work is a row the minute sweeps signal
   again. The minute sweep ends the work of `channel.onboard`, `commerce.account` and
   `template.delete` for its company instead (ADR-111), and the company starts it again;
   `template.submit` dead letters can be retried from Operations → Queues (section 10P, ADR-108).
   `boss.redrive('dead-letter', …)` does not help: the worker has already completed the copies.
4. Index bloat warnings (`index_bloat`) → run `getReindexCommands()` output as the owner role during
   low traffic (runtime roles cannot reindex).

## 4. Webhook ingestion failure

1. Meta retries for up to 7 days; `/api/webhooks/meta` returns 200 only after the encrypted receipt is
   committed (500 on storage failure, 401 on a bad signature, 413 above 4 MB).
2. Signature failures (`ops.security_events` `webhook.invalid_signature`, rate-limited to about one
   per 5 s): verify `META_APP_SECRET` (and `META_APP_SECRET_PREVIOUS` during a rotation) matches
   the app. A spike from unknown sources is an attack — keep rejecting, alert security.
3. Backlog: `SELECT status, count(*) FROM ops.webhook_receipts GROUP BY 1`. The messaging sweep
   re-signals `pending`/`failed` receipts older than 2 minutes and expired `processing` leases, up to
   12 attempts. Receipts at 12 attempts stay `failed` for you: read `last_error` under Operations →
   Integrations, fix the cause, then **Retry** it there with the fix as the reason (platform audit
   log; it goes back to pending and the sweep processes it again; processing is idempotent). If the
   web is down, the owner role can reset it with
   `UPDATE ops.webhook_receipts SET status = 'failed', attempts = 0 WHERE id = …`.
4. Unknown or mismatched assets land in `ops.webhook_quarantine` (`unknown_asset`,
   `asset_mismatch`, `malformed`), listed under Operations → Integrations. Map an asset only after
   verifying ownership with the company (never by guess; it reconnects through Embedded Signup),
   then **Retry** the receipt, and **Resolve** the entry with the decision either way.
5. Raw bodies are erased after 7 days; replay is impossible after that (by design).

## 5. Provider outage (Meta, Razorpay, SMTP)

- Sends/charges stay queued with bounded retries and backoff; do not bulk-retry manually.
- Post a status notice in-app (platform banner, backlog) and to affected owners.
- After recovery, watch for `unknown_outcome` sends (section 7); open top-ups and auto-recharge
  attempts reconcile themselves through the billing sweep (section 9).

## 6. Expired or revoked provider credentials

1. Symptoms: the daily check of the account's access (ADR-137) found that Meta no longer accepts it,
   or Graph error 190/102/10 or HTTP 401 on sends, template syncs or setup steps. The account and
   its numbers show **Reconnect needed** in Settings → Channels (`whatsapp_accounts.status` and
   `channel_accounts.status = 'needs_reconnect'`, the reason in `whatsapp_accounts.token_problem`),
   every page of the company shows a banner, and the owners and administrators were emailed once. A
   send or template sync refused for the token asks for a check at once
   (`whatsapp_accounts.token_check_requested_at`), so the account follows within about a minute.
2. The failing send is marked failed with the provider error; later sends to that number fail fast
   at the channel check until it is reconnected.
3. The company re-runs Embedded Signup (Connect WhatsApp number) with the same account and one of
   its numbers: the token is replaced and the reason cleared, that number's setup re-runs from the
   first step, and the account's other numbers that Meta still lists resume their setup (an active
   number only has its health read again; one Meta no longer lists stays as it is).
4. A check that could not be made changes nothing for the company: `token_check_error` keeps the
   error's kind, code and title and the account is tried again after 30 minutes. When many accounts
   fail at once, check `META_APP_SECRET` (Meta refuses HyFib's app access token with error 190
   `OAuthException`) and egress to `graph.facebook.com`. The operations console's Integrations page
   lists an account whose access has not been checked successfully for 26 hours ("WhatsApp access
   check").
5. An expiry Meta reports for a token is shown on Channels; the owners and administrators are
   reminded once 7 days before it, and the account is checked again as soon as it passes.
   Reconnecting gives HyFib a new token.
6. **WhatsApp messages are not reaching HyFib** (ADR-138): the daily check found HyFib's app missing
   from the account's subscribed apps and could not subscribe it again. Channels and every page of
   the company say so, the owners and administrators were emailed once, and the operations
   console's Integrations page lists the account under "WhatsApp webhooks" with Meta's error
   (`whatsapp_accounts.webhooks_missing_since`, `webhooks_check_error`). HyFib tries again every 30
   minutes. Code 200 means Meta refuses the app's permission for the account (ask the company
   whether it removed HyFib's app); others are usually transient. Reconnecting the account runs
   onboarding's subscribe step. A subscription HyFib restored by itself is audited
   (`whatsapp.webhooks_restored`) and the company is told that messages sent before then may be
   missing.

## 7. Duplicate-send uncertainty

1. `unknown_outcome` means the request may have reached Meta but no response was recorded (timeout,
   connection reset, or a worker that died after recording dispatch).
2. Nothing resends automatically — not workers, not the sweep. A member with reply permission decides
   in the thread: **It arrived** (marks it sent) or **Send again** (accepting a possible duplicate).
3. A status webhook for the message cannot be correlated without a WAMID; if the customer confirms
   receipt, choose **It arrived**. Staff never resend on a company's behalf.
4. If many sends become unknown at once, check network egress to `graph.facebook.com` and Meta's
   status before anyone resends.

### Setup failures

- `Meta temporarily blocked registration … (72 hours)`: error 133016 (too many register attempts).
  Wait, then **Retry setup**.
- Other setup errors show the step and Meta's message; fix the cause (for example the number's
  two-step verification PIN set elsewhere) and **Retry setup**.

## 8. Data restoration

1. Declare incident; freeze deploys.
2. Restore the managed PostgreSQL to a new instance at the chosen point in time (PITR).
3. Verify: row counts, latest audit events, migration table (`w360_migrations.applied`), pg-boss
   version; run the isolation test suite against the restored instance if time permits.
4. Re-apply company deletions completed after the restore point before reopening access. List
   them from the old database's register (`SELECT * FROM ops.tenant_deletions WHERE completed_at >
'<restore point>'`) or, if it is lost, from the worker's `company deleted` log lines
   (`tenantId`). On the restored database, as the migration role with `SET ROLE w360_definer`: if
   the company's deletion is still open there, set its `due_at` to now; if the request came after
   the restore point, insert the old register row (same id, requester, request time, previous
   status and name, `due_at` now, no start or completion) and set the company's status to
   `pending_deletion`. The minute sweep then deletes it again (section 10Q). Contact erasures after
   the restore point are repeated from the old database's audit log (`contact.erased`).
5. Switch connection strings (secret manager) and roll web/worker. Record timings (RPO/RTO achieved)
   in the release evidence. **A restore drill has not been performed yet.**

## 9. Payments, credit and auto-recharge

Credit exists only as ledger postings made by SQL functions; never insert or edit ledger rows,
balances or top-up states by hand. Corrections are compensating postings made through a reviewed
migration or function, recorded in the incident log.

1. **Razorpay webhooks.** `/api/webhooks/razorpay` answers 200 only after the encrypted receipt is
   committed (401 bad signature, 413 above 1 MB, 404 when Razorpay is not configured). Razorpay
   disables a webhook after 24 h of failures: re-enable it in the Dashboard, then let the
   reconciliation sweep catch up. Backlog and failures:
   `SELECT status, count(*) FROM ops.webhook_receipts WHERE provider = 'razorpay' GROUP BY 1`.
   The billing sweep re-signals stale receipts up to 12 attempts (reset as in section 4).
   Signature failures: check `RAZORPAY_WEBHOOK_SECRET` (and `…_PREVIOUS` during rotation).
2. **Quarantined payments** (`ops.webhook_quarantine`, provider `razorpay`, `unknown_asset`): a
   payment for an order we did not create (another integration on the same account, or a test).
   Confirm in the Razorpay Dashboard; never attach it to a company by guess. If a customer paid
   outside our checkout, refund it from the Dashboard.
3. **A customer says they paid but has no credit.** Find the top-up (`app.topups` by
   `provider_order_id` or `receipt`). `awaiting_payment` with a captured payment in the Dashboard:
   the next sweep credits it (checks back off from 15 min to 4 h); to hurry, redeliver the
   `payment.captured` webhook from the Dashboard. Authorised but not captured: credit waits for
   capture (auto-capture) — never credit manually.
4. **Auto-recharge attempts.** `SELECT status, unknown_step, last_error, next_check_at FROM
app.auto_recharge_attempts WHERE tenant_id = … ORDER BY created_at DESC`. `unknown` resolves
   itself: orders are looked up by receipt `ar_<attempt id>` and debit requests by the order's
   payments before anything is repeated. `payment_requested` for up to 72 h is normal (bank
   pre-debit notice). A debit still `created` after a week blocks new attempts on purpose; check
   the payment in the Dashboard and, if it is dead, ask Razorpay support before failing anything.
   `last_error` starting `internal:` is our fault (the attempt retries hourly): fix and redeploy.
5. **Repeated declines.** Three consecutive failed attempts turn auto-recharge off and email the
   owners and billing members; the company turns it back on after fixing the card.
6. **Refunds and chargebacks.** Refunds made in the Razorpay Dashboard are recorded from
   `refund.processed`; lost disputes from `payment.dispute.lost`. Both reduce available credit and
   may make it negative, which blocks billable services until credit is added. Prefer refunding
   unused credit from the company's platform page (step 10): it never takes spent credit.
7. **Enabling card mandates.** Only after Razorpay confirms Recurring Payments (card) for the
   merchant: set `RAZORPAY_RECURRING_CARDS_ENABLED=true` on web and worker. Turning it off again
   stops new mandates and new auto-recharge settings; attempts already requested still complete.
8. **Integrity check** (read-only, any time):
   `SELECT tenant_id FROM app.ledger_accounts GROUP BY tenant_id HAVING sum(CASE WHEN normal_side =
'debit' THEN balance_minor ELSE -balance_minor END) <> 0` must return no rows.
9. **Statements and receipts** (Billing → Statements, and Receipt links, ADR-057). They are computed
   from the ledger each time: nothing to regenerate or repair.
   - **"A statement changed."** Statements follow the company's current time zone, and changing it
     moves every month boundary. Otherwise a posting only appears afterwards if it committed after
     the statement was generated, just after midnight (each statement shows when it was
     generated).
   - **"No receipt."** Only a top-up credited from a captured payment has one; a top-up still
     awaiting payment shows none (see step 3).
   - **"The method is missing."** Top-ups credited before 0029 have no recorded method. It is filled
     in the next time Razorpay reports the payment (a redelivered `payment.captured` webhook
     does it); never set it by hand.
   - **"We need a tax invoice."** Receipts are payment confirmations, not tax invoices. GST
     documents are not issued yet (tax review, RELEASE-CHECKLIST).
   - **Migrations 0030 and 0031 failed.** They build `ledger_entries_account_time_idx` and
     `ledger_transactions_reference_idx` concurrently outside a transaction. Drop the invalid index
     (`DROP INDEX CONCURRENTLY IF EXISTS app.<index>`) and run the migrations again.
10. **Refunds of unused credit** (the company's platform page → Service credit, platform owners,
    ADR-058). The request holds the credit at once; the worker sends it to Razorpay within a
    minute or two and the company's billing managers are emailed when Razorpay accepts it.
    Razorpay normally completes it in 5–7 working days and keeps its fee.
    `SELECT status, attempts, provider_refund_id, last_error, next_attempt_at FROM app.credit_refunds
WHERE tenant_id = … ORDER BY requested_at DESC`:
    - **`requested` with attempts rising:** Razorpay did not answer or was busy; the same call
      (same idempotency key, so never a second refund) is repeated after 1, 5, 15 and 60 minutes,
      then hourly. A 401 means the API keys are wrong: fix them, and the next try goes through.
    - **`submitted` for days:** normal up to about 7 working days. Look the refund up in the
      Dashboard; if Razorpay shows it processed, redeliver `refund.processed` (or wait for the
      worker's check, every 6 hours after the first day). Never mark it processed by hand.
    - **`failed`:** `last_error` is Razorpay's code and description (for example refunds not
      enabled, or not enough balance); the credit is back with the company. Fix the cause and ask
      for a new refund.
    - **The company asked for deletion:** new refunds are refused; refund from the Dashboard, which
      is recorded from `refund.processed`. A due deletion waits for a refund in progress (the
      deletion card on the platform page says so).
    - A refund still open after 90 days loses its hold to the expired-holds sweep; if Razorpay
      processes it later, it is recorded as a plain refund.
    - **Refund requests from companies** (`/platform/refunds`, ADR-073). Billing managers ask from a
      payment's receipt; platform owners are emailed a count ("A refund request is waiting for a
      decision") within a minute, and decide on the page (operators only read). Approving starts
      the refund above for the amount asked, with the same checks; declining needs a note, which
      the company's billing managers are emailed within a minute. Before approving, check the
      reason and the payment date: Razorpay may fail a normal refund of a payment older than about
      6 months (R-077), so decline such a request with a note and settle it another way.
      `SELECT status, requested_at, announced_at, decided_at, decline_notified_at, credit_refund_id
FROM app.credit_refund_requests WHERE tenant_id = … ORDER BY requested_at DESC`:
      - **"Approving was refused":** the request no longer fits (the unused credit was spent since,
        a refund of the payment started meanwhile, or the company asked for deletion); the page
        shows the reason and the request stays open. Decline it with a note, or refund a smaller
        amount from the company's platform page and decline the request saying so.
      - **No email about a request:** only platform owners are emailed, once per request, and only
        while it is open (a request withdrawn or decided within the minute is not announced). The
        worker logs `refund requests announced to platform owners`, or `companies asked for refunds
but there is no platform owner to email` (make someone a platform owner; the requests are
        then announced). Emails go through the outbox (section 3).
      - **The company did not hear of a decline:** the worker logs `refund request declines
emailed`, or `refund request decline notice failed for a company; will retry` with the
        company; `decline_notified_at` is set when the email was queued. An approval sends no email
        of its own: the refund's emails follow.
      - **"We asked too often":** a company can ask 5 times in 24 hours (withdrawn requests count,
        and so do requests for refunds of plan payments, ADR-104); the next request is accepted
        once the oldest of those is a day old.
11. **Settlement reconciliation** (`/platform/reconciliation`, ADR-059). Each day from 06:00 India
    time the worker reads Razorpay's settlement report for the previous day and matches every
    transaction. Look at the list once a day; "Need a person" counts what is still open. Platform
    owners are also emailed ("Settlement reconciliation … needs a person" or "… failed", ADR-066)
    within a minute of a day finishing with open transactions or failing, once per attempt; the
    email names only days and counts, so open the page from its link.
    - **No alert came:** alerts go to platform owners only (not operators), for failed days and
      days with open transactions; retrying days wait until they fail for good, and a day whose
      transactions were resolved before the next minute sends none. `alerted_attempt` on the run
      shows the attempt that was emailed. The worker logs `settlement reconciliation alert emailed`,
      or `… no platform owner to email` (make someone a platform owner; the alert then goes out).
      Emails go through the outbox like every other email (section 3).
    - **Recorded by the check:** Razorpay settled a payment or refund HyFib had missed (its webhook
      never arrived); the check fetched it and recorded it the usual way. Nothing to do, but a
      series of them means webhooks are failing: see step 1 and section 4.
    - **Does not match, needs a look, not HyFib's:** nothing was changed. Per reason:
      - _Second payment_: the customer paid the same top-up twice. HyFib credited one payment;
        refund the other in the Razorpay Dashboard (it shows as a refund of an uncredited payment
        on a later day).
      - _Amount differs_, _refund exceeds the payment_, _not captured_: compare the company's
        platform page (Service credit) with the Dashboard and raise an incident before anyone
        changes anything; corrections are compensating postings through a reviewed function.
      - _Payment or refund unavailable_: Razorpay did not return it when asked. Run the day again
        later; if it stays, ask Razorpay support.
      - _Dispute_: a payment or refund HyFib matched or recorded has a dispute (one HyFib had
        missed was recorded first). Check the dispute in the Dashboard. A lost chargeback is
        recorded from `payment.dispute.lost`; if the company's credit does not show it, redeliver
        that webhook.
      - _Adjustment_, _transfer_, _not HyFib's_, _unknown type_, _other currency_, _unreadable_:
        check them in the Dashboard (another integration on the account, Razorpay's own
        corrections).

      Then resolve the item with a note of what was checked or done (platform owners; audited).

    - **A day failed:** the error says why. "Refused HyFib's API keys": fix `RAZORPAY_KEY_ID` and
      `RAZORPAY_KEY_SECRET`, then run the day again (platform owners, with a reason). A day with
      more than 50,000 transactions fails too: raise it with engineering. Failures that may pass
      (timeouts, 5xx) are retried by themselves after 5, 15, 60, 180 and 360 minutes.
    - **Days are missing:** the schedule creates the previous day and fills gaps of up to a week;
      after a longer outage, reconcile the missing days from the form. Running a day again keeps
      what an earlier run recorded and the resolutions.
    - **Payments not seen in a settlement:** a paid top-up whose payment no settlement showed 7
      days after payment. Look the payment up in the Dashboard (on hold, refunded, disputed) before
      doing anything; the list only counts days that were reconciled. Platform owners are emailed
      once about each such payment ("… paid top-ups were not settled within 7 days", ADR-071), with
      the count and the payment days only, and the list shows when. No email: the worker logs
      `unsettled payments alert emailed`, or `… no platform owner to email` (the payments stay due
      until there is one); `ops.settlement_unsettled_alerts` holds the payments emailed.

## 10. Contacts, consent and templates

**A customer says they opted out but still received a template.** Open the contact: the consent
history lists every event with its source and time. Compare with the message's send time in the
conversation. Sends re-check consent right before dispatch, so a template sent after a recorded
opt-out is a defect: collect the message id and the consent event ids (no message text) and open a
security/privacy incident. If the opt-out was never recorded (for example the customer wrote a
sentence rather than a keyword), record it manually with a note.

**A bulk tag edit was refused or changed fewer contacts than expected (ADR-213).** "These filters
now match N contacts" means contacts were added, changed or erased since the page loaded: reload it
and check the matches again. More than 10,000 matches must be narrowed first. A contact that already
has 50 tags keeps them, and the result counts it; remove a tag from it first. Each edit is in the
audit log as `contacts.bulk_tagged` with its counts; each changed contact also appears in the
contact feed and as a `contact.updated` webhook event.

**A bulk field edit was refused or changed fewer contacts than expected (ADR-238).** It is refused
like a bulk tag edit when the matches changed or exceed 10,000, and when the value does not fit the
field's type (the message names the field). Contacts that already had the value are counted, not
changed. Each edit is in the audit log as `contacts.bulk_field_set` with the field's key and its
counts (never the value); each changed contact also appears in the contact feed and as a
`contact.updated` webhook event.

**Erasure request.** A member with `contacts.delete` erases the contact from its page (keep the
number suppressed unless the requester asks otherwise). The action is audited
(`contact.erased`). Data already delivered to Meta is outside our database (see
docs/DATA-RETENTION.md).

**Template stuck in "Submitting".** The worker could not confirm Meta's answer. The next sync
(within 5 minutes) adopts the template if Meta created it; after 10 minutes without a match it is
marked "Submission failed" and can be submitted again. Check worker logs for `template job` and the
`template.submit` / `template.sync` queues; a sync failing permanently is recorded in the audit log
as `templates.sync_failed`.

**Template statuses look stale.** Press "Refresh from Meta" on the Templates page. If the account
shows as not connected, reconnect it in Settings → Channels. Verify that the Meta app is subscribed
to the template webhook fields (docs/META-SETUP.md). A refresh, and a sync Meta's template webhook
asks for, is queued ahead of routine syncs (ADR-178): if statuses still take more than a few
minutes, look at the template.sync queue's oldest wait on Operations → Queues.

**A template send failed with 132015 / 132016.** Meta paused or disabled the template; HyFib marks it
and requests a sync. Improve the template (quality) or use another one; do not resend blindly.

**Import rejected.** Row errors name the row and the problem, never the row's contents. Files must
be under the upload limit and 5,000 rows; split larger files.

## 10A. Campaigns

**A campaign seems stuck ("Sending" with no progress).** The detail page shows why a campaign waits:
a sending window that has not opened, pacing, or a pause reason. Check the worker logs for
`campaign tick` with the campaign id (`outcome` progress, waiting, busy, paused, completed) and the
`campaign.run` queue depth. The per-minute messaging sweep re-signals a running campaign whose next
tick is more than 30 seconds late (`campaign ticks signalled`). Sends then follow the send runbooks
above (message.send queue, unknown outcomes).

**Stop a campaign now (wrong audience or content).** Cancel it from the detail page (members with
`campaigns.send`): pending recipients and queued sends that no worker has claimed are cancelled in
one transaction; sends already handed to Meta cannot be recalled. Pausing instead keeps the
remaining recipients for later.

**Paused by HyFib.** The reason is on the page: template no longer approved (fix or replace the
template, then resume), number inactive (reconnect, then resume), spending or message cap reached
(raise it, then resume), the sending member left or lost permission (another member with
`campaigns.send` resumes it under their name; sends not yet handed to Meta went back to the
campaign and are sent then), or no rate card for the cap's currency (platform staff publish one,
or remove the cap).

**Nobody was emailed when HyFib paused a campaign (ADR-210).** The email goes to the member whose
authority the campaign sends under, while they are active and may send campaigns; otherwise to the
company's active owners and administrators. Pauses by members or keys email nobody. It is queued in
the pause's transaction (`ops.email_outbox`, dedupe key
`campaign-paused:<campaign id>:<version>:<user id>`) and sent by the email worker: check its dead
letters and the email provider as for other notices. Campaigns paused before this release, or by an
old worker during a rollout, emailed nobody; the campaign's page gives the reason in any case.

**Nobody was emailed when a campaign finished (ADR-214).** The email goes to the member whose
authority the campaign sent under, only while they are an active member, when every contact was
handed to WhatsApp or skipped or when its sending period ended. A cancelled campaign emails nobody.
It is queued in the transaction that completes the campaign (`ops.email_outbox`, dedupe key
`campaign-completed:<campaign id>:<version>:<user id>`) and sent by the email worker.

**A member gets an email they turned off, or not one they expect (ADR-215).** Settings →
Notifications shows the member's own choices for that company; `app.memberships.email_opt_outs`
lists the kinds turned off. Choices are per company: a member of two companies sets each. Security,
sign-in and billing emails cannot be turned off. During a rollout an old server may still send an
email that was turned off. The audit log records each change as
`membership.email_preferences_updated`.

**A member cannot open a file a customer sent (ADR-216).** The message says why: the account that
received it is disconnected or Meta refused its token (reconnect it in Settings → Channels; the
daily access check reports the same), WhatsApp no longer keeps the file (it keeps files for a
limited time; there is nothing to restore, since HyFib keeps no copy), or WhatsApp did not answer
(try again, and check the web tier's outbound https to Meta). Safari and iOS do not play recordings
and videos from HyFib: members download them with the link below the player.

**An integration cannot download a file a customer sent (ADR-217).** The JSON error's reason says
why: `no_file` (the message has no file from the customer: check its `direction` and `type`),
`file_expired` (WhatsApp no longer keeps it; integrations should fetch files soon after
`message.received`), `channel_disconnected` or `access_refused` (reconnect the account in Settings →
Channels), `file_too_large` (over 100 MB); a 503 means WhatsApp did not answer, so retry later. The
key needs `conversations.read`.

**A member cannot send a file (ADR-218).** The card says why: the type is not one HyFib sends, the
file is empty or over 16 MB, the window closed (only templates can go), the number or its account is
disconnected (reconnect it in Settings → Channels), or WhatsApp refused the file (its reason is
shown) or did not answer (try again). A 413 from a load balancer before HyFib answers means its body
limit is below the 16 MB HyFib accepts.

**An integration cannot upload or send a file by id (ADR-219).** An upload is refused for its type
or size (422 naming `file`), a number that is not the company's or not active, or WhatsApp refusing
it (422 with its reason). A send by id is refused when the id is not the company's upload, was
uploaded for another number or is of another kind (422 naming `mediaId`), or was uploaded more than
30 days ago (412 `file_expired`): upload the file again. `app.media_objects` rows with an
`api_key_id` and no `message_id` are the uploads.

**Many failures with 131049.** Meta's per-user marketing limit: those customers received too many
marketing messages from businesses. Do not resend; wait at least 24 hours (M-062) and consider the
company's frequency cap.

**Rate card mistake.** Platform staff withdraw the card (with a reason; audited) and publish a
corrected one. Estimates recorded on recipients already queued keep the old price; new estimates use
the card in force when each message is queued.

## 10B. Reports

**A report number looks wrong.** Open "How these numbers are counted" on the Reports page: each
number names its definition (key and version), denominator, window and time-zone rule. Common causes:
delivery statuses or pricing not received yet (Meta webhooks; check webhook ingestion, section 4),
a period that includes today, or the company's time zone (Settings → Company) differing from the
viewer's. Response times start when HyFib received the customer's message; the target and the
business-hours figures count opening hours only when business hours are on (section 10C), other
times are absolute.

**Response times missing for older conversations.** Reply turns are recorded from the release that
added reports (migration 0007); earlier conversations have none. Nothing to repair.

**Estimated charges show unpriced messages.** The report lists why: no billing currency (Settings →
Messaging), no published rate card for the currency and period (platform staff publish one), a
pricing category the card has no rate for, a market missing from the card or an erased recipient.
Estimates never replace Meta's invoice.

**A report is slow or times out.** Reports run under the normal statement timeout. Try a shorter
period (the page allows at most 92 days); check that migration 0008's
`app.messages_tenant_created_idx` exists and is valid (`\d app.messages`); record the company and
period for the materialised-aggregate follow-up (ADR-026).

## 10C. Inbox routing, business hours and CSAT

**New conversations are not being assigned.** Check, in order: the conversation's team (inbox
filter or thread) and that the team assigns round robin (Settings → Teams); that at least one team
member is available (Settings → Teams shows who is taking conversations) and below the team's limit
of open conversations; that the member is active and has a role that can answer (owner,
administrator, supervisor, agent). Waiting conversations are picked up within a minute by the
messaging sweep (worker log "waiting conversations assigned") or immediately when a member becomes
available. The audit log records each decision as `conversation.routed` (rule `keyword` or
`number`). A conversation that already has an assignee is never re-routed.

**A reply timer or "overdue" looks wrong.** Timers use the company time zone (Settings → General)
and, when business hours are on, only the opening hours and closed days in Settings → Inbox. A timer
shown as paused resumes at the next opening. Reports apply the current calendar to past periods.

**CSAT surveys are not sent.** Each resolve records a survey with a reason when nothing was sent
(Reports → CSAT lists the reasons): the 24-hour window had closed, the customer opted out or the
number is suppressed, the contact was erased or has no phone number, the WhatsApp number is inactive,
or the customer was asked in the last 24 hours. A survey that was queued but failed shows Meta's
error on the message in the thread (for example a consent change before dispatch: `opted_out`).

**A member was not emailed about a mention (ADR-211).** The email goes 10 minutes after the note,
only if the member has not opened the conversation since (opening it marks their mentions read), is
still active and can still see it (an agent loses sight of a conversation assigned to someone else),
and the mention is less than a day old; of several unread mentions in one conversation only the
newest one emails. Mentions while the company was suspended are not emailed. The worker logs
`mention email` with the mention id and the outcome (`sent`, `read`, `cannot_see`, `newer`, `gone`,
`too_late`, `already_sent`); a sent one is in `ops.email_outbox` with the dedupe key
`note-mention:<mention id>`, and is then the email worker's (dead letters, the email provider). A
note added while the `note.mention` queue did not exist fails: run the migration job.

**A member cannot download a conversation's transcript (ADR-212).** It needs `inbox.export` (owners,
administrators and supervisors; agents do not have it) and a conversation the member can see;
otherwise the conversation page shows no "Download transcript" link and its address answers with a
403 or a 404. Each download is in the audit log as `conversation.transcript_exported` with the
conversation's id. A transcript leaves internal notes out by design; a download cut short mid-file
is logged by the web server as `transcript export failed mid-stream`, so download it again.

**A member cannot tag a conversation (ADR-220).** Tagging needs `inbox.reply` and a conversation the
member can see (agents see those assigned to them and the unassigned ones). A conversation takes at
most 20 tags of up to 40 characters, without commas, and the conversation of an erased contact takes
none ("This contact was erased."). The inbox's Tag filter offers only the tags on conversations the
member can see, so two members may be offered different tags.

**An integration's tag change is refused (ADR-221).** 422 naming `addTags` means a tag that cannot
be one (over 40 characters, or with a comma) or a conversation that would have more than 20 tags
(the message names it; the call changed nothing); `removeTags` means the same tag both added and
removed; `tag` means a filter value that cannot be a tag. Conversations of erased contacts are not
found. Each change is in the audit log as `conversation.tags_changed` with the counts.

**An automation did not tag a conversation (ADR-222).** The run's step log says why: "the
conversation already has the maximum number of tags" (20), or "the contact was erased". A run that
failed as `version_unreadable` right after a deploy was read by a worker of the previous release:
roll the workers out, then start the run again.

**Customers do not see that their messages were read (ADR-223).** Settings → Inbox, "Read receipts
and typing", must be on. A receipt is queued when a member opens a conversation with unread
messages, for the customer's latest message; the worker logs each job as `read receipt` with its
outcome (`off`, `contact_erased`, `channel_inactive`, `account_disconnected`, `rejected` with what
Meta said). Jobs that kept failing are in the dead letters of the `message.read` queue. Typing
indicators are queued only inside the 24-hour window, at most every 20 seconds per composer.

**A merge is refused, or a contact is missing after one (ADR-224).** The review page says why a
merge cannot be done; the function refuses the same cases again in fixed sentences, and a message to
the merged contact being sent asks for a minute's wait. A merged contact is deleted: its old link
leads to the contact it was merged into (`app.contact_merges`), and the audit log has
`contact.merged` with the counts moved. A merge cannot be undone; a mistaken one is corrected by
hand (a number moved back by a member, consent recorded again with evidence).

**An integration still has a merged contact (ADR-225).** Endpoints that take `contact.merged` are
sent one event per merge, with `mergedContactId` and the contact it belongs to now; the contact
endpoints of the API answer the merged id with 404, reason `contact_merged`, and `mergedInto`;
`GET /contact-changes` lists `mergedContactIds` on the kept contact. Events of the merged contact
not yet delivered at the merge end as `event_gone` (Settings → Webhooks shows them as failed). A
receiver that still holds the merged contact deletes its copy or moves what it keeps to the kept
contact.

**A member sees customers' numbers masked, or whole when they should not (ADR-226).** Settings →
Security lists the roles whose members see numbers masked; owners and administrators always see them
whole, and a member with another role that is not masked sees them whole too. A change applies to
the next page the member opens. The audit log has `tenant.number_masking_updated` with the roles
before and after. Masked members find contacts, conversations and orders by a whole number only.
Numbers customers wrote in messages, and those the public API and webhooks carry, are not masked.

**Migration 0148 or 0149 failed.** They build `app.campaign_recipients_contact_idx` and
`app.automation_runs_contact_idx` concurrently. If one failed, an INVALID index can remain: run
`DROP INDEX CONCURRENTLY app.campaign_recipients_contact_idx;` (or
`app.automation_runs_contact_idx`) and run the migrations again.

**Migration 0155 failed.** It builds `app.conversation_turns_open_started_idx` concurrently. If it
failed, an INVALID index can remain: run
`DROP INDEX CONCURRENTLY app.conversation_turns_open_started_idx;` and run the migrations again.

**Members were not emailed about an overdue reply.** Emails go only to companies with a
first-response target (Settings → Inbox), once per wait, after its due time (in business hours when
they are on). `app.overdue_reply_notices` for the turn says what happened: no row (not due yet, or
the worker's sweep has not run), `waiting` (due at `due_at`, business hours), `skipped` with
`too_late` (due more than a day before the sweep saw it), `no_one` (no active member could answer
it) or `opted_out` (every member responsible turned these emails off), or `sent` with the members
emailed. The worker logs `overdue replies` with counts, and
`overdue reply emails failed; will retry` with the company when a pass failed.

**Migration 0010 failed.** It builds `app.conversations_team_idx` concurrently. If it failed, an
INVALID index can remain: run `DROP INDEX CONCURRENTLY app.conversations_team_idx;` and run the
migrations again.

## 10D. Automations

**A customer got no automated reply.** A run starts only when all of these hold: the automation is
active with a live version and uses the number the message arrived on (or any number); the
conversation is unassigned and no other run is handling it; the company is active (not suspended);
the message matches the trigger (keywords are compared as whole words, ignoring case and
punctuation); the business-hours filter and the cooldown allow it; fewer than 10 runs started in
that conversation in the last hour; and the message is not an opt-out keyword. Automations → Runs
lists every run with its outcome, and a failed run's page names the reason (for example the 24-hour
window had closed or the WhatsApp number is not active).

**A run looks stuck.** The run page shows the current step and whether it waits for a reply or a
timer, and until when. A run waiting for a reply continues when the customer answers or at the
deadline. A running run whose next step is more than 30 seconds overdue is signalled again by the
minute sweep; the worker logs each attempt as "automation run advanced" with its outcome. If
nothing happens, check that the worker runs and the `automation.run` queue drains (section 3), and
that the company is not suspended: its runs wait ("automation run deferred") and resume after
reactivation, and a run older than 7 days then fails as expired. A step that raises an error fails
its job (pg-boss retries it and keeps the error; the worker logs it too) and is counted on the run;
after five failed attempts in a row the run fails with "a step failed repeatedly because of an
internal error" (`step_error`) and the conversation goes to people. Find the error in the worker
log before publishing again.

**Stopping automations.** One run: a member takes the conversation over from the inbox (replying,
assigning or resolving also ends the run), or a member with publish permission stops it from the
run page. The conversation goes to people and bot messages not yet claimed by a send worker are
cancelled (`bot_stopped`). New runs: Pause the automation (runs in progress finish). Everything at
once: Archive (runs in progress stop and their conversations go to people). Each action is audited
(`automation.*`).

**Budgets and failed sends.** A run fails, and hands the conversation to people, when it exceeds
200 steps, enters one step 20 times, sends 50 messages or runs longer than 7 days, or when a
message cannot be queued (number not active, 24-hour window closed, no WhatsApp id for the contact).
After queuing a message the run waits for Meta to accept it before its next step (the run page and
the inbox banner say "sending"); the send worker signals the run as soon as the send is settled. A
message Meta rejects, one that is cancelled, one whose outcome is unknown (the send worker never
resends those), one not accepted within 10 minutes (it is then cancelled if no send worker has
claimed it), or a failure Meta reports later for a message of an active run ends the run as "a
message did not reach the customer" (`send_failed`, with Meta's error code or the reason in the
detail) and passes the conversation to people. Meta's error is also shown on the message in the
thread. A failure Meta reports after a run has already ended (for example after a completed run's
last message was accepted) is shown on the message only; the run's recorded outcome does not change.

**A web request step failed or its outcome is unknown.** The run page lists each call (method,
host, path, outcome, duration) and the step log names the reason. A status code means the server
answered (only 2xx counts as success). `domain_not_allowed`, `secret_missing` and
`secret_domain_mismatch` mean the company's current settings refused the call before it was made
(Settings → Web requests: the domain was removed, or the secret deleted or saved for another
domain). `address_blocked` means the name resolves to a private or reserved address, which is never
allowed; `dns_failed` (including a name that did not resolve within the 10-second deadline) and
`connect_failed` (no checked address accepted a connection) mean nothing was sent. `timeout`, `network_error` and
`no_result` mean the request may have reached the server without a complete answer: the outcome is
unknown and the call is never repeated automatically, because the server may have acted on it
(creating an order, say). Ask the company to check on their side, then take the conversation over
if needed. `not_started` means the worker did not get to the call before the run's two-minute
deadline (a backlog, a worker outage or a suspended company); it was not sent.
`run_ended_in_flight` means the run ended (take-over, stop, resolve, archive, opt-out) while the
call was being made, so its outcome is unknown; after an erasure the code is `contact_erased`. Worker log lines
"automation HTTP call" carry the call id and outcome, never the request, its headers or the
response.

**Web requests are slow or piling up.** Each call holds a worker slot for at most 10 seconds. Check
the `automation.http` queue (section 3) and the worker log; a call still queued 30 seconds after it
was recorded is signalled again by the minute sweep, and a call past its run's deadline is cancelled
rather than sent late. Loopback and http:// targets are refused in production: the web and worker
refuse to start with `W360_EGRESS_ALLOW_LOOPBACK` outside `APP_ENV=local|test`.

**A secret may have leaked.** Replace it at its source (the company's API), then save the new value
under the same name in Settings → Web requests (the version increases; steps keep working), or
delete it to stop every step that uses it. The audit log shows who created, replaced or deleted
secrets and domains (`http.*`). Values are never shown, so a leak points at the receiving server
(one that echoes request headers, for example) or at the keyring (section 13).

**Worker restarts and deploys.** Runs are rows, so a restart delays steps but never loses or repeats
one: queued `automation.run` jobs continue, and runs whose signal was lost are picked up by the sweep
within about 90 seconds. A test run stops when the member who started it leaves the company ("test
run tester removed") or no longer holds `automations.write` and `inbox.reply` (the run page says so).

**Retention.** The minute sweep clears captured answers 30 days after runs end and deletes runs
(with their step logs) 180 days after they end ("automation retention applied").

**Migration 0014 or 0015 failed.** Like 0011, they replace definer functions through
`SET ROLE w360_definer` (0014: `app.erase_contact` and `ops.apply_automation_retention`; 0015:
`app.erase_contact` again) and apply nothing on failure.

**Migration 0011 failed.** It runs in one transaction, so a failure applies nothing. It drops and
recreates the definer functions `app.erase_contact` and `ops.conversations_to_route` through
`SET ROLE w360_definer` (ADR-039): a failure mentioning ownership or `SET ROLE` means the migration
role cannot act as `w360_definer` (see `infra/db/bootstrap-roles.sql`). Fix the cause and run the
migrations again.

## 10E. CRM

**A task reminder was not emailed.** The tasks page shows each reminder's state: "Reminder set"
(pending), "Reminder emailed" or "Reminder not sent" with the reason — the task was closed first,
the assignee can no longer use the CRM (left the company, suspended, or their role lost
`crm.read`), or it was more than a day late (the company was suspended or the worker was down for
over a day). A pending reminder is signalled by a job at its time and again by the minute sweep
once it is more than 30 seconds overdue; the worker logs "task reminder" with the outcome
(`sent`, `skipped`, `not_due`, `idle`). If reminders stay pending, check that the worker runs, the
`crm.reminder` queue drains (section 3) and the company is not suspended ("task reminder
deferred"). If the state is "Reminder emailed" but nothing arrived, follow the email outbox
(section 5 for SMTP outages): the reminder is queued once, and the outbox retries delivery. To send
another reminder, edit the task and set a new reminder time.

**A pipeline cannot be archived or a stage cannot be removed.** Pipelines and stages with open
deals are kept so no open deal loses its place: move the deals (or mark them won or lost) first.
Closed deals stay in archived stages and pipelines and still count in reports. Reopening a closed
deal whose stage was removed puts it in the pipeline's first stage (the timeline shows the stage
change); a deal in an archived pipeline reopens once the pipeline is restored. Restoring a pipeline
fails if another pipeline in use has its name; rename one first. A company can use 20 pipelines at
once.

**"Someone else changed this" on a deal or task.** Every deal and task carries a version, and a
change made from a stale page is refused instead of overwriting another member's change. Reload
the page and make the change again.

**Deal values.** Values are stored exactly, in the pipeline currency's minor unit, and a
pipeline's currency cannot be changed (create a new pipeline instead). Reports never add values in
different currencies; they list a total per currency.

**Migration 0013 failed.** It runs in one transaction, so a failure applies nothing. It replaces
the definer function `app.erase_contact` through `SET ROLE w360_definer` (ADR-039) like 0011: see
that section.

## 10F. Growth tools

**A chat link shows "This chat link is not available".** The short link answers 404 when the link
is archived (restore it on its page), its number is not active (Settings → Channels; a number that
needs reconnecting stops its links until it is active again), or the company was deleted. A
suspended company's links keep working, as do those of a company waiting for deletion (ADR-055). The link page shows a warning in the first two cases.
Unknown or mistyped addresses answer the same page. Nothing is logged about the visitor.

**Clicks look too high.** Counts include every open of the short link and its QR code: repeated
clicks by one person and automated visits (link previews in chat apps and social networks,
crawlers, security scanners) all count, because nothing about the visitor is kept to tell them
apart (ADR-044). Compare conversations from the link instead. Counts cannot be edited or reset.

**Conversations from a link are not counted.** A conversation counts when the customer's message
contains the whole marker "(ref ABC234)" (any case) and arrives on the number the link opens. It
does not count when the customer deleted or changed the marker, sent it to another of the company's
numbers, sent it inside a photo caption or other media, or when the link was created with the
reference code switched off (the list shows "—"). The direct wa.me link skips the click count but
still carries the code.

**The website button does not appear.** Check, in order: the button is shown (not hidden) and not
deleted; its link is not archived and its number is active (the Website button page shows a badge
for both); the site's Content Security Policy allows the app origin in `script-src`; the tag is on
the page (`/widget/<id>.js` returns a script, not the 404 comment). Browsers may keep the previous
script for up to five minutes, so changes and removals reach visitors within five minutes. The
script adds one button per page even if the tag appears twice.

**A click-to-WhatsApp ad is not listed under Growth → Ads.** Only messages whose webhook carries a
`referral` object are counted (Meta includes it on the message a customer sends from the ad); ads
are not synced from an ad account, and ads with no conversation in the last 30 days are not
listed. The inbox shows "Came from the ad …" on attributed conversations. Ad click ids are never
stored, so conversions cannot be reported back to Meta.

**Migration 0016 failed.** It runs in one transaction, so a failure applies nothing. It replaces the
definer function `app.erase_contact` through `SET ROLE w360_definer` (ADR-039) like 0011 and 0015:
see that section. It adds policies and column grants for `w360_definer` on `app.channel_accounts`
and `app.messages`; a failure there usually means the bootstrap roles are missing
(`infra/db/bootstrap-roles.sql`).

## 10G. WhatsApp Flows

**A flow stays on "Sending to Meta…" (or another operation).** The flow page shows the operation and
when it was requested. The `flow.sync` worker retries Meta's temporary failures five times over
about 15 minutes; the minute sweep signals operations waiting for more than two minutes again and
marks those older than 30 minutes failed ("did not finish within 30 minutes"), which the member can
try again. Check the worker log for `flow job` lines with the flow id and outcome, and that Meta is
configured (without it the worker does nothing and says "Meta is not configured"). Jobs of a
suspended company are dropped and picked up by the sweep after reactivation.

**"Meta did not accept the change".** The message is Meta's own (title or detail, trimmed). A
credential problem says to reconnect the WhatsApp account. Validation problems in the Flow JSON are
not failures: they are listed on the flow page with line and column, and publishing waits until
Meta reports none. A failed delete that says Meta could not read the flow usually means it was
already deleted in WhatsApp Manager: archive it in HyFib.

**Two flows appeared at Meta for one draft.** It should not happen: the name at Meta ends with
"(w360 " and the first eight characters of the flow's public id, and the worker adopts a flow with
its reference instead of creating another after a lost response. A copy made by hand in WhatsApp
Manager keeps the reference in its name; rename or delete it there.

**The encryption key is not valid on a number.** The flow page lists each number with the key's
state. "Uploading…" clears within minutes (the sweep retries uploads pending for more than two
minutes). "Failed" shows the reason: the account is not connected (reconnect it), the number is not
active, or Meta reports a signature mismatch or a different key for the number (another system may
have uploaded its own key: use "Upload the key again", and stop the other system from replacing it).
New numbers of the account get the key automatically. Replacing the key keeps the previous one
working for 24 hours.

**Customers see "This form is no longer available".** The token of that message was not issued by
HyFib for this flow, is older than 30 days, or belongs to an erased contact: send the form again.
"This form is not available right now" means the company is suspended. Other failures answer 500
(what WhatsApp then shows the customer is not documented in our research); the web log has a
`flow endpoint request` line with the outcome: `endpoint_not_set`, `endpoint_domain_not_allowed` (add the domain in Settings → Web
requests), `endpoint_secret_missing`, `endpoint_secret_domain_mismatch` (the secret now belongs to
another domain), `endpoint_failed` with the company's status or the egress code, `endpoint_answer_not_json`
or `endpoint_answer_too_large` (over 64 KB). `decrypt_failed` (421) makes WhatsApp fetch the key
again; if it persists, check the number's key state. `bad_signature` (432) means the request was not
signed with the current or previous app secret.

**Answers were not saved on the contact.** Each completed form lists what happened to every answer:
saved, not answered, not saved (with the reason, for example an invalid email or a value that does
not fit the field's type) or skipped (the answers could not be read or were too large, or the form
was completed by someone other than the contact it was sent to). Answers are always kept with the
completed form, and saving them never changes consent.

**Migration 0017 failed.** It runs in one transaction, so a failure applies nothing. It replaces the
definer function `app.erase_contact` through `SET ROLE w360_definer` (ADR-039) like 0011, 0015 and
0016, and adds two definer functions (`ops.flow_endpoint_target`, `ops.flow_work_due`) with column
grants for `w360_definer` on the flow tables and `app.channel_accounts`; a failure there usually
means the bootstrap roles are missing (`infra/db/bootstrap-roles.sql`). The `flow.sync` and
`flow.keys` queues are created by `pnpm db:migrate` with the other pg-boss queues.

## 10H. Commerce

**A catalog read failed or shows no products.** Commerce → Catalogs shows the read state and the
error. "Meta refused access to the catalog" (Graph errors #10 and #200–#299) usually means HyFib's
Meta app lacks catalog access for the account (`catalog_management` is expected but not confirmed,
research M-173): check the app's permissions and the account's Login for Business grant, then use
"Read from Meta". "Meta reported no catalog connected" means no catalog is connected to the
WhatsApp account in Commerce Manager. A read that waits more than five minutes is signalled again
by the minute sweep and fails after 30 minutes; the worker log has `commerce job` lines with the
account id and outcome. Catalogs are read again every day. Only the first 5,000 products of a
catalog are read (the page says so).

**An order shows "Product not in your catalog copy" or no total.** Names come from HyFib's copy of
the catalog: read it again. The total is unknown when a price in the webhook had more decimals than
its currency, the items were in different currencies, or HyFib could not read an item of the cart
(the order page says how many; ask the customer to send the cart again); payment cannot be requested for such an
order (the amounts WhatsApp sent are shown per item).

**"Your Razorpay account has not been checked successfully".** Commerce → Payments shows the check.
"Razorpay rejected the key id or secret" means the keys are wrong, revoked or from the other mode:
the company saves them again. Checks that could not reach Razorpay are retried three times; saving
the keys again starts a new check.

**A Payment Link stays "Being created".** The `commerce.link` worker creates it with the company's
keys and retries while Razorpay cannot be reached (five attempts over about 15 minutes); the sweep
signals due links every minute. A create whose answer was lost is found again by its reference, so
it never creates a second link. "Not created" shows Razorpay's reason (for example keys rejected).

**The customer paid but the order is still waiting.** HyFib records a payment only from the link as
Razorpay reports it: every 15 minutes on the link's first day, then every six hours, and at once
when the company's Razorpay account notifies HyFib. Check the link at Razorpay (Dashboard →
Payment Links): partly paid links do not mark the order paid (HyFib asks for the full amount). If
notifications do not arrive, the web log shows `payment link webhook` lines with the outcome:
`bad_signature` (the webhook secret in Razorpay differs from the one saved in HyFib; the company
saves the same secret in both), `unknown_account` (the address is wrong), `no_open_link` (the link
is already settled) or `duplicate` (a redelivery). Payments are still recorded by the scheduled
checks.

**"Razorpay returned no https address".** The link exists at Razorpay but HyFib had nothing to
send: cancel it on the order page and request payment again.

**"The link was created but not sent".** The customer service window had closed, the number was not
active or the contact has no phone number: the order page shows the link's address to copy and send
another way (a template, or a reply after the customer writes again).

**Cancelling did not cancel.** Razorpay refuses to cancel paid or partly paid links (research R-109);
HyFib then records what Razorpay reports (the order becomes paid when the link is paid in full).
Refunds are made in the company's Razorpay Dashboard; HyFib does not change the order for them.

**Migration 0018 failed.** It runs in one transaction, so a failure applies nothing. It replaces
`app.erase_contact` through `SET ROLE w360_definer` (ADR-039) like 0011 and 0015–0017 and adds two
definer functions (`ops.commerce_payment_webhook_target`, `ops.commerce_work_due`) with column
grants for `w360_definer`; a failure there usually means the bootstrap roles are missing
(`infra/db/bootstrap-roles.sql`). The `commerce.sync`, `commerce.link` and `commerce.account` queues
are created by `pnpm db:migrate`.

## 10I. Store connectors (Shopify, WooCommerce)

**"Shopify is not set up for HyFib yet".** The web has no `SHOPIFY_CLIENT_ID`,
`SHOPIFY_CLIENT_SECRET` and `SHOPIFY_API_VERSION` (both web and worker need them; the worker logs
"Shopify is not configured" at start). See `docs/DEPLOYMENT.md` "Shopify app".

**Connecting a Shopify store ends on "could not be verified or has expired".** The web log has a
`shopify callback refused` line with the reason: `bad_signature` (the app secret in HyFib differs
from the app's, or the callback is older than 90 seconds: check both servers' clocks),
`unknown_state` (the approval took over 15 minutes, or the page was used twice) or `bad_request`.
"Only the member who started connecting a store can finish it" means another account was signed in
when Shopify sent the member back. In each case the member starts again.

**A store is stuck on "Waiting for approval".** The owner never finished the approval (Shopify or
WordPress). The handshake is deleted an hour after it expired (15 minutes) when the store was never
connected; "Connect again" starts a new one. For WooCommerce, the web log has
`woocommerce key handover` lines: `not_read_write` (the owner approved without write access, or the
site sent other permissions) or `unknown_handshake` (too late, or already used). WooCommerce
deletes keys HyFib did not accept.

**A store is stuck on "Connecting".** The `commerce.store` worker finishes the connection (worker
log `store job` lines with the store id and outcome). It retries while the store cannot be reached
and fails the store after 30 minutes with "HyFib could not reach the store to finish connecting".
Other messages name the cause: "Shopify did not grant read_orders and read_products" (the merchant
declined some access), "WooCommerce refused the keys", "No WooCommerce REST API answered at this
address" (wrong address, or the site lacks pretty permalinks), "HyFib cannot connect to this
address" (the egress client refused it: private addresses, redirects, http outside local and test).

**A store "Needs attention".** The store page shows why. "Shopify refused HyFib's access" or "no
longer accepts HyFib's access" means the token or refresh token stopped working (uninstalled,
access revoked, or the refresh token expired after about 90 days without a read, research SH-007):
connect again. "WooCommerce refused the keys (they may have been revoked or lack Read/Write
access)" means the key was revoked or its WordPress user lost rights: connect again with new keys.

**Orders stop updating.** The store page shows the last read and the next one (hourly), changes
waiting to be read, and "Webhooks last checked" (six-hourly). A read error is shown as "The last
read did not finish" and retried in five minutes; Shopify throttling (research SH-011) only delays
the next read. "Read the store now" asks for a read at once. The web log has `shopify webhook` or
`woocommerce webhook` lines with the outcome: `bad_signature` (Shopify: the app secret differs;
WooCommerce: the webhook was not created by HyFib or its secret was edited — remove the store and
connect it again), `no_store`, `duplicate` or `fetch_signalled`. WooCommerce disables a webhook after
more than five failed deliveries and never retries it (WC-018): the six-hourly check re-enables it,
and the hourly read catches up meanwhile. "The keys cannot manage webhooks" means Read-only keys:
reads still run hourly.

**Orders show no customer name, number or email.** Shopify did not share protected customer data
(the store page says so, research SH-020): HyFib's Shopify app needs Shopify's approval for those
fields. Or the details were removed: a customer's redaction request or a contact erasure (the orders
page shows "Details removed"). Numbers without a country code are linked to contacts only after the
company sets a calling code on the store page.

**Only part of the products are there.** HyFib keeps the first 20,000 products of a store (the
store page says when a copy is incomplete); orders are not limited.

**The merchant uninstalled HyFib in Shopify.** The store shows "Uninstalled in Shopify": reads stop
and the access is dropped; the orders stay until Shopify's `shop/redact` (about 48 hours later,
research SH-027) or until the company removes the store. "Connect again" installs HyFib again.

**A Shopify data request arrived.** The store page lists it with the customer's email or number and
the orders Shopify named. Answer the customer within 30 days with what HyFib holds (the orders page
searches by email or number), then mark the request answered; the customer's details on the request
are cleared.

**Removing a store did not finish.** Removal waits up to 30 minutes for the store (Shopify
uninstall, or deleting HyFib's WooCommerce webhooks), then deletes the store anyway; the audit entry
`commerce.store_removed` says `remote: done`, `no_access` or `unreachable`. For WooCommerce, the
owner must also revoke the key in WooCommerce → Settings → Advanced → REST API (the API cannot).

**Migration 0019 failed.** It runs in one transaction, so a failure applies nothing. It replaces
`app.erase_contact` through `SET ROLE w360_definer` (ADR-039) like 0011 and 0015–0018 and adds four
definer functions (`ops.commerce_store_by_shop`, `ops.commerce_store_by_webhook`,
`ops.commerce_store_by_connect`, `ops.commerce_store_work_due`) with column grants for
`w360_definer`; a failure there usually means the bootstrap roles are missing
(`infra/db/bootstrap-roles.sql`). The `commerce.store` queue is created by `pnpm db:migrate`.

## 10J. Order messages (messages on store events)

**A customer did not get an order message.** Open the store's Messages page (Commerce → Stores → the
store → Order messages): the report lists the last 30 days with the status and, for "Not sent", the
reason; the order page lists the order's messages. The reasons:

- "saw this more than 48 hours after it happened" — the store was disconnected, failing or its
  webhooks were lost and the event was found late (by the hourly read); HyFib does not send stale
  updates.
- "A test order" — Shopify test orders are messaged only when the store's setting allows it.
- "The message for this event was switched off" — the rule was off at send time, or was switched off
  and on again after the event (a rule never messages about what happened before it was switched on).
- "Nobody has confirmed that this store's customers agreed" — the opt-in confirmation was withdrawn.
- "The order has no phone number" — the store gave no number, it had no country code and the store
  has no calling code set (store page), or Shopify withheld customer data (protected customer data,
  research SH-020).
- "opted out", "suppression list", "erased", "has not opted in" (marketing templates) — consent, as
  for any business-initiated message.
- "The template is not approved", "The WhatsApp number is not active", "The template's variables or
  buttons changed" — fix the template or number, then set the rule up again.
- "A template variable had no value" — the order had no value for a field chosen without a fallback
  (for example the tracking number of an order shipped without one).

A message shown as "Not delivered" was sent to WhatsApp and failed there: Meta's error is shown in
the report and in the conversation, as for any failed message. Worker logs have `store message`
lines with the outcome and reason.

**Nothing is recorded for new orders.** Check that the rule is on (the Messages page), that the store
reads orders (store page: last read, webhooks), and that orders reach HyFib: an order placed before
the rule was switched on, or already in the copy, never gets a placed message. Order messages are
found when HyFib reads an order, so a webhook outage delays them until the hourly read (and the
48-hour limit applies).

**Messages wait.** "Waiting" messages show when they are due: the rule's delay after the event, moved
to the start of the store's sending hours when outside them (company time zone). The minute sweep
signals due messages whose job was lost; a suspended company's messages wait until it is reactivated.

**Delivered messages come late or not at all (Shopify).** Deliveries are found by reading orders in
transit again every three hours for 14 days after shipping (research SH-034); the store job must be
running (store page: last read). Only fully shipped orders whose shipments are all delivered count.
WooCommerce has no delivered status.

**A customer's cash on delivery answer is missing.** Only taps on the message's own buttons, from the
same customer and conversation, count; the newest answer wins. The template's two chosen buttons
must be quick replies (the rule says which confirms and which cancels). HyFib does not change the
order in the store: cancel it there. A cancellation reopens the conversation; a confirmation does
not.

**Migration 0020 failed.** It runs in one transaction, so a failure applies nothing. It replaces
`app.erase_contact` through `SET ROLE w360_definer` (ADR-039) and adds
`ops.commerce_store_messages_due` with column grants for `w360_definer`; a failure there usually
means the bootstrap roles are missing (`infra/db/bootstrap-roles.sql`). It also redefines the
`contacts.source` check to allow `store`. The `commerce.store-message` queue is created by
`pnpm db:migrate`.

## 10K. Cart reminders (Shopify checkouts)

**A customer who left a checkout got no reminder.** Open the store's Order messages page: the Cart
reminders card shows read errors and the report table lists each reminder with its checkout,
status and reason. The reasons specific to cart reminders:

- "The customer completed the checkout", "An order with the same number was placed…" — the customer
  bought; nothing is sent (an order counts from when the checkout began).
- "More than 3 days passed since the checkout was left" — the reminder could not go out in time (the
  store was disconnected, the company suspended, or the sending hours and delays added up).
- "The first reminder was not sent, so the second one is not either" — the second reminder follows
  only a sent first reminder.
- "has not opted in" — cart reminders are marketing: the customer needs a marketing opt-in in HyFib
  (Settings → Consent decides whether it is required), or the store consent setting must be on and
  Shopify must record the customer as subscribed.
- "as many marketing messages as the company allows" — the company's marketing frequency cap
  (campaign settings), shared with campaigns.
- "Cart reminders need an approved marketing template" — the template's category changed at Meta;
  choose a marketing template again.

No row at all means HyFib never saw the checkout with a number: checkouts are read every 15 minutes
while a cart reminder is on ("Read the store now" reads them at once), only those updated since the
first reminder was switched on, and only checkouts with a phone (the customer's default phone needs
customer access and the store consent setting; otherwise the shipping or billing phone). Shopify
may withhold phones (protected customer data, SH-040).

**"Reading checkouts: …" on the card.** The read failed and is tried again every 15 minutes; orders
keep syncing. An access error may mean that the staff account that approved HyFib lacks Shopify's
"manage abandoned checkouts" permission (research SH-037 says so for staff calls; whether it applies
to HyFib's offline token is unconfirmed) or that the app's protected customer data access is not
approved: fix it in Shopify, then "Read the store now".

**Customer access.** "Allow customer access in Shopify" asks Shopify for `read_customers` for that
store only; the manager approves it in Shopify and returns to the store's page, and the worker
exchanges the approval within a minute. If Shopify does not grant customer access, the store keeps
working without it and the card
says why (for example "Shopify did not grant access to customers"). The store consent setting
needs that access, Shopify's 2026-07 API (`SHOPIFY_API_VERSION`) and a manager with
`contacts.write`.

**Consent looks wrong.** Consent a store recorded appears on the contact page as "Recorded by the
store" with Shopify's time; the newest consent from any source counts, so a later STOP keyword or a
member's opt-out wins, and a later Shopify unsubscription wins over an earlier opt-in. Only
subscribed and unsubscribed states with a time are imported; HyFib never writes consent to Shopify.
Turning the setting off stops future imports and keeps what was recorded.

**The recovery numbers look low or high.** A checkout counts as recovered only when Shopify reports
it completed after one of its reminders was handed to WhatsApp (failed or unconfirmed reminders do
not count), within the last 30 days; the value is the checkout's total. It is not revenue
attribution: the customer may have come back anyway.

**Migration 0021 failed.** It runs in one transaction, so a failure applies nothing. It replaces
`app.erase_contact`, `ops.commerce_store_by_connect` and `ops.commerce_store_work_due` through
`SET ROLE w360_definer` (ADR-039), with column grants and a policy for `w360_definer` on
`commerce_store_checkouts`; a failure there usually means the bootstrap roles are missing
(`infra/db/bootstrap-roles.sql`). It also redefines the consent source and store message event checks.

## 10L. Store events in automations

**An order rule set to start an automation started nothing.** The store's Order messages report
shows "Automation started" with a link to the run, or "Not sent" with the reason; the order page
lists the same. The reasons specific to automations:

- "The automation was paused or archived, or its live version no longer starts from order
  messages" — publish a version whose trigger is "An order event in a store" and keep the
  automation active. The rule keeps pointing at the automation meanwhile.
- "The WhatsApp number is not active or does not match the template" — also shown when the live
  version is limited to another number than the rule's.
- "A team member was handling the conversation with the customer" — the conversation was assigned;
  automations never interrupt members.
- "Another automation was handling the conversation with the customer" — one run per
  conversation; the order is not queued behind it.
- "Automations had already started too often in this conversation within the hour" — at most 10
  runs per conversation per hour, whatever started them.
- "suppression list", "opted out", "erased" — checked before the run starts; each template step
  checks consent for its own template's category again.

**The run started but the customer got nothing, or not everything.** Open the run (from the report,
or Automations → Runs). A template step that cannot be sent ends the run as "A message could not be
sent" with the reason:

- "the template's variables or quick-reply buttons changed after the step was set up" — choose the
  template again in the step (the automation lists the problem) and publish a new version.
- "the template is no longer approved…", "the WhatsApp number is not active or does not match the
  template" — fix the template or the number; the automation lists the problem too.
- "a template variable was empty after filling in placeholders" — an order field had no value (a
  tracking number before shipping, for example), the order was deleted, or its customer was
  redacted or erased. Use the fields the event always has.
- "has not opted in", "as many marketing messages as the company allows" — marketing templates
  follow the campaign rules: marketing opt-in and the company's frequency cap.

A template step whose company lock is held by the campaign runner tries again every 2 seconds until
the lock is free; during a large campaign send the run's next step time moves forward without new
step log lines. That is expected.

**The customer's tap did nothing, or went to "Other reply".** A tap counts only on the template
message of the step the run is waiting on, in the same visit of that step; taps on older messages,
of another run or of another step follow the step's "Other reply" path (or end the run when it has
none). Typing a button's title counts as tapping it. After the step's timeout the run has followed
the timeout path, and once the conversation is assigned, taken over or resolved again, the run has
stopped.

**Publishing is refused with "WhatsApp allows only templates until the customer replies".** An
automation started by order messages begins outside the 24-hour window, so every path must send a
template (and get the customer's reply) before any other message; continue from the reply branches
of an "Ask with a template" step. The hand-off warning means people see the conversation only once
the customer writes.

**Migration 0022 failed.** It runs in one transaction, so a failure applies nothing. It replaces
the trigger function `app.guard_automation_run` (an ordinary trigger function, not SECURITY DEFINER),
adds the run's order reference and event, the rule's action and automation, the store message's run,
their checks and foreign keys, and column grants for `w360_app`. The new columns start empty, so the
new checks hold for existing rows; a failure usually means the bootstrap roles are missing
(`infra/db/bootstrap-roles.sql`).

## 10M. Plans and entitlements

**Putting a company on a plan.** Platform → the company → Plan: choose a trial of a published
version until a day, a paid period of one (from a day until a day, in the company's time zone; the
period ends at the start of the "until" day), complimentary access, or end the plan. Give the
invoice or ticket as the reason: it is shown in the company's audit log and emailed to its
billing managers. A form older than the current plan state is refused ("The plan changed while you
were editing"); reload. Nothing is charged in HyFib: set the period after the payment is settled
elsewhere.

**A company says it was not told of a plan change (ADR-100).** The worker's minute billing sweep
emails the company's active owners and billing members "HyFib changed your plan" after each staff
change, with the plan now, its dates and add-ons and the reason. Two changes within a minute make
one email with the latest; a change the plan sweep or a subscription replaced before the sweep ran
is not told (their own emails are). A change not told yet has
`app.tenant_plans.staff_notice_version` set; it stays set for a company being deleted. The worker
logs `plan change notices` with the counts, and `plan change notice failed for a company; will
retry` with the company id on failure (the change is told the next minute). If the email was
queued, follow section 2 (Email not arriving).

**A company says it was not told that HyFib cancelled its subscription (ADR-101).** The same sweep
emails the company's active owners and billing members "HyFib cancelled your plan subscription"
after a platform owner cancels it, with the reason and what the plan keeps (the period the
subscription paid, its grace days, or that the plan is not changed). The company's own
cancellations send their own email ("Your HyFib plan subscription is cancelled"); those of a
company deletion send none. A cancellation not told yet has
`app.plan_subscriptions.staff_cancel_notice_due` set; it stays set for a company being deleted. The
worker logs `subscription cancellation notices` with the count, and `subscription cancellation
notice failed for a company; will retry` with the company and subscription ids on failure (it is
told the next minute). If the email was queued, follow section 2 (Email not arriving).

**Paying for plans by Razorpay subscription (ADR-063).** Turn it on only after Razorpay activated
Subscriptions (and Flash Checkout, which Subscriptions need) on HyFib's account and the webhook
sends the `subscription.*` events (`docs/DEPLOYMENT.md`): set `RAZORPAY_SUBSCRIPTIONS_ENABLED=true`
on web and worker, then a platform owner sets the tax on plan prices (Platform → Plans → Paying for
plans, with a reason); companies are offered paying only once a tax is set, even 0%. Changing the
tax affects new subscriptions only. A company on a paid period staff set, on complimentary access,
on a retired version or with an add-on the version does not sell is not offered paying; Billing says
why for the last two.

**A company paid but its plan did not change.** Open the company's platform page → Plan
subscription: status, cycle, last checked and any note. The plan changes only when Razorpay reports
the cycle paid, fetched by HyFib: after Checkout, on each `subscription.*` or `payment.*` webhook, and
by the minute sweep (every live subscription at least daily, hourly once its cycle has ended or its
first charge is due, and just before the plan sweep would move the period on). The worker logs `plan subscription check
failed; will retry` with the subscription id when Razorpay cannot answer; it is tried again. A note such as "Razorpay
returned a subscription for another plan" or a payment Razorpay reports for another amount means
the records disagree: compare with the Razorpay Dashboard before doing anything by hand, and never
set a paid period for a payment HyFib has not recorded unless the Dashboard shows it captured.

**A plan payment failed.** `pending`: Razorpay retries; the payer changes the card through the link
in Razorpay's email. `halted`: Razorpay stopped retrying. Billing managers were emailed at each
step. When the paid period ends the plan gets the version's grace days (past due), then expires;
a later successful charge makes it active again. The company can also cancel the subscription and
pay again. Charges above ₹15,000 on Indian cards wait for the payer's approval through their bank
every time (RBI rules, Razorpay's FAQ): a charge that stays unpaid for that reason looks the same.

**A trial paid from its end (ADR-102).** A company whose trial ends more than two days ahead pays
from the trial's end: Checkout only authorises the card, the company's platform page → Plan
subscription shows "Authorised" and the day of the first charge, and the plan stays a trial. At the
trial's end Razorpay charges the first cycle, and the plan becomes active once HyFib records it (the
webhook, or the sweep's hourly check once the charge is due). Until then the ended trial waits, for
at most the plan version's grace days, and Billing says until when. A trial still waiting: check
`SELECT status, starts_at, paid_count, synced_at, failure_reason FROM app.plan_subscriptions WHERE
tenant_id = … ORDER BY created_at DESC LIMIT 1`; `authenticated`, `active` and `pending` wait (the
last one while Razorpay retries a failed first charge), anything else ends the trial at the next
sweep. After the grace days the trial expires; a later charge still makes the plan active. A
company that cancelled just as the first charge was made may show "a payment of a HyFib plan
subscription that syncing the subscription did not record" in the daily reconciliation: the charge
is on a cancelled subscription and HyFib gave no period for it, so refund it in the Dashboard.

**Refunding a plan payment (ADR-103).** Platform owners refund part or all of a plan payment on the
company's platform page → Plan subscription → Refund a plan payment, with a reason (kept in the
platform audit log, never shown to the company). The plan and the subscription do not change: to end
the plan as well, cancel the subscription and then change the plan. The worker asks Razorpay within a
minute or two with `X-Refund-Idempotency: ppr_<request id>` and the note `hyfib_plan_refund`, and the
company's billing managers are emailed when Razorpay accepts it. A request that does not move: check
`SELECT status, attempts, provider_refund_id, last_error, next_attempt_at FROM
app.plan_payment_refunds WHERE id = …`. `requested` with attempts rising: Razorpay is unreachable or
answering unclearly; the same call (same key, so never a second refund) is repeated after 1, 5, 15
and 60 minutes, then hourly. `submitted` for days is normal up to about 7 working days; if the
Dashboard shows it processed, redeliver `refund.processed` or wait for the job's check. `failed`:
`last_error` is Razorpay's code and description (for example a payment already refunded in the
Dashboard, or older than Razorpay refunds); the company was emailed, and another refund can be asked
for. A refund made in the Dashboard is recorded from `refund.processed` or the daily reconciliation,
as made at Razorpay, and shows on the company's receipt. For a company being deleted, refund in the
Dashboard; a due deletion waits for a refund in progress.

**Refund requests of plan payments (ADR-104).** A company's billing managers ask from a plan
payment's receipt for a refund of part or all of it, with a reason. Platform owners get the same
email as for requests of service credit within a minute, counting both kinds (when every waiting
request is of a plan payment it links straight to them), and decide on `/platform/refunds` → Plan
payments (operators only read). Approving starts the refund above for the amount asked, with the
same checks, and its staff reason reads "Asked for by the company:" and the company's reason;
declining needs a note, which the company's billing managers are emailed within a minute. Neither
changes the plan. `SELECT status, requested_at, announced_at, decided_at, decline_notified_at,
plan_payment_refund_id FROM app.plan_payment_refund_requests WHERE tenant_id = … ORDER BY
requested_at DESC`:

- **"Approving was refused":** the request no longer fits (Razorpay refunded part of the payment
  since, for example in the Dashboard, a refund of it started meanwhile, or the company asked for
  deletion); the page shows the reason and the request stays open. Decline it with a note, or refund
  a smaller amount from the company's platform page and decline the request saying so.
- **No email about a request, or about a decline:** as for requests of service credit (section 9,
  item 10): the worker logs the same lines for both kinds, and a failed decline notice names the
  kind (`credit` or `plan_payment`).
- **"We asked too often":** 5 requests in 24 hours per company, of plan payments and service credit
  together (withdrawn requests count).

**Offering plans that companies choose (ADR-105).** Platform owners offer a published version on
its platform page → Actions → "Offer to companies", and stop offering it there ("Stop offering");
retiring a version stops its offer too. Nothing is offered until a platform owner does, and a
version priced under ₹1 cannot be offered. Companies without a paid period (on a trial, past due,
ended or canceled; not complimentary access) see the offered versions under Billing → Choose a
plan, each with what it would cost with their add-ons and the tax, and owners and billing managers
with a sign-in within 15 minutes choose one, then pay for it as before. During a trial the chosen
version's limits and modules apply at once, and the trial's end does not move. Nothing is emailed:
the company's audit log shows `billing.plan_chosen`, and its platform page shows "Last change …:
Chosen by the company.". A staff change not yet emailed when the company chose is not emailed.
`SELECT p.code, p.version, p.status, p.offered_at FROM ops.plans p WHERE p.offered_at IS NOT NULL`
lists what is offered.

- **"You cannot choose a plan now":** the page says why. Razorpay subscriptions are off or the tax
  on plan prices is not set (offering does nothing until both are); the company has complimentary
  access or a paid period (staff change those plans; the company can choose once the period ends);
  a payment is being started (its Checkout window closes within an hour); a subscription pays from
  the trial's end (the company cancels it under Billing, and the trial goes on) or pays now
  (the company changes its plan from the end of the paid period under Billing → Change plan,
  ADR-109, below); or the company is suspended or being deleted.
- **"… holds less than your company has now":** the version has fewer seats (members and
  invitations still waiting, plus the company's extra seats), WhatsApp numbers, teams or live
  automations than the company uses; the message names each one. The company frees some first
  (revokes invitations, removes members, disconnects numbers, deletes teams or turns automations
  off), or chooses a larger version. Monthly limits never refuse a choice.
- **A version is listed without a button ("Your add-ons are not sold with this plan…"):** the
  version does not sell the company's extra seats, numbers or run packs, or the total is more than a
  plan payment can be. The company removes those add-ons under Billing → Add-ons first (ADR-106),
  or staff change the company's plan and add-ons.
- **A version is missing from the list:** it is not offered, was retired, or is a draft.
- **"… costs more than can be paid here with your add-ons and the tax":** the version, with the
  company's add-ons and the tax on plan prices, is more than a plan payment can be (the page shows
  it without a price). Staff change the company's plan instead.
- **Stopping an offer or retiring a version takes a moment longer than usual:** it waits for
  choices of that version being committed at that instant (milliseconds), so none of them lands on
  a version no longer offered.

**Add-ons that companies choose (ADR-106).** Under Billing → Add-ons, owners and billing managers
with a sign-in within 15 minutes set the extra seats, extra WhatsApp numbers and automation run
packs of the version the company is on, when it is on a trial, past due, ended or canceled (the
same companies that can choose a plan), and then pay for them with the plan. The version must still
be published (offered or not) and sell the add-on, within its most seats and numbers. The new
limits apply at once, during a trial too; the trial's end does not move. Nothing is emailed: the
company's audit log shows `billing.add_ons_chosen` with the quantities before and after, and its
platform page shows "Last change …: Add-ons chosen by the company.". `SELECT extra_seats,
extra_numbers, run_packs, note, changed_by_user_id, changed_at FROM app.tenant_plans WHERE
tenant_id = …` shows them.

- **"You cannot change your add-ons now":** the page says why, as for choosing a plan above; also
  when the company's version was retired (it cannot be paid for, so its add-ons stay as staff left
  them: the company chooses another plan, or staff change it).
- **"With these add-ons your plan holds … where your company uses …":** a decrease would leave
  fewer seats (members and invitations still waiting) or WhatsApp numbers than the company uses.
  The company frees some first (revokes invitations, removes members, disconnects numbers), or
  keeps more. An increase is never refused for this, even when the company stays over its limit
  (for example after staff removed add-ons); fewer run packs refuse nothing, and the month's runs
  already used count against the smaller allowance.
- **"… does not sell that many extra seats" (or numbers, or run packs):** the version does not sell
  that add-on, or not that many; the page shows only what it sells and the most it allows.
- **"With these add-ons your plan costs more than can be paid here":** the total with the tax is
  more than one plan payment can be. Choose fewer, or staff change the plan.
- **"No add-ons to choose":** the version sells none of them (choose another plan), or the company
  has complimentary access.

**API request packs (ADR-110).** A version with a monthly API request limit above 0 may sell packs
of extra requests a month (the platform plan form's "API request pack (requests)" and "(₹)", both or
neither). Staff set a company's packs with its plan on the company's platform page, and companies
choose them under Billing → Add-ons and Billing → Change plan like the other add-ons. The company's
limit is the version's plus packs × size, for every request, the usage warning, the used-up email,
the plan card, Settings → API keys and the platform page; fewer packs lower it at once, and the
month's requests already counted stay counted. `SELECT api_requests FROM
app.tenant_entitlements(…)` shows the limit with them, and `SELECT api_request_packs FROM
app.tenant_plans WHERE tenant_id = …` the packs.

- **"API request packs need a monthly API request limit above 0":** a version without a limit or
  without the API (0) has nothing to add to. Set a limit, or leave the packs empty.
- **"This plan sells at most N API request packs" (or automation run packs):** no limit with packs
  may pass 2,000,000,000 (the database returns limits as 32-bit integers); the forms show how many a
  version sells. A version with a smaller pack size, or a larger plan, sells more.
- **"This plan does not sell API request packs":** the version (or the one chosen) sells none. Set
  the packs to 0 first, or choose a version that sells them.
- **"A subscription pays for the plan and add-ons the company has now. Reload the page and try
  again.":** a subscription was about to be recorded for another version or add-ons than the
  company's plan state, which happens only from a page or server older than the plan state (during a
  deploy, a server of the previous release does not know the packs). Reloading and paying again
  records the right one.

**Changing the plan a subscription pays for (ADR-109).** Under Billing → Change plan, owners and
billing managers with a sign-in within 15 minutes choose the version (an offered one, or their own
while published) and add-ons they pay for from the end of the paid period. HyFib cancels the current
subscription at the end of its cycle at Razorpay (unless it already ends then), records a new
subscription that follows it from the period's end, and the payer authorises it in Razorpay's
payment window; nothing is charged for it before the period ends. At the period's end the current
subscription ends, the period is due like a renewal (past due within the current version's grace
days, or expired without any), and the new subscription's first paid cycle puts the plan on the new
version and add-ons. Emails: "Your HyFib plan changes at the end of the paid period" when the
current subscription is cancelled for the change, "Your HyFib plan changes on …" once the new one
is authorised, then the usual payment email. The audit log shows `billing.plan_change_started` and
`billing.plan_subscription_cancelled` (reason `plan_change`), then `plan.subscription_period` with
the previous version and add-ons. `SELECT id, status, plan_id, starts_at, follows_subscription_id,
cancel_at_period_end FROM app.plan_subscriptions WHERE tenant_id = … ORDER BY created_at` shows both.

- **"You cannot change your plan here now":** the page says why: paying for plans is off or the tax
  is not set; the plan has no period paid by subscription (a trial, a period staff set, or an ended
  plan: the company chooses a plan instead); Razorpay reports the subscription paused or not
  charging; the paid period ends within 48 hours (Razorpay starts a card debit 24 to 36 hours
  ahead, so a change then could not take effect at the period's end: the company chooses a plan
  once the period ends); or the company is suspended or being deleted.
- **The payer closed Razorpay's window without authorising:** the current subscription still ends
  with the period (Razorpay cannot undo a cancellation, R-068). Billing shows the next subscription
  as waiting for the payment method, with "Authorise the new plan" until its window closes an hour
  after the change (Change plan says "Not authorised yet"); after that the company changes its plan
  again (any version, including the one it pays for now) until 48 hours before the period
  ends. Otherwise the plan ends with the period, as after any cancellation, and the company pays
  again from Billing.
- **"Cancel the change":** cancels the new subscription at once (it was never charged). The current
  subscription still ends with the period, so the plan ends then unless the company changes it
  again. Choosing again replaces a scheduled change the same way.
- **The plan did not change at the period's end:** the new subscription's first charge has not been
  recorded yet (the plan is past due meanwhile, as at any renewal); the minute sweep asks Razorpay
  hourly once the charge is due. If Razorpay reports the charge failed, the subscription retries
  and halts as any renewal does (the payer changes the card through Razorpay's email).
- **Staff cancel at once** (platform page) cancels both subscriptions, the current and the new one;
  company deletion does too. Staff plan changes stay refused while either is live.
- **Both subscriptions charged for the same period** should not happen (the current one is
  cancelled before the new one exists). If Razorpay ever renews the cancelled one, its payment is
  recorded but never applied (`stale`); refund it from the company's platform page (ADR-103).

**The price list for visitors (ADR-107).** Platform owners show it on the platform Plans page
("Price list for visitors", then "Show the price list"). Anyone can then see at `/pricing`, without
signing in, every version offered to companies with its price before and with the tax, what it
includes and its add-ons, the default trial's length, and that Meta bills WhatsApp's own message
charges directly. "Hide the price list" takes it down at once. Both are in the platform audit log
(`platform.price_list_shown`, `platform.price_list_hidden`). Changes to the offers, the tax or the
default trial show on the next view: nothing is cached.

- **`/pricing` says "Page not found":** the card on the Plans page names what keeps it from
  visitors. Either the list is hidden, or paying for plans is turned off on this platform (Razorpay
  subscriptions), or no tax on plan prices is set. It also stays hidden when there is no default
  trial (new companies would start complimentary and could not choose a plan), or when no offered
  version can be paid with one plan payment, tax included. Fix what the card names; the page
  appears on the next view.
- **A version is missing from the list:** it is not offered (offer it on its platform page), it is
  a draft or retired, or its price with the tax is more than one plan payment can be.
- **To take a price down at once** (a wrong price, say): hide the price list, or stop offering the
  version. A published version never changes: publish a corrected version, offer it, and stop
  offering the wrong one.

**Cancelling a company's subscription.** Owners and billing managers cancel in Billing (an active
one at the end of the paid period, otherwise at once). Platform owners cancel at once on the
company's platform page with a reason (needed before changing the company's plan, which staff
cannot do while a subscription is live); the paid period stands and the plan then ends as canceled,
without grace days, and the company's billing managers are emailed the reason (ADR-101). A
subscription paid from a trial's end is cancelled at once by the company before its start (nothing
was charged, and the trial goes on); after the start HyFib asks Razorpay first, and one already
charged is cancelled at the end of the period it paid (ADR-102). A company
that cancelled pays again from Billing once the paid period has ended
(there is no resume). Deleting a company cancels its subscription first; a failure shows as "Plan
subscription at Razorpay: failed" in the deletion's provider outcomes: cancel it in the Razorpay
Dashboard.

**Refunding a plan payment.** HyFib does not refund plan payments. A refund made in the Razorpay
Dashboard shows in the daily reconciliation as "A refund of a plan subscription payment" for a
platform owner; it changes nothing in HyFib, so decide whether the company keeps the period (end
the plan if not, after cancelling the subscription) and note it on the item.

**A company asks for a receipt of a plan payment.** Billing → Paying for your plan lists each
payment with a Receipt link (owners, administrators and billing managers), and the payment email
links to it (ADR-064). It confirms the payment and is not a tax invoice; staff have no view of it.

**A payment start that never finished.** A subscription is recorded before Razorpay is called; one
still "creating" after 10 minutes is marked failed by the sweep. A Razorpay subscription created
anyway can only be authorised within its hour (`expire_by`), and the sweep cancels any unpaid one
whose hour has passed, so nothing can be charged later.

**A new version of a plan.** Only platform owners change the catalog. Open the published version →
"New version from this one", edit the draft, publish it, then move companies to it one by one; the
old version can be retired (companies on it keep it). A published version never changes, even for
the platform role; a mistake in a draft that was published is corrected by retiring it and
publishing a new version. The default trial must be a published version with trial days; retire it
only after choosing another default (or none: new companies are then complimentary).

**A company says it cannot send anything ("This company's plan has ended").** Its trial or paid
period ended and the grace days passed (the minute billing sweep moved it to expired and restricted
it), or staff ended the plan. Reading, exports, members and billing still work. Put it on a plan
(trial, paid period or complimentary): the restriction lifts at once. If the company is also
suspended, lift the suspension separately; reactivating a suspended company whose plan has lapsed
makes it restricted, not active.

**"Your company's plan allows N seats (numbers, teams, live automations), and all are in use."**
Waiting invitations hold seats until they are accepted, revoked or expire; suspended members do not.
Numbers count while being connected, connected or needing reconnection; disconnected and failed
ones do not. The company can free one, or staff can add extra seats or numbers (when the version
sells them) or move it to a larger version. A lower limit never removes anything.

**Automations stopped answering customers.** The month's automation runs may be used up: the
company's billing managers were emailed when 80% were used, or the share chosen under Billing →
Usage warnings (ADR-144), and again once all were (ADR-062), and Billing shows the runs used and the
period.
Runs already in progress continue; runs from store events are recorded as "Not sent: the month's
automation runs are used up". Add run packs (when the version sells them) or change the plan; the
next customer message starts a run. The period starts on the day the current plan or trial started
(usage anchor), whatever the billing interval. If the plan leaves out Automations, nothing starts
("not in the plan") and the automation pages say so.

**A usage warning or used-up email did not come.** Each counter (company, automation runs or API
requests, usage period) gets at most one warning, at the company's share of the limit rounded up
(`app.tenants.usage_warning_percent`: 80% unless a member who manages billing chose 50% to 95% under
Billing → Usage warnings, ADR-144; none when the share rounds up to the limit itself, as for limits
of 1 to 4 at 80%, and none when the limit is reached before a sweep saw the share), and one used-up
notice; `app.usage_counters.warned_at` and `notified_at` say when the sweep queued them. A counter
already warned is not warned again when the share changes; one already past a lowered share is
warned at the next sweep. The company's audit log shows who changed the share
(`billing.usage_warning_changed`, from and to). A counter of an earlier period is marked without an
email, and a company that is suspended, restricted or being deleted gets none. Queued emails go out
through the email outbox like every other notice.

**A rate change email did not come, or came again.** A company is told once per published card
(`app.rate_change_notices`: the card, its currency and effective time, when the email was queued)
when a card for its billing currency (Settings → Messaging) takes effect within 7 days. None goes to
a company without a billing currency, one that is suspended, restricted or being deleted, or about a
draft, a withdrawn card or a card published after it took effect. The recipients are the owners and
billing managers at the time. The billing sweep logs `rate change notices` with how many were sent,
and `rate change notice failed for a company; will retry` with the company and card ids (nothing is
recorded, and the next minute tries again). A correction published as a new card is announced again
(ADR-065).

**The sweep did not move a plan on.** The billing sweep runs every minute and logs `plan sweep`
(and `plan sweep failed for a company; will retry` with the company id and error, rolled back and
retried the next minute). A company being deleted is skipped. Check `app.tenant_plans` for the
company (`status`, `trial_ends_at`, `period_end`, `grace_ends_at`): the database's clock decides
what is due.

**Migration 0060, 0061 or 0062 failed.** 0060 runs in one transaction, so a failure applies
nothing: it makes `app.conversation_notes.author_membership_id` optional and adds
`author_api_key_id` with the check `conversation_notes_author` (exactly one author) and a composite
foreign key to `app.api_keys`, both `NOT VALID`. A failure usually means a lock wait on
`app.conversation_notes` or `app.api_keys` timed out: run the migrations again when writes are
quieter. 0061 runs outside a transaction (one `CREATE INDEX CONCURRENTLY`): a failure can leave an
INVALID index; run `DROP INDEX CONCURRENTLY IF EXISTS app.conversation_notes_api_key_idx;` and run
the migrations again. 0062 validates both constraints without blocking writes; it fails only if a
stored note has no author or two, which no code writes: find it with `SELECT id FROM
app.conversation_notes WHERE (author_membership_id IS NULL) = (author_api_key_id IS NULL)` before
running it again.

**Migration 0059 failed.** It runs in one transaction, so a failure applies nothing: it widens
the check on `app.api_keys.scopes` to allow `webhooks.manage` (up to ten scopes), makes
`app.webhook_endpoints.created_by_user_id` optional, and adds `created_by_api_key_id` with the check
`webhook_endpoints_creator` (exactly one creator) and a composite foreign key to `app.api_keys`,
both validated at once (a company has at most 10 endpoints). A failure usually means the scope
check was renamed or changed by hand; no stored endpoint can break the new check, since each has a
member as its creator.

**Migration 0057 or 0058 failed.** 0057 runs in one transaction, so a failure applies nothing: it
replaces `automation_runs_end` on `app.automation_runs`, `NOT VALID`, with a check that also allows
the reason `stopped_by_api`. A failure usually means the check was renamed or changed by hand.
0058 validates it without blocking writes; it fails only if a stored run's status and end reason do
not match, which no code writes: find it with `SELECT id, status, end_reason FROM
app.automation_runs WHERE status NOT IN ('running', 'waiting') AND end_reason IS NULL` (and compare
the pairs listed in 0057) before running it again.

**Migration 0052, 0053 or 0054 failed.** 0052 runs in one transaction, so a failure applies
nothing: it widens the check on `app.api_keys.scopes` to allow `automations.start` (up to nine
scopes), adds `app.automation_runs.api_key_id` with the trigger type check, the key check and the
foreign key `NOT VALID`, and replaces `app.guard_automation_run` so that the key stays fixed. A
failure usually means a constraint was renamed or changed by hand (`api_keys_scopes_check`,
`automation_runs_trigger_type_check`). 0053 runs outside a transaction (one `CREATE INDEX
CONCURRENTLY`): a failure can leave an INVALID index; run `DROP INDEX CONCURRENTLY IF EXISTS
app.automation_runs_api_key_idx;` and run the migrations again. 0054 validates the three
constraints without blocking writes; it fails only if a stored run breaks one, which no code writes:
find it with `SELECT id, trigger_type, api_key_id FROM app.automation_runs WHERE (trigger_type =
'api') <> (api_key_id IS NOT NULL)` before running it again.

**Migration 0051 failed.** It runs in one transaction, so a failure applies nothing. It adds
`app.api_keys.allowed_networks` with its check and grants, creates
`ops.api_key_authenticate(text, inet)` and rebuilds the one-argument lookup on it (dropped and
created again, granted to `w360_app`, then handed to `w360_definer`). A failure usually means the
bootstrap roles are missing or the lookup was changed by hand. The one-argument lookup was kept only
for web servers of the previous release during a rolling deploy and refused keys that list networks;
0074 drops it.

**Migration 0050 failed.** It runs in one transaction, so a failure applies nothing. It replaces
the check on `app.api_keys.scopes` with one that also allows `conversations.write` (up to eight
scopes). The check is wider than before, so existing keys pass; a failure usually means the
constraint was renamed or changed by hand.

**Migration 0046 failed.** It runs in one transaction, so a failure applies nothing. It adds
`app.credit_refund_requests` (row security, column grants, a restrictive policy for the company
role, deletion step 76), the notice functions for the worker, the platform lists and
`ops.platform_decide_credit_refund_request`. A failure usually means a deletion step numbered 76
already exists, or a function of the same name was created by hand.

**Migration 0045 failed or left an INVALID index.** It runs outside a transaction
(`-- migrate:no-transaction`, one `CREATE INDEX CONCURRENTLY` of `app.conversations_created_idx`),
so a failure can leave an INVALID index: run
`DROP INDEX CONCURRENTLY IF EXISTS app.conversations_created_idx;` and run the migrations again.
Without the index, conversation pages through the API still answer, only more slowly for companies
with many conversations.

**Migration 0044 failed.** It runs in one transaction, so a failure applies nothing. It replaces
the check on `app.api_keys.scopes` with one that also allows `conversations.read` (up to seven
scopes). The check is wider than before, so existing keys pass; a failure usually means the
constraint was renamed or changed by hand.

**Migration 0043 failed.** It runs in one transaction, so a failure applies nothing. It adds
`ops.settlement_unsettled_alerts` (granted to `w360_definer` only), the shared definition
`ops.settlement_unsettled_topups()` (executable by nobody else), the listing and the mark (granted
to `w360_app`, then handed to `w360_definer`), and replaces the page's unsettled list
(`ops.platform_settlement_recon_unsettled`) to read the shared definition. A failure usually means
the bootstrap roles are missing or migration 0034 was changed by hand.

**Migration 0042 failed.** It runs in one transaction, so a failure applies nothing. It replaces
the check on `app.api_keys.scopes` with one that also allows `messages.reply` (up to six scopes)
and the check on `app.automation_runs` end reasons with one that also allows `api_replied` for a
run taken over. Both checks are wider than before, so existing rows pass; a failure usually means a
constraint was renamed or changed by hand.

**Migration 0041 failed.** It runs in one transaction, so a failure applies nothing. It grants
`w360_definer` select and delete on `ops.rate_limit_buckets` and adds `ops.purge_rate_limit_buckets`
(granted to `w360_app`, then handed to `w360_definer`). A failure usually means the bootstrap roles
are missing.

**Migration 0040 failed.** It runs in one transaction, so a failure applies nothing. It adds
`app.api_keys.expiry_reminded_at` (with column grants to `w360_app`), replaces the key's guard
function with one that also keeps the reminder mark, adds a partial index and
`ops.api_key_expiry_reminders_due` (granted to `w360_app`, then handed to `w360_definer`). A
failure usually means the bootstrap roles are missing or migration 0024 was changed by hand.

**Migration 0039 failed.** It runs in one transaction, so a failure applies nothing. It adds
`ops.settlement_recon_runs.alerted_attempt` (runs already finished are marked as emailed) and the
listing, mark and recipients functions for reconciliation alerts (granted to `w360_app`, then
handed to `w360_definer`). A failure usually means the bootstrap roles are missing or migration 0034
was changed by hand.

**Migration 0038 failed.** It runs in one transaction, so a failure applies nothing. It adds
`app.rate_change_notices` (forced RLS, grants, an append-only trigger and a deletion step), column
grants and read policies for `w360_definer` on published rate cards, billing currencies and the
notices, and `ops.rate_change_notices_due` (granted to `w360_app`, then handed to `w360_definer`). A
failure usually means the bootstrap roles are missing.

**Migration 0037 failed.** It runs in one transaction, so a failure applies nothing. It adds the
plan tax setting, `app.plan_subscriptions` and `app.plan_payments` (forced RLS, grants, triggers),
`tenant_plans.subscription_id`, the resolve, period and due functions, and recreates
`app.apply_plan_transition`, `ops.settlement_recon_facts` and `ops.record_tenant_deletion_cleanup`
(dropped as `w360_definer`, recreated, granted, then handed to `w360_definer`) and the
reconciliation reason check. A failure usually means the bootstrap roles are missing or one of
those functions was changed by hand.

**Migration 0023 failed.** It runs in one transaction, so a failure applies nothing. It widens the
company status check with `restricted`, adds the plan tables, triggers (two SECURITY DEFINER trigger
functions created before their ownership moves to `w360_definer`), the entitlement and sweep
functions, replaces `app.accept_invitation` and seven lookup functions (dropped as `w360_definer`,
recreated, granted, then handed to `w360_definer`), and backfills a complimentary plan state for
every existing company as `w360_definer` (companies are behind forced RLS). A failure usually means
the bootstrap roles are missing (`infra/db/bootstrap-roles.sql`) or a lookup function was changed
by hand.

## 10N. Public API

**A company's API key leaked.** In Settings → API keys (owners and administrators), revoke it: the
next request with it gets 401. If the integration must keep working, rotate instead with no overlap
and give the new key to the integration; do not keep an overlap for a leaked key. The audit log
shows who created, rotated and revoked keys (`api_key.*`, with the key's public prefix) and the
contacts and consent a key recorded (actor `api_key`); messages a key sent carry its id
(`messages.api_key_id`) and show in their conversations. "Last used" shows when a key was last
presented (updated at most once a minute).

**"Send a valid API key" (401).** The key is unknown, revoked or expired, the header is not
`Authorization: Bearer <key>`, or the company is being deleted. Keys are shown once: a lost key is
rotated, never recovered. Many failed attempts from one address answer 429 for a while (one attempt
every 5 seconds after a burst of 20). The buckets are rows of `ops.rate_limit_buckets` (keys
`api:auth-failure:<address>`, `api:key:<key id>`, `api:company:<company id>`); the messaging sweep
deletes them once they are full again and logs `full rate limit buckets deleted` (ADR-068). Do not
delete a bucket by hand to lift a limit: it refills on its own within seconds for keys and companies
and within 100 seconds for failed attempts.

**429 "Too many requests".** Each key allows bursts of 50 requests and 10 a second, each company 200
and 30 a second; wait for `Retry-After` and retry with the same `Idempotency-Key`. A 429 with the
reason `quota_exceeded` means the plan's API requests for the month are used up (ADR-061): the
requests work again when the next usage period starts, or with a larger plan.

**429 with the reason `key_quota_exceeded`.** The key used up its own monthly limit (ADR-097); the
company's other keys are not affected, and requests the key was refused are not counted for the
company. Settings → API keys shows each key's requests this period, marks a key whose limit is
reached, and lets an owner or administrator (after a recent sign-in) raise or remove the limit: it
applies from the next request, to the requests already counted. Otherwise the key works again when
the next usage period starts. The audit log records each change (`api_key.limit_changed`, with the
limits before and after). A rotated key keeps its predecessor's limit and counts from zero.

**An email about a key's limit did not come, or came again.** Owners and administrators are
emailed once when a key reaches 80% of its own limit in a period and once when it reaches the limit
(ADR-098); limits of 1 to 4 get only the second, and so does a key that reached its limit before
the sweep saw it at 80%. The messaging sweep logs `API key usage emails queued` with the counts,
and `API key usage email failed; will retry` with the company and counter ids (nothing is marked,
and the next minute tries again). Settings → API keys shows when each email went out this period.
Nothing is sent for a key without a limit, a revoked or expired key, or a company being deleted,
and a counter of an earlier period is marked without an email. Changing a key's limit arms both
emails again for the new limit.

**403 `not_in_plan` naming a scope.** The company's plan leaves that scope out (ADR-092). The key
keeps the scope: requests that need it work again, with no change to the key, once the company is
on a plan version that includes it (a published version's scopes never change, so this is a new
version or another plan). Settings → API keys lists the plan's scopes and marks each key's scope it
leaves out; platform staff see the scopes on the plan page and the company's platform page. A 403
`not_in_plan` that names no scope means the plan leaves the whole API out (ADR-061).

**An API request to assign or move a conversation is refused with 422 naming `assigneeId` or
`teamId`.** The member cannot be given conversations or the team is not the company's (ADR-093):
`GET /members` lists the members who can (active, with a role that answers conversations; a
marketer, analyst or billing manager cannot, nor a suspended member), and `GET /teams` the teams.
Nothing in the refused request was kept, including a status or team named with it. A conversation
moved to a round-robin team goes to the team's next available member at once when it is open and
has no member after the request; an unassigned conversation in such a team is otherwise given out
by the minute sweep. The audit log shows the key's changes
(`conversation.assigned`, `conversation.team_changed`, source `api`) and routing's
(`conversation.routed`).

**A call to change many conversations is refused with 422 naming `conversationIds.<n>`.** The id at
that place in the list (counting from 0) names none of the company's conversations: another
company's, an erased contact's, or none at all (ADR-120). Nothing in the call was changed, the other
conversations included: `POST /conversations/update-many` changes all of them or none. Remove or
correct that id and send the call again; what a conversation already has changes nothing, so
repeating a call is harmless. A call takes at most 100 conversations, each once (422 naming
`conversationIds`), and counts as one request against the key's limits. Each conversation's change
is audited as a single change is, all with the call's correlation id.

**A call to change many contacts is refused with 409, 412 or 422 naming `contacts.<n>.…`.** The
contact at that place in the list (counting from 0) could not be changed as asked (ADR-122):
`contacts.<n>.id` names none of the company's live contacts (another company's, an erased one, or
none at all); `contacts.<n>.fields.<key>` is a field the company does not have or a value of another
type (`GET /api/v1/contact-fields` lists the fields and types); `contacts.<n>.email` is not an
email; `contacts.<n>.addTags` would give the contact more than 50 tags; `contacts.<n>.removeTags`
names a tag also being added. `contacts.<n>.phone` with 422 is not a number with its country code
and a leading +, or a number another contact of the call is given too ("Give each number once.");
with 409 or 412 it is refused as `PATCH /api/v1/contacts/{id}` refuses it (ADR-180, below), and 409
also when one of the call's own contacts has the number: a call never swaps or moves numbers between
its contacts (ADR-188), so give the contact that has it another number in a call of its own first.
Nothing in the call was changed, the other contacts included: `POST /contacts/update-many` changes
all of them or none. Correct that contact's change and send the call again; what a contact already
has changes nothing, so repeating a call is harmless. A call takes at most 100 contacts, each once
(422 naming `contacts`), and counts as one request. A 409 `conflict` that names no place (retryable)
means it met another transaction changing the same contacts in another order, such as a CSV import,
and PostgreSQL ended it: send it again. Each contact's change is audited as a single change is, all
with the call's correlation id.

**An API key expired without a reminder, or the reminder came twice.** Owners and administrators
are emailed once, 7 days before a key expires (ADR-067): `app.api_keys.expiry_reminded_at` says when
the reminder was queued, and Settings → API keys shows it. Keys that never expire, rotated keys (the
new key is reminded instead), revoked keys and keys of companies being deleted get none, and a key
created or rotated to expire within 7 days is reminded within a minute. The messaging sweep logs
`API key expiry reminders emailed` with the count, and `API key expiry reminder failed; will retry`
with the company and key ids (nothing is marked, and the next minute tries again). Queued emails go
out through the email outbox like every other notice. A key is renewed by rotating it; its expiry
cannot be extended.

**"This Idempotency-Key was already used with a different request" (422).** The integration reused
a key for another message; each new message needs a new key (for example a UUID), and only retries
of the same request reuse one. Keys are kept 24 hours.

**An API send failed or never arrived.** `GET /api/v1/messages/{id}` shows the status (`queued`,
`accepted`, `sent`, `delivered`, `read`, `failed` with WhatsApp's error, `unknown_outcome` when the
send was interrupted and is not retried). A 412 at send time names the reason (no marketing opt-in,
suppression, frequency cap, template not approved). The send pipeline is the members' (§6): the
message appears in the conversation, which is created resolved.

**An API text reply was refused with `window_closed` (412).** A text reply (ADR-070) goes only to a
contact who wrote to that WhatsApp number in the last 24 hours. The same answer covers a number
that is not a contact, one that wrote to another of the company's numbers (send with `from` set to
the number it wrote to), an erased contact and a last message older than 24 hours, so the answer
alone does not tell them apart; the conversation in the inbox shows when the customer last wrote.
Outside the window only approved templates can be sent (`type` `template`). A reply queued just
before the window closed can still fail when the worker sends it: `GET /api/v1/messages/{id}`
then shows `failed` with the code `window_closed`. A key needs the `messages.reply` scope for text
(403 without it); keys keep their scopes, so an older key is replaced by a new one with the scope.

**An automation stopped after an API reply, or the conversation still waits for a member.** A text
reply through the API takes the conversation over from an automation handling it, as a member's
reply does: the run ends as taken over ("A reply was sent through the API") and its queued
messages are cancelled. The reply is not a member's reply, so the conversation keeps waiting for a
member (and counts in the Inbox SLA) until a member replies or resolves it. The inbox shows the
message with "API" and the key's name.

**An integration cannot find a conversation or a message through the API.** Reading conversations
(ADR-072) needs the `conversations.read` scope (403 without it), which only a member who reads every
conversation can grant. The conversations of erased contacts are not listed and read as not found
(404), like another company's ids. Messages carry their text and media type, not the media;
internal notes and member names are not returned. Lists are newest first and `nextCursor` gives the
next page. To catch up on changes, an integration asks for `updatedSince` a little before its
previous pass began: a change carries the time its transaction began, so one saved during a pass can
be older than the pass. Before ADR-072, pages of contacts (the list, the export and the API), the
inbox thread's older messages and the audit log could skip rows written in the same transaction as
a page's last row; cursors issued before still work.

**An API request is refused with `ip_not_allowed` (403).** The key lists the networks it accepts
(Settings → API keys, "Accepts requests from"; ADR-076), or the company lists addresses for all its
keys ("Addresses for all keys"; ADR-099), and the request came from another address; the error
message names the address the API saw and says whose list refused it ("This API key…" or "The
company this API key belongs to…"). If that address is a load balancer's or proxy's rather than the
integration's, `TRUSTED_PROXIES` is missing a hop (DEPLOYMENT.md): fix the configuration, do not add
the proxy's address to the key or the company's list. If the integration moved, a member who manages
keys changes the list that refused it (a recent sign-in is needed); the change applies to the next
request and is in the audit log (`api_key.networks_changed`, or `api.networks_changed` for the
company's list). Refused requests count against the address's failed-authentication limit, so a
client that keeps trying is answered 429 for a while. The web log has `api request refused: the key
does not accept the address` (or `the company does not accept the address`) with the key and
company ids.

**An integration cannot resolve or reopen a conversation, or a resolve did something unexpected.**
`PATCH /api/v1/conversations/{id}` (ADR-075) needs the `conversations.write` scope (403 without it),
which only owners, administrators and supervisors can grant; keys keep their scopes, so an older
key is replaced by a new one with the scope. It answers 404 for an erased contact's conversation or
another company's, 422 for any body but `{"status": "resolved"}` or `{"status": "open"}`, and 423
while the company is suspended or its plan has ended. Asking for the status the conversation
already has changes nothing. A resolve stops an automation answering the conversation ("The
conversation was resolved.") and sends no satisfaction survey: surveys follow a member's resolve.
The audit log shows the change with the actor `api_key`, and per-member report counts leave it out.
The contact's next message reopens the conversation as usual.

**An integration cannot start an automation, or its run ended early.** `POST
/api/v1/automations/{id}/runs` (ADR-077) needs the `automations.start` scope, which only owners and
administrators can grant (keys keep their scopes: replace an older key), and an `Idempotency-Key`.
The reason says what is missing: `automation_unavailable` (not published, archived, or the published
version is not "Started through the API": publish the draft with that trigger), `automation_paused`
(resume it), `channel_unavailable` (the automation's number is not active), `automation_busy` (a run
is already handling the contact's conversation: wait for it, or stop it on its run page),
`conversation_assigned` (a member has the conversation), `automation_limit` (10 runs in that
conversation in the last hour), `automation_quota` or `not_in_plan` (the plan). A 412 without a
reason is the contact's consent: on the suppression list, erased, or opted out of utility messages.
A 422 names the input that is missing, unknown or longer than 1,000 characters (`GET
/api/v1/automations` lists the inputs); a marketing template needs the key's
`messages.send_marketing` scope (403). A run that starts and then fails with `send_blocked` had a
template step refused when it sent (for a marketing template, no opt-in or the frequency cap); the
run page shows the step and the reason, with the key that started it and the inputs. A retry with
the same `Idempotency-Key` answers as the first request did; `GET /api/v1/automation-runs/{id}`
shows the run as it is now.

**A run was stopped through the API, or a stop changed nothing.** `POST
/api/v1/automation-runs/{id}/stop` (ADR-079) stops only runs keys of the company started; any other
run answers 404. A run that had already ended is answered as it is: its `endReason` says how it
ended (`stopped_by_api` for an earlier stop). A stopped run's page says "Stopped through the API.",
and the audit log shows `automation.run_stopped` with the actor `api_key`. Messages the run had
queued but not handed to the sender are cancelled ("Not sent: the automation stopped before this
message left."). The conversation is not handed to people: if the customer wrote, it waits,
unassigned, for a member in the inbox; assign it or let routing pick it up when the customer writes
again.

**A reply with buttons or a list is refused or fails.** A 422 names the field: at most 3 buttons
with different titles (up to 20 characters) and ids (up to 256); a list button label up to 20
characters, up to 10 sections with a title on each when there are several (up to 24 characters),
at most 10 rows in all with different ids (up to 200 characters), titles up to 24 and descriptions
up to 72; ids cannot start or end with a space, or start with `w360` (HyFib's own buttons use it).
A 412 `window_closed` means the number has not written in the last 24 hours, as for text. A
message that fails after it was queued shows WhatsApp's error on `GET /api/v1/messages/{id}` and in
the inbox; limits Meta applies beyond its published description would show there first.

**A quote or a reaction sent through the API is refused, or shows no quote.** `replyTo` takes a
HyFib message id (from `GET /api/v1/conversations/{id}/messages`, the `message.received` webhook or
a send's response), never a WhatsApp id. A 422 on `replyTo` says why: "Give the id of a message in
this conversation" when the id is unknown or belongs to another conversation (another number, or
another contact, of the company or not); reactions and WhatsApp notices cannot be quoted; a
business message can be quoted once WhatsApp accepted it and while it has not failed; reactions go
only on messages the contact sent in the last 30 days; the emoji must be exactly one emoji (skin
tones and flags count as one). A 412 `window_closed` means the number has not written in the last
24 hours, as for any reply. A reaction does not end a running automation. Reactions cannot be taken
back through the API. The inbox shows a quote above a reply and names the message a reaction is
for; it shows no quote when the quoted message is not in the conversation (sent before HyFib had
the number, or deleted by retention), and the API then gives `replyTo: null`.

**Products sent through the API are refused or fail.** A 403 with reason `not_in_plan` means the
company's plan does not include Commerce. A 422 on `products` names the content ids HyFib cannot
send: ids are matched exactly (case and spaces included) against the catalogs HyFib read for the
WhatsApp number in Commerce → Catalogs; a product added at Meta since the last read appears after
"Read from Meta", and products Meta no longer lists or catalogs disconnected from the number are
not sent. A 422 on `catalogId` means more than one catalog of the number holds all the ids: name
the one to use with its Meta id. "Give products from one catalog" means no catalog holds them all.
Other 422s name Meta's limits (header up to 60 characters, body up to 1,024, footer up to 60,
section titles up to 24 and required with more than one section, 10 sections, 30 products, each
once). A 412 `window_closed` means the number has not written in the last 24 hours, as for any
reply. A message that fails after it was queued shows WhatsApp's error on
`GET /api/v1/messages/{id}` and in the inbox.

**The message feed (`GET /api/v1/messages`) looks short, empty or repeated.** A page reads at most
2,000 of the company's messages, newest first, and shows those that pass `direction` and
`channelId`: when the filters leave out most of them the page holds fewer messages than `limit`,
or none, and still gives a `nextCursor`. That is not the end: follow `nextCursor` until it is
`null`. Messages seen again after asking for `since` a little before the previous pass are
expected (a message carries the time its saving began); deduplicate on the message id. Missing
messages: the feed leaves out erased contacts' conversations and internal notes, never attaches
media, and a 403 means the key lacks `conversations.read`. A 422 names the query field (`direction`
is `inbound` or `outbound`, `channelId` a number's id, `since` a date-time with its offset, `limit`
up to 100, a cursor from a previous page); a `channelId` that is not one of the company's numbers
gives empty pages. Statuses in the feed are as they were when read; follow them with the
`message.status` webhook.

**Notes read through the API (`GET /api/v1/conversations/{id}/notes`) are missing or unnamed.** A
404 means the conversation is another company's, its contact was erased (erasure deletes the
conversation's notes too) or the id is wrong; a 403 means the key lacks `conversations.read`.
Members' notes say `writtenBy: agent` and never which member: that is deliberate, as nowhere in
the API names members. A key's note names the key in `apiKeyId`, and the inbox shows the note with
the key's name. Pages are newest first; follow `nextCursor` until it is `null`.

**An endpoint added through the API is refused, missing or unexpected.** A 422 names the field:
an https address (no credentials, port 443 or from 1024; `http://` and loopback only where local
and test configuration allow them), at least one event from the list, a description up to 200
characters; the address cannot change (add a new endpoint and delete the old one). A 412 means the
company has 10 endpoints, members' included. A key that cannot find an endpoint (404) is looking
at one a member added in settings: keys see only what keys added. A retry with the same
`Idempotency-Key` answers `secret: null` by design: rotate the secret to get a new one. Owners and
administrators are emailed whenever a key adds an endpoint; if nobody expected it, delete it in
Settings → Webhooks (which names the key) and revoke the key, then check the audit log for what
else the key did (`actor_type = 'api_key'`).

**A note added through the API is refused or does not show.** `POST /conversations/{id}/notes`
needs `conversations.write` (403 otherwise) and an `Idempotency-Key`; a retry with the same key
answers as the first request did and adds nothing. A 404 means the conversation is another
company's or its contact was erased (erasure deletes the conversation's notes, and a note sent while
an erasure runs waits for it and is then refused). A 422 names the text: 1 to 4,000 characters.
The note shows in the conversation's Notes card as "API (key name)"; it never reaches the customer
and notifies no member.

**A test event or a replay through the API is refused, or a delivery cannot be found.**
`POST /webhook-endpoints/{id}/test` and `POST /webhook-deliveries/{id}/replay` need an
`Idempotency-Key`; a retry with the same key answers as the first request did and queues nothing
more. A 412 ("Turn the endpoint on") means the endpoint is off: the key turns it on with
`PATCH /webhook-endpoints/{id}` and `{"enabled": true}`. A 409 ("still being attempted") means the
delivery has not succeeded or failed yet: follow it with `GET /webhook-deliveries/{id}`. A 404
means the delivery or endpoint was added by a member (keys see only what keys added), belongs to
another company, or was deleted after 30 days. A delivery shows no body (payloads are built when
delivered and never stored): match it to the receiver's log by `eventId`.

**A contact change through the API is refused, or a custom field value is missing (ADR-112).**
A 422 names what it refused in `issues`: `fields.<key>` for a key the company has no field for
(`GET /api/v1/contact-fields` lists the keys; a label is not a key), a value of another type (text
and dates are strings, dates `YYYY-MM-DD`, numbers are JSON numbers, yes/no are `true` or `false`;
`"3"` is not a number) or a bad value, `email`, `addTags` (51 tags, commas) or `removeTags`. Nothing
of a refused request is saved, so the integration fixes the value and sends it again. A 404 means
the contact is erased, belongs to another company or does not exist. A field that a member deleted
while the request waited is refused as unknown. A value missing from a contact's `fields` was never
set, was cleared, or belongs to a field that was deleted (deleting a field removes its values from
every contact and sends no event); a create (`POST /contacts`) fills only the fields an existing
contact has no value for, so a change of a value needs `PATCH /contacts/{id}`. Changes are audited
as `contact.updated` by the key with the field keys, never the values.

**A contact search through the API gives short or empty pages, or a 422 (ADR-113).** A page
filtered by `tag` or `fields[<key>]` reads at most 2,000 contacts, newest first: when few contacts
match, pages hold fewer than `limit`, or none, and still give `nextCursor`, which the integration
follows until it is `null`. A 422 names the filter: `fields.<key>` for a key the company has no
field for (`GET /api/v1/contact-fields`), a value of another type (numbers as members type them,
dates `YYYY-MM-DD`, `true` or `false`) or an empty one, `email` or `tag`. Text matches whatever its
case but compares whole values, not parts of them.

**A search by name through the API finds fewer contacts than expected, or a 422 (ADR-124).** `name`
finds contacts whose name contains the text, whatever its case, as members' Contacts search finds a
name: try the same text there. Accents count (`Elodie` does not find `Élodie`), and so does the form
of a name typed with combining accents; letters' case is folded by the database's locale
(`SHOW lc_ctype;`): with `C` only ASCII letters fold, so `ÉLODIE` does not find `Élodie` (DEPLOYMENT
asks for a UTF-8 locale). The filter reads names only, not emails or numbers (`email` and `phone`
find those). A page filtered by name reads at most 2,000 contacts: short or empty pages still give
`nextCursor`, followed until it is `null`. A 422 names `name` for an empty value or one longer than
200 characters.

**An API request is refused with "Text cannot hold the NUL character (U+0000)" (ADR-124).** The
integration sent the character U+0000 in a query parameter or a JSON string, which PostgreSQL text
cannot store; the refusal's `issues` names the parameter as sent or the body's path (such as
`contacts.1.name`). The integration removes the character (often left by a C string or a binary
field) before sending. Before ADR-124 such a request failed with 500 and an `api request failed` log
line naming the database's encoding error (`invalid byte sequence for encoding "UTF8": 0x00`).

**A member's form, a sign-up or a CSV import is refused with "Text cannot hold the NUL character
(U+0000)", or a message shows "�" (ADR-130).** The text held U+0000, which PostgreSQL cannot store,
often pasted from a binary field or left by a file saved as UTF-16 (re-save the CSV as UTF-8; the
refusal names the line). Text from WhatsApp, Razorpay, the stores and companies' endpoints keeps
the replacement character "�" where the character was; nothing else in the message, product or
answer is changed.

**A message shows "This message was too large to keep." or "N contacts were too large to keep", or
text ends with "�" (ADR-131).** A message's content may take at most 64 KB: a contact card keeps the
contacts that fit and counts the rest, and content larger than that (far beyond what WhatsApp sends)
is kept without it; ask the customer to send it again in parts. "�" stands for half of an emoji or
another character that a clip or a provider cut: HyFib clips text without splitting one (inbound
text since ADR-131, text sent to Meta or Razorpay or shown to members since ADR-133), so it appears
only where a provider or an API request sent half of one, or in clipped error text. A status's
errors and pricing larger than their columns hold (4 KB and 2 KB) are kept shortened. The receipt is
processed either way; none of these ever fails one. The API's messages and the `message.received`
webhook say the same with `contentTooLarge` (its text, reply and media type are then null) and
`contactsLeftOut` (ADR-132), so an integration can tell such a message from one without text.

**A key's campaign results differ from the campaign page, or a campaign read through the API answers
403 or 404 (ADR-125).** `GET /api/v1/campaigns/{id}` counts the results when it is read, as the
campaign page does on each view: both move as delivery statuses, replies and opt-outs arrive, so
compare them at the same moment. A reply or an opt-out counts once, for the last campaign message
queued to the contact in the 72 hours before it, whichever campaign sent it: a later campaign takes
it from an earlier one. A draft answers `results: null`. 403 `forbidden` means the key lacks
`campaigns.read` (keys keep the scopes they were created with: create a key with it); 403
`not_in_plan` means the company's plan version chose its scopes without it (ADR-092). 404 means the
id is not one of the key's company's campaigns.

**A contact search with a `last_message` or `campaign` condition answers 403 or 422, or finds other
contacts than expected (ADR-126).** 403 `forbidden` names the scope the key lacks:
`conversations.read` for `last_message`, `campaigns.read` for `campaign` (keys keep the scopes they
were created with: create a key with it). 422 naming `conditions.N.campaignId` means the company has
no such campaign (`GET /campaigns` lists them). `last_message` reads when the contact last wrote, in
any conversation, so a contact who only received messages has not written; `not_within_days` also
finds contacts who never wrote. Campaign outcomes count only the recipients a message was sent to:
skipped and cancelled recipients match none. `replied` follows the campaign's reply attribution (the
last campaign message in the 72 hours before the reply, of any campaign), so a later campaign takes
a reply from an earlier one. A segment with the same conditions finds the same contacts: preview it
in the app to compare.

**A campaign's recipients through the API differ from its results or from the Recipients page, or
answer 403, 404 or 422 (ADR-127).** Each `outcome` of `GET /api/v1/campaigns/{id}/recipients` lists
the recipients its count in `results` counts, read when each page is asked for: while a campaign
runs, recipients move between outcomes, so compare a list with a count read at the same moment.
Recipients whose contact was erased are never listed but still counted. Replies and opt-outs count
once their message is delivered: a recipient with `repliedAt` whose message is still `sent` is in
neither `replied` nor its count. The Recipients page in the app groups differently: its Failed
includes unknown outcomes and its Replied shows a reply whatever its message's status. 403
`forbidden` names the scope the key lacks, `campaigns.read` or `contacts.read` (keys keep the scopes
they were created with: create a key with both); `not_in_plan` means the plan leaves it out
(ADR-092). 404 means the id is not one of the key's company's campaigns. 422 names the parameter: an
`outcome` the results do not count, a `cursor` that is not the previous page's `nextCursor`, or an
unknown parameter.

**A template with a photo, video or document header sent through the API failed (ADR-201).**
WhatsApp fetches the header's file from the link when it sends the message, as for media from links
(ADR-194), and `GET /messages/{id}` (and the `message.status` webhook) gives its error. Check that
the link is reachable from the internet without signing in, that the file is of the header's kind,
and that a document is a PDF (Meta's spec, research M-195), then send again with a new
Idempotency-Key. Members cannot send these templates from the inbox, campaigns or automations; the
template's page says so.

**A sticker sent through the API failed (ADR-198).** As for media from links (ADR-194), WhatsApp
fetches the sticker and decides whether the file can be one, and `GET /messages/{id}` (and the
`message.status` webhook) gives its error. Meta's spec uploads stickers as WebP files (research
M-194) but states no format, dimensions or size, so check the file against Meta's current sticker
requirements before sending again with a new Idempotency-Key.

**A contact card sent through the API failed (ADR-197).** `GET /messages/{id}` (and the
`message.status` webhook) gives WhatsApp's error. HyFib sends only the parts Meta's spec describes
(research M-193), in WhatsApp's words, and requires a second part of the name besides
`formattedName`; if WhatsApp refuses a card anyway, record its error code and title and review
M-193. A refusal before sending (422) names the part, such as `contacts.0.phones.1.type`, and the
inbox shows a card sent with its names and numbers.

**A contact card's contacts are missing or partial through the API or a webhook (ADR-196).**
`contacts` gives what WhatsApp sent and HyFib kept: parts the person did not or could not share are
null or empty, a card larger than a message may hold keeps its first contacts (up to 20;
`contactsLeftOut` counts the others), and an erased customer's cards give null. Values that are not
text are left out rather than passed on, and numbers are as the card gives them, not E.164. The
inbox shows the same contacts' names, numbers and email addresses.

**A location sent through the API failed (ADR-195).** HyFib sends the coordinates as decimal text,
as Meta's spec types them, with the name and address given; `GET /messages/{id}` (and the
`message.status` webhook) gives WhatsApp's error when it refuses one. The spec's examples send the
coordinates as numbers (research M-192): if WhatsApp's error names the latitude or the longitude,
record its code and title and review M-192 before changing what HyFib sends. The location is stored
with the message and shown in the inbox with its coordinates.

**A photo, video, audio or document sent through the API failed (ADR-194).** WhatsApp fetches the
media from the message's link when it sends it, and HyFib records what WhatsApp answers:
`GET /messages/{id}` (and the `message.status` webhook) gives the error. The usual causes are a link
that needs signing in or has expired, one not reachable from the internet, or media WhatsApp does
not accept (its type or size). HyFib never fetches the link, so its logs say nothing of the media;
fix the link and send the message again with a new Idempotency-Key. The link is stored with the
message and shown in the inbox.

**A campaign a key submitted waits for approval (ADR-202).** A key's submission always waits for a
member's approval, even where members' own campaigns start at once. Its page names the key; a member
who may approve and send campaigns (owners and administrators) approves it there, and it sends under
their authority, or sends it back with a note. A member who cannot send campaigns sees no Approve
button for it. The key that submitted it can take it back (`POST /campaigns/{id}/withdraw`,
ADR-203), and a member can in the app; either makes it a draft at a new version.

**An approver was not emailed about a waiting campaign (ADR-204).** The email goes, when the
campaign starts waiting, to the company's active owners and administrators other than the member who
submitted it (who cannot approve their own); for a key's submission, only to those who may also send
campaigns. Where the only approver submitted it, nobody is emailed: another owner or administrator
approves it. The email is queued in the submission's transaction (`ops.email_outbox`, dedupe key
`campaign-approval:<campaign id>:<version>:<user id>`) and sent by the email worker: check its dead
letters and the email provider as for other notices. Campaigns submitted before this release, or by
an old web server during a rollout, emailed nobody.

**A member was not told their campaign was approved, sent back or taken back (ADR-205).** The email
goes to the member who submitted it, when someone else approves it, sends it back or takes it back,
and only while they are an active member; a key's submission emails nobody (its integration reads
`campaign.status_changed`). It is queued in the same transaction (`ops.email_outbox`, dedupe key
`campaign-review:<campaign id>:<version>:<user id>`) and sent by the email worker. The campaign's
history on its page shows what happened and the note in any case.

**A segment read through the API has a problem, or another count than expected (ADR-206).**
`problem` says what members' segment page says: usually a condition on a custom field deleted or
changed since, which a member fixes on the segment's page; until then a draft with it cannot be
submitted, and `count` is null. `count` is read when asked, from the contacts as they are then
(erased contacts left out), with dates in the company's time zone, so it changes as contacts do; an
archived segment is not found.

**A segment a key wrote is refused or not where expected (ADR-207).** A 422 names the condition at
fault, as `POST /contacts/search` would (a custom field key the company lacks, a comparison its type
does not take, a campaign of another company); a 409 is a name another segment of the company has,
whatever its case, or a stale `expectedVersion`. The audit log shows which key created, changed or
archived a segment. An archived segment leaves members' Segments page and the API's reads; drafts
with it need another audience before they are submitted.

**A segment's contacts through the API come in short or empty pages, or are refused (ADR-208).**
Each page reads at most 2,000 of the company's contacts, newest first, so a segment that leaves out
most contacts gives short or empty pages with a `nextCursor`: follow it until it is `null`. A 412 is
a segment with a problem, which a member fixes on its page; a 403 naming `conversations.read` is a
segment with a recent-messages condition.

**An approver cannot approve a waiting campaign: its sending period ended (ADR-209).** A campaign
can be approved only until its sending period ends, counted from when it was set to start (its
submission, for one that starts at once); the approval email and its page give the time, and after
it the page offers no Approve button. Send it back with a note; the member who submitted it
schedules it again and submits it, or raises its sending period first.

**A draft's review through the API shows no estimate, or other counts than expected (ADR-193).**
`GET /campaigns/{id}/review` reads the saved draft as members' review does, now: save the draft
first. `estimate` is null without a currency (the spending cap's, or else Settings → Messaging),
without a rate card published in it (platform staff publish one), or when no contact can receive the
campaign; recipients in markets the card has no price for are in `unpricedCount`, left out of the
total. The total is an upper bound (every message at its market's list price). `audience` is null
until the draft has a number, a template and an audience, or when the audience is over 50,000
contacts. 403 means the key lacks `campaigns.write`; 409, that the campaign was submitted (its
results are on `GET /campaigns/{id}`).

**A campaign was paused or cancelled through the API, or `POST /api/v1/campaigns/{id}/pause` or
`/cancel` answers 403, 404, 409 or 423 (ADR-128).** The campaign's page says "Paused through the
API." and its history names the key ("through the API, key “name”"); Settings → Audit log lists
`campaign.paused` or `campaign.canceled` with the key as the actor and the request's id. A member
resumes a paused campaign as any other (messages released by the pause are queued again); a
cancelled campaign is not resumed: create a new one. 403 `forbidden` names the scope the key lacks,
`campaigns.stop` (keys keep the scopes they were created with: create a key with it); `not_in_plan`
means the plan leaves it out (ADR-092). 404 means the id is not one of the key's company's
campaigns. 409 names the campaign's status: only scheduled and running campaigns pause, and a draft
is cancelled only by a key with `campaigns.write` (ADR-187). 423 means the company is suspended or
its plan ended (nothing sends then anyway). To stop a key from stopping campaigns, revoke it and
create one without the scope.

**A campaign was resumed through the API, or `POST /api/v1/campaigns/{id}/resume` answers 403, 404,
409, 412 or 423 (ADR-176).** Its history names the key ("Resumed through the API, key “name”"), and
Settings → Audit log lists `campaign.resumed` with the key as the actor and the request's id; it
sends under the authority of the member who launched it, as before the pause. 403 `forbidden` names
the scope the key lacks, `campaigns.resume` (a key with `campaigns.stop` only does not resume;
create a key with it), or `not_in_plan` (ADR-092). 404 means the id is not one of the key's
company's campaigns. 409 names the campaign's status, or its `pauseReason` when a member or HyFib
paused it: only a key's pause (`api`) is lifted through the API, and members resume the rest in the
app. 412 names the check that failed: the template no longer approved, the number not active, a cap
reached (members raise it in the app), no rate card for the spending cap's currency, or the member
who launched the campaign has left or can no longer send campaigns (a member who can resumes it in
the app, under their own authority). 423 means the company is suspended or its plan ended. To stop a
key from resuming campaigns, revoke it and create one without the scope.

**A key created or changed a campaign draft, or `POST /api/v1/campaigns` or
`PATCH /api/v1/campaigns/{id}` answers 403, 404, 409, 422 or 423 (ADR-186).** The draft's history
names the key ("Created through the API, key “name”", "Edited through the API, key “name”"), and
Settings → Audit log lists `campaign.created` and `campaign.updated` with the key as the actor and
the request's id. A key's draft sends nothing until a member submits and starts it. 403 `forbidden`
names the scope the key lacks, `campaigns.write` (create a key with it), or `not_in_plan` (ADR-092).
404 names what is not the company's: the campaign, the WhatsApp number, the template or the segment
(an archived segment too). 409 names the campaign's status (only drafts are edited) or, with
`expectedVersion`, the draft's version: someone changed it since the key read it, so read it again
(`GET /campaigns/{id}` with a key that also holds `campaigns.write`) and retry. 422 names the
setting that failed members' checks (a condition by segments' rules, the time zone, the window, the
date and time, the spending cap). 423 means the company is suspended or its plan ended. To stop a
key from writing drafts, revoke it and create one without the scope; members edit or cancel the
drafts it wrote in the app.

**`GET /api/v1/orders` answers 403 or 404, or an order seems missing (ADR-167).** 403 `forbidden`
names the scope the key lacks, `orders.read` (keys keep the scopes they were created with: create a
key with it); reason `not_in_plan` means the company's plan leaves out Commerce or the scope
(ADR-092). 404 means the id is not one of the key's company's orders. Orders are listed newest first
by when they were received, and filters narrow them: an order missing from a pass with
`updatedSince` changed while the pass ran, so ask from a little before the previous pass began. An
erased contact's orders have no note: erasure cleared it. Payment Links and payment ids are never in
these answers; the company's Razorpay account has them.

**`PATCH /api/v1/orders/{id}` answers 409, 403 or 423 (ADR-168).** 409 `conflict` names the order's
status: the move is not one members can make from it (a received order is confirmed or cancelled, a
confirmed one fulfilled or cancelled, a paid one fulfilled), the order was not in the
`expectedStatus` given, or it is waiting for payment, which ends when its Payment Link is cancelled
(`POST /orders/{id}/cancel-payment` with `orders.request_payment`, or members in the app). Read the
order (`GET /orders/{id}`) and decide again; an order already in the status asked for answers 200,
so a retry is safe. 403 `forbidden` names the scope the key lacks (`orders.write`, granted by
members with `inbox.reply`), or with reason `not_in_plan` the company's plan leaves out Commerce or
the scope. 423 means the company is suspended or its plan has ended; reading orders still works.

**`POST /api/v1/orders/{id}/request-payment` or `cancel-payment` answers 409, 412, 403 or 423
(ADR-283).** 409 `conflict` names the order's status: payment is asked for only for a received or
confirmed order, once while a link is open (send an `Idempotency-Key` so a retry is safe), and
cancelling needs an open link. 412 `precondition_failed` says what members are told on the order
page: HyFib could not read the whole cart or work out its total, the total is not in rupees, below
₹1 or above the most one link asks for, or the company's Razorpay account is missing or not checked
(Commerce → Payments). 403 `forbidden` names the scope the key lacks (`orders.request_payment`,
granted by members with `inbox.reply`; `orders.write` alone asks for no payment), or with reason
`not_in_plan` the company's plan leaves out Commerce or the scope. 423 means the company is
suspended or its plan has ended. An order waits for payment until Razorpay reports its link paid or
ended; the order page shows the link ("through the API"), whether it was sent in the chat and why
not, and `order.status_changed` events report the outcome.

**`GET /api/v1/orders/{id}/payment-links` shows a link not sent, or answers 403 or 404 (ADR-284).**
`notSentReason` says why HyFib did not send a link in the chat, as the order page does: the customer
service window had closed, the number is inactive, the contact has no number, or Razorpay gave no
https address for it. Members copy the link from the order page, or cancel it and ask again once the
customer writes. `error` says what went wrong at Razorpay (a `failed` link was never created). 403
`forbidden` names the scope the key lacks (`orders.read`), or with reason `not_in_plan` the
company's plan leaves out Commerce; 404 means the order is not one of the company's. A link's
address and Razorpay's ids are never given.

**`GET /api/v1/deals` or `GET /api/v1/pipelines` answers 403 or 404, or a deal seems missing
(ADR-253).** 403 `forbidden` names the scope the key lacks, `deals.read` (keys keep the scopes they
were created with: create a key with it); reason `not_in_plan` means the company's plan leaves out
the CRM or the scope (ADR-092). 404 means the id is not one of the key's company's deals. Deals are
listed newest first by when they were created, closed ones too, and filters narrow them: a deal
missing from a pass with `updatedSince` changed while the pass ran, so ask from a little before the
previous pass began. A deal titled "Deal (contact erased)" without a lost reason belongs to an
erased contact. Archived pipelines are listed with `archived: true`; their deals are closed ones.

**Migration 0168 failed.** It builds `app.crm_deals_list_idx` concurrently. If it failed, an INVALID
index can remain: run `DROP INDEX CONCURRENTLY app.crm_deals_list_idx;` and run the migrations
again.

**`POST /api/v1/deals` answers 403, 404, 409, 422 or 423 (ADR-254).** 403 `forbidden` names the
scope the key lacks, `deals.write` (granted by members with `crm.write`), or with reason
`not_in_plan` the company's plan leaves out the CRM or the scope. 404 means the contact is not one
of the company's or was erased (reason `contact_merged` and `mergedInto` name the contact a merged
one belongs to now). 409 means members archived the pipeline or removed the stage: read GET
/pipelines again. 422 names the field: a pipeline, stage or owner the company does not have, a stage
of another pipeline, or an owner who cannot use the CRM (GET /members). 423 means the company is
suspended or its plan has ended; reading deals still works. A deal created through the API says so
on its page and timeline; the audit log has `crm.deal_created` with the key.

**`PATCH /api/v1/deals/{id}` answers 409, 422 or 404 (ADR-255).** 409 `conflict` says why: the deal
changed since the `expectedVersion` given (read it again and decide), it is closed (reopen it with
`status` `open` before moving it or closing it the other way), its pipeline is archived (members
restore it in the app), its stage was removed, its contact was erased (its details no longer
change), or a merge moved it to another contact while the call ran (try again). 422 names the field:
a stage of another pipeline, an owner who cannot use the CRM, or a lost reason without `status`
`lost` or for an erased contact. 404 means the deal is not one of the key's company's. A call that
asks for the deal as it already is changes nothing and answers 200. The timeline shows each change
"through the API"; the audit log has `crm.deal_updated` with the key and what changed.

**`GET /api/v1/deals/{id}/history` answers 403, 404 or 422, or leaves a change out (ADR-281).** 403
`forbidden` names the scope the key lacks, `deals.read`, or with reason `not_in_plan` the company's
plan leaves out the CRM or the scope. 404 means the id is not one of the company's deals. 422 names
the parameter: `limit` beyond 1 to 100, or a parameter the history does not take. The history gives
the changes the deal events report, newest first: notes and the deal's tasks are read with
`GET /notes` and `GET /tasks`, and a deal of an erased contact has no history, since erasure deletes
the timeline. `changedBy` null means HyFib did not record who made a change; a member is never
named.

**An integration misses a deal change, or hears two at once (ADR-256).** Endpoints that take
`deal.created`, `deal.stage_changed` or `deal.status_changed` are sent one event per deal added and
per change of a deal's stage or status, whoever made it; edits of its title, value or expected date
send `deal.updated` to the endpoints that take it (ADR-275), as does erasure's retitling, and merges
send nothing; a change of its owner sends `deal.owner_changed` to the endpoints that take it
(ADR-269). Changes made while no endpoint took the type were not recorded and are not sent later. A
deal reopened in another stage (its own was removed), or moved and closed by one API request, sends
two events, in the order the steps happened and possibly with the same `createdAt`; each gives the
stage and status its step left. An erased contact's deal is sent titled "Deal (contact erased)",
without its contact's number or name or a lost reason.

**An integration misses a task change, or a task event fails as gone (ADR-261).** Endpoints that
take `task.created` or `task.status_changed` are sent one event per task added and per completion,
cancellation or reopening, whoever made it; edits of its title, notes, due time or reminder send
`task.updated` to the endpoints that take it (ADR-276), and reminders being sent, merges and erasure
send nothing; a change of its assignee sends `task.assignee_changed` to the endpoints that take it
(ADR-274). Changes made while no endpoint took the type were not recorded and are not sent later. A
delivery that failed with `event_gone` belonged to a task that no longer exists: erasing a contact
deletes its tasks. Payloads never carry a task's notes.

**A deal does not move to another pipeline through the API (ADR-257).** 409 with "This pipeline uses
…; clear the deal's value (in …) before moving it" means the deal has a value in another currency:
send `valueMinor` `null` in a request of its own, then move it (with a new value in the pipeline's
currency if needed). 422 names `pipelineId` for a pipeline the company does not have, or `stageId`
for a stage of another pipeline (GET /pipelines). 409 also means the pipeline is archived, the stage
was removed, or the deal is closed (reopen it with `status` `open`, in the same request if wanted).
The pipeline the deal is in, without a stage, changes nothing.

**`GET /api/v1/tasks` answers 403 or 404, or a task seems missing (ADR-258).** 403 `forbidden` names
the scope the key lacks, `tasks.read` (keys keep the scopes they were created with: create a key
with it); reason `not_in_plan` means the company's plan leaves out the CRM or the scope (ADR-092).
404 means the id is not one of the key's company's tasks: erasing a contact deletes its tasks. Tasks
are listed newest first by when they were created, closed ones too, and filters narrow them: a task
missing from a pass with `updatedSince` changed while the pass ran, so ask from a little before the
previous pass began. A task merged from another contact names the contact kept. `reminderSkipReason`
says why a reminder was not sent: the task was closed first (`task_closed`), it came due more than a
day before it could be sent (`too_late`), or the assignee could no longer use the CRM
(`assignee_inactive`).

**Migration 0174 failed.** It builds `app.crm_tasks_list_idx` concurrently. If it failed, an INVALID
index can remain: run `DROP INDEX CONCURRENTLY app.crm_tasks_list_idx;` and run the migrations
again.

**`POST /api/v1/tasks` answers 403, 404, 409, 422 or 423 (ADR-259).** 403 `forbidden` names the
scope the key lacks, `tasks.write` (granted by members with `crm.write`), or with reason
`not_in_plan` the company's plan leaves out the CRM or the scope. 422 names the field: `assigneeId`
for someone who is not an active member able to use the CRM (GET /members lists who can be),
`dealId` for a deal the company does not have, `contactId` for a contact other than the deal's
(leave it out with a deal), `dueAt` beyond five years, and `remindAt` in the past or over a year
ahead. 404 means the contact is not one of the company's or was erased (reason `contact_merged` and
`mergedInto` name the contact a merged one belongs to now). 409 means the deal's contact was erased,
or a merge moved the deal while the task was being created (try again). 423 means the company is
suspended or its plan has ended. A retry with the same `Idempotency-Key` answers the first task,
even after its reminder time.

**`PATCH /api/v1/tasks/{id}` answers 404, 409 or 422 (ADR-260).** 404 means the task is not one of
the company's, or its contact was erased (erasure deletes a contact's tasks). 409 names the
conflict: the task is closed (reopen it with `status` `open`, in the same request if wanted), it is
already done or cancelled the other way, it changed since the `expectedVersion` given (read it
again), or a merge moved it while it was being changed (try again). 422 names the field: an
`assigneeId` who is not an active member able to use the CRM, a `dueAt` beyond five years, or a
`remindAt` in the past or over a year ahead. A task's contact and deal cannot be changed: create a
new task. A retry changes nothing.

**`POST /api/v1/notes` answers 403, 404, 409, 422 or 423 (ADR-268).** 403 `forbidden` names the
scope the key lacks, `notes.write` (granted by members with `crm.write`; keys keep the scopes they
were created with), or with reason `not_in_plan` the company's plan leaves out the CRM or the scope.
422 names the field: `body` empty or over 4,000 characters, `dealId` for a deal the company does not
have, `contactId` for a contact other than the deal's (leave it out with a deal), or neither given.
404 means the contact is not one of the company's or was erased (reason `contact_merged` and
`mergedInto` name the contact a merged one belongs to now). 409 means the deal's contact was erased,
or a merge moved the deal while the note was being added (try again). 423 means the company is
suspended or its plan has ended. A note added cannot be changed or deleted through the API, and a
key with `notes.read` reads it back (ADR-279); members see it on the timeline as written through the
API. A retry with the same `Idempotency-Key` answers the first note.

**`GET /api/v1/notes` or `/notes/{id}` answers 403, 404 or 422, or leaves out a note (ADR-279).**
403 `forbidden` names the scope the key lacks, `notes.read` (granted by members with `crm.read`;
`notes.write` adds notes but does not read them, and keys keep the scopes they were created with),
or with reason `not_in_plan` the company's plan leaves out the CRM or the scope. 422 names the
parameter: `limit` beyond 1 to 100, `contactId` or `dealId` not a UUID, `createdSince` not an ISO
time, or a parameter the list does not take. 404 means the id is not one of the company's notes:
another company's, any other timeline entry (a stage move, a closing, a task entry), or a note of a
contact since erased. A note left out of a page filtered by contact was moved to another contact by
a merge (its `contactId` is now the contact kept), or was added with a time before `createdSince`
while the integration's previous pass was reading: ask from a minute before the previous pass began.
`writtenBy` says `member` or `api`, with `apiKeyId` for a key's note; which member wrote a note is
shown on the contact and deal pages only.

**`GET /api/v1/contact-tags` or `/conversation-tags` answers 403 or 422, or leaves out a tag
(ADR-272).** 403 `forbidden` names the scope the key lacks: `contacts.read` for contact tags,
`conversations.read` for conversation tags (keys keep the scopes they were created with). 422 names
the parameter: `limit` beyond 1 to 100, `prefix` with a comma or nothing but spaces, `cursor` that
does not decode to a tag as tags are written (give the `nextCursor` a page answered), or one it does
not take. A tag is listed only while a contact or conversation has it: one removed from its last
contact or conversation, or only on erased contacts, is gone, and a tag first used before the cursor
while a reader pages appears on the next pass. Counts are read with each page, so two pages can add
up to more or fewer than the total. Tags are listed as they are written (lower case, single spaces);
a `prefix` is compared the same way.

**`GET /api/v1/channels` answers 403, or a number shows no phone or name (ADR-171).** 403
`forbidden` names the scope the key lacks, `channels.read` (keys keep the scopes they were created
with: create a key with it); reason `not_in_plan` means the company's plan leaves the scope out
(ADR-092). Every number of the company is listed, whatever its status (`status=active` for those
that send and receive). A number still being connected has no phone or name until Meta reports
them.

**A search with `POST /api/v1/contacts/search` gives short or empty pages, or a 422 (ADR-117).**
Its pages read at most 2,000 contacts, as filtered lists do (entry above): the integration sends the
same conditions with each `nextCursor` until it is `null`. A 422 names the condition's part:
`conditions.<i>.key` for a key the company has no field for (`GET /api/v1/contact-fields`), `.op` for
a comparison the field's type does not take (the message lists those it takes), `.value` for a value
missing, given to a comparison that takes none (`is_set`, `is_not_set`, `is_true`, `is_false`), not a
number, not a date that exists, or a number for a text or date field, `.tag`, `.date` for a creation
day that does not exist, and `.type` for a condition the API does not offer (segments'
`last_message` and `campaign` read conversations and campaigns, which `contacts.read` does not
give). Creation days are the company's, in its time zone (Settings → General), so a contact added
late in the evening UTC can fall on the next day there. The search and a segment with the same
conditions find the same contacts.

**A segment or campaign says "Enter a date written as YYYY-MM-DD." (ADR-117).** One of its
conditions has a creation day or a date comparison that does not exist, like 30 February. Such a
segment used to make its page or the campaign's audience fail; now it names the problem and shows no
preview until a member changes the condition to a real date.

**The contact change feed shows nothing new for a while, or refuses a cursor (ADR-114).**
`GET /api/v1/contact-changes` reads a change only once every transaction that began before it has
finished, so a long transaction anywhere in the database (a large import, a session left idle in a
transaction) holds the feed back until it ends; nothing is skipped. Find it with
`SELECT pid, state, xact_start, backend_xid FROM pg_stat_activity WHERE backend_xid IS NOT NULL ORDER BY xact_start`
and let it finish or end it. A 422 with path `cursor` means the cursor is not one this company's
feed gave, was changed, or was sealed with an encryption key the platform no longer holds (retiring
a key ends the cursors sealed with it): the integration starts again without a cursor, which lists
every contact. The worker's minute sweep compacts the change rows (`replaced contact changes
deleted` in its log); `ops.contact_change_compaction.compacted_at` shows when it last ran. If it
stops, the feed still answers correctly, with more rows to pass.

**A key cannot add, rename or delete a custom field (ADR-115).** The key needs the "Define contact
fields" scope (`contact_fields.manage`), which only owners and administrators can grant, and a plan
version that chose its scopes may leave it out (403 `not_in_plan`). A 409 naming `key` means the
company has a field with that key (also when the key was made from the label: give `key`); a 422
at the 51st field means the company has 50 (delete one in Settings or through the API first). A 404
means the company has no field with that key (keys are lower-case; list them with
`GET /contact-fields`). A field's key and type never change: add a new field and delete the old one.
Who added, renamed or deleted a field is in the audit log (`contact_field.created`, `.renamed`,
`.deleted`, actor `api_key` or `user`). Deleting a field deletes every contact's value for it.

**The message change feed shows nothing new for a while, or refuses a cursor (ADR-116).**
`GET /api/v1/message-changes` reads a change only once every transaction that began before it has
finished, as the contact change feed does (its entry above has the query that finds a long
transaction); nothing is skipped. A message changed by a transaction still running is read once that
transaction ends, at its new place. A 422 with path `cursor` means the cursor is not one this
company's message feed gave (a contact feed cursor does not open it), was changed, or was sealed
with an encryption key the platform no longer holds: the integration starts again without a cursor,
which lists every message. The rows are written only by the trigger on `app.messages`; a message
missing from the feed after its change committed and every older transaction ended is a bug: check
`SELECT xact FROM app.message_changes WHERE message_id = '<id>'` against `pg_current_snapshot()`.

**The company is suspended or its plan ended.** Keys keep reading; creating and changing contacts,
recording consent, defining contact fields, sending, resolving conversations and adding notes to
them, starting and stopping automations, and managing webhook endpoints (reading them and their
deliveries included) answer 423 until the company is active again.

**Migration 0024 failed.** It runs in one transaction. It creates the two tables, the guard trigger,
the two SECURITY DEFINER functions (granted to `w360_app` before their ownership moves to
`w360_definer`), adds `messages.api_key_id` and widens the consent actor check. A failure usually
means the bootstrap roles are missing (`infra/db/bootstrap-roles.sql`).

**Migration 0073 failed.** It runs in one transaction, so a failure applies nothing. It adds
`app.api_keys.monthly_request_limit` (a nullable column with a check, validated against the keys
already stored: a short `ACCESS EXCLUSIVE` lock on the keys table), creates `app.api_key_usage` with
row security and its grants, and registers deletion step 855 with the definer's grants and
policies. A failure usually means a lock wait on `app.api_keys` timed out (run the migrations again
when requests are quieter) or the bootstrap roles are missing.

**Migration 0088 failed.** It runs in one transaction, so a failure applies nothing. It adds
`ops.plans.api_request_pack_size` and `api_request_pack_price_minor` (with checks),
`app.tenant_plans.api_request_packs` and `app.plan_subscriptions.api_request_packs` (with defaults,
so no table is rewritten; short locks), replaces the plan guard, the plan state's guard, the follow
guard and `app.tenant_entitlements`, adds the start guard trigger and a four-quantity
`app.choose_add_ons`, and recreates `app.apply_plan_subscription_period`,
`ops.usage_limits_reached`, `ops.api_quota_reached` and `ops.usage_warnings_due` (dropped as
`w360_definer`, recreated by the migration role, granted to `w360_app` and handed back). A failure
usually means the bootstrap roles are missing (`w360_owner` must be a member of `w360_definer`).
Images built before it keep working: the three-quantity `app.choose_add_ons` stays, and the start
guard refuses an old image's subscription only for a company that has API request packs (which
only a new image can have set), so its payments never fail to match the plan. Run it before the new
images. Before running it, `SELECT tp.tenant_id FROM app.tenant_plans tp JOIN ops.plans p ON p.id =
tp.plan_id WHERE tp.run_packs > 0 AND p.automation_runs_monthly::bigint + tp.run_packs::bigint *
p.run_pack_size > 2000000000` should return no rows: such a company's entitlement checks already
fail with "integer out of range", and after the migration every change of its plan state, the
sweep's included, is refused until staff lower its run packs from the company's platform page.

**Migration 0087 failed.** It runs in one transaction, so a failure applies nothing. It adds
`app.plan_subscriptions.follows_subscription_id` (nullable, with a composite foreign key and a
check), replaces the unique index on live subscriptions with one on those not ending at their
period's end (a short lock on the subscriptions table), adds the follow guard trigger, replaces the
plan guard `app.guard_tenant_plan()`, and recreates `app.apply_plan_subscription_period` and
`app.apply_plan_transition` (dropped as `w360_definer`, recreated by the migration role, granted to
`w360_app` and handed back). A failure usually means the bootstrap roles are missing (`w360_owner`
must be a member of `w360_definer`). Web and worker images built before it keep working (they never
record a following subscription); the new web image needs it for Billing → Change plan, so run it
before that image.

**Migration 0085 failed.** It runs in one transaction, so a failure applies nothing. It adds two
nullable columns and a check to `ops.plan_settings` (a single row, so the lock is brief), lets the
platform role update them, and lets the runtime role read the default trial and whether the price
list is shown. A failure usually means the bootstrap roles are missing. Web images built before it
keep working; the new web image needs it for `/pricing` and the platform Plans page, so run it
before that image.

**Migration 0084 failed.** It runs in one transaction, so a failure applies nothing. It adds
`app.choose_add_ons` (SECURITY DEFINER, owned by `w360_definer`, executable by `w360_app` only) and
changes no table. A failure usually means the bootstrap roles are missing (`w360_owner` must be a
member of `w360_definer`). Web images built before it keep working; the new web image needs it for
Billing → Add-ons, so run it before that image.

**Migration 0083 failed.** It runs in one transaction, so a failure applies nothing. It replaces
the plan guard `ops.guard_plan()` and recreates `app.choose_plan` (dropped as `w360_definer`,
recreated by the migration role, granted to `w360_app` and handed back to `w360_definer`), so that a
choice waits for a withdrawal or retirement of its version in progress. A failure usually means the
bootstrap roles are missing (`w360_owner` must be a member of `w360_definer`). Web images built for
0082 keep working after it (the function keeps its name, argument and result); run it with 0082,
before the new web image.

**Migration 0082 failed.** It runs in one transaction, so a failure applies nothing. It adds
`ops.plans.offered_at` and `offered_by_user_id` (nullable, with two checks validated against the
plans already stored: a short `ACCESS EXCLUSIVE` lock on the small plans table) and the platform
role's update grant on them, replaces the plan guard `ops.guard_plan()`, and creates
`app.choose_plan`, granted to `w360_app` before it is handed to `w360_definer`. A failure usually
means a function of the same name was created by hand or the bootstrap roles are missing. Web
images from before it never read the new columns and keep working, except that one cannot retire a
version a new image offered (the check refuses a retired version with an offer: retire it from a new
image, or stop offering it first). The new web image needs it: Billing and the platform plan pages
read the offer (migrate first).

**Migration 0081 failed.** It runs in one transaction, so a failure applies nothing. It creates
`app.plan_payment_refund_requests` (empty, with row security, column grants, a restrictive policy
for the company role and deletion step 77), the notice functions for the worker, the platform lists
and `ops.platform_decide_plan_payment_refund_request`, each granted before it is handed to
`w360_definer`. A failure usually means a deletion step numbered 77 already exists, a function of
the same name was created by hand, or the bootstrap roles are missing. Web and worker images from
before it never read the new table and keep working. The new images need it: without it, asking for
a refund of service credit and the minute billing sweep fail (migrate first).

**Migration 0080 failed.** It runs in one transaction, so a failure applies nothing. It creates
`app.plan_payment_refunds` (empty, with row security, a rule that nobody deletes a row and the
roles' grants), `ops.platform_request_plan_payment_refund` (platform role), and
`ops.plan_payment_refunds_due` and `app.record_plan_payment_refund` (runtime role), each handed to
`w360_definer`, and rebuilds `ops.settlement_recon_facts`: `w360_definer` drops it, and the migration
role recreates it, grants it to `w360_app` and hands it back. A failure usually means the bootstrap
roles are missing: run the migrations again. Web and worker images from before it do not know
refunds of plan payments and leave refunds made in the Dashboard unrecorded, as before; the new
images need it (migrate first).

**Migration 0079 failed.** It runs in one transaction, so a failure applies nothing. It adds
`starts_at` to `app.plan_subscriptions` (nullable, with a check validated against the rows stored: a
short lock on the table), creates `app.trial_charge_wait_until` (granted to `w360_app` and
`w360_definer`), and rebuilds `app.apply_plan_transition`, `ops.plan_transitions_due` and
`ops.plan_subscriptions_due`: `w360_definer` drops each, and the migration role recreates it, grants
it to `w360_app` and hands it back to `w360_definer`. A failure usually means the bootstrap roles
are missing or a lock wait on `app.plan_subscriptions` timed out: run the migrations again. Web and
worker images from before it keep charging trials at once; the new images need it (migrate first).

**Migration 0078 failed.** It runs in one transaction, so a failure applies nothing. It adds
`staff_cancel_notice_due` to `app.plan_subscriptions` (a boolean defaulting to false, so no rows are
rewritten) with a partial index, the platform role's update grant on it,
`ops.plan_subscription_cancel_notices_due` and `app.take_plan_subscription_cancel_notice` (granted
to `w360_app`, then handed to `w360_definer`), and the definer's update grant and policy for that
column. A failure usually means the bootstrap roles are missing or a lock wait on
`app.plan_subscriptions` timed out: run the migrations again. Cancellations made before it are not
told.

**Migration 0077 failed.** It runs in one transaction, so a failure applies nothing. It adds
`staff_notice_version` to `app.tenant_plans` with a check and a partial index (a short lock on the
table, one row per company), the platform role's update grant on it, and
`ops.plan_change_notices_due` and `app.take_plan_change_notice` (granted to `w360_app`, then handed
to `w360_definer`). A failure usually means the bootstrap roles are missing or a lock wait on
`app.tenant_plans` timed out: run the migrations again. Staff changes made before it are not told.

**Migration 0076 failed.** It runs in one transaction, so a failure applies nothing, and the
authentication function stays as it was. It creates `app.api_settings` with row security, its grants
and deletion step 857, and rebuilds `ops.api_key_authenticate(text, inet)`: the migration role drops
it as the owner of the `ops` schema, creates it, grants it to `w360_app` and hands it to
`w360_definer`. A failure usually means the bootstrap roles are missing (`w360_owner` must be able to
`SET ROLE w360_definer`) or a lock wait timed out: run the migrations again. While it runs, requests
keep using the old function; web servers of the previous release keep working after it.

**Migration 0075 failed.** It runs in one transaction, so a failure applies nothing. It adds
`warned_at` and `notified_at` to `app.api_key_usage` with their grant, a partial index, and
`ops.api_key_usage_notices_due` (granted to `w360_app`, then handed to `w360_definer`, with the
definer's column grants and read policy). A failure usually means the bootstrap roles are missing
or a lock wait on `app.api_key_usage` timed out: run the migrations again when requests are quieter.

**Migration 0074 failed.** It runs in one transaction and only drops
`ops.api_key_authenticate(text)`, the lookup without the client's address that 0051 kept for web
servers of the previous release. A failure usually means something created since depends on it
(nothing in the application does): find it with `SELECT * FROM pg_depend WHERE refobjid =
'ops.api_key_authenticate(text)'::regprocedure` before running it again. Web servers of a release
before 0051 can no longer authenticate keys once it has run.

## 10O. Outgoing webhooks

**"Our endpoint gets nothing."** In Settings → Webhooks (owners and administrators) check that the
endpoint is on and subscribed to the event, then open its deliveries. No delivery at all means no
subscribed event happened since the endpoint was added (events are captured only while an active
endpoint subscribes; earlier ones are not sent). "Send test event" queues a `ping`; the result
column names what went wrong: an HTTP status, `timeout` (no complete answer within 10 seconds),
`dns_failed`, `address_blocked` (the name resolves to a private, loopback or reserved address, which
is never called), `connect_failed`, `response_too_large` (more than 256 KB) or `invalid_status`;
"HyFib could not prepare the request" (`payload_failed`) is HyFib's side, see below.
Redirects are not followed: the endpoint must answer at the saved URL.

**Deliveries wait and are not sent.** The worker is woken by the `w360_webhooks` notification and
by the minute sweep. Check the `webhook.deliver` queue (section 3) and the worker log for
`webhooks delivered` and `webhook dispatch failed`; a listener that cannot connect logs
`webhook listener could not listen` and delivery then waits for the minute sweep. Suspended and
restricted companies are not delivered to until they are active again. A delivery in `delivering`
longer than 45 seconds belongs to a lost worker; the next run attempts it again (the receiver may see
it twice and deduplicates on the event id).

**A delivery failed as `payload_failed` ("HyFib could not prepare the request").** HyFib could not
build the event's payload, sign it or open the endpoint's headers: a bug in a payload builder, an
event it cannot describe, a database error while building (a lock or statement timeout included), or
an endpoint secret or the endpoint's own headers (ADR-118) the keyring cannot open. No request was
made: the delivery used no attempt, the endpoint's health is unchanged and the company's other
deliveries went on. A backlog of them is ended 200 deliveries per job, each job queueing the next
(`handedOver` in `webhooks delivered`). The worker logs
`webhook delivery could not be prepared; failed as payload_failed` with `tenantId`, `deliveryId`,
`endpointId`, `eventType`, `stage` (`payload`, `signature` or `headers`), `errorClass` and
`errorCode` (a SQLSTATE for a database error), never the payload or the error's message. One
`eventType` failing across deliveries is a builder bug: reproduce it from the event row
(`app.webhook_events`, by the delivery's `event_id`) on a copy, not from the log. `stage`
`signature` on every delivery of one endpoint means its secret cannot be opened: a key missing from
`W360_ENCRYPTION_KEYS`, or a secret restored with the wrong version. Restore the key; if it cannot
come back, the company deletes the endpoint and adds it again (rotating keeps the unreadable
previous secret signing for 24 hours, so those deliveries keep failing). `stage` `headers` on every
delivery of one endpoint means its own headers cannot be opened: a key missing from
`W360_ENCRYPTION_KEYS`, or headers restored onto another endpoint (they are bound to theirs).
Restore the key; if it cannot come back, the company gives the headers again ("Replace the headers"
on the endpoint's page, or `PATCH /webhook-endpoints/{id}` with `headers`). `errorCode` `55P03` or
`57014` is a lock or statement timeout. Once the cause is fixed, the company replays: "Replay failed
deliveries" on the endpoint's page, or `POST /webhook-endpoints/{id}/replay-failed`, includes
`payload_failed` deliveries (unlike `event_gone`). Until 2026-10-02 such a delivery failed the whole
`webhook.deliver` job instead: none of the company's deliveries went out, the minute sweep woke the
job again every minute and the dead letters filled with the same failure. Deploying the change ends
that by itself.

**A receiver refuses deliveries for a missing or wrong header (ADR-118).** An endpoint can send up
to 5 headers of its own (an `Authorization` or API key header its receiver issued) with every
attempt, test event and replay; the endpoints list shows their names ("Headers sent: …"), the API
answers `headers: [{ name }]`, and no one can read a value back, support staff included. When the
receiver answers 401 or 403, or says a header is missing, the company gives the headers again with
the values the receiver issued: on the endpoint's page, "Replace the headers" (every header again; a
change replaces the list, and none removes them), or `PATCH /webhook-endpoints/{id}` with
`headers`. Then "Send test event" and, once it is delivered, "Replay failed deliveries". Names are
sent in lowercase (HTTP header names are case-insensitive), values as saved, trimmed. "HyFib sets
this header itself." refuses `Content-Type`, `Content-Encoding`, `User-Agent`, the transport's
headers (`Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Keep-Alive`, `Upgrade`, `TE`,
`Trailer`, `Expect`, `Accept-Encoding`), `Proxy-*` and `W360-*`; a receiver that needs one of them
cannot be served by this endpoint. A change takes effect at the next attempt, even of a delivery
already waiting.

**A receiver gets fewer `message.status` events than expected (ADR-119).** An endpoint can take
only some statuses; the endpoints list shows them ("Message statuses sent: …"), and the API answers
`messageStatuses` (null takes every status). A status the endpoint does not take is never queued for
it, and when no endpoint of the company takes it, no event is recorded at all, so there is nothing
to replay: statuses captured before a change are not sent afterwards. To take more, tick them under
"Message status" on the endpoint's page (all ticked takes every status, including statuses added
later), or `PATCH /webhook-endpoints/{id}` with `messageStatuses` (null for every status). Removing
the `message.status` event clears the list. A message's status only moves forward, so one read
before WhatsApp reported its delivery never reaches `delivered`: a receiver that takes only
`delivered` misses such messages, and one that needs to know a message arrived should take `read`
too.

**A receiver gets fewer `contact.updated` events than expected (ADR-123).** An endpoint can take
the event only for some parts of a contact; the endpoints list shows them ("Contact changes sent:
…"), and the API answers `contactParts` (null takes every change). A change that names none of
them is never queued for the endpoint, and changes saved before the endpoint took more are not sent
afterwards. To take more, tick them under "Contact changed" on the endpoint's page (all ticked takes
every change, including parts added later), or `PATCH /webhook-endpoints/{id}` with `contactParts`
(null for every change). Removing the `contact.updated` event clears the list. One event stands
for a contact's whole transaction and names every part it changed, so an endpoint taking only
emails also receives an event that changed the email and the tags, naming both.

**A receiver misses a custom field's changes (ADR-184).** An endpoint can take the changes of chosen
custom fields only. The endpoints list shows them ("Custom fields whose changes are sent: …"), and
the API answers `contactFieldKeys` (null takes every field's). A change of another field is never
queued for the endpoint (one that also changed a part the endpoint takes is, naming every part), and
when no endpoint of the company takes a change, it is not recorded for it, so there is nothing to
replay. A field deleted since it was chosen shows as "… (deleted)". To take more, tick the fields
under "Custom fields" on the endpoint's page or choose "Every custom field’s changes", or
`PATCH /webhook-endpoints/{id}` with `contactFieldKeys` (null for every field). Leaving out Contact
changed, or its custom field values, clears the list.

**A receiver gets no automation run events for an automation (ADR-145).** An endpoint can take
the runs of chosen automations only; the endpoints list shows them ("Automation runs sent: …",
archived ones marked), and the API answers `automationIds` (null takes every automation's runs). A
run of another automation is never queued for it, and when no endpoint of the company takes a run,
no event is recorded at all, so there is nothing to replay: runs that started or ended before a
change are not sent afterwards. To take more, choose "Every automation’s runs" or tick the
automation under "Automation runs sent" on the endpoint's page (only published automations are
offered; publish a draft first), or `PATCH /webhook-endpoints/{id}` with `automationIds` (null for
every automation). Removing both automation run events clears the list. An archived automation has
no runs until it is restored; it stays in the list meanwhile.

**A receiver gets fewer campaign.status_changed events than expected (ADR-146).** An endpoint can
take only the statuses a campaign reaches that it chose; the endpoints list shows them ("Campaign
statuses sent: …"), and the API answers `campaignStatuses` (null takes every status). A change to
another status is never queued for it, and when no endpoint of the company takes a change, no
event is recorded at all, so there is nothing to replay: changes made before an edit are not sent
afterwards. Each event still names the status before it (`previousStatus`), so an endpoint taking
only `completed` learns what a campaign completed from. To take more, tick the statuses under
"Campaign status" on the endpoint's page (all ticked takes every status, as a new endpoint does),
or `PATCH /webhook-endpoints/{id}` with `campaignStatuses` (null for every status). Removing the
`campaign.status_changed` event clears the list.

**A receiver gets fewer order.status_changed events than expected (ADR-147).** An endpoint can take
only the statuses an order reaches that it chose; the endpoints list shows them ("Order statuses
sent: …"), and the API answers `orderStatuses` (null takes every status). A change to another
status is never queued for it, and when no endpoint of the company takes a change, no event is
recorded at all, so there is nothing to replay: changes made before an edit are not sent
afterwards. `order.received` is never filtered, and each change still names the status before it
(`previousStatus`). An order paid through its Payment Link reaches `awaiting_payment` and then
`paid`; one whose link ended unpaid goes back to `confirmed`, which an endpoint taking only `paid`
does not receive. To take more, tick the statuses under "Order status" on the endpoint's page (all
ticked takes every status, as a new endpoint does), or `PATCH /webhook-endpoints/{id}` with
`orderStatuses` (null for every status). Removing the `order.status_changed` event clears the list.

**A receiver gets fewer template.status_changed events than expected (ADR-148).** An endpoint can
take only the template statuses it chose; the endpoints list shows them ("Template statuses sent:
…"), and the API answers `templateStatuses` (null takes every status). A status it did not choose is
never queued for it, and when no endpoint of the company takes a status, no event is recorded at
all, so there is nothing to replay: statuses reported before an edit are not sent afterwards. A
template's review starts as "In review" (`pending`) and then reaches `approved` or `rejected`; a
deletion that fails returns the template to the status Meta last reported, which is sent again to
the endpoints that take that status. HyFib's own steps (drafts, submissions, a submission that
failed, a deletion under way or refused) are never sent. To take more, tick the statuses under
"Template status" on the endpoint's page (all ticked takes every status, as a new endpoint does), or
`PATCH /webhook-endpoints/{id}` with `templateStatuses` (null for every status). Removing the
`template.status_changed` event clears the list.

**A receiver gets fewer conversation.status_changed events than expected (ADR-149).** An endpoint
can take only the statuses a conversation reaches that it chose, `open` (reopened) or `resolved`;
the endpoints list shows them ("Conversation statuses sent: …"), and the API answers
`conversationStatuses` (null takes every status). A change to the other status is never queued for
it, and when no endpoint of the company takes a change, no event is recorded at all, so there is
nothing to replay: changes made before an edit are not sent afterwards. Each change still names the
status before it (`previousStatus`). A conversation the contact writes to again after it was
resolved is reopened, which an endpoint taking only `resolved` does not receive. To take more, tick
the statuses under "Conversation status" on the endpoint's page (both ticked takes every status, as
a new endpoint does), or `PATCH /webhook-endpoints/{id}` with `conversationStatuses` (null for every
status). Removing the `conversation.status_changed` event clears the list.

**A receiver gets fewer automation.run_ended events than expected (ADR-151).** An endpoint can take
only the ends it chose of the runs it takes: completed, handed off, taken over, stopped or failed;
the endpoints list shows them ("Automation ends sent: …"), and the API answers `runEndStatuses`
(null takes every end). Its automations ("Automation runs sent: …", ADR-145) apply as well: an end
is sent only for a run of an automation it takes and with a status it chose. An end of another
status is never queued for it, and when no endpoint of the company takes an end, no event is
recorded at all, so there is nothing to replay: runs that ended before an edit are not sent
afterwards. Starts are not filtered by the list. To take more, tick the ends under "Automation
ended" on the endpoint's page (every end ticked takes them all, as a new endpoint does), or
`PATCH /webhook-endpoints/{id}` with `runEndStatuses` (null for every end). Removing the
`automation.run_ended` event clears the list.

**A receiver gets no events of some numbers (ADR-170).** An endpoint can take the events of chosen
WhatsApp numbers only: the endpoints list shows them ("Numbers whose events are sent: …"), and the
API answers `channelIds` (null takes every number's). Messages, message statuses, conversation
changes, automation runs, orders and campaigns of another number are never queued for it, and when
no endpoint of the company takes such an event, no event is recorded at all, so there is nothing to
replay: events from before an edit are not sent afterwards. A campaign's events are those of the
number it sends from; a campaign without a number yet is on no list. Consent, contact and template
events are not filtered by number. To take more, tick the numbers under "WhatsApp numbers" on the
endpoint's page or choose "Every number’s events" (which also takes numbers connected later), or
`PATCH /webhook-endpoints/{id}` with `channelIds` (null for every number). Removing every event of a
number clears the list.

**A receiver gets the statuses of only some messages (ADR-172).** An endpoint can take
`message.status` only for the messages some senders sent: members, automations, campaigns, the API
or HyFib (store order updates and satisfaction surveys). The endpoints list shows them ("Statuses of
messages sent by: …"), and the API answers `messageSenders` (null takes every message's); each
status names its sender in `message.sentBy`. A status of another sender's message is never queued
for it, and when no endpoint of the company takes a status, no event is recorded at all, so there is
nothing to replay: statuses from before an edit are not sent afterwards. To take more, tick the
senders under "Message status" on the endpoint's page (every sender ticked takes every message's),
or `PATCH /webhook-endpoints/{id}` with `messageSenders` (null for every sender). Removing the
`message.status` event clears the list.

**Deliveries fail with `oauth_token_…`, or a receiver keeps answering 401 (ADR-173).** An endpoint
with an OAuth client gets an access token from its token URL before its deliveries; when none comes,
the attempt fails without calling the endpoint and is retried on the usual schedule.
`oauth_token_refused_401` or `_400`: the authorization server refused the client ID, the secret or
the scope; `oauth_token_refused_404` or a 3xx: the token URL is wrong (redirects are not followed);
`oauth_token_invalid`: it answered 200 without a bearer token (an HTML page, or a token type other
than Bearer); `oauth_token_timeout`, `_dns_failed`, `_connect_failed` or `_address_blocked`: the
token URL cannot be reached, or is not a public https address. Check the client with the receiver's
owner and change it on the endpoint's page ("Change the OAuth client"; a new token URL needs the
secret again), or `PATCH /webhook-endpoints/{id}` with `oauth`. A token the endpoint answers 401 to
is dropped and a new one is asked for at the next attempt; a 401 every time means the receiver does
not accept the server's tokens (often the scope). Tokens live in each worker's memory, so restarting
workers makes them ask again. Replay what failed meanwhile with the "No valid answer" failures.

**A receiver misses a conversation's events (ADR-174).** An endpoint can take the message and
conversation events of chosen teams' conversations only. The endpoints list shows them ("Teams whose
conversations’ events are sent: …"), and the API answers `teamIds` (null takes every
conversation's). A conversation's events go by the team it is in when they happen: one in no team,
or in another team, is never queued for the endpoint (a change of team reaches the team it left as
well as the one it joined), and when no endpoint of the company takes an event, it is not recorded
at all, so there is nothing to replay. A team deleted since it was chosen shows as "A deleted team"
and matches nothing. To take more, tick the teams under "Teams" on the endpoint's page or choose
"Every conversation’s events", or `PATCH /webhook-endpoints/{id}` with `teamIds` (null for every
conversation). Removing every message and conversation event clears the list.

**A receiver misses a message's statuses or a template's changes (ADR-175).** An endpoint can take
the statuses and changes of chosen templates only. The endpoints list shows them ("Templates whose
statuses and changes are sent: …"), and the API answers `templateIds` (null takes every template's).
A message's statuses go by the template it was sent with: those of a message sent without one (a
member's reply, an automation's text) or with another template are never queued for the endpoint,
and when no endpoint of the company takes an event, it is not recorded at all, so there is nothing
to replay. To take more, tick the templates under "Templates" on the endpoint's page or choose
"Every message’s statuses and every template’s changes", or `PATCH /webhook-endpoints/{id}` with
`templateIds` (null for every template). Removing both Message status and Template status clears the
list.

**A receiver misses automation ends (ADR-192).** An endpoint can take the runs of an end that ended
for chosen reasons only. The endpoints list shows them ("Automation ends narrowed to: …"), and the
API answers `runEndReasons` (null takes every reason). A list narrows only the ends it names reasons
of: a run that ended with one of them goes only when its reason is listed (a failure for `expired`
is never queued for an endpoint naming `send_failed` only), and when no endpoint of the company
takes an end, it is not recorded at all, so there is nothing to replay. The runs of its other ends
go as before. To take more, tick the reasons by status under "Automation ended" on the endpoint's
page, or `PATCH /webhook-endpoints/{id}` with `runEndReasons` (null for every reason). A reason of
an end the endpoint does not take is refused: take its status first. Removing Automation ended
clears the list.

**A receiver misses received messages (ADR-191).** An endpoint can take the received messages of
chosen types only. The endpoints list shows them ("Received messages sent: …"), and the API answers
`messageTypes` (null takes every type). A message goes by its type (`message.type`): those of other
types are never queued for the endpoint, and when no endpoint of the company takes a message, it is
not recorded at all, so there is nothing to replay. A tap on reply buttons or a list row is
`interactive`; a tap on a template's quick-reply button is `button`. To take more, tick the types
under "Message received" on the endpoint's page, or `PATCH /webhook-endpoints/{id}` with
`messageTypes` (null for every type). Removing Message received clears the list.

**A receiver misses added contacts (ADR-190).** An endpoint can take the `contact.created` of the
contacts from chosen sources only. The endpoints list shows them ("New contacts sent: …"), and the
API answers `contactSources` (null takes every contact). An added contact goes by its source
(`contact.source`): one from another source is never queued for the endpoint, and its later changes
are `contact.updated` events, which the list does not narrow. To take more, tick the sources under
"Contact added" on the endpoint's page, or `PATCH /webhook-endpoints/{id}` with `contactSources`
(null for every contact). Removing Contact added clears the list. A receiver that is sent its own
contacts back should leave out `api`.

**A receiver misses consent changes (ADR-189).** An endpoint can take chosen consent changes only.
The endpoints list shows them ("Consent changes sent: …"), and the API answers `consentChanges`
(null takes every change). A change goes by its purpose and action (`marketing_opt_out`): the others
are never queued for the endpoint, and when no endpoint of the company takes a change, it is not
recorded at all, so there is nothing to replay. An erasure records opt-outs for both purposes, which
the same list narrows. To take more, tick the changes under "Consent changed" on the endpoint's
page, or `PATCH /webhook-endpoints/{id}` with `consentChanges` (null for every change). Removing
Consent changed clears the list.

**A receiver misses a campaign's message statuses or changes (ADR-185).** An endpoint can take the
statuses and changes of chosen campaigns only. The endpoints list shows them ("Campaigns whose
statuses and changes are sent: …"), and the API answers `campaignIds` (null takes every campaign's).
A message's statuses go by the campaign that sent it: those of a message no campaign sent (a
member's reply, an automation's message) or another campaign sent are never queued for the endpoint,
and when no endpoint of the company takes an event, it is not recorded at all, so there is nothing
to replay. Settings lists the 200 newest campaigns; an older one can be chosen through the API. To
take more, tick the campaigns under "Campaigns" on the endpoint's page or choose "Every message’s
statuses and every campaign’s changes", or `PATCH /webhook-endpoints/{id}` with `campaignIds` (null
for every campaign). Removing both Message status and Campaign status clears the list. Each status
names its campaign as `message.campaignId`, null for a message no campaign sent.

**A receiver misses a deal's events (ADR-263).** An endpoint can take the deal events of chosen
pipelines only. The endpoints list shows them ("Pipelines whose deals’ events are sent: …"), and the
API answers `pipelineIds` (null takes every pipeline's). A deal's events go by the pipeline each
event gives (`deal.pipelineId`): those of a deal in another pipeline are never queued for the
endpoint, and when no endpoint of the company takes an event, it is not recorded at all, so there is
nothing to replay. A move to another pipeline reaches the endpoints of both pipelines; the deal's
later events go by its new pipeline only. An archived pipeline stays on a list and sends nothing
until it is restored. To take more, tick the pipelines under "Pipelines" on the endpoint's page or
choose "Every deal’s events", or `PATCH /webhook-endpoints/{id}` with `pipelineIds` (null for every
pipeline). Removing every deal event clears the list. Task events are never narrowed by pipelines.

**A receiver misses a deal's moves or hears too many (ADR-264).** An endpoint can take the deal
events of chosen stages only. The endpoints list shows them ("Stages whose deals’ events are sent:
…"), and the API answers `stageIds` (null takes every stage's). A deal's events go by the stage each
event gives (`deal.stageId`), and a move also by the stage it left, so an endpoint that names
Proposal hears deals arriving in Proposal and leaving it: compare `deal.stageId` to act on arrivals
only. With pipelines chosen too, an event must pass both lists. Events no endpoint takes are not
recorded, so there is nothing to replay. A removed stage, or one of an archived pipeline, stays on a
list and sends nothing. To take more, tick the stages under "Stages" on the endpoint's page or
choose "Every stage’s deals", or `PATCH /webhook-endpoints/{id}` with `stageIds` (null for every
stage). Removing every deal event clears the list.

**A receiver misses the deals of a member it follows (ADR-265).** An endpoint can take the events of
the deals chosen members own only. The endpoints list shows them ("Members whose deals’ events are
sent: …"), and the API answers `ownerIds` (null takes every deal's). A deal's events go by its owner
when each happens: a deal without an owner, or owned by someone else at the time, is not queued for
the endpoint, and events no endpoint takes are not recorded, so there is nothing to replay. Changing
a deal's owner sends `deal.owner_changed` to the endpoints of the owner it left as well as of the
new one, if they take it (ADR-269); the deal's later events go by its new owner. The payload's
`deal.ownerId` is the owner when it is delivered (for `deal.owner_changed`, the owner the change
gave), so a deal given away meanwhile can name someone else. With pipelines or stages chosen too, an
event must pass every list. A member who left stays on a list, "(no longer uses the CRM)", matching
the deals they still own; give those deals another owner. To take more, tick members under "Deal
owners" on the endpoint's page or choose "Every deal’s events", or `PATCH /webhook-endpoints/{id}`
with `ownerIds` (null for every deal). Removing every deal event clears the list.

**A receiver misses a deal's change of owner, or doubts one (ADR-269).** Endpoints that take
`deal.owner_changed` ("Deal owner") are sent one event each time a member gives a deal to another
member or leaves it without an owner on the deal page, or a key changes its `ownerId`. Automations
set an owner only on the deals they add (`deal.created`), and erasure and merges keep the owner, so
they send nothing; changes made while no endpoint took the type were not recorded and are not sent
later. `deal.ownerId` and `deal.previousOwnerId` are the change (null for no owner): compare them,
not the owner the deal has now (GET /deals/{id}). An endpoint with owners chosen hears it for the
owner the deal left as well as for the one it was given to, and with pipelines or stages chosen too,
the deal's pipeline and stage must pass them. One API request that gives the deal to another owner
and closes it sends the owner change first, with status `open`, then the close; one that reopens or
moves it sends those first. Who made the change is not sent: the deal's timeline records it.

**A receiver misses the tasks of a member it follows (ADR-266).** An endpoint can take the events of
the tasks assigned to chosen members only. The endpoints list shows them ("Members whose tasks’
events are sent: …"), and the API answers `taskAssigneeIds` (null takes every task's). A task's
events go by its assignee when each happens: a task assigned to someone else at the time is not
queued for the endpoint, and events no endpoint takes are not recorded, so there is nothing to
replay. Reassigning a task sends `task.assignee_changed` to the endpoints of the member it left as
well as of the new one, if they take it (ADR-274); the task's later events go by its new assignee.
The payload's `task.assigneeId` is the assignee when it is delivered (for `task.assignee_changed`,
the assignee the change gave), so a task given away meanwhile can name someone else. A member who
left stays on a list, "(no longer uses the CRM)", matching the tasks still assigned to them; assign
those tasks to someone else. To take more, tick members under "Task assignees" on the endpoint's
page or choose "Every task’s events", or `PATCH /webhook-endpoints/{id}` with `taskAssigneeIds`
(null for every task). Removing every task event clears the list.

**A receiver misses a task's change of assignee, or doubts one (ADR-274).** Endpoints that take
`task.assignee_changed` ("Task assignee") are sent one event each time a member gives a task to
another member by editing it, or a key changes its `assigneeId`. Automations set an assignee only on
the tasks they add (`task.created`), and erasure and merges keep it, so they send nothing; changes
made while no endpoint took the type were not recorded and are not sent later. `task.assigneeId` and
`task.previousAssigneeId` are the change: compare them, not the assignee the task has now (GET
/tasks/{id}). An endpoint with assignees chosen hears it for the member the task left as well as for
the one it was given to. One API request that gives the task to another member and completes it
sends the change first, with status `open`, then the completion; one that reopens it sends the
reopening first. Who made the change is not sent.

**A receiver misses a change of a deal's details, or doubts one (ADR-275).** Endpoints that take
`deal.updated` ("Deal details") are sent one event each time a member editing a deal or a key
changes its title, value or expected close date, and when erasing its contact retitles it "Deal
(contact erased)". An edit that changes nothing sends nothing, automations set details only on the
deals they add (`deal.created`), merges keep them, and changes made while no endpoint took the type
were not recorded and are not sent later. `changes` names what changed (`title`, `valueMinor`,
`expectedCloseOn`); the deal is the deal when the event is delivered, so read it there, not the
values before, which are never sent (members see a value's change on the deal's timeline). Endpoints
naming pipelines, stages or owners hear it by the deal's as the change left them. One API request
that changes details and closes the deal sends the change first, with status `open`, then the close;
one that also gives the deal to another owner sends the change of details before the change of
owner.

**A receiver misses a change of a task's details, or doubts one (ADR-276).** Endpoints that take
`task.updated` ("Task details") are sent one event each time a member editing a task or a key
changes its title, notes, due time or reminder time. An edit that changes nothing sends nothing,
automations set details only on the tasks they add (`task.created`), merges and reminders being sent
or skipped keep them, erasure deletes the task, and changes made while no endpoint took the type
were not recorded and are not sent later. `changes` names what changed (`title`, `notes`, `dueAt`,
`remindAt`); the task is the task when the event is delivered, so read its title and due time there,
and its notes and reminder with GET /tasks/{id} (`tasks.read`): the payload never carries them, nor
the values before. An endpoint naming assignees hears it by the member the task has as the change
left it. One API request that changes details and completes the task sends the change first, with
status `open`, then the completion; one that also gives the task to another member sends the change
of details before the change of assignee, and one that reopens it sends the reopening first.

**A receiver misses a note, or a note's event fails as gone (ADR-280).** Endpoints that take
`note.created` ("Note added") are sent one event per note a member adds on a contact or deal page or
a key adds through `POST /notes`; notes are never changed, merges and erasure add none, and notes
added while no endpoint took the type were not recorded and are not sent later (read them with
`GET /notes` and `createdSince`). The payload never carries the note's text: read it with
`GET /notes/{id}` and a key holding `notes.read`. `note.writtenBy` says `member` or `api`, with
`note.apiKeyId` for a key's note, so an integration that adds notes skips its own. A delivery that
failed with `event_gone` belonged to a note erasure deleted with its contact; a note moved by a
merge is sent with the contact kept.

**An integration acts on its own deal or task changes, or ignores someone else's (ADR-277).** Every
deal and task event's `deal.changedBy` or `task.changedBy` says who made the change it reports:
`member` (never which), `automation`, or `api` with `apiKeyId`, the key's id; for an addition, who
added it. An integration ignores the events whose `apiKeyId` is the id of the key it changes deals
and tasks with (`GET /webhook-endpoints` answers an endpoint it added with its key's id).
`changedBy` is null when HyFib did not record the maker: erasure retitling a deal, changes made by
servers from before the release that added it (during its rollout, deliveries an older worker built
have no `changedBy` at all), and events captured before it; treat those as someone else's. A change
is never named after the maker of an earlier one: the database clears a changer another transaction
recorded. To see who made a deal's or task's latest change, read `changedBy` and `changedByApiKeyId`
from `GET /deals/{id}` or `GET /tasks/{id}` (ADR-278), or `changed_by` and `changed_by_api_key_id`
on `app.crm_deals` and `app.crm_tasks`; only the latest change is kept there, and a member's save of
a task that changes nothing keeps it. Both are null while a deal or task is as it was added;
`deal.created` and `task.created` say who added it, as `createdBy` and `createdByApiKeyId` on the
deal or task do (ADR-282), never null: `member` (never which), `automation` (never which), or `api`
with the key's id.

**A receiver misses the conversations of a tagged customer (ADR-267).** An endpoint can take the
message and conversation events of the conversations whose contact has chosen tags only. The
endpoints list shows them ("Contact tags whose conversations’ events are sent: …"), and the API
answers `contactTags` (null takes every conversation's). An event goes by the tags the contact has
when it happens: a message that arrived before the tag was put on (by a member, an import or an
automation reacting to that very message) was not queued for the endpoint, and events no endpoint
takes are not recorded, so there is nothing to replay; the contact's next event counts. Tags are
compared as contacts carry them (lower case, trimmed), and a tag no contact has matches nothing.
With numbers, teams or members chosen too, an event must pass every list. To take more, change the
tags under "Contact tags" on the endpoint's page or choose "Every conversation’s events", or `PATCH
/webhook-endpoints/{id}` with `contactTags` (null for every conversation). Removing every event of a
conversation clears the list.

**A receiver misses the events of a tagged conversation (ADR-273).** An endpoint can take the
message and conversation events of the conversations that have chosen tags only. The endpoints list
shows them ("Conversation tags whose events are sent: …"), and the API answers `conversationTags`
(null takes every conversation's). An event goes by the tags the conversation has when it happens: a
message that arrived before the tag was put on (by a member, a key or an automation reacting to that
very message) was not queued for the endpoint, and events no endpoint takes are not recorded, so
there is nothing to replay; the conversation's next event counts. Tags are compared as conversations
carry them (lower case, single spaces), and a tag no conversation has matches nothing; the contact's
tags are another list (ADR-267). With numbers, teams, members or contact tags chosen too, an event
must pass every list. To take more, change the tags under "Conversation tags" on the endpoint's page
or choose "Every conversation’s events", or `PATCH /webhook-endpoints/{id}` with `conversationTags`
(null for every conversation). Removing every event of a conversation clears the list.
`GET /conversation-tags` lists the tags in use.

**A receiver misses a run's events (ADR-183).** An endpoint can take the run events of the runs
started by chosen triggers only. The endpoints list shows them ("Automation runs started by: …"),
and the API answers `runTriggers` (null takes every run). A run's events go by what started it, as
`run.trigger` names it: those of a run started otherwise are never queued for the endpoint, and when
no endpoint of the company takes an event, it is not recorded at all, so there is nothing to replay.
To take more, tick the triggers under "Runs started by" on the endpoint's page, or
`PATCH /webhook-endpoints/{id}` with `runTriggers` (null for every run). Removing both Automation
started and Automation ended clears the list.

**A receiver misses the events of a member's conversations (ADR-181).** An endpoint can take the
message and conversation events of the conversations assigned to chosen members only. The endpoints
list shows them ("Members whose conversations’ events are sent: …"), and the API answers
`assigneeIds` (null takes every conversation's). A conversation's events go by the member it is
assigned to when they happen: an unassigned conversation, or one assigned to someone else, is never
queued for the endpoint (a change of assignee reaches the member it left as well as the one it went
to), and when no endpoint of the company takes an event, it is not recorded at all, so there is
nothing to replay. An endpoint that names teams too receives only those members' conversations in
those teams. A member who left, was suspended or lost the role that answers conversations shows as
"(no longer takes conversations)" and matches nothing until they hold conversations again. To take
more, tick the members under "Members" on the endpoint's page or choose "Every conversation’s
events", or `PATCH /webhook-endpoints/{id}` with `assigneeIds` (null for every conversation).
Removing every message and conversation event clears the list.

**A campaign event's results differ from the campaign page (ADR-150).** `campaign.results` are
counted when the request is built (the `t` of its `W360-Signature`), as `GET /campaigns/{id}` counts
them, and a retry or a replay counts again: an event delivered while the campaign's messages were on
their way shows them in progress, and a replay of it later shows how they went. Members' campaign
page counts the same numbers when it is read. The status, the status before it and the reasons are
as captured. An event delivered while the campaign is a draft (submitted and then rejected, say) has
`results: null`, whatever status it reports. Costs are never sent.

**An endpoint was turned off automatically.** It failed every attempt for 72 hours; its waiting
deliveries were marked failed (`endpoint_disabled`), owners and administrators got the
"Webhook endpoint turned off" email, and the audit log has `webhook.endpoint_auto_disabled`. Fix the
receiver, turn the endpoint on (its health starts afresh), send a test event, then replay the
failed deliveries still needed (within 30 days): on its deliveries page, "Replay failed
deliveries" from the last hour, day, week or 30 days sends every event whose deliveries all failed
again, 500 at a time (ADR-095; press again while it says more remain), and single deliveries can
be replayed from the same page. For an endpoint a key added, the integration can do the same
through the API: `POST /webhook-endpoints/{id}/replay-failed` with `since` (repeat while `more` is
true), or `POST /webhook-deliveries/{id}/replay` for one (ADR-083).

**A replay of failed deliveries queued fewer events than expected (ADR-095).** It leaves out
events already delivered or waiting to be (a replay queued earlier included), deliveries that
failed with `event_gone` (the message, contact, run, order or campaign no longer exists, so a
replay would fail again at once), test events, and deliveries queued before the period chosen or
deleted after 30 days. A 412 means the endpoint is off. Each call is audited as
`webhook.deliveries_replayed` with the host, the time from, the count and whether more remained.
The replays go out ten at a time with the company's other deliveries, so a large one delays new
events by a few minutes at most.

**The receiver rejects signatures.** It must compute HMAC-SHA256 over the exact raw body bytes
prefixed with the `t` value and a dot, compare in constant time against any `v1` value, and allow a
few minutes of clock difference (the documented tolerance is 5 minutes). After a rotation both the
new and the previous secret sign for 24 hours. A lost secret cannot be shown again: rotate it. A
leaked secret: delete the endpoint and add it again (rotation keeps the old secret signing for 24
hours).

**Duplicates at the receiver.** Delivery is at least once: a retry after a timeout, an interrupted
attempt or a replay repeats the event with the same `W360-Event-Id` (and `id` in the body); the
receiver keeps the ids it has processed. Deliveries are not ordered.

**Migration 0025 failed.** It runs in one transaction. It creates the three tables with their
row-level security and grants, the capture triggers on `app.messages`, `app.consent_events` and
`app.template_status_events`, the notification trigger and the two SECURITY DEFINER sweep functions
(granted to `w360_app` before their ownership moves to `w360_definer`). A failure usually means the
bootstrap roles are missing (`infra/db/bootstrap-roles.sql`).

**Conversation and contact events (ADR-074).** An endpoint that takes `contact.created` and
`contact.updated` receives one event per contact for each change saved: an import sends one per
contact it adds or changes, delivered like any other event. A receiver that asks why an erased
contact's `contact.created` arrived with no name or number: payloads are built when delivered, and
the contact was erased in between; `contact.erased` follows if the endpoint takes it. Since
ADR-094 every change of a conversation's member sends `conversation.assignment_changed`, moves
between members included (see the entry on member and team events below). To see what a
transaction captured, `app.webhook_events.captured_xact` holds its id for contact events.

**Migration 0047, 0048 or 0049 failed.** 0047 runs in one transaction, so a failure applies
nothing: it widens the event type checks (the one on `app.webhook_events` `NOT VALID`), adds
`captured_xact`, the capture functions and the triggers on `app.conversations`, `app.contacts` and
`app.contact_tags`. A failure usually means a check was renamed by hand
(`webhook_endpoints_event_types_check`, `webhook_events_type_check`). 0048 runs outside a
transaction (one `CREATE INDEX CONCURRENTLY`): a failure can leave an INVALID index; run
`DROP INDEX CONCURRENTLY IF EXISTS app.webhook_events_contact_xact_idx;` and run the migrations
again. 0049 validates the type check without blocking writes; it fails only if a stored event has a
type outside the list, which no code writes: look for the row by `type` before running it again.

**Automation run events (ADR-078).** An endpoint that takes `automation.run_started` or
`automation.run_ended` hears of live runs only: a member's test run sends nothing, so a receiver
that sees no event for a test is working as designed. The end of a short run can arrive before its
start (deliveries are not ordered); receivers compare `run.startedAt` and `run.endedAt`. A receiver
that asks for a run's answers or API inputs: payloads never carry them; the run page shows answers
to members who can see the conversation. The event keeps the run and automation ids and the end
reason in `app.webhook_events.detail`.

**Migration 0055 or 0056 failed.** 0055 runs in one transaction, so a failure applies nothing: it
widens the event type checks (the one on `app.webhook_events` `NOT VALID`) and adds the capture
function and the two triggers on `app.automation_runs`. A failure usually means a check was renamed
by hand (`webhook_endpoints_event_types_check`, `webhook_events_type_check`) or a trigger of the
same name exists. 0056 validates the type check without blocking writes; it fails only if a stored
event has a type outside the list, which no code writes: look for the row by `type` before running
it again.

**Order events (ADR-085).** An endpoint that takes `order.received` or `order.status_changed` hears
of WhatsApp orders only: store orders (Shopify, WooCommerce) send nothing, since the store reports
them itself. Every status change is sent whoever makes it: a member (confirm, fulfil, cancel, ask
for payment), an API key (confirm, fulfil, cancel, ask for payment; ADR-168, ADR-283) or the worker
applying a Payment Link's outcome (paid, or back to confirmed when the link ends unpaid). A receiver
that sees `paidAt` on an early event is reading the order as it was when that event was delivered;
`order.status` and `order.previousStatus` are the change itself, and the latest change has the
latest `createdAt`. A receiver that asks for the Payment Link address or Razorpay's payment id:
payloads never carry them; the order page shows the link. A missing note on an order whose contact
was erased is expected: erasure clears it (and sends no order event). The event keeps the order id,
the status before a change and who made it (ADR-270) in `app.webhook_events.detail`.

**A receiver misses a Payment Link's change, or doubts one (ADR-285).** Endpoints that take
`payment_link.status_changed` ("Payment Link status") are sent one event per status the commerce
worker writes: `created` when the link is ready at Razorpay (sent in the chat, or `notSentReason`
says why not), `partially_paid`, `paid`, `expired`, `cancelled`, and `failed` when Razorpay could
not create it. Asking for payment and asking to cancel send none of their own (the order's
`awaiting_payment` is an `order.status_changed`), and an endpoint that names numbers hears only the
links of its numbers' orders. `paymentLink.status` and `previousStatus` are the change as captured;
the rest is the link when the event is delivered, so an early event may already show a later
payment. The payload never carries the link's address: members copy it from the order page. Changes
made while no endpoint took the type were not recorded and are not sent later: read them with
`GET /orders/{id}/payment-links`.

**A receiver cannot tell who changed an order, or ignores a member's change (ADR-270).**
`order.changedBy` says who made the change an `order.status_changed` event reports: `member` (the
order page; never which member: the audit log names them, `commerce.order_status_changed`, or
`commerce.payment_requested` for a payment request), `api` with `order.apiKeyId` (the key; an
endpoint it adds through the API answers its id as `apiKeyId`, and so do the messages it sends when
read back with `GET /conversations/{id}/messages`) or `payment_link` (HyFib applying what Razorpay
reported for the order's Payment Link: paid, or back to confirmed when the link expired, was
cancelled or failed). An integration that changes orders through the API should ignore the events
whose `apiKeyId` is its own, not every `api` event. Null means HyFib did not record who: an event
captured before migration 0187, or a change made by a server from before it during a rollout; it is
never the maker of an earlier change, since the database clears a changer an earlier transaction
recorded (`commerce_orders_status_changer`). `order.received` names nobody. To see who made an
order's latest change, read `statusChangedBy` and `statusChangedByApiKeyId` from `GET /orders/{id}`
(ADR-271), or `status_changed_by` and `status_changed_by_api_key_id` on `app.commerce_orders`; only
the latest change is kept there; the audit log records members' and keys' changes
(`commerce.order_status_changed`, `commerce.payment_requested`), not the Payment Link's.

**Migration 0063 or 0064 failed.** 0063 runs in one transaction, so a failure applies nothing: it
widens the event type checks (the one on `app.webhook_events` `NOT VALID`) and adds the capture
function and the two triggers on `app.commerce_orders`. A failure usually means a check was renamed
by hand (`webhook_endpoints_event_types_check`, `webhook_events_type_check`) or a trigger of the
same name exists. 0064 validates the type check without blocking writes; it fails only if a stored
event has a type outside the list, which no code writes: look for the row by `type` before running
it again.

**Campaign events (ADR-087).** An endpoint that takes `campaign.status_changed` hears of every
status change a campaign makes, whoever makes it: a member (submit, withdraw, reject, approve,
pause, resume, cancel) or the runner (start, pause with its reason, complete). A campaign the runner
starts and pauses in one tick (its member lost the permission, the template or number stopped
working) sends both changes, `running` then `paused`, in capture order. Editing a draft and sending
tests send nothing. `campaign.status` and `campaign.previousStatus` are the change itself, with
`pauseReason` or `completionReason`; the name, times and counters are as they are when the event
is delivered, so a late delivery can show counts from after the change. Delivery and read numbers
are not in the payload: they come with `message.status` for each message or from the campaign's
report. The event keeps the campaign id, the status before it and the reason in
`app.webhook_events.detail`.

**Migration 0065 or 0066 failed.** 0065 runs in one transaction, so a failure applies nothing: it
widens the event type checks (the one on `app.webhook_events` `NOT VALID`) and adds the capture
function and the trigger on `app.campaigns`. A failure usually means a check was renamed by hand
(`webhook_endpoints_event_types_check`, `webhook_events_type_check`) or a trigger of the same name
exists. 0066 validates the type check without blocking writes; it fails only if a stored event has
a type outside the list, which no code writes: look for the row by `type` before running it again.

**Member and team events (ADR-094).** `conversation.assignment_changed` is sent for every change of
a conversation's member (one assigned, a move to another, none any more) with `assigneeId` and
`previousAssigneeId`, and `conversation.team_changed` for every change of its team with `teamId` and
`previousTeamId`, whoever makes it: routing, a member, an automation's hand-off, an API key.
Deleting a team sends one `conversation.team_changed` for each conversation it had, delivered like
any other event: expect a burst after a busy team is deleted. Ids are memberships and teams as
`GET /members` and `GET /teams` list them; a member removed since is not listed there any more.
An assignment event with both member ids null was captured before migration 0070; one without the
fields at all was delivered by a worker of the previous release while the release rolled out. Two
changes made by one request (a member taken off, then routing giving the conversation out) can
share a `createdAt` to the millisecond: the receiver reads the conversation for where it stands.
The events keep the ids before and after in `app.webhook_events.detail`, stamped with the time each
change was captured (`occurred_at`).

**Migration 0070 or 0071 failed.** 0070 runs in one transaction, so a failure applies nothing: it
widens the event type checks (the one on `app.webhook_events` `NOT VALID`) and replaces the
conversation capture function and its trigger (`conversations_webhook`). A failure usually means a
check was renamed by hand (`webhook_endpoints_event_types_check`, `webhook_events_type_check`).
0071 validates the type check without blocking writes; it fails only if a stored event has a type
outside the list, which no code writes: look for the row by `type` before running it again.

**Custom field events (ADR-112).** Since migration 0090 `contact.updated` is also sent when a value
of one of the company's custom fields changes, whoever changes it: an automation or a Flow that
saves an answer sends one per contact, as an import does, and a name and a field changed together
send one. Deleting or renaming a field sends nothing, so a receiver keeps a deleted field's values
until it reads the contact again (`GET /api/v1/contact-fields` lists the fields there are). A
receiver that asks which field changed: since ADR-121 the event's `changes` names it (below).

**Migration 0090 failed.** It runs in one transaction, so a failure applies nothing: it creates
`app.webhook_capture_contact_fields()` and the trigger `contacts_webhook_fields` on `app.contacts`.
A failure usually means the bootstrap roles (fix them and run the migrations again) or a function or
trigger of that name created by hand. Until it is applied, custom field changes send no event.

**What a `contact.updated` changed (ADR-121).** Since migration 0096 the event's `changes` lists
what its transaction changed: `name`, `phone`, `email`, `tags` and `fields.<key>`, sorted. Names
only, never values: the contact in the same body is as it is when delivered, so a value can already
differ from the one the change saved. `changes` is null for events captured before the migration,
which replays of older deliveries still send; a receiver treats null as "anything may have
changed". A name changed and changed back in one transaction is still named. To see what an event
holds: `SELECT type, contact_changes, captured_xact FROM app.webhook_events WHERE tenant_id = $1 AND
id = $2`. An event's list cannot be changed after its transaction commits, by design.

**Which tags a `contact.updated` added or removed (ADR-182).** Since migration 0129 the event's
`tagsAdded` and `tagsRemoved` list them, sorted, net within the change: a tag added and removed
again in one change is in neither, so both can be empty while `changes` names `tags`. Both are null
for events captured before the migration and for an erased contact, whose stored events lose them
when it is erased. To see what an event holds:
`SELECT type, contact_changes, tags_added, tags_removed FROM app.webhook_events WHERE tenant_id = $1
AND id = $2`.

**Migration 0096 or 0097 failed.** 0096 runs in one transaction, so a failure applies nothing: it
adds `contact_changes` with its check (`NOT VALID`), the definer function
`app.add_contact_webhook_changes`, the four-argument `app.capture_contact_webhook_event` (dropping
the three-argument one) and the three trigger functions. A failure usually means the bootstrap
roles (`w360_definer` must exist to own the function) or a function of that name created by hand.
0097 validates the check without blocking captures; it fails only if a stored event has a list,
which nothing wrote before 0096: look for rows with `contact_changes IS NOT NULL` before running it
again.

## 10P. Platform operations console

`/platform/ops` is for platform owners and operators (MFA). It shows counts, states, error codes,
labels and times, never message text, contacts, payloads, email addresses, secrets or full URLs. A
question it cannot answer from those needs a support grant (section 11) or the logs.

**A company is "critical" or "warning".** The company's platform page lists why (Health). Numbers
down or an account needing reconnection: the company reconnects through Embedded Signup (section 6);
quality `RED`/`YELLOW`: point them at their templates and opt-outs before Meta limits the number;
send failures: the error codes are on their Reports page; failing webhook endpoints, stores, payment
account checks, catalog or Flow syncs: the Integrations page names the error HyFib stored; dead
letters: section 3; plan past due: section 10M. Quality is as of the number's last health check.

**Signals (7 days).** A flag asks for a review of that company's sending, not an action: look at its
campaigns, templates and opt-out keywords (support grant if content is needed). Suspension stays a
reasoned, audited action on the company page. The thresholds are HyFib's own heuristics
(ADR-054), not Meta's rules. Security events are counted by kind; `auth.sign_in` (info) counts
completed sign-ins (ADR-136).

**Onboarding.** Failed signups show the reason Meta returned; abandoned ones expired before the
popup finished (the person can start again). A number setup stuck for over 30 minutes: check the
`channel.onboard` queue and dead letters; companies without an active number after signup may need
help with Embedded Signup.

**Queues.** Counts are pg-boss's, refreshed by the worker about once a minute; failed counts include
jobs retained after their last attempt. `billing.auto-recharge` has no retries on purpose
(section 9). A row "Not declared by this release" is a queue named by a dead letter that this
release does not declare (an older or newer deploy); "No such queue in the database" means pg-boss
has no queue by that name (for a declared queue: the migrations have not run). The oldest wait
(ADR-096) is the longest a ready job had waited when the worker's minute sweep last checked, with
the queue's limit under its name; "Not checked" means the sweep has not checked that queue yet (a
queue new in this release, until the next minute).

**Late queues (ADR-096).** Every platform administrator is emailed "Queue … is falling behind" (or
"N queues are falling behind") once each time a queue's oldest ready job has waited its limit, at
most every 15 minutes, with each queue's waiting jobs, oldest wait and limit; the Queues tab marks
the queue late and says when staff were emailed. It stays late until its oldest job has waited under
half its limit, then its alert is re-armed. The worker logs `job queues are late` at each check
while any is, and `late queue alert emailed to platform staff`; `job queues are late but there is
no platform administrator to email` means nothing is marked until there is one. Section 3 says what
to do. "The worker is not checking the queues" on the tab (or a dash on the overview's Late queues)
means no check for 5 minutes: the minute messaging sweep is not running or fails before the check
(look for failures of `ops.messaging-sweep` in the worker's logs), so late queues are not emailed.

**Dead letters.** Recorded by the worker within seconds of the move; if the list stays empty while
`SELECT count(*) FROM pgboss.job WHERE name = 'dead-letter' AND state = 'created'` grows, the worker
is not consuming (`dead letters recorded` and `job attempt failed` in its log). Rows are deleted 30
days after the job failed.

**Retrying a dead letter (ADR-108).** Once the cause is fixed, Retry (with a reason of at least 10
characters) sends the failed job back to its queue once, for one more attempt, exactly as pg-boss's
own retry does, and writes `platform.dead_letter_retried` to the platform audit log. The row then
shows who retried it and when; if the job fails again it is listed again, as a new dead letter.
Which ones need it:

- `channel.onboard`, `commerce.account` and `template.delete`: none. Within a minute the sweep ends
  their work for the company (ADR-111): the number's setup fails with the step it stopped at (the
  company's "Retry setup" starts it again; Meta counts registration attempts, so it is never
  repeated automatically), the keys' check fails with a message that Razorpay could not be reached
  (saving the keys again checks them), and a deletion goes back to Meta's last status with
  "Deletion failed" in the template's history (Delete starts it again). The row then says "Work
  ended for its company", or "Nothing left to end" when the work had finished or been started
  again, and offers no Retry. These jobs retry for 2 to 3 hours (setup), 1.5 to 2 hours (keys) and
  4 to 5 hours (deletions) before they dead-letter, and the template sync keeps a deletion for 8
  hours while its job tries.
- `template.submit`: after 10 minutes the template sync marks the template "submit failed" and the
  company submits it again; a retry after that does nothing.
- Every other queue's work is signalled again by the minute sweeps once the cause is fixed: a
  retry repeats it, or is refused because the sweep's job for the same work is already waiting.

The row says why it offers no Retry: already retried; the signature did not verify (the worker would
refuse the job again); the queue is not declared by this release; the queue never retries its jobs
(`billing.auto-recharge`: its sweep repeats an attempt only after looking it up at Razorpay);
pg-boss no longer keeps the failed job (its queue's retention has passed; the time is shown under
Retry); a receipt queue (`webhook.process`, `billing.event-process`: retry the receipt on the
Integrations page instead); the company is being deleted or is gone; or its work was ended for the
company (ADR-111).

**Acknowledging a dead letter (ADR-169).** The administrator who looks at a dead letter opens
Acknowledge on its row and writes a note of 10 to 500 characters: what was found or done ("Meta's
outage is over; retried it", "The company submitted the template again"). The row then shows who,
when and the note, so the others need not look again; a later note replaces it, and the platform
audit log keeps each (`platform.dead_letter_acknowledged`). An acknowledgement lasts as long as the
dead letter (30 days after its job failed); a later failure of the same work is a new,
unacknowledged dead letter. Acknowledging neither retries the job nor changes whether it can be
retried, and does not stop the alert email, which tells each dead letter once anyway. "Dead letter
not found." means it was purged since the page loaded.

**Acknowledging a late queue (ADR-177).** The administrator who looks at a late queue opens
Acknowledge under its lateness on Job queues and writes a note of 10 to 500 characters: what was
found or done ("Worker restarted at 10:05; draining", "Shopify rate limits; it catches up by
itself"). The row then shows who, when and the note, so the others need not look again; a later note
replaces it, and the platform audit log keeps each (`platform.late_queue_acknowledged`). The note
lasts while the queue stays late: the worker's check that finds it back under half its limit clears
it, and the next time it falls behind it starts unacknowledged and is emailed again. Acknowledging
changes neither the lateness nor the alert. "This queue is no longer late since then." means the
queue recovered, or fell behind again, since the page loaded: reload it.

**A list's CSV has more rows than its tab (ADR-200).** The console's exports give up to 5,000 rows
of number setups, new companies, receipts needing attention, quarantine entries and dead letters, up
to 1,000 current failures and up to 500 signups, newest first, while the tabs show fewer. The file's
first rows are the tab's; the platform audit entry of the export counts the rows it gave. A list
longer than its CSV's limit needs a query on the database.

**Acknowledging a quarantine entry (ADR-199).** The administrator who takes up an open quarantine
entry opens Acknowledge on its row and writes a note of 10 to 500 characters: what was found or is
awaited ("Asked the company to reconnect through Embedded Signup", "A Meta test account; waiting for
Meta to confirm"). The row then shows who, when and the note; a later note replaces it, and the
platform audit log keeps each (`platform.webhook_quarantine_acknowledged`). Acknowledging neither
retries the receipt nor resolves the entry, and it does not stop the alert email; resolve the entry
once it is decided. "This quarantine entry is already resolved." means another administrator
resolved it since the page loaded; "Quarantine entry not found." that it was deleted with its
receipt.

**Acknowledging a webhook receipt (ADR-179).** The administrator who looks at a receipt that needs
attention opens Acknowledge on its row and writes a note of 10 to 500 characters: what was found or
done ("Malformed body from a Meta test account; not retrying", "Parser fixed in 1.4.3; retried").
The row then shows who, when and the note, so the others need not look again; a later note replaces
it, and the platform audit log keeps each (`platform.webhook_receipt_acknowledged`). The note stays
with the receipt, retried or not, and is deleted with it after 90 days. Acknowledging neither
retries the receipt nor stops the alert email. "Receipt not found." means it was deleted since the
page loaded.

**`PATCH /api/v1/contacts/{id}` with `phone` answers 409, 412 or 422 (ADR-180).** 412 "This number
comes from WhatsApp and cannot be changed." means the contact has written to one of the company's
numbers: its number is its identity and stays (members cannot change it either); 412 about the
suppression list means the new number is suppressed (remove it from the list in the app first, if
that is right). 409 means another contact of the company has the number: find it with
`GET /contacts?phone=` (with `contacts.read`) and merge or fix them in the app. 422 naming `phone`
means it is not a number with its country code and a leading +. `POST /api/v1/contacts/update-many`
gives the same answers naming `contacts.<n>.phone` (ADR-188).

**A dead letter of those three queues stays unsettled.** The sweep leaves one alone while its
company is being deleted, while a job for the same work waits or runs (the company started it again,
or a retry), and when its envelope did not verify. Otherwise look for `ending stranded work failed;
will retry` in the worker's log: the error names the cause, and the next minute's sweep tries again.
A setup, keys check or deletion that a company reports stuck with no dead letter is still being
retried by its job.

**Repairs.** Retry and Resolve (section 4) both need a reason of at least 10 characters and appear
in the platform audit log as `platform.webhook_receipt_retried` and
`platform.webhook_quarantine_resolved`. A receipt whose body was erased (after 7 days) cannot be
retried. A receipt listed as "Failed all attempts" with "Its worker stopped during the last
attempt" was being processed when its worker stopped (a deploy or a crash) on its 12th attempt: the
sweeper no longer signals it, so retry it once the worker runs (since migration 0068; before, it was
listed nowhere and needed SQL).

**Failure alerts (ADR-091).** Every platform administrator is emailed "N failures need a look" when
a job is dead-lettered, a receipt uses all its attempts or an event is quarantined: counts by queue,
provider and reason, never a company or an error. One email covers everything new since the last
one, at most every 15 minutes; the Integrations page says when the last one went out, and each
receipt, quarantine entry and dead letter shows when staff were emailed about it. A retried receipt
that fails all its attempts again is emailed again. The worker logs `failure alert emailed to
platform staff`; `work failed for good but there is no platform administrator to email` means nothing
is marked until there is one. An item listed without "Staff emailed" for more than 15 minutes means
the alert did not run: it runs last in the minute messaging sweep, so look in the worker's logs for
failures of `ops.messaging-sweep`. On the email: open the tab it links, find the cause (the worker's
logs, the provider's status page), fix it, then retry receipts within 7 days of receipt and resolve
quarantine entries (section 4). Most dead letters need no action once the cause is fixed, because
the minute sweeps signal their work again or end it for its company (ADR-111); retry those of
`template.submit` if needed (ADR-108).

**Integration failure alerts (ADR-139).** Every platform administrator is emailed "N company
integrations are failing" when the Integrations page lists failures staff were not emailed about:
counts by kind (such as "WhatsApp number, needs reconnecting 2"), never a company or an error. One
email covers everything new since the last one, at most every 15 minutes, and Current failures says
when the last one went out. Each failure is emailed once while it lasts, and again if it changes
state; one that has not been listed for an hour is forgotten, so it is emailed again if it fails
later. The worker logs `integration failure alert emailed to platform staff`; `company integrations
are failing but there is no platform administrator to email` means nothing is marked until there is
one. On the email: open Current failures, look for a pattern across companies (one kind failing at
many companies points to HyFib or the provider: the worker's logs, the provider's status page) and
for HyFib-side kinds (accounts not checked for 26 hours, webhooks not subscribed: section 6). Most
failures are the company's to fix, and the company is told of them; HyFib staff contact it when it
does not act.

**Acknowledging failures (ADR-141).** On Current failures, the administrator who takes a failure
opens Acknowledge on its row and writes a note of 10 to 500 characters: what was done or found
("Called the owner: they will reconnect the number today", "Meta's status page reports an outage").
The row then shows who acknowledged it, when, and the note, so the others need not call the company
too. A new note replaces it (a colleague taking over, a finding); the platform audit log keeps each
(`platform.integration_failure_acknowledged`). The acknowledgement lasts while the failure is
listed in that state: one that changes state (a failing endpoint turned off) is listed again
unacknowledged, and one that recovers keeps its acknowledgement for an hour, in case it comes back.
"This integration is no longer failing in that state. Reload the page." means that it recovered or
changed state since the page loaded. Acknowledging does not stop the alert email, which tells each
failure once anyway.

**Keys (ADR-134).** The configured encryption key ids, the primary first, and how many stored values
each key seals, by kind (counts only). While another key is configured the worker seals the values
it sealed again with the primary key, up to 500 a minute, and logs `sealed values re-encrypted under
the primary key`; the count of the old key falls to zero, and the page then says it can be removed
(section 13). "Values that cannot be opened" are sealed with a key that is not configured, or not
sealed with the keyring at all: nothing can open them, so the company reconnects what they belong to
(a WhatsApp account, a store, Razorpay keys) or saves the secret again. The worker logs each value
that does not open with its key once (`a sealed value does not open with its key`, with its kind, id
and company, never the value) and leaves it as it is; after 1,000 it stops re-encrypting until it
restarts and logs an error naming `W360_ENCRYPTION_KEYS`: check that the old key's bytes are right.

**Job signing keys (ADR-135)** are on the same tab: the signing key's id, the next or previous key's
during a rotation, and how many jobs that can still run (waiting, running, failed) name each key.
While a previous key is configured the worker signs the jobs it signed, and those signed before key
ids, again with the signing key, up to 500 a minute, and logs `queued jobs signed again with the job
signing key`; once none is left the page says the previous key can be removed (section 13). A
running job is signed again once it waits for its retry. The worker logs a queued job that does not
verify with any key once (`a queued job does not verify with any job signing key`, with its queue
and id, never its data) and leaves it as it is: its consumer refuses it (`job.invalid_signature`)
whatever the configuration, so it stays counted under the key it names; cancel it in pg-boss if it
should not wait for that. After 1,000 such jobs a worker stops signing jobs again until it restarts
and logs an error naming `W360_JOB_SIGNING_KEY_PREVIOUS`: check that the previous key's value is
right. "Jobs that will be refused" name a key that is not configured.

**Migration 0107 failed.** It creates `ops.integration_acknowledgements` and
`ops.platform_acknowledge_integration_failure`, and recreates `ops.platform_ops_integration_failures`
(with each failure's acknowledgement) and `ops.integration_alerts_due` (which keeps and forgets
acknowledgements too), in one transaction; a failure rolls it back (usually the bootstrap roles: fix
them and run the migrations again). Web servers of this release need it before they start, or
acknowledging a failure fails and the list shows no acknowledgement; web servers and workers of the
previous release work with it (they do not read the list's new columns, and the check keeps its name
and result).

**Migration 0106 failed.** It creates `ops.integration_failures` and `ops.integration_alerts`,
recreates `ops.platform_ops_integration_failures` on the shared list, and adds the alert's two
functions and its row in `ops.platform_alerts`, in one transaction; a failure rolls it back
(usually the bootstrap roles: fix them and run the migrations again). Workers of this release need
it before they start, or their minute sweep fails at the alert, after the rest of its work; workers
of the previous release send no integration alert. The first alert after it tells every failure
listed then.

**Migration 0105 failed.** It adds the webhook subscription columns to `app.whatsapp_accounts` and
recreates `ops.whatsapp_access_checks_due` and `ops.platform_ops_integration_failures`, in one
transaction; a failure rolls it back (usually the bootstrap roles: fix them and run the migrations
again). Workers of this release need it before they start, or their access checks fail when they
store what they found; workers of the previous release check no subscription. Each connected
account's subscription is first checked at its next daily access check.

**Migration 0104 failed.** It adds the access check columns to `app.whatsapp_accounts`, creates
`ops.whatsapp_access_checks_due` and recreates `ops.platform_ops_integration_failures`, in one
transaction; a failure rolls it back (usually the bootstrap roles: fix them and run the migrations
again). The migration runner declares the `whatsapp.access_check` queue: workers of this release
need both before they start, or their minute sweep fails at the access checks; workers and web
servers of the previous release check no access.

**Migration 0103 failed.** It only creates `ops.my_sign_ins` and an index of sign-in events, in one
transaction; a failure rolls it back (usually the bootstrap roles: fix them and run the migrations
again). Web servers of this release then fail to show Account & security until it is applied, while
sign-ins still work and are recorded; web servers of the previous release record no sign-in.

**Migration 0102 failed.** It only creates `ops.job_signing_key_counts`, in one transaction; a
failure rolls it back (usually the bootstrap roles: fix them and run the migrations again). The
migration runner then grants the definer the data of pg-boss's jobs. Workers of the previous release
sign no job again and accept no next or previous key; web servers of the previous release show no
job signing keys.

**Migration 0101 failed.** It replaces `app.touch_updated_at` (the shared trigger function, which
then keeps a row's time while `w360.resealing` is on), grants the definer the sealed columns and a
read policy on HTTP secrets, and creates `ops.sealed_value_keys`, `ops.sealed_values_to_reseal`,
`ops.sealed_value_counts` and `app.reseal_store_webhook_secret` with a policy on
`app.commerce_stores`, in one transaction; a failure rolls it all back (usually the bootstrap roles:
fix them and run the migrations again). Workers of the previous release re-encrypt nothing; web
servers of the previous release have no Keys tab.

**Migration 0068 failed.** It adds nullable columns and partial indexes to `ops.dead_letters`,
`ops.webhook_receipts` and `ops.webhook_quarantine`, marks existing dead letters and erased receipts
as told, and replaces `ops.platform_retry_webhook_receipt` (dropped as `w360_definer` and recreated,
as in 0011), in one transaction. A failure rolls it all back: fix the cause (usually the bootstrap
roles) and run the migrations again. Workers of the previous release keep working; web servers of
the previous release show receipts as before.

**Migration 0086 failed.** It adds `retried_at` and `retried_by_user_id` to `ops.dead_letters` (with
the check pairing them) and creates `ops.platform_retry_dead_letter`, in one transaction; a failure
rolls it all back (usually the bootstrap roles: fix them and run the migrations again). The
migration runner grants the definer what it needs of `pgboss.job` after pg-boss's own install, on
every run: if Retry fails with "permission denied for table job", run the migrations again. Web
servers of the previous release show dead letters without Retry.

**Migration 0089 failed.** It adds `settled_at` and `settled_ended` to `ops.dead_letters` (three
checks and a partial index), creates `ops.dead_letter_work_live`, `ops.dead_letters_to_settle` and
`ops.settle_dead_letter`, and replaces `ops.platform_retry_dead_letter` (dropped as `w360_definer`
and recreated, as in 0086), in one transaction; a failure rolls it all back (usually the bootstrap
roles: fix them and run the migrations again). The migration runner grants the definer
`pgboss.job.singleton_key` after pg-boss's install, on every run: if the sweep logs "permission
denied for table job", run the migrations again. Workers of the previous release settle nothing;
web servers of the previous release offer Retry on a settled dead letter, which the function
refuses. The new retry settings of `template.delete` and `commerce.account` apply to jobs queued
after the runner updated the queues.

**Migration 0117 failed.** It adds `acknowledged_at`, `acknowledged_by_user_id` and
`acknowledgement` to `ops.dead_letters` (with the check `dead_letters_acknowledged`) and creates
`ops.platform_acknowledge_dead_letter`, in one transaction; a failure rolls it all back (usually the
bootstrap roles: fix them and run the migrations again). Web servers of this release need it before
they start, or the Queues tab fails to load; web servers and workers of the previous release work
with it.

**Migration 0118 failed.** It adds `channel_account_ids` to `app.webhook_endpoints` with the check
`webhook_endpoints_channel_account_ids`, grants its update to the runtime role, and replaces
`app.capture_webhook_event` and the trigger functions of message, conversation, automation run,
order and campaign events, in one transaction; a failure rolls it all back (usually the bootstrap
roles, or a lock held on the table: fix it and run the migrations again). Web servers of this
release need it before they start, or Settings → Webhooks and the endpoints API fail (their reads of
endpoints name the column); workers of either release and web servers of the previous release work
with it.

**Migration 0119 failed.** It replaces `api_keys_scopes_check` on `app.api_keys` and
`plans_api_scopes_check` on `ops.plans` with checks that also accept `channels.read`, in one
transaction; a failure rolls it all back (usually a lock held on one of the tables: run the
migrations again). Web servers of this release need it before a key or plan version holds the new
scope; those of the previous release work with it.

**Migration 0120 failed.** It adds `message_senders` to `app.webhook_endpoints` with the check
`webhook_endpoints_message_senders`, grants its update to the runtime role, and replaces
`app.capture_webhook_event` and the message trigger function, in one transaction; a failure rolls it
all back (usually the bootstrap roles, or a lock held on the table: fix it and run the migrations
again). Web servers of this release need it before they start, or Settings → Webhooks and the
endpoints API fail (their reads of endpoints name the column); workers of either release and web
servers of the previous release work with it.

**Migration 0121 failed.** It adds the four OAuth columns to `app.webhook_endpoints` with the check
`webhook_endpoints_oauth`, grants their updates to the runtime role, and drops and creates
`ops.sealed_value_keys()` as the definer role, in one transaction; a failure rolls it all back
(usually the bootstrap roles: the migration role must be able to `SET ROLE w360_definer`; or a lock
held on the table: fix it and run the migrations again). Workers and web servers of this release
need it before they start (their reads of endpoints name the columns); those of the previous release
work with it.

**Migration 0122 failed.** It adds `team_ids` to `app.webhook_endpoints` with the check
`webhook_endpoints_team_ids`, grants its update to the runtime role, and replaces
`app.capture_webhook_event`, in one transaction; a failure rolls it all back (usually the bootstrap
roles, or a lock held on the table: fix it and run the migrations again). Web servers of this
release need it before they start, or Settings → Webhooks and the endpoints API fail (their reads of
endpoints name the column); workers of either release and web servers of the previous release work
with it.

**Migration 0123 failed.** It adds `template_ids` to `app.webhook_endpoints` with the check
`webhook_endpoints_template_ids`, grants its update to the runtime role, and replaces
`app.capture_webhook_event`, in one transaction; a failure rolls it all back (usually the bootstrap
roles, or a lock held on the table: fix it and run the migrations again). Web servers of this
release need it before they start, or Settings → Webhooks and the endpoints API fail (their reads of
endpoints name the column); workers of either release and web servers of the previous release work
with it.

**Migration 0124 failed.** It replaces `api_keys_scopes_check` on `app.api_keys` and
`plans_api_scopes_check` on `ops.plans` with checks that also accept `campaigns.resume`, in one
transaction; a failure rolls it all back (usually a lock held on one of the tables: run the
migrations again). Web servers of this release need it before a key or plan version holds the new
scope; those of the previous release work with it.

**Migration 0125 failed.** It adds the acknowledgement columns and their check to `ops.queue_waits`,
replaces the worker role's read of the table with a read of the check's columns, creates
`ops.record_queue_waits` again and adds `ops.platform_acknowledge_late_queue`, in one transaction; a
failure rolls it all back (usually the bootstrap roles, or a lock held on the table by a sweep: run
the migrations again). Web servers of this release need it before they show the Queues tab; workers
of either release and web servers of the previous release work with it.

**Migration 0126 failed.** It drops `ops.template_sync_due` as its owner and creates it again with
the `requested` column and the new order, in one transaction; a failure rolls it all back (usually
the bootstrap roles: fix them and run the migrations again). Workers of this release need it before
they start (their sweep reads the column); workers of the previous release work with it.

**Migration 0127 failed.** It creates `ops.receipt_acknowledgements` and
`ops.platform_acknowledge_webhook_receipt`, in one transaction; a failure rolls it all back (usually
the bootstrap roles: fix them and run the migrations again). Web servers of this release need it
before they show the Integrations tab; workers and web servers of the previous release work with it.

**Migration 0128 failed.** It adds `assignee_ids` to `app.webhook_endpoints` with the check
`webhook_endpoints_assignee_ids`, grants its update to the runtime role, and replaces
`app.capture_webhook_event`, in one transaction; a failure rolls it all back (usually the bootstrap
roles, or a lock held on the table: fix it and run the migrations again). Web servers of this
release need it before they start, or Settings → Webhooks and the endpoints API fail (their reads of
endpoints name the column); workers of either release and web servers of the previous release work
with it.

**Migration 0129 or 0130 failed.** 0129 runs in one transaction, so a failure applies nothing: it
adds `tags_added` and `tags_removed` to `app.webhook_events` with their check (`NOT VALID`), the
definer function `app.note_contact_webhook_tag`, and replaces `app.capture_contact_webhook_event`
and `app.webhook_capture_contact_tag`. A failure usually means the bootstrap roles (`w360_definer`
must exist to own the function) or a function of that name created by hand. 0130 validates the check
without blocking captures; it fails only if a stored event has a list, which nothing wrote before
0129: look for rows with `tags_added IS NOT NULL OR tags_removed IS NOT NULL` before running it
again.

**Migration 0131 failed.** It adds `run_triggers` to `app.webhook_endpoints` with the check
`webhook_endpoints_run_triggers`, grants its update to the runtime role, and replaces
`app.capture_webhook_event` and `app.webhook_capture_automation_run`, in one transaction; a failure
rolls it all back (usually the bootstrap roles, or a lock held on the table: fix it and run the
migrations again). Web servers of this release need it before they start, or Settings → Webhooks and
the endpoints API fail (their reads of endpoints name the column); workers of either release and web
servers of the previous release work with it.

**Migration 0132 failed.** It adds `contact_field_keys` to `app.webhook_endpoints` with the check
`webhook_endpoints_contact_field_keys`, grants its update to the runtime role, and replaces
`app.capture_contact_webhook_event`, in one transaction; a failure rolls it all back (usually the
bootstrap roles, or a lock held on the table: fix it and run the migrations again). Web servers of
this release need it before they start, or Settings → Webhooks and the endpoints API fail (their
reads of endpoints name the column); workers of either release and web servers of the previous
release work with it.

**Migration 0133 failed.** It adds `campaign_ids` to `app.webhook_endpoints` with the check
`webhook_endpoints_campaign_ids`, grants its update to the runtime role, and replaces
`app.capture_webhook_event` and `app.webhook_capture_message`, in one transaction; a failure rolls
it all back (usually the bootstrap roles, or a lock held on the table: fix it and run the migrations
again). Web servers of this release need it before they start, or Settings → Webhooks and the
endpoints API fail (their reads of endpoints name the column); workers of either release and web
servers of the previous release work with it.

**Migration 0134 failed.** It replaces `api_keys_scopes_check` on `app.api_keys` and
`plans_api_scopes_check` on `ops.plans` with checks that also accept `campaigns.write`, in one
transaction; a failure rolls it all back (usually a lock held on one of the tables: run the
migrations again). Web servers of this release need it before a key or plan version holds the new
scope; those of the previous release work with it.

**Migration 0135 failed.** It adds `consent_changes` to `app.webhook_endpoints` with the check
`webhook_endpoints_consent_changes`, grants its update to the runtime role, and replaces
`app.capture_webhook_event`, in one transaction; a failure rolls it all back (usually the bootstrap
roles, or a lock held on the table: fix it and run the migrations again). Web servers of this
release need it before they start, or Settings → Webhooks and the endpoints API fail (their reads of
endpoints name the column); workers of either release and web servers of the previous release work
with it.

**Migration 0136 failed.** It adds `contact_sources` to `app.webhook_endpoints` with the check
`webhook_endpoints_contact_sources`, grants its update to the runtime role, and replaces
`app.capture_contact_webhook_event`, in one transaction; a failure rolls it all back (usually the
bootstrap roles, or a lock held on the table: fix it and run the migrations again). Web servers of
this release need it before they start, or Settings → Webhooks and the endpoints API fail (their
reads of endpoints name the column); workers of either release and web servers of the previous
release work with it.

**Migration 0137 failed.** It adds `message_types` to `app.webhook_endpoints` with the check
`webhook_endpoints_message_types`, grants its update to the runtime role, and replaces
`app.capture_webhook_event`, in one transaction; a failure rolls it all back (usually the bootstrap
roles, or a lock held on the table: fix it and run the migrations again). Web servers of this
release need it before they start, or Settings → Webhooks and the endpoints API fail (their reads of
endpoints name the column); workers of either release and web servers of the previous release work
with it.

**Migration 0138 failed.** It adds `run_end_reasons` to `app.webhook_endpoints` with the check
`webhook_endpoints_run_end_reasons`, grants its update to the runtime role, and replaces
`app.capture_webhook_event`, in one transaction; a failure rolls it all back (usually the bootstrap
roles, or a lock held on the table: fix it and run the migrations again). Web servers of this
release need it before they start, or Settings → Webhooks and the endpoints API fail (their reads of
endpoints name the column); workers of either release and web servers of the previous release work
with it.

**Migration 0139 failed.** It creates `ops.quarantine_acknowledgements` and
`ops.platform_acknowledge_quarantine_entry`, in one transaction; a failure rolls it all back
(usually the bootstrap roles: fix them and run the migrations again). Web servers of this release
need it before they show the Integrations tab; workers and web servers of the previous release work
with it.

**Migration 0072 failed.** It creates `ops.queue_waits`, adds `queues` to the kinds of
`ops.platform_alerts` (replacing its check `platform_alerts_kind_check`) and creates
`ops.record_queue_waits` and `ops.mark_queue_alert`, in one transaction. A failure rolls it all
back: usually the bootstrap roles, or the check renamed by hand. Workers of the previous release do
not check queues; web servers of the previous release show the Queues tab without waits.

**Migrations 0026 and 0027 failed.** 0026 runs in one transaction: it needs the bootstrap roles
(`w360_definer`, `w360_platform`, `w360_app`). 0027 builds an index concurrently outside a
transaction; if it fails, drop the invalid index
(`DROP INDEX CONCURRENTLY IF EXISTS app.consent_events_tenant_occurred_idx`) and run the
migrations again.

## 10Q. Company export and deletion

Owners use Settings → Company data (ADR-055). Platform owners can also schedule a company's
deletion and cancel the ones staff scheduled (ADR-090, below); nobody can speed a deletion up, and
the export is only for the company's owners.

**An export fails or is cut short.** The file is complete only if its last line is
`{"end":true,...}`. A second export while one runs answers 409; each start is audited
(`tenant.exported`) and emailed to owners and administrators, even when it then fails. A failure
after the download started is logged by the web as `company export stopped` (with the company id).
Large companies stream for as long as the read takes; `idle_in_transaction_session_timeout` (60 s)
ends an export whose reader stops reading for a minute.

**A deletion is scheduled.** The company is `pending_deletion` until `due_at` (14 days) and works as
suspended. Any owner cancels in Settings → Company data until the run starts; after that the page
says it can no longer be cancelled. The register is `ops.tenant_deletions` (the company's platform
page shows it). A company that asks HyFib to stop an owner's deletion before it starts: an owner
cancels; staff cannot cancel an owner's deletion, so if no owner can, escalate before it is due.

**Deleting a company for HyFib (ADR-090).** For a company whose owners asked support to delete it
and cannot do it themselves, or whose service HyFib ends. Confirm the request or the decision
outside the product first (who asked, through which channel, the ticket), as for an MFA reset. A
platform owner opens the company's platform page, "Delete the company", writes the reason (10 to
1,000 characters: the owners and administrators read it, in their email and on every page of the
company, so no internal notes) and types the company address. The company is `pending_deletion` at
once and deleted 14 days later by the same job; its owners can still export meanwhile. Operators
see the card but cannot schedule. The owners and administrators are emailed by the worker's minute
sweep (`staff deletion notices emailed` in the worker log; a failure logs `staff deletion notice
failed for a company; will retry` and is tried again the next minute). Both audit logs record it
(`platform.tenant_deletion_scheduled`, with the reason).

**Cancelling a deletion HyFib scheduled.** Only a platform owner, only before the run starts, from
the Deletion card on the company's platform page, with a reason the company reads (emailed the same
way). The company returns to the status it had (a suspension stays, a lapsed plan restricts). Owners
cannot cancel it: their page tells them to contact HyFib support. Staff cannot cancel a deletion an
owner asked for.

**A deletion is running or stuck.** The minute billing sweep queues a `tenant.delete` job for every
due or unfinished deletion (`company deletions due` in the worker log); each run deletes for up to
five minutes (`company deletion continues` with the rows deleted) until `company deleted`. A run that
keeps failing shows in the job log and dead letters (section 3); the register's `attempts` counts
runs. `finish_tenant_deletion` returns false while any deletable row remains, so a run that ends
with rows written meanwhile simply runs again. The providers are visited once per deletion
(`provider_cleanup_at`); their outcomes are in `provider_cleanup` and in the final email. A
`failed` outcome (for example Meta refusing an expired token) is not retried: the email asks the
owners to remove HyFib's access there; WooCommerce stores are always listed because their keys can
only be revoked in the store.

**After a deletion.** The company row is a tombstone (`deleted`, "Deleted company",
`deleted-<id>`); its old address is free. Billing records, plan history, the register, support
grants and security events stay. Meta events for its numbers are quarantined as `unknown_asset`
(section 4). If the business connects the same numbers to another company, they bind normally.

**Migration 0028 failed.** It runs in one transaction and needs the bootstrap roles; fix the cause
and run the migrations again.

**Migration 0067 failed.** It adds columns to `ops.tenant_deletions` (existing rows become owners'
deletions; nothing is rewritten), replaces `app.cancel_tenant_deletion` (dropped as `w360_definer`
and recreated, as in 0011) and adds the staff and notice functions, in one transaction. A failure
rolls it all back: fix the cause (usually the bootstrap roles) and run the migrations again. Web
servers of the previous release keep working: they read none of the new columns and call the owners'
cancel with the same signature.

## 11. Compromised company (tenant) or account

1. Suspend the company in `/platform` with a reason (stops outbound activity; ingestion continues).
2. For a compromised user: reset MFA via platform recovery (verified out of band), which signs out
   all their sessions; require a password reset.
3. Rotate company-level provider credentials (reconnect WhatsApp), API keys and webhook secrets
   (phase 5). A stolen session alone could not export the company, ask for its deletion, change
   payment settings or the company's Razorpay keys, create API keys or webhook endpoints, add an
   owner or turn off required two-factor: those need a sign-in within the last 15 minutes
   (ADR-056). Check the audit log for them anyway (a stolen password is enough to sign in).
4. Review the company audit log and security events; export evidence; notify the owner. The
   person sees their last 20 sign-ins on Account & security (when, device, address, how;
   ADR-136); platform staff with database access find all of them as `auth.sign_in` security
   events with the person's `user_id`.
5. Reactivate with a reason once clean.

**"Sign in again to continue".** Members see it when an action needs a sign-in within the last 15
minutes (ADR-056) and theirs is older. It signs them out and brings them back to the page after
they sign in. It is not an error and cannot be switched off for a company.

## 12. Migration failure

1. The runner applies each file in a transaction; a failure rolls back that file and stops. Files
   starting with `-- migrate:no-transaction` (a single `CREATE INDEX CONCURRENTLY`, such as 0008)
   are not transactional: a failure can leave an INVALID index. Drop it
   (`DROP INDEX CONCURRENTLY app.messages_tenant_created_idx;`) and run the migrations again.
2. Fix forward: write a new migration that repairs state; never edit an applied file (checksums).
3. If an app release depends on the failed migration, keep the previous release running (migrations
   are backward compatible by policy).

## 13. Key rotation

See `docs/SECURITY.md#secret-and-key-rotation` for every secret. The encryption key
(`W360_ENCRYPTION_KEYS`, ADR-134):

1. Add the new key next to the old one (`old:…,new:…`), make it primary
   (`W360_ENCRYPTION_PRIMARY_KEY_ID=new`) and deploy web and worker. New values are sealed with the
   new key from then on, and both keys open what is stored.
2. The worker's minute sweep seals what the old key sealed again with the new one, up to 500 values
   a minute, in each company's scope; a row's time does not change. Operations → Keys (section 10P)
   shows how many values each key still seals.
3. Once the old key seals nothing and every web and worker instance runs the new configuration, wait
   until integrations reading change feeds have fetched a page since the rotation: each page hands
   out a cursor sealed with the primary key, and a cursor sealed with a removed key is refused as
   invalid (the integration must start again from the first change). Then remove the old key and
   deploy.
4. A value that does not open with its key stays sealed with it (section 10P, Keys); removing the
   key changes nothing for it, since nothing could open it before.

The job signing key (`W360_JOB_SIGNING_KEY`, ADR-135), one rotation at a time, once every web server
and worker runs a release with ADR-135:

1. Generate the new key (`openssl rand -hex 32`), set it as `W360_JOB_SIGNING_KEY_NEXT` and deploy
   web and worker. Every instance accepts jobs signed with it; nothing signs with it yet. Operations
   → Keys shows it as the next key.
2. Once every instance runs with it, set `W360_JOB_SIGNING_KEY` to the new key and
   `W360_JOB_SIGNING_KEY_PREVIOUS` to the old one, unset `W360_JOB_SIGNING_KEY_NEXT`, and deploy.
   New jobs are signed with the new key, jobs the old key signed still run, and the worker's minute
   sweep signs the waiting, retrying and failed ones again with the new key, up to 500 a minute.
   During each rollout every instance accepts what any other signs.
3. Once every instance runs with the new key and Operations → Keys shows no job that can still run
   signed with the previous key (or with no key id), unset `W360_JOB_SIGNING_KEY_PREVIOUS` and
   deploy. A job left there that does not verify is refused whatever the configuration (section 10P,
   Keys).
4. If the old key leaked, do step 1, then in step 2 sign with the new key without setting a previous
   one: jobs the old key signed are refused (each recorded as `job.invalid_signature`, critical),
   and the sweeps signal their work again from its durable rows.

## 14. Queue policy changes

Changing a queue's pg-boss policy is refused by the migration runner. Create a new queue name with
the new policy, deploy producers to the new queue, drain the old one, then retire it.
