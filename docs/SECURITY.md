# Security

Last updated 2026-09-27. This document lists implemented controls, the role/permission matrix and
security operations. It is not a compliance claim; see `docs/THREAT-MODEL.md` for open risks and
`docs/RELEASE-CHECKLIST.md` for launch gates (including an independent security review).

## Implemented controls (verified locally)

| Area               | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation   | FORCE RLS on every tenant table; transaction-local context that fails closed; runtime roles without BYPASSRLS/superuser/ownership (start-up self check); column-level grants; SECURITY DEFINER entry points with pinned `search_path`, no PUBLIC execute and explicit per-role grants; 60 integration tests incl. pool reuse, jobs and concurrency.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Authentication     | Email verification required; scrypt password hashing (Better Auth); minimum 12 characters; DB-backed rate limits (sign-in 5/min, sign-up 10/h, reset 5/h, 2FA 5/min per IP); sign-up enumeration protection; sessions stored server-side without cookie cache (immediate revocation); revoke other sessions on password change/reset.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| MFA                | TOTP with 10 backup codes; required for owner, administrator and billing roles after `MFA_GRACE_PERIOD_HOURS` (default 72 h); optional company-wide requirement; platform staff must have MFA.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Authorization      | Permission matrix below, enforced in domain services (server actions and pages), workers (`authorizeJob`) and PostgreSQL policies. Suspended companies lose outbound permissions. Only owners manage owners; last-owner protection is transactional.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Sessions & cookies | `w360` cookie prefix, HttpOnly, SameSite=Lax, Secure in production; session lifetime 7 days, refreshed daily; step-up window 15 minutes (library `freshAge`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| CSRF               | SameSite cookies, Next.js server-action Origin/Host verification, and our exact trusted-origin check for every action.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Browser hardening  | Per-request nonce CSP with `strict-dynamic`, `frame-ancestors 'none'`, HSTS (preload-ready), `X-Content-Type-Options`, strict referrer policy, COOP/CORP, restrictive Permissions-Policy, `Cache-Control: private, no-store` on app pages.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Secrets            | Loaded from environment populated by the secret manager; production start-up refuses placeholder values; AES-256-GCM keyring with key ids, AAD binding and rotation support; logger redaction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Audit              | Append-only company audit log and platform audit log (privileges + trigger); security events for invalid job signatures, password resets and sign-up attempts on existing emails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Platform access    | Separate platform role without BYPASSRLS; customer data only through reasoned, scoped, ≤8 h support grants visible to the company; no impersonation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Webhooks           | Raw-body HMAC-SHA256 (`X-Hub-Signature-256`) with constant-time compare against the current and previous app secret; 4 MB cap enforced while streaming; encrypted durable receipt before 200; tenant resolved only from verified asset bindings; quarantine otherwise; rate-limited security events for bad signatures.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Provider tokens    | Exchanged server-side from Embedded Signup codes, verified with `debug_token` and an ownership check, stored AES-256-GCM with AAD (company + account), never sent to browsers or logs; registration PINs encrypted the same way.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Live updates       | SSE and polling endpoints authenticate the session, resolve membership per request, re-validate every 30 s, carry ids only and filter events by conversation visibility; unauthenticated or non-member requests get 404.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Payments           | Card entry only inside Razorpay Checkout's frame; the Checkout signature is verified against our stored order id and the payment is then fetched from Razorpay; only captured payments credit, exactly once, through SECURITY DEFINER functions; runtime roles cannot write ledger rows or balances; webhooks verified over the raw body (current + previous secret) and stored before 200; only card network, issuer, last four digits and expiry stored (no PAN/CVV); billing actions limited to owner and billing roles (MFA-required roles) and audited. Step-up re-authentication for payment settings is not built yet.                                                                                                                                    |
| Contacts & consent | Consent is append-only (runtime role can only insert events; current state is written by a SECURITY DEFINER trigger); every template send re-checks consent and the suppression list under the send intent's row lock; erasure is one audited definer function; the status-history guard allows clearing recipient ids only inside it; CSV import caps size, rows, columns and field length and never echoes row contents; CSV export is formula-safe and audited.                                                                                                                                                                                                                                                                                               |
| Campaigns          | Audience snapshots without personal data; recipients re-checked (erasure, suppression, consent, variables, frequency cap, spending cap) when queued and again by the send worker before dispatch; pause/cancel cancel unclaimed sends atomically; one runner tick per campaign and per company; sends under a named member's authority; four-eyes approval option; formula-safe audited export; rate cards immutable once published.                                                                                                                                                                                                                                                                                                                             |
| Reports            | Aggregates and member names only (no message content or contact details), computed in one read-only snapshot under the company's RLS scope; reply turns written only by database triggers (runtime role cannot rewrite or delete them); metric definitions global and read-only; per-section exports need `reports.export`, are formula-safe and audited before data is returned.                                                                                                                                                                                                                                                                                                                                                                                |
| Automations        | Published versions are immutable (database trigger) and runs stay pinned to theirs; runs are durable rows advanced one step per transaction under the conversation and run row locks; a partial unique index allows one active run per conversation, and a member reply, template send, assignment, take-over or resolve ends it and cancels unclaimed bot sends; reply-button ids name the run, step and visit, and stale or forged ids select nothing; budgets cap steps, loops, messages, run time and runs per conversation per hour; step logs hold outcome codes and labels written by the company, never customer text; captured answers are shown only to members who can see the conversation and are cleared 30 days after the run ends or on erasure. |
| Templates          | Created, deleted and listed only by the worker with the stored WABA token (never in the browser); webhooks for templates are signals routed through verified WABA bindings and never change status on their own; submission is write-ahead so a lost response cannot create a duplicate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Supply chain       | Exact pins + lockfile, pnpm minimum release age, explicit install-script allowlist, `pnpm audit` and gitleaks in CI, GitHub Actions pinned by SHA, Trivy image scanning, Dependabot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

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
- Campaigns: drafts and segments need `campaigns.write`; submitting needs `campaigns.write` and
  `campaigns.send`; approving (when the company requires it) needs `campaigns.approve` and a member
  other than the submitter; pausing, resuming, cancelling a started campaign, changing its caps and
  test sends need `campaigns.send`. Sends run under the submitter's (or the resuming member's)
  authority and the runner pauses the campaign if that member leaves or loses `campaigns.send`.
  Per-recipient lists need `contacts.read`; the per-recipient CSV export needs `contacts.export`.
  Campaign settings (approval, frequency cap, estimate currency) need `tenant.settings.manage`.
