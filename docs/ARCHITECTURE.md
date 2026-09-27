# Architecture

Last updated 2026-09-27. Status markers: **[built]** exists and is tested locally; **[designed]** is
specified here but not yet implemented.

## 1. System context

```
            Browsers (agents, admins, billing)                Meta WhatsApp Cloud API
                        │ HTTPS                                   ▲      │ webhooks
                        ▼                                         │      ▼
 Load balancer ──► web (Next.js, ≥2 replicas) ──────────────► PostgreSQL (managed, PITR)
                        │   ▲ SSE (designed)                      ▲
                        │   └── LISTEN/NOTIFY + event table       │
                        ▼                                         │
                   worker (pg-boss consumers, ≥1 replica) ────────┘
                        │            │             │
                     SMTP provider  Object storage  Razorpay (designed)
```

- **web** serves the UI, server actions, auth endpoints, provider webhooks (designed) and health
  probes. Node.js runtime only. **[built]**
- **worker** processes durable jobs: email delivery, webhook processing, outbound sends, campaign
  ticks, automation runs, billing events, auto-recharge and the minute sweepers. **[built]**
- **PostgreSQL** is the system of record, the job queue (pg-boss) and the durable event log. There is
  no Redis, Kafka or search cluster (ADR-015).

## 2. Code organisation (modular monolith)

| Package              | Responsibility                                                                                                                                | Depends on                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `packages/core`      | Config (zod-validated env), typed errors, ids (UUIDv7), keyring (AES-256-GCM + AAD), HMAC, logger with redaction, money in minor units, clock | zod, pino                             |
| `packages/contracts` | Zod schemas shared by browser and server; queue definitions and job envelope schema                                                           | zod                                   |
| `packages/db`        | Drizzle schema, SQL migrations, migration runner, scoped transactions, platform DB handle, role safety check                                  | core, contracts, drizzle, pg, pg-boss |
| `packages/domain`    | Services and policy: tenant context, permission matrix, tenancy, platform admin, audit, email outbox/delivery, job signing/authorization      | core, db, contracts                   |
| `packages/ui`        | Accessible primitives (Tailwind), Radix-based dialogs/menus                                                                                   | react, radix-ui                       |
| `apps/web`           | Pages, server actions, route handlers; thin adapters over domain services                                                                     | all packages, next, better-auth       |
| `apps/worker`        | Job handlers, schedules, health server                                                                                                        | core, db, domain, contracts, pg-boss  |

Rule: server-rendered pages and actions call the same domain services and authorization as APIs.
Business logic never lives in React components.

## 3. Tenant isolation **[built]**

### 3.1 Identity vs tenancy

- **Identity** (users, sessions, credentials, TOTP) lives in schema `auth`, managed by Better Auth
  through the `w360_auth` role. Tenant code can read only public profile columns of `auth.users`.
- **Tenancy** (companies = `app.tenants`, memberships, invitations, audit) lives in schema `app`.
- **Platform operations** (platform admins, support grants, platform audit, security events, email
  outbox) live in schema `ops`.

### 3.2 Database roles

| Role            | Purpose                                     | Key properties                                                                                                                                                                       |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `w360_owner`    | Migrations only                             | Owns schemas/tables. Not used by web/worker. Subject to FORCE RLS (no owner policies).                                                                                               |
| `w360_app`      | Web + worker tenant work                    | NOSUPERUSER, NOBYPASSRLS, owns nothing, column-level grants on sensitive columns.                                                                                                    |
| `w360_auth`     | Authentication library                      | Identity tables only; no access to `app`.                                                                                                                                            |
| `w360_platform` | Platform administration                     | NOBYPASSRLS; explicit `TO w360_platform` policies; customer data (incl. member directories) only through active support grants; seat counts and owners via narrow definer functions. |
| `w360_definer`  | NOLOGIN owner of SECURITY DEFINER functions | Specific policies for company creation, invitation acceptance, last-owner guard, account recovery.                                                                                   |

Web and worker run `checkRuntimeRoleSafety()` at start-up and refuse to start in production if the
role is a superuser, has BYPASSRLS or owns protected tables.

### 3.3 Context propagation

Every transaction begins with
`select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)` (transaction
local). Policies compare `tenant_id = (SELECT app.current_tenant_id())`; a missing value is NULL and
matches nothing (fail closed); a malformed value raises. Because the settings are local, a pooled
connection cannot carry context into the next transaction; each transaction also overwrites any
session-level value. Scopes are branded TypeScript types created only by authorization code:

- `authorizedTenantScope(tenantId, userId)` — after `resolveTenantContext` verified an active
  membership (web) or `authorizeJob` verified a signed envelope (worker).
