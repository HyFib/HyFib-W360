# Architecture decision records

Format: context → decision → consequences. Reversible assumptions are marked **(reversible)**.
Decisions that need an owner's confirmation before launch are marked **(owner confirmation needed)**.

## ADR-001 Modular monolith with web and worker processes (2026-09-26)

Context: many coupled domains (tenancy, messaging, billing), a small team, strict isolation needs.
Decision: one TypeScript pnpm workspace; business logic in framework-independent packages shared by a
Next.js web process and a worker process, each independently scalable.
Consequences: one deployable codebase, shared types; module boundaries enforced by package structure
and lint rules (e.g. only `packages/domain/src/platform` may import `@w360/db/platform`).

## ADR-002 Toolchain versions (2026-09-26)

- Node.js **24.21.0 LTS "Krypton"** (Node 26 is Current, not LTS yet; Node 22 is maintenance).
- **TypeScript 6.0.3**, not 7.0: typescript-eslint 8.70 supports `<6.1`, and TS 7's native
  compiler has a different programmatic API. (reversible — revisit when tooling supports TS 7)
- **ESLint 10** (ESLint 9 is end-of-life). `eslint-plugin-react`/`import`/`jsx-a11y` declare `^9`
  peers; jsx-a11y, react-hooks and @next/eslint-plugin-next were verified to run under ESLint 10.
- **pnpm 11.28** (mature line; pnpm 12 was one month old). pnpm 11 enforces a minimum package release
  age and requires explicit `allowBuilds` for install scripts — both kept as supply-chain controls.
- Exact versions are pinned in manifests and the lockfile is committed; Dependabot proposes updates.

## ADR-003 Next.js 16 App Router, Node runtime, dynamic rendering (2026-09-26)

