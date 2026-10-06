# Security

Last updated 2026-09-28. This document lists implemented controls, the role/permission matrix and
security operations. It is not a compliance claim; see `docs/THREAT-MODEL.md` for open risks and
`docs/RELEASE-CHECKLIST.md` for launch gates (including an independent security review).

## Implemented controls (verified locally)

| Area               | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation   | FORCE RLS on every tenant table; transaction-local context that fails closed; runtime roles without BYPASSRLS/superuser/ownership (start-up self check); column-level grants; SECURITY DEFINER entry points with pinned `search_path`, no PUBLIC execute and explicit per-role grants; 60 integration tests incl. pool reuse, jobs and concurrency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Authentication     | Email verification required; scrypt password hashing (Better Auth); minimum 12 characters; DB-backed rate limits (sign-in 5/min, sign-up 10/h, reset 5/h, 2FA 5/min per IP); sign-up enumeration protection; sessions stored server-side without cookie cache (immediate revocation); revoke other sessions on password change/reset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| MFA                | TOTP with 10 backup codes; required for owner, administrator and billing roles after `MFA_GRACE_PERIOD_HOURS` (default 72 h); optional company-wide requirement; platform staff must have MFA.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Authorization      | Permission matrix below, enforced in domain services (server actions and pages), workers (`authorizeJob`) and PostgreSQL policies. Suspended companies lose outbound permissions. Only owners manage owners; last-owner protection is transactional.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Sessions & cookies | `w360` cookie prefix, HttpOnly, SameSite=Lax, Secure in production; session lifetime 7 days, refreshed daily; step-up: exporting or deleting the company, payment settings, paying for the plan and cancelling its subscription, the company's Razorpay keys, API keys, webhook endpoints, new owners and turning off required two-factor need a sign-in within the last 15 minutes (ADR-056; the library's `freshAge` uses the same window).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| CSRF               | SameSite cookies, Next.js server-action Origin/Host verification, and our exact trusted-origin check for every action.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Browser hardening  | Per-request nonce CSP with `strict-dynamic`, `frame-ancestors 'none'`, HSTS (preload-ready), `X-Content-Type-Options`, strict referrer policy, COOP/CORP, restrictive Permissions-Policy, `Cache-Control: private, no-store` on app pages.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Secrets            | Loaded from environment populated by the secret manager; production start-up refuses placeholder values; AES-256-GCM keyring with key ids, AAD binding and rotation (the worker seals stored values again under a new primary key, ADR-134); logger redaction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Error logs         | A database driver's error leaves `db.run` and the platform database's `run` as a `DatabaseQueryError` with the SQLSTATE, the constraint, table and column PostgreSQL named and the frames of the failed query, and PostgreSQL's message only where its SQLSTATE's messages quote no values (not data exceptions nor syntax errors); never the query, its parameters (names, numbers, message text) or PostgreSQL's detail, which repeats keys and rows (ADR-129). Mapped and wrapping errors carry it as their cause, so logs, failed jobs' outputs, dead letters and receipts' `last_error` hold it, and every logger writes `err` through a serializer that does the same to any driver error it is given, along the causes. Better Auth, which queries on its own pool, logs through the same serializer, and its API errors and server-side calls drop the driver's error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Text input         | PostgreSQL text cannot hold the NUL character (U+0000), so input never takes it to a query: the API refuses it with 422 naming where (ADR-124); every service's `parseInput` refuses it in what a schema keeps, naming the field; CSV values are refused with their line; Better Auth's forms are refused by a hook before any endpoint (ADR-130). Provider and outside JSON (Meta, Graph, Razorpay, Shopify, WooCommerce, companies' endpoints) is parsed with the character replaced by U+FFFD, so one message or product holding it is kept instead of failing everything delivered beside it; signatures are checked on the bytes as received. jsonb is written as JSON PostgreSQL stores: half of an emoji (a lone UTF-16 surrogate, cut by a clip or sent as an escape) is written as U+FFFD, as text columns store it, and clips keep emoji whole, in inbound text and in text sent to Meta or Razorpay or shown to members (ADR-133); an inbound message's content is bounded under the 64 KB its column allows (a contact card keeps the contacts that fit, anything larger is kept as too large), and a status's errors and pricing are kept within their columns, so one message or status never fails its receipt (ADR-131).                                                                                                        |
| Audit              | Append-only company audit log and platform audit log (privileges + trigger); security events for invalid job signatures, password resets, sign-up attempts on existing emails and every completed sign-in, which each person reads back as their own sign-in history on Account & security (ADR-136).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Platform access    | Separate platform role without BYPASSRLS; customer data only through reasoned, scoped, ≤8 h support grants visible to the company; no impersonation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Webhooks           | Raw-body HMAC-SHA256 (`X-Hub-Signature-256`) with constant-time compare against the current and previous app secret; 4 MB cap enforced while streaming; encrypted durable receipt before 200; tenant resolved only from verified asset bindings; quarantine otherwise; rate-limited security events for bad signatures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Provider tokens    | Exchanged server-side from Embedded Signup codes, verified with `debug_token` and an ownership check, stored AES-256-GCM with AAD (company + account), never sent to browsers or logs; registration PINs encrypted the same way. Each connected account’s token is checked daily with `debug_token` by the same rules (at once when Meta refuses it for a send or a template sync); a token Meta no longer accepts marks the account and its numbers for reconnecting, and a check that could not be made stores only the error’s kind, code and title (ADR-137).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Live updates       | SSE and polling endpoints authenticate the session, resolve membership per request, re-validate every 30 s, carry ids only and filter events by conversation visibility; unauthenticated or non-member requests get 404.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Payments           | Card entry only inside Razorpay Checkout's frame; the Checkout signature is verified against our stored order id and the payment is then fetched from Razorpay; only captured payments credit, exactly once, through SECURITY DEFINER functions; runtime roles cannot write ledger rows or balances; webhooks verified over the raw body (current + previous secret) and stored before 200; only card network, issuer, last four digits and expiry stored (no PAN/CVV); billing actions limited to owner and billing roles (MFA-required roles) and audited; adding a card and turning automatic top-ups on or changing them need a sign-in within the last 15 minutes (ADR-056).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Contacts & consent | Consent is append-only (runtime role can only insert events; current state is written by a SECURITY DEFINER trigger); every template send re-checks consent and the suppression list under the send intent's row lock; erasure is one audited definer function; the status-history guard allows clearing recipient ids only inside it; CSV import caps size, rows, columns and field length and never echoes row contents; CSV export is formula-safe and audited.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Campaigns          | Audience snapshots without personal data; recipients re-checked (erasure, suppression, consent, variables, frequency cap, spending cap) when queued and again by the send worker before dispatch; pause/cancel cancel unclaimed sends atomically; one runner tick per campaign and per company; sends under a named member's authority; four-eyes approval option, approvers emailed when a campaign waits (ADR-204) and submitters told the outcome (ADR-205); formula-safe audited export; rate cards immutable once published.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Reports            | Aggregates and member names only (no message content or contact details), computed in one read-only snapshot under the company's RLS scope; reply turns written only by database triggers (runtime role cannot rewrite or delete them); metric definitions global and read-only; per-section exports need `reports.export`, are formula-safe and audited before data is returned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Automations        | Published versions are immutable (database trigger) and runs stay pinned to theirs; runs are durable rows advanced one step per transaction under the conversation and run row locks; a partial unique index allows one active run per conversation, and a member reply, template send, assignment, take-over or resolve ends it and cancels unclaimed bot sends; reply-button ids name the run, step and visit, and stale or forged ids select nothing; budgets cap steps, loops, messages, run time and runs per conversation per hour; step logs hold outcome codes and labels written by the company, never customer text; captured answers are shown only to members who can see the conversation and are cleared 30 days after the run ends or on erasure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Web requests       | Automation HTTP steps reach only company-allowed domains, over https, through one egress guard (public addresses only, DNS pinned to the checked address, no redirects, size and time limits); calls are written ahead, made once and marked unknown (never retried) when they may have been received without a result; secrets are encrypted, write-only, audited by name and sent only to the domain each was saved for; customer text in headers is never read as a placeholder.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Growth tools       | The public short link (`/l/<slug>`) and widget script (`/widget/<id>.js`) take only a random identifier and reach data through two SECURITY DEFINER functions that return what the response needs; the redirect is rebuilt from the stored link (wa.me and the company's own number only, never an open redirect) with no referrer and no caching; clicks are counted per link and day with nothing about the visitor; the widget sets no cookies, stores and sends nothing and draws text only; ad referrals keep the ad's id, type, http(s) address and headline, never the ad click id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| WhatsApp Flows     | Everything at Meta goes through written-ahead operations performed by the worker with the stored token; publishing and key replacement need `flows.publish`; the data endpoint checks Meta's signature, finds the flow by a random public id, decrypts with that WhatsApp account's own keys (private keys are keyring ciphertexts bound to their row, deleted 24 hours after replacement), accepts only flow tokens HyFib issued for that flow (30 days, ended by erasure), and forwards to the company's endpoint on an allowed domain through the egress guard, with its secret only for that host; answers are shown only with `contacts.read` and deleted by erasure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Commerce           | Catalogs are only read from Meta by the worker; orders come only from signed Meta webhooks with prices converted to minor units exactly; Payment Links use the company's own Razorpay keys (keyring ciphertexts bound to their row, write-only, live keys only in production), are written ahead and created once per single-use reference, and a payment is recorded only from the link as fetched from Razorpay, never from a browser or a webhook body; the merchant webhook verifies the company's own secret, deduplicates by event id and only signals a fetch; orders are visible only with the conversation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Store connectors   | Companies' Shopify and WooCommerce stores are only read, by the worker, through the egress client; access (Shopify expiring tokens, WooCommerce keys) is sealed in the keyring, bound to the store row and versioned so a token refresh never overwrites access saved meanwhile; handshakes use single-use hashed tokens (Shopify: signed callback, timestamp, the member who started it; WooCommerce: Read/Write keys proven against the entered address); webhooks are verified over the raw body (Shopify with the app secret, WooCommerce with a per-store secret), deduplicated and only make the worker read from the store; Shopify's compliance and uninstall topics act only on the shop named in the signed body; redaction of store orders is sticky; order data needs `commerce.read` and `contacts.read`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Order messages     | Sent only by the worker after a manager confirmed the store's customers opted in; never about orders from before a rule was switched on; one message per order and event (unique); every rule, consent and suppression check repeated at send time and at dispatch; cash on delivery answers accepted only from the message's own contact and thread; tracking redacted with the customer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Cart reminders     | Shopify checkouts are read by the worker only while a cart reminder is on, and only those updated since it was switched on; `read_customers` is asked for only when a manager allows customer access, and the exchanged token replaces the old one only for the credentials version read (a grant without the connector's own scopes fails the store); only approved marketing templates, to customers with marketing opt-in, within the frequency cap (counted under the campaign runner's lock); at most one reminder per checkout and kind (unique); never after the checkout was completed, after an order with the number, or three days after it was left; store consent is imported only after a manager with `contacts.write` turns it on, never for suppressed numbers; checkouts are redacted for good and deleted after 30 days.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Store automations  | An order rule starts an automation only after every order message check, and only an active automation whose live version starts from order messages (never from customer messages), in a conversation nobody is assigned to and no run holds, at most one run per store message; template steps check the template, its variables and quick replies, the number, consent and the marketing frequency cap again when they run (the cap under the campaign runner's lock, only tried by the runner), and the send worker checks template and consent again at dispatch; until the customer replies only templates can be sent (refused at publish); quick-reply payloads name the run, step and visit; runs keep a reference to their order, not a copy, shown only with `commerce.read`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Plans              | Plan state is written only by SQL functions (company creation, the time sweep in the company's own scope) and platform staff (column grants, a version check, both audit logs); companies can only read theirs (RLS). Published plan versions never change (trigger). Limits are checked by the services under a per-company advisory lock, seats also in `app.accept_invitation`, and automation runs through an atomic counter that never passes the limit; plan modules remove write permissions and stop worker actions. Platform staff see a company's usage as counts only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Public API         | Company API keys store only the token's SHA-256, which the runtime role cannot read (column grants); keys are found through a SECURITY DEFINER function that refuses revoked and expired keys and companies being deleted. Scopes are granted only by members holding the matching permission; a request acts in its key's company scope as the key (audit actor `api_key`), never from a company id in the request; writing scopes stop while the company is suspended or restricted. Template sends apply the members' checks and are re-checked before dispatch; an `Idempotency-Key` stored in the request's transaction replays the first response instead of sending twice. Per-key, per-company and per-address (failed authentication) rate limits, 64 KB bodies, no tokens in logs, `no-store` responses; keys expire, rotate with an overlap of up to 72 hours and are revoked at once, all audited. A week before a key expires, the company's owners and administrators are emailed once with its name and prefix, never a token (ADR-067).                                                                                                                                                                                                                                                                                         |
| Outgoing webhooks  | Endpoints are managed with `developer.manage` (at most 10, checked by the egress guard's URL rules); events are captured by triggers in the company's own scope and hold ids and non-personal facts only (but for the tags a contact change added or removed, which erasure clears, ADR-182), and payloads are built when delivered, so an erased contact is sent without personal data. Contact events (ADR-074) carry the API's contact; erasing sends only `contact.erased`, with the id, source and creation time, and drops what its own transaction captured; conversation events name no members or teams. Run events (ADR-078) cover live runs only and carry no answers or inputs; order events (ADR-085) carry no Payment Link or payment details; campaign events (ADR-087) carry counts, never recipients or members. Requests go only through the egress guard (public addresses only, DNS pinned, no redirects, 10 s, 64 KB), signed with HMAC-SHA256 over the timestamp and body with a per-endpoint secret shown once and stored encrypted (bound to company, endpoint and version); the worker never takes a company id from a notification. Bounded retries, at-least-once delivery with a stable event id, automatic disabling after 72 hours of failures with an email, 30-day retention; audit entries name only the host. |
| Operations console | Platform staff see counts, states, error codes, labels and times only, through four SECURITY DEFINER functions that refuse anyone but a platform administrator and read named columns; URLs are cut to their host inside the database; dead letters keep an error's name and code, never its message, and name a company only when the job's signature verifies; retrying a receipt or a dead letter's job and resolving a quarantine entry need a reason, and acknowledging a failing integration a note; each is written to the platform audit log; a job goes back to its queue once, never for an unverified envelope or a company being deleted, and the definer reads and writes only a job's id, name, state, retry limit and completion time. Usage shows each company's API request counter, the plan's, read by the platform role under 0023's policy: a company, a period and a count only (ADR-153). Its lists' CSV exports are formula-safe, refused to anyone but a platform administrator before any read, written to the platform audit log (the list, how many rows, the window) in the transaction that reads them before the file is returned, and leave out who acknowledged or retried and the notes (ADR-154, ADR-155, ADR-158).                                                                                          |
| Company data       | Owners only (`tenant.export`, `tenant.delete`, re-checked in SQL for deletion). The export streams listed columns from one read-only transaction in the company's scope (credentials, secrets, token hashes, PIN and Flow tokens never exported; catalog tests fail on unclassified tables or columns), is not stored, runs once at a time and is audited and emailed before it starts. Deletion needs the company address typed, waits 14 days (cancellable, emails to owners and administrators), then runs as a signed worker job through SECURITY DEFINER functions whose delete policies match only the company being deleted; providers are cleaned up once; billing records, plan history and platform evidence are kept (ADR-055). Platform owners can also schedule a deletion (the address typed, a reason the company reads, the same 14 days and job); only platform owners cancel it, and staff cannot cancel an owner's (ADR-090).                                                                                                                                                                                                                                                                                                                                                                                                |
| Billing history    | Statements and receipts need `billing.read` and are computed from the append-only ledger in the company's scope (RLS), in one read-only snapshot; statement CSVs are audited (`billing.statement_exported`) and formula-safe; receipts show Razorpay references and the payment method Razorpay reported, never card numbers, and say they are not tax invoices; the method is written only by a definer function, once, for the payment that credited the top-up (ADR-057).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Usage and rates    | Billing → Usage and rates needs `billing.read`, re-checked by the service. It reads published rate cards (platform data) and the company's own delivered-message counts by pricing category in the company's scope (RLS), in one read-only snapshot; it shows no message, number, contact or market breakdown, stores nothing and never posts to the ledger (ADR-060). A week before a card for the company's currency takes effect, its owners and billing managers are emailed once; the sweep's definer function returns ids only, and each notice is checked and recorded in the company's scope (ADR-065).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Plan payments      | Starting and cancelling need `billing.manage` and a recent sign-in, one start at a time per company. HyFib records its subscription before calling Razorpay and follows it only as Razorpay reports it when asked: Checkout's signature is checked against the stored subscription id and only prompts a fetch, webhook payloads and notes are never trusted, and a plan payment is recorded (once per payment id) only for a paid invoice of our subscription, in INR, for our amount, whose payment Razorpay reports captured. The plan state changes only through `app.apply_plan_subscription_period` in the company's own scope, for exactly the paid cycle; an ended subscription never becomes live again, and an older read changes nothing. A subscription's amounts, add-ons, plan and starter never change (column grants), plan payments are append-only and neither is ever deleted (triggers), and platform staff can only move a subscription to cancelled (policy); platform owners alone set the tax and cancel a company's subscription, with a reason (ADR-063). Plan payment receipts need `billing.read` and are computed in the company's scope from the payment and its subscription (ADR-064).                                                                                                                          |
| Trial-end payments | A subscription paid from a trial's end records nothing until Razorpay reports a paid cycle, and its start is written once (no role may update it). The ended trial waits for the first charge only while that subscription may still be charged, and for at most the plan version's grace days, by one SQL rule (`app.trial_charge_wait_until`) used by the transition, the due list and the plan card. After the start, a company's cancellation asks Razorpay first, so a charge already made keeps its paid period; a trial less than 48 hours from its end is charged at once, as Billing says (ADR-102).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Plan choices       | Platform owners offer a published version and stop offering it (the platform service checks the owner role, as for every catalog change; a column grant lets the platform role write only the offer; a check keeps it off drafts, retired versions and versions under ₹1), in the platform audit log. Members with `billing.manage` and a sign-in within 15 minutes choose an offered version only through `app.choose_plan` (SECURITY DEFINER, `w360_app` only), which takes the company and member from the session's scope, never from input, and checks the company's status, the plan state, a subscription that may still be charged, the offer and the tax again in SQL under the subscription-start lock and the plan state's row lock; it changes only the version, the note and who changed it, after any withdrawal or retirement of the version in progress (migration 0083). The company role still cannot write its plan state. The version must hold the seats, numbers, teams and live automations in use, counted after the locks additions take, and be payable with the add-ons and the tax. Audited (`billing.plan_chosen`).                                                                                                                                                                                                |
| Plan add-ons       | Members with `billing.manage` and a sign-in within 15 minutes change the add-ons of their own version only through `app.choose_add_ons` (SECURITY DEFINER, `w360_app` only), which takes the company and member from the session's scope, never from input, and checks the company's status, the plan state, a subscription that may still be charged, a published version and the tax again in SQL under the subscription-start lock and the plan state's row lock; it changes only the three quantities, the note and who changed them, and the plan state's guard keeps them to what the version sells, within its maximums. The company role still cannot write its plan state. A decrease must leave the seats and WhatsApp numbers in use, counted after the locks additions take, and the total must be payable with the tax. Audited (`billing.add_ons_chosen`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Price list         | Platform owners show or hide the price list for visitors (the platform service checks the owner role, as for every catalog change; a column grant lets the platform role write only when it was shown and by whom, which a check pairs), in the platform audit log. `/pricing` needs no sign-in: it reads in the system scope as `w360_app`, in a read-only transaction, the commercial terms of the versions that are published and offered (never who made or offered them) and, of the settings, only whether the list is shown, the tax and the default trial (column grants: the runtime role cannot read who showed it, nor change any setting). It shows nothing of any company or person, and is not found while hidden or while a visitor could not follow it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| API reference      | `/developers` needs no sign-in and reads no session, company data or database: it shows the OpenAPI document the API serves at `/api/v1/openapi.json` (also public), built by the same call, once, from the code and the configured address, so it holds nothing the document does not. Its text is rendered as text, never as HTML; a reference or a shared parameter it cannot resolve fails the page instead of leaving part of it out. Like every page it is `private, no-store`, carries the CSP nonce and is not indexed (ADR-152).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Plan changes       | Members with `billing.manage` and a sign-in within 15 minutes change the plan a subscription pays for, from the end of the paid period, only by ending the current subscription at Razorpay first (cancelled at the end of its cycle, as their own cancel) and recording a new subscription that follows it (`follows_subscription_id`, insert-only). A trigger (`app.guard_plan_subscription_follow`, migration 0087) refuses one that does not start exactly when the period paid by the subscription it follows ends, at least 48 hours ahead, after that one charges no more, for a company not suspended or being deleted, for an offered or the current published version, within what it sells, at its price with the tax set now. A unique index allows one live subscription that keeps charging per company. The new subscription's first paid cycle, fetched from Razorpay, applies its version and add-ons through `app.apply_plan_subscription_period`, which never moves a period back. Audited (`billing.plan_change_started`).                                                                                                                                                                                                                                                                                                  |
| Credit refunds     | Platform owners only (checked in SQL: `ops.platform_request_credit_refund` looks the user up in `ops.platform_admins`), with a reason in the platform audit log; at most the unrefunded amount and the unused credit (under the wallet's row lock), one open refund per top-up, none for a company being deleted. The credit is held at once; only `app.billing_record_refund` (a refund Razorpay reports, fetched first) and `app.billing_fail_credit_refund` settle the request and its hold, and the company role cannot move a request to either state (restrictive policy) or read the reason (column grants). Razorpay is called by the worker with an idempotency key, the same body every time (ADR-058).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Plan refunds       | Platform owners only (checked in SQL by `ops.platform_request_plan_payment_refund`), with a reason in the platform audit log; at most what Razorpay has not refunded of the payment, one open refund per payment, none for a company being deleted, under a lock that recordings take too. Only `app.record_plan_payment_refund` (a refund fetched from Razorpay) marks a refund processed or records one made at Razorpay, and processed refunds never exceed the payment; the runtime role may only move a request to submitted or failed (restrictive policy). The company role cannot read the reason or who asked (column grants), and nobody deletes a refund. A refund never changes the plan or the subscription (ADR-103).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Refund requests    | Members with `billing.manage` and a sign-in within 15 minutes ask from a receipt: of a top-up, at most what is left of the payment and the unused credit; of a plan payment, at most what Razorpay has not refunded of it, and none while a refund of it runs. One open request per payment (unique indexes), 5 a day per company across both kinds (counted under one advisory lock), none once deletion is asked for (the company's status read under a share lock in the request's transaction). The company role inserts only open requests (column grants), moves them only to withdrawn (restrictive policies) and cannot read who decided. Only platform owners decide (checked in SQL); approving runs the staff refund's checks again under its locks, and declining needs a note. Platform owners are emailed counts only (ADR-073, ADR-104).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Reconciliation     | The worker reads Razorpay's settlement report and writes runs and items only through SECURITY DEFINER functions that check the run's current attempt; neither runtime role can read or write the tables. Companies are found through HyFib's own provider-id mappings; a missed payment or refund is recorded only after fetching it from Razorpay, through the functions its webhook uses (credit exactly once, refunds keyed by id). Platform staff read through functions that check `ops.platform_admins`; only platform owners run a day or resolve an item, with a reason or note in the platform audit log. Items keep ids and amounts, never notes, descriptions, receipts or card fields (ADR-059).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Templates          | Created, deleted and listed only by the worker with the stored WABA token (never in the browser); webhooks for templates are signals routed through verified WABA bindings and never change status on their own; submission is write-ahead so a lost response cannot create a duplicate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Supply chain       | Exact pins + lockfile, pnpm minimum release age, explicit install-script allowlist, `pnpm audit` and gitleaks in CI, GitHub Actions pinned by SHA, Trivy image scanning, Dependabot; an advisory with no patched release is cleared by removing the vulnerable package from the tree, not by ignoring it (ADR-142: a pnpm patch pinned to the plugin's version).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Permission matrix

Generated from `packages/domain/src/authz/permissions.ts` with `pnpm tsx scripts/permission-matrix.ts`.
Members can hold several roles; effective permissions are the union, minus the write permissions of
modules the company's plan leaves out (`automations.write`, `automations.publish`, `flows.write`,
`flows.publish`, `crm.write`, `commerce.manage`; ADR-051), minus permissions blocked while the
company is suspended, restricted (its plan expired or was canceled) or pending deletion (the same
"allowed while suspended" column) or while required MFA is overdue (only `tenant.read` and
`members.read` remain). A company can also take `contacts.view_numbers` from the roles it chooses
(ADR-226).

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
| `inbox.export`           |   ✓   |   ✓   |     ✓      |       |          |         |         |            ✓            |
| `contacts.read`          |   ✓   |   ✓   |     ✓      |   ✓   |    ✓     |         |         |            ✓            |
| `contacts.write`         |   ✓   |   ✓   |     ✓      |   ✓   |    ✓     |         |         |                         |
| `contacts.import`        |   ✓   |   ✓   |     ✓      |       |    ✓     |         |         |                         |
| `contacts.export`        |   ✓   |   ✓   |            |       |    ✓     |         |         |            ✓            |
| `contacts.delete`        |   ✓   |   ✓   |            |       |          |         |         |            ✓            |
| `contacts.view_numbers`  |   ✓   |   ✓   |     ✓      |   ✓   |    ✓     |    ✓    |         |            ✓            |
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
- Merging contacts (ADR-224) needs `contacts.write` and `contacts.delete` (owners and
  administrators, not while the company is suspended) and is audited with the counts.
  `app.merge_contacts` (SECURITY DEFINER, executable by the runtime role only) works in the
  company's own scope: a contact of another company is not found, and its new policies reach only
  the current company's rows. Consent events, the CRM timeline and automation runs accept a change
  of `contact_id` alone, only inside the function (`w360.contact_merge`) and only for the definer
  role, which alone holds UPDATE on those columns. The opt-out of either contact stands; no opt-in
  is added. `app.contact_merges` holds ids, the member and counts, never personal data.
- Integrations hear of a merge (ADR-225) through ids only: `contact.merged` names the merged
  contact's id and gives the kept contact as the API describes it to the company's own endpoints,
  the change feed lists merged contacts' ids, and a 404 for a merged contact names the kept
  contact's id. The trigger runs as the merge (the definer role) and captures for the merging
  company alone; the API reads `app.contact_merges` in the key's company scope, so another company's
  merged contact is plainly not found.
- Customers' numbers (ADR-226): a company's owners and administrators choose the roles (supervisor,
  agent, marketer, analyst) whose members see them masked; the context leaves out
  `contacts.view_numbers` for a member whose every role that grants it is masked, and the services
  mask every number they give such a member (pages, server actions, CSV exports, the transcript)
  before it leaves the server. Their digit searches match whole numbers only, so hidden digits
  cannot be found by narrowing a search. Unmasking a role needs a recent sign-in; both changes are
  audited. Message content, the public API, webhooks and the owners' company export are not masked.
- Notice email choices (ADR-215): a member changes only their own, through
  `app.set_own_email_opt_outs` (SECURITY DEFINER, executable by the runtime role only), which takes
  the membership from the scope, never an argument; the runtime role has no update on memberships.
  Only the listed kinds (six since overdue replies, ADR-230) can be turned off (a check constraint);
  security, sign-in and billing emails cannot be. Each change is audited.
- The overview's setup checklist (ADR-233) shows each step only to members who can read its data,
  and reads no fact for the others; it gives whether something exists (an active number, an approved
  template, a contact, a teammate, a target), never the records.
- Bulk tag edits need `contacts.write`, match only the company's contacts that are not erased,
  change at most 10,000 at once and only the number the member was shown, and are audited
  (`contacts.bulk_tagged`: the tag, counts and the filters used, never the search text; ADR-213).
- Campaigns: drafts and segments need `campaigns.write`; submitting needs `campaigns.write` and
  `campaigns.send`; approving (when the company requires it) needs `campaigns.approve` and a member
  other than the submitter; pausing, resuming, cancelling a started campaign, changing its caps and
  test sends need `campaigns.send`. Sends run under the submitter's (or the resuming member's)
  authority and the runner pauses the campaign if that member leaves or loses `campaigns.send`.
  Per-recipient lists need `contacts.read`; the per-recipient CSV export needs `contacts.export`.
  Campaign settings (approval, frequency cap, estimate currency) need `tenant.settings.manage`.
- Segment conditions on store orders (ADR-231: how many orders a contact placed, what they spent)
  need `commerce.read` as well to preview or save a segment and to give a campaign draft such an
  audience. A saved segment with one shows members without `commerce.read` how many contacts it
  matches, never which; a store it names must be the company's. They reveal whether a contact
  matches, never an order's contents.
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
  A member who has not opened the conversation 10 minutes later is emailed once, after the same
  checks run again (active, can still see it, mention unread); the email names only who mentioned
  them, how many mentions are unread there and the conversation's link, never the note or the
  customer (ADR-211).
  Overdue reply emails (ADR-230) go only to members who can see the conversation by the inbox's rule
  (the assignee, the team's members, or those who assign conversations), checked when sent, and skip
  members who turned them off. They carry the target, the reason, the time the customer started
  waiting and a link where access is checked again; never the customer's name, number or messages.
  The sweep's definer function returns ids only; the decisions run in each company's own scope.
  Transcripts need `inbox.export` (owners, administrators, supervisors) and sight of the
  conversation, are audited (`conversation.transcript_exported`, no content), are plain text so no
  spreadsheet runs a formula from them, and leave internal notes out (ADR-212).
  Conversation tags (ADR-220) need `inbox.reply` and sight of the conversation, checked under its
  row lock; whoever sees a conversation sees its tags, and the inbox's filter offers only the tags
  on conversations the member can see. Erasing a contact deletes the tags of their conversations
  (the definer function's policies reach only the current company's rows), and an erased contact's
  conversation takes no new tags.
  Keys (ADR-221) read conversations' tags with `conversations.read` and change them with
  `conversations.write`, in their own company only; conversations of erased contacts are not found.
  Changes through the API are audited with the counts added and removed, never the tags.
  Automations (ADR-222) tag only the conversation their run answers, under its row lock, with the
  same limit, and never the conversation of an erased contact.
  Read receipts and typing indicators (ADR-223) are off until a member who manages company settings
  turns them on (audited). Typing needs `inbox.reply` and sight of the conversation; jobs carry only
  the message's id in a signed envelope, and the worker re-reads everything in the company's scope
  and uses the receiving account's token only towards Graph. Nothing is sent for an erased contact.
  Files customers send (ADR-216) are given only to members who can see the conversation, fetched for
  each request with the receiving account's token, which goes only to Graph and to the https address
  Graph returned (no user name or password, no redirects; the address is never stored or logged),
  and passed on without a copy. Only photos, stickers, recordings and videos keep their type; every
  other file is an `application/octet-stream` attachment. Answers carry `nosniff`, a `sandbox`
  Content-Security-Policy and a same-origin resource policy, and stop past 100 MB.
  Files members send (ADR-218) need `inbox.reply` and every check of a text reply, go through a
  route only HyFib's own pages may post to (the trusted-origin check) with the member's session, are
  read up to 16 MB and accepted only as listed photo, video, recording and document types, and are
  uploaded with the account's token from the server, never the browser; HyFib keeps no copy.
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
- Exporting orders (ADR-235) needs `commerce.read` and `contacts.export`: the file holds the orders
  of conversations the member can see, with customers' names, numbers (masked as for the member,
  ADR-226) and notes, formula-neutralised; an erased contact's orders carry neither number nor note.
  Each export is audited (`commerce.orders_exported`, with the status filter).
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
  `inbox.reply` for `messages.send` (utility templates) and `messages.reply` (text replies,
  ADR-070), `campaigns.send` for `messages.send_marketing`, `inbox.read_all` for
  `conversations.read` (ADR-072), `inbox.supervise` for `conversations.write` (ADR-075),
  `automations.publish` for `automations.start` (ADR-077), `tenant.settings.manage` for
  `contact_fields.manage` (ADR-115), `campaigns.read` and `campaigns.write` for the scopes of the
  same names (ADR-125, ADR-186), `campaigns.send` for `campaigns.stop` (ADR-128) and
  `campaigns.resume` (ADR-176), `commerce.read` for `orders.read` (ADR-167), `inbox.reply` for
  `orders.write` (ADR-168), and `channels.read` for the scope of the same name (ADR-171). Nobody
  grants a key more than they hold, and rotating needs the same. A key keeps the scopes it was
  created with.
- A request acts for the key's company only, as the key: its company comes from the key found by
  the token's hash, never from the path, body or headers, and data access runs in that company's
  scope (RLS). Audit rows name the key (`api_key`). Writing scopes are refused while the company is
  suspended or restricted.
- A key may be tied to up to 20 networks (ADR-076): the lookup refuses any other address, and an
  unknown one, before the key is marked used; the refusal (403 `ip_not_allowed`) counts against the
  address's failed-authentication limit. Members who manage keys set the networks with a recent
  sign-in, audited with the lists before and after; the runtime role reads and writes
  `allowed_networks` through column grants in the company's scope, and the definer function reads it
  to authenticate. The address is the one audit uses (`X-Forwarded-For` behind `TRUSTED_PROXIES`), so
  the protection depends on the edge overwriting or appending that header.
- The company may list up to 20 networks for all its keys (ADR-099): a request must come from one of
  them, and from one of its key's own networks when the key lists any. The lookup checks both before
  the key is marked used and says which list refused the address; the refusal is the same 403
  `ip_not_allowed`, counted against the address's failed-authentication limit. Members who manage
  keys change the list with a recent sign-in, audited with the lists before and after; the runtime
  role reads and changes only its company's row of `app.api_settings` (no delete), and the definer
  function reads the list of the key's company to authenticate.
- Template sends through the API apply the members' template-send checks (approval, category scope,
  consent, suppression, erasure, the marketing frequency cap) and are checked again before dispatch.
  The API can read the status only of messages sent through the API.
- Text replies through the API (ADR-070) go only to an existing contact who wrote to that number in
  the last 24 hours, checked under the conversation's row lock and again by the send worker; they
  never create a contact. A number that is not a contact, has no conversation on the number, was
  erased or last wrote earlier gets one answer (412, `window_closed`), so the refusal tells a key
  without `contacts.read` no more than a sent reply would. A reply ends an automation handling the
  conversation, as a member's reply does, and is marked with its key in the inbox and in status
  reads and webhooks.
- Conversation reads (ADR-072) are the most sensitive reads the API offers: a key with
  `conversations.read` reads every conversation of the company and what contacts wrote, so only a
  member who reads every conversation (`inbox.read_all`) can grant it. The conversations of erased
  contacts are neither listed nor read. A conversation names its member and team by id only
  (ADR-093); messages carry their text and the media type, never internal notes or member names. The
  file a customer sent comes only from `GET /messages/{id}/media` (ADR-217), with the same scope,
  fetched from WhatsApp per request and given as an attachment; a key cannot be sent by a browser on
  its own, so the file keeps its type.
  Uploads (ADR-219) need `messages.reply`, are checked as members' files are (listed types, at most
  16 MB) and are uploaded from the server with the account's token. A send names only the company's
  own upload, for the number it goes from, of its type, within 30 days; another company's id is not
  found.
  Keyset cursors carry a timestamp and an id that are checked before they reach a query.
