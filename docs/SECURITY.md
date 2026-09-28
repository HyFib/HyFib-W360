# Security

Last updated 2026-09-28. This document lists implemented controls, the role/permission matrix and
security operations. It is not a compliance claim; see `docs/THREAT-MODEL.md` for open risks and
`docs/RELEASE-CHECKLIST.md` for launch gates (including an independent security review).

## Implemented controls (verified locally)

| Area               | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation   | FORCE RLS on every tenant table; transaction-local context that fails closed; runtime roles without BYPASSRLS/superuser/ownership (start-up self check); column-level grants; SECURITY DEFINER entry points with pinned `search_path`, no PUBLIC execute and explicit per-role grants; 60 integration tests incl. pool reuse, jobs and concurrency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Authentication     | Email verification required; scrypt password hashing (Better Auth); minimum 12 characters; DB-backed rate limits (sign-in 5/min, sign-up 10/h, reset 5/h, 2FA 5/min per IP); sign-up enumeration protection; sessions stored server-side without cookie cache (immediate revocation); revoke other sessions on password change/reset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| MFA                | TOTP with 10 backup codes; required for owner, administrator and billing roles after `MFA_GRACE_PERIOD_HOURS` (default 72 h); optional company-wide requirement; platform staff must have MFA.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Authorization      | Permission matrix below, enforced in domain services (server actions and pages), workers (`authorizeJob`) and PostgreSQL policies. Suspended companies lose outbound permissions. Only owners manage owners; last-owner protection is transactional.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Sessions & cookies | `w360` cookie prefix, HttpOnly, SameSite=Lax, Secure in production; session lifetime 7 days, refreshed daily; step-up: exporting or deleting the company, payment settings, the company's Razorpay keys, API keys, webhook endpoints, new owners and turning off required two-factor need a sign-in within the last 15 minutes (ADR-056; the library's `freshAge` uses the same window).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| CSRF               | SameSite cookies, Next.js server-action Origin/Host verification, and our exact trusted-origin check for every action.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Browser hardening  | Per-request nonce CSP with `strict-dynamic`, `frame-ancestors 'none'`, HSTS (preload-ready), `X-Content-Type-Options`, strict referrer policy, COOP/CORP, restrictive Permissions-Policy, `Cache-Control: private, no-store` on app pages.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Secrets            | Loaded from environment populated by the secret manager; production start-up refuses placeholder values; AES-256-GCM keyring with key ids, AAD binding and rotation support; logger redaction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Audit              | Append-only company audit log and platform audit log (privileges + trigger); security events for invalid job signatures, password resets and sign-up attempts on existing emails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Platform access    | Separate platform role without BYPASSRLS; customer data only through reasoned, scoped, ≤8 h support grants visible to the company; no impersonation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Webhooks           | Raw-body HMAC-SHA256 (`X-Hub-Signature-256`) with constant-time compare against the current and previous app secret; 4 MB cap enforced while streaming; encrypted durable receipt before 200; tenant resolved only from verified asset bindings; quarantine otherwise; rate-limited security events for bad signatures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Provider tokens    | Exchanged server-side from Embedded Signup codes, verified with `debug_token` and an ownership check, stored AES-256-GCM with AAD (company + account), never sent to browsers or logs; registration PINs encrypted the same way.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Live updates       | SSE and polling endpoints authenticate the session, resolve membership per request, re-validate every 30 s, carry ids only and filter events by conversation visibility; unauthenticated or non-member requests get 404.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Payments           | Card entry only inside Razorpay Checkout's frame; the Checkout signature is verified against our stored order id and the payment is then fetched from Razorpay; only captured payments credit, exactly once, through SECURITY DEFINER functions; runtime roles cannot write ledger rows or balances; webhooks verified over the raw body (current + previous secret) and stored before 200; only card network, issuer, last four digits and expiry stored (no PAN/CVV); billing actions limited to owner and billing roles (MFA-required roles) and audited; adding a card and turning automatic top-ups on or changing them need a sign-in within the last 15 minutes (ADR-056).                                                                                                                                                                                                                              |
| Contacts & consent | Consent is append-only (runtime role can only insert events; current state is written by a SECURITY DEFINER trigger); every template send re-checks consent and the suppression list under the send intent's row lock; erasure is one audited definer function; the status-history guard allows clearing recipient ids only inside it; CSV import caps size, rows, columns and field length and never echoes row contents; CSV export is formula-safe and audited.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Campaigns          | Audience snapshots without personal data; recipients re-checked (erasure, suppression, consent, variables, frequency cap, spending cap) when queued and again by the send worker before dispatch; pause/cancel cancel unclaimed sends atomically; one runner tick per campaign and per company; sends under a named member's authority; four-eyes approval option; formula-safe audited export; rate cards immutable once published.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Reports            | Aggregates and member names only (no message content or contact details), computed in one read-only snapshot under the company's RLS scope; reply turns written only by database triggers (runtime role cannot rewrite or delete them); metric definitions global and read-only; per-section exports need `reports.export`, are formula-safe and audited before data is returned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Automations        | Published versions are immutable (database trigger) and runs stay pinned to theirs; runs are durable rows advanced one step per transaction under the conversation and run row locks; a partial unique index allows one active run per conversation, and a member reply, template send, assignment, take-over or resolve ends it and cancels unclaimed bot sends; reply-button ids name the run, step and visit, and stale or forged ids select nothing; budgets cap steps, loops, messages, run time and runs per conversation per hour; step logs hold outcome codes and labels written by the company, never customer text; captured answers are shown only to members who can see the conversation and are cleared 30 days after the run ends or on erasure.                                                                                                                                               |
| Web requests       | Automation HTTP steps reach only company-allowed domains, over https, through one egress guard (public addresses only, DNS pinned to the checked address, no redirects, size and time limits); calls are written ahead, made once and marked unknown (never retried) when they may have been received without a result; secrets are encrypted, write-only, audited by name and sent only to the domain each was saved for; customer text in headers is never read as a placeholder.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Growth tools       | The public short link (`/l/<slug>`) and widget script (`/widget/<id>.js`) take only a random identifier and reach data through two SECURITY DEFINER functions that return what the response needs; the redirect is rebuilt from the stored link (wa.me and the company's own number only, never an open redirect) with no referrer and no caching; clicks are counted per link and day with nothing about the visitor; the widget sets no cookies, stores and sends nothing and draws text only; ad referrals keep the ad's id, type, http(s) address and headline, never the ad click id.                                                                                                                                                                                                                                                                                                                     |
| WhatsApp Flows     | Everything at Meta goes through written-ahead operations performed by the worker with the stored token; publishing and key replacement need `flows.publish`; the data endpoint checks Meta's signature, finds the flow by a random public id, decrypts with that WhatsApp account's own keys (private keys are keyring ciphertexts bound to their row, deleted 24 hours after replacement), accepts only flow tokens HyFib issued for that flow (30 days, ended by erasure), and forwards to the company's endpoint on an allowed domain through the egress guard, with its secret only for that host; answers are shown only with `contacts.read` and deleted by erasure.                                                                                                                                                                                                                                     |
| Commerce           | Catalogs are only read from Meta by the worker; orders come only from signed Meta webhooks with prices converted to minor units exactly; Payment Links use the company's own Razorpay keys (keyring ciphertexts bound to their row, write-only, live keys only in production), are written ahead and created once per single-use reference, and a payment is recorded only from the link as fetched from Razorpay, never from a browser or a webhook body; the merchant webhook verifies the company's own secret, deduplicates by event id and only signals a fetch; orders are visible only with the conversation.                                                                                                                                                                                                                                                                                           |
| Store connectors   | Companies' Shopify and WooCommerce stores are only read, by the worker, through the egress client; access (Shopify expiring tokens, WooCommerce keys) is sealed in the keyring, bound to the store row and versioned so a token refresh never overwrites access saved meanwhile; handshakes use single-use hashed tokens (Shopify: signed callback, timestamp, the member who started it; WooCommerce: Read/Write keys proven against the entered address); webhooks are verified over the raw body (Shopify with the app secret, WooCommerce with a per-store secret), deduplicated and only make the worker read from the store; Shopify's compliance and uninstall topics act only on the shop named in the signed body; redaction of store orders is sticky; order data needs `commerce.read` and `contacts.read`.                                                                                         |
| Order messages     | Sent only by the worker after a manager confirmed the store's customers opted in; never about orders from before a rule was switched on; one message per order and event (unique); every rule, consent and suppression check repeated at send time and at dispatch; cash on delivery answers accepted only from the message's own contact and thread; tracking redacted with the customer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Cart reminders     | Shopify checkouts are read by the worker only while a cart reminder is on, and only those updated since it was switched on; `read_customers` is asked for only when a manager allows customer access, and the exchanged token replaces the old one only for the credentials version read (a grant without the connector's own scopes fails the store); only approved marketing templates, to customers with marketing opt-in, within the frequency cap (counted under the campaign runner's lock); at most one reminder per checkout and kind (unique); never after the checkout was completed, after an order with the number, or three days after it was left; store consent is imported only after a manager with `contacts.write` turns it on, never for suppressed numbers; checkouts are redacted for good and deleted after 30 days.                                                                    |
| Store automations  | An order rule starts an automation only after every order message check, and only an active automation whose live version starts from order messages (never from customer messages), in a conversation nobody is assigned to and no run holds, at most one run per store message; template steps check the template, its variables and quick replies, the number, consent and the marketing frequency cap again when they run (the cap under the campaign runner's lock, only tried by the runner), and the send worker checks template and consent again at dispatch; until the customer replies only templates can be sent (refused at publish); quick-reply payloads name the run, step and visit; runs keep a reference to their order, not a copy, shown only with `commerce.read`.                                                                                                                       |
| Plans              | Plan state is written only by SQL functions (company creation, the time sweep in the company's own scope) and platform staff (column grants, a version check, both audit logs); companies can only read theirs (RLS). Published plan versions never change (trigger). Limits are checked by the services under a per-company advisory lock, seats also in `app.accept_invitation`, and automation runs through an atomic counter that never passes the limit; plan modules remove write permissions and stop worker actions. Platform staff see a company's usage as counts only.                                                                                                                                                                                                                                                                                                                              |
| Public API         | Company API keys store only the token's SHA-256, which the runtime role cannot read (column grants); keys are found through a SECURITY DEFINER function that refuses revoked and expired keys and companies being deleted. Scopes are granted only by members holding the matching permission; a request acts in its key's company scope as the key (audit actor `api_key`), never from a company id in the request; writing scopes stop while the company is suspended or restricted. Template sends apply the members' checks and are re-checked before dispatch; an `Idempotency-Key` stored in the request's transaction replays the first response instead of sending twice. Per-key, per-company and per-address (failed authentication) rate limits, 64 KB bodies, no tokens in logs, `no-store` responses; keys expire, rotate with an overlap of up to 72 hours and are revoked at once, all audited. |
| Outgoing webhooks  | Endpoints are managed with `developer.manage` (at most 10, checked by the egress guard's URL rules); events are captured by triggers in the company's own scope and hold ids and non-personal facts only, and payloads are built when delivered, so an erased contact is sent without personal data. Requests go only through the egress guard (public addresses only, DNS pinned, no redirects, 10 s, 64 KB), signed with HMAC-SHA256 over the timestamp and body with a per-endpoint secret shown once and stored encrypted (bound to company, endpoint and version); the worker never takes a company id from a notification. Bounded retries, at-least-once delivery with a stable event id, automatic disabling after 72 hours of failures with an email, 30-day retention; audit entries name only the host.                                                                                             |
| Operations console | Platform staff see counts, states, error codes, labels and times only, through four SECURITY DEFINER functions that refuse anyone but a platform administrator and read named columns; URLs are cut to their host inside the database; dead letters keep an error's name and code, never its message, and name a company only when the job's signature verifies; retrying a receipt and resolving a quarantine entry need a reason and are written to the platform audit log.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Company data       | Owners only (`tenant.export`, `tenant.delete`, re-checked in SQL for deletion). The export streams listed columns from one read-only transaction in the company's scope (credentials, secrets, token hashes, PIN and Flow tokens never exported; catalog tests fail on unclassified tables or columns), is not stored, runs once at a time and is audited and emailed before it starts. Deletion needs the company address typed, waits 14 days (cancellable, emails to owners and administrators), then runs as a signed worker job through SECURITY DEFINER functions whose delete policies match only the company being deleted; providers are cleaned up once; billing records, plan history and platform evidence are kept (ADR-055).                                                                                                                                                                     |
| Billing history    | Statements and receipts need `billing.read` and are computed from the append-only ledger in the company's scope (RLS), in one read-only snapshot; statement CSVs are audited (`billing.statement_exported`) and formula-safe; receipts show Razorpay references and the payment method Razorpay reported, never card numbers, and say they are not tax invoices; the method is written only by a definer function, once, for the payment that credited the top-up (ADR-057).                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Usage and rates    | Billing → Usage and rates needs `billing.read`, re-checked by the service. It reads published rate cards (platform data) and the company's own delivered-message counts by pricing category in the company's scope (RLS), in one read-only snapshot; it shows no message, number, contact or market breakdown, stores nothing and never posts to the ledger (ADR-060).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Credit refunds     | Platform owners only (checked in SQL: `ops.platform_request_credit_refund` looks the user up in `ops.platform_admins`), with a reason in the platform audit log; at most the unrefunded amount and the unused credit (under the wallet's row lock), one open refund per top-up, none for a company being deleted. The credit is held at once; only `app.billing_record_refund` (a refund Razorpay reports, fetched first) and `app.billing_fail_credit_refund` settle the request and its hold, and the company role cannot move a request to either state (restrictive policy) or read the reason (column grants). Razorpay is called by the worker with an idempotency key, the same body every time (ADR-058).                                                                                                                                                                                              |
| Reconciliation     | The worker reads Razorpay's settlement report and writes runs and items only through SECURITY DEFINER functions that check the run's current attempt; neither runtime role can read or write the tables. Companies are found through HyFib's own provider-id mappings; a missed payment or refund is recorded only after fetching it from Razorpay, through the functions its webhook uses (credit exactly once, refunds keyed by id). Platform staff read through functions that check `ops.platform_admins`; only platform owners run a day or resolve an item, with a reason or note in the platform audit log. Items keep ids and amounts, never notes, descriptions, receipts or card fields (ADR-059).                                                                                                                                                                                                   |
| Templates          | Created, deleted and listed only by the worker with the stored WABA token (never in the browser); webhooks for templates are signals routed through verified WABA bindings and never change status on their own; submission is write-ahead so a lost response cannot create a duplicate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Supply chain       | Exact pins + lockfile, pnpm minimum release age, explicit install-script allowlist, `pnpm audit` and gitleaks in CI, GitHub Actions pinned by SHA, Trivy image scanning, Dependabot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Permission matrix

Generated from `packages/domain/src/authz/permissions.ts` with `pnpm tsx scripts/permission-matrix.ts`.
Members can hold several roles; effective permissions are the union, minus the write permissions of
modules the company's plan leaves out (`automations.write`, `automations.publish`, `flows.write`,
`flows.publish`, `crm.write`, `commerce.manage`; ADR-051), minus permissions blocked while the
company is suspended, restricted (its plan expired or was canceled) or pending deletion (the same
"allowed while suspended" column) or while required MFA is overdue (only `tenant.read` and
`members.read` remain).

| Permission               | owner | admin | supervisor | agent | marketer | analyst | billing | Allowed while suspended |
| ------------------------ | :---: | :---: | :--------: | :---: | :------: | :-----: | :-----: | :---------------------: |
| `tenant.read`            |   ✓   |   ✓   |     ✓      |   ✓   |    ✓     |    ✓    |    ✓    |            ✓            |
| `tenant.settings.manage` |   ✓   |   ✓   |            |       |          |         |         |                         |
| `tenant.security.manage` |   ✓   |   ✓   |            |       |          |         |         |                         |
| `tenant.export`          |   ✓   |       |            |       |          |         |         |            ✓            |
| `tenant.delete`          |   ✓   |       |            |       |          |         |         |            ✓            |
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
  (platform audit log). The app role reads published and withdrawn cards; estimates and Billing →
  Usage and rates use published cards only.
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
  contact's WhatsApp number when queued (a template step checks its template and the contact's
  consent instead of the window, P4-06e). Live runs send as the company's automation (no member
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

Phase 4 rules (Store connectors, P4-06b):

- The stores list and a store's status need `commerce.read`; store orders, an order page, products
  and the "Store orders" panel also need `contacts.read` (they carry customers' names, numbers and
  emails), and the panel needs the conversation to be visible. Connecting, the calling code setting,
  "read now", removal and answering data requests need `commerce.manage` (owners and
  administrators). Changes are audited (`commerce.store_connect_started`,
  `commerce.store_connect_approved`, `commerce.store_keys_received`, `commerce.store_keys_saved`,
  `commerce.store_settings_saved`, `commerce.store_sync_requested`,
  `commerce.store_remove_requested`, `commerce.store_removed`, `commerce.store_failed`,
  `commerce.store_uninstalled`, `commerce.store_customer_redacted`,
  `commerce.store_data_requested`, `commerce.store_data_request_answered`,
  `commerce.store_redacted`), never with tokens, keys or customer details.
- Shopify: the app asks only for `read_orders,read_products`. The state is 32 random bytes, stored
  as a SHA-256 hash, single-use, valid 15 minutes and bound to the member who started it; the
  callback is refused unless its HMAC (current or previous app secret), timestamp (±90 s), shop
  name and waiting handshake all check out, and then only the same signed-in member, re-checked in
  that company with `commerce.manage`, can finish it. The code and tokens never reach the browser.
  A shop is connected to one company at a time.
- WooCommerce: the key handover route accepts JSON from the store without a session, only for a
  waiting handshake (by its single-use id) and only Read/Write keys; any other answer makes
  WooCommerce delete the keys. The keys are used only after they work against the address the
  member entered; they travel in the Authorization header over https only (http:// only with
  loopback egress, local and test), never in URLs, logs or the browser. Pasted keys are write-only.
- Access is sealed in the keyring (`commerce-store:<company>:<store>:credentials`, webhook secrets
  `…:webhook`), used only by the worker and the webhook route, and dropped on uninstall and removal.
- Webhooks: Shopify deliveries (`/api/webhooks/shopify`, 256 KB) are verified with the app secret
  (current and previous), WooCommerce deliveries (`/api/webhooks/woocommerce/<address id>`, 1 MB;
  the address id is 80 random bits) with that store's own secret; bad signatures get 401 and a
  rate-limited security event. Only WooCommerce's unsigned creation ping is answered without a
  signature, and it changes nothing. Bodies are not stored and never become data: a delivery only
  marks a deletion or makes the worker read the item from the store. `app/uninstalled` and the
  compliance topics act only on the shop named in the signed body, not the header.
- Privacy: Shopify's `customers/redact` and contact erasure remove customers' details from store
  orders for good (a later read keeps them empty); data requests show the customer's details to
  managers only until answered; `shop/redact` deletes an uninstalled store's copy. Customer numbers
  are linked to contacts only when they are E.164 or the company set a calling code.
- While a company is suspended, store jobs are dropped and the sweep skips its stores; webhooks are
  still verified and recorded, and the reads they asked for run after reactivation.

Phase 4 rules (Order messages, P4-06c):

- A store's Messages page needs `commerce.read`; customer names in its report and an order's messages
  also need `contacts.read`. Changing the settings or a rule needs `commerce.manage`, and choosing a
  marketing template also `campaigns.send`, as sending one by hand does. Changes are audited
  (`commerce.store_message_settings_saved`, `commerce.store_message_rule_saved`, with the event,
  template, number and delay, never customer details).
- No rule can be switched on until a manager confirms that the store's customers agreed to WhatsApp
  messages from the business (Meta's opt-in rule, research M-175); the confirmation records who and
  when, and withdrawing it switches every rule off. A rule applies only to what happens from the
  second it is switched on, so connecting a store or switching a rule on never messages customers
  about past orders.
- Messages are sent only by the worker, with no member as sender. Every check is made again at send
  time under the store message's row lock (store, opt-in, rule, sending hours, order, number,
  template, WhatsApp number, variables, suppression before any contact is created, then erasure,
  opt-out and marketing opt-in), and the send pipeline checks consent once more at dispatch. At most
  one message per order and event can exist (a unique constraint), whatever webhooks and reads repeat.
- Cash on delivery answers come only from the message's quick-reply payloads and count only from its
  own contact and conversation (and the message the reply names); a payload naming another message
  is ignored. A tap is never a consent keyword; HyFib never changes the order in the store.
- Tracking numbers and links are removed with the customer's details (erasure, `customers/redact`)
  and stay removed on later reads (a constraint enforces it). Store messages keep ids, times, states
  and the answer only.
- While a company is suspended, its store messages wait (the sweep skips it and jobs are dropped);
  they are checked again, including their lateness at detection, when it is reactivated.

Phase 4 rules (Cart reminders, P4-06d):

- Cart rules follow the order message permissions and need an approved marketing template (so
  `campaigns.send`) and the store's opt-in confirmation. Allowing customer access needs
  `commerce.manage`; the store consent setting also needs `contacts.write`, because it writes
  consent records for the company's contacts. Changes are audited
  (`commerce.store_message_rule_saved`, `commerce.store_consent_saved`,
  `commerce.store_customer_access_requested`, `commerce.store_customer_access_approved`,
  `commerce.store_access_updated`), never with customer details.
- Least privilege at Shopify: HyFib asks for `read_customers` only after a manager allows customer
  access for that store. The new authorization has the connection's checks (HMAC with the app
  secret, timestamp, shop, a single-use state bound to the member who started it). Its code is
  sealed in the keyring bound to the store row. Shopify keeps one current token per store (SH-007),
  so the worker stores the exchanged token, only for the credentials version it read: without
  `read_customers` the store keeps working without customer access, and without the connector's
  own scopes it fails and must be connected again. A code Shopify refuses leaves the current token.
