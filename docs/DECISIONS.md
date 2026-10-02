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
    not part of the API's contact and do not send it; consent has its own event.
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

Not built: custom field changes, member and team identities (and so moves between members or
teams), conversations started, notes, merges, events for campaigns, automations or orders, and
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
filters by automation, and reading runs not started through the API with the API.

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
API, catalog and product events, and filters by status.

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
reports have them), the campaign in `message.status`, events for each recipient, test sends and
drafts, reading campaigns through the public API, and filters by campaign.

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
  API).
- **No migration.**

Not built: statuses changed since a time, filters by contact or conversation (a conversation's
messages endpoint reads one), media, notes, counts, and a push feed (the webhooks are that).

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
  chosen version's limit.
- **Serialised with paying and staff changes:** `app.choose_plan` first takes the per-company
  advisory lock that starting a subscription takes, so a start never records the version a choice
  replaces, then the company row (shared, as a deletion request updates it) and the plan state, in
  the order the plan sweep and staff changes lock them. The plan version itself is read without a
  lock: a choice that races a withdrawal is as if made just before it.
- **Trials:** during a trial the chosen version's limits and modules apply at once, until the
  trial's end, which does not move. A company can therefore try any offered version within its
  trial; platform owners decide which versions are offered.
- **Recorded:** in the company audit log (`billing.plan_chosen`, with the versions before and
  after), and in the plan state's note ("Chosen by the company.") with the member, which staff see
  on the company's platform page. No email: the member who chose sees the result.

Not built: changing a plan a subscription pays for (a new subscription from the period's end,
R-069), choosing add-ons, a price list for visitors before sign-up, proration, and emails about a
company's choice.