- Resolving and reopening conversations through the API (ADR-075) needs `conversations.write`,
  which only members who resolve every conversation in the inbox (`inbox.supervise`: owners,
  administrators, supervisors) can grant; an agent cannot. The change runs under the conversation's
  row lock like a member's, finds no erased contact's or other company's conversation, is audited
  as the key, sends no satisfaction survey and credits no member in reports.
- Assigning conversations and moving them between teams (ADR-093) also needs `conversations.write`;
  every role that can grant it also holds `inbox.assign` (tested). Only active members whose role
  answers conversations can be given one (the rule teams and routing use, which the inbox now keeps
  too), and only the company's teams; the member's and the team's rows are locked while the change
  is written, so a member suspended at the same time is refused or has the conversation released by
  the suspension. `conversations.read` lists those members with their names, teams and whether they
  take conversations, never emails or roles; the members who can grant it see the team in the app
  already. Every change is audited as the key; routing that follows is the system's.
- Changing many conversations in one call (ADR-120, `POST /conversations/update-many`) needs the
  same scope and changes each conversation through the same function, under the same locks, as a
  single change; at most 100 per call, all or none. It locks the member first, then the
  conversations in id order, then the team as conversations move into it, the order suspensions and
  team deletions lock them, so concurrent calls take turns, and a call meeting a suspension or a
  deletion waits and is refused, instead of deadlocking (tested). An id
  that names none of the company's conversations (another company's or an erased contact's
  included) refuses the whole call, naming its place in the list, and changes nothing (tested), so
  a call never reveals or touches another company's conversations beyond saying an id is not one of
  the company's. A call counts as one request against the key's limits.
