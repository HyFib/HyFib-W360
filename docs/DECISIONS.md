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
hook is needed. A retry is built again, so it may carry newer data than the first attempt; the
event id, type and the status it reports never change.

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
available to engineers who fixed a cause.

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
check), API request counts (not recorded), exports, the age of the oldest waiting job, and
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
   outcomes on the company's platform page; they cannot start, speed up or cancel a deletion.

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
deletion started by platform staff, deleting media files (no media storage exists), a stored export
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

**Not built:** alerts and emails, a CSV export of a run, reconciling settlements with bank
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

Not built: alerts or emails about an upcoming change, estimates per number or campaign on this page
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

Not built: a threshold chosen per company or per member, warnings for seats, numbers, teams or live
automations (they refuse additions, they do not run out during the month), and in-app notices.

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
  plan payments to a person, since HyFib does not refund them.
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

Not built: billing that starts at the end of a trial, self-serve plan and add-on changes with
proration, pausing, offers, plan payment receipts (since ADR-064) and GST invoices, refunds of plan payments, and
emails about a subscription beyond charges, failures and endings.

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
reconciliation leaves it to a person). Nothing is stored: the page is computed from the plan payment
and its subscription. The payments table in Billing links each payment to its receipt, and the
payment-received email links to the receipt of the payment that paid the new period.

Not built: tax invoices, credit notes, receipts in platform pages, and plan payments in the monthly
service-credit statements (they never touch the wallet).
