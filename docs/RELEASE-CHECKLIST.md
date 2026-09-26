# Release checklist

**Current overall status: implementation in progress — production blocked.** No release has been
made. This checklist records the evidence required per gate; unchecked items block production.

## Build and version

- [x] Lockfile committed, exact versions pinned, `pnpm audit` clean (2026-09-26, local)
- [x] Web and worker images build and start locally (2026-09-26)
- [ ] Images built by CI, scanned (Trivy HIGH/CRITICAL = 0 unfixed), digests recorded
- [ ] Release notes with commit SHA, image digests, migration list

## Phase gates

| Phase | Gate                                                                                                    | Evidence                                                                                               | Status                                                         |
| ----- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 0     | Scope and dependencies traceable; no invented provider capabilities                                     | FEATURE-MATRIX (dated, sourced, search-derived evidence labelled), research files, BACKLOG, META-SETUP | Done with caveat: sources must be re-verified by direct access |
| 1     | Two-tenant adversarial isolation suite passes incl. pool reuse and jobs                                 | `pnpm test:integration`: 54/54 passed locally on PostgreSQL 18 (2026-09-26)                            | Locally passed; CI evidence pending                            |
| 2     | Approved test account sends/receives; duplicate/reordered/replayed events and restart recovery verified | —                                                                                                      | Not started (needs Meta approvals)                             |
| 3     | Opt-outs stop queued sends; concurrent limits and ambiguous outcomes handled                            | —                                                                                                      | Not started                                                    |
| 4     | Published flow survives restart; handoff and integration idempotency verified                           | —                                                                                                      | Not started                                                    |
| 5     | Financial concurrency/reconciliation tests; live approved payment/mandate flow                          | —                                                                                                      | Not started (needs Razorpay activation)                        |
| 6     | Real integration and security checks per capability                                                     | —                                                                                                      | Not started                                                    |
| 7     | Load, accessibility, recovery, security review, rollout                                                 | —                                                                                                      | Not started                                                    |

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
- [ ] Migration 0008 (`CREATE INDEX CONCURRENTLY`) applied on production-sized data and the index
      confirmed valid
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