- Changing the conversations a filter finds (ADR-166, `POST /conversations/update-matching`) needs
  `conversations.read` and `conversations.write` both, so a key that may only change conversations
  cannot list them through it. It takes at least one of the list's filters, so no call changes every
  conversation by mistake, and changes each conversation of a page, at most 100, through the
  function `PATCH` uses, under the locks of ADR-120, audited as the key. The filter is applied again
  to the locked rows, so a conversation someone else took out of it meanwhile is left out rather
  than changed (tested), and only the company's conversations are found (the company condition and
  row security; another company's key changed nothing, tested).
- Changing many contacts in one call (ADR-122, `POST /contacts/update-many`) needs
  `contacts.write` and changes each contact through the function `PATCH /contacts/{id}` uses, with
  the same checks of every value against its field's type, the 50-tag limit and the audit as the
  key; at most 100 per call, all or none, in the company's scope. It locks the fields any change
  names first, in one statement, as a field's deletion takes them, then the contacts in id order,
  so concurrent calls take turns and a call meeting a field's deletion waits and refuses the deleted
  key without keeping a value of it (tested). An id of another company's contact or an erased one
  refuses the whole call, naming its place in the list, and changes nothing (tested), so a call never
  reveals or touches another company's contacts beyond saying an id is not one of the company's. A
  call counts as one request against the key's limits.
- Numbers in calls that change many contacts (ADR-188): each contact's new number is refused as
  `PATCH /contacts/{id}` refuses it (a WhatsApp identity's, another contact's without naming it, a
  suppressed one), and every number is checked against the numbers contacts have before the call,
  after their rows are locked and before anything is written, so a key never swaps or moves numbers
  between the call's contacts (a person's messages then reaching another) in one call; a number
  given twice is refused before anything is read. A refusal names the place in the list, never
  another contact.
- Starting automations through the API (ADR-077) needs `automations.start`, which only members who
  publish automations (`automations.publish`: owners and administrators) can grant, as a started run
  messages contacts as a published version does; an automation whose version sends a marketing
  template also needs `messages.send_marketing`. Only a published, active automation whose trigger
  is "Started through the API" starts, from the one number it is limited to, for a contact who is not
  suppressed, erased or opted out, in a conversation no member is assigned to and no other run
  handles, within the hourly limit per conversation and the plan's runs; until the contact replies
  its steps send templates only, each checked for consent (and, for marketing, the frequency cap)
  when it is sent. The run records its key (`api_key_id`, fixed by the run guard); its inputs are
  kept with its answers and cleared with them (erasure, 30 days after the run ends), and the audit
  entry leaves them out. A key reads only runs keys of its company started.
- Starting an automation for many contacts in one call (ADR-161,
  `POST /automations/{id}/runs/start-many`) needs `automations.start` and starts each run through
  the steps a start of one run takes, with all of its checks for each contact, in a savepoint of its
  own: a refused start is answered in its place and leaves nothing behind, a contact created for it
  included, while the others start (an integration test, run in CI). Numbers that are not valid and
  a number given twice refuse the whole call before anything is read, and inputs the automation does
  not take before any start, naming their place in the list; the automation's own refusals and a
  plan without automations refuse the whole call. At most 50 starts per call, once per
  `Idempotency-Key`; a call counts as one request against the key's limits, and each run against the
  plan's runs.
- Stopping runs through the API (ADR-079) needs `automations.start` and an active company, and
  reaches only runs keys of the company started: a key cannot stop the automations customers start
  by writing, members' test runs or another company's runs (404). The stop runs under the
  conversation's and the run's locks like a member's, cancels what the run queued, hands nothing to
  people, is audited as the key and changes nothing for a run that has ended.
- Stopping many runs in one call (ADR-162, `POST /automation-runs/stop-many`) needs
  `automations.start` and stops each run as a single stop does, under the same locks, audited as the
  key; at most 100 per call, all or none. An id that names no run a key of the company started
  (another company's, one customers started by writing, a member's test run) refuses the whole call,
  naming its place in the list, and stops nothing (an integration test, run in CI), so a call never
  stops or reveals another company's runs beyond saying an id is not one of the company's. A call
  counts as one request against the key's limits.
- Template sends to many numbers (ADR-163, `POST /messages/send-many`) need the scopes one send
  needs and check each number as one send does (erasure, the suppression list, consent for the
  template's category, the marketing frequency cap under the campaign runner's company lock), so a
  call never sends where one send would be refused; a refused number changes nothing, not even the
  contact it would have created (integration tests, run in CI). At most 50 numbers per call, once
  per `Idempotency-Key`; a call counts as one request against the key's limits, within the 64 KB a
  body holds, and the send worker paces each WhatsApp number's messages as it paces every send.
