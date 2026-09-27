# Runbooks

Last updated 2026-09-26. Procedures marked **(phase N)** apply once that capability ships. Every
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
3. If a poison job fails repeatedly, it moves to `dead-letter` after its retry limit. Inspect its
   data (ids only), fix the cause, then re-drive with `boss.redrive('dead-letter', …)` or re-signal
   the durable row.
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
   12 attempts. Receipts at 12 attempts stay `failed` for you: read `last_error`, fix the cause, then
   reset with `UPDATE ops.webhook_receipts SET status = 'failed', attempts = 0 WHERE id = …` (owner
   role); processing is idempotent.
4. Unknown or mismatched assets land in `ops.webhook_quarantine` (`unknown_asset`,
   `asset_mismatch`, `malformed`). Map an asset only after verifying ownership with the company
   (never by guess), then reset the receipt as above. Record the decision in `resolution`.
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
4. Re-apply pending deletions recorded after the restore point (deletion log, phase 5).
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
   may make it negative, which blocks billable services until credit is added.
7. **Enabling card mandates.** Only after Razorpay confirms Recurring Payments (card) for the
   merchant: set `RAZORPAY_RECURRING_CARDS_ENABLED=true` on web and worker. Turning it off again
   stops new mandates and new auto-recharge settings; attempts already requested still complete.
8. **Integrity check** (read-only, any time):
   `SELECT tenant_id FROM app.ledger_accounts GROUP BY tenant_id HAVING sum(CASE WHEN normal_side =
'debit' THEN balance_minor ELSE -balance_minor END) <> 0` must return no rows.

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
allowed; `dns_failed` and `connect_failed` mean nothing was sent. `timeout`, `network_error` and
`no_result` mean the request may have reached the server without a complete answer: the outcome is
unknown and the call is never repeated automatically, because the server may have acted on it
(creating an order, say). Ask the company to check on their side, then take the conversation over
if needed. `not_started` means the worker did not get to the call before the run's two-minute
deadline (a backlog, a worker outage or a suspended company); it was not sent. Worker log lines
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

**Migration 0014 failed.** Like 0011, it replaces `app.erase_contact` and
`ops.apply_automation_retention` through `SET ROLE w360_definer` and applies nothing on failure.

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

## 11. Compromised company (tenant) or account

1. Suspend the company in `/platform` with a reason (stops outbound activity; ingestion continues).
2. For a compromised user: reset MFA via platform recovery (verified out of band), which signs out
   all their sessions; require a password reset.
3. Rotate company-level provider credentials (reconnect WhatsApp), API keys and webhook secrets
   (phase 5).
4. Review the company audit log and security events; export evidence; notify the owner.
5. Reactivate with a reason once clean.

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
