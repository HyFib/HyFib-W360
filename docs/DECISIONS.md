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

## ADR-021 Campaign audiences: frozen snapshot, live checks (2026-09-26)

Decision: submitting a campaign inserts one `campaign_recipients` row per matching contact (the
snapshot), classified with the same SQL the review screen shows (pending, or skipped with a
reason). Recipients hold ids and outcomes only; phone numbers and variable values are read live
when the runner queues them, so erasure and later edits apply. Every recipient is checked again
when queued (erasure, number, suppression, consent, variables, frequency cap, spending cap) and by
the send worker right before dispatch (consent, suppression, template approval, campaign status).
Alternatives: snapshotting phones and values (stale data, erasure would have to rewrite campaign
rows) or evaluating the segment at send time (the audience a member approved could silently
change). Limit: 50,000 recipients per campaign until load tests (phase 7) justify more.

## ADR-022 Campaign runner on the existing send pipeline (2026-09-26)

Decision: a `campaign.run` job ticks every 10 seconds per running campaign (self-rescheduled; the
per-minute sweep re-signals lost ticks through `ops.campaigns_due`). A tick holds the campaign's
row lock and a per-company advisory lock, so two campaigns of one company never race on the
frequency cap, and queues at most `rate_per_minute`-worth (or the number's rate) of recipients,
bounded by 500 per tick and by sends still waiting in the queue. Each recipient becomes an ordinary
message + send intent + `message.send` job, so pacing per number, unknown-outcome handling and
send-time policy checks are the Phase 2 ones. Campaign threads are created resolved, so they do
not flood the open inbox; a reply reopens them. Pause and cancel cancel unclaimed send intents in
the same transaction as the status change (row locks make "claimed or cancelled" exclusive); a send
that returns to the queue after a retryable error meets a claim-time campaign check.

## ADR-023 Rate cards entered by platform staff; estimates, not charges (2026-09-26)

Decision: Meta prices are not shipped with HyFib. Platform administrators copy Meta's published
rate card for a currency into `ops.rate_cards` (market, calling codes, price per category, source
URL, effective time); cards are immutable once published (triggers) and corrected by withdrawal
plus a new card. Prices are integer millionths of the major unit because per-message prices are
fractions of a minor unit. Estimates use the card in force when a message is queued, the list price
(tier 0) and assume every message is charged: an upper bound, since Meta charges delivered messages
and free windows and volume tiers are not applied. Spending caps compare these estimates; Meta bills
the company directly (ADR-011), so no wallet funds are reserved for campaign sends.

## ADR-024 Approval and sending authority (2026-09-26)

Decision: companies can require approval; the approver must hold `campaigns.approve` and differ
from the member who submitted. Sends run under the submitter's authority (the member who resumes a
paused campaign takes over). The runner pauses the campaign when that member leaves the company or
loses `campaigns.send`, so revoking a member stops their campaigns, like their other queued work.

## ADR-025 Campaign attribution: last touch within 72 hours (2026-09-26)

Decision: a reply (any inbound message except reactions and system notices, on the same number) or
a marketing opt-out is attributed to the most recent campaign message queued to that contact in the
72 hours before it, once, and recorded on the recipient row when it arrives. Clicks and conversions
are reported as not measured: Meta does not report website-button taps, HyFib does not rewrite
links, and no conversion source is connected. Metric definitions are versioned (ADR-026 when
reports persist them). Only a message WhatsApp accepted can be credited (a failed or unsent message
cannot have caused a reply or an opt-out; Meta's 131050 failure means the customer had already
stopped marketing messages), and the reply and opt-out rates count delivered recipients only, so
they never exceed their denominator.

## ADR-026 Reports: computed on request under persisted definitions (2026-09-26)

Decision: reports are computed when requested from the operational tables, in one repeatable-read
read-only transaction under the company's RLS scope, rather than from pre-aggregated tables. Each
reported number follows a row in `ops.metric_definitions` (numerator, denominator, window, time-zone
rule, missing-data semantics, freshness); rows are immutable and a change is a new version in a new
migration, kept equal to the code registry by a test. Periods are whole days in the company's time
zone, at most 92 days. Metrics HyFib cannot measure are persisted as unavailable with the reason and
shown instead of a number. Reconsider materialised daily aggregates when a company's report queries
approach the statement timeout (the `(tenant_id, created_at)` message index and the turn indexes
bound today's queries); the definitions stay the contract either way.

## ADR-027 Reply turns maintained by database triggers (2026-09-26)

Decision: response times are measured on reply turns (first customer message without a member reply
→ member reply or resolve) recorded in `app.conversation_turns` by triggers on `app.messages` and
`app.conversations` instead of by each caller, so inbox replies, template sends, ingestion and any
future write path are covered identically; a partial unique index keeps one open turn per
conversation under concurrent inbound messages. A reply counts when the member sends it (a later
WhatsApp failure shows in the messaging report, not as an unanswered turn). Times are absolute;
business-hours calendars are a later extension (H-011). Turns started before the release are not
reconstructed.

## ADR-028 Estimated Meta charges from Meta's pricing object (2026-09-26)

Decision: the messaging report estimates charges only for delivered messages that Meta's status
webhook marked `billable` (research M-065, M-076), at the list price of the published rate card in
force when each message was recorded, by the market of the number Meta delivered to and Meta's
pricing category. Messages Meta marked free, messages without pricing yet and billable messages that
cannot be priced are counted by reason, never estimated. Volume tiers are not applied, so the
estimate can exceed the invoice for utility and authentication; Meta's invoice is authoritative.
Reconciling with Meta's `pricing_analytics` (M-078, SDK-sourced, not verified) is backlog. A
campaign's estimate currency is fixed the first time it prices a message.

## ADR-029 Teams route conversations but do not change who can read them (2026-09-26)

Decision: teams are routing groups. A conversation's team decides who receives it (number team,
keyword team, round robin with availability and limits); visibility stays with the permission
matrix (`inbox.read_all`, or `inbox.read_assigned` for assigned-to-me plus the unassigned queue).
Making team queues private would change live-update routing (events carry only the assignee) and
every visibility check at once; it is a separate, reviewed change if customers need it. Routing
runs under one advisory lock per company taken after conversation row locks (end of a webhook batch;
the sweep uses one transaction per conversation), so limits and rotation hold under concurrency.
Availability is an explicit switch that defaults to off: automatic assignment to someone who is not
working is worse than a waiting queue that the sweep drains when they start. A reopened conversation
keeps its assignee; members who leave, are suspended or lose inbox access have their conversations
returned to the queue.

## ADR-030 Business hours apply to the target; absolute times stay reported (2026-09-26)

Decision: when business hours are on, the first-response target (inbox timers, "answered within
target" v2, "overdue") counts opening hours only; first response is reported both in absolute time
and in business hours (new definition), and resolution time in absolute time. Reports apply the
company's current calendar to the whole period, stated in the definitions, instead of versioning
calendars; the calendar is company-wide (per-team calendars and targets are backlog). Definitions
whose text said business hours were not supported got new versions (v2) rather than edits.

## ADR-031 Conversation cases maintained by triggers (2026-09-26)

Decision: resolution time is measured on cases (open → resolve) recorded in
`app.conversation_cases` by triggers on `app.conversations`, for the same reason as reply turns
(ADR-027): every write path is covered and the rows are immutable once resolved. Conversations that
were already open when migration 0009 ran get their first case when they are next reopened; no
cases are reconstructed.

## ADR-032 CSAT through interactive reply buttons inside the service window (2026-09-26)

Decision: a resolve by a member sends one question with three reply buttons (research M-157:
1 to 3 buttons, titles up to 20 characters, ids up to 256), only inside the 24-hour customer service
window, only to contacts who have not opted out of non-marketing messages (the utility consent
check used for templates), at most once per conversation per 24 hours, re-checked at send time.
Outside the window nothing is sent (a template-based survey would be a business-initiated charge
and needs its own consent decision). Every resolve records a survey row, sent or skipped with the
reason, so coverage is reportable. The answer is the first tap whose button id and `context.id`
(M-158) match the conversation's survey; later taps are stored as messages but do not change it.
Taps never reopen a conversation or start a reply turn. The score is the share of best ratings among
answers; the response rate uses delivered surveys as the denominator.

## ADR-033 Collision warning at send time instead of presence (2026-09-26)

Decision: collisions are caught where they cause harm, when a reply is queued: under the
conversation's row lock, a reply is refused once if another member's reply is newer than the
newest message the sender had seen; the sender reads it and sends again. This needs no presence
heartbeats and cannot be missed by a disconnected browser. Live "someone is typing" presence is
backlog.

## ADR-034 Automations: a structured builder with a generated diagram (2026-09-27)

Decision: automations are edited as a list of typed steps (labelled forms, "next step" choices), and
a diagram is generated from that list, instead of a drag-and-drop canvas. The list works with a
keyboard and a screen reader, and every branch target is an explicit, validated choice. The graph
format (steps with named outgoing branches) does not preclude a canvas later; it would edit the same
JSON. The graph model and the interpreter have no server dependencies, so the builder checks
drafts and simulates runs in the browser with the code the worker runs. The feature matrix states
that the builder is not drag-and-drop.

## ADR-035 Automation runs: durable rows advanced one step per transaction (2026-09-27)

Decision: a run is a row holding its position (current step, visit counts, wait state, captured
answers); each step is one transaction that locks the conversation, then the run, applies the
step's effects and stores the new position. Bot messages are written through the existing send
pipeline in that transaction (message, send intent, `message.send` job), so a crash before commit
leaves nothing and a crash after commit loses nothing; the send worker keeps its own rule of never
resending an unknown outcome. Jobs on `automation.run` only signal the row (keys per start, reply,
timer and continuation), and the minute sweep re-signals any active run whose next step is more than
30 seconds overdue, so a worker restart or a lost job delays a run but never loses or repeats a
step. Runs are pinned to the version they started with; publishing never changes a run in progress.
Budgets (200 steps, 20 entries per step, 50 messages, 7 days, 10 runs per conversation per hour)
end runaway runs as failed and return the conversation to people. A step that raises an error fails
its job as usual (pg-boss retries and keeps the error), and the run counts the attempt; after five
failed attempts in a row the run fails (`error`, `step_error`) and the conversation goes to people,
so a bug or a persistent database error cannot hold a customer for the full seven days. A run
waits for Meta to accept each bot message before its next step or its completion (the queued
message is recorded on the run; the send worker signals the run when the send is settled), and a
message that is rejected, cancelled, of unknown outcome, not accepted within 10 minutes or reported
failed later fails the run (`send_failed`) and hands the conversation to people: a run never reports
"completed", or moves on, on a message the customer did not get. This also keeps a run's messages in
order. Acceptance, not delivery, is the bar (delivery can take days when a phone is off); a failure
reported after a run has ended is shown on the message but does not rewrite the run's outcome.
External calls (the HTTP step) use a write-ahead call with an unknown outcome, like auto-recharge
(ADR-043).

## ADR-036 The bot/human hand-off lock (2026-09-27)

Decision: at most one run per conversation is active (partial unique index). While it is, the
automation owns the conversation: automations start only in unassigned conversations, routing
leaves bot-handled conversations alone (ingest, the sweep and availability changes), and no reply
turn is open. A member's reply or template, an assignment to a member, Take over and a resolve end
the run in the same transaction as the member's change, under the conversation lock, and cancel the
run's bot messages that no send worker has claimed, so after a person acts nothing more from the bot
leaves. A message already handed to the sender cannot be recalled; this is stated in the UI copy and
the threat model. A hand-off step, a stop by a member, a failure or an opt-out returns the
conversation to people and routes it (to the hand-off team, or like a new case of the number).

## ADR-037 Reply turns while automations answer (2026-09-27)

Decision: time an automation spends answering is not time a customer waits for a member. A
customer message opens no turn while a run is active; a run that starts closes the open turn as
`automated`; when a run passes the conversation to people (hand-off, stop, failure, Take over or
an assignment, or the customer has the last word), a turn opens at that moment with
`start_reason = 'handoff'`. A run ended by a member's reply, a resolve or an erasure opens none.
Reports leave automated turns out, and every turn-based metric got a new definition version (not an
edit) because what a turn is changed. Triggers on `app.automation_runs` maintain this, like the
other turn triggers (ADR-027).

## ADR-038 Automations act for the company; test runs act for the member (2026-09-27)

Decision: live runs carry no member: they are the company's published configuration, and they
keep running if the member who published them leaves (publishing, pausing and archiving need
`automations.publish` and are audited). Test runs carry the member who started them: their jobs and
bot messages are signed with that member, and each step re-checks that the member is still active
with `automations.write` and `inbox.reply` (as the campaign runner re-checks its launcher), so a
test stops if the member leaves or loses either permission. Suspended companies
start no runs; jobs of existing runs wait until the company is active again (and runs older than
7 days then fail as expired).

## ADR-039 Replacing SECURITY DEFINER functions in later migrations (2026-09-27)

Decision: a definer function owned by `w360_definer` cannot be replaced in place by the migration
role (it may `SET ROLE w360_definer`, but that role has no CREATE on the schemas). Migration 0011
drops such a function as its owner (`SET ROLE w360_definer; DROP FUNCTION …; RESET ROLE;`),
recreates it as the migration role, grants EXECUTE to the caller, and hands it back to
`w360_definer`, all in the migration's transaction, so there is no moment without the function.
`app.erase_contact` and `ops.conversations_to_route` were replaced this way; the isolation suite
checks that neither is executable by PUBLIC and that both keep a pinned `search_path`.

## ADR-040 CRM records: company-wide, single-currency pipelines and an append-only timeline (2026-09-27)

Decision: the CRM is company-wide (`crm.read`/`crm.write`), not scoped like the inbox: sales work
spans members, and a deal is not a conversation. Pipelines and their stages are company settings
(`tenant.settings.manage`, audited); deal and task changes go to an append-only timeline per
contact and deal instead of the audit log, which records settings and security events. Each
pipeline has one currency fixed at creation (no runtime UPDATE grant), so every deal value and
every board or report total within a pipeline is in one currency; values are integers in the
currency's minor unit (ISO 4217 decimals from ICU; amounts are parsed without floats) and totals
are never added across currencies. Won and lost are deal statuses, not stages, so reports do not
depend on how a company names its stages; stages and pipelines are archived, never deleted, so
closed deals keep the stage they ended in. A deal belongs to one contact for life (no UPDATE grant
on `contact_id`), and composite foreign keys tie a task's and a timeline entry's deal to the same
contact, so erasing a contact finds every row that describes them: erasure deletes the contact's
timeline (the only free text besides titles), notes and tasks, and blanks deal titles and lost
reasons while keeping stage, value, owner and dates for reports. Concurrent edits are refused by
version checks rather than merged. CRM writes lock the contact (FOR KEY SHARE) before a deal or
task, in erasure's order, so nothing about a contact is written during or after its erasure; deal
writers share the pipeline row before reading stages, so an open deal never lands in a stage or
pipeline archived at the same moment; a closed deal whose stage was removed reopens in the first
stage (stages are not restorable). Custom deal fields, deal import and forecasting are deferred.

## ADR-041 Task reminders: the task row decides, jobs only signal (2026-09-27)

Decision: a reminder is state on the task (`pending` → `sent` or `skipped` with a reason), not a
job. Saving a reminder time schedules a delayed `crm.reminder` job keyed by task and time; the job
locks the task, and the email is queued through the outbox in the same transaction that marks the
reminder sent, so retries, duplicate signals and restarts never send twice and a crash before
commit sends nothing. The minute sweep (`ops.crm_reminders_due`, ids of active companies only)
re-signals reminders more than 30 seconds overdue, so a lost job delays a reminder but does not
lose it. Changing the time makes a new reminder (a job for the old time finds the task not due);
closing the task skips a pending reminder. A reminder is skipped, with the reason shown on the
task, when the assignee is no longer an active member with CRM access or when it is more than a
day late (a suspended company or a long outage), because a stale reminder is worse than none. The
email carries the task title and a link, like other notices sent to a member's own address.

## ADR-042 One egress guard for requests to addresses a company chooses (2026-09-27)

Decision: every request to an address a company supplies goes through `packages/core/src/egress.ts`
(the automation HTTP step now; tenant webhooks and imports later). It allows https only, port 443
or 1024 and up, and no credentials in the address. It resolves the name once, refuses the request
if any answer is private, loopback, link-local, carrier-grade NAT, multicast, reserved,
documentation, cloud-metadata or an IPv6 form of those (IPv4-mapped, NAT64, 6to4, unique-local,
site-local), and then connects only to the addresses it checked, trying them in turn until one
connects (a `lookup` hook pins them; the name only goes into SNI and Host), so DNS rebinding between
check and connect is not possible and one unreachable address does not fail the call. IP
literals are checked the same way, in every notation Node's URL parser accepts. Redirects are never
followed, there is no connection pool shared between companies, request bodies are limited to 64
KiB, responses to 256 KiB and the whole exchange, name resolution included, to 10 seconds. System
lookups cannot be cancelled and run in the process's thread pool, so at most two are in progress
per client; a request that cannot get a lookup slot before its deadline fails as `dns_failed`
without being sent. Callers cannot set framing,
routing or proxy headers or send line breaks in headers. Every refusal says whether the request may
have reached the server (`EgressError.sent`), which the caller needs to decide between "failed" and
"unknown". Loopback and plain http exist only for local test targets (`W360_EGRESS_ALLOW_LOOPBACK`),
and both web and worker configuration refuse that flag outside `APP_ENV=local|test`. A network
egress policy (a proxy or firewall that denies private ranges) remains recommended as a second
layer in deployment.

## ADR-043 Automation HTTP step: written ahead, made once, secrets bound to a domain (2026-09-27)

Decision: an HTTP step never calls out from the runner. The step's transaction records the call
(`automation_http_calls`, one per step visit, the request encrypted with the keyring and bound to
the row) and the run waits for it (`waiting_for = 'http'`, two minutes). The `automation.http`
worker claims a queued call (`in_flight`, with a lease) in one transaction, re-checks the company's
current allowed domains and secrets, makes the request through the egress guard with no locks held,
and records the outcome in another transaction, then signals the run. A call is only ever sent from
`queued`, so a retried or duplicated job cannot send it twice, and the database refuses to queue a
call that may have been sent. A call still in flight at the run's deadline (the worker died, or the
server was slow) becomes `unknown` (`no_result`) and the run takes its failure branch: it is never
retried, because the server may have acted on it; a call not started by then is cancelled. The
runner locks the call when it reads it, so a result cannot arrive between "not finished" and
settling it, and a result recorded first always wins. A run that ends while a call is in flight
(taken over, stopped, resolved, archived, opted out, erased) settles the call as unknown at once,
because no runner is left to do it; the worker's later result is not kept. Values saved from a
response are kept only while the run can still use them, are cleared with captured answers
(retention, erasure) and are never logged; the stored request is erased once the call has an
outcome. The call record keeps the host and the step's path as written (placeholders not filled
in), so it never holds a customer's values in plain text.

Secrets are company settings (`integrations.manage`, audited by name): stored encrypted, never
returned to a browser, referenced by name in header values only, and each saved for one allowed
domain; the worker sends a secret only to that domain, so whoever edits automations cannot send one
company API's key to another allowed host. Header values are rendered into text and secret parts:
customer text (a profile name, an answer) is never read as a placeholder again, so it cannot pull in
a secret, and it is percent-encoded unless it is printable ASCII (placeholders in the address are
URL-encoded, in the JSON body JSON-escaped). A server that echoes request headers back would still
reveal a secret to automation editors; the settings page warns that only trusted domains should be
allowed. Per run there are at most 20 calls (`budget_http`).

## ADR-044 Growth tools count clicks, not visitors; sources keep only what identifies them (2026-09-27)

Decision: a chat link is a short link on our origin, `/l/<slug>` (12 random base32 characters,
unique across companies because the public route has no company context), that redirects to
`https://wa.me/<number>?text=…` (research M-160). The redirect is built from the stored link only
(the number's digits and the pre-filled message), so the route can never be pointed at another
address. Following a link runs `ops.follow_chat_link` (SECURITY DEFINER), which adds one to the
link's count for the company's current day and returns nothing for an archived link, a number
that is not active or a company being deleted; a suspended company's links keep working, because
the customer writes to the company and nothing is sent. (Since ADR-055 a company waiting for
deletion is treated like a suspended one, and only a deleted company's links stop.) Nothing about the visitor is stored: no
address, user agent, referrer, cookie or time of the click; the redirect sends no referrer to
WhatsApp. Counts therefore include repeated clicks and automated visits such as link previews, and
the pages say so: removing them would need an identifier for the visitor, which we do not keep.
QR codes hold the short link, so scans are counted and printed codes follow later edits.

A conversation is attributed to a link when the customer's message carries the link's reference
code ("(ref ABC234)", appended to the pre-filled message unless switched off), on the number the
link opens; a code typed to another number does not count. The customer can edit the message, so
link conversations are a lower bound, and the pages call them conversations that sent the code.
Per-click codes (which would identify a click and so a visitor) and matching conversations to
clicks by time were rejected. Messages from click-to-WhatsApp ads carry the ad in `referral`
(M-130); ingestion keeps the ad's id, type, web address (http or https only) and headline, and no
longer stores the raw object: the ad click id (`ctwa_clid`) identifies the visitor to Meta for
conversion reporting, which HyFib does not do (W-072 needs explicit configuration and consent),
and the image and video addresses and ad text add nothing to attribution. Each attributed inbound
message gets one `conversation_sources` row (an ad wins over a code in the same message); rows are
deleted when the contact is erased, and erasure also clears referral objects stored before this
change. Starting a conversation from a link or an ad is not consent to marketing: consent is
recorded as before.

The website button is a script (`/widget/<id>.js`, 16 random characters) that draws one link to
the company's short link from `ops.chat_widget_config` (nothing while the button is disabled or
deleted, or while its link would not open). It sets no cookies, stores nothing in the visitor's
browser, loads nothing else and sends nothing of its own, so it needs no cookie consent. It sets
text with `textContent` and styles through the CSSOM in a shadow root, so neither the company's
text nor the site's styles can inject markup, and it works on sites whose style policy forbids
inline style elements. It is cacheable for five minutes (it holds no private data), so a change
reaches visitors' browsers within five minutes; the short link itself stops at once. The page the
visitor is on is not added to the message, unlike some products, because that would pass browsing
data into the chat. Links and buttons are company data under `campaigns.read` and
`campaigns.write` (created, edited, archived and deleted with an audit entry); at most 500 open
links and 50 buttons per company.

## ADR-045 WhatsApp Flows: HyFib keeps the draft, the worker talks to Meta, HyFib's endpoint decrypts and forwards (2026-09-27)

Decision: companies write Flow JSON as text (no visual builder yet). HyFib checks the structure it
relies on while the member types (at most 256 KiB, a `version`, an optional `data_api_version`,
1–100 screens with unique ids, `SUCCESS` reserved, at most 50 components a screen, at least one
terminal screen) and stores the JSON exactly as written, because Meta's validation errors cite
lines and columns of the uploaded file (research M-162); Meta validates every component on upload,
and publishing is refused while it reports problems. The answers a flow returns are the keys of its
`complete` payloads; each can be saved as the contact's name, email or a custom field.

Everything done at Meta is one operation at a time, written ahead on the flow row (`sync_op`,
`sync_state`) in the member's transaction and performed by the `flow.sync` worker: create, upload,
publish, deprecate, delete and refresh. The worker claims the operation (queued → running), calls
Meta, and records the result only if the row still waits for the same operation; a flow waiting for
Meta cannot be changed. Transient failures are retried by pg-boss (five attempts, 30–900 seconds
apart); permanent ones are shown with Meta's message and a Try again button; the sweep re-signals
operations waiting for more than two minutes and fails those older than 30 minutes. Creating a flow
has no idempotency key at Meta (M-161), so the name at Meta carries a HyFib reference
(`Name (w360 abcdefgh)`): before creating, the worker lists the account's flows and adopts one with
its reference, so a lost create response never makes a second flow. Publishing, deprecating and
deleting read the flow's status first and skip the call when Meta already shows the result;
uploading the same JSON again replaces the asset with itself.

Publishing is irreversible at Meta (M-163), so it needs `flows.publish` (owners and administrators),
a confirmation, a draft whose current JSON Meta has without validation errors, and, for a flow that
fetches data, an endpoint address and a valid key on every active number of the account. A
published flow is changed by making a new draft from it (HyFib uploads the JSON itself rather than
using Meta's `clone_flow_id`). Members who edit flows can send a draft (mode `draft`) in a chat to
test it. Sending a form is a reply (`inbox.reply`) and only while the customer service window is
open.

Keys: one RSA-2048 key pair per WhatsApp account, generated by the worker; the private key is a
keyring ciphertext bound to its row (`flow-key:<company>:<key>`) and never leaves the server. The
public key is uploaded to each active number (M-164: one active key per number, an upload replaces
it) and read back; a number is ready when Meta reports `VALID` for that same key. Our sources do not
say whether one key may serve several numbers; the worker checks each number, and the release
checklist verifies it on a real account. Replacing the key (`flows.publish`) keeps the previous one
decrypting for 24 hours while WhatsApp clients pick up the new one, then retires it and deletes its
private key.

The data endpoint is HyFib's `/api/flows/endpoint/<public id>` (16 random base32 characters),
registered as the flow's `endpoint_uri`. It checks Meta's signature over the raw body (432), finds
the flow through `ops.flow_endpoint_target` (companies that are active or suspended), and continues
in that company's scope: the signature proves the request comes from WhatsApp and the public id
names the flow, a verified provider mapping. It decrypts with the current key, then the previous
one (421 when neither works, so the client refreshes the key; M-100, M-101), answers health checks
and error notifications itself (M-103), and then requires a flow token HyFib issued for this flow:
32 random bytes per send, valid for 30 days and ended by erasure (427 with a message otherwise; 427
too while the company is suspended). Everything else is forwarded as plain JSON (the request plus
the flow and the contact the form was sent to) to the company's endpoint on an allowed domain
through the egress guard, within seven seconds (Meta's own wait is not documented in our sources),
with the company's secret as a bearer token only when the secret belongs to that host. A company
427 with `error_msg` is passed on; any other failure is a 500 with a code in the log. Requests are
forwarded at least once: WhatsApp may repeat them, so company endpoints must tolerate repeats.
`flow_token_signature` (M-168, low confidence) is not used.

A completed flow arrives as an inbound `nfm_reply` (M-166, medium confidence: third-party sources).
Its answers are kept without the token on a response row (at most 48 KB) and applied to the contact
answer by answer, each with an outcome (saved, not answered, not saved, skipped); a completion from
anyone other than the contact the form was sent to is kept but not applied. Completing a flow is
never consent, and completions do not start automations. Answers are shown only to members who can
read contacts, logs carry codes and ids only, and contact erasure deletes the answers and ends the
contact's tokens.

## ADR-046 Commerce: catalogs read from Meta, orders from the webhook, Payment Links in the company's own Razorpay account (2026-09-27)

Decision: the first commerce slice (P4-06a) connects WhatsApp's own commerce features to HyFib and
takes payment through the company's own Razorpay account. Store connectors (Shopify, WooCommerce)
are a separate slice (P4-06b): catalogs stay managed in Meta Commerce Manager.

Catalogs are read, never written. The `commerce.sync` worker lists the catalogs connected to a
WhatsApp account (`/{WABA}/product_catalogs`) and their products (`/{catalog}/products`, research
M-172), at most 10 catalogs and 5,000 products each, and upserts them in batches of 200. A product
Meta no longer lists is marked removed only after a complete read (never after a truncated one), a
catalog no longer connected is marked disconnected, and both stay for the orders that name them.
The read is one row per account (queued → running → idle or failed), requested by members with
`commerce.manage` or by the daily re-read; the sweep re-signals reads waiting over five minutes and
fails those older than 30 minutes. Which permission Meta requires for these edges is not confirmed
from Meta's pages (M-173); Graph permission errors (#10, #200–#299) are reported as missing catalog
access (`catalog_management`) rather than as a bad credential. The price text is shown as Meta
returns it (its format is not documented, M-172) and is never used for money.

Product messages (M-169) are replies: `inbox.reply` and `commerce.read`, in a conversation the
member can see, while the customer service window is open. One message names products from one
catalog connected to the conversation's WhatsApp account: a single product, a list (1–10 sections,
at most 30 products, section titles when there are several) or the whole catalog with a thumbnail
product. They go through the normal send pipeline (send intent, message row, `message.send`).

Orders come from the webhook (`type` = `order`, M-170). The prices there are JSON numbers in major
units; each is converted to minor units exactly through its shortest decimal text, and refused
(null) when it has more decimals than its currency, is negative or uses an exponent. The order's
subtotal is kept only when every item of the cart was read, with a readable price, in one currency;
otherwise it is unknown and payment cannot be requested (a cart with an item HyFib could not read
is never charged for the items it could). Items are matched to HyFib's copy of the catalog by retailer id for
their names; unknown products are kept by retailer id. An order has an 8-character reference and is
visible only to members who can see its conversation. Members move orders along: received →
confirmed or cancelled, confirmed → fulfilled or cancelled, paid → fulfilled. "Waiting for payment"
and "paid" are set only by Payment Links.

Payment Links are created in the company's own Razorpay account; no money passes through HyFib and
nothing is posted to HyFib's ledger. The company saves its key id, key secret and a webhook secret
(`commerce.manage`); the secrets are keyring ciphertexts bound to the account row
(`commerce-payments:<company>:<account>:<key|webhook>`), are never shown again, and live keys are
accepted only in production. The worker checks the keys by listing links for a reference that
cannot exist (R-107): an answer proves the keys, a 401 marks them failed. A check's result, and a
rejection seen while creating a link, apply only to the version of the keys they used, so keys saved
again meanwhile are never marked by an older answer.

Requesting payment (`inbox.reply`) writes a link ahead in the member's transaction: the order's
subtotal in rupees (at least ₹1; other currencies are refused), a single-use `reference_id`
(`w360_` plus 20 random characters, R-106), 7 days to expire; HyFib's own cap on one link is ₹50
crore. One link can be open per order. The
`commerce.link` worker takes a two-minute lease on the row and creates the link once: after an
attempt whose response was lost it first looks the link up by its reference, and if Razorpay
answers that the reference was already used it adopts the link found (never a second create).
Links ask for the whole amount (`accept_partial` false) and Razorpay's SMS, email and reminders are
turned off, because HyFib sends the link in the chat, and only while the service window is open; if
it cannot, the link is kept with the reason (`send_error`) for the member to copy it, or, when
Razorpay returned no https address, to cancel it and ask again.

A payment is recorded only from the link as HyFib fetches it from Razorpay with the company's keys:
never from a browser, a chat or a webhook body. The link is fetched every 15 minutes on its first
day, then every six hours until a day after it expires, and at once when the company's Razorpay
account notifies `/api/webhooks/razorpay-links/<16 random characters>`. That route finds the
company by the address, verifies the signature with that company's webhook secret, records the
event id (a redelivery does nothing) and only signals a fetch; the body is not stored. The order
becomes paid when Razorpay reports the link paid in full; an expired, cancelled or failed link
returns the order to confirmed. Cancelling asks Razorpay to cancel the link; Razorpay refuses paid
links (R-109), and then the fetched status is applied instead. A job that finds the row leased is
retried, so a notification is never lost to a check already in flight. Links, orders and
conversations are locked in the order conversation → order → link, the order used by replies and
erasure.

Erasure keeps an order and its amounts as a business record, clears the customer's note and asks
Razorpay to cancel the contact's open links; the message that carried the order is redacted with the
rest of the conversation.

## ADR-047 Store connectors: read-only copies kept in step by signals, cursors and checks (2026-09-27)

Decision: companies connect their own Shopify and WooCommerce stores (P4-06b, research
`docs/research/store-connectors.md`). HyFib reads orders and products into a copy it keeps in step,
shows orders next to the customer's conversations and never writes orders, products or customers
to the store. Messages sent on store events (order confirmations, shipping updates) are the next
slice (P4-06c).

**Shopify** uses one HyFib app (non-embedded, authorization code grant, SH-002) configured by the
operator (`SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_API_VERSION`), with the scopes
`read_orders,read_products` only. A member with `commerce.manage` starts a handshake: a single-use
state (32 random bytes, stored as a hash, 15 minutes, bound to that member) and the store row in
`authorizing`. The callback is checked before any company context exists: the HMAC with the app
secret (current and previous), the timestamp (±90 s), the shop's shape and a handshake still waiting
(`ops.commerce_store_by_connect`); the route then requires the same signed-in member, re-checked
through `resolveTenantContext`. The code is exchanged by the worker for an expiring offline token
(`expiring=1`, SH-006/SH-007). A shop can be connected to one company at a time (a unique index over
the active states), because Shopify keeps one token per app and shop.

**WooCommerce** uses REST API keys. The approval page (`/wc-auth/v1/authorize`, WC-002) asks for
Read/Write keys (write is used only for HyFib's own webhooks, WC-004), or a member pastes keys.
The key handover (WC-003) is unauthenticated: it is accepted only for a waiting handshake (the
single-use id sent as `user_id`), only for `read_write` keys, and the keys are trusted only after
they work against the address the member entered. Keys go in the Authorization header over https
(WC-005), never in URLs; http:// addresses only where loopback egress is allowed (local and test).

**Access** is sealed in the keyring, bound to the row (`commerce-store:<company>:<store>:credentials`)
and versioned: every writer of the credentials bumps `credentials_version`, and a token refresh
(five minutes before expiry) stores the new pair only if the version and state are unchanged, so a
refresh never overwrites access saved meanwhile. All store traffic goes through the egress client
(address checks, no redirects, 30 s, 4 MiB).

**Webhooks only signal.** Shopify deliveries are verified with the app secret over the raw body
(SH-024) and cut to `id`, `admin_graphql_api_id` and `updated_at` with `includeFields`; WooCommerce
deliveries go to a per-store address (`/api/webhooks/woocommerce/<16 random characters>`) and are
verified with that store's secret (WC-014); the unsigned creation ping (`webhook_id=N`, WC-012) is
answered with 200 and changes nothing; anything else unsigned is refused with 401. A delivery id is
recorded per store (a repeat does nothing; retained 30 days), deletions are marked, and everything
else becomes a fetch row (store, kind, id) and a job: the worker reads the current state from the
store's API. Nothing from a webhook body is stored. A fetch row is deleted only if no newer signal
arrived during the read (each repeat moves its time forward, even within a millisecond).

**Recovery.** Webhooks can be lost (Shopify drops subscriptions after failures, SH-025; WooCommerce
disables a webhook after more than five failures, WC-018), so the worker reads what changed every
hour, oldest first by `updated_at` (SH-016) or `modified_after` (WC-007). The cursor moves to the
last item's whole second, so items at the boundary are read again rather than skipped, and a page
token continues only among items sharing the cursor's second. Every six hours the worker checks
HyFib's subscriptions and re-creates missing ones or re-enables disabled ones. The first read covers
60 days of orders (SH-012) and the products (at most 20,000 per store; the store page says when a
copy is incomplete).

**One job at a time per store.** A job takes a five-minute lease on the store row; a busy store is
skipped. A job reads at most five pages and 50 signalled items; when work remains (signals or a due
read) it queues the next job in the transaction that releases the lease, so a signal arriving during
a run is never lost to the singleton key of the running job. The minute sweep finds handshakes to
expire, stores to finish connecting or removing and reads due (`ops.commerce_store_work_due`).
Throttling (Shopify `THROTTLED`, HTTP 429) waits without an error; refused access fails the store
with a reason the company can act on; other errors are shown on the store and retried in five
minutes.

**The copy.** An order or product is replaced only by a copy at least as recent
(`remote_updated_at`). Amounts are Shopify `Decimal` strings or WooCommerce decimal strings
converted exactly to minor units; a value with non-zero digits beyond the currency's exponent is
unknown (never rounded); WooCommerce's float `price` is not used. Customer numbers are linked to
contacts only in E.164; a number without a country code is read with the store's calling code only
when the company set one (never guessed).

**Privacy.** Order data needs `commerce.read` and `contacts.read`. When Shopify withholds protected
customer data (SH-020), orders are kept without names, numbers and emails and the store says why.
Shopify's compliance webhooks route by the shop named in the signed body (SH-027):
`customers/redact` removes the customer's details from the named orders and orders with their
number or email, for good (a redacted order keeps its details empty on every later read);
`customers/data_request` is kept for the company to answer (managers see the contact details, which
are cleared when answered); `shop/redact` deletes an uninstalled store and its copy.
`app/uninstalled` must name the same shop in its body (the HMAC does not cover headers): the store
stops, its access is dropped and the copy stays until `shop/redact` or removal. Contact erasure
(`app.erase_contact`) redacts the store orders with the contact's number or email, and when the
erasure keeps the number suppressed, new orders from it are kept without the customer's details.

**Removal** by the company uninstalls HyFib from the shop (`appUninstall`, SH-028) or deletes
HyFib's webhooks from the site (WooCommerce cannot revoke keys through its API, WC-020; the owner is
told to revoke the key), then deletes the store and everything read from it. A store that cannot be
reached is removed anyway after 30 minutes; the audit entry records what could not be done at the
store.

## ADR-048 Order messages: events from the store copy, one message per order and event, checked again at send time (2026-09-27)

Decision: a connected store sends the approved WhatsApp template a manager chose when one of its
orders is placed, paid for on delivery, shipped, delivered or cancelled (P4-06c, research
`docs/research/store-connectors.md` §3 and `docs/research/meta-whatsapp.md` §16). Abandoned carts and
store events as automation triggers are not built (P4-06d).

**Events come from the copy, not from webhook bodies.** A read from the store (a signalled read, the
hourly read or the delivery check below) upserts the order and compares its milestones before and
after: new to the copy (placed, and cash on delivery when the payment method says so), shipped,
delivered, cancelled. Shopify orders now carry `paymentGatewayNames` and up to ten `fulfillments`
with `trackingInfo`, all readable with `read_orders` (SH-030, SH-031), so the app's scopes are
unchanged. A shipment that is cancelled or failed does not count; shipped is the first real
shipment; delivered needs a fully shipped order whose shipments are all delivered. WooCommerce
orders carry `payment_method` (`cod` is the core cash on delivery gateway, WC-021) and
`date_completed_gmt`; completion counts as shipped and there is no delivered event (WC-022).
Cash on delivery on Shopify is recognised only by a gateway name containing "cash on delivery"
(Shopify's own example is "Cash on Delivery (COD)").

**Deliveries are found by reading again.** Whether a delivery changes a Shopify order or sends
`orders/updated` is unconfirmed (SH-034), and the fulfillment topics need `read_fulfillments`
(SH-033). While a store's delivered message is on, each store job reads again up to 100 orders
shipped in the last 14 days, not delivered or cancelled and last read three or more hours ago.

**Never about the past, never twice.** A rule applies from the second it is switched on (store
timestamps are whole seconds); editing an enabled rule keeps that time, switching it off and on
again resets it. An event is recorded only when it happened at or after that time: the first read of
a store (60 days of orders) and orders already in the copy send nothing. Store messages are rows
unique per order and event, written in the read's own transaction, so repeated webhooks, reads and
jobs cannot send a second message. An event first seen more than 48 hours after it happened, a test
order (unless the store allows them) and a plain confirmation of an order covered by the cash on
delivery message are recorded as skipped with their reason. Cancelled orders get no shipped or
delivered message.

**When.** A message goes out at the event's time plus the rule's delay (0–1,440 minutes), never
before it is seen, and inside the store's sending hours in the company's time zone
(`sendingWindow`, the campaign scheduler's daylight-saving rules). A `commerce.store-message` job is
queued for that time; the minute sweep (`ops.commerce_store_messages_due`, active companies only)
signals any whose job was lost.

**Checked again at send time.** Under the store message's row lock the worker checks, in order: the
store is connected; a manager's opt-in confirmation stands; the rule is still on and was switched
on before the event; the sending hours (a message outside them moves to their start); the order
still exists, is not redacted, and (except for the cancellation message) is not cancelled; it has an
E.164 number; the template is approved, utility or marketing, and sendable; the number is active
and belongs to the template's account; the cash on delivery buttons are still quick replies; every
variable has a value (fixed text or an order field, with an optional fallback); the number is not
suppressed (checked before any contact is created); and the customer may receive the template
(`checkTemplateEligibility`: erasure, opt-out, marketing opt-in). Any failed check skips the message
with its reason. Otherwise it creates the contact from the order when needed (`source = store`),
the conversation (a new one starts resolved, like a campaign's), the message (`sender_type =
system`, labelled with the store and event) and a send intent without an actor; the send pipeline
checks consent once more at dispatch and records Meta's statuses.

**Opt-in.** Meta requires opt-in before business-initiated messages (M-175) and HyFib cannot see a
store's checkout, so no rule can be switched on until a manager confirms that the store's customers
agreed to WhatsApp messages from the business. The confirmation records who and when; withdrawing it
switches every rule of the store off. A marketing template follows the marketing consent rules and
needs `campaigns.send` to be chosen (cart reminders are marketing, M-176).

**Cash on delivery answers.** The message's two chosen quick-reply buttons carry payloads
`w360-cod:<store message id>:confirm|cancel` (M-177). A tap (a `button` message with the payload and
`context.id`, M-178) is recorded as the store message's answer only from that message's own contact
and conversation, only when the reply names that message (when it names one), and only if it is not
older than the answer already kept. A tap is not a consent keyword, a campaign reply or an
automation trigger; a confirmation stays quiet, a cancellation reopens the conversation so the team
can cancel the order in the store. HyFib does not change orders in the store.

**Privacy.** Tracking numbers and links are redacted with the customer's details (contact erasure,
Shopify's `customers/redact`) and stay empty on later reads; a constraint ties them to
`redacted_at`. Store messages hold ids, times, states and the answer; they are deleted with their
order or store.

## ADR-049 Cart reminders: Shopify checkouts read on a schedule, marketing templates only, consent from HyFib or the store (2026-09-27)

Decision: a connected Shopify store can remind customers about a checkout they left, with up to two
approved marketing templates a manager chose (P4-06d, research `docs/research/store-connectors.md`
§4, SH-037 to SH-043, and `docs/research/meta-whatsapp.md` M-176). WooCommerce has no carts to read
(WC-023), so the reminders are Shopify only. Store events as automation triggers need a template
step outside the service window and data given to a run when it starts; they are a later slice.

**Reading checkouts.** While a cart reminder is on, the store job reads, every 15 minutes, the
checkouts updated since its cursor with `read_orders` (SH-037): `abandonedCheckouts` filtered by
`updated_at`, paged through in full (no sort by update time exists, SH-038; a read that needs more
than ten pages continues on the next run with Shopify's page cursor). The next cursor is when the
read started, less two minutes for clock differences, so an update made during a read is read next
time; checkouts read twice are kept once. Checkout webhooks are not used: their payloads were not
read, and reminders wait at least 30 minutes. Switching a reminder on starts the cursor at that
moment, so nothing earlier is read; "Read the store now" also reads the checkouts at once while a
reminder is on. The copy keeps the number (the customer's default phone when the
store allowed customer access, else the shipping or billing phone, both protected `phone` data,
SH-040), the name, the total in minor units, up to ten items, the recovery address (https), when it
was completed and the consent Shopify records for that number. Copies are deleted 30 days after
their last update, and redacted for good with the customer (contact erasure, Shopify's
`customers/redact`).

**Reminders.** A checkout is left at its last update. When a read sees a checkout that is not
completed, has a number and was updated at or after the rule was switched on, it records a pending
reminder for each rule that is on (unique per checkout and reminder), due at the time it was left
plus the rule's delay (first reminder 30 minutes to 24 hours; second 1 hour to 3 days, later than
the first), inside the store's sending hours. A later update before a reminder goes out moves it
(the customer came back); once sent, a reminder is never sent again. At send time every order
message check runs (store, rule and its start, sending hours, number, template, number's account,
variables, suppression, contact, consent) plus: the checkout still exists, is not redacted and not
completed; no order with the same number was placed in the store since the checkout was created; the
template is a marketing template; the second reminder goes only after the first was sent; nothing
goes out more than three days after the checkout was left; and the company's marketing frequency cap
(counted like campaigns, under the campaign runner's company lock so the two never race). The cap now
applies to every store message with a marketing template.

**Consent.** A cart reminder is marketing (M-176): it needs an approved marketing template, a member
with `campaigns.send` to choose it, and the customer's marketing opt-in unless the company turned the
opt-in requirement off. Opt-in can come from HyFib's own records or, when a manager allows it, from
the store: Shopify 2026-07 records WhatsApp marketing consent per phone number (SH-041), readable
with `read_customers`. HyFib asks for that scope only when a manager allows customer access for the
store (least privilege; SH-042: the app authorizes again with the extra scope, and the store keeps
syncing with its old token until the worker exchanges the new code). Shopify keeps one current token
per app and store (SH-007), so the exchanged token always replaces the old one: without
`read_customers` the store keeps working without customer access; without the connector's own scopes
it can no longer sync and fails with a request to connect it again; a code Shopify refuses leaves
the old token in place. With
"use the WhatsApp consent the store records" on (`commerce.manage` and `contacts.write`, audited),
each checkout read records Shopify's `SUBSCRIBED` or `UNSUBSCRIBED` state with its update time as a
consent event (source `store`, evidence: store, state, opt-in level, where it was collected) for the
contact with that number, created from the checkout when needed (never for a number on the
suppression list); the newest consent event wins, as
for every source, and the same Shopify state is never recorded twice. States without an update time,
`PENDING`, `NEVER_SUBSCRIBED` and `REDACTED` change nothing. HyFib never writes consent back to
Shopify.

**Recovered checkouts.** A checkout counts as recovered when a read sees it completed (SH-043) after
one of its reminders was sent; the recovered value is its total. A reminder counts as sent once it
was handed to WhatsApp, unless WhatsApp reported it failed, it was cancelled or its outcome is
unknown. The store's Order messages page shows, for the last 30 days, reminders sent, checkouts
recovered and their value per currency, with these definitions.

## ADR-050 Store events in automations: order rules start a published automation, template steps send outside the service window, runs read their order (2026-09-28)

Decision: an order message rule (ADR-048) either sends its template or starts an automation whose
trigger is "Started by a store's order messages" (P4-06e). Automations gain two template steps, and
a run started this way reads the order it is about while it runs.

**Where the link lives.** The rule for a store and event says what happens: send a template (as
before) or start a chosen automation. The automation's trigger (`store_event`) never matches a
customer message, so it starts only from rules. Keeping the choice on the rule keeps every guarantee
of ADR-048 unchanged: at most one store message per order and event, nothing about events before the
rule was switched on, test orders and late events recorded without sending, the delay and the
store's sending hours, and a rule is either a template or an automation, never both. Order placed,
shipped, delivered and cancelled can start automations, for Shopify and WooCommerce stores alike.
The cash on delivery confirmation keeps its template, because its answer is recorded on the order,
and the cart reminders keep theirs, because their send checks depend on the first reminder having
been sent; both are recorded as not built for automations.

**Starting a run.** At the store message's send time, under its row lock, the order message checks
run first (store connected, opt-in confirmed, rule switched on since before the event, sending hours,
order neither deleted, redacted nor cancelled, a number). Then: the automation is active and its
published version starts from order messages; the rule's number is active and allowed by the
automation (an automation limited to one number starts only from rules using it); the number is not
on the suppression list; the contact may receive messages at all (not erased, not opted out); the
conversation is not assigned to a member; no automation is active in it; and fewer than
`maxRunsPerConversationPerHour` runs started there in the last hour. A failed check skips the store
message with its reason. Otherwise the contact and the conversation are created as for a template
(a new conversation starts resolved), the run is inserted with the order and the event, and the
store message becomes `started` with the run's id, in one transaction: a repeated job or the sweep
finds the store message no longer pending, so a store message starts at most one run. Choosing an
automation on a rule needs `commerce.manage` and `automations.read`, and `campaigns.send` when its
published version uses a marketing template; its templates must belong to the rule's number's
WhatsApp account.

**Template steps.** "Send a template" sends and continues; "Ask with a template" sends and waits:
a branch for each of the template's quick-reply buttons, one for any other reply and one for no
reply within the timeout (at most 24 hours). Variables are texts with placeholders, filled in when
the step runs. Only approved utility or marketing templates HyFib can send are offered (authentication
templates and templates with content HyFib cannot send are not). Each quick-reply button of an asking
step carries the bot button id as its payload (research M-177, M-178): run, step, visit and the
button's position among the template's buttons (now 0 to 9, templates have up to ten buttons; the id
has at most 84 characters and no payload length limit was found). A tap matches only the step and
visit that sent it, and a typed button title counts as the tap, like reply buttons; a template tap
without a bot id stays a text reply, as before. When the step runs, the runner checks the template
again (approved, still utility or marketing, the same number of variables and the same quick-reply
buttons as the step expects, else `template_changed`), the number (active, of the template's
account), a value for every variable (a variable left empty ends the run with `missing_variable`,
nothing is sent with a blank), the contact's consent for the template's category (suppression,
erasure, opt-out, marketing opt-in) and, for marketing templates, the company's frequency cap, then
creates the chat message as a bot message and hands it to the send pipeline, which checks template and
consent again at dispatch (P3). No 24-hour window applies to templates. Any failed check ends the run
as a failed send (`send_blocked` with the reason). The frequency cap is counted under the campaign
runner's company lock (ADR-049); the campaign runner holds that lock while it writes conversations,
so the automation runner, which already holds the conversation's lock, only tries the lock and, when
it is busy, tries the step again two seconds later instead of waiting (a wait would be a deadlock).
Publishing or testing an automation that uses a marketing template needs `campaigns.send`, as
choosing one for a store rule or a template send does.

**The service window in store-event automations.** Until the customer replies WhatsApp allows only
templates. In an automation started by order messages, `checkGraph` refuses a message, a question
with buttons or a typed question that some path from the first step reaches before the customer has
replied; a reply is an answer or an other reply at a question or an asking template step (no reply,
waits and web requests are not). A hand-off reached before a reply only warns: it cannot open the
conversation (people see it once the customer writes).

**Runs in closed conversations.** A conversation created or found by a store rule stays resolved, like
a campaign's, so the inbox holds no work until the customer writes. A store-event run may therefore
continue while its conversation is still resolved as it was when the run started (`resolved_at` at or
before the run's start); the customer's reply reopens it (ingestion, as before) and reaches the run.
A conversation resolved after the run started still stops the run, and a member resolving it ends the
run as before. A run's end routes only open conversations (routing leaves resolved ones alone), so a
run that ends before the customer replied puts nothing in front of people.

**Order data.** The run keeps the order's id, not a copy, and each step reads the order as it is now:
`{{order.number}}`, `{{order.customer_name}}`, `{{order.total}}`, `{{order.items}}`,
`{{order.status_url}}`, `{{order.tracking_number}}`, `{{order.carrier}}`, `{{order.tracking_url}}` and
`{{order.store}}`, in messages, questions, template variables, contact updates and web requests. The
reference is cleared when the order is deleted (with its store, for example), and a redacted order
has no values: its placeholders are empty (a template variable then fails as above). No customer data
is copied into the run. Order placeholders are refused in automations that do not start from order
messages. Conditions on order fields and changing the order from a run are not built.

**Test runs.** A test run of a store-event automation uses an order the member chooses
(`commerce.read` and `contacts.read`, as seeing store orders needs, because its steps send the
customer's details) on a conversation they can see, inside its service window, as other test runs
do.

**Template steps in other automations.** Template steps are available in every automation, so an
automation a keyword starts can wait (up to 24 hours per wait step, within the run's 7 days) and then
send a template, which the service window does not limit (drip follow-ups, W-084). The warning for a
wait or a question timeout over 23 hours now follows the paths after it: it appears only when a
message that is not a template can follow before the customer replies.

**Records.** The store's Order messages report and the order page show automations started, with a
link to the run for members with `automations.read`; the run page shows the order for members with
`commerce.read`; the automation page lists the store rules that use it.

**Migration 0022.** `automation_runs` gains `store_order_id` (composite foreign key, set null when the
order is deleted) and `store_event`, and the `store_event` trigger type; order message rules gain
`action` and `automation_id` (composite foreign key, set null when the automation is deleted, which
only a draft never published can be, and only a switched-off rule can name one; a rule that sends
its template keeps no automation; only the four order events may start automations); store
messages gain the `started` state and `automation_run_id` (composite foreign
key, set null when the run is deleted by retention).

## ADR-051 Plans and entitlements: a platform catalog of immutable plan versions, one plan state per company, limits checked where things are added (2026-09-28)

Decision: HyFib staff define plans in the platform area and put each company on one (P5-01).
Companies see their plan, its limits and their usage; limits are enforced by the services and
workers that add seats, numbers, teams, live automations and automation runs, and a company whose
plan has lapsed is restricted like a suspended one. Charging for plans (Razorpay Subscriptions,
ADR-012) is not part of this decision: periods are set by staff, for example after an invoice is
paid outside HyFib.

**Plans.** `ops.plans` holds one row per version of a plan code, entered by platform owners (only
they change the catalog and the default trial; operators put companies on plans), never seeded (no
hard-coded prices). A version is a draft (editable), published (immutable, assignable) or
retired (kept for companies already on it, no longer assignable); a change is a new version, so a
company's terms never change under it. A version has a name and description, a price in INR paise
per 1, 3 or 12 months, trial days, grace days after a paid period ends, and limits: seats included,
WhatsApp numbers included, teams, live automations and automation runs per month (no value means no
limit). Extra seats, extra numbers and packs of automation runs are add-ons, sold only when the
version gives their price (seats and numbers up to a maximum). Modules are the paid areas a plan may
leave out: automations, WhatsApp Flows, CRM and commerce (catalogs, orders, payment links and store
connectors). The inbox, contacts, templates, campaigns, growth tools, reports and billing are in
every plan.

**Default trial and complimentary access.** A platform owner may name a published version with
trial days as the default trial: a new company starts a trial of it. Without one, a new company
starts **complimentary** (no limits, all modules), and the platform area says so; staff may also
grant complimentary access on purpose. Companies that existed before plans are complimentary.

**Company plan state.** `app.tenant_plans` holds one row per company: the plan version, a status
(complimentary, trialing, active, past_due, expired, canceled), the trial end, the paid period, the
grace end, add-on quantities, the start of the current usage period and who changed it. Companies
can read it; only SQL functions (company creation, the time sweep) and platform staff write it.
Staff set complimentary, trialing (plan and the day the trial ends) or active (plan, the days the
paid period starts and ends, in the company's time zone) with add-ons and a reason, or end the plan
(canceled); past_due and expired are set only by time. A change needs the plan state's version (a
stale form is refused), and every change is written to the platform audit log and the company's
own. Writers lock the company row before its plan state, so the sweep, plan changes and status
changes cannot deadlock. The minute sweep moves time forward: a trial whose end has passed
expires; an active plan whose period has ended becomes past_due until its grace days pass, then
expires. Lapses and exhausted automation runs are emailed to the company's billing managers.

**Restricted companies.** `app.tenants.status` gains `restricted`: a company whose plan expired or
was canceled keeps read access, exports, member management and billing, and everything that sends
or starts work pauses, exactly as for suspension (the same permission set, deferred jobs and
sweeps that skip it), with its own banner. A trigger on the plan state keeps the two in step: a
lapse restricts an active company and a trial, active plan or complimentary access lifts the
restriction. Platform suspension wins: reactivating a suspended company makes it restricted when
its plan is not current. Inbound messages are still received.

**Limits.** Checked when something is added, under a per-company lock so two concurrent additions
cannot pass a limit together: seats (active members plus pending invitations, at invitation,
acceptance and when a suspended member is restored), WhatsApp numbers (when a number is
connected), teams (when one is created), live automations (when one is published or turned on) and
automation runs (a counter per company and monthly period, incremented atomically when a live run
starts from a customer message or a store event; test runs do not count). A lower limit never
removes anything: after a downgrade, members, numbers, teams and live automations above the limit
stay, and only new ones are refused. Monthly periods start on the day the current plan or trial
started (the usage anchor), whatever the billing interval: a new trial or a new paid period restarts
them, and a change of plan within the same period keeps the month's count. A used-up month is
emailed to the billing managers once (a claim on the counter). Platform staff see a company's usage
as counts only, through a definer function, because the records themselves are customer data.

**Modules.** When a plan leaves a module out, the company keeps read access to what it already has
and loses the module's write permissions (automations: write and publish; flows: write and publish;
CRM: write; commerce: manage), so the services refuse changes and the pages hide their buttons.
Work that runs without a member checks the module too: no automation run starts from a customer
message or a store event, store messages and cart reminders are skipped (`not_in_plan`), and
products and flows cannot be sent from a conversation. Runs already in progress finish, and store
copies keep updating so the data stays visible.

**Not built.** Paying for a plan in HyFib (Razorpay Subscriptions), self-serve plan changes and
trials of higher plans, proration, plan invoices and receipts, usage alerts before a limit is
reached, API quotas (P5-08) and AI credits (Phase 6).

**Migration 0023.** `ops.plans` (guarded like rate cards: drafts editable, published versions
immutable, retire only), `ops.plan_settings` (the default trial), `app.tenant_plans` (a row per
company, created by a trigger on company creation and backfilled as complimentary),
`app.usage_counters`, the `restricted` company status with the sync trigger, the entitlement
function the services, the platform and `app.accept_invitation` use, the sweep functions, the
platform's usage counts (`ops.platform_tenant_usage`, with the definer role reading automation
statuses), `app.accept_invitation` and seven lookup functions replaced to know the restricted
status, and grants and policies for the platform and definer roles.

## ADR-052 Public API v1: company API keys with scopes, templates-only sends, idempotency keys and an OpenAPI document (2026-09-28)

Decision: companies integrate with HyFib through a versioned REST API under `/api/v1`, authenticated
by company API keys (P5-08). Version 1 covers what integrations need first: reading approved
templates, finding and creating contacts, recording consent, sending approved templates and reading
the status of what the API sent. Outgoing webhooks are P5-09.

**Keys.** A member with `developer.manage` creates a key for the company with a name, scopes and an
expiry (30, 90 or 365 days, or none). The token (`w360_<key id>_<secret>`, 256 random bits in the
secret) is shown once; only its SHA-256 is stored (`app.api_keys.token_hash`, not readable by the
runtime role through column grants), and a key is found by that hash through a SECURITY DEFINER
function that also refuses revoked and expired keys and records when it was last used (at most once
a minute). Keys belong to the company, not the member: they keep working when the member leaves,
and any member with `developer.manage` can revoke them. Creating a key needs each permission its
scopes stand for, so nobody grants more than they hold. Rotation creates a new key with the same
name and scopes and lets the old one expire after an overlap of up to 72 hours (or at once). At most
20 keys are active per company. Tokens never appear in logs, URLs or pages after creation.

**Scopes.** `templates.read` (needs `templates.read`), `contacts.read` (`contacts.read`),
`contacts.write` (`contacts.write`: contacts and consent), `messages.send` (`inbox.reply`: utility
templates and reading what the API sent) and `messages.send_marketing` (`campaigns.send`: marketing
templates, which also need the contact's marketing opt-in and respect the frequency cap). A key
without the scope an endpoint needs gets 403.

**The API context.** A request acts for the company as its key, not as a member: data access runs in
the company's scope without a user, audit rows have `actor_type = 'api_key'` and the key id, API
contacts have source `api`, consent events source `api` with the key as actor, and messages
`sender_type = 'api'` with the key's id. Suspended and restricted companies keep read scopes and lose
writing and sending, as in the app; plan modules do not apply to these endpoints (templates,
contacts and sending are in every plan).

**Sending.** `POST /api/v1/messages` sends an approved utility or marketing template to a phone
number (the contact is created when new) from a chosen active number (optional when the company has
exactly one), with the template's variables, through the same send intents and checks as members'
template sends: erasure, suppression, consent for the template's category, the marketing frequency
cap, the template's and number's state. A message is `queued` when the API answers; its status
follows Meta's webhooks and is read with `GET /api/v1/messages/{id}`. Session (free-text) messages,
media and interactive messages are not in version 1.

**Idempotency.** `POST /api/v1/messages` requires an `Idempotency-Key` header and
`POST /api/v1/contacts` accepts one. The key, a hash of the request and the response are stored in
the same transaction as the work (`app.api_idempotency_keys`, unique per API key and idempotency
key), so a retried request returns the first response (`Idempotent-Replayed: true`) and never sends
twice; the same idempotency key with a different request is refused (422). Stored responses expire
after 24 hours. This is exactly-once creation of the send, not exactly-once delivery: delivery
follows the send pipeline (ARCHITECTURE §6).

**Limits.** Each key has a token bucket (burst 50, 10 requests a second) and each company another
(burst 200, 30 a second), in `ops.rate_limit_buckets`; failed authentication is limited per client
address. Exceeding them answers 429 with `Retry-After`. Monthly API quotas per plan are not built.

**Shape.** JSON bodies up to 64 KB; errors as `{"error": {"code", "message", "reason"?,
"issues"?}, "requestId"}` with HTTP statuses from the error codes; lists use keyset cursors (`limit` up to 100,
`cursor` from the previous page); ids are UUIDs; times are ISO 8601 in UTC. Breaking changes need a
new version path. `GET /api/v1/openapi.json` publishes an OpenAPI 3.1 document generated from the
same zod schemas that validate requests, so the document cannot drift from the checks.

**Not built.** Outgoing webhooks (P5-09), session, media and interactive messages, listing
conversations and messages, OAuth apps for third parties, IP allowlists per key, monthly API quotas
per plan, and API access as a plan module.

**Migration 0024.** `app.api_keys`, `app.api_idempotency_keys`, `ops.api_key_authenticate`,
`app.messages.api_key_id`, and `api_key` as a consent event actor.

## ADR-053 Outgoing webhooks: events captured by database triggers, payloads built at delivery, signed at-least-once delivery through the egress guard (2026-09-28)

Decision: companies register HTTPS endpoints that receive signed JSON notifications of what happens
in their account (P5-09). Delivery is at least once, never "exactly once": a receiver deduplicates by
the event id.

**Endpoints.** Members with `developer.manage` (as for API keys, ADR-052) add up to 10 endpoints,
each with an HTTPS URL (checked by the egress guard's URL rules: https, no credentials, allowed
ports), an optional description and the event types it receives. An endpoint can be disabled,
enabled and deleted (its delivery history goes with it). Every change is audited; the URL is shown
to members but only its host is logged.

**Events.** `message.received` (an inbound message from a contact), `message.status` (an outbound
message reaching `accepted`, `sent`, `delivered`, `read`, `played`, `failed`, `canceled` or
`unknown_outcome`), `consent.changed` (an opt-in or opt-out recorded, whatever its source) and
`template.status_changed` (a template reaching a status Meta reports, or deleted); `ping` is sent
only by "Send test event". They are captured by triggers on `app.messages`, `app.consent_events`
and `app.template_status_events`, in the transaction that makes the change, so every writer
produces them (ingestion, the send worker and its recovery, campaigns, automations, erasure, the
API, imports and store consent) and a rolled-back change produces none. A trigger writes an event
only when an active endpoint of the company subscribes to its type, with one delivery per such
endpoint, and wakes the worker with an empty `w360_webhooks` notification. The worker never takes a
company id from a notification: it asks the database which active companies have due deliveries
(`ops.webhook_dispatch_due`), so a forged or repeated notification only causes that lookup.

**Payloads are built when delivered.** An event row holds ids and non-personal facts only (type,
message, contact, conversation or template id, the status reached, an error code, a consent's
purpose, action and source). The worker builds the JSON when it delivers, in the company's scope:
the contact's number and name, the message's text or reply, the template's name. Nothing personal
is stored twice, a contact erased before delivery is sent without their details, and no erasure
hook is needed (except for the tags a contact change lists, ADR-182). A retry is built again, so it
may carry newer data than the first attempt; the event id, type and the status it reports never
change.

**Delivery.** A per-company `webhook.deliver` job (pg-boss policy `stately`: one queued and one
active per company) is enqueued after that lookup, which the worker's LISTEN connection runs when
notified (bursts coalesce) and the minute sweep runs for retries, missed notifications and leases
that expired. The job claims due deliveries in batches of 10 under row locks (`SKIP LOCKED`) with a
lease of the request deadline plus 35 s, posts each one through the egress guard (DNS pinned,
private and metadata addresses refused, no redirects, 10 s timeout, at most 64 KB sent) with no
transaction open, and records each outcome, locking the endpoint before the delivery: a 2xx answer
succeeds; anything else, including timeouts and refused addresses, is retried at 1 min, 5 min,
30 min, 2 h, 6 h, 12 h and 24 h (eight attempts over about 45 hours), then the delivery fails. A
delivery whose lease expired (worker lost) is attempted again (`interrupted` when no attempt is
left); an outcome recorded after a newer attempt claimed the delivery is dropped. After 200
attempts a job queues its successor, so one busy company cannot hold a worker. Response bodies are
read up to the guard's limit and discarded; only the status, a short error code and the duration
are kept. Deliveries are not ordered. Suspended and restricted companies are not delivered to
(their events wait, within retention, until the company is active again).

**Deliveries that cannot be prepared (2026-10-02).** A delivery whose payload or signature cannot
be built (a bug in a payload builder, data it cannot describe, a secret the keyring cannot open, or
a database error while building) fails at once as `payload_failed`, as `event_gone` does: no
request is made, so it uses no attempt (attempts and `W360-Delivery-Attempt` count requests, as
ADR-083 says) and leaves the endpoint's health alone. Each build runs in a savepoint, so a database
error leaves the claim's transaction usable, and the rest of the batch is claimed and sent. Before,
the error rolled back the whole claim: none of the batch was claimed, the failing delivery used no
attempt, so the cap never ended it, and the minute sweep woke the job for the same deliveries every
minute. One such delivery held up every delivery of its company and filled the dead letters with
the same failure. Retrying is not chosen: the same code and data fail the same way, and counting it
as an attempt would misstate what the receiver saw. Once HyFib has fixed the cause, a member or a
key replays it, alone or with ADR-095's replay of failed deliveries, which leaves out only
`event_gone`. The worker logs the company, delivery, endpoint, event type, what failed (`payload`
or `signature`) and the error's class and code (a SQLSTATE for a database error); never the
payload or the error's message, which can quote data. Settings → Webhooks shows "HyFib could not
build or sign the request", and a code that ended a delivery without an attempt now shows instead
of the status an earlier attempt left. Deliveries ended at their claim, whatever the reason, now
count toward the job's 200 with its attempts (though not as attempts), so a backlog that cannot be
built hands over to a successor as an attempted one does, instead of holding a worker while such
deliveries keep arriving. Accepted: a database error that a retry would have passed (a lock or
statement timeout) also ends its delivery, which then needs a replay.

**Signing.** Each endpoint has a secret (`whsec_` and 32 random bytes), shown once, stored encrypted
with the keyring (it is needed to sign) and bound to the company, the endpoint and its version.
Requests carry `W360-Signature: t=<unix time>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, plus
`W360-Event-Id`, `W360-Event-Type`, `W360-Delivery-Id` and `W360-Delivery-Attempt`. Rotating the
secret signs with both the new and the previous secret (two `v1` values) for 24 hours.

**Health.** An endpoint that has failed without a success for 72 hours is disabled at its next
failure; its pending deliveries fail as `endpoint_disabled` and the company's owners and
administrators are emailed. Members can replay a finished delivery (a new delivery of the same
event, within its retention) and send a test event.

**Retention.** Events and deliveries are deleted 30 days after they were created (the messaging
sweep); endpoints stay until deleted.

**Not built.** Per-event filters beyond the type, ordering guarantees, custom headers, mutual TLS,
IP allowlisting by receivers (HyFib has no fixed egress addresses yet), per-number endpoints, and
events for conversations, campaigns, automations, contacts created or orders.

**Migration 0025.** `app.webhook_endpoints`, `app.webhook_events`, `app.webhook_deliveries`, the
capture triggers, `ops.webhook_dispatch_due` and `ops.purge_webhook_data`.

## ADR-054 Platform operations console: content-free facts through narrow definer functions, dead letters recorded by the worker, two audited repairs (2026-09-28)

Decision: platform staff get an operations console under `/platform/ops` (P5-10) that shows where
companies are stuck or failing, what the job system is doing and which companies' sending needs a
review. It is built from counts, states, error codes, labels and times, never from customer
content (messages, contacts, payloads, email addresses, secrets or full URLs).

**Reads through definer functions.** Four SECURITY DEFINER functions, owned by `w360_definer`,
executable only by `w360_platform` and refusing to run unless `app.user_id` is a platform
administrator (`W3403`), like `ops.platform_tenant_usage` (ADR-051):

- `ops.platform_ops_health(p_tenant_id)`: one row per company (every company not deleted, or one):
  status, plan status, numbers by state, the worst quality rating of its active numbers and when it
  was checked, WhatsApp accounts needing reconnection, outbound messages and failures and inbound
  messages in the last 24 hours, the last message time, failing or recently auto-disabled webhook
  endpoints, failed store connections, payment account checks, catalog and Flow syncs, and dead
  letters in the last 7 days.
- `ops.platform_ops_activity(p_since, p_tenant_id)`: one row per company (every company not
  deleted, or one) since a time at most 93 days back: outbound messages by sender (agent, bot,
  campaign, API, system), failed, inbound, marketing templates sent and delivered, Meta errors
  `131049` and `131050` (official codes, research M-062), opt-outs from marketing made by or for
  contacts (keyword, Meta, agent, API; imports and erasure excluded), complaint suppressions,
  webhook deliveries, this period's automation runs (the plan counter), active members and numbers.
- `ops.platform_ops_signup_sessions(p_since, p_limit)`: Embedded Signup sessions that failed or
  were abandoned (still started or exchanging after they expired) with the stored failure reason
  and whether the company has an active number now. Numbers whose setup failed or has run for over
  30 minutes (with the step and error) and companies created since then without an active number
  are read directly: the platform role already reads `app.channel_accounts` and `app.tenants`.
- `ops.platform_ops_integration_failures(p_limit)`: current failures, each with its company, a
  label (a display phone number, the business account name, or the host of a store or endpoint
  URL; the rest of a URL, which can carry tokens, never leaves the database), the state, the error
  text HyFib stored from the provider's answer and since when: numbers needing reconnection or
  whose setup failed, WhatsApp accounts needing reconnection, failed store connections and store
  sync or webhook errors, failed payment account checks, failed catalog and Flow syncs, failing or
  auto-disabled webhook endpoints.

The platform role reads directly only what it could already read, plus the new dead-letter
records: failed, stuck and quarantined Meta and Razorpay receipts (`ops.webhook_receipts`,
`ops.webhook_quarantine`), failed emails by kind (`ops.email_outbox`, counts only: SMTP errors can
quote addresses) and security events by type
and severity (`ops.security_events`, counts only: details can hold addresses). Queue counts (ready,
deferred, active, failed jobs still retained) come from pg-boss's `getQueues()` through the web's
producer instance; they are the counts the worker refreshes about once a minute, and job payloads
are signed envelopes with ids only.

**Dead letters.** The dead-letter queue had no consumer: dead-lettered jobs stayed in pg-boss for
30 days, readable only with SQL, and a list of them cannot be read with a limit through pg-boss's
API. The worker now consumes it and records each job in `ops.dead_letters`: the source queue and
job, the envelope's kind, reference and company only if its signature verifies (otherwise none of
the three), the retries used, the error's name and code (an application error code or a SQLSTATE)
and the times. Error messages and stacks are not copied because they can quote data; the job,
with its output, stays in pg-boss for its 30-day retention and the worker's redacted logs have the
rest. The worker role may only insert rows (duplicates from a retried recording are ignored); rows
are purged 30 days after the job failed. Recording a batch is retried three times.

There is no redrive button. Every queue's work is a durable row that the minute sweeps re-signal,
so a redrive repeats what the sweep does, and `billing.auto-recharge` deliberately has no retries
(an attempt is reconciled before anything is charged again). The runbook's `boss.redrive` stays
available to engineers who fixed a cause. (Since ADR-108 platform administrators retry a dead
letter's job from the console: the sweeps do not re-signal the work of every queue, and
`boss.redrive` finds nothing once the worker has recorded the dead letter.)

**Two repairs**, open to both platform roles and written to the platform audit log (actor, reason,
result) in the same transaction:

- Retry a Meta or Razorpay webhook receipt that failed all 12 attempts or was quarantined, while
  its body is still kept (7 days): `ops.platform_retry_webhook_receipt` sets it back to pending
  with no attempts, and the sweep processes it again (processing is idempotent). This replaces the
  owner-role SQL in RUNBOOKS §4.
- Resolve a quarantine entry with a written resolution.

Neither reads or changes company data, so neither is written to a company's audit log.

**Health and signals** are derived in domain code from those facts, with thresholds that are
HyFib's own review heuristics, not Meta rules:

| Health issue                                                           | Severity |
| ---------------------------------------------------------------------- | -------- |
| Numbers, none active, some needing reconnection or failed              | critical |
| A WhatsApp account needs reconnection                                  | critical |
| An active number rated `RED` at its last check                         | critical |
| Last 24 hours: at least 20 outbound and at least 50% failed            | critical |
| A number needing reconnection or failed while others are active        | warning  |
| An active number rated `YELLOW` at its last check                      | warning  |
| Last 24 hours: at least 20 outbound and at least 10% failed            | warning  |
| A webhook endpoint failing, or turned off for failing in 7 days        | warning  |
| A failed store connection, payment account check, catalog or Flow sync | warning  |
| Dead letters in 7 days                                                 | warning  |
| Plan past due                                                          | warning  |

| Signal (7 days)                            | Flagged when                                                   |
| ------------------------------------------ | -------------------------------------------------------------- |
| Send failures                              | at least 100 outbound and at least 20% failed                  |
| Marketing opt-outs                         | at least 100 marketing templates delivered and opt-outs of 2%+ |
| `131050` (user stopped marketing messages) | at least 20                                                    |
| `131049` (Meta's per-user marketing limit) | at least 100                                                   |
| Complaint suppressions                     | at least 5                                                     |
| Number quality                             | an active number rated `RED` or `YELLOW` at its last check     |

A signal asks for a review; nothing is suspended automatically. Suspension stays a reasoned,
audited action on the company page.

**Pages.** Overview (totals and the companies needing attention), Onboarding, Integrations, Queues,
Signals and Usage; the company page gains a health card. Every page re-checks the platform actor.
The functions read every company on each view, which suits the test envelope (100 companies);
precomputed rollups and paging come with growth.

**Not built.** Alerts (email or pager) on these conditions, trends over time, number quality
updates from Meta's `phone_number_quality_update` webhook (quality is as of the last health
check), API request counts (not recorded; the plan's counter is shown since ADR-153), exports, the age of the oldest waiting job, and
acknowledging or snoozing an issue.

**Migrations 0026 and 0027.** 0026 adds `ops.dead_letters`, `ops.purge_dead_letters`, the four read
functions, `ops.platform_retry_webhook_receipt` and the definer policies and column grants they
need; 0027 builds an index on consent events by company and time concurrently.

## ADR-055 Company export and deletion: a streamed export with listed columns, deletion after 14 days by a resumable worker job, billing records kept (2026-09-28)

Decision: owners can take a full copy of their company's data at any time and can have the company
deleted (P5-11). Deletion is delayed 14 days so it can be cancelled, then runs in the worker in
bounded steps that survive restarts, and ends with a company row that holds nothing but what the
law or HyFib's own accounting needs.

**Export.** Owners (`tenant.export`, also while the company is suspended, restricted or pending
deletion) download a gzip-compressed JSON Lines file that the web streams from one read-only,
repeatable-read transaction in the company's scope:

- a header line (format `hyfib-w360-company-export`, version 1, company, export time, tables), one
  line per row (`{"table": ..., "row": {...}}`) and an end line with the row count of every table.
  A file without the end line is incomplete (the download broke).
- Every table with a `tenant_id` is either exported with named columns, or excluded with a reason
  (delivery queues, stored API responses, bindings, the email outbox, platform records). Within an
  exported table every column is either exported or named as omitted with a reason: credentials,
  secrets, token hashes, the registration PIN and Flow tokens are never exported. Tests fail when a
  table or a column is not classified, so new ones must be decided.
- Members are exported with their name and email; `tenant_id` is left out of rows (the header names
  the company); 64-bit integers (money in minor units) are strings.
- Nothing is stored: no object storage exists, and a stored copy of a whole company would be one
  more thing to protect and expire. One export runs at a time per company (an advisory lock), each
  start is audited (`tenant.exported`) and every owner and administrator is emailed, before the
  first line is written (so an export that is then refused or cut short is still reported).

**Deletion request and grace period.** An owner (`tenant.delete`, now also allowed while the
company is suspended or restricted: leaving must not depend on paying) types the company's address.
`app.request_tenant_deletion` records the current status in the deletion register
`ops.tenant_deletions`, sets the company to `pending_deletion` due in 14 days, writes the company
audit log, and the service emails every active owner and administrator. While pending, the company
works as if suspended (read, export, cancel), outbound work waits, public links and webhooks behave
as for a suspended company, and API keys are refused (as before). Owners cancel until the job
starts (`app.cancel_tenant_deletion`), which restores the recorded status, re-applying the plan
state (a lapsed plan restricts, a current one lifts a restriction; a suspension stays).

**Deletion run.** The minute billing sweep lists due deletions (`ops.tenant_deletions_due`,
including ones already running) and queues one signed `tenant.delete` job per company (singleton
per company, so one run at a time). A run deletes for up to five minutes and stops; the next sweep
starts the next run until the company is finished. A run:

1. starts the deletion (`ops.start_tenant_deletion`): records the owners and administrators to
   notify and releases the company's WhatsApp number bindings, so new Meta events are no longer
   routed to it;
2. cleans up at providers, recording every outcome (a failure is recorded, and named in the final
   email, but does not stop the deletion): unsubscribes HyFib's app from each WhatsApp Business
   Account (`DELETE /{WABA-ID}/subscribed_apps`, in Meta's official OpenAPI description), uninstalls
   HyFib's Shopify app (`appUninstall`) and deletes HyFib's WooCommerce webhooks, cancels the
   company's plan subscription at Razorpay at once (ADR-063, so nothing more is charged), and
   deletes HyFib's card mandate token at Razorpay;
3. deletes the company's rows through `ops.delete_tenant_data`, a batch at a time, each batch its
   own transaction, following a fixed order (`ops.tenant_deletion_steps`: children before parents;
   the two tables of the one foreign-key cycle, automations and their versions, in one statement;
   the two self-referencing tables in one statement each). Guard triggers let these deletes through
   because the function sets the retention-purge and erasure flags; its delete policies only match
   the company being deleted.
4. finishes (`ops.finish_tenant_deletion`) only when no row is left in any deletable table: the
   company row becomes a tombstone (status `deleted`, name "Deleted company", address
   `deleted-<id>` so the old address can be used again) and the register is completed. The
   owners and administrators recorded at the start get an email (addressed to them, not stored
   with the company). Platform staff see the register's dates, runs, row count and provider
   outcomes on the company's platform page; they cannot start, speed up or cancel a deletion (since
   ADR-090, platform owners schedule a deletion, and cancel the ones staff scheduled).

**Kept after deletion:** the tombstone company row; billing and tax records (wallet, ledger,
top-ups, card mandates with only safe card metadata, auto-recharge attempts, the Razorpay customer
reference and billing contact); plan history (`app.tenant_plans`), plan subscriptions and plan
payments (ADR-063); the deletion register; platform evidence (platform
audit log, support grants, security events); and people's own accounts, which may belong to other
companies. Everything else is deleted, including members, invitations, the company audit log,
contacts, consent history, conversations, messages, templates, campaigns, automations, CRM, growth,
Flows, commerce, stores, API keys, webhooks and queued emails. Consent history and the audit log
are the company's records: they are in the export.

**Not done at providers:** numbers are not deregistered (the business keeps its numbers and may use
them with another provider; deregistering could break another app on the same account); templates
and Flows stay in the business's WhatsApp account; Payment Links stay in the company's own Razorpay
account; WooCommerce keys cannot be revoked through the API (the email asks the owner to revoke
them); HyFib's Razorpay customer record is not deleted (the client has no such call).

**Backups:** deleted data stays in encrypted backups until they expire. After a restore, deletions
completed after the restore point are applied again, found in the old database's register or the
worker's `company deleted` log lines (RUNBOOKS §8).

**Found while building (fixed in the same migration):**

- Contact erasure left the number and message text in the requests of past sends
  (`app.send_intents.request`); erasure now redacts them.
- Shopify's redaction webhooks, payment webhooks of the company's own Razorpay account, chat links,
  the website button and the Flows data endpoint treated a company pending deletion as unknown, so a
  redaction received during the grace period was dropped; they now treat it like a suspended one.
- The ended-run guard no longer froze `pending_message_id` and `http_call_count` (lost in migration
  0022); both are frozen again.

**Not built:** a shorter grace period,
deletion started by platform staff (since ADR-090), deleting media files (no media storage exists), a stored export
with a download link, and other export formats.

**Migration 0028** adds the register and the step order, the deletion functions with their scoped
grants and policies, and the three fixes above.

## ADR-056 Step-up re-authentication: a sign-in within the last 15 minutes for actions that hand out credentials, move money or take the whole company (2026-09-28)

Decision: a few actions need the member to have signed in within the last 15 minutes. A member who
signed in earlier signs in again (password and, when it is on, two-factor), and the page they were
on comes back. The window is `RECENT_SIGN_IN_MINUTES` in the domain, and the authentication
library's own `session.freshAge` is set from it, so HyFib's check and the library's sensitive
endpoints agree.

**What needs it.** Actions a stolen session could use to take the company's data or money, or to
keep access after the session is gone:

- exporting the company's data and asking for its deletion (cancelling does not need it);
- adding a card for automatic top-ups, and turning automatic top-ups on or changing them (turning
  them off does not);
- saving the company's own Razorpay keys (payments for its orders go to that account);
- creating and rotating API keys (revoking does not);
- adding a webhook endpoint, changing one, or rotating its secret (turning one off, deleting it,
  test events and replays do not);
- making someone an owner, by invitation or by a role change (other roles do not);
- turning off the company-wide two-factor requirement (turning it on does not).

**How.** The web passes the session's creation time to `resolveTenantContext`, which puts it in the
tenant context (`signedInAt`); `assertRecentSignIn` in each of those service functions refuses with
`step_up_required` before anything is read, written or sent. A context without a sign-in time (not
from a browser session) never counts as recent. Pages that would otherwise offer the action (the
export link, the deletion form, adding a card, creating a key) show "Sign in again" instead; any
form whose action is refused shows the same prompt, which signs the member out and returns them to
the page after they sign in.

**Why a new sign-in rather than a password or code prompt** (SEC-8 had proposed a verification
endpoint): re-entering only the password would skip two-factor, and the library checks a two-factor
code for a signed-in user without its sign-in attempt limit, so a code prompt would need HyFib's own
attempt counting and storage. Signing in again reuses the whole protected flow: rate limits per
address, the two-factor attempt limit and lockout, trusted devices, and the security events and
emails the sign-in already produces. The cost is one more sign-in for rare actions.

**Not built:** WebAuthn or passkeys as the step-up factor, a step-up for platform staff actions
(their MFA is checked on every platform request), and per-action windows.

## ADR-057 Billing history: monthly statements computed from the ledger, payment receipts that are not tax invoices (2026-09-28)

Decision: companies read their service-credit history as **monthly statements**. Each paid top-up
has a **payment receipt**, and the billing managers get it by email. Both are computed on request
from the append-only ledger (0004_billing); nothing is stored or rewritten, so a statement viewed
twice shows the same postings. Reading needs `billing.read` (owners, administrators and the billing
role). Downloading a statement as CSV is audited like the report exports.

**Statements.** A statement covers one calendar month in the company's time zone, from local
midnight on the 1st to local midnight on the 1st of the next month. Where a daylight-saving change
removes or doubles midnight, the day starts at its first real instant (campaigns/schedule). Months
run from the month the wallet was created to the current month, which is shown as "month to date".
Everything on a statement comes from one repeatable-read, read-only snapshot:

- **Opening balances** of available and reserved credit are the sums of those accounts' entries
  before the month starts.
- **Lines** are the month's ledger transactions in time order, each with its change to available
  and to reserved credit and both balances after it.
- **Totals** per kind are credit added, service charges, refunds to card and chargebacks.
- **Closing balances** equal the opening balances plus the lines.

Holds and releases only move credit between available and reserved, so they change neither the
total nor any "money" total. The web shows 100 lines per page, with the running balance carried
across pages. The CSV has every line of the month (at most 100,000) between an opening-balance row
and a closing-balance row. Amounts are exact decimal rupees built from integer paise, and cells are
formula-safe (contacts/csv).

**Times.** Statements use the company's current time zone. Changing it moves the month boundaries
of every statement, including past ones, and each statement names the time zone it used. A posting
is dated when its database transaction started. In theory, a posting that starts just before
midnight and commits just after can appear in a statement viewed after it committed but not in one
viewed a moment earlier, so every statement shows when it was generated.

**Receipts.** A top-up credited from a captured Razorpay payment has a receipt page showing:

- the receipt number (the order receipt `tu_…`, which also appears in Razorpay);
- the payment date, amount and method as Razorpay reported it (card, UPI, net banking, …), plus the
  saved card's network and last four digits for an automatic top-up;
- the Razorpay payment and order ids;
- when the credit was added, and any refunds or chargebacks against the payment.

The method is recorded with the credit by `app.billing_record_payment_method`. It is a definer
function that sets the method once, and only on the top-up that the same payment id credited:
runtime code still cannot change a paid top-up. Top-ups credited before 0029 show no method.
Receipts never show or store card numbers.

**Not a tax invoice.** A receipt confirms a payment for prepaid service credit. Each receipt says it
is not a tax invoice. HyFib does not claim that it is a GST receipt voucher, which has prescribed
particulars (supplier GSTIN, place of supply, tax breakdown). Tax invoices and GST treatment of
prepaid credit wait for tax review (RELEASE-CHECKLIST, P5-05). The operator's legal name, address
and GSTIN are not configured anywhere yet.

**Emails.** When a top-up is credited, the company's billing managers get a payment-received email
with a link to its receipt, in the same transaction as the credit. An automatic top-up's email,
which already existed, now links to the receipt too.

**Not built:** statements for custom ranges or years, PDF files (the pages print cleanly, and the
browser saves them as PDF), stored or emailed monthly statements, staff views of a company's
statements, tax invoices, and credit notes for refunds. Monthly rollups are not built either: the
months list sums the wallet's whole ledger on each view. That is fine while only top-ups, refunds
and chargebacks post, but a high-volume charging service (holds per request) will need rollups.

## ADR-058 Refunds of unused service credit started by platform owners: a hold while Razorpay processes, the refund recorded from what Razorpay reports (2026-09-28)

Decision: a platform owner can refund part or all of a paid top-up from the company's platform
page, with a written reason. The amount is capped by two things: the top-up's unrefunded amount,
and the company's available credit when the refund is asked for. Credit already spent is never
refunded from the console, because that would leave the company owing money. Only one refund per
top-up can be open at a time. Refunds made in the Razorpay Dashboard keep working as before
(recorded from `refund.processed`).

**Flow.**

1. **Request.** `ops.platform_request_credit_refund` is SECURITY DEFINER and only the platform role
   can execute it. It refuses anyone but a platform owner, a reason shorter than 10 characters, a
   top-up that is not paid or partly refunded, and an amount outside ₹0.01 to the unrefunded
   amount. Under the wallet's row lock it also refuses an amount above the available credit. Then,
   in one transaction, it:
   - places a hold for the amount (reference `credit_refund`, kept for 90 days);
   - records the request in `app.credit_refunds` as `requested`;
   - writes the platform audit log (`platform.credit_refund_requested`, with the reason).
2. **Submit.** The minute billing sweep finds due requests (`ops.credit_refunds_due`) and queues one
   signed `billing.credit-refund` job for each. The job runs in the company's scope and writes the
   attempt down first. It then calls `POST /v1/payments/:id/refund` with the amount, speed
   `normal`, and `X-Refund-Idempotency: crf_<request id>`, so a repeated call after a lost
   response returns the same refund (R-076, R-086). The outcome:
   - Razorpay returns a refund: the request becomes `submitted` with the refund id, the billing
     managers are emailed, and a refund that is already `processed` is recorded at once.
   - Razorpay refuses (a 4xx other than 401, and other than 409, which means a call with this key
     is still being processed): the request becomes `failed`, the hold is released and the error
     code is kept.
   - A transient failure: the same call, with the same body, is retried after 1, 5, 15 and 60
     minutes, then hourly.
3. **Recording.** `refund.processed` (R-023), or the job's own check of a submitted refund (every 15
   minutes, backing off to 6 hours), fetches the refund and its payment from Razorpay. It then calls
   `app.billing_record_refund`, which is replaced in 0032. When the refund is for a top-up with an
   open request (the same refund id, or no refund id stored yet and the same amount), the function
   releases the request's hold and marks the request `processed`, in the same transaction as the
   refund posting. So the refund takes the credit the hold set aside, exactly once.
4. **Failure.** `refund.failed` (R-023), or a fetched refund that failed, marks the request
   `failed` and releases the hold, so the credit is available again. The billing managers are
   emailed.

**On statements** a staff refund shows as "Reserved for a refund" when asked. When Razorpay
completes it, "Refund reservation released" and "Refund to card" appear at the same moment. Total
credit drops only when the refund is processed.

**Why a hold and not a debit at request time:** a debit before Razorpay accepts would take credit
the company keeps if the refund fails. The hold keeps the credit aside and is released either way,
and the company cannot spend it meanwhile. A hold left open for 90 days is released by the
expired-holds sweep; a refund processed after that is recorded as a plain refund.

**Why platform owners only:** money leaves the platform. Operators see refunds but cannot start
them, and every request is in the platform audit log with its reason. Staff see a company's
balances, top-ups and refunds without a support grant: these are payments to HyFib, not the
company's content (`ops.platform_company_billing` returns amounts, statuses, dates and the payment
method, nothing else). The company sees its refunds on the Billing page and the receipt, but not
the staff reason or who asked (column grants).

**Company deletion:** no refund can be asked for once the company is pending deletion, and a
deletion that is due waits until no refund is open: the worker checks before it starts, because
nothing runs for a deleted company. For a company being deleted, a refund is made in the Razorpay
Dashboard and recorded from `refund.processed`, as before. Refund requests are billing records and
are kept after the deletion (ADR-055).

**Fees and timing:** Razorpay does not reverse its fee on a refund (R-079). The company gets the
full amount and the platform bears the fee. Refunds are paid from the platform's Razorpay balance
and normally take 5–7 working days (R-077, R-079). The email and the pages say so.

**Not built:** refunds asked for by companies, refunds of spent credit, refunds started here for a
company being deleted, instant refunds (`optimum`), several refunds of one top-up at once, a
platform-wide refunds list, and the daily reconciliation report (P5-05).

## ADR-059 Daily settlement reconciliation with Razorpay: every settled transaction matched against HyFib's records, missed payments and refunds recorded through the usual paths, the rest for platform owners (2026-09-28)

Decision: every day the worker reads Razorpay's settlement report for the previous day
(`GET /v1/settlements/recon/combined`, R-110, R-111), a page of up to 1,000 transactions at a
time, and matches each transaction against HyFib's records. The result is kept as a run (one per
day) with an item per transaction, for platform staff.

**Matching.** The report's `entity_id`, `payment_id` and `order_id` are used only to look up
HyFib's own records, like the ids in a webhook:

| Transaction       | HyFib's record                                                            | Result                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| payment           | a top-up credited by this payment                                         | matched, or `amount_differs`                                                                                                                                  |
| payment           | a card mandate's authorisation payment                                    | matched                                                                                                                                                       |
| payment           | a top-up's order, not credited by this payment                            | fetched and applied as a webhook would be: credited now (recorded), or `second_payment` (another payment paid the top-up), `amount_differs` or `not_captured` |
| payment           | a mandate's authorisation order, another payment                          | for review (`mandate_payment`)                                                                                                                                |
| refund            | a refund HyFib recorded (ledger key `refund:<id>`)                        | matched, or `amount_differs`                                                                                                                                  |
| refund            | a mandate's authorisation refund, or a refund of an authorisation payment | matched                                                                                                                                                       |
| refund            | a refund of a payment that credited a top-up, not recorded                | fetched and recorded as `refund.processed` would be (recorded), or `refund_not_processed` or `refund_exceeds_payment`                                         |
| refund            | a refund of another payment on a top-up's order (never credited)          | matched                                                                                                                                                       |
| payment or refund | none                                                                      | not HyFib's                                                                                                                                                   |
| transfer          | none (HyFib does not use Route)                                           | not HyFib's                                                                                                                                                   |
| adjustment        | none                                                                      | for review                                                                                                                                                    |

A transaction with an unknown type, another currency or fields HyFib cannot read is listed for
review too, and so is a payment or refund HyFib matched or recorded that carries a `dispute_id`: the
report documents only the dispute's id, not which transaction carries a chargeback's deduction
(R-111). A missed payment or refund with a dispute is still recorded first, so the same transaction
reads the same on every run; a transaction already waiting for a person keeps its own reason and
shows the dispute. Lost chargebacks are still recorded from `payment.dispute.lost`, fetched first.

**What the reconciliation records by itself** goes through the existing paths: `applyPaymentById`
credits only a payment fetched as captured, through `app.billing_credit_topup` (exactly once), and
a refund is fetched and recorded through `app.billing_record_refund`, which also completes a staff
refund request (ADR-058). This is the backstop for webhooks that never arrived. The top-up sweep
stops checking an order after 24 hours, and nothing checked refunds, so a lost `refund.processed`
left refunded credit spendable. Nothing else changes automatically. A person looks at amounts that
differ, second payments, adjustments, disputes and transactions that are not HyFib's; refunds are
made in the Razorpay Dashboard, and HyFib's records change only through the normal paths.

**The other direction.** Paid top-ups whose payment has not appeared in any settlement 7 days after
the payment are listed, oldest first. A top-up is listed only when every day from its payment to 7
days later has a completed run; the page counts the days without one. Seven days is HyFib's own
threshold: settlement is normally T+2 working days (R-082).

**Runs.**

- The minute billing sweep creates the run for the previous day in India from 06:00 India time. It
  also creates runs for any of the 7 days before that has none, but never for days before the first
  day ever reconciled, so turning this on does not backfill history. The documentation does not say
  which time zone the report's day uses (R-110); HyFib asks for India's calendar day.
- A platform owner can reconcile an earlier day (up to a year back) or run a day again, with a
  reason in the platform audit log.
- One signed `billing.settlement-recon` job per run. A claim takes a 15-minute lease and a new
  attempt number, and a stale attempt cannot write. Reading the report is safe to repeat: a failure
  that may pass (timeout, lost response, 429, 5xx) is retried after 5, 15, 60, 180 and 360 minutes.
  After 6 attempts, or on any other 4xx (keys, parameters), the run fails with the error and waits for a
  platform owner.
- Items are kept per run, type and transaction id: running a day again keeps what an earlier
  attempt recorded and people's resolutions. Items Razorpay no longer lists for the day are removed
  when an attempt completes.

**Stored per item:** the transaction id and type, amount, debit, credit, fee and tax, currency, on
hold, settled, the settlement id and UTR, times, the payment, order and dispute ids and the method;
the match (company, top-up, HyFib's amount), status and reason; a resolution (who, when, a note).
Not stored: notes, description, order receipt and card fields, which can carry another
integration's customer data. Runs total fees and tax for information; the platform bears
Razorpay's fee (ADR-058).

**Access.** Platform owners and operators read runs: payments to HyFib (company names, amounts,
provider ids), no company content. Platform owners run days and resolve items with a note, in the
platform audit log. The worker has no privileges on the tables: it writes through SECURITY DEFINER
functions that check the attempt, and cannot read them back.

**Retention:** runs and items are billing records, kept with the ledger.

**Not built:** alerts and emails (since ADR-066, emails to platform owners), a CSV export of a run, reconciling settlements with bank
statements (UTR), fee and tax accounting, companies' own Razorpay accounts, automatic handling of
adjustments, disputes and transfers, and instant settlements.

## ADR-060 Usage and rates for companies: Meta's rates in force, the next change and this month's estimate, read-only (2026-09-28)

Context: companies are billed by Meta directly (ADR-011), and HyFib estimates those charges from
the rate cards platform staff enter from Meta's published cards (ADR-028). Estimates already use
the card in force at the time they price: a campaign's at its scheduled time, the campaign runner's
at sending, Reports' at each message's time. But a company could not see which rates apply, or that
Meta's rates change on a given day (Meta's cards change on 2026-10-01, research M-075, and M-067
records service messages as free until 2026-09-30), and billing managers, who have `billing.read`
but not `reports.read`, could not see any estimate.

Decision: Billing → Usage and rates, for owners, administrators and billing managers
(`billing.read`), read in one repeatable-read, read-only snapshot:

- **The billing currency** chosen in Settings → Messaging (the currency Meta bills the company's
  WhatsApp account in). Without it the page says where to choose it and shows no rates.
- **Rates in force:** the published card for that currency with the latest effective time not after
  now: its effective time, the source staff copied it from (Meta's rate card page), and the list
  price (volume tier 0) of each market and pricing category. A category a market has no price for is
  shown as not priced, never as zero.
- **The next change:** the published card with the earliest effective time after now, with the date,
  every price that changes (old and new, and the difference), prices that appear and prices that go
  away. When no card is in force yet, the next card is shown as the rates from its date.
- **This month so far:** in the company's time zone, the delivered messages, how many Meta marked
  billable, free and not yet priced, and the estimated charges by category and in total, computed
  by the same function as Reports → Estimated Meta charges (ADR-028), with the same reasons for
  messages that cannot be priced. Members who can read reports get a link to the full report.

Drafts and withdrawn cards are never shown (a withdrawal corrects a card; the correction is a new
published card). The page is read-only: nothing is stored, and nothing is posted to the ledger or
taken from service credit. It says that Meta bills the company directly and that estimates are upper
bounds (list price, every billable message counted, volume tiers not applied).

Access: billing managers see aggregate counts and estimates of delivered messages by pricing
category, without any message, number, contact or market breakdown: a subset of what Reports shows
`reports.read` holders.

Not built: alerts or emails about an upcoming change (since ADR-065, an email a week before), estimates per number or campaign on this page
(campaigns show their own), a history of past cards, and exact charges (Meta's invoice is
authoritative; reconciling with `pricing_analytics` stays in the backlog, ADR-028).

## ADR-061 API access and monthly API requests by plan (2026-09-28)

Context: the public API (ADR-052) limits requests per key and per company per second, but not per
month, and every plan includes it. Plans (ADR-051) limit seats, numbers, teams, live automations and
automation runs; API quotas and API access by plan were left for later (backlog P5-01, P5-08).

Decision: one more limit per plan version, `api_requests_monthly`:

- **Meaning:** empty (NULL) for no monthly limit, 0 when the plan leaves the public API out, or the
  requests a company may make per monthly usage period (the plan's usage anchor, as for automation
  runs). A new column, so versions published before it keep NULL, which is what they gave: the API
  without a monthly limit. Published versions stay unchangeable (the guard compares the new column
  too). Complimentary access has no limit. No add-on packs yet.
- **What counts:** every request authenticated with the company's API key that passes the key and
  company rate limits, counted before the body is read or the request handled, so a malformed
  request or an idempotent replay counts too; a failed authentication or a rate-limited request does
  not. Counted in `app.usage_counters` (metric `api_requests`) for the period, atomically and never
  beyond the limit, and counted without a limit too, so companies and staff see the month's use.
- **Refusals:** a plan without the API gets 403 `forbidden` with reason `not_in_plan` on every
  request, and creating or rotating keys is refused with the same message (existing keys stay
  listed and can be revoked). When the month's requests are used, requests get 429 `rate_limited`
  with reason `quota_exceeded` and `Retry-After` counting the seconds until the next period. The
  OpenAPI document describes both.
- **Notice:** the minute plan sweep emails the billing managers once per period when the month's API
  requests reach the limit (`ops.api_quota_reached`, alongside the automation run notice).
- **Where it shows:** the Billing plan card and Settings → API keys (the month's use and limit, or
  that the plan does not include the API, with creating keys disabled); the platform plan form and
  page; the platform company page.

Not built: packs of extra requests, per-key or per-endpoint quotas, alerts before the limit, and
quotas for outgoing webhooks (deliveries are not API requests).

## ADR-062 A warning before a monthly limit is reached (2026-09-28)

Context: automation runs (ADR-051) and public API requests (ADR-061) are limited per monthly usage
period. The billing managers are emailed once the month's allowance is used up, when automations
have already stopped starting or the API is already refusing requests; nothing tells them earlier.

Decision:

- **When:** once a counter reaches 80% of its limit (rounded up) while still below it, the billing
  managers are emailed once for that counter, that is once per company, metric and period. A limit
  so small that 80% rounds up to the limit itself (1 to 4) gets no warning: the used-up notice is the
  first. A company that jumps from below 80% to the limit between two sweeps gets only the used-up
  notice.
- **How:** `ops.usage_warnings_due` lists counters of active companies with a limit, at or over the
  threshold, below the limit, neither warned nor announced; the limit is read from the company's
  current plan (with run packs for automation runs). The minute plan sweep then, in the company's
  scope, locks each counter (`SELECT … FOR UPDATE` while `warned_at` is empty), checks it again
  against the company's current limit and period, and sets `warned_at` in the transaction that
  queues the email, so of two sweeps that listed a counter only one sends it.
- **The used-up notices work the same way** (a fix to ADR-051 and ADR-061, which set `notified_at`
  first and emailed without checking the period): a counter of an earlier usage period is marked
  without an email, since a lowered limit or a new paid period could otherwise make last period's
  count look like this month's; a counter no longer due under the current limit, because the limit
  changed after the sweep listed it, is left unmarked for a later sweep to decide.
- **Where it shows:** the email says how much is used, what happens at the limit and when the next
  period starts; the Billing plan card marks a counter at or over the threshold as nearly used.

Not built: a threshold chosen per company (a share per company since ADR-144) or per member,
warnings for seats, numbers, teams or live automations (they refuse additions, they do not run out
during the month), and in-app notices.

## ADR-063 Paying for plans with Razorpay Subscriptions (2026-09-28)

Context: ADR-051 left charging for plans out, so HyFib staff set paid periods, for example after an
invoice is paid outside HyFib. ADR-012 chose Razorpay Subscriptions for plans. Companies cannot pay
for their plan in HyFib, and a lapsed plan restricts them until staff act.

Decision:

- **What a company pays for:** the plan version it is on, with the add-ons HyFib staff set: the
  version's price plus extra seats, extra numbers and run packs at the version's prices, every 1, 3
  or 12 months as the version says (add-on prices are per billing interval, like the price). The
  plan form says prices are before tax, so platform owners set the tax added to plan prices (a
  percentage with up to two decimals, 0 to 50%, stored in basis points, with a reason in the
  platform audit log); until it is set, paying is not offered. Each subscription keeps its subtotal,
  tax and total, so a later rate change never changes it. A company can start paying while
  trialing, past due, or after its plan expired or was canceled, on a published version whose total
  is at least ₹1 (Razorpay's minimum); not while a paid period staff set is running, and not with
  complimentary access. Changing the plan or add-ons stays with staff. Razorpay documents that, under
  RBI's card mandate rules, a charge above ₹15,000 on an Indian card needs the payer's approval
  through their bank every time, so the page says so for such totals.
- **Starting:** owners and billing managers (`billing.manage`) with a recent sign-in (ADR-056), one
  start at a time per company (an advisory lock). HyFib records its subscription first
  (write-ahead), then creates a Razorpay plan for the total (`POST /v1/plans`: period `monthly`,
  `quarterly` or `yearly`, interval 1) and a subscription (`POST /v1/subscriptions`: five years of
  cycles, so `total_count` 60, 20 or 5, within Razorpay's ten-year limit; `customer_notify` on so
  Razorpay tells the payer about charges, failures and card updates; the authorisation open for one
  hour through `expire_by`). Checkout opens with the `subscription_id`. The subscription starts at
  once: the first charge is taken in Checkout and the paid period starts then, so the rest of a
  trial is not carried over, and the page says so. An unfinished Checkout is reopened while its
  hour lasts; after that it is replaced, and the old one is cancelled at Razorpay so it can never be
  authorised. A creation that fails or gets no answer marks ours failed (the sweep does this after
  ten minutes for one that never finished); a Razorpay subscription created anyway cannot be
  authorised after `expire_by`.
- **Razorpay decides, HyFib follows:** the browser, the webhook payload and notes are never enough.
  Checkout's signature (`payment_id|subscription_id`, checked against our stored subscription id)
  only prompts a fetch. Every `subscription.*` event, the Checkout confirmation, the sweep and a sync
  before a period-end transition fetch the subscription, and its invoices only while Razorpay counts
  more paid cycles (`paid_count`) than HyFib recorded. A paid invoice becomes a plan payment (payment
  id unique) only when it is for our subscription, has a billing period, was paid in INR for exactly
  our amount, and its payment fetched from Razorpay is captured for the same amount. A subscription
  that ended stays ended, a status HyFib does not know keeps ours, and an answer with fewer paid
  cycles than we stored (an older read) changes nothing. While the subscription is active and a plan
  payment covers its current cycle, a definer function in the company's scope makes the plan state
  active for exactly Razorpay's `current_start` to `current_end`, links it to the subscription and
  writes the company's audit log; a new paid period restarts the monthly usage period, as when staff
  set one (ADR-051). A payment covers the cycle that holds the middle of its invoice's billing
  period, because Razorpay's example invoices start and end at midnight India time while the
  subscription's cycle has exact times. A subscription whose plan version or add-ons no longer match
  the company's plan state is never applied.
- **Missed events:** the sweep re-reads each live subscription daily, and hourly once its paid cycle
  has ended (except when Razorpay has stopped retrying), so a missed renewal event costs at most an
  hour after a period ends; the plan sweep syncs a subscription again just before moving its plan
  state at the end of a period.
- **Failed charges:** Razorpay retries a failed charge (`pending`) and then stops (`halted`). HyFib
  shows it, emails the billing managers when it happens, and lets time decide the plan state: at the
  end of the paid period the version's grace days (past due) and expiry apply as before, with
  wording for a company that pays by subscription. A later successful charge (after the payer
  updates the card through Razorpay's email) makes the plan active again. Billing managers are also
  emailed when a payment is recorded.
- **Cancelling:** owners and billing managers (recent sign-in) cancel an active subscription at the
  end of the paid period (`cancel_at_cycle_end`), and one not yet charged at once; the plan then ends
  as canceled when the period ends, without grace days, and the billing managers are emailed.
  Platform owners can cancel a company's subscription at once, with a reason in the platform audit
  log, for example before changing its plan; the paid period stands. Staff plan changes are refused
  while a company has a subscription that can still be authorised or charged. Deleting a company
  cancels its subscription at Razorpay first, and the outcome is kept with the deletion (ADR-055).
- **Other Razorpay events:** a subscription charge also sends `payment.*` events. A payment on no
  order of HyFib's whose invoice belongs to one of our subscriptions syncs that subscription instead
  of being quarantined as an unknown order; an event for a subscription HyFib does not know is
  quarantined. The daily settlement reconciliation (ADR-059) matches recorded plan payments by
  payment id, looks up unknown payments the same way (recording a missed one), and leaves refunds of
  plan payments to a person, since HyFib does not refund them (since ADR-103 it records them).
- **Flag:** `RAZORPAY_SUBSCRIPTIONS_ENABLED`, off by default: Razorpay Subscriptions (and Flash
  Checkout, which Razorpay requires for them) must be activated on the account, and the tax
  treatment of plan prices needs review (ADR-012). Events for existing subscriptions are processed
  either way.

Uncertain, from Razorpay's documentation and Node SDK only (no test-mode account was available):
whether an invoice's `billing_start`/`billing_end` always fall inside the subscription's cycle as
the midpoint rule assumes; how soon after a charge `paid_count` and the paid invoice can be fetched;
whether every subscription charge's payment carries `invoice_id` (one that does not stays
quarantined for a person); and how a quarterly plan behaves on domestic cards, whose mandates
Razorpay registers "as presented" for frequencies other than weekly, monthly and yearly. The
release checklist has the test-mode checks.

Not built: billing that starts at the end of a trial (since ADR-102), self-serve plan and add-on changes with
proration, pausing, offers, plan payment receipts (since ADR-064) and GST invoices, refunds of plan payments (since
ADR-103), and emails about a subscription beyond charges, failures and endings.

## ADR-064 Receipts for plan payments (2026-09-29)

Context: ADR-063 records each plan payment Razorpay charges for a company's subscription, and the
Billing page lists them, but a company had nothing to keep for its records, while every top-up has
a receipt (ADR-057).

Decision: each recorded plan payment has a **receipt page** (`/c/<company>/billing/plan-payments/<id>`),
read with `billing.read` in the company's scope like top-up receipts. It shows:

- the receipt number: Razorpay's invoice id for the charge (`inv_…`), which Razorpay also shows;
- the plan version and billing interval, and the add-ons the subscription covers;
- the billing period of Razorpay's invoice, in the company's time zone;
- the subscription's subtotal, tax rate and tax, and the amount paid. The breakdown is shown only
  when the payment is exactly the subscription's total, as every recorded payment is (ADR-063);
- when it was paid and the method Razorpay reported, the Razorpay payment, invoice and subscription
  ids, the company's name and billing email.

Like top-up receipts, it says it is a payment confirmation and **not a tax invoice**; the operator's
legal name, address and GSTIN are not configured, and tax invoices wait for tax review. HyFib does
not refund plan payments, so a refund made in Razorpay's Dashboard is not shown (the daily
reconciliation leaves it to a person). Since ADR-103 the receipt lists every refund of the payment,
HyFib's own and those made at Razorpay. Nothing is stored: the page is computed from the plan payment
and its subscription. The payments table in Billing links each payment to its receipt, and the
payment-received email links to the receipt of the payment that paid the new period.

Not built: tax invoices, credit notes, receipts in platform pages, and plan payments in the monthly
service-credit statements (they never touch the wallet).

## ADR-065 A notice before Meta's rates change (2026-09-29)

Context: Billing → Usage and rates (ADR-060) announces the next published rate card for the
company's billing currency, but only to someone who opens the page. Meta's cards change on
2026-10-01 (research M-075), and companies plan campaigns around their costs.

Decision:

- **Who and when:** once per company and published card, the company's billing managers (owners
  and the billing role, as for other billing notices) are emailed when a published card for the
  company's billing currency (Settings → Messaging) takes effect within the next 7 days. Companies
  without a billing currency, and companies that are suspended, restricted or being deleted, get
  none.
- **What:** the date and time the card takes effect in the company's time zone; how many prices it
  changes, adds and no longer lists compared with the published card in force just before it (for
  a second upcoming card, the first), or that it is the first card for the currency; up to three
  of the largest changes (by relative size; new and dropped prices last); that HyFib's estimates
  switch at that time and that Meta bills the company directly; a link to Billing → Usage and rates.
- **Once:** `app.rate_change_notices` (company, card, currency, effective time, when sent; unique
  per company and card; append-only) is written in the transaction that queues the email. The
  minute billing sweep lists due pairs through `ops.rate_change_notices_due` (a definer function
  returning ids only, owned by `w360_definer`, which may read only published cards' id, currency,
  status and effective time, the companies' billing currencies and which card each company was
  told about). Each pair is then checked again in the company's own scope before anything is
  written, so a card withdrawn, a currency changed or a company suspended after the listing sends
  nothing; two sweeps at once send one email (the unique key). A failure (an email that cannot be
  written) records nothing, and the next sweep tries again; the other companies are not held up.
- A card published less than 7 days before it takes effect is announced at once; a card published
  after its effective time is not announced (it is already in force). A withdrawn card sends
  nothing more; its correction is a new card with its own notice. A company that chooses a billing
  currency later is told about the cards still to come within the week.
- Records are exported with the company and deleted with it (ADR-055). Nothing is charged or
  posted; the notice is informational.

Not built: a setting to turn the notice off, notices for currencies other than the billing
currency, notices to other roles, and in-app banners (the Usage and rates page already shows the
next change).

## ADR-066 Alerts for reconciliation findings (2026-09-29)

Context: the daily settlement reconciliation (ADR-059) leaves what does not match on Platform →
Reconciliation for a platform owner, and a day can fail until an owner runs it again, but nobody
hears of either unless they open the page. Money that moved without HyFib's records following waits
unseen.

Decision:

- **When:** a day's run finishes with transactions still waiting for a person (does not match,
  needs a look, not HyFib's; not resolved), or fails (a refusal, or six attempts). Retrying days,
  days where everything matched or was recorded, and days whose transactions were all resolved
  first send nothing.
- **Who:** platform owners, who resolve transactions and run days again (operators only read), by
  their account email. While there is no platform owner nothing is marked, the worker logs a
  warning, and the email goes out once there is one.
- **What:** one email per sweep listing the days (up to 10, oldest first): for each, how many
  transactions wait by status, or that the check failed with its last error (cut to 400
  characters); a link to the day, or to the reconciliation page for several days. It names no
  transaction, amount or company: those stay on the page, behind platform sign-in and two-factor
  authentication.
- **Once:** each finished attempt is emailed once. `ops.settlement_recon_runs.alerted_attempt`
  records the attempt (the run's `attempt_seq`) emailed; the minute billing sweep lists attempts
  not emailed yet through `ops.settlement_recon_alerts_due` (ids only) and marks each through
  `ops.settlement_recon_mark_alerted`, which returns what the email says, counted under the run's
  row lock, in the transaction that queues the emails. Two sweeps at once send one email; a run
  that moved on to a new attempt is not marked for the old one. Running a day again is a new
  attempt, and its outcome is emailed again. The recipients come from
  `ops.settlement_recon_alert_recipients`. All three are SECURITY DEFINER functions executable by
  the worker's role only. Runs finished before migration 0039 are marked as emailed.
- Emails go through the encrypted outbox as a new `platform.notice` kind, not tied to a company.

Not built: alerts for paid top-ups that no settlement shows (the reconciliation page lists them),
a digest schedule or thresholds, alerts to other channels (chat, pager), and alerts for other
platform conditions (the operations console shows them).

## ADR-067 Reminders before API keys expire (2026-09-29)

Context: API keys (ADR-052) are created to expire after 30, 90 or 365 days, or never. When a key
expires, the public API refuses the integration using it without warning; the expiry shows only on
Settings → API keys, which nobody opens while an integration works.

Decision:

- **Which keys:** a key that can still be used (not revoked, not expired), was not rotated, and
  expires within the next 7 days. A rotated key is left out: its shortened expiry (at most 72 hours
  of overlap) was chosen by whoever rotated it, and the new key is reminded in its turn. Keys that
  never expire need no reminder.
- **Who:** the company's active owners and administrators, the roles that manage keys
  (`developer.manage`), as for disabled webhook endpoints. Companies being deleted get none (their
  keys no longer work); suspended and restricted companies do, because their keys still read.
- **What:** the key's name and public prefix (never a token, which HyFib does not keep), when it
  expires in the company's time zone, who created it and when, when it was last used or that it
  has not been used, how to rotate it (same name, scopes and expiry period, up to 72 hours of
  overlap), and a link to Settings → API keys. The key's name is put on one line for the subject.
- **Once:** `app.api_keys.expiry_reminded_at` records when the reminder was queued; the key's guard
  keeps it once set. The minute messaging sweep lists due keys through
  `ops.api_key_expiry_reminders_due` (a definer function returning company and key ids only,
  executable by the runtime role only, over a partial index), then locks and checks each key again
  in its company's own scope before marking it in the transaction that queues the emails: a key
  revoked, rotated or expired after the listing, or a company being deleted, gets nothing, and two
  sweeps at once send one reminder. A failure rolls back and the next sweep tries again; other keys
  are not held up. An expiry can only come sooner, and only through rotation, so a key is reminded
  at most once.
- Settings → API keys marks keys that expire soon and says when the reminder was emailed. The mark
  is exported with the company's keys and deleted with them (ADR-055).

Not built: a second reminder closer to the expiry, reminders to other members or by other channels,
extending a key's expiry (rotation is the way to renew a key), and alerts when an expired key is
still being presented.

## ADR-068 Tested API rate limits, and full token buckets deleted (2026-09-29)

Context: the public API's rate limits (ADR-052: failed authentication per client address, then each
request per key and per company) run on PostgreSQL token buckets (`ops.rate_limit_buckets`,
migration 0003), and no automated test exercised them or the bucket itself. Buckets were never
deleted: every API key, company, WhatsApp number and client address ever limited kept a row, and
failed-authentication buckets are keyed by the client's address, so addresses were kept without
end (migration 0003's note said keys were only ids).

Decision:

- **Full buckets are deleted.** A bucket whose tokens, refilled for the time since its last use,
  reach its capacity limits nothing and behaves exactly like a missing one: the next request starts
  a full bucket and takes a token from it. The minute messaging sweep deletes such buckets through
  `ops.purge_rate_limit_buckets` (SECURITY DEFINER, executable by the runtime role only; the definer
  role may select and delete buckets, and the runtime role still cannot delete them). A bucket taken
  from after it was listed is checked again and kept. A client address is kept only while its
  failed attempts limit it: at most 100 seconds after the last one (20 attempts, one back every 5
  seconds), plus up to a minute until the sweep.
- **The limits are domain functions.** `admitFailedApiAuthentication` (per client address; requests
  whose address is unknown share one bucket) and `admitApiRate` (the key's bucket, then the
  company's; a request the key refuses takes nothing from the company) are what the web gate calls,
  so the integration tests exercise the gate's own code.
- **Tests:** a bucket's burst and refill up to its capacity, atomic takes under concurrency, the
  three API limits, the purge (full buckets and failed-authentication addresses deleted, limiting
  ones kept, a deleted bucket starting full), and an e2e burst of 120 requests on one key refused
  with 429 and `Retry-After: 1` and served again after the wait. Tests move a bucket's last use back
  instead of waiting.

Not built: edge rate limits in front of the app (a deployment item), limits per endpoint, a limit on
successful authentications per address, and hashing the address in the bucket's key (it is kept
only while it limits).

## ADR-069 Emails someone is waiting for go ahead of notices (2026-09-29)

Context: every email is one `email.send` job, and the worker's email queue works through them in
order at about two a second per worker process (four slots, each fetching one job, pg-boss waiting
between fetches). A notice to many people at once, such as a reconciliation alert to every platform
owner or a rate change notice to many companies' billing managers, queued ahead of a sign-up's
address confirmation delays it by as long as the burst takes. The local e2e run found it: a sign-up
waited more than 30 seconds for its confirmation email behind an alert to 73 platform owners.

Decision: emails someone is waiting for on a page, the address confirmation (`auth.verify_email`)
and the password reset (`auth.reset_password`), are queued at priority 10 and every other email at
0 (`emailPriority`). pg-boss fetches higher priorities first (its fetch orders by priority, then
creation time), so a waited-for email is sent next whatever is queued. The outbox sweep, which
signals rows whose job was lost, uses the row's kind for the same priority. Nothing else about
delivery changes: notices still go out in order, at the same rate.

Not built: a higher sending rate for the email queue (a notice to many recipients still takes about
half a second per recipient per worker process), and priorities for other kinds.

## ADR-070 Text replies through the public API (2026-09-29)

Context: integrations receive customers' messages through the `message.received` webhook (ADR-053)
but could answer only with approved templates through `POST /api/v1/messages` (ADR-052). Inside
WhatsApp's customer service window, 24 hours after the customer's last message, members answer in
the inbox with free-form text; an integration (a helpdesk, an order system, a company's own
assistant) could not.

Decision:

- **A new scope,** `messages.reply` ("Reply with text"), granted only by members who hold
  `inbox.reply`, as for `messages.send`. Keys keep their scopes (the key guard), so no existing key
  gains it; migration 0042 widens the scopes check.
- **One operation:** `POST /api/v1/messages` takes `type`: `template`, the default, so existing
  requests are unchanged, or `text`, with `to`, an optional `from` (the number the contact wrote
  to; optional with one active number), `text` (1 to 4,096 characters, trimmed) and `previewUrl`
  (off unless asked for). The OpenAPI operation is renamed from `sendTemplate` to `sendMessage`
  before any release, with a `oneOf` body. Any other `type` is refused.
- **Only inside the window:** a text goes to an existing contact with a conversation on that number
  whose last message is at most 24 hours old, checked under the conversation's row lock, with the
  same `Idempotency-Key` rules as templates. A number that is not a contact, has no conversation
  there, was erased or last wrote more than 24 hours ago gets one answer, 412 with reason
  `window_closed`, so a key without `contacts.read` learns no more than a sent reply would tell it.
  The contact is never created. The worker checks the window again before sending, as for the
  inbox, and a message whose window closed in between fails with `window_closed`.
- **Sent like a member's reply:** to the contact's WhatsApp id for the number's account, through the
  send pipeline and its per-number rate. The message has `sender_type = 'api'` and the key, so
  `GET /messages/{id}` (now with `type`), status webhooks and the inbox, which shows "API (key
  name)", tell where it came from.
- **It takes the conversation over from an automation,** as a member's reply does: the run ends as
  taken over (`api_replied`, migration 0042) and its queued messages are cancelled, so the bot and
  the integration never answer at once.
- **It is not a member's reply:** the conversation keeps its status, assignee and unread count, and
  a customer waiting for a member keeps waiting. Reply turns and the Inbox SLA metrics are
  unchanged, and an automation ended by the API opens a hand-off turn like other take-overs. An
  integration's acknowledgement ("we got your message") must not hide a customer who still waits
  for a person; members resolve conversations an integration answered in full.

Not built: media, location, interactive (buttons and lists) and reaction messages through the API;
replying to a given message (context); contacts known only by a WhatsApp user id (the API addresses
numbers); resolving or assigning conversations through the API; conversation and message lists.

## ADR-071 Alerts for payments no settlement showed (2026-09-29)

Context: Platform → Reconciliation lists paid top-ups whose payment no settlement showed 7 days
after the payment, once every day in between was reconciled (ADR-059). A payment can be missing
from settlements because Razorpay holds it, because it was refunded or disputed in the Razorpay
Dashboard, or because HyFib's records are wrong. The list was the only place such a payment
showed: nobody heard of it unless they looked (ADR-066 left it out).

Decision:

- **Who and when:** platform owners are emailed once about each payment on that list, by the
  minute billing sweep, like the reconciliation alerts (ADR-066): the same recipients (operators
  only read) and the same `platform.notice` kind.
- **One definition:** `ops.settlement_unsettled_topups()` holds the rule: paid or partly refunded
  top-ups with a payment, no settlement item for the payment, and every day from the payment's day
  (India time) to 7 days later reconciled. The page's list (migration 0034's function, replaced in 0043) and the alerts both read it, so they cannot disagree; a test checks that every payment on
  the list was emailed. It runs only inside the definer functions.
- **Once:** `ops.settlement_unsettled_alerts` holds a row per payment emailed. The sweep lists due
  payment ids (`ops.settlement_unsettled_alerts_due`), then `ops.settlement_mark_unsettled_alerted`
  checks each against the definition again and records it in the transaction that queues the
  emails. A payment settled or refunded in between is not recorded; a concurrent sweep waits on the
  first one's insert and then records nothing, so two sweeps send one email. With no platform owner
  nothing is recorded, and the worker warns.
- **What:** how many payments and the days they were paid (India time), what to check (a hold, a
  refund or dispute made in the Dashboard, HyFib's records) and where the list is. No company,
  amount or payment id: those stay on the page, which now says when owners were emailed about each
  payment. Payments already on the list when this ships are emailed by the first sweep, since
  nobody was told about them.

Consequences: the minute sweep evaluates the definition each time, a pass over paid top-ups since
the first reconciled day with index lookups for each payment's settlement items and runs. This was
not measured at production volumes; if the sweep slows, the listing is the place to narrow.

Not built: plan payments (the reconciliation matches them by payment id, ADR-063, and they are not
on this list), reminders while a payment stays unsettled, thresholds by amount, other channels.

## ADR-072 Reading conversations and messages through the public API (2026-09-29)

Context: integrations hear of new messages through the `message.received` webhook (ADR-053) and can
reply with text (ADR-070), but the API had no way to read a conversation: an integration that
missed webhooks (downtime, a new install) or needed the thread before replying could only read the
status of messages it had sent itself. Conversations hold what customers wrote, so reading them is
the most sensitive read the API offers.

Decision:

- **Scope:** `conversations.read` ("Read conversations"), granted only by members who hold
  `inbox.read_all`: a key reads every conversation of the company, so the member who grants it
  must be able to read them all. Keys are created by owners and administrators
  (`developer.manage`), who hold it today; the check keeps a member whose roles change from
  granting more than they read. It does not write, so suspended and restricted companies can still
  read.
- **Endpoints:** `GET /api/v1/conversations` (a page, newest conversation first, filtered by
  `status`, `contactId`, `channelId` and `updatedSince`), `GET /api/v1/conversations/{id}` and
  `GET /api/v1/conversations/{id}/messages` (a page, newest message first). Pages are keyset pages
  on the creation time and id, which never change, so paging never skips or repeats a conversation;
  `updatedSince` (the conversation's `updated_at`, kept by its trigger) lets an integration catch up
  on what changed since its previous pass. The trigger stamps the time the change's transaction
  began, so a change still being saved while a pass read can carry an earlier time than the pass:
  the documentation tells integrations to ask from a little before the previous pass began (a
  minute) and to expect some conversations again, rather than promising an exact feed.
- **What a conversation says:** its status, whether a member is assigned (not who), the unread
  count, the last message and last inbound times, and when WhatsApp's customer service window ends
  (24 hours after the contact last wrote), which tells whether a text reply can be sent. No preview
  text, team or member ids.
- **What a message says:** the vocabulary of the webhooks, so a message reads the same in both:
  direction, type, `text` (the text, a caption, the title of a tapped reply, a reaction, a location's
  name; for outbound messages the text, a template's rendered body or an interactive message's
  body), the reply tapped, the media type (never the media), the template's id and name, `sentBy`
  (`agent`, `bot`, `campaign`, `api` or `system`) and the API key for messages sent through the API,
  the status and its time, and an error. Internal notes are not messages and are not returned.
- **Erased contacts:** their conversations are not listed and read as not found, as their contacts
  do (erasure already redacted the messages).
- A new index on conversations by company and creation time serves the pages, built concurrently
  in its own migration; messages already have one per conversation.
- **Exact cursors:** a keyset cursor carries the last row's time as PostgreSQL keeps it, to the
  microsecond (`exactTimestamp`), not a JavaScript date. Writing these pages showed that cursors
  built from dates lost the rows that shared the page's last millisecond but came after it, which
  rows written in one transaction always do: the contacts list and export, API contacts, the inbox
  thread's older messages and the audit log skipped rows at page ends. They, campaigns and store
  orders now use the exact cursors; cursors issued before still read, and a cursor whose time or id
  PostgreSQL would refuse is a validation error, not a failed query.

Not built: writing to conversations (resolving, assigning, notes), member and team names, media
downloads, full-text search, a messages feed across conversations, filtering by assignee or team.

## ADR-073 Refunds of unused credit asked for by companies, decided by platform owners; a platform-wide refunds list (2026-09-29)

Context: since ADR-058 a platform owner can refund unused service credit from a company's platform
page, but a company had no way to ask except by writing to support, and platform staff had no list
of refunds across companies (both listed as not built there).

Decision:

- **Asking:** members with `billing.manage` (owners and billing managers) and a sign-in within the
  last 15 minutes (ADR-056) ask from a paid top-up's receipt for a refund of part or all of it, with
  a reason of 10 to 1,000 characters. The amount is at most what is left of the payment and the
  company's unused credit at the time; no request while a refund of the top-up is in progress, one
  open request per top-up (a partial unique index), at most 5 requests per company in 24 hours
  (counted under a per-company advisory lock), none once the company asked for its deletion (its
  status is read in the request's transaction under a share lock: a deletion asked for meanwhile
  waits for the request, or the request sees it and is refused). The company can withdraw an open
  request. A request moves no money and holds no credit.
- **Deciding:** only a platform owner decides, on `/platform/refunds` (operators see it).
  `ops.platform_decide_credit_refund_request` locks the open request; approving calls
  `ops.platform_request_credit_refund` (ADR-058) for the request's amount in the same transaction, so
  every check runs again under its locks (the top-up, what is left of it, the unused credit now, a
  refund in progress, a company being deleted): a request that no longer fits is refused with the
  reason and stays open for a decline. Declining needs a note the company reads. Both are in the
  platform audit log; who decided is not shown to the company (column grants).
- **Hearing about it:** the minute billing sweep emails platform owners once about new requests (a
  count only: no company, amount or reason, as the reconciliation alerts of ADR-066 and ADR-071), and
  a company's billing managers once when a request is declined, with the note. Each is marked in the
  transaction that queues the email; the listing of declines runs across companies but each is
  marked in the company's own scope. An approval needs no email of its own: the refund's emails of
  ADR-058 follow (submitted to Razorpay, failed).
- **The refunds list:** `/platform/refunds` also lists every refund of service credit across
  companies (staff-started or answering a request), newest first on exact keyset pages (ADR-072),
  with its status, error and times. Payments older than about 6 months may be refused by Razorpay for
  a normal refund (R-077); the list shows each top-up's payment date for that judgement.
- **Data:** `app.credit_refund_requests` is a company table (RLS, the company reads all but who
  decided and the notice marks, inserts open requests and moves an open request to withdrawn only).
  It is exported with the company's data and deleted with the company (ADR-055); the refunds it led
  to stay as billing records.

Not built: requests for spent credit or plan payments, approving a different amount (a platform owner
declines with a note and refunds from the company's page instead), several open requests per top-up,
reminders about requests waiting, and in-app notices.

## ADR-074 Outgoing webhook events for conversations and contacts (2026-09-29)

Context: the webhooks of ADR-053 tell integrations about messages, consent and templates. A helpdesk
or CRM kept in step with HyFib also needs to hear when a conversation is resolved, reopened or
picked up by a person, and when a contact is added, changed or erased; without that it has to poll
the API (ADR-072) and cannot hear of erasure at all.

Decision:

- **Five event types**, chosen per endpoint like the others (an endpoint may now take all 9):
  - `conversation.status_changed`: the status moved between open, pending and resolved, whoever
    moved it (a member, routing, an automation, or the contact writing to a resolved
    conversation). It reports the status reached and the one before.
  - `conversation.assignment_changed`: a member was assigned to a conversation nobody had, or the
    conversation lost its member (unassigned, the member removed, routing). A move from one member
    to another is not sent: like the API, webhooks name no members or teams, so it would show no
    change. It reports whether a member is assigned.
  - `contact.created`: a contact was added, whatever the source (a first message, a member, an
    import, the API, a store).
  - `contact.updated`: the contact's name, number, email or tags changed. Custom field values are
    not part of the API's contact and do not send it (since ADR-112 they are, and a change of one
    sends it); consent has its own event.
  - `contact.erased`: the contact was erased, so a receiver can delete its copy.
- **Capture** by triggers in the transaction that makes the change, as ADR-053: on
  `app.conversations` (status; an assignee appearing or going), `app.contacts` (added; name,
  number or email changed while not erased; erased) and `app.contact_tags` (added or removed).
  Conversation events are one per change.
- **One contact event per contact and transaction.** Adding a contact with its tags, or changing
  its name and email in one save, captures one event: the event row keeps the id of the top-level
  transaction that captured it (`captured_xact`, the same inside savepoints, and gone with a
  rolled-back savepoint), and a partial index finds it. A contact added in the transaction is sent
  as `contact.created` only: `contact.created` and `contact.updated` are captured when an active
  endpoint takes either, and delivered to the endpoints that take the event's own type, so an
  endpoint that takes only updates hears nothing about a contact being added. Erasing deletes the
  created or updated events its own transaction captured (erasure removes the tags first), so an
  erasure sends `contact.erased` only.
- **Payloads are built when delivered** (ADR-053). Conversation events carry `conversation` (id,
  status, the previous status for status changes, whether a member is assigned, when it was
  resolved), `contact` (id, number and name, null once erased) and `channel`, as the message
  events do. The fact the event reports (the status and the one before, or whether a member is
  assigned) is as captured; the rest is the conversation as it is when delivered. Contact events
  carry `contact` in the API's words (id, name, number, email, tags, consent, source, created)
  and `erased`; an erased contact is sent with its id, source and creation time only, whichever
  event is delivered.
- **Volume:** an import sends one `contact.created` per contact added to each endpoint that takes
  it, delivered like any other event (ADR-053).
- **Migrations:** 0047 widens the event type checks, adds `captured_xact`, the capture functions
  and the triggers; the check on `app.webhook_events` is added `NOT VALID`, so the rows already
  there are not scanned under the lock taken to change it. 0048 builds the partial index
  concurrently and 0049 validates the check, neither blocking writes. No endpoint can take the new
  types before the web app of this release runs, which is after the migrations, so the lookups
  the index serves never run without it.

Not built: custom field changes (since ADR-112), member and team identities (and so moves between
members or teams), conversations started, notes, merges, events for campaigns, automations or orders, and
filters beyond the event type.

## ADR-075 Resolving and reopening conversations through the public API (2026-09-29)

Context: an integration can read conversations (ADR-072) and answer inside the customer service
window (ADR-070), but it could not close the loop: a helpdesk that closes a ticket, or an order
system that has answered in full, left the WhatsApp conversation open in the inbox until a member
resolved it (listed as not built in ADR-070 and ADR-072).

Decision:

- **Scope:** `conversations.write` ("Resolve and reopen conversations"), granted only by members who
  hold `inbox.supervise`: owners, administrators and supervisors, who see and resolve every
  conversation in the inbox (a unit test keeps every role holding it also holding `inbox.read_all`
  and `inbox.reply`). A key acts on every conversation of the company, so an agent, who resolves
  only the conversations assigned to them, cannot grant it. It writes, so it is refused while the
  company is suspended or its plan has ended. Keys keep their scopes; migration 0050 widens the
  scopes check (a key may now hold all 8).
- **One operation:** `PATCH /api/v1/conversations/{id}` with `{"status": "resolved"}` or
  `{"status": "open"}`, answered with the conversation as `GET` returns it. Other fields and the
  `pending` status (which the inbox does not set either) are refused. Asking for the status the
  conversation already has changes nothing and answers the same, so a retried request needs no
  `Idempotency-Key`.
- **What it does is what the inbox's Resolve and Reopen do**, in one transaction with the
  conversation row locked, as a member's change is: resolving stops an automation answering the
  conversation (its queued messages are cancelled), clears the unread count and records when it was
  resolved; the triggers close the waiting reply turn and the case, and reopening opens a new case.
  The inbox hears of it live, and the `conversation.status_changed` webhook (ADR-074) is captured by
  its trigger like any other change. The contact's next message reopens a resolved conversation as
  it always does.
- **Attributed to the key, not a member:** the audit entry (`conversation.status_changed`, with
  `source: api` and the request id) names the key, and the turn, the case and the stopped run name
  no member. Per-member report counts (`agent.resolved`, answered turns) leave API resolves out;
  company measures (cases resolved, turns resolved without a reply) include them.
- **No satisfaction survey:** surveys follow a member's resolve and are credited to the assignee
  (ADR-032, and the settings page says so). A survey after an integration's resolve would need its
  own decision about who it measures, so none is sent and no survey row is recorded.
- **Erased contacts' conversations** are not found, as in reads; another company's conversation is
  not found either (the company's scope and the tenant condition).

Not built: assigning or moving conversations, notes, setting `pending`, bulk changes, surveys after
API resolves, and a precondition on the conversation's state (the inbox checks the version the
member saw; the API has no counterpart).

## ADR-076 Addresses an API key accepts requests from (2026-09-29)

Context: a leaked API key works from anywhere until someone revokes it. Integrations usually call
from a few fixed servers, and a key tied to their addresses is useless elsewhere (listed as not
built under P5-08: IP allowlists).

Decision:

- **Networks per key:** up to 20 IPv4 or IPv6 addresses or CIDR ranges
  (`app.api_keys.allowed_networks`, `cidr[]`, migration 0051); NULL accepts any address, as every
  key did before. They are typed one per line or separated by commas or spaces, checked by
  PostgreSQL as networks and kept in its form (a single address gains /32 or /128), without
  repeats. An address with bits set after its prefix length (`203.0.113.7/24`) is refused with the
  network it probably means, never widened or narrowed silently; `/0`, IPv4-mapped IPv6 addresses
  and prefixes longer than the address are refused too. The company export (ADR-055) includes them.
- **Who sets them:** members who manage keys (`developer.manage`) with a recent sign-in (ADR-056),
  when creating a key or later for an active key; a rotation copies them to the new key. Each
  change is audited with the lists before and after (`api_key.networks_changed`), and a creation's
  entry lists them.
- **Checked in the lookup:** `ops.api_key_authenticate(token_hash, client_ip)` finds the key as
  before and says whether the address is inside one of its networks; a key with networks refuses a
  request whose address could not be determined. A refused request does not mark the key used. The
  API answers 403 with reason `ip_not_allowed`, naming the address it saw (the caller's own), and
  counts the attempt against the per-address limit of failed authentication (bursts of 20, one
  every 5 seconds), so a stolen key tried from elsewhere is slowed like a wrong one.
- **The address is the one audit and rate limits use:** `X-Forwarded-For` read from the right,
  skipping `TRUSTED_PROXIES` (DEPLOYMENT.md), or the connection's address when the header is missing
  (the web server fills it in). An allowlist is only as sound as that: behind the load balancer every
  proxy hop must be in `TRUSTED_PROXIES` and the edge must overwrite or append the header; an app
  reachable without the edge lets a client claim any address.
- **Rollout:** the one-argument lookup of 0024 stays for web servers of the previous release during
  a rolling deploy, rebuilt on the new one so that it refuses every key that lists networks (it
  cannot check an address); a later release drops it.
  (Migration 0074, 2026-09-30, drops it: every release since calls the lookup with the address.)

Not built: networks for the whole company, per scope or per endpoint; hostnames; time windows; and
alerts or a list of refused requests (the web server logs each refusal with the key and company).

## ADR-077 Starting automations through the public API (2026-09-29)

Context: integrations (booking systems, CRMs, a company's own order system) want to start a
WhatsApp flow for a contact and let it continue on the contact's replies: an appointment reminder
with Confirm and Reschedule buttons, a follow-up after a form. Automations started from customer
messages (ADR-034, ADR-035), from order message rules (ADR-050) and as members' test runs
(ADR-038); the API could send one template but not start a flow (W-086, listed as not built under
P5-08).

Decision:

- **A trigger for it:** "Started through the API" (`api`) never matches a customer message; only a
  call starts it. It declares up to 10 inputs by name (`^[a-z][a-z0-9_]{0,31}$`, like answer
  names), and every call gives each of them a text of 1 to 1,000 characters, and nothing else.
  Texts, template variables and web requests use them as `{{input.<name>}}`; the checks refuse an
  input the trigger does not declare, and `{{input.…}}` in automations with other triggers. The
  simulator gives each input a sample value; a member's test run takes them in the test form.
- **Templates before the contact replies**, as for order messages (ADR-050): a call starts a run
  outside the conversation's service window, so the check that refuses messages, questions with
  buttons and typed questions before a reply applies to `api` automations too.
- **One number:** an `api` automation must be limited to one WhatsApp number (saving shows an
  error, publishing is refused), as calls do not choose a number; its templates belong to that
  number's account.
- **Scope `automations.start`** ("Start automations", writes), granted only by members holding
  `automations.publish` (owners and administrators): a key that starts live runs acts as
  publishing does. Starting an automation whose published version sends a marketing template also
  needs the key's `messages.send_marketing` scope, as publishing it needs `campaigns.send`.
- **Operations:** `GET /api/v1/automations` lists the automations whose published version starts
  through the API, active or paused, with their inputs and number; `POST
/api/v1/automations/{id}/runs` with `{"to": "+91…", "inputs": {…}}` and a required
  `Idempotency-Key` starts a run and answers 201 with it (a retry answers as the first request
  did); `GET /api/v1/automation-runs/{id}` reads a run any key of the company started (status, end
  reason, contact, conversation, number, times).
- **The checks of an order rule's start (ADR-050), in one transaction with the idempotency key:**
  the automation is active and its published version starts through the API; its number is
  active; the recipient is not on the suppression list; the contact (created with source `api`
  when new; a refused start leaves none) is not erased and has not opted out of utility messages;
  the conversation (created resolved when new) is not assigned to a member, has no active run and
  had fewer than `maxRunsPerConversationPerHour` runs in the last hour; the plan includes
  automations and has a run left this month (ADR-051). Refusals: 409 `automation_busy`,
  `conversation_assigned`, `automation_limit`; 412 `automation_unavailable`, `automation_paused`,
  `channel_unavailable`, `automation_quota`, and the consent refusals with their message as for
  template sends (ADR-052); 403 `not_in_plan`; 422 for inputs. Each template step checks the
  contact's consent for its category (a marketing opt-in) and the frequency cap again when it
  sends; a step refused then fails the run with `send_blocked`, which the run's status shows.
- **Runs in a resolved conversation:** like order message runs, a run started through the API works
  in its conversation while it stays resolved as it was when the run started (until the contact
  replies); a member resolving it later stops the run. The runner allowed this only for order
  message runs, so an API-started run would have stopped at its first step.
- **Recorded:** the run has `trigger_type = 'api'` and `api_key_id` (migration 0052), both fixed by
  the run guard with everything else that started it; a check keeps `api_key_id` set exactly for
  `api` runs. The inputs are kept with the run's answers as `input.<name>`, so erasure and the purge
  30 days after the run ends clear them (ADR-035). The audit entry `automation.run_started` names
  the key and the automation, without the inputs. The run page names the key, as the inbox does for
  API messages, and lists the inputs with the answers. The company export includes the key column.
- **Migrations:** 0052 widens the scope check, adds the column with its checks and foreign key `NOT
VALID` (so `app.automation_runs` is not scanned under the lock) and replaces the run guard; 0053
  builds the partial index on `(tenant_id, api_key_id)` concurrently; 0054 validates the checks and
  the foreign key without blocking writes.

Not built: choosing a number per call, starting runs for many contacts in one call (or a segment),
stopping runs through the API, inputs other than text, and webhook events for runs.

## ADR-078 Outgoing webhook events for automation runs (2026-09-29)

Context: an integration that starts automations through the API (ADR-077) learns how a run went only
by polling `GET /automation-runs/{id}`, and runs started otherwise (a keyword, a new conversation,
any message, a store's order event) cannot be read through the API at all. A CRM or helpdesk needs
to hear when an automation hands a customer to people or fails, and a booking system when its
reminder flow has finished.

Decision:

- **Two event types**, chosen per endpoint like the others (an endpoint may now take all 11):
  - `automation.run_started`: a live run started, whatever started it (a keyword, a new
    conversation, any message, a store's order event, a call through the API).
  - `automation.run_ended`: a live run ended: completed, handed off, taken over, stopped or failed,
    with the reason the run records.
  - Members' test runs of drafts send nothing: they try out a draft in a member's own conversation,
    and an integration acting on hand-offs or counting runs would act on tests. Moving between
    running and waiting is not sent either: runs do it at every question.
- **Capture** by two triggers on `app.automation_runs` in the transaction that inserts a live run
  or moves it from running or waiting to an ended status, as ADR-053. They run with the rights of
  whoever makes the change: the runtime role in the company's scope, or `w360_definer` inside a
  definer function (erasure stopping the contact's run), both of which already capture events. The
  event keeps the run and automation ids, the conversation and contact, the status it reports and,
  for an end, the reason.
- **Payloads are built when delivered** (ADR-053): `run` (id, the automation's id and its name when
  delivered, what started it, the API key that started it for `api` runs, the status the event
  reports, the start time, and the end reason and end time for `automation.run_ended`),
  `conversation` (id), `contact` (id, number and name, null once erased) and `channel`, as the
  message events do. The status, reason and end time are as captured; the rest as when delivered,
  so the start of a run whose contact was erased since is delivered without the number or name. A
  run that no longer exists fails the delivery as `event_gone`, like a deleted message.
- **No answers or inputs:** the run's captured answers and API inputs can hold personal data a
  receiver did not ask for, and the API's run read (ADR-077) returns neither; a receiver that needs
  them reads the conversation.
- **Order:** deliveries are not ordered (ADR-053), so the end of a short run can arrive before its
  start; receivers compare `startedAt` and `endedAt`, and deduplicate on the event id.
- **Volume:** two events per live run, bounded by the runs a conversation may start in an hour and
  the plan's monthly runs (ADR-051).
- **Migrations:** 0055 widens the endpoint and event type checks (the one on `app.webhook_events`
  added `NOT VALID`, as in 0047) and adds the capture function and triggers; 0056 validates the
  check without blocking writes. Endpoints can take the new types only once this release's web app
  runs, after the migrations and the workers, so every worker delivering them knows them.

Not built: events per step or message of a run, test runs, answers or inputs in the payload,
filters by automation (built by ADR-145), and reading runs not started through the API with the
API.

## ADR-079 Stopping automation runs through the public API (2026-09-29)

Context: an integration that starts an automation through the API (ADR-077) often learns later
that it is no longer needed: the appointment was cancelled or confirmed by phone, the order was
refunded. Until now only a member could stop the run, from its page, so the reminder flow kept
waiting for the contact's answer or went on to its next message.

Decision:

- **One operation:** `POST /api/v1/automation-runs/{id}/stop`, with the `automations.start` scope
  that starts and reads runs (granted only by members holding `automations.publish`). It writes, so
  it is refused while the company is suspended or its plan has ended. No body.
- **Only runs started through the API**, by any key of the company, as for reading them (ADR-077);
  other runs (a keyword's, a store's, members' tests), other companies' runs and unknown ids
  answer 404. A key cannot stop the automations customers start by writing.
- **An active run ends as `stopped` with the new reason `stopped_by_api`,** in one transaction with
  the conversation row and then the run locked, as a member's stop is: the step log records the
  stop, messages the run queued that no send worker has claimed are cancelled (a message already
  handed to the sender cannot be recalled), and web requests it had not made are cancelled.
- **The conversation is not handed to people.** A member's stop routes the conversation as a new
  case; an integration's stop means the flow is over, so nothing is routed or assigned. As after a
  reply through the API (ADR-070), a customer who wrote and is still in an open conversation waits
  for a member (the automation turn trigger opens a hand-off turn); a conversation the run started
  and the contact never answered stays resolved.
- **Retries are harmless:** a run that has already ended (stopped by an earlier call, completed,
  handed off, stopped by a member) is answered as it is and nothing changes, so no
  `Idempotency-Key` is needed; its `endReason` says how it ended.
- **Recorded:** the audit entry `automation.run_stopped` names the key and the automation (with
  `source: api` and the request id); the run names no member. The run page says "Stopped through the
  API.", and the `automation.run_ended` webhook (ADR-078) carries the reason.
- **Migrations:** 0057 replaces the run's end check with one that allows `stopped_by_api`,
  `NOT VALID` so `app.automation_runs` is not scanned under the lock; 0058 validates it without
  blocking writes.

Not built: stopping runs keys did not start, stopping every run of an automation or a contact in
one call, pausing a run, and a reason given by the caller.

## ADR-080 Reply buttons and list messages through the public API (2026-09-29)

Context: integrations reply inside the customer service window with text (ADR-070). A booking
system or a helpdesk bot wants the customer to choose: "Keep it / Move it", or one of a few times.
HyFib's automations and satisfaction surveys already send reply buttons (research M-157–M-159);
nothing sent list messages, and the Graph stand-in refused them. Meta's OpenAPI description gives
the list limits (M-179) and the list reply (M-180); whether a list may have 10 rows per section or
10 in all could not be settled (M-181).

Decision:

- **Two more kinds of reply,** `POST /api/v1/messages` with `type: "buttons"` or `type: "list"`,
  beside `text` and `template`, under the same `messages.reply` scope ("Reply with text, buttons and
  lists") and every rule of ADR-070: only to a contact who wrote to the number in the last 24 hours
  (one answer, 412 `window_closed`, for every reason it cannot be reached), the running automation
  ended as `api_replied`, the conversation still waiting for a member, one send per
  `Idempotency-Key`, the window checked again when the worker sends. A key that sends free-form
  text already chooses every word the customer reads in the window; buttons and rows add choices the
  customer taps, which arrive as ordinary messages, so no new scope.
- **Meta's limits, checked before anything is read:** buttons: 1 to 3, ids of 1 to 256 characters,
  titles of 1 to 20 that differ ignoring case; lists: a button label of 1 to 20 characters, 1 to 10
  sections, a title (1 to 24) on each when there are several, rows with ids of 1 to 200 characters
  that differ, titles of 1 to 24 and descriptions of 1 to 72, and at most 10 rows in all (the
  stricter reading of M-181); a body of 1 to 1024 characters, an optional text header and footer of
  1 to 60. Texts are trimmed; ids are kept exactly as given and refused with a space at either end.
- **HyFib's own ids are refused:** ids starting with `w360`, in any case. Automation buttons
  (`w360bot:`) and satisfaction surveys (`w360csat:`) recognise taps by their ids; a survey answer
  counts only when it refers to the survey's own message, but a tap whose id starts `w360csat:` is
  treated as a survey tap by ingestion and the reply-turn trigger (0009), so it would neither
  reopen the conversation nor open a reply turn.
- **Stored for the inbox, sent as Meta describes:** the message is `interactive`, with the
  automations' content for buttons (titles only, so the inbox draws them as it does a bot's) and a
  list's button, sections and rows (titles and descriptions), shown in the inbox; the ids travel only
  in the request to Meta. `GET /messages/{id}` reports `interactive` (it reported every message but
  text as `template`), and the conversation's messages give the body as their text.
- **Taps say what was tapped:** `reply` in the `message.received` webhook and in the API's messages
  gains `type` (`button` for a reply button or a template's quick reply, `list` for a row) and, for
  a row, its `description`.
- **No migration:** `app.messages` already takes `interactive` messages and the scope exists.

Not built: media headers, call-to-action URL buttons (not in the spec's list of interactive types,
M-043), product and catalog messages, location requests, replies quoting a message, and editing or
deleting sent messages.

## ADR-081 Managing webhook endpoints through the public API (2026-09-29)

Context: webhook endpoints are managed only in Settings → Webhooks (ADR-053), by members who hold
`developer.manage`, after a recent sign-in (ADR-056). An integration that installs itself into a
company (a CRM connector, a helpdesk app, the company's own order system) had to ask a member to
paste its receiver's address, copy the secret back to it, and remember to delete the endpoint when
it was uninstalled. WATI's API manages endpoints (W-139; title-level evidence only).

Decision:

- **A new scope,** `webhooks.manage` ("Manage webhook endpoints"), granted only by members who hold
  `developer.manage` (owners and administrators, who manage endpoints in settings and read every
  conversation, so an endpoint for `message.received` gives the key nothing its grantor could not
  see). It writes, so it is refused while the company is suspended or restricted.
- **Keys manage only the endpoints keys added,** whichever key of the company added them (a
  rotated key keeps managing its endpoints, as keys read runs any key started, ADR-077). Endpoints
  members added are not found through the API: their addresses can carry a receiver's own token,
  and they stay under members' control. Members keep full control of every endpoint, whoever added
  it; Settings → Webhooks names the key that added one.
- **Operations** under `/api/v1/webhook-endpoints`: list, add (`url`, `events`, `description`),
  read one, change (`events`, `description`, `enabled`), delete, and rotate the secret. The address
  cannot change: moving is a new endpoint, announced like any other.
- **Secrets are shown once.** Adding and rotating need an `Idempotency-Key`; the response kept for
  a retry holds `secret: null`, never the secret (the idempotency table is not encrypted). A lost
  secret is replaced by rotating; the previous one signs too for 24 hours, as in settings.
- **The same rules as settings,** through the same code: the egress guard's address rules (https,
  no credentials, port 443 or from 1024; private and local addresses are refused when a delivery
  connects), 10 endpoints per company in all, members' included, under the company's endpoint lock,
  and the same audit actions, as the key, with the request id and `source: api`.
- **Owners and administrators are emailed when a key adds an endpoint,** with the key's name and
  prefix, the address's host (never its path), the events and a link to Settings → Webhooks, queued
  in the transaction that adds it. A key has no recent sign-in to check, and a new endpoint is where
  customers' messages start to go; a leaked key cannot add one unseen.
- **Migration 0059:** the scope check allows `webhooks.manage` (up to ten scopes);
  `created_by_user_id` becomes optional and `created_by_api_key_id` (a composite foreign key to the
  key) records a key, with a check that exactly one of them is set. The runtime role inserts both
  through its table grant and can update neither.

Not built: deliveries, replays and test events through the API, changing an address, managing
members' endpoints, filters beyond the event type, and notices when a key changes or deletes an
endpoint (the audit log records them).

## ADR-082 Replies that quote a message, and reactions, through the public API (2026-09-29)

Context: integrations reply inside the customer service window with text, buttons and lists
(ADR-070, ADR-080), but a reply could not show which of the customer's messages it answers, and an
integration could not acknowledge a message with an emoji. Meta's spec lets any message carry
`context.message_id` to reply to one (research M-041, M-183) and describes reactions
(`reaction.message_id` and `emoji`, M-182). Customers' quotes and reactions were already stored
with the WhatsApp id they point at (the webhook's `context.id`, M-186, and a reaction's
`message_id`, M-184), but neither the inbox nor the API said which message that was. Meta's prose
rules for reactions could not be read (M-185).

Decision:

- **Quoting:** a text, buttons or a list sent through `POST /api/v1/messages` may name `replyTo`,
  the id of a message in the conversation (from the API's conversation messages, the
  `message.received` webhook or a send's response). It must be a message the contact sent, or one
  the business sent that WhatsApp accepted and that did not fail (a queued message has no WhatsApp
  id yet); not a reaction or a WhatsApp notice. The request carries that message's WhatsApp id as
  `context.message_id`, and the reply keeps it as inbound quotes are kept (`context_external_id`).
  Every rule of ADR-070 still applies.
- **Reactions:** `type: "reaction"` with `replyTo` and `emoji`, under the same `messages.reply`
  scope, now "Reply with text, buttons, lists and reactions" (a key that writes the customer
  anything in the window can also react). One emoji from Unicode's recommended set (RGI: skin
  tones, flags, keycaps and joined sequences count as one), on a message the contact sent in the
  last 30 days (the stricter reading of M-185), and only while the customer service window is open
  (one answer, 412 `window_closed`, as for replies; checked again when the worker sends). Stored as
  an outbound `reaction` message with the emoji and the WhatsApp id, as inbound reactions are, and
  the conversation's preview becomes "Reacted 👍". A reaction is not an answer: it leaves a running
  automation and the waiting reply turn alone. Reactions cannot be taken back through the API:
  the spec does not say how (M-185).
- **Checked in the conversation:** the message is looked up by id in the conversation between the
  number and the contact, after the conversation's row is locked. A message of another
  conversation or company is refused like one that does not exist (422 on `replyTo`); each other
  refusal says why the message cannot be quoted or reacted to. A refusal stores nothing.
- **Reading:** the API's conversation messages and `GET /messages/{id}` give `replyTo`, the message
  a message answers: the message quoted, the message a reaction is for, or the message whose button
  or row was tapped (taps carry the id of the message they answer, M-158, M-178), when that message
  is in the conversation. `GET /messages/{id}` reports `reaction`. The `message.received` webhook
  gives `replyTo` too, looked up when the event is delivered. A reaction's `text` is its emoji,
  sent or received.
- **In the inbox:** a quote is shown above the reply ("Customer" or "Your team" and the quoted
  message in one line, cut at 120 characters), and a reaction names the message it is for
  ("Reacted 👍 to …"). Taps, forms and carts answer a message by their nature and show no quote.
- **No migration:** `app.messages` already has `context_external_id`, which the runtime role
  inserts, and takes `reaction` messages; the unique index on a number's WhatsApp ids serves the
  lookups. The messaging report counts outbound reactions as outbound messages (they have delivery
  statuses, and its definition counts every outbound message), while its inbound count leaves
  reactions out as before.

Not built: members quoting or reacting in the inbox, taking a reaction back, reacting to the
business's own messages, media, location and contact card replies through the API, and editing or
deleting sent messages.

## ADR-083 Webhook deliveries, test events and replays through the public API (2026-09-29)

Context: since ADR-081 an integration adds and manages its webhook endpoints through the API, but it
could not tell whether events reached its receiver, send a test event to check its setup, or have a
failed delivery sent again once its receiver was fixed: only members could, in Settings → Webhooks
(ADR-053). An installation that checks itself ("send a test event and confirm it arrived") still
needed a member.

Decision:

- **The same scope,** `webhooks.manage`, whose description now names deliveries, test events and
  replays. A key that adds an endpoint and chooses its events already decides what is sent to it,
  and a delivery says only how sending went, so no new scope is needed. The scope writes, so these
  calls, reads included, are refused while the company is suspended or restricted.
- **Only endpoints keys added,** as in ADR-081: deliveries to endpoints members added are not found
  (404) when listed, read or replayed, and test events to them are refused the same way.
- **Operations:**
  - `GET /api/v1/webhook-endpoints/{id}/deliveries`: the endpoint's deliveries, newest first, on
    exact keyset pages (ADR-072) of up to 100 (50 by default), optionally only those `pending`,
    `succeeded` or `failed`;
  - `GET /api/v1/webhook-deliveries/{id}`: one delivery;
  - `POST /api/v1/webhook-endpoints/{id}/test`: a `ping` event for an endpoint that is on, answered
    201 with its delivery to follow;
  - `POST /api/v1/webhook-deliveries/{id}/replay`: a finished delivery (succeeded or failed) sent
    again as a new delivery of the same event to the same endpoint, which must be on, answered 201
    with the new delivery, whose `replayOf` names the one replayed. A delivery still being
    attempted is refused (409), and so is either call for an endpoint that is off (412).
- **Once per `Idempotency-Key`:** a test event and a replay each need one, as adding an endpoint
  and rotating its secret do; a retry answers as the first request did and sends nothing more.
- **What a delivery says:** its event's id and type (`ping` for a test event), its status (the
  database's `state`), the attempts made, when the next is due while it waits, the last attempt's
  time, HTTP status, error code and duration, when it was delivered, and the delivery it replays.
  Never what was sent or received: payloads are built when delivered and never stored (ADR-053),
  and a receiver matches deliveries to its own log by the event id. Deliveries are kept 30 days.
- **The settings service's own steps** (`queueWebhookTest`, `replayWebhookDelivery`), so the rules
  are the same: the endpoint's row is locked before anything is queued, a replay is audited as
  `webhook.delivery_replayed` (as the key, with the request id and `source: api`, the host, the
  delivery replayed and the new one), and a test event is not audited, as in settings. The worker
  sends both as it sends every delivery, through the egress guard.
- **No migration:** the runtime role already reads deliveries and inserts events and deliveries in
  the company's scope.

Not built: bodies sent or received, replaying many deliveries in one call, filters beyond the
status (event type, dates), and deliveries to members' endpoints.

## ADR-084 Internal notes through the public API (2026-09-29)

Context: members add internal notes to a conversation in the inbox, which the team reads and
WhatsApp never receives (mentions notify the members named, P3-06d). An integration that works alongside the team (a helpdesk that opened a
ticket, an order system that issued a refund, a CRM that logged a call) could resolve and reopen
conversations (ADR-075) but could not leave the team a note in one: a note needed a member
(`author_membership_id` was required).

Decision:

- **The `conversations.write` scope adds notes,** now "Resolve, reopen and add notes to
  conversations". Its grantors (owners, administrators and supervisors, who hold `inbox.supervise`)
  read every note already, and a note changes nothing the customer sees, so no new scope is needed.
  Keys that already hold the scope can add notes from this release.
- **One operation:** `POST /api/v1/conversations/{id}/notes` with `{"text": "…"}` (1 to 4,000
  characters, trimmed, as members' notes are), answered 201 with the note (its id, the conversation,
  the text, the key and when it was written). It needs an `Idempotency-Key`: a retry answers as the
  first request did and adds nothing.
- **Nothing else changes:** WhatsApp never receives a note, and the conversation's status, assignee,
  unread count and wait for a reply stay as they are. The inbox hears of it live, as it hears of
  members' notes, and names it as the key's ("API (name)"), as it names the messages keys send.
- **No mentions:** the API names no members (ADR-072), so a key's note notifies no one.
- **Erasure wins:** the conversation's row is locked before the contact is checked, in the order
  erasure locks it, so a note sent while an erasure runs waits and is then refused (404), and
  erasure deletes the notes added before it with the contact's other notes. Erased contacts' and
  other companies' conversations are not found.
- **Recorded on the note:** each note keeps the key that wrote it (`author_api_key_id`; exactly one
  author per note). There is no audit entry, as there is none for members' notes or for the
  messages keys send, which keep their key too.
- **Migrations:** 0060 makes `author_membership_id` optional and adds `author_api_key_id` (a
  composite foreign key to the key) with a check that exactly one author is set, both `NOT VALID` so
  the notes table is not read under the lock; 0061 builds the partial index on the key concurrently;
  0062 validates both without blocking writes. The runtime role inserts the new column through its
  table grant and has no `UPDATE` on notes.

Not built: reading notes through the API (members' notes would need their authors kept out),
editing or deleting notes, mentions from keys, notes on contacts or deals, and a webhook event for
notes.

## ADR-085 Outgoing webhook events for WhatsApp orders (2026-09-30)

Context: companies that sell from their WhatsApp catalog receive customers' carts as orders in
HyFib (M-170): members confirm, fulfil or cancel them and ask for payment with a Payment Link from
the company's own Razorpay account, which the worker marks paid only from the link it fetched
(ADR-046). An order or delivery system learns of an order only from `message.received` (type
`order`), which carries no items or total, and hears nothing when the order is paid or changes
status; the public API does not read orders either.

Decision:

- **Two event types**, chosen per endpoint like the others (an endpoint may now take all 13):
  - `order.received`: HyFib recorded a cart a customer sent from the company's WhatsApp catalog.
  - `order.status_changed`: the order's status changed, whoever changed it: a member confirming,
    fulfilling or cancelling it or asking for payment (waiting for payment), or the worker applying
    what Razorpay reports for its Payment Link (paid, or back to confirmed when the link expired or
    was cancelled unpaid, erasure's cancellation included).
  - Store orders (the Shopify and WooCommerce copies of ADR-047) are not sent: they are copies of
    orders the company's store already reports through its own webhooks.
- **Capture** by two triggers on `app.commerce_orders`, after an insert and after an update of
  `status` that changes it, in the transaction that makes the change, as ADR-053. They run with the
  rights of whoever makes the change: the runtime role in the company's scope, the only role that
  adds orders or changes their status (erasure, in its definer function, only clears the customer's
  note and so sends nothing). The event keeps the order id, the conversation and contact, the status
  it reports and, for a change, the status before it.
- **Payloads are built when delivered** (ADR-053): `order` (id, reference, the status the event
  reports and the one before it, null for `order.received`; the order message's id; the Meta
  catalog; the currency, the subtotal and each unit price as integers in the currency's minor units,
  null where HyFib could not work them out; the items read and the items left out; the customer's
  note; each item's content id, the product name HyFib knew when the order was received, quantity,
  unit price and currency; when it was received and paid), `conversation` (id), `contact` (id,
  number and name, null once erased) and `channel`, as the other events. The two statuses are as
  captured and the rest as when delivered: an event delivered after the payment names when it was
  paid, and one delivered after the contact's erasure has no number, name or note (erasure clears
  it). An order that no longer exists fails the delivery as `event_gone` (orders are kept until the
  company is deleted, which removes its webhook history first).
- **Money is never a float:** amounts are the integers HyFib stores; subtotals are capped at
  5×10¹³ minor units when an order is read, well inside JSON's exact integer range.
- **No payment details:** the Payment Link's id and address and Razorpay's payment ids are not
  sent. The company's Razorpay account reports those to it directly, and a link's address is a way
  to pay.
- **Order:** deliveries are not ordered (ADR-053); the latest change is the one with the latest
  `createdAt`, the time the status changed. Receivers deduplicate on the event id.
- **Volume:** one event per order and one per status change, a handful per order at most.
- **Migrations:** 0063 widens the endpoint check to 13 types and replaces the event type check
  `NOT VALID` (as 0055 did), and adds the capture function (not executable by `PUBLIC`) and the two
  triggers; 0064 validates the check without blocking writes. Endpoints can take the new types only
  once this release's web app runs, after the migrations and the workers, so every worker
  delivering them knows them.

Not built: store order events, Payment Link events, reading or changing orders through the public
API, catalog and product events, and filters by status (the status reached built by ADR-147).

## ADR-086 Product messages through the public API (2026-09-30)

Context: members send products from the company's WhatsApp catalogs in the inbox (a product, up to
30 products in sections, or the catalog; ADR-046, research M-169), and the API could send text,
buttons, lists and reactions (ADR-070, ADR-080, ADR-082) but no products. A store, a chatbot or a
recommendation system answering a customer who asked about something to buy had to send a link as
text.

Decision:

- **Three reply types** on `POST /api/v1/messages`, under `messages.reply` (now "Reply with text,
  buttons, lists, products and reactions"): `product` (one product, with an optional body and
  footer), `product_list` (a header, a body, an optional footer and 1 to 10 sections of products,
  at most 30 in all, each once, sections titled when there is more than one) and `catalog` (the
  catalog, opened from a product's picture, with a body and an optional footer). Keys that already
  hold the scope can send them from this release: every role that grants it (holding
  `inbox.reply`) also holds `commerce.read` and sends products from the inbox.
- **The rules of replies:** the same path as text, buttons and lists (`sendReply`): only to a number
  that wrote to the WhatsApp number in the last 24 hours, one answer (`window_closed`) for every
  number it cannot reach, the conversation locked, the automation answering it ended, the message
  marked with its key, one message per `Idempotency-Key`, the window checked again at send; a
  `replyTo` quotes a message as for the other replies (the schema gives every message type
  `context`, research M-183).
- **Commerce in the plan:** products need the Commerce module, as in the inbox; a plan without it
  is refused first (403, reason `not_in_plan`), before the number is looked up.
- **Products by content id:** the API names products as the company's catalog does (`retailerId`,
  exactly as Meta keeps it), not by HyFib's ids, which the API never shows. They are looked up
  among the catalogs HyFib read for the sending number's WhatsApp account (Commerce → Catalogs),
  still connected and not removed at Meta; all must be in one catalog, which `catalogId` (Meta's
  id) names when more than one catalog holds them all (a catalog holding only some of them does not
  count). Unknown ids are refused by name (422, path
  `products`), so an integration learns which of its products HyFib cannot send; ids in another
  WhatsApp account's, another company's or a disconnected catalog are unknown.
- **Stored and shown as the inbox's:** the message stores the kind, the product names HyFib knew,
  the header, body and footer (`content.products`), so the thread shows it as it shows members'
  product sends, named as the key's; the Graph request is built by the same function as the inbox's
  (`productInteractive`).
- **Limits** are the inbox's (`COMMERCE_LIMITS`: header 60, body 1,024, footer 60 and section title
  24 characters, 10 sections, 30 products), checked before anything is read.

Not built: Flows, call-to-action and order messages through the API (`cta_url` is not in the spec
Meta publishes, research M-043), product names or prices in the request, reading catalogs and
products through the API, and sending products outside the customer service window (templates with
product buttons).

## ADR-087 Outgoing webhook events for campaigns (2026-09-30)

Context: companies send marketing campaigns to their contacts (P3-04): members draft them, submit
them for approval when the company asks for it (ADR-024), and the runner starts, paces, pauses and
completes them (ADR-022; it pauses on a cap, the template, the number or the member whose authority
the sends use). A CRM or a marketing tool kept in step with HyFib learns of each campaign message
through `message.status`, but not that a campaign was approved, started, paused (and why) or
finished, and the public API does not read campaigns.

Decision:

- **One event type,** chosen per endpoint like the others (an endpoint may now take all 14):
  `campaign.status_changed`, whenever a campaign's status changes, whoever changes it: a member
  submitting it for approval, withdrawing it, rejecting it (both back to draft), approving it
  (scheduled), pausing, resuming or cancelling it, or the runner starting it (running), pausing it
  (a cap reached, the template no longer approved, the number not active, the member whose authority
  it uses gone or without the permission, no rate card for its spending cap) or completing it.
  Creating and editing drafts, the runner's progress and test sends change no status and send
  nothing.
- **Capture** by a trigger on `app.campaigns` after an update of `status` that changes it, in the
  transaction that makes the change, as ADR-053. It runs with the rights of whoever makes the
  change: the runtime role in the company's scope, the only role that changes a campaign's status.
  The event keeps the campaign id, the status it reports, the status before it and, for a pause or
  a completion, the reason, and is stamped with the time it is captured (`clock_timestamp()`), not
  the transaction's: the runner starts a campaign and may pause it in the same transaction (as the
  campaign's own history records), and the two changes must keep their order.
- **Payloads are built when delivered** (ADR-053): `campaign` (id, name, the status the event
  reports and the one before it, the pause or completion reason, the template's id and name, when
  it was scheduled, started, completed or cancelled, and its counters: the audience taken when it
  was submitted, the recipients queued and skipped) and `channel` (the number, null if none is set).
  The statuses and reasons are as captured and the rest as when delivered. No member is named, as
  in every other event, and no recipient: the payload carries counts only. A campaign that no
  longer exists fails the delivery as `event_gone` (campaigns are kept until the company is
  deleted, which removes its webhook history first).
- **Order:** deliveries are not ordered (ADR-053); the latest change is the one with the latest
  `createdAt`. Receivers deduplicate on the event id.
- **Volume:** a handful of events per campaign: submission, approval, the start, pauses and resumes,
  the end.
- **Migrations:** 0065 widens the endpoint check to 14 types and replaces the event type check
  `NOT VALID` (as 0063 did), and adds the capture function (not executable by `PUBLIC`) and the
  trigger; 0066 validates the check without blocking writes. Endpoints can take the new type only
  once this release's web app runs, after the migrations and the workers.

Not built: delivery and read counts in the payload (they change with every message status; the
reports have them; built by ADR-150 as the results counted when each event is delivered), the
campaign in `message.status`, events for each recipient, test sends and drafts, reading campaigns
through the public API, and filters by campaign (filters by the status reached built by ADR-146).

## ADR-088 A message feed across conversations through the public API (2026-09-30)

Context: integrations that copy what customers write into a helpdesk, a CRM or a warehouse hear of
each message through the `message.received` webhook (ADR-053), but read messages only one
conversation at a time (ADR-072). To catch up after their receiver was down, or to fill a new
install, they listed the conversations updated since their last pass and read each one's messages:
one request per conversation, and a conversation's `updated_at` does not move for every message.

Decision:

- **Endpoint:** `GET /api/v1/messages` (`listMessages`, beside `POST /messages` and
  `GET /messages/{id}`): the messages of every conversation of the company, newest first, on the
  exact keyset pages of ADR-072 (creation time to the microsecond, then id; neither changes), so
  paging never skips or repeats a message. Filters: `direction` (`inbound`, what contacts wrote;
  `outbound`, what the company sent), `channelId` (the number a message was received on or sent
  from) and `since` (created at or after a time).
- **No new scope:** `conversations.read` already reads every message of every conversation, one
  conversation at a time; the feed reads the same messages in fewer requests. A key without it is
  refused (403) before its query is read. It does not write, so suspended and restricted companies
  can still read.
- **What a message says:** exactly what a conversation's messages say (one function builds both),
  with its conversation's contact (`contactId`) and the number it was received on or sent from
  (`channelId`, the message's own number), so an integration can file it without reading the
  conversation. No media, no internal notes; erased contacts' conversations are left out, as in
  every read.
- **A bounded read per page:** `messages_tenant_created_idx` (0008) serves the pages: PostgreSQL
  reads it backwards and sorts by id only the messages that share a time. Filters are not in that
  index, so a filter that matches few messages would read every message the company has to fill a
  page (measured locally on 400,000 synthetic messages in a rolled-back transaction: a number
  without messages took 774 ms, and the time grows with the company's messages up to the 15-second
  statement timeout), and indexes for each filter, and for both together, would cost every message
  written. Instead each page reads at most 2,000 of the company's messages (from `since` and the
  cursor, newest first) and shows those that pass the filters: when the filters leave out most of
  them it shows fewer than `limit`, or none, and its cursor continues after the last message it
  read, as filtered DynamoDB queries do. The page first finds the 2,000th message (if there is
  one), then reads the matches from there to the cursor; both reads see one snapshot (repeatable
  read, read only), so no message saved between them moves the page's end. Unfiltered pages are
  always full. Measured the same way, each of the two reads took about 3 ms, for a number without
  messages as for outbound messages, and for a page 300,000 messages back as for the first.
- **Catching up:** a message carries the time its transaction began, so one still being saved
  while a pass reads can carry an earlier time than messages the pass saw. As for `updatedSince`
  (ADR-072), the documentation tells integrations to ask for `since` a little before their previous
  pass began (a minute) and to expect some messages again (deduplicating on the id), rather than
  promising an exact feed. Statuses change after a message is created, and the feed does not follow
  them: the `message.status` webhook does (and `GET /messages/{id}` for messages sent through the
  API). Since ADR-116, `GET /message-changes` follows new messages and statuses exactly.
- **No migration.**

Not built: statuses changed since a time (built by ADR-116), filters by contact or conversation (a
conversation's messages endpoint reads one), media, notes, counts, and a push feed (the webhooks are
that).

## ADR-089 Reading internal notes through the public API (2026-09-30)

Context: keys add internal notes to conversations (ADR-084), and members write them in the inbox,
but no key could read them: a helpdesk kept in step with HyFib pushed its notes in and could not
bring the team's back, so the two sides of a conversation's internal history drifted apart.

Decision:

- **Endpoint:** `GET /api/v1/conversations/{id}/notes` (`listConversationNotes`): the
  conversation's notes, newest first, on the exact keyset pages of ADR-072 (creation time to the
  microsecond, then id), so paging never skips or repeats a note.
- **Scope:** `conversations.read`, which already reads everything customers wrote in every
  conversation and is granted only by members who read every conversation's notes in the inbox
  (`inbox.read_all`, ADR-072). Notes are the team's own words, no more sensitive than what the scope
  gives; a separate scope would make every integration that reads conversations ask twice. Keys
  that already hold the scope can read notes from this release, which its label now says.
- **What a note says:** its text, when it was written, and who wrote it at the level the API names
  anyone: `writtenBy` is `agent` (a member in the inbox, the word messages' `sentBy` uses for
  members) or `api` (added through the API), with the key (`apiKeyId`) for a key's note. Never which member, as nowhere else in the API (assignment
  says whether a member is assigned, not who, ADR-074), and never whom a note mentions (mentions are
  member ids and notifications; the text keeps whatever the member typed). The note a key adds
  (ADR-084) answers in the same shape, now with `writtenBy: api`; ADR-084 is not yet released, so
  its response gains the field and `apiKeyId` becomes nullable without breaking anyone.
- **Erased contacts:** their conversations are not found, as in every read; erasure deletes their
  notes (ADR-084).
- **No migration:** `conversation_notes_thread_idx` (0003) serves the pages; a conversation holds
  few notes.

Not built: notes across conversations (the message feed of ADR-088 is for messages), editing or
deleting notes, member names and mentions, and notes in webhooks.

## ADR-090 Company deletion started by HyFib staff (2026-09-30)

Context: only a company's owners could delete it (ADR-055); staff could neither start, speed up nor
cancel a deletion, which ADR-055 left as not built. A company whose owners asked HyFib support to
delete it (they left the business, or cannot sign in any more), or whose service HyFib ends, could
only be suspended, and its data was then kept with no end.

Decision:

- **Who:** platform owners only (`ops.platform_admins.role = 'platform_owner'`, with two-factor like
  all platform staff), as for refunds (ADR-058). Operators see a company's deletion and cannot act.
- **How:** on the company's platform page, a platform owner types the company address (as owners
  do) and a reason of 10 to 1,000 characters, which the company reads: it is emailed to the
  owners and administrators and shown on every page of the company and in Settings → Company data.
  `ops.platform_request_tenant_deletion` checks the platform owner, the reason, the company's
  status and the address, records the deletion (`requested_by = 'platform'`, the reason), puts the
  company in `pending_deletion` and writes both audit logs (the company's names "HyFib platform
  staff", never the staff member).
- **The same grace and the same job:** due 14 days later, the company working as if suspended
  meanwhile (members read, owners export, nothing is sent), then the resumable `tenant.delete` job
  of ADR-055 with its provider clean-up, batches, tombstone and kept records. Nobody can shorten the
  grace or start the job early; a refund in progress still holds it back (ADR-058).
- **Whoever scheduled it cancels it:** owners cancel an owner's deletion, as before
  (`app.cancel_tenant_deletion`, which now refuses a staff deletion); a platform owner cancels a
  staff deletion before it starts, with a reason the company reads
  (`ops.platform_cancel_tenant_deletion`), and cannot cancel an owner's: that deletion is the
  company's decision. The register enforces it too: a cancellation's `cancelled_by` must equal
  `requested_by`. Cancelling restores the status recorded at the schedule, with the plan applied
  again (a suspension stays, a lapsed plan restricts), one rule shared by both functions
  (`ops.tenant_status_after_deletion`).
- **Telling the company:** the platform role cannot queue email (it has no outbox or queue grants,
  and should not read members' addresses), so the worker's minute sweep tells the owners and
  administrators of a staff deletion and of a staff cancellation, as it tells billing managers of a
  declined refund request (ADR-073): `ops.tenant_deletion_notices_due` lists what was not told,
  oldest first (a schedule before its cancellation), and each notice is marked in the company's own
  scope (`app.tenant_deletion_mark_notified`) in the transaction that queues its emails, so it is
  told once. A company deleted before a notice went out is not told afterwards. The final "Company
  deleted" email says HyFib deleted it, with the reason. HyFib's reasons, like refund notes, may be
  longer than an email line; they are split over lines (`splitEmailText`).
- **What the company reads:** `requested_by`, `reason`, `cancelled_by` and `cancel_reason` (column
  grants): who scheduled it and HyFib's words, never who at HyFib. The existing column grants are
  unchanged.
- **Older rows:** deletions scheduled before this migration are owners' (`requested_by` defaults to
  `owner`); those cancelled before it have no `cancelled_by`, and only owners could cancel them. No
  row is rewritten (the register forces row security, so a migration could not update it anyway).

Not built: a shorter grace for staff, starting the job early, deleting a company without its
owners being told, staff cancelling an owner's deletion, reasons kept only for staff, and
selecting companies to delete in bulk (for example inactive trials).

## ADR-091 Alerts for work that failed for good (2026-09-30)

Context: the operations console (ADR-054) lists jobs the dead-letter queue received, Meta and
Razorpay webhook receipts that used all their processing attempts, and provider events that could
not be matched to a company (quarantine), but nobody heard of them unless they looked. A receipt
can be retried only while its body is kept (7 days): a Razorpay payment or a customer's message
could be lost for good while the console waited to be opened. Designing the alert also showed a
receipt nobody could see: one whose worker stopped during its 12th attempt stayed `processing`
after its lease ran out. The sweeper stops signalling a receipt after 12 attempts, and the console
listed only `failed` receipts as used up (and only those under 12 attempts as waiting), so it was
neither listed, retried nor retryable (the retry took `failed` or `quarantined` receipts only).

Decision:

- **What is told:** each dead letter; each receipt that used all its attempts, meaning it failed
  its 12th attempt or its worker stopped during it (`ops.webhook_receipt_exhausted`, the one rule
  for the alert, the console and the retry, tested against `MAX_RECEIPT_ATTEMPTS`); and each
  quarantine entry not resolved.
- **Who:** every platform administrator, both roles: both retry receipts and resolve quarantine
  entries (ADR-054), and dead letters need someone to look for the cause. While there is none,
  nothing is marked and the worker warns; the alert goes out once there is one.
- **Once, and not too often:** each item carries when staff were emailed about it
  (`ops.dead_letters.alerted_at`, `ops.webhook_receipts.exhausted_alerted_at`,
  `ops.webhook_quarantine.alerted_at`). The minute messaging sweep, last of its work so that a
  failure here holds nothing else back, counts what waits (`ops.failure_alerts_due`), reads the
  recipients (`ops.platform_failure_alert_recipients`) and marks it all through
  `ops.mark_failure_alert` in the transaction that queues the emails. The mark
  does nothing while the last alert went out less than 15 minutes ago (`ops.platform_alerts`, row
  locked, so two sweeps at once send one alert), and marks at most 1,000 items of each kind per
  alert. A burst of failures makes one email, not one a minute; what arrives in between waits for
  the next. Retrying a receipt clears its mark, so if it fails all its attempts again, staff hear of
  it again. All three functions are SECURITY DEFINER and executable by the worker's role only.
- **What:** one `platform.notice` email: how many jobs were dead-lettered by queue, how many
  receipts used their attempts by provider (with the 7 days to retry them), and how many events
  could not be matched by provider and reason, naming six entries a line at most, with a link to
  the tab that lists them. A queue's name is cut at 40 characters: the table allows 100, and a line
  longer than a notice's 600 would fail the email, and so the alert, at every sweep. No company, receipt, reference or error: those stay on the console,
  behind platform sign-in and two-factor authentication.
- **The stuck receipt:** the console lists a receipt whose worker stopped during its last attempt
  as "Failed all attempts", with that explanation, and the retry takes it (migration 0068 replaces
  `ops.platform_retry_webhook_receipt`). The console also shows when staff were emailed about each
  receipt, quarantine entry and dead letter, and when the last alert went out.
- **Already listed before this release:** dead letters, and receipts whose body was already erased,
  are marked as told by the migration (they are history, and nothing can be done for such a
  receipt). Receipts that can still be retried and unresolved quarantine entries are emailed by the
  first sweep, since staff must act on them and nobody was told.

Not built: alerts for queues whose oldest waiting job is too old (pg-boss's counts carry no age),
alerts to other channels (chat, pager), a digest schedule or intervals chosen per alert, and alerts
for failing integrations of one company (the console's Current failures; companies hear of their
own through their pages and emails).

## ADR-092 API scopes by plan (2026-09-30)

Context: a plan version can leave the whole public API out (0 monthly requests, ADR-061) but not
part of it. HyFib may want a plan that lets integrations read contacts and send templates without
managing webhook endpoints or starting automations, the "endpoint availability by plan" that the
benchmark documents (W-137). HyFib's endpoints are grouped by the scope they need, so a plan's
choice is made per scope.

Decision:

- **Plan versions choose API scopes:** `ops.plans.api_scopes` (migration 0069) is empty (NULL) for
  every scope, including scopes HyFib adds later, or the scopes the version includes (1 to 10 of the
  known ones, kept in the list's order; the table checks them). Versions published before keep NULL,
  which is what they gave. A version without the API (0 monthly requests) has none (a check), and
  published versions stay unchangeable (the guard compares the new column). The platform plan form
  offers "Every scope, including scopes HyFib adds later" or "Only the scopes chosen below".
  Complimentary access includes every scope.
- **Every request is held to the plan:** the admission that counts a request (ADR-061) already
  reads the company's entitlements; it now also gives the request's context the scopes the plan
  includes, and handlers run only with an admitted context. A request may use a scope when its key
  has it and the plan includes it (`hasScope`). A scope the key has but the plan leaves out answers
  403 `forbidden` with reason `not_in_plan`, naming the scope (`assertScope`); a scope the key does
  not have is refused as before, checked first. Reads that any of several scopes allow (a message's
  status, automation runs) need one the plan includes (`assertAnyScope`). The plan is checked before
  the company's status. A refused request was counted, as every admitted request is.
- **Keys:** creating a key with a scope the plan leaves out is refused, naming the scopes. Existing
  keys keep their scopes: rotating copies them, Settings → API keys marks the ones the plan leaves
  out, and requests are refused them while it does. When the company's plan includes them again
  they work again, with no change to the key. What keys already did stays: endpoints a key added
  keep receiving events (deliveries are not API requests) and runs a key started go on.
- **Where it shows:** Settings → API keys (the scopes the plan includes, scopes it leaves out
  disabled in the form and marked on keys), the Billing plan card, the platform plan form and page,
  and the platform company page. The OpenAPI document describes the refusal.

Not built: availability per endpoint rather than per scope, quotas per scope, telling companies
which scopes a plan change removes, and packs of scopes sold as add-ons.

## ADR-093 Assigning conversations and moving them between teams through the public API (2026-09-30)

Context: an integration can read conversations, answer them, resolve and reopen them and add notes
(ADR-070, ADR-072, ADR-075, ADR-084), but deciding who answers stayed in the inbox: a helpdesk or
CRM that routes customers to its own owners could not give a conversation to a member or a team,
and the API named no members or teams (ADR-072, ADR-074). The benchmark's API row lists assigning
conversations (W-134).

Decision:

- **Scopes:** `conversations.write`, now "Resolve, reopen, assign and add notes to conversations",
  also assigns conversations and moves them between teams. It is granted only by members holding
  `inbox.supervise` (owners, administrators and supervisors), and a unit test keeps every role
  holding it also holding `inbox.assign`. `conversations.read` also reads the teams and the members
  conversations can be given to; it is granted only by members holding `inbox.read_all`, all of whom
  hold `members.read` (a unit test). Existing keys gain both, as keys gained notes (ADR-084): within
  what their granter could do in the app.
- **Members and teams:** `GET /members` pages the active members whose role reads and answers
  conversations (the members teams and routing take): the id `assigneeId` names, the name, the
  teams they belong to, and whether they take new conversations now. Emails, roles and anything else
  about them are not given. `GET /teams` pages the company's teams: id, name and how the team gives
  out conversations (`manual` or `round_robin`); keywords, limits and numbers are settings, not
  given. Both are paged oldest first.
- **Conversations name their member and team:** `assigneeId` and `teamId` (null for none) join
  `assigned`, and the list filters by `assigneeId` and `teamId`, each an id or `none`.
- **One operation:** `PATCH /conversations/{id}` takes any of `status`, `assigneeId` (a member, or
  null to unassign) and `teamId` (a team, or null for none), at least one, applied in one
  transaction with the conversation row locked, as the inbox's controls are: the team, then the
  member, then the status. The operation is renamed `updateConversation` and its body
  `UpdateConversation`, since it no longer sets only the status.
  - Assigning a member ends an automation answering the conversation (the hand-off, reason
    `assigned`), as a member's assignment does. Unassigning leaves the conversation to routing:
    in a round-robin team the minute sweep gives it out again.
  - Moving a conversation to a team then routes it at once when it has no member and is not
    resolved, as the inbox's team control does (a member the request names keeps it); routing
    leaves a conversation an automation answers to the automation.
  - A member who cannot answer conversations (another role, suspended or removed, another
    company's) or a team of another company is refused with 422, naming the field, and nothing in
    the request is kept. The member's row is locked for share and the team's row against deletion
    while the change is written: a member being suspended at the same time is refused once the
    suspension commits, or has the conversation released by it (as a suspension releases every
    conversation), and a team being deleted is refused rather than failing on its foreign key.
  - What the conversation already has changes nothing, so a retried request needs no
    `Idempotency-Key`.
- **Attributed to the key:** the audit entries (`conversation.assigned`,
  `conversation.team_changed`, with `source: api` and the request id) name the key; routing that
  follows is the system's, as always. The inbox hears of each change live, and the
  `conversation.assignment_changed` webhook fires when a member comes or goes, captured by its
  trigger as for any change.
- **Also fixed in the inbox:** the assignment picker offered, and assigning accepted, any active
  member, including marketers, analysts and billing managers, who cannot open the inbox, leaving
  the conversation with someone who could not see it. The inbox now offers and accepts only members
  who can answer conversations, as teams and routing do, with the same locks on the member and the
  team as the API.

Not built: webhooks naming the member and team (and so moves between members or teams), assigning
many conversations in one call, members' emails, team settings through the API, and a precondition
on the conversation's state (the inbox checks the version a member saw; the API has no
counterpart).

## ADR-094 Webhook conversation events name the member and the team (2026-09-30)

Context: since ADR-093 the API names a conversation's member and team (`assigneeId`, `teamId`,
`GET /members`, `GET /teams`) and changes both, but the webhooks of ADR-074 still said only whether
a member was assigned, sent nothing when a conversation moved from one member to another, and
nothing about teams. A helpdesk or CRM that keeps its own owners in step with HyFib's had to poll
the API to notice such moves (listed as not built in ADR-074 and ADR-093, P5-09).

Decision:

- **Assignment events name the member:** `conversation.assignment_changed` is now captured for
  every change of the member: one assigned where there was none, a move from one member to
  another, and none any more (unassigned, the member suspended or removed, routing). It carries
  `assigneeId` and `previousAssigneeId`, members as `GET /members` lists them (null for none), with
  `assigned` as before.
- **A new event for teams:** `conversation.team_changed` ("Conversation team"), chosen per endpoint
  like the others (an endpoint may now take all 15): a conversation placed in a team, moved to
  another or taken out of one, whoever does it: routing placing a new conversation in its number's
  team, a member, an automation's hand-off, an API key, or the team being deleted (each of its
  conversations leaves it, one event each). It carries `teamId` and `previousTeamId`, teams as
  `GET /teams` lists them.
- **What each body says:** the change an event reports is as captured; the rest is the
  conversation when the event is delivered, as in ADR-074. The assignment event also gives the
  team, the team event the member, and the status event now gives both (`assigneeId`, `teamId`)
  beside `assigned`. Assignment events captured before this release are delivered with both member
  ids null. Fields are only added, so receivers of the existing events keep working.
- **Capture:** the trigger of 0047 now also fires when the team changes (migration 0070) and
  captures one event for each fact that changed: routing that places a new conversation in a team
  and gives it a member in one statement captures a team event and an assignment event. A team's
  deletion sets its conversations' team to none through the foreign key (0009), which fires the
  trigger for each of them. As before, nothing is captured unless an active endpoint of the company
  takes the event's type.
- **Order:** conversation events are now stamped with the time each change is captured
  (`clock_timestamp()`), not the transaction's start, as campaign events are (ADR-087). One request
  can change the member twice (taking it off and moving the conversation to a team whose routing
  gives it out again), and a transaction that started earlier but waited for the conversation's row
  could otherwise stamp a later change earlier. `createdAt` is given to the millisecond, so two
  changes in one request can share it; the OpenAPI document says to read the conversation then.
- **What is not given:** members are ids only, with their names through `GET /members`
  (`conversations.read`); no names, emails or roles travel in webhook bodies.
- **Migrations:** 0070 widens the endpoint check to 15 types, replaces the event type check
  `NOT VALID` (as 0065) and replaces the capture function (still not executable by `PUBLIC`) and
  the trigger; 0071 validates the check without blocking writes. Endpoints can take the new type
  only once this release's web app runs, after the migrations and the workers. Between the
  migrations and the new workers, a worker of the previous release delivers assignment events in
  the previous shape (`assigned` only), moves between members included.

Not built: member names or emails in bodies, events for a member's availability or a team's
settings, conversations started, `createdAt` finer than the millisecond, and filters beyond the
event type.

## ADR-095 Replaying an endpoint's failed deliveries in one call (2026-09-30)

Context: when a receiver is down, its deliveries fail after their eight attempts (ADR-053), or at
once when HyFib turns the endpoint off after 72 hours of failures or a member turns it off. Once
the receiver is back, members replayed failed deliveries one at a time in Settings → Webhooks and
keys one per call (ADR-083): after a day's outage, hundreds of clicks or calls ("replaying many
deliveries in one call", not built in ADR-083 and P5-08).

Decision:

- **What is replayed:** for one endpoint that is on, every event whose deliveries to it all
  failed, from the deliveries queued since a chosen time: one new delivery per event, replaying
  its latest failed delivery (`replayOf`), oldest event first. Left out: events delivered since,
  or with a delivery still waiting or being attempted (a replay already queued included);
  deliveries that failed because what the event names no longer exists (`event_gone`, which
  would fail again at once); and test events.
- **At most 500 per call.** The answer says how many were queued and whether more remain;
  another call queues the next ones, since those queued are waiting and so left out.
- **Where:** Settings → Webhooks, on an endpoint's deliveries (`developer.manage`): "Replay
  failed deliveries" from the last hour, 24 hours, 7 days or 30 days (the deliveries HyFib keeps).
  And keys with `webhooks.manage`, for the endpoints keys added (ADR-083):
  `POST /api/v1/webhook-endpoints/{id}/replay-failed` with `since` (a time with its offset, in
  the past), once per `Idempotency-Key`, answered 200 with `queued` and `more`. An endpoint that
  is off is refused (412), as for one replay.
- **Order and races:** the endpoint's row is locked first, as for one replay, so two calls at
  the same time queue each event once: the second waits, then finds the first's replays waiting.
- **Delivery:** the worker sends them as it sends every delivery, ten at a time for the company
  and 200 per job before handing over (ADR-053), so a receiver just back is not flooded; events
  captured meanwhile wait behind the replays.
- **Audit:** one entry per call, `webhook.deliveries_replayed`, with the host, the time from, the
  count and whether more remain, as the member or as the key (`source: api`).
- **No migration:** the existing indexes serve the query (deliveries by endpoint and time, and
  by event), and the roles already read deliveries and insert them in the company's scope.

Not built: replays across endpoints, choosing event types or single deliveries to replay in
bulk, replaying succeeded deliveries in bulk, and scheduled replays.

## ADR-096 How long jobs wait, and alerts for queues that fall behind (2026-09-30)

Context: the operations console (ADR-054) shows pg-boss's counts for each queue, which carry no
age: a queue whose workers had stopped taking work looked like one with a few jobs in it. Nobody
was told (ADR-091 left it out), and the counts come from pg-boss's own cache, refreshed by the
worker. A job whose handler never runs is not dead-lettered either: it waits, while customers'
messages, webhook deliveries or payments wait with it.

Decision:

- **What is measured:** for each queue this release declares, the jobs pg-boss would hand to a
  worker now and since when the oldest of them has waited: jobs created or retried whose start time
  has come (pg-boss's own "ready", as its queue stats count it), left out when held by a job they
  depend on (they wait for that job, not for a worker). A retried or delayed job waits from when it
  became due. Read from `pgboss.job` by the worker's role, which pg-boss already needs, through the
  partial index pg-boss claims jobs with (checked with `EXPLAIN`: an index-only scan, so finished
  jobs are never read).
- **Limits per queue:** `maxWaitMinutes` in the queue catalog, 15 minutes unless given (a job
  normally starts within seconds); 60 minutes for queues of long jobs run one or two at a time,
  where a burst of work waits by design (template sync, catalog sync, store sync, the settlement
  reconciliation and company deletion).
- **Recorded every minute:** the minute messaging sweep reads them after the failure alert and
  records them in `ops.queue_waits` through `ops.record_queue_waits`, one row per queue with the
  count, the oldest job's due time, the limit and the time of the check. A queue is late once its
  oldest job has waited its limit, and stays late until nothing has waited half of it, so a queue
  hovering around its limit is not reported again and again. Rows no check touched for 7 days
  (queues a release no longer declares) are deleted.
- **Alert:** every platform administrator is emailed once each time a queue becomes late, through
  `ops.mark_queue_alert` in the transaction that queues the emails: at most every 15 minutes
  (`ops.platform_alerts` gains a `queues` row, so failure alerts and queue alerts do not hold each
  other back), only for checks from the last 5 minutes (a row a stopped check left behind is not
  news), and two sweeps at once send one alert. The email names each late queue with its waiting
  jobs, its oldest wait and its limit, the longest wait first, eight queues at most (seven and a
  count beyond), and what to look at. Queue names, counts and times only: no job's payload leaves
  pg-boss. While there is no platform administrator, nothing is marked and the worker warns.
- **Console:** the Queues tab shows each queue's oldest wait at the last check, its limit, whether
  and since when it is late and when staff were emailed, and when the worker last checked; when
  that was more than 5 minutes ago it says the worker is not checking, since then nobody is told.
  The overview counts late queues.
- **Access:** the table is written only by the two functions (SECURITY DEFINER, executable by the
  worker's role only); the worker and platform staff read it.

Not built: an email when the worker itself stops (an alert the worker sends cannot report that:
its liveness and readiness probes are for it, see DEPLOYMENT, and the console says when the last
check was), a reminder while a queue stays late, an email when it has caught up, limits changed
without a release, and trends of waits over time.

## ADR-097 Monthly request limits per API key (2026-09-30)

Context: a company's plan limits the API requests of the whole company in a month (ADR-061), and
the rate limits (ADR-068) bound each key only by the second. One integration (a partner's feed, a
script run in a loop) could use up the month's requests every other integration of the company
needs, and nobody could tell which key used what: keys showed only when they were last used.

Decision:

- **Counted per key:** every request the API admits is also counted for the key that made it, in
  `app.api_key_usage` (one row per key and period), in the company's usage period (ADR-061), so a
  key's month is the plan's month. Keys without a limit are counted too, so Settings → API keys
  shows each key's requests this period.
- **A key's own limit:** optional, a whole number from 1 to a billion (`api_keys.monthly_request_limit`,
  null for none). Set when the key is created and changed later for an active key, by owners and
  administrators (`developer.manage`) after a recent sign-in (ADR-056), like its addresses
  (ADR-076); the change applies from the key's next request, to the requests already counted this
  period, and is audited with the limits before and after (`api_key.limit_changed`; a creation's
  audit entry carries the limit). A rotated key's successor keeps the limit, and its own requests
  are counted from zero: the same people manage both, so this is no way around a limit they could
  change anyway.
- **Admission:** in the transaction that counts the company's request (ADR-061), the key's count
  is taken first, below its limit (one upsert, atomic whatever runs in parallel), then the
  company's; a request its key refuses takes nothing from the company, as with the rate limits,
  and a request the company refuses is taken back from its key (a savepoint), so a refused request
  counts for neither. The key's limit is read under a key share lock, which waits for a change of
  the limit in progress (the change holds the key's row FOR UPDATE), so a request is never counted
  under a limit just replaced; the last-used update (at most once a minute) already skips a locked
  key and is made by a later request. Every request locks its key, then the key's count, then the
  company's, so requests cannot deadlock. A key that used up its month gets 429 `rate_limited` with reason
  `key_quota_exceeded`, the limit and when requests are accepted again in the message, and
  Retry-After until the next period; with both used up, the key's refusal is the one given.
- **Access and data:** the runtime role reads the counts, adds to them and cannot move them to
  another key or period or delete them (column grants); a count belongs to a key of the same
  company (a composite foreign key). The counts are in the company export and are deleted with the
  company, before its keys.

Not built: warnings before a key's limit (the company's warning at 80% stays, ADR-062), emails
when a key's month is used up, per-key limits per endpoint, and per-key usage on HyFib's platform
pages.

## ADR-098 Emails about an API key's own monthly limit (2026-09-30)

Context: a key with a monthly limit of its own (ADR-097) was refused once its month was used up
without anyone being told, while the company's limit warns the billing managers at 80% (ADR-062)
and tells them when it is reached (ADR-061). The integration behind the key simply started failing.

Decision:

- **Who and when:** the company's active owners and administrators, the roles that manage keys (as
  for the expiry reminders, ADR-067), are emailed once when a key's requests reach 80% of its limit
  (rounded up) in a usage period, and once when they reach the limit. A period that reaches the
  limit before the sweep saw it at 80% gets only the second email, and limits of 1 to 4 have no
  warning (80% of them rounded up is the limit), as for the company (ADR-062).
- **How:** `app.api_key_usage` gains `warned_at` and `notified_at`. The minute messaging sweep lists
  the counters due through `ops.api_key_usage_notices_due` (SECURITY DEFINER, the worker's role
  only, ids only): of the last month, of a usable key with a limit, of a company whose keys still
  work (not being deleted). Each is locked and checked again in the company's own scope, including
  that it is the current period's counter, and marked in the transaction that queues the emails, so
  two sweeps at once send one email. A counter of an earlier period is marked without an email (as
  the company's, ADR-062), so that the sweep stops listing it; one of a later period, counted by a
  server whose clock is ahead, waits until it is current.
- **Changing the limit arms them again:** a new limit (or none) clears this period's marks, so the
  emails follow the new limit; the next period's counter is a new row, armed from the start.
- **What the email says:** the key's name and public prefix (never a token), the requests used, the
  limit and when the period ends in the company's time zone, and where to change the limit.
  Settings → API keys shows when each email went out this period.

Not built: a choice of recipients or thresholds, emails for keys without a limit of their own, and
notices in the product beyond the settings page.

## ADR-099 Addresses for all of a company's API keys (2026-09-30)

Context: a key can be held to the networks its systems call from (ADR-076), but a company that
wants all its API traffic to come from its own servers had to set every key, and a key created
without networks accepted requests from anywhere (listed as not built under P5-08: networks for
the whole company).

Decision:

- **One list for the company:** up to 20 IPv4 or IPv6 addresses or networks for all of the
  company's keys (`app.api_settings.allowed_networks`, one row per company, made when first set,
  migration 0076), typed, checked and kept as a key's are (ADR-076); empty accepts any address.
- **Both lists apply:** a request must come from one of the company's networks, and from one of
  its key's own networks when the key lists any; the key's own list is checked first. Keys created
  later are held to the company's list from their first request.
- **Who sets it:** members who manage keys (`developer.manage`) after a recent sign-in (ADR-056),
  in Settings → API keys ("Addresses for all keys"). Each change is audited as
  `api.networks_changed` with the lists before and after; the same list again records nothing.
  Changes take the company's key lock, so two first changes at once make one row and the second
  sees the first.
- **Checked in the lookup:** `ops.api_key_authenticate` reads the company's networks after the
  key's own and before the key is marked used, so a refused request does not mark it used, and says
  which list refused the address (`refused_by`). The API answers 403 `ip_not_allowed` naming the
  address and whose list refused it ("The company this API key belongs to does not accept API
  requests from …"), and counts the attempt against the per-address limit of failed
  authentication, as for a key's networks.
- **Data:** the list is in the company export and deleted with the company (deletion step 857);
  the runtime role reads and changes only its company's row and cannot delete it.
- **Rollout:** migration 0076 rebuilds the function with the same arguments and one more column.
  Web servers of the previous release select the columns they know by name, so during a rolling
  deploy they keep working, and answer a company refusal with the key's message until replaced.

Not built: exceptions for single keys, networks per scope or endpoint, hostnames, time windows,
and alerts or a list of refused requests (the web server logs each refusal with the key and
company).

## ADR-100 Emails to companies about plans HyFib staff set (2026-09-30)

Context: platform staff put a company on a plan, start or extend its trial, set a paid period,
change its add-ons, make it complimentary or end its plan from the company's platform page
(ADR-051). Each change was audited in both audit logs, but nobody at the company was told: the plan
sweep emails billing managers when a trial or period ends (ADR-051), and subscriptions email about
payments (ADR-063), while a change by staff could restrict the company without warning (listed as
not built under P5-01: plan-change emails to companies).

Decision:

- **Who and what:** the company's active billing managers (owners and members with the billing
  role, as for the other billing notices) get one email per change, "HyFib changed your plan", with
  what the plan is now: a trial and its end, a paid period and its days (in the company's time
  zone), complimentary access, or an ended plan and what that pauses; the add-ons it includes; and
  HyFib's reason, which the company's audit log already showed. It links to Billing. The platform
  form says that the reason is emailed.
- **Marked by the change, sent by the worker:** the platform role cannot queue email (ADR-090), so a
  staff change sets `app.tenant_plans.staff_notice_version` to the version it writes (migration
  0077; the platform role may update that column, the runtime role no column). The worker's minute
  billing sweep lists the companies with a mark (`ops.plan_change_notices_due`, not companies being
  deleted), and takes each company's notice in its own scope
  (`app.take_plan_change_notice()`), in the transaction that queues the emails: the mark is cleared,
  so a change is told at most once, and two sweeps at once tell it once.
- **The latest state, or nothing:** two changes before the sweep make one email with the plan as it
  is. A change that the plan sweep (a trial or period that ended) or a subscription replaced before
  the email went out is not told, as their own emails tell the company the newer state; the same
  plan saved again changes nothing and tells nothing.
- **Lock order:** taking the notice locks the company row before the plan state, as staff changes
  and the plan sweep do; the emails' outbox rows reference the company row, so the other order
  could deadlock with a staff change.

Not built: emails when staff cancel a company's subscription, a choice of recipients, notices in
the product beyond the plan card, and emails for plan changes the company makes itself (its
subscription emails cover those).

## ADR-101 Emails to companies when HyFib staff cancel their plan subscription (2026-09-30)

Context: a platform owner can cancel a company's Razorpay subscription at once from the company's
platform page, with a reason (ADR-063), for example before changing its plan, which staff cannot do
while a subscription is live. The cancellation went to both audit logs, but nobody at the company
was told: a company's own cancellation emails its billing managers, while a cancellation by staff
stopped the charges without a word until the plan ended (listed as not built in ADR-100 and P5-01).

Decision:

- **Who and what:** the company's active billing managers (owners and members with the billing
  role) get one email, "HyFib cancelled your plan subscription": the plan and the day (in the
  company's time zone), that nothing more is charged, what the plan keeps, and HyFib's reason (the
  one the company's audit log shows). What the plan keeps is read from the plan state when the email
  goes out: a period the subscription paid that is still running ("runs until …; the plan then
  ends", as `app.apply_plan_transition` ends it as canceled, without grace days), the grace days
  after the last period it paid (when its charges had failed), or neither (a trial, a plan staff set
  since, or a plan that already ended), which the cancellation does not change. A period or grace
  days the plan sweep has not moved on yet (Razorpay did not answer) are not told as running. The
  email links to Billing, which shows how to continue; the platform form says the reason is emailed.
- **Marked by the cancellation, sent by the worker:** as for plan changes (ADR-100), the platform
  role cannot queue email, so a cancellation by staff sets
  `app.plan_subscriptions.staff_cancel_notice_due` (migration 0078; the platform role may update
  that column, the runtime role no column). The worker's minute billing sweep lists marked
  subscriptions after the staff plan changes (`ops.plan_subscription_cancel_notices_due`, oldest
  first, not companies being deleted) and takes each one in the company's own scope
  (`app.take_plan_subscription_cancel_notice(subscription)`, true only for the call that cleared the
  mark), in the transaction that queues the emails: each cancellation is told at most once, and two
  sweeps at once tell it once. The company's own cancellations (which email it already) and those
  of a company deletion are never marked.
- **Lock order:** taking the notice locks the company row before the subscription: the emails'
  outbox rows reference the company row, and staff plan changes and the plan sweep lock it first.
  Only a cancelled subscription is taken, and the subscription sync never applies a period for
  one, so the sync's own order (the subscription, then the company row for a period it applies)
  cannot meet it.

Not built: a choice of recipients, and emails for subscriptions that end at Razorpay without a
cancellation in HyFib (for example one cancelled in the Razorpay Dashboard); the plan sweep's email
tells the company when its plan ends.

## ADR-102 Paying for a plan from the end of the trial (2026-09-30)

Context: a company on a trial that started paying by subscription (ADR-063) was charged in
Checkout at once, and its paid period started then: the rest of the trial was lost, and the page
said so. A company had no reason to pay before the trial's last day, and one that forgot then lost
its plan. A Razorpay subscription can start in the future (`start_at`): Checkout then only
authorises the payment method, the subscription is `authenticated`, and Razorpay starts the first
billing cycle and charges it at that time, which Razorpay itself calls a trial period (R-119).

Decision:

- **When:** a company whose trial ends at least 48 hours ahead starts its subscription at the
  trial's end (`start_at`, stored as `starts_at`); a nearer trial end is charged at once, as before.
  Razorpay starts a card debit with the bank's notice to the payer 36 hours before it (R-073,
  R-119), so a nearer first charge could not be notified in time. Billing names the day on the
  button ("Pay ₹… per month from …") and says that Checkout checks the payment method now, that any
  amount taken for the check is refunded (Razorpay documents no amount, so none is stated), and that
  nothing is charged for the plan before the trial ends.
- **Authorised, not paid:** Checkout's signed response prompts a fetch, as before; an authenticated
  subscription with a start records no payment and leaves the plan state alone, so the trial goes on
  with its limits. The billing managers are emailed once ("Payments for your HyFib plan start when
  the trial ends": the amount, the day and how often), and Billing shows the day. Staff plan changes
  stay refused while the subscription may be charged, as for any live one, so the trial's end cannot
  move away from the start.
- **The first charge:** Razorpay makes the subscription `active` when the first cycle starts and
  then charges it (R-119). The recorded charge makes the plan active for Razorpay's cycle through
  the definer function of ADR-063, which ends the trial and restarts the usage period.
- **The trial waits for the charge:** without it, the trial's end would expire the plan in the
  minutes before Razorpay's charge is recorded. A trial whose company has a subscription starting
  at the trial's end that may still be charged (`authenticated`, `active` or `pending`) waits for
  that charge until the plan version's grace days have passed, as a paid period waits for its
  renewal. One SQL function, `app.trial_charge_wait_until` (migration 0079), holds the rule for the
  plan transition, the sweep's due list and the plan card ("The trial ended on …. Everything keeps
  working while Razorpay makes the first charge, until … at the latest."). A failed first charge's
  email says until when. After the grace days the trial ends as before, and its email says the plan
  is paid once Razorpay's first charge goes through; a later charge still makes the plan active.
- **Missed events:** once the first charge is due, the sweep asks Razorpay hourly until a paid
  cycle is recorded, as after a paid cycle ends.
- **Cancelling:** before the start, the company cancels at once: nothing was charged, and the trial
  goes on. After the start, HyFib asks Razorpay first, so a charge made but not yet heard of is
  recorded, the period it paid stands and the subscription ends with it (as for any active one); if
  Razorpay does not answer, nothing is cancelled and the company is asked to try again. A
  cancellation racing Razorpay's charge in the moment between that check and the cancel can still
  leave a charge on a cancelled subscription: the daily reconciliation reports it as a plan payment
  not recorded (ADR-059), for a person to refund. Staff cancellations are emailed as before
  (ADR-101), naming the trial the payments were to start after: going on, or over when it ended
  waiting for the first charge.

Uncertain: whether Razorpay accepts an `expire_by` (HyFib's one-hour Checkout window) earlier than
the start, which its example puts after it, and the amount of the authentication payment. The
release checklist has the test-mode check (R-119).

Not built: moving the start when staff extend a trial (they cancel the subscription first, as for
other plan changes), and payments starting on a day other than the trial's end.

## ADR-103 Refunds of plan payments (2026-09-30)

Context: companies pay for plans by Razorpay subscription (ADR-063), and HyFib could not refund a
plan payment. A refund made in Razorpay's Dashboard was not recorded either: `refund.processed`
found no top-up for the payment and was set aside as an unknown refund, the receipt (ADR-064) did
not show it, and the daily reconciliation (ADR-059) left it to a person. Staff need to refund a plan
payment, for example a charge made after the company asked to cancel, or a goodwill refund.

Decision:

- **Who:** platform owners, from the company's platform page, with a written reason (10 to 2,000
  characters, kept in the platform audit log). Operators see refunds but cannot start them. Part or
  all of a recorded plan payment can be refunded: at least ₹0.01 and at most what Razorpay has not
  refunded of it, one refund of a payment at a time. Not for a company being deleted (refund in the
  Razorpay Dashboard; the webhook now records it), and a deletion that is due waits until no refund
  of a plan payment is open, as for refunds of service credit (ADR-058).
- **The plan does not change:** a refund never changes the plan state or the subscription. Reasons
  vary (a goodwill refund, part of a price, a charge after a late cancel), and ending a plan on a
  partial refund would be wrong. To end the plan, staff cancel the subscription (ADR-063) and then
  change the plan (ADR-051); the form says so. Plan payments never touch the wallet, so nothing is
  held.
- **Flow, as ADR-058:**
  1. `ops.platform_request_plan_payment_refund` (SECURITY DEFINER, platform role only) checks the
     role, the reason, the company's status, the payment and the amount, and records the request
     with the platform audit entry. Requests and recordings of one payment's refunds take the same
     transaction lock, so what is refunded never exceeds what was paid.
  2. The minute billing sweep lists due requests (`ops.plan_payment_refunds_due`) and queues one
     signed `billing.plan-payment-refund` job each, run in the company's scope. The attempt is written
     down first; then `POST /v1/payments/:id/refund` with the amount, speed `normal`,
     `X-Refund-Idempotency: ppr_<request id>` (R-086) and the note `hyfib_plan_refund: <request id>`.
     A plan payment is refunded like any captured payment (R-121; whether Razorpay changes the
     subscription or its invoice is unconfirmed point 29, checked in test mode before release).
     A refund returned makes the request `submitted` (company audit log, billing managers emailed),
     and one already processed is recorded at once; a refusal (a 4xx other than 401 and 409) fails
     the request and emails the billing managers; anything else is tried again with the same key
     after 1, 5, 15 and 60 minutes, then hourly.
  3. `refund.processed`, the job's own check (every 15 minutes, backing off to 6 hours) and the daily
     reconciliation fetch the refund and its payment from Razorpay and call
     `app.record_plan_payment_refund` in the company's scope. The refund with this id completes its
     request. A refund whose id HyFib never stored (the creation's response was lost) completes the
     request its notes name, when the amount is the same: Razorpay returns a refund's notes (R-120),
     so it is never recorded as a second refund. Any other processed refund of the payment was made
     at Razorpay and is recorded as such. Processed refunds of a payment never exceed it (W3412).
  4. `refund.failed`, or a fetched refund that failed, fails the staff request it belongs to and
     emails the billing managers; a failed refund nobody asked for through HyFib changes nothing.
     Failing moves no money, so the runtime role may fail an open request; only the definer function
     marks a refund processed or records one made at Razorpay.
- **What people see:** the plan payment's receipt lists its refunds (in progress, or refunded on a
  day, started by HyFib or made at Razorpay) and the amount paid after refunds; Billing's payments
  table marks refunded amounts and a refund in progress; the platform page lists the refunds with the
  reason and who asked, and the form. The company never reads the reason or who asked (column
  grants), and its emails give neither.
- **Reconciliation:** a refund of a plan payment in the settlement report is matched against the
  recorded refund by id (amounts compared); one HyFib has not recorded is fetched and recorded
  through the same path, as its webhook would have been, instead of waiting for a person.
- **Records:** refunds of plan payments are billing records, kept after the company's deletion with
  the payments they refund (no role may delete them), and exported without the reason and who asked.

Not built: refunds asked for by companies, ending the plan with a refund, instant refunds
(`optimum`), several open refunds of one payment, credit notes and tax invoices, disputes of plan
payments, plan payment refunds in the platform-wide refunds list (ADR-073), emails about refunds
made in the Dashboard, and the "HyFib is refunding" email for a staff refund that Razorpay reports
processed before HyFib stored its id (recognised by its notes after a lost response; the receipt
shows it). ADR-104 builds refunds asked for by companies and plan refunds in the platform-wide list.

## ADR-104 Refunds of plan payments asked for by companies; plan refunds in the platform-wide list (2026-10-01)

Context: since ADR-103 a platform owner can refund a plan payment from the company's platform page,
but a company could not ask for one except by writing to support, and `/platform/refunds` (ADR-073)
listed only refunds of service credit. Both were listed as not built in ADR-103.

Decision:

- **Asking, as for service credit (ADR-073):** members with `billing.manage` and a sign-in within the
  last 15 minutes (ADR-056) ask from a plan payment's receipt for a refund of part or all of it, with a
  reason of 10 to 1,000 characters. The amount is at least ₹0.01 and at most what Razorpay has not
  refunded of the payment; no request while a refund of the payment is in progress, one open request
  per payment (a partial unique index), none once the company asked for its deletion (its status read
  under a share lock in the request's transaction). The company can withdraw an open request. A
  request moves no money and changes nothing about the plan.
- **One daily limit:** a company may make 5 refund requests in 24 hours, of either kind, counted under
  the same per-company advisory lock that requests of service credit already take.
- **Deciding:** only a platform owner decides. `ops.platform_decide_plan_payment_refund_request`
  locks the open request; approving calls `ops.platform_request_plan_payment_refund` (ADR-103) for
  the request's amount in the same transaction, so every check runs again under its lock (what
  Razorpay has not refunded of the payment, a refund in progress, a company being deleted): a request
  that no longer fits is refused with the reason and stays open for a decline. The refund's staff
  reason reads "Asked for by the company:" and the company's reason. Declining needs a note the
  company reads. Both are in the platform audit log; the company never sees who decided (column
  grants). The refund, as any staff refund of a plan payment, never changes the plan or the
  subscription.
- **Hearing about it:** the minute billing sweep's email to platform owners about new requests counts
  both kinds (still a count only: no company, amount or reason; its wording names the kinds, and it
  links straight to the plan payments' list when every request it announces is of a plan payment). A
  declined request is emailed to the company's billing managers once, with the note, marked in the
  company's own scope in the transaction that queues it. An approval needs no email of its own: the
  refund's emails (ADR-103) follow.
- **The platform-wide list:** `/platform/refunds` shows service credit or plan payments. For plan
  payments it lists the companies' requests (waiting, decided or all) with the payment, what
  Razorpay has not refunded of it and whether a refund is in progress, and every refund of a plan
  payment across companies (started by HyFib, answering a request, or made at Razorpay), newest
  first on exact keyset pages (ADR-072).
- **Data:** `app.plan_payment_refund_requests` is a company table (RLS; the company reads all but who
  decided and the notice marks, inserts open requests and moves an open request only to withdrawn).
  It is exported with the company's data and deleted with the company (ADR-055, step 77); the
  refunds it led to stay as billing records (ADR-103).

Not built: approving a different amount (decline with a note and refund from the company's page),
several open requests per payment, reminders about waiting requests, in-app notices, and refund
requests through the public API.

## ADR-105 Companies choose the plan they pay for (2026-10-02)

Context: a company could pay only for the plan version HyFib staff put it on (ADR-063), so a company
on the default trial needed staff before it could pay for another plan. Changing a plan a
subscription already pays for is a different problem: Razorpay lets a subscription paid by a
domestic card update only its offer, at the end of a cycle, and one paid by UPI or eMandate not at
all (R-069), so such a change would need a new subscription that starts when the paid period ends.

Decision:

- **Offered versions:** platform owners offer a published plan version to companies and can stop
  offering it (`ops.plans.offered_at` and `offered_by_user_id`), both in the platform audit log.
  Nothing is offered until they do. A version priced under ₹1 cannot be offered (it could never be
  paid, R-064), retiring a version stops the offer in the same update, and the plan guard lets only
  the offer change on a published version.
- **Who and when:** owners and billing managers (`billing.manage`) with a sign-in within the last
  15 minutes (ADR-056), while the company is active or restricted (not suspended and not being
  deleted), has no subscription that may still be charged, is on a trial, past due, expired or
  canceled (not complimentary access and not a paid period, whose change is not built), and paying
  for plans is available (Razorpay subscriptions on and the tax on plan prices set).
- **What changes:** only the plan version, through `app.choose_plan` (SECURITY DEFINER, the runtime
  role only), which checks all of the above in SQL under its locks. The status, the trial's end,
  the paid period and grace days, the add-ons and the monthly usage period stay as they are, so
  switching never resets monthly counts; the add-ons must be sold by the chosen version (the plan
  state's guard). The company then pays as before (ADR-063, ADR-102): the payment offer is for the
  chosen version. A staff plan change not yet emailed (ADR-100) is not emailed once the company
  chose after it.
- **Limits:** the chosen version must hold what the company uses now: seats (members and waiting
  invitations), WhatsApp numbers, teams and live automations. Otherwise the choice is refused,
  naming each one over. They are counted in the choice's transaction after it takes the advisory
  locks that additions take (ADR-051), so a choice and an addition cannot both pass. Monthly limits
  (automation runs, API requests) refuse nothing: what the period used so far counts against the
  chosen version's limit. A version the company could not pay for with its add-ons and the tax
  (more than a plan payment can be) is refused as paying for it would be, whatever the page showed
  when it was loaded.
- **Serialised with paying and staff changes:** `app.choose_plan` first takes the per-company
  advisory lock that starting a subscription takes, so a start never records the version a choice
  replaces, then the company row (shared, as a deletion request updates it) and the plan state, in
  the order the plan sweep and staff changes lock them. The chosen version is then held by a
  per-version advisory lock, shared, which the plan guard takes exclusively whenever a published
  version stops being offered (withdrawn, or retired, which clears the offer; migration 0083 after
  review): a choice either commits before the change, as a company already on the version would
  have, or waits for it and is refused, so no company ends on a version withdrawn or retired while
  it chose. (A row lock on the version would need an update grant and policy for the definer.)
- **Trials:** during a trial the chosen version's limits and modules apply at once, until the
  trial's end, which does not move. A company can therefore try any offered version within its
  trial; platform owners decide which versions are offered.
- **Recorded:** in the company audit log (`billing.plan_chosen`, with the versions before and
  after), and in the plan state's note ("Chosen by the company.") with the member, which staff see
  on the company's platform page. No email: the member who chose sees the result.

Not built: changing a plan a subscription pays for (a new subscription from the period's end,
R-069), choosing add-ons, a price list for visitors before sign-up, proration, and emails about a
company's choice.

## ADR-106 Companies choose their add-ons (2026-10-02)

Context: since ADR-105 a company chooses its plan version, but only HyFib staff set its add-ons
(extra seats, extra WhatsApp numbers and automation run packs, ADR-051), so a company whose team
outgrew its version's seats needed staff, or a bigger version, before it could pay for more.
Changing add-ons a subscription already pays for meets the problem of changing its plan (R-069):
it would need a new subscription from the end of the paid period.

Decision:

- **Who and when:** as for choosing a plan (ADR-105): owners and billing managers
  (`billing.manage`) with a sign-in within the last 15 minutes, while the company is neither
  suspended nor being deleted, has no subscription that may still be charged, is on a trial, past
  due, expired or canceled, and paying for plans is available (Razorpay subscriptions on and the
  tax on plan prices set). The company's version must still be published: a retired version cannot
  be paid for (ADR-063), so its add-ons stay as staff left them until the company chooses another
  plan. The version need not be offered: a company pays for the version it is on.
- **What changes:** only the three quantities, through `app.choose_add_ons` (SECURITY DEFINER, the
  runtime role only), which takes the company and member from the session's scope and checks all
  of the above in SQL under the locks of `app.choose_plan` (the subscription-start lock, the company
  row shared, the plan state for update). The plan state's guard keeps them to what the version
  sells, within its maximums (its most seats, its most WhatsApp numbers or 100, and 10,000 run
  packs). The version, the status, the trial's end, the paid period and the monthly usage period
  stay as they are. The version is read without a lock: a retirement committing meanwhile leaves
  the company on its version, as it leaves every company on it.
- **Limits:** a decrease cannot leave fewer seats (members and waiting invitations) or WhatsApp
  numbers than the company uses, counted in the change's transaction after the advisory locks that
  additions take (ADR-051). An increase is always allowed, even when the company is still over the
  limit after it. Fewer run packs refuse nothing: what the month used counts against the smaller
  allowance (as a monthly limit does on a change of plan, ADR-105). A total with the add-ons and the
  tax above what one plan payment can be is refused, as paying it would be.
- **Trials:** during a trial the add-ons apply at once, until the trial's end, which does not move.
  A company can therefore try more seats or numbers within its trial; platform owners bound them
  with each version's maximums and prices.
- **Recorded:** in the company audit log (`billing.add_ons_chosen`, with the quantities before and
  after), and in the plan state's note ("Add-ons chosen by the company.") with the member, which
  staff see on the company's platform page. A staff plan change not yet emailed (ADR-100) is not
  emailed once the company changed its add-ons after it. No email: the member who chose sees the
  result.

Not built: changing add-ons a subscription pays for (R-069) and proration, add-ons through the
public API, and emails about a company's change.

## ADR-107 A price list for visitors (2026-10-02)

Context: since ADR-105 platform owners offer plan versions that companies choose and pay for under
Billing, but someone deciding whether to sign up cannot see them: prices appear only inside a
company. Offering a version to companies is not the same as publishing its price to anyone on the
internet (a version may be offered to existing companies first), so a public price list needs its
own decision.

Decision:

- **Shown by platform owners:** `ops.plan_settings.price_list_shown_at` and
  `price_list_shown_by_user_id` (migration 0085, paired by a check constraint), set and cleared by
  platform owners on the platform Plans page ("Show the price list" and "Hide the price list"), each
  in the platform audit log (`platform.price_list_shown`, `platform.price_list_hidden`). It is
  hidden until a platform owner shows it.
- **What visitors see:** `/pricing`, without signing in: every version that is published and
  offered, as companies see them under Billing → Choose a plan (cheapest first), with its price
  before tax and with the tax, what it includes (seats, WhatsApp numbers, teams, live automations
  and monthly automation runs when it has automations, monthly public API requests and whether only
  part of the API, the modules with and without), the add-ons it sells with their prices and
  maximums, the default trial's length, and that Meta bills WhatsApp's own message charges directly
  (ADR-011). Links to sign in and to create an account. Nothing about any company or person, and
  nothing of drafts, retired versions or versions that are not offered.
- **Only when a visitor could follow it:** the page lists versions only while the list is shown,
  paying for plans is available (Razorpay subscriptions on and the tax set, as for choosing a plan),
  there is a default trial (without one a new company starts complimentary and cannot choose a plan,
  ADR-105), and an offered version can be paid for with the tax: a version whose price with the tax
  is more than one plan payment can be is left out, as choosing it would be refused. Otherwise
  `/pricing` is not found. The platform card says which of these is missing, from the same rule
  (`priceListGaps`).
- **How it reads:** in the system scope as the runtime role, in a read-only transaction, without a
  function: the role already reads published and retired versions (0023) and the tax (0037); 0085
  grants it whether the list is shown and the default trial, not who showed it. Each view is one
  transaction of two small queries, with no rate limit or cache of its own: like the public chat
  links (`/l/{slug}`), the edge limits requests per address and must not cache it (DEPLOYMENT).
- **Not indexed:** search engines are asked not to index it, as for every page of the app; HyFib's
  own site links to it.

Not built: links from the sign-in and sign-up pages (they render without the database), versions
listed without being offered or offered without being listed, prices in other currencies,
comparisons by feature, caching, and the price list through the public API.

## ADR-108 Retrying dead-lettered jobs from the operations console (2026-10-02)

Context: ADR-054 left out a redrive button because every queue's work is a durable row that the
minute sweeps signal again. An audit of the 25 queues that dead-letter found that this holds for 19
of them, but not for these:

- `channel.onboard`: a number whose setup job died stays in setup indefinitely (only the company's
  "Retry setup" restarts it).
- `commerce.account`: a payment account check stays open, so payment links are refused, and the
  console does not show it.
- `template.delete`: the template stays "pending deletion" until the account's next template sync,
  up to 6 hours later, puts Meta's status back, silently undoing the deletion.
- `template.submit`: never sent again; the sync marks it "submit failed" and the company submits
  it again.
- `webhook.process` and `billing.event-process`: once the receipt has used its 12 attempts, which
  the receipt retry on the Integrations page already repairs.

The runbook's fallback did not work either: `boss.redrive('dead-letter', …)` moves only copies not
yet started, and the worker completes every copy once it has recorded the dead letter. The failed
job itself stays in its queue, failed, until the queue's retention deletes it (1 to 7 days).

Decision:

- **Retry from the Queues tab:** a platform administrator (either role, as for the receipt retry)
  sends a dead letter's job back to its queue once, with a reason of 10 to 2,000 characters,
  through `ops.platform_retry_dead_letter` (migration 0086; SECURITY DEFINER, executable by
  `w360_platform` only). In one transaction the function:
  - makes pg-boss 12's own retry (`retryJobs`): state back to `retry`, one more attempt allowed,
    no completion time;
  - marks the dead letter (`retried_at` and `retried_by_user_id`, paired by a check);
  - writes `platform.dead_letter_retried` to the platform audit log.

  A worker takes the job as it was, with its signed envelope, and authorizes it again. If it fails
  again, pg-boss dead-letters it again and it is listed as a new dead letter, which can be retried
  in its turn.

- **Refused** (in the function, and not offered by the console):
  - a dead letter already retried;
  - one whose envelope did not verify (the worker would refuse the job again) or without its job;
  - one of a company being deleted or gone;
  - a job pg-boss no longer keeps as failed: deleted after its queue's retention, or already sent
    back;
  - a job of a queue that never retries its jobs: `billing.auto-recharge`, whose sweep repeats an
    attempt only after looking it up at Razorpay. No producer sets a job's retry limit, so a limit
    of 0 is the queue's;
  - a job of the receipt queues (`webhook.process`, `billing.event-process`): the receipt retry
    resets the receipt's attempts and refuses a receipt whose body was erased;
  - a job whose work already waits in its exclusive queue (pg-boss's unique index), which will do
    that work.
- **What the console shows:** Retry and until when pg-boss keeps the failed job (the failure time
  plus the queue's retention) for a dead letter that none of the refusals applies to, by this
  release's queue catalog (a queue it does not declare is not offered); otherwise why not. A
  retried dead letter shows who retried it and when.
- **Least privilege on pg-boss:** the migration runner grants `w360_definer` usage of the `pgboss`
  schema, SELECT on `pgboss.job`'s id, name, state and retry limit and UPDATE on its state, retry
  limit and completion time: never a job's data or output, and never inserting or deleting jobs.
  It grants them on every migration run, after pg-boss installs or upgrades its schema, which
  happens after the SQL migrations.
- **No retried job deleted unstarted:** a retried job is due at once. pg-boss deletes a waiting job
  14 days after it was first due (its default retention, which the runner does not change), and a
  retry is offered only while the failed job is kept, at most 7 days for a queue that dead-letters
  (a unit test pins it).

Not built: sweeps that signal the stranded work of `channel.onboard`, `commerce.account` and
`template.delete` again (they would make most retries unneeded), retrying several dead letters at
once, whether a retried attempt succeeded (a new failure is listed as a new dead letter), and
retries through the public API.

## ADR-109 Paying companies change their plan or add-ons from the next period (2026-10-02)

Context: since ADR-105 and ADR-106 a company chooses its plan version and add-ons, but only while
nothing may still charge it. A company paying by subscription had to ask HyFib staff, and staff
cannot change a plan while a subscription is live (ADR-063). Razorpay cannot change the plan of a
subscription paid by a domestic card (only its offer, at a cycle's end) and cannot change one
authorised through UPI or eMandate at all (R-069). A subscription cancelled at the end of its cycle
cannot be renewed or reactivated, and the documentation shows no way to undo such a cancellation
(R-068, R-122). So a change needs a new subscription.

Decision:

- **Who and when:** owners and billing managers with a recent sign-in can change the plan from the
  end of the paid period. The company must:
  - not be suspended or being deleted;
  - be able to pay for plans here (Razorpay subscriptions on, the tax set);
  - have a plan that is `active` for a period its subscription paid;
  - have that subscription `active` at Razorpay, or already ending: cancelled at the period's end,
    or ended without charging again;
  - be at least 48 hours from the end of the paid period. Razorpay starts a card debit, with the
    bank's notice, 24 to 36 hours before the debit date (R-073, R-119). So the current
    subscription's renewal has not started yet, and the new subscription's first charge can be
    notified in time (as ADR-102).
- **What:** the company picks the next plan:
  - a version platform owners offer, or the version it is on while that is published;
  - add-ons within what that version sells (ADR-106's bounds).

  The change is refused when:
  - the next plan holds less than the company has now (seats with waiting invitations, WhatsApp
    numbers, teams, live automations);
  - its total with the tax cannot be one plan payment;
  - it is what the company already pays for and the current subscription is not ending.

- **How (Billing → Change plan)**, in this order:
  1. HyFib cancels the current subscription at the end of its cycle at Razorpay
     (`cancel_at_cycle_end`, the company's own cancel of ADR-063), unless it already ends then.
     This cannot be undone.
  2. HyFib records a new subscription for the next plan's price (written ahead, as ADR-063). It
     starts at the end of the paid period (`starts_at`), is marked as following the current one
     (`follows_subscription_id`), and is created at Razorpay with `start_at` (as ADR-102).
  3. The payer authorises it in Checkout. Razorpay refunds the authorisation payment (R-075,
     R-119). Nothing is charged before the period ends.

  Because the current subscription is cancelled first, the two can never both charge: the new one
  exists only once the current one ends with the period. The cost is this: if the payer leaves
  Checkout without authorising, the current subscription still ends. Billing says so, and the
  company can authorise again or choose again, including the plan it pays for now, until 48 hours
  before the period's end. After that, the plan ends with the period, and the company pays again
  as for any ended plan.

- **At the period's end:** the current subscription ends at Razorpay. The plan transition does not
  end the plan as canceled when a new subscription (authenticated, active, pending or halted)
  starts at the period's end. The period is then due like any renewal: past due within the grace
  days of the current version, or expired if it has none.

  The new subscription's first paid cycle, fetched and checked like every plan payment (ADR-063),
  goes through `app.apply_plan_subscription_period`. In one transaction it makes the plan active on
  the next version and add-ons for that cycle and restarts the monthly usage period. It is
  recorded in the company's audit log with the previous version and add-ons.
  - A subscription for another version or other add-ons than the plan state is applied only when
    it follows the subscription that paid the plan's period. Otherwise it is never applied
    (`mismatch`, as in ADR-063).
  - A cycle never moves the plan's period back. A cycle of another subscription that ends no later
    than the period paid by the plan's subscription is `stale`. Before, a subscription renewed
    after it should have ended could take the plan back to an earlier period.
  - A version retired since the change was made is applied all the same. The company paid for it,
    and companies on a retired version keep it (ADR-051). So the plan guard lets a retired version
    in only as the plan of the paid subscription that follows the one that paid the plan.
  - Things the company added after the change and beyond the next plan's limits stay, as when
    staff set a smaller plan. Adding more is refused (ADR-051).

- **Changing again before the period ends:** a new choice replaces the scheduled one. HyFib first
  cancels the earlier new subscription at Razorpay at once (it was never charged), then creates
  another. The same plan and add-ons chosen again while the earlier one is still in its Checkout
  window reopen that Checkout instead; one whose window has closed is cancelled at Razorpay by the
  next check, as any unpaid subscription (ADR-063). Cancelling the new subscription on Billing leaves the plan to end with the period, since
  the current subscription already ends then.
- **Only one subscription keeps charging:** the unique index allowed one live subscription per
  company. It now allows one live subscription that is not ending at its period's end. So the
  current subscription, which is ending, and the one that follows it can coexist, but two can
  never both keep charging.

  A trigger refuses a new subscription that follows another unless all of these hold:
  - the one it follows paid the company's current period and charges no more after it (`active`
    and cancelled at the period's end, `cancelled`, `completed` or `expired`);
  - it starts exactly when that period ends, and at least 48 hours ahead;
  - its company is not suspended or being deleted;
  - its version is offered or is the company's current version, and is published;
  - its add-ons are ones that version sells, within its maximums;
  - its price is what that version charges for its add-ons, with the tax set now.

- **Emails:**
  - When the current subscription is cancelled for a change, the email says the plan changes on
    that date once the new payment is authorised, and ends otherwise.
  - Once the new subscription is authorised, an email says what the plan becomes, from when, and
    what Razorpay will charge.
  - The usual payment email follows the first charge, naming the new plan.
- **Staff and deletion:** a staff cancel (ADR-063, ADR-101) and company deletion (ADR-055) cancel
  every subscription that may still charge, including the new one, at once. ADR-101's email is sent
  once, for the subscription that paid the plan. Staff plan changes stay refused while any
  subscription is live.
- **What the company and staff see:**
  - Billing shows the current subscription and the next one: when it starts, the plan, what it
    costs, and whether it still needs authorising.
  - The plan card says what the plan becomes and when.
  - The platform company page lists both subscriptions.

Not built:

- Changes that take effect at once. Razorpay's immediate, prorated update is not available for
  domestic cards; refunding the unused part and starting a subscription at once would need its own
  design.
- Changes while a trial is paid from its end. The company can cancel that payment and choose again
  (ADR-105).
- A reminder email when a change is left unauthorised.
- Detecting a subscription Razorpay charged after HyFib asked it to end. The `stale` rule keeps it
  from moving the plan, and its payment stays recorded so it can be refunded.
- Changes through the public API.

Open questions for Razorpay:

- that a domestic-card subscription cannot be changed in place (research question 14);
- whether `expire_by` may come before `start_at` (as in ADR-102);
- what a second cancel at the cycle's end returns, since the fetched subscription does not show a
  cancellation scheduled for the cycle's end.

## ADR-110 Packs of extra API requests (2026-10-02)

Context: a plan limits a company's public API requests per monthly usage period (ADR-061). At the
limit every request is refused with 429 `quota_exceeded` until the next period, and the company's
only way out is another plan. Automation runs have packs that raise their monthly limit (ADR-051);
API requests had none (BACKLOG P5-08, ARCHITECTURE "Not built yet"). While adding them, a fault in
run packs turned up: a limit with packs is computed in 32-bit integers, and 10,000 packs of up to
10,000,000 runs on top of up to 100,000,000 runs pass that range. A company with such packs got
"integer out of range" from every entitlement check, and the minute sweep's lookups, which compute
every company's limit in one query, failed for every company.

Decision:

- **What a version sells:** a version with a monthly API request limit above 0 may sell API request
  packs, as it sells run packs: a pack size (1 to 100,000,000 requests a month) and a price per
  billing interval, both or neither. A version without a limit, or without the API (0), sells none:
  there is no limit to raise. Check constraints hold this whatever writes the row (a pack without
  any limit too, which a plain `api_requests_monthly > 0` would let through as NULL), and a
  published version keeps its packs (the plan guard compares the two columns).
- **What a company has:** `tenant_plans.api_request_packs`, 0 to 10,000, none without a plan. Staff
  set it with the plan from the company's platform page (ADR-051), and the company sets it under
  Billing → Add-ons (ADR-106) and Billing → Change plan (ADR-109), with the other add-ons and under
  the same conditions. The plan state's guard keeps it to versions that sell packs.
- **The limit:** the version's monthly requests plus packs × pack size. `app.tenant_entitlements`
  returns it, so request admission (ADR-061), the plan card, Settings → API keys and the platform
  company page count the packs; the sweep's lookups for the 80% warning (ADR-062) and the used-up
  notice count them too. Fewer packs lower the limit at once, as fewer run packs do.
- **At most 2,000,000,000 with packs:** the guards of the plan state and of a following subscription
  refuse packs that would take a limit past 2,000,000,000, for run packs as for API request packs,
  and the forms say how many a version sells (`packsMax`: 10,000, or fewer near the bound). The
  sums are made in 64 bits, so a refusal never fails on the integer range itself. The three sweep
  lookups (`usage_limits_reached`, `api_quota_reached`, `usage_warnings_due`) compare in 64 bits, so
  no company's plan state can stop them for every company; `app.tenant_entitlements` casts its
  64-bit sums back to 32 bits, so a plan state written before this migration that passes the bound
  fails loudly for that company alone rather than wrapping. None can exist in production: nothing
  is deployed yet.
- **Paying:** a subscription records its packs (`plan_subscriptions.api_request_packs`) and charges
  them at the version's price with the other add-ons and the tax (ADR-063). A following subscription
  (ADR-109) is checked with them: sold by its version, within the bound, in its price. Its first
  paid cycle puts them on the plan, audited with the packs before.
- **A subscription that follows none is for the plan as it is:** a new guard refuses one whose
  version or add-ons are not the plan state's. HyFib always records them so (ADR-063, ADR-102); the
  guard keeps a web server of the previous release, which does not know the packs, from recording a
  subscription without them for a company that has some during a deploy. Its payments would never
  have applied to the plan (`mismatch`).
- **Deploying:** `app.choose_add_ons` with three quantities stays for web servers of the previous
  release and leaves the packs as they are; a four-quantity function replaces it in this release and
  a later migration drops the old one. A staff change from a server of the previous release leaves
  the packs as they are, and is refused when it moves the company to a version that sells none
  while it has some.
- **Where it shows:** the platform plan form and page, the price list (ADR-107), the Billing plan
  card (packs and the limit with them), Billing → Add-ons, Billing → Change plan, the payment card,
  receipts, the staff plan email (ADR-100) and the company export.

Not built: packs bought once instead of every billing interval, packs per API key (a key's own
limit stays its own, ADR-097), packs that take effect at once for a paying company (they come with
the next paid period, ADR-109), and AI credits (Phase 6).

## ADR-111 Work that runs out of retries ends where the company can see it (2026-10-02)

Context: ADR-108 found three queues whose work is never done after their job dead-letters unless
someone acts: `channel.onboard` (the number stays in setup), `commerce.account` (the keys stay
"checking", so payment links are refused) and `template.delete` (the template stays "pending
deletion" until the account's next template sync puts Meta's status back, silently undoing the
deletion). ADR-108 added a manual retry from the operations console and left out sweeps that signal
this work again.

Signalling it again from a sweep, as the other queues' work is signalled, was rejected:

- These jobs dead-letter only after their own backoff has failed against Meta or Razorpay for
  minutes to hours. Repeating them on a timer either loops while the provider is down (a dead letter
  and an alert on every turn) or needs attempt bookkeeping on every row.
- Number setup registers the number with Meta, and registration attempts count towards a limit
  (error 133016 blocks registration for 72 hours), so automatic repeats can turn a recoverable
  failure into a block.
- The company can start each of them again itself: Delete again, Save the keys again, Retry setup,
  each audited.

Decision:

- **Longer automatic retries where a repeat is harmless.** `template.delete` (a delete by the
  template's id and name) retries 10 times instead of 5, at most an hour apart (4 to 5 hours in
  all, against 15 to 30 minutes before); `commerce.account` (a read of one payment link list) 8
  times instead of 3, at most 30 minutes apart (1.5 to 2 hours, against 3.5 to 7 minutes).
  `channel.onboard` keeps its 8 retries (2 to 3 hours), as its registration counts towards Meta's
  limit. pg-boss waits 30 s × 2^n × (1 to 2, at random) before the retry that follows n others,
  at most the queue's maximum. The migration runner applies new retry settings to existing queues;
  jobs already queued keep theirs.
- **Settled when the job has run out of retries.** The minute messaging sweep finds dead letters of
  these three queues whose envelope verified and names the job's own queue, that no one retried and
  that are not settled yet, of companies not being deleted, whose work no job is doing again
  (`ops.dead_letters_to_settle`), and settles each one's work in its company's scope, the company
  id coming from the dead letter as the worker recorded it from the verified envelope:
  - a template still pending deletion goes back to the status Meta last reported (the sync requested
    here refreshes it), with a `delete_failed` status event saying Meta could not be reached and the
    template can be deleted again, an event for the status it went back to (both reach the
    company's webhook endpoints as `template.status_changed`, as after a deletion Meta refuses and
    the sync that follows it), a `template.delete_failed` audit entry and a template sync request;
    one Meta itself last reported as being deleted is left to the sync;
  - keys still being checked become `failed`, with a message that Razorpay could not be reached and
    saving them again checks them;
  - a number still in setup becomes `failed`, with the step it stopped at and the Retry setup
    button, a `channel.setup_failed` audit entry and a live update.

  A setup retried, a deletion asked for again or keys saved again after the job died queue a job
  under a singleton key the sweep can find (the number's id; the template's id and `:delete`; the
  account's id, `:` and the save time); while such a job waits or runs, the dead letter is left
  alone (`ops.dead_letter_work_live`, reading pg-boss's job table through a column the migration
  runner now grants the definer: the singleton key). The dead job's first queueing is not compared
  with the work's rows: pg-boss's time reaches the worker in milliseconds, the rows' times are in
  microseconds.

  The work and the dead letter's mark (`ops.settle_dead_letter`: settled time, and whether anything
  was left to end) are one transaction, so a settled dead letter always has its work ended; a sweep
  that dies in between leaves both for the next one.

- **A settled dead letter is not retried.** `ops.platform_retry_dead_letter` refuses it and the
  console says its work was ended for the company, which can start it again; a retried dead letter
  is not settled (its job is doing the work, and dead-letters again if it fails). The two marks
  exclude each other (a check). As the sweep runs every minute, the work of these three queues is
  in practice started again by the company, not from the console (ADR-108's retry stays for the
  other queues, such as `template.submit`).
- **The template sync no longer undoes a deletion in progress.** A template pending deletion that
  Meta still lists keeps `pending_deletion` while its last deletion event is the request itself,
  made in the last 8 hours (the 10 retries plus a margin). A deletion Meta refused (its
  `delete_failed` event) or an older one, whose job ended before this release, takes Meta's status
  as before, with a reason on the sync's status event saying the deletion did not go through.
- **Not changed:** `template.submit` (the sync marks an unconfirmed submission "submit failed" and the
  company submits it again, ADR-108), the receipt queues (the receipt retry), and the dead letters
  and alerts themselves (platform staff still see that Meta or Razorpay could not be reached).

Not built: settling the work of other queues that already signal it again, a company notice beyond
the state each page shows (no email), and automatic retries of number setup.

## ADR-112 Contact custom fields and contact changes through the public API (2026-10-02)

Context: a company describes its contacts with up to 50 custom fields (text, number, date or yes/no,
P3-01). Members set them on the contact page and in imports, automations and Flows save answers
into them, segments filter on them and templates fill variables from them. Integrations could do
none of this: the API's contact (ADR-052) had no custom fields, `POST /contacts` could not set them,
nothing changed a contact once it existed apart from adding tags and recording consent, and the
`contact.updated` webhook (ADR-074) fired for name, number, email and tag changes only, so a CRM kept
in step with HyFib missed every answer an automation or a Flow saved.

Decision:

- **Reading:** the API's contact gains `fields`, the values of the company's custom fields keyed by
  field key: text and dates as strings (dates `YYYY-MM-DD`), numbers as numbers, yes/no as booleans;
  a field without a value is left out. Only keys of fields the company has are read, so a value
  written for a field deleted at the same moment never shows. Every contact the API returns
  (`GET /contacts`, `GET /contacts/{id}`, a create or a change) and the contact in the contact
  webhooks (one shape since ADR-074) carry it; an erased contact's `fields` is empty.
- **The fields themselves:** `GET /api/v1/contact-fields` (`listContactFields`, `contacts.read`)
  lists the company's custom fields by label with key, label, type and creation time, at most 50
  and so in one page, for an integration to map its own fields. Members still add, rename and
  delete fields in the app.
- **Creating:** `POST /contacts` accepts `fields`. A new contact gets them; an existing one gets only
  the fields it has no value for, as it gets an empty name or email (a create never overwrites).
- **Changing:** `PATCH /api/v1/contacts/{id}` (`updateContact`, `contacts.write`) sets the name, the
  email and field values (null or an empty string clears one; fields left out keep theirs), and adds
  or removes tags, at least one of these and nothing else. Values must have their field's type: a
  string of at most 500 characters for text, a JSON number with at most 15 digits before the point
  and 6 after for a number (what members can type), a real date as a `YYYY-MM-DD` string for a date,
  true or false for yes/no; strings are not converted. An unknown key, a value of another type or a
  bad value is refused (422) naming `fields.<key>`, and nothing is saved. Emails are checked as
  members' are, and tags follow the app's rules (lower-cased, without commas, 50 at most per
  contact; a tag both added and removed is refused). The phone number is not changed through the
  API: a number from WhatsApp is the contact's identity, and members change typed numbers in the
  app.
  - In one transaction with the contact row locked, as a member's change: another company's or an
    erased contact is not found, a change that alters nothing saves nothing (no audit entry, no
    webhook event), and two requests for one contact apply in turn. Setting values is idempotent,
    so a retry needs no `Idempotency-Key`.
  - The fields named are locked (`FOR SHARE`) before the contact row, in the order a field's
    deletion takes them: a change waits for a deletion in progress, then refuses the deleted key, so
    no value outlives its field (a field added later with the same key would otherwise show it).
  - Audited as `contact.updated` by the key, naming what changed (name, email, field keys, the
    number of tags added and removed), never values.
- **Webhooks:** `contact.updated` also fires when a custom field's value changes, whoever changes it
  (members, imports, automations, Flows, the API), in the transaction that changes it and once per
  contact and transaction (ADR-074's rule), so a name and a field changed together send one event.
  The trigger compares the values of the company's field keys only: deleting a field removes its
  row before its values, so it sends nothing (the field is gone for every contact at once, and one
  company can have thousands), and renaming one changes no value.
- **Scope wording:** `contacts.write` is now "Create and change contacts and record consent". Keys
  that have it can change contacts from this release; only members who can change contacts grant
  it (ADR-052).
- **Migration 0090 (forward-only):** `app.webhook_capture_contact_fields()` and its trigger on
  `app.contacts` (after an update of `attributes` while the contact is not erased), not executable
  by PUBLIC.

Found while building: `POST /contacts` added up to 20 tags to an existing contact without the
50-tag limit members and automations keep, so repeated calls could pass it. It is now refused,
naming `tags`.

Not built: defining fields through the API, filtering the contact list by a field value (since
ADR-113), changing numbers through the API (typed numbers: built by ADR-180), changing many contacts
in one call, and an event that says which fields changed (the payload is the contact as it is when
delivered, as before).

## ADR-113 Finding contacts through the public API (2026-10-02)

Context: since ADR-112 integrations read and change contacts' custom fields, but `GET /contacts`
found contacts only by number. An integration matching its records by email, syncing the contacts
of a tag or looking contacts up by a field value (an order or customer number) had to page through
every contact the company has. Members find contacts by these in the app (search and segments).

Decision:

- **Filters on `GET /contacts`:** `email` (whatever its case, checked as members' emails are),
  `tag` (written as the app writes tags) and `fields[<key>]=<value>` (the OpenAPI `deepObject`
  style), at most 5 fields. A contact must match every filter given, with `phone`. A field's value
  is read with the field's type and compared as segments compare "equals": text whatever its case,
  numbers as numbers (`3` finds 3 and `3.0` finds it too), dates as `YYYY-MM-DD`, and `true` or
  `false` for yes/no. An unknown key, a value of another type, an empty value, or a bad email
  address or tag is refused (422) naming the parameter (`fields.<key>`, `email`, `tag`).
- **Windows, not scans:** a page filtered by tag or field reads at most 2,000 of the company's
  contacts, newest first, as the message feed does (ADR-088). When the filters leave out most
  contacts, a page holds fewer than `limit`, or none, and still gives `nextCursor`; pages never skip
  or repeat a contact, and both reads of a page see one snapshot. A number or email address alone
  reads no window: their indexes find the few contacts that match.
- **No migration and no new index:** tags already have an index by company and tag, and field
  values are compared in the rows a window reads; an index of values would serve one kind of
  comparison and grow with every value saved.
- **Scope:** `contacts.read`, which listing contacts already needs.

Not built: other comparisons (contains, greater or less than, not set; built by ADR-117 as
`POST /contacts/search`), several values for one filter, orders other than newest first, contacts
changed since a time, and searching by name.

## ADR-114 Following contact changes through the public API (2026-10-02)

Context: an integration that keeps its own copy of a company's contacts (a CRM, a warehouse) hears
of changes through the contact webhooks (ADR-074, ADR-112), but a receiver that was down past the
retries, an endpoint disabled after 72 hours of failures, or a new install has no way to catch up
short of listing every contact again. `updatedSince` filters (ADR-072, ADR-088) give a time to ask
from, but a change still being saved can carry an earlier time than one already read, so they ask
integrations to overlap and deduplicate, and a contact's `updated_at` does not move for a tag or a
consent state.

Decision:

- **Endpoint:** `GET /api/v1/contact-changes` (`listContactChanges`, scope `contacts.read`): every
  contact whose API description changed (added; name, number, email, custom field values or source
  changed; a tag added or removed; a consent state set or changed; erased), once, as it is now, in
  the order the changes were saved. Each item is `{ id, erased, contact }`, `contact` being the
  contact of `GET /contacts/{id}`, or null once erased. Pages hold up to `limit` (1 to 100, 50 by
  default) and say `hasMore`; `nextCursor` is always given, so an integration keeps it and asks
  again later. Without a cursor the feed starts from the first change, which lists every contact
  the company has.
- **A record per change, not a time:** migration 0091 adds `app.contact_changes`, one row per
  contact and transaction, written by triggers on contacts, tags and consent states in the
  transaction that makes the change, whoever makes it (members, imports, automations, Flows, keys,
  erasure, a field's deletion removing its values). The row holds the transaction's id
  (`pg_current_xact_id()`), not a time. Rows are only inserted and no other row is updated, so
  changes of one contact never wait for each other on a shared row. A row's key to its contact takes
  a key-share lock on the contact, which adding a tag or recording consent takes already and
  changing the contact exceeds; only removing a tag did not take it. The automation runner changed
  tags without the contact's lock, while members and keys (ADR-112) lock the contact before its
  tags, so a run and a member removing the same tag could have deadlocked, and adding the same tag
  at once already could. The runner now locks the contact for key share before it changes a tag, so
  one waits for the other instead (tested both ways). The migration records every existing contact
  once, after its triggers lock the three tables against writes until it commits, so no contact is
  added unseen in between.
- **Never past a change still being saved:** the feed reads only rows whose transaction id is
  below the reading snapshot's xmin: every transaction below it has finished, so what a page reads
  is final, and a change committed later always lies beyond the page's cursor, as the inbox's event
  stream already reads `tenant_events` (0003). A transaction still running anywhere holds the feed
  back until it ends; it never makes the feed skip. Each contact is read at its latest finished
  change only, so a contact changed again moves to the end, and a contact appears again only when it
  changed again.
- **Sealed cursors:** a position is a transaction id and a row id, which would show how busy the
  whole platform is (transaction ids are shared by every company). The cursor is sealed with the
  keyring (AES-256-GCM) and bound to the company, so it reveals nothing and another company's
  cursor, a changed one or one sealed with a key the platform no longer holds is refused (422, path
  `cursor`, saying to start again without one). Retiring an encryption key ends the cursors sealed
  with it, as it ends what else that key sealed.
- **Compaction:** only a contact's latest change is ever read, so earlier rows of a contact are
  dead weight. The worker's minute sweep calls `ops.compact_contact_changes`, which follows every
  company's changes in the same order and under the same xmin rule, from where it last stopped (one
  row in `ops.contact_change_compaction`), at most 5,000 a minute; each change deletes the earlier
  changes of its contact. A reader that had not passed a deleted change reads its contact at the
  change that replaced it, now or once that change is below the reader's xmin, so compaction never
  changes what the feed reads. One compaction runs at a time.
- **Kept and deleted:** rows hold no personal data (a contact id and a transaction id), so erasure
  leaves them (the erasure itself is the contact's last change); they are deleted with the company
  (ADR-055) and are not in the company export (the contacts are).

Not built: a field's rename or a field's creation reported as changes (neither changes a value; a
field's deletion does, and is recorded), which fields changed, changes of other records (members,
conversations: the message feed and webhooks cover those), filters on the feed, and a time to start
from.

## ADR-115 Defining contact fields through the public API (2026-10-02)

Context: since ADR-112 integrations read and set the values of a company's custom fields, but the
fields themselves (up to 50, each a key, a label and a type) could only be added and deleted by
owners and administrators in Settings. An integration that maps its own records' properties (a
CRM's custom properties, a store's customer attributes) onto HyFib's had to ask a member to add each
field by hand, with the same key, before it could write a value.

Decision:

- **Scope:** `contact_fields.manage` ("Define contact fields"), granted only by members holding
  `tenant.settings.manage`, who define fields in Settings (owners and administrators). It writes, so
  a suspended or restricted company refuses it, and a plan version that chose its scopes (ADR-092)
  leaves it out until a new version includes it. `GET /contact-fields` answers keys with either
  `contacts.read` or this scope.
- **Endpoints:** `POST /contact-fields` (`createContactField`) adds a field from a label (1 to 80
  characters), a type and, optionally, a key; without one the key is made from the label as Settings
  makes it. A key the company has is refused with 409 naming `key`; the 51st field with 422. An
  optional `Idempotency-Key` makes a retry answer with the field as first added. `PATCH
/contact-fields/{key}` (`updateContactField`) changes the label only; the same label changes
  nothing. `DELETE /contact-fields/{key}` (`deleteContactField`) deletes the field and every
  contact's value for it, as Settings does. Fields are named by key, which the API already uses for
  values; a key no field can have in the path is not found, as an id that is not a UUID is.
- **Key and type never change:** values are stored under the key and were checked against the type
  when written, so changing either would leave stored values meaning something else. An integration
  that needs another type adds a new field.
- **One set of rules:** members and keys go through the same functions
  (`contacts/field-definitions.ts`) in their own transaction; each caller checks who may and audits
  as itself. The 50-field limit was checked by counting and then inserting, so two additions at
  once could both pass at 49; additions of one company now take turns under a transaction-level
  advisory lock (as API keys and invitations do), and the count is taken under it. Renames, which
  Settings' service could make without a trace, are audited as `contact_field.renamed` with the key.
- **Deletion keeps ADR-112's lock order:** the field row is deleted first, then the values, so a
  contact change naming the field (which locks the field rows before the contact) waits for the
  deletion or the deletion for it, and its value is removed either way. The values' removal sends
  no webhook (ADR-112) and records each contact that had one as changed (ADR-114).
- **Migration 0092** widens the scope checks of API keys and plan versions to the new scope (11 at
  most). Existing keys keep their scopes.

Not built: changing a field's type, renaming fields in the app (Settings adds and deletes them;
the service could always rename, and now audits it), choices for a field (a list of allowed values),
field order, and events for field definitions.

## ADR-116 Following messages through the public API (2026-10-03)

Context: an integration that keeps its own copy of a company's conversations (a helpdesk, a CRM
timeline, a warehouse) reads messages through `GET /messages` (ADR-088) and hears of new ones and of
status changes through the webhooks (`message.received`, `message.status`). A receiver that was down
past the retries, an endpoint disabled after 72 hours of failures, or a new install can only catch
up with `since`, which ADR-088 asks to overlap and deduplicate, and the feed does not follow
statuses: a template sent yesterday and read this morning shows its new status only to a reader who
reads it again by id or by conversation ("statuses changed since a time", ADR-088's Not built).

Decision:

- **Endpoint:** `GET /api/v1/message-changes` (`listMessageChanges`, scope `conversations.read`):
  every message of the company's conversations whose API description changed (received or sent; its
  status, status time or error changed; its contact erased), once, as it is now, in the order the
  changes were saved. Each item is `{ id, erased, message }`, `message` being the message as
  `GET /messages` gives it (with `contactId` and `channelId`; one function builds both), or null once
  its contact is erased. Pages hold up to `limit` (1 to 100, 50 by default) and say `hasMore`;
  `nextCursor` is always given. Without a cursor the feed starts from the first change, which lists
  every message the company has. No new scope: `conversations.read` already reads every message of
  every conversation. It does not write, so suspended and restricted companies can still read.
- **One row per message, moved by each change:** migration 0093 adds `app.message_changes`, one row
  per message holding the id of the last transaction that changed it (`pg_current_xact_id()`),
  written by triggers on `app.messages` in the transaction that makes the change, whoever makes it
  (ingestion, the send worker and its recovery, campaigns, automations, keys, members, erasure).
  Contact changes (ADR-114) come from three tables and are only inserted, so that changes of one
  contact never wait for each other on a shared row. Every change of a message updates the
  message's own row, which the changing transaction then holds locked until it ends, so the trigger
  moves the message's row right after (an insert, or an update on conflict) without adding a wait,
  and a message has one row however often it changes: there is nothing to compact. Two changes in
  one transaction are one change; a write that leaves the columns as they were records nothing.
- **What counts:** a message inserted, or an update that changes its status, status time, error code,
  error title or content (only erasure changes content after a message is saved: it redacts it and
  cancels sends not yet made). The provider's message id, the pricing and the status rank change
  with a status or are not described, so they do not count.
- **Only the trigger writes:** the trigger function is SECURITY DEFINER, owned by the definer role
  (pinned `search_path`, not executable by PUBLIC); the runtime role may only read the rows, in its
  company, so no code can move a message to another place in the feed or record a transaction that
  did not change it.
- **Never past a change still being saved:** as for contact changes, the feed reads only rows whose
  transaction id is below the reading snapshot's xmin. A message whose latest change is still held
  back is read once that change can be, at its new place; a reader that reads before the change
  commits still reads it at its old place, as it was. A transaction still running anywhere holds the
  feed back until it ends; it never makes the feed skip.
- **Sealed cursors:** sealed as the contact feed's are (ADR-114), with the feed's name and the
  company as associated data (`api/change-cursors.ts`, shared by both feeds; the contact feed's
  cursors are unchanged), so a contact feed cursor, another company's, a changed one or one sealed
  with a key the platform no longer holds is refused (422, path `cursor`).
- **Erased contacts:** erasure redacts each message of the contact, so each comes once more, as
  `{ id, erased: true, message: null }`, telling an integration to delete its copy; nothing of the
  message is shown again.
- **Existing messages:** the migration records every existing message once, each company's in the
  order they were saved, while its triggers lock `app.messages` against writes until it commits.
  The keys, the foreign key and the feed's index are added after the rows, which builds each once:
  measured locally on 402,976 synthetic messages in a rolled-back transaction (as the superuser),
  recording them took 1.2 seconds and the keys and the index 1.2 seconds more; with the keys in place
  it took 19.6 seconds.
- **Kept and deleted:** rows hold no personal data (a message id and a transaction id); they are
  deleted with the company (ADR-055), before its messages (a status recorded while the deletion runs
  adds a row back, which goes with its message), and are not in the company export (the messages
  are).

Not built: filters (direction, number, conversation), a time to start from, which part of a message
changed (the item is the message as it is now), notes and conversation changes (the conversation
webhooks carry those), and media.

## ADR-117 Searching contacts with segment conditions through the public API (2026-10-03)

Context: since ADR-113 `GET /contacts` finds contacts by number, email, tag and custom field values
equal to a given value. An integration asking for the contacts with more than three orders, without
the tag `vip`, opted in to marketing, added after a date or whose city contains "pur" had to read
every contact and filter them itself (ADR-113's Not built: other comparisons). Members ask such
questions in segments (P3-04), which compare custom fields (set, not set, equals, not equals,
contains, greater or less than, before or after, yes or no) and contacts' tags, consent, creation
day, source and calling code, matching all of the conditions or any.

Decision:

- **Endpoint:** `POST /api/v1/contacts/search` (`searchContacts`, scope `contacts.read`), with a JSON
  body `{ match, conditions, limit, cursor }`: `match` is `all` (the default) or `any`, and
  `conditions` holds 1 to 20 conditions. It answers as `GET /contacts` does: the company's contacts
  newest first, `{ data, nextCursor }`, on exact keyset pages, erased contacts left out. POST
  because a list of conditions has no query string form that OpenAPI 3.1 can describe (`deepObject`
  does not nest); the search only reads (a read-only transaction, no `Idempotency-Key`, nothing
  audited) and counts as one request like any other.
- **Segments' conditions, compiled by segments' code:** `field` (a key, a comparison and a value),
  `tag` (`has`, `not_has`), `consent` (a purpose and `opted_in`, `opted_out` or `not_recorded`),
  `created` (before or after a day, in the company's time zone), `source` and `calling_code`, each
  turned into SQL by the function segments use, so a key and a segment with the same conditions find
  the same contacts (tested). Which comparison applies to which type of field, and which needs a
  value, are segments' rules too, kept in one shared function. Values are compared as segments
  compare them: text whatever its case (`contains` looks for the text as written, never as a
  pattern), numbers as numbers, dates as `YYYY-MM-DD`; `not_equals` also finds contacts without a
  value.
- **Not offered:** segments' `last_message` and `campaign` conditions. They read conversations and
  campaign outcomes, which `contacts.read` does not give (conversations need `conversations.read`;
  campaigns have no scope).
- **Strict refusals:** 422 naming the condition's part, like `conditions.1.key`: a key the company has
  no field for, a comparison its type does not take (the message lists those it takes), a value
  missing where a comparison needs one or given where it takes none, a value that is not a number
  (as members type numbers) for a number field or not a date that exists for a date field, a
  creation day that does not exist, or a bad tag. Text and date values are strings; a number may be a
  JSON number or a string of one.
- **Windows, not scans:** every page reads at most 2,000 of the company's contacts, newest first, as
  `GET /contacts` filtered by tag or field does (ADR-113, now one function for both): when the
  conditions leave out most contacts, a page holds fewer than `limit`, or none, and still gives
  `nextCursor`; pages never skip or repeat a contact, and both reads of a page see one snapshot. No
  migration and no index.
- **Also fixed: dates that do not exist in segments.** A segment's creation day and its date
  comparisons were checked only for the `YYYY-MM-DD` form, so 30 February passed: as a creation day
  it then failed the segment's preview, its page and a campaign's audience with a database error,
  and as a date comparison it was compared as text. Both now need a date that exists, and are
  refused with the problem named, for new segments and for saved ones alike.

Not built: the `last_message` and `campaign` conditions (since ADR-126), searching by name (a name
condition since ADR-143), groups of conditions (all of some and any of others), orders other than
newest first, counting the matches, and saved segments through the API.

## ADR-118 Custom headers on webhook endpoints (2026-10-03)

Context: receivers verify HyFib's deliveries with the `W360-Signature` HMAC (ADR-053), but many
accept only requests that carry a credential they issued: an `Authorization: Bearer …` or an API
key header (automation platforms' catch hooks, API gateways, a company's own services behind an
authenticating proxy). A company could not deliver to them without running a relay of its own
(P5-09's Remaining: custom headers).

Decision:

- **Up to 5 headers per endpoint**, given when an endpoint is added or changed: in Settings →
  Webhooks, and through the API as `headers: [{ name, value }]` on `POST /webhook-endpoints` and
  `PATCH /webhook-endpoints/{id}` (for the endpoints keys added, ADR-081). Values are never shown
  again, so a list given replaces all of the endpoint's headers (each is given again), `[]` removes
  them, and a change that leaves them out keeps them. Settings show "Headers sent: …" with the
  names; the API answers `headers: [{ name }]`.
- **Names and values:** a name is 1 to 60 letters, digits and `-`, starting with a letter or digit,
  and appears once whatever its case. A value is 1 to 1,000 printable ASCII characters, trimmed: no
  line breaks or tabs, so a value cannot add a header. Names HyFib sets or that describe the body
  or the connection are refused whatever their case: `Content-Type`, `Content-Encoding`,
  `User-Agent`, `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Keep-Alive`,
  `Upgrade`, `TE`, `Trailer`, `Expect`, `Accept-Encoding`, `Proxy-*` and HyFib's `W360-*`. These
  rules are stricter than the egress guard's, which still applies. Refusals name the header's part
  (`headers.0.name`).
- **Values are secrets:** names and values are sealed together with the keyring as one ciphertext,
  bound to the company and the endpoint (`webhook-headers:<company>:<endpoint>`); only the names are
  kept in clear, to be shown. Values are never logged, put in audit entries (`headers` lists the
  names when they are given), exported (the company data export carries the names), kept in an API
  key's idempotency record or sent to the browser after they are saved.
- **Sent with every delivery:** the claim opens an endpoint's headers once per batch and sends them
  with every attempt, retry, test event and replay, before HyFib's own headers; opening checks the
  names again, so none can replace the signature, the event's ids, the content type or the user
  agent. A change applies from the next attempt, even of a delivery already waiting, as a changed
  address does. Headers that do not open (a key the platform no longer holds, a ciphertext restored
  onto another endpoint) end the delivery without an attempt as `payload_failed`, logged with stage
  `headers` and nothing of them, as a secret that cannot be opened does; the company's other
  deliveries go on, and once the headers are given again a replay delivers it.
- **Migration 0094:** `header_names text[] NOT NULL DEFAULT '{}'` and `headers_ciphertext text` on
  `app.webhook_endpoints`, a check that both are empty or both set and that there are at most 5
  names, and update grants on both columns for the runtime role (it inserts them with its table
  grant). Existing endpoints have no headers; nothing is backfilled.

Not built: other authentication schemes (OAuth client credentials, built by ADR-173; mutual TLS),
headers computed per delivery (a signed token), headers per event type, values outside printable ASCII, and showing
a value again.

## ADR-119 Choosing the message statuses a webhook endpoint receives (2026-10-03)

Context: `message.status` is the busiest event (ADR-053). Every message a company sends is
accepted, sent, delivered and often read, so a receiver that acts only on failures (to retry from
its own system, or to alert a person) was sent four or five deliveries for each message and
discarded most of them: a campaign to 10,000 contacts meant about 40,000 deliveries, each retried
while the receiver was down. P5-09's Remaining listed filters beyond the event type.

Decision:

- **A list of statuses per endpoint,** for `message.status` only. None (null) receives every
  status, as before, including statuses added later. A list holds 1 to 8 of `accepted`, `sent`,
  `delivered`, `read`, `played`, `failed`, `canceled` and `unknown_outcome`, the statuses the
  message trigger captures (0025), kept in the order a message reaches them with repeats merged.
  It is chosen in Settings → Webhooks under "Message status" (every status ticked to begin with;
  saving all of them ticked keeps none, so later statuses arrive too) and shown on the endpoint as
  "Message statuses sent: …", and through the API as `messageStatuses` on `POST /webhook-endpoints`
  and `PATCH /webhook-endpoints/{id}` and in every endpoint the API answers.
- **Only with the event:** statuses given for an endpoint that does not receive `message.status`
  are refused (`messageStatuses`; 422 through the API). A change that removes the event clears
  them, and a `PATCH` that leaves them out keeps them; Settings always sends them. A check in the
  database holds the same rule.
- **Applied when the event is captured:** `app.capture_webhook_event` creates a `message.status`
  delivery only for the endpoints with no list or whose list holds the status, and writes no event
  when no active endpoint takes it, as it already did for an event type nobody receives. A status
  nobody takes costs no row, delivery or attempt. A change applies to statuses captured after it;
  deliveries already created are still sent. Replays and test events do not pass through the
  capture and are unchanged.
- **Audited:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry `messageStatuses`
  when the endpoint has a list, and the company data export carries the column.
- **Migration 0095:** `message_statuses text[]` on `app.webhook_endpoints` with a check (null, or 1
  to 8 known statuses while `message.status` is among the events), an update grant on the column
  for the runtime role (it inserts it with its table grant), and `app.capture_webhook_event`
  replaced with the same signature, so its owner and grants stay. Existing endpoints keep null;
  nothing is backfilled.

Not built: filters for other event types (conversation statuses (built by ADR-149), automations
(built by ADR-145), campaigns (built by ADR-146)), filters on a message's fields (its template; its number, built by ADR-170, and its sender, built by ADR-172), and retry settings per
status.

## ADR-120 Changing many conversations in one call through the public API (2026-10-03)

Context: since ADR-093 a key with `conversations.write` changes one conversation per request
(`PATCH /conversations/{id}` with `status`, `assigneeId` or `teamId`). A helpdesk that hands a
departing agent's 80 conversations to someone else, or closes a batch after an outage, made 80
requests, each counted against its rate and monthly limits (ADR-068, ADR-097), and a failure halfway
left half of them changed. P5-08's Remaining listed assigning many conversations at once.

Decision:

- **`POST /conversations/update-many`** takes `conversationIds` (1 to 100, each once) and any of
  `status`, `assigneeId` and `teamId`, at least one, each meaning what it means for `PATCH`. It needs
  `conversations.write` and answers 200 with the conversations as they now are, in the order given.
- **All of them or none, in one transaction, locking in the order the other writers do.** The member
  (share) is checked and locked first, as a suspension locks the member before releasing its
  conversations; then every conversation's row in id order (`FOR UPDATE`), so calls that change the
  same conversations take turns instead of deadlocking, whatever order each lists them in; and the
  team (key share) only as a conversation moves into it, as a team's deletion releases its
  conversations before deleting the team. A call that meets a suspension or a deletion waits for
  it and is then refused instead of deadlocking. (A team's deletion releases the team's
  conversations in no set order, so a call naming two or more of them can still meet it in a
  deadlock; PostgreSQL then fails one of the two, and a failed call answers 409 `conflict`, which
  says to retry.) An id that names none of the company's
  conversations (another company's, or an erased contact's, included) refuses the call with 422
  naming its place in the list (`conversationIds.3`), as a member who cannot answer conversations
  or another company's team refuses it (`assigneeId`, `teamId`); nothing is changed.
- **Each conversation is changed exactly as `PATCH` changes one,** by the same function: the team,
  then the member, then the status; an automation answering it stops when it is assigned or
  resolved; it is routed after a move into a team when it has no member and is open; an audit entry
  per change names the key, all with the request's correlation id; the inbox and the webhooks see
  each change as they see a single one. The conversations are changed in the order given, which a
  round-robin team follows when it gives them out. What a conversation already has changes nothing,
  so a repeated call is harmless without an `Idempotency-Key`.
- **A call counts as one request** against the rate and monthly limits; at most 100 conversations
  keep the transaction and its locks short.

Not built: choosing conversations by a filter (all of a member's, all of a team's), changes that
partly succeed, notes for many conversations, and the inbox doing the same for members.

## ADR-121 Saying what changed in `contact.updated` (2026-10-03)

Context: `contact.updated` (ADR-074, ADR-112) is captured once per contact and transaction and sent
with the contact as it is when delivered. A receiver could not tell a new email from a new tag
without keeping a copy to compare, so one that acts only on a changed email (to update a mailing
list) or a changed tag (to start a flow in its own system) had to store every contact or fetch it
again. P5-09's Remaining listed which custom fields changed.

Decision:

- **`changes` on `contact.updated`:** the parts of the contact its change changed, in the API
  contact's names: `name`, `phone`, `email`, `tags` (a tag added or removed) and `fields.<key>` for
  each custom field whose value changed, sorted, once each. Names only: values stay out of events
  (ADR-053), and the contact carries them as they are when delivered. Null for an event captured
  before HyFib recorded what changed (migration 0096), which a replay within the 30 days kept can
  send. `contact.created` and `contact.erased` carry no `changes`.
- **One event naming everything the transaction changed:** still one event per contact and
  transaction. A key's `PATCH` or an import changes the name, email and field values in one
  statement and the tags in others: the first capture writes the event and each later one adds what
  it changed. A savepoint that rolls back takes back what it added. A change undone in the same
  transaction (a name changed and changed back) still captures the event, as before, and is named.
- **The same triggers say what changed:** 0047's trigger compares the old and new name, number and
  email; the tag trigger names `tags`; 0090's names each of the company's fields whose value differs.
  A field's rename or deletion still sends nothing, and an erasure still sends only
  `contact.erased`.
- **Events stay history:** a later change adds to the event through
  `app.add_contact_webhook_changes`, a definer function that updates only an event the calling
  transaction captured (its `captured_xact`), which no delivery can have read yet. The runtime role
  still only inserts and reads events; the definer role gains the update of this one column, which
  erasure (running as it) needs when it removes several tags before marking the contact. The
  capture function now takes what changed, and refuses `contact.updated` without it and the other
  types with it.
- **Migration 0096:** `contact_changes text[]` on `app.webhook_events` with a check (null, or a
  non-empty list of the parts above, on `contact.updated` only), added NOT VALID and validated by
  0097, which does not hold the lock every capture needs; `app.capture_contact_webhook_event`
  replaced by a version that takes what changed (the old one dropped: only triggers called it); the
  three trigger functions replaced with the same signatures, so their triggers and grants stay.
  Existing events keep null.

Not built: what changed in `GET /contact-changes` (an item there stands for every change since the
reader's cursor and compaction merges a contact's changes, ADR-114, so it could name only parts a
reader may already have read; a reader keeping a copy compares), which tags were added or removed
(built by ADR-182), the values before a change (personal data stays out of events), consent and
source (consent has its own event; the source is not part of `contact.updated`), and endpoints
taking `contact.updated` only for chosen parts.

## ADR-122 Changing many contacts in one call through the public API (2026-10-03)

Context: since ADR-112 a key with `contacts.write` changes one contact per request
(`PATCH /contacts/{id}`: the name, email, custom field values and tags). An integration that tags
everyone who joined a webinar, or copies a field from its CRM to a few hundred contacts, made one
request for each, counted against its rate and monthly limits (ADR-068, ADR-097), and a failure
halfway left half of them changed. P5-08's Remaining listed changing many contacts in one call.

Decision:

- **Endpoint:** `POST /api/v1/contacts/update-many` (`updateManyContacts`, scope `contacts.write`)
  takes `contacts`, 1 to 100 items, each with its `id` (each contact once) and what
  `PATCH /contacts/{id}` takes (`name`, `email`, `fields`, `addTags`, `removeTags`, at least one).
  It counts as one request against the rate and monthly limits, within the 64 KB a body may hold,
  and answers the contacts as they now are, in the order given. No `Idempotency-Key`: what a
  contact already has changes nothing, so a repeat changes nothing more.
- **All of them or none, in one transaction:** a contact of another company or an erased one, a
  value of another type, an unknown field, a bad email, a tag both added and removed or a 51st tag
  refuses the call with 422 naming its place (`contacts.3.fields.plan`, `contacts.5.id`), and
  nothing is changed.
- **Each contact changed as `PATCH` changes one,** by the same function (`changeLockedContact`), in
  the order given: only what differs is written, audited as `contact.updated` by the key (one entry
  per changed contact, with the call's correlation id) and captured for webhooks as one
  `contact.updated` per contact, which names what changed (ADR-121).
- **Locks:** every field any change names is locked first, in one statement, as a field's deletion
  takes them, so a call waits for a deletion without holding a contact and then refuses the deleted
  key; then the contacts, `FOR UPDATE` in id order, so two calls naming the same contacts take
  turns. A CSV import changes its contacts in one transaction in the file's order, so a call and an
  import changing the same two contacts at the same moment can deadlock; PostgreSQL then ends one of
  them, which the API answers with 409 `conflict` (retryable), as for any deadlock.

Not built: choosing contacts to change by a filter (all with a tag, a segment), changes that partly
succeed, adding contacts in the same call, changing numbers (typed numbers: built by ADR-188), and
the same change for many contacts in the inbox (members change contacts one at a time, or by
import).

## ADR-123 Choosing the contact changes a webhook endpoint receives (2026-10-03)

Context: since ADR-121 a `contact.updated` names what its change changed (`name`, `phone`, `email`,
`tags`, `fields.<key>`). An endpoint that takes the event still receives every change: a receiver
that only copies emails to a mailing tool is sent every tag an automation or an import adds, and
must read and drop each. ADR-119 lets an endpoint take only some message statuses; P5-09's
Remaining listed `contact.updated` only for chosen parts.

Decision:

- **What an endpoint chooses:** `contactParts`, null for every change (as before), or 1 to 5 of
  `name`, `phone`, `email`, `tags` and `fields` (a change of any custom field), only while the
  endpoint takes `contact.updated`. Chosen in Settings → Webhooks under "Contact changed" (all
  ticked keeps none, so parts added later arrive too) or through the API (`contactParts` on
  `POST` and `PATCH /webhook-endpoints`). A change that removes the event clears the list; an API
  change that leaves it out keeps it. Audited with the list; the company data export carries it.
- **Where it applies:** where the event is captured. The first capture of a contact's
  `contact.updated` in a transaction creates a delivery for each endpoint whose list is null or
  holds a part the change names; each later change of the contact in the transaction, which adds
  what it changed to the event (ADR-121), creates one for each endpoint that now takes it and has
  none of this event yet (the event is the transaction's own, so no replay of it can exist). A
  savepoint that rolls back takes back the deliveries it created with the parts it added. The
  event is still written when an endpoint takes `contact.created` or `contact.updated`, even if
  none takes the parts of the first change, and every endpoint that receives it is sent the same
  event, naming every part that changed: an endpoint taking emails is told when one transaction
  changed the email and the tags.
- **Unchanged:** `contact.created` and `contact.erased`, the other event types, replays, test
  events and the payload.
- **Migration 0098:** `contact_parts text[]` on `app.webhook_endpoints` with a check (null, or 1 to
  5 known parts while `contact.updated` is among the events) validated at once (at most 10
  endpoints per company), the runtime role's update of the column, and
  `app.capture_contact_webhook_event` replaced with the same signature.

Not built: field keys chosen one by one (built by ADR-184), filters for `contact.created` (by where
the contact came from: built by ADR-190) or `contact.erased`, and filters on a contact's values (a
tag, a field's value).

## ADR-124 Finding contacts by name through the public API (2026-10-03)

Context: `GET /contacts` finds contacts by number, email address, tag and custom field values
(ADR-113), and `POST /contacts/search` with segments' conditions (ADR-117), but neither finds them
by name: both list it as not built. An integration that knows a person only by name (a support tool
looking up "Asha Rao", a CRM matching a contact before it has the number) had to read every contact
the company has. Members find contacts by typing part of a name in Contacts' search.

Decision:

- **A `name` filter on `GET /contacts`:** contacts whose name contains the given text, compared as
  members' search compares names (the same `ilike`): letters whatever their case, the text as
  written (`%` and `_` are characters, not patterns), without the spaces at its ends (names are
  saved without them). 1 to 200 characters, the longest name a contact holds; an empty value is
  refused with 422 naming `name`, and so is a longer one. It combines with the other filters (a
  contact must match all of them); contacts without a name never match, and erased contacts are
  left out as always. Members' search also reads digits as a number and matches emails; the filter
  reads names only (`phone` and `email` find those exactly).
- **Letters' case as the database's locale folds it:** `ilike` lowers letters by the database's
  `LC_CTYPE`. With a UTF-8 locale such as `en_US.UTF-8` (the test and CI databases) accented
  letters fold too (`ÉLODIE` finds `Élodie`); with the `C` locale only ASCII letters do. Letters
  whose other case is longer (`ß` and `SS`) do not match each other, and accents count (`Elodie`
  does not find `Élodie`). DEPLOYMENT asks for a UTF-8 locale when the database is created.
- **Windows, not scans:** a page filtered by name reads at most 2,000 of the company's contacts,
  newest first, as one filtered by tag or field does (ADR-113): no index serves "contains" (one
  would need the `pg_trgm` extension, a decision of its own), so the filter alone would otherwise
  read every contact a company has for one short page. Pages can be short or empty and still give
  `nextCursor`; they never skip or repeat a contact.
- **No migration and no index;** scope `contacts.read`, as listing contacts needs.
- **Also fixed: text holding the NUL character.** PostgreSQL text cannot hold U+0000, and a request
  with it in a query parameter or a JSON string reached the database and failed there as an
  internal error (500, logged as a failure) in any endpoint, from a contact's name to a reply's text
  or a field filter. The API now refuses such a request with 422 `validation_failed` naming where
  the character is (the parameter as sent, or the body's path such as `contacts.1.name`) before
  anything reads it. The body is walked without recursion, so no nesting a 64 KB body allows can
  exhaust the stack. Other control characters are kept, as before.

Not built: a name condition in `POST /contacts/search` (its conditions are segments' conditions,
which have no name; adding one changes segments too), matching names whatever their accents or
Unicode form (a name saved with combining accents is found only by text written the same way), fuzzy
or phonetic matching, finding contacts by part of an email, an index for names, and the same check
in members' forms and searches and in provider payloads, which still fail as before when they hold
the character (since ADR-129 without the text in logs or a receipt's last error; settled by ADR-130,
which refuses members' input and keeps providers' text with U+FFFD in place of the character).

## ADR-125 Reading campaigns and their results through the public API (2026-10-03)

Context: companies send marketing campaigns to their contacts (P3-04), and an endpoint that takes
`campaign.status_changed` (ADR-087) learns when one is approved, starts, pauses or completes, with
its stored counters (the audience, the recipients queued and skipped). But how its messages did
(delivered, read, failed, replies, opt-outs) is on members' campaign page only: the public API does
not read campaigns (ADR-087 lists it as not built). A marketing tool or a reporting job that shows
a campaign's results had a member copy them from the page or export recipients by hand.

Decision:

- **A new scope, `campaigns.read`** ("Read campaigns", reading only), which a member creating a key
  grants only if they hold `campaigns.read` themselves, as every scope needs its permission
  (ADR-052). Existing keys keep their scopes, so they gain nothing; a plan version that chose its
  scopes (ADR-092) leaves it out until a new version includes it, and one with every scope (`NULL`)
  includes it. As a reading scope it works while the company is suspended or restricted, as
  members' campaign pages do.
- **`GET /api/v1/campaigns`** (`listCampaigns`): the company's campaigns, newest first by creation,
  on exact keyset pages (creation time to the microsecond, then id; neither changes), so paging
  never skips or repeats one; `status` keeps one status (`draft` to `canceled`); `limit` up to 100,
  50 by default. A page reads the campaigns' index (`campaigns_list_idx`) in its order; companies
  make campaigns by hand, so they have few. Each campaign: id, name, status, why it paused or
  completed, the template's id and name, the number it sends from (id and number as WhatsApp
  displays it), when it was scheduled, started, completed or cancelled and created, and the
  counters it stores, as the campaign event carries them (ADR-087).
- **`GET /api/v1/campaigns/{id}`** (`getCampaign`): one campaign with `results` counted when read,
  as members' campaign page counts them (`campaignAnalytics`): recipients by state (audience,
  pending, skipped, canceled, queued), queued messages by outcome (in progress, sent, delivered,
  read, failed, unknown and canceled; sent includes delivered and read, delivered includes read),
  replies and opt-outs among delivered recipients, each counted once, for the last campaign message
  (whichever campaign sent it) queued to the contact in the 72 hours before it (a reply on the same
  number; a STOP is both), skipped recipients by reason and failed messages by WhatsApp's error
  code (the 10 commonest). The row and the counts are read in
  one read-only snapshot (repeatable read), so they agree. A draft has no recipients: `results` is
  null. An id that is not a UUID, unknown or another company's answers 404 `not_found`.
- **Counts only:** no recipients, contacts or messages (since ADR-127 a key that also reads contacts
  lists the recipients; members' CSV export stays in the app; a campaign's messages reach
  integrations through the message feeds and `message.status` with `conversations.read` and
  webhooks), no members (who created, submitted, approved, launched or cancelled it, and the review
  note), no costs (the estimate members see and the spending cap: estimates from published rate
  cards, not what Meta bills, which a key that reads campaigns does not need), and not the
  audience's definition, the template's variables or the pacing (time zone, window, rate, caps).
- **The cost of a read:** the list reads stored columns. The detail counts every recipient of the
  campaign and its message once per request, as the page does on each view: a campaign of 50,000
  recipients (the most one has, `MAX_AUDIENCE`) is one pass over its recipients through their
  campaign index. Rate limits (ADR-068) and monthly requests (ADR-061) bound how often a key repeats
  it.
- **Migration 0099** replaces the key and plan scope checks with the 12 scopes and validates them
  at once, as 0092 did (one row per key and per plan version).

Not built: changing campaigns through the API (creating, submitting, approving, pausing, resuming or
cancelling them; pausing and cancelling since ADR-128, creating and editing drafts since ADR-186),
each recipient's outcome (since ADR-127), costs, filters by template, number or time, results for a
time range or grouped by day, and campaign results in `campaign.status_changed` (ADR-087 left them
out: they change with every message status; built by ADR-150, counted when each event is delivered).

## ADR-126 Conversation and campaign conditions in contact searches through the public API (2026-10-03)

Context: `POST /contacts/search` finds contacts with segments' conditions (ADR-117), less the two
that read conversations and campaigns: `last_message` (the contact wrote, or did not, in the last
days) and `campaign` (what happened to a campaign's message to the contact). ADR-117 left them out
because `contacts.read` gives neither, conversations need `conversations.read` and campaigns had no
scope. ADR-125 added `campaigns.read`. Integrations ask for both: a marketing tool following up
with the recipients who read a campaign but did not reply, a support tool listing the customers who
wrote this week.

Decision:

- **Both conditions, as segments have them:** `last_message` with `within_days` (contacts who wrote
  in the last 1 to 365 days, in any of their conversations) or `not_within_days` (the others,
  contacts who never wrote included); `campaign` with one of the company's campaigns and an outcome
  among the recipients it was sent to: `delivered` (read included), `not_delivered` (failed or not
  delivered yet), `read`, `replied` (a reply was counted for the campaign's message: the last
  campaign message the contact was sent in the 72 hours before replying, once WhatsApp had accepted
  it; the results of ADR-125 count it once the message is delivered) or `not_replied` (delivered,
  without a reply). Recipients the campaign skipped or cancelled match no outcome. The conditions
  are checked by segments' rules and turned into SQL by segments' own function, so a key and a
  segment with the same conditions find the same contacts. `days` is a JSON number.
- **Each also needs the scope that reads what it reads:** a search with a `last_message` condition
  needs `conversations.read`, and one with a `campaign` condition `campaigns.read`, as well as
  `contacts.read`; without it the search is refused with 403 before anything is read, naming the
  scope (and with `not_in_plan` when the plan leaves the scope out, ADR-092). Members see a
  campaign's recipients with `campaigns.read` and `contacts.read` together, the same pair.
- **A campaign the company does not have** (unknown, or another company's) is refused with 422
  naming the condition's `campaignId`, as segments refuse it; a draft has no recipients and finds
  nobody.
- **The same pages:** each page still reads at most 2,000 of the company's contacts (ADR-113); the
  two conditions are checked for those contacts only, through the conversations' and the campaign
  recipients' indexes.
- **No migration;** the OpenAPI document lists the two condition shapes.

Not built: groups of conditions, a name condition (in segments and searches since ADR-143),
conditions on a conversation's status, member or team, on a campaign's message other than these outcomes (clicked
buttons, opt-outs), and on automation runs.

## ADR-127 A campaign's recipients through the public API (2026-10-03)

Context: since ADR-125 a key with `campaigns.read` reads a campaign's results: how many recipients
were skipped and why, how many messages were delivered, read or failed, how many replied. Which
contacts those were is on members' recipients page only (with `campaigns.read` and
`contacts.read`), or in its CSV export (with `contacts.export`). ADR-126 finds contacts by five
outcomes, a page of contacts at a time, without the message's status, when it was reached or why it
failed. An integration that marks in its CRM which customers got an offer, reaches the ones whose
message failed some other way, or reconciles a campaign with its own records had a member export the
CSV by hand.

Decision:

- **`GET /api/v1/campaigns/{id}/recipients`** (`listCampaignRecipients`) lists the campaign's
  recipients, each with what happened to it: the contact (id, name and number), the recipient's
  state (`pending`, `queued`, `skipped` with the reason, or `canceled`: the campaign was cancelled
  before its turn or before its queued message was sent), the message queued for it (id, status as
  the API's messages name it, when it reached that status, and why it failed or was not sent:
  WhatsApp's error, or HyFib's reason such as `campaign_canceled`), when it was queued, and when a
  reply and an opt-out were counted for it (ADR-125's attribution). The message id is the one the
  message feeds (with `conversations.read`) and `message.status` webhooks give; `GET /messages/{id}`
  reads messages sent through the API only. The contact's email, tags, fields and consent are read
  with `GET /contacts/{id}`.
- **It needs `campaigns.read` and `contacts.read`**, the pair members need for the recipients page:
  the list names contacts. Without either the request is refused with 403 before anything is read,
  naming the scope (`not_in_plan` when the plan leaves it out, ADR-092). No new scope; the
  description of `campaigns.read` in Settings → API keys says a key that also reads contacts lists
  recipients (and names no other scope's label, so each checkbox keeps its own accessible name,
  which a unit test checks).
- **`outcome` lists the recipients one count of `results` counts** (ADR-125): `pending`, `skipped`,
  `canceled`, `queued`, `in_progress`, `sent`, `delivered`, `read`, `failed`, `unknown`,
  `message_canceled`, `replied` or `opted_out`. Each is the very condition the count uses: one
  definition (`RECIPIENT_OUTCOME_SQL`, `campaigns/outcomes.ts`) serves `campaignAnalytics` and the
  list, so an outcome lists as many recipients as its count, less those whose contact was erased,
  when nothing changes in between. Replies and opt-outs count among delivered messages only: a STOP
  sent before the message is reported delivered has its time on the recipient but is in neither
  list. Members' recipients page filters differently: its Failed includes unknown outcomes, and its
  Replied shows a reply whatever its message's status. The API follows the counts.
- **Recipients whose contact was erased are left out**, as the API leaves erased contacts out
  everywhere; `results` still counts them, as members' campaign page does.
- **Pages in a fixed order:** recipients are listed by their id (a campaign's recipients are taken
  once, when it is submitted, and none are added later), on keyset pages: `cursor` is the last
  recipient's id, `limit` up to 100, 50 by default, so paging never skips or repeats a recipient.
  Each page is read when it is asked for: while the campaign runs, a recipient can change outcome
  between pages, and paging one outcome can miss a recipient that reaches it behind the cursor. A
  campaign sent back to draft (withdrawn or rejected) loses its recipients and lists none.
- **Refusals:** an id that is not a UUID, unknown or another company's answers 404 `not_found`, as
  `GET /campaigns/{id}`; a draft has no recipients and lists none. A cursor that is not a recipient
  id, an unknown outcome and unknown parameters are refused with 422, naming them.
- **The cost of a page:** a campaign has at most 50,000 recipients (`MAX_AUDIENCE`). A page joins
  each recipient to its contact and message by their keys and stops when it is full; an outcome few
  recipients have reads the campaign's queued recipients until the page is full, all of them for an
  outcome none has. Measured on the local PostgreSQL 18 with a campaign of 50,000 recipients (a
  throwaway test, not kept): a page of 100 took 4 to 6 ms (median of 7) for every recipient, one
  state or a common outcome, and 15 to 25 ms for outcomes few have (10 failed, none unknown, 500
  read). The test database held little else, so the planner read the messages table directly for
  rare outcomes; next to a large messages table it was not measured. Rate limits (ADR-068) and
  monthly requests (ADR-061) bound how often a key repeats a page.
- **No costs and no members:** the market and estimated cost of each recipient stay in members'
  CSV export, as ADR-125 left costs out.
- **No migration.** The OpenAPI document lists the path, its `outcome` values and
  `CampaignRecipient`.

Not built: recipients through webhooks, filters by contact, number or time, the conversation of the
message, costs per recipient, members' groupings of failed and replied recipients, and changing
campaigns through the API (pausing and cancelling since ADR-128).

## ADR-128 Pausing and cancelling campaigns through the public API (2026-10-03)

Context: since ADR-125 and ADR-127 a key reads campaigns, their results and their recipients, but
only members stop one. An integration that sees a product sell out, a price change or complaints
arriving while a campaign sends had a member pause or cancel it by hand.

Decision:

- **A new writing scope, `campaigns.stop`** ("Pause and cancel campaigns"), granted only by members
  holding `campaigns.send` (owners, administrators and marketers by default), the permission members
  pause and cancel campaigns with. Existing keys gain nothing; a plan version that chose its scopes
  (ADR-092) leaves it out until a new version includes it, and one with every scope (`NULL`)
  includes it. As a writing scope it is refused while the company is suspended or restricted (423,
  ADR-052), as members' pausing and cancelling are (`campaigns.send` is not kept then), and nothing
  is sent in those states anyway.
- **Stopping only:** `POST /campaigns/{id}/pause` and `POST /campaigns/{id}/cancel`, without a body.
  Resuming, approving, scheduling and editing stay with members: a resumed campaign sends under the
  authority of the member who resumed it (`launched_by_user_id`, which the runner checks before each
  batch), and a key is not a member.
- **Pause:** a scheduled or running campaign pauses as members pause it, in one transaction with the
  campaign row locked, as each runner tick locks it (a tick that finds it locked tries again
  shortly): sends no worker has claimed are cancelled (`campaign_paused`) and their recipients wait
  again (a send a worker already claimed cannot be recalled and ends as it ends), and the campaign
  is paused with a new reason, `api`, so members ("Paused through the API."), the API and
  `campaign.status_changed` tell it from a member's pause (`manual`). Members resume it as any
  paused campaign. A paused campaign answers as it is, whatever paused it, so a retry changes
  nothing; a draft, one waiting for approval, a completed or a cancelled one is refused with 409
  `conflict`, the message naming its status as `status` gives it.
- **Cancel:** a campaign waiting for approval, scheduled, running or paused is cancelled as members
  cancel it: waiting recipients and sends no worker has claimed are cancelled, their messages with
  `campaign_canceled` (ADR-127 lists both). A cancelled or completed campaign answers as it is; a
  draft is refused with 409: it sends nothing until a member submits it, and members edit drafts, or
  cancel them, in the app. A cancelled campaign is never resumed.
- **One implementation:** members' pause and cancel and the API's call the same functions once the
  campaign row is locked (`pauseLockedCampaign` and `cancelLockedCampaign`, `campaigns/service.ts`);
  each caller checks the statuses it allows and writes its own audit row.
- **The answer** is the campaign as `GET /campaigns/{id}` describes it, without `results`, so a
  client sees the status it reached.
- **`pauseReason` only while paused:** the answer, `GET /campaigns` and `GET /campaigns/{id}` give
  `pauseReason` for a paused campaign only, as the field's description and `campaign.status_changed`
  (ADR-087) always said. Found while testing: a campaign cancelled while paused answered its last
  pause reason, since the API returned the column as stored (ADR-125).
- **Who did it:** the campaign's event names no member and carries the key's id in its detail
  (`apiKeyId`), as events name members by id; members' campaign history names the key ("through the
  API, key “name”", or "through the API" if the key's row is gone), and `canceled_by_user_id` stays
  null. The audit row's actor is the key (`api_key`, ADR-052), with the request's id and `source`
  `api`; `campaign.status_changed` fires from the status trigger as for members (ADR-087), with
  `pauseReason` `api` for a pause.
- **No idempotency key:** both calls change a campaign's state and answer the state it is in, so
  repeating one changes nothing.
- **Migration 0100** replaces the key and plan scope checks with the 13 scopes (as 0099 did) and the
  campaigns' pause reason check with `api` added; existing rows already satisfy them.

Not built: resuming (built by ADR-176 for the campaigns keys paused), approving, scheduling,
creating or editing campaigns through the API (drafts: built by ADR-186), cancelling drafts (built
by ADR-187), stopping many campaigns in one call, a reason or note given with the call, and
`campaign.status_changed` naming who cancelled a campaign.

## ADR-129 Database errors without the data they quote (SEC-11) (2026-10-03)

Context: an error the app does not map (anything but its functions' W34xx codes, unique violations,
permission failures and serialization failures) left `db.run` as the driver raised it. Drizzle's
error repeats the failed query with its parameters ("Failed query: … params: …"), and PostgreSQL's
error, its cause, can repeat values in its message (`invalid input syntax for type uuid: "…"`), its
detail (`Key (…)=(…) already exists.`, `Failing row contains (…)`), hint, context and internal
query. The logger's default error serializer writes all of it, causes included, so the API's and
server actions' error logs, the worker's job log and the webhook routes logged contacts' names,
numbers, emails and message text whenever such a query failed; Next.js printed the same error for a
failing page, pg-boss kept it in a failed job's output, and a webhook receipt kept its message as
`last_error`, which the operations console shows platform staff. Mapped errors kept the driver's
error as their cause, which the job log printed too. ADR-124 found it (SEC-11): members' contact
search with a NUL character failed in the database, and the error's message quoted the search text.

Decision:

- **At the source.** `db.run` and the platform database's `run` replace a database driver's error
  with a `DatabaseQueryError` (`@w360/core`) that quotes no data. Its message is PostgreSQL's own
  when that SQLSTATE's messages name only objects or are our functions' sentences ("new row for
  relation "contacts" violates check constraint "contacts_email_check"", "permission denied for
  table api_keys"), so a log still says which guard refused. Data exceptions (SQLSTATE class 22:
  "invalid input syntax for type uuid: "…"", "value "…" is out of range") quote the value that
  failed and syntax errors (42601) the SQL text, so for those, and for any message longer than one
  line of 300 characters, the message only names what is known ("Database query failed (SQLSTATE
  22P02)", with the constraint, table and column when PostgreSQL gives them, or the class of the
  error that stopped the query before it reached the database). Its properties are the SQLSTATE
  (`code`), severity, schema, table, column, data type, constraint and routine, each kept only if it
  reads as a code or a name. Its stack keeps the frames of the driver's error (where the query was
  awaited) under its own first line: that error's first line, which repeats the message, is removed
  exactly as V8 wrote it, so a parameter that looks like a frame stays out, and a stack that does
  not start that way gives no frames. The query, its parameters, PostgreSQL's detail (where unique
  and check violations repeat the key or the whole row), hint, context and internal query, and the
  driver's error itself, are dropped. An error that wraps a driver error (an `AppError`, or another
  error given it as its cause) keeps its own message and class, with the `DatabaseQueryError` as its
  cause instead.
- **Our functions' messages quote no personal data**, as every `RAISE` in the migrations does today
  (fixed sentences; the few with values name a table, a ledger account, a ledger transaction and its
  amounts, or an event type): a value a function wants to report belongs in `DETAIL`, which is
  dropped. One check raises 22023 and so loses its sentence (`queue waits must be an array`).
- **Mapping is unchanged.** W34xx codes, 23505, 42501, 40001 and 40P01 become the same `AppError`s,
  with the `DatabaseQueryError` as their cause; the functions' W34xx messages stay the public message
  (fixed sentences written to be shown, without personal data), and `isUniqueViolation` still reads
  the SQLSTATE and the constraint.
- **Recognised by shape, not by class:** PostgreSQL's error (a `severity` and a five-character
  SQLSTATE `code`) and drizzle's failed query (a `query` text and a `params` list), at any depth of
  the causes, so a second copy of either library, an error wrapping one, or the plain object pg-boss
  copies one into is still recognised; a `DatabaseQueryError` (a brand, as `AppError` has) is not.
- **And in the logger.** Every logger made by `createLogger` writes `err` through `serializeError`,
  which does the same without changing the error it logs, so a driver error that never passed
  through `db.run` (pg-boss's own queries, a driver error kept as another error's cause, or among an
  `AggregateError`'s errors) is logged as its `DatabaseQueryError`, behind the errors that wrap it.
  A caller's own `err` serializer cannot replace it. Any other error is logged as pino logs it. The
  pg-boss error handlers log the queue and worker beside the error (`pgBossErrorContext`), as the
  copy pino logged whole held them before.
- **And Better Auth.** Better Auth queries the database on its own pool, so its failed queries
  never pass through `db.run`, and its default logger printed them whole to the web's output: a
  sign-up whose user insert failed printed the name and email, and a failed session or
  verification lookup would print the token. Its log lines now go through the web's logger
  (`logLibraryLine`): the line's message, with the first error among its arguments as `err`,
  written as above; its other arguments (a query's conditions, a provider's answer) are left out.
  Its API error hook logs a failed query as its `DatabaseQueryError` (any other error by its
  message, as before), and the calls pages, routes and actions make (`auth.api`, such as reading
  the session) rethrow a failure without the driver's error (`withoutDriverErrorsFrom`), so
  Next.js's output never holds it.
- **What follows:** the error logs above, Next.js's own output for a failing page, failed jobs'
  outputs (so dead letters name `DatabaseQueryError` and its SQLSTATE, not `Error` without a code)
  and receipts' `last_error` hold the sanitised error. Members' contact search with a NUL character
  still fails (22021), and so does an inbound message holding one (22P05, the receipt `failed`), as
  ADR-124 left them, now without the text (since ADR-130 the search is refused naming `q`, and the
  message kept with U+FFFD).
- **Finding a failed query** uses the SQLSTATE, constraint, table and column, the frames, and the
  request or job that failed, never logged values (RUNBOOKS, triage).

Not built: messages of other libraries' errors (logged as before; webhook delivery logs only their
class and code); migrations' console output (operators run them, and it keeps PostgreSQL's
message); a job whose handler fails on pg-boss's own query (a job sent outside a transaction) keeps
PostgreSQL's error in its failed job's output (those queries hold job envelopes: ids and a
signature); an error kept under another property than `cause` (or `errors`) is logged as pino
logs it; Better Auth's lookup of a session's or user's related rows, when its query fails, prints
that error to the console itself (its parameters are ids).

## ADR-130 Text the database cannot store, in members' forms and provider payloads (2026-10-03)

Context: PostgreSQL's text and jsonb cannot hold the NUL character (U+0000). ADR-124 refused it in
the public API and left it everywhere else: members' forms and searches, the sign-up and account
forms Better Auth serves, imported CSV files and the JSON providers send all took it to a query,
which failed. A member saw an internal error instead of the field to fix (since ADR-129 the logs
hold only its SQLSTATE). A provider payload failed where it was stored, and with it everything
delivered beside it: an inbound WhatsApp message holding the character failed its whole webhook
receipt (every message and status in it, `failed` after the retries, with an operations alert), a
store's product or order failed its sync job, and a company endpoint's answer failed the automation
step saving from it.

Decision:

- **Members' input is refused, naming where.** `parseInput`, which validates what every service is
  given (members, platform staff, API keys, jobs), refuses what the schema keeps when it holds the
  character: `validation_failed`, "Text cannot hold the NUL character (U+0000).", with the field's
  path (`q`, `tags.1`, `fields.city`; a key holding it written `\u0000`), as the API answers. What a
  schema drops is not checked, as it never reaches a query, and other control characters are kept,
  as the API keeps them. The walk is the API's (`nulCharacterPathIn`, without recursion), so the
  two cannot disagree.
- **Imported CSV files** are refused at the value holding it, with its line and a hint for files
  saved as UTF-16, which read as UTF-8 hold the character after most letters (`parseCsv`); the
  import's options never carried the file's text, so `parseInput` does not see it.
- **Better Auth's forms** (sign-up, names, passwords, tokens in links) are refused by a hook before
  any endpoint runs, its body, query and path parameters checked: 400 with the same message.
- **Provider and outside JSON is kept, with U+FFFD in place of the character.** Meta's webhooks (and
  a completed Flow's answers inside them), Graph's answers, Razorpay's webhooks and answers, a
  company's Razorpay payment link webhooks, Shopify's and WooCommerce's webhooks and REST answers,
  and a company endpoint's answer to an automation's HTTP step are parsed by `parseExternalJson`
  (`@w360/core`). JSON text holds the character only as the escape `\u0000` (a raw one is not valid
  JSON), so every such escape becomes `�` before parsing, keys included; an escaped backslash
  is read as a pair, so `\\u0000` (a backslash, then "u0000") stays as it is. A message is kept with
  the replacement character, visible where the character was, instead of failing with everything
  delivered beside it. Signatures are still checked on the bytes as received, before parsing.
- **Not replaced:** requests to the Flow endpoint (stored nowhere: forwarded to the company's
  endpoint as WhatsApp sent them) and its answers (returned to WhatsApp as the company sent them),
  WooCommerce's key handover (keys checked by format and stored encrypted), and the app's own stored
  JSON (which cannot hold the character).
- **What follows:** members are told which field to fix; inbound messages, statuses, store data and
  saved answers holding the character are kept. The ADR-129 tests that used the character to make
  the database fail now use a contact card larger than a message's content may be (64 KB), which
  PostgreSQL refuses, to fail a receipt (since ADR-131 no inbound content fails a receipt, and the
  test runs a failing statement in the receipt's transaction).

Not built: a check of pages' URL segments and query strings as such (they reach services as ids,
slugs, cursors and filters, checked by format or through `parseInput`; one that is not would still
fail in the database, without the text since ADR-129); media bytes (kept in object storage) and
headers (HTTP forbids the character) need none, and invalid UTF-8 never reaches a query (Node
decodes it to U+FFFD). An inbound message whose content is larger than 64 KB (a contact card or a
reply with an oversized field, far beyond what WhatsApp sends) still fails its receipt, as that test
shows (settled by ADR-131, which bounds inbound content).

## ADR-131 Inbound text the database cannot store: split emoji and oversized messages (2026-10-03)

Context: drizzle writes a jsonb value as `JSON.stringify` writes it, and `JSON.stringify` writes a
lone UTF-16 surrogate (half of an emoji, or of another character beyond U+FFFF) as the escape
`\ud83d`, which PostgreSQL's jsonb refuses (22P02, "Unicode low surrogate must follow a high
surrogate"); a text column stores it as U+FFFD, as Node encodes it. The app cuts such halves
itself: an inbound message's text was clipped to 4,096 UTF-16 code units, so a WhatsApp message
longer than that whose 4,096th unit was the first half of an emoji failed its insert, and with it
the whole webhook receipt (every message and status in it, `failed` after the retries, with an
operations alert). A Flow's body and an order's note were clipped the same way, and an outside
JSON escape of a lone surrogate, or a lone surrogate an API request sent, failed wherever it was
stored as jsonb (a contact's custom fields, for one). Separately, a message's stored content may be
at most 64 KB (`messages_content_check`), and some of it was kept as Meta sent it: a contact card's
contacts (the first 20, whole), an interactive reply's object, an unsupported message's errors and
values that are not text under the keys read from other messages. So a contact card with large
contacts failed its receipt the same way (SEC-12, found with ADR-130). A Flow's answers, capped at
48 KB of JSON text, could also exceed the 64 KB their own column allows once stored as jsonb, and a
status's errors and pricing were stored as Meta sent them, under checks of 4 KB and 2 KB, so a
status with long error details failed its receipt too.

Decision:

- **jsonb is written as JSON PostgreSQL stores.** `jsonbText` (`@w360/core`) writes a value as
  `JSON.stringify` does, with each lone surrogate's escape replaced by `�` (U+FFFD, as text
  columns store it), reading an escaped backslash as a pair. `JSON.stringify` writes a surrogate
  pair as the character itself, so an escape it leaves is always a half. Every jsonb column is
  declared with `@w360/db`'s `jsonb` type, which writes through it and reads as drizzle's does,
  and the six queries that build jsonb from JSON text use it too.
- **Inbound text is clipped without splitting a character.** `clipText` (`@w360/core`) stops before
  a surrogate pair it would split. An inbound message's text, caption and other values, a Flow's
  body, an order's note, a conversation's preview, a contact's profile name and a company deletion's
  label for a WhatsApp account use it. Clips elsewhere may still split a pair (an automation step's
  field value, clipped to 500 characters by the interpreter the browser also runs, for one), which
  is stored as U+FFFD in text and jsonb alike (since ADR-133 only clips of error text and
  identifiers do).
- **Inbound content is bounded by construction (SEC-12).** Values read from a message keep text
  (clipped), finite numbers and true or false, nothing else; an interactive reply keeps its id,
  title and description; an unsupported message keeps at most 5 errors' code, title, message and
  details. A contact card keeps its first contacts, at most 20, while its content fits a 60 KB
  budget, and records how many it left out (`omittedContacts`). The budget is measured by
  `jsonbSize` (`@w360/core`), an upper bound of what jsonb takes (its header, an entry per value,
  text as UTF-8, numbers at their widest and the padding each may need), checked against
  PostgreSQL's `pg_column_size`. A Flow's answers whose jsonb would exceed 55 KB are too large, as
  answers over 48 KB of JSON text were. Content that would still exceed it is kept as
  `{"tooLarge": true}`, with "[message too large to keep]" as the conversation's preview.
- **A status's errors and pricing are kept within their columns.** As Meta sent them when they fit
  a budget under each column (3.5 KB and 1.5 KB, measured by `jsonbSize`); otherwise each error's
  code, title, message and details, clipped, while they fit (the first error's code and title
  always do), and the pricing's billable flag, pricing model, category and type (reports read the
  category and the flag).
- **Members see what was left out:** the inbox says how many contacts a card left out, and "This
  message was too large to keep." for content kept as too large.

What follows: a long message with emoji, a large contact card, a status with long error details and
a Flow's answers no longer fail a receipt, and a lone surrogate an API request or a provider sends
is kept as U+FFFD instead of failing. ADR-129's test of a receipt failing in the database now runs a
failing statement (a real PostgreSQL error quoting a name and a number) in the receipt's
transaction, as no inbound content can fail it any more.

Not built: the API and webhooks do not say that a message's content was too large (its text is
null) or how many contacts a card left out (since ADR-132 they do); contact cards' contacts are
still not shown in the inbox; clips outside the inbound path may still split a pair (stored as
U+FFFD; since ADR-133 only those of error text and identifiers).

## ADR-132 What was left out of a message, in the API and webhooks (2026-10-03)

Context: since ADR-131 an inbound message's content is bounded under the 64 KB its column allows: a
contact card keeps its first contacts that fit and records how many it left out
(`omittedContacts`), and content that would still exceed the budget is kept as
`{"tooLarge": true}`. The inbox says so; the API and the `message.received` webhook did not. A
message kept as too large came with `text: null`, as a message without text does, a tapped template
button kept as too large came with a reply whose id and title were null, and a contact card said
nothing of the contacts it left out. The API and webhooks do not give a card's contacts at all:
that would mean naming the fields of Meta's contact object, which the research notes do not cover
and whose reference on developers.facebook.com could not be read from this environment (its network
policy blocks the host), so it stays undecided.

Decision:

- **Two fields say what was left out.** Every message the API returns (a conversation's messages,
  `GET /messages` and `GET /message-changes`) and the `message.received` webhook carry
  `contentTooLarge`, true when WhatsApp sent more than a message may hold, so its content was not
  kept (false for outbound messages), and `contactsLeftOut`, how many contacts a contact card left
  out (0 otherwise). One function, `inboundOmissions`, reads both from the stored content: only
  `true` marks content as too large, and only a whole number above 0 on a contact card counts.
- **Content kept as too large has nothing to read:** its text, reply and media type are null,
  whatever its type, a tapped button's included.
- **Additive and documented:** both fields are required in the OpenAPI document's
  `ConversationMessage`, `FeedMessage` and `WebhookMessageReceived`, with their meaning. Webhook
  bodies are built when delivered (ADR-053), so deliveries and replays of events captured before
  carry them too.

What follows: an integration can tell a message HyFib could not keep from a message without text,
and ask the customer to send it again in parts, and knows when a contact card is incomplete.

Not built: a contact card's contacts in the API and webhooks (and in the inbox), until Meta's
contact object is confirmed from its reference.

## ADR-133 Clips that keep characters whole, in what goes to providers and members (2026-10-03)

Context: ADR-131 clipped inbound text without splitting a surrogate pair and wrote jsonb with half
of an emoji as U+FFFD, but other clips still cut by UTF-16 code units. Text sent to Meta could end
in half of an emoji: a template variable cut to its 1,000 characters (a campaign's or an order
message's, from a contact's field or a store's order, or an automation's), an automation's message
or question cut to its limit, an answer or a value from an HTTP step's response cut to 1,000, a
contact field value an automation sets cut to 500 (stored as U+FFFD since ADR-131), a saved reply
inserted into the composer up to its limit, and a company endpoint's refusal shown in a Flow.
Razorpay could get half of an emoji in a customer's name or email, a recurring charge's
description or a plan's name. `JSON.stringify` writes such a half as an escape (`\ud83d`), and what
Meta and Razorpay do with it is not confirmed: refuse the request, or show "�". Members saw "�"
where a clip fell inside an emoji: in a conversation's preview (a member's reply, a template, a
Flow, an order or product message, an automation's message and a campaign's), a store's, catalog's
or product's text, an ad's headline, a Flow's health text, an import's file name, an automation
run's step log and a company deletion's clean-up list.

Decision:

- **Clips of text that reaches providers or members use `clipText`** (`@w360/core`, ADR-131),
  which stops before a surrogate pair it would split; an automation's shortened text keeps its
  "…". The automation interpreter, the store message model, the inbox composer and the automation
  diagram, which the browser also runs, import it from `@w360/core/text`, a new export with no
  Node dependency.
- **Left as they are:** error and status text, HyFib's own or a provider's (in English), and ids,
  keys, slugs, dates and search text, clipped by code units; a half there is stored as U+FFFD.

What follows: Meta and Razorpay never get half of an emoji from HyFib's clips, and members no
longer see "�" at the end of clipped text outside error messages.

Not built: clips by grapheme: a clip may still separate an emoji's parts that are characters of
their own (a family joined by zero-width joiners, a flag's two regional indicators, a skin tone),
which shows a different emoji, never half of one.

## ADR-134 Re-encrypting stored secrets under the primary key (SEC-10) (2026-10-03)

Context: every secret HyFib stores is sealed with the keyring (AES-256-GCM, its key id in the
value, bound to its row by associated data): companies' WhatsApp tokens and number registration
PINs, HTTP secrets and the requests automations queue, companies' Razorpay key and webhook secrets,
Flow private keys, stores' credentials, webhook secrets and access codes, webhook endpoints'
secrets (and the previous one, for a day after a rotation) and headers, and in the operations
schema providers' webhook bodies (kept 7 days) and queued emails. Making a new key primary seals
new values with it, but nothing sealed the stored ones again, so an old key could never be removed
from `W360_ENCRYPTION_KEYS` without breaking companies' connections (SECURITY's rotation table,
SEC-10). Change-feed cursors handed to API keys are sealed the same way but not stored.

Decision:

- **One registry of what is sealed** (`keyring/reseal.ts`): each kind's table, column and
  associated data, built by the functions its service seals with, so the two cannot drift; a unit
  test checks that migration 0101 lists the same 15 kinds.
- **The minute sweep re-encrypts while a key other than the primary is configured.**
  `ops.sealed_values_to_reseal` (security definer, ids and companies only) finds values sealed with
  such a key, reading only the first 40 characters of each (a key id has at most 32, and a webhook
  body can be large), at most 500 a minute. Each is re-encrypted in its company's scope (operations
  rows in the system scope): read, opened with its associated data, sealed with the primary key and
  written only if it is still the value read (compare and set), so a value a member or a job
  replaced meanwhile is left as it is. A re-encryption changes no row's time: the shared touch
  trigger keeps `updated_at` while `w360.resealing` is on for the transaction (the runtime role
  may already write `updated_at` wherever that trigger runs). A store's webhook secret, which the
  runtime role cannot write, is swapped by `app.reseal_store_webhook_secret` (compare and set,
  within the company in scope, only for another sealed value). An automation's request is
  re-encrypted only while its call is queued or in flight (a finished call clears it), and a
  webhook endpoint's previous secret with the version it was sealed under.
- **Only an older server seals with another key**, so after a lookup finds nothing the next waits
  an hour.
- **A value that does not open** (its associated data does not match, or it is corrupt) was
  unreadable already: it is logged once by each worker with its kind, id and company and the
  error's message (never the value), and left out of that worker's lookups until it restarts.
  After 1,000 of them a worker stops re-encrypting and logs an error that names
  `W360_ENCRYPTION_KEYS`: a wrong old key is the likely cause.
- **Operations → Keys** shows the configured key ids (primary first), how many stored values each
  key seals, by kind, and values sealed with a key that is not configured or not sealed with the
  keyring at all. `ops.sealed_value_counts` returns counts only, to platform administrators only.
  A key can be removed once nothing stored is sealed with it.
- **The definer reads the sealed columns** (column grants, and a read policy on HTTP secrets) only
  to take their key ids; it never returns a value. The keys themselves stay in the secret manager.

What follows: rotating the encryption key is a configuration change and a wait: add a key, make it
primary, wait until Operations → Keys shows the old key seals nothing, then remove it (runbook
§13).
A change-feed cursor sealed with a removed key is refused as invalid, so the runbook keeps the old
key until integrations have read a page since the rotation.

Not built: re-encrypting on demand from the console, alerts when values do not open (the worker
logs them), and rotating the job signing key (SEC-4) or Better Auth's secret.

## ADR-135 Rotating the job signing key without draining the queues (SEC-4) (2026-10-03)

Context: every job carries an envelope signed with `W360_JOB_SIGNING_KEY` when it is queued
(ADR-008, ARCHITECTURE §4), and a worker refuses a job whose signature does not verify
(recorded as `job.invalid_signature`, critical). The key could only be replaced by draining every
queue first (SECURITY's rotation table, SEC-4): a web server or worker still on the old key refuses
what the new key signed and the reverse, and a CRM reminder, a scheduled campaign, an automation's
wait or a store message can stay queued for months, signed with the old key.

Decision:

- **Two optional keys, one rotation at a time.** `W360_JOB_SIGNING_KEY_NEXT` is accepted before any
  instance signs with it; `W360_JOB_SIGNING_KEY_PREVIOUS` is the key being retired, still accepted.
  Configuration refuses both at once, either equal to the signing key, either shorter than 32
  characters, and (in production) a development placeholder. Rotating takes three deploys: add the
  new key as NEXT everywhere; then sign with it and make the old key PREVIOUS; then remove PREVIOUS
  once no job that can still run was signed with it. During each deploy's rollout every instance,
  old or new, accepts what any other signs.
- **An envelope names its key** (`kid`: 16 hexadecimal characters of an HMAC of the key, which does
  not reveal it). The name is outside the signature, so web servers and workers of the previous
  release, which drop fields they do not know, still verify this release's envelopes. It is not
  trusted: verification tries every configured key, and a verified envelope is returned naming the
  key that verified it. Envelopes signed before key ids carry none.
- **The minute sweep signs queued jobs again while a previous key is configured.** It looks up, at
  most 500 a minute, jobs waiting, retrying or failed (pg-boss keeps a failed job, which the console
  can retry, ADR-108) whose envelope names the previous key or no key, verifies each, and writes the
  same contents and time signed with the signing key, with a compare and set on the job's state and
  signature, so a job a worker fetched, or whose data changed, meanwhile is left as it is. A job
  that does not verify is never signed: it is left as it is, logged once by queue and id (never its
  data), and its consumer refuses it as before; after 1,000 a worker stops and logs an error naming
  `W360_JOB_SIGNING_KEY_PREVIOUS`. Running and finished jobs are left alone (a running job that
  fails is signed again once it waits for its retry). After a lookup finds nothing the next waits
  an hour: only an instance still on the previous configuration signs with the previous key. The
  runtime role writes pg-boss's jobs itself, as pg-boss does; the lookup scans pg-boss's job table,
  only while a previous key is configured.
- **Operations → Keys** shows the job signing key ids and, for each key a job's envelope names, how
  many jobs that can still run (waiting, running, failed) name it: `ops.job_signing_key_counts`
  (security definer, platform administrators only, key ids, states and counts) reads pg-boss's job
  data, which the migration runner now lets the definer read. The page says when the previous key
  signs nothing left and can be removed, and counts jobs naming a key that is not configured (their
  consumer will refuse them).

What follows: rotating the job signing key is three configuration changes and a wait (runbook §13);
no queue is drained and no job is refused. A job that does not verify stays counted under the key
it names (the worker logs it): its consumer refuses it whatever the configuration. If the old key
leaked, waiting while it is accepted keeps it usable to whoever holds it and can write to pg-boss's
jobs, and the sweep would sign what they forged again: then do the first deploy, and in the second
sign with the new key without a previous one, accepting that jobs the old key signed are refused
(each recorded as `job.invalid_signature`) and that the sweeps signal their work again from the
durable rows it belongs to (ARCHITECTURE §4).

Not built: rotating on demand from the console, alerts for jobs that do not verify (the worker logs
them), rotating Better Auth's secret.

## ADR-136 Sign-in history for each person (SEC-9) (2026-10-04)

Context: Account & security lists a person's active sessions (Better Auth's: device, address, when
it was signed in), but a session is gone once it is signed out or expires, so nobody can see when,
from where and how their account was signed in to over time (SEC-9). Security events
(`ops.security_events`) record password resets and sign-ups with an address that has an account;
the application role inserts them and cannot read them (0001).

Decision:

- **Every completed sign-in is a security event** `auth.sign_in` (info): the person, the address
  and browser Better Auth stored with the new session, and in its details how they signed in and
  the session's id. A HyFib plugin to Better Auth records it after each endpoint that signs people
  in: the password step (`/sign-in/email`), an authenticator code (`/two-factor/verify-totp`), a
  backup code (`/two-factor/verify-backup-code`) and the email confirmation link (`/verify-email`,
  which signs people in). The methods: password; password on a trusted device (two-factor is on and
  the device's trust skipped the code); password and authenticator code; password and backup code;
  email confirmation link.
- **Only a sign-in that hands out a session counts.** For someone with two-factor on, the password
  step creates a session that Better Auth's two-factor plugin deletes until a code is given, and
  then it clears the endpoint's new session; the plugin runs after it (and before the one that lets
  server actions set cookies), so that step records nothing and the code's records the sign-in.
  Turning two-factor on or off and changing the password renew a person's session under a new id,
  which is no sign-in: on the code and link endpoints a session issued to someone already signed in
  as the same person records nothing, and the other endpoints are not watched. Wrong passwords and
  codes record nothing; Better Auth's rate limits and two-factor lockout apply as before.
- **A sign-in that cannot be recorded fails**: the plugin deletes the session the endpoint created
  and the request fails, so every session handed out has its sign-in in the history.
- **People read only their own**: `ops.my_sign_ins(limit)` (security definer, run by the
  application role, pinned search path) returns the signed-in person's sign-ins (time, method,
  session id, address, browser), newest first, at most 100, and refuses without a signed-in person;
  the application role still cannot read security events otherwise. A partial index on the person
  and time of sign-ins serves it.
- **Account & security → Recent sign-ins** lists the last 20: when, the device and browser, the
  address and how; it marks the one that started the current session and says what to do about one
  that is not yours (change the password, which signs other sessions out, and turn on two-factor).

What follows: people see their last 20 sign-ins and how each was made, so a backup code's use or an
unknown device stands out; platform staff see sign-in counts among the security events on the
operations console (Signals). Sign-ins before this release were not recorded. A session renewed by
turning two-factor on or off or by a password change keeps no link to its sign-in, so the current
session's sign-in is marked only until then. The address is the one Better Auth determines (no
address without a trusted proxy header, as for the sessions list).

Not built: failed attempts in the history (recording a wrong password for an address with an
account only would let whoever tries tell, by how long a sign-in takes, whether the address has
one, and anyone could fill a person's history), emails about sign-ins from new devices, signing a
sign-in's session out from the history, and purging security events after the retention period
(DATA-RETENTION proposes a year).

## ADR-137 Checking each company's WhatsApp access before sends fail (P2-12) (2026-10-04)

Context: each connected WhatsApp Business Account holds the business token Embedded Signup gave
HyFib, encrypted with the keyring (ADR-010). Onboarding checks it once with `debug_token` (our app,
valid, both WhatsApp permissions, the account among the target ids Meta lists for the management
permission). Nothing checks it afterwards: a token Meta stops accepting is found only when a send
fails (that number turns `needs_reconnect`; the account and its other numbers stay connected and
nobody is told), and never for a company that is not sending. Meta's deauthorization signals and
token lifetimes are unconfirmed (M-146); the research recommends checking with `debug_token`
periodically and treating error 190 as a possible loss of access. Templates are listed every six
hours with the same token, and a rejection there is recorded as a failed sync only.

Decision:

- **A daily check of each connected account**: the minute sweep lists, through a definer function
  (ids only), the connected accounts of active companies whose access was not checked in the last
  24 hours, or for which a check was asked since the last one, and signals one
  `whatsapp.access_check` job per account (at most 100 a minute). The job runs in the company's
  scope: it decrypts the token and asks `GET /debug_token` with HyFib's app access token, as at
  onboarding (the token goes in the query string as Meta documents; URLs are never logged).
- **What Meta's answer means**, by the rules onboarding applies (one function for both): the
  token is not valid; it belongs to another app; a WhatsApp permission is missing from its scopes;
  or Meta lists target ids for the management permission and the account is not among them. Any
  of these is a **loss of access**. Otherwise the access is healthy: the check time, the
  permissions Meta lists and the expiry Meta reports (none for 0) are stored.
- **A loss of access**, in one transaction with the account locked and only if it is still
  connected with the same token: the account turns `needs_reconnect` with the reason and its time;
  its numbers that are active or being set up turn `needs_reconnect` with a message saying why
  (failed and disconnected numbers are left as they are); a system audit entry
  `whatsapp.access_lost` (the reason, the missing permissions, how many numbers); a live
  `channel.updated` event per number; and an email to the company's owners and administrators
  (the roles that can reconnect) with the account, the reason, the numbers that stopped sending
  and how to reconnect. The account leaves the checks until it is reconnected, so the email is
  sent once per loss.
- **A check that could not be made** (no answer, a rate limit, a server error, or an error about
  the request itself, such as HyFib's app access token being refused) changes nothing for the
  company: the attempt and the error (kind, code and title; never the token) are stored and the
  worker logs it; the account is checked again after 30 minutes. An account whose access has not
  been checked successfully for more than 26 hours while attempts failed is listed among the
  integration failures on the operations console, which also shows the reason of an account that
  needs reconnecting.
- **Checks asked at once**: a send rejected for the token (codes 190, 102, 10 or HTTP 401) already
  marks its number `needs_reconnect`; it now also asks for a check of the account's access, and so
  does a template sync rejected that way. The check finds within a minute whether the account lost
  its access (then the other numbers and the email follow) or the token is fine (the number keeps
  its state, as before).
- **Expiry**: when Meta reports an expiry for a healthy token and it is less than 7 days away, the
  owners and administrators are emailed once, with the date and how to reconnect; the Channels
  page shows the date. Once that date has passed, the account is checked again at once instead of
  at the next daily check, and until the check answers, the banner and Channels say the access
  expired. Meta's guides describe business integration tokens as long-lived (M-188),
  so this is expected to be rare.
- **Reconnecting** is Embedded Signup again with the same account (unchanged): it stores the new
  token, clears the reason, the expiry reminder and any asked check, stores the expiry Meta
  reports, and sets the chosen number up again. The account's other numbers that need
  reconnecting and that the new token lists under the account now resume their setup from the
  step they had completed (an active number only has its health read again: Meta counts
  registration attempts), each through its own job; numbers Meta no longer lists stay as they are.
- **Prompts in HyFib**: while an account needs reconnecting, every page of the company shows a
  banner to members who can see channels: the account, the reason, that its numbers cannot send,
  and a link to Channels for owners and administrators (others are told to ask one); an expiry
  within 7 days shows a warning the same way. The Channels page explains each account that needs
  reconnecting and shows, for each number, when its account's access was last checked and when it
  expires. The banner comes with each page load (the company layout is not re-run on client
  navigation; the Channels page reads the state itself).

What follows: a company learns within a day (within minutes when a send or a template sync is
refused) that Meta no longer accepts HyFib's access, before campaigns or replies fail one by one,
and one reconnection brings back every number Meta still lists. A false loss would stop the
company's sends until it reconnects; the check uses only Meta's explicit answer and the rules that
admitted the token at onboarding, and never concludes anything from a failed request. Accounts of
companies that are not active are not checked (as for template syncs).

Not built: checking that HyFib's app is still subscribed to the account's webhooks
(`GET /{waba-id}/subscribed_apps`) and subscribing it again; Meta's deauthorization and uninstall
callbacks (unconfirmed, M-146); a "check now" button; the account's review and payment status
(`health_status`); emails to platform staff about companies' lost access (the console lists them).

## ADR-138 Checking and restoring each account's webhook subscription (P2-12) (2026-10-04)

Context: Meta sends a WhatsApp Business Account's messages, delivery statuses and template updates
to the apps subscribed to the account's webhooks; onboarding subscribes HyFib's app with
`POST /{WABA_ID}/subscribed_apps` (M-017). If HyFib's app stops being subscribed while its token
stays valid, nothing tells HyFib: customers' messages stop arriving and the inbox looks quiet. The
daily access check (ADR-137) confirms the token, not the subscription. Meta's official OpenAPI
description documents `GET /{WABA-ID}/subscribed_apps` ("Get All Subscriptions for a WABA"): `data`
lists the subscribed apps and is empty when none is; its examples put each app's `id`, `name` and
`link` under `whatsapp_business_api_data`, while its `SubscribedApp` schema puts `id` and `name`
directly in each item (M-190). Disconnecting a number in HyFib does not unsubscribe the app at Meta;
only deleting a company does (ADR-055).

Decision:

- **Part of the access check**: once Meta admits the token (ADR-137), the same job lists the
  account's subscribed apps with the account's token. HyFib's app is subscribed when an item's
  `whatsapp_business_api_data.id`, or its `id`, is HyFib's app id (both documented forms are read).
  Only a complete, well-formed answer counts: a `data` list without HyFib's app, in which every
  app's id can be read and after which Meta announces no further page, means the subscription is
  missing. A list with an app whose id cannot be read, or with a further page, cannot tell (unless
  it lists HyFib's app); it, any other answer and a failed request are a check that could not be
  made. A loss of access, or an access that could not be checked, skips this step.
- **A missing subscription is restored at once** with the call onboarding makes (an empty body;
  HyFib uses no callback override, M-035). Restoring is safe against a disconnection racing it:
  disconnecting does not unsubscribe the app, so a restored subscription leaves Meta as a
  disconnection would. The restoration is audited (`whatsapp.webhooks_restored`) and the owners and
  administrators are emailed: Meta no longer listed HyFib's app for the account, HyFib subscribed it
  again, messages and updates Meta sent before then may not have reached HyFib, and disconnecting
  the numbers is the way to stop HyFib receiving them.
- **A subscription that could not be restored** (the POST failed): the account records since when
  HyFib's app is known to be missing and the error's kind, code and title; the first failure is
  audited (`whatsapp.webhooks_missing`) and emailed to the owners and administrators, every page of
  the company shows "WhatsApp messages are not reaching HyFib" (HyFib tries again every 30 minutes,
  and reconnecting also subscribes the app) and the operations console lists the account. When a
  later check finds the app subscribed again (restored by HyFib or by the business), they are
  emailed that messages arrive again and that messages sent meanwhile may be missing.
- **A subscription that could not be checked** (the listing failed or answered something else)
  changes nothing for the company: the error is kept, the account is checked again after 30
  minutes, and the console lists it once the subscription has not been confirmed for 26 hours.
- Channels shows when each account's webhooks were last checked. Reconnecting clears the
  subscription's state (the number's setup job subscribes the app again).

What follows: a lost subscription is found within a day and restored without anyone's help, and the
company learns that some messages may be missing; when it cannot be restored, the company and staff
see it at once. A business that removed HyFib's app from its account on purpose but kept HyFib's
token valid is subscribed again until it disconnects the numbers in HyFib; the email says so.

Not built: checking which webhook fields the app receives for an account; Meta's deauthorization
and uninstall callbacks (unconfirmed, M-146); restoring callback overrides (HyFib uses none).

## ADR-139 Alerts for companies' failing integrations (P5-10) (2026-10-04)

Context: the operations console's Integrations page lists the companies' integrations that fail
now: WhatsApp numbers and accounts that need reconnecting or failed, accounts whose access or
webhook subscription could not be checked for 26 hours, webhooks HyFib's app is no longer
subscribed to, stores that failed or report sync or webhook errors, Razorpay accounts that failed,
catalog and Flow syncs that failed, and webhook endpoints failing or turned off (ADR-054, ADR-137,
ADR-138). Staff saw them only when they opened the page. Companies are told of most of them, but
some point to HyFib's side (an access check failing for a day, a subscription that cannot be
restored, a store sync failing at many companies at once), and only staff see the pattern across
companies. Work that failed for good and late queues already reach staff by email (ADR-091,
ADR-096).

Decision:

- **One list:** the console and the alert read the same rule, `ops.integration_failures()`
  (migration 0106), which only its owner may call; the console's
  `ops.platform_ops_integration_failures` keeps its platform administrator check and reads it.
- **What is told:** each failure once, by its integration (source and subject) and state, recorded
  in `ops.integration_alerts`. A failure stays told while it is listed; a new state of the same
  integration (a failing endpoint turned off, a store whose sync error became a failure) is a new
  failure. Once the console has not listed a failure for an hour its mark is forgotten, so a later
  failure of the same integration is told again, and one that comes and goes within the hour is not
  told at every return.
- **Who and how often:** every platform administrator (ADR-091's recipients), in one email at most
  every 15 minutes (`ops.platform_alerts` kind `integrations`, its row locked so that two sweeps at
  once send one alert), marking at most 1,000 failures per alert, oldest first. The minute messaging
  sweep runs it after the other two alerts. Nothing is marked while there is no platform
  administrator, and the worker warns.
- **What:** one `platform.notice` email with how many failures it tells, by the console's kinds
  ("Webhook endpoint, failing 3; WhatsApp number, needs reconnecting 1"), six kinds named at most,
  and a link to Operations → Integrations. No company, label, host, error or id: those stay on the
  console, behind platform sign-in and two-factor authentication. The Integrations page says when
  the last integration alert went out.
- **Already failing before this release:** told by the first alert after the deploy, since staff
  were never told.

What follows: staff hear of a company's failing integration within about 15 minutes of the console
listing it, once. The check reads the console's list every minute (twice when something waits),
which suits the test envelope; paging and precomputed rollups come with growth (ADR-054).

Not built: alerts by kind or by company, choosing which kinds to be told of, digests, and paging.

## ADR-140 Notices in the app when a monthly limit is nearly or fully used (P5-01) (2026-10-04)

Context: automation runs (ADR-051) and public API requests (ADR-061) are limited per monthly usage
period, packs included (ADR-110). Billing managers are emailed at 80% of a limit (ADR-062) and when
it is used up, and the Billing plan card marks a counter as nearly used up. Nobody else is told: a
marketer whose automations stop answering customers, or a developer whose integration is refused
with 429, learns why only from a billing manager, and a billing manager who missed the email sees
it only on Billing.

Decision:

- **A notice on every page of the company**, with its other notices, while the company is active
  and the current usage period's automation runs or API requests are used up (the limit reached)
  or nearly used up (at least 80% of the limit, rounded up as ADR-062 rounds it, and below it).
- **To the members it concerns:** members who read billing (owners, administrators and billing
  managers by default) see both states of both limits; once the runs are used up, members who read
  automations see it too (supervisors, marketers and analysts), and once the API requests are,
  members who manage API keys (owners and administrators). Agents see none. The counts are no
  secret in the company (`plans.usage` gives them to any member, ADR-051), but a notice that can
  stay for the rest of the month belongs on the pages of those who can act on it or whose work it
  stops.
- **Only limits that apply:** the runs while the plan includes automations and allows more than 0
  of them; the API requests while the plan allows more than 0 (0 leaves the API out of the plan,
  ADR-061). Complimentary access and unlimited plans show none. A company that is suspended,
  restricted or being deleted shows its own notice instead, and nothing runs then.
- **What it says**, as the emails do: how much of the limit is used, what stops at the limit and
  until when (the end of the usage period, in the company's time zone, to the minute), that runs in
  progress continue, or that the app, automations and outgoing webhooks are not affected by the
  API's limit; and whom to ask: members who read billing, HyFib, for more or a larger plan, with a
  link to Billing (not on Billing itself); the others, a member who manages billing.
- **Read where the counts are kept:** one read-only transaction in the company's scope per page,
  reading the plan's limits (`app.tenant_entitlements`, packs included) and the period's two
  counters, and only for a member who would be shown a notice. No table and no migration: a notice
  goes away when the period ends or the limit is raised, and cannot be dismissed.
- **The company's limits only:** a key's own monthly limit (ADR-097) is shown per key on Settings
  → API keys and emailed when it is nearly or fully used (ADR-098).

Not built: dismissing a notice, thresholds per company (since ADR-144) or per member, notices of
keys' own limits, and notices for limits that refuse additions (seats, numbers, teams, live
automations), which the forms they limit show.

## ADR-141 Acknowledging companies' failing integrations on the operations console (P5-10) (2026-10-04)

Context: Operations → Integrations lists the companies' integrations that fail now, and since
ADR-139 every platform administrator is emailed about each new failure. The email names no company,
so every administrator who reads it opens the same list, and nothing there said that someone had
already taken a failure, contacted the company or found the cause: two staff could call the same
company, or each assume that another had.

Decision:

- **Acknowledged with a note:** on Current failures, a platform administrator acknowledges a listed
  failure with a note of 10 to 500 characters (what was done or found). The list shows who
  acknowledged it, when, and the note. Another administrator may acknowledge it again, replacing
  the note; the platform audit log keeps each acknowledgement
  (`platform.integration_failure_acknowledged`, with the company, the note as its reason and the
  failure's source, subject and state).
- **What is acknowledged:** a failure as ADR-139 tells it, by its integration (source and subject)
  and state, in `ops.integration_acknowledgements` (migration 0107). A new state of the same
  integration (a failing endpoint turned off) is a new failure and starts unacknowledged. Only a
  failure the console lists at that moment can be acknowledged: one that recovered or changed state
  is refused ("no longer failing in that state"), so a page left open cannot acknowledge what the
  console no longer shows.
- **How long:** an acknowledgement lasts while the console lists its failure and is forgotten an
  hour after it stops being listed, as the alert marks are (ADR-139): the minute sweep's check keeps
  both (refreshed at most every 10 minutes) and forgets both. A failure that comes back within the
  hour keeps its acknowledgement; one that fails again later starts unacknowledged, and is emailed
  again.
- **Where it is enforced:** `ops.platform_acknowledge_integration_failure` (SECURITY DEFINER,
  executable by the platform role only) checks the platform administrator, the note and that the
  failure is listed now (`ops.integration_failures`, the console's own rule), then records the
  acknowledgement and the audit entry in one transaction. The console's
  `ops.platform_ops_integration_failures` returns each failure's acknowledgement (when, the
  administrator's name, the note). Only the definer role reads and writes the table, which holds the
  failure's ids, the administrator and the note; the company never sees it.

Also fixed in passing: the console used a time its definer functions return only when the driver
handed over a Date, but drizzle hands raw query results over as PostgreSQL's text. The list's
"Since", a company's last message and quality check on its platform page and the start of the
automation runs' period on Usage were blank, and failed onboarding sessions showed the time of the
page view as their start. The console now parses them (an integration test compares them with the
stored times).

Not built: assigning a failure to someone, acknowledging the console's other lists (dead letters,
built by ADR-169; receipts, built by ADR-179; quarantine; late queues, built by ADR-177), editing or
deleting a note (a new acknowledgement replaces it), and leaving acknowledged failures out of the
alert email (each failure is emailed once anyway).

## ADR-142 Clearing the braces advisory from the Next.js ESLint plugin (2026-10-04)

Context: CI's dependency audit (`pnpm audit --audit-level=high`) failed on GHSA-vfj7-8cjw-p6xm, a
high-severity denial of service in `braces` (stack exhaustion through deeply nested patterns) that
has no patched release: 3.0.3, the latest, is affected. It reached the repository only through the
Next.js ESLint plugin, a development dependency: `@next/eslint-plugin-next` (directly, and through
`eslint-config-next`) pins `fast-glob` 3.3.1, whose `micromatch` depends on `braces`. Next.js's
latest and canary releases still pin it. The plugin calls fast-glob once,
`globSync(rootDir, { onlyDirectories: true })`, to resolve `settings.next.rootDir` (ours is
`apps/web`) for the `no-html-link-for-pages` rule. Nothing at runtime used braces, but the check
stayed red, and the job's secret scan, which runs after the audit, was skipped meanwhile.

Decision:

- **Patched, not ignored:** a pnpm patch (`patches/@next__eslint-plugin-next@16.3.6.patch`,
  `patchedDependencies` in `pnpm-workspace.yaml`) makes that call use Node's `fs.globSync` (stable in
  Node 24) and keeps fast-glob's result for it: the matching directories, named as the pattern
  names them (relative or absolute), with the pattern's trailing slash. The one difference, a `**`
  not following symbolic links to directories, does not arise with a plain path.
- **Removed from the tree:** an override (`'@next/eslint-plugin-next>fast-glob': '-'`) drops
  fast-glob from the plugin's dependencies, and with it micromatch, braces and 13 more packages
  only they used; the audit then finds no known vulnerability. The advisory is not ignored: if
  braces comes back through another package, the audit fails again.
- **Pinned to the version:** the patch applies to `@next/eslint-plugin-next@16.3.6` only, so
  upgrading the plugin fails the install until the patch is redone, or dropped once the plugin no
  longer pins fast-glob or braces is fixed. Both Dockerfiles copy `patches/` before their frozen
  install.

Verified: the audit finds no known vulnerability; the patched lookup returns what fast-glob did for
every pattern tried (plain, absolute and trailing-slash paths, `*`, braces, missing directories,
symbolic links) except the `**` case above; with a temporary page in a `pages` directory,
`no-html-link-for-pages` still reported an `<a>` link to it; `pnpm lint` passes; the Dockerfiles'
install step fails without `patches/` and succeeds with it, and both images' build stages built.

Not done: `eslint-config-next`, which `apps/web` still lists, shares the patched plugin and was left
in place.

## ADR-143 Name conditions in segments and contact searches (P3-04, P5-08) (2026-10-04)

Context: segments (P3-04) compare contacts' custom fields, tags, consent, creation day, source,
calling code, last message and campaign outcomes, but not the contact's own name, so members could
not target "contacts named Asha" or "contacts without a name", and `POST /contacts/search`, which
takes segments' conditions (ADR-117, ADR-126), had no name condition either. `GET /contacts?name=`
finds part of a name since ADR-124, but cannot ask for a name that is not something, for no name,
or for a name among conditions matched with `any`. Names come from members, imports, the API, store
orders, Flows answers and WhatsApp profile names; profile names are kept as WhatsApp sends them, so
a name can carry spaces around it, or be spaces only.

Decision:

- **A `name` condition with a text field's comparisons:** `is_set`, `is_not_set`, `equals`,
  `not_equals` and `contains`, in segments and in `POST /contacts/search` alike (one list,
  `NAME_COMPARISONS`, which a unit test keeps equal to a text field's). `equals` and `not_equals`
  compare the whole name whatever its case; `contains` looks for the text as written, never as a
  pattern (`%`, `_` and `\` are escaped); `not_equals` also finds contacts without a name, as it
  does contacts without a field value.
- **A name of spaces only counts as none, and spaces around a name are not compared:** the
  condition reads `nullif(btrim(display_name), '')`, so a WhatsApp profile name of spaces only is
  found by `is_not_set` and " Ravi Kumar " equals "ravi kumar". Stored names are not rewritten.
- **The name to compare with:** at most 200 characters (a name's longest), trimmed; `equals`,
  `not_equals` and `contains` need one, `is_set` and `is_not_set` take none. Segments refuse a
  missing name in members' words ("Enter a name to compare with."); the API answers 422 naming
  `conditions.N.value` ("equals needs a name to compare with.", "is_set takes no value."), and its
  schema refuses another comparison, a number or a longer name.
- **Compiled by segments' function:** the API turns its condition into the segment condition, and
  segments' function turns that into parameterised SQL, so a key and a segment with the same
  conditions find the same contacts (tested for each comparison and for a saved segment). The name
  is part of the contact, so the condition needs only `contacts.read`.
- **Builder:** segments and campaign audiences offer "Name" with "contains" (the default), "is",
  "is not", "has a name" and "has no name"; the name field shows only for the comparisons that take
  one.
- **No migration and no index:** each API page still reads at most 2,000 of the company's contacts
  (ADR-113), and segments read the company's contacts as for every other condition.

Not built: names compared regardless of accents (é and e differ), starts-with and ends-with
comparisons, and conditions on a contact's email.

## ADR-144 Usage warnings at a share each company chooses (P5-01) (2026-10-04)

Context: since ADR-062 a company's billing managers are emailed once when a monthly limit
(automation runs or API requests, packs included) is 80% used, and since ADR-140 members who read
billing see a notice on every page from the same point. A company whose month can run out within a
day (a campaign's automation runs, a nightly API sync) needs the warning earlier, to add packs or
change plan in time; one that uses most of its allowance every month is warned when nothing is
wrong. ADR-062 left a threshold chosen per company unbuilt (P5-01 Remaining).

Decision:

- **One share per company, from 50% to 95% in steps of 5, 80% until one is chosen:**
  `app.tenants.usage_warning_percent` (0108; `smallint`, default 80, a check constraint keeps it to
  the list for every writer). It applies to both monthly limits. Members who manage billing (owners
  and billing managers) choose it under Billing → Usage warnings, shown while the plan has either
  limit; members who only read billing, administrators among them, see the share and who may change
  it. No recent sign-in is asked: the share moves no money and changes no access, and the notices at
  a limit itself do not depend on it. A change is in the company's audit log
  (`billing.usage_warning_changed`, with the share before and after); choosing the current share
  writes nothing. Anything off the list is refused with one message, a number or not.
- **The same point everywhere:** the sweep's list (`ops.usage_warnings_due`, recreated by 0108 to
  read the company's share), the sweep's check under the counter's lock before it emails, the
  notices on every page (ADR-140) and the plan card's "nearly used up" all warn from
  `ceil(limit × share / 100)` (`warningThreshold`) while below the limit. A limit so small that the
  share rounds up to the limit itself gets no warning, as limits of 1 to 4 at 80%: below 20 at 95%,
  only a limit of 1 at 50%.
- **A change counts from the next sweep:** each counter is still warned at most once per period
  (`warned_at`), so raising the share never warns a counter again, and lowering it below what a
  counter already used warns it at the next sweep. The sweep reads the share again in the company's
  scope while it holds the counter, so a share raised after the list was read is respected (that
  counter waits for a later sweep). The email ends by saying at what share it came and that a
  member who manages billing can change it under Billing → Usage warnings.
- **API keys' own limits stay at 80%** (ADR-098): a key's limit is set per key by members who
  manage API keys, not by the plan, and its emails go to owners and administrators.
- **Runtime role:** `w360_app` gains `UPDATE` on this column alone (a column grant, beside the
  name, locale, time zone and two-factor setting it could already change), and reaches only its
  company's row (RLS); it still cannot change the company's status.

Not built: shares per limit or per member, more than one warning per period, a share for keys' own
limits, and choosing who is warned.

## ADR-145 Choosing the automations whose runs a webhook endpoint receives (P5-09) (2026-10-04)

Context: since ADR-078 an endpoint that takes `automation.run_started` or `automation.run_ended`
receives every run of every automation. A company runs many automations (greetings, order updates,
qualification flows, runs started through the API), and a receiver usually acts on one or two: a
CRM that records the leads a qualification flow collects was sent every greeting and order update,
twice, and had to read and drop each. ADR-119 and ADR-123 let an endpoint take some message
statuses and some contact changes; ADR-078 and ADR-119 left filters by automation unbuilt (P5-09
Remaining).

Decision:

- **What an endpoint chooses:** `automationIds`, null for every automation's runs (as before,
  including automations published later), or 1 to 20 automation ids, in the order given with
  repeats merged (compared in lower case), only while the endpoint takes `automation.run_started`
  or `automation.run_ended`. One list applies to both events. It is chosen in Settings → Webhooks
  under "Automation runs sent", shown while either event is ticked: "Every automation’s runs" or
  "Only the runs of the automations ticked", from the company's published automations by name
  (paused and archived ones marked; an archived one is offered only while it is chosen). The
  endpoint shows "Automation runs sent: …", archived ones marked. Through the API it is
  `automationIds` on `POST /webhook-endpoints` and `PATCH /webhook-endpoints/{id}` and in every
  endpoint the API answers (ids only).
- **Only the company's published automations:** each id must be an automation of the endpoint's
  company with a published version. Anything else is refused as `validation_failed`, with the issue
  naming its place (`automationIds.<n>`; 422 through the API). A draft has no live runs. Another
  company's automation is refused with the same message as an unknown id (the lookup runs in the
  company's scope). A published automation cannot be deleted, only archived: the service refuses
  to delete an automation with versions, the runtime role can neither change nor delete versions
  (0011: no grant, and a trigger), and their foreign key keeps the automation. So a list never names
  an automation that is gone. An archived one stays in a list, may be given again, and has no runs
  to send until it is restored. A list given again is checked again; one
  kept by a change is not (it was checked when it was chosen).
- **Kept with its events:** a change that removes both events clears the list, and a list given
  without either is refused (`automationIds`). A `PATCH` that leaves it out keeps it; Settings
  always sends it. A check in the database holds the same rule (null, or 1 to 20 ids without nulls
  while one of the two events is among the endpoint's). The ids are not foreign keys (an array
  cannot reference rows); the services check them as above.
- **Applied when the event is captured:** `app.capture_webhook_event` creates a run event's
  delivery only for the active endpoints that take the event and whose list is null or holds the
  run's automation (the `automationId` 0055's trigger puts in the event's detail). It writes no
  event when no endpoint takes it, as for the other filters. The capture runs in the run's own
  transaction, from the trigger on `app.automation_runs`, so whether a delivery exists is settled
  when the run starts or ends. A change applies to runs that start or end after it. Deliveries
  already created are still sent, and an endpoint taking only ends receives the end of a run that
  started before the change. Replays, test events and the payload are unchanged.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `automationIds` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` (owners and administrators, who can
  read automations too) choose them in Settings and see the names. Keys with `webhooks.manage`
  choose them through the API. The API answers and audits ids only, and its refusals say only that
  an id is not one of the company's published automations. Run event deliveries already carry each
  run's automation id and name to the company's receivers.
- **Migration 0109:** `automation_ids uuid[]` on `app.webhook_endpoints` with the check, validated
  at once (a company has at most 10 endpoints), an update grant on the column for the runtime role
  (it inserts it with its table grant), and `app.capture_webhook_event` replaced with the same
  signature (0095's, with the automation condition), so its owner and grants stay. Existing
  endpoints keep null; nothing is backfilled.

Not built: filters on other facts of a run (its trigger (built by ADR-183), how it ended (built by
ADR-151), the key that started it), choosing automations by tag or folder, and filters for
campaigns, templates, orders or conversations by team or channel (by number: built by ADR-170).

## ADR-146 Choosing the campaign statuses a webhook endpoint receives (P5-09) (2026-10-04)

Context: since ADR-087 an endpoint that takes `campaign.status_changed` receives every change of
every campaign's status: submitted, sent back to draft, scheduled, started, paused, resumed,
completed and cancelled. Most receivers act on a few of them: a reporting job that pulls a
campaign's results once it ends wants completions and cancellations, and an alert wants the
runner's pauses (a spending or message cap, the template no longer approved). ADR-119 lets an
endpoint take some message statuses; ADR-087 and ADR-119 left filters for campaigns unbuilt (P5-09
Remaining).

Decision:

- **A list of statuses per endpoint,** for `campaign.status_changed` only: null receives every
  status, as before; a list holds 1 to 7 of `draft`, `pending_approval`, `scheduled`, `running`,
  `paused`, `completed` and `canceled`, the status the change reached (the event's
  `campaign.status`, not the one before), in the order a campaign reaches them with repeats merged.
  It is chosen in Settings → Webhooks under "Campaign status" (every status ticked to begin with;
  saving all of them ticked keeps none) and shown on the endpoint as "Campaign statuses sent: …",
  with the names Campaigns uses, and through the API as `campaignStatuses` on
  `POST /webhook-endpoints` and `PATCH /webhook-endpoints/{id}` and in every endpoint the API
  answers.
- **Only with the event:** statuses given for an endpoint that does not receive
  `campaign.status_changed` are refused (`campaignStatuses`; 422 through the API). A change that
  removes the event clears them, and a `PATCH` that leaves them out keeps them; Settings always
  sends them. A check in the database holds the same rule (null, or 1 to 7 known statuses while the
  event is among the endpoint's).
- **Applied when the event is captured:** `app.capture_webhook_event` creates a
  `campaign.status_changed` delivery only for the active endpoints whose list is null or holds the
  status the campaign reached, and writes no event when none takes it, as for message statuses. The
  capture is in the transaction that changes the campaign's status, from 0065's trigger. A change of
  the list applies to changes captured after it; deliveries already created are still sent.
  Replays, test events and the payload are unchanged; the payload still carries the status before.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `campaignStatuses` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API. The list names statuses only, never a campaign.
- **Migration 0110:** `campaign_statuses text[]` on `app.webhook_endpoints` with the check,
  validated at once (a company has at most 10 endpoints), an update grant on the column for the
  runtime role (it inserts it with its table grant), and `app.capture_webhook_event` replaced with
  the same signature (0109's, with the campaign condition), so its owner and grants stay. Existing
  endpoints keep null; nothing is backfilled.

Not built: filters by campaign, by the status before a change or by why a campaign paused or
completed, and filters for template (built by ADR-148), order (built by ADR-147) or conversation
(built by ADR-149) statuses.

## ADR-147 Choosing the order statuses a webhook endpoint receives (P5-09) (2026-10-04)

Context: since ADR-085 an endpoint that takes `order.status_changed` receives every change of every
WhatsApp order's status: a member's confirmation, fulfilment or cancellation, a Payment Link
requested, Razorpay's payment, and the return to confirmed when a link ends unpaid. Most receivers
act on a few of them: a warehouse picks orders once they are paid or confirmed for cash on
delivery, and a refund desk wants cancellations. ADR-085 left filters by status unbuilt, and
ADR-146 built them for campaigns.

Decision:

- **A list of statuses per endpoint,** for `order.status_changed` only: null receives every status,
  as before; a list holds 1 to 5 of `confirmed`, `awaiting_payment`, `paid`, `fulfilled` and
  `cancelled`, the status the change reached (the event's `order.status`, not the one before), in
  the order an order reaches them with repeats merged. An order is `received` only when it is
  recorded, which `order.received` reports and no change reaches (members move an order from it,
  the worker never back to it), so the list cannot name it. It is chosen in Settings → Webhooks
  under "Order status" (every status ticked to begin with; saving all of them ticked keeps none)
  and shown on the endpoint as "Order statuses sent: …", with the names Orders uses, and through
  the API as `orderStatuses` on `POST /webhook-endpoints` and `PATCH /webhook-endpoints/{id}` and
  in every endpoint the API answers.
- **Only with the event:** statuses given for an endpoint that does not receive
  `order.status_changed` are refused (`orderStatuses`; 422 through the API). A change that removes
  the event clears them, and a `PATCH` that leaves them out keeps them; Settings always sends them.
  A check in the database holds the same rule (null, or 1 to 5 known statuses while the event is
  among the endpoint's). `order.received` is never filtered.
- **Applied when the event is captured:** `app.capture_webhook_event` creates an
  `order.status_changed` delivery only for the active endpoints whose list is null or holds the
  status the order reached, and writes no event when none takes it, as for campaign statuses. The
  capture is in the transaction that changes the order's status, from 0063's trigger, whether a
  member, the Payment Link worker or Razorpay's payment makes the change. A change of the list
  applies to changes captured after it; deliveries already created are still sent. Replays, test
  events and the payload are unchanged; the payload still carries the status before.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `orderStatuses` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API. The list names statuses only, never an order.
- **One control for both lists:** Settings shows campaign and order statuses with the same
  component, so both keep the order statuses are reached in and both send none when every status
  is ticked.
- **Migration 0111:** `order_statuses text[]` on `app.webhook_endpoints` with the check, validated
  at once (a company has at most 10 endpoints), an update grant on the column for the runtime role
  (it inserts it with its table grant), and `app.capture_webhook_event` replaced with the same
  signature (0110's, with the order condition), so its owner and grants stay. Existing endpoints
  keep null; nothing is backfilled.

Not built: filters by the status before a change, by store or catalog, by amount or by payment
method, filters for `order.received`, and filters for template (built by ADR-148) or conversation
(built by ADR-149) statuses.

## ADR-148 Choosing the template statuses a webhook endpoint receives (P5-09) (2026-10-04)

Context: since ADR-053 an endpoint that takes `template.status_changed` receives every status
reported for every template: Meta's review (in review, approved, rejected), its later decisions
(paused, disabled, flagged, in appeal, archived, locked, a limit exceeded) and deletions. Most
receivers act on a few of them: a team that keeps its campaigns running wants pauses, rejections and
disablements, and a publishing tool wants approvals. ADR-146 and ADR-147 built filters by status for
campaigns and orders.

Decision:

- **A list of statuses per endpoint,** for `template.status_changed` only: null receives every
  status, as before; a list holds 1 to 11 of the statuses the event reports (`pending`, `approved`,
  `rejected`, `paused`, `disabled`, `in_appeal`, `flagged`, `archived`, `deleted`,
  `limit_exceeded`, `locked`, 0025's trigger's list), in the order Templates lists them with repeats
  merged. HyFib's own steps before Meta has a template (`draft`, `submitting`, `submit_failed`), a
  deletion under way or refused (`pending_deletion`, `delete_failed`) and an unrecognised status
  (`unknown`) are never sent, so the list cannot name them. It is chosen in Settings → Webhooks
  under "Template status" (every status ticked to begin with; saving all of them ticked keeps none)
  and shown on the endpoint as "Template statuses sent: …", with the names Templates uses, and
  through the API as `templateStatuses` on `POST /webhook-endpoints` and
  `PATCH /webhook-endpoints/{id}` and in every endpoint the API answers.
- **Only with the event:** statuses given for an endpoint that does not receive
  `template.status_changed` are refused (`templateStatuses`; 422 through the API). A change that
  removes the event clears them, and a `PATCH` that leaves them out keeps them; Settings always
  sends them. A check in the database holds the same rule (null, or 1 to 11 known statuses while
  the event is among the endpoint's).
- **Applied when the event is captured:** `app.capture_webhook_event` creates a
  `template.status_changed` delivery only for the active endpoints whose list is null or holds the
  status reported, and writes no event when none takes it, as for campaign and order statuses. The
  capture is in the transaction that records the status, from 0025's trigger, whoever records it:
  the submission worker with Meta's answer, a sync of Meta's listing (which Meta's template
  webhooks request), a send Meta refused for the template's status, or a deletion (including the
  return to the status Meta last reported when a deletion fails). A change of the list applies to
  statuses captured after it; deliveries already created are still sent. Replays, test events and
  the payload are unchanged.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `templateStatuses` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API. The list names statuses only, never a template.
- **The same control as campaign and order statuses** in Settings.
- **Migration 0112:** `template_statuses text[]` on `app.webhook_endpoints` with the check,
  validated at once (a company has at most 10 endpoints), an update grant on the column for the
  runtime role (it inserts it with its table grant), and `app.capture_webhook_event` replaced with
  the same signature (0111's, with the template condition), so its owner and grants stay. Existing
  endpoints keep null; nothing is backfilled. An integration test holds the domain's list, the
  trigger's and the check's to the same statuses.

Not built: filters by template (built by ADR-175), category, language or WhatsApp account, by the
status before a change or by Meta's reason, and filters for conversation statuses (built by
ADR-149).

## ADR-149 Choosing the conversation statuses a webhook endpoint receives (P5-09) (2026-10-04)

Context: since ADR-074 an endpoint that takes `conversation.status_changed` receives every change of
every conversation's status: each resolve and each reopening, by a member, an automation, an API key
or the contact writing again. A receiver that acts on one of them (a survey tool or a CRM closing
its ticket on resolutions, a desk reopening its case when the contact writes again) had to read and
drop the rest. ADR-146 to ADR-148 built filters by status for campaigns, orders and templates. The
event's description said a conversation could also be set to pending, which nothing does (ADR-075
left setting `pending` unbuilt).

Decision:

- **A list of statuses per endpoint,** for `conversation.status_changed` only: null receives every
  status, as before; a list holds 1 or 2 of `open` and `resolved`, the status the change reached
  (the event's `conversation.status`, not the one before), in the order the inbox lists them with
  repeats merged. `pending` cannot be named: nothing sets a conversation pending, so no change
  reaches it; the feature that first does will widen the list. It is chosen in Settings → Webhooks
  under "Conversation status" (both ticked to begin with; saving both ticked keeps none) and shown
  on the endpoint as "Conversation statuses sent: …", with the names the inbox uses, and through
  the API as `conversationStatuses` on `POST /webhook-endpoints` and
  `PATCH /webhook-endpoints/{id}` and in every endpoint the API answers.
- **Only with the event:** statuses given for an endpoint that does not receive
  `conversation.status_changed` are refused (`conversationStatuses`; 422 through the API). A change
  that removes the event clears them, and a `PATCH` that leaves them out keeps them; Settings always
  sends them. A check in the database holds the same rule (null, or 1 or 2 known statuses while the
  event is among the endpoint's).
- **Applied when the event is captured:** `app.capture_webhook_event` creates a
  `conversation.status_changed` delivery only for the active endpoints whose list is null or holds
  the status the conversation reached, and writes no event when none takes it, as for campaign,
  order and template statuses. The capture is in the transaction that changes the conversation,
  from 0070's trigger, whoever changes it. A change of the list applies to changes captured after
  it; deliveries already created are still sent. Replays, test events and the payload are
  unchanged; the payload still carries the status before.
- **The event's description is corrected:** "A conversation was resolved or reopened, by a member,
  an automation, an API key or the contact writing again", in Settings and the OpenAPI document; the
  payload's status field keeps the three statuses a conversation row can hold.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `conversationStatuses` when the endpoint has a list, and the company data export carries the
  column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API. The list names statuses only, never a conversation.
- **The same control** as campaign, order and template statuses in Settings.
- **Migration 0113:** `conversation_statuses text[]` on `app.webhook_endpoints` with the check,
  validated at once (a company has at most 10 endpoints), an update grant on the column for the
  runtime role (it inserts it with its table grant), and `app.capture_webhook_event` replaced with
  the same signature (0112's, with the conversation condition), so its owner and grants stay.
  Existing endpoints keep null; nothing is backfilled.

Not built: filters by the status before a change, by who changed it, by team or member, and setting
conversations pending.

## ADR-150 Campaign results in campaign events (P5-09) (2026-10-05)

Context: `campaign.status_changed` (ADR-087) carries a campaign's counters (the audience taken, the
recipients queued and skipped) but not what happened to its messages: ADR-087 left delivery and read
counts out because they change with every message status. Since ADR-125 `GET /campaigns/{id}`
answers the campaign's results counted when read, so a receiver that hears a campaign completed had
to call it, with a key holding `campaigns.read`, to learn how it went. The results were counted in
three statements (the counts, the skip reasons, the failure codes), which agree only in one
snapshot: the API reads them at repeatable read, members' campaign page at read committed.

Decision:

- **`campaign.results` in every `campaign.status_changed`:** the results `GET /campaigns/{id}`
  answers, the same object members' campaign page counts (recipients pending, skipped, cancelled and
  queued; messages in progress, sent, delivered, read, failed, of unknown outcome and cancelled;
  replies and opt-outs among delivered recipients; skip reasons and the 10 commonest failure codes),
  counted when the request is built, like the campaign's name and counters (ADR-087): the `t` of the
  request's `W360-Signature` is that time, and a retry, a replay or a later delivery counts again.
  Null while the campaign is a draft, which has no recipients yet, as the API answers. The status,
  the status before it and the reasons stay as captured.
- **One statement:** `campaignAnalytics` counts in a single statement, the skip reasons and failure
  codes in scalar subqueries, so its numbers agree whatever the caller's isolation: members'
  campaign page, the API (still repeatable read) and the delivery's claim (read committed). Ties
  among reasons and codes are ordered by reason and code, failures without a code after the codes
  they tie with, which also decides the tenth code when the tenth place is tied. The counting moved
  to `campaigns/results.ts` with the results schema and its mapping, which the service, the API and
  the payloads share.
- **Counts only:** no recipient, member or cost (the page's cost estimate stays out, as in the API).
  Who receives them is unchanged: endpoints are managed by owners and administrators
  (`developer.manage`), who read campaigns anyway, and by keys with `webhooks.manage`, which only
  they grant and which already receive the campaign's counters and the company's messages.
- **No migration:** nothing is stored; the payload is built when delivered (ADR-053). The OpenAPI
  document's `WebhookCampaignStatusChanged` gains `results` (the schema of the results
  `GET /campaigns/{id}` answers), and the event says when they are counted.

Not built: results as they were at the change (a snapshot stored with the event), results for a time
range or by day, the campaign in `message.status`, events for each recipient, and costs.

## ADR-151 Choosing how the automation runs a webhook endpoint receives ended (P5-09) (2026-10-05)

Context: since ADR-078 an endpoint that takes `automation.run_ended` receives the end of every run:
each completed run and each one handed to people, taken over, stopped or failed. ADR-145 lets it
name the automations whose runs it takes, and left filters on how a run ended unbuilt. A receiver
that acts on some ends only (an alert on failures, a desk opening a case when a run hands the
conversation to people) had to read and drop the rest; ADR-146 to ADR-149 built the same filter for
the statuses of campaigns, orders, templates and conversations.

Decision:

- **A list of ends per endpoint,** for `automation.run_ended` only: null receives every end, as
  before; a list holds 1 to 5 of `completed`, `handed_off`, `taken_over`, `stopped` and `failed`,
  the status the run ended with (the event's `run.status`), in the order an automation's runs list
  them with repeats merged. A run's active statuses (`running`, `waiting`) end nothing and cannot be
  named. It is chosen in Settings → Webhooks under "Automation ended" (every end ticked to begin
  with; saving them all ticked keeps none) and shown on the endpoint as "Automation ends sent: …",
  with the names an automation's runs use, and through the API as `runEndStatuses` on
  `POST /webhook-endpoints` and `PATCH /webhook-endpoints/{id}` and in every endpoint the API
  answers.
- **Only with the event:** a list given for an endpoint that does not receive `automation.run_ended`
  is refused (`runEndStatuses`; 422 through the API), run starts included. A change that removes the
  event clears it, and a `PATCH` that leaves it out keeps it; Settings always sends it. A check in
  the database holds the same rule (null, or 1 to 5 known ends while the event is among the
  endpoint's).
- **Applied when the event is captured,** with the automations an endpoint names (ADR-145):
  `app.capture_webhook_event` creates an `automation.run_ended` delivery only for the active
  endpoints that take it, whose automations are null or include the run's, and whose list is null or
  holds the status the run ended with, and writes no event when none takes it. Run starts are
  unchanged. The capture is in the transaction that ends the run, from 0055's trigger, whatever ends
  it (the run itself, a member, an API key, erasure). A change of the list applies to ends captured
  after it; deliveries already created are still sent. Replays, test events and the payload are
  unchanged.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `runEndStatuses` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API. The list names statuses only, never a run or a conversation.
- **The same control** as the statuses of campaigns, orders, templates and conversations in
  Settings.
- **Migration 0114:** `run_end_statuses text[]` on `app.webhook_endpoints` with the check, validated
  at once (a company has at most 10 endpoints), an update grant on the column for the runtime role
  (it inserts it with its table grant), and `app.capture_webhook_event` replaced with the same
  signature (0113's, with the run end condition), so its owner and grants stay. Existing endpoints
  keep null; nothing is backfilled.

Not built: filters on a run's end reason, its trigger (built by ADR-183) or the key that started it,
on how long it ran, or by tag or folder.

## ADR-152 An API reference page made from the OpenAPI document (P5-08) (2026-10-05)

Context: since ADR-052 the public API has been described by one OpenAPI 3.1 document at
`/api/v1/openapi.json`, generated from the schemas that validate requests, and by nothing a person
can read: a developer imported the 314 KB document into Postman or a viewer to learn an operation's
parameters or a webhook body, and Settings → API keys and Settings → Webhooks linked to the JSON
only. The feature matrix recorded a documentation site as not built (W-140).

Decision:

- **A page made from the document, for anyone:** `/developers` shows the document the API serves,
  built by the same call with the same address, so it never describes more or less: each operation
  once, grouped by the first segment of its path in the document's order (`Contacts`,
  `Webhook endpoints`), with its summary, description, parameters, request body and answers; each
  webhook event with the headers every delivery carries, its body and the answer HyFib expects; each
  schema with its fields. Contents at the top lead to every group, operation, event and schema
  (`#op-<operationId>`, `#event-<type>`, `#schema-<name>`), and a schema named in a type leads to
  it. Settings → API keys and Settings → Webhooks link to it (Webhooks to its events), beside the
  document.
- **No sign-in, nothing private:** the page reads no session, no company data and no database: only
  the configured address, through the web configuration alone (`getWebConfig`, which the runtime now
  shares). The document route needs no more, so neither starts the runtime (database pool, keyring,
  job queue) any longer.
- **Words, not a viewer:** `apiReference` (domain, pure) turns the document into what the page
  shows. Types are named (a schema, `string (uuid)`, `array of Contact`, `map of string`, "one of 9
  objects", a constant value), a nullable value with its other option; limits, allowed values and
  defaults are notes ("1 to 100", "One of `asc` or `desc`", "At most 1,000 characters", "Default
  50"), those of each key, item or value after a lead-in; a pattern is left out where a format says
  the same. Fields inside fields are indented under theirs, and a union of objects (a contact
  search's conditions) lists each shape, named by its one constant field (`type = tag`), otherwise
  by its place.
- **Text only:** descriptions become paragraphs at line breaks and code between backticks (an
  unpaired backtick stays text); nothing in the document is rendered as HTML, so
  `Authorization: Bearer <API key>` reads as written.
- **Refused rather than left out:** a reference the page cannot follow (outside the document) or a
  shared parameter the document lacks stops the page with an error instead of dropping part of it;
  the unit tests build the reference from the real document, so such a document fails them first.
- **Built once, not per request:** the document and its reference depend on the code and the
  configured address alone, so the web tier builds them once and keeps them in memory
  (`publicApiDocs`; the page's and the route's server bundles each keep a copy), and the route serves
  the JSON it built. The page is rendered for each request, with its CSP nonce, and like every page is
  `private, no-store` and asked not to be indexed; the document stays `public, max-age=300`.

Not built: a changelog, code samples, a console for trying requests, search, and references for
other versions (there is one, `v1`).

## ADR-153 API requests on the operations console (P5-10) (2026-10-05)

Context: the console's Usage tab (ADR-054) lists each company's sending, receipts, webhook
deliveries, automation runs, members and numbers, and said that API request counts were not
recorded. Since ADR-061 a company's plan counts every request its API keys make, one counter per
usage period, which Billing and the company's platform page show against the plan's limit; staff
watching the platform had no list of which companies use the API, or how much.

Decision:

- **The plan's counter on the Usage tab:** an "API requests" column beside "Automation runs", read
  the same way: each company's latest API request counter with the day its period started ("from
  …"), 0 and no date when its keys have made no request. It is the count the plan's limit applies to
  (requests a key's or the company's monthly limit refused are not in it), for the plan's period,
  not for the 7, 30 or 90 days the tab's other columns cover, as the tab says.
- **Read by the platform role, without a migration:** 0023's policy already lets the platform role
  read every company's `app.usage_counters`, as the platform company page does. The service reads
  each company's latest `api_requests` row in the transaction that reads the activity and joins it
  to the companies `ops.platform_ops_activity` returns, so deleted companies stay out; company ids,
  periods and counts only. The definer function is unchanged.
- **The tab's text** no longer says API requests are not recorded; messages sent through the API
  still count under Sent.

Not built: each key's count (ADR-097 shows it to the company in Settings → API keys), requests over
the tab's window, refused requests, trends.

## ADR-154 Exporting the console's usage table (P5-10) (2026-10-05)

Context: the console's Usage tab (ADR-054, ADR-153) shows each company's sending, receipts, webhook
deliveries, automation runs, API requests, members and numbers over 7, 30 or 90 days, on screen
only, and P5-10's Remaining listed exports. Staff comparing usage with plans or planning capacity
copied the figures by hand.

Decision:

- **"Download CSV" on the Usage tab,** for the window shown: a line per company in the tab's order
  with its name, address and status and the tab's figures (sending by sender, failures, receipts,
  webhook deliveries, automation runs and API requests with the days their periods started, members,
  numbers); UTF-8 with a byte-order mark, RFC 4180 quoting and the contacts export's formula
  neutralisation, so a company name starting with `=`, `+`, `-` or `@` cannot run in a spreadsheet;
  named `hyfib-usage-<days>-days-<day>.csv`.
- **Audited before it leaves:** the service writes `platform.ops_usage_exported` to the platform
  audit log, with the window and how many companies, in the transaction that reads the rows, and
  returns the file only once that entry commits with them. The tab's checks run first (the page's
  platform actor, then the definer function's administrator check), so a refused export writes
  nothing and returns no file.
- **The tab's data and nothing else,** from the same reads (ADR-153's counters included): no
  message, contact or person. Served as an attachment, `private, no-store` and `nosniff`.

Not built: exports of the console's other lists, other formats, scheduled exports.

## ADR-155 Exporting the console's health and signals lists (P5-10) (2026-10-05)

Context: ADR-154 made the Usage tab downloadable. Every company's health (the facts behind its level
and issues) and the Signals tab could still be read on screen only, and the Overview lists only the
companies needing attention. Staff preparing a review of companies at risk, or keeping a record of
sending signals, copied them by hand.

Decision:

- **"Download CSV" on the Overview,** for every company, healthy ones included: worst first
  (critical, then warnings, then healthy; more issues first; then by name, as the Overview orders
  those needing attention), with its address, status, plan status, creation day, level and issues as
  the console words them, and every fact the Overview and a company's page show: numbers by state,
  the worst quality rating and when it was checked, the last 24 hours' sending, the last message,
  failing and turned-off webhook endpoints, failed stores, payment accounts, catalog and Flow syncs,
  and dead letters in 7 days. Times are to the minute in UTC. Named `hyfib-health-<day>.csv`.
- **"Download CSV" on the Signals tab,** for the tab's lines over its 7 days, in its order: sending,
  failures, marketing templates delivered and opt-outs, Meta's errors 131050 and 131049, complaints,
  the worst quality rating and the signals in words. Named `hyfib-signals-7-days-<day>.csv`.
- **One export for the console's lists:** `/platform/ops/export/{usage,health,signals}` (the Usage
  tab's link moves there; any other name is not found). One service call reads the list's rows with
  the tab's own reads and writes `platform.ops_<list>_exported` to the platform audit log, with how
  many companies and the window where the list has one, in that transaction, before the file is
  returned (ADR-154's rules). The same CSV writer: UTF-8 with a byte-order mark, RFC 4180 quoting
  and formula neutralisation.
- **Counts, states, codes and labels only,** as on the screens (ADR-054): no message, contact or
  person.

Not built: exports of the action lists (onboarding, integrations, queues, keys), other formats,
scheduled exports.

## ADR-156 Replaying an endpoint's failed deliveries by event type (P5-09) (2026-10-05)

Context: since ADR-095 a member or a key replays every event whose deliveries to an endpoint all
failed in a period, 500 per call. A receiver that failed for some events only (a bug in its handler
for `contact.updated`, say, while it took `message.received` without trouble) got every failed event
of the period again, including those it had since read through the API. P5-09's Remaining listed
replays by event type.

Decision:

- **Of the events chosen:** `POST /api/v1/webhook-endpoints/{id}/replay-failed` takes `events`
  beside `since`: known event types, at least one, kept once each in the list's order. Left out, the
  failed deliveries of every event are replayed, as before. Settings → Webhooks' replay form offers
  "Every event" or one of the events the endpoint receives.
- **Everything else as ADR-095:** the same failed deliveries are chosen (every delivery of the event
  to the endpoint failed, not `event_gone`, not a test event), oldest event first, 500 per call with
  `more`, the endpoint locked and on, once per `Idempotency-Key` through the API.
- **Audit:** `webhook.deliveries_replayed` names the events chosen, as the member or as the key.
- **No migration:** the filter is one more condition on the event's type in the query that chooses
  the deliveries.

Not built: replays across endpoints, replays by a delivery's error or HTTP status.

## ADR-157 Each company's usage against the window before (P5-10) (2026-10-05)

Context: the console's Usage tab (ADR-054, ADR-153) shows each company's sending and receipts over
7, 30 or 90 days, with nothing to compare them with: staff could not tell a company whose sending
had halved, which often comes before it leaves, from one that always sent little. P5-10's Remaining
listed trends.

Decision:

- **The window before, for 7 and 30 days:** under Sent and Received, each company's count in the 7
  or 30 days before the window and how it moved (`+25%`, `-40%`, "none before" when it was 0;
  nothing when it is 0 in both), and the same for the totals. The CSV (ADR-154) gains "Sent in the
  window before" and "Received in the window before" as its last two columns.
- **Not for 90 days:** the activity function reads at most 93 days back (ADR-054), so 180 days
  cannot be read; the tab says so and the CSV leaves the two columns empty.
- **Exact, in one snapshot:** the window before is the activity since twice as far back less the
  window's own. Both are calls of `ops.platform_ops_activity`, which is STABLE, in one statement, so
  they see the same snapshot and a message written between them cannot be counted in one and not the
  other. No migration: the definer function is unchanged.

Not built: comparisons of the other figures (failures, webhook deliveries, the plans' counters,
which are per period), trends over more than two windows, charts, alerts on a fall.

## ADR-158 Exporting the console's action lists (P5-10) (2026-10-05)

Context: ADR-154 and ADR-155 made the Usage tab, every company's health and the Signals tab
downloadable, and left out the lists staff act on: the Onboarding tab's failed and abandoned
signups, failed or stuck number setups and new companies without a number; the Integrations tab's
current failures, Meta and Razorpay receipts needing attention, quarantined events and email
delivery; and the Queues tab's queues and dead letters. Staff handing a list to the person fixing
it, or keeping a record of a bad day, copied it by hand.

Decision:

- **"Download CSV" on each list of the three tabs,** for the rows the tab shows, in its order and in
  its words: an outcome, a state, a step, a problem or a reason as the tab says it, times to the
  minute in UTC, Yes or No for the tab's yes-or-no facts. A queue's oldest wait is in whole minutes,
  empty when nothing waited or the worker did not check the queue; a dead letter's last columns say
  what became of its job, or why it cannot be retried, as the tab does. Each link is named after its
  list ("Download CSV: Recent dead letters"), so a tab with several lists tells them apart.
- **The same export:** `/platform/ops/export/<list>` for `signups`, `number-setups`,
  `new-companies`, `failures`, `receipts`, `quarantine`, `emails`, `queues` and `dead-letters`,
  beside ADR-155's three lists, through the same service call: the tab's own read of the list (each
  tab's reads are now one per list, shared by the tab and its exports),
  `platform.ops_<list>_exported` in the platform audit log with how many rows (companies, for new
  companies without a number) and the window where the list has one (30 days for signups and new
  companies, 7 for email delivery), in that transaction, before the file is returned, and the same
  writer: UTF-8 with a byte-order mark, RFC 4180 quoting and formula neutralisation. Named
  `hyfib-dead-letters-<day>.csv`, `hyfib-signups-30-days-<day>.csv` and so on.
- **Refused before any read:** an export checks, in its transaction, that the actor is a platform
  administrator and refuses anyone else before the list is read. The lists read through a definer
  function were refused there already; the others, the platform role's own reads of number setups,
  receipts, quarantine, emails, queues and dead letters, were refused only by the pages' platform
  actor check, which stays.
- **What the screens show, less people and notes:** who acknowledged a failure (ADR-141) or retried
  a job (ADR-108) is left out, and so is an acknowledgement's note: the file gives when a failure
  was acknowledged and when a job was retried, and the rest stays in the console and the platform
  audit log. Errors are the providers' answers as the tab shows them (an endpoint by its host only);
  emails are counted by kind, never with an address; quarantine entries carry only the allow-listed
  provider ids.

Not built: exports beyond the rows a tab lists (its latest 100 dead letters, receipts and quarantine
entries, 200 signups and number setups, 500 failures and new companies), an export of the Keys tab,
other formats, scheduled exports.

## ADR-159 Replaying an endpoint's failed deliveries by how they failed (P5-09) (2026-10-05)

Context: ADR-156 let a replay of an endpoint's failed deliveries choose the events. A receiver that
was down for an hour, answering 502 or not answering at all, and that also refused some events for
reasons of its own (a 400 for a payload its handler rejects) got the refused events again with the
rest when the period was replayed, to refuse them again. ADR-156 left out replays by a delivery's
error or HTTP status.

Decision:

- **Five kinds of failure,** by how the event's latest failed delivery to the endpoint ended: server
  errors (HTTP 5xx), refused (HTTP 4xx), other answers (HTTP 1xx or 3xx: redirects are not
  followed), no valid answer (a timeout, a host or address that failed, a broken connection, an
  answer too large or without a valid status, an attempt its worker stopped during) and not
  attempted (the endpoint was turned off, or HyFib could not prepare the request). As the
  deliveries list says it, a code that ended the delivery says more than the status an earlier
  attempt left: a delivery answered 500 and then ended when the endpoint was turned off was not
  attempted, and one answered 503 and then interrupted got no valid answer.
- **Of the failures chosen:** `POST /api/v1/webhook-endpoints/{id}/replay-failed` takes `failures`
  beside `since` and `events`: `server_error`, `client_error`, `other_answer`, `no_answer` and
  `not_attempted`, at least one, kept once each in that order. Left out, every failure is replayed,
  as before. Settings → Webhooks' replay form offers "Every failure" or one kind, beside the events.
- **The latest failed delivery decides,** the one a replay names in `replayOf`: an event answered
  500 and then replayed without an answer is replayed again with "No valid answer", not with the
  server errors.
- **Everything else as ADR-095 and ADR-156:** the same events are chosen (every delivery of the
  event to the endpoint failed, not `event_gone`, not a test event), oldest event first, 500 per
  call with `more`, the endpoint locked and on, once per `Idempotency-Key` through the API.
- **Audit:** `webhook.deliveries_replayed` names the failures chosen, beside the events, as the
  member or as the key.
- **No migration:** one more condition on the latest failed delivery's code and status in the query
  that chooses the deliveries.

Not built: replays by one status or error code, replays across endpoints.

## ADR-160 Replaying the failed deliveries of every endpoint at once (P5-09) (2026-10-05)

Context: since ADR-095 a replay works on one endpoint. A company whose endpoints all failed for the
same reason (its gateway was down for an hour, or a certificate expired on a host they share)
replayed each endpoint in turn, up to ten times, with the same period, events and failures. P5-09's
Remaining listed replays across endpoints.

Decision:

- **Every endpoint that is on, in one call:** Settings → Webhooks gains "Replay failed deliveries"
  under the endpoints, with an endpoint's period, events (every event, or one an endpoint that is on
  receives) and failures. Through the API, `POST /api/v1/webhook-endpoints/replay-failed` takes the
  `since`, `events` and `failures` of an endpoint's call, for the endpoints keys added (scope
  `webhooks.manage`, once per `Idempotency-Key`). Endpoints that are off are left out; when none is
  on, the call is refused (412), as an endpoint's is.
- **One batch, endpoint by endpoint:** at most 500 new deliveries per call across the endpoints, in
  the order they were added, each one's oldest event first; at each endpoint the events an
  endpoint's own replay would choose (ADR-095, ADR-156, ADR-159). `more` says whether another call
  would queue more: once the batch is used up, each endpoint left is only asked whether it has any.
  The answer gives each endpoint's `queued` and `more`; Settings says how many deliveries go to each
  endpoint's host.
- **Locked together:** every endpoint is locked, in that order, before any is read, so an endpoint's
  own replay at the same time queues each event once, and two replays of every endpoint cannot
  deadlock.
- **Audit:** one `webhook.deliveries_replayed` entry per endpoint that is on, as an endpoint's own
  replay writes it, marked `allEndpoints`.
- **No migration:** an endpoint's replay is now one step that both calls share.

Not built: replays across companies for staff, replays of a chosen list of endpoints.

## ADR-161 Starting an automation for many contacts in one call (P5-08) (2026-10-05)

Context: since ADR-077 a key starts an automation for one contact per call. A booking system that
sends tomorrow's reminders to 80 patients needed 80 calls, each with its own `Idempotency-Key`,
paced to stay within the key's limits (a burst of 50, then 10 a second). P5-08's Remaining listed
starting or stopping runs for many contacts in one call.

Decision:

- **Up to 50 starts in one call:** `POST /api/v1/automations/{id}/runs/start-many` takes `runs`,
  each the `to` and `inputs` a start of one run takes, at most 50, each number once; scope
  `automations.start`, an `Idempotency-Key` required, one request against the key's limits.
- **Why 50:** each run started keeps its savepoint's transaction id until the call commits.
  PostgreSQL caches 64 per transaction; beyond them, every snapshot taken anywhere while the call
  runs looks subtransactions up on disk, which slows the whole database. 50 leaves room.
- **The automation checked once, each contact on its own:** the automation's checks run once for the
  call (published, started through the API, active, its number, the marketing scope). Each start
  then takes, in the order given, the steps of a start of one run (the contact, created when new;
  erasure, suppression and opt-outs; the conversation, not held by a member or handled by another
  run; the hourly limit; the plan's runs) in a savepoint of its own.
- **Not all or none:** a start refused for its contact (409 or 412, as one start answers it) rolls
  back alone, a contact created for it included, and is answered in its place with its code, message
  and reason, while the others start. Unlike changing many conversations or contacts (ADR-120,
  ADR-122), where a refusal means a mistake in the call, such a refusal is a fact about one contact
  that asking again does not change; refusing the other starts for it would only make the caller
  send them again without it.
- **Refused as a whole, starting nothing:** a number that is not valid or given twice (before
  anything is read) and inputs the automation does not take (422, naming the place, as
  `runs.3.inputs`); an automation that cannot start (404, 412); a plan without automations (403).
- **The answer:** 200 with each number, as normalised, and its run or its refusal, in the order
  given; a retry with the same key answers as the first call did and starts nothing more.
- **Records as one start's:** each run records its key and inputs, with its first step, the live
  `automation.started` event, an audit entry as the key and its first job.
- **Concurrent starts:** the call is one transaction. Until it ends it keeps each conversation it
  starts a run in and, on a plan with a monthly run limit, the company's run count from its first
  start, while every other start takes a conversation before the count. A run starting at the same
  moment for a contact further down the list (a customer's message, another call) can therefore
  deadlock with the call. PostgreSQL ends one of the two; when it ends the call, the call is refused
  as a whole (409, starting nothing) and can be sent again with the same `Idempotency-Key`.
- **No migration:** a start of one run is now four steps that both calls share.

Not built: stopping runs for many contacts in one call, starting many automations in one call.

## ADR-162 Stopping many runs in one call (P5-08) (2026-10-05)

Context: since ADR-079 a key stops one run per call. An integration that started an automation for
many contacts in one call (ADR-161) and then calls them off (the appointments moved, the offer was
withdrawn) needed one call per run. P5-08's Remaining listed stopping runs for many contacts in one
call.

Decision:

- **Up to 100 runs in one call:** `POST /api/v1/automation-runs/stop-many` takes `runIds`, 1 to 100,
  each once; scope `automations.start`, one request against the key's limits, and no
  `Idempotency-Key`: a run that has ended stays as it is, so a retry answers the same.
- **Each as one stop:** each run is stopped through the step `POST /automation-runs/{id}/stop` uses
  (ADR-079): a running or waiting run ends as `stopped` with the reason `stopped_by_api`, with its
  step and an audit entry as the key, and a run that has ended is answered as it is.
- **All of them or none:** an id that names no run a key of the company started (another company's,
  one customers started by writing, one that does not exist) refuses the call (422, naming the
  place, as `runIds.3`) before anything is locked, and nothing is stopped. Unlike ADR-161's starts,
  such an id is a mistake in the call, so it is refused as changing many conversations refuses one
  (ADR-120).
- **Locks:** the runs' conversations are locked in id order in one statement, as ADR-120 locks them,
  then each run in the order given, so calls stopping the same runs take turns. Stopping counts
  nothing against the plan, so no shared counter is held across runs.
- **100, not 50:** nothing is answered in place, so the call opens no savepoint per run and the
  subtransaction limit behind ADR-161's 50 does not apply.
- **The answer:** 200 with each run as it now is, in the order given.
- **No migration:** the single stop and this call share one step.

Not built: stopping every run of an automation, or of a contact, without listing them.

## ADR-163 Sending a template to many numbers in one call (P5-08) (2026-10-05)

Context: a key sends an approved template to one number per call (ADR-052). An integration that
tells many customers the same thing at once (a delay on every order of a route, the day's
appointment reminders) needed one request per number, each against the key's rate limit. P5-08's
Remaining listed bulk sends in one call.

Decision:

- **One template, up to 50 numbers:** `POST /api/v1/messages/send-many` takes `templateId`, an
  optional `from` and `messages`, 1 to 50, each a number (`to`) with the values of the template's
  variables; the scopes of one send (`messages.send`, and `messages.send_marketing` for a marketing
  template), once per `Idempotency-Key`, and one request against the key's limits.
- **Each as one send:** the template (the company's, approved, one HyFib can send), every send's
  values and the number sent from are checked once for the call; then each number is sent to through
  the steps a send to one number takes (`queueTemplateFor`): the contact, created when new; erasure,
  the suppression list and consent for the template's category; the marketing frequency cap; then
  the message, its send intent and its job, which the send pipeline delivers as any API send,
  checking consent again before dispatch.
- **Refusals in place:** each send runs in a savepoint (`tx.transaction`). A refusal for its contact
  (`precondition_failed`: erased, opted out, on the suppression list, without the marketing opt-in
  the company asks for, or at the frequency cap) rolls back to it, a contact created for it
  included, and is answered in its place with its code and message while the others are sent;
  anything else refuses the call.
- **Refused as a whole, before any send:** a number that is not valid or is given twice (before
  anything is read), and values that do not fill the template's variables, naming the place
  (`messages.2.to`, `messages.1.variables`); a template or a WhatsApp number that cannot send, as
  for one send.
- **50 per call,** as ADR-161: each send keeps its savepoint's transaction id until the call
  commits, and PostgreSQL caches 64 per transaction.
- **One lock order:** a marketing template is counted under the campaign runner's company lock
  (ADR-049), which the call takes once, before any contact is created or conversation locked. A send
  to one number now takes it at the same point, before creating the contact (it took it after), so
  the two wait for each other instead of deadlocking over a new number both create.
- **Collisions:** the call keeps the conversations it sends in from its first send until it commits.
  Another call taking several of them in another order at the same moment (another send to many
  numbers, a start of many runs, a change of many conversations) can deadlock with it; PostgreSQL
  ends one of the two, and when it is this call, it is refused as a whole (409, sending nothing) and
  can be sent again with the same key. The operation documents it.
- **The answer:** 200 with each number in the order given, in E.164: its message, queued, as a send
  to one number answers it, or its refusal. Messages queued together may leave in any order, as
  messages queued one after the other may.
- **One implementation:** the single send and this call share the template, variables, number, lock
  and queueing steps; this call and the start of many runs (ADR-161) share the checks of a list's
  numbers (`phoneAt`, `assertEachNumberOnce`).
- **No migration.**

Not built: different templates in one call, reasons beside a refusal's message, more than 50 numbers
per call, and a send to every contact of a segment through the API (campaigns do that, with approval
and pacing).

## ADR-164 Groups of conditions in contact searches through the API (P5-08) (2026-10-05)

Context: `POST /contacts/search` (ADR-117) finds the contacts matching all of its conditions or any
of them. A question mixing the two (VIPs who are in Pune or have more than six orders; contacts
added this month who opted in to marketing or wrote in the last week) needed two searches merged by
the caller, or a broader search filtered afterwards. ADR-117's Not built listed groups of
conditions.

Decision:

- **Groups as conditions:** an item of `conditions` can be a group,
  `{ "type": "group", "match": "all" | "any", "conditions": [...] }`, which a contact matches when
  it matches all of the group's conditions, or any of them; the search joins its items, groups
  included, by its own `match`. "All of these and any of those" is a search matching all, with a
  group matching any.
- **One level:** a group holds conditions, not groups. Two levels say every mix of all and any that
  a person says in a sentence; a group inside a group is refused by the body's shape (422).
- **20 conditions in all,** counted inside groups too, as a search held before; a group holds 1 to 20. ADR-117's windows still bound what a page reads.
- **A group says its `match`:** it has no default, unlike the search's, which stays `all` for
  searches written before groups.
- **The same rules inside groups:** a condition in a group is checked and compiled as one outside it
  (segments' rules, then `segmentConditionsSql`); a group is compiled as a segment with its own
  `match`. A refusal names its place in the group, like `conditions.2.conditions.0.key`, and a
  `last_message` or `campaign` condition in a group needs its scope as one outside does, checked
  before anything is read.
- **Segments are unchanged:** members' segments and campaigns keep one list, matched all or any, so
  a search through the API can say more than a segment.
- **No migration.**

Not built: groups in segments, groups inside groups, the opposite of a group (most conditions have
their own, like `not_has` and `not_within_days`), counting the matches, and orders other than newest
first.

## ADR-165 Changing the contacts a search finds, a page at a time (P5-08) (2026-10-05)

Context: a key finds contacts with segments' conditions (ADR-117, ADR-164) and changes up to 100
contacts it names in one call (ADR-122). Tagging every contact in Pune, or setting a field for
everyone who opted in to marketing, meant reading the search page by page and sending each page's
ids back to change them: twice the calls, and a contact changed in between by someone else was
changed as the search had found it. P5-08's Remaining listed choosing contacts to change by a
filter.

Decision:

- **Endpoint:** `POST /api/v1/contacts/update-matching` (`updateMatchingContacts`) takes a search's
  `match` and `conditions` (groups included), a `change`, and a page: `limit` (1 to 100, 50 by
  default) and `cursor`. The change holds custom field values (`fields`) and tags (`addTags`,
  `removeTags`), at least one, the same for every contact; names and emails are a contact's own and
  are not set for many at once.
- **Both contact scopes:** `contacts.read` and `contacts.write`. The call finds contacts as a search
  does and answers them, so a key that may only write contacts cannot use it to read the company's
  contacts. `last_message` and `campaign` conditions need their scopes, as in a search, and
  `contacts.write`, a writing scope, is refused while the company is suspended or restricted.
- **A search page, changed:** each call reads one page as `POST /contacts/search` reads it (newest
  first, in windows of 2,000, on exact keyset pages) and changes each of its contacts as
  `PATCH /contacts/{id}` changes one, with the locks changing many contacts takes (ADR-122: the
  fields' definitions shared, the contacts `FOR UPDATE` in id order), an audit entry as the key and
  `contact.updated` for each contact the change changes. It answers the page's contacts as they now
  are, with the next cursor.
- **One snapshot:** the page is read and changed in one repeatable read transaction, so the change
  reaches exactly the contacts the page found. A contact someone else changed after the page was
  read refuses the call (409, changing nothing), and it can be sent again with the same cursor.
- **Pages follow the conditions as they are:** a contact the change takes out of the search is not
  read again (the cursor has passed it).
- **All or none in a call:** a field the company does not have, a value of another type, or a
  contact the change would give more than 50 tags refuses the call (422, naming the part, as
  `change.fields.plan`).
- **No `Idempotency-Key`:** what a contact already has changes nothing, and a contact the change took
  out of the search is not found again, so a call sent again after a lost answer is safe: the pages
  still reach every contact the search finds, each changed once. A call counts as one request.
- **No migration.**

Not built: names and emails for many contacts, consent for many contacts (consent needs each
contact's evidence), erasing the contacts a search finds, counting the contacts a change would
reach, and every page in one call.

## ADR-166 Changing the conversations a filter finds, a page at a time (P5-08) (2026-10-05)

Context: a key lists conversations by status, contact, number, member, team and time of change
(ADR-072, ADR-093) and changes up to 100 conversations it names in one call (ADR-120). Resolving
every open conversation of a team, or handing a member's conversations to another, meant listing
them page by page and sending each page's ids back: twice the calls, and a conversation changed in
between by someone else was changed as the list had found it. P5-08's Remaining listed choosing
conversations to change by a filter; ADR-165 did it for contacts.

Decision:

- **Endpoint:** `POST /api/v1/conversations/update-matching` (`updateMatchingConversations`) takes
  `filter`, the filters of `GET /conversations` (`status`, `contactId`, `channelId`, `assigneeId`
  and `teamId`, these two with `none`, and `updatedSince`), at least one, so that no call changes
  every conversation by mistake; `change`, any of `status`, `assigneeId` and `teamId` as
  `PATCH /conversations/{id}` takes them, the same for every conversation; and a page: `limit` (1 to
  100, 50 by default) and `cursor`.
- **Both conversation scopes:** `conversations.read` and `conversations.write`. The call finds
  conversations as the list does and answers them, so a key that may only change conversations
  cannot list them through it; `conversations.write`, a writing scope, is refused while the company
  is suspended or restricted.
- **A page of the list, changed:** each call reads one page as `GET /conversations` reads it (newest
  first, on exact keyset pages, erased contacts' conversations left out) and changes each of its
  conversations as `PATCH` changes one, in that order (a team that assigns in turn gives them out in
  it), with the locks changing many conversations takes (ADR-120): the member first, then the page's
  rows `FOR UPDATE` in id order, the team as a conversation moves into it. It answers the page's
  conversations as they now are, with the next cursor.
- **The filter checked again under the locks, not one snapshot:** unlike ADR-165, the call runs read
  committed, as every change of a conversation does. Routing, which a move into a team runs, takes
  the company's routing lock and then counts each member's open conversations; a snapshot taken
  before that lock would count without the conversations given out meanwhile and could push a member
  past the team's limit. Instead the page's rows are locked with the filter again: a conversation
  someone else took out of the filter after the page was read is left out (a page can then hold
  fewer conversations than the limit while more follow), and one that still matches is changed as it
  now is.
- **Refused before the page is read:** a member who cannot answer conversations or a team that is
  not the company's refuses the call (422, `change.assigneeId` or `change.teamId`), even when
  nothing matches. The member is locked for share then, as `update-many` locks it; the team is only
  read (teams are locked after conversations, as a team's deletion takes them) and locked as a
  conversation moves into it.
- **409 when routing crosses a move:** routing's sweeps take the routing lock before a
  conversation's row, and a move into a team takes the rows first, so a call moving conversations
  into a team while routing hands one of them out can be refused as a whole (409, changing nothing)
  and sent again with the same cursor. `PATCH` and `update-many` meet the same refusal; their
  descriptions now say so too.
- **No `Idempotency-Key`:** what a conversation already has changes nothing, and one the change took
  out of the filter is not found again, so a call sent again after a lost answer is safe: the pages
  still reach every conversation the filter finds, each changed once. A call counts as one request.
- **No migration.**

Not built: filters `GET /conversations` does not have (such as the time of the last message),
counting the conversations a change would reach, every page in one call, and notes for many
conversations.

## ADR-167 Reading WhatsApp orders through the public API (P5-08) (2026-10-05)

Context: customers send carts from the company's WhatsApp catalog as orders (M-170); members
confirm, fulfil or cancel them and ask for payment with a Payment Link (ADR-046). Order systems hear
each order and each change through `order.received` and `order.status_changed` (ADR-085) but could
not read orders: a missed delivery, a new integration or a nightly reconciliation had no way to list
them. ADR-085 left reading orders through the public API unbuilt.

Decision:

- **A new reading scope, `orders.read`** ("Read WhatsApp orders"), granted with `commerce.read`, the
  permission members read orders with; only owners and administrators create keys, and both hold it.
  It only reads, so it works while the company is suspended or restricted, as every reading scope
  does. Existing keys keep their scopes, and a plan version that chose its scopes (ADR-092) leaves
  it out until a new version includes it.
- **Commerce in the plan:** orders are Commerce's, so a plan without it reads none (403, reason
  `not_in_plan`), as it sends no products (ADR-086); checked first in the transaction.
- **Endpoints:** `GET /api/v1/orders` (`listOrders`) pages the company's orders newest first by when
  they were received, on exact keyset pages (`commerce_orders_list_idx`), filtered by `status`,
  `contactId`, `conversationId`, `reference` (the eight capitals members and customers quote) and
  `updatedSince`; `GET /api/v1/orders/{id}` (`getOrder`) reads one. Another company's order and an
  unknown id answer 404, and an id that is not a UUID is refused before any query.
- **An order as the webhook describes it, with ids only:** reference, status and when it last
  changed; the conversation, contact, number and order message by id; the Meta catalog; the
  currency, subtotal and each item's content id, name, quantity and unit price, amounts as integers
  in minor units (null where HyFib could not work them out); the items left out; the customer's
  note; when it was received, paid and last changed. Not the customer's number or name, which a key
  reads with `contacts.read`, and never the Payment Link or Razorpay's payment ids, which the
  company's Razorpay account reports itself.
- **Erased contacts:** orders are kept until the company is deleted (ADR-085), so an erased
  contact's orders are still read, without the note erasure clears; their contact id names a contact
  the API no longer finds.
- **Reads only:** one read-only transaction per call. Items are written with their order and never
  change, so they are read beside it without a shared snapshot. A call counts as one request.
- **Migration 0115** replaces the key and plan scope checks with ones that also accept
  `orders.read`, validated at once (one row per key and per plan version), as 0100 did.

Not built: changing orders through the API (confirming, fulfilling, cancelling, asking for payment),
store orders (the Shopify and WooCommerce copies, which the store reports itself), Payment Links,
refunds and order reports.

## ADR-168 Confirming, fulfilling and cancelling WhatsApp orders through the public API (P5-08) (2026-10-05)

Context: since ADR-167 order systems read the orders customers send from the company's WhatsApp
catalog, but moving an order on (confirming it, marking it fulfilled when it ships, cancelling it)
still needed a member on the order page, so an order system that ships or cancels orders had to ask
someone to click. ADR-167 left changing orders through the public API unbuilt.

Decision:

- **A new writing scope, `orders.write`** ("Confirm, fulfil and cancel WhatsApp orders"), granted
  with `inbox.reply`: members change an order's status with `inbox.reply` and `commerce.read`, and
  every role with the first has the second (unit-tested); owners and administrators, who create
  keys, have both. Like every writing scope it is refused while the company is suspended or
  restricted (423). Existing keys keep their scopes, and a plan version that chose its scopes
  (ADR-092) leaves it out until a new version includes it.
- **Commerce in the plan**, checked first in the transaction, as for reading orders (403, reason
  `not_in_plan`).
- **`PATCH /api/v1/orders/{id}`** (`updateOrder`) takes `status` (`confirmed`, `fulfilled` or
  `cancelled`) and, if wanted, `expectedStatus`, and answers the order as `GET /orders/{id}` gives
  it. The moves are the ones members make (`MEMBER_ORDER_TRANSITIONS`): a received order is
  confirmed or cancelled, a confirmed one fulfilled or cancelled, a paid one fulfilled. Any other
  move is refused with 409, naming the order's status, and so is an order not in `expectedStatus`;
  nothing changes. Payment statuses come only from Razorpay (ADR-046): an order waiting for payment
  is refused, as members cancel its Payment Link first (the order goes back to confirmed when the
  link ends unpaid), and a paid order is never cancelled.
- **Retries:** an order that already has the status asked for is answered as it is, whatever
  `expectedStatus` says, with no new version, audit entry or event, so a call sent again after a
  lost answer needs no `Idempotency-Key`. A call counts as one request.
- **One write for members and keys:** the order's row is locked (`FOR UPDATE`, as members' changes
  lock it), the move checked under the lock, and the status written by `writeLockedOrderStatus`
  (`commerce/service.ts`), which members' changes now use too: the time of the change and the next
  version, so a member's page opened before a key's change is refused as stale (an integration test,
  run in CI). The table's trigger captures `order.status_changed` with the status before it
  (ADR-085), as for a member's change; the audit entry `commerce.order_status_changed` names the key
  (`api_key`) with `source: 'api'`. Nothing is sent to the customer, as for members.
- **Another company's order** and an unknown id answer 404, and an id that is not a UUID is refused
  before any query.
- **Migration 0116** replaces the key and plan scope checks with ones that also accept
  `orders.write`, as 0115 did.

Not built: asking for payment or cancelling a Payment Link through the API, refunds, changing many
orders in one call, a reason or note with the change, `order.status_changed` naming who changed the
order, and store orders.

## ADR-169 Acknowledging dead letters on the operations console (P5-10) (2026-10-05)

Context: every platform administrator is emailed about each dead letter (ADR-091), and Operations →
Queues lists the latest 100 with a Retry for the jobs that can be sent back once (ADR-108). Many
need no retry: the work is obsolete, the company started it again, or the sweep ended it for the
company (ADR-111). Nothing on the tab said that someone had already looked at a dead letter or what
they found, so every administrator who read the email opened the same rows. ADR-141 left
acknowledging the console's other lists unbuilt.

Decision:

- **Acknowledged with a note:** on Recent dead letters, a platform administrator acknowledges a dead
  letter with a note of 10 to 500 characters (what was found or done), retried or not. The row shows
  who acknowledged it, when, and the note; another administrator may acknowledge it again, replacing
  the note. The platform audit log keeps each (`platform.dead_letter_acknowledged`, the note as its
  reason, the dead letter and its queue in the metadata, and the company only when the job's
  signature verified and the company still exists, as the console names it, ADR-054).
- **Kept with the dead letter:** the time, the administrator and the note are columns of
  `ops.dead_letters` (migration 0117), set together or not at all, so an acknowledgement lasts as
  long as its dead letter: 30 days after the job failed (ADR-054's purge). A later failure of the
  same work has a dead letter of its own and starts unacknowledged. Unlike a failing integration
  (ADR-141), a dead letter does not recover, so nothing forgets an acknowledgement sooner.
- **Where it is enforced:** `ops.platform_acknowledge_dead_letter` (SECURITY DEFINER, executable by
  the platform role only) checks the administrator, the note (trimmed) and the dead letter, then
  writes the columns and the audit entry in one transaction. Only the definer role writes the
  columns; the platform role reads them with the rest of the row, as the console already read dead
  letters. The company never sees them.
- **Nothing else changes:** acknowledging neither retries the job nor changes whether it can be
  retried, and the alert email (ADR-091) still tells each dead letter once, before anyone could
  acknowledge it.
- **The CSV** of Recent dead letters (ADR-158) gains "Acknowledged (UTC)": when, never who or the
  note, as for failures.

Not built: acknowledging quarantine entries (late queues: built by ADR-177; receipts: built by
ADR-179); assigning a dead letter to someone; filtering the list by acknowledgement; deleting a note
(a new acknowledgement replaces it).

## ADR-170 Choosing the WhatsApp numbers whose events a webhook endpoint receives (P5-09) (2026-10-05)

Context: an endpoint receives the events of every WhatsApp number its company has. A company with a
number per shop, brand or team often has a receiver per number (each shop's helpdesk, each brand's
CRM), and every receiver was sent every number's messages, conversations, runs, orders and
campaigns, read the number in each payload (`channel.id`) and dropped the rest. ADR-145 left filters
by channel unbuilt.

Decision:

- **What an endpoint chooses:** `channelIds`, null for every number's events (as before, including
  numbers connected later), or 1 to 100 of the company's numbers (channel accounts), in the order
  given with repeats merged (compared in lower case), only while the endpoint takes an event that
  happens on a number: `message.received`, `message.status`, the three conversation events, both
  automation run events, both order events and `campaign.status_changed` (a campaign's events are
  those of the number it sends from). Consent, contact and template events belong to no number: an
  endpoint that names numbers still receives every one of them it takes. It is chosen in Settings →
  Webhooks under "WhatsApp numbers", shown while such an event is ticked: "Every number’s events" or
  "Only the events of the numbers ticked", from every number of the company in the order they were
  connected, each named by its number and verified name (Meta's id for it until Meta reports them)
  and marked when it is not active. The endpoint shows "Numbers whose events are sent: …". Through
  the API it is `channelIds` on `POST /webhook-endpoints` and `PATCH /webhook-endpoints/{id}` and in
  every endpoint the API answers: ids only, those messages, conversations and orders give as
  `channelId`.
- **Only the company's numbers:** each id must be a number of the endpoint's company, whatever its
  status (a disconnected number may be chosen; it has no events until it is connected again).
  Anything else is refused as `validation_failed`, the issue naming its place (`channelIds.<n>`; 422
  through the API); another company's number gets the same message as an unknown id (the lookup runs
  in the company's scope). A company's numbers are never deleted (the runtime role has no delete on
  them; a number is disconnected), so a list never names one that is gone. A list given again is
  checked again; one kept by a change is not (it was checked when it was chosen).
- **Kept with its events:** a change that removes every such event clears the list, and a list given
  without one is refused (`channelIds`). A `PATCH` that leaves it out keeps it; Settings always
  sends it. A check in the database holds the same rule (null, or 1 to 100 ids without nulls while
  one of those events is among the endpoint's). The ids are not foreign keys (an array cannot
  reference rows); the services check them as above.
- **Applied when the event is captured:** the triggers of those events (0025's for messages, 0070's
  for conversations, 0055's for runs, 0063's for orders, 0065's for campaigns) now pass the number
  of the row that changed as `channelId` in the event's detail. `app.capture_webhook_event` reads it
  and takes it out before the event is stored, so stored events and payloads are unchanged (the
  payload's `channel` is read from the row when it is delivered), and creates a delivery of such an
  event only for the active endpoints that take it, pass its other filters and whose list is null or
  holds the number. It writes no event when none takes it, as for the other filters. A campaign
  without a number yet is on no list. The capture runs in the transaction that makes the change, so
  whether a delivery exists is settled then: a change of the list applies to events captured after
  it, and deliveries already created are still sent. Replays and test events are unchanged.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `channelIds` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` choose numbers in Settings, where they
  are named and their status shown as Settings → Channels shows them; keys with `webhooks.manage`
  choose them through the API, which answers and audits ids only. Deliveries of those events already
  carry each event's number (`channel.id` and `channel.phone`) to the company's receivers.
- **Migration 0118:** `channel_account_ids uuid[]` on `app.webhook_endpoints` with the check,
  validated at once (a company has at most 10 endpoints), an update grant on the column for the
  runtime role (it inserts it with its table grant), `app.capture_webhook_event` replaced with the
  same signature (0114's, with the number condition), and the five trigger functions replaced with
  the same names, so their owners, grants and triggers stay. Existing endpoints keep null; nothing
  is backfilled.

Not built: filters by team (built by ADR-174) or by the member assigned, numbers chosen per event type (one list
applies to every event of a number the endpoint takes), and a `GET /channels` listing a company's
numbers through the API (built by ADR-171).

## ADR-171 Reading the company's WhatsApp numbers through the public API (P5-08) (2026-10-05)

Context: the public API names WhatsApp numbers by id everywhere (a message's, conversation's or
order's `channelId`, a webhook event's `channel.id`, the `channelIds` an endpoint takes since
ADR-170), and a send takes one as `from` when the company has several, but nothing listed them: a
key learned a number's id only from a template's `channels`, with `templates.read`, or from
something sent or received on it. ADR-170 left a listing unbuilt.

Decision:

- **A new reading scope, `channels.read`** ("Read WhatsApp numbers"), granted with the permission of
  the same name, with which members see the numbers in Settings → Channels (every role but billing;
  owners and administrators, who create keys, hold it). It only reads, so it works while the company
  is suspended or restricted, as every reading scope does. Existing keys keep their scopes, and a
  plan version that chose its scopes (ADR-092) leaves it out until a new version includes it. It
  comes first in the list of scopes.
- **`GET /api/v1/channels`** (`listChannels`) pages the company's numbers oldest first by when they
  were added, on exact keyset pages, whatever their status; `status` narrows them (`active` for
  those that send and receive). Each gives its id, the number and verified name WhatsApp shows (null
  until Meta reports them), its status and when it was added: never Meta's ids for the number or its
  account, the credential, the registration PIN or Meta's review fields. A company's numbers are
  never deleted, so a number listed once stays listed.
- **Reads only:** one read-only transaction per call; a call counts as one request.
- **Migration 0119** replaces the key and plan scope checks with ones that also accept
  `channels.read`, listed in the API's order, validated at once (one row per key and per plan
  version), as 0115 and 0116 did.

Not built: a number by id (`GET /channels/{id}`), the number's WhatsApp account, Meta's quality
rating, and connecting or disconnecting numbers through the API.

## ADR-172 Choosing who sent the messages whose statuses a webhook endpoint receives (P5-09) (2026-10-05)

Context: an endpoint that takes `message.status` receives the statuses of every message the company
sends: members' replies, automations' messages, campaigns, the API's sends and HyFib's own (store
order updates, satisfaction surveys). ADR-119 lets it choose the statuses, and left filters on a
message's sender unbuilt. A system that sends through the API usually wants the statuses of its own
messages only, and was sent every campaign's (thousands at a time) to read the event's
`message.sentBy` and drop.

Decision:

- **A list of senders per endpoint,** for `message.status` only: null receives the statuses of every
  message, as before; a list holds 1 to 5 of `agent` (a member), `bot` (an automation), `campaign`,
  `api` and `system` (HyFib itself), the senders the event reports as `message.sentBy`, in that
  order with repeats merged. It is chosen in Settings → Webhooks under "Message status" ("Messages
  sent by", every sender ticked to begin with; saving them all ticked keeps none) and shown on the
  endpoint as "Statuses of messages sent by: …", and through the API as `messageSenders` on
  `POST /webhook-endpoints` and `PATCH /webhook-endpoints/{id}` and in every endpoint the API
  answers.
- **Only with the event:** a list given for an endpoint that does not receive `message.status` is
  refused (`messageSenders`; 422 through the API), received messages included. A change that removes
  the event clears it, and a `PATCH` that leaves it out keeps it; Settings always sends it. A check
  in the database holds the same rule (null, or 1 to 5 known senders while the event is among the
  endpoint's; a contact, which sends no status, cannot be named).
- **Applied when the event is captured,** with the statuses an endpoint names (ADR-119) and its
  numbers (ADR-170): the trigger of message statuses (0025's, as 0118 left it) passes the message's
  sender as `sentBy` in the event's detail, named as the payload names it (anything other than a
  member, an automation, a campaign or the API is `system`), and `app.capture_webhook_event` takes
  it out with the number before the event is stored, so stored events and payloads are unchanged. A
  status's delivery is created only for the active endpoints whose list is null or holds the sender,
  and no event is written when none takes it. A change of the list applies to statuses captured
  after it; deliveries already created are still sent. Replays and test events are unchanged.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `messageSenders` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API. The list names kinds of senders only, never a member, an
  automation, a campaign or a key.
- **Migration 0120:** `message_senders text[]` on `app.webhook_endpoints` with the check, validated
  at once (a company has at most 10 endpoints), an update grant on the column for the runtime role,
  `app.capture_webhook_event` replaced with the same signature (0118's, with the sender condition)
  and the message trigger function with the same name, so owners, grants and triggers stay. Existing
  endpoints keep null; nothing is backfilled.

Not built: statuses of the messages one API key, campaign (built by ADR-185), automation or template
(built by ADR-175) sent (an endpoint chooses kinds of senders only), and a sender filter for
received messages (a contact sends them all).

## ADR-173 OAuth 2.0 client credentials for webhook endpoints (P5-09) (2026-10-05)

Context: a receiver may protect its webhook URL with OAuth 2.0 rather than a fixed key: it accepts
only requests carrying an access token its authorization server issued for the client credentials
grant (RFC 6749 section 4.4), and those tokens expire within minutes or hours. An endpoint's own
headers (ADR-118) send a fixed value, so such a receiver needed a proxy that fetched tokens; ADR-118
left other authentication schemes unbuilt.

Decision:

- **An OAuth client per endpoint, optional:** the token URL of the receiver's authorization server,
  a client ID and secret it issued, and the scope to ask for, if any. It is set in Settings →
  Webhooks ("OAuth 2.0": "Get an OAuth access token for each delivery"; on an endpoint's page the
  client is kept, changed or removed) and through the API as `oauth` on `POST /webhook-endpoints`
  and `PATCH /webhook-endpoints/{id}`; endpoints are shown and answered with the token URL, the
  client ID and the scope, never the secret. The client ID and secret are printable ASCII, up to 200
  and 500 characters, so that the HTTP Basic header stays within the 4,096 characters the egress
  client sends; the scope is space-separated values without quotes or backslashes (RFC 6749 section
  3.3), up to 500, empty for none.
- **The token URL is held to the endpoint URL's rules:** https, no credentials, port 443 or an
  unprivileged one, checked when it is saved; the token request goes through the egress client
  (public addresses only, the name resolved once and the connection pinned to it, no redirects, the
  same deadline and size limits).
- **The secret is sealed and sent only to its token URL:** sealed with the keyring, bound to the
  company and the endpoint (`webhook-oauth-secret:<company>:<endpoint>`), never shown again, logged,
  audited, exported or kept in an API key's idempotency record; the keyring sweep re-encrypts it
  (`webhook_oauth_secret`, in `ops.sealed_value_keys`). A change may leave the secret out to keep it
  only while the token URL stays the same: a new token URL needs the secret again, so whoever
  changes an endpoint without knowing the secret cannot have it sent elsewhere.
- **Tokens:** before sending an endpoint's deliveries, the worker asks the token URL for a token as
  RFC 6749 section 4.4.2 says (`grant_type=client_credentials` and the scope in a form; the client
  in an HTTP Basic header, its identifier and secret each form-encoded, section 2.3.1), and takes a
  200 holding a JSON `access_token` of type `Bearer` (any case), up to 4,000 characters of RFC
  6750's token characters, so that it cannot inject a header. Each delivery sends it as
  `Authorization: Bearer <token>`, after the endpoint's own headers. Tokens are kept in the worker
  process's memory only, never stored, logged or shown: for the company's endpoint and its client as
  configured (a changed token URL, identifier, secret or scope gets a new token), until a minute
  before `expires_in` ends and for at most a day; a token without a lifetime of more than two
  minutes serves only the deliveries sent with it. The deliveries of an endpoint that need a token
  at once share one request; a process keeps the tokens of at most 1,000 endpoints, the least
  recently used going first. A token the endpoint answers 401 to is dropped, so the next attempt
  asks for a new one.
- **A delivery without a token fails its attempt without calling the endpoint,** retried on the
  usual schedule and counting toward the endpoint's 72 hours of failures:
  `oauth_token_refused_<status>` (any answer but a 200, redirects included), `oauth_token_invalid`
  (a 200 without a usable bearer token) or `oauth_token_` and the code of a request that failed
  (`oauth_token_timeout`, `oauth_token_address_blocked`, …). Members read them in words, and
  replaying failures by kind counts them as no valid answer ("No valid answer (timeouts, connection
  errors, no access token)"). A secret the keyring cannot open ends the delivery without an attempt
  (`payload_failed`, logged with the stage `oauth`), as headers that do not open do. The lease of a
  delivery with a client covers a token request and the delivery.
- **Either tokens or an Authorization header of the endpoint's own:** a change that would leave an
  endpoint with both is refused, naming the header given or the client (`oauth`).
- **Audited:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry the token URL's host
  (`oauthTokenHost`) and, on a change, whether a new secret was given (`oauthSecretReplaced`), or
  `oauthRemoved`; never the token URL's path, the client ID or the secret. The company data export
  carries the token URL, the client ID and the scope.
- **Permissions unchanged:** members with `developer.manage` (with a recent sign-in, as adding or
  editing an endpoint needs) and keys with `webhooks.manage` for the endpoints keys added.
- **Migration 0121:** `oauth_token_url`, `oauth_client_id`, `oauth_client_secret_ciphertext` and
  `oauth_scope` on `app.webhook_endpoints`, with a check validated at once (all four null, or the
  first three set within their lengths, each named as not null, and the scope optional); update
  grants on the four columns for the runtime role; `ops.sealed_value_keys()` dropped as its owner
  and created again with the OAuth secrets. Existing endpoints have no client; nothing is
  backfilled.

Not built: other grants and client authentication (authorization code, JWT assertions,
`private_key_jwt`, mutual TLS), the client in the request body instead of HTTP Basic (RFC 6749
allows it; Basic is the method servers must support for a client with a password), token revocation,
one token shared by several endpoints, refreshing a token before it is needed, and sending a
delivery again within its attempt after a 401.

## ADR-174 Choosing the teams whose conversations' events a webhook endpoint receives (P5-09) (2026-10-05)

Context: an endpoint receives the message and conversation events of every conversation its company
has. Companies route conversations to teams (support, sales, returns), and each team often works in
a tool of its own: a helpdesk for support, a CRM for sales. Each tool was sent every team's
conversations and had to look the team up and drop the rest. ADR-170 narrows events by WhatsApp
number and left filters by team unbuilt.

Decision:

- **A list of teams per endpoint,** for the events of a conversation only: `message.received`,
  `message.status`, `conversation.status_changed`, `conversation.assignment_changed` and
  `conversation.team_changed`. Null receives every conversation's events, as before; a list holds 1
  to 50 of the company's teams, in the order given with repeats merged. It is chosen in Settings →
  Webhooks ("Teams": every conversation's events, or only those of the conversations of the teams
  ticked) and shown on the endpoint as "Teams whose conversations’ events are sent: …", and through
  the API as `teamIds` on `POST /webhook-endpoints` and `PATCH /webhook-endpoints/{id}` and in every
  endpoint the API answers.
- **Only with those events:** a list given for an endpoint that takes none of them is refused
  (`teamIds`; 422 through the API). A change that removes them clears it, and a `PATCH` that leaves
  it out keeps it; Settings always sends it. A check in the database holds the same rule (null, or 1
  to 50 ids without a null while one of the five events is among the endpoint's).
- **A conversation's team is the one it is in when the event is captured,** read from the
  conversation (after the change, for the conversation's own events), so a conversation in no team
  is on no list, and `conversation.team_changed` reaches the endpoints of the team the conversation
  left (its stored `previousTeamId`) as well as of the team it joined. Applied in
  `app.capture_webhook_event` with the endpoints' other filters; the team is read only when an
  active endpoint of the company that takes the event names teams, and no event is written when none
  takes it. Stored events and payloads are unchanged; replays and test events too. Consent, contact,
  template, automation run, order and campaign events are not narrowed: an endpoint that names teams
  still receives every one of them it takes.
- **The company's teams:** a list given now may add only teams of the endpoint's company. A team
  deleted later stays on the lists that held it (its conversations leave it first, so it matches
  nothing), and a list given again may keep it but not add it back: an endpoint's list never widens
  by itself. Settings names such a team "A deleted team"; the API answers its id.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `teamIds` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API. The choices list the company's teams by name to members with
  `developer.manage`.
- **Migration 0122:** `team_ids uuid[]` on `app.webhook_endpoints` with the check, validated at once
  (a company has at most 10 endpoints), an update grant on the column for the runtime role, and
  `app.capture_webhook_event` replaced with the same signature (0120's, with the team condition), so
  its owner and grants stay. The triggers are unchanged. Existing endpoints keep null; nothing is
  backfilled.

Not built: filters by the member a conversation is assigned to (built by ADR-181), teams for
automation run and order events (which can belong to a conversation too), and teams chosen per event
type.

## ADR-175 Choosing the templates whose message statuses and changes a webhook endpoint receives (P5-09) (2026-10-05)

Context: an endpoint that takes `message.status` receives the statuses of every message its company
sends, and one that takes `template.status_changed` the changes of every template. A receiver often
follows a few notifications only: an order system the delivery and read statuses of its order and
shipping updates, a login service those of its one-time passwords, a team that looks after some
templates their reviews. Each was sent every status and had to look the template up and drop the
rest. ADR-148 left filters by template unbuilt, and ADR-172 narrows statuses by kind of sender only.

Decision:

- **A list of templates per endpoint,** for `message.status` and `template.status_changed` only.
  Null receives every template's, as before; a list holds 1 to 50 of the company's templates, in the
  order given with repeats merged. It is chosen in Settings → Webhooks ("Templates": every message's
  statuses and every template's changes, or only those of the templates ticked, named by name and
  language) and shown on the endpoint as "Templates whose statuses and changes are sent: …", and
  through the API as `templateIds` on `POST /webhook-endpoints` and `PATCH /webhook-endpoints/{id}`
  and in every endpoint the API answers.
- **Only with those events:** a list given for an endpoint that takes neither is refused
  (`templateIds`; 422 through the API). A change that removes both clears it, and a `PATCH` that
  leaves it out keeps it; Settings always sends it. A check in the database holds the same rule
  (null, or 1 to 50 ids without a null while one of the two events is among the endpoint's).
- **A message's template is the one it was sent with** (its `template_id`, written with the message
  and never changed), so the statuses of a message sent without one, such as a member's reply or an
  automation's text, are on no list; a template's change goes by the template that changed. Applied
  in `app.capture_webhook_event` with the endpoints' other filters, to the template both triggers
  already passed; no event is written when no endpoint takes it. Stored events and payloads are
  unchanged; replays and test events too. Other events are not narrowed: an endpoint that names
  templates still receives every other event it takes.
- **The company's templates, in any status:** a list may name only templates of the endpoint's
  company, a draft or a rejected one included, so their statuses and changes can be chosen before
  approval. A template is never deleted while its company exists (one deleted at Meta or from HyFib
  keeps its row, and the messages sent with it keep referring to it), so a list never names one that
  is gone; a list given again is checked again.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `templateIds` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API. The choices list the company's templates by name and language
  to members with `developer.manage` (owners and administrators, who can read templates anyway).
- **Migration 0123:** `template_ids uuid[]` on `app.webhook_endpoints` with the check, validated at
  once (a company has at most 10 endpoints), an update grant on the column for the runtime role, and
  `app.capture_webhook_event` replaced with the same signature (0122's, with the template
  condition), so its owner and grants stay. The triggers are unchanged. Existing endpoints keep
  null; nothing is backfilled.

Not built: filters by a template's category or language, by campaign (built by ADR-185) or
automation (a list names templates, not who sent them), and templates chosen per event type (one
list serves both events).

## ADR-176 Resuming through the public API the campaigns keys paused (P5-08) (2026-10-05)

Context: since ADR-128 a key pauses a campaign, for example when a product sells out or a price
changes, but only members resume it: an integration that paused a campaign for stock had someone
resume it by hand once the stock was back. ADR-128 kept resuming with members because a resumed
campaign sends under the authority of the member who resumed it (`launched_by_user_id`, which the
runner checks before each batch), and a key is not a member.

Decision:

- **A new writing scope, `campaigns.resume`** ("Resume campaigns keys paused"), granted only by
  members holding `campaigns.send`, the permission members resume campaigns with. Existing keys gain
  nothing, and `campaigns.stop` does not resume. A plan version that chose its scopes (ADR-092)
  leaves it out until a new version includes it; one with every scope (`NULL`) includes it. As a
  writing scope it is refused while the company is suspended or restricted (423, ADR-052).
- **Only what keys paused:** `POST /campaigns/{id}/resume`, without a body, resumes a campaign whose
  pause reason is `api`. A campaign a member paused (`manual`), or HyFib paused (a cap reached, the
  template no longer approved, the number inactive, the launcher gone or no longer permitted, no
  rate card), is refused with 409 naming its `pauseReason`: members decided that pause, or fix its
  cause, in the app. A scheduled or running campaign is answered as it is, so a retry changes
  nothing; a draft, one waiting for approval, a completed or a cancelled one is refused with 409
  naming its status.
- **Under the launcher's authority:** the key lifts the pause and nothing else. The campaign keeps
  `launched_by_user_id`, so it sends under the authority of the member who launched it, as before
  the pause, and the runner keeps checking that member before each batch. The resume is refused
  (412) while that member has left or can no longer send campaigns, which the runner would answer
  with a pause of its own; a member who can resumes it in the app, under their own authority.
- **Members' checks:** the template still approved by Meta, the number active, neither cap reached
  (counted again first) and a rate card for a spending cap's currency, each refused with 412 as
  members are refused. A campaign that started runs again at once; one that never started waits for
  its scheduled time, or starts at once if that has passed. Its recipients waiting since the pause
  are queued again as it runs.
- **One implementation:** members' resume and the API's call `resumeLockedCampaign`
  (`campaigns/service.ts`) once the campaign row is locked; a member's resume puts the campaign
  under the resuming member's authority as before, and a key's leaves it. The runner's launcher
  check and the key's share `campaignLauncherStanding`. Members' resume no longer checks
  `campaigns.send` a second time for marketing templates after asserting it first (that check could
  not fail).
- **Who did it:** the `resumed` event names no member and carries the key's id in its detail
  (`apiKeyId`), and members' history names the key ("Resumed through the API, key “name”"); the
  audit row `campaign.resumed` is the key's (`api_key`), with the request's id and `source` `api`;
  `campaign.status_changed` fires from the status trigger as for members.
- **The answer** is the campaign as `GET /campaigns/{id}` describes it, without `results`. No
  idempotency key: the call answers the state the campaign is in, so repeating it changes nothing.
- **Migration 0124** replaces the key and plan scope checks with the 17 scopes (as 0119 did);
  existing rows already satisfy them.

Not built: resuming through the API what members or HyFib paused, a key as a campaign's launcher,
raising caps, approving, scheduling, creating or editing campaigns through the API (drafts: built by
ADR-186), and resuming many campaigns in one call.

## ADR-177 Acknowledging late queues on the operations console (P5-10) (2026-10-05)

Context: since ADR-096 every platform administrator is emailed once each time a queue falls behind,
and Operations → Queues shows since when. As with failing integrations (ADR-141) and dead letters
(ADR-169), nothing there said that someone had already looked at a late queue or what they found, so
every administrator who read the email opened the same tab, and two could restart the same worker or
each assume that the other had. ADR-169 left acknowledging late queues unbuilt.

Decision:

- **Acknowledged with a note:** on Job queues, a platform administrator acknowledges a queue that is
  late with a note of 10 to 500 characters (what was found or done). The queue's row shows who
  acknowledged it, when, and the note; another administrator may acknowledge it again, replacing the
  note. The platform audit log keeps each (`platform.late_queue_acknowledged`, the note as its
  reason, the queue, since when it was late and its waiting jobs in the metadata, no company).
- **While it stays late:** the time, the administrator and the note are columns of `ops.queue_waits`
  (migration 0125), set together or not at all and only while the queue is late (a check holds
  both). The worker's check that finds the queue back on time (under half its limit, as ADR-096
  decides) clears them with the alert's mark, so the next time it falls behind it starts
  unacknowledged, as it is emailed again. A page names the lateness it shows by when it began (to
  the millisecond, as the console reads it): a page left open cannot acknowledge a queue that
  recovered (409, "no longer late since then") or a later spell of the same queue.
- **Where it is enforced:** `ops.platform_acknowledge_late_queue` (SECURITY DEFINER, executable by
  the platform role only) checks the administrator, the note (trimmed) and the queue's lateness,
  then writes the columns and the audit entry in one transaction. Only the definer role writes the
  columns. Platform staff read them with the rest of the row, as the console already read it; the
  worker's table grant becomes a grant on the check's own columns, so it never reads a note.
  `ops.record_queue_waits` is created again with the same signature (dropped by its owner and
  recreated, as 0011 explains), its owner and grants restored.
- **Nothing else changes:** acknowledging neither changes whether the queue is late nor its alert:
  the email (ADR-096) still tells each spell once, before anyone could acknowledge it, and the
  overview counts late queues as before.
- **The CSV** of Job queues (ADR-158) gains "Acknowledged (UTC)" after "Staff emailed (UTC)": when,
  never who or the note, as for dead letters.

Not built: acknowledging quarantine entries (receipts: built by ADR-179), assigning a late queue to
someone, a reminder while an acknowledged queue stays late, and deleting a note (a new
acknowledgement replaces it).

## ADR-178 Template syncs asked for go first (2026-10-05)

Context: a member's "Refresh from Meta" promises statuses "within a minute", and Meta's template
webhooks (an approval, a rejection, a pause) only mark the account as asking for a sync, which the
minute sweep then queues. The sweep lists at most 100 accounts a minute, never synced first and then
the oldest sync (0005), and queued their syncs in that order; a member's refresh was queued at once
but behind every sync queued before it. With many newly connected accounts, a refresh or an approval
could wait behind syncs nobody was waiting for. Found when the template webhook test could not find
its account in the sweep's list, which the suite's shared database fills with accounts that never
synced (fixed then by reading the account's row instead).

Decision:

- **Asked for first:** `ops.template_sync_due` (migration 0126) lists the accounts asked for since
  their last sync first, oldest request first, then the rest as before, and says which they are
  (`requested`). Which accounts are due is unchanged.
- **Queued ahead:** a member's refresh, and the sweep's sync of an account asked for, are queued at
  a higher pg-boss priority (10) than routine syncs (0), and the template.sync queue fetches higher
  priorities first, so they run before syncs queued earlier. A sync already queued or running for
  the account still stands for the request (one per account, 0005), and a request made while a sync
  runs is queued by the next sweep, as before.
- **Migration 0126:** the function is created again with the new column and order (dropped by its
  owner and recreated, as 0011 explains), its owner and grant restored.

Not built: a refresh for one template rather than the account's whole list, and showing on the
Templates page when the refresh ran.

Amended (2026-10-05, found in review): the template.sync queue is exclusive, so a job sent under the
key of a sync already waiting collapses into it, and the waiting job kept its own priority: a
refresh, or the sweep's sync of an account asked for, that found a routine sync still waiting waited
at routine priority after all. Both now raise the waiting job to the priority asked for
(`JobQueue.raisePriority`: a job created or due a retry, under the account's key, never lowered; a
running job is left alone, and the next sweep queues what was asked meanwhile, as before). The
refresh raises it in its own transaction, after the account is found in the member's company; the
runtime role already writes pg-boss's tables, so there is no migration.

## ADR-179 Acknowledging webhook receipts on the operations console (P5-10) (2026-10-05)

Context: Operations → Integrations lists the Meta and Razorpay receipts that used all their attempts
or have waited too long, and every platform administrator is emailed about the first kind (ADR-091).
As for dead letters (ADR-169) and late queues (ADR-177), nothing there said that someone had already
looked at a receipt, whether its retry was pointless (a malformed body, a test account), or what was
fixed before retrying it.

Decision:

- **Acknowledged with a note:** in the receipts list, a platform administrator acknowledges a
  receipt with a note of 10 to 500 characters, retried or not. The row shows who acknowledged it,
  when, and the note; another administrator may acknowledge it again, replacing the note. The
  platform audit log keeps each (`platform.webhook_receipt_acknowledged`, the note as its reason,
  the receipt, its provider and status in the metadata, no company: a receipt is not yet a
  company's).
- **Kept with the receipt:** notes live in `ops.receipt_acknowledgements` (migration 0127), one per
  receipt, deleted with it (a foreign key that cascades), so the retention sweep's deletion of
  receipts after 90 days takes their notes too. A retried receipt keeps its note while it is listed.
  A table of its own, because the runtime role writes receipts (table grants since 0003) and must
  not write notes.
- **Where it is enforced:** `ops.platform_acknowledge_webhook_receipt` (SECURITY DEFINER, executable
  by the platform role only) checks the administrator, the note (trimmed) and the receipt, then
  writes the note and the audit entry in one transaction. Platform staff read the notes; the runtime
  and auth roles cannot read or write them.
- **Nothing else changes:** acknowledging neither retries the receipt nor changes whether it can be
  retried, and the alert email still tells each receipt that used its attempts once.
- **The CSV** of the receipts list (ADR-158) gains "Acknowledged (UTC)" as its last column: when,
  never who or the note.

Not built: acknowledging quarantine entries (they are resolved with a resolution instead), assigning
a receipt to someone, and deleting a note (a new acknowledgement replaces it).

## ADR-180 Changing a contact's typed number through the public API (P5-08) (2026-10-05)

Context: `PATCH /contacts/{id}` changes a contact's name, email, custom field values and tags
(ADR-112), never its number: a number WhatsApp gave is the contact's identity, and members change
typed numbers in the app. A CRM or shop that fixes a mistyped number (an import, a checkout form)
had a member retype it. Members' rule already tells the two apart: a contact linked to a WhatsApp
identity keeps its number, and any other contact's number can be changed to one no other contact
has.

Decision:

- **`phone` on `PATCH /contacts/{id}`,** with the country code and a leading +, as `POST /contacts`
  takes it, under the same `contacts.write` scope. It changes as members change it: a contact with a
  WhatsApp identity (it wrote to one of the company's numbers) keeps its number (412, "This number
  comes from WhatsApp and cannot be changed."); a number another contact of the company has is
  refused with 409, without naming that contact (a key may not read contacts); a number on the
  company's suppression list is refused with 412, as `POST /contacts` refuses to create a contact
  for it. A number that is not one is refused with 422 naming `phone`, before anything is read; the
  same number in another form changes nothing.
- **One call:** only `PATCH /contacts/{id}` changes numbers. Changing many contacts at once
  (ADR-122) or the contacts a search finds (ADR-165) does not take `phone`: two contacts in one call
  could swap numbers, which each check alone would not see.
- **As any change:** in the transaction that locks the contact; audited as `contact.updated` with
  `phone` among what changed, never the number; `contact.updated` webhooks name `phone` (ADR-121)
  and the contact feed lists the contact (ADR-114), from the triggers as for members. Two keys
  moving two contacts to one number at once: the unique number index refuses the second (409).
  Consent stays with the contact, as when members change a number.

Not built: numbers in calls that change many contacts (built by ADR-188), clearing a number, and
moving a WhatsApp identity to another contact.

## ADR-181 Choosing the members whose assigned conversations' events a webhook endpoint receives (P5-09) (2026-10-05)

Context: an endpoint can take the message and conversation events of chosen teams' conversations
(ADR-174), but some receivers follow members, not teams: a sales representative's own CRM, the
dashboard of a supervisor who looks after a few members, an outsourced agent's tool that should see
that agent's conversations only. Each was sent every conversation of the team or the company and had
to look the assignee up and drop the rest. ADR-174 left filters by the member a conversation is
assigned to unbuilt.

Decision:

- **A list of members per endpoint,** for the events teams narrow: `message.received`,
  `message.status`, `conversation.status_changed`, `conversation.assignment_changed` and
  `conversation.team_changed`. Null receives every conversation's events, as before; a list holds 1
  to 50 members, by the ids `GET /members` lists them by (and conversation events name them by), in
  the order given with repeats merged. It is chosen in Settings → Webhooks ("Members": every
  conversation's events, or only those of the conversations assigned to the members ticked) and
  shown on the endpoint as "Members whose conversations’ events are sent: …", and through the API as
  `assigneeIds` on `POST /webhook-endpoints` and `PATCH /webhook-endpoints/{id}` and in every
  endpoint the API answers.
- **Only with those events:** a list given for an endpoint that takes none of them is refused
  (`assigneeIds`; 422 through the API). A change that removes them clears it, and a `PATCH` that
  leaves it out keeps it; Settings always sends it. A check in the database holds the same rule
  (null, or 1 to 50 ids without a null while one of the five events is among the endpoint's).
- **A conversation's member is the one it is assigned to when the event is captured,** read from the
  conversation with its team (after the change, for the conversation's own events), so an unassigned
  conversation is on no list, and `conversation.assignment_changed` reaches the endpoints of the
  member the conversation left (its stored `previousAssigneeId`) as well as of the member it went
  to. Applied in `app.capture_webhook_event` with the endpoints' other filters, so an endpoint that
  names teams and members receives the events of those members' conversations in those teams; the
  member is read only when an active endpoint of the company that takes the event names teams or
  members, and no event is written when none takes it. Stored events and payloads are unchanged;
  replays and test events too. Other events are not narrowed: an endpoint that names members still
  receives every other event it takes.
- **Members who take conversations:** a list given now may add only members conversations can be
  assigned to: active members of the endpoint's company whose role reads and answers conversations,
  those `GET /members` lists and routing gives conversations to. A member who later leaves, is
  suspended or removed, or loses that role stays on the lists that held them: their conversations
  are released then (`conversation.assignment_changed` events, which those endpoints receive), and
  they match nothing while they hold none; a list given again may keep them but not add them back
  until they take conversations again. Settings names such a member "… (no longer takes
  conversations)". Memberships are never deleted, so a list never names one that is gone.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `assigneeIds` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API. The choices list the members conversations can be assigned to,
  by name, to members with `developer.manage` (owners and administrators, who can read members
  anyway); a refusal tells a key only whether an id it gives is such a member of its company.
- **Migration 0128:** `assignee_ids uuid[]` on `app.webhook_endpoints` with the check, validated at
  once (a company has at most 10 endpoints), an update grant on the column for the runtime role, and
  `app.capture_webhook_event` replaced with the same signature (0123's, with the member condition),
  so its owner and grants stay. The definer role already reads a conversation's member (0009). The
  triggers are unchanged. Existing endpoints keep null; nothing is backfilled.

Not built: members for automation run and order events, filters by who sent a message (a list names
whom a conversation is assigned to, not who wrote in it), and members chosen per event type.

## ADR-182 Naming the tags a `contact.updated` added and removed (P5-09) (2026-10-05)

Context: since ADR-121 a `contact.updated` names the parts its change changed, `tags` among them,
but not which tags. A receiver that keeps a list in step with a tag (a CRM segment for `vip`, a flow
it starts when `refund` is added) still had to keep a copy of every contact's tags to compare;
ADR-121 left it unbuilt. Unlike the parts, the tags cannot be told when the event is delivered: by
then the contact's tags may have changed again.

Decision:

- **`tagsAdded` and `tagsRemoved` on `contact.updated`:** the tags the change added and those it
  removed, as the contact lists them, sorted. Always given: both empty when the change touched no
  tag, or when it undid itself (a tag added and removed again in one transaction is in neither list,
  and so is one removed and added back). Null for an event captured before migration 0129, which a
  replay within the 30 days kept can send, and once the contact is erased. `contact.created` lists
  none: its contact carries its tags.
- **Net within the transaction:** still one event per contact and transaction. The tag trigger notes
  each tag on the event its transaction captured through `app.note_contact_webhook_tag`, a definer
  function that, like `app.add_contact_webhook_changes` (ADR-121), changes only an event the calling
  transaction captured, which no delivery can have read yet: adding a tag the transaction removed
  takes it off the removed list and otherwise puts it on the added list, and removing one likewise.
  A savepoint that rolls back takes back what it noted.
- **Stored, so erasure clears them:** ADR-053 keeps events to ids and non-personal facts and builds
  personal data when it delivers. Tags cannot be built then, and a tag can say something about a
  person, so they are the one exception: kept no longer than the event (30 days), sent only to the
  company's own endpoints, and cleared from every event of a contact when it is erased (in
  `app.capture_contact_webhook_event`'s erasure branch, as the definer role erasure runs as, through
  the contact events' index), so a delivery or replay after an erasure names no tag. The payload of
  an erased contact carries none either.
- **Events stay history:** the runtime role still only inserts and reads events; the definer role
  gains the update of the two columns, for the function and for erasure. A database check keeps the
  lists together, on `contact.updated` only, without a null entry or a tag in both.
- **Migrations 0129 and 0130:** 0129 adds `tags_added` and `tags_removed` with the check, added NOT
  VALID so that captures wait for its lock only briefly, the definer function, and replaces
  `app.capture_contact_webhook_event` and the tag trigger function with the same signatures, so
  their triggers and grants stay; 0130 validates the check while captures go on. Existing events
  keep null.

Not built: the tags in `GET /contact-changes` (ADR-114 merges a contact's changes), the values a
change replaced for other parts (they stay out of events), and endpoints taking the changes of
chosen tags only.

## ADR-183 Choosing what started the runs a webhook endpoint receives (P5-09) (2026-10-05)

Context: an endpoint that takes `automation.run_started` or `automation.run_ended` receives the
events of every live run, or of the automations it names (ADR-145), and of the ends it chooses
(ADR-151). A receiver often follows some runs only: a shop the runs its own calls start through the
API, a store connector those its order messages start, a chatbot dashboard the runs customers'
messages start. Each was sent every run and had to read `run.trigger` and drop the rest. ADR-145 and
ADR-151 left filters on a run's trigger unbuilt.

Decision:

- **A list of triggers per endpoint,** for both run events: `keyword`, `conversation_started`,
  `any_message`, `store_event` and `api`, the trigger the payload reports as `run.trigger`. Null
  receives every run, as before; a list holds 1 to 5 of them, kept in the order the automation
  builder lists triggers. It is chosen in Settings → Webhooks ("Runs started by": all ticked unless
  some are unticked, named as the automation pages name triggers) and shown on the endpoint as
  "Automation runs started by: …", and through the API as `runTriggers` on `POST /webhook-endpoints`
  and `PATCH /webhook-endpoints/{id}` and in every endpoint the API answers.
- **Only with a run event:** a list given for an endpoint that takes neither is refused
  (`runTriggers`; 422 through the API). A change that removes both clears it, and a `PATCH` that
  leaves it out keeps it; Settings always sends it. A check in the database holds the same rule
  (null, or 1 to 5 known triggers without a null while a run event is among the endpoint's).
  Members' test runs send no events, so `test` is not a choice.
- **Matched as captured:** the run trigger passes what started the run as `runTrigger` in the
  event's detail, and `app.capture_webhook_event` takes it out with the number and the sender before
  the event is stored (ADR-172's way), so stored events stay as they were; the payload reads the
  trigger from the run. A run's trigger is set when it starts and no role can change it, so the
  start and the end of a run always match the same endpoints' lists. Applied with the endpoints'
  other filters (automations, ends, numbers); no event is written when no endpoint takes it.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `runTriggers` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API.
- **Migration 0131:** `run_triggers text[]` on `app.webhook_endpoints` with the check, validated at
  once (a company has at most 10 endpoints), an update grant on the column for the runtime role, and
  `app.capture_webhook_event` and the run trigger function replaced with the same signatures, so
  their owners, grants and triggers stay. Existing endpoints keep null; nothing is backfilled.

Not built: filters on the key that started a run, on a store event's kind (placed, shipped,
delivered, cancelled), on a run's end reason, and triggers chosen per event (one list serves both
run events).

## ADR-184 Choosing the custom fields whose changes a webhook endpoint receives (P5-09) (2026-10-05)

Context: an endpoint can take `contact.updated` only for some parts of a contact (ADR-123), `fields`
standing for a change of any custom field. A receiver that keeps a few fields in step (a loyalty
tier its own system sets, a city for delivery zones) was sent every field's change and had to read
`changes` and drop the rest; ADR-123 left choosing fields one by one unbuilt.

Decision:

- **A list of fields per endpoint,** by key (as `GET /contact-fields` lists them): null receives
  every field's changes, as before; a list holds 1 to 50 keys (a company has at most 50 fields), in
  the order given with repeats merged. It narrows field changes only: a change of a custom field
  (`fields.<key>` in `changes`) counts for the endpoint only when its key is listed, while changes
  of the name, number, email and tags are narrowed by the parts alone. An event still names every
  part its change changed. Chosen in Settings → Webhooks ("Custom fields": every custom field's
  changes, or only those of the fields ticked, named by label and key), shown on the endpoint as
  "Custom fields whose changes are sent: …", and through the API as `contactFieldKeys` on
  `POST /webhook-endpoints` and `PATCH /webhook-endpoints/{id}` and in every endpoint the API
  answers.
- **Only while field changes are taken:** a list given for an endpoint that does not take
  `contact.updated`, or whose parts leave out `fields`, is refused (`contactFieldKeys`; 422 through
  the API), checked against the parts the endpoint keeps. A change that drops the event or `fields`
  clears it, and a `PATCH` that leaves it out keeps it; Settings always sends it. A check in the
  database holds the same rule (null, or 1 to 50 well-formed keys without a null, with
  `contact.updated` and every part or `fields`).
- **Applied at capture:** `app.capture_contact_webhook_event` creates a delivery for an endpoint
  when one of the parts the change names passes both its parts and its fields; a later change of the
  contact in the same transaction queues the endpoints it newly concerns, as before. Stored events
  and payloads are unchanged.
- **The company's fields:** a list given now may add only keys of the company's fields. A field
  deleted later stays on the lists that held it, and a list given again may keep it but not add it
  back; keys never change, so a field added later with the same key matches it again. Settings names
  a deleted field "… (deleted)"; the API answers its key.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `contactFieldKeys` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API. The choices list the company's fields by label to members with
  `developer.manage`.
- **Migration 0132:** `contact_field_keys text[]` on `app.webhook_endpoints` with the check,
  validated at once (a company has at most 10 endpoints), an update grant on the column for the
  runtime role, and `app.capture_contact_webhook_event` replaced with the same signature (0129's,
  with the field condition), so its owner and grants stay. Existing endpoints keep null; nothing is
  backfilled.

Not built: filters on a field's value (a tier becoming `gold`), fields for `contact.created`, and
fields chosen by type.

## ADR-185 Choosing the campaigns whose message statuses and changes a webhook endpoint receives (P5-09) (2026-10-05)

Context: an endpoint can take the statuses of the messages campaigns send (`sentBy` `campaign`,
ADR-172) and every campaign's changes, or those of chosen statuses (ADR-146), but not one
campaign's. A receiver that reports on some campaigns only (one market's, an agency client's) was
sent every campaign's and could not tell them apart: a message's status named its template and that
a campaign sent it, never which campaign. ADR-172 and ADR-175 left filters by campaign unbuilt.

Decision:

- **The campaign in each message status:** `message.status` payloads gain `message.campaignId`, the
  campaign that sent the message as `GET /campaigns` lists it, or null for a message no campaign
  sent. It is read from the message when the delivery is prepared (a message's campaign never
  changes), so a replay of an event captured before this change names it too.
- **A list of campaigns per endpoint,** for `message.status` and `campaign.status_changed`: null
  receives every campaign's, as before; a list holds 1 to 50 of the company's campaigns, by id, in
  the order given with repeats merged. It narrows message statuses to those of the messages a listed
  campaign sent (a message no campaign sent, such as a member's reply or an automation's, is on no
  list) and campaign changes to those of a listed campaign; other events are not narrowed. Chosen in
  Settings → Webhooks ("Campaigns": every message's statuses and every campaign's changes, or only
  those of the campaigns ticked, named by name and status), shown on the endpoint as "Campaigns
  whose statuses and changes are sent: …", and through the API as `campaignIds` on
  `POST /webhook-endpoints` and `PATCH /webhook-endpoints/{id}` and in every endpoint the API
  answers.
- **Only while one of those events is taken:** a list given for an endpoint that takes neither is
  refused (`campaignIds`; 422 through the API). A change that drops both clears it, and a `PATCH`
  that leaves it out keeps it; Settings always sends it. A check in the database holds the same rule
  (null, or 1 to 50 ids in one dimension without a null, with one of the two events).
- **Applied at capture:** the message trigger passes the message's campaign in the event's detail,
  and `app.capture_webhook_event` matches it, or the campaign a campaign's event names, against each
  endpoint's list, then takes the message's out of the detail before the event is stored, so stored
  events are unchanged. With the other filters (numbers, teams, templates, members, statuses and
  senders) an event reaches an endpoint only when it passes them all, and no event is written when
  no endpoint takes it.
- **The company's campaigns:** a list given now may hold only campaigns of the company, which are
  kept until the company is deleted, so a list never names one that is gone. Settings offers the
  company's 200 newest campaigns, whatever their status (a draft can be chosen before it starts),
  says when there are more, and keeps listing an older one the endpoint already names; the API takes
  any of the company's.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `campaignIds` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API. The choices list the company's campaigns by name and status to
  members with `developer.manage`.
- **Migration 0133:** `campaign_ids uuid[]` on `app.webhook_endpoints` with the check, validated at
  once (a company has at most 10 endpoints), an update grant on the column for the runtime role, and
  `app.capture_webhook_event` and `app.webhook_capture_message` replaced with the same signatures
  (0131's and 0120's, with the campaign), so their owners, grants and triggers stay. Existing
  endpoints keep null; nothing is backfilled.

Not built: the campaign a reply is attributed to (ADR-025) in `message.received`, filters by a
campaign's template or audience, and campaigns chosen per event type (one list serves both events).

## ADR-186 Creating and editing campaign drafts through the public API (P5-08) (2026-10-05)

Context: keys read campaigns (ADR-125) and pause, cancel and resume them (ADR-128, ADR-176), but
every campaign was made in the app: an integration that plans campaigns elsewhere (a CRM's segments,
a merchandising calendar) had a member type each one again. ADR-128 kept creating and editing with
members because a campaign sends under a member's authority, but a draft sends nothing.

Decision:

- **A new writing scope, `campaigns.write`** ("Create and edit campaign drafts"), granted only by
  members holding `campaigns.write`, the permission members create and edit drafts with (owners,
  administrators and marketers by default). Existing keys gain nothing; a plan version that chose
  its scopes (ADR-092) leaves it out until a new version includes it, and one with every scope
  (`NULL`) includes it. As a writing scope it is refused while the company is suspended or
  restricted (423, ADR-052).
- **Drafts only:** `POST /campaigns` creates a draft with the settings given, and
  `PATCH /campaigns/{id}` changes the settings given and keeps the others. The settings are those of
  members' editor: the name, the number (`channelId`), the template, its variables, the audience (a
  segment, or conditions as a segment holds them: `POST /contacts/search`'s conditions without
  groups), the schedule (now, or a date and time in a time zone), the daily window, the rate, the
  message cap, the spending cap and the sending period. Settings left out of a new draft start as a
  member's new draft does: none, at once, in the company's time zone, sending for 24 hours.
  Submitting, approving and starting stay with members, under the authority of a member allowed to
  send campaigns and with every check a submission makes; a campaign that is no longer a draft is
  refused with 409 naming its status.
- **Members' checks, one implementation:** members' save and the API both call
  `prepareCampaignDraft` (the time zone, window, variables, date and time, and spending cap) and
  then `writeLockedCampaignDraft` on the locked draft (the company's number, template and segment, a
  segment not archived, and conditions by segments' rules), in `campaigns/service.ts`; members' save
  keeps its checks and their order.
- **Versions:** every change raises the draft's version, members' and keys' alike. `PATCH` takes an
  optional `expectedVersion`: given, a draft changed since (by a member or another key) is refused
  with 409 and keeps its settings; left out, the change applies to the draft as it is. Members' save
  compares the version they loaded, as before, so a key's change between a member's load and save is
  reported to the member.
- **Answers:** both calls answer the campaign as `GET /campaigns/{id}` describes it, with `version`
  and `settings` (as members' editor holds them: the date and time as YYYY-MM-DDTHH:mm, the window
  as HH:MM, the spending cap in major units). `GET /campaigns/{id}` answers both to a key that also
  holds `campaigns.write`, and null for both to a key that only reads campaigns, which still gets
  counts only (ADR-125: no audience, variables, pacing or costs).
- **Who did it:** a key's draft has no creator (`created_by_user_id` null); its `created` and
  `edited` campaign events name no member and carry the key's id (`apiKeyId`), so members' history
  reads "through the API, key “name”"; the audit rows `campaign.created` and `campaign.updated` are
  the key's (`api_key`), with the request's id and `source` `api`.
- **Retries:** `POST` takes an optional `Idempotency-Key` (one draft per key: a retry answers the
  first draft); `PATCH` sets values, so a retry sets the same settings again and raises the version.
- **Migration 0134** replaces the key and plan scope checks with the 18 scopes (as 0124 did);
  existing rows already satisfy them.

Not built: submitting, approving, scheduling or starting campaigns through the API (a key is not a
member), cancelling drafts (built by ADR-187) or deleting them, test sends, a draft's review (the
audience breakdown and the cost estimate) through the API (built by ADR-193), and creating many
drafts in one call.

## ADR-187 Cancelling campaign drafts through the public API (P5-08) (2026-10-05)

Context: since ADR-186 keys create and edit drafts, but a draft a key made by mistake (a duplicate,
a promotion called off) stayed for a member to cancel: `POST /campaigns/{id}/cancel` refused drafts
(ADR-128), because only members wrote them.

Decision:

- **Drafts with `campaigns.write`:** `POST /campaigns/{id}/cancel` cancels a draft for a key holding
  `campaigns.write`, whoever wrote the draft, as members cancel drafts with the permission of that
  name (and anything else with `campaigns.send`). Everything else it cancels still needs
  `campaigns.stop`: a key holding only `campaigns.write` is refused any other campaign with 403
  naming `campaigns.stop`, and a key holding only `campaigns.stop` is refused a draft with 409
  naming its status, as before. A cancelled or completed campaign is answered as it is to a key with
  either scope, so a retry is harmless.
- **Checked before anything is read:** the key must hold one of the two scopes within the company's
  plan, and, both being writing scopes, the company must be active (423 otherwise); the campaign is
  then locked in the key's company.
- **As members cancel it:** `cancelLockedCampaign`, which members' cancel calls too (a draft has no
  recipients or sends to cancel); the `canceled` event names no member and carries the key's id,
  members' history names the key, the audit row `campaign.canceled` is the key's with `source`
  `api`, and `campaign.status_changed` reports the change.
- **No migration.**

Not built: deleting drafts (a cancelled draft is kept, as members' are) and cancelling many
campaigns in one call.

## ADR-188 Changing typed numbers in calls that change many contacts (P5-08) (2026-10-05)

Context: ADR-180 lets `PATCH /contacts/{id}` change a number typed for a contact and kept numbers
out of `POST /contacts/update-many` (ADR-122): two contacts in one call could swap numbers, which
each contact's check alone would not see. A CRM or shop fixing the numbers an import or a checkout
form mistyped still made one request per contact, each counted against its limits, and a failure
halfway left some fixed.

Decision:

- **`phone` on each contact of `POST /contacts/update-many`,** as `PATCH /contacts/{id}` takes it,
  under the same `contacts.write` scope, all of them or none, as the call's other changes. A number
  changes as members change it (ADR-180): a contact whose number WhatsApp gave keeps it (412), a
  number on the company's suppression list is refused (412), and a number another contact has is
  refused with 409, without naming that contact.
- **Never swapped or moved within a call:** every new number is checked after the contacts are
  locked and before the first change is written, against the numbers contacts have before the call.
  A number one of the call's own contacts has is therefore another contact's, whatever the order,
  even when that contact is given another number in the same call, so a call never swaps two
  contacts' numbers or moves one from a contact to another; that takes separate calls, each checked
  on its own. A number given to two contacts of the call, in any form, is refused with 422 before
  anything is read ("Give each number once.").
- **The refusal names its place:** the 409 and 412 carry `issues` with `contacts.<index>.phone` (a
  bad number is refused with 422 naming the same place), so the integration knows which contact to
  fix; nothing in the call is changed. `PATCH /contacts/{id}`'s answers are unchanged.
- **The same change for many contacts** (`POST /contacts/update-matching`, ADR-165) still takes no
  number: one number cannot go to many contacts.
- **As any change:** each contact through `changeLockedContact`, in the order given; audited as
  `contact.updated` with `phone` among what changed, never the number; `contact.updated` webhooks
  name `phone` (ADR-121) and the contact feed lists the contact (ADR-114). Two calls giving one
  number to two contacts at once: the unique number index refuses the second (409), as for `PATCH`.
- **No migration.**

Not built: swapping numbers in one call (a contact needs a free number first), numbers in the same
change for many contacts, clearing a number, and moving a WhatsApp identity to another contact.

## ADR-189 Choosing the consent changes a webhook endpoint receives (P5-09) (2026-10-05)

Context: an endpoint that takes `consent.changed` receives every opt-in and opt-out the company
records, for both purposes, whatever recorded it (a keyword, a member, an import, Meta, a key, a
store, an erasure). A receiver often wants some of them only: a mailing tool kept in step with
marketing opt-outs, a compliance log of utility opt-ins and opt-outs. Each was sent every change and
had to read `purpose` and `action` and drop the rest. ADR-119 to ADR-185 built such filters for
other event types; consent changes had none.

Decision:

- **A list of consent changes per endpoint,** for `consent.changed` only: `marketing_opt_in`,
  `marketing_opt_out`, `utility_opt_in` and `utility_opt_out`, the event's `purpose` and `action`
  together, so any mix can be chosen. Null receives every change, as before; a list holds 1 to 4 of
  them, kept marketing first, opt-in before opt-out. It is chosen in Settings → Webhooks under
  "Consent changed" ("Consent changes sent": all ticked unless some are unticked; saving them all
  ticked keeps none) and shown on the endpoint as "Consent changes sent: …", and through the API as
  `consentChanges` on `POST /webhook-endpoints` and `PATCH /webhook-endpoints/{id}` and in every
  endpoint the API answers.
- **Only with the event:** a list given for an endpoint that does not take `consent.changed` is
  refused (`consentChanges`; 422 through the API). A change that removes the event clears it, and a
  `PATCH` that leaves it out keeps it; Settings always sends it. A check in the database holds the
  same rule (null, or 1 to 4 known changes, one dimension, without a null, while `consent.changed`
  is among the endpoint's events).
- **Matched as captured:** `app.capture_webhook_event` creates a `consent.changed` delivery only for
  the active endpoints whose list is null or holds the change, read from the purpose and the action
  the consent trigger has always stored in the event's detail (ADR-053), and writes no event when no
  endpoint takes it. An erasure's opt-outs (both purposes) go through the same filter. Other events
  are not narrowed; replays and test events are unchanged.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `consentChanges` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API.
- **Migration 0135:** `consent_changes text[]` on `app.webhook_endpoints` with the check, validated
  at once (a company has at most 10 endpoints), an update grant on the column for the runtime role,
  and `app.capture_webhook_event` replaced with the same signature, so its owner and grants stay.
  Existing endpoints keep null; nothing is backfilled.

Not built: filters on what recorded a change (its source: a keyword, a member, an import, Meta, a
key, a store or an erasure), on the contact's other consent, and for `contact.created` (by where the
contact came from: built by ADR-190), `contact.erased` and `order.received`.

## ADR-190 Choosing where the added contacts a webhook endpoint receives came from (P5-09) (2026-10-05)

Context: an endpoint that takes `contact.created` receives every contact the company adds, wherever
it came from: a customer writing on WhatsApp, a member in the app, a CSV import, an API key, a
store's customer. An integration that adds contacts itself through the API was sent each of them
back and had to recognise its own, or risk adding them again; a receiver that follows people who
wrote on WhatsApp was sent every import. ADR-123 and ADR-189 left filters for `contact.created`
unbuilt.

Decision:

- **A list of sources per endpoint,** for `contact.created` only: `whatsapp`, `manual`, `import`,
  `api` and `store`, the source the payload reports as `contact.source`. Null receives every
  contact, as before; a list holds 1 to 5 of them, kept in that order. It is chosen in Settings →
  Webhooks under "Contact added" ("New contacts sent, by where they came from": all ticked unless
  some are unticked; saving them all ticked keeps none) and shown on the endpoint as "New contacts
  sent: …", and through the API as `contactSources` on `POST /webhook-endpoints` and
  `PATCH /webhook-endpoints/{id}` and in every endpoint the API answers, whose description advises
  leaving out `api` not to hear of the contacts the integration's own keys add.
- **Only with the event:** a list given for an endpoint that does not take `contact.created` is
  refused (`contactSources`; 422 through the API). A change that removes the event clears it, and a
  `PATCH` that leaves it out keeps it; Settings always sends it. A check in the database holds the
  same rule (null, or 1 to 5 known sources, one dimension, without a null, while `contact.created`
  is among the endpoint's events).
- **Matched as captured:** `app.capture_contact_webhook_event` creates a `contact.created` delivery
  only for the active endpoints whose list is null or holds the contact's source, read from the
  contact (the trigger runs after the insert, so the row is there) and only when an active endpoint
  of the company names sources. A contact's source is set when it is added and never changes. The
  event is still written when an endpoint takes `contact.created` or `contact.updated`, so changes
  later in the same transaction fold into it as before, reaching no endpoint the source left out;
  later changes are `contact.updated` events, which the list does not narrow, nor `contact.erased`.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `contactSources` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API.
- **Migration 0136:** `contact_sources text[]` on `app.webhook_endpoints` with the check, validated
  at once (a company has at most 10 endpoints), an update grant on the column for the runtime role,
  and `app.capture_contact_webhook_event` replaced with the same signature, so its owner and grants
  stay. Existing endpoints keep null; nothing is backfilled.

Not built: filters on which key added a contact (one integration's key among several), on the source
for `contact.updated` and `contact.erased`, and filters for `order.received`.

## ADR-191 Choosing the types of the received messages a webhook endpoint receives (P5-09) (2026-10-05)

Context: an endpoint that takes `message.received` receives every message customers send, or those
its numbers, teams and members keep (ADR-170, ADR-174, ADR-181), whatever its type. A receiver often
handles some kinds only: a chatbot answers text and taps on its buttons and lists, an order system
takes carts, an archive keeps documents and photos. Each was sent every reaction, sticker and
account notice and had to read `message.type` and drop the rest.

Decision:

- **A list of types per endpoint,** for `message.received` only: `text`, `image`, `video`, `audio`,
  `document`, `sticker`, `location`, `contacts`, `interactive` (taps on reply buttons and list
  rows), `button` (taps on a template's quick-reply buttons), `reaction`, `order`, `system` and
  `unsupported`, the type the payload reports as `message.type`; `template` is only ever sent, so it
  is no choice. Null receives every type, as before; a list holds 1 to 14 of them, kept in the order
  message types are defined. It is chosen in Settings → Webhooks under "Message received" ("Received
  messages sent, by type": all ticked unless some are unticked; saving them all ticked keeps none)
  and shown on the endpoint as "Received messages sent: …", and through the API as `messageTypes` on
  `POST /webhook-endpoints` and `PATCH /webhook-endpoints/{id}` and in every endpoint the API
  answers.
- **Only with the event:** a list given for an endpoint that does not take `message.received` is
  refused (`messageTypes`; 422 through the API). A change that removes the event clears it, and a
  `PATCH` that leaves it out keeps it; Settings always sends it. A check in the database holds the
  same rule (null, or 1 to 14 known types, one dimension, without a null, while `message.received`
  is among the endpoint's events).
- **Matched as captured:** `app.capture_webhook_event` creates a `message.received` delivery only
  for the active endpoints whose list is null or holds the message's type, as the message trigger
  has always stored it in the event's detail (ADR-053), applied with the endpoints' numbers, teams
  and members, and writes no event when no endpoint takes it. A message's type is set when it is
  received and never changes. Other events, `message.status` included, are not narrowed; replays and
  test events are unchanged.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `messageTypes` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API.
- **Migration 0137:** `message_types text[]` on `app.webhook_endpoints` with the check, validated at
  once (a company has at most 10 endpoints), an update grant on the column for the runtime role, and
  `app.capture_webhook_event` replaced with the same signature, so its owner and grants stay.
  Existing endpoints keep null; nothing is backfilled.

Not built: filters on a received message's words or on the kind of an interactive reply (button or
list), types for `message.status` (the messages HyFib sends), and filters on the contact who sent it
(a tag, a field's value).

## ADR-192 Choosing why the runs a webhook endpoint receives ended (P5-09) (2026-10-05)

Context: an endpoint that takes `automation.run_ended` receives the end of every run, or of the
automations, ends and triggers it chose (ADR-145, ADR-151, ADR-183). An end is coarse: "failed"
covers a message that could not be sent, a step, loop, message or web request limit, a run older
than 7 days and an error, and "completed" both an End step and a step with nothing after it. A
receiver that acts on some reasons only (an alert when a message could not be sent, but not when a
run grew old) was sent every end of the status and had to read `run.endReason` and drop the rest.

Decision:

- **A list of reasons per endpoint,** for `automation.run_ended` only: the 21 reasons a run ends
  for, as the payload's `run.endReason` names them, each belonging to one end (completed:
  `end_node`, `no_next`; handed_off: `handoff_node`; taken_over: `agent_replied`, `assigned`,
  `take_over`, `api_replied`; stopped: `stopped_by_member`, `conversation_resolved`, `opted_out`,
  `contact_erased`, `automation_archived`, `stopped_by_api`; failed: `budget_steps`, `budget_loop`,
  `budget_messages`, `budget_http`, `expired`, `send_blocked`, `send_failed`, `error`). Null
  receives every reason, as before; a list holds 1 to 21 of them, kept in that order. Through the
  API it is `runEndReasons` on `POST /webhook-endpoints` and `PATCH /webhook-endpoints/{id}` and in
  every endpoint the API answers.
- **A list narrows the ends it names reasons of:** a run's end counts only when its reason is
  listed, for an end the list names reasons of; the runs of the endpoint's other ends are narrowed
  by the ends alone (ADR-151), as a list of custom fields narrows field changes and leaves the other
  parts to the parts (ADR-184). An endpoint taking every end and naming `send_blocked` and
  `send_failed` receives every completion, hand-off, take-over and stop and, of the failures, those
  two only; one taking only the failed end with the same list receives those failures only. So a
  list never hides the runs of an end it names no reason of, and an end added to the endpoint later
  receives its every run, rather than none.
- **Only reasons of the ends taken:** a reason of an end the endpoint does not take could never
  match, so a list naming one is refused (`runEndReasons`, "Choose end reasons only of the ends the
  endpoint receives."; 422 through the API), checked against the ends given with it, or else the
  ends the endpoint keeps. A change of the ends that leaves the reasons out keeps those of the ends
  kept; none left takes every reason. A list given for an endpoint that does not take
  `automation.run_ended` is refused; a change that removes the event clears it, and a `PATCH` that
  leaves it out keeps it. A check in the database holds the same rules (null, or 1 to 21 known
  reasons, one dimension, without a null, while `automation.run_ended` is among the endpoint's
  events and only of the ends it takes), so a change of the ends alone cannot strand a reason
  either.
- **Settings:** under "Automation ended", below the statuses, "Why the runs ended, by status" lists
  the reasons of each status ticked, all ticked unless some are unticked. The last reason ticked of
  a status stays ticked (unticking the status stops its runs), and a status with every reason ticked
  is not narrowed, so saving everything ticked keeps no list. The endpoints list shows "Automation
  ends narrowed to: …".
- **Matched as captured:** `app.capture_webhook_event` creates an `automation.run_ended` delivery
  only for the active endpoints whose list is null, holds the reason the run ended for, or names no
  reason of the end the run ended with (its status, paired with its reasons in the function as the
  runs' own check pairs them), applied with the endpoints' other filters, and writes no event when
  no endpoint takes it. The run trigger has always passed the reason in the event's detail, and a
  run's end and reason are set once. Run starts and other events are not narrowed; replays and test
  events are unchanged.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `runEndReasons` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API.
- **Migration 0138:** `run_end_reasons text[]` on `app.webhook_endpoints` with the check, validated
  at once (a company has at most 10 endpoints), an update grant on the column for the runtime role,
  and `app.capture_webhook_event` replaced with the same signature, so its owner and grants stay.
  Existing endpoints keep null; nothing is backfilled.

Not built: filters on the step a run failed at or on the API key that started or stopped it, and
reasons for `automation.run_started` (a run starting has none; its trigger is chosen with ADR-183).
A reason added to automations later needs a migration that adds it to the check and to the capture's
pairs, as it needs one for the runs' own check.

## ADR-193 Reviewing campaign drafts through the public API (P5-08) (2026-10-05)

Context: since ADR-186 keys create and edit drafts, but only members could see what submitting one
would do: what still blocks it, how many contacts it would reach and why the others would be
skipped, and what it would cost. An integration that prepares drafts for members (a store that
drafts its weekly offer, say) could not tell whether its draft was ready, or warn before a member
submitted a draft that would reach few contacts or cost more than expected.

Decision:

- **`GET /campaigns/{id}/review`** answers a draft's review as members' review shows it, read now:
  `problems` (what must change before a member can submit it, in members' words and order, empty
  when nothing blocks it), `audience` (the contacts the segment or conditions match, those who can
  receive the campaign now, and why the others would be skipped, the commonest first; null until the
  draft has a number, a template and an audience, or when the audience is over 50,000), `estimate`
  (an upper bound of Meta's charges for the contacts who can receive it, from the rate card HyFib
  publishes from Meta's rates for when it would start, in major units by market, with the recipients
  in markets without a price counted apart; null without a currency, a rate card in it or a contact
  who can receive it), `costCurrency`, `scheduledAt` and `scheduleAdjustment`, `approvalRequired`
  and `frequencyCap`, and the `version` reviewed, which `PATCH` takes as `expectedVersion`. Counts
  only: never contacts or members.
- **One implementation:** members' review and the API both call `reviewCampaignDraft`
  (`campaigns/service.ts`), which checks readiness (now given the company's id and time zone rather
  than a member's context), counts the audience and estimates the cost; the API maps it to its words
  (`toApiCampaignReview`). A member's submission checks everything again, so a review is advice, not
  a promise.
- **For keys that write drafts:** it needs `campaigns.write`, the scope that already reads a draft's
  settings (ADR-186), because it shows costs and the audience, which keys that only read campaigns
  never see (ADR-125). It changes nothing, so it is answered whatever the company's status, as reads
  are; the key's company decides the campaign (another company's is not found).
- **Drafts only:** any other status is refused with 409 naming it: a submitted campaign keeps the
  audience frozen when it was submitted, and `GET /campaigns/{id}` counts its results.
- **One snapshot, no writes:** a read-only transaction at repeatable read, so the counts, the
  estimate and the problems agree with one another.
- **No migration.**

Not built: reviewing a draft's settings before saving them (the review reads the saved draft),
submitting, approving, scheduling or starting campaigns through the API (a key is not a member), and
the frequency cap's effect on the audience (applied when the campaign sends, as members' review
says).

## ADR-194 Sending media from links through the public API (P5-08) (2026-10-06)

Context: keys reply with text, buttons, lists, products and reactions (ADR-070, ADR-080, ADR-082,
ADR-086), but not with a photo, a video, a voice note or a document: a clinic could not send its
leaflet, nor a shop a product photo, to a customer who had just written. HyFib keeps no media
(inbound media is metadata only, and uploads need storage it does not have), but Meta's published
spec lets a message name its media by an http(s) `link` that WhatsApp fetches (research M-191).

Decision:

- **Media from a link:** `POST /messages` takes `type` `image`, `video`, `audio` or `document` with
  `to`, an optional `from` and `replyTo` as other replies take them, a `link`, and for a photo, a
  video or a document an optional `caption` (trimmed, 1 to 1,024 characters); audio takes none. It
  is a reply (ADR-070): `messages.reply`, only to a number that wrote to the WhatsApp number in the
  last 24 hours (`window_closed` otherwise), stopping an automation answering the conversation.
- **Links:** https only, with a host and without a user name or password, at most 2,000 characters,
  trimmed; HyFib never fetches it. WhatsApp fetches it when it sends the message, so it must be
  reachable from the internet without signing in; a link it cannot fetch, or media it does not
  accept, makes the message fail, which `GET /messages/{id}` and `message.status` report with
  WhatsApp's error, as for any send.
- **Stored as sent:** the message's content is the link and the caption (`type` the media's), and
  its send intent the Graph request (`{type}: {link, caption}`), sent through the same pipeline and
  send job as every reply; the conversation's preview is the caption, or the kind of media. The API
  reads the caption as the message's `text` (`mimeType` stays null: HyFib does not know it). The
  inbox shows the kind, the caption and the link, which opens in a new tab (only an https link is
  shown as one). Erasing the contact redacts the content as for any message.
- **Not uploads, not stickers:** no `id` of uploaded media (HyFib has no media storage), no
  `filename` for documents and no stickers: Meta's spec shows a filename only for a document sent by
  id, and a caption on an audio or sticker message nowhere (M-191). The scope's label and
  description name media.
- **No migration:** the media types are already message types.

Not built: sending uploaded media (needs media storage and Meta's upload), media in the inbox's own
reply box, stickers, a document's file name, checking a link before sending it, and media downloads.

## ADR-195 Sending locations through the public API (P5-08) (2026-10-06)

Context: keys reply with text, buttons, lists, products, reactions and media from links (ADR-070,
ADR-080, ADR-082, ADR-086, ADR-194), but not with a place: a clinic asked where it is could only
type its address. Meta's published spec describes a location message (research M-192), and the inbox
already shows the locations customers send.

Decision:

- **A location:** `POST /messages` takes `type` `location` with `to`, an optional `from` and
  `replyTo` as other replies take them, a `latitude` (-90 to 90) and a `longitude` (-180 to 180) in
  decimal degrees as JSON numbers, and the place's `name` and `address` if wanted, each trimmed and
  1 to 1,000 characters long (HyFib's own bound: Meta's spec gives none). Nothing else: the spec's
  send schema has only these four properties, so a received location's `url` is not sent. It is a
  reply (ADR-070): `messages.reply`, only to a number that wrote to the WhatsApp number in the last
  24 hours (`window_closed` otherwise), stopping an automation answering the conversation. It may
  quote a message, as the spec's examples do.
- **Coordinates as the spec types them:** the send intent's Graph request gives the coordinates as
  decimal text (`"18.5204"`), as the spec's `LocationMessage` schema types them; its examples send
  numbers, a conflict M-192 records, and HyFib follows the schema. `decimalDegrees` writes them in
  plain decimals, never in the exponent notation JavaScript uses below a millionth. A location
  WhatsApp refuses makes the message fail, which `GET /messages/{id}` and `message.status` report
  with WhatsApp's error, as for any send.
- **Stored as received locations are:** the message's content holds the coordinates as numbers with
  the name and the address, the shape of a received location, so the inbox and the API read both
  alike. The conversation's preview, the API's `text` and the inbox's one-line quote give
  the name, else the address (as for received locations); the preview says "Location" without
  either. The inbox now shows a location's coordinates under its name and address, received
  locations' too. Erasing the contact redacts the content as for any message.
- **Descriptions:** the scope's label and description name locations. The API's description of a
  message's `text` now names captions and locations for outbound messages too. ADR-194 left captions
  out of it, and its record said webhooks give a caption as text, which they do not
  (`message.status` carries no words): both corrected. The feature matrix no longer says media
  messages are not built.
- **No migration:** `location` is already a message type.

Not built: locations in the inbox's own reply box, asking a customer for their location
(`location_request_message` is not among the spec's interactive types, M-043), a place's `url`, and
maps.

## ADR-196 Reading the contacts of contact cards through the API and webhooks (P5-08, P5-09) (2026-10-06)

Context: when a customer shares a contact card, HyFib keeps the contacts WhatsApp sends (its first
ones, at most 20, while they fit, ADR-131), but the API and the `message.received` webhook gave only
how many were left out (`contactsLeftOut`, ADR-132), and the inbox only "Shared a contact card": a
CRM could not file a referral, and members had to open WhatsApp to read the number. The backlog
waited on Meta's contact object, which Meta's published spec describes for received cards (research
M-193).

Decision:

- **`contacts` on every message:** `GET /conversations/{id}/messages`, `GET /messages`,
  `GET /message-changes` and `message.received` give each message `contacts`: for a contact card,
  the contacts kept, in the API's words (`name` with `formattedName`, `firstName`, `lastName`,
  `middleName`, `prefix` and `suffix`; `phones` with `phone`, `waId` and `type`; `emails`; `urls`;
  `addresses` with `street`, `city`, `state`, `zip`, `country`, `countryCode` and `type`; `org` with
  `company`, `department` and `title`; `birthday`). It is null for other messages and for content
  removed or too large to keep; `contactsLeftOut` still counts the contacts left out.
- **As WhatsApp gave them, every part optional:** the spec says parts may be missing when the person
  does not or cannot share them, and its schema and examples disagree on the values of `type` (HOME
  and WORK in the schema, MOBILE in an example), so HyFib passes text on as given. A value that is
  not text is left out, as are a phone, an email or a link without its value, an address without any
  part and an organisation without any. Nothing is checked or normalised: a number is the card's,
  not E.164, and a link is not made a link.
- **One mapping:** `contactCards` (`webhooks/payloads.ts`) reads the stored content for the API and
  the webhook alike, so they never differ. An erased customer's messages are redacted, so their
  cards give null, in a webhook delivered after the erasure too.
- **Inbox:** a contact card shows each contact's name (its formatted name, else its first and last
  names) with its numbers and email addresses, as text.
- **No migration, no new scope:** the content is already stored, and `conversations.read` reads it
  as it reads messages' text. `message.received`'s description of `text` now names a location's
  name, which it has always given.

Not built: sending contact cards through the API (the spec describes the object a sent card uses,
M-193), and adding a shared person as a contact.

## ADR-197 Sending contact cards through the public API (P5-08) (2026-10-06)

Context: keys read the contact cards customers share (ADR-196) but could not send one: a clinic
could not give a patient the dentist's number as a card WhatsApp can save. Meta's published spec
describes the contact object a sent card uses (research M-193).

Decision:

- **Contact cards:** `POST /messages` takes `type` `contacts` with `to`, an optional `from` and
  `replyTo` as other replies take them, and `contacts`: 1 to 5 contacts in the words reads use
  (ADR-196). Each has a `name` with `formattedName` and at least one other part, and if wanted
  `phones` (a `phone` with a digit, a `waId` of 6 to 20 digits), `emails` (valid addresses), `urls`
  (http or https, with a host and no user name or password) and `addresses` (at least one part,
  `countryCode` two letters), up to 5 of each, each with a `type` of HOME or WORK; an `org` with at
  least one part; and a `birthday` that exists (YYYY-MM-DD). Each text is trimmed and at most 256
  characters long (a link 2,000), and nothing else is taken. It is a reply (ADR-070):
  `messages.reply`, only within the 24-hour window, stopping an automation answering the
  conversation.
- **HyFib's own rules:** the spec's `NameObject` requires nothing, but the received card's schema
  requires `formatted_name` and none of its examples has a formatted name alone, so HyFib asks for
  one more part, which costs an integration little and avoids a card WhatsApp might refuse. The 256
  characters and 5 entries of each kind are HyFib's bounds (the spec gives none), and contacts that
  would make the message larger than received content may be (60 KB) are refused, so a message
  always fits.
- **Stored as received cards are:** the message's content and the Graph request hold the contacts in
  WhatsApp's words (`formatted_name`, `wa_id`, `country_code`), parts not given left out, so reads
  give sent and received cards alike through `contactCards`, and the inbox shows each one's name,
  numbers and email addresses. The conversation's preview is "Contact card:" with the names. A card
  WhatsApp refuses makes the message fail, which `GET /messages/{id}` and `message.status` report
  with WhatsApp's error, as for any send.
- **The scope's label** becomes "Reply with text, media and other messages", which stays true as
  types are added; its description lists them.
- **No migration:** `contacts` is already a message type.

Not built: contact cards in the inbox's own reply box, and sending one of the company's contacts as
a card.

## ADR-198 Sending stickers from links through the public API (P5-08) (2026-10-06)

Context: keys send photos, videos, audio and documents from links (ADR-194), and ADR-194 left
stickers out, though Meta's published spec sends a sticker by link the same way, without a caption
(research M-191, M-194).

Decision:

- **A fifth kind of media:** `POST /messages` takes `type` `sticker` with `to`, an optional `from`
  and `replyTo`, and a `link` under ADR-194's rules (https, a host, no user name or password, at
  most 2,000 characters), and nothing else: no caption, as for audio. It is a reply (ADR-070) under
  `messages.reply`, sent through the same path as every medium.
- **WhatsApp decides:** the spec states no format, dimensions or size for a sticker (its upload
  example is a WebP file), so HyFib checks none; a file WhatsApp does not take as a sticker makes
  the message fail, which `GET /messages/{id}` and `message.status` report with WhatsApp's error.
- **Stored as other media sent from a link:** the content keeps the link, the conversation's preview
  says "Sticker", the API's `text` is null, and the inbox shows the link as other media's.
- **No migration:** `sticker` is already a message type.

Not built: stickers uploaded to Meta or sent by id, and checking that a file can be a sticker.

## ADR-199 Acknowledging quarantine entries on the operations console (P5-10) (2026-10-06)

Context: the console's other lists take an administrator's note: current failures (ADR-141), dead
letters (ADR-169), late queues (ADR-177) and webhook receipts (ADR-179). Quarantine entries, events
HyFib could not attribute to a company, could only be retried or resolved: while one waited on the
company to reconnect, or on Meta, nothing told the other administrators that someone was on it, and
every administrator is emailed about each (ADR-091).

Decision:

- **A note on an open entry:** on the Integrations tab, a platform administrator acknowledges an
  open quarantine entry with a note of 10 to 500 characters (what was found or is awaited). The row
  shows who acknowledged it, when, and the note; another administrator may acknowledge it again,
  replacing the note; the platform audit log keeps each (`platform.webhook_quarantine_acknowledged`,
  the note as its reason, with the entry, its receipt, the provider and the reason it was
  quarantined, and no company). Resolving the entry still closes it; a resolved entry takes no note
  (409), as the console no longer lists it.
- **Where it is enforced:** `ops.platform_acknowledge_quarantine_entry` (SECURITY DEFINER,
  executable by the platform role only) checks the platform administrator, the note (trimmed) and
  that the entry exists and is open, then records the note and the audit entry in one transaction.
  The notes live in `ops.quarantine_acknowledgements` (migration 0139), which only the definer role
  writes and only the platform role reads: the runtime role, which writes quarantine entries, has no
  grant on it.
- **How long:** a note goes with its entry. The retention sweep deletes entries with their receipts
  after 90 days, and the notes with them through a cascading foreign key.
- **Exports:** the quarantine CSV gains an "Acknowledged (UTC)" column with the time only, never who
  or the note, as the other lists' exports do.

Not built: assigning an entry or a failure to someone, editing or deleting a note (a new
acknowledgement replaces it), and leaving acknowledged entries out of the alert email (each is
emailed once anyway).

## ADR-200 Exporting the console's lists beyond the rows a tab shows (P5-10) (2026-10-06)

Context: each of the console's action lists downloads as CSV (ADR-158), but only the rows its tab
shows: the latest 100 dead letters, receipts needing attention and quarantine entries, 200 signups
and number setups, 500 current failures and new companies. After a bad day, or for a provider asking
about every quarantined event, staff could not get the rest.

Decision:

- **Exports go further than the tab:** the CSV of number setups, new companies without a number,
  receipts needing attention, quarantine entries and dead letters gives up to 5,000 rows; of current
  failures, up to 1,000, and of signups, up to 500, the most their definer functions return, so no
  function changes. Tabs keep their rows. `OPS_LIST_ROWS` names both numbers for each list, and each
  list's title says how many rows its CSV gives.
- **The same list, the same order:** the export reads the list with the tab's own read, only with
  the larger number, and each read now breaks ties by id, so the tab's rows are the file's first
  rows. The audit entry (`platform.ops_<list>_exported`) counts the rows the file gives, as before;
  the files hold what the tabs hold, people and notes left out (ADR-158).
- **No migration:** the platform role reads the larger lists through its own grants, and the definer
  functions already accept those numbers.

Not built: exports beyond these numbers (paged or streamed files), filters on an export, and raising
the definer functions' limits.

## ADR-201 Sending templates with a photo, video or document header through the public API (P5-08) (2026-10-06)

Context: templates made in WhatsApp Manager with a photo, video or document header are synced and
shown, but HyFib could not send them: a send's spec refused any header but text. A send needs only
the file, given by link: Meta's published spec gives a header parameter of type `image`, `video` or
`document` holding a media object (an `id` or a `link`) without a caption, and its "Send Message
Template Media" example sends `{type: image, image: {link}}` (research M-195). Creating such
templates needs the Resumable Upload API (M-050), which HyFib does not use yet.

Decision:

- **The API sends them:** `POST /messages` (`type` `template`) and `POST /messages/send-many` (in
  each message, as each has its own variables) take `headerMedia: {link}`, an https link under
  ADR-194's rules (a host, no user name or password, at most 2,000 characters) that WhatsApp fetches
  when it sends the message. A template with such a header needs it and one without refuses it (422,
  naming `headerMedia` or `messages.<n>.headerMedia`), checked with the variables before anything is
  written. HyFib never fetches the link and keeps no media.
- **The list says what a send gives:** `GET /templates` lists these templates with `headerMedia`
  (`image`, `video` or `document`; null for other templates), their header asking for no text value.
- **Only the API opts in:** `sendSpecFor` takes a header's file only when its caller passes
  `mediaHeaders`, as the API does. The inbox, campaigns, automations and store messages still cannot
  send these templates and now say why ("This template has a photo header: HyFib sends such
  templates only through the API, which gives a link to the file."), as members' template pages do.
- **Sent as the spec gives it:** the header's one parameter, `{type, <type>: {link}}`, before the
  body's; no caption and no file name, which the spec's template media parameters do not take. The
  spec supports only PDF documents in media templates; HyFib cannot check a file it does not fetch,
  so the API's description says so, and a file WhatsApp refuses makes the message fail, as
  `GET /messages/{id}` and `message.status` report.
- **Kept with the message:** the content keeps `headerMedia` (the kind and the link) beside the
  rendered text; the inbox shows the kind and the link above the template's text, as an https anchor
  opened in a new tab without the referrer; API reads and webhooks give the template's text as
  before, never the file (ADR-194). Erasure replaces the content and the request, as for every
  message.
- **VIDEO on the spec's word:** the spec's template examples show IMAGE and DOCUMENT headers, and
  its header parameters include `video` (M-195), so a VIDEO header is sent as the others. GIF
  (third-party lists only, M-090), LOCATION and PRODUCT headers stay unsendable.
- **No migration:** templates and messages keep their columns; the link is in the message's content
  and its send request.

Not built: these templates from the inbox, campaigns, automations or store messages; files uploaded
to Meta (ids); creating templates with media headers (the Resumable Upload API); location headers;
showing a template's example file.

## ADR-202 Submitting campaign drafts through the public API, for a member's approval (P5-08) (2026-10-06)

Context: keys create, edit, review and cancel campaign drafts (ADR-186, ADR-187, ADR-193), but only
members submit them, so an integration that prepares a campaign has to ask someone to open the app
and press submit. Members' submission checks the draft, takes its audience and either waits for
approval or launches the campaign under the submitting member's authority, which the runner checks
before each batch; a key is no member, so it has no such authority to give.

Decision:

- **A key submits, a member approves:** `POST /campaigns/{id}/submit` with the draft's
  `expectedVersion` submits it with members' code (`submitLockedDraft`): the checks its review
  lists, the audience's size and the snapshot of who it goes to, each refused as members are told
  (409 for a stale version, 412 for a check). The submission then always waits for a member's
  approval (`pending_approval`), whatever the company's settings: a key never starts a campaign.
- **The approver lends the authority:** a member with `campaigns.approve` approves a key's
  submission in the app, as they approve another member's, and must also hold `campaigns.send`, as
  the campaign is launched under their authority (`launched_by_user_id`), which the runner checks as
  for every campaign. Rejecting it with a note, or taking it back, makes it a draft again without
  the key.
- **`campaigns.write` is the scope:** it already edits what a campaign would send, and a submission
  sends nothing until a member approves it. Its label becomes "Create, edit and submit campaign
  drafts", and its description says a key never starts a campaign.
- **Recorded:** the campaign keeps the key (`submitted_by_api_key_id`, never with a submitting
  member, a check the database enforces, and a key of the company, a composite foreign key); the
  event and the audit name it, and the campaign page says the key submitted it and who may approve
  it.
- **Retries:** a campaign the key submitted is answered as it is, whatever happened to it since; any
  other campaign that is not a draft is refused with 409, naming its status. A rejected or withdrawn
  submission is a draft at a new version, so a retry with the old one is refused.
- **Migrations 0140 and 0141:** the column, the check and the foreign key added NOT VALID and
  validated in the next migration, so `app.campaigns` stays writable; the runtime role updates the
  column through a column grant.

Not built: keys approving or starting campaigns (by design), withdrawing a key's submission through
the API, and notifying approvers of a waiting campaign.

## ADR-203 Withdrawing a key's campaign submission through the API (P5-08) (2026-10-06)

Context: a key submits drafts, which wait for a member's approval (ADR-202), but only a member could
take a submission back, so an integration that found a mistake after submitting had to ask someone
to open the app. Members take back their own submissions and approvers anyone's.

Decision:

- **The submitting key withdraws its own:** `POST /campaigns/{id}/withdraw` with `campaigns.write`
  takes a campaign waiting for approval that the key submitted back to a draft, as a member's
  withdrawal does (`returnLockedCampaignToDraft`, shared with members' withdrawal and rejection):
  the audience snapshot is dropped (nothing was sent), the submission is cleared and the version
  goes up, so the key reads the draft again before it submits it again.
- **Nobody else's:** a submission a member or another key made is refused with 403, as a member may
  take back only their own (approvers withdraw any in the app); a campaign that no longer waits for
  approval is refused with 409, naming its status.
- **Retries:** a draft is answered as it is, so a retry after the withdrawal changes nothing; the
  event and the audit name the key.
- **No migration.**

Not built: notifying approvers of a waiting campaign, and a key withdrawing what a member submitted.

## ADR-204 Emailing approvers when a campaign waits for approval (P5-08) (2026-10-06)

Context: a campaign that waits for approval (a member's submission where the company requires
approval, and every key's submission, ADR-202) waited until an approver happened to open Campaigns:
nobody was told. A key's submission made this worse, as nobody in the company had pressed a button.

Decision:

- **Who:** the company's active members whose roles grant `campaigns.approve` (owners and
  administrators), except the member who submitted it, who cannot approve their own (four-eyes); for
  a key's submission only those who may also send campaigns, as approving it needs (ADR-202). Today
  every role that approves also sends; the check keeps the rule if roles change.
- **When:** in the submission's transaction, through the encrypted email outbox
  (`emailCampaignApprovers`, called by members' `submitCampaign` and by `apiSubmitCampaign`), so a
  refused submission emails nobody. The outbox's dedupe key is the campaign, its version after the
  submission and the approver: a retry answered as it is adds nothing, and a new submission after a
  withdrawal or a rejection is a new version and emails again. A submission that starts at once (no
  approval needed) emails nobody.
- **What:** a company notice naming who submitted it (the member, or the key by name), how many of
  its audience it would reach, when it starts once approved (in the campaign's time zone, as its
  page shows it) and a link to its page, where the member signs in and is authorized as usual.
  Counts only, never contacts. For a key's submission it adds that approving needs permission to
  send campaigns, as the campaign then sends under the approver's authority.
- **No migration and no setting:** the email kind exists (`tenant.notice`), and the services'
  dependencies now carry the outbox and the app's base URL (`CampaignDeps.notices`).

Not built: telling the submitter that their campaign was approved or sent back, reminders while a
campaign keeps waiting, and email preferences.

## ADR-205 Telling the member who submitted a campaign what its approver did (P5-08) (2026-10-06)

Context: approvers are emailed when a campaign waits for them (ADR-204), but the member who
submitted it learned that it was approved, sent back with a note, or taken back to a draft only by
opening its page. An approved campaign also sends under that member's authority, which they should
know.

Decision:

- **Who:** the member who submitted it, in the transaction of the approver's action, so a refused
  approval emails nobody: only while they are an active member, and never for their own action
  (taking back their own submission). A key's submission has no member to tell: its integration
  reads `campaign.status_changed` (ADR-087), as before.
- **What:** approved (by whom, when it starts in the campaign's time zone or that it starts now, the
  approver's note if any, and that it sends under their authority, so it pauses if they leave or can
  no longer send campaigns); sent back as a draft with the approver's note; or taken back to a draft
  by an approver while it waited. Each says nothing was sent where nothing was, and links to the
  campaign's page. A note is the approver's own words (at most 500 characters), split into lines as
  long notes are.
- **Once:** the outbox's dedupe key is the campaign, its version after the action and the member,
  and each action raises the version.
- **No migration.** `emailCampaignSubmitter` is called by `approveCampaign`, `rejectCampaign` and
  members' `withdrawCampaign`; the submitter is passed in, as sending back clears it.

Not built: reminders while a campaign keeps waiting, email preferences, and emails when a running
campaign pauses or completes (its page and `campaign.status_changed` say so).

## ADR-206 Reading saved segments through the API (P5-08) (2026-10-06)

Context: a draft's audience can be one of the company's saved segments (ADR-186), but a key had no
way to find a segment's id: segments were only on members' Segments page.

Decision:

- **Reads with `campaigns.read`:** `GET /segments` lists the company's segments that are not
  archived, newest first on keyset pages, and `GET /segments/{id}` reads one; members read segments
  with the permission of the same name. Reads continue while the company is suspended, as other
  reads do.
- **In the API's words:** each segment gives its conditions as `POST /contacts/search` and drafts'
  audiences take them (segments store them so, ADR-117), its version, and `problem`: why it cannot
  be used now, as members' segment page says (a custom field deleted since, a comparison its field
  no longer takes, a tag or date that is not valid, a campaign that does not exist), checked by
  segments' rules; conditions HyFib can no longer read give a null definition with a problem.
- **Counts only:** one segment adds `count`, how many contacts match it now (erased contacts left
  out), counted by segments' own SQL with dates in the company's time zone, as members' page counts
  it; null when it has a problem. Contacts themselves are found with `POST /contacts/search` and
  `contacts.read`, so this read gives no contact.
- **Not found:** an archived segment and another company's, as members' page.
- **No migration.**

Not built: creating, changing or archiving segments through the API, and segments' members as pages
(`POST /contacts/search` with the same conditions finds them).

## ADR-207 Creating, changing and archiving saved segments through the API (P5-08) (2026-10-06)

Context: keys read segments (ADR-206) and give one as a draft's audience (ADR-186), but an
integration that keeps its audiences elsewhere had to ask a member to build each segment on the
Segments page. Separately, a member who saved a segment under a name another segment has got only
the database's generic conflict, "A record with the same unique value already exists".

Decision:

- **Writes with `campaigns.write`,** the permission members create and change segments with:
  `POST /segments` (the name and conditions; once per `Idempotency-Key`), `PATCH /segments/{id}`
  (the name or the conditions given, the rest kept, with an optional `expectedVersion`) and
  `DELETE /segments/{id}`, which archives it as members do. Each answers with the segment as
  `GET /segments/{id}` reads it, counted now; archiving answers its id.
- **Checked as a search is:** the conditions go through the code that checks `POST /contacts/search`
  (`apiSegmentConditions`): a custom field of the company and a comparison its type takes, a valid
  tag (stored normalized) or date, a campaign of the company; a problem is refused with 422 naming
  the condition, like `definition.conditions.1.key`. Segments hold no groups. Saving needs no other
  scope (a condition on messages or campaigns reads nothing when saved; counting it is
  `GET /segments/{id}`, with `campaigns.read`).
- **Names:** a name another segment of the company has that is not archived, whatever its case
  (`segments_name_uq`), is refused with 409 "Another segment already has this name." naming `name`,
  for keys and for members alike (`segmentNameRefusal`). Archiving frees the name.
- **Archiving** leaves submitted campaigns' audiences as they were; a draft with the segment cannot
  be submitted until it takes another audience, as when a member archives it. A segment already
  archived is answered as it is, so a retry is harmless; another company's is not found.
- **The audit names the key** (`segment.created`, `segment.updated`, `segment.archived` with source
  `api`); the segment records no member as its author or last editor.
- **No migration.**

Not built: segments' members as pages, and restoring an archived segment (members cannot either).

## ADR-208 Listing a segment's contacts through the API (P5-08) (2026-10-06)

Context: keys read, write and count segments (ADR-206, ADR-207), but to get a segment's contacts an
integration had to copy its conditions into `POST /contacts/search`, and keep the copy in step with
members' changes.

Decision:

- **`GET /segments/{id}/contacts`** gives the contacts a segment holds now, read from its stored
  conditions by segments' own SQL (`segmentConditionsSql`), with dates in the company's time zone,
  as a campaign takes its audience. Pages are those of `POST /contacts/search` (`apiContactPage`):
  newest first, erased contacts left out, each page reading at most 2,000 contacts in one
  repeatable-read snapshot, so a page can be short and still give a cursor.
- **Scopes as a search's:** `campaigns.read` (segments) and `contacts.read` (contacts), and
  `conversations.read` for a segment with a `last_message` condition, as a search with one needs it
  (ADR-126); a `campaign` condition needs `campaigns.read`, which the route needs anyway. That last
  check reads the segment first, as a search reads its conditions.
- **A segment with a problem** (ADR-206) is refused with 412 saying it, rather than answered from
  conditions that no longer hold; an archived segment and another company's are not found.
- **No migration.**

Not built: restoring an archived segment (members cannot either), and a segment's contacts as a
file.

## ADR-209 Saying until when a waiting campaign can be approved (P5-08) (2026-10-06)

Context: a campaign waiting for approval can be approved only until its sending period ends, counted
from when it was set to start; a campaign that starts at once is set to start at its submission, so
with the default 24-hour period it can no longer be approved a day after it was submitted. Approvers
learned this only from the refusal ("The scheduled sending period has already ended"), neither the
approval email (ADR-204) nor the campaign's page said it.

Decision:

- **One rule:** `campaignApprovalDeadline` (the set start plus `stop_after_hours`) is what
  `approveCampaign` refuses after and what the email and the page show, so they cannot disagree.
- **The approval email** says until when the campaign can be approved, in the campaign's time zone,
  and that it has to be sent back and scheduled again after that.
- **The campaign's page** says the same while it waits; once the time has passed it says the sending
  period ended and that it can no longer be approved, and offers no Approve button (sending it back
  stays).
- **No migration and no new setting;** the API is unchanged (a key cannot approve).

Not built: a reminder before the time passes, and letting an approver extend the sending period on
approval.

## ADR-210 Emailing members when HyFib pauses a campaign by itself (P3-04) (2026-10-06)

Context: the runner pauses a campaign by itself when its spending or message cap is reached, its
template is no longer approved by Meta (or no longer takes the campaign's variables), its number is
not active, the member whose authority it sends under left or lost `campaigns.send`, or no rate card
is published for its cap's currency. The pause showed only on the campaign's page and in its
outgoing webhook event, so a member who was not looking could learn of it after its sending period
had ended, when the contacts still waiting are skipped.

Decision:

- **Who:** the member whose authority it sends under, while they are an active member who may send
  campaigns, as they can fix and resume it; otherwise (they left or lost the permission) the
  company's active members who may approve and send campaigns, its owners and administrators, as one
  of them must resume it. Members' and keys' own pauses email nobody.
- **When:** in the pause's transaction, from the runner's pause and from the job that pauses a
  campaign whose member left, so a pause that rolls back emails nobody; one email per member for
  each pause (the dedupe key holds the campaign's version, which every pause raises).
- **What:** the cause and what a member does about it (raise or remove the cap; resume once Meta
  approves the template again, or cancel; reconnect the number in Settings → Channels; resume under
  another member's authority; wait for a rate card or remove the cap), and that messages not sent
  yet wait for the resume until its sending period ends, given in the campaign's time zone, after
  which the contacts still waiting are skipped; for a campaign that had not started, that nothing
  was sent. No counts: messages still queued when a cap pauses it are held back by the send worker
  afterwards, so a count would be out of date.
- **No migration and no setting;** the worker sends it.

Not built: an email when a campaign completes or its sending period ends, a digest of pauses, email
preferences, and in-app notifications.

## ADR-211 Emailing members mentioned in a note who have not opened it (P3-06) (2026-10-06)

Context: a member mentioned in a note sees it only in the app (the unread count, Inbox → Mentions
and the live update). One who is not in the app learns of it when they next open it, however urgent
the note.

Decision:

- **After a delay, only if still unread:** adding a note schedules a signed `note.mention` job for
  each member it mentions other than its author, due 10 minutes later. Opening the conversation in
  that time (which marks the mention read) means no email.
- **The mention row decides,** under its row lock, when the job runs: no email for a mention already
  read, gone with its note (erased contact, deleted company), more than a day old (the company was
  suspended or the worker down), or of a member who is no longer active or can no longer see the
  conversation (the inbox's own rule, checked again). Of a member's unread mentions in one
  conversation, only the newest one's job emails, saying how many are unread, so a burst of notes
  sends one email. A job run again after its transaction committed finds its email queued (the
  outbox's dedupe key holds the mention id).
- **What it says:** who mentioned them, how many of their mentions in the conversation are unread,
  and a link to the conversation, where access is checked again. Never the note, the customer's name
  or number, or the message: an email stays readable after its reader loses access to the
  conversation, and leaves HyFib's controls.
- **A suspended company's** jobs are dropped (logged): its members get no email for those mentions,
  which the inbox still shows as unread.
- **No SQL migration and no setting;** the migration job creates the new queue. Keys' notes mention
  no one (ADR-072), so nothing changes in the API.

Not built: email preferences (a member cannot turn these emails off), a daily digest, and the note's
text in the email.

## ADR-212 Downloading a conversation's transcript (P3-06, W-042) (2026-10-06)

Context: a team settling a dispute, handing a case to another system or keeping a record had to copy
a conversation from the screen; the company export holds every conversation at once and is for
owners only.

Decision:

- **Who:** a new permission, `inbox.export`, held by owners, administrators and supervisors (and
  kept while the company is suspended, like the other exports), and only for a conversation the
  member can see. Agents read their conversations on screen but do not take copies; marketers and
  analysts do not read conversations.
- **What:** every message, oldest first, with its time in the company's time zone (WhatsApp's time
  for a customer's message), who sent it (the contact's name or "Customer", the member, the
  automation, the campaign by name, the API key by name, or "Sent automatically"), its words in full
  after its kind when it is not plain text, a contact card's names only, and what happened to a
  message of the company that did not reach the customer (not delivered with Meta's reason,
  cancelled, or delivery unknown). A header names the contact, the number, the company, the time
  zone and who downloaded it when. Internal notes are left out: they are the team's, not the
  conversation's.
- **How:** a plain-text file streamed from `/c/<company>/inbox/<conversation>/transcript`, 500
  messages per read-only transaction, from a "Download transcript" link on the conversation page.
  The permission, the conversation and the audit entry (`conversation.transcript_exported`, no
  content) come first, so a refused download is a 403 or 404, never a partial file. Plain text, not
  CSV: no spreadsheet reads any of it as a formula.
- **No migration;** the API is unchanged.

Not built: notes in the transcript, a PDF, a date range, transcripts through the API, and emailing a
transcript to the customer.

## ADR-213 Adding or removing a tag on every contact a filter matches (P3-01) (2026-10-06)

Context: tags were changed one contact at a time, or by importing a CSV of the contacts again.
Tagging a group found on the contacts page (everyone from Pune who opted in, say) meant opening each
contact.

Decision:

- **From the contacts page:** below its filters (search, tag, consent), a member with
  `contacts.write` adds or removes one tag on every contact the filters match, the number shown in
  the form. More than 10,000 matches are refused: the filters must be narrowed first.
- **The number shown is the number changed:** the edit carries the count the member saw. In one
  transaction the matching contacts are locked (as one contact's tag edit locks it) and counted
  again; a different count refuses the edit, so no contact the member did not review is tagged.
- **The tag rules stay:** the tag is normalised as everywhere (lower case, no commas). A contact
  that has the 50 tags a contact may have keeps them; the result says how many were changed, already
  had the tag (or did not, for a removal) and were full. Erased contacts never match.
- **Each changed contact is a change,** in the contact feed and as a `contact.updated` webhook
  event, as when one member edits it. The audit entry (`contacts.bulk_tagged`) holds the tag, the
  counts and which filters were used, never the search text.
- **No migration;** the API is unchanged.

Not built: bulk edits of other fields, bulk edits from a segment or through the API, choosing
contacts one by one, and undo.

## ADR-214 Emailing the member a campaign sent under when it finishes (P3-04) (2026-10-06)

Context: a campaign finishes when every contact in its audience was handed to WhatsApp or skipped,
or when its sending period ends with contacts still waiting, which are then skipped. Only its page
said so; a campaign that ran out of time could leave thousands unreached without anyone noticing
until its results were read.

Decision:

- **Who:** the member whose authority it sent under (who started it, approved it, or last resumed
  it), while they are an active member. Nobody else: finishing needs no one's action. A cancelled
  campaign emails nobody, as a member or key cancelled it.
- **When:** in the transaction that completes it, from the runner, once (completion is final).
- **What:** that it finished, or that its sending period ended (with its time in the campaign's time
  zone) and how many contacts it had not reached; how many messages it handed to WhatsApp and how
  many of its audience it skipped; and that deliveries, reads and replies keep arriving on its page.
  Counts only, never contacts.
- **No migration and no setting;** the worker sends it.

Not built: a summary of deliveries some time after it finishes, email preferences, and emails to
other members.

## ADR-215 Letting members choose which notice emails they get (P3-06) (2026-10-06)

Context: members are emailed when a campaign waits for their approval (ADR-204), when their campaign
is reviewed (ADR-205), paused by HyFib (ADR-210) or finished (ADR-214), and when they are mentioned
in a note they have not opened (ADR-211). Each ADR listed email preferences as not built: a member
who follows campaigns in the app all day could not stop them.

Decision:

- **Per member, per company:** migration 0142 adds `app.memberships.email_opt_outs`, the kinds the
  member turned off in that company, checked against the five kinds above. It starts empty, so every
  email stays on until a member turns it off, and it is the company's data: exported with the
  membership and deleted with the company.
- **Only one's own:** Settings → Notifications shows each member the kinds their role can receive
  and saves their choice through `app.set_own_email_opt_outs`, a definer function that finds the
  membership from the scope (the company and the signed-in user), never from an argument; the
  runtime role still cannot update memberships. Kinds the role does not show keep their setting. The
  change is audited (`membership.email_preferences_updated`, with the kinds off).
- **Every notice honours it,** in the transaction that would send it: approval requests, review
  outcomes, pause and completion emails, and mention emails (whose job ends as `opted_out`). A pause
  that needs another member to resume it (ADR-210) still goes to the owners and administrators who
  did not turn pauses off; if all did, nobody is emailed, and the campaign's page and webhook event
  still say why it paused.
- **Never these:** security, sign-in and billing emails are not listed and cannot be turned off.

Not built: a digest instead of single emails, in-app notifications, preferences for CRM task
reminders, and a company-wide default set by an administrator.

## ADR-216 Viewing and downloading the files customers send (P2-09, P5-08) (2026-10-06)

Context: a photo, voice note, video, document or sticker a customer sent reached the inbox as its
kind and caption only, with "Media download is not available yet.": members could not see what
customers sent. WhatsApp keeps the file for the business to fetch (`GET /{media-id}` gives an
address valid for 5 minutes, downloaded with the account's token; research M-047, M-196), but HyFib
has no storage for files.

Decision:

- **Fetched when shown, never kept:** the conversation page shows each file the customer sent
  through `/c/<company>/inbox/<conversation>/media/<message>`. For each request HyFib asks Graph for
  the file's address with the token of the WhatsApp account that received it, downloads it with the
  same token and passes it on as it arrives (`messaging/received-media.ts`). Nothing is written: the
  file is not stored, cached on the server or logged, so a customer's erasure, which deletes the
  message's media record, leaves nothing behind, and a file WhatsApp no longer keeps cannot be
  shown.
- **Who:** members who can see the conversation, as for its messages: `inbox.read_all`, or
  `inbox.read_assigned` for conversations assigned to them or to nobody. A message of another
  conversation or company, one the company sent, or one of an erased customer has no file to give
  (404).
- **How it reaches the browser:** photos (JPEG, PNG), stickers (WebP), recordings (AAC, MP4, MPEG
  and OGG audio) and videos (MP4, 3GPP) keep their type and are shown or played in the page;
  recordings and videos load only when played. Every other file, documents included, is sent as
  `application/octet-stream` with `Content-Disposition: attachment`, under the name the document
  came with (without characters a file name or a header cannot hold) or
  `whatsapp-<type>-<message>.<extension>`, so no customer's file renders as a page of HyFib. Every
  answer carries `X-Content-Type-Options: nosniff`, a `sandbox` Content-Security-Policy and
  `Cross-Origin-Resource-Policy: same-origin`, and only the member's browser caches it (`private`,
  an hour).
- **The token reaches only Meta:** it goes in the Authorization header to Graph, and to the address
  Graph returned only when that address is https (or the configured Graph origin, the test stand-in)
  and has no user name or password; redirects are refused and the address is never stored or logged.
  The download sends a User-Agent in the form of the pattern in Meta's description.
- **Limits and refusals:** a file larger than 100 MB, Meta's largest (M-049), is refused by its
  announced size before the download and by counting while it passes. Other refusals come before the
  first byte, as plain text: the account disconnected or its token refused by Meta (412, reconnect
  in Settings → Channels), WhatsApp no longer giving the file (404, as it keeps files for a limited
  time), WhatsApp not answering (503). An error page in place of the file is refused.
- **What is not checked:** Meta's description does not say how `sha256` is encoded (its example is
  `<HASH>`), so HyFib does not compare the file with it; TLS protects the transfer.
  `phone_number_id` is not sent: the description says it checks that the media belongs to that
  number, and whether a customer's file belongs to the number it was sent to is not stated.
- **No migration.** The web tier now calls Meta's media host on members' requests, as DEPLOYMENT
  notes.

Not built: files through the public API, byte ranges (Safari and iOS play recordings and videos only
from servers that answer byte-range requests, so members there download them with the link below the
player), keeping files beyond WhatsApp's lifetime, thumbnails, scanning documents for malware
(members' devices open them), and sending files from the inbox.

## ADR-217 Downloading the files customers send through the public API (P5-08) (2026-10-06)

Context: keys read a message a customer sent with a file as its type, its caption (`text`) and
`mimeType` (`GET /messages`, `message.received`), but not the file: an integration filing a
customer's invoice or photo had someone download it by hand. Members open these files in the inbox
since ADR-216.

Decision:

- **`GET /api/v1/messages/{id}/media`** with `conversations.read`, whose description now says it
  includes the files contacts sent: the file of a message a customer sent with one (`direction`
  `inbound`, `type` `image`, `video`, `audio`, `document` or `sticker`), fetched from WhatsApp for
  the request with ADR-216's calls and passed on as it arrives. HyFib keeps no copy.
- **As WhatsApp gave it:** `Content-Type` is the type WhatsApp gave the file, without its
  parameters, or `application/octet-stream` without one; `Content-Disposition` is always
  `attachment`, with the name ADR-216 gives. Unlike the inbox, every type is given: the API is
  called with a key in a header, never with a browser's cookies, so no file runs as a page of HyFib.
  The answer also carries `nosniff` and a `sandbox` policy.
- **Refusals before the first byte, as the API's JSON errors:** 404 for a message not in the company
  or of an erased contact (as its conversation is), or with reason `no_file` (no file from the
  customer) or `file_expired` (WhatsApp no longer gives it); 412 with `channel_disconnected`,
  `access_refused` or `file_too_large`; 503 when WhatsApp does not answer. Keys, scopes, the plan
  and the limits apply as to every call.
- **One implementation:** a member's and a key's request share the lookup and the fetch
  (`createReceivedMediaService`), and the API's handler can now answer with a stream
  (`handleApiRequest`'s file result) that carries the request's id.
- **No migration.** The OpenAPI document and the reference describe the call.

Not built: thumbnails, files in webhook events (they keep the type and `mimeType`), a link that
works without the key, and the files the business sent.

## ADR-218 Sending files from the inbox (P2-09) (2026-10-06)

Context: members answered in text only, so a price list, an invoice or a product photo went from
someone's phone. Meta's spec uploads a file for a number (`POST /{phone-number-id}/media`, multipart
`file` and `messaging_product`, answering an `id`) and sends media by that id, with a caption and,
in its "Send Document Message by ID" example, a file name (research M-046, M-197). HyFib has no file
storage.

Decision:

- **Uploaded when sent, never kept:** while a reply can be sent, the conversation page has a "Send a
  file" card. The browser posts the file and an optional caption to
  `/api/c/<company>/inbox/<conversation>/files`; HyFib checks the reply as it checks a text reply
  (`inbox.reply`, sight of the conversation, the number active, the 24-hour window, a WhatsApp
  number, and the collision warning of ADR-033 against the newest message the page showed), uploads
  the file for the conversation's number with its account's token, and queues a reply naming the
  media id. The bytes pass through memory once; the message keeps the media id, the caption, the
  type and a document's name, and so does its media record.
- **What can be sent:** JPEG and PNG photos, MP4 and 3GPP videos, AAC, AMR, MP3, MP4 and OGG
  recordings, and PDF, text, Word, Excel and PowerPoint documents, up to 16 MB, HyFib's limit for a
  file through its servers (Meta's limits by type come from third-party copies, M-049). A caption of
  up to 1,024 characters goes with a photo, a video or a document; a recording takes none (M-191). A
  document goes with the name it came with, cleaned as ADR-216 cleans names.
- **Once:** a retry of the same submission (its client key) answers the first message without
  uploading again. If the reply is refused after the upload, for example because the window closed
  meanwhile, the media is never sent and Meta deletes it (M-046).
- **Refusals before anything is written:** a file of another type, empty or over 16 MB (422, naming
  the file); the reply's own refusals (403, 404, 409, 412); Meta refusing the upload (422, with
  Meta's reason) or the account's token (412), or not answering (503).
- **The route** is under /api, so Next's proxy neither buffers nor cuts a body over its 10 MB; only
  HyFib's own pages may post to it (the trusted-origin check of server actions), with the member's
  session, and it reads at most 16 MB and 64 KB.
- **Members see what they sent:** a file a member sent shows in the thread as a customer's does
  (ADR-216), fetched from WhatsApp while Meta keeps it. The API's download stays for customers'
  files (ADR-217).
- **One implementation:** text and file replies share the reply's checks and queueing
  (`queueReply`). The test stand-in keeps uploads as files and takes a document's name only with an
  id, as the spec's examples do.
- **No migration.**

Not built: uploads through the public API, several files at once, dragging and dropping, a progress
bar, stickers, files over 16 MB, and files outside the window, where only templates go.

## ADR-219 Uploading files through the public API to send by id (P5-08) (2026-10-06)

Context: keys sent media only from https links WhatsApp fetches (ADR-194), so an integration with an
invoice or a price list on its own servers had to publish it at a public address first. Members
upload files since ADR-218, with Meta's upload and sending by id (research M-046, M-197).

Decision:

- **`POST /api/v1/media`** with `messages.reply`, as multipart form data: `file`, and `from` (the
  number's id) when the company has several active numbers. The file is checked as members' files
  are (the types of ADR-218, at most 16 MB), uploaded to WhatsApp for the number with its account's
  token, and recorded as the company's upload: a media row without a message, naming the number, the
  key and Meta's media. The answer (201) gives its `id`, the number, its `type`, type, size and
  name, and `expiresAt`, 30 days after the upload, as long as Meta keeps it (M-046). HyFib keeps no
  copy. An upload takes no Idempotency-Key: a retry uploads the file again.
- **Sent by id:** `POST /messages` with `type` `image`, `video`, `audio` or `document` takes
  `mediaId` in place of `link` (one of the two). The file must be the company's upload, for the
  number the message goes from, of the message's type, and less than 30 days old; otherwise 422
  naming `mediaId`, or 412 with reason `file_expired`. It can be sent as often as needed. The
  message names Meta's media id, a document with the name it was uploaded under (as the spec's
  example sends it), gets a media row of its own, and shows in the inbox as members' files do
  (ADR-218). Stickers stay links (ADR-198).
- **Migration 0143** adds `channel_account_id` and `api_key_id` to `app.media_objects`, with
  composite foreign keys to the company's numbers and keys and a check that a key's upload names its
  number and Meta's media and belongs to no message, all NOT VALID so the table stays writable;
  **0144** validates them. The company data export carries the columns; erasure and the company's
  deletion already delete media rows, before the numbers and keys they name.
- **The API takes multipart bodies** for this call only (`handleApiRequest`'s `multipartBytes`: at
  most 16 MB and 64 KB, form fields checked for NUL as JSON is).

Not built: listing or deleting uploads, uploads for template headers (they take links, ADR-201),
stickers, files over 16 MB, and purging upload rows after their 30 days.

## ADR-220 Conversation tags (P3-06, W-035) (2026-10-06)

Context: the inbox filtered conversations by team, number and customer, but members had no way to
label a conversation ("refund", "follow up") and find the labelled ones again; contact tags describe
the person, not the conversation. WATI's inbox tags chats, from tags managed in its settings
(research W-035).

Decision:

- **Tags on conversations** in `app.conversation_tags` (migration 0145), written as contact tags
  are: lower case, trimmed, spaces collapsed, 1 to 40 characters, no commas or control characters;
  at most 20 on a conversation, counted under the conversation's row lock. They are free text, as
  contact tags are: there is no central list, and the editor suggests the tags already in use.
- **Who:** members with `inbox.reply` add and remove tags on the conversations they can see (the
  sight rule of replies and notes); everyone who sees a conversation sees its tags. The conversation
  of an erased contact takes no new tags. Each change emits a `conversation.tags` live event, so
  open inboxes refresh. Changes are not audited, as contact tags' are not.
- **Inbox:** each conversation in the list shows its tags. The filter's Tag choice lists the tags on
  conversations the member can see (at most 200, alphabetically), so an agent never learns the tags
  of conversations they cannot open, and lists the conversations with the tag chosen. The
  conversation page shows its tags with an editor that takes several at once, separated by commas.
- **Erasure and deletion:** erasing a contact deletes the tags of their conversations, as it deletes
  the conversations' notes: 0145 replaces `app.erase_contact` with that one statement added, and
  w360_definer reads and deletes only the current company's tags. The company's deletion deletes
  them before its conversations (step 365); the company data export carries them.

Not built: tags through the public API or webhooks, automations that tag, a central list of allowed
tags, renaming a tag everywhere, and reports by tag.

## ADR-221 Conversation tags through the public API (P5-08, W-035) (2026-10-06)

Context: members tag conversations since ADR-220, but an integration (a helpdesk, a CRM) could
neither read the tags nor set them, so the two sides could not share the labels.

Decision:

- **Read:** every conversation the API answers carries `tags`, alphabetically, with
  `conversations.read`. `GET /conversations` takes `tag` (written as tags are, so its case does not
  matter); a value that cannot be a tag is refused with 422 naming `tag`. Changing the conversations
  a filter finds (ADR-166) takes it too.
- **Change:** `PATCH /conversations/{id}`, `POST /conversations/update-many` and `/update-matching`
  take `addTags` and `removeTags` with `conversations.write`, applied after the status: written as
  tags are, each once, never both added and removed (422 naming `removeTags`), at most 20 on a
  conversation, counted under the conversation's row lock (422 naming `addTags`, or
  `change.addTags`, and nothing changed). What a conversation already has changes nothing.
- **A change of the tags is a change of the conversation**, through the API or the inbox: its
  `updatedAt` moves, so `updatedSince` finds it, and open inboxes refresh. Through the API it is
  audited as `conversation.tags_changed` with the counts added and removed, never the tags, as
  contacts' tag changes are.
- **The API document names no ADR:** a unit test now checks the whole document, and two descriptions
  that did were corrected.

Not built: webhook events or webhook filters on tags, tags in the message feed, and a list of the
tags in use through the API.

## ADR-222 Automations that tag the conversation and branch on its tags (P4-01, W-035) (2026-10-06)

Context: members and keys tag conversations since ADR-220 and ADR-221, but an automation that asks
the customer what they need could not label the conversation for the team ("refund"), nor take
another path for a conversation already labelled.

Decision:

- **A step, "Tag the conversation"** (`update_conversation`): add or remove one tag on the run's
  conversation, written as tags are, then go on to the next step. A conversation that already has 20
  tags keeps them; the step goes on and its log says why (`conversation_too_many_tags`), as a
  contact at its limit does. A conversation whose contact was erased takes no tag.
- **A condition rule, "A conversation tag"** (`conversation_tag`): the run's conversation has, or
  does not have, a tag, beside the contact's tags (whose rule is unchanged).
- **Applied as members tag:** the runner holds the conversation's row lock for the step, which
  members and keys take before changing its tags, so the count and the change see one state; a
  change moves `updatedAt` and emits the live event. The simulator shows what the step would do and
  keeps simulated conversation tags.
- **No migration:** steps live in the published versions' JSON. Workers roll out before the web
  tier, so a version with the new step is never read by a worker that does not know it.

Not built: a trigger when a conversation is tagged, tagging from the API's runs, and tags set from
saved answers.

## ADR-223 Telling customers their message was read and a member is writing (P3-06) (2026-10-06)

Context: a customer who writes to a company on HyFib never saw that anyone read their message: HyFib
did not send WhatsApp's read receipts, nor the typing indicator WhatsApp offers in the same request
(research M-045). P3-06 listed typing indicators.

Decision:

- **A company setting, off by default** (Settings → Inbox, "Read receipts and typing";
  `tenant.settings.manage`, audited as `inbox.read_receipts_updated`; migration 0146 adds
  `app.messaging_settings.read_receipts`): whether customers may see that the business read their
  message is the company's choice.
- **Read receipts:** when a member opens a conversation with unread messages, the transaction that
  marks it read queues one read receipt for the customer's latest message WhatsApp named (one job
  per message, signed, on the new `message.read` queue). Earlier messages are not marked one by one;
  whether WhatsApp shows them read too was not verifiable from this environment.
- **Typing indicators:** while a member who can reply and see the conversation writes in the
  composer, inside the 24-hour window on an active number, the composer asks at most every 20
  seconds; the server queues a typing indicator for the customer's latest message (which marks it
  read as well). Best effort: a refusal changes nothing for the member, and the composer stops
  asking once told the setting is off. How long WhatsApp shows the indicator is Meta's; it was not
  verifiable.
- **The worker sends** `POST /{phone-number-id}/messages` with `status: read`, the message's id and,
  for typing, `typing_indicator: {type: text}` (`GraphClient.markRead`), after checking again in the
  company's scope: the setting still on, an inbound message, the contact not erased, the number
  active and its account connected. Meta's refusal is logged with what Meta said; a failure worth
  trying again is retried for a read receipt (marking read again is harmless) and dropped for a
  typing indicator, which would only show late.

Not built: members' presence in the inbox (who else is viewing or writing in a conversation), read
receipts for automations' or keys' replies, and marking each unread message read.

## ADR-224 Merging two contacts (H-019) (2026-10-06)

Context: one person could be two contacts, and nothing joined them. WhatsApp lets customers write
with a username: a message naming them only by WhatsApp user id creates a contact without a number,
while the company already knows them by phone (imported, added by a member, read from a store).
Contacts from the API or a store can lack a number too. A later message naming both the user id and
the number failed its whole receipt: the user id's identity took a number another identity held,
against the unique index.

Decision:

- **Owners and administrators merge** (`contacts.write` and `contacts.delete`, so not while the
  company is suspended), from the contact they keep: "Merge a duplicate" finds the other by name,
  email or number, the review shows both side by side with what the result keeps and why a merge is
  refused, and a confirmation merges. It cannot be undone; the audit log has `contact.merged` with
  the merged contact's id and counts.
- **Everything moves to the kept contact** in one transaction (`app.merge_contacts`, SECURITY
  DEFINER): WhatsApp identities, conversations, the consent history (whole, with its times and
  sources), tags, CRM deals with their tasks and timeline (one statement, as their composite keys
  tie them to one contact), orders, store messages, conversation sources, campaign rows, automation
  runs, Flow sends and answers, and earlier merges into it. The kept contact keeps its name, number,
  email and field values and takes the other's where it has none. Of a campaign both were in, one
  row stays: the one a message was sent from, else one still waiting to be sent (so the person is
  not sent it twice), else the kept contact's.
- **The stricter consent:** the merged contact's opt-out stands on the kept contact, recorded as a
  consent event with the new source `merge` (at the later of now and the kept state's own time,
  where an opt-out wins a tie). A merge never adds an opt-in: one only the merged contact had stays
  in the history, the review says so, and a member records it again if the customer agreed.
- **Deleted, not emptied:** the merged contact is deleted once nothing names it, and
  `app.contact_merges` records who merged it into which contact, when, and the counts (no personal
  data), so a link to it leads to the kept contact. Anything that read it before the merge's locks
  committed first and was merged; anything still naming it afterwards meets its foreign key and
  fails (ingestion and jobs are retried, members' actions refused) instead of landing on a contact
  nobody sees. What the merge's own transaction captured about it (webhook events, the API's change
  records) goes with it.
- **Refused** (the review says why, and the function checks again under its locks): two phone
  numbers (a contact keeps one), conversations of both on the same company number (one conversation
  per number and contact; conversations are not joined), more than 50 tags between them, a campaign
  sent to both, an erased contact, and a message to the merged contact being sent (its answer is
  recorded for the contact read when it was claimed; queued sends are locked, so none is claimed
  during the merge).
- **Locks** in the order other writers take them: both contacts' conversations, then both contacts,
  then the merged contact's queued and in-flight sends and both contacts' campaign rows, each in id
  order. Consent events, the CRM timeline and what started an automation run stay append-only,
  except for an update that changes only `contact_id` while the function sets `w360.contact_merge`,
  by the definer role alone (it alone holds UPDATE on those columns), as erasure's exception (0005).
- **Also fixed:** a message naming a customer by user id and by a number another identity holds
  leaves the number with that identity and joins the user id's contact, instead of failing the
  receipt; a reply uses the identity WhatsApp updated last among those with a number (with two
  identities on an account it could take the one known by user id only and refuse).

Not built: merging through the API and a `contact.merged` webhook event (the merged contact's id
stops resolving: the API answers 404), joining two conversations on one number, merging contacts
that each have a number, undoing a merge, and suggestions of likely duplicates.

## ADR-225 Telling integrations about a merge (2026-10-06)

Context: a merge (ADR-224) deletes the merged contact. Integrations that keep copies of contacts,
from webhooks or the API's change feed, had no way to learn that its id was gone: events of it not
yet delivered stopped, the API answered a plain 404, and the feed never read it again, so their copy
stayed.

Decision:

- **A `contact.merged` webhook event**, one per merge, for the endpoints that choose it in Settings
  → Webhooks or through the API (no filter narrows it): `mergedContactId`, and `contact`, the
  contact it belongs to now as the API describes it when the event is delivered. After a later merge
  of that contact, that is the contact kept then: the merge points every earlier merge into it at
  the new kept contact (`app.contact_merges`). A trigger on `app.contact_merges` captures it when
  the merge records itself, after the merged contact is deleted, through
  `app.capture_webhook_event`. It has no `captured_xact`, so what the merge changed of the kept
  contact stays its own `contact.updated`. A `contact.created` or `contact.updated` of the merged
  contact not yet delivered ends as `event_gone`, as an event of anything gone does; a
  `consent.changed` of it is still sent, naming its id, as before.
- **The API answers a merged contact's id** on `GET` and `PATCH /contacts/{id}` and
  `POST /contacts/{id}/consent` with 404, reason `contact_merged`, and `mergedInto`, the contact it
  belongs to now; nothing is changed. Another company's contact, or an id that never was one, is
  plainly not found. `POST /contacts/update-many` says in its refusal that a contact may have been
  merged.
- **The change feed** records a change of the kept contact at every merge (the same trigger), and
  each contact it reads lists `mergedContactIds`: the contacts merged into it, oldest merge first,
  those merged into a contact merged into it later included. The kept contact's latest change is at
  or after the merge, so a reader learns of it however the feed was compacted; the merged contact's
  own changes go with it (ADR-224), so it is never read again.
- **Also:** a worker that meets an event type it does not describe (one a newer release added, read
  by a worker rolled back) fails the delivery without an attempt, to be replayed once fixed, instead
  of sending a body without data.

Not built: merging through the API, filters on merge events, and naming the kept contact in a
`consent.changed` of the merged contact delivered after the merge.

## ADR-226 Hiding customers' numbers from chosen roles (W-044) (2026-10-06)

Context: every member who could read contacts or conversations saw customers' whole phone numbers. A
company that lets agents or temporary staff answer customers may not want them to copy those
numbers, and WATI masks them for its operator role (research W-044).

Decision:

- **A permission and a company setting.** `contacts.view_numbers` ("see customers' phone numbers
  whole") is granted to every role that reads contacts, conversations, campaigns or orders (owner,
  admin, supervisor, agent, marketer, analyst), so nothing changes until a company chooses. Owners
  and administrators choose, in Settings → Security, the roles whose members see numbers masked:
  supervisors, agents, marketers and analysts (`app.tenants.masked_number_roles`, migration 0152);
  owners and administrators always see them whole. The member's context, built for every request,
  leaves the permission out when every role of the member that grants it is masked, so a member who
  also has another role sees numbers whole. Showing numbers to a role again needs a recent sign-in
  (as dropping two-factor does); both changes are audited.
- **Masked on the server.** A masked number keeps the plus, at most the first three digits and the
  last two, a dot for every other digit and at least three hidden (`+919•••••••45`). The services
  that give members contact data mask before anything leaves the server: contacts (list, contact
  page, its WhatsApp identities, the suppression list), the inbox (list, conversation, transcript,
  mentions), the CRM (deal and task cards, the contact panel, the contact picker), campaign
  recipients and their CSV, segment samples, store orders, the automation test picker, and contact
  exports. The contact page asks the suppression list by contact instead of handling numbers itself.
- **No digit-by-digit search.** For a masked member, searching contacts, conversations or store
  orders by digits matches a whole number only; part of a number finds nothing, so the hidden digits
  cannot be found by narrowing searches. Checks that tell whether a number the member types exists
  (adding a contact or a suppression, a campaign test send) stay: they confirm a number the member
  already has and reveal no other.
- **What a masked member cannot do:** replace a number they cannot see (refused, naming the
  setting); they can still add a number to a contact without one, and change everything else.
- **Not masked:** what customers sent (a number in a message, a contact card, a Flow answer, a saved
  answer of a run), free text members write, the public API and webhooks (they serve integrations;
  keys are created by owners and administrators), the company export (owners), and the merge pages
  (owners and administrators). A segment's calling-code condition takes up to four digits, so
  combined with other conditions it can tell a masked member a fourth leading digit.

Not built: masking per member rather than per role, masking emails, masking customers' numbers in
message content, and masking for API keys.

## ADR-227 Merging contacts through the API (2026-10-06)

Context: owners and administrators merge two contacts of the same person in the app (ADR-224), and
integrations hear of merges (ADR-225), but an integration that finds duplicates itself (a CRM that
knows a customer by phone and by WhatsApp user id) could not merge them.

Decision:

- **A `contacts.merge` scope** for `POST /contacts/{id}/merge` with `mergeContactId`: the contact
  the body names is merged into the one the path names, through `app.merge_contacts`, as in the app
  (the same moves, refusals, stricter consent and deletion). Merging deletes a contact, so only
  members who may delete contacts grant the scope (`contacts.delete`: owners and administrators); it
  is a writing scope, refused while the company is suspended or its plan has ended. A plan version
  that chose its scopes (ADR-092) leaves it out until a new version includes it (migration 0153).
- **Answers** the kept contact as it is now, the merged contact's id and the counts moved (200).
  Refusals: 404 for a contact of no one or another company, and `contact_merged` with `mergedInto`
  for one merged already; 409 for the same contact twice, an erased contact, or a message to the
  merged contact being sent; 412 for two numbers, conversations on the same number, more than 50
  tags between them or a campaign sent to both. With an `Idempotency-Key`, a retry answers the first
  response; a retry without one learns where the first merge went from the 404.
- **Recorded as the key's:** the audit log names the key; the merge record names no member, and an
  opt-out the merge carries is recorded with actor `system` (the function reads no key).

Not built: naming the key on the merge record and on the carried opt-out, merging many pairs in one
call, and suggesting duplicates through the API.

## ADR-228 Website buttons whose link ends with a value (2026-10-06)

Context: a utility template usually carries a link of its own for each customer (an order to track,
a booking to manage), but HyFib refused website buttons with a variable because the format of their
example was not confirmed. Meta's official OpenAPI description shows it (research M-198): a `URL`
button whose `url` ends with `{{1}}` is created with `example: ['summer2023']`, the value rather
than a whole link, and a send gives a `button` component (`sub_type` `url`, `index`) whose one
`text` parameter is the "suffix that is appended to the predefined prefix URL".

Decision:

- **The link:** a website button's link may end with one value, `{{1}}`, placed after the website's
  address in full: an https link whose host is followed by `/`, `?` or `#`, without a user name, so
  no value can change the website the button opens (checked by appending values that would lengthen
  the host, put it after a user name or add a port). A value elsewhere in the link, another
  variable, or a value right after the host is refused when a draft is saved; a synced template with
  one is shown as not sendable. The editor asks for an example, which goes to Meta as
  `example: [value]`; an example Meta's listing gives as a list or as text is kept as it is.
- **The values:** a send gives the end of each such link, in the order of the buttons:
  `params.buttons` from a contact's or a conversation's sender, `variables.buttons` through the API,
  whose template list gives `links` (each button's text and link) and `variables.buttons` (how
  many). A value holds no spaces or control characters, at most 1,000 characters, and must leave the
  link on the template's website; it is refused with the button's name, through the API as 422
  naming `variables.buttons.N` (or `messages.N.variables.buttons.N`). It is sent as given, without
  percent-encoding, as a `button` component with `sub_type` `url`, the button's `index` and one
  `text` parameter; button components follow the order of the buttons.
- **What is kept:** the message keeps each link as sent beside its button's text, and the inbox
  shows it as an https link opening in a new tab without the referrer.
- **Where they are sent:** from a contact or a conversation and through the API, and the template
  list marks them sendable. Campaigns, automations and store messages do not send them yet: the
  campaign editor and store messages leave them out of their template lists, automations list them
  with the reason, and each refuses one with the reason.

Not built: values from campaigns, automations and store messages, a value elsewhere than at the end
of a link, more than one variable in a link, and encoding values for a link (a value must already be
fit for one).

## ADR-229 Filling the ends of links from campaigns, automations and store messages (2026-10-06)

Context: since ADR-228 a template's website button can end its link with a value given when sending,
but only a member's send and the API gave one: campaigns, automations and store messages left such
templates out, although a personal link (an offer, a booking, a parcel to track) is what they most
often send.

Decision:

- **Campaigns** fill the end of each link from a source, as they fill variables: fixed text, the
  contact's name or a custom field, with a fallback (`variables.buttons`, also through the API's
  campaign drafts). A contact's value that cannot end the link (spaces or control characters, over
  1,000 characters, or one that would change the website) counts as no value: the fallback is used
  when it can, else the recipient is skipped with `missing_variable`, as for a variable without a
  value. A fixed text or fallback that cannot end the link is a review problem before submitting.
- **Automations:** a template step gives each link's end as text with placeholders (`links`;
  versions saved before have none), counted with the variables in the checks. The end is kept as
  rendered (white space is not collapsed); an empty one fails the run with `missing_variable`, and
  one the link cannot take ends it as `send_blocked` with the detail `invalid_link` when the
  template is queued.
- **Store messages** fill each link's end from the order or the checkout, or fixed text, with a
  fallback, as their variables (an order's tracking number to start with). An unusable value falls
  back or skips the message with `missing_variable`; fixed text or a fallback a link cannot end with
  is refused when the message is saved.
- **Every send takes them:** `sendSpecFor` no longer has a caller that cannot give the ends of
  links, so its option for them is removed and every caller is asked for `buttonParams`.

Not built: a browser test of the three editors' link fields (their database tests cover the sends),
encoding a value for a link, and a skip reason of its own for an unusable value.

## ADR-230 Emailing members when a customer's reply is overdue (P3-06) (2026-10-06)

Context: the inbox shows when each waiting customer's reply is due (the company's first-response
target, counted in business hours when they are on) and turns it red once it is overdue, but only
for members looking at the inbox. A customer waiting past the target while the member responsible is
away from the screen waits on, unseen.

Decision:

- **When:** the worker's minute sweep finds open reply turns that may be overdue
  (`ops.overdue_reply_turns`, a definer function giving ids only, for active companies with a
  target) and works through each company's in the company's own scope. The due time is the inbox's
  own (`replyDueAt`); a turn only ever waits for a member (an automation answering closes it, a
  resolve closes it, a member's reply closes it), and it is locked while the sweep decides, so a
  reply either waits for the sweep or is seen by it.
- **Once per wait:** `app.overdue_reply_notices` (migration 0154) records each turn's notice:
  `waiting` while business hours put its due time later than the target in absolute time (the sweep
  looks again at that time), then `sent` or `skipped` for good (a guard trigger keeps them as they
  are). A customer who writes again after a member's reply starts a new wait, noticed anew. A reply
  due more than a day before the sweep saw it (the worker was down, the company suspended) is
  skipped (`too_late`); turns are looked at only within 30 days of their start.
- **Who:** the member the conversation is assigned to while they can see and answer it; else the
  members of its team who can see and answer it; else the members who assign conversations (owners,
  administrators, supervisors). A member who turned these emails off (a new kind, `reply_overdue`,
  in Settings → Notifications, ADR-215) is not emailed, and nobody else is emailed in their place:
  such a wait is skipped (`opted_out`), as one nobody can answer is (`no_one`).
- **What:** one email per member per company in a sweep. For one conversation: the target, why it is
  theirs (assigned, their team's, nobody's), since when the customer waits, and the conversation's
  link; for several (business hours opening on a night's messages): how many, for what reasons, the
  longest wait, and the inbox's list by longest wait. Never the customer's name, number or messages:
  an email stays readable after its reader loses access.
- **No setting of its own:** a company without a first-response target gets no emails; one with a
  target gets them, and each member chooses theirs. Settings → Inbox says so beside the target.
- **Migrations:** 0154 adds the notices (deleted with the company before its turns, exported with
  the company, gone with their turn), the sweep function and the definer's reads, and the new kind
  in the members' email choices; 0155 builds the index of open turns by start concurrently.

Not built: in-app notices, a second email when a wait drags on, per-team targets and calendars,
escalation to supervisors when the assignee does not answer, and a digest across sweeps.

## ADR-231 Segment conditions on store orders (W-051) (2026-10-06)

Context: companies with a connected Shopify or WooCommerce store keep a copy of its orders (P4-06b),
and members see each contact's orders, but campaigns could not be aimed at contacts by what they
bought: those who ordered twice, those who have not ordered in 90 days, those who spent ₹5,000.
Segments only knew contacts' own data and messages.

Decision:

- **Two conditions:** `orders` counts a contact's orders (at least, or fewer than, a number from 1
  to 10,000) and `spend` totals them in one currency (at least, or less than, an amount in the
  currency's minor unit, ISO 4217 codes the runtime knows). Each can look at the last 1 to 3,650
  days and at one of the company's stores; left out, every order and every store. They combine with
  the other conditions under all/any, in saved segments, campaign audiences and API searches alike.
- **Which orders:** matched to the contact by number (`customer_phone` against the contact's E.164
  number, as the inbox's order panel matches them); a contact without a number has none. An order
  counts unless the store marked it as a test, cancelled, deleted, or with a status of cancelled,
  refunded, failed, trash or checkout-draft, or a payment status of refunded, voided or expired.
  Spend adds the totals the store reported, in the condition's currency only: no conversion, and a
  partial refund is not taken off.
- **SQL:** a correlated count or sum over `app.commerce_store_orders` per contact, every value a
  parameter, filtered by the company as well as by RLS so the existing
  `(tenant_id, customer_phone, placed_at)` index serves it. No migration.
- **Who:** previewing or saving a segment with such a condition, and giving a campaign draft such an
  audience, needs `commerce.read` as well as the segment or campaign permission. A saved segment
  with one shows members who cannot read store orders how many contacts it matches, never which.
  Through the API the conditions need `orders.read` too, wherever a key gives them (searches,
  changing matching contacts, segments, a segment's contacts, drafts' audiences), and a store named
  must be the company's (another company's reads as one that does not exist).
- **Builder:** the condition types appear when the member can read store orders and the company has
  a store (spend also needs orders in some currency); the currency list is the currencies of the
  company's orders, and amounts are typed in major units.

Not built: products or categories bought, the first or last order date, average order value, refunds
taken off spend, and orders matched by email. Contacts without a number never match an order
condition.

## ADR-232 Starter templates (W-070) (2026-10-06)

Context: a member creating a company's first templates starts from an empty editor and has to learn
Meta's form (numbered variables with examples, categories, buttons) before anything can be sent
outside the 24-hour window. Most companies need the same few: order and shipping updates, reminders,
payment notices, a welcome and an offer.

Decision:

- **Twelve starters, HyFib's own copy:** eight utility (order confirmation, shipping update,
  delivery confirmation, appointment reminder with Confirm and Reschedule replies, booking
  confirmation, payment reminder, payment received, request update) and four marketing (welcome,
  back in stock, seasonal offer, cart reminder), in English, each with example values for its
  variables (`templates/library.ts`). They hold no website or phone button, which need the company's
  own address or number, and no body starts or ends with a variable (HyFib's rule for its starters,
  not a verified Meta rule).
- **Starting a draft:** the New template page lists them; choosing one fills the editor with its
  name, category and content, which the member changes before saving as any draft. Nothing is
  created until they save, and saving and submitting are the drafts' own (validation, Meta's review,
  which decides the category).
- **Opt-out button:** a marketing starter gets a quick reply carrying the company's first marketing
  opt-out keyword (Settings → Messaging), when it fits a button; a customer's tap sends the keyword,
  which HyFib already records as a marketing opt-out. Without one, the page asks the member to give
  customers a way to stop offers.
- **Checks:** a unit test passes every starter through the draft schema and checks, the round trip
  through Meta's component format, and HyFib's starter rules. No migration, no new permission (the
  page needs `templates.write`; it reads the keywords with `contacts.read`).

Not built: starters in other languages, starters with media headers or website buttons, a gallery of
other companies' approved templates, and starters through the API.

## ADR-233 The setup checklist from the company's own data (W-026) (2026-10-06)

Context: the overview's "Get started" list was written in phase 1: verifying an email (always done),
two-factor authentication, inviting the team, and a WhatsApp number marked as not available until
phase 2. Numbers have long been connectable, yet the step never showed one as connected, and nothing
pointed new companies at templates, contacts or a reply target.

Decision:

- **Steps from data:** two-factor authentication (the member's own); a WhatsApp number (done while
  one is active; a number to reconnect is said so); a template Meta approved (a draft is not
  enough); a contact that is not erased; a teammate who is active or invited and not expired; a
  first-response target. `createSetupChecklistService` reads them in one read-only transaction in
  the company's scope, and `setupSteps` turns them into steps with links.
- **What each member sees:** a step appears only to members who can read its data (`channels.read`,
  `templates.read`, `contacts.read`, `members.read`; the target to those who set it,
  `tenant.settings.manage`), and its fact is not even read for others. Links go to the page where
  the step is taken; a member who cannot write templates is sent to the list, one who can to a new
  draft with HyFib's starters (ADR-232).
- **Honest about the deployment:** with no number and Meta's Embedded Signup not set up for the
  deployment, the number step says so instead of pointing at a page that cannot connect one.
- **Not a step:** Meta's business verification, which HyFib cannot read, and checking a member's
  email, which every member has done. No migration.

Not built: dismissing the checklist, steps for automations, campaigns or stores, and counting
progress across members.

## ADR-234 Moving deals between pipelines in the app (P4-04) (2026-10-06)

Context: since P4-04 the CRM service has moved a deal to a stage of another pipeline (a value in a
different currency must be cleared first) and recorded the move on the deal's timeline, but the app
only offered the stages of the deal's own pipeline. A deal opened in the wrong pipeline had to be
lost and created again, losing its history.

Decision:

- **The deal page offers it:** an open deal's page has "Move to another pipeline" for members with
  `crm.write`: the company's other active pipelines that have a stage, each with its currency, and a
  stage of the one chosen. The move is the service's own (`moveDeal` with the pipeline): the version
  check, the pipeline and stage checks, the currency rule and the timeline entry ("Qualified → New
  (another pipeline)").
- **No new rule:** a deal keeps its value between pipelines of one currency; to move a deal with a
  value to a pipeline in another currency, a member clears the value first, as the service's refusal
  says. Archived pipelines and stages are not offered and are refused.
- **Tests:** an integration test of a successful move (value kept, timeline entry, both boards) and
  of the refusals (a stage of another pipeline, another company's pipeline, an archived pipeline);
  the CRM e2e test moves its deal to a second rupee pipeline. No migration.

Not built: moving deals in bulk, from the board, or through the API.

## ADR-235 Exporting WhatsApp orders as CSV (P4-06a) (2026-10-06)

Context: Commerce → Orders lists the carts customers send from the company's WhatsApp catalog, fifty
at a time, but a company reconciling orders with its accounts or its warehouse had no way to take
them out of HyFib. Campaign recipients and contacts already export as CSV.

Decision:

- **What:** one line per order the member can see (the inbox's visibility, as the list), newest
  first, filtered by status as the list is: the order id and reference, when it was received, its
  status and when that changed, when it was paid, the customer's name and number, the items ("2 ×
  Blue kurta; 1 × sku-9", product names where the catalog gave them), how many items and how many
  could not be read, the currency and the subtotal in its major unit (exact, from minor units), and
  the customer's note. Times are UTC, ISO 8601.
- **Who:** `commerce.read` and `contacts.export`, since the file carries customers' names, numbers
  and notes (owners and administrators; marketers export contacts but see no conversations, so their
  file is empty). Numbers are shown as the member may see them (ADR-226). An erased contact's orders
  stay in the file as "Erased contact", with neither number nor note.
- **How:** `exportOrders` streams batches of 500 by received time and id, formula-safe (`csvLine`),
  through `GET /c/{slug}/commerce/orders/export`, which authorizes before the first byte; each
  export is audited (`commerce.orders_exported`, with the status filter). No migration.

Not built: order reports (totals by day or product), exports through the public API, and a choice of
columns or time zone.

## ADR-236 Form bodies for automation HTTP steps (P4-02) (2026-10-06)

Context: an automation's "Call a web address" step sends a JSON body, its placeholders JSON-escaped.
Many company systems (SMS gateways, older CRMs, payment and form endpoints) take
`application/x-www-form-urlencoded` fields instead, and a JSON body could not reach them.

Decision:

- **A body format per step:** `bodyFormat` is `json` (the default, and what a step without it means,
  so every saved automation is unchanged) or `form`. A form body is written as fields, `name=value`
  joined by `&`, already URL-encoded (`%20` or `+` for a space), with placeholders for values, for
  example `phone={{answer.phone}}&note=Hello%20there`.
- **Encoding:** a placeholder's value is URL-encoded in a form body (`encodeURIComponent`), as it is
  in the address, so a customer's text can neither add a field nor end one; in a JSON body it stays
  JSON-escaped. A form body is sent as `application/x-www-form-urlencoded`: the runner adds the
  header to the written-ahead request, and the egress client keeps it.
- **Checks at publish:** a form body must be fields as above (each with a name, no stray spaces, a %
  only starting an encoded character); a Content-Type header beside it is refused, since HyFib sets
  it. A JSON body is checked as before.
- **Editor:** "Body format" on the step (JSON or form fields), with an example for each. No
  migration: the format lives in the automation's graph.

Not built: multipart bodies, form bodies built field by field in the editor, and secrets in bodies
(still header values only).

## ADR-237 Exporting automation runs as CSV (P4-01) (2026-10-06)

Context: the runs list shows fifty runs at a time with each run's automation, version, status, end
reason, trigger, times and counts. A company measuring its automations (how many runs hand off, fail
or finish, by version) had to read them page by page.

Decision:

- **What:** one line per run the list shows, newest first, with its filters (an automation, a
  status, "active" for running and waiting): the run id, the automation's name, the version number,
  live or test, the status, the end reason, the trigger, when it started and ended (UTC, ISO 8601),
  and its step and message counts.
- **No customer data:** neither the contact nor the conversation nor the answers a run captured, so
  the export needs only `automations.read`, as the list does; analysts and marketers export what
  they already see. Names are formula-neutralised (`csvLine`).
- **How:** `exportRuns` streams batches of 500 by start time and id through
  `GET /c/{slug}/automations/runs/export`, which checks the permission and the filters before the
  first byte; each export is audited (`automation.runs_exported`, with its filters). No migration.

Not built: exporting a run's steps or captured answers, and exports through the public API.

## ADR-238 Setting a custom field on every contact a filter matches (P3-01) (2026-10-06)

Context: bulk tag edits (ADR-213) change one tag on every contact the contacts page's filters match.
Custom field values (a city, a plan, a renewal date) were still set one contact at a time, or by
importing a CSV of the contacts again with the value in a column.

Decision:

- **From the contacts page, beside the bulk tag edit:** a member with `contacts.write` chooses one
  of the company's custom fields and sets one value on every contact the filters match, or clears
  the field on all of them, the number shown in the form. The member confirms first: each contact's
  own value is replaced, which cannot be undone.
- **The rules of bulk tag edits:** at most 10,000 matches; in one transaction the matching contacts
  are locked and counted again, and a count other than the one shown refuses the edit; erased
  contacts never match.
- **The value is checked as one contact's edit checks it:** against the field's type (text up to 500
  characters, a number, a real date, yes or no), and an empty value clears. A field must be the
  company's own. Contacts that already have the value (or, clearing, have none) are left untouched;
  the result counts the contacts changed and those left as they were.
- **Each changed contact is a change,** in the contact feed and as a `contact.updated` webhook event
  naming the field, as when one member edits it (the triggers on the contact's values). The audit
  entry (`contacts.bulk_field_set`) holds the field's key, whether it was cleared, the counts and
  which filters were used, never the value or the search text.
- **No migration;** the API is unchanged.

Not built: bulk changes of consent (each contact's consent needs its own provenance; an import
carries an attestation), of names, emails or numbers (each contact's own), bulk edits from a segment
or through the API, choosing contacts one by one, and undo.

## ADR-239 Exporting deals as CSV (P4-04) (2026-10-06)

Context: the board shows the open deals of one pipeline, at most 200 per stage, and the won and lost
lists fifty at a time. A company reviewing its pipeline in a spreadsheet, or keeping its deals
elsewhere as well, had no way to take them out.

Decision:

- **What:** one line per deal the view shows, all of them, newest first: the open deals of the
  board's pipeline with its owner filter, or the won or lost deals. Each line holds the deal id,
  title, pipeline, stage, status, currency, value (exact, in the currency's major unit), owner, the
  contact's name and number, expected close date, when it was created, entered its stage and closed
  (UTC, ISO 8601), the lost reason and its open tasks.
- **Who:** deals carry customers' names and numbers, so the export needs `contacts.export` as well
  as `crm.read`, as the orders export does (ADR-235): owners and administrators by default. Numbers
  are shown as the member may see them (ADR-226); an erased contact is named as such, without a
  number. Values are formula-neutralised (`csvLine`).
- **How:** `exportDeals` streams batches of 500 by creation time (exact to the microsecond) and id
  through `GET /c/{slug}/crm/export`, which checks the permissions and the filters (a status, a
  pipeline of the company, an owner) before the first byte; each export is audited
  (`crm.deals_exported`, with its filters). No migration.

Not built: importing deals, exporting tasks, notes or timelines, and exports through the public API.

## ADR-240 Keyword triggers that also match small typos (P4-01) (2026-10-06)

Context: keyword triggers match whole words exactly (case, punctuation and Unicode forms aside).
Customers type on phones: "refnud", "delivry" and "cancelation" started nothing, and the
conversation waited for a person.

Decision:

- **Opt-in per trigger:** "Also start when a keyword is written with a small typo" (`typos` on the
  keyword trigger, absent before, so every saved trigger reads as it did). It applies to both modes:
  the message is a keyword, or contains one.
- **What counts as a small typo:** per word of the keyword, a character inserted, deleted or
  replaced, or two neighbours swapped (optimal string alignment distance, in characters rather than
  UTF-16 units): one in words of 5 to 8 characters, two from 9. Shorter words ("menu", "help") have
  too many neighbours and must match exactly, and so must any word with a digit, so an order number
  is never taken for another. The first letter must match, which keeps "border" from starting
  "order". Words are still whole: a typo never joins or splits them.
- **A typo never beats a match without one:** triggers rank exact keyword, contained keyword,
  keyword with typos, new conversation, any message; a run started by a typo is still a keyword
  start. The builder warns when no keyword word allows a typo.
- **No migration;** the trigger is part of the automation's JSON. The API does not expose keyword
  triggers, so it is unchanged.

Not built: typos in team routing keywords and in consent keywords (an opt-out matched by similarity
would be a guess, so consent keywords stay whole-message matches in `consent/keywords.ts`), phonetic
or transliteration matching (Hinglish spellings), and a per-trigger tolerance setting.

## ADR-241 A notice of overdue replies in the inbox (P3-06) (2026-10-06)

Context: the inbox marks each overdue reply in its list, and ADR-230 emails the member responsible.
A member working in the inbox had to scan the list, and the marks were computed when the page
loaded: a customer whose wait passed the target while the member read a thread stayed unmarked until
something else refreshed the page.

Decision:

- **Where:** above the conversation list on the inbox, conversation and mentions pages, for members
  with inbox access: "3 customers are waiting past the reply target, 1 of them assigned to you",
  with a link to the open conversations by longest wait.
- **Whose waits:** those of the open conversations the member can see, by the inbox's own rule (all
  of them with `inbox.read_all`; the member's own and the unassigned ones with
  `inbox.read_assigned`), each due as the list computes it (the first-response target, in business
  hours when they are on). None without a target.
- **Following the clock:** `waitingReplies` gives the page the due times of at most the 200 earliest
  waits and whether each is the member's, nothing else (no customer, conversation or message); the
  notice counts those past due every 10 seconds in the browser, so a wait turning overdue shows
  without a reload, and live updates bring new waits. When more customers wait than came and all
  that came are overdue, it says "at least". The first render uses the server's time, so the page
  matches its HTML.
- **No migration;** the API is unchanged.

Not built: a notice outside the inbox (the navigation or other pages), a sound or browser
notification, per-team targets, and presence of members.

## ADR-242 Stage chances of winning and a weighted forecast on the CRM board (P4-04) (2026-10-06)

Context: the board totals each stage's open deals at full value, so a pipeline full of early-stage
deals looked as valuable as one about to close, and there was no figure for what the month was
likely to bring.

Decision:

- **A chance per stage:** owners and administrators may give each stage, in Settings → Pipelines, a
  whole-percentage chance of winning its deals (`crm_stages.win_percent`, 0 to 100, empty by
  default; migration 0156). A new pipeline's stages take one with their names; saving a pipeline
  without a stage's chance keeps it. Like the rest of a pipeline, it is a company setting
  (`tenant.settings.manage`, the update audited as before).
- **On the board:** each stage with a chance shows it and its open deals' value times it (rounded to
  the minor unit). Above the columns, when any stage has a chance: the weighted pipeline (the sum
  over stages with a chance) and the weighted value of the deals expected to close by the end of the
  month in the company's time zone (a past expected date included), with the board's owner filter.
  Stages that hold open deals but have no chance are left out and counted, so the figure never looks
  complete when it is not.
- **Additive:** a nullable column without a default; the account export includes it. The API is
  unchanged.

Not built: chances per deal, forecasts in Reports or by month further ahead, won and lost history to
suggest chances, and the forecast through the API.

## ADR-243 Members who have a conversation open (P3-06) (2026-10-06)

Context: nothing told a member that a teammate was reading the same conversation, so two members
could answer the same customer at once; the send-time collision warning only refused the second
reply after it was written.

Decision:

- **Reports from the page:** while a conversation's page is open and visible, it reports to
  `/api/c/<company>/inbox/<conversation>/presence` every 20 seconds, at once when it becomes visible
  again, and says the member left (DELETE, kept alive past the page) when the member moves to
  another conversation or leaves the page. The route takes the member's session and HyFib's own
  origin only.
- **What the member sees:** the answer names the other active members reported within 45 seconds
  (two reports, so one late report does not hide anyone) who can see the conversation by the inbox's
  rule now, first three by name and the rest counted ("Ravi also has this conversation open."). A
  report that fails says so instead of showing nobody. A member reports and hears only about
  conversations they can see; another company's conversation, or one they lost sight of, is not
  found.
- **Storage:** one row per member and conversation in `app.conversation_viewers` (migration 0157):
  ids and a time, nothing about the customer, its time moved forward by each report. Leaving deletes
  the member's row; the worker's minute sweep deletes rows not reported for an hour through
  `ops.purge_conversation_viewers`, a definer function whose policies let it see only such rows. The
  rows are deleted with the company and left out of the account export.

Not built: who is typing a reply or a note, presence in the conversation list, and presence through
the API or webhooks.

## ADR-244 Automation steps that create a CRM task (P4-01, P4-04) (2026-10-06)

Context: an automation could answer, ask, tag and hand over, but a conversation that ended with
"please call me" left nothing in the CRM: someone had to read the run and create the task by hand.

Decision:

- **The step:** "Create a CRM task" (`create_task`) has a title (up to 200 characters, with the
  placeholders of a message: the contact's name, the company, answers, order fields or the call's
  inputs), the member it is for, and an optional due time 1 hour to 90 days after the step runs. The
  title is filled in when the step runs, on one line. The run goes on to the next step.
- **Who the task is for:** a chosen member, who must be an active member who can use the CRM when
  the automation is published and when the step runs. During a run the conversation is unassigned (a
  member taking it ends the run), so "the conversation's assignee" is not offered.
- **Created as the automation:** a task records the automation that created it
  (`crm_tasks.created_by_automation_id`; migration 0158 makes `created_by_membership_id` nullable
  and checks that exactly one creator is set) and is about the run's contact; its `task_created`
  activity has no member as actor and names the automation and the run, and the timeline says "by an
  automation". No member is impersonated.
- **When no task is created:** a member who left or can no longer use the CRM, an erased contact, or
  a title whose placeholders filled in nothing: the step is logged as skipped with the reason (a new
  step outcome, `skipped`; a created task is `created`), and the run goes on, so a change in the
  team never stops a conversation with a customer. A test run creates its task too, like its other
  changes.
- **Permission:** publishing or testing an automation with a task step needs `crm.write`, as
  creating a task does, as publishing marketing templates needs `campaigns.send`.
- **Migrations:** 0158 adds the column and, NOT VALID, the creator check, the foreign key to the
  automation and the run steps' outcome check with `created` and `skipped`; 0159 validates them
  without blocking writes.

Not built: steps that create deals, a reminder email for an automation's task, tasks for the
conversation's team or in turn, and a link from the task to the run.

## ADR-245 Automation steps that create a CRM deal (P4-01, P4-04) (2026-10-06)

Context: after ADR-244 an automation could ask for a follow-up, but a customer who showed interest
still reached the pipeline only when a member created the deal by hand.

Decision:

- **The step:** "Create a CRM deal" (`create_deal`) has a title (up to 120 characters, with the
  placeholders of a message), a stage of an active pipeline, an optional value typed in the
  pipeline's currency (read exactly by the CRM's money rules) and an optional owner. The deal is for
  the run's contact and from the run's conversation, in the chosen stage, created by the automation
  as tasks are (`crm_deals.created_by_automation_id`, migrations 0160 and 0161 with the same NOT
  VALID then VALIDATE steps as 0158 and 0159). Its `deal_created` activity has no member actor and
  names the automation and the run; the deal page says "by an automation".
- **One open deal per pipeline:** no deal is created when the contact already has an open deal in
  that pipeline, so a customer who asks twice is not counted twice; runs of the same contact in two
  conversations take the contact's row lock one after the other.
- **When the company changed:** an archived pipeline or stage, an erased contact, an open deal or an
  empty title skips the step (logged as `skipped` with the reason); an owner who can no longer use
  the CRM, or a value that is no longer an amount in the pipeline's currency, is left out of the
  deal with a note. The run goes on in every case. Publishing checks the stage, the value and the
  owner; publishing or testing needs `crm.write`, as for task steps.

Not built: moving an existing deal from an automation, setting the expected close date, and choosing
what happens when an open deal exists (update it, or create another).

## ADR-246 Reminder emails for the tasks automations create (P4-01, P4-04) (2026-10-06)

Context: a task an automation created (ADR-244) reached its member only through the CRM's task list,
while a member creating a task can ask for a reminder email.

Decision:

- A task step may ask to email the member a reminder when the task is due (`remind`, only with a due
  time; publishing refuses a reminder without one). The task is created with its reminder at the due
  time and the `crm.reminder` job queued in the step's transaction, exactly as a member's task with
  a reminder, so the reminder rules apply unchanged: it is sent once, only while the task is open
  and the member can still use the CRM, and not when more than a day late. Versions saved before
  have no `remind` and send no reminder. No migration.

Not built: a reminder at another time than the due time, and reminders for the deals automations
create.

## ADR-247 An expected close date from deal steps (P4-01, P4-04) (2026-10-06)

Context: the board's forecast of the month (ADR-242) counts deals by their expected close date,
which deals created by automations (ADR-245) never had.

Decision:

- A deal step may expect the deal to close a number of days after the step runs (0 to 365,
  `closeInDays`), counted on the company's calendar in its time zone (`localDateAfter`), so a step
  run late in the evening in India counts from the Indian date. Versions saved before have no
  expected date. No migration.

Not built: a date from an answer or an order, and moving the date when the deal changes stage.

## ADR-248 Automation steps that send a WhatsApp form (P4-01, P4-03) (2026-10-06)

Context: a form (WhatsApp Flows, ADR-045) could be sent only by a member from a conversation, so an
automation answering a customer could not hand them a form to fill in.

Decision:

- **The step:** "Send a form" (`send_flow`) sends one of the company's published forms in the
  conversation the run answers, with a message (up to 1,024 characters, with the placeholders of a
  message), an optional header and footer (60 characters each) and a button text (30), the limits of
  a member's form. It is a session message like a text: it needs the 24-hour window, follows a
  customer's reply in automations started by a store or the API, and counts against the run's
  message budget.
- **Sent like a member's form:** after a text's checks (an active number, an open window, a
  WhatsApp number for the contact), the runner queues it through the send pipeline with a new flow
  token recorded for the conversation and contact (`flow_sends`, with no member), so the customer's
  answers are applied to the contact as the form maps them. The message is the bot's and names the
  run.
- **When the form or the plan changed:** publishing needs a form published at Meta (or throttled),
  of the WhatsApp account of the automation's number when it has one; the run checks again when it
  sends, and a form archived, no longer published or of another account than the number ends the run
  with `send_blocked` (`flow_unavailable`), passing the conversation to people, as for a text that
  cannot be sent. As in the inbox, the company's plan must include WhatsApp Flows: publishing or
  testing such an automation is refused without it, and a run ends with `flows_not_in_plan` when the
  plan no longer includes it. No migration.

Not built: forms from campaigns and templates, a draft form sent by a test run, waiting for the
form's answers before the run goes on, and branching on them.

## ADR-249 Task and deal steps follow the plan's CRM (P4-01, P4-04) (2026-10-06)

Context: a plan without the CRM takes away writing it (ADR-051: `crm.write` leaves the members'
permissions; read access stays). Publishing a task or deal step needs `crm.write`, so a company
without the CRM could not publish one, but an automation published before a change of plan kept
creating tasks and deals that no member of the company could create any more.

Decision:

- Task and deal steps check the company's plan when they run: without the CRM the step creates
  nothing, is logged as `skipped` with `crm_not_in_plan`, and the run goes on, as other CRM steps
  that create nothing do, and as order messages are skipped when the plan leaves out commerce.
- Publishing or testing such an automation says that the plan does not include the CRM, before the
  permission check. No migration.

Not built: a notice to the company when its automations skip steps after a change of plan.

## ADR-250 Automation steps that move a CRM deal (P4-01, P4-04) (2026-10-06)

Context: automations could create a deal for a customer (ADR-245) but not move it on, so a customer
who paid, booked or answered a question still needed a member to drag their deal to the next stage.

Decision:

- **The step:** "Move the CRM deal" (`move_deal`) moves the run's contact's open deal in a chosen
  pipeline to a chosen active stage of it, as a member's move does: the stage and the time it was
  entered change, the deal's version moves on (so a member editing it at the same time is told it
  changed), and a `stage_changed` activity without a member actor names the automation and the run,
  which the timeline shows as "by an automation".
- **Only when it is clear which deal:** nothing moves, the step is logged as `skipped` with the
  reason and the run goes on, when the contact has no open deal in the pipeline (`deal_not_open`) or
  more than one (`deal_ambiguous`: which one is meant is not known), when the deal is already in the
  stage (`deal_in_stage`), when the stage or its pipeline was archived, when the contact was erased,
  or when the plan no longer includes the CRM (ADR-249). Moving to another pipeline is left to
  members.
- **Checks and locks:** publishing checks the stage against the company's active pipelines;
  publishing or testing needs `crm.write` and the CRM in the plan, as for the other CRM steps. The
  runner locks the contact against erasure, shares the pipeline against archiving, then locks the
  deals, the CRM's order. Run steps get the outcome `moved` (migrations 0162 and 0163: the outcome
  check replaced NOT VALID, then validated).

Not built: closing a deal as won or lost from an automation, moving it to another pipeline, and
choosing which of several open deals to move.

## ADR-251 Automation steps that close a CRM deal (P4-01, P4-04) (2026-10-06)

Context: after ADR-250 an automation could move a customer's deal but not close it, so a paid order
or a customer's "no thanks" still needed a member to mark the deal won or lost.

Decision:

- **The step:** "Close the CRM deal" (`close_deal`) closes the run's contact's open deal in a chosen
  active pipeline as won or lost, with an optional reason for a lost deal (up to 200 characters, the
  CRM's limit, kept as written), as a member closes it: the status and the time it closed change and
  the version moves on. No member is its closer; its `deal_won` (with the value) or `deal_lost`
  activity has no member actor and names the automation and the run, so the timeline says "by an
  automation". A member reopens such a deal as any other.
- **On the same terms as a move (ADR-250):** nothing closes, the step is logged as `skipped` and the
  run goes on, when the contact has no open deal in the pipeline or more than one, when the pipeline
  was archived, when the contact was erased, or when the plan no longer includes the CRM; publishing
  checks the pipeline and needs `crm.write` and the CRM in the plan. The lookup and the locks are
  shared with moves. Run steps get the outcome `closed` (migrations 0164 and 0165, as 0162 and
  0163).

Not built: recording the automation on the deal row as its closer (the timeline names it), and a
reason filled in from the conversation.

## ADR-252 A weighted CRM forecast in Reports (P4-04) (2026-10-07)

Context: the CRM board weighs open deals by each stage's chance of winning for the pipeline and for
the current month (ADR-242), but Reports showed only the open pipeline by stage, so a company could
not see what to expect in the coming months.

Decision:

- **What:** under each pipeline's open pipeline, a "Weighted forecast" (`crm.forecast`, version 1)
  of its open deals in active stages by the month they are expected to close: this month (dates
  already past included, as on the board), the next two months, later, and without a date, each with
  the number of deals, their value and that value weighed by each stage's chance, in the pipeline's
  currency. Months are the company's.
- **The same arithmetic as the board:** each stage's deals in a bucket are weighed once
  (`forecastByMonth`), so this month's weighted value equals the board's. Deals in stages without a
  chance count in the deals and the value and are named apart; a pipeline without any chance shows
  no weighed values and says where to set them.
- **Like every report number:** computed when the page loads in the report's read-only snapshot,
  with `reports.read`; its definition is persisted with the others (migration 0166) and a test keeps
  the table equal to the registry. It is a state now, not a period figure, so it is not in the deals
  section's CSV export, as the open pipeline is not.

Not built: forecasts by owner or by month beyond the third, and history of past forecasts (nothing
is stored).

## ADR-253 Reading CRM deals through the public API (P5-08, P4-04) (2026-10-07)

Context: integrations could read a company's contacts, conversations, campaigns and orders through
the API, but not its CRM: a data warehouse, a sales dashboard or another CRM had no way to read the
pipelines and the deals members and automations move on the board.

Decision:

- **A new reading scope, `deals.read`** ("Read CRM deals"), granted with `crm.read`, the permission
  members read the CRM with; only owners and administrators create keys, and both hold it. It only
  reads, so it works while the company is suspended or restricted, as every reading scope does.
  Existing keys keep their scopes, and a plan version that chose its scopes (ADR-092) leaves it out
  until a new version includes it.
- **The CRM in the plan:** pipelines and deals are the CRM's, so a plan without it reads none
  through the API (403, reason `not_in_plan`), as orders need Commerce (ADR-167); checked first in
  the transaction. Members keep reading the CRM in the app after a downgrade (ADR-051).
- **Endpoints:** `GET /api/v1/pipelines` (`listPipelines`) pages the company's pipelines oldest
  first, archived ones too, each with its stages in board order (archived ones last) and each
  stage's chance of winning, read in one snapshot. `GET /api/v1/deals` (`listDeals`) pages its
  deals, open and closed, newest first by when they were created, on exact keyset pages
  (`crm_deals_list_idx`, built concurrently by migration 0168), filtered by `pipelineId`, `stageId`,
  `status`, `contactId`, `ownerId` (or `none`) and `updatedSince`; `GET /api/v1/deals/{id}`
  (`getDeal`) reads one. Another company's deal and an unknown id answer 404, and an id that is not
  a UUID is refused before any query.
- **A deal with ids only:** its title, pipeline and stage (a closed deal keeps the stage it was
  closed in), status, value as an integer in the pipeline currency's minor units with the currency,
  the contact, the conversation it was created from and the owner by id (the owner as GET /members
  names members), the expected close date, when it entered its stage, the lost reason, when it
  closed, was created and last changed. Never notes, tasks, the timeline or the contact's name or
  number, which `contacts.read` reads.
- **Erased contacts:** deals are kept for reports, renamed and without the lost reason (erasure),
  and read as they are; erasure changes a deal's `updatedAt`, so a pass catching up on changes sees
  it again.
- **Reads only:** one read-only transaction per call, the pipelines' in repeatable read so a page's
  stages are of the same moment as its pipelines. A call counts as one request. Migration 0167
  replaces the key and plan scope checks with ones that also accept `deals.read`, validated at once
  (one row per key and per plan version), as 0153 did.

Not built: changing deals or pipelines through the API, tasks and notes, the timeline, deal webhook
events, and who created a deal (a member or an automation).

## ADR-254 Creating CRM deals through the public API (P5-08, P4-04) (2026-10-07)

Context: after ADR-253 an integration could read the company's deals but not add one, so a web shop,
a booking form or another CRM still needed a member to type each new deal on the board.

Decision:

- **A new writing scope, `deals.write`** ("Create CRM deals"), granted with `crm.write`, the
  permission members create deals with; only owners and administrators create keys, and both hold
  it. It writes, so it is refused while the company is suspended or restricted (423). Existing keys
  keep their scopes, and a plan version that chose its scopes (ADR-092) leaves it out until a new
  version includes it.
- **`POST /api/v1/deals` (`createDeal`)** creates a deal as members do on the board: for a contact
  of the company that exists and was not erased (404 otherwise, with reason `contact_merged` for a
  merged one), in an active pipeline and an active stage of it (its first when `stageId` is left
  out), with a title of up to 120 characters, a value as an integer in the pipeline currency's minor
  units up to the CRM's limit, an owner who is an active member able to use the CRM, and an expected
  close date. An unknown pipeline, a stage of another pipeline or an owner who cannot use the CRM is
  refused with 422 naming the field; a pipeline or stage members archived with 409. The CRM must be
  in the plan (403, reason `not_in_plan`). It answers 201 with the deal as GET /deals/{id} reads it;
  with an `Idempotency-Key`, a retry answers the first response.
- **Recorded as the key's:** the deal names the key as its creator (`created_by_api_key_id`,
  migration 0169; the creator check now takes exactly one of a member, an automation or a key, and
  0170 validates both), its `deal_created` activity has no member actor and names the key, so the
  deal's page and the timeline say it came "through the API", and the audit log has
  `crm.deal_created` as the key. The pipeline is shared and the contact locked until the deal is in,
  as for members' deals, so archiving or erasure waits.
- Migration 0169 also replaces the key and plan scope checks with ones that also accept
  `deals.write`, validated at once, as 0167 did.

Not built: changing, moving, closing or deleting deals through the API, linking a deal to a
conversation through the API, and deal webhook events.

## ADR-255 Changing CRM deals through the public API (P5-08, P4-04) (2026-10-07)

Context: after ADR-254 an integration could create deals but not move them on: a paid order, a
signed contract or a cancelled booking still needed a member to move, win or lose the deal on the
board.

Decision:

- **`PATCH /api/v1/deals/{id}` (`updateDeal`)** with `deals.write`, now "Create and change CRM
  deals": changes a deal as members do on the deal page, in one transaction with its contact and
  then its row locked (the order erasure takes them in), in this order: `status` `open` reopens a
  closed deal (in its stage, or its pipeline's first active stage when its stage was removed);
  `stageId` moves the open deal to another active stage of its pipeline; the title, the value in the
  pipeline currency's minor units, the owner (an active member who can use the CRM, or null) and the
  expected close date change; `status` `won` or `lost` closes the open deal, with `lostReason` for a
  lost one. The version moves on once per call.
- **The members' rules:** a deal already as asked is answered as it is, so a retry changes nothing;
  a closed deal is not moved, or closed the other way, until it is reopened, and a deal in an
  archived pipeline is not reopened (409); an erased contact's deal keeps its details (409) and is
  closed only without a reason (422); a stage of another pipeline or an owner who cannot use the CRM
  is refused naming the field (422), a removed stage with 409. Moving a deal to another pipeline
  stays with members.
- **Versions:** deals now carry `version` (GET answers too), and `expectedVersion` refuses a change
  to a deal changed since (409). Members' changes check the version as before, so a member saving
  what they read before a key's change is told it changed.
- **Recorded as the key's:** each change is on the deal's timeline without a member actor, naming
  the key (shown "through the API"); a deal closed through the API has no member as its closer; the
  audit log records `crm.deal_updated` as the key with what changed. No migration.

Not built: moving deals to another pipeline, deleting deals, linking conversations, tasks and notes
through the API, and deal webhook events.

## ADR-256 Webhook events for CRM deals (P5-09, P4-04) (2026-10-07)

Context: integrations could read, create and change deals through the API (ADR-253 to ADR-255), but
heard of nothing members, automations or other keys did to them: an ERP or a reporting tool had to
poll `GET /deals` to notice a deal won on the board.

Decision:

- **Three event types:** `deal.created` when a deal is added, `deal.stage_changed` when it moves to
  another stage (of its pipeline, or of another one: then naming the pipeline it left) and
  `deal.status_changed` when it is won, lost or reopened, whoever makes the change: a member on the
  board or the deal page, an automation's deal steps or an API key. Endpoints take them like any
  other event, in Settings → Webhooks ("Deal added", "Deal stage", "Deal won, lost or reopened") or
  through the API; the OpenAPI document describes each with its body.
- **Captured by triggers on `app.crm_deals`** (migration 0171) through `app.capture_webhook_event`,
  in the change's transaction and the company's scope, only when an active endpoint of the company
  takes the type: the deal, its stage and pipeline, and for a change the stage, pipeline or status
  before it. Edits of a deal's title, value, owner or expected date send nothing, and neither do
  erasure (which blanks a deal's text) and merges (which move it to the kept contact). No endpoint
  filter narrows deal events: an endpoint that names numbers, teams or members still receives every
  one it takes.
- **One change, two steps:** a change of both the stage and the status sends both events in the
  order the rules allow, since a closed deal never moves: a deal reopened in another stage (its own
  was removed while it was closed) is reopened, then moved; a deal one API request moves and closes
  is moved, then closed. Each event gives the deal as its step left it, and each is stamped when it
  is captured, as conversation and campaign events are; the two can still show the same `createdAt`,
  which bodies give to the millisecond.
- **Built when delivered:** the stage, pipeline and statuses as captured; the title, the value in
  the pipeline currency's minor units, the currency, the owner (a membership id), the expected date,
  the lost reason and who added the deal (`member`, `automation` or `api`) as they are then; the
  conversation it was created from; the contact as the API describes it. An erased contact's deal is
  sent as erasure left it: titled "Deal (contact erased)", without a reason, its contact without
  number or name. An event whose deal no longer exists ends as `event_gone`. Migration 0172
  validates the events' new type check while captures go on.

Not built: filters for deal events (by pipeline, stage, status or owner), events for deal edits,
notes and tasks, and an end-to-end test of its own.

## ADR-257 Moving CRM deals to another pipeline through the public API (P5-08, P4-04) (2026-10-07)

Context: ADR-255 let a key move a deal only within its pipeline, though members move deals to
another pipeline on the deal page (ADR-234): a booking that turns into a renewal, or a lead handed
from sales to onboarding, still needed a member.

Decision:

- **`pipelineId` on `PATCH /deals/{id}`:** moves the open deal to another active pipeline of the
  company, to `stageId` (an active stage of that pipeline) or, without it, the pipeline's first
  active stage, as a deal created there would enter it. The pipeline it is in, without a stage,
  changes nothing, so a retry changes nothing either. The move takes its place in the order of a
  change: a reopen first, then the move, the details, and a close.
- **The members' rules:** a closed deal is reopened before it moves (409); an unknown pipeline or
  another company's is named (422, `pipelineId`), and so is a stage of another pipeline (`stageId`);
  an archived pipeline and a removed stage are conflicts (409). A deal with a value moves only to a
  pipeline of its currency (409), as members' moves do: its value is cleared in a request of its own
  first (`valueMinor` `null`), since the move comes before the details in a change, and a new value
  in the other currency can come with the move once the deal has none. The target pipeline is shared
  while the deal moves, as for members.
- **Recorded as members' moves are:** the timeline entry names both pipelines and the key, the audit
  row lists `pipeline` and `stage` among what changed, and a `deal.stage_changed` webhook event
  names the pipeline it left (ADR-256). No migration.

Not built: moving deals between pipelines of different currencies in one request, and an end-to-end
test of its own.

## ADR-258 Reading CRM tasks through the public API (P5-08, P4-04) (2026-10-07)

Context: integrations could read, create and change deals through the API (ADR-253 to ADR-257), but
not the tasks members and automations add to contacts and deals: a sales dashboard or another CRM
could see a deal, not the follow-ups due on it.

Decision:

- **A new reading scope, `tasks.read`** ("Read CRM tasks"), granted with `crm.read`, the permission
  members read tasks with on the Tasks page; only owners and administrators create keys, and both
  hold it. It only reads, so it works while the company is suspended or restricted. Existing keys
  keep their scopes, and a plan version that chose its scopes (ADR-092) leaves it out until a new
  version includes it. Migration 0173 replaces the key and plan scope checks with ones that also
  accept it, validated at once (one row per key and per plan version), as 0169 did.
- **The CRM in the plan:** tasks are the CRM's, so a plan without it reads none through the API
  (403, reason `not_in_plan`), checked first in the transaction, as for deals (ADR-253).
- **Endpoints:** `GET /api/v1/tasks` (`listTasks`) pages the company's tasks, open and closed,
  whoever created them (a member or an automation), newest first by when they were created, on exact
  keyset pages (`crm_tasks_list_idx`, built concurrently by migration 0174), filtered by `status`,
  `assigneeId`, `contactId`, `dealId` and `updatedSince`; `GET /api/v1/tasks/{id}` (`getTask`) reads
  one. Another company's task and an unknown id answer 404, and an id that is not a UUID is refused
  before any query.
- **A task with ids only:** its title and notes, status, due time, reminder time, the reminder's
  state with when it was sent or skipped and, as a code, why it was skipped (`task_closed`,
  `too_late` or `assignee_inactive`, as the Tasks page explains them), the assignee, contact and
  deal by id (a task about a deal is about its contact too), when it was completed or cancelled,
  created and last changed, and its version. Never the timeline, who created or completed it, or the
  contact's name or number, which `contacts.read` reads.
- **Erased and merged contacts:** erasure deletes a contact's tasks, so they are no longer listed
  and their ids answer 404; a merge moves the merged contact's tasks to the contact kept, which
  changes their `updatedAt`, so a pass catching up on changes sees them again.

Not built: creating, changing, completing or cancelling tasks through the API, notes and the
timeline, task webhook events, and who created or completed a task.

## ADR-259 Creating CRM tasks through the public API (P5-08, P4-04) (2026-10-07)

Context: after ADR-258 an integration could read the company's tasks but not add one, so an order
system, a booking tool or another CRM could not hand a member a follow-up (call the customer back,
confirm a delivery) without someone typing it in.

Decision:

- **A new writing scope, `tasks.write`** ("Create CRM tasks"), granted with `crm.write`, the
  permission members create tasks with; refused while the company is suspended or restricted, as
  every writing scope is. Existing keys keep their scopes, and a plan version that chose its scopes
  leaves it out until a new version includes it. Migration 0175 replaces the key and plan scope
  checks with ones that also accept it, validated at once, as 0173 did.
- **`POST /api/v1/tasks` (`createTask`)** creates a task as members do on the Tasks page and the
  contact and deal pages: a title, notes, an assignee who is an active member able to use the CRM,
  and about a contact, a deal (and so the deal's contact) or nobody, with a due time within five
  years and a reminder from now to a year ahead, the members' rule (`taskTimeIssue`, shared with
  their tasks), whose email is scheduled as theirs are. With an `Idempotency-Key` a retry answers
  the first response; the key is claimed before the times are checked, so a retry after the reminder
  time is still answered.
- **Refusals as members get them, named for keys:** an assignee who is not an active member able to
  use the CRM, an unknown or another company's deal, a contact other than the deal's and a refused
  time are 422 naming the field; an unknown, another company's or erased contact is 404 (a merged
  one with reason `contact_merged` and `mergedInto`); a deal whose contact was erased is 409, as
  members are refused. The contact is locked against erasure and merges until the task is in; merges
  lock both contacts first, so a deal whose contact a merge removed between the reads answers 409
  rather than a task attached to the wrong contact.
- **Recorded as the key's:** migration 0175 adds `crm_tasks.created_by_api_key_id` and replaces the
  creator check with one taking a key as the creator (NOT VALID with the foreign key; 0176 validates
  both). The `task_created` activity of a task about a contact has no member actor and names the
  key, so the contact's and deal's timelines say it came through the API, and a `crm.task_created`
  audit row names the key and the assignee. The data export lists the new column.

Not built: changing, completing, cancelling or reopening tasks through the API (members do it in the
app), and task webhook events.

## ADR-260 Changing CRM tasks through the public API (P5-08, P4-04) (2026-10-07)

Context: after ADR-259 a key could add a task but not move it on: an order system that delivered
could not mark its "confirm the delivery" task done, and a booking tool could not move a task's due
time when the customer rebooked, so members closed and edited them by hand.

Decision:

- **`PATCH /api/v1/tasks/{id}` (`updateTask`)** with `tasks.write`, now labelled "Create and change
  CRM tasks": in one transaction, with the task's contact (if any) and then its row locked as
  members' changes lock them, `status` `open` reopens a closed task; the open task's title, notes,
  assignee, due time and reminder time change; `status` `done` or `cancelled` closes the open task,
  in that order, with the version moving on once. A task's contact and deal do not change, as for
  members.
- **The members' rules:** a closed task is not changed, or closed the other way, until it is
  reopened (409); the assignee must be an active member able to use the CRM and the times follow
  `taskTimeIssue` (422 naming the field); a new reminder time resets the reminder and schedules its
  email, null removes it; closing skips a pending reminder (`task_closed`) and reopening does not
  bring it back. Only what differs is a change, so a retry, or details equal to the task's, change
  nothing, even on a closed task. With `expectedVersion`, a task changed since is refused with 409.
- **Recorded as the key's:** reopening and closing a task about a contact are on its timeline
  without a member actor, naming the key (the member who closed a task stays empty), and a
  `crm.task_updated` audit row lists what changed. No migration.

Not built: changing a task's contact or deal, deleting tasks (members cannot either), and task
webhook events.

## ADR-261 Webhook events for CRM tasks (P5-09, P4-04) (2026-10-07)

Context: integrations could read, create and change tasks through the API (ADR-258 to ADR-260) and
hear of deals (ADR-256), but had to poll to learn that a member added a follow-up, completed it or
reopened it.

Decision:

- **Two events:** `task.created` ("Task added") when a task is added, by a member, an automation's
  run or an API key, and `task.status_changed` ("Task done, cancelled or reopened") when a task is
  completed, cancelled or reopened, by a member or a key (automations add tasks only). Edits of a
  task's details or reminder, a reminder being sent, a merge moving a task to another contact and
  erasure deleting it change no status, so they send nothing.
- **Captured as the deal events are (0171):** triggers on `app.crm_tasks` call
  `app.capture_webhook_event` with the task id, and the status before a change, in `detail`, the
  task's contact (none for a task about nobody) and the status it reports, stamped when captured,
  and only when an active endpoint of the company takes the type; no number, team or member filter
  narrows them (migration 0177; 0178 validates the events' type check).
- **Payloads built when delivered:** the status and the one before it as captured; the title, due
  time, assignee id, deal id and creator (member, automation or key) as the task is then, and its
  contact as the API describes it, or null. Never the task's notes, which may hold anything a member
  wrote; `GET /tasks/{id}` reads them with `tasks.read`. Erasing a contact deletes its tasks, so a
  delivery whose task is gone fails without an attempt (`event_gone`).

Not built: events for edits, reassignments or sent reminders, and filters narrowing task events (by
assignee, say).

## ADR-262 Renaming contact fields in Settings (P3-01) (2026-10-07)

Context: members added and deleted custom contact fields in Settings → Messaging, but a field named
badly, or one whose meaning changed, could only be deleted with every contact's value and added
again; keys could rename fields through the API (ADR-115), and the service always could, but no page
offered it (ADR-115's Not built).

Decision:

- **A rename per field in Settings:** members who manage the company's settings (owners and
  administrators, as for adding and deleting fields) rename a field in its row: its label, 1 to 80
  characters as when it is added, through the same service function (`renameField`), which audits
  `contact_field.renamed` with the key; the same label changes nothing.
- **The key stays:** values are stored under the key, which is also the CSV column, the API's name
  and what segments and webhook filters name, so a rename changes none of them, and the page says so
  after saving. A rename sends no webhook and records no contact change (ADR-112, ADR-114). No
  migration.

Not built: changing a field's type (ADR-115 keeps it fixed), choices for a field, and field order.

## ADR-263 Choosing the CRM pipelines whose deal events a webhook endpoint receives (P5-09, P4-04) (2026-10-07)

Context: endpoints receive `deal.created`, `deal.stage_changed` and `deal.status_changed` for every
deal of the company (ADR-256), and no filter narrowed them. A company that runs a pipeline per team
(sales and renewals, say) and connects each to its own system had every pipeline's deals sent to
every receiver, which had to read `deal.pipelineId` and drop the rest. ADR-256 and P5-09 left
filters for deal events unbuilt.

Decision:

- **A list of pipelines per endpoint,** for the three deal events: null receives every pipeline's
  deals, as before; a list holds 1 to 50 of the company's pipelines, by id, in the order given with
  repeats merged. A deal's event counts when the pipeline it gives is listed (`deal.pipelineId`: the
  deal's pipeline as the event's step left it), and `deal.stage_changed` also when the pipeline a
  move to another pipeline left is (`deal.previousPipelineId`), as `conversation.team_changed`
  reaches the team a conversation left (ADR-174): a receiver learns that a deal left its pipeline,
  and the deal's later events go by its new pipeline. Task events, even of a deal's tasks, and every
  other event are not narrowed. Chosen in Settings → Webhooks ("Pipelines": every deal's events, or
  only those of the deals in the pipelines ticked), shown on the endpoint as "Pipelines whose deals’
  events are sent: …", and through the API as `pipelineIds` on `POST /webhook-endpoints` and `PATCH
/webhook-endpoints/{id}` and in every endpoint the API answers.
- **Only while a deal event is taken:** a list given for an endpoint that takes none is refused
  (`pipelineIds`; 422 through the API). A change that drops all three clears it, and a `PATCH` that
  leaves it out keeps it; Settings always sends it. A check in the database holds the same rule
  (null, or 1 to 50 ids in one dimension without a null, with a deal event).
- **Applied at capture:** `app.capture_webhook_event` matches the pipeline the deal trigger stores
  in the event's detail (0171), and for a move the one it left, against each endpoint's list. With
  the other filters an event reaches an endpoint only when it passes them all, no event is written
  when no endpoint takes it, and stored events are unchanged.
- **The company's pipelines, archived ones too:** a list given now may hold only pipelines of the
  company, checked in its scope; pipelines are archived, never deleted, so a list never names one
  that is gone. An archived pipeline has no open deal and takes none until it is restored, so it
  sends nothing meanwhile, and a list keeps it. Settings offers the pipelines the company uses, in
  board order, and keeps listing an archived one the endpoint already names, marked as archived; the
  API takes any of the company's, as `GET /pipelines` lists them.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `pipelineIds` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API. The choices list the company's pipelines by name to members
  with `developer.manage`.
- **The Settings page names CRM deal and task events** among what endpoints can receive, which
  ADR-256 and ADR-261 left out of its description.
- **Migration 0179:** `pipeline_ids uuid[]` on `app.webhook_endpoints` with the check, validated at
  once (a company has at most 10 endpoints), an update grant on the column for the runtime role, and
  `app.capture_webhook_event` replaced with the same signature (0138's, with the pipelines), so its
  owner and grants stay. Existing endpoints keep null; nothing is backfilled.

Not built: deal events by stage or owner, task events by their deal's pipeline, and pipelines chosen
per event type (one list serves the three events).

## ADR-264 Choosing the CRM stages whose deal events a webhook endpoint receives (P5-09, P4-04) (2026-10-07)

Context: an endpoint can take the deal events of chosen pipelines (ADR-263), but a receiver that
acts when deals reach some stages (send the contract when a deal reaches Proposal, say) was sent
every move of those pipelines' deals and had to read `deal.stageId` to drop the rest; a no-code
receiver often cannot. ADR-263 left filters by stage unbuilt.

Decision:

- **A list of stages per endpoint,** for the three deal events: null receives every stage's deals,
  as before; a list holds 1 to 50 of the company's stages, of any of its pipelines, by id, in the
  order given with repeats merged. A deal's event counts when the stage it gives is listed
  (`deal.stageId`: the deal's stage as the event's step left it, so a deal added in a listed stage,
  moved into one, or won, lost or reopened in one), and `deal.stage_changed` also when the stage it
  left is (`deal.previousStageId`), as with pipelines (ADR-263): a receiver learns that a deal left
  a stage it follows; one that acts on arrivals compares `deal.stageId`. With a list of pipelines
  too, an event must pass both. Task events and every other event are not narrowed. Chosen in
  Settings → Webhooks ("Stages": every stage's deals, or only those of the deals in the stages
  ticked, named with their pipeline, as "Sales: Proposal"), shown on the endpoint as "Stages whose
  deals’ events are sent: …", and through the API as `stageIds` on `POST /webhook-endpoints` and
  `PATCH /webhook-endpoints/{id}` and in every endpoint the API answers.
- **Only while a deal event is taken:** a list given for an endpoint that takes none is refused
  (`stageIds`; 422 through the API). A change that drops all three clears it, and a `PATCH` that
  leaves it out keeps it; Settings always sends it. A check in the database holds the same rule
  (null, or 1 to 50 ids in one dimension without a null, with a deal event).
- **Applied at capture:** `app.capture_webhook_event` matches the stage the deal trigger stores in
  the event's detail (0171), and for a move the one it left, against each endpoint's list, after the
  pipeline filter. No event is written when no endpoint takes it, and stored events are unchanged.
- **The company's stages, removed ones too:** a list given now may hold only stages of the company,
  checked in its scope; a removed stage is archived (it cannot be restored) and a pipeline is
  archived, never deleted, so a list never names a stage that is gone. A removed stage holds no
  deal, and an archived pipeline no open one, so they send nothing, and a list keeps them. Settings
  offers the stages in use of the pipelines the company uses, in board order, and keeps listing a
  removed one, or one of an archived pipeline, the endpoint already names, marked as such; the API
  takes any of the company's, as `GET /pipelines` lists them.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `stageIds` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API. The choices list the company's stages and pipelines by name to
  members with `developer.manage`.
- **Migration 0180:** `stage_ids uuid[]` on `app.webhook_endpoints` with the check, validated at
  once (a company has at most 10 endpoints), an update grant on the column for the runtime role, and
  `app.capture_webhook_event` replaced with the same signature (0179's, with the stages), so its
  owner and grants stay. Existing endpoints keep null; nothing is backfilled.

Not built: deal events by owner, task events by their deal's pipeline or stage, and stages chosen
per event type (one list serves the three events).

## ADR-265 Choosing the members whose deal events a webhook endpoint receives (P5-09, P4-04) (2026-10-07)

Context: an endpoint can take the deal events of chosen pipelines and stages (ADR-263, ADR-264), but
a receiver that serves some members (a sales representative's own alerts, a team lead's dashboard)
was sent every member's deals and had to read `deal.ownerId` to drop the rest. ADR-256 and ADR-263
left filters by owner unbuilt; it is the last of the deal filters P5-09 listed.

Decision:

- **A list of deal owners per endpoint,** for the three deal events: null receives every deal's, as
  before; a list holds 1 to 50 members of the company, by membership id (as `GET /members` lists
  them), in the order given with repeats merged. A deal's event counts when the member who owns the
  deal when the event happens is listed, so a deal without an owner is on no list. Changing a deal's
  owner sends no event, so there is no owner left to reach, unlike pipelines and stages; the
  payload's `deal.ownerId` is the owner when it is delivered, which a later change can make differ.
  With lists of pipelines or stages too, an event must pass them all. Task events and every other
  event are not narrowed. Chosen in Settings → Webhooks ("Deal owners": every deal's events, or only
  those of the deals the members ticked own), shown on the endpoint as "Members whose deals’ events
  are sent: …", and through the API as `ownerIds` on `POST /webhook-endpoints` and `PATCH
/webhook-endpoints/{id}` and in every endpoint the API answers.
- **Members who can own deals:** a list may add only active members with access to the CRM, as deal
  owners are chosen (`assertCrmMember`'s rule); members it already holds may have left, been
  suspended or lost the access since, and stay, matching the deals they still own; Settings names
  them "(no longer uses the CRM)" and the API keeps them in `ownerIds`. Memberships are kept, so a
  list never names one that is gone.
- **Only while a deal event is taken:** a list given for an endpoint that takes none is refused
  (`ownerIds`; 422 through the API). A change that drops all three clears it, and a `PATCH` that
  leaves it out keeps it; Settings always sends it. A check in the database holds the same rule
  (null, or 1 to 50 ids in one dimension without a null, with a deal event).
- **Applied at capture:** `app.capture_webhook_event` reads the deal's owner from `app.crm_deals` by
  the deal the trigger stores in the event's detail, only when an active endpoint of the company
  that takes the event names owners (as it reads a conversation's team and member, ADR-174,
  ADR-181), and matches it against each endpoint's list, after the pipeline and stage filters. The
  deal trigger runs as whoever changes the deal, in the company's scope. No event is written when no
  endpoint takes it, and stored events are unchanged.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `ownerIds` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API. The choices list the members who can own deals by name to
  members with `developer.manage`, as the member choices of ADR-181 do.
- **Migration 0181:** `owner_ids uuid[]` on `app.webhook_endpoints` with the check, validated at
  once (a company has at most 10 endpoints), an update grant on the column for the runtime role, and
  `app.capture_webhook_event` replaced with the same signature (0180's, with the owner), so its
  owner and grants stay. Existing endpoints keep null; nothing is backfilled.

Not built: an event when a deal's owner changes, task events by their deal's pipeline, stage or
owner, or by their assignee, and owners chosen per event type (one list serves the three events).

## ADR-266 Choosing the members whose task events a webhook endpoint receives (P5-09, P4-04) (2026-10-07)

Context: task events (ADR-261) reached every endpoint that took them, whoever the task was assigned
to; a receiver that serves some members (one member's own task list in another tool, a team lead's
board) had to read `task.assigneeId` to drop the rest. ADR-265 left task events by assignee unbuilt.

Decision:

- **A list of task assignees per endpoint,** for the two task events: null receives every task's, as
  before; a list holds 1 to 50 members of the company, by membership id (as `GET /members` lists
  them), in the order given with repeats merged. A task's event counts when the member it is
  assigned to when the event happens is listed; every task has an assignee. Reassigning a task sends
  no event, so there is no assignee left to reach; the payload's `task.assigneeId` is the assignee
  when it is delivered, which a later change can make differ. Deal events and every other event are
  not narrowed, and the deal filters (ADR-263 to ADR-265) do not narrow task events. Chosen in
  Settings → Webhooks ("Task assignees": every task's events, or only those of the tasks assigned to
  the members ticked), shown on the endpoint as "Members whose tasks’ events are sent: …", and
  through the API as `taskAssigneeIds` on `POST /webhook-endpoints` and `PATCH
/webhook-endpoints/{id}` and in every endpoint the API answers.
- **Members who can be assigned tasks** are those who can own deals (active, with access to the CRM,
  `assertCrmMember`'s rule), so the choices, the check of the members a list adds and the label are
  the deal owners' (ADR-265), shared. Members a list already holds may have left, been suspended or
  lost the access since, and stay, matching the tasks still assigned to them; Settings names them
  "(no longer uses the CRM)" and the API keeps them in `taskAssigneeIds`.
- **Only while a task event is taken:** a list given for an endpoint that takes neither is refused
  (`taskAssigneeIds`; 422 through the API). A change that drops both clears it, and a `PATCH` that
  leaves it out keeps it; Settings always sends it. A check in the database holds the same rule
  (null, or 1 to 50 ids in one dimension without a null, with a task event).
- **Applied at capture:** `app.capture_webhook_event` reads the task's assignee from `app.crm_tasks`
  by the task the trigger stores in the event's detail, only when an active endpoint of the company
  that takes the event names assignees (as it reads a deal's owner, ADR-265), and matches it against
  each endpoint's list. The task trigger runs as whoever changes the task, in the company's scope.
  No event is written when no endpoint takes it, and stored events are unchanged.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `taskAssigneeIds` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API.
- **Migration 0182:** `task_assignee_ids uuid[]` on `app.webhook_endpoints` with the check,
  validated at once (a company has at most 10 endpoints), an update grant on the column for the
  runtime role, and `app.capture_webhook_event` replaced with the same signature (0181's, with the
  assignee), so its owner and grants stay. Existing endpoints keep null; nothing is backfilled.

Not built: task events by their deal's pipeline, stage or owner, an event when a task is reassigned,
and assignees chosen per event type (one list serves the two events).

## ADR-267 Choosing the contact tags whose conversations' events a webhook endpoint receives (P5-09) (2026-10-07)

Context: an endpoint taking message or conversation events received those of every conversation of
the company unless it named numbers, teams or members (ADR-170, ADR-174, ADR-181). A receiver that
serves some customers (a priority desk for those tagged vip, a wholesale system) was sent everyone's
conversations and had to look each contact up to drop the rest. P5-09 left filters on a contact's
values, such as by tag, unbuilt.

Decision:

- **A list of contact tags per endpoint,** for the events of a conversation (`message.received`,
  `message.status`, `conversation.status_changed`, `conversation.assignment_changed`,
  `conversation.team_changed`, the events teams and members narrow): null receives every
  conversation's, as before; a list holds 1 to 50 tags as contacts carry them (`normalizeTag`:
  trimmed, spaces inside collapsed, lower case, 1 to 40 characters, no comma or control character),
  in the order given with repeats merged. Such an event belongs to the conversation's contact, and
  counts when the contact has any of the listed tags when the event happens, as the transaction that
  captures it sees the contact's tags: a tag put on later counts from the next event on, and one
  taken off no longer does. With numbers, teams or members too, an event must pass them all. Deal,
  task, order, contact and other events are not narrowed. Chosen in Settings → Webhooks ("Contact
  tags": every conversation's events, or only those of the conversations whose contact has any of
  the tags typed, separated by commas), shown on the endpoint as "Contact tags whose conversations’
  events are sent: …", and through the API as `contactTags` on `POST /webhook-endpoints` and `PATCH
/webhook-endpoints/{id}` and in every endpoint the API answers.
- **Tags are labels,** not rows of their own: a list may name a tag no contact has yet, which
  matches nothing until a contact gets it, so nothing is checked against the company's contacts; a
  tag no contact carries any more stays listed until it is taken off.
- **Only while an event of a conversation is taken:** a list given for an endpoint that takes none
  is refused (`contactTags`; 422 through the API). A change that drops them all clears it, and a
  `PATCH` that leaves it out keeps it; Settings always sends it. A check in the database holds the
  same rule and the tags' form (null, or 1 to 50 tags in one dimension without a null, each as
  `app.contact_tags` allows a tag, with an event of a conversation).
- **Applied at capture:** `app.capture_webhook_event` reads the tags of the conversation's contact
  (through the conversation, as its team and member are read, ADR-174, ADR-181) only when an active
  endpoint of the company that takes the event names tags, and creates a delivery only for the
  endpoints whose list is null or shares a tag with it. Both roles whose changes capture these
  events read a company's tags (the runtime role in its scope, the definer role through its column
  grants and policy). No event is written when no endpoint takes it, and stored events are
  unchanged.
- **Audited and exported:** `webhook.endpoint_created` and `webhook.endpoint_updated` carry
  `contactTags` when the endpoint has a list, and the company data export carries the column.
- **Permissions unchanged:** members with `developer.manage` in Settings, keys with
  `webhooks.manage` through the API.
- **Migration 0183:** `contact_tags text[]` on `app.webhook_endpoints` with the check, validated at
  once (a company has at most 10 endpoints), an update grant on the column for the runtime role, and
  `app.capture_webhook_event` replaced with the same signature (0182's, with the tags), so its owner
  and grants stay. Existing endpoints keep null; nothing is backfilled.

Not built: contact events by tag (a contact's tags are often written after the event that adds it is
captured, in the same transaction), every listed tag required rather than any, tags to leave out,
events of a conversation by its own tags (ADR-220), and other values of a contact (a field's value).

## ADR-268 Adding notes to the CRM timeline through the public API (P5-08, P4-04) (2026-10-07)

Context: keys read and change deals and tasks (ADR-253 to ADR-260), but a call centre, a telephony
system or a CRM kept in step with HyFib could not leave a note of what happened on the customer's
timeline, where members read it; ADR-253, ADR-255 and ADR-258 left notes unbuilt.

Decision:

- **`POST /notes`** (`createNote`) with a new scope, `notes.write` ("Add notes to the CRM
  timeline"), granted only by members holding `crm.write`, who add notes in the app: a note on one
  of the company's contacts (not erased), or on one of its deals and so on the deal's contact, as
  members add notes on the contact and deal pages: the text trimmed, 1 to 4,000 characters
  (`app.crm_activities`' own limit), with `contactId`, `dealId` or both (a contact other than the
  deal's is refused, naming `contactId`). It answers 201 with the note: its id, text, contact, deal
  and time.
- **Recorded as the key's:** the note is a `note` activity without a member actor that names the key
  in its data, as the API's deal and task activities do, so the contact's and the deal's timelines
  say it came through the API; the audit log records `crm.note_added` as the key, with the contact
  and deal, never the text. No webhook event and no contact change are recorded, as members' notes
  record none.
- **Members' rules:** the CRM must be in the company's plan (403, reason `not_in_plan`), the company
  active (writing scopes are refused while it is suspended or restricted), and the contact is locked
  against erasure and merges until the note is in (key share), as the API's tasks lock it: an
  unknown or erased contact given alone answers 404 (a merged one names the contact it belongs to
  now), an unknown or another company's deal 422 naming `dealId`, and a deal whose contact was
  erased, or that a merge moved meanwhile, 409. With an `Idempotency-Key` a retry answers the first
  response.
- **Notes are not read through the API:** the timeline stays in the app, as ADR-253 and ADR-258
  decided; a key that adds a note keeps its id.
- **Migration 0184** widens the API keys' and plan versions' scope checks (24 scopes), validated at
  once (one row per key and per plan version). Existing keys keep their scopes, and a plan version
  that chose its scopes leaves the new one out until a new version includes it.

Not built: reading notes or the timeline through the API, changing or deleting notes (members cannot
either), notes on tasks, mentions in notes, and webhook events for notes.

## ADR-269 A webhook event when a CRM deal's owner changes (P5-09, P4-04) (2026-10-07)

Context: deal events (ADR-256) told integrations of deals added, moved, won, lost or reopened, and
an endpoint could take the deals of chosen members (ADR-265), but giving a deal to another member
sent nothing: a receiver following a member's deals (a CRM kept in step, a commission sheet, a
team's dashboard) learnt that a deal had left or reached them only from the deal's next event, if
one came.

Decision:

- **`deal.owner_changed`** ("Deal owner") is captured by the deal trigger
  (`app.webhook_capture_deal`, replaced in place; its update trigger now also fires on
  `owner_membership_id`) when an update changes a deal's owner: a member giving the deal to another
  member, or leaving it without one, on the deal page, or a key changing `ownerId`
  (`PATCH /deals/{id}`, ADR-255). Automations set an owner only on the deals they add
  (`deal.created`), and erasure and merges keep the owner, so they send none.
- **The change, not the deal now:** the payload is the deal events' one with a new field,
  `deal.previousOwnerId` (the owner before, null when it had none; null in the other deal events),
  and its `deal.ownerId` is the owner the change gave (null when it left the deal without one)
  rather than the owner at delivery, so a receiver reads the change even when the deal has changed
  hands again since. The stage, pipeline and status are those the deal had at the change; the rest
  is the deal at delivery. Who made the change is not sent; the deal's timeline records it.
- **Its place among one change's steps:** one update that also reopens, moves or closes the deal
  captures each in the order members' and keys' steps run (ADR-255): reopened, moved, given to
  another owner, closed, each with the deal as its step left it, stamped with `clock_timestamp()`; a
  key giving a deal away and winning it in one request sends the owner change with status `open`,
  then the close.
- **Filters:** it is a deal event for the pipeline, stage and owner lists (ADR-263 to ADR-265),
  matched by the pipeline and stage the deal has; an endpoint naming owners receives it for the
  owner the deal left as well as for the one it was given to, as `conversation.assignment_changed`
  reaches both members (ADR-181), so a receiver hears a deal leave the members it follows. The lists
  stay while an endpoint takes any of the four deal events; no number, team or member filter narrows
  it.
- **Migrations 0185 and 0186:** 0185 replaces the endpoints' event check and their three deal lists'
  checks (validated at once: at most 10 endpoints per company), the events' type check (NOT VALID;
  0186 validates it while captures go on), the trigger and its function, and
  `app.capture_webhook_event` with the same signature (keeping 0183's filters).

Not built: events for other edits of a deal (its title, value or expected date), who made a change
in the payload, and task events by their deal's owner.

## ADR-270 Saying who changed a WhatsApp order in `order.status_changed` (P5-09, P5-08) (2026-10-07)

Context: since ADR-168 an order system confirms, fulfils and cancels orders through the API, and it
hears every status change through `order.status_changed` (ADR-085), its own included: it could not
tell a change it made from a member's on the order page or from a payment Razorpay reported, so it
either acted on its own echoes or ignored changes it needed. ADR-168 left `order.status_changed`
naming who changed the order unbuilt.

Decision:

- **`order.changedBy`** on `order.status_changed`: `member` (the order page: confirming, fulfilling,
  cancelling or asking for payment; never which member, as `sentBy` and `writtenBy` name members
  elsewhere), `api` with **`order.apiKeyId`** naming the key (`PATCH /orders/{id}`, ADR-168), or
  `payment_link` (HyFib applying what Razorpay reports for the order's Payment Link: paid, or back
  to confirmed when the link expired, was cancelled or failed unpaid). Null for `order.received`,
  which the customer's cart creates, and for a change HyFib did not record the maker of (events
  captured before this, or changes made by servers from before it). An integration ignores the
  events whose `apiKeyId` is its own key's id, which an endpoint it adds through the API answers
  (`apiKeyId`) and the messages it sends carry when read back (`GET /conversations/{id}/messages`).
- **Recorded with the status:** `app.commerce_orders` gains `status_changed_by`,
  `status_changed_by_api_key_id` (a foreign key to the company's keys through the company's id) and
  `status_changed_xact`, written in the same statement as the status by every writer (members'
  `setOrderStatus` and payment requests, keys' `apiUpdateOrder` through the shared
  `writeLockedOrderStatus`, the worker's paid and released orders), through one helper
  (`orderStatusChangedBy`). A check keeps the changer to the three values and the key to `api`.
- **Never the previous changer:** a status written without the changer would keep the one before it,
  so a key's change could be followed by a member's on a server from before this release and still
  name the key, and an integration ignoring its own changes would ignore the member's. A trigger
  before each status change clears the changer unless `status_changed_xact` is the transaction
  making the change (`pg_current_xact_id()`, as ADR-121 marks a transaction's own events), so a
  change that does not record its maker names nobody.
- **In the event, as captured:** the order trigger (0063, 0118) puts the changer and the key in the
  event's `detail`; the payload gives them as captured, whoever changes the order later. Who changed
  an order is not read through the API, and the order page and audit log are unchanged (the audit
  log names the member or key already).
- **Migrations 0187 and 0188:** 0187 adds the three columns (nullable, so the table is not
  rewritten), the foreign key and the check NOT VALID, the runtime role's grant to update them, the
  trigger and its function, and `app.webhook_capture_order` with the same signature; 0188 validates
  the foreign key and the check while the table stays writable.

Not built: which member changed an order, who changed it in `GET /orders`, a reason or note with a
change, and who created or cancelled a Payment Link.

## ADR-271 Reading who last changed a WhatsApp order through the public API (P5-08) (2026-10-07)

Context: ADR-270 recorded who changes an order's status and sent it in `order.status_changed`, but
an order system that polls `GET /orders` with `updatedSince` instead of taking webhooks (or that
catches up after its receiver was down) still could not tell the orders it changed last from those
members or payments did; ADR-270 left reading it through the API unbuilt.

Decision:

- **`statusChangedBy` and `statusChangedByApiKeyId`** on the API's order (`GET /orders`,
  `GET /orders/{id}` and the answer of `PATCH /orders/{id}`): who made the latest status change,
  `member` (never which member), `api` with the key's id, or `payment_link` (HyFib applying the
  order's Payment Link), read from the columns ADR-270 added. Null while the order is as the
  customer sent it, and when HyFib did not record who made the latest change (before migration 0187,
  or by a server from before it); never the maker of an earlier change, since the database clears a
  changer an earlier transaction recorded.
- **The same as the event:** the order and `order.status_changed` agree, the event giving each
  change's maker as captured and the order the latest one's; `GET /orders` describes the fields and
  why an integration reads them.
- **No migration and no new filter:** the columns are read as the order's other columns are, in the
  key's company scope; listing orders by who changed them is not offered (an integration skips its
  own key's orders as it pages).

Not built: filtering orders by who changed them, the history of an order's changes through the API
(the audit log keeps members' and keys' changes), and who changed an order on the order page and in
the members' CSV export.

## ADR-272 Listing the tags in use through the public API (P5-08) (2026-10-07)

Context: keys read the tags contacts and conversations carry (`tags`), filter by one (`tag`), add
and remove them (ADR-112, ADR-221), and webhook endpoints narrow events by contact tags (ADR-267),
but nothing listed the tags a company uses: an integration offering a tag picker, checking a tag
before filtering by it, or keeping its own list had to page through every contact or conversation.
ADR-221 left a list of the tags in use through the API unbuilt.

Decision:

- **`GET /contact-tags`** (`listContactTags`, `contacts.read`) and **`GET /conversation-tags`**
  (`listConversationTags`, `conversations.read`): the tags on the company's contacts or
  conversations, alphabetically, each with how many contacts (`contacts`) or conversations
  (`conversations`) have it when the page is read. A tag nobody has any more is not listed; erasure
  and merges delete a contact's tags, so erased and merged contacts count for none. Members' lists
  (Contacts, the inbox's tag filter) are unchanged.
- **Pages that continue after the last tag:** up to `limit` tags (1 to 100, 50 by default),
  `nextCursor` the last tag listed, encoded, and a page reading the tags after it, so paging never
  skips or repeats a tag that stays in use, even when nobody has the cursor's tag any more; a tag
  first used meanwhile before the cursor is listed on the next pass, and the counts are read with
  each page. A cursor that is not a tag as tags are written is refused with 422 naming `cursor`.
- **`prefix`:** only the tags that start with a text, written as tags are (lower case, single
  spaces), for a picker that completes what someone types; a prefix that cannot be part of a tag is
  refused with 422 naming `prefix`, and unknown parameters are refused.
- **Reads only, in the key's company:** one read-only transaction per page, the tags of the key's
  company only (row security and an explicit company condition), allowed while the company is
  suspended, as every read is; a page counts as one request. The tags are grouped by the existing
  `(tenant_id, tag)` indexes; no migration.

Not built: renaming, merging or deleting tags through the API (members cannot either), tags across
both lists in one call, other orders (by count), and tags of contacts or conversations matching a
filter.