- `authenticatedUserScope(userId)` — user scope: own memberships and the companies they belong to.
- `systemScope` — no tenant: infrastructure tables only.

### 3.4 Request lifecycle (web)

1. The proxy assigns a CSP nonce and correlation id.
2. The page/action calls `requireTenant(slug)` (pages) or `tenantForAction(slug)` (actions):
   session → membership lookup in user scope → tenant status → effective permissions (role union,
   minus suspended-blocked permissions, minus MFA-blocked permissions). Non-members and missing
   companies both get 404.
3. The domain service asserts a permission, validates input with zod, and runs `db.run(ctx.scope)`.
   Audit rows are written in the same transaction.
4. Server actions additionally require an exact trusted `Origin` (on top of Next.js's own check).

Company switching is URL-based (`/c/{slug}`) with a full page load so no client state crosses
companies (ADR-006).

### 3.5 Structural rules enforced by tests

`tests/integration/tenant-isolation.test.ts` fails if any `app` table with `tenant_id` lacks FORCE RLS
or a NOT NULL tenant id, if any SECURITY DEFINER function lacks a pinned `search_path`, if any `app`
or `ops` function is executable by PUBLIC, or if runtime roles gain dangerous attributes.

Function privileges: the migration role's global default revokes EXECUTE from PUBLIC (a per-schema
default cannot). Definer functions are granted to their callers **before** ownership moves to
`w360_definer`; the migration role can `SET ROLE w360_definer` but does not inherit its privileges,
so grants issued after the transfer would silently grant nothing (migration 0002 repaired 0001).

## 4. Durable jobs **[built]**

- pg-boss 12 in schema `pgboss`, installed and upgraded by the migration runner (owner role). Queues
  are declared at deploy time (`packages/contracts/src/jobs.ts`); runtime roles only enqueue/process.
- Work queues use the `exclusive` policy with `singletonKey = <row id>`: at most one
  created/retry/active job per durable row, so duplicate wake-ups collapse.
- Jobs are **signals for durable rows** (outbox rows, webhook receipts, send intents). Sweepers
  re-signal rows whose job was lost, so correctness never depends on one enqueue.
- Enqueue can join the business transaction (`PgBossJobQueue.enqueue(tx, …)`).
- Every job carries a signed envelope `{kind, tenantId, actorUserId, ref, issuedAt, sig}`. Workers
  call `authorizeJob`: verify HMAC, check company status (defer outbound work while suspended),
  check the actor's membership is still active, then load the referenced row under that company's
  RLS scope.
- Workers stop gracefully on SIGTERM (stop fetching, wait up to 30 s, close pools).

## 5. Email **[built]**

`ops.email_outbox` rows are inserted in the business transaction with an AES-256-GCM encrypted
payload bound (AAD) to the row id. The worker claims a row with a short lease (`sending`,
`locked_until`), sends via the SMTP adapter outside any transaction, then records `sent` and erases
the payload. Transient failures return the row to `pending` and pg-boss retries with backoff;
permanent SMTP 5xx or exhausted attempts mark `failed`. Delivery is at-least-once.

## 6. Messaging pipeline **[built — verified against a local Graph stand-in; no live Meta traffic yet]**

- **Ingestion:** `POST /api/webhooks/meta` reads the raw body with a hard 4 MB cap (Meta payloads can
  reach ~3 MB), verifies `X-Hub-Signature-256` (HMAC-SHA256 of the raw body, constant-time, current
  and previous app secret during rotation), stores an encrypted `ops.webhook_receipts` row
  (deduplicated by body hash, AAD = receipt id) and only then returns 200. Persistence failure → 500
  so Meta retries (for up to 7 days). Invalid signatures → 401 plus a rate-limited security event.
  A signed `webhook.process` job (same transaction) processes the receipt; a sweeper re-signals
  receipts whose signal was lost, up to 12 attempts, then leaves them for operators.
- **Routing:** `ops.resolve_provider_asset(provider, asset_type, external_id)` (SECURITY DEFINER,
  ids only) maps a phone number id to its company; the binding's WABA must equal the entry id.
  Unknown or mismatched assets go to `ops.webhook_quarantine` (platform-visible only, one row per
  receipt and reason). The company is never taken from the request.
- **Idempotency:** messages unique on `(tenant_id, channel_account_id, external_message_id)`;
  status events immutable and unique on `(…, external_message_id, status, provider_timestamp)`;
  current state only moves forward by rank (`failed` outranks `sent` but not `delivered`, as Meta
  documents both for one message). Statuses that arrive before the WAMID is recorded are stored and
  applied when the send is accepted.