- Checkouts are read only while a cart reminder is on, and only those updated since it was switched
  on; the customer's default phone and consent are asked for only while the store consent setting is
  on. A checkout copy keeps the number, the name, the total, up to ten item titles, the recovery
  address (https only) and Shopify's consent state, with no email or address. Copies are deleted 30
  days after their last update. Contact erasure and `customers/redact` (by number or Shopify
  customer id) redact them for good (a constraint enforces it), and reminders still waiting about
  them are not sent.
- Reminders are sent only by the worker. At send time, under the row lock, every order message check
  runs again plus the cart checks (checkout completed, an order with the number, three days, the
  first reminder sent, a marketing template), and the company's marketing frequency cap is counted
  under the campaign runner's company lock, so the two never pass the cap together. At most one
  reminder per checkout and kind can exist (a unique constraint).
- Store consent: Shopify's `SUBSCRIBED` and `UNSUBSCRIBED` states with their update time become
  consent events (source `store`, actor the shop); the same state is never recorded twice (a unique
  index), a number on the suppression list never becomes a contact, and other states change nothing.
  The newest consent from any source counts, so a customer's later STOP wins over Shopify's opt-in.
  HyFib never writes consent to Shopify.
- The recovery report counts HyFib's own records only (reminders handed to WhatsApp and not failed,
  checkouts Shopify reports completed after one of them); it is not revenue attribution.

