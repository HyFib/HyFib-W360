# Progress

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

### Blockers (external)

- Network policy of this build environment blocked `wati.io`, `developers.facebook.com`,
  `business.whatsapp.com` and `razorpay.com`; research relies on search summaries and official GitHub
  sources and must be re-verified.
- Meta: business verification, Tech Provider app review, Embedded Signup configuration.
- Razorpay: merchant activation (Orders, Subscriptions, Recurring Payments card mandates).
- Owner decisions: SMTP provider and sending domain, hosting provider/region, legal entity for billing.

### Next task

Phase 2, starting with P2-01 (channel schema and asset bindings), P2-04 (webhook endpoint with raw-body
signature verification and durable receipts) and P2-05/P2-06 (idempotent processing into contacts,
conversations and messages), tested with deterministic provider fixtures while Meta approvals are
pending.