- **Identity:** contacts keyed per WABA by business-scoped user id (BSUID), phone optional
  (ADR-013); sending to BSUID-only contacts is refused as unsupported until verified.
- **Outbound:** the message row, a durable `app.send_intents` row (client idempotency key per
  composer submit) and a signed job are written in one transaction. The worker re-checks company
  status, sender membership, channel state and the 24-hour window at send time, takes a token from a
  per-number PostgreSQL bucket (`META_SEND_RATE_PER_SECOND`, default 20) and runs in a pg-boss
  fairness group per number. Dispatch is recorded before the request leaves. Outcomes: `queued →
sending → accepted → sent → delivered → read/played`, or `failed`, `canceled`, `unknown_outcome`.
  Meta documents no idempotency key for `/messages`, so a timeout, reset or lost worker after
  dispatch becomes `unknown_outcome` and is never resent automatically; a member marks it as arrived
  or chooses to send again, accepting a possible duplicate. `biz_opaque_callback_data` is not used
  (unconfirmed for status correlation). Retryable rejections (429/5xx/rate codes) back off with
  jitter; revoked tokens mark the number `needs_reconnect`.
- **Onboarding:** Embedded Signup with a single-use state bound to member, auth session and company;
  server-side code exchange, `debug_token` checks and an independent WABA/number ownership check with
  the new token; encrypted token; definer-function bindings; then `channel.onboard` jobs subscribe
  the app, register the number (generated six-digit PIN, encrypted) and read its health, resuming
  from the last completed step. Facebook's SDK is allowed by CSP (and COOP relaxed to
  `same-origin-allow-popups`) on the channels settings page only.
- **Live inbox:** `app.tenant_events` (xid8 + id cursor; readers only see transactions below the
  snapshot xmin, so no event is skipped), events record the conversation's assignee so streams only
  carry ids a member may see, `NOTIFY` wakes one `LISTEN` connection per web process, the SSE endpoint
  replays from `Last-Event-ID`, re-validates session and membership every 30 s and ends after 10
  minutes; clients fall back to polling with the same cursor and resynchronise after reconnects.
- **Retention:** raw webhook bodies erased after 7 days, receipt rows deleted after 90, live events
  pruned after 7 (definer functions run by the messaging sweep).
- **Not built yet:** media download to private object storage, templates and template sends,
  message search, token health checks via `debug_token`, Meta-side deregistration on disconnect.

## 6A. Contacts, consent and templates **[built — templates verified against a local Graph stand-in only]**

- **Contacts** (`packages/domain/src/contacts`): one row per phone number per company (unique
  index). Manual entry, CSV import and inbound identities converge on it; the WhatsApp id returned by
  a template send is stored as an identity. Custom fields are typed definitions with values in
  `contacts.attributes`. Import is a synchronous server action (preview → mapping → one
  transaction, batched by 500); export streams CSV from keyset batches, each in its own read-only
  transaction. Erasure is `app.erase_contact` (SECURITY DEFINER), leaving an empty tombstone row so
  conversations and delivery history keep their foreign keys.
- **Consent** (`packages/domain/src/consent`): append-only `consent_events`; a definer trigger
  maintains `contact_consents` (later wins, opt-out wins ties). Sources: keyword messages (matched
  in ingestion on newly stored text, button and interactive replies), member notes, import
  attestations, Meta error 131050 (status webhook or send response) and erasure. Company settings
  hold the keyword lists and the marketing opt-in requirement.
- **Templates** (`packages/domain/src/templates`): editor model ↔ Meta component format
  (`definition.ts`, also exported to the browser as `@w360/domain/template-definition` because it
  depends only on zod); drafts and status history in `message_templates` /
  `template_status_events`. Worker queues: `template.submit` (write-ahead create),
  `template.delete`, `template.sync` (paged listing, reconcile by id then by name and language).
  Syncs are signalled by template webhooks (`whatsapp_accounts.templates_sync_requested_at`), by the
  per-minute messaging sweep (`ops.template_sync_due`: requested, in review every 5 minutes, or older
  than 6 hours) and by members.
- **Template sends** reuse the Phase 2 pipeline: `queueTemplateMessage` writes the message and send
  intent (type `template`, rendered text stored for the thread, request body without secrets); the
  worker skips the 24-hour window check for templates but re-checks template approval, consent and
  the suppression list inside the claim transaction before any request leaves.

## 6B. Segments and campaigns **[built — sends verified against a local Graph stand-in only]**

- **Segments** (`packages/domain/src/campaigns/segments.ts`): saved, dynamic lists of conditions
  (tags, consent, typed custom fields, creation date in the company's time zone, source, last
  inbound message, calling code, response to an earlier campaign) combined with all/any. They
  compile to parameterised SQL over `app.contacts`; erased contacts never match.
