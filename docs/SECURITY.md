# Security

Last updated 2026-09-26. This document lists implemented controls, the role/permission matrix and
security operations. It is not a compliance claim; see `docs/THREAT-MODEL.md` for open risks and
`docs/RELEASE-CHECKLIST.md` for launch gates (including an independent security review).

## Implemented controls (verified locally)

| Area               | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation   | FORCE RLS on every tenant table; transaction-local context that fails closed; runtime roles without BYPASSRLS/superuser/ownership (start-up self check); column-level grants; SECURITY DEFINER entry points with pinned `search_path`, no PUBLIC execute and explicit per-role grants; 60 integration tests incl. pool reuse, jobs and concurrency.                                                                                                                                                                                                                                                                           |
| Authentication     | Email verification required; scrypt password hashing (Better Auth); minimum 12 characters; DB-backed rate limits (sign-in 5/min, sign-up 10/h, reset 5/h, 2FA 5/min per IP); sign-up enumeration protection; sessions stored server-side without cookie cache (immediate revocation); revoke other sessions on password change/reset.                                                                                                                                                                                                                                                                                         |
| MFA                | TOTP with 10 backup codes; required for owner, administrator and billing roles after `MFA_GRACE_PERIOD_HOURS` (default 72 h); optional company-wide requirement; platform staff must have MFA.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Authorization      | Permission matrix below, enforced in domain services (server actions and pages), workers (`authorizeJob`) and PostgreSQL policies. Suspended companies lose outbound permissions. Only owners manage owners; last-owner protection is transactional.                                                                                                                                                                                                                                                                                                                                                                          |
| Sessions & cookies | `w360` cookie prefix, HttpOnly, SameSite=Lax, Secure in production; session lifetime 7 days, refreshed daily; step-up window 15 minutes (library `freshAge`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| CSRF               | SameSite cookies, Next.js server-action Origin/Host verification, and our exact trusted-origin check for every action.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Browser hardening  | Per-request nonce CSP with `strict-dynamic`, `frame-ancestors 'none'`, HSTS (preload-ready), `X-Content-Type-Options`, strict referrer policy, COOP/CORP, restrictive Permissions-Policy, `Cache-Control: private, no-store` on app pages.                                                                                                                                                                                                                                                                                                                                                                                    |
| Secrets            | Loaded from environment populated by the secret manager; production start-up refuses placeholder values; AES-256-GCM keyring with key ids, AAD binding and rotation support; logger redaction.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Audit              | Append-only company audit log and platform audit log (privileges + trigger); security events for invalid job signatures, password resets and sign-up attempts on existing emails.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Platform access    | Separate platform role without BYPASSRLS; customer data only through reasoned, scoped, ≤8 h support grants visible to the company; no impersonation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Webhooks           | Raw-body HMAC-SHA256 (`X-Hub-Signature-256`) with constant-time compare against the current and previous app secret; 4 MB cap enforced while streaming; encrypted durable receipt before 200; tenant resolved only from verified asset bindings; quarantine otherwise; rate-limited security events for bad signatures.                                                                                                                                                                                                                                                                                                       |
| Provider tokens    | Exchanged server-side from Embedded Signup codes, verified with `debug_token` and an ownership check, stored AES-256-GCM with AAD (company + account), never sent to browsers or logs; registration PINs encrypted the same way.                                                                                                                                                                                                                                                                                                                                                                                              |
| Live updates       | SSE and polling endpoints authenticate the session, resolve membership per request, re-validate every 30 s, carry ids only and filter events by conversation visibility; unauthenticated or non-member requests get 404.                                                                                                                                                                                                                                                                                                                                                                                                      |
| Payments           | Card entry only inside Razorpay Checkout's frame; the Checkout signature is verified against our stored order id and the payment is then fetched from Razorpay; only captured payments credit, exactly once, through SECURITY DEFINER functions; runtime roles cannot write ledger rows or balances; webhooks verified over the raw body (current + previous secret) and stored before 200; only card network, issuer, last four digits and expiry stored (no PAN/CVV); billing actions limited to owner and billing roles (MFA-required roles) and audited. Step-up re-authentication for payment settings is not built yet. |
| Contacts & consent | Consent is append-only (runtime role can only insert events; current state is written by a SECURITY DEFINER trigger); every template send re-checks consent and the suppression list under the send intent's row lock; erasure is one audited definer function; the status-history guard allows clearing recipient ids only inside it; CSV import caps size, rows, columns and field length and never echoes row contents; CSV export is formula-safe and audited.                                                                                                                                                            |
| Templates          | Created, deleted and listed only by the worker with the stored WABA token (never in the browser); webhooks for templates are signals routed through verified WABA bindings and never change status on their own; submission is write-ahead so a lost response cannot create a duplicate.                                                                                                                                                                                                                                                                                                                                      |
| Supply chain       | Exact pins + lockfile, pnpm minimum release age, explicit install-script allowlist, `pnpm audit` and gitleaks in CI, GitHub Actions pinned by SHA, Trivy image scanning, Dependabot.                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Permission matrix

Generated from `packages/domain/src/authz/permissions.ts` with `pnpm tsx scripts/permission-matrix.ts`.
Members can hold several roles; effective permissions are the union, minus permissions blocked while
the company is suspended or while required MFA is overdue (only `tenant.read` and `members.read`
remain).

| Permission               | owner | admin | supervisor | agent | marketer | analyst | billing | Allowed while suspended |
| ------------------------ | :---: | :---: | :--------: | :---: | :------: | :-----: | :-----: | :---------------------: |
| `tenant.read`            |   ✓   |   ✓   |     ✓      |   ✓   |    ✓     |    ✓    |    ✓    |            ✓            |
| `tenant.settings.manage` |   ✓   |   ✓   |            |       |          |         |         |                         |
| `tenant.security.manage` |   ✓   |   ✓   |            |       |          |         |         |                         |
| `tenant.export`          |   ✓   |       |            |       |          |         |         |            ✓            |
| `tenant.delete`          |   ✓   |       |            |       |          |         |         |                         |
| `members.read`           |   ✓   |   ✓   |     ✓      |   ✓   |    ✓     |    ✓    |    ✓    |            ✓            |
| `members.invite`         |   ✓   |   ✓   |            |       |          |         |         |                         |
| `members.manage`         |   ✓   |   ✓   |            |       |          |         |         |            ✓            |
| `members.manage_owners`  |   ✓   |       |            |       |          |         |         |            ✓            |
| `audit.read`             |   ✓   |   ✓   |            |       |          |         |         |            ✓            |
| `channels.read`          |   ✓   |   ✓   |     ✓      |   ✓   |    ✓     |    ✓    |         |            ✓            |
| `channels.manage`        |   ✓   |   ✓   |            |       |          |         |         |                         |
| `inbox.read_all`         |   ✓   |   ✓   |     ✓      |       |          |         |         |            ✓            |
| `inbox.read_assigned`    |   ✓   |   ✓   |     ✓      |   ✓   |          |         |         |            ✓            |
| `inbox.reply`            |   ✓   |   ✓   |     ✓      |   ✓   |          |         |         |                         |
| `inbox.assign`           |   ✓   |   ✓   |     ✓      |       |          |         |         |                         |
| `inbox.supervise`        |   ✓   |   ✓   |     ✓      |       |          |         |         |                         |
| `contacts.read`          |   ✓   |   ✓   |     ✓      |   ✓   |    ✓     |         |         |            ✓            |
| `contacts.write`         |   ✓   |   ✓   |     ✓      |   ✓   |    ✓     |         |         |                         |
| `contacts.import`        |   ✓   |   ✓   |     ✓      |       |    ✓     |         |         |                         |
| `contacts.export`        |   ✓   |   ✓   |            |       |    ✓     |         |         |            ✓            |
| `contacts.delete`        |   ✓   |   ✓   |            |       |          |         |         |            ✓            |
| `templates.read`         |   ✓   |   ✓   |     ✓      |   ✓   |    ✓     |    ✓    |         |            ✓            |
| `templates.write`        |   ✓   |   ✓   |            |       |    ✓     |         |         |                         |
| `templates.submit`       |   ✓   |   ✓   |            |       |    ✓     |         |         |                         |
| `campaigns.read`         |   ✓   |   ✓   |     ✓      |       |    ✓     |    ✓    |         |            ✓            |
| `campaigns.write`        |   ✓   |   ✓   |            |       |    ✓     |         |         |                         |
| `campaigns.approve`      |   ✓   |   ✓   |            |       |          |         |         |                         |
| `campaigns.send`         |   ✓   |   ✓   |            |       |    ✓     |         |         |                         |
| `automations.read`       |   ✓   |   ✓   |     ✓      |       |    ✓     |    ✓    |         |            ✓            |
| `automations.write`      |   ✓   |   ✓   |            |       |    ✓     |         |         |                         |
| `automations.publish`    |   ✓   |   ✓   |            |       |          |         |         |                         |
| `flows.read`             |   ✓   |   ✓   |     ✓      |       |    ✓     |    ✓    |         |            ✓            |
| `flows.write`            |   ✓   |   ✓   |            |       |    ✓     |         |         |                         |
| `flows.publish`          |   ✓   |   ✓   |            |       |          |         |         |                         |
| `crm.read`               |   ✓   |   ✓   |     ✓      |   ✓   |          |         |         |            ✓            |
| `crm.write`              |   ✓   |   ✓   |     ✓      |   ✓   |          |         |         |                         |
| `commerce.read`          |   ✓   |   ✓   |     ✓      |   ✓   |    ✓     |         |         |            ✓            |
| `commerce.manage`        |   ✓   |   ✓   |            |       |          |         |         |                         |
| `ai.use`                 |   ✓   |   ✓   |     ✓      |   ✓   |    ✓     |         |         |                         |
| `ai.manage`              |   ✓   |   ✓   |            |       |          |         |         |                         |
| `reports.read`           |   ✓   |   ✓   |     ✓      |       |    ✓     |    ✓    |         |            ✓            |
| `reports.export`         |   ✓   |   ✓   |     ✓      |       |          |    ✓    |         |            ✓            |
| `integrations.read`      |   ✓   |   ✓   |     ✓      |       |    ✓     |         |         |            ✓            |
| `integrations.manage`    |   ✓   |   ✓   |            |       |          |         |         |                         |
| `developer.manage`       |   ✓   |   ✓   |            |       |          |         |         |                         |
| `billing.read`           |   ✓   |   ✓   |            |       |          |         |    ✓    |            ✓            |
| `billing.manage`         |   ✓   |       |            |       |          |         |    ✓    |            ✓            |

MFA required (after grace period): owner, admin, billing.

Phase 3 rules on top of the matrix (enforced in domain services and re-checked where noted):

- Sending a template: utility templates need `inbox.reply` or `campaigns.send`; marketing templates
  need `campaigns.send`. Members without inbox access can send from a contact page but do not see
  or claim the conversation. Consent and suppression are checked when queued and again before
  dispatch.
- Consent keywords, the marketing opt-in requirement and custom contact fields need
  `tenant.settings.manage`. Adding a number to the suppression list needs `contacts.write`;
  removing one needs `tenant.settings.manage` (it re-enables messaging).
- Deleting a template Meta already has needs `templates.submit` as well as `templates.write`.
- Erasing a contact needs `contacts.delete` (also while the company is suspended).

Platform roles (`ops.platform_admins`): `platform_owner` and `platform_operator`. Both require MFA;
all actions are audited; neither can read customer content without a support grant.

## Secret and key rotation

| Secret                                  | Rotation procedure                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `W360_ENCRYPTION_KEYS`                  | Add a new key id, make it primary (`W360_ENCRYPTION_PRIMARY_KEY_ID`), deploy, run the re-encryption job (phase 2 adds provider tokens), remove the old key after `Keyring.needsRotation` finds no rows. |
| `W360_JOB_SIGNING_KEY`                  | Drain queues or deploy dual-key verification first (backlog item SEC-4); then rotate. Invalid-signature jobs are dropped and logged.                                                                    |
| `BETTER_AUTH_SECRET`                    | Rotating signs everyone out and invalidates encrypted TOTP secrets; plan with the library's multi-secret support (`secrets` option) before production.                                                  |
| Database role passwords                 | Rotate in the secret manager and PostgreSQL (`ALTER ROLE … PASSWORD`), rolling restart.                                                                                                                 |
| Provider secrets (Meta, Razorpay, SMTP) | Rotate at the provider, update the secret manager, rolling restart; webhook secrets support an overlap window where the provider allows it.                                                             |

## Reporting and response

Security issues: report privately to the HyFib security contact (to be published before launch).
Incident handling follows `docs/RUNBOOKS.md` (compromised tenant, credential exposure).

## Known gaps before launch

See `docs/THREAT-MODEL.md` (status P/D/A) and `docs/BACKLOG.md` (SEC-* items): WebAuthn, breached
password screening, hash-chained audit checkpoints, SSRF egress guard, media scanning, dual-key job
signing, OpenTelemetry alerting, independent penetration test, step-up re-authentication for payment
settings, and Razorpay sandbox verification of the payment flows and Checkout CSP.