- Buttons and lists through the API (ADR-080) follow every rule of text replies (`messages.reply`,
  an active company, only contacts who wrote in the last 24 hours with one answer for every
  refusal, the window checked again at send). Their ids cannot start with `w360`: HyFib's own
  automation and survey ids do, and a tap on a survey-like id would not reopen the conversation or
  open a reply turn. Meta's limits are checked before anything is read; ids reach Meta only, and the
  inbox stores titles.
- Webhook endpoints through the API (ADR-081) need `webhooks.manage`, which only members holding
  `developer.manage` grant (they manage endpoints in settings and read every conversation), and an
  active company. Keys see and manage only endpoints keys added (members' endpoints answer 404, so
  a key never learns an address that carries another receiver's token); the address rules, the
  limit of 10 and the audit actions are the settings service's own. Secrets are shown once: the
  response kept for an `Idempotency-Key` stores `secret: null`. Owners and administrators are emailed
  the key, the host and the events whenever a key adds an endpoint, since a key has no recent
  sign-in to check. Addresses cannot change through the API.
- Quotes and reactions through the API (ADR-082) follow every rule of replies (`messages.reply`, an
  active company, only contacts who wrote in the last 24 hours with one answer for every number it
  cannot reach, the window checked again at send). The message named in `replyTo` is looked up by
  id in that conversation only, after the conversation's lock: another conversation's or company's
  message is refused like an unknown id, and WhatsApp ids are never taken from the request. A
  reaction goes only on the contact's own messages of the last 30 days and does not end an
  automation; the emoji must be one RGI emoji.
- Webhook deliveries, test events and replays through the API (ADR-083) use the same
  `webhooks.manage` scope and reach only endpoints keys added: deliveries to members' endpoints
  answer 404 when listed, read or replayed. A delivery shows how sending went (status, attempts,
  HTTP status, error code, duration), never a body: payloads are not stored. Test events and
  replays need an `Idempotency-Key`, go only to an endpoint that is on, through the egress guard,
  and use the settings service's own steps; a replay is audited as the key. Replaying an
  endpoint's failed deliveries in one call (ADR-095) follows the same rules, queues at most 500
  events per call (each once, even when two calls race: the endpoint's row is locked first) and is
  audited once per call with the count.
- Notes through the API (ADR-084) need `conversations.write` (granted by members holding
  `inbox.supervise`, who read every note) and an active company. A note is internal: WhatsApp never
  receives it and it changes nothing about the conversation; the inbox names the key, and a key's
  note mentions no member. The conversation is locked before its contact is checked, in the order
  erasure takes, so no note outlives an erasure; erased contacts' and other companies'
  conversations answer 404. The database keeps exactly one author per note, which the runtime role
  cannot change.
- Products through the API (ADR-086) follow every rule of replies (`messages.reply`, an active
  company, only contacts who wrote in the last 24 hours with one answer for every number it cannot
  reach, the window checked again at send), and need Commerce in the company's plan, checked before
  the number is looked up. Products are found by content id only among the catalogs HyFib read for
  the sending number's WhatsApp account, still connected and not removed at Meta: products of
  another WhatsApp account's, another company's or a disconnected catalog are refused like unknown
  ids, and the catalog sent to Meta is always the one found, never taken from the request
  unchecked.
- Reading orders (ADR-167): `GET /orders` and `GET /orders/{id}` need `orders.read`, granted only
  with `commerce.read`, and Commerce in the company's plan, both checked before an order is read.
  They read in the key's company only (row security and an explicit company condition): another
  company's order answers 404 as an unknown one does, an id that is not a UUID is refused before any
  query, and every filter is typed (a status from the list, UUIDs, the reference's eight-capital
  pattern, an ISO time). Orders name the contact, conversation and number by id only, never the
  customer's number or name, the Payment Link or Razorpay's payment ids; an erased contact's orders
  are read without the note erasure clears (unit tests; integration and e2e tests, run in CI only).
- Changing orders (ADR-168): `PATCH /orders/{id}` needs `orders.write`, granted only with
  `inbox.reply`, checked before anything is read and refused while the company is suspended or
  restricted, and Commerce in the company's plan. It changes an order of the key's company only (row
  security and an explicit company condition; another company's order answers 404), with its row
  locked, and only as members may move it: payment statuses come only from Razorpay, an order
  waiting for payment is left to members, and a paid order is never cancelled. The change is audited
  as the key and moves the order's version on, so a member's page opened before it is refused as
  stale (unit tests; integration and e2e tests, run in CI only).
- Reading numbers (ADR-171): `GET /channels` needs `channels.read`, granted only with the permission
  of the same name, checked before anything is read. It reads in the key's company only (row
  security and an explicit company condition), takes a page and a status from the list and nothing
  else, and gives each number's id, the number and verified name WhatsApp shows, its status and when
  it was added: never Meta's ids for the number or its account, the credential, the registration PIN
  or Meta's review fields (unit tests; integration and e2e tests, run in CI only).
- The message feed (ADR-088) needs `conversations.read`, checked before its query is read, and
  reads only in the key's company scope: other companies' messages are never in it, erased
  contacts' conversations are left out, internal notes are not messages and media is never
  attached. It reads what one conversation's messages already give the same key. Each page reads at
  most 2,000 of the company's messages whatever its filters, so no request can make the database
  read every message a company has.
- Reading notes (ADR-089) needs `conversations.read`, checked before anything is read, and finds
  only the key's company's conversations whose contacts are not erased (others answer 404). A note
  says whether a member or a key wrote it and, for a key's note, which key; never which member, and
  mentions are never read.
- Contact custom fields (ADR-112): every contact the API or a contact webhook describes carries the
  values of the company's own fields only, so a value left by a field deleted at the same moment is
  never read. `contacts.read` also lists the fields (keys, labels and types). Changing a contact
  (`PATCH /contacts/{id}`) needs `contacts.write`, which only members who can change contacts grant,
  and an active company; it changes the name, email, field values and tags, and a typed number
  (ADR-180) but never one WhatsApp gave (the contact's identity), nor to a number another contact
  has (refused without naming it) or one on the suppression list, under the contact's row lock and
  with the field rows locked against a deletion at the same time (taken first, in a deletion's
  order); erased and other companies' contacts are not found. Values must have their field's type
  and a refusal saves nothing; tags keep the 50 a contact may have, which `POST /contacts` now
  checks too. The audit entry names what changed and which fields, never a value.
- Finding contacts (ADR-113): `GET /contacts` filters by email, tag and custom field values in the
  key's company only (erased contacts never match). Field keys are checked against the company's
  fields before use, and keys, tags and values are bound parameters, never part of the SQL text. A
  page filtered by tag or field reads at most 2,000 contacts, so a rare value cannot make one request
  read every contact a company has.
- Finding contacts by name (ADR-124): `name` on `GET /contacts` reads the key's company's live
  contacts only (`contacts.read`, the company's scope), as the other filters do. The text is a bound
  parameter with `%`, `_` and `\` escaped, so it is never SQL and never a pattern, and a page
  filtered by it reads at most 2,000 contacts, so a text no name holds cannot make one request read
  every contact a company has. Names come in the query string, which the app's request log leaves
  out (it records the path); access logs at the edge are deployment's to strip or keep short
  (DEPLOYMENT).
- Text holding the NUL character (ADR-124): every API request's query parameters and JSON body are
  checked before its handler runs, and one holding U+0000, which PostgreSQL text cannot store, is
  refused with 422 naming where, instead of failing in a query as an internal error that a client
  could repeat to fill error logs and alerts. The body is walked without recursion, so no nesting
  exhausts the stack. Members' forms, Better Auth's and provider payloads have the same protection
  since ADR-130 ("Text input" above).
- Reading campaigns (ADR-125): `GET /campaigns` and `GET /campaigns/{id}` need `campaigns.read`
  (granted only by members holding `campaigns.read`) and read the key's company's campaigns in its
  scope: an id of another company's campaign answers 404 as an unknown one does, and an id that is
  not a UUID is refused before any query. They answer counts only, never recipients, contacts,
  messages, members or costs, so a key with the scope alone learns how a campaign did but not who
  received it (listing recipients also needs `contacts.read`, ADR-127, below); campaign and template
  names are the only text. A campaign's results are counted when read, one pass over its recipients,
  and rate limits and monthly requests bound how often a key repeats it. As a reading scope it keeps
  working while the company is suspended or restricted, as members' campaign pages do.
- Conversation and campaign conditions in contact searches (ADR-126): a `last_message` condition
  (whether a contact wrote in the last days) needs `conversations.read` as well as `contacts.read`,
  and a `campaign` condition (what happened to a campaign's message to a contact) needs
  `campaigns.read`; without the scope the search is refused before anything is read. With
  `campaigns.read` and `contacts.read` a key learns which contacts a campaign reached, read or got a
  reply from, as members who hold both see a campaign's recipients. A campaign the key's company
  does not have (another company's included) is refused as unknown, and the campaign id and the days
  are bound parameters, never SQL. The pages read at most 2,000 contacts, as before.
- A campaign's recipients (ADR-127): `GET /campaigns/{id}/recipients` names contacts (name and
  number) and what happened to each one's message, so it needs `campaigns.read` and `contacts.read`,
  the pair members need to see a campaign's recipients, both checked before anything is read. The
  campaign is looked up in the key's company first (RLS and an explicit filter): another company's
  campaign answers 404 as an unknown one does. An id or cursor that is not a UUID and an outcome the
  results do not count are refused before any query; the cursor is a bound parameter and the outcome
  picks one fixed condition, never SQL from the request. Recipients whose contact was erased are
  left out, as the API leaves erased contacts out everywhere (the results still count them), and no
  costs, members or other contact details are returned. A page reads one campaign's recipients
  (50,000 at most) and stops when it is full; rate limits and monthly requests bound repeats.
- Pausing and cancelling campaigns (ADR-128): `POST /campaigns/{id}/pause` and `/cancel` need
  `campaigns.stop`, a writing scope granted only by members holding `campaigns.send` (the permission
  members pause and cancel with) and refused while the company is suspended or restricted. They only
  stop sending: a pause releases the sends no worker claimed, a cancel also cancels waiting
  recipients; neither sends a message, spends or resumes anything (resuming needs a member, under
  whose authority the campaign then sends, or, for a pause a key made, a key with
  `campaigns.resume`: ADR-176). The campaign is locked in the key's company (RLS and an explicit
  filter): another company's campaign answers 404 as an unknown one does, and an id that is not a
  UUID is refused before any query. The audit row names the key (`api_key`) with the request's id,
  members' campaign history names the key, and `campaign.status_changed` reports the change. A
  leaked key with the scope can stop the company's campaigns until it is revoked (members resume a
  paused one; a cancelled one stays cancelled), so only integrations that must stop campaigns should
  get it.
- Resuming the campaigns keys paused (ADR-176): `POST /campaigns/{id}/resume` needs
  `campaigns.resume`, a writing scope of its own (`campaigns.stop` does not resume) granted only by
  members holding `campaigns.send` and refused while the company is suspended or restricted. It
  lifts only a pause whose reason is `api`: what a member paused, or HyFib paused for a reason
  members must fix (caps, the template, the number, the launcher, the rate card), stays for members.
  The key never becomes the authority the campaign sends under: the campaign keeps the member who
  launched it, the resume is refused while that member has left or can no longer send campaigns, and
  the runner keeps checking them before each batch, so a key cannot send what no current member with
  the permission launched. Members' checks run before anything changes (the template approved, the
  number active, the caps, the rate card). The campaign is locked in the key's company (RLS and an
  explicit filter): another company's campaign answers 404 as an unknown one does. The audit row
  names the key with the request's id, and members' history names it. A leaked key with the scope
  can undo the pauses keys made until it is revoked; members can pause again, which such a key
  cannot lift.
- Creating and editing campaign drafts (ADR-186): `POST /campaigns` and `PATCH /campaigns/{id}` need
  `campaigns.write`, a writing scope granted only by members holding `campaigns.write` (the
  permission members edit drafts with) and refused while the company is suspended or restricted.
  They write drafts only: a draft sends nothing, a campaign that is no longer a draft is refused,
  and submitting, approving and starting stay with members, so a key never becomes the authority a
  campaign sends under and sends nothing by itself. Members' checks run on every write in the key's
  company (RLS and explicit filters): the number, template and segment must be the company's
  (another company's answers 404, as an unknown one does), conditions pass segments' rules, and the
  time zone, window, variables, date and caps are checked as members' are. A key's draft names no
  member; its campaign events carry the key's id, and the audit rows name the key with the request's
  id. `GET /campaigns/{id}` answers a draft's settings (audience, variables, pacing and spending
  cap) only to keys that also hold `campaigns.write`; a key that only reads campaigns still gets
  counts (ADR-125). A leaked key with the scope can create drafts and change the company's drafts
  until it is revoked, which members see in each draft's history before they submit it.
- Cancelling drafts (ADR-187): `POST /campaigns/{id}/cancel` cancels a draft for a key holding
  `campaigns.write`, the scope that writes drafts, as members cancel drafts with that permission; it
  never stops a campaign that sends, which still needs `campaigns.stop`. Both scopes are checked as
  writing scopes before anything is read, and the campaign is locked in the key's company. A leaked
  key with `campaigns.write` can cancel the company's drafts until it is revoked; a cancelled draft
  is kept, and its history names the key.
- Reviewing drafts (ADR-193): `GET /campaigns/{id}/review` answers a draft's review only to a key
  holding `campaigns.write`, which already reads drafts' settings: it shows counts of the audience
  and an estimate of Meta's charges, never contacts or members, and keys that only read campaigns
  get 403. It reads one draft of the key's company in a read-only transaction and changes nothing,
  so a company that is not active still reads it.
- Submitting drafts (ADR-202): a key with `campaigns.write` submits one of its company's drafts with
  members' checks, but it can never start a campaign: the submission always waits for a member with
  `campaigns.approve` who also holds `campaigns.send`, and the campaign runs under that member's
  authority, which the runner checks before each batch. The campaign records the key (a composite
  foreign key to the company's keys, and never with a submitting member, both enforced by the
  database), and the event and the audit name it. A suspended company's keys cannot submit.
- Withdrawing submissions (ADR-203): a key takes back only a submission it made, while it waits for
  approval (403 for a member's or another key's, 409 once approved); the withdrawal drops the
  audience, raises the version and is recorded in the event and the audit with the key.
- Approval emails (ADR-204): when a campaign starts waiting for approval, the company's active
  owners and administrators other than the member who submitted it are emailed, read in the
  company's scope and queued through the encrypted outbox in the submission's transaction (a refused
  submission emails nobody); for a key's submission only members who may also send campaigns. The
  email names the submitter and the campaign, counts its audience and links to its page, which
  authorizes the member as usual: no contact data, no token, and the link grants nothing by itself.
- Review emails (ADR-205): the member who submitted a campaign is emailed what an approver did with
  it, in the same transaction through the encrypted outbox, only while they are an active member of
  the company and never for their own action. The email names the approver and the campaign, carries
  the approver's note (written for that member) and links to the campaign's page, which authorizes
  as usual; it carries no contact data. A key's submission emails nobody.
- Segments (ADR-206): a key with `campaigns.read` reads its company's segments that are not
  archived, in a read-only transaction in the company's scope: names, conditions (tags, field keys
  and values, consent, dates, campaign ids), versions and how many contacts one matches now. No
  contact is given (finding them needs `POST /contacts/search` and `contacts.read`); archived
  segments and other companies' are not found.
- Writing segments (ADR-207): a key with `campaigns.write` creates, changes and archives its
  company's segments in the company's scope (RLS); conditions are checked against the company's own
  fields and campaigns, as searches are, a write is refused while the company is suspended or
  restricted, and the audit names the key. Saving a segment reads no contact; counting one needs
  `campaigns.read`, and finding its contacts `contacts.read`. Another company's segment is not
  found.
- A segment's contacts (ADR-208): `GET /segments/{id}/contacts` needs `campaigns.read` and
  `contacts.read`, and `conversations.read` for a segment with a `last_message` condition, as a
  search with the same conditions does, so a segment never gives what a search could not; it reads
  in the key's company scope, erased contacts left out.
- Conditions on store orders (ADR-231): `orders` and `spend` also need `orders.read` (granted with
  `commerce.read`) in searches, changes to matching contacts, segments, a segment's contacts and
  drafts' audiences, checked before anything is read; a store named must be the company's, another
  company's answering as one that does not exist.
- Media from links (ADR-194): a key with `messages.reply` sends a photo, a video, audio or a
  document by a link WhatsApp fetches, within the 24-hour window. HyFib never fetches the link, so
  it cannot be used to reach HyFib's network; it takes only https links with a host and no user name
  or password, so no credentials are stored with the message or shown in the inbox, and the inbox
  opens the link only as an https anchor in a new tab without the referrer. The link is the
  company's own data: it is redacted with the contact's messages and exported with them.
- Locations (ADR-195): a key with `messages.reply` sends a place's coordinates, name and address
  within the 24-hour window, with a reply's checks. HyFib fetches and looks up nothing: it sends
  what the key gives, bounded (coordinates within their ranges, a name and an address of at most
  1,000 characters each, no other property), and the inbox shows them as text only. The location is
  the company's own data: it is redacted with the contact's messages and exported with them.
- Contact cards' contacts (ADR-196): the people a customer shares are third parties' personal data,
  kept as the message's content since ADR-131. The API gives them only with `conversations.read`
  (granted only by members who read every conversation), and `message.received` only to the
  company's endpoints taking it, as both already give messages' text; nothing new is stored. Erasing
  the customer redacts the card, so reads and deliveries after the erasure give no contacts. The
  inbox shows them as text only, never as links.
- Contact cards sent through the API (ADR-197): a key with `messages.reply` shares up to 5 contacts
  within the 24-hour window, with a reply's checks. HyFib sends what the key gives, bounded (5
  contacts, 5 of each kind, 256 characters a text, links http or https without credentials, emails
  and dates checked, no other part) and within the size a message may hold; it fetches nothing, and
  the inbox shows the card as text only. The people on a card are the company's data like any
  message's: redacted with the contact's messages and exported with them.
- Stickers from links (ADR-198): the rules of media from links (ADR-194): a key with
  `messages.reply`, within the 24-hour window, an https link with a host and no credentials that
  HyFib never fetches, shown in the inbox as an https anchor in a new tab without the referrer; no
  caption is taken.
- Templates with media headers (ADR-201): the header's file follows the rules of media from links
  (ADR-194): an https link with a host and no credentials, at most 2,000 characters, that HyFib
  never fetches, shown in the inbox as an https anchor in a new tab without the referrer. The
  template's checks are unchanged (the scope of its category, consent, the suppression list, the
  marketing cap); only the API sends these templates, and the link is kept with the message and
  redacted with it.
- Website buttons whose link ends with a value (ADR-228): no value can change the website a button
  opens. A link must name its https website in full before `{{1}}` (the host followed by `/`, `?` or
  `#`, no user name), refused when a draft is saved and not sendable when synced otherwise; every
  value is checked again when sent, by the sender, the API and `buildTemplateSend` (no spaces or
  control characters, the template's origin kept). The link as sent is kept with the message and
  redacted with it, and the inbox shows it as an https anchor in a new tab without the referrer.
- Ends of links from customer data (ADR-229): campaigns, automations and store messages fill the end
  of a link from contact fields, run inputs or order values, which customers or integrations may
  have written. Each is checked when queued exactly as a member's value is (no spaces or control
  characters, at most 1,000 characters, the template's website kept): an unusable value falls back
  to the member's fallback, or skips the recipient or message, or fails the run; fixed ends and
  fallbacks are checked when saved. A value can choose the path on the template's website, never
  another website.
- Following contact changes (ADR-114): `GET /contact-changes` reads the key's company's changes
  only (`contacts.read`, RLS and an explicit company filter). Its cursor, a database transaction id
  and a row id, is sealed with the keyring (AES-256-GCM) with the company in the associated data, so
  it shows nothing of other companies' activity and opens for no other company; a changed or foreign
  cursor is refused with 422. Change rows hold no personal data; an erased contact is read as
  `erased` with no contact. The triggers that record changes run as whoever changes the contact
  (column grants: the runtime and definer roles insert only `tenant_id` and `contact_id`); only the
  compaction function, owned by the definer role and run by the worker, deletes rows across
  companies, and only rows a later change of the same contact replaced.
- Merging contacts through the API (ADR-227): `contacts.merge` is granted only by members holding
  `contacts.delete` (owners and administrators, who merge in the app), is a writing scope (refused
  while the company is suspended or restricted) and can be left out by the plan. The merge runs
  `app.merge_contacts` in the key's company scope, so another company's contact is not found; the
  audit log names the key.
- Defining contact fields (ADR-115): adding, renaming and deleting the company's custom fields needs
  `contact_fields.manage`, which only members holding `tenant.settings.manage` (owners and
  administrators, who define fields in Settings) grant, and an active company. Fields are named by
  key in the key's company only; another company's key is not found. Keys and types never change,
  so values already stored keep their meaning; a deletion removes every contact's value with the
  field, as in Settings. Additions of one company take turns under a lock, so the 50-field limit
  holds for members and keys at once. Every change is audited as the key or the member with the
  field's key, never values; renames are audited now, in Settings too.
- Following message changes (ADR-116): `GET /message-changes` reads the key's company's messages
  only (`conversations.read`, which only members who read every conversation grant; RLS and an
  explicit company filter). Its cursor is sealed as the contact feed's is, with the feed's name and
  the company in the associated data, so a contact feed cursor or another company's does not open.
  Change rows hold no personal data (a message id and a transaction id); a message of an erased
  contact is read as `erased` with nothing of it. Only the trigger on `app.messages` writes the rows,
  through a function owned by the definer role; the runtime role may only read them, so no code can
  move a message to another place in the feed.
- Searching contacts (ADR-117): `POST /contacts/search` (`contacts.read`) finds the key's company's
  live contacts only (RLS and an explicit company filter; erased contacts never match), with
  segments' conditions on data a contact already shows (custom fields, tags, consent, creation day,
  source, calling code, and the name since ADR-143). Segments' conditions on conversations and
  campaigns also need the scope that reads them (ADR-126, below). Field keys are checked against
  the company's fields first, and keys, values, tags and dates are bound parameters, never part of
  the SQL text; `contains` escapes `%` and `_`, so a value is never a pattern. Each page reads at
  most 2,000 contacts, so no condition can make one request read every contact a company has. It
  writes nothing.
- Groups of conditions in contact searches (ADR-164) are checked, bound and scoped as conditions
  outside them (a `last_message` or `campaign` condition in a group needs its scope, checked before
  anything is read), hold no groups and count toward the search's 20 conditions, so a search reads
  no more than before.
- Changing the contacts a search finds (ADR-165, `POST /contacts/update-matching`) needs
  `contacts.read` and `contacts.write` both, so a key that may only write contacts cannot read them
  through it, and the conditions' own scopes; it changes custom field values and tags only, each
  contact as `PATCH /contacts/{id}` changes one (audited as the key), at most 100 a call, in one
  snapshot, all or none.
- Only the token's SHA-256 is stored; the runtime role cannot read it. The token is shown once in
  the browser and kept only in the page's memory; it is never logged, and audit entries carry the
  public prefix only.
- Each request that passes authentication and the rate limits is counted against the plan's
  monthly API requests (ADR-061) in the key's company scope, atomically and never beyond the limit.
  A plan without the API refuses every request (403, `not_in_plan`) and creating or rotating keys;
  a month used up is refused with 429 (`quota_exceeded`) until the next period. The limit belongs to
  the plan version and changes only with a new version or another plan, set by platform staff.
- The scopes a plan includes (ADR-092) bound every key's: the admission that counts a request gives
  it the plan's scopes, and a request may use a scope only when its key has it and the plan
  includes it. One the plan leaves out answers 403 (`not_in_plan`), checked before the company's
  status. New keys cannot be given such a scope; existing keys keep theirs and are refused them while
  the plan leaves them out. The list belongs to the plan version (checked by the table, unchangeable
  once published) and is set by platform owners.
- Each counted request is also counted for its key (ADR-097), in the same transaction and before
  the company's count, below the key's own monthly limit when it has one: a request its key refuses
  (429, `key_quota_exceeded`) takes nothing from the company, and one the company refuses is taken
  back from the key, so a refused request counts for neither. A request reads the key's limit under
  a lock that a change of the limit holds until it commits, so it is never counted under a limit a
  committed change replaced. The limit is set and changed only by
  members with `developer.manage` after a recent sign-in, audited; the runtime role adds to a
  key's count but cannot move it to another key or period or delete it, and a count belongs to a
  key of the same company.
- The company's owners and administrators are emailed at 80% of a key's own limit and at the limit
  (ADR-098): the sweep finds counters due only through `ops.api_key_usage_notices_due` (owned by
  `w360_definer`, executable only by `w360_app`, returning company and counter ids), then locks and
  checks each again in its company's scope before marking it in the transaction that queues the
  emails. The email names the key by its name and public prefix; the token is never stored, so it
  cannot be sent.
- The API reference at `/developers` (ADR-152) needs no sign-in. It reads neither the session nor
  the database, only the address in the web configuration, and shows the OpenAPI document the API
  serves, built by the same call (once, then kept in memory), so nothing a company holds can appear
  on it.
  Descriptions are shown as text (paragraphs and code spans, escaped like every text React renders);
  nothing in the document is rendered as HTML. A reference it cannot follow, or a shared parameter
  the document lacks, fails the page rather than leaving part of it out.

Phase 5 rules (outgoing webhooks, P5-09):

- Members with `developer.manage` (owners and administrators) add, edit, turn off, delete and test
  the company's webhook endpoints, rotate their secrets and replay deliveries, one at a time, an
  endpoint's failed ones together or those of every endpoint that is on (ADR-160), of every event or
  of those chosen, and of every failure or of those chosen (ADR-095, ADR-156, ADR-159); API keys
  with `webhooks.manage` do the same for the endpoints keys added (ADR-081, ADR-083). Every change
  is audited with the endpoint's host only; the full URL (which may carry a receiver's token) and
  the secret are never logged.
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
- A delivery whose payload or signature cannot be built fails alone as `payload_failed`, and the
  worker logs only the company, delivery, endpoint, event type, what failed and the error's class
  and code: never the payload or the error's message, which can quote data (a failed query's
  message repeats its parameters). Tested.
- Secrets (`whsec_` + 32 random bytes) are shown once, kept only in the page's memory, and stored
  encrypted with the AAD `webhook-secret:<company>:<endpoint>:<version>`.
- An endpoint's own headers (ADR-118), up to 5, are given when it is added or changed, in Settings
  or by a key that manages it. Their values are secrets: they reach the server once, are sealed with
  the keyring as one ciphertext with the AAD `webhook-headers:<company>:<endpoint>`, and are never
  shown again, logged, put in audit entries (which name the headers), exported (the company data
  export carries the names) or kept in an API key's idempotency record; Settings and the API show
  names only, and a change gives every header again. Names HyFib sets or that describe the body or
  the connection (`Content-Type`, `Content-Encoding`, `User-Agent`, `Host`, `Content-Length`,
  `Transfer-Encoding`, `Connection`, `Keep-Alive`, `Upgrade`, `TE`, `Trailer`, `Expect`,
  `Accept-Encoding`), `Proxy-*` and `W360-*` are refused whatever their case, when saved and again
  when opened, and HyFib's own headers are set after the endpoint's, so none can replace the
  signature or the event's ids. Values are printable ASCII without line breaks, so a header cannot
  inject another. Only the worker opens them, for the endpoint they are bound to; headers that do
  not open fail that delivery alone as `payload_failed` (stage `headers`), logged without them.
  Tested.
- An endpoint's OAuth client (ADR-173) is set the same way: a token URL held to the egress client's
  rules when saved and when called (https, public addresses, the name pinned, no redirects), a
  client ID, a secret and a scope. The secret reaches the server once, is sealed with the AAD
  `webhook-oauth-secret:<company>:<endpoint>` and is never shown again, logged, put in audit entries
  (which name the token URL's host), exported or kept in an API key's idempotency record; a change
  keeps it only while the token URL stays the same, so it cannot be sent to another server by
  someone who does not know it. The worker sends it only to the token URL, in an HTTP Basic header.
  Access tokens live only in the worker's memory, keyed by the company, the endpoint and a hash of
  the client: never stored, logged or shown, a day at most, replaced after a 401 or a change of the
  client. A token's characters are checked (RFC 6750) before it goes in the `Authorization` header,
  and an endpoint with a client cannot send an `Authorization` header of its own. A token request
  that fails is recorded by its code only; a secret that does not open fails that delivery alone as
  `payload_failed` (stage `oauth`). Tested (unit; integration and e2e tests run in CI only).
- An endpoint can take only some `message.status` statuses (ADR-119), chosen by whoever may change
  it (members with `developer.manage`, or the key that manages it). The list is checked against
  the statuses the message trigger captures, kept only while the endpoint takes `message.status`
  (a database check too), and applied in `app.capture_webhook_event`, which reads the company's own
  endpoints: it narrows what one endpoint receives and never what another endpoint or company
  receives, and a status no endpoint takes is not recorded. Audited with the list. Tested.
- An endpoint can take `contact.updated` only for some parts of a contact (ADR-123), chosen the
  same way. The list is checked against the parts the event names, kept only while the endpoint
  takes `contact.updated` (a database check too), and applied in
  `app.capture_contact_webhook_event`, which reads the company's own endpoints as the role making
  the change: it narrows what one endpoint receives and never adds an event, a part or a delivery
  for another company. A later change in the transaction queues only an event that transaction
  captured, once per endpoint, and a rolled-back savepoint takes back what it queued. The event
  names every part that changed, as before. Audited with the list. Tested.
- An endpoint can take automation run events only for some automations (ADR-145), chosen the same
  way. Each id must be an automation of the endpoint's company with a published version, looked up
  in the company's scope, so another company's automation is refused like an unknown id and the
  refusal reveals nothing about it; a published automation cannot be deleted, so a list never
  points at an automation that is gone. The list is kept only while the endpoint takes a run event
  (a database check too) and applied in `app.capture_webhook_event`, in the run's own transaction:
  it narrows what one endpoint receives and never adds an event or a delivery for another endpoint
  or company. The API answers and audits ids only; Settings names them to members with
  `developer.manage`, who can read automations anyway. Audited with the list. Tested.
- An endpoint can take `campaign.status_changed` only for some of the statuses a campaign reaches
  (ADR-146), chosen the same way. The list is checked against the seven campaign statuses, kept
  only while the endpoint takes `campaign.status_changed` (a database check too, which also refuses
  a null entry), and applied in `app.capture_webhook_event`, in the campaign change's own
  transaction: it narrows what one endpoint receives and never adds an event or a delivery for
  another endpoint or company, and a status no endpoint takes is not recorded. Statuses are not
  personal data. Audited with the list. Tested.
- An endpoint can take `order.status_changed` only for some of the statuses an order reaches
  (ADR-147), chosen the same way. The list is checked against the five statuses a change can reach
  (`received` only arrives as `order.received`, which is never filtered), kept only while the
  endpoint takes `order.status_changed` (a database check too, which also refuses a null entry),
  and applied in `app.capture_webhook_event`, in the transaction that changes the order, whether a
  member, the Payment Link worker or Razorpay's payment changes it: it narrows what one endpoint
  receives and never adds an event or a delivery for another endpoint or company. Audited with the
  list. Tested.
- An endpoint can take `template.status_changed` only for some of the statuses reported (ADR-148),
  chosen the same way. The list is checked against the eleven statuses the event reports (HyFib's
  own steps, a deletion under way or refused and an unrecognised status are never sent), kept only
  while the endpoint takes `template.status_changed` (a database check too, which also refuses a
  null entry), and applied in `app.capture_webhook_event`, in the transaction that records the
  status, whoever records it: it narrows what one endpoint receives and never adds an event or a
  delivery for another endpoint or company. Audited with the list. Tested.
- An endpoint can take `conversation.status_changed` only for some of the statuses a conversation
  reaches (ADR-149), chosen the same way. The list is checked against the two statuses a change
  reaches (`open`, `resolved`; nothing sets a conversation pending), kept only while the endpoint
  takes `conversation.status_changed` (a database check too, which also refuses a null entry), and
  applied in `app.capture_webhook_event`, in the transaction that changes the conversation: it
  narrows what one endpoint receives and never adds an event or a delivery for another endpoint or
  company. Audited with the list. Tested.
- An endpoint can take `automation.run_ended` only for some of the ways a run ends (ADR-151), chosen
  the same way. The list is checked against the five statuses a run ends with (`completed`,
  `handed_off`, `taken_over`, `stopped`, `failed`; a run still going ends nothing), kept only while
  the endpoint takes `automation.run_ended` (a database check too, which also refuses a null entry),
  and applied in `app.capture_webhook_event` together with the automations the endpoint names
  (ADR-145), in the transaction that ends the run: it narrows what one endpoint receives and never
  adds an event or a delivery for another endpoint or company. Audited with the list. Tested.
- An endpoint can take the events of chosen WhatsApp numbers only (ADR-170), chosen the same way.
  Each id must be a number of the endpoint's company, looked up in the company's scope (another
  company's number is refused like an unknown id, by its place); the list is kept only while the
  endpoint takes an event that happens on a number (a database check too, which also refuses a null
  entry and more than 100 ids); and it is applied in `app.capture_webhook_event` with the number of
  the row the change itself made, passed by that table's trigger in the transaction that makes the
  change: it narrows what one endpoint receives and never adds an event or a delivery for another
  endpoint or company. Consent, contact and template events are not narrowed, and the number passed
  is not stored with the event. Audited with the list (unit tests; integration and e2e tests, run in
  CI only).
- An endpoint can take `message.status` only for the messages some kinds of senders sent (ADR-172),
  chosen the same way: members, automations, campaigns, the API or HyFib. The list is checked
  against those five (a contact sends no status), kept only while the endpoint takes
  `message.status` (a database check too, which also refuses a null entry), and applied in
  `app.capture_webhook_event` with the sender of the message the change itself updated, passed by
  its trigger in the same transaction: it narrows what one endpoint receives and never adds an event
  or a delivery for another endpoint or company. The sender passed is not stored with the event.
  Audited with the list (unit tests; integration and e2e tests, run in CI only).
- An endpoint can take the message and conversation events of chosen teams' conversations only
  (ADR-174), chosen the same way. A list may add only teams of the endpoint's company (checked in
  its scope), is kept only while the endpoint takes such an event (a database check too, which also
  refuses a null entry), and is applied in `app.capture_webhook_event`, which reads the
  conversation's team in the company's scope (the definer role through its column grant): it narrows
  what one endpoint receives and never adds an event or a delivery for another endpoint or company.
  A team deleted later stays on the list and matches nothing, so a list never widens by itself.
  Audited with the list (unit tests; integration and e2e tests, run in CI only).
- An endpoint can take the statuses and changes of chosen templates only (ADR-175), chosen the same
  way. A list may name only templates of the endpoint's company (checked in its scope whenever a
  list is given; templates are never deleted), is kept only while the endpoint takes
  `message.status` or `template.status_changed` (a database check too, which also refuses a null
  entry), and is applied in `app.capture_webhook_event` to the template the triggers pass: it
  narrows what one endpoint receives and never adds an event or a delivery for another endpoint or
  company. A refusal tells a key with `webhooks.manage` only whether an id it gives is one of its
  company's templates. Audited with the list (unit tests; integration and e2e tests, run in CI
  only).
- An endpoint can take the events of the conversations assigned to chosen members only (ADR-181),
  chosen the same way. A list may add only members of the endpoint's company who take conversations
  (active, with a role that reads and answers them; checked in its scope), is kept only while the
  endpoint takes a message or conversation event (a database check too, which also refuses a null
  entry), and is applied in `app.capture_webhook_event`, which reads the conversation's member in
  the company's scope (the definer role through its column grant): it narrows what one endpoint
  receives and never adds an event or a delivery for another endpoint or company. A member who stops
  taking conversations stays on the list and matches nothing while holding none, so a list never
  widens by itself. Settings names the members to members with `developer.manage` only, and a
  refusal tells a key with `webhooks.manage` only whether an id it gives is such a member. Audited
  with the list (unit tests; integration and e2e tests, run in CI only).
- An endpoint can take the run events of the runs started by chosen triggers only (ADR-183), chosen
  the same way. A list holds only known triggers (never `test`: members' test runs send nothing), is
  kept only while the endpoint takes a run event (a database check too, which also refuses a null
  entry), and is applied in `app.capture_webhook_event` to the trigger the run's own trigger passes,
  which no role can change: it narrows what one endpoint receives and never adds an event or a
  delivery for another endpoint or company. The trigger passed is not stored with the event. Audited
  with the list (unit tests; integration and e2e tests, run in CI only).
- An endpoint can take the changes of chosen custom fields only (ADR-184), chosen the same way. A
  list may add only keys of the endpoint's company's fields (checked in its scope), is kept only
  while the endpoint takes field changes (a database check too, which also refuses a malformed key
  or a null entry), and is applied in `app.capture_contact_webhook_event` to the parts the triggers
  name: it narrows what one endpoint receives and never adds an event or a delivery for another
  endpoint or company. Audited with the list (unit tests; integration and e2e tests, run in CI
  only).
- An endpoint can take the message statuses and changes of chosen campaigns only (ADR-185), chosen
  the same way. A list given may hold only campaigns of the endpoint's company (checked in its
  scope), is kept only while the endpoint takes `message.status` or `campaign.status_changed` (a
  database check too), and is applied in `app.capture_webhook_event` to the campaign the triggers
  pass: it narrows what one endpoint receives and never adds an event or a delivery for another
  endpoint or company. A message's campaign travels in the detail to the capture only and is not
  stored with the event; the payload's `campaignId` is read from the message in the company's scope
  when the delivery is prepared, an id without personal data. Audited with the list (unit tests;
  integration and e2e tests, run in CI only).
- An endpoint can take chosen consent changes only (ADR-189), chosen the same way. A list holds only
  the four known changes, is kept only while the endpoint takes `consent.changed` (a database check
  too, which also refuses a null entry), and is applied in `app.capture_webhook_event` to the
  purpose and action the consent trigger stores: it narrows what one endpoint receives and never
  adds an event or a delivery for another endpoint or company, and an event still holds no personal
  data. Audited with the list (unit tests; integration and e2e tests, run in CI only).
- An endpoint can take the added contacts from chosen sources only (ADR-190), chosen the same way. A
  list holds only the five known sources, is kept only while the endpoint takes `contact.created` (a
  database check too, which also refuses a null entry), and is applied in
  `app.capture_contact_webhook_event` to the source of the contact the insert added, read in the
  company's scope: it narrows what one endpoint receives and never adds an event or a delivery for
  another endpoint or company. Audited with the list (unit tests; integration and e2e tests, run in
  CI only).
- An endpoint can take the received messages of chosen types only (ADR-191), chosen the same way. A
  list holds only the fourteen types a received message has, is kept only while the endpoint takes
  `message.received` (a database check too, which also refuses a null entry), and is applied in
  `app.capture_webhook_event` to the type the message trigger stores: it narrows what one endpoint
  receives and never adds an event or a delivery for another endpoint or company. Audited with the
  list (unit tests; integration and e2e tests, run in CI only).
- An endpoint can take the runs of an end that ended for chosen reasons only (ADR-192), chosen the
  same way. A list holds only the 21 reasons a run ends for, is kept only while the endpoint takes
  `automation.run_ended` and only with reasons of the ends it takes (a database check too, which
  also refuses a null entry), and is applied in `app.capture_webhook_event` to the reason the run
  trigger stores: it narrows what one endpoint receives and never adds an event or a delivery for
  another endpoint or company. Audited with the list (unit tests; integration and e2e tests, run in
  CI only).
- Conversation and contact events (ADR-074) follow the same rules. Conversation events name the
  member and the team by id only (ADR-094), the ids the API gives `conversations.read` keys
  (ADR-093): names are read through `GET /members` and `GET /teams` with such a key, and no email or
  role is sent. Contact events carry the contact in the
  API's words; an erased contact, whichever event is delivered, has only its id, source and creation
  time. `contact.erased` deletes the created and updated events its own transaction captured, with
  their deliveries: `app.capture_contact_webhook_event` can delete only as the definer role that
  erasure runs as (the company role has no delete on webhook events, tested). One contact event per
  contact and transaction keeps imports and tag changes from multiplying deliveries. Since ADR-112
  a change of a custom field's value captures `contact.updated` too (a trigger compares the company's
  field keys only, as the role that made the change), and the payload carries the values; a field's
  deletion sends nothing for each contact it removes the value from. Since ADR-121 the event names
  what its transaction changed (`name`, `phone`, `email`, `tags`, `fields.<key>`), never a value,
  so events still hold no personal data. Stored events stay history: a later change in the same
  transaction adds to the event through `app.add_contact_webhook_changes`, a definer function that
  updates only an event the calling transaction captured (which no delivery can have read); the
  company role still has no update on webhook events (tested, as is another company's event and an
  event of an earlier transaction staying as captured), and a database check keeps the list to known
  parts on `contact.updated` only.
  Since ADR-182 the event also keeps the tags its transaction added and removed, which can describe
  a person: noted through `app.note_contact_webhook_tag`, a definer function bound the same way
  (only an event its caller's transaction captured), kept no longer than the event, and cleared from
  every event of a contact when it is erased (as the definer role erasure runs as), so a delivery or
  replay after an erasure names no tag, and the payload of an erased contact carries none. A
  database check keeps the lists on `contact.updated` only (unit tests; integration and e2e tests,
  run in CI only).
- Automation run events (ADR-078) follow the same rules. They are captured for live runs only (a
  member's test run sends nothing), by triggers running as the role that changes the run (the
  runtime role, or `w360_definer` when erasure stops a run), so each event stays in the run's
  company. Payloads say what started the run, the API key for runs started through the API (as the
  inbox names keys), the status and end reason, and the contact as message events do; never the
  run's answers or API inputs, which can hold personal data.
- Order events (ADR-085) follow the same rules. Triggers on WhatsApp orders run as the role that
  adds the order or changes its status (only the runtime role, in the company's scope), so each
  event stays in the order's company and holds the order id and statuses only. Payloads are built
  when delivered: the customer's note, number and name are gone once the contact is erased (erasure
  clears the note without a status change, so it sends nothing), amounts are integers in minor
  units, and no Payment Link address or Razorpay payment id is sent.
- Campaign events (ADR-087) follow the same rules. The trigger on campaigns runs as the role that
  changes a campaign's status (only the runtime role, in the company's scope), so each event stays
  in the campaign's company and holds the campaign id, the statuses and a pause or completion reason
  only. Payloads carry the campaign's name, template, times and counters, never a recipient, a
  contact's data or the member who acted. Since ADR-150 they also carry its results as
  `GET /campaigns/{id}` counts them, counted in the company's scope when the request is built and
  stored nowhere: counts, skip reasons and failure codes only, never costs. Who receives them is
  unchanged: owners and administrators, who manage endpoints, read campaigns anyway, and keys with
  `webhooks.manage` are granted only by them and already receive the campaign's counters and the
  company's messages.

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