- **Campaign lifecycle** (`campaigns/service.ts`): draft → (pending_approval →) scheduled → running
  → completed, with paused and canceled. Submitting runs the readiness checks, freezes the audience
  (`campaign_recipients`, one row per contact, pending or skipped with a reason, no personal data)
  and records the submitter. With approval required, a different member with `campaigns.approve`
  approves. Sends run under the submitter's (or the resuming member's) authority.
- **Scheduling** (`campaigns/schedule.ts`): a wall-clock time in an IANA zone resolved with Node's
  ICU data; a time inside a daylight-saving gap moves forward by the jump, a repeated time means its
  first occurrence, and the adjustment is stored and shown. An optional daily sending window (which
  may wrap midnight) delays ticks until it opens. `stop_after_hours` bounds the sending period;
  recipients not reached by then are recorded as expired, so a campaign held up by a suspension is
  never replayed days later.
- **Runner** (`campaigns/runner.ts`, queue `campaign.run`): one tick about every 10 seconds per
  running campaign under the campaign row lock and a per-company advisory lock. It pauses when the
  template is no longer sendable, the number is inactive, the sending member lost authority, a cap
  is reached or rates are missing; otherwise it takes the next pending recipients (pacing by
  `rate_per_minute` or the number's rate, at most 500 per tick, bounded by sends still queued),
  re-checks each with fresh data and queues ordinary messages + send intents + `message.send` jobs
  (batch insert). Campaign threads are created resolved; a reply reopens them. The per-minute
  messaging sweep re-signals ticks through `ops.campaigns_due` (active companies only).
- **Guardrails:** marketing frequency cap per contact (company setting; counts marketing templates
  from campaigns and the inbox), message cap, estimated spending cap (rate cards, ADR-023), pacing,
  approval, sending window, deadline. Meta's own limits (per-user marketing limit 131049, messaging
  tiers) still apply and show as failures with Meta's code.
- **Pause and cancel:** both cancel unclaimed send intents in the transaction that changes the
  status; pausing returns those recipients to pending, cancelling cancels them and every pending
  recipient. Cancelling is idempotent. The send worker also refuses a campaign message whose
  campaign is paused or cancelled (a send that returned to the queue after a retryable error). A
  send the worker rejects because its sending member left or the company is suspended returns its
  recipient to pending (cancelled if the campaign has ended), so a resumed or reactivated
  campaign still reaches them, subject to its deadline.
- **Outcomes and attribution:** delivery progress is read from the linked message; replies and
  marketing opt-outs are attributed last-touch within 72 hours to a message WhatsApp accepted, by
  ingestion and consent recording (ADR-025); the reply and opt-out rates count delivered
  recipients only. Analytics compute rates with explicit denominators from `METRIC_DEFINITIONS`
  (`packages/domain/src/reports/definitions.ts`); clicks and conversions are reported as not
  measured. Per-recipient CSV export is formula-safe and audited.
- **Rate cards** (`ops.rate_cards`, `rate_card_prefixes`, `rate_card_prices`): entered by platform
  staff from Meta's published cards (platform console), immutable once published; companies read
  published cards only.

## 6C. Reports **[built — numbers come from HyFib's own records; provider data verified against a local Graph stand-in only]**

- **Computed on request, never stored** (`packages/domain/src/reports/service.ts`): one
  repeatable-read, read-only transaction per report inside the company's RLS scope, so every number
  on a page comes from the same snapshot; statement timeouts still apply. There are no
  pre-aggregated tables to drift from the source rows (ADR-026). Reports show aggregates and member
  names only, never message content or contact details.
- **Definitions** (`ops.metric_definitions`, registry in `reports/definitions.ts`): each number's
  numerator, denominator, window, time-zone rule, missing-data semantics and freshness, versioned
  and immutable; a test keeps the table equal to the registry. Metrics HyFib cannot measure
  (clicks, conversions, automation outcomes, deal outcomes, retention cohorts) are rows with
  `available = false` and a reason, shown instead of numbers.
- **Periods** (`reports/period.ts`): whole calendar days in the company's time zone, from local
  midnight to local midnight (daylight-saving days last 23 or 25 hours; a skipped midnight starts the
  day at its first real instant), at most 92 days; days are bucketed with `AT TIME ZONE` in SQL.
- **Reply turns** (`app.conversation_turns`): written only by triggers. An inbound customer message
  (not a reaction or system notice) opens a turn if none is open (the partial unique index makes
  this idempotent under concurrency); a member's outbound message closes it as replied; resolving
  the conversation closes it as resolved (crediting the acting member). Turns hold ids and
  timestamps only, so erasure leaves them. First-response times are measured from HyFib's receipt of
  the customer message to the member's send, in absolute time and, when business hours are on, in
  business hours (§6D).
