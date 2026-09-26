# Progress

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