Phase 5 rules (rate change notices, P5-07, ADR-065):

- The minute sweep finds due companies only through `ops.rate_change_notices_due`: owned by
  `w360_definer`, executable only by `w360_app`, returning company and card ids. The definer role
  may read only the id, currency, status and effective time of published cards (column grants and a
  policy), each company's id and billing currency, and which card each company was told about. It
  cannot read card sources or notes, other messaging settings or when a notice was sent.
- The ids are never taken from a request. Each pair is checked again in the company's own RLS scope
  before anything is written, and the email goes only to the company's owners and billing managers
  through the encrypted outbox, in the transaction that records the notice. Records are unique per
  company and card and append-only (no update or delete grant; a trigger), exported with the company
  and deleted with it.
- The notice shows Meta's published list prices and says they are estimates: nothing is charged,
  posted or held.

Phase 5 rules (API key expiry reminders, P5-08, ADR-067):

- The minute sweep finds due keys only through `ops.api_key_expiry_reminders_due`: owned by
  `w360_definer`, executable only by `w360_app`, returning company and key ids. It reads keys the
  definer role could already read for authentication; it returns no token hash, name or address.
- The ids are never taken from a request. Each key is locked and checked again in its company's own
  RLS scope (usable, not rotated, not reminded, expiring within 7 days, the company not being
  deleted) before anything is written. The runtime role may set only `expiry_reminded_at` beyond the
  key columns it already managed, and the key's guard keeps the mark once set, so a key is reminded
  once.