- **Turns and automations** (migration 0011, ADR-037): no turn is open while an automation handles a
  conversation; a run that starts closes the open turn as `automated` (left out of reports), and a
  run that passes the conversation to people opens a turn at the hand-off (`start_reason =
'handoff'`). Turn-based metrics have new definition versions for this.
- **Cost estimates:** delivered messages (Meta charges per delivered message) that Meta's status
  webhook marked billable, priced with the published rate card for the company's billing currency in
  force when each message was recorded, by the market of the number Meta delivered to and Meta's
  pricing category. Messages Meta marked free, messages without pricing yet, and billable messages
  that could not be priced (no currency, no card, category without a rate, unknown market or erased
  recipient, no price) are counted separately rather than estimated. Campaign estimates keep the
  currency fixed when the campaign first priced a message (`campaigns.estimate_currency`).
- **Exports:** one formula-safe CSV per section, `reports.export` only; the export is audited
  (`report.exported`) before data is returned.
- **Live inbox updates** (§6): pages read the event-log position before loading their data and hand
  it to the browser, which opens the stream from there, so nothing that changes between the render
  and the connection is missed.

## 6D. Inbox teams, routing, business hours and CSAT **[built — CSAT sends verified against a local Graph stand-in only]**

- **Teams and routing** (`packages/domain/src/inbox/routing.ts`, `teams.ts`; migration 0009): a
  conversation belongs to at most one team. When a conversation starts a new case (created, or
  reopened after a resolve) routing places it in the first team (by name) whose routing keyword
  appears in the customer's message, otherwise in the team its number starts conversations in
  (`channel_accounts.default_team_id`). A round-robin team then assigns it to the next available
  member (explicit per-member availability, default off) below the team's limit of open
  conversations; with nobody eligible it waits in the team's queue. Routing never changes an
  existing assignment, so a reopened conversation stays with its assignee. All routing in a company
  runs under one transaction-scoped advisory lock (taken after the conversation row locks, at the
  end of a webhook batch), so rotation and limits hold under concurrent arrivals. A minute sweep
  (`ops.conversations_to_route`, SECURITY DEFINER, ids only) assigns waiting conversations when a
  member becomes available or a place frees up; becoming available and saving a team route at once.
  Suspending, removing or demoting a member returns their conversations to the queue.
  **Teams never change visibility**: `inbox.read_assigned` still sees assigned-to-me plus the
  unassigned queue (ADR-029).
- **Automations first:** a conversation an automation is handling is not routed (ingest, the sweep
  and availability changes all skip it); when the run ends and passes the conversation to people it
  is routed then (§6E).
- **Business hours** (`inbox/business-hours.ts`): weekly intervals (ISO weekdays, `24:00` closes at
  midnight) and closed days in the company's time zone, turned into real instants with the same
  daylight-saving rules as campaign schedules; pure functions add business minutes, measure business
  time and find the next opening.
- **Reply-due timers** (`inbox/sla.ts`): the open reply turn's start plus the first-response target,
  counted in business hours when business hours are on (the timer pauses while closed), else absolute
  time. The inbox list and thread show waiting time, due time, overdue and paused states; a
  longest-waiting order pages on `date_trunc('milliseconds', started_at)` so keyset cursors
  round-trip exactly.
- **Cases** (`app.conversation_cases`): opened by a trigger when a conversation is created or
  reopened and closed when it is resolved (resolver and assignee recorded); guarded like reply turns
  (a resolved case never changes). Resolution times are measured on cases.
- **Reports** (§6C): business-hours reply times are the overlap of each turn with the company's
  opening periods, computed in SQL against an `unnest` of periods generated in TypeScript for the
  report's range; new versioned definitions (ADR-030).
- **Saved replies** (`inbox/saved-replies.ts`): shared answers with `{{name}}`, `{{agent}}` and
  `{{company}}` placeholders, filled server-side for the conversation; the composer inserts the text
  and the member sends it as an ordinary reply.
- **Mentions** (`app.note_mentions`): a note can name members who can see the conversation at that
  moment; Inbox → Mentions lists a member's mentions in conversations they can still see, with an
  unread count cleared when they open the conversation.
- **Collision warning** (`queueTextMessage` `afterMessageId`): under the conversation row lock, a
  reply is refused once when another member's reply is newer than the newest message the sender had
  seen; the composer refreshes the thread and keeps the draft (ADR-033).
