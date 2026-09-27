# Backlog

Dependency-ordered. Each item lists acceptance criteria (AC), tests (T) and prerequisites (PR).
Status values follow the feature matrix. Last updated 2026-09-26.

## Phase 1 — foundation (done; CI green on PR #1)

Workspace, DB roles/RLS, identity, companies, memberships, invitations, RBAC, MFA policy, audit,
platform administration, support grants, worker/jobs, email outbox, CSP/security headers, Docker
images, CI workflow, e2e flows. CI evidence: all jobs green on commit `e01bc26` (quality,
integration PG17/18, build, e2e on Chromium/Firefox/WebKit/mobile, security scan, container scans).

## Phase 2 — WhatsApp connection, ingestion, outbound, live inbox

Built and tested against a local Graph API stand-in (commit following `e01bc26`); every item that
talks to Meta still needs sandbox verification, which is externally blocked (Meta app, business
verification, app review, Embedded Signup configuration).

- **P2-01 Channel schema** — done. `app.whatsapp_accounts` (encrypted token in the row, AAD-bound),
  `app.channel_accounts`, `ops.provider_asset_bindings` (one active binding per external asset),
  definer resolver/bind/release functions. T: cross-company binding refused (integration).
- **P2-02 Graph API client** — done (without usage-header parsing). Pinned version, timeouts, no
  redirects, classified results (`retryable`/`permanent`/`auth`/`unknown`), tokens in headers only.
  Remaining: parse `x-business-use-case-usage` to pace management calls.
- **P2-03 Embedded Signup** — done except payment-method check and Meta-side deregistration. T:
  integration tests with the stand-in (success and six refusal paths). PR for verification: Meta app,
  config id, app review.
- **P2-04 Webhook endpoint** — done. T: e2e (bad signature → 401), smoke (oversized → 413), integration
  (dedupe, storage before processing).
- **P2-05 Webhook processor** — done for `messages` (inbound, statuses, identity changes);
  remaining: template/account/quality update fields, media download to private storage within
  Meta's retention window.
- **P2-06 Contacts & conversations core schema** — done (contacts, identities, conversations, notes,
  messages, status history, send intents, media metadata, event log) with composite FKs and FORCE RLS
  (structural tests cover the new tables).
- **P2-07 Outbound pipeline** — done for text replies inside the 24-hour window. T: success,
  idempotent resubmit, rate limit, permanent error, revoked token, dropped connection, timeout, worker
  loss before/after dispatch, company suspended, manual resolution of unknown outcomes.
- **P2-08 Tenant event log + SSE** — done. T: commit-order cursors per company (integration), live
  delivery in e2e.
- **P2-09 Inbox UI** — done: views, thread, composer with per-member-and-company drafts and
  idempotency keys, window indicator, assignment, resolve/reopen, notes, unknown-outcome decisions,
  live updates. Remaining: list virtualisation, collision warnings (phase 3 with presence), template
  picker (phase 3).
- **P2-10 Channel settings UI** — done: connect (Embedded Signup), setup progress and errors, retry,
  disconnect, quality and health time. Remaining: messaging limits and granted permissions display.
- **P2-11 Platform quarantine view** — new: list and resolve quarantined webhooks in the platform area
  (today the platform role can read and resolve them in the database only).
- **P2-12 Token health** — new: periodic `debug_token` checks and reconnect prompts before sends fail.

## Phase 3 — contacts, consent, templates, campaigns, reports

- **P3-01 Contacts & CRM fields** — _implemented (2026-09-26)_: custom fields, tags, search and
  filters, import preview/mapping/row errors, one contact per number (dedupe across manual, import
  and inbound), formula-safe export, erasure; saved segments (P3-04). **Remaining:** safe merge
  (H-019), role-based number masking (W-044), bulk tag edits.