- The email goes only to the company's active owners and administrators (the roles that manage
  keys), through the encrypted outbox, in the transaction that sets the mark. It names the key by
  its name and public prefix; the token is never stored, so it cannot be sent. The name is put on
  one line for the subject.

Phase 5 rules (rate limit buckets, P5-08, ADR-068):

- The public API's limits are domain functions the web gate calls: failed authentication per
  client address (unknown addresses share one bucket), then each request per key and per company;
  a request its key refuses takes nothing from the company's bucket. Integration and e2e tests
  exercise them.
- Buckets that are full again are deleted by the minute sweep through
  `ops.purge_rate_limit_buckets` (SECURITY DEFINER, executable by `w360_app` only). Only the definer
  role may delete buckets; a bucket taken from after it was listed is checked again and kept, and a
  full bucket behaves exactly like a missing one, so no limit changes. A client address counted
  for failed authentication is kept only while it limits (at most about 100 seconds after its last
  failed attempt, plus a minute).

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

Phase 5 rules (refund requests from companies, P5-05, ADR-073):

- A request moves no money and holds no credit. Only a platform owner's approval starts a refund,
  and it goes through `ops.platform_request_credit_refund` in the same transaction, so every rule
  above is checked again under its locks: a request asked for when the credit was there cannot take
  credit spent since, and a request that no longer fits stays open to be declined.
