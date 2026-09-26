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

## 10. Compromised company (tenant) or account

1. Suspend the company in `/platform` with a reason (stops outbound activity; ingestion continues).
2. For a compromised user: reset MFA via platform recovery (verified out of band), which signs out
   all their sessions; require a password reset.
3. Rotate company-level provider credentials (reconnect WhatsApp), API keys and webhook secrets
   (phase 5).
4. Review the company audit log and security events; export evidence; notify the owner.
5. Reactivate with a reason once clean.

## 11. Migration failure

1. The runner applies each file in a transaction; a failure rolls back that file and stops.
2. Fix forward: write a new migration that repairs state; never edit an applied file (checksums).
3. If an app release depends on the failed migration, keep the previous release running (migrations
   are backward compatible by policy).

## 12. Key rotation

See `docs/SECURITY.md#secret-and-key-rotation`.

## 13. Queue policy changes

Changing a queue's pg-boss policy is refused by the migration runner. Create a new queue name with
the new policy, deploy producers to the new queue, drain the old one, then retire it.