- **CSAT** (`inbox/csat.ts`, ADR-032): inside the resolve transaction, if CSAT is on, a survey is
  recorded: either an interactive message with three reply buttons (ids `w360csat:<survey>:<score>`,
  limits from Meta's OpenAPI spec, research M-157) queued through the ordinary send pipeline, or a
  skip reason (window closed, opted out, suppressed, erased, no phone number, number inactive, asked
  in the last 24 hours). The send worker re-checks the contact's consent before dispatch. Ingestion
  records the customer's first tap when its button id and `context.id` (the survey message's WAMID,
  M-158) match the conversation's survey; a tap never reopens the conversation, counts as unread,
  starts a reply turn (trigger, migration 0009), matches a consent keyword or counts as a campaign
  reply.

## 6E. Automations **[built — bot messages verified against a local Graph stand-in only]**

- **Model** (`packages/domain/src/automations/graph.ts`, browser-safe): a trigger (a message is or
  contains a keyword; a customer starts a conversation; any customer message; optionally only while
  the business is open or closed; a cooldown per conversation) and a graph of typed steps: send a
  message, ask with reply buttons (Meta's limits: 1–3 buttons, titles ≤ 20, body ≤ 1024, header and
  footer ≤ 60; research M-157/M-159), ask a question (any text, a number or an email; retries;
  answer saved under a name), condition (answers, contact fields, tags, business hours), update
  contact (tags, custom fields), wait (≤ 24 h), hand off to people (a team, or routed like a new
  case), end. Texts may use `{{name}}`, `{{company}}` and `{{answer.<name>}}`. `checkGraph` rejects
  missing targets, unsaved answers, unknown placeholders, missing teams or fields, and loops that
  never pass through a question or a wait.
- **Interpreter** (`automations/interpreter.ts`): a pure function (graph, run state, event, facts)
  → new state, effects, log entry; one call is one step. Reply buttons carry
  `w360bot:<run>:<step>:<visit>:<index>`, so a tap answers exactly the question it belongs to; a
  typed reply equal to a button title counts as that button. Budgets end runaway runs.
- **Versions** (migration 0011): drafts are edited freely (`automations.write`); publishing
  (`automations.publish`) checks the draft and freezes trigger, graph and number into a numbered,
  immutable `automation_versions` row that new runs use. Test runs use immutable test snapshots of
  the draft (reused while the draft is unchanged).
- **Dispatch** (`automations/dispatch.ts`, inside the ingestion transaction): an opt-out keyword
  stops the active run; a run waiting for a reply receives the message (`input_message_id`, a job
  keyed by the message); otherwise, in an unassigned conversation of an active company with no
  active run, the best match starts (exact keyword, contained keyword, new conversation, any
  message; then name order), subject to business-hours filters, cooldowns and 10 runs per
  conversation per hour.
- **Runner** (`automations/runner.ts`, queue `automation.run`, ADR-035): one transaction per step,
  conversation lock then run lock; checks the hand-off lock, resolve and the 7-day age; loads the
  pinned version's graph (cached: versions never change) and the contact facts; applies effects —
  bot messages through the send pipeline (active number, open window and a WhatsApp id checked
  first; a blocked send fails the run), contact updates as single statements, hand-off routing —
  appends the step log row and stores the position. A queued bot message holds the run
  (`pending_message_id`) until the send worker records Meta's acceptance and signals the run; a
  rejected, cancelled, unknown or late (10 minutes) send, or a failure Meta reports later, fails the
  run (`send_failed`) and hands the conversation to people, so a run never moves on or completes on
  a message the customer did not get. Up to 25 steps per job; waits enqueue a delayed
  job; the minute sweep (`ops.automation_runs_due`) re-signals runs more than 30 seconds overdue. A
  step that raises an error fails its job (retried by pg-boss) and is counted on the run; five failed
  attempts in a row fail the run (`step_error`) and hand the conversation to people.
- **Hand-off lock** (ADR-036): one active run per conversation (partial unique index). A member's
  reply or template, an assignment, Take over and a resolve end the run under the conversation lock
  and cancel bot messages not yet claimed by a send worker. The inbox shows which automation is
  handling a conversation and what it waits for, with Take over.
- **Logs and privacy:** `automation_run_steps` is append-only and holds step ids, outcomes,
  authored branch labels and message ids, never customer text. Captured answers live on the run
  (`variables`), are shown only to members who can see the conversation, and are cleared 30 days
  after the run ends or when the contact is erased; ended runs are deleted after 180 days.
- **Builder** (`/c/{slug}/automations`, ADR-034): a structured step list with a generated diagram,
  live checks, an in-browser simulator (sends nothing and checks neither the window nor consent),
  publish, pause, archive and restore, test runs, versions and run pages.