Phase 4 rules (Store events in automations, P4-06e):

- Choosing an automation on an order rule needs `commerce.manage` and `automations.read`, plus
  `campaigns.send` when the automation's live version sends a marketing template; the automation
  must exist in the company (RLS), be active, start from order messages and allow the rule's
  number, and its templates must belong to that number's WhatsApp account. Publishing or testing an
  automation that sends marketing templates needs `campaigns.send`, as choosing one for a rule or
  a template send does. Rule changes are audited (`commerce.store_message_rule_saved` with the
  action and automation).
- An automation with the order messages trigger never starts from a customer message. A rule starts
  it only after the order message checks, and only for a number that is not suppressed and a
  contact who is not erased or opted out, in a conversation that is not assigned and has no active
  run, within 10 runs per conversation per hour. The run and the store message's state are written
  in one transaction under the store message's row lock, so a repeated job starts nothing more.
- WhatsApp allows only templates until the customer replies: the builder refuses a message or
  question any path reaches before a reply in such an automation, and the send worker's window check
  still stops a session message that gets through. Each template step checks, when it runs, that the
  template is approved and still utility or marketing, with the variables and quick-reply buttons
  the step expects, on an active number of the template's account; the contact's consent for the
  category; and, for marketing, the frequency cap under the campaign runner's company lock. The
  runner holds the conversation's lock, so it only tries that lock and tries the step again later
  when it is busy (never waiting, which could deadlock with the campaign runner). The send worker
  checks the template and consent again at dispatch. A variable left empty sends nothing.
