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
                        │            │             │            │
                     SMTP provider  Object storage  Razorpay   Companies' stores
                                                               (Shopify, WooCommerce)
```

- **web** serves the UI, server actions, auth endpoints, provider webhooks, health probes, two
  public routes for growth tools (chat links `/l/*` and the website button script `/widget/*`,
  section 6G) and the WhatsApp Flows data endpoint (`/api/flows/endpoint/*`, which calls companies'
  endpoints through the egress guard while WhatsApp waits, section 6H). Node.js runtime only.
  **[built]**
- **worker** processes durable jobs: email delivery, webhook processing, outbound sends, campaign
  ticks, automation runs, flow operations at Meta and flow keys, billing events, auto-recharge,
  catalog reads and Payment Links, reads from companies' Shopify and WooCommerce stores (section 6J),
  order messages (section 6K) and the minute sweepers. **[built]**
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
  the business is open or closed; a cooldown per conversation; or started by a store's order
  messages, §6M) and a graph of typed steps: send a message, ask with reply buttons (Meta's limits:
  1–3 buttons, titles ≤ 20, body ≤ 1024, header and footer ≤ 60; research M-157/M-159), ask a
  question (any text, a number or an email; retries; answer saved under a name), send a template and
  ask with a template (an approved utility or marketing template with its variables as texts; the
  asking step branches on each quick-reply button, any other reply and no reply; ADR-050), condition
  (answers, contact fields, tags, business hours), update contact (tags, custom fields), wait
  (≤ 24 h), hand off to people (a team, or routed like a new case), end. Texts may use `{{name}}`,
  `{{company}}`, `{{answer.<name>}}` and, in automations started by order messages,
  `{{order.<field>}}`. `checkGraph` rejects missing targets, unsaved answers, unknown or misplaced
  placeholders, missing teams or fields, loops that never pass through a question or a wait, empty
  template variables, templates HyFib cannot send or whose variables, buttons or account no longer
  match (checked against the company's synced templates), and, in automations started by order
  messages, a message or question that some path reaches before the customer replied. A wait or a
  question timeout over 23 hours warns only when a message that is not a template can follow it
  before a reply (templates need no window, so a run can follow up a day or more later).
- **Interpreter** (`automations/interpreter.ts`): a pure function (graph, run state, event, facts)
  → new state, effects, log entry; one call is one step. Reply buttons, and the quick-reply buttons
  of an asking template step (as their payload), carry `w360bot:<run>:<step>:<visit>:<position>`
  (position 0–9), so a tap answers exactly the question it belongs to; a typed reply equal to a
  button title counts as that button. A template variable left empty after filling in placeholders
  fails the run without sending. Budgets end runaway runs.
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
  first; a blocked send fails the run), template steps through the same pipeline without the window
  (template approved and still utility or marketing, the variables and quick-reply buttons the step
  expects, the number of the template's account, consent for the category, and for marketing the
  frequency cap under the campaign runner's company lock, which the runner only tries: busy, the step
  runs again two seconds later), contact updates as single statements, hand-off routing — appends
  the step log row and stores the position. A run started by order messages reads its order for
  each step with texts and may run while its conversation stays resolved as it was at the start. A queued bot message holds the run
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
- **HTTP step** (migrations 0014 and 0015, ADR-042, ADR-043): "Call a web address" calls a company's own API
  (GET, POST, PUT, PATCH, DELETE; JSON body; up to 10 headers; values saved from a JSON response by
  path) and branches on success (2xx) or failure. Only domains on the company's list
  (`http_allowed_domains`) can be called, over https through the egress guard
  (`packages/core/src/egress.ts`: public addresses only, pinned DNS, no redirects, 64 KiB/256 KiB/10
  s). Secrets (`http_secrets`) are encrypted, write-only, referenced as `{{secret.<name>}}` in header
  values and sent only to the domain each was saved for. The runner writes the call ahead
  (`automation_http_calls`, request encrypted) and waits up to two minutes; the `automation.http`
  worker claims it, sends it outside any transaction and records the outcome; a call that may have
  been received but has no result by the deadline is `unknown` and never retried. The minute sweep
  re-signals queued calls whose job was lost (`ops.automation_http_calls_due`). Settings → Web
  requests manages domains and secrets (`integrations.manage`); run pages list each call (method,
  host, path, outcome).
- **Not built yet:** WhatsApp Flows steps (P4-03), catalog steps (P4-06), starting a run through the
  public API (P5), fuzzy keyword matching, templates with media headers or variable buttons in
  template steps, usage billing.

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
  same transaction. Lock order: a CRM write about a contact first takes a key-share lock on the
  contact (erasure takes FOR UPDATE), then the deal or task, so an erasure and a CRM change of the
  same contact run one after the other; deal writers then share the pipeline row before reading its
  stages, so a settings change (pipeline FOR UPDATE, count open deals, archive) never leaves an
  open deal in an archived stage or pipeline. A closed deal whose stage was removed reopens in the
  pipeline's first stage. Moving a deal to another pipeline is supported by the service (a value in a
  different currency must be cleared first) but not offered in the UI yet.
  Amounts are parsed and formatted by `crm/money.ts` (browser-safe, exact: no floats in parsing).
- **Reminders** (ADR-041, queue `crm.reminder`): saving a reminder time schedules a delayed job keyed
  by task and time; the job locks the task and, when it is due, queues the email through the outbox
  in the transaction that marks it sent; the minute sweep (`ops.crm_reminders_due`) re-signals
  reminders more than 30 seconds overdue. Reminders are skipped with a reason when the task closed,
  the assignee lost CRM access or they are more than a day late.
- **Web** (`/c/{slug}/crm`): the board (a column per stage, a stage picker on each card, owner and
  pipeline filters), won and lost lists (50 at a time, keyset on the millisecond), the deal page (stage, outcome, details, tasks, contact,
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

## 6G. Growth tools **[built — links and ad sources verified with signed test webhooks only; no live WhatsApp or ad traffic]**

- **Model** (migration 0016, ADR-044): `chat_links` (a number of the company, name, pre-filled
  message ≤ 500 characters, a reference code of six characters from `A–H J–N P–Z 2–9` unique per
  company, whether the code is added to the message, a 12-character base32 slug unique across
  companies, archived, version); `chat_link_clicks` (one row per link and company day with a
  count, written only by `ops.follow_chat_link`); `chat_widgets` (a link, a 16-character public id,
  button text, optional greeting, corner, colour, shown or hidden, version);
  `conversation_sources` (one row per attributed inbound message: its conversation, contact and
  message, `ad` with the ad's id, type, web address and headline, or `link` with the link). Composite
  foreign keys keep every reference inside the company.
- **Service** (`packages/domain/src/growth`): links (create on an active number, edit, archive and
  restore, all version-checked and audited; at most 500 open links), widgets (create for an open
  link, edit, delete, audited; at most 50), each link's clicks per day for 30 days in the company
  time zone, clicks and attributed conversations per link, and the ads that started conversations
  in the last 30 days (`campaigns.read` to read, `campaigns.write` to change). `waMeUrl` and
  `prefilledText` build `https://wa.me/<digits>?text=<encoded message> (ref CODE)` (research
  M-160).
- **Ingestion** (`messaging/ingest.ts` → `growth/sources.ts`): for each new inbound message (not a
  reaction or system message), a `referral` object (research M-130) becomes an `ad` source with
  only its id, type, http(s) address and headline (bounded); otherwise a complete `(ref CODE)`
  marker in a text message, matched without regard to case, becomes a `link` source when a link of
  the company with that code opens the number the message arrived on. Redelivered webhooks add
  nothing (message dedupe; one source per message). The raw referral is no longer stored on the
  message.
- **Public routes** (no session, no company context in the URL beyond the random identifier):
  `GET /l/<slug>` counts the click through `ops.follow_chat_link` and answers 302 to the wa.me
  address rebuilt from the stored link (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
  no cookies), or 404 with a short "not available" page. `GET /widget/<id>.js` renders the button
  script from `ops.chat_widget_config` (`Cache-Control: public, max-age=300`,
  `Cross-Origin-Resource-Policy: cross-origin`), or a 404 script comment. Both definer functions
  return only what the response needs and nothing for archived links, inactive numbers, disabled
  widgets or companies being deleted.
- **Widget script** (`growth/widget-script.ts`): configuration embedded as JSON escaped for a script
  context; guards against a second copy on the same page; draws a fixed-position greeting and link
  in an open shadow root with `textContent` and CSSOM styles (text colour chosen for contrast);
  the link opens the short link in a new tab with `noopener noreferrer`. No storage, no requests,
  nothing loaded.
- **Web** (`/c/{slug}/growth`): Chat links (list with clicks and conversations over 30 days,
  archived view, new-link form with a preview of the customer's message), a link page (short link
  and direct wa.me link to copy, QR code as PNG and SVG generated on the server with `qrcode`,
  clicks per day, edit, archive or restore), Website button (script tags to copy, a notice for sites
  with a Content Security Policy, forms), Ads (ads that started conversations, with conversation and
  message counts). The inbox conversation page says which link or ad the conversation came from.
- **Erasure** (`app.erase_contact`, replaced in 0016): deletes the contact's conversation sources and
  clears any referral objects stored on its messages before 0016.
- **Not built yet:** connecting ad accounts (ad sync, spend, cost per conversation), conversion
  reporting to Meta (W-072), a link or button per team or with routing rules, UTM-style campaign
  parameters, and a public link generator for people without an account.

## 6H. WhatsApp Flows **[built — verified against the local Graph stand-in and signed, encrypted test requests only; no live WhatsApp traffic]**

- **Model** (migration 0017, ADR-045): `flows` (a WhatsApp account, name, categories, the Flow JSON
  as written, its version, data API version, first screen and answer keys, where answers go, the
  company endpoint and secret name, a public id, the Meta flow id, status, validation errors,
  health and preview, the written-ahead operation and its state, archived, version); `flow_keys`
  (one active and at most one previous key per account: public key, fingerprint, the private key
  as a keyring ciphertext, deleted when retired); `flow_key_uploads` (the key's state on each
  number: pending, uploaded or failed, and Meta's signature status); `flow_sends` (the token sent
  with each flow message, its mode, expiry and completion); `flow_responses` (answers without the
  token and what was applied). Composite foreign keys keep every reference inside the company.
- **Service** (`packages/domain/src/flows`): Flow JSON checks shared with the browser
  (`flow-json.ts`), drafts, settings (answer mapping; endpoint on an allowed domain; secret bound to
  that domain), publish, deprecate, delete, refresh, try again, new draft from a flow, archive and
  restore, all version-checked and audited; key status, set-up and replacement; the forms a member
  may send in a conversation; sending; completed forms. `flows.read` to read, `flows.write` to
  change and test drafts, `flows.publish` to publish, deprecate and replace keys, `inbox.reply` to
  send, `contacts.read` to see answers.
- **Worker** (`flows/worker.ts`, queues `flow.sync` and `flow.keys`): performs the written-ahead
  operation against the Graph API (multipart create, asset upload, publish, deprecate, delete, read;
  research M-161 to M-163), adopting its own flow after a lost create response; generates keys,
  uploads them to every active number and reads them back (M-164), and retires previous keys after
  24 hours. `ops.flow_work_due` feeds the messaging sweep with operations and uploads waiting for
  more than two minutes and keys due to retire.
- **Endpoint** (`/api/flows/endpoint/<public id>` → `flows/endpoint.ts`): 1 MB request limit;
  signature (432), lookup, decryption with the current or previous key (421), health checks and
  error notices, token and company checks (427), forwarding through the egress guard (seven
  seconds, 64 KB answer limit), encrypted answer with the inverted IV (M-100, M-167). The web tier
  has its own egress client for it.
- **Ingestion** (`messaging/meta-webhook.ts`, `messaging/ingest.ts` → `flows/responses.ts`): an
  `nfm_reply` becomes an interactive message with the answers (no token) and the preview
  "[Form submitted]"; the token is matched to its send, the answers stored and applied to the
  contact; automations are not started by it.
- **Web** (`/c/{slug}/flows`): list with archived view; new flow from the example form with checks
  while typing; a flow page with status, Meta's validation errors (line and column), health and
  preview, lifecycle buttons with confirmation, the draft editor or the published JSON, answer and
  endpoint settings, the data endpoint address and key status per number, and completed forms with
  paging. The inbox conversation page has a "Send a form" card while the window is open.
- **Erasure** (`app.erase_contact`, replaced in 0017): deletes the contact's flow responses and
  ends their tokens (expiry set to now).
- **Not built yet:** a visual form builder, sending flows from automations, campaigns or templates,
  flows that start with `data_exchange`, Meta's flow metrics, and `flow_token_signature`.

## 6I. Commerce **[built — verified against the local Graph and Razorpay stand-ins and signed test webhooks only; no live Meta or Razorpay traffic]**

- **Model** (migration 0018, ADR-046): `commerce_syncs` (one catalog read per WhatsApp account:
  state, error, times, version); `commerce_catalogs` (the catalogs Meta reported: Meta id, name,
  product count, whether the read was truncated, disconnected); `commerce_products` (retailer id,
  Meta id, name, description, price text, currency, availability, review status, removed);
  `commerce_orders` (reference, conversation, contact, message, Meta catalog id, currency, subtotal
  in minor units, item count, items that could not be read, customer note, status, version) and `commerce_order_items` (retailer
  id, name when matched, quantity, unit price in minor units); `commerce_payment_accounts` (one per
  company: key id, key and webhook secrets as keyring ciphertexts, webhook address id, check
  status); `commerce_payment_links` (written ahead: order, amount, single-use reference, Razorpay id
  and address, status, amount paid, lease, cancel request, errors, the chat message, next check);
  `commerce_payment_events` (event ids of notifications, for deduplication). Composite foreign keys
  keep every reference inside the company; `ops.commerce_payment_webhook_target` and
  `ops.commerce_work_due` are the only cross-company lookups.
- **Service** (`packages/domain/src/commerce`): catalogs and products with search and paging;
  catalog read requests (`commerce.manage`); products a member can send in a conversation and
  sending them (`inbox.reply`); orders and an order's items, links and allowed actions (`commerce.read`,
  limited to conversations the member can see); order statuses, payment requests and cancelling a
  link (`inbox.reply`); the payment account (`commerce.manage` to see the key id and webhook address,
  save or remove keys). All changes are version-checked where members edit and audited.
- **Worker** (`commerce/worker.ts`, queues `commerce.sync`, `commerce.link`, `commerce.account`):
  reads catalogs and products (M-172); creates each Payment Link once (lookup by reference after a
  lost response, R-106, R-107), cancels on request, fetches status on schedule or when signalled,
  applies paid, expired and cancelled links to orders, and queues the chat message with the link;
  checks the company's keys. The messaging sweep calls `sweepCommerceWork`, which re-signals reads
  and links that are due and queues the daily catalog re-read.
- **Webhooks**: orders arrive with the Meta webhook (`messaging/meta-webhook.ts` → `ingest.ts` →
  `commerce/orders.ts`) in the same transaction as their message. Companies' Razorpay accounts
  notify `/api/webhooks/razorpay-links/<address id>` (256 KB limit) → `commerce/webhook.ts`, which
  verifies the company's signature, records the event id and signals a fetch of the link.
- **Web** (`/c/{slug}/commerce`): orders with status filters and paging; an order page with items,
  total, note, status buttons, Payment Links (status, address, not-sent reason) and the request and
  cancel actions; catalogs per WhatsApp account with the read state and a "Read from Meta" button;
  products with search; payment settings (write-only secrets, webhook address, events to select).
  The inbox conversation page has a "Send products" card while the window is open, an Orders panel,
  and message bubbles for orders, product messages and payment requests.
- **Erasure** (`app.erase_contact`, replaced in 0018): clears the customer's note on their orders
  and requests cancellation of their open links; orders and amounts stay as business records.
- **Not built yet:** writing to catalogs, stock updates, product enquiries (`referred_product`,
  M-171), payments inside WhatsApp (`order_details`, M-174), refunds from HyFib, and order reports.
  Shopify and WooCommerce stores are §6J.

## 6J. Store connectors **[built — verified against the local Shopify and WooCommerce stand-ins only; no live store traffic]**

- **Model** (migration 0019, ADR-047): `commerce_stores` (platform, shop domain or site address,
  name, currency, the state machine authorizing → connecting → connected, failed, uninstalled or
  removing; sealed and versioned access, token expiry and granted scopes; the handshake's token hash,
  member and deadline; the per-store webhook address id and sealed secret; read cursors and page
  tokens, due times, errors, a lease); `commerce_store_orders` (external id, name, statuses,
  currency, total in minor units, customer name, E.164 number and email, status page, redaction and
  deletion times, the store's own update time) and `commerce_store_order_items`;
  `commerce_store_products` (title, status, SKU, address, price range in minor units, stock,
  variants); `commerce_store_fetches` (what signed webhooks asked the worker to read);
  `commerce_store_events` (delivery ids, 30 days); `commerce_store_privacy_requests` (Shopify's
  customer requests). Everything cascades from the store. `ops.commerce_store_by_shop`,
  `ops.commerce_store_by_webhook`, `ops.commerce_store_by_connect` and
  `ops.commerce_store_work_due` are the only cross-company lookups.
- **Service** (`packages/domain/src/stores/service.ts`): stores and a store's detail
  (`commerce.read`); connecting (Shopify handshake, WooCommerce approval or pasted keys), the calling
  code setting, "read now", removal and answering data requests (`commerce.manage`); store orders
  with search and keyset paging, an order with items and the matching contact, products, and the
  orders next to a conversation (`commerce.read` and `contacts.read`; the conversation panel also
  needs the conversation to be visible). Changes are audited.
- **Clients**: `stores/shopify.ts` (the code exchange and refresh, Admin GraphQL with named
  operations checked against the 2026-07 and 2025-10 schemas, cost-based throttling, withheld
  customer data, subscriptions, `appUninstall`) and `stores/woocommerce.ts` (REST v3 with Basic
  authentication: currency, orders and products by `modified_after` or ids, webhooks), both through
  the egress client.
- **Worker** (`stores/worker.ts`, queue `commerce.store`, one job at a time per store under a row
  lease): finishes connecting (code exchange, scopes, shop details, webhooks), reads signalled items,
  reads what changed since the cursor, refreshes Shopify tokens, checks webhooks every six hours,
  prunes delivery ids and removes stores. The messaging sweep calls `sweepStoreWork`.
- **Webhooks**: `/api/webhooks/shopify` (256 KB; HyFib's app secret; order, product,
  `app/uninstalled` and compliance topics) and `/api/webhooks/woocommerce/<address id>` (1 MB; the
  store's secret) → `stores/webhook.ts`: verify, dedupe, then mark deletions or signal a fetch.
  `/api/stores/shopify/callback` (GET, signed query, the signed-in member) and
  `/api/stores/woocommerce/callback` (the key handover, 16 KB) finish the handshakes.
- **Web** (`/c/{slug}/commerce/stores`): the stores with status and counts; connect forms for both
  platforms; a store page (status and errors, facts, read now, connect again, remove with a
  confirmation, privacy requests, the calling code); orders with search, an order page (items,
  customer, the matching contact, status page) and products. The inbox conversation page has a
  "Store orders" panel for the contact's number.
- **Erasure** (`app.erase_contact`, replaced in 0019): redacts the store orders with the contact's
  number or email for good; new orders from a number suppressed as erased are kept without the
  customer's details.
- **Not built yet:** store customers, discount codes, writing to stores, other platforms. Messages on
  store events are §6K.

## 6K. Order messages **[built — verified against the local Shopify, WooCommerce and Graph stand-ins only; no live store or WhatsApp traffic]**

- **Model** (migration 0020, ADR-048): store orders gain their payment names, whether they are paid
  on delivery, when they shipped and were delivered, the latest shipment's tracking (redacted with
  the customer's details; a constraint ties them to `redacted_at`) and when an order in transit was
  last read. Stores gain the manager's opt-in confirmation (who and when), sending hours (minutes in
  the company's time zone) and whether test orders are messaged.
  `commerce_store_message_rules` holds one rule per store and event (`order_placed`,
  `cod_confirmation`, `order_shipped`, `order_delivered`, `order_cancelled`): on or off, when it was
  switched on, the number, the template, the variables, the delay and the cash on delivery buttons.
  `commerce_store_messages` holds at most one message per order and event: pending, queued (with the
  chat message and contact) or skipped (with the reason), the event's time, the send time and the
  cash on delivery answer. `ops.commerce_store_messages_due` is the only cross-company lookup.
  `contacts.source` gains `store`.
- **Rules** (`stores/messages-model.ts`, browser-safe): event detection from an order's milestones
  before and after a read (never about the past, never twice, test orders and events seen more than
  48 hours late recorded as skipped, cancelled orders never shipped or delivered), the send time
  (delay, sending hours via `sendingWindow`), variables (fixed text or order fields: number,
  customer, total, items, status page, tracking, store name) and the cash on delivery payloads.
- **Worker**: the store job (`stores/worker.ts`) records events in the transaction that saves the
  orders, and reads Shopify orders in transit again every three hours while the delivered message
  is on. `stores/order-messages.ts` runs the `commerce.store-message` job: every check again under
  the row lock, then the contact, conversation, message (`sender_type = system`) and send intent;
  the send pipeline checks consent once more and records delivery. The messaging sweep calls
  `sweepStoreMessages`.
- **Answers**: webhook ingestion hands `button` messages to `recordStoreMessageAnswer`, which accepts
  a cash on delivery tap only from the message's own contact, conversation and (when named) message,
  keeps the newest answer, and tells ingestion to treat it as an answer (no keyword, campaign reply
  or automation; a confirmation stays quiet, a cancellation reopens the conversation).
- **Service** (`stores/messages-service.ts`): a store's Messages page (settings, one rule per event,
  numbers, sendable templates, the last 30 days by status; `commerce.read`, customer names with
  `contacts.read`), saving settings and rules (`commerce.manage`; marketing templates also
  `campaigns.send`; optimistic versions; audited), and an order's messages (`commerce.read` and
  `contacts.read`).
- **Web** (`/c/{slug}/commerce/stores/{id}/messages`): the opt-in confirmation, sending hours and test
  orders; a form per event (number, template with its text, variables with fallbacks, delay, the
  cash on delivery buttons); the report with reasons. Order pages show payment, shipping, tracking and
  the order's messages with the customer's answer; the inbox labels the message with its store and
  event.
- **Not built yet:** messages per shipment or on tracking changes, changing orders in the store from a
  customer's answer. Cart reminders are §6L; rules that start automations are §6M.

## 6L. Cart reminders **[built — verified against the local Shopify and Graph stand-ins only; no live store or WhatsApp traffic]**

- **Model** (migration 0021, ADR-049): stores gain the checkout read (cursor, Shopify's page cursor
  while a read continues, when the next read is due, the last read's error), customer access (when a
  manager asked for `read_customers`, the sealed authorization code for the worker, the last
  refusal) and the store consent setting (who turned it on and when). `commerce_store_checkouts`
  holds the checkouts read: number, name, Shopify's consent for that number, total in minor units,
  up to ten items, the https recovery address, when it was completed and a sticky `redacted_at`
  (a constraint keeps the customer's details off redacted rows). Store messages are about an order
  or a checkout (a constraint ties the cart events to checkouts; unique per checkout and event).
  Rules gain `cart_reminder` (30 minutes to 24 hours) and `cart_second_reminder` (1 hour to 3 days).
  Consent events gain the `store` source (a store's events are unique per contact, purpose, action
  and time).
  `ops.commerce_store_work_due` also returns stores whose checkout read is due; `app.erase_contact`
  redacts the contact's checkouts.
- **Rules** (`stores/messages-model.ts`, browser-safe): which checkouts call for a reminder (not
  completed, not redacted, with a number, updated at or after the rule was switched on), the delay
  ranges, the checkout values (customer, total, items, recovery address, store name) and the consent
  action a Shopify consent state stands for.
- **Reading** (`stores/worker.ts`, `stores/cart-reminders.ts`): while a cart reminder is on, the store
  job reads `abandonedCheckouts` updated since the cursor every 15 minutes, up to ten pages per run,
  and with the customer's default phone and consent only while store consent is on and the store
  allowed customer access. Each page is saved (an older copy never replaces a newer one; redaction
  sticks), then its reminders are recorded (a waiting reminder moves when the checkout is updated
  again) and its consent imported (never creating a contact for a suppressed number), in one
  transaction. A read's errors stay on the store (`checkouts_error`) and never fail the order sync;
  throttling waits as Shopify asks. The job also exchanges a customer access code: the new token
  replaces the old one (Shopify keeps one current token per store, SH-007), bound to the
  credentials version read; without the connector's own scopes the store fails and must be
  connected again. Checkouts are deleted 30 days after their last update.
- **Sending** (`stores/order-messages.ts`): the `commerce.store-message` job runs every order message
  check plus the cart checks (checkout still there, not redacted, not completed; no order with the
  number since the checkout began; a marketing template; the second reminder only after the first
  was sent, waiting while the first waits; at most three days after the checkout was left), then the
  marketing frequency cap under the campaign runner's company lock (for every store message with a
  marketing template).
- **Service** (`stores/messages-service.ts`, `stores/service.ts`): cart rules (marketing templates,
  delay ranges, the second after the first; switching the first off switches the second off;
  switching the first reminder on starts the read cursor), the store consent setting
  (`commerce.manage` and `contacts.write`; needs customer access and Shopify 2026-07), customer access
  (`commerce.manage`; a new authorization for a connected store, accepted by the Shopify callback
  like a connection), and the 30-day report (reminders sent, checkouts recovered and their value per
  currency). "Read the store now" also makes a pending checkout read due.
- **Web** (`/c/{slug}/commerce/stores/{id}/messages`): a Cart reminders card for Shopify stores
  (customer access, the store consent setting, the report and read errors) and a form per reminder;
  the report table names the checkout. The contact page labels consent the store recorded.
- **Not built yet:** WooCommerce carts (no API, WC-023), checkout webhooks, writing consent back to
  Shopify, cart reminders that start automations.

## 6M. Store events in automations **[built — verified against the local Shopify and Graph stand-ins only; no live store or WhatsApp traffic]**

- **Model** (migration 0022, ADR-050): an order message rule has an `action` (send its template, or
  start `automation_id`; only order placed, shipped, delivered and cancelled may start one). Runs
  gain `store_order_id` (the order they read; set null when it is deleted) and `store_event`, and
  the `store_event` trigger type; store messages gain the `started` state and `automation_run_id`
  (set null when retention deletes the run). The run guard keeps `store_event` fixed and lets
  `store_order_id` only be cleared.
- **Starting** (`stores/order-automations.ts`, from the `commerce.store-message` job): after the order
  message checks (store, opt-in, rule start, sending hours, order, number), the automation must be
  active with a live version that starts from order messages and allows the rule's number; the
  number active and not suppressed; the contact not erased or opted out; the conversation (created
  resolved when new) not assigned and without an active run; fewer than 10 runs there in the last
  hour. The run and the store message's `started` state are written in the store message's
  transaction, so one store message starts at most one run. Automations with this trigger never
  match customer messages (`dispatch.ts`).
- **Running** (`automations/runner.ts`, §6E): each step with texts reads the order as it is now
  (`stores/order-values.ts`; a deleted or redacted order gives empty values); template steps send
  outside the window; the run continues while its conversation stays resolved as it was at its
  start, the customer's reply reopens it, and a conversation resolved later stops the run; routing at
  the end touches only open conversations.
- **Service** (`stores/messages-service.ts`, `automations/service.ts`): choosing an automation on a rule
  needs `commerce.manage` and `automations.read` (and `campaigns.send` for one with a marketing
  template), and its templates must belong to the rule's number's account; publishing or testing an
  automation with a marketing template needs `campaigns.send`; a test run of a store-event
  automation reads an order the member chooses (`commerce.read`). The Order messages report and the
  order page show automations started and their outcome (the run linked for `automations.read`), the
  run page the order (`commerce.read`), the automation page the rules that start it.
- **Web**: the builder's "An order event in a store" trigger with the order fields, the template step
  fields (template, variables, a branch per quick reply, other reply, no reply), the simulator's
  sample order and quick replies, the test form's order choice; "What happens" on the store's rule
  forms.
- **Not built yet:** cash on delivery confirmations and cart reminders in automations, conditions on
  order fields, changing the order from a run, messages per shipment or on tracking changes.

## 7. Commercial model and billing **[built: plans and entitlements, wallet, top-ups, auto-recharge — verified against a local Razorpay stand-in only; paying for plans in HyFib planned]**

- **Who pays Meta:** as a Meta Tech Provider HyFib has no credit line; each customer adds its own
  payment method and Meta bills them directly (`tenants.billing_mode = 'direct_meta'`, the default).
  The HyFib wallet funds only disclosed HyFib services (e.g. AI and automation usage), so a Meta
  charge can never be taken twice. `partner_billed` requires a verified partner agreement and is
  blocked (ADR-011).
- **Plans and entitlements (0023, ADR-051) [built]:** platform owners keep a catalog of plan
  versions in `ops.plans` (never seeded, INR paise per 1, 3 or 12 months, trial and grace days,
  limits, add-on prices and modules): drafts change, published versions never do (a trigger), and
  retired ones stay with the companies on them. Every company has one row in `app.tenant_plans`
  (complimentary, trialing, active, past_due, expired, canceled), created by a trigger when the
  company is created (a trial of `ops.plan_settings.default_trial_plan_id`, else complimentary) and
  written afterwards only by platform staff (`setTenantPlan`, with both audit logs and a version
  check) and by `app.apply_plan_transition`, which the minute billing sweep calls in the company's
  scope for trials, paid periods and grace periods that have ended (notices to billing managers). An
  expired or canceled plan sets `tenants.status = 'restricted'` through a trigger; restricted
  behaves like suspended (`ALLOWED_WHEN_SUSPENDED`, jobs deferred, sweeps skip it, public
  lookups still resolve), suspension wins, and a plan that gives access again lifts it.
  `app.tenant_entitlements` computes limits with add-ons (NULL: no limit) and modules; the services
  check a limit where something is added, under a per-company advisory lock (`seats:`, `numbers:`,
  `teams:`, `automations:`); seats count active members plus waiting invitations and
  `app.accept_invitation` checks the same limit in SQL. Live automation runs started by customer
  messages or store events consume `app.usage_counters` atomically (`ON CONFLICT … DO UPDATE …
WHERE used < limit`), per monthly period from `usage_anchor`; the sweep announces a used-up month
  once (`notified_at`). The tenant context drops the write permissions of modules the plan leaves
  out (`MODULE_WRITE_PERMISSIONS`); workers check the module before starting runs, order messages
  and cart reminders (`not_in_plan`). Platform staff see usage as counts only
  (`ops.platform_tenant_usage`). Charging for plans (Razorpay Subscriptions), self-serve changes,
  proration and plan invoices are not built: staff set paid periods.
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