- Rate cards are platform data: only platform administrators create, publish and withdraw them
  (platform audit log); companies read published cards.
- Reports need `reports.read` (they contain aggregates and member names only, so roles without
  inbox or contact access, such as analysts and marketers, can read them); CSV exports need
  `reports.export` and are audited (`report.exported`). The inbox response target needs
  `tenant.settings.manage`; resolving and reopening conversations is audited.
- Inbox teams (P3-06): creating, editing and deleting teams (members, numbers, routing keywords,
  round robin, limits) and saved replies need `inbox.supervise` (audited); moving a conversation
  between teams needs `inbox.assign` (audited, version-checked); members set their own
  availability with `inbox.reply`, and `inbox.assign` may set anyone's (audited). Business hours,
  closed days and CSAT settings need `tenant.settings.manage` (audited). Teams never widen
  visibility. Mentions: only active members who can see the conversation at that moment can be
  mentioned, and a member's mentions are listed only for conversations they can still see.
  Automatic assignment only reaches active members whose role can read and answer conversations.
- CSAT taps: a tap is recorded only when its button id names a survey of the same conversation and
  its `context.id` is that survey's message; nothing in the tap is trusted beyond selecting one of
  the three scores, and a tap can never reopen a conversation.

Phase 4 rules (automations, P4-01):

- Reading automations, versions and run history needs `automations.read`; editing drafts and
  deleting a never-published draft need `automations.write`; publishing, pausing, turning on,
  archiving, restoring and stopping a run need `automations.publish`. Every change (including test
  runs, stops and take-overs) is audited.
- A test run needs `automations.write` and `inbox.reply`, and only runs in an open conversation the
  member can see, with a customer message in the last 24 hours, that is unassigned or assigned to
  them. It sends real messages under the tester's authority and stops at its next step once the
  tester leaves the company or loses either permission.
- Taking a conversation over from an automation needs `inbox.reply` and a conversation the member
  can see (audited). Any member reply, template send, assignment or resolve also ends the run.
- Run lists and logs show the conversation link, captured answers and message links only to members
  who can see that conversation; analysts and marketers see outcomes and step codes only.
- Automations start only in unassigned conversations of an active (not suspended) company, never
  after an opt-out keyword, and every bot message re-checks the channel, the 24-hour window and the
  contact's WhatsApp number when queued. Live runs send as the company's automation (no member
  actor on the send); test runs send under the tester's authority.

Phase 4 rules (CRM, P4-04):

- Reading the board, deals, tasks, notes and timelines needs `crm.read`; creating and changing
  deals, tasks and notes needs `crm.write`. CRM visibility is company-wide: an agent who sees only
  assigned conversations still sees every deal, task and note of the company. Notes say so on the
  form ("visible to members with CRM access"); conversation notes keep the inbox's visibility.
- Pipelines and stages are company settings: creating, editing, archiving and restoring them need
  `tenant.settings.manage` and are audited (`crm.pipeline_*`, with counts, never names). Deal and
  task changes are recorded on the CRM timeline (member, time, what changed), not in the audit log.
  A pipeline's currency cannot be changed by any runtime role (no UPDATE grant), and a deal's
  contact cannot be changed (no UPDATE grant), so a deal's tasks and timeline stay with it.
- Owners and assignees must be active members whose role has `crm.read`; a reminder is emailed only
  to an assignee who still is one when it is due. The email names the task and the company and
  links to the tasks page; it contains nothing else from the CRM.
- Linking a deal to a conversation needs a member who can see that conversation, and only a
  conversation of the deal's contact can be linked. Erased contacts get no new deals, tasks or
  notes. The contact picker in the deal form uses the contact search (`contacts.read`).
- Reports show deal counts, values, pipeline and stage names (never deal titles, notes or contacts)
  to `reports.read`, including analysts and marketers, like the other report sections.
- While a company is suspended, `crm.read` stays available and `crm.write` does not; reminder jobs
  wait, and the sweep sends reminders after reactivation unless they are more than a day late.

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
