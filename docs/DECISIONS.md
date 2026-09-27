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
the customer writes to the company and nothing is sent. Nothing about the visitor is stored: no
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