- Asking needs `billing.manage` and a sign-in within the last 15 minutes (ADR-056). The service
  checks the top-up, what is left of it, a refund in progress and the unused credit, and counts the
  company's requests of the last 24 hours under a per-company advisory lock (at most 5); a partial
  unique index keeps one open request per top-up, also for requests sent at once. It reads the
  company's status in the same transaction under a share lock, which `app.request_tenant_deletion`
  (locking the row for update) waits for: once deletion is asked for, also while a request is being
  made, the company cannot ask.
- The company role inserts only the columns of an open request (a column grant: no status, decision
  or notice mark) and may move an open request only to withdrawn (a restrictive policy). It reads
  the decision note but not who decided or when the emails went out (column grants). Deciding and
  the notice marks happen only in SECURITY DEFINER functions: `ops.platform_decide_credit_refund_request`
  (platform role only; it looks the session's user up as a platform owner and writes the platform
  audit log in the same transaction), and the two marks for the worker.
- Platform owners are emailed a count only (no company, amount or reason), through the encrypted
  outbox and not tied to a company. A declined request is emailed to the company's billing managers
  with the note, in the company's own scope. Each email is marked in the transaction that queues it,
  so it is sent once.

Phase 5 rules (refund requests of plan payments, P5-07, ADR-104):

- As for service credit: a request moves no money and changes nothing about the plan. Only a
  platform owner's approval starts a refund, through `ops.platform_request_plan_payment_refund`
  (ADR-103) in the same transaction, so what Razorpay has not refunded of the payment, a refund in
  progress and a company being deleted are checked again under its lock; a request that no longer
  fits stays open to be declined. A refund never changes the plan or the subscription.
- Asking needs `billing.manage` and a sign-in within the last 15 minutes (ADR-056). The service reads
  the company's plan payment in its own scope (RLS; a composite foreign key keeps a request on the
  company's own payment), what Razorpay has not refunded of it and a refund in progress, and reads
  the company's status under the same share lock as requests of service credit. Requests of both
  kinds count towards one limit of 5 in 24 hours, under the advisory lock requests of service credit
  already take (the same key, so servers of both releases serialise during a rolling deploy); a
  partial unique index keeps one open request per payment.
- The company role inserts only the columns of an open request and may move an open request only to
  withdrawn (a restrictive policy); it reads the decision note but not who decided or when the
  emails went out (column grants), and cannot delete a request. Deciding and the notice marks happen
  only in SECURITY DEFINER functions: `ops.platform_decide_plan_payment_refund_request` (platform
  role only; it looks the session's user up as a platform owner and writes the platform audit log in
  the same transaction) and the marks for the worker, the decline mark taking only the current
  company's request.
- Platform owners' email about waiting requests counts both kinds (no company, payment, amount or
  reason). A declined request is emailed to the company's billing managers with the note, in the
  company's own scope, marked in the transaction that queues it. The platform lists read through
  functions that check `ops.platform_admins`; the refund's staff reason ("Asked for by the company:"
  and the company's reason) stays platform-only, as ADR-103's reasons do.

Phase 5 rules (companies choose their plan, P5-01, ADR-105):

- Only platform owners offer a plan version or stop offering it, checked by the platform service as
  every catalog change is (the platform role is shared by owners and operators), with the platform
  audit log in the same transaction. The platform role may write only the two offer columns of a
  published version (a column grant and the plan guard, which compares every other term); check
  constraints keep the offer to published versions priced at ₹1 or more and pair it with the user
  who made it; retiring a version must clear its offer in the same update.
- A company changes its plan only through `app.choose_plan` (SECURITY DEFINER, pinned
  `search_path`, executable by `w360_app` alone). It takes the company and the member from the
  session's company scope (`app.current_tenant_id()`, `app.current_user_id()`), never from an
  argument, so a forged form names at most a plan version. It refuses, under its locks, a company
  suspended or being deleted, complimentary access, a paid period, a subscription that may still be
  charged, a version that is not offered and a platform without the tax on plan prices; it changes
  only the version, the note and who changed it, and the plan state's own guard keeps the add-ons
  sold by the chosen version. The company role has no update privilege on its plan state, as
  before.
- The service needs `billing.manage` and a sign-in within the last 15 minutes (ADR-056), and
  refuses while Razorpay subscriptions are off. It takes the advisory locks that additions take
  (seats, numbers, teams, automations, in that order) before the function's locks, then counts what
  the company uses against the chosen version and rolls the change back when it holds less, so an
  addition and a choice never both pass, and refuses a version the company could not pay for with
  its add-ons and the tax. Lock order: the limit locks, the subscription-start lock, the company row
  (shared), the plan state (for update), as the plan sweep and staff changes take them, then the
  chosen version's advisory lock (shared). The plan guard takes that lock exclusively whenever a
  published version stops being offered (withdrawn, or retired), so a choice either commits before
  the change or sees it and is refused; a withdrawal or retirement takes no company lock, so the
  two never wait for each other in a cycle (migration 0083).
- A choice replaces the version a subscription start would record only before the start takes its
  lock; afterwards it is refused (a subscription that may still be charged), so Razorpay is never
  asked to charge for a version the company no longer has.

Phase 5 rules (companies choose their add-ons, P5-01, ADR-106):

- A company changes its add-ons only through `app.choose_add_ons` (SECURITY DEFINER, pinned
  `search_path`, executable by `w360_app` alone), which takes the company and the member from the
  session's company scope, never from an argument, so a forged form names at most three
  quantities. It refuses, under the locks of `app.choose_plan`, everything that function refuses
  except the offer, and a version that is no longer published; it changes only the quantities, the
  note and who changed them, and the plan state's guard keeps them to what the version sells,
  within its maximums. The company role has no update privilege on its plan state, as before.
- The service needs `billing.manage` and a sign-in within the last 15 minutes, refuses while
  Razorpay subscriptions are off, and accepts whole numbers only (digits, within the table's
  bounds). It takes the advisory locks that additions take before the function's locks, then counts
  the seats (with waiting invitations) and WhatsApp numbers in use after a decrease and rolls it
  back when they no longer fit, so an addition and a decrease never both pass; an increase is never
  refused for what is in use. A total with the tax above one plan payment is refused.
- A change of add-ons replaces the quantities a subscription start would record only before the
  start takes its lock; afterwards it is refused, so Razorpay is never asked to charge for add-ons
  the company no longer has.

Phase 5 rules (a price list for visitors, P5-01, ADR-107):

- Only platform owners show or hide the price list, checked by the platform service as every
  catalog change is, with the platform audit log in the same transaction. The platform role may
  write only when the list was shown and by whom (a column grant), and a check constraint pairs the
  two, so a shown list always names the owner who showed it.
- `/pricing` reads in the system scope as `w360_app`, in a read-only transaction, without a
  function: the commercial terms of the versions that are published and offered (name, description,
  prices, limits, add-on prices, modules, and whether the API is limited, never who created,
  published or offered them), and of the settings only whether the list is shown, the tax on plan
  prices and the default trial. Migration 0085 grants the runtime role those two settings columns
  only; it cannot read who showed the list, nor write any setting.
- The page shows nothing about any company or person, and is not found while the list is hidden or
  while a visitor could not follow it: paying for plans off, no tax, no default trial, or no offered
  version one plan payment can cover. Its links lead only to sign-in and sign-up, and search engines
  are asked not to index it, as for every page.

Phase 5 rules (paying companies change their plan from the next period, P5-01, ADR-109):

- A change never lets two subscriptions charge a company: the current subscription is cancelled at
  the end of its cycle at Razorpay before HyFib records the new one, and the unique index on live
  subscriptions now allows only one that is not ending at its period's end. A change is refused
  within 48 hours of the period's end, before Razorpay starts the renewal debit (R-073).
- The new subscription is written by the runtime role in the company's own scope, so the guard
  trigger checks what the service checked: the subscription it follows paid the plan's current
  period and charges no more after it, the new one starts exactly at that period's end, the company
  is not suspended or being deleted, the version is offered or the company's own and published, the
  add-ons are within what it sells, and the price is the version's for those add-ons with the tax
  set now. Nobody can update which subscription it follows (no column grant).
- The plan takes another version or other add-ons from a subscription only when that subscription
  follows the one that paid the plan's period and its own cycle was paid, as Razorpay reports when
  asked; a cycle of another subscription that ends no later than the plan's paid period is never
  applied, so a late renewal cannot take the plan back. The plan guard lets a retired version in only
  as the plan of that following subscription, with its paid cycle.
- The service needs `billing.manage` and a sign-in within the last 15 minutes, accepts whole numbers
  only, and refuses before cancelling anything: a version that holds less than the company has, add-
  ons the version does not sell or beyond its maximums, and a total one plan payment cannot cover.
  Staff cancels and company deletion cancel every subscription that may still charge.

Phase 5 rules (packs of extra API requests, P5-01/P5-08, ADR-110):

- A version sells API request packs only with a monthly API request limit above 0, with both a size
  and a price; check constraints hold this for every writer (a NULL limit included), and the plan
  guard keeps a published version's packs. The platform role may update the two columns of a draft
  only (column grant), and `api_request_packs` of a plan state, which the plan state's guard keeps
  to versions that sell packs.
