# Release checklist

**Current overall status: implementation in progress — production blocked.** No release has been
made. This checklist records the evidence required per gate; unchecked items block production.

## Build and version

- [x] Lockfile committed, exact versions pinned, `pnpm audit` clean (2026-09-26, local)
- [x] Web and worker images build and start locally (2026-09-26)
- [ ] Images built by CI, scanned (Trivy HIGH/CRITICAL = 0 unfixed), digests recorded
- [ ] Release notes with commit SHA, image digests, migration list

## Phase gates

| Phase | Gate                                                                                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Status                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 0     | Scope and dependencies traceable; no invented provider capabilities                                     | FEATURE-MATRIX (dated, sourced, search-derived evidence labelled), research files, BACKLOG, META-SETUP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Done with caveat: sources must be re-verified by direct access                              |
| 1     | Two-tenant adversarial isolation suite passes incl. pool reuse and jobs                                 | `pnpm test:integration`: 54/54 passed locally on PostgreSQL 18 (2026-09-26)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Locally passed; CI evidence pending                                                         |
| 2     | Approved test account sends/receives; duplicate/reordered/replayed events and restart recovery verified | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Not started (needs Meta approvals)                                                          |
| 3     | Opt-outs stop queued sends; concurrent limits and ambiguous outcomes handled                            | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Not started                                                                                 |
| 4     | Published flow survives restart; handoff and integration idempotency verified                           | Local only (2026-09-27): `tests/integration/automations.test.ts` 15/15 — a run survives a failing step, a killed consumer and lost signals with real pg-boss consumers, a step that keeps failing hands over after five attempts, a run waits for Meta to accept each message, and bot and person never answer at once; e2e `automations.spec.ts`. CRM: `tests/integration/crm.test.ts` 14/14 (reminders emailed exactly once under repeated signals, erasure also under concurrent writes, settings changes racing deal writes, isolation) and e2e `crm.spec.ts`. Integration idempotency (HTTP step, commerce) not built | In progress: automation engine and CRM locally verified; P4-02, P4-03, P4-05 and P4-06 open |
| 5     | Financial concurrency/reconciliation tests; live approved payment/mandate flow                          | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Not started (needs Razorpay activation)                                                     |
| 6     | Real integration and security checks per capability                                                     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Not started                                                                                 |
| 7     | Load, accessibility, recovery, security review, rollout                                                 | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Not started                                                                                 |

## Production release requirements (all mandatory)

- [ ] Real credentials configured in the secret manager (DB roles, keyring, auth secret, SMTP, Meta, Razorpay)
- [ ] Meta business verification, app review/advanced access, live-mode app (docs/META-SETUP.md)
- [ ] Live integration checks on approved accounts (messaging, templates, webhooks)
- [ ] A campaign to test recipients on an approved sandbox number (consent re-checks, pause,
      cancel, delivery statuses, reply attribution) and the 10,000-recipient run in staging
- [ ] Meta rate cards for each launch currency entered and published by platform staff from
      Meta's current published cards (none ship with HyFib)
- [ ] Report numbers compared with WhatsApp Manager and Meta's invoice for a sandbox period
      (delivery counts, billable flags, estimated charges); differences explained in the
      definitions
- [ ] Migrations 0008 and 0010 (`CREATE INDEX CONCURRENTLY`) applied on production-sized data and
      the indexes confirmed valid
- [ ] A CSAT survey sent to a test recipient on an approved sandbox number: the reply-button message
      is accepted and delivered, and a real tap arrives with `button_reply` and `context.id` as in
      research M-158
- [ ] An automation run with a test recipient on an approved sandbox number: the reply-button
      message with header and footer is accepted and delivered, a real tap and a typed reply
      continue the run, and Take over stops it (research M-157, M-159)
- [ ] Migration 0011 rehearsed on production-sized data (it re-checks the reply-turn
      constraints while holding a table lock) and the lock time recorded
- [ ] A CRM task reminder delivered through the production SMTP provider to a member's mailbox
      (sender domain authenticated), with the link opening the tasks page
- [ ] Tenant-isolation and security gates passing in CI on the release commit
- [ ] Measured load behaviour against the test envelope (k6 results)
- [ ] Backup restoration drill performed and timings recorded (RPO/RTO)
- [ ] Monitoring, alerting and on-call ownership defined
- [ ] Billing reconciliation verified end to end (phase 5)
- [ ] Legal/commercial review: terms, privacy notice, DPA, subprocessors, wallet terms, tax
- [ ] **Independent external security review / penetration test** completed and findings resolved
- [ ] Accessibility review (WCAG 2.2 AA-oriented) and real-device smoke tests documented

## Known remaining risks (as of 2026-09-26)

- Provider documentation could not be fetched directly; research is search-derived (ADR-016).
- Auto-recharge timing on Indian card mandates (≈36–72 h) constrains product behaviour.
- Plaintext session tokens at rest in `auth.sessions` (restricted to `w360_auth`).
- Job-signing key rotation requires a dual-key window (backlog SEC-4).

## Rollout and rollback

Follow `docs/DEPLOYMENT.md#release-procedure`: migrate first (backward compatible), roll out workers
then web with readiness checks; roll back by redeploying the previous image digest; repair schema
forward only.
