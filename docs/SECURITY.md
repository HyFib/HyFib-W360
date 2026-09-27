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
| Web requests       | Automation HTTP steps reach only company-allowed domains, over https, through one egress guard (public addresses only, DNS pinned to the checked address, no redirects, size and time limits); calls are written ahead, made once and marked unknown (never retried) when they may have been received without a result; secrets are encrypted, write-only, audited by name and sent only to the domain each was saved for; customer text in headers is never read as a placeholder.                                                                                                                                                                                                                                                                              |
| Growth tools       | The public short link (`/l/<slug>`) and widget script (`/widget/<id>.js`) take only a random identifier and reach data through two SECURITY DEFINER functions that return what the response needs; the redirect is rebuilt from the stored link (wa.me and the company's own number only, never an open redirect) with no referrer and no caching; clicks are counted per link and day with nothing about the visitor; the widget sets no cookies, stores and sends nothing and draws text only; ad referrals keep the ad's id, type, http(s) address and headline, never the ad click id.                                                                                                                                                                       |
| WhatsApp Flows     | Everything at Meta goes through written-ahead operations performed by the worker with the stored token; publishing and key replacement need `flows.publish`; the data endpoint checks Meta's signature, finds the flow by a random public id, decrypts with that WhatsApp account's own keys (private keys are keyring ciphertexts bound to their row, deleted 24 hours after replacement), accepts only flow tokens HyFib issued for that flow (30 days, ended by erasure), and forwards to the company's endpoint on an allowed domain through the egress guard, with its secret only for that host; answers are shown only with `contacts.read` and deleted by erasure.                                                                                       |
| Commerce           | Catalogs are only read from Meta by the worker; orders come only from signed Meta webhooks with prices converted to minor units exactly; Payment Links use the company's own Razorpay keys (keyring ciphertexts bound to their row, write-only, live keys only in production), are written ahead and created once per single-use reference, and a payment is recorded only from the link as fetched from Razorpay, never from a browser or a webhook body; the merchant webhook verifies the company's own secret, deduplicates by event id and only signals a fetch; orders are visible only with the conversation.                                                                                                                                             |
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

Phase 4 rules (automation web requests, P4-02):

- Settings → Web requests (allowed domains and secrets) is readable with `automations.read` or
  `integrations.read`; adding and removing domains and saving, replacing and deleting secrets need
  `integrations.manage` and are audited (`http.domain_added`, `http.domain_removed`,
  `http.secret_created`, `http.secret_updated`, `http.secret_deleted`, with the name and domain,
  never a value). At most 50 domains and 50 secrets per company.
- A secret value is sent to the server once, encrypted with the keyring and bound to its row (AAD
  `http-secret:<company>:<id>`), and never returned to a browser, a log or an export; only the
  `automation.http` worker decrypts it, when it makes a request to the secret's own domain.
- Publishing refuses HTTP steps whose host is not allowed, that use a secret that does not exist or
  belongs to another domain, that use secrets outside header values, or whose host contains
  placeholders. The worker re-checks the current domain list and secrets when it makes each call
  (removing a domain or secret takes effect on the next call).
- A company that allows a server which echoes request headers back exposes its secrets to anyone
  who can edit automations; the settings page says so. Automation editors cannot choose the host at
  run time and cannot place secrets in the address or body.
- Run pages show each call's method, host, the step's path as written (placeholders not filled in,
  without the query), outcome and duration to `automations.read`; requests are stored encrypted until the call finishes and then erased; saved
  response values are shown only with the run's captured answers.
- `W360_EGRESS_ALLOW_LOOPBACK` (http:// and loopback targets for tests) is refused by the web and
  worker configuration outside `APP_ENV=local|test`.

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

Phase 4 rules (growth tools, P4-05):

- Chat links, website buttons and the ads list need `campaigns.read` (owners, administrators,
  supervisors, marketers and analysts); creating, editing, archiving and restoring links and
  creating, editing and deleting buttons need `campaigns.write` (owners, administrators, marketers)
  and are audited (`growth.link_created`, `growth.link_updated`, `growth.link_archived`,
  `growth.link_restored`, `growth.widget_created`, `growth.widget_updated`,
  `growth.widget_deleted`, with the name or button text). A link can only use an active number of
  the company, and a button only an open link of the company, so a button can only ever open the
  company's own numbers.
- The public routes are unauthenticated by design. Their identifiers are random (60 bits for links,
  80 for buttons) and unique across companies; `ops.follow_chat_link` and `ops.chat_widget_config`
  are executable only by the runtime role, check the identifier's format, and return nothing for
  archived links, numbers that are not active, disabled or deleted buttons and companies being
  deleted. Counts can be inflated by anyone who requests a link; they are labelled as including
  automated visits and affect nothing but the displayed number. Rate limiting these routes at the
  edge is a deployment item (release checklist).
- Button text and greetings are placed in the script as JSON escaped for a script context and shown
  with `textContent`; ad addresses are kept only when they start with http(s) and are shown with
  `rel="noopener noreferrer nofollow"`.
- The inbox line saying where a conversation came from is shown to whoever can see the
  conversation; the link name links to the link page only for members with `campaigns.read`.
- While a company is suspended its links and buttons keep working (customers write to it) and
  `campaigns.write` is unavailable.

Phase 4 rules (WhatsApp Flows, P4-03):

- Flows need `flows.read` (owners, administrators, supervisors, marketers and analysts); creating
  and editing drafts, answer and endpoint settings, deleting drafts, refreshing, trying again,
  making a new draft from a flow, archiving, setting up keys and sending drafts to test them need
  `flows.write` (owners, administrators, marketers); publishing and deprecating (irreversible at
  Meta) and replacing a key need `flows.publish` (owners and administrators). Changes are audited
  (`flow.created`, `flow.updated`, `flow.settings_updated`, `flow.publish_requested`,
  `flow.deprecate_requested`, `flow.deleted`, `flow.archived`, `flow.restored`,
  `flow.keys_requested`, `flow.key_rotated`, with the flow's name or the WhatsApp account).
- Sending a form is a reply: `inbox.reply`, a conversation the member can see, an active number and
  an open customer service window. Answers and the names of the contacts who sent them are shown
  only to members with `contacts.read`; others see when forms were completed and what was saved.
- The data endpoint is unauthenticated except for Meta's signature (app secret, current and previous)
  and the encryption to the WhatsApp account's key; the public id only names the flow. Flow tokens
  are 256-bit random values, one per send; the endpoint accepts a token only for the flow it was
  sent with, before it expires and while the company is active, and the answers of a completion
  are applied only to the contact the token was sent to. Nothing from requests, answers or tokens
  is logged; log lines carry an outcome code and ids.
- A company endpoint must be on one of the company's allowed domains (Settings → Web requests) when
  saved and when each request is forwarded; a secret is sent as a bearer token only to the host it
  is saved for. The web tier makes these calls through the same egress guard as the worker.
- Completing a flow never records consent and never starts an automation.
- While a company is suspended, `flows.read` stays available; its forms answer "not available right
  now", flow jobs are dropped and nothing is sent to Meta. After reactivation the sweep signals
  waiting operations again; one that waited more than 30 minutes is marked failed and can be tried
  again.

Phase 4 rules (Commerce, P4-06a):

- Orders, catalogs, products and whether payment is set up need `commerce.read` (owners,
  administrators, supervisors, agents and marketers); a member sees an order only when they can see
  its conversation (the order list and page apply the inbox's visibility). Reading catalogs from
  Meta and the company's Razorpay keys need `commerce.manage` (owners and administrators); only they
  see the key id and the webhook address. Sending products, changing an order's status, requesting
  payment and cancelling a link are replies: `inbox.reply` in a conversation the member can see
  (sending also needs an active number and an open service window). Changes are audited
  (`commerce.catalog_sync_requested`, `commerce.order_status_changed`, `commerce.payment_requested`,
  `commerce.payment_link_cancel_requested`, `commerce.payment_account_saved`,
  `commerce.payment_account_removed`, with the order reference or key id, never secrets).
- The company's key secret and webhook secret are sent once, stored as keyring ciphertexts bound to
  the company and account (`commerce-payments:<company>:<account>:<key|webhook>`), never returned
  to the browser or logged, and used only by the worker (keys) and the merchant webhook route
  (webhook secret). Live keys are refused outside production. Removing the keys is refused while a
  link is open.
- Money: HyFib records a payment only when the Payment Link fetched from Razorpay with the
  company's keys reports the whole amount paid; browsers, chats and webhook bodies never change an
  order's payment status. Links are INR only, for the order's own subtotal (computed from the
  webhook's prices in minor units, and never for a cart with an item HyFib could not read), at most
  ₹50 crore, and nothing is posted to HyFib's ledger.
- The merchant webhook (`/api/webhooks/razorpay-links/<address id>`) is unauthenticated except for
  the company's signature over the raw body; the address id (80 random bits) only names the
  company. Unsigned or wrongly signed deliveries get 400 and a rate-limited security event; a
  delivery is recorded by event id (a redelivery does nothing) and only makes the worker fetch the
  link. The body is not stored; logs carry the outcome and, for signed deliveries, the event
  name.
- While a company is suspended, `commerce.read` stays available; commerce jobs are dropped (no
  catalog reads, no Payment Link calls) and nothing is sent. After reactivation the sweep signals
  due links and reads again.

Platform roles (`ops.platform_admins`): `platform_owner` and `platform_operator`. Both require MFA;
all actions are audited; neither can read customer content without a support grant.

## Secret and key rotation

| Secret                                      | Rotation procedure                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `W360_ENCRYPTION_KEYS`                      | Add a new key id, make it primary (`W360_ENCRYPTION_PRIMARY_KEY_ID`), deploy. New values use the new key at once; existing ciphertexts (provider tokens, HTTP secrets, flow private keys, companies' Razorpay secrets, stored webhook bodies) need the re-encryption job, which is not built yet (SEC-10). Remove the old key only after `Keyring.needsRotation` finds no rows. |
| `W360_JOB_SIGNING_KEY`                      | Drain queues or deploy dual-key verification first (backlog item SEC-4); then rotate. Invalid-signature jobs are dropped and logged.                                                                                                                                                                                                                                            |
| `BETTER_AUTH_SECRET`                        | Rotating signs everyone out and invalidates encrypted TOTP secrets; plan with the library's multi-secret support (`secrets` option) before production.                                                                                                                                                                                                                          |
| Database role passwords                     | Rotate in the secret manager and PostgreSQL (`ALTER ROLE … PASSWORD`), rolling restart.                                                                                                                                                                                                                                                                                         |
| Provider secrets (Meta, Razorpay, SMTP)     | Rotate at the provider, update the secret manager, rolling restart; webhook secrets support an overlap window where the provider allows it.                                                                                                                                                                                                                                     |
| Flow encryption keys (per WhatsApp account) | "Replace the key" on a flow page (`flows.publish`): the worker generates and uploads a new key to every number; the previous key keeps decrypting for 24 hours, then its private key is deleted.                                                                                                                                                                                |
| Company Razorpay keys (per company)         | "Replace keys" in Commerce → Payments (`commerce.manage`): the new key secret and webhook secret apply at once and are checked with Razorpay; change the webhook secret in Razorpay at the same time (there is no overlap window: notifications signed with the old secret are refused, and the scheduled checks still record payments).                                        |

## Reporting and response

Security issues: report privately to the HyFib security contact (to be published before launch).
Incident handling follows `docs/RUNBOOKS.md` (compromised tenant, credential exposure).

## Known gaps before launch

See `docs/THREAT-MODEL.md` (status P/D/A) and `docs/BACKLOG.md` (SEC-* items): WebAuthn, breached
password screening, hash-chained audit checkpoints, a network egress policy behind the egress guard
(deployment), edge rate limits for the public chat-link and widget routes, media scanning, dual-key job signing, OpenTelemetry alerting, independent penetration test, step-up re-authentication for payment
settings, and Razorpay sandbox verification of the payment flows and Checkout CSP.
