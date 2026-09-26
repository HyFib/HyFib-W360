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

## 4. Webhook ingestion failure **(phase 2)**

1. Meta retries for up to 7 days; confirm `/api/webhooks/meta` returns 200 only after persisting.
2. Signature failures (`ops.security_events` `webhook.invalid_signature`): verify `META_APP_SECRET`
   matches the app; a spike from unknown sources is an attack — keep rejecting, alert security.
3. Unknown assets land in `ops.webhook_quarantine`; map them only after verifying ownership (never
   assign by guess). Replay from receipts once mapped.

## 5. Provider outage (Meta, Razorpay, SMTP)

- Sends/charges stay queued with bounded retries and backoff; do not bulk-retry manually.
- Post a status notice in-app (platform banner, backlog) and to affected owners.
- After recovery, watch for `unknown_outcome` sends (section 7) and reconcile payments (section 9).

## 6. Expired or revoked provider credentials **(phase 2)**

1. Symptoms: Graph error 190, failing `debug_token`, loss of WABA subscription.
2. Mark the channel `needs_reconnect`; outbound sends stop (not dropped); notify company admins.
3. The company re-runs Embedded Signup (reconnect) which re-binds the same assets; queued work
   resumes after re-checks.

## 7. Duplicate-send uncertainty **(phase 2)**

1. `unknown_outcome` means the request may have reached Meta but no response was recorded.
2. Wait for correlated status webhooks (up to the reconciliation window). If one arrives, the intent
   resolves to accepted/sent.
3. Otherwise the company's duplicate-risk policy applies (default: never auto-retry). Staff never
   resend on the company's behalf without the company's decision.

## 8. Data restoration

1. Declare incident; freeze deploys.
2. Restore the managed PostgreSQL to a new instance at the chosen point in time (PITR).
3. Verify: row counts, latest audit events, migration table (`w360_migrations.applied`), pg-boss
   version; run the isolation test suite against the restored instance if time permits.
4. Re-apply pending deletions recorded after the restore point (deletion log, phase 5).
5. Switch connection strings (secret manager) and roll web/worker. Record timings (RPO/RTO achieved)
   in the release evidence. **A restore drill has not been performed yet.**

## 9. Payment reconciliation **(phase 5)**

Run the reconciliation job for the window; compare provider payments/refunds/disputes with ledger
entries; resolve mismatches with compensating entries only (never edit history); record the run.

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