- A quick-reply payload names the run, the step and the visit, and a tap counts only for that step
  and visit of that run; the run itself is bound to its conversation, so a tap from another
  conversation never reaches it. A tap from an older visit or another step selects nothing.
- A run keeps its order's id, not a copy, and reads the order when a step runs; the order page,
  report and run page show the order only with `commerce.read`, and runs only with
  `automations.read`. Testing with an order needs `commerce.read` and `contacts.read`, as seeing
  store orders does, because its steps send the customer's details to the tester's conversation.
  An order deleted with its store clears the reference; a redacted order has no values.

Phase 5 rules (Public API, P5-08):

- Members with `developer.manage` (owners and administrators) create, rotate and revoke the
  company's API keys; a key belongs to the company, not to its author. Each scope needs the
  permission a member needs for the same work: `templates.read`, `contacts.read`, `contacts.write`,
  `inbox.reply` for `messages.send` (utility templates) and `campaigns.send` for
  `messages.send_marketing`. Nobody grants a key more than they hold, and rotating needs the same.
- A request acts for the key's company only, as the key: its company comes from the key found by
  the token's hash, never from the path, body or headers, and data access runs in that company's
  scope (RLS). Audit rows name the key (`api_key`). Writing scopes are refused while the company is
  suspended or restricted.
