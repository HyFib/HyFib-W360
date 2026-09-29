# Runbooks

Last updated 2026-09-28. Procedures marked **(phase N)** apply once that capability ships. Every
action on customer data requires a support grant (`/platform`) with a reason; every platform action is
audited. Never paste tokens, message content or card data into tickets or chat.

## 1. Triage basics

- Correlation ids: responses carry `x-request-id`; server-action errors show a reference to users.
  Search logs by `correlationId`.
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

1. Identify the queue (`pgboss.job` counts by `name` and `state='created'`).
2. Check worker health and logs; scale worker replicas horizontally (safe).
3. If a poison job fails repeatedly, it moves to `dead-letter` after its retry limit, and the
   worker records it in `ops.dead_letters` (Operations → Queues: queue, kind, company when its
   signature verified, retries, error name and code, never the message). The worker log's
   `job attempt failed` entries carry the error for each attempt; the job itself (ids only, with its
   output) stays in pg-boss for 30 days. Fix the cause; the minute sweeps re-signal durable rows, so
   re-driving is rarely needed (`boss.redrive('dead-letter', …)` as the owner when it is).
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

1. Symptoms: Graph error 190/102/10 or HTTP 401 on sends or setup steps; the number shows
   **Reconnect needed** in Settings → Channels (`channel_accounts.status = 'needs_reconnect'`).
2. The failing send is marked failed with the provider error; later sends to that number fail fast at
   the channel check until it is reconnected. Tell company admins.
3. The company re-runs Embedded Signup (Connect WhatsApp number); the same WABA and number re-bind
   to the same records, the token is replaced and setup re-runs from the first step.

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
      doing anything; the list only counts days that were reconciled.

## 10. Contacts, consent and templates