- No limit with packs passes 2,000,000,000: the plan state's guard and the guard of a following
  subscription refuse more packs of either kind, summing in 64 bits, so nobody (staff, a company's
  function, a following subscription's paid cycle) can store a plan state whose entitlements leave
  the integer range. The sweep's lookups compare in 64 bits, so one plan state cannot stop them for
  every company.
- Companies set their packs only through `app.choose_add_ons` (four quantities; SECURITY DEFINER,
  pinned `search_path`, `w360_app` alone, the company and member from the session's scope), under
  ADR-106's conditions and locks. The three-quantity function kept for a deploy leaves the packs
  unchanged.
- A subscription that follows none is refused unless its version and add-ons are the company's plan
  state's (`app.guard_plan_subscription_start`, invoker rights, executable by nobody), so a payment
  is never taken for add-ons the company does not have, nor a company left with add-ons it did not
  pay for, whichever server recorded the subscription.

Phase 5 rules (usage warnings at a share the company chooses, P5-01, ADR-144):

- Only members with `billing.manage` (owners and billing managers) choose the share, re-checked by
  the service; administrators, who read billing, and every other role are refused. No recent
  sign-in is asked: the share moves no money and changes no access, and the notices at a limit
  itself do not depend on it. Each change is in the company's audit log with the share before and
  after (`billing.usage_warning_changed`); choosing the current share writes nothing.
- The runtime role gains `UPDATE` on `app.tenants.usage_warning_percent` alone (a column grant) and
  reaches only its company's row (RLS); a check constraint keeps the share to 50% to 95% in steps of
  5 for every writer, and the service refuses anything else with one message.
- The share moves only when a warning comes, never how often: the sweep still warns each counter at
  most once per period, under the counter's lock, after reading the company's share again in the
  company's scope, so a share raised after the sweep listed a counter is respected.
  `ops.usage_warnings_due` (SECURITY DEFINER, pinned `search_path`, `w360_app` alone) still returns
  ids only. API keys' own limits keep their 80% email (ADR-098).

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
- Alerts (ADR-066) go to platform owners only, through the encrypted outbox, not tied to a company.
  They name days, counts by status and a failed run's last error (HyFib's own description of
  Razorpay's answer), never a transaction id, amount or company; the details stay on the page, behind
  platform sign-in and two-factor authentication. The worker reaches the runs and the owners'
  addresses only through three SECURITY DEFINER functions executable by `w360_app` alone: the listing
  returns ids, the mark writes only `alerted_attempt` and returns the email's content, and the
  recipients function returns platform owners' ids and addresses.
- Alerts about payments no settlement showed (ADR-071) follow the same rules: platform owners only,
  counts and payment days only, never a company, amount or payment id. The worker reaches them only
  through a listing (payment ids) and a mark (which checks each payment again and records it), both
  SECURITY DEFINER and executable by `w360_app` alone; the runtime roles have no privileges on
  `ops.settlement_unsettled_alerts`, and the shared definition of an unsettled payment runs only
  inside definer functions.

Platform roles (`ops.platform_admins`): `platform_owner` and `platform_operator`. Both require MFA;
all actions are audited; neither can read customer content without a support grant. Both see a
company's service credit (balances, paid top-ups, refunds) and the settlement reconciliation, which
are payment data about HyFib's own charges, and the companies' refund requests; only platform owners
refund unused credit (ADR-058), decide refund requests (ADR-073, ADR-104), run or resolve reconciliations
(ADR-059) and schedule or cancel a company's deletion (ADR-090). Only platform owners set the tax on plan prices and
cancel a company's plan subscription at Razorpay (ADR-063), and staff cannot change a company's plan
while its subscription can still be authorised or charged. Only platform
owners change the plan catalog (create, edit and publish versions, retire them, choose the default
trial, offer versions to companies and stop offering them, ADR-105); owners and operators put companies on plans and end them, with a reason shown in the
company's audit log and emailed to its billing managers (ADR-100). The platform role only marks the
change (`app.tenant_plans.staff_notice_version`, a column grant); the worker queues the emails from
the company's own scope (`ops.plan_change_notices_due`, and `app.take_plan_change_notice`, which
takes only the current company's notice), so the platform role gains no outbox, queue or
member-address access, and the runtime role can neither set nor clear the mark. A platform owner's
cancellation of a company's subscription is told the same way (ADR-101): the platform role marks it
(`app.plan_subscriptions.staff_cancel_notice_due`), and the worker lists the marks
(`ops.plan_subscription_cancel_notices_due`) and takes each in the company's own scope
(`app.take_plan_subscription_cancel_notice`, which clears only the current company's mark and needs
the definer's update grant on that one column). Reactivating a
suspended company whose plan has lapsed makes it restricted, and only a plan change lifts a
restriction.

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
  `failed`, `quarantined` or processing with its last attempt's lease run out (since 0068), only
  while its body is kept) and resolving a quarantine entry each need a written reason and write
  `ops.platform_audit_events` in the same transaction. Neither reads or changes company data.
- Dead letter retries (ADR-108): `ops.platform_retry_dead_letter` (owned by `w360_definer`,
  executable only by `w360_platform`, `W3403` unless the session's user is a platform
  administrator) sends a dead letter's failed job back to its queue once, with a written reason of
  10 to 2,000 characters, marks the dead letter with who retried it and when (a check pairs the
  two; only the definer may write them) and writes `ops.platform_audit_events`, in one transaction.
  It refuses a dead letter already retried, one whose envelope did not verify (so a forged job is
  never run again on a platform administrator's word), one of a company being deleted or gone, a
  job pg-boss no longer keeps as failed, a job of a queue that never retries
  (`billing.auto-recharge`) or of a receipt queue, and a job whose work already waits. The job runs
  again with its own signed envelope, which the worker verifies and authorizes again; the retry
  changes no company data. The migration runner grants the definer, on `pgboss.job`, SELECT on id,
  name, state and retry limit and UPDATE on state, retry limit and completion time only: it can
  read no job's data or output, and insert or delete none (tested). It also refuses a dead letter
  whose work was settled (ADR-111).
- Settling stranded work (ADR-111): the minute sweep ends the work of `channel.onboard`,
  `commerce.account` and `template.delete` dead letters in the company's own scope. The company
  comes from the dead letter, which the worker recorded only from a verified envelope, through
  `ops.dead_letters_to_settle` (SECURITY DEFINER, executable only by `w360_app`; companies being
  deleted are left out). `ops.settle_dead_letter` (SECURITY DEFINER, `w360_app` only) marks a dead
  letter only in its own company's scope (`W3403` without a company scope or an answer, `W3404` for
  another company's), only a verified one of those queues whose envelope names its own queue
  (`W3412`), and returns false when the dead letter was retried or settled, or a job for its work
  waits or runs: the sweep then rolls back the work it ended in that transaction. The work it ends
  is the company's own row, through RLS, guarded by its state. Checks keep a settled time paired
  with its answer, limit it to those queues and keep it apart from a retry. `ops.dead_letter_work_live`
  is executable by the definer only, which reads `pgboss.job.singleton_key` for it (the runner's
  grant; still no job data or output). Neither the worker nor platform staff can mark a dead letter
  directly (tested).
- Failure alerts (ADR-091): the worker emails every platform administrator counts of dead letters by
  queue, used-up receipts by provider and quarantine entries by provider and reason, never a
  company, receipt, reference or error. `ops.failure_alerts_due`, `ops.mark_failure_alert` and
  `ops.platform_failure_alert_recipients` are SECURITY DEFINER, executable only by the worker's
  role; the definer role may update only the three alert marks and the last alert's time. Each item
  is emailed once, at most one alert every 15 minutes.
- Queue waits and late-queue alerts (ADR-096): the worker's role reads `pgboss.job` (which pg-boss
  already needs) for each declared queue's count of ready jobs and the oldest one's due time, never
  a job's data, and records them through `ops.record_queue_waits`; `ops.mark_queue_alert` marks late
  queues in the transaction that queues the email. Both are SECURITY DEFINER and executable only by
  the worker's role; only the definer role writes `ops.queue_waits`, which the worker and platform
  roles read (queue names, counts and times). The email to every platform administrator names
  queues, counts, waits and limits only, at most every 15 minutes.
- Integration failure alerts (ADR-139): the worker emails every platform administrator counts of
  companies' failing integrations by kind, never a company, label, host, error or id.
  `ops.integration_failures` (the console's list) is callable only by its owner, through the
  console's function (platform administrators only) and the alert's two functions
  (`ops.integration_alerts_due`, `ops.mark_integration_alert`), which are SECURITY DEFINER and
  executable only by the worker's role; only the definer role reads and writes
  `ops.integration_alerts`. Each failure is emailed once, at most one alert every 15 minutes.
- Acknowledging integration failures (ADR-141): a platform administrator notes on the console that a
  listed failure is being handled, through `ops.platform_acknowledge_integration_failure` (SECURITY
  DEFINER, executable only by the platform role), which checks the administrator, the note (10 to
  500 characters) and that the console lists the failure in that state now, and writes the platform
  audit entry (`platform.integration_failure_acknowledged`, the note as its reason) in the same
  transaction. Only the definer role reads and writes `ops.integration_acknowledgements` (the
  failure's source, subject and state, the administrator, the time and the note); the console's
  list returns the administrator's name and the note to platform administrators only, and the
  company never sees them. An acknowledgement is forgotten an hour after its failure stops being
  listed.
- Acknowledging dead letters (ADR-169): through `ops.platform_acknowledge_dead_letter` (SECURITY
  DEFINER, executable only by the platform role), which checks the platform administrator, the note
  (10 to 500 characters, trimmed) and the dead letter, and writes the platform audit entry
  (`platform.dead_letter_acknowledged`, the note as its reason; the company only when the job's
  signature verified) in the same transaction. Only the definer role writes the acknowledgement
  columns of `ops.dead_letters`, which a check keeps together; the platform role reads them on the
  console, the company never sees them, and the CSV export gives the time only, never who or the
  note (unit tests; integration and e2e tests, run in CI only).
- Acknowledging late queues (ADR-177): through `ops.platform_acknowledge_late_queue` (SECURITY
  DEFINER, executable only by the platform role), which checks the platform administrator, the note
  (10 to 500 characters, trimmed) and that the queue is still late since the time the page showed,
  and writes the platform audit entry (`platform.late_queue_acknowledged`, the note as its reason,
  no company) in the same transaction. Only the definer role writes the acknowledgement columns of
  `ops.queue_waits`, which a check keeps together and to a late queue, and the check that finds the
  queue on time clears them. The platform role reads them on the console; the worker's role, which
  read the whole table, now reads only the check's columns; companies never see them; the CSV gives
  the time only (unit tests; integration tests, run in CI only).
- Acknowledging webhook receipts (ADR-179): through `ops.platform_acknowledge_webhook_receipt`
  (SECURITY DEFINER, executable only by the platform role), which checks the platform administrator,
  the note (10 to 500 characters, trimmed) and the receipt, and writes the platform audit entry
  (`platform.webhook_receipt_acknowledged`, the note as its reason, no company) in the same
  transaction. Notes live in `ops.receipt_acknowledgements`, which only the definer role writes and
  only the platform role reads (the runtime role, which writes receipts, has no grant on it); they
  are deleted with their receipt; the CSV gives the time only (unit tests; integration tests, run in
  CI only).
- Acknowledging quarantine entries (ADR-199): through `ops.platform_acknowledge_quarantine_entry`
  (SECURITY DEFINER, executable only by the platform role), which checks the platform administrator,
  the note (10 to 500 characters, trimmed) and that the entry is open, and writes the platform audit
  entry (`platform.webhook_quarantine_acknowledged`, the note as its reason, no company) in the same
  transaction. Notes live in `ops.quarantine_acknowledgements`, which only the definer role writes
  and only the platform role reads (the runtime role, which writes quarantine entries, has no grant
  on it); they are deleted with their entry; the CSV gives the time only (unit tests; integration
  tests, run in CI only).
- Exports beyond a tab's rows (ADR-200): a list's CSV may give more rows than its tab (up to 5,000),
  with the same checks: platform administrators only, refused before the list is read, audited with
  the row count in the same transaction, and the same allow-listed contents without people or notes
  (ADR-158).

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
- Deletion started by staff (ADR-090): `ops.platform_request_tenant_deletion` and
  `ops.platform_cancel_tenant_deletion` are owned by `w360_definer`, executable only by
  `w360_platform`, and check that the session's user is a platform owner; both need a reason of 10
  to 1,000 characters and write the platform and company audit logs (the company's names HyFib
  platform staff, never the staff member). Whoever scheduled a deletion cancels it:
  `app.cancel_tenant_deletion` refuses a staff deletion, the platform function refuses an owner's,
  and the register's check makes a cancellation's `cancelled_by` equal its `requested_by`. The
  company's emails are queued by the worker (`ops.tenant_deletion_notices_due` for the runtime role,
  and `app.tenant_deletion_mark_notified`, which marks only in the company's own scope), so the
  platform role gains no outbox, queue or member-address access. The company reads who scheduled
  and cancelled its deletion and HyFib's reasons through column grants.

## Secret and key rotation

| Secret                                      | Rotation procedure                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `W360_ENCRYPTION_KEYS`                      | Add a new key id next to the old one, make it primary (`W360_ENCRYPTION_PRIMARY_KEY_ID`), deploy: new values use the new key at once, and the worker's minute sweep seals every stored value the old key sealed again with the new one (ADR-134; RUNBOOKS §13). Remove the old key once Operations → Keys shows it seals nothing, every instance runs the new configuration and integrations have read their change feeds since.                                     |
| `W360_JOB_SIGNING_KEY`                      | Add the new key as `W360_JOB_SIGNING_KEY_NEXT` and deploy (accepted, signs nothing); once every instance runs with it, make it `W360_JOB_SIGNING_KEY` with the old one as `W360_JOB_SIGNING_KEY_PREVIOUS` and deploy: the worker signs the queued jobs the old key signed again (ADR-135). Remove the previous key once Operations → Keys shows no job that can still run signed with it (RUNBOOKS §13). Invalid-signature jobs are dropped and logged.              |
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
(deployment), edge rate limits for the public chat-link and widget routes and the API reference page,
media scanning,
OpenTelemetry alerting, independent penetration test, WebAuthn as a step-up
factor, Razorpay sandbox verification of the payment flows and Checkout CSP, and for the public
API: IP allowlists per key, monthly API quotas and reminders before keys expire; for outgoing
webhooks: fixed egress addresses that receivers can allowlist, mutual TLS and ending a rotated
secret's overlap early.