- Template sends through the API apply the members' template-send checks (approval, category scope,
  consent, suppression, erasure, the marketing frequency cap) and are checked again before dispatch.
  The API can read the status only of messages sent through the API.
- Only the token's SHA-256 is stored; the runtime role cannot read it. The token is shown once in
  the browser and kept only in the page's memory; it is never logged, and audit entries carry the
  public prefix only.

Phase 5 rules (outgoing webhooks, P5-09):

- Members with `developer.manage` (owners and administrators) add, edit, turn off, delete and test
  the company's webhook endpoints, rotate their secrets and replay deliveries. Every change is
  audited with the endpoint's host only; the full URL (which may carry a receiver's token) and the
  secret are never logged.
- An endpoint's URL must pass the egress guard's rules when saved (https, no credentials, port 443
  or from 1024) and every request goes through the egress guard: private, loopback, link-local,
  metadata and reserved addresses are refused after DNS resolution, the connection is pinned to the
  checked address and redirects are never followed.
- Events are written by triggers running as the role that made the change, in the company's scope,
  so row security keeps each event in its row's company. The worker's wake-up notification carries
  nothing; companies with due deliveries are read from the database (SECURITY DEFINER), and each
  job acts in its signed company's scope.
- Payloads are built when delivered from the company's current data: they carry the contact's
  number and name, the message's text or reply and template names, never media, and nothing of a
  contact erased before delivery. Receivers are told to deduplicate on the event id and to reject
  signatures older than 5 minutes.
