# Backlog

Dependency-ordered. Each item lists acceptance criteria (AC), tests (T) and prerequisites (PR).
Status values follow the feature matrix. Last updated 2026-09-26.

## Phase 1 — foundation (done, locally verified)

Workspace, DB roles/RLS, identity, companies, memberships, invitations, RBAC, MFA policy, audit,
platform administration, support grants, worker/jobs, email outbox, CSP/security headers, Docker
images, CI workflow, e2e flows. Remaining to close the gate formally:

- **P1-01 CI evidence.** AC: all CI jobs green on the PR (quality, integration PG17/18, build, e2e ×4
  projects, security, containers). T: CI. PR: none.
- **P1-02 Firefox/WebKit e2e.** AC: the existing e2e suite passes on Firefox and WebKit in CI. T: CI.

## Phase 2 — WhatsApp connection, ingestion, outbound, live inbox

- **P2-01 Channel schema.** `app.channel_accounts` (WABA, phone numbers, status, quality, limits),
  `app.channel_credentials` (encrypted BISU token, key id, rotation metadata),
  `ops.provider_asset_bindings` (unique `(provider, external_id)` → tenant), resolver function.
  AC: an external asset can bind to exactly one company; RLS + definer resolver. T: isolation tests
  for bindings; uniqueness race test.
- **P2-02 Graph API client.** Typed `fetch` client with version pinning, timeouts, retry
  classification (429/130429/131056 retryable; 131047/131026/368 permanent; 5xx retryable),
  `x-business-use-case-usage` parsing, error normalisation. AC: no token in logs/URLs. T: unit tests
  with recorded fixtures (test-only).
- **P2-03 Embedded Signup.** Onboarding session with CSRF `state`, JS SDK launch, code exchange
  within 30 s, ownership verification, binding, resumable onboarding job (subscribe app, register
  number with encrypted PIN, health check, payment-method check), reconnect, disconnect. AC: steps in
  META-SETUP §3; failures visible and retryable. T: integration tests with a provider mock
  (deterministic failures) + sandbox verification. PR: Meta app, config id, app review.
- **P2-04 Webhook endpoint.** Challenge verification, raw-body HMAC check (constant time), 4 MB limit,
  durable `ops.webhook_receipts` before 200, security events on invalid signatures, processing job.
  AC: persistence failure returns 500. T: tampered signature, oversized body, replay, DB outage.
- **P2-05 Webhook processor.** Routing via bindings, quarantine for unknown assets, idempotent upserts
  (contacts by BSUID, conversations, messages by WAMID, immutable status events with monotonic state),
  template/account/quality updates, media download to private storage (7-day window). AC: duplicate,
  delayed, batched, out-of-order, malformed and unknown-version payloads handled. T: property-style
  replay tests; worker kill mid-processing.
- **P2-06 Contacts & conversations core schema** (subset needed for inbox): contacts, channel
  identities, conversations (per company/number/contact), messages, message_status_events, media.
  Composite FKs everywhere. T: isolation suite additions.
- **P2-07 Outbound pipeline.** Send intents with client idempotency keys, per-number group concurrency
  - token bucket, send-time policy re-checks, retry/backoff with jitter, dead letters, unknown-outcome
    state and correlation, cancellation. AC: no duplicate send from retries; timeouts never blindly
    retried. T: worker death before/after provider call, 429 storms, expired token, company suspended
    mid-queue.
- **P2-08 Tenant event log + SSE.** `app.tenant_events` with xid8 cursor, LISTEN/NOTIFY hint
  connection, SSE route with replay and membership re-validation, polling fallback. AC: no missed
  events across reconnects; revoked member's stream closes. T: concurrency tests for cursor gaps.
- **P2-09 Inbox UI.** Conversation list (virtualised), thread view, composer with per-company drafts
  (memory/sessionStorage keyed by user+company), service-window indicator, template picker (phase 3
  templates), assignment, notes, collision warnings. AC: keyboard accessible; responsive. T: e2e with
  mock provider in CI + sandbox manual check.
- **P2-10 Channel settings UI.** Connection status, quality, limits, permissions granted, health.

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
- **P5-02 Ledger**: accounts, journal transactions/entries (sum zero), balance triggers, reservations,
  releases, settlements, adjustments; INR minor units. T: property tests for balance invariants.
- **P5-03 Manual top-up**: top-up intents, Razorpay orders (unique receipt), hosted checkout, webhook
  processing (signature, event-id dedupe, out-of-order), authoritative fetch, credit exactly once;
  states pending/succeeded/failed/expired/disputed/partially refunded/refunded.
- **P5-04 Auto-recharge**: settings with caps, mandate lifecycle, state machine
  (disabled/armed/pending/requires-customer-action/succeeded/failed/suspended/canceled), single
  active attempt, headroom reservation incl. pending, persisted intent before provider call,
  reconciliation before retry, cooldown and failure suspension, notifications. Feature flag off until
  Razorpay activation (ADR-012).
- **P5-05 Refunds, disputes, reconciliation runs, statements, receipts vs invoices.**
- **P5-06 Mandatory financial tests** (all from the specification): concurrent spends on last funds;
  many low-balance triggers → one recharge; repeated/out-of-order events; timeout after capture;
  delayed success after UI timeout; decline; authentication required; mandate revocation; cap
  exhaustion incl. in-flight; settings change during pending charge; refund vs usage race; partial
  refunds; chargeback after spend; cancelled subscription with credit; restart recovery; cross-company
  wallet access.
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