Decision: Next.js 16.3 with `proxy.ts` (renamed from middleware) for per-request CSP nonces; all
pages render per request (`connection()` in the root layout) because nonces require it and all
content is user-specific; `Cache-Control: private, no-store`; `output: 'standalone'` images.
Consequence: no static caching of authenticated data; multi-replica deployments must share
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`.

## ADR-004 PostgreSQL with forced RLS as defence in depth (2026-09-26)

Decision: PostgreSQL 17/18 (CI tests both). Separate owner/app/auth/platform roles, a NOLOGIN
definer role for SECURITY DEFINER entry points, FORCE RLS on all tenant tables, column-level grants,
transaction-local context. RLS protects against application bugs; it cannot protect against a fully
compromised application process holding app credentials (documented in the threat model).

## ADR-005 Hand-written SQL migrations + Drizzle for queries (2026-09-26)

Decision: reviewed forward-only SQL files (roles, policies, triggers and functions are first-class)
with a small runner (advisory lock, checksums, per-file transactions, optional no-transaction files
for concurrent index builds). Drizzle provides typed queries only; it does not generate migrations.
Consequence: schema definitions exist twice (SQL and Drizzle); integration tests catch drift.

## ADR-006 URL-scoped company context (2026-09-26)

Decision: the company is part of the URL (`/c/{slug}`) and membership is re-verified on every page
load and action; no "active company" stored in the session. Switching performs a full page load.
Consequences: multiple tabs can safely show different companies; a stale tab cannot act in another
company; server actions re-derive the company from the slug they are given and verify membership.

## ADR-007 Better Auth for identity; tenancy in our own schema (2026-09-26)

Decision: Better Auth 1.7 (email/password, email verification, password reset, database sessions,
database rate limits, TOTP 2FA + backup codes, built-in sign-up enumeration protection). Its
organization plugin is **not** used: memberships/invitations need composite keys, FORCE RLS and
SECURITY DEFINER acceptance rules that the plugin's adapter cannot run under our roles.
Consequences: invitations and roles are our code (tested). Session tokens are stored by the library
in plaintext in `auth.sessions`; only the `w360_auth` role can read them. Enterprise SSO is phase 6.

## ADR-008 pg-boss for durable jobs (2026-09-26)

Decision: pg-boss 12 (PostgreSQL-backed, SKIP LOCKED, retries with backoff and jitter, dead letters,
group concurrency, schedules). Schema installed by the migration runner; queues declared at deploy
time with `exclusive` policies for row-keyed signals; producers can enqueue inside business
transactions; workers disable owner-only maintenance (reindex, stats partitions).

## ADR-009 One transactional email provider through SMTP (2026-09-26) (reversible)

Decision: nodemailer SMTP adapter; the production provider (e.g. Amazon SES in ap-south-1, Postmark
or Resend via SMTP) is chosen by the operator; Mailpit locally and in CI.
**(owner confirmation needed)** provider choice and sending domain (SPF/DKIM/DMARC).

## ADR-010 Application-level encryption keyring (2026-09-26)

Decision: AES-256-GCM with key ids and AAD binding (`tenant:<id>|<table>:<id>`), keys supplied by
the secret manager as environment variables; rotation by adding a new primary key and re-encrypting
in a background job. A cloud KMS envelope implementation can replace the key source later.

## ADR-011 Direct Meta billing by default (2026-09-26) (owner confirmation needed)

Context: research indicates Meta Tech Providers have no credit line; customers add their own payment
method and Meta bills them directly. Re-billing or marking up Meta charges is unconfirmed.
Decision: `tenants.billing_mode = 'direct_meta'` default; the HyFib wallet never funds Meta messaging
in this mode. `partner_billed` stays blocked until a verified partner agreement and rate schedule
exist. Tenant code cannot change the billing mode (column grants).

## ADR-012 Razorpay for India; separate mandates for subscriptions and top-ups (2026-09-26)

Decision: Razorpay Orders + hosted checkout for manual top-ups; Razorpay Subscriptions for plans;
Recurring Payments card mandates (`max_amount ≤ ₹15,000`, `frequency: as_presented`) for opt-in
auto-recharge. Auto-recharge is disabled in product until Razorpay confirms activation and
unscheduled threshold charging for our use case. Webhook signatures verified with our own
constant-time HMAC check (the SDK helper uses non-constant-time comparison).
**(owner confirmation needed)** merchant entity, activation of Recurring Payments, tax treatment.

## ADR-013 Business-scoped user ids first (2026-09-26)

Decision: channel identities are keyed by the WhatsApp business-scoped user id (`user_id`), with the
phone number optional; username/BSUID system events update identities. Never assume `wa_id` exists.

## ADR-014 Pinned Graph API version (2026-09-26) (reversible)

Decision: `META_GRAPH_API_VERSION` configuration, default `v26.0` (current per Meta's SDK source);
yearly upgrade task; webhook payload version set deliberately in the Meta app.

## ADR-015 No additional infrastructure initially (2026-09-26)

Decision: no Kubernetes, Kafka, Redis, Elasticsearch or vector database. PostgreSQL provides queues,
search (full-text) and realtime wake-ups (LISTEN/NOTIFY as hints, event table as the durable log).
Revisit only with measured need, recorded as a new ADR.

## ADR-016 Research under restricted egress (2026-09-26)

Context: the build environment blocked direct access to wati.io, developers.facebook.com,
business.whatsapp.com and razorpay.com. Decision: use search-index summaries of official pages and
official GitHub sources (Meta SDKs, Razorpay markdown docs export), label every claim with evidence
type and confidence, and require direct re-verification before launch claims.

## ADR-017 One contact per phone number per company (2026-09-26)

Decision: `contacts (tenant_id, phone_e164)` is unique. Manual entry, CSV import and inbound
WhatsApp identities resolve to the same contact; the unique index arbitrates concurrent creators
(`INSERT … ON CONFLICT DO NOTHING`, then read), so no advisory locks are needed and a 5,000-row
import does not exhaust the lock table. The Wa id Meta returns on a template send is stored as an
identity so replies from a number Meta rewrote (for example country-specific formats) still reach
the same contact. BSUID-only identities create phone-less contacts. Numbers without an
international prefix are never guessed: manual entry requires `+`/`00`, imports state how bare
numbers are read.

## ADR-018 Consent as append-only events with derived state (2026-09-26)

Decision: purposes `marketing` and `utility`. Runtime code only inserts `consent_events` (source,
actor, evidence, occurred_at); `contact_consents` is written by a SECURITY DEFINER trigger. Later
events win; an opt-out wins a tie. Meta timestamps are whole seconds, so a customer's opt-out is
placed at the end of its second and an opt-in at the start: within that uncertainty an opt-out wins.
Imports record opt-ins only with the importer's attestation and never over an existing opt-out.
Marketing templates need a recorded opt-in by default (company setting); service-window replies are
never blocked by consent. Enforcement happens when a template is queued and again, authoritatively,
right before dispatch.

## ADR-019 Templates: Graph listing is the source of truth (2026-09-26)

Decision: template webhooks (payloads documented only by third parties) only mark the WABA for a
re-sync; status, category, quality and rejection reasons come from `GET /{WABA_ID}/message_templates`.
Submission is write-ahead (`submitting` before the request). A lost response is adopted by name and
language at the next sync; a submission Meta never received fails after 10 minutes and must be
resubmitted by a member. Nothing is resubmitted automatically. Scope for the first slice: text
headers, positional variables, static buttons; everything else is shown as not sendable.

## ADR-020 CSV without a dependency (2026-09-26) (reversible)

Decision: an in-house RFC 4180 reader/writer (quoted fields, doubled quotes, embedded line breaks,
CRLF/LF/CR, BOM, delimiter detection; hard limits on bytes, rows, columns and field length) and a
formula-safe writer. Import runs through a server action, so files are limited to just under the
1 MB action body limit; larger imports would need a streaming upload endpoint.