- **Not built yet:** the HTTP step (P4-02, needs the egress guard and a write-ahead unknown state),
  WhatsApp Flows steps (P4-03), catalog steps (P4-06), starting a run through the public API (P5),
  fuzzy keyword matching, template follow-ups outside the service window, usage billing.

## 6F. CRM **[built — reminder emails verified through Mailpit only]**

- **Model** (migration 0013, ADR-040): `crm_pipelines` (name, one ISO 4217 currency fixed at
  creation, position, archived, version) with ordered `crm_stages` (archived, never deleted);
  `crm_deals` (pipeline and stage — a composite key keeps the stage in the pipeline —, a contact for
  life, optionally the conversation it came from, title, value in the currency's minor unit, owner,
  `open`/`won`/`lost` with a lost reason, expected close date, stage entry time, version);
  `crm_tasks` (title, notes, assignee, optionally a contact or one of its deals, due time, reminder
  time and state, open/done/cancelled, version); `crm_activities`, the append-only timeline of each
  contact and deal (ids and codes, plus the body of a note). Composite foreign keys keep every
  reference inside the company and a task's or entry's deal on the same contact.
- **Service** (`packages/domain/src/crm`): pipelines (`tenant.settings.manage`, audited, at most 20
  in use; editing sets the stages in order and archives removed stages only when no open deal is in
  them), deals (create — optionally from a conversation the member can see —, edit, move, close,
  reopen, board per pipeline with owner filters and per-stage totals, won and lost lists), tasks
  (create, edit, done, cancel, reopen; lists of the member's or everyone's tasks; the member's
  overdue and due-today counts on the overview), notes, and the contact and deal timelines. Every
  change to a deal or task locks the row, checks its version and appends its timeline entry in the
  same transaction. Moving a deal to another pipeline is supported by the service (a value in a
  different currency must be cleared first) but not offered in the UI yet.
  Amounts are parsed and formatted by `crm/money.ts` (browser-safe, exact: no floats in parsing).
- **Reminders** (ADR-041, queue `crm.reminder`): saving a reminder time schedules a delayed job keyed
  by task and time; the job locks the task and, when it is due, queues the email through the outbox
  in the transaction that marks it sent; the minute sweep (`ops.crm_reminders_due`) re-signals
  reminders more than 30 seconds overdue. Reminders are skipped with a reason when the task closed,
  the assignee lost CRM access or they are more than a day late.
