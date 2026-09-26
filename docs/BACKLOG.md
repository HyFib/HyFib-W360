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

- **P3-01 Contacts & CRM fields**: custom fields, tags, segments (saved filters → SQL), import
  preview/mapping/row errors, dedupe, safe merge, export (formula-safe), deletion.
- **P3-02 Consent & suppression**: consent events with provenance, opt-out keywords, suppression
  lists; enforced at send time. T: opt-out during a running campaign stops queued sends (race test).
- **P3-03 Templates**: drafts, validation, submission, status sync, versioning, archive.
- **P3-04 Campaigns**: audience snapshot, approval workflow, timezone/DST scheduling, pacing,
  frequency caps, budget guardrails, pause/resume/cancel (idempotent), per-recipient outcomes,
  analytics with documented denominators. T: 10k-recipient campaign in staging.
- **P3-05 Reports**: messaging outcomes and cost estimates (versioned rate tables), inbox SLA, agent
  activity, campaign funnels; metric definitions persisted.
- **P3-06 Inbox advanced**: teams, round-robin/capacity routing, business hours, SLA timers, saved
  replies, mentions, CSAT.

## Phase 4 — automation, Flows, CRM, commerce

- **P4-01 Automation engine**: typed node graph, validation, immutable published versions, runs pinned
  to a version, durable step execution on pg-boss, budgets (steps/loops/time), test mode, handoff
  lock (bot vs human). T: restart mid-run resumes; no competing responses.
- **P4-02 HTTP node + egress guard** (shared with SEC-3).
- **P4-03 WhatsApp Flows**: Flow JSON validation, publish lifecycle, RSA key management per number,
  encrypted data endpoint (health check, error codes), response mapping.
- **P4-04 CRM**: deals, pipelines, stages, tasks, reminders, activity history.
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
  re-validation, limits) used by all outbound HTTP.
- **SEC-4** Dual-key job signing for rotation without draining.
- **SEC-5** Hash-chained audit checkpoints exported to WORM storage.
- **SEC-6** Media scanning pipeline (malware) before exposure.
- **SEC-7** OpenTelemetry tracing/metrics, alert rules (queue lag, dead letters, error rates, auth
  anomalies).
- **SEC-8** Step-up verification endpoint (password + TOTP) recorded in `ops.step_up_verifications`
  for sensitive settings (billing, security).
- **SEC-9** Per-user login history view.