- Secrets (`whsec_` + 32 random bytes) are shown once, kept only in the page's memory, and stored
  encrypted with the AAD `webhook-secret:<company>:<endpoint>:<version>`.

Phase 5 rules (billing history, P5-07, ADR-057):

- Statements, their CSVs and payment receipts need `billing.read` (owners, administrators and the
  billing role). Everything is read in the company's scope under row security; a receipt for
  another company's top-up is "not found". CSV downloads are audited before any data is returned.
- Runtime code cannot change a paid top-up. The payment method on a receipt is written only by
  `app.billing_record_payment_method`, which sets it once, and only when the same payment id
  credited the top-up. A new top-up cannot carry a method (insert policy). Card numbers are never
  stored or shown; an automatic top-up's receipt names the saved card by network and last four
  digits only.
- Receipts confirm payments for prepaid service credit and say they are not tax invoices. Tax
  invoices and GST documents are not issued until tax review (RELEASE-CHECKLIST).

Phase 5 rules (usage and rates, P5-07, ADR-060):

- Billing → Usage and rates needs `billing.read` (owners, administrators and the billing role),
  checked by the page and again by the service. Billing managers see this month's counts of
  delivered, billable, free and not-yet-priced messages and the estimate by pricing category; the
  breakdown by market and day, campaign and member reports and CSV exports stay behind
  `reports.read` and `reports.export`.
- The billing currency is read from the company's own messaging settings, and messages from its own
  rows, under row security in one read-only transaction. Nothing is written: no ledger posting and
  no hold on service credit, because Meta bills the company directly (ADR-011).

Phase 5 rules (staff refunds of unused credit, P5-05, ADR-058):