**A customer says they opted out but still received a template.** Open the contact: the consent
history lists every event with its source and time. Compare with the message's send time in the
conversation. Sends re-check consent right before dispatch, so a template sent after a recorded
opt-out is a defect: collect the message id and the consent event ids (no message text) and open a
security/privacy incident. If the opt-out was never recorded (for example the customer wrote a
sentence rather than a keyword), record it manually with a note.

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
to the template webhook fields (docs/META-SETUP.md).

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
invoice or ticket as the reason: it is shown in the company's audit log. A form older than the
current plan state is refused ("The plan changed while you were editing"); reload. Nothing is
charged in HyFib: set the period after the payment is settled elsewhere.

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
by the minute sweep (every live subscription at least daily, hourly once its cycle has ended, and
just before the plan sweep would move the period on). The worker logs `plan subscription check
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

**Cancelling a company's subscription.** Owners and billing managers cancel in Billing (an active
one at the end of the paid period, otherwise at once). Platform owners cancel at once on the
company's platform page with a reason (needed before changing the company's plan, which staff
cannot do while a subscription is live); the paid period stands and the plan then ends as canceled,
without grace days. A company that cancelled pays again from Billing once the paid period has ended
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
company's billing managers were emailed when 80% were used (limits of 5 or more) and again once all
were (ADR-062), and Billing shows the runs used and the period.
Runs already in progress continue; runs from store events are recorded as "Not sent: the month's
automation runs are used up". Add run packs (when the version sells them) or change the plan; the
next customer message starts a run. The period starts on the day the current plan or trial started
(usage anchor), whatever the billing interval. If the plan leaves out Automations, nothing starts
("not in the plan") and the automation pages say so.

**A usage warning or used-up email did not come.** Each counter (company, automation runs or API
requests, usage period) gets at most one warning, at 80% of the limit rounded up (none for limits of
1 to 4, none when the limit is reached before a sweep saw 80%), and one used-up notice;
`app.usage_counters.warned_at` and `notified_at` say when the sweep queued them. A counter of an
earlier period is marked without an email, and a company that is suspended, restricted or being
deleted gets none. Queued emails go out through the email outbox like every other notice.

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

**The company is suspended or its plan ended.** Keys keep reading; creating contacts, recording
consent and sending answer 423 until the company is active again.

**Migration 0024 failed.** It runs in one transaction. It creates the two tables, the guard trigger,
the two SECURITY DEFINER functions (granted to `w360_app` before their ownership moves to
`w360_definer`), adds `messages.api_key_id` and widens the consent actor check. A failure usually
means the bootstrap roles are missing (`infra/db/bootstrap-roles.sql`).

## 10O. Outgoing webhooks

**"Our endpoint gets nothing."** In Settings → Webhooks (owners and administrators) check that the
endpoint is on and subscribed to the event, then open its deliveries. No delivery at all means no
subscribed event happened since the endpoint was added (events are captured only while an active
endpoint subscribes; earlier ones are not sent). "Send test event" queues a `ping`; the result
column names what went wrong: an HTTP status, `timeout` (no complete answer within 10 seconds),
`dns_failed`, `address_blocked` (the name resolves to a private, loopback or reserved address, which
is never called), `connect_failed`, `response_too_large` (more than 256 KB) or `invalid_status`.
Redirects are not followed: the endpoint must answer at the saved URL.

**Deliveries wait and are not sent.** The worker is woken by the `w360_webhooks` notification and
by the minute sweep. Check the `webhook.deliver` queue (section 3) and the worker log for
`webhooks delivered` and `webhook dispatch failed`; a listener that cannot connect logs
`webhook listener could not listen` and delivery then waits for the minute sweep. Suspended and
restricted companies are not delivered to until they are active again. A delivery in `delivering`
longer than 45 seconds belongs to a lost worker; the next run attempts it again (the receiver may see
it twice and deduplicates on the event id).

**An endpoint was turned off automatically.** It failed every attempt for 72 hours; its waiting
deliveries were marked failed (`endpoint_disabled`), owners and administrators got the
"Webhook endpoint turned off" email, and the audit log has `webhook.endpoint_auto_disabled`. Fix the
receiver, turn the endpoint on (its health starts afresh), send a test event, then replay the
failed deliveries that are still needed (within 30 days) from its deliveries page, filtered to
failed ones.

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
(ADR-054), not Meta's rules.

**Onboarding.** Failed signups show the reason Meta returned; abandoned ones expired before the
popup finished (the person can start again). A number setup stuck for over 30 minutes: check the
`channel.onboard` queue and dead letters; companies without an active number after signup may need
help with Embedded Signup.

**Queues.** Counts are pg-boss's, refreshed by the worker about once a minute; failed counts include
jobs retained after their last attempt. `billing.auto-recharge` has no retries on purpose
(section 9). A row "Not declared by this release" is a queue named by a dead letter that this
release does not declare (an older or newer deploy); "No such queue in the database" means pg-boss
has no queue by that name (for a declared queue: the migrations have not run).

**Dead letters.** Recorded by the worker within seconds of the move; if the list stays empty while
`SELECT count(*) FROM pgboss.job WHERE name = 'dead-letter' AND state = 'created'` grows, the worker
is not consuming (`dead letters recorded` and `job attempt failed` in its log). Rows are deleted 30
days after the job failed.

**Repairs.** Retry and Resolve (section 4) both need a reason of at least 10 characters and appear
in the platform audit log as `platform.webhook_receipt_retried` and
`platform.webhook_quarantine_resolved`. A receipt whose body was erased (after 7 days) cannot be
retried.

**Migrations 0026 and 0027 failed.** 0026 runs in one transaction: it needs the bootstrap roles
(`w360_definer`, `w360_platform`, `w360_app`). 0027 builds an index concurrently outside a
transaction; if it fails, drop the invalid index
(`DROP INDEX CONCURRENTLY IF EXISTS app.consent_events_tenant_occurred_idx`) and run the
migrations again.

## 10Q. Company export and deletion

Owners use Settings → Company data (ADR-055). Nothing here is done by staff: staff cannot start,
speed up or cancel a deletion, and the export is only for the company's owners.

**An export fails or is cut short.** The file is complete only if its last line is
`{"end":true,...}`. A second export while one runs answers 409; each start is audited
(`tenant.exported`) and emailed to owners and administrators, even when it then fails. A failure
after the download started is logged by the web as `company export stopped` (with the company id).
Large companies stream for as long as the read takes; `idle_in_transaction_session_timeout` (60 s)
ends an export whose reader stops reading for a minute.

**A deletion is scheduled.** The company is `pending_deletion` until `due_at` (14 days) and works as
suspended. Any owner cancels in Settings → Company data until the run starts; after that the page
says it can no longer be cancelled. The register is `ops.tenant_deletions` (the company's platform
page shows it). A company that asks HyFib to stop a deletion before it starts: an owner cancels; if
no owner can, suspend handling of the request and escalate (there is no staff cancellation).

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

## 11. Compromised company (tenant) or account

1. Suspend the company in `/platform` with a reason (stops outbound activity; ingestion continues).
2. For a compromised user: reset MFA via platform recovery (verified out of band), which signs out
   all their sessions; require a password reset.
3. Rotate company-level provider credentials (reconnect WhatsApp), API keys and webhook secrets
   (phase 5). A stolen session alone could not export the company, ask for its deletion, change
   payment settings or the company's Razorpay keys, create API keys or webhook endpoints, add an
   owner or turn off required two-factor: those need a sign-in within the last 15 minutes
   (ADR-056). Check the audit log for them anyway (a stolen password is enough to sign in).
4. Review the company audit log and security events; export evidence; notify the owner.
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

See `docs/SECURITY.md#secret-and-key-rotation`.

## 14. Queue policy changes

Changing a queue's pg-boss policy is refused by the migration runner. Create a new queue name with
the new policy, deploy producers to the new queue, drain the old one, then retire it.