- **P3-02 Consent & suppression** — _implemented (2026-09-26)_: consent events with provenance,
  opt-out/opt-in keywords, Meta 131050 opt-outs, suppression list, send-time enforcement (race test
  with a queued template, and with campaigns). **Remaining:** review Meta's
  opt-in guidance (M-131) and per-market consent law; consent capture from growth tools (phase 4).
- **P3-03 Templates** — _implemented (2026-09-26), not verified against Meta_: drafts, validation,
  write-ahead submission with lost-response reconciliation, Graph listing sync (webhook-triggered
  and periodic), deletion, status history, template sends from contacts and the inbox.
  **Remaining:** media headers (Resumable Upload + media storage), URL buttons with variables (the
  example format must be confirmed), named parameters, authentication/OTP, carousel, LTO, copy-code
  and catalog templates, editing approved templates (`POST /{template-id}`), template library
  (W-070), and a sandbox run with a real WABA.
- **P3-04 Campaigns** — _implemented (2026-09-26), sends verified against the Graph stand-in
  only_: saved segments (incl. campaign-response retargeting), drafts with a review panel,
  audience snapshots re-checked when queued and before dispatch, optional four-eyes approval,
  wall-clock scheduling with daylight-saving rules, sending windows, deadlines, pacing, marketing
  frequency cap, message and estimated spending caps (platform rate cards), pause/resume and
  idempotent cancel, test sends, per-recipient outcomes, last-touch reply/opt-out attribution,
  results with denominators, CSV export. Local 10,000-recipient run: snapshot 0.6 s, all recipients
  queued in 21 ticks. **Remaining:** the 10k run in staging with real dispatch, per-recipient time
  zones, A/B variants, messaging-tier awareness (read the number's limit from Meta), campaign
  sends through the public API (P5-08), media-header templates.
- **P3-05 Reports** — _implemented (2026-09-26); provider data verified against the Graph stand-in
  only_: persisted, versioned metric definitions; periods of whole days in the company time zone;
  messaging outcomes with denominators; estimated Meta charges from Meta's billable flag and
  published rate cards, with unpriced reasons; inbox queue and reply-turn response times against a
  company first-response target (turns recorded by triggers); member activity; campaign funnels;
  unavailable metrics shown with reasons; audited formula-safe exports; business-hours figures,
  resolution times and CSAT (with P3-06). **Remaining:** reconciliation with Meta's
  `pricing_analytics` (M-078, verify first), materialised daily aggregates if report queries near
  the statement timeout, scheduled report emails, retention reports once that module exists
  (automation outcomes were added with P4-01, deal outcomes with P4-04).
- **P3-06 Inbox advanced** — _implemented (2026-09-26); CSAT sends verified against the Graph
  stand-in only_: teams with members and numbers, keyword and number routing, round robin with
  explicit availability and per-member limits, a minute sweep, release when members leave;
  business hours and closed days; reply-due timers and a longest-waiting order; team, number and
  customer filters; conversation cases and resolution times; business-hours report figures; saved
  replies; note mentions; a send-time collision warning; CSAT surveys with three reply buttons.
  **Remaining:** per-team SLA targets and calendars, SLA breach notifications (email or in-app),
  presence and typing indicators, conversation tags (W-035), private team queues (would change
  visibility, ADR-029), mention emails, CSAT by template outside the window (needs a consent
  decision), CSAT with a real WABA, transcript download (W-042), phone-number masking (W-044).

## Phase 4 — automation, Flows, CRM, commerce

- **P4-01 Automation engine** — _implemented and locally verified (2026-09-27); WhatsApp sends
  verified against the Graph stand-in only_: keyword, new-conversation and any-message triggers with
  business-hours filters and cooldowns; eight step types (message, question with reply buttons,
  question with a typed answer and format check, condition, contact update, wait, hand-off, end);
  checks at save and publish (including loops that never wait); immutable published versions and
  runs pinned to them; durable one-step-per-transaction runs on pg-boss with a minute sweep for lost
  signals; budgets (steps, loops, messages, 7 days, runs per hour) and a limit on failing steps; test
  runs of the draft on a real conversation; the bot/human hand-off lock with Take over; step logs,
  captured answers with retention; an automation report section; a builder with a generated diagram
  and an in-browser simulator. T: restart and lost signals resume from the stored position; bot and
  person never answer at once. **Remaining:** Flows and catalog steps (P4-03, P4-06), starting runs from the public API or campaigns, template follow-ups outside the service
  window, fuzzy keyword matching, a drag-and-drop canvas (ADR-034), run export, usage billing for
  automation steps, a real sandbox run (release checklist).
- **P4-02 HTTP node + egress guard** — _implemented and locally verified (2026-09-27) against a
  local target server only_: "Call a web address" steps (method, address with URL-encoded
  placeholders, headers, JSON body, values saved from the response, success and failure branches);
  per-company allowed domains and encrypted write-only secrets bound to a domain (Settings → Web
  requests, `integrations.manage`, audited); calls written ahead and made once by the
  `automation.http` worker through the egress guard, unknown (never retried) when they may have been
  received without a result, cancelled when not made before the run's two-minute deadline; call
  outcomes on run pages; erasure and retention of saved values. T: egress unit suite (blocked
  ranges and notations, pinning, redirects, limits, headers), `automation-http.test.ts` (made once,
  refusals, crash and late results, timeouts, cancellation, sweep, erasure, retention, settings,
  isolation), e2e `web-requests.spec.ts`. **Remaining:** calls against a real company API in an
  authorized environment (release checklist), response headers or non-JSON bodies as values,
  retries a company opts into for idempotent requests, form-encoded bodies, OAuth client flows.
- **P4-03 WhatsApp Flows**: Flow JSON validation, publish lifecycle, RSA key management per number,
  encrypted data endpoint (health check, error codes), response mapping.
- **P4-04 CRM** — _implemented and locally verified (2026-09-27); reminder emails verified through
  Mailpit only_: pipelines (company settings, audited) with ordered stages and one currency each,
  archived instead of deleted; deals linked to a contact for life and optionally to a conversation,
  with exact minor-unit values, owners, stage moves, won/lost with a reason and reopening, all
  version-checked; a board per pipeline with owner filters and per-stage totals; won and lost
  lists; tasks with due times and reminders emailed once (durable job plus the minute sweep, skipped
  with a reason when stale, closed or the assignee lost access); notes; an append-only timeline per
  contact and deal; CRM panels on the contact page and beside a conversation; deal outcomes, win
  rate, time to win and open pipeline in reports and CSV; erasure of the CRM free text. T: reminders
  exactly once under repeated signals; erasure; isolation. **Remaining:** custom deal fields,
  products on deals, deal import and export, forecasting, moving deals between pipelines in the UI
  (the service supports it), automation steps that create deals or tasks, CRM connectors (HubSpot,
  Salesforce, Zoho: integrations), reminder emails through the production SMTP provider (release
  checklist).
- **P4-05 Growth tools**: click-to-chat links, QR codes, consent-aware website widget, referral capture.
- **P4-06 Commerce**: catalog connection, product messages, order capture, payment links with verified
  status; Shopify and WooCommerce connectors (authenticated setup, webhook verification, dedupe, sync
  recovery, uninstall).

## Phase 5 — billing, wallet, platform, public API

- **P5-01 Plans & entitlements**: platform-admin configurable plans (no hard-coded prices), trials,
  seats, quotas, add-ons; entitlement checks in services and workers.
- **P5-02 Ledger** **[built, locally verified]**: accounts, append-only journal balanced at commit,
  balances by trigger, holds, settlements, releases (expiry sweep), refunds and chargebacks as
  compensating postings; INR paise. Remaining: manual adjustments with dual approval, statements.
- **P5-03 Manual top-up** **[built; Razorpay traffic simulated by a test-only stand-in]**: top-ups,
  Razorpay orders (unique receipt), Standard Checkout, webhook processing (signature, event-id and
  body dedupe, out-of-order), authoritative fetch, credit exactly once, reconciliation sweep, expiry,
  refunds, lost disputes. Remaining: Razorpay sandbox verification; payment receipts (PDF/email).
- **P5-04 Auto-recharge** **[built; externally blocked on Razorpay Recurring Payments]**: settings
  with caps, card mandate lifecycle (₹1 authorisation refunded, token status, removal), state machine
  with write-ahead unknown states, one active attempt, caps including pending attempts,
  reconciliation before retry, cooldown, suspension after three failures, owner notices, feature
  flag `RAZORPAY_RECURRING_CARDS_ENABLED`. Remaining: step-up re-authentication for payment
  settings; "requires customer action" state if Razorpay reports AFA for a debit.
- **P5-05 Refunds, disputes, reconciliation runs, statements, receipts vs invoices.** Refunds and
  lost disputes are recorded from webhooks; initiating refunds from the platform console, daily
  reconciliation reports, statements and GST invoices remain (GST treatment needs tax review).
- **P5-06 Mandatory financial tests** **[29 integration tests + 2 e2e]**: concurrent spends on last
  funds; many low-balance triggers → one attempt; repeated and out-of-order events; timeout after
  capture (reconciliation); delayed success after UI timeout; decline; mandate revocation; cap
  exhaustion incl. in-flight; settings change during a pending charge; refund vs usage race;
  partial refunds; chargeback after spend; restart recovery; cross-company wallet access. Remaining:
  cancelled subscription with credit (needs P5-01) and AFA-required debits (not reachable while
  mandates are capped at ₹15,000).
- **P5-07 Billing screens**: overview, plans, wallet & recharge, auto-recharge, payment methods,
  usage & rate card, transactions & receipts, invoices; step-up auth for sensitive changes.
- **P5-08 Public API**: versioned REST, hashed scoped keys, rotation, quotas, idempotency keys,
  cursor pagination, OpenAPI document.
- **P5-09 Outgoing webhooks**: signing, secret rotation, delivery history, bounded retry, replay,
  SSRF guard.
- **P5-10 Platform ops screens**: onboarding failures, tenant health, usage, integration failures,
  queues and dead letters, abuse signals.
- **P5-11 Account export/deletion workflow.**

## Phase 6 — AI, calling, channels, connectors, enterprise

AI copilot (budgets, retrieval with pgvector only when shipped, prompt-injection tests); Instagram and
Messenger; SMS provider; calling (eligibility-gated); HubSpot, Salesforce, Zoho connectors; MCP
server; SSO (SAML/OIDC via maintained implementation); agency/partner features.

## Phase 7 — hardening and rollout

k6 load tests against the envelope; accessibility audit; backup restore drill; independent security
review; production rollout per RELEASE-CHECKLIST.

## Security backlog

- **SEC-1** WebAuthn/passkeys for privileged roles.
- **SEC-2** Breached-password screening at sign-up/reset (k-anonymity API or offline list).
- **SEC-3** Central SSRF-safe egress client (DNS pinning, private/metadata range blocking, redirect
  re-validation, limits) used by all outbound HTTP — _built with P4-02 (ADR-042) and used by the
  automation HTTP step; outgoing webhooks (P5-09) and imports must use it too. Remaining: a network
  egress policy as a second layer in deployment._
- **SEC-4** Dual-key job signing for rotation without draining.
- **SEC-5** Hash-chained audit checkpoints exported to WORM storage.
- **SEC-6** Media scanning pipeline (malware) before exposure.
- **SEC-7** OpenTelemetry tracing/metrics, alert rules (queue lag, dead letters, error rates, auth
  anomalies).
- **SEC-8** Step-up verification endpoint (password + TOTP) recorded in `ops.step_up_verifications`
  for sensitive settings (billing, security).
- **SEC-9** Per-user login history view.