- Only platform owners start a refund, and the database checks it: the definer function
  `ops.platform_request_credit_refund` is executable only by the platform role and looks the
  session's user up in `ops.platform_admins`. The role in the web session is not trusted. Every
  request writes the platform audit log with its reason, in the same transaction.
- A refund never takes spent credit or more than the payment: the amount is at most the top-up's
  unrefunded amount and the available credit, checked under the wallet account's row lock, with one
  open refund per top-up (a partial unique index). The credit is held at once, so it cannot be spent
  while Razorpay processes the refund.
- The refund is recorded only from what Razorpay reports, fetched first (`refund.processed` or the
  worker's check); the posting and the release of the hold happen in one definer function, keyed by
  the refund id, so the credit is taken once. A refusal or failed refund releases the hold. The
  company role can read its requests (not the reason or who asked) and cannot mark one processed or
  failed (restrictive policy).
- Razorpay is called only by the worker, with `X-Refund-Idempotency: crf_<request id>` and the same
  body on every try; an uncertain outcome is retried, never failed, so a refund Razorpay may pay is
  never released back to spendable credit.
- A company pending deletion gets no new refund, and its deletion waits for refunds in progress.

Phase 5 rules (daily settlement reconciliation, P5-05, ADR-059):

- The settlement report is used only to look HyFib's own records up by provider id; a company is
  never taken from it. What the reconciliation records by itself (a captured payment HyFib had not
  credited, a processed refund it had not recorded) is fetched from Razorpay first and goes through
  `app.billing_credit_topup` and `app.billing_record_refund`, keyed as their webhooks are, so nothing
  is recorded twice. Everything else (amounts that differ, second payments, adjustments, disputes,
  transactions that are not HyFib's) changes nothing and waits for a person.
- The runtime roles have no privileges on `ops.settlement_recon_runs` or `ops.settlement_recon_items`.
  The worker writes through SECURITY DEFINER functions that refuse a stale attempt (the attempt
  number of the current lease); platform staff read through functions that check `ops.platform_admins`,
  and only platform owners run a day or resolve an item, audited with the reason or note.
- Items keep transaction ids, amounts, fees, settlement ids and HyFib's match. Notes, descriptions,
  order receipts and card fields, which can carry another integration's customer data, are not read.

Platform roles (`ops.platform_admins`): `platform_owner` and `platform_operator`. Both require MFA;
all actions are audited; neither can read customer content without a support grant. Both see a
company's service credit (balances, paid top-ups, refunds) and the settlement reconciliation, which
are payment data about HyFib's own charges; only platform owners refund unused credit (ADR-058) and
run or resolve reconciliations (ADR-059). Only platform
owners change the plan catalog (create, edit and publish versions, retire them, choose the default
trial); owners and operators put companies on plans and end them, with a reason shown in the
company's audit log. Reactivating a suspended company whose plan has lapsed makes it restricted, and
only a plan change lifts a restriction.

The operations console (`/platform/ops`, ADR-054) is open to both platform roles and shows no
message text, contact details, payloads, email addresses, secrets or full URLs:

- Company facts come from `ops.platform_ops_health`, `ops.platform_ops_activity`,
  `ops.platform_ops_signup_sessions` and `ops.platform_ops_integration_failures`: owned by
  `w360_definer`, executable only by `w360_platform`, raising `W3403` unless the session's user is
  in `ops.platform_admins`. The definer role has column grants for the columns they read (no message
  text, contact, token, secret or payload column) and a read policy on signup sessions.
- Labels are a display number, an account name or a host (`ops.url_host`, executable only by the
  definer role): store and endpoint URLs can carry tokens in their paths or queries.
- Errors are the provider's answer as HyFib already stored it for the company's own pages. Emails
  and security events are counted by kind, because SMTP errors and event details can quote
  addresses. Quarantine entries show allow-listed provider ids only (account, number, field,
  payment and order ids).
- Dead letters (`ops.dead_letters`): the worker role may only insert; the platform role reads; the
  definer purges after 30 days. A job's company, kind and reference are recorded only when its
  envelope signature verifies, so a forged job cannot attribute a failure to a company.
- Repairs: retrying a Meta or Razorpay receipt (`ops.platform_retry_webhook_receipt`, only from
  `failed` or `quarantined`, only while its body is kept) and resolving a quarantine entry each
  need a written reason and write `ops.platform_audit_events` in the same transaction. Neither
  reads or changes company data.

Company export and deletion (Settings → Company data, ADR-055):

- `tenant.export` and `tenant.delete` are owners' only (administrators hold neither) and stay
  available while the company is suspended, restricted or pending deletion: leaving, and taking
  the data along, must not depend on paying. `app.request_tenant_deletion` and
  `app.cancel_tenant_deletion` check again that the caller is an active owner.
- The export reads as the runtime role in the company's scope, so row security and column grants
  apply; the tests check that the runtime role can read every exported column and that the export
  spec classifies every table and column.
- The deletion functions (`ops.start_tenant_deletion`, `ops.record_tenant_deletion_cleanup`,
  `ops.delete_tenant_data`, `ops.finish_tenant_deletion`, `ops.tenant_deletions_due`) are owned by
  `w360_definer` and executable only by `w360_app`. The definer holds, on each deletable table,
  `SELECT (tenant_id, id)` and `DELETE` with policies matching `ops.deleting_tenant_id()`, which the
  functions set only while they run and only to a company with a started, due deletion; the helper
  is executable by the definer only. The functions also set the retention-purge and erasure flags
  for the deletes, so guard triggers let them through only there.
- Provider outcomes are stored as kind, label (an account name and id, a shop domain, a store host
  or a card's network and last four digits), outcome and a short code; no token, response body or
  address.

## Secret and key rotation

| Secret                                      | Rotation procedure                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `W360_ENCRYPTION_KEYS`                      | Add a new key id, make it primary (`W360_ENCRYPTION_PRIMARY_KEY_ID`), deploy. New values use the new key at once; existing ciphertexts (provider tokens, HTTP secrets, flow private keys, companies' Razorpay secrets, stored webhook bodies) need the re-encryption job, which is not built yet (SEC-10). Remove the old key only after `Keyring.needsRotation` finds no rows.                                                                                      |
| `W360_JOB_SIGNING_KEY`                      | Drain queues or deploy dual-key verification first (backlog item SEC-4); then rotate. Invalid-signature jobs are dropped and logged.                                                                                                                                                                                                                                                                                                                                 |
| `BETTER_AUTH_SECRET`                        | Rotating signs everyone out and invalidates encrypted TOTP secrets; plan with the library's multi-secret support (`secrets` option) before production.                                                                                                                                                                                                                                                                                                               |
| Database role passwords                     | Rotate in the secret manager and PostgreSQL (`ALTER ROLE … PASSWORD`), rolling restart.                                                                                                                                                                                                                                                                                                                                                                              |
| Provider secrets (Meta, Razorpay, SMTP)     | Rotate at the provider, update the secret manager, rolling restart; webhook secrets support an overlap window where the provider allows it.                                                                                                                                                                                                                                                                                                                          |
| Flow encryption keys (per WhatsApp account) | "Replace the key" on a flow page (`flows.publish`): the worker generates and uploads a new key to every number; the previous key keeps decrypting for 24 hours, then its private key is deleted.                                                                                                                                                                                                                                                                     |
| Company Razorpay keys (per company)         | "Replace keys" in Commerce → Payments (`commerce.manage`): the new key secret and webhook secret apply at once and are checked with Razorpay; change the webhook secret in Razorpay at the same time (there is no overlap window: notifications signed with the old secret are refused, and the scheduled checks still record payments).                                                                                                                             |
| `SHOPIFY_CLIENT_SECRET`                     | Rotate the client secret in HyFib's Shopify app settings; set the new one as `SHOPIFY_CLIENT_SECRET` and the old one as `SHOPIFY_CLIENT_SECRET_PREVIOUS`, rolling restart: callbacks and webhooks signed with either verify, while code exchanges and token refreshes use the new one. Remove the previous secret once Shopify signs only with the new one. How long Shopify keeps the old secret valid is not confirmed from shopify.dev (check before production). |
| Company API keys (per key)                  | Settings → API keys → Rotate (`developer.manage`): a new key with the same scopes is shown once, and the old one keeps working for the chosen overlap (up to 72 hours; none revokes it at once). Revoke a key that may have leaked instead of rotating it; its requests are refused from the next one.                                                                                                                                                               |
| Webhook signing secrets (per endpoint)      | Settings → Webhooks → Rotate secret (`developer.manage`): the new secret is shown once and every request carries a signature with it and one with the previous secret for 24 hours, so the receiver can switch without losing events. To stop a leaked secret at once, delete the endpoint and add it again.                                                                                                                                                         |
| Store access (per store)                    | Shopify access tokens expire after 60 minutes and are refreshed by the worker; to cut access at once, remove the store (HyFib uninstalls itself) or uninstall HyFib in Shopify. WooCommerce keys: connect the store again with new keys, then revoke the old key in WooCommerce → Settings → Advanced → REST API. A store's webhook secret changes only by removing the store and connecting it again (new address and secret).                                      |

## Reporting and response

Security issues: report privately to the HyFib security contact (to be published before launch).
Incident handling follows `docs/RUNBOOKS.md` (compromised tenant, credential exposure).

## Known gaps before launch

See `docs/THREAT-MODEL.md` (status P/D/A) and `docs/BACKLOG.md` (SEC-* items): WebAuthn, breached
password screening, hash-chained audit checkpoints, a network egress policy behind the egress guard
(deployment), edge rate limits for the public chat-link and widget routes, media scanning,
dual-key job signing, OpenTelemetry alerting, independent penetration test, WebAuthn as a step-up
factor, Razorpay sandbox verification of the payment flows and Checkout CSP, and for the public
API: IP allowlists per key, monthly API quotas and reminders before keys expire; for outgoing
webhooks: fixed egress addresses that receivers can allowlist, mutual TLS and ending a rotated
secret's overlap early.