- **Web** (`/c/{slug}/crm`): the board (a column per stage, a stage picker on each card, owner and
  pipeline filters), won and lost lists, the deal page (stage, outcome, details, tasks, contact,
  timeline with notes), the tasks page (mine or everyone's, open or closed, by assignee, edit), and
  Settings → Pipelines. The contact page and the inbox conversation page show the contact's deals,
  open tasks and timeline with forms to add a deal (tied to the conversation), a task or a note.
  Task times are entered and shown as wall-clock times in the company time zone.
- **Reports:** deal outcomes (versioned definition `crm.deal_outcomes` v2), win rate, median time to
  win and the open pipeline, per pipeline currency, with a CSV export of closed deals per day.
- **Erasure** (`app.erase_contact`): deletes the contact's timeline, notes and tasks and blanks the
  titles and lost reasons of its deals, keeping outcomes and values for reports.
- **Not built yet:** custom deal fields, products on deals, deal import and export, forecasting,
  automation steps that create deals or tasks, and syncing with external CRMs (integrations, P4–6).

## 7. Commercial model and billing **[built: wallet, top-ups, auto-recharge — verified against a local Razorpay stand-in only; subscriptions planned]**

- **Who pays Meta:** as a Meta Tech Provider HyFib has no credit line; each customer adds its own
  payment method and Meta bills them directly (`tenants.billing_mode = 'direct_meta'`, the default).
  The HyFib wallet funds only disclosed HyFib services (e.g. AI and automation usage), so a Meta
  charge can never be taken twice. `partner_billed` requires a verified partner agreement and is
  blocked (ADR-011).
- **Subscriptions [planned]:** Razorpay Subscriptions for plan fees (separate from the wallet).
- **Ledger (0004_billing):** one INR wallet per company with five accounts (`wallet_available`,
  `wallet_held`, `payment_clearing`, `service_revenue`, `dispute_losses`). `ledger_transactions` and
  `ledger_entries` are append-only (trigger), balances are maintained by trigger from the entries,
  and a deferred constraint trigger rejects any transaction whose debits and credits differ at
  commit. Runtime roles have no write access to any of these tables: every posting goes through a
  SECURITY DEFINER function (`billing_credit_topup`, `billing_record_refund`,
  `billing_record_dispute_loss`, `billing_hold`, `billing_settle_hold`, `billing_release_hold`)
  that enforces its business rule and is idempotent by key (`topup:<id>`, `refund:<rfnd_…>`, …).
  Holds reserve available credit (row lock on the account, so concurrent spends cannot overdraw),
  settle at the verified amount and release the rest; the sweeper releases expired holds. Refunds
  and lost disputes may take available credit below zero (money owed), which blocks new holds.
- **Manual top-up:** `topups` row (`creating`) → Razorpay order with our receipt `tu_<id>` →
  Standard Checkout in the browser (card data stays in Razorpay's frame) → the handler's signature
  is checked against OUR stored order id → the payment is fetched from Razorpay → only a `captured`
  payment credits, exactly once (`billing_credit_topup` locks the top-up, checks order, amount and
  currency). Webhooks (`payment.*`, `order.paid`) and the reconciliation sweep (backing off from 15
  minutes to 4 hours, expiring after 24 h without a payment) reach the same function, so duplicates,
  reordering, `failed` → `captured` and a browser that gave up all end in one credit. A top-up whose
  order id was never stored is failed immediately: no browser can pay it.
- **Webhooks:** `POST /api/webhooks/razorpay` verifies `X-Razorpay-Signature` over the raw body
  (current and previous secret), stores the encrypted body keyed by `x-razorpay-event-id` and body
  hash before answering 200, and signals `billing.event-process`. Workers resolve the company from
  our own records (`ops.billing_resolve_order`, `ops.billing_resolve_token`), never from payload
  ids, fetch the entity from Razorpay before acting, and quarantine unknown orders.
- **Card mandate:** customer (`fail_existing: 0`) → mandate row → ₹1 authorisation order with
  `token{max_amount ≤ ₹15,000, frequency: as_presented}` → Checkout with `recurring` → token fetched
  and mapped to the mandate status; the ₹1 is refunded with an idempotency key once the mandate is
  active. Only network, issuer, last four digits and expiry are stored. Removing the card deletes
  the token at Razorpay.
- **Auto-recharge:** opt-in, disabled by default, and refused unless the platform sets
  `RAZORPAY_RECURRING_CARDS_ENABLED=true` after Razorpay activates Recurring Payments.
  `app.billing_begin_auto_recharge` decides under a per-company advisory lock: enabled, company
  active, mandate active, amount within the mandate, available credit below threshold, no attempt in
  flight (also a partial unique index), no failure in the last 24 h, and daily/monthly caps counting
  succeeded AND in-flight attempts. The attempt then moves `scheduled → order_created →
payment_requested → succeeded`; before each provider call it is written as `unknown`
  (`create_order` / `request_payment`), so a crash or lost response is reconciled first — orders by
  receipt `ar_<attempt>`, debit requests by the order's payments — and a request is repeated only
  when Razorpay shows nothing. An order accepts one captured payment and a top-up is credited once,
  so reconciliation cannot double-charge or double-credit. Card debits complete 36–72 h after the
  request (pre-debit notice), so the UI asks for thresholds with headroom. Declines fail the attempt
  (audit + email to owners and billing members), three consecutive failures turn auto-recharge off,
  and turning it off or removing the card cancels attempts that have not requested a debit.
- **Browser security:** the billing and WhatsApp-channels pages get their own CSP allowing only
  that provider's script and frame. Because a CSP belongs to the loaded document, links to these
  pages are full page loads and the pages reload once if reached by client-side navigation.

## 8. Observability

Structured JSON logs (pino) with redaction and correlation ids **[built]**; audit and security
events in the database **[built]**; OpenTelemetry traces/metrics with one hosted backend, queue lag
and dead-letter alerts **[designed]**.

## 9. Topology

|                | Production (target)                             | Pilot (lower cost)                                             |
| -------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| Web            | ≥2 replicas behind a load balancer, HTTP/2, TLS | 1 replica                                                      |
| Worker         | ≥2 replicas (jobs are claim-safe)               | 1 replica (restartable)                                        |
| PostgreSQL     | Managed, HA/standby, PITR (RPO 15 min target)   | Managed single instance with daily backups + PITR if available |
| Object storage | Private bucket, versioning, SSE                 | Same                                                           |
| Availability   | Target 99.9% (goal, not guarantee)              | Best effort; single points of failure accepted and disclosed   |

Development Docker Compose is not evidence of high availability.

## 10. Initial engineering test envelope (assumption, not a capacity claim)

100 companies, 500 connected agents, 50,000 messages/day, 100 webhook events/s bursts, a
10,000-recipient scheduled campaign. Provider limits (80 msg/s default per number, portfolio
messaging limits) override local targets. Load tests (k6) are phase 7.
