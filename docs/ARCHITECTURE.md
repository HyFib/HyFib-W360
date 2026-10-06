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
  A HyFib plugin records each completed sign-in as a security event, which the person reads back
  through `ops.my_sign_ins` (ADR-136).
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
3. The domain service asserts a permission, validates input with zod (`parseInput`, which also
   refuses the NUL character PostgreSQL text cannot hold, naming the field, ADR-130), and runs
   `db.run(ctx.scope)`. jsonb columns use `@w360/db`'s `jsonb` type, which writes half of an emoji
   as U+FFFD, as text columns store it (ADR-131); text clipped for a provider or for members is
   clipped with `clipText`, which never splits a character (ADR-133).
   Audit rows are written in the same transaction. Actions that hand out credentials, move money,
   take or destroy the whole company's data, or weaken account security also assert a recent
   sign-in (`assertRecentSignIn`: the session started within 15 minutes, carried in the context as
   `signedInAt`), refusing with `step_up_required`; the page then offers "Sign in again" (ADR-056).
4. Server actions additionally require an exact trusted `Origin` (on top of Next.js's own check).

Company switching is URL-based (`/c/{slug}`) with a full page load so no client state crosses
companies (ADR-006).

Server actions that change what a page shows call `refresh()` (`next/cache`), so the action's
response carries the re-rendered page. Client components do not follow such an action with
`router.refresh()`; forms whose message describes the refreshed page (the template, segment and
campaign editors) set it inside `startTransition` after the `await`, so it appears together with
that render. Client refreshes remain only where no action refreshed:
live updates, a sending campaign's polling, refused actions (conflicts) and the auth client. A page
load cancels a client refresh in flight (Firefox and WebKit at once), and Next.js answers by loading
the current page again over it; filter forms on live pages therefore navigate with `next/form`
(PROGRESS, 2026-09-28).

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
- Every job carries a signed envelope `{kind, tenantId, actorUserId, ref, issuedAt, kid, sig}`;
  `kid` names the signing key outside the signature, and verification tries every configured key
  (the signing key, and during a rotation the next or the previous one, ADR-135). Workers
  call `authorizeJob`: verify HMAC, check company status (defer outbound work while suspended),
  check the actor's membership is still active, then load the referenced row under that company's
  RLS scope.
- A work job that fails its last retry moves to the `dead-letter` queue (the sweeps, which run
  again within a minute, have none); the worker records it in `ops.dead_letters` without its error
  message (§6P), and platform administrators can send the failed job back to its queue once
  (ADR-108). The minute sweep ends, in the company's scope, the work of the three queues whose work
  no sweep signals again (ADR-111), and while a key other than the primary is configured it seals
  stored secrets that key sealed again with the primary key (ADR-134); while a previous job
  signing key is configured it signs the queued jobs that key signed again (ADR-135).
- Workers stop gracefully on SIGTERM (stop fetching, wait up to 30 s, close pools).

## 5. Email **[built]**

`ops.email_outbox` rows are inserted in the business transaction with an AES-256-GCM encrypted
payload bound (AAD) to the row id. The worker claims a row with a short lease (`sending`,
`locked_until`), sends via the SMTP adapter outside any transaction, then records `sent` and erases
the payload. Transient failures return the row to `pending` and pg-boss retries with backoff;
permanent SMTP 5xx or exhausted attempts mark `failed`. Delivery is at-least-once. Emails someone
is waiting for on a page (confirming an address, resetting a password) are queued at a higher
priority than notices, also when the outbox sweep signals a lost one again, so they do not wait
behind a burst of notices (ADR-069).

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
- **Access checks (ADR-137):** the minute sweep signals a `whatsapp.access_check` job for each
  connected account due one (daily, or asked by a send or template sync Meta refused for the token);
  the job asks `debug_token` and applies onboarding's rules in the company's scope: a loss marks the
  account and its numbers `needs_reconnect`, audits and emails the owners and administrators once;
  a failed request changes nothing and is retried after 30 minutes. Once Meta admits the token,
  the same job lists the account's subscribed apps and subscribes HyFib's app again when it is
  missing (ADR-138): a restoration is audited and emailed; one that fails is emailed once, shown on
  every page of the company and tried again after 30 minutes.
- **Not built yet:** media download to private object storage, message search, Meta-side
  deregistration on disconnect (templates and template sends: section 6A).

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
  per-minute messaging sweep (`ops.template_sync_due`: requested, in review every 5 minutes, or
  older than 6 hours) and by members. The sweep lists the accounts asked for first, and their syncs,
  like members' refreshes, are queued at a higher pg-boss priority than routine ones (ADR-178).
- **Template sends** reuse the Phase 2 pipeline: `queueTemplateMessage` writes the message and send
  intent (type `template`, rendered text stored for the thread, request body without secrets); the
  worker skips the 24-hour window check for templates but re-checks template approval, consent and
  the suppression list inside the claim transaction before any request leaves.

## 6B. Segments and campaigns **[built — sends verified against a local Graph stand-in only]**

- **Segments** (`packages/domain/src/campaigns/segments.ts`): saved, dynamic lists of conditions
  (the contact's name, tags, consent, typed custom fields, creation date in the company's time zone,
  source, last inbound message, calling code, response to an earlier campaign) combined with
  all/any. They compile to parameterised SQL over `app.contacts`; erased contacts never match. A
  name condition compares the name with its surrounding spaces removed, a name of spaces only
  counted as none (ADR-143).
- **Campaign lifecycle** (`campaigns/service.ts`): draft → (pending_approval →) scheduled → running
  → completed, with paused and canceled. Submitting runs the readiness checks, freezes the audience
  (`campaign_recipients`, one row per contact, pending or skipped with a reason, no personal data)
  and records the submitter. With approval required, a different member with `campaigns.approve`
  approves. Sends run under the submitter's (or the resuming member's) authority. A waiting
  campaign can be approved until `campaignApprovalDeadline` (its set start plus
  `stop_after_hours`, ADR-209), which `approveCampaign`, the approval email and the page share.
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
  When it pauses a campaign by itself it calls `emailCampaignPaused` (`campaigns/service.ts`) in the
  same transaction, as `pauseCampaignForRemovedLauncher` does (ADR-210): one `tenant.notice` written
  by `campaignPauseNotice` to the member whose authority the sends use while they may still send
  campaigns, otherwise to each active member who may approve and send campaigns, with the dedupe key
  `campaign-paused:<campaign>:<version>:<member>`. `CampaignRunnerDeps.notices` carries the outbox
  and the app's base URL.
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
  staff from Meta's published cards (platform console), immutable once published; the app role reads
  published and withdrawn cards, and estimates use published cards only. Companies see the cards
  for their currency under Billing → Usage and rates (§7).

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
  **Mention emails** (`inbox/mention-emails.ts`, queue `note.mention`, ADR-211): `addNote` schedules
  one signed job per member it mentions other than its author, due `MENTION_EMAIL_DELAY_MS` (10
  minutes) later. `sendMentionEmail` locks the mention row and queues a `tenant.notice` (dedupe key
  `note-mention:<mention>`) only for an unread mention less than a day old, of an active member who
  can still see the conversation, with no newer unread mention of the member there; the email names
  the author and the unread count, never the note or the customer.
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
  the business is open or closed; a cooldown per conversation; started by a store's order messages,
  §6M; or started through the API with the inputs it declares, §6N) and a graph of typed steps: send a message, ask with reply buttons (Meta's limits:
  1–3 buttons, titles ≤ 20, body ≤ 1024, header and footer ≤ 60; research M-157/M-159), ask a
  question (any text, a number or an email; retries; answer saved under a name), send a template and
  ask with a template (an approved utility or marketing template with its variables as texts; the
  asking step branches on each quick-reply button, any other reply and no reply; ADR-050), condition
  (answers, contact fields, tags, business hours), update contact (tags, custom fields), wait
  (≤ 24 h), hand off to people (a team, or routed like a new case), end. Texts may use `{{name}}`,
  `{{company}}`, `{{answer.<name>}}`, in automations started by order messages
  `{{order.<field>}}`, and in automations started through the API `{{input.<name>}}`. `checkGraph`
  rejects missing targets, unsaved answers, unknown or misplaced
  placeholders, missing teams or fields, loops that never pass through a question or a wait, empty
  template variables, templates HyFib cannot send or whose variables, buttons or account no longer
  match (checked against the company's synced templates), and, in automations started by order
  messages or through the API, a message or question that some path reaches before the customer
  replied; an automation started through the API must be limited to one number (`triggerIssues`). A wait or a
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
  each step with texts; it, and a run started through the API, may run while its conversation stays
  resolved as it was at the start. A queued bot message holds the run
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
  widgets or deleted companies (a company waiting for deletion works like a suspended one,
  ADR-055).
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

## 6N. Public API **[built — sends verified against the local Graph stand-in only; no live WhatsApp traffic]**

- **Model** (migration 0024, ADR-052): `app.api_keys` (name, public prefix, the token's SHA-256,
  scopes, author, expiry, last use, revocation, the key that replaced it) is never deleted; a guard
  trigger keeps the token, scopes and author fixed, a revocation final, an expiry only sooner and a
  replacement single. The runtime role cannot read `token_hash` (column grants) or write
  `last_used_at`. `ops.api_key_authenticate` (SECURITY DEFINER) finds a key by its token's hash and
  returns nothing for unknown, revoked or expired keys or companies being deleted; it records the
  last use at most once a minute without waiting (`FOR UPDATE SKIP LOCKED`).
  `app.api_idempotency_keys` stores successful responses per key and `Idempotency-Key` for 24 hours;
  `ops.purge_api_idempotency_keys` deletes expired rows (the messaging retention sweep). Messages the
  API sends have `sender_type = 'api'` and `api_key_id`; consent it records has the actor `api_key`.
- **Keys** (`api/keys.ts`): tokens are `w360_` + 12 base32 characters (the prefix shown in lists) +
  `_` + 32 random bytes in base64url; only the hash is stored and the token is shown once. Members
  with `developer.manage` create keys (name, scopes, expiry of 30, 90 or 365 days or none) and may
  grant a scope only when they hold its permission (`templates.read`, `contacts.read`,
  `contacts.write`, `inbox.reply` for `messages.send` and `messages.reply`, `campaigns.send` for
  `messages.send_marketing`, `inbox.read_all` for `conversations.read`, `inbox.supervise` for
  `conversations.write`, `automations.publish` for `automations.start`, `tenant.settings.manage` for
  `contact_fields.manage`, and `campaigns.read` for itself, ADR-125); at most 20 active keys per
  company, counted under an advisory lock.
  Rotation creates a key with the same name, scopes, lifetime and networks and lets the old one work
  for 0 to 72 hours (0 revokes it); revocation is immediate. Each change is audited without the
  token. A key may list up to 20 networks it accepts requests from (`allowed_networks cidr[]`, 0051,
  ADR-076): checked for shape in the service, canonicalised by PostgreSQL (`pg_input_is_valid`,
  `::cidr`), editable for an active key with a recent sign-in (`setAllowedNetworks`, audited). The
  company may list up to 20 networks for all its keys the same way (`app.api_settings`, 0076,
  ADR-099; `setCompanyNetworks` under the company's key lock, audited `api.networks_changed`).
- **Requests** (`apps/web/src/server/api.ts`): the bearer token is checked by shape, then through
  the definer function with the client's address (`authenticateApiRequest`,
  `ops.api_key_authenticate(hash, inet)`): a key whose networks, or whose company's networks for all
  keys, do not contain the address (or any such key when the address is unknown) answers 403
  `ip_not_allowed` naming whose list refused it (`refused_by`), is not marked used and counts as a
  failed authentication for the address; the request acts in its company's scope as the
  key (`ApiContext`, no user), so no company id is ever read from the request. Failed authentication is limited per client
  address (bursts of 20, one every 5 seconds), then each key (bursts of 50, 10 a second) and each
  company (bursts of 200, 30 a second) have token buckets (`admitFailedApiAuthentication`,
  `admitApiRate` in `api/rate-limits.ts`; a request its key refuses takes nothing from the
  company's bucket); over the limit answers 429 with `Retry-After`. Buckets that are full again are
  deleted by the minute messaging sweep (`ops.purge_rate_limit_buckets`, 0041, ADR-068). Then the
  request is counted against the plan's monthly API requests (below). JSON
  bodies need `Content-Type: application/json` and at most 64 KB. A query parameter or JSON string
  holding the NUL character (U+0000), which PostgreSQL text cannot store, is refused with 422 naming
  where before the handler runs (`assertNoNulCharacter`, `api/request-text.ts`, ADR-124; the body
  is walked without recursion). Writing scopes
  are refused while the company is suspended or restricted (reading continues). Errors are
  `{"error": {"code", "message", "reason"?, "issues"?}, "requestId"}` with the status of the
  application error; other failures are a generic 500 logged with the request id. Tokens are never
  logged; responses are `private, no-store`.
- **Resources** (`api/resources.ts`): approved utility and marketing templates with their variables
  and numbers; contacts listed newest first with keyset cursors (or by number), read, and created
  (201) or returned when the number exists (200, filling an empty name or email and adding tags;
  suppressed numbers refused); consent recorded with its evidence (source `api`); template sends
  with the members' checks (an approved template; its category's scope; the variables; the number
  given as `from`, or the only active one; the template's account; erasure, suppression, consent and
  the marketing frequency cap under the campaign runner's lock), a conversation created resolved,
  a send intent without a user and the `message.send` job, re-checked before dispatch like every
  template send; the status of messages the API sent, with their type.
- **Contact custom fields and changes (0090, ADR-112):** every contact the API returns, and the
  contact in the contact webhooks, carries `fields`: the values of the company's custom fields by
  key, typed (strings for text and dates, numbers, booleans), read by a subquery over
  `app.contact_fields` (`apiContactColumns` in `api/contact-view.ts`) so a key no field has is never
  returned. `GET /contact-fields` (`api/contacts.ts`, `contacts.read`) lists the fields by label.
  `POST /contacts` takes `fields` (an existing contact gets only those it has no value for, merged
  under its own values), and `PATCH /contacts/{id}` (`apiUpdateContact`, `contacts.write`) changes
  the name, email, a typed number (ADR-180: `assertNumberFree` refuses a contact with a WhatsApp
  identity, a number another contact has and a suppressed one), field values and tags in one
  transaction: `apiFieldChanges` reads the named fields `FOR SHARE` (the order a field's deletion
  takes its locks) and checks each value with `apiFieldValue` (`contacts/fields.ts`: JSON types, no
  coercion), then the contact row is locked `FOR UPDATE`; only what differs is written and audited
  as `contact.updated` (keys and counts, no values). A refused value names `fields.<key>` in
  `issues` and nothing is saved. Both writes keep the app's 50-tag limit.
- **Finding contacts (ADR-113):** `GET /contacts` also takes `email` (compared through the
  `lower(email)` index), `tag` and up to 5 `fields[<key>]` (`contactListQuery` turns the
  `deepObject` parameters into one object for the schema). `apiFieldFilters` checks each key against
  the company's fields and reads each value with its field's type (`apiFieldFilterValue`), then
  compares as segments' "equals" does. A page filtered by tag or field first finds the 2,000th
  contact of its range (`API_CONTACT_SEARCH_WINDOW`) and reads only down to it, so its cursor goes on
  past the window when few contacts match, as the message feed's does; both reads share a repeatable
  read snapshot.
- **Finding contacts by name (ADR-124):** `name` on `GET /contacts` (`apiContactListFilters` trims
  it and refuses it empty) adds `display_name ilike likePattern(name)` to the windowed filters, the
  comparison members' search makes (`contacts/service.ts`), so a page filtered by name reads at most
  `API_CONTACT_SEARCH_WINDOW` contacts, as one filtered by tag or field does.
- **Campaigns (0099, ADR-125):** `campaigns.read` (reading) lists the company's campaigns from their
  rows (`apiListCampaigns`, `api/campaigns.ts`: keyset pages over `campaigns_list_idx`, an optional
  status, the template and number joined by the company and id) and reads one with
  `campaignAnalytics` (`campaigns/service.ts`), the counting members' campaign page uses, in one
  repeatable-read, read-only transaction, so the row and its counts agree; a draft has no results.
  The answers hold counts and names only.
- **A campaign's recipients (ADR-127):** `apiListCampaignRecipients` (`api/campaigns.ts`,
  `campaigns.read` and `contacts.read`) checks that the campaign is the company's, then reads its
  recipients with their contacts and messages in id order on keyset pages, erased contacts left out.
  `outcome` picks one condition of `RECIPIENT_OUTCOME_SQL` (`campaigns/outcomes.ts`), the conditions
  `campaignAnalytics` counts with, so a list and its count share one definition.
- **Pausing and cancelling campaigns (0100, ADR-128):** `apiPauseCampaign` and `apiCancelCampaign`
  (`api/campaigns.ts`, `campaigns.stop`, writing) lock the campaign row (`lockCampaign`), check the
  statuses each allows and call `pauseLockedCampaign` or `cancelLockedCampaign`
  (`campaigns/service.ts`), which members' pause and cancel call too, with the key as the one who
  stopped it: the pause reason `api`, the event's detail naming the key (`apiKeyId`, no member) and
  `canceled_by_user_id` null. The audit row is the key's (`recordSystemAudit` with `apiActor`), and
  `campaign.status_changed` comes from the status trigger (0065). Members' campaign history joins
  the key's name on the event's `apiKeyId`.
- **Resuming campaigns keys paused (0124, ADR-176):** `apiResumeCampaign` (`api/campaigns.ts`,
  `campaigns.resume`, writing) locks the campaign row, answers a scheduled or running campaign as it
  is, refuses any status but paused and any pause reason but `api`, checks the launcher with
  `campaignLauncherStanding` (which the runner uses before each batch too) and calls
  `resumeLockedCampaign` (`campaigns/service.ts`), which members' resume calls too: members' checks,
  the counters counted again, the status and next run set and the runner signalled, with the event
  naming the key (`apiKeyId`, no member) and `launched_by_user_id` kept. The audit row is the key's,
  and `campaign.status_changed` comes from the status trigger.
- **Campaign drafts (0134, ADR-186):** `apiCreateCampaign` and `apiUpdateCampaign`
  (`api/campaigns.ts`, `campaigns.write`, writing) turn the request into members' draft input
  (`apiDraftInputFrom`, from a new draft's defaults or from the locked draft through
  `campaignDraftInputOf`), then call `prepareCampaignDraft` and `writeLockedCampaignDraft`
  (`campaigns/service.ts`), which members' save calls too. A key's draft is inserted without a
  creator; the `created` and `edited` events carry the key's id and the audit rows are the key's.
  `PATCH` refuses any status but draft and, when given, a version other than the draft's. Answers
  add `version` and `settings`, which `GET /campaigns/{id}` gives only to keys that hold
  `campaigns.write`.
- **Cancelling drafts (ADR-187):** `apiCancelCampaign` takes `campaigns.stop` or `campaigns.write`,
  each checked as a writing scope before the campaign is read, then needs `campaigns.write` for a
  draft and `campaigns.stop` for any other campaign it cancels; a cancelled or completed campaign is
  answered to either. It calls `cancelLockedCampaign` as members' cancel does, with the key named in
  the event and the audit.
- **Reviewing drafts (ADR-193):** `apiReviewCampaign` takes `campaigns.write` as a read (whatever
  the company's status), reads the draft and the company's time zone in one read-only snapshot and
  calls `reviewCampaignDraft`, as members' review does; `toApiCampaignReview` answers it with the
  skip reasons commonest first and amounts in major units. Other statuses get 409.
- **Submitting drafts (ADR-202):** `apiSubmitCampaign` locks the draft, checks the version and calls
  `submitLockedDraft` (`campaigns/service.ts`), which members' `submitCampaign` calls too: the
  readiness, the audience's size, the snapshot and the event, naming the key or the member. A key's
  submission then always goes to `awaitCampaignApproval`; members' launches when the company needs
  no approval. `approveCampaign` launches a key's submission under the approving member, who must
  hold `campaigns.send`.
- **Withdrawing submissions (ADR-203):** `apiWithdrawCampaign` locks the campaign and, for a
  submission waiting for approval that the key made, calls `returnLockedCampaignToDraft`
  (`campaigns/service.ts`), which members' withdrawal and rejection call too.
- **Approval emails (ADR-204):** `emailCampaignApprovers` (`campaigns/service.ts`) runs in the
  submission's transaction after `awaitCampaignApproval`, from members' `submitCampaign` and from
  `apiSubmitCampaign`. It reads the campaign once it waits for approval, picks the active members
  whose roles grant `campaigns.approve` (and `campaigns.send` for a key's submission) other than the
  submitter, and queues one `tenant.notice` each through `enqueueEmail`, written by
  `campaignApprovalNotice`, with the dedupe key `campaign-approval:<campaign>:<version>:<member>`.
  `CampaignDeps.notices`, and `campaignNotices` for the API route, carry the outbox and the app's
  base URL.
- **Review emails (ADR-205):** `emailCampaignSubmitter` (`campaigns/service.ts`) runs in the
  transaction of `approveCampaign`, `rejectCampaign` and members' `withdrawCampaign`, given the
  submitter read before the change (sending back clears it). For a member's submission acted on by
  someone else, while that member is active, it queues one `tenant.notice` written by
  `campaignReviewNotice`, with the dedupe key `campaign-review:<campaign>:<version>:<member>`.
- **Segments (ADR-206):** `apiListSegments` and `apiGetSegment` (`api/segments.ts`) read
  `app.segments` in a read-only transaction, check each definition with `segmentDefinitionSchema`
  and `checkSegmentDefinition` (`campaigns/segments.ts`), as members' segment page does, and count
  one with `segmentWhere` in the company's time zone.
- **Writing segments (ADR-207):** `apiCreateSegment`, `apiUpdateSegment` and `apiArchiveSegment`
  (`api/segments.ts`) convert conditions with `apiSegmentConditions` (`api/contact-search.ts`), the
  search's own checks, write `app.segments` and record a system audit with the key; a unique
  violation of `segments_name_uq` becomes a 409 through `segmentNameRefusal`
  (`campaigns/segments.ts`), which members' `createSegment` and `updateSegment` use too.
- **A segment's contacts (ADR-208):** `apiListSegmentContacts` (`api/segments.ts`) reads the
  segment, checks it as `GET /segments/{id}` does, and passes `segmentConditionsSql` as the filter
  of `apiContactPage` (`api/contacts.ts`), the page `POST /contacts/search` reads, in a
  repeatable-read, read-only transaction.
- **Media from links (ADR-194):** `apiSendMedia` (`api/resources.ts`) parses `type` `image`,
  `video`, `audio` or `document`, an https `link` (`isMediaLink`) and a caption except for audio,
  and sends through `sendReply` as text replies do: the content keeps the link and the caption, the
  send intent the Graph request. `outboundText` reads the caption, and the inbox shows the link.
- **Locations (ADR-195):** `apiSendLocation` (`api/resources.ts`) parses `type` `location`, the
  coordinates as numbers within their ranges and an optional name and address, and sends through
  `sendReply`: the content keeps the coordinates as numbers, as received locations do, and the send
  intent's Graph request gives them as decimal text (`decimalDegrees`). `outboundText` reads the
  name, else the address, and the inbox shows the coordinates.
- **Contact cards' contacts (ADR-196):** `contactCards` (`webhooks/payloads.ts`) reads the contact
  objects a stored contact card kept into `ContactCard`s, every part optional, for `toApiMessage`
  (conversation messages, the feed and the change feed) and the `message.received` payload alike;
  other messages, removed content and content too large to keep give null. The inbox reads the same
  content for names, numbers and email addresses.
- **Contact cards sent (ADR-197):** `apiSendContacts` (`api/resources.ts`) parses `type` `contacts`
  with `apiContactCardInputSchema`, turns each contact into WhatsApp's words (`whatsappContact`),
  refuses contacts larger than received content may be (`jsonbSize`), and sends through `sendReply`:
  the content and the Graph request hold the same contacts, which `contactCards` reads back.
- **Stickers from links (ADR-198):** `API_MEDIA_TYPES` adds `sticker`, parsed by
  `apiSendStickerSchema` (a link and no caption) and sent by `apiSendMedia` as other media from
  links are.
- **Templates with media headers (ADR-201):** `sendSpecFor` (`templates/definition.ts`) takes a
  photo, video or document header (`TEMPLATE_HEADER_MEDIA`) only when its caller passes
  `mediaHeaders`, as the API's template list and `loadSendableTemplate` do; every other caller gets
  the reason. `buildTemplateSend` puts the link in the header's parameter and returns it, and
  `queueTemplateFor` keeps it as the content's `headerMedia`, which the inbox's bubble shows.
- **Searching contacts (ADR-117):** `POST /contacts/search` (`api/contact-search.ts`) parses
  segments' conditions (`last_message` with `conversations.read` and `campaign` with
  `campaigns.read` since ADR-126, a named campaign checked to be the company's, `name` since
  ADR-143), checks them against the company's fields with segments' rules (`fieldConditionProblem`
  and `comparisonTakesValue` in `campaigns/segments.ts`, which `checkSegmentDefinition` uses too,
  each in its own words), and
  compiles them with `segmentConditionsSql`, which `segmentWhere` wraps for segments and campaigns.
  Its pages and `GET /contacts`'s come from one function, `apiContactPage` (`api/contacts.ts`): the
  window's edge, then the matching rows down to it, in one repeatable read snapshot.
- **Groups of conditions (ADR-164):** an item of the search's `conditions` can be a group with its
  own `match`. `placedConditions` lists every condition with its place, for the scope checks and the
  campaigns named; `segmentCondition` checks each one as before, naming its place; and
  `contactSearchSql` joins the search's items by its `match`, compiling a group with
  `segmentConditionsSql` as a segment of its own and a single condition as a segment of one.
- **Changing the contacts a search finds (ADR-165):** `POST /contacts/update-matching`
  (`apiUpdateMatchingContacts`) reads one page through the search's own steps (`searchPage`, shared
  with `apiSearchContacts`), then `changeContactsAlike` (`api/contacts.ts`) checks the change's
  fields once (`lockFields`, `checkFieldChanges`), locks the page's contacts `FOR UPDATE` in id
  order and runs `changeLockedContact`, `PATCH /contacts/{id}`'s step, for each, in one repeatable
  read transaction; it answers the contacts as they now are with the page's cursor.
- **Following contact changes (0091, ADR-114):** triggers on `contacts` (insert, and an update of
  the columns the API describes), `contact_tags` (insert, delete) and `contact_consents` (set, status
  changed) call `app.capture_contact_change`, which inserts one `app.contact_changes` row per contact
  and transaction (`xact` = `pg_current_xact_id()`); its key to the contact takes the key-share
  lock adding a tag takes, and the automation runner takes it before changing a tag (members and
  keys take the contact before its tags). `apiContactChanges`
  (`api/contact-changes.ts`) reads rows above the cursor and below `pg_snapshot_xmin`, each contact
  at its latest such row, joined to the contact for its current state; the cursor is sealed with the
  keyring and the company as associated data. `ops.compact_contact_changes` (minute sweep) walks the
  rows in the same order from `ops.contact_change_compaction` and deletes the rows each change
  replaced.
- **Defining contact fields (0092, ADR-115):** `contacts/field-definitions.ts` adds, renames and
  deletes a company's custom fields for both Settings (`contacts/service.ts`, by id) and the API
  (`api/contact-fields.ts`, by key, scope `contact_fields.manage`); callers check who may and audit
  as themselves. Additions take `pg_advisory_xact_lock(hashtextextended('contact-fields:<company>',
0))` before counting, so the 50-field limit holds for additions at once; a rename changes only the
  label (`contact_fields` grants `UPDATE (label)` only); a deletion removes the field row, then the
  values (`attributes - key`), in the order a contact change locks them (ADR-112). 0092 widens the
  scope checks of `app.api_keys` and `ops.plans`.
- **Following message changes (0093, ADR-116):** triggers on `messages` (insert, and an update that
  changes the status, status time, error or content) call `app.message_changes_capture`, a SECURITY
  DEFINER function that upserts the message's one `app.message_changes` row with `xact` =
  `pg_current_xact_id()` (the message row is already locked by its change, so the upsert adds no
  wait and nothing needs compacting). `apiMessageChanges` (`api/message-changes.ts`) reads rows above
  the cursor and below `pg_snapshot_xmin`, joined to the message, its conversation and contact for
  the current state (`feedMessageColumns`, `toApiFeedMessage`, shared with `GET /messages`); both
  change feeds seal cursors with `api/change-cursors.ts`, the feed's name and the company being the
  associated data.
- **Text replies (0042, ADR-070):** `POST /messages` with `type: "text"` (`apiSendMessage` picks
  `apiSendText`; no `type` is a template) needs `messages.reply`. It finds an existing, not erased
  contact by number and locks its conversation on the number (`from`, or the only active one); a
  last message older than 24 hours, no conversation there or an unknown number all answer 412
  `window_closed`, and no contact is created. The text (up to 4,096 characters, `preview_url` off
  unless asked) goes to the contact's WhatsApp id for the number's account as a message with
  `sender_type = 'api'` and the key, a send intent without a user and the `message.send` job; the
  send worker checks the window again. The reply ends an automation handling the conversation as
  taken over (`api_replied`, cancelling its queued messages) but is not a member's reply: status,
  assignee, unread count and reply turns stay, and the inbox marks the message "API (key name)".
- **Conversation reads (0044, 0045, ADR-072):** `conversations.read` (read only, so it works while
  the company is suspended or restricted) opens `GET /conversations` (newest first, filtered by
  status, contact, number and `updatedSince`), `GET /conversations/{id}` and
  `GET /conversations/{id}/messages` (newest first), all in `api/conversations.ts`. Conversations
  join their contact, so an erased contact's conversation is neither listed nor read (404). A
  conversation says whether a member is assigned (and, since ADR-093, the member's and the team's
  ids), the unread count, the last message and
  inbound times and when the 24-hour window ends; a message reads in the webhooks' words
  (`inboundSummary` for inbound; for outbound the text, a template's rendered body or an interactive
  message's body; since ADR-132 `inboundOmissions` says whether inbound content was too large to
  keep and how many contacts a card left out), with who sent it (`agent`, `bot`, `campaign`, `api`,
  `system`), the key for API messages, the status and its error, never the media or internal
  notes. `updatedSince` compares the
  row's `updated_at`, which its trigger stamps with the transaction's start, so integrations are
  told to overlap their passes. `conversations_created_idx` (0045, built concurrently) serves the
  pages.
- **Resolving and reopening (0050, ADR-075):** `PATCH /conversations/{id}` with the `status`
  `resolved` or `open` needs `conversations.write` (`apiUpdateConversation`, which also assigns and
  moves conversations since ADR-093). It locks the
  conversation row `FOR UPDATE`, as the inbox's `setStatus` does, checks the contact is not erased
  (404 otherwise), and answers the conversation unchanged when it already has the status. Otherwise
  resolving ends an active automation run (`conversation_resolved`, no member) and sets `resolved_at`
  and an unread count of 0, reopening clears `resolved_at`; the version goes up, the live
  `conversation.status` event is emitted and the change is audited as the key
  (`conversation.status_changed`, `source: api`). The existing triggers do the rest: the reply turn
  and the case close without a member (`app.current_user_id()` is empty in the key's scope), a
  reopen opens a case, and the webhook event is captured. No satisfaction survey is queued.
- **Automations started through the API (0052–0054, ADR-077):** `automations.start` (writes,
  granted by members holding `automations.publish`) opens `GET /automations` (published automations
  whose trigger is `api`, with their inputs and number), `POST /automations/{id}/runs` (an
  `Idempotency-Key` is required) and `GET /automation-runs/{id}`, in `api/automations.ts`. A start
  runs in the idempotency key's transaction: it locks the automation `FOR SHARE`, checks the
  published version (trigger `api`, active, the inputs `apiInputValues` accepts; a marketing
  template needs `messages.send_marketing`), the number, the contact (`contactForPhone` with source
  `api`, then `checkTemplateEligibility` for utility: suppression, erasure, opt-out), the
  conversation (created resolved, locked `FOR UPDATE`; not assigned, no active run, fewer than 10
  runs in the hour) and the plan (`consumeAutomationRun`), each refusal with its reason. The run row
  has `trigger_type = 'api'`, `api_key_id` and the inputs as `input.<name>` variables; the step log,
  the live `automation.started` event, the audit entry (as the key, without the inputs) and the
  run's first job follow in the same transaction. `automation_runs_api_key` keeps `api_key_id` set
  exactly for `api` runs, the run guard keeps it fixed, and `automation_runs_api_key_idx` (0053,
  built concurrently) serves the foreign key.
- **Starting an automation for many contacts (ADR-161):** `POST /automations/{id}/runs/start-many`
  (`apiStartManyAutomationRuns`, `automations.start`, an `Idempotency-Key` required) takes up to
  `API_LIMITS.runsPerStart` (50, as each run started keeps its savepoint's transaction id and
  PostgreSQL caches 64 per transaction) starts. The numbers are normalised and a repeat refused,
  naming its place, before the transaction. In the idempotency key's transaction the automation is
  checked once (`loadApiAutomation`), then every start's inputs (`inputVariables`, 422 at
  `runs.<i>.inputs`), then the marketing scope and the number (`sendingChannel`); a start of one run
  takes the same three steps. Each start then runs `startRunFor` (the contact, eligibility, the
  conversation, the plan, the run with its step, event, audit entry and first job) in a savepoint
  (`tx.transaction`): a `conflict` or `precondition_failed` refusal rolls back to it and is answered
  in the start's place through `apiErrorResponse`, while any other error (a plan without automations
  included) refuses the call. The call keeps the conversations it starts in and, on a plan with a
  run limit, the `automation_runs` usage counter from its first start until it commits, while other
  starts take a conversation before the counter: a start for a contact further down the list can
  deadlock with it, and PostgreSQL's `40P01` comes back from `db.run` as a retryable 409
  (`mapDatabaseError`), the call starting nothing.
- **Stopping runs through the API (0057–0058, ADR-079):** `POST /automation-runs/{id}/stop` with
  `automations.start` (`apiStopAutomationRun`) finds a run keys of the company started, locks the
  conversation `FOR UPDATE` and then the active run (`lockActiveRun`), and ends it with `endRun` as
  `stopped`/`stopped_by_api`: queued bot messages and web requests not yet made are cancelled, and
  the conversation is not routed (the turn trigger opens a hand-off turn when it is open). The step
  log and the audit entry (as the key) follow in the same transaction; a run that has ended is
  answered as it is. 0057 replaces `automation_runs_end` `NOT VALID` to allow the reason; 0058
  validates it.
- **Stopping many runs through the API (ADR-162):** `POST /automation-runs/stop-many`
  (`apiStopManyAutomationRuns`, `automations.start`, up to `API_LIMITS.runsPerStop` (100) ids) reads
  the runs keys of the company started with those ids in one statement and refuses the call, naming
  the place, when one is missing; it then locks their conversations `FOR UPDATE` in id order in one
  statement (`lockConversations`, as ADR-120 locks them) and stops each run in the order given
  through the single stop's step (`stopRunIfActive`: the active run locked with `lockActiveRun`, its
  step, `endRun` as `stopped_by_api`, the audit entry as the key), leaving a run that has ended as
  it is. The answer reads the runs again, in the order given.
- **Template sends to many numbers through the API (ADR-163):** `POST /messages/send-many`
  (`apiSendManyTemplates`, up to `API_LIMITS.messagesPerSend` (50) numbers) shares the single send's
  steps in `api/resources.ts`: `loadSendableTemplate` (the company's approved template the key's
  scope may send), `assertTemplateVariables` (each send's values, named by place),
  `templateSendingNumber` (the number of the template's account, active), `lockMarketingSends` (the
  campaign runner's company lock for a marketing template, taken before any contact or conversation,
  by both calls) and `queueTemplateFor` (the contact, eligibility, the frequency cap, the
  conversation `FOR UPDATE`, the message, its send intent, the event and the job). Each number's
  `queueTemplateFor` runs in a savepoint, and a `precondition_failed` refusal is answered in its
  place. The answer is stored with the `Idempotency-Key`, as one send's is.
- **Buttons and lists through the API (ADR-080):** `POST /messages` with `type` `buttons` or `list`
  (`apiSendButtons`, `apiSendList`) takes the same path as a text reply (`sendReply`: the contact
  who wrote in the last 24 hours, the conversation locked `FOR UPDATE`, the automation ended as
  `api_replied`, the message marked with its key, one signed send job per idempotency key). The
  limits are `INTERACTIVE_LIMITS` (`messaging/interactive.ts`, from research M-157, M-159, M-179),
  checked by the request schemas together with unique titles and ids, 10 rows in all and ids not
  starting with `w360`; `replyButtonsInteractive` and `listInteractive` build the Graph `interactive`
  object, and `replyButtonsContent` and `listContent` what the inbox stores (no ids). A tap's
  `reply` (webhooks and the API's messages, `tappedReplySchema`) carries `type` and a row's
  `description` from the stored `interactiveType` and reply.
- **Webhook endpoints through the API (ADR-081):** `createApiWebhookEndpoints`
  (`api/webhook-endpoints.ts`) serves `/webhook-endpoints` for `webhooks.manage` keys with the
  settings service's own steps (`checkedWebhookUrl`, `insertWebhookEndpoint` under the company's
  endpoint lock, `lockWebhookEndpoint`, `rotateWebhookEndpointSecret`,
  `setWebhookEndpointEnabled`), limited to endpoints whose `created_by_api_key_id` is set (keys see
  and manage only what keys added). Adding and rotating run inside `idempotent`, whose `kept`
  argument stores the response with `secret: null` for replays. Adding queues a `tenant.notice` to
  owners and administrators (`deletionRecipients`) in the same transaction; audit rows name the key.
- **Quotes and reactions through the API (ADR-082):** `replyTo` on a text, buttons or a list, and
  `type` `reaction` (`apiSendReaction`), take the same path as other replies (`sendReply`); after
  the conversation is locked, `answeredMessage` finds the named message in that conversation and
  `answerProblem` (`messaging/reply-context.ts`) decides whether it can be quoted (a WhatsApp id,
  not a reaction or a notice, a business message accepted and not failed) or reacted to (the
  contact's, from the last 30 days). A quote adds `context.message_id` to the Graph request and
  keeps the id in `context_external_id`; a reaction stores `{emoji, message_id}` as inbound
  reactions do, and does not end the automation. Reading, the message a message answers is joined
  by WhatsApp id within the conversation (`answeredMessages`, `answeredJoin`: a reaction's
  `content->>'message_id'`, otherwise `context_external_id`, on `messages_external_uq`), for the
  API's messages, `GET /messages/{id}` and the inbox thread (`messageSnippet`,
  `messaging/message-text.ts`); the `message.received` payload looks it up when delivered
  (`findAnsweredMessageId`).
- **Webhook deliveries through the API (ADR-083):** `createApiWebhookEndpoints` also serves an
  endpoint's deliveries (`GET /webhook-endpoints/{id}/deliveries`, exact keyset pages on
  `(created_at, id)`, optionally by state), one delivery (`GET /webhook-deliveries/{id}`), test
  events (`POST /webhook-endpoints/{id}/test`) and replays (`POST /webhook-deliveries/{id}/replay`),
  for endpoints whose `created_by_api_key_id` is set. The settings service shares its steps:
  `queueWebhookTest` inserts a `ping` event and its delivery for an endpoint locked and on;
  `replayWebhookDelivery` finds the delivery (with `keysOnly`, only one to an endpoint a key
  added), locks the endpoint, refuses a delivery still being attempted or an endpoint that is off,
  and inserts a new delivery of the same event with `replay_of`; both lists select
  `webhookDeliveryColumns` joined to the event (`deliveryEventJoin`). Test events and replays run
  inside `idempotent`; a replay's audit row names the key.
- **Replaying failed deliveries (ADR-095):** `replayFailedWebhookDeliveries` (webhooks service)
  locks the endpoint (refused when off), selects for each event the latest failed delivery to it
  queued since the given time (`DISTINCT ON (event_id)` over `webhook_deliveries_endpoint_idx`),
  drops `event_gone` failures (but not `payload_failed` ones, sent once HyFib fixed the cause),
  `ping` events, events of other types than those given (`events`, ADR-156), events whose latest
  failed delivery failed in other ways than those given (`failures`, ADR-159: by its code when it
  has one, `endpoint_disabled` and `payload_failed` not attempted and any other no valid answer,
  else by its status, 5xx, 4xx or another) and events with any delivery to the endpoint that did not
  fail (`webhook_deliveries_event_idx`), and inserts up to `WEBHOOK_LIMITS.replayBatch` (500) new
  deliveries oldest event first, reading one more row to say whether more remain. Settings
  (`webhooks.replayFailed`, a period) and the API (`POST /webhook-endpoints/{id}/replay-failed`,
  `since`, inside `idempotent`, `keysOnly`) call it and audit once per call. A replay of every
  endpoint (ADR-160, `replayFailedAcrossEndpoints`) locks the company's endpoints (with `keysOnly`,
  those keys added) in the order they were added, in one `FOR NO KEY UPDATE` statement, then runs
  each endpoint that is on through the same step (`replayLockedEndpoint`) with what is left of the
  batch, a limit of 0 only finding whether an endpoint has more; Settings
  (`webhooks.replayAllFailed`) and the API (`POST /webhook-endpoints/replay-failed`) audit once per
  endpoint.
- **Notes through the API (0060–0062, ADR-084):** `POST /conversations/{id}/notes` with
  `conversations.write` (`apiAddConversationNote`, `api/conversations.ts`) runs inside `idempotent`:
  it locks the conversation `FOR UPDATE` (the order erasure takes), checks that it is visible (the
  contact not erased), inserts the note with `author_api_key_id` and emits `conversation.note`. The
  inbox thread reads notes with left joins to the member and the key (`authorName`, `apiKeyName`);
  `NOTE_MAX_LENGTH` (`messaging/notes.ts`) bounds members' notes and keys' alike.
  `conversation_notes_author` keeps exactly one author, `conversation_notes_api_key_fk` ties the key
  to the company, and `conversation_notes_api_key_idx` (0061, built concurrently) serves the foreign
  key.
- **Products through the API (ADR-086):** `POST /messages` with `type` `product`,
  `product_list` or `catalog` (`apiSendProducts`) takes the same path as other replies
  (`sendReply`), with two additions: a `precheck` run first in the transaction refuses a plan
  without Commerce (`loadEntitlements`, reason `not_in_plan`), and the reply's `build` resolves the
  content ids against the catalogs of the sending number's WhatsApp account (`catalogProducts`: not
  disconnected, not removed at Meta, all in one catalog, `catalogId` choosing between catalogs that
  share an id). `productInteractive` (`commerce/model.ts`) builds the Graph `interactive` object for
  the inbox and the API alike, and the message stores `content.products` as the inbox's product
  sends do.
- **Orders through the API (ADR-167):** `GET /orders` and `GET /orders/{id}` (`api/orders.ts`,
  `orders.read`) check Commerce in the plan first (`loadEntitlements`, reason `not_in_plan`), then
  read `commerce_orders` in the company, newest first by `received_at` on exact keyset cursors
  (`commerce_orders_list_idx`), the filters as plain equalities and `updated_at >= updatedSince`,
  and the page's items in one query (`itemsOf`, by order and position). `toApiOrder` gives the order
  the `order.*` webhooks describe (ADR-085), with ids in place of the contact and number objects.
- **Changing orders through the API (ADR-168):** `PATCH /orders/{id}` (`apiUpdateOrder`,
  `orders.write`) checks Commerce in the plan, locks the order's row and checks the move against
  `MEMBER_ORDER_TRANSITIONS` (and `expectedStatus`) under the lock; `writeLockedOrderStatus`
  (`commerce/service.ts`), shared with members' `setOrderStatus`, writes the status, its time and
  the next version, and the trigger of 0063 captures `order.status_changed`. The answer is read as
  `GET /orders/{id}` reads it (`readApiOrder`).
- **Numbers through the API (ADR-171):** `GET /channels` (`api/channels.ts`, `channels.read`) reads
  `channel_accounts` in the company oldest first on exact keyset cursors (`created_at`, `id`), with
  `status` as an equality, and gives the id, `display_phone_number`, `verified_name`, the status and
  `created_at`; Meta's ids, the credential, the PIN and Meta's review fields are never selected.
- **Message feed (ADR-088):** `GET /messages` (`apiListMessages`, `conversations.read`) pages the
  company's messages across conversations newest first on exact keyset cursors, joined to their
  conversation and contact (erased contacts' conversations left out), with `direction`,
  `channelId` (the message's own `channel_account_id`) and `since`. Each message is built by
  `toApiMessage`, shared with a conversation's messages. `messages_tenant_created_idx` (0008) serves
  the order; since the filters are not in it, a page reads at most `API_MESSAGE_FEED_WINDOW` (2,000)
  messages: a first read finds the window's last message (`OFFSET 1999`), the second reads the
  matches between it and the cursor, and both run in one repeatable-read, read-only transaction. A
  short page's cursor is the window's last message.
- **Reading notes (ADR-089):** `GET /conversations/{id}/notes` (`apiListConversationNotes`,
  `conversations.read`) checks the conversation is visible (the contact not erased), then pages
  `conversation_notes` newest first on exact keyset cursors. `writtenBy` comes from which author
  column is set (`author_api_key_id` for a key, `author_membership_id` for a member; the database
  keeps exactly one); member ids and `note_mentions` are never read.
- **Assigning and moving conversations (ADR-093):** `PATCH /conversations/{id}`
  (`apiUpdateConversation`, `conversations.write`) takes `status`, `assigneeId` and `teamId` and,
  with the conversation row locked, changes the team, then the member, then the status, each as the
  inbox does (events, audit as the key, `endRunForHuman` for an assignment). A member is checked and
  locked for share by `lockAssignableMember` and a team by `lockTeam` (`inbox/routing.ts`), which the
  inbox's `assign` and `setTeam` use too; a team move without a member ends with `routeConversation`.
  `GET /members` and `GET /teams` (`api/members.ts`, `conversations.read`) page the members routing
  would take (active, `INBOX_WORKER_ROLES`) and the teams, oldest first on exact keyset cursors.
- **Many conversations at once (ADR-120):** `POST /conversations/update-many`
  (`apiUpdateManyConversations`) takes 1 to 100 `conversationIds` and the same fields. In one
  transaction it locks the member first (as a suspension does before releasing its conversations),
  then every conversation `FOR UPDATE` in id order, refuses an id that is not one of the company's
  visible conversations (naming `conversationIds.<index>`), and applies `changeLockedConversation`,
  the function `PATCH` uses, to each in the order given, which locks the team as a conversation
  moves into it (after the conversations, as a team's deletion does); it answers the conversations
  in that order.
- **Conversations a filter finds (ADR-166):** `POST /conversations/update-matching`
  (`apiUpdateMatchingConversations`) reads one page through `conversationPage`, the list's own read
  (`apiListConversations` uses it, with `conversationFilterSql` for the filters), in a read
  committed transaction: it checks the member (`lockAssignableMember`, first) and the team
  (`isCompanyTeam`, a plain read) before the page, locks the page's rows `FOR UPDATE` in id order
  with the filter's conditions again, so rows someone else took out of the filter are skipped, drops
  erased contacts' conversations (`visibleConversations`, shared with `update-many`) and applies
  `changeLockedConversation` to each in the page's order; it answers them as they now are with the
  page's cursor.
- **Many contacts at once (ADR-122):** `POST /contacts/update-many` (`apiUpdateManyContacts`,
  `api/contacts.ts`) takes 1 to 100 contacts, each with its id and `PATCH`'s fields. It checks each
  change before the transaction (`prepareContactChange`: email, tags), then locks every field any
  change names in one statement (`lockFields`, as a field's deletion takes them) and checks the
  values against them (`checkFieldChanges`), locks the contacts `FOR UPDATE` in id order, refuses an
  id that is not one of the company's live contacts (naming `contacts.<index>.id`), and applies
  `changeLockedContact`, the function `PATCH` uses, to each in the order given; it answers the
  contacts in that order.
- **Numbers in many contacts' changes (ADR-188):** `apiUpdateManyContacts` refuses a number two
  contacts of the call give (compared as E.164, naming `contacts.<index>.phone`) before the
  transaction, and after locking the contacts checks every new number with `assertNumberFree`, given
  the place, before `changeLockedContact` writes anything: the numbers the call's own contacts have
  are still theirs then, so a call never swaps or moves numbers. `changeLockedContact` checks each
  number again as it writes it, as for `PATCH`.
- **Keyset cursors** (`encodeKeysetCursor`, `exactTimestamp`): a cursor carries the last row's
  timestamp as PostgreSQL keeps it, to the microsecond, and its id, and pages compare
  `(time, id) < (cursor time, cursor id)`; cursors made with milliseconds still read. Cursors built
  from JavaScript dates (milliseconds) skipped the rows that shared the page's last millisecond but
  came after it, and rows written in one transaction share their time: the contacts list and
  export, API contacts, the inbox thread's older messages and the audit log lost rows at page ends
  (regression tests show it). Campaigns and store orders use the same cursors now (ADR-072).
- **Idempotency** (`api/idempotency.ts`): `POST /messages` needs an `Idempotency-Key` (optional on
  `POST /contacts`). The key's row is inserted in the request's own transaction, so a concurrent
  retry waits on the unique index and then replays the stored response (`Idempotent-Replayed:
true`); the same key with another request (method, path and body hashed) answers 422
  `idempotency_key_reused`; a failed request stores nothing; an expired key is reused.
- **Monthly API requests by plan (0035, ADR-061):** `ops.plans.api_requests_monthly` is empty for no
  limit, 0 when the plan leaves the API out, or the requests a company may make per monthly usage
  period (§7). `admitApiRequest` (`api/quota.ts`) counts every request that passed authentication
  and the rate limits in `app.usage_counters` (metric `api_requests`) with one upsert that never
  counts beyond the limit, and counts without a limit too. A plan without the API answers 403
  `forbidden` with reason `not_in_plan` (creating and rotating keys are refused too); a month used
  up answers 429 `rate_limited` with reason `quota_exceeded` and `Retry-After` until the next
  period. The minute plan sweep emails the billing managers once per period
  (`ops.api_quota_reached`), and once before, at 80% of the limit or the share the company chose
  (ADR-062, ADR-144).
- **API scopes by plan (0069, ADR-092):** `ops.plans.api_scopes` is empty for every scope or the
  scopes the version includes; `app.tenant_entitlements` returns them. `admitApiRequest` takes the
  authenticated key (`ApiKeyContext`) and returns the request's `ApiContext` with `planScopes`, so
  a handler only runs with a context admitted under the plan. `hasScope`, `assertScope` and
  `assertAnyScope` (`api/context.ts`) check the key's scopes, then the plan's (403 `not_in_plan`),
  then the company's status for writing scopes. Creating a key checks its scopes against the plan
  (`assertScopesInPlan`); rotating keeps them. `authenticateApiToken`, used by the tests, loads the
  plan's scopes without counting a request.
- **Monthly requests per key (0073, ADR-097):** `consumeApiRequest` (`plans/entitlements.ts`) also
  counts each admitted request for its key in `app.api_key_usage` (one row per key and usage
  period), before the company's count and in the same transaction: one upsert below the key's
  `monthly_request_limit` when it has one (429 `rate_limited`, reason `key_quota_exceeded`, nothing
  counted for the company), then the company's; a company refusal rolls back to a savepoint taken
  before the key's count. The key's limit is read `FOR KEY SHARE`, so a request waits for a change
  of the limit in progress, which holds the key `FOR UPDATE`. Keys lock before companies, for
  every request. The keys service sets the
  limit at creation, changes it for an active key after a recent sign-in (`setMonthlyLimit`,
  audited `api_key.limit_changed`), copies it on rotation, and lists each key's count this period.
- **Emails about a key's limit (0075, ADR-098):** after the expiry reminders, the minute messaging
  sweep (`api/key-usage-notices.ts`) lists through `ops.api_key_usage_notices_due` the counters of
  usable keys with a limit at 80% of it (not warned) or at it (not told), then locks and checks each
  again in its company's scope (the current period only) and sets `warned_at` or `notified_at` in
  the transaction that queues a company notice to the active owners and administrators. A counter
  of an earlier period is marked without an email, so that it is not listed again. Changing a key's
  limit clears this period's marks.
- **OpenAPI** (`api/openapi.ts`): `GET /api/v1/openapi.json` (no key; cacheable 5 minutes) is built
  from the zod schemas that validate requests; a unit test checks it against the route handlers.
- **API reference (ADR-152) [built]:** the web tier builds the document once with the configured
  address alone and keeps it in memory (`publicApiDocs` in `server/api-docs.ts`, from `getWebConfig`;
  each server bundle that imports it, the page's and the route's, keeps its own copy), without
  starting the runtime, and serves it as built. The page `/developers` (no sign-in) shows the same
  document: `apiReference` (`api/reference.ts`, pure) turns it into groups of operations by the
  first segment of their paths, webhook events and schemas, with named types, notes for limits,
  allowed values and defaults, the fields inside fields and the shapes of unions, and descriptions
  as paragraphs and code spans; `components/developers/reference.tsx` renders them as text, with
  contents and links from each type to its schema. Settings → API keys and Settings → Webhooks link
  to it.
- **Expiry reminders (0040, ADR-067):** the minute messaging sweep (`api/expiry-reminders.ts`) lists,
  through the definer function `ops.api_key_expiry_reminders_due` (company and key ids only, over a
  partial index), keys that can still be used, were not rotated, expire within 7 days and were not
  reminded, of companies not being deleted. Each key is locked and checked again in its company's
  scope, then `expiry_reminded_at` is set (kept by the key's guard) in the transaction that queues a
  company notice to its active owners and administrators: the key's name and prefix, its expiry in
  the company's time zone, its author, its last use and how to rotate it. A failure rolls back and
  is retried by the next sweep without holding up other keys.
- **Web:** Settings → API keys (`developer.manage`): the month's API requests and the plan's limit
  (or that the plan leaves the API out), the base URL and an example, the keys with state, prefix,
  scopes, author, last use and expiry, a mark on keys that expire within 7 days and when their
  reminder was emailed, each key's requests this period and its own monthly limit (marked when
  reached, changed in a dialog); creation with the scopes the member may grant, allowed addresses
  and a monthly limit; the new token shown once with a copy button (kept only in the page's
  memory); rotation with an overlap; revocation.
- **Not built yet:** media and call-to-action messages, taking reactions back, assigning many
  conversations or starting many runs in one call, bulk sends, media downloads, statuses changed
  since a time, defining contact fields, changing numbers or many contacts in one call, limits and
  availability per endpoint and OAuth apps (BACKLOG P5-08). Packs of extra API requests are plan add-ons (ADR-110, section 7). Outgoing
  webhooks are section 6O.

## 6O. Outgoing webhooks **[built — verified with local test receivers only; no customer endpoints yet]**

- **Model** (migration 0025, ADR-053): `app.webhook_endpoints` (URL, description, event types, the
  signing secret encrypted by the keyring with its version, the previous secret and when it stops
  signing, on/off with the reason, health: failing since, last success, last failure);
  `app.webhook_events` (what happened: type, message, conversation, contact or template id, the
  status reached and small non-personal facts; no foreign keys, so erasure and retention never wait
  on webhook history); `app.webhook_deliveries` (one per event and endpoint: state `pending`,
  `delivering` with a lease, `succeeded` or `failed`, attempts, next attempt, last status code, error
  code and duration, the delivery it replays). Composite foreign keys cascade from the endpoint and
  the event. The runtime role has column grants only for what the services change; it cannot move a
  delivery to another event or endpoint, edit events, or delete history except with its endpoint.
- **Capture:** SECURITY INVOKER triggers on `app.messages` (an inbound message from a contact; an
  outbound message reaching `accepted`, `sent`, `delivered`, `read`, `played`, `failed`, `canceled`
  or `unknown_outcome`, with the error code and title), `app.consent_events` (every opt-in and
  opt-out) and `app.template_status_events` (the statuses Meta reports, and deletion) call
  `app.capture_webhook_event`, which writes an event and its deliveries only when an active endpoint
  of the row's company subscribes to the type (for `message.status`, since 0095, only when one also
  takes the status, ADR-119). They run as the role making the change (the runtime
  role in the company's scope, or a definer function such as `app.erase_contact`), so row security
  keeps each event in its row's company, and a rolled-back change leaves none. A delivery insert
  sends an empty `w360_webhooks` notification.
- **Conversation and contact events** (migrations 0047–0049, ADR-074): triggers on
  `app.conversations` (`conversation.status_changed` with the status before;
  `conversation.assignment_changed` for every change of the member and, since 0070 (ADR-094),
  `conversation.team_changed` for every change of the team, each with the ids before and after and
  stamped with the time it is captured), `app.contacts` (`contact.created`; `contact.updated` for
  the name, number or email, and since 0090 (ADR-112) for a value of one of the company's custom
  fields, compared by key so that a field's deletion captures nothing; `contact.erased`) and
  `app.contact_tags` (`contact.updated`). Contact events go through
  `app.capture_contact_webhook_event`: `contact.created` and `contact.updated` are captured when an
  active endpoint takes either, once per contact and top-level transaction (`captured_xact`, found
  by a partial index built concurrently), and `contact.erased` first deletes what its own
  transaction captured for the contact, so an erasure (which removes the tags first) sends only
  that. Since 0096 (ADR-121) each trigger also says what changed (`name`, `phone`, `email`, `tags`,
  `fields.<key>`), kept in `contact_changes` on the `contact.updated` event; a later change in the
  same transaction adds to it through `app.add_contact_webhook_changes`, a definer function that
  updates only an event its caller's transaction captured. Since 0098 (ADR-123) a `contact.updated`
  delivery is created only for an endpoint whose `contact_parts` is null or holds a part the change
  names (`fields` for any `fields.<key>`), and a later change in the transaction queues the
  endpoints it newly concerns. Since 0129 (ADR-182) the event also keeps `tags_added` and
  `tags_removed`, noted by the tag trigger through `app.note_contact_webhook_tag`, a definer
  function that changes only its caller's transaction's event and nets a tag added and removed
  again, and `contact.erased` clears both from the contact's other events. Their payloads are built
  when delivered: conversation events as the message events are, contact events with the API's
  contact (`api/contact-view.ts`, shared with the public API) and `erased`, an erased contact
  keeping its id, source and creation time only, and `contact.updated` with `changes` (null for
  events captured before 0096) and `tagsAdded` and `tagsRemoved` (null before 0129 and for an erased
  contact).
- **Automation run events** (migrations 0055–0056, ADR-078): triggers on `app.automation_runs`
  capture `automation.run_started` when a live run is inserted and `automation.run_ended` when one
  moves from running or waiting to an ended status, through `app.capture_webhook_event` (the run and
  automation ids, and the end reason, in `detail`). Test runs send nothing. Their payloads are built
  when delivered: the run (what started it, the API key for `api` runs, the automation's name now,
  the status and end as captured), the conversation id, the contact and the number; never the run's
  answers or inputs.
- **Order events** (migrations 0063–0064, ADR-085): triggers on `app.commerce_orders` capture
  `order.received` when a WhatsApp order is recorded and `order.status_changed` when an update
  changes its status (a member, or the payment worker applying a Payment Link's outcome), through
  `app.capture_webhook_event` (the order id, and the status before a change, in `detail`). Erasure
  clears the note without touching the status, so it captures nothing. Their payloads are built
  when delivered: the order with its items in cart order and amounts in minor units (the statuses
  as captured, the note null once erased), the conversation id, the contact and the number; never
  Payment Link or Razorpay payment details. Store orders send nothing.
- **Campaign events** (migrations 0065–0066, ADR-087): a trigger on `app.campaigns` captures
  `campaign.status_changed` when an update changes a campaign's status (a member submitting,
  withdrawing, rejecting, approving, pausing, resuming or cancelling it, or the runner starting,
  pausing or completing it), through `app.capture_webhook_event` (the campaign id, the status before
  it and a pause or completion reason, in `detail`), stamped with `clock_timestamp()` so that a
  start and a pause made in one runner transaction keep their order. Their payloads are built when
  delivered: the campaign's name, template, times and counters now, the statuses and reason as
  captured, and the number; never a recipient or a member. Since ADR-150 they also carry `results`,
  as `GET /campaigns/{id}` counts them, counted in the delivery's claim by `campaignAnalytics`
  (`campaigns/results.ts`), which counts in one statement so its numbers agree at any isolation;
  null while the campaign is a draft.
- **Dispatch:** the worker's LISTEN connection (`apps/worker/src/webhook-listener.ts`) turns a
  notification into a lookup of active companies with due deliveries (`ops.webhook_dispatch_due`,
  SECURITY DEFINER), at most one lookup every 250 ms; the per-minute messaging sweep does the same
  for retries, interrupted attempts and missed notifications, and applies retention. Each company
  gets a signed `webhook.deliver` job (policy `stately`: one queued and one active per company,
  singleton key = company id). Suspended and restricted companies are skipped (the job defers).
- **Delivery** (`webhooks/delivery.ts`): the job claims up to 10 due deliveries (`FOR UPDATE SKIP
LOCKED`; pending ones due now, then `delivering` ones whose lease expired), builds each payload
  from the company's current data (`webhooks/payloads.ts`; an erased contact has no number or name,
  a message, conversation, contact, run or order that is gone ends the delivery as `event_gone`),
  signs it, sets the lease (the 10 s egress deadline plus 35 s) and commits. A delivery whose payload
  or signature cannot be built (a bug, data the builder cannot describe, a secret or the endpoint's
  own headers the keyring cannot open, or a database error while building, each build running in a
  savepoint) ends at once as
  `payload_failed` without an attempt, and the rest of the batch goes on; the worker logs its
  company, delivery, endpoint, event type, what failed and the error's class and code, never the
  payload or the error's message. The POSTs go through the egress client (DNS pinned, private,
  loopback, link-local, metadata and reserved addresses refused, no redirects, 64 KB sent, responses
  read up to 256 KB and discarded) with no transaction open.
  Each outcome is recorded in its own transaction, locking the endpoint before the delivery; an
  outcome whose attempt no longer owns the delivery (lease expired and re-claimed, or the endpoint
  deleted) is dropped. A 2xx answer succeeds; anything else is retried at 1 min, 5 min, 30 min, 2 h,
  6 h, 12 h and 24 h, and the eighth failure fails the delivery; an interrupted delivery with no
  attempt left fails as `interrupted`. After 200 deliveries, attempted or ended at their claim, a
  job queues its successor.
- **Signing:** `W360-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, one `v1` per
  secret (the previous secret also signs for 24 hours after a rotation), with `W360-Event-Id`,
  `W360-Event-Type`, `W360-Delivery-Id`, `W360-Delivery-Attempt` and `User-Agent:
HyFib-W360-Webhooks/1`. Secrets are `whsec_` + 32 random bytes, encrypted with the AAD
  `webhook-secret:<company>:<endpoint>:<version>`.
- **Endpoint headers** (migration 0094, ADR-118): up to 5 headers an endpoint's receiver asks for,
  their names in `header_names` and names and values sealed together in `headers_ciphertext` (AAD
  `webhook-headers:<company>:<endpoint>`; a check keeps both empty or both set). Settings, the API,
  audit entries and the export carry names only. The claim opens them once per endpoint and batch
  and sends them before HyFib's own headers, which names HyFib or the transport sets can never
  replace (refused when saved and when opened); headers that do not open end the delivery as
  `payload_failed`, stage `headers`.
- **Message status filters** (migration 0095, ADR-119): `message_statuses` on an endpoint lists the
  `message.status` statuses it takes, null for every status; a check keeps it to 1 to 8 known
  statuses and to endpoints that take `message.status`. `app.capture_webhook_event` (replaced with
  the same signature) creates a `message.status` delivery only for endpoints whose list is null or
  holds the status, and writes no event when none does; other types, replays and test events are
  unchanged. Settings and the API (`messageStatuses`) set it; a change that drops the event clears
  it.
- **Contact part filters** (migration 0098, ADR-123): `contact_parts` on an endpoint lists the parts
  of a contact whose change it takes as `contact.updated` (`name`, `phone`, `email`, `tags`,
  `fields`), null for every change; a check keeps it to 1 to 5 known parts and to endpoints that
  take `contact.updated`. `app.capture_contact_webhook_event` (replaced with the same signature)
  queues the first capture of a contact's update for endpoints whose list is null or holds a part
  it names, and each later change of the contact in the transaction for those it newly concerns
  that have no delivery of the event yet; the event is still written when an endpoint takes
  `contact.created` or `contact.updated`, and each endpoint receives the same event, naming every
  part that changed. Settings and the API (`contactParts`) set it; a change that drops the event
  clears it.
- **Automation filters** (migration 0109, ADR-145): `automation_ids` on an endpoint lists the
  automations whose runs it takes as `automation.run_started` and `automation.run_ended`, null for
  every automation; a check keeps it to 1 to 20 ids without nulls and to endpoints that take one of
  the two events. The services accept only automations of the company with a published version
  (which cannot be deleted, only archived). `app.capture_webhook_event` (replaced with the same
  signature) creates a run event's delivery only for endpoints whose list is null or holds the
  run's automation (`automationId` in the event's detail), and writes no event when none does;
  other types, replays and test events are unchanged. Settings and the API (`automationIds`) set
  it, Settings from `automationChoices` (the company's published automations by name); a change
  that drops both events clears it.
- **Campaign status filters** (migration 0110, ADR-146): `campaign_statuses` on an endpoint lists
  the statuses a campaign reaches that it takes as `campaign.status_changed`, null for every
  status; a check keeps it to 1 to 7 known statuses and to endpoints that take the event.
  `app.capture_webhook_event` (replaced with the same signature) creates a campaign event's
  delivery only for endpoints whose list is null or holds the status reached, and writes no event
  when none does; other types, replays and test events are unchanged. Settings and the API
  (`campaignStatuses`) set it; a change that drops the event clears it.
- **Order status filters** (migration 0111, ADR-147): `order_statuses` on an endpoint lists the
  statuses an order reaches that it takes as `order.status_changed` (`confirmed`,
  `awaiting_payment`, `paid`, `fulfilled`, `cancelled`; `received` only arrives as
  `order.received`), null for every status; a check keeps it to 1 to 5 known statuses and to
  endpoints that take the event. `app.capture_webhook_event` (replaced with the same signature)
  creates an order change's delivery only for endpoints whose list is null or holds the status
  reached, and writes no event when none does; other types, replays and test events are unchanged.
  Settings (the same status control as campaigns) and the API (`orderStatuses`) set it; a change
  that drops the event clears it.
- **Template status filters** (migration 0112, ADR-148): `template_statuses` on an endpoint lists
  the statuses it takes as `template.status_changed` (the eleven the event reports, `pending` to
  `locked`; HyFib's own steps, a deletion under way or refused and an unrecognised status are never
  sent), null for every status; a check keeps it to 1 to 11 known statuses and to endpoints that
  take the event. `app.capture_webhook_event` (replaced with the same signature) creates a template
  status's delivery only for endpoints whose list is null or holds the status reported, and writes
  no event when none does; other types, replays and test events are unchanged. Settings (the same
  status control as campaigns and orders) and the API (`templateStatuses`) set it; a change that
  drops the event clears it.
- **Conversation status filters** (migration 0113, ADR-149): `conversation_statuses` on an endpoint
  lists the statuses a conversation reaches that it takes as `conversation.status_changed` (`open`,
  `resolved`; nothing sets one `pending`), null for every status; a check keeps it to 1 or 2 known
  statuses and to endpoints that take the event. `app.capture_webhook_event` (replaced with the
  same signature) creates a conversation change's delivery only for endpoints whose list is null or
  holds the status reached, and writes no event when none does; other types, replays and test
  events are unchanged. Settings (the same status control) and the API (`conversationStatuses`) set
  it; a change that drops the event clears it.
- **Run end filters** (migration 0114, ADR-151): `run_end_statuses` on an endpoint lists the
  statuses a run ends with that it takes as `automation.run_ended` (`completed`, `handed_off`,
  `taken_over`, `stopped`, `failed`; a run still going ends nothing), null for every end; a check
  keeps it to 1 to 5 known ends and to endpoints that take the event. `app.capture_webhook_event`
  (replaced with the same signature) creates a run end's delivery only for endpoints whose
  automations (ADR-145) include the run's and whose list is null or holds the status the run ended
  with, and writes no event when none does; run starts, other types, replays and test events are
  unchanged. Settings (the same status control) and the API (`runEndStatuses`) set it; a change that
  drops the event clears it.
- **Number filters** (migration 0118, ADR-170): `channel_account_ids` on an endpoint lists the
  WhatsApp numbers whose events it takes: the message, conversation, automation run, order and
  campaign events (`WEBHOOK_CHANNEL_EVENTS`; consent, contact and template events happen on no
  number and are not narrowed), null for every number; a check keeps it to 1 to 100 ids without
  nulls and to endpoints that take such an event. The trigger functions of those events pass the
  changed row's number as `channelId` in the detail; `app.capture_webhook_event` (replaced with the
  same signature) takes it out before storing the event, creates such an event's delivery only for
  endpoints whose list is null or holds the number, and writes no event when none does; replays and
  test events are unchanged. Settings (a choice between every number and the numbers ticked, from
  `channelChoices`) and the API (`channelIds`) set it, the services checking that each id is a
  number of the company (`assertWebhookChannels`); a change that drops every such event clears it.
- **Message sender filters** (migration 0120, ADR-172): `message_senders` on an endpoint lists who
  sent the messages whose `message.status` it takes (`agent`, `bot`, `campaign`, `api`, `system`, as
  the payload's `message.sentBy`), null for every sender; a check keeps it to 1 to 5 known senders
  and to endpoints that take the event. The message trigger passes the sender as `sentBy` in the
  detail, mapped as the payload maps it; `app.capture_webhook_event` (replaced with the same
  signature) takes it out with the number before storing the event, creates a status's delivery only
  for endpoints whose list is null or holds the sender, and writes no event when none does. Settings
  (checkboxes under "Message status") and the API (`messageSenders`) set it; a change that drops the
  event clears it.
- **OAuth clients** (migration 0121, ADR-173): an endpoint may name its receiver's token URL, a
  client ID, a secret (sealed, `webhook-oauth-secret:<company>:<endpoint>`) and a scope; a check
  keeps them set together or not at all. Settings ("OAuth 2.0") and the API (`oauth`) set it; the
  token URL is checked like the endpoint's URL, and a new token URL needs the secret again. After a
  batch's claim commits, `sendDelivery` gets a token from the worker's `WebhookOAuthTokenCache` (in
  memory, keyed by the company, the endpoint and a hash of the client; deliveries needing one at
  once share the request) or asks the token URL through the egress client (`fetchWebhookOAuthToken`:
  the client credentials grant with HTTP Basic, RFC 6749 section 4.4), sends it as a bearer token,
  and drops it when the endpoint answers 401. A delivery that gets no token fails its attempt with
  an `oauth_token_…` code and no status. The lease of such a delivery covers both requests.
- **Team filters** (migration 0122, ADR-174): `team_ids` on an endpoint lists the teams whose
  conversations' message and conversation events it takes, null for every conversation's; a check
  keeps it to 1 to 50 ids and to endpoints that take such an event. `app.capture_webhook_event`
  (replaced with the same signature) reads the conversation's team when an active endpoint of the
  company that takes the event names teams, and creates a delivery only for endpoints whose list is
  null or holds that team or, for `conversation.team_changed`, the team the conversation left; it
  writes no event when none does. Settings (radio buttons and checkboxes under "Teams") and the API
  (`teamIds`) set it; the services check the teams a list adds; a change that drops the events
  clears it.
- **Template filters** (migration 0123, ADR-175): `template_ids` on an endpoint lists the templates
  whose messages' statuses and changes it takes, null for every template's; a check keeps it to 1 to
  50 ids and to endpoints that take `message.status` or `template.status_changed`.
  `app.capture_webhook_event` (replaced with the same signature) creates a delivery of those events
  only for endpoints whose list is null or holds the event's template (the message's, which the
  message trigger passes and which is null for a message sent without one, or the template that
  changed), and writes no event when none does. Settings (radio buttons and checkboxes under
  "Templates") and the API (`templateIds`) set it; the services check the templates a list gives; a
  change that drops both events clears it.
- **Assignee filters** (migration 0128, ADR-181): `assignee_ids` on an endpoint lists the members
  (membership ids) whose assigned conversations' message and conversation events it takes, null for
  every conversation's; a check keeps it to 1 to 50 ids and to endpoints that take such an event.
  `app.capture_webhook_event` (replaced with the same signature) reads the conversation's member
  with its team when an active endpoint of the company that takes the event names teams or members,
  and creates a delivery only for endpoints whose list is null or holds that member or, for
  `conversation.assignment_changed`, the member the conversation left; it writes no event when none
  does. Settings (radio buttons and checkboxes under "Members") and the API (`assigneeIds`) set it;
  the services check that the members a list adds take conversations; a change that drops the events
  clears it.
- **Run trigger filters** (migration 0131, ADR-183): `run_triggers` on an endpoint lists what
  started the runs whose `automation.run_started` and `automation.run_ended` it takes, null for
  every run; a check keeps it to 1 to 5 known triggers and to endpoints that take a run event. The
  run trigger passes `runTrigger` in the detail, and `app.capture_webhook_event` (replaced with the
  same signature) creates a delivery of a run event only for endpoints whose list is null or holds
  it, taking it out of the detail before the event is stored. Settings (checkboxes under "Runs
  started by") and the API (`runTriggers`) set it; a change that drops both events clears it.
- **Custom field filters** (migration 0132, ADR-184): `contact_field_keys` on an endpoint lists the
  custom fields whose changes it takes as `contact.updated`, null for every field's; a check keeps
  it to 1 to 50 well-formed keys and to endpoints taking `contact.updated` for every part or for
  `fields`. `app.capture_contact_webhook_event` (replaced with the same signature) creates a
  delivery only when one of the parts a change names passes the endpoint's parts and, for
  `fields.<key>`, its fields. Settings (radio buttons and checkboxes under "Custom fields") and the
  API (`contactFieldKeys`) set it; the services check the keys a list adds; a change that drops the
  event or `fields` clears it.
- **Campaign filters** (migration 0133, ADR-185): `campaign_ids` on an endpoint lists the campaigns
  whose messages' statuses (`message.status`) and changes (`campaign.status_changed`) it takes, null
  for every campaign's; a check keeps it to 1 to 50 ids and to endpoints taking one of those events.
  The message trigger passes the message's `campaign_id` as `campaignId` in the detail, and
  `app.capture_webhook_event` (replaced with the same signature) matches it, or a campaign event's
  stored `campaignId`, against the list, then takes the message's out before storing the event.
  `message.status` payloads name the campaign (`message.campaignId`), read from the message when
  prepared. Settings (radio buttons and checkboxes under "Campaigns", the 200 newest campaigns) and
  the API (`campaignIds`) set it; the services check the campaigns of a list given; a change that
  drops both events clears it.
- **Consent change filters** (migration 0135, ADR-189): `consent_changes` on an endpoint lists the
  `consent.changed` changes it takes, each its purpose and action together (`marketing_opt_out`),
  null for every change; a check keeps it to 1 to 4 known changes and to endpoints taking the event.
  `app.capture_webhook_event` (replaced with the same signature) matches the purpose and action the
  consent trigger stores in the detail against the list. Settings (checkboxes under "Consent
  changed") and the API (`consentChanges`) set it; a change that drops the event clears it.
- **Contact source filters** (migration 0136, ADR-190): `contact_sources` on an endpoint lists where
  the contacts whose `contact.created` it takes came from (`contact.source`), null for every
  contact; a check keeps it to 1 to 5 known sources and to endpoints taking the event.
  `app.capture_contact_webhook_event` (replaced with the same signature) reads the contact's source
  when an active endpoint of the company names sources and creates a `contact.created` delivery only
  where it is listed. Settings (checkboxes under "Contact added") and the API (`contactSources`) set
  it; a change that drops the event clears it.
- **Message type filters** (migration 0137, ADR-191): `message_types` on an endpoint lists the types
  of the received messages it takes as `message.received`, null for every type; a check keeps it to
  1 to 14 known types (never `template`) and to endpoints taking the event.
  `app.capture_webhook_event` (replaced with the same signature) matches the `messageType` the
  message trigger stores in the detail against the list, with the endpoint's other filters. Settings
  (checkboxes under "Message received") and the API (`messageTypes`) set it; a change that drops the
  event clears it.
- **Run end reason filters** (migration 0138, ADR-192): `run_end_reasons` on an endpoint lists the
  reasons a run ended for that it takes as `automation.run_ended`, null for every reason; a check
  keeps it to 1 to 21 known reasons, to endpoints taking the event and to reasons of the ends they
  take. `app.capture_webhook_event` (replaced with the same signature) matches the `endReason` the
  run trigger stores in the detail against the list for the ends it names reasons of (each status
  paired with its reasons in the function); the runs of other ends pass on the end filter alone.
  Settings (reasons by status under "Automation ended") and the API (`runEndReasons`) set it; a
  change of the ends keeps the reasons of the ends kept, and one that drops the event clears it.
- **Health:** a success clears the failing state; a failure when the endpoint has been failing for
  72 hours without a success turns it off (`failing`), fails its waiting deliveries as
  `endpoint_disabled`, records a system audit entry and emails the company's active owners and
  administrators (`webhook.endpoint_disabled`) in the same transaction.
- **Web:** Settings → Webhooks (`developer.manage`): endpoints with state, events, last-24-hour
  counts, last success, failing since and secret version; adding one (the secret shown once, kept
  only in the page's memory); sending a test event (`ping`); rotating the secret; turning off and
  on; deleting. Each endpoint's page lists its latest 100 deliveries (or only failed ones) with
  attempts, result and timings, replays finished ones (a new delivery of the same event, audited)
  and edits the URL, description, events, the message statuses, contact parts, automations,
  campaign, order, template and conversation statuses, the run ends and the numbers it takes,
  headers (names shown, values never; replacing gives each again) and its OAuth client (the secret
  never shown).
  The OpenAPI document describes every event under `webhooks`. Audit entries name the endpoint's
  host, never its full URL or secret.
- **Not built yet:** filters on a message's
  or contact's values, ordering,
  other authentication (headers computed per delivery, other OAuth grants), mutual TLS, fixed
  egress addresses for receivers' allowlists, endpoints per number, and events for conversations
  started, notes or merges.

## 6P. Platform operations console **[built — verified with local test data only; no production companies yet]**

- **Purpose** (P5-10, ADR-054): platform staff see where companies are stuck or failing, what the
  job system is doing and whose sending needs a review, from counts, states, error codes, labels
  and times. No message text, contact, payload, email address, secret or full URL is read into the
  console.
- **Reads:** four SECURITY DEFINER functions (migration 0026), owned by `w360_definer`, executable
  only by `w360_platform`, refusing to run unless the session user is a platform administrator
  (`W3403`): `ops.platform_ops_health` (per company: numbers by state, worst quality rating of its
  active numbers, accounts needing reconnection, last-24-hour outbound, failed and inbound counts,
  failing webhook endpoints, failed stores, payment account checks, catalog and Flow syncs, dead
  letters in 7 days), `ops.platform_ops_activity` (per company since a time at most 93 days back:
  outbound by sender, failures, inbound, marketing templates sent and delivered, errors `131049` and
  `131050`, marketing opt-outs by contacts, complaint suppressions, webhook deliveries, automation
  runs, members and numbers), `ops.platform_ops_signup_sessions` (Embedded Signup sessions that
  failed or expired unfinished) and `ops.platform_ops_integration_failures` (current failures with a
  label: a display number, an account name or only the host of a URL, via `ops.url_host`). The
  definer role has column grants for exactly the columns these read. Failed, stuck and quarantined
  Meta and Razorpay receipts, numbers, companies, failed emails (counts by kind) and security
  events (counts by type) are read directly by the platform role, which could already read them.
- **Queues:** `pgBossQueueInspector` (`jobs/queue.ts`) reads pg-boss's `getQueues()` through the
  web's producer instance: ready, deferred, active and retained failed jobs per queue, as cached by
  the worker's supervisor about once a minute. Each declared queue is listed with its retry policy.
- **Dead letters:** the worker consumes `dead-letter` (batches of 20, one at a time, with pg-boss
  metadata) and writes `ops.dead_letters` (`jobs/dead-letters.ts`): source queue and job, the
  envelope's kind, company and reference only when its signature verifies, retries used, the
  error's name and code (never its message, stack or details, which can quote data) and times. The
  worker role may only insert (a repeated recording is ignored); the messaging sweep deletes rows
  30 days after the job failed through `ops.purge_dead_letters`. Recording is retried three times
  with backoff; the job itself stays in pg-boss for its own retention.
- **Health and signals** (`platform/ops-model.ts`) are pure functions over those facts with HyFib's
  own thresholds (ADR-054): a company is `critical`, `warning` or `ok`, and a signal asks for a
  review; nothing is suspended automatically.
- **Repairs:** retrying a Meta or Razorpay receipt that used all its attempts (it failed the 12th, or
  its worker stopped during it: `ops.webhook_receipt_exhausted`, migration 0068) or was
  quarantined, while its body is still kept (`ops.platform_retry_webhook_receipt`: back to pending
  with no attempts; the minute sweep processes it again, idempotently), and resolving a quarantine
  entry with a written resolution. Both need a reason and write `ops.platform_audit_events` in the
  same transaction.
- **Dead letter retries** (ADR-108, migration 0086, `platform/dead-letter-retries.ts`): a platform
  administrator sends a dead letter's failed job back to its queue once, with a reason, through
  `ops.platform_retry_dead_letter`, which makes pg-boss's own retry (state back to `retry`, one
  more attempt allowed, no completion time), marks the dead letter (`retried_at`,
  `retried_by_user_id`) and writes the platform audit log in one transaction. It refuses a dead
  letter already retried, unverified or without its job, of a company being deleted or gone, a job
  pg-boss no longer keeps as failed, a job of a queue that never retries (`billing.auto-recharge`)
  or of a receipt queue (the receipt retry repairs those), and a job whose work already waits in
  its exclusive queue. The migration runner grants the definer role SELECT on `pgboss.job`'s id,
  name, state and retry limit and UPDATE on its state, retry limit and completion time, after
  pg-boss's install. `deadLetterRetryBlock` is the console's copy of those rules, by this release's
  queue catalog, with the time the queue's retention ends. Retries matter for `template.submit`,
  whose work no sweep signals again, and for the three queues below until their work is settled.
- **Stranded work** (ADR-111, migration 0089, `jobs/stranded-work.ts`): `channel.onboard`,
  `commerce.account` and `template.delete` leave their work in progress when their job
  dead-letters. The minute messaging sweep lists, through `ops.dead_letters_to_settle` (SECURITY
  DEFINER, the worker role only), the verified dead letters of those queues whose envelope names
  its own queue, neither retried nor settled, of companies not being deleted, whose work no job is
  doing again (`ops.dead_letter_work_live`: a waiting or running job under the work's singleton
  key; the definer reads `pgboss.job.singleton_key` for it). For each, in the company's scope
  (`authorizedTenantScope`, the company coming from the dead letter as the worker recorded it from
  the verified envelope) and one transaction, it ends the work and marks the dead letter through
  `ops.settle_dead_letter`, which checks the scope, the queue and the kind, and returns false when
  the dead letter was retried or settled meanwhile or a job for its work waits or runs again; the
  sweep then rolls back, so work a job is doing is never ended under it. The work: a template
  still pending deletion goes back to Meta's last status (a `delete_failed` event and one for that
  status, audit, sync request; one Meta itself reports as being deleted is left to the sync; the
  template's history lists same-time events newest first by id), keys still being checked
  fail, and a number still in setup fails with the step it stopped at (audit, live update). A
  settled dead letter keeps `settled_at` and `settled_ended` (whether anything was left to end) and
  is never retried from the console (a check keeps the two marks apart). The template sync keeps
  `pending_deletion` while the template's last deletion event is the request itself, made in the
  last 8 hours; `template.delete` and `commerce.account` retry longer than before (10 and 8 times,
  at most an hour and 30 minutes apart).
- **Failure alerts** (ADR-091, migration 0068, `platform/failure-alerts.ts`): the minute messaging
  sweep emails every platform administrator about each dead letter, each receipt that used all its
  attempts and each unresolved quarantine entry, once (`alerted_at` marks set by
  `ops.mark_failure_alert` in the transaction that queues the emails) and at most every 15 minutes
  (`ops.platform_alerts`), with counts by queue, provider and reason only. A retry clears the
  receipt's mark. The console shows when staff were emailed about each item and when the last alert
  went out.
- **Queue waits** (ADR-096, migration 0072, `platform/queue-waits.ts`): after the failure alert, the
  minute messaging sweep reads, for each queue the catalog declares, the jobs pg-boss would hand to a
  worker (`state < 'active'`, due, not held by a dependency: pg-boss's partial claim index serves it)
  and the oldest one's due time, and records them with the queue's `maxWaitMinutes` through
  `ops.record_queue_waits` into `ops.queue_waits` (late at the limit, until under half of it).
  `alertLateQueues` then marks late queues not yet told through `ops.mark_queue_alert` (at most every
  15 minutes, `ops.platform_alerts` kind `queues`; fresh checks only) in the transaction that queues
  one `platform.notice` email to every platform administrator. The Queues tab and the overview read
  `ops.queue_waits` as the platform role.
- **Integration failure alerts** (ADR-139, migration 0106, `platform/integration-alerts.ts`): last
  in the minute messaging sweep, `ops.integration_alerts_due` keeps the marks of failures the
  console still lists (`ops.integration_failures`, the console's own rule), forgets those not listed
  for an hour and counts the failures not yet told; `ops.mark_integration_alert` marks them (at most
  every 15 minutes, `ops.platform_alerts` kind `integrations`, 1,000 at a time) in the transaction
  that queues one `platform.notice` email to every platform administrator, with counts by kind only.
- **Acknowledging failures** (ADR-141, migration 0107): a platform administrator acknowledges a
  failure on Current failures with a note, through `ops.platform_acknowledge_integration_failure`
  (definer, platform role only), which checks the administrator and that `ops.integration_failures`
  lists the failure in that state now, upserts `ops.integration_acknowledgements` (by source,
  subject and state) and writes the platform audit entry in one transaction; the console's list
  returns each failure's acknowledgement. `ops.integration_alerts_due` keeps acknowledgements of
  listed failures and forgets the others after an hour, as it does the alert marks.
- **Acknowledging dead letters** (ADR-169, migration 0117): `acknowledged_at`,
  `acknowledged_by_user_id` and `acknowledgement` on `ops.dead_letters`, set together (the check
  `dead_letters_acknowledged`) and written only by `ops.platform_acknowledge_dead_letter` (definer,
  platform role only) with the platform audit entry in one transaction. The Queues tab's read
  (`recentDeadLetters`) joins the administrator's name through `acknowledgers`, an alias of
  `auth.users` beside the one for who retried; the CSV writes the time only.
- **Acknowledging late queues** (ADR-177, migration 0125): `acknowledged_at`,
  `acknowledged_by_user_id` and `acknowledgement` on `ops.queue_waits`, set together and only while
  the queue is late (the check `queue_waits_acknowledged`), written by
  `ops.platform_acknowledge_late_queue` (definer, platform role only, the lateness named by its
  start) with the platform audit entry in one transaction, and cleared by `ops.record_queue_waits`
  when the check finds the queue back on time, as it clears the alert's mark. The Queues tab's read
  (`queueWaitsByName`) joins the administrator's name through `acknowledgers`; the worker's grant
  covers the check's columns only; the CSV writes the time only.
- **Acknowledging webhook receipts** (ADR-179, migration 0127): `ops.receipt_acknowledgements`, one
  note per receipt (who, when, the note), deleted with the receipt through a cascading foreign key,
  written only by `ops.platform_acknowledge_webhook_receipt` (definer, platform role only) with the
  platform audit entry in one transaction and read by the platform role. The Integrations tab's read
  (`receiptsNeedingAttention`) joins it and the administrator's name through `acknowledgers`; the
  CSV writes the time only.
- **Acknowledging quarantine entries** (ADR-199, migration 0139): `ops.quarantine_acknowledgements`,
  one note per entry (who, when, the note), deleted with the entry through a cascading foreign key,
  written only by `ops.platform_acknowledge_quarantine_entry` (definer, platform role only, open
  entries only) with the platform audit entry in one transaction and read by the platform role. The
  Integrations tab's read (`openQuarantine`) joins it and the administrator's name through
  `acknowledgers`; the CSV writes the time only.
- **Exports beyond a tab's rows (ADR-200):** each list read in `platform/ops.ts` takes a limit, the
  tab's by default; `exportFile` passes the larger one from `OPS_LIST_ROWS`, and the reads order
  ties by id so the file starts with the tab's rows.
- **Web:** `/platform/ops` (Overview, Onboarding, Integrations, Queues, Signals, Usage over 7, 30 or
  90 days) and a health card on each company's platform page. Every page re-checks the platform
  actor. The functions read every company on each view, which suits the test envelope; paging and
  precomputed rollups come with growth.
- **API requests on the Usage tab (ADR-153):** `usage()` also reads each company's latest
  `api_requests` row of `app.usage_counters` through the platform role (0023's policy), in the same
  transaction, and joins it to the companies the activity function returns; the tab shows it, with
  the period's start, beside automation runs.
- **The window before (ADR-157):** for the 7- and 30-day windows, `usageRows` reads the activity
  since the window's start and since twice as far back in one statement (two calls of the STABLE
  definer function, so one snapshot) and gives each company the difference, the window before's
  sending and receipts; 90 days has none (the function reads at most 93 days back).
- **Exports (ADR-154, ADR-155, ADR-158):** `/platform/ops/export/[list]` (a route handler behind the
  pages' platform actor check; a name of `OPS_EXPORT_LISTS`, any other not found) calls
  `exportList`, which checks in its transaction that the actor is a platform administrator, reads
  the list's rows with the tab's own read (`usageRows`, `healthFacts` sorted by `byHealth`,
  `signalRows`; for the Onboarding, Integrations and Queues tabs one read per list, such as
  `signupProblems`, `integrationFailures`, `openQuarantine`, `queueRows` or `recentDeadLetters`,
  which the tabs share), inserts `platform.ops_<list>_exported` (`opsExportAction`) into
  `ops.platform_audit_events` in that transaction and returns the list's CSV (`usageCsv` to
  `deadLettersCsv` in `platform/ops-model.ts`, formula-safe through `contacts/csv`); each tab links
  to it as "Download CSV", named after its list where a tab has several (`ListTitle`).
- **Not built yet:** other alert channels, trends,
  quality updates from Meta's quality webhook, sweeps for the work of
  `channel.onboard`, `commerce.account` and `template.delete`, retrying several dead letters at
  once, and acknowledging the console's other lists (dead letters, receipts, late queues).

## 6Q. Company export and deletion **[built — providers verified against the local Graph, Shopify and Razorpay stand-ins only]**

- **Purpose** (P5-11, ADR-055): owners take a full copy of the company's data at any time and can
  have the company deleted, after 14 days of grace, by a job that survives restarts.
- **Export** (`tenancy/export.ts`, `tenancy/export-spec.ts`): the route
  `/c/<slug>/settings/data/export` bridges `writeCompanyExport` into a response stream (text →
  `TextEncoderStream` → `CompressionStream('gzip')`), answering an error instead of a file until
  the first line is written. The export reads every table in `EXPORT_TABLES` keyset-paged by id,
  1,000 rows a page, in one read-only, repeatable-read transaction in the company's scope, after an
  advisory lock per company; members are joined with their account's name and email. The spec
  lists each exported table's columns and each omitted column's reason; `EXPORT_EXCLUDED_TABLES`
  gives each left-out table's reason.
- **Request and grace** (`tenancy/deletion.ts`): `app.request_tenant_deletion` (owner, typed
  address) writes the register `ops.tenant_deletions` (previous status, due in 14 days) and puts the
  company in `pending_deletion`, which the permission layer treats like a suspension; the company
  layout shows a banner. `app.cancel_tenant_deletion` restores the status (a suspension stays, a
  lapsed plan restricts) until the run starts.
- **Staff deletion** (ADR-090, migration 0067, `platform/service.ts`): a platform owner schedules
  a deletion from the company's platform page (typed address, a reason the company reads) through
  `ops.platform_request_tenant_deletion`, and cancels one staff scheduled through
  `ops.platform_cancel_tenant_deletion`; the register records `requested_by`, the reason,
  `cancelled_by` and the cancel reason, and whoever scheduled a deletion cancels it (the owners'
  function refuses staff deletions). Both cancel functions restore the status through
  `ops.tenant_status_after_deletion`. The worker's minute billing sweep emails the owners and
  administrators (`notifyStaffDeletions`: `ops.tenant_deletion_notices_due`, then
  `app.tenant_deletion_mark_notified` in the company's scope with the emails), because the platform
  role cannot queue email. The banner, Settings → Company data and the final email name HyFib and
  its reason instead of an owner.
- **Run** (`tenancy/deletion-run.ts`, worker `handlers/tenancy.ts`): the minute billing sweep calls
  `ops.tenant_deletions_due` and queues a signed `tenant.delete` job per company (`exclusive`,
  singleton per company, retried with backoff). A run calls `ops.start_tenant_deletion` (first time:
  records who to notify, releases the company's number bindings), cleans up at providers once and
  records the outcomes (`ops.record_tenant_deletion_cleanup`), then calls `ops.delete_tenant_data`
  in its own transaction per batch (2,000 rows of the first step that has rows, or a whole step for
  the cycle and self-references) for up to five minutes, and finally `ops.finish_tenant_deletion`
  with the final emails in the same transaction. The step order `ops.tenant_deletion_steps` lists
  every deletable table; the definer role's delete policies match `ops.deleting_tenant_id()`, set
  only inside the functions.
- **Provider clean-up:** Graph `DELETE /{WABA-ID}/subscribed_apps` with the account's stored token;
  the store worker's removal (Shopify `appUninstall`, WooCommerce webhook deletion) with the removal
  deadline already past; the company's plan subscription cancelled at Razorpay at once (0037,
  ADR-063); Razorpay token deletion for HyFib's card mandate, with the mandate cancelled
  and auto-recharge turned off either way. Missing configuration or credentials are recorded as
  skipped, errors as failed; neither stops the deletion.
- **Kept:** the company row as a tombstone, billing tables, plan history, plan subscriptions and
  plan payments, the register, support
  grants and security events (the catalog tests list them); people's accounts.
- **Web:** Settings → Company data (owners: export link, deletion form with the typed address, the
  pending state with the due date and a cancel button, or HyFib's reason without one, the started
  state); the platform company page shows the register (dates, runs, rows deleted, provider
  outcomes, who scheduled and cancelled it and why) and, for platform owners, the forms to schedule
  and cancel a staff deletion.
- **Step-up:** exporting and asking for the deletion need a sign-in within the last 15 minutes
  (ADR-056).
- **Not built yet:** stored exports and other formats.

## 7. Commercial model and billing **[built: plans and entitlements, paying for plans by Razorpay subscription, wallet, top-ups, auto-recharge, statements and receipts, usage and rates, staff refunds of unused credit, daily settlement reconciliation — verified against a local Razorpay stand-in only; tax invoices planned]**

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
  scope for trials, paid periods and grace periods that have ended (notices to billing managers). A
  staff change marks the version it writes (`staff_notice_version`, 0077, ADR-100), and the same
  sweep emails the billing managers about it (`notifyStaffPlanChanges`: listed by
  `ops.plan_change_notices_due`, taken by `app.take_plan_change_notice()` in the company's scope,
  company row first, in the transaction that queues the emails; a change replaced first is not
  told). An
  expired or canceled plan sets `tenants.status = 'restricted'` through a trigger; restricted
  behaves like suspended (`ALLOWED_WHEN_SUSPENDED`, jobs deferred, sweeps skip it, public
  lookups still resolve), suspension wins, and a plan that gives access again lifts it.
  `app.tenant_entitlements` computes limits with add-ons (NULL: no limit) and modules; the services
  check a limit where something is added, under a per-company advisory lock (`seats:`, `numbers:`,
  `teams:`, `automations:`); seats count active members plus waiting invitations and
  `app.accept_invitation` checks the same limit in SQL. Live automation runs started by customer
  messages or store events consume `app.usage_counters` atomically (`ON CONFLICT … DO UPDATE …
WHERE used < limit`), per monthly period from `usage_anchor`; the sweep announces a used-up month
  once (`notified_at`) and warns once at 80% of the limit (`warned_at`, 0036, ADR-062), or at the
  share from 50% to 95% that a member who manages billing chose
  (`app.tenants.usage_warning_percent`, 0108, ADR-144), each time locking the counter and checking
  it against the current limit, period and share (a counter of an earlier period is marked without
  an email). The company layout shows notices of those two limits (`plans/limit-notices.ts`,
  ADR-140): nearly used up (from the same share) or used up, read per page in one
  read-only transaction (`app.tenant_entitlements` and the period's counters) for an active company
  and a member who reads billing, automations (runs used up) or manages API keys (requests used
  up). The tenant context drops the write permissions of
  modules the plan leaves out (`MODULE_WRITE_PERMISSIONS`); workers check the module before
  starting runs, order messages and cart reminders (`not_in_plan`). Public API requests are counted
  the same way against the version's monthly API requests (0035, ADR-061; §6N). Platform staff see
  usage as counts only (`ops.platform_tenant_usage`). Staff set paid periods for payments settled
  outside HyFib; companies can also pay by Razorpay subscription (below) and change the plan it pays
  for from the end of the paid period (ADR-109). Changes at once, proration and plan invoices are
  not built.
- **Paying for plans (0037, ADR-063) [built, behind `RAZORPAY_SUBSCRIPTIONS_ENABLED`]:** Billing →
  Paying for your plan (`packages/domain/src/billing/plan-subscriptions.ts`) quotes the plan version
  with the company's add-ons plus the tax platform owners set (`ops.plan_settings.plan_tax_bp`,
  `planPaymentQuote` in integer paise). Owners and billing managers with a recent sign-in start a
  subscription: `app.plan_subscriptions` is written first (`creating`, amounts, add-ons and the plan
  fixed by column grants, one live row that keeps charging per company by a partial unique index,
  an advisory lock per company), then Razorpay's plan (`POST /v1/plans`, monthly, quarterly or yearly) and subscription
  (`POST /v1/subscriptions`, five years of cycles, `expire_by` in one hour, `customer_notify`).
  Checkout opens with the `subscription_id`; its signature (`payment_id|subscription_id`, checked
  against OUR stored id) only prompts `syncPlanSubscription`, which is also run by every
  `subscription.*` webhook, by a `payment.*` webhook whose fetched invoice names one of our
  subscriptions (`ops.billing_resolve_subscription`), by the minute sweep
  (`ops.plan_subscriptions_due`: unfinished starts after 10 minutes, unpaid ones past `expire_by`,
  live ones daily and hourly after a cycle ends) and by the plan sweep before a period-end
  transition. The sync fetches the subscription and, while Razorpay's `paid_count` exceeds the
  recorded payments, its invoices; each paid invoice of our subscription, in INR, for our amount,
  whose payment is fetched as captured, becomes one append-only `app.plan_payments` row (payment and
  invoice ids unique). Ended statuses stay ended, unknown ones keep ours, older reads (fewer paid
  cycles) change nothing, and an unpaid subscription past its window is cancelled at Razorpay. For
  an active subscription `app.apply_plan_subscription_period` (definer, the company's scope) makes
  the plan active for exactly `current_start`–`current_end` when a payment's billing period has its
  middle in that cycle and the plan state still has the subscription's version and add-ons, links
  `tenant_plans.subscription_id` and restarts the usage period. Company cancels are
  `cancel_at_cycle_end` for an active subscription (at once otherwise); `app.apply_plan_transition`
  ends such a period as canceled without grace days. Platform owners set the tax and cancel a
  company's subscriptions at once (`/platform/tenants/<id>`), staff plan changes are refused while a
  subscription is live, and company deletion cancels them at Razorpay (§6Q). Billing managers are
  emailed about payments, failed charges (`pending`), stopped retries (`halted`) and cancels: the
  company's own at once, and a platform owner's by the minute billing sweep, as the platform role
  cannot queue email (`staff_cancel_notice_due`, 0078, ADR-101: listed by
  `ops.plan_subscription_cancel_notices_due`, taken by `app.take_plan_subscription_cancel_notice()`
  in the company's scope, company row first, in the transaction that queues the emails, with the
  reason from the company's audit log and what the plan keeps, read from its plan state). Each
  plan payment has a receipt page (`billing/plan-payments/<id>`, ADR-064) computed from the payment
  and its subscription, linked from the payments table and the payment email; not a tax invoice.
- **Paying from the end of the trial (0079, ADR-102) [built]:** `planPaymentStart` offers a trial
  that ends at least 48 hours ahead a subscription starting at the trial's end: its `starts_at`
  (written once) is sent as Razorpay's `start_at`, Checkout only authorises the payment method
  (`authenticated`, no payment recorded, `confirmCheckout` answers `scheduled`), and the first
  charge at the start makes the plan active through `app.apply_plan_subscription_period`, as any
  paid cycle. `app.trial_charge_wait_until(tenant)` (an ordinary SQL function, run by the company's
  scope and by the definer functions) is the one rule by which an ended trial waits for that charge:
  while a subscription starting at the trial's end is `authenticated`, `active` or `pending`, until
  the plan version's grace days have passed. `app.apply_plan_transition` and
  `ops.plan_transitions_due` leave a waiting trial alone, the plan card shows until when, and
  `ops.plan_subscriptions_due` re-reads a due first charge hourly until a paid cycle is recorded.
  The company's cancel before the start is at once; after it, the subscription is synced first, so
  a charge already made is kept and cancelled at the end of its cycle.
- **Refunds of plan payments (0080, ADR-103) [built]:** `app.plan_payment_refunds` holds each refund
  of a plan payment: asked for by a platform owner (`origin = 'staff'`, with the reason and who
  asked, which the company role cannot read) or made at Razorpay (`origin = 'razorpay'`, recorded
  as processed). `ops.platform_request_plan_payment_refund` (platform role) checks the owner, the
  reason, the company's status and the amount; `ops.plan_payment_refunds_due` feeds the minute
  billing sweep, which queues one signed `billing.plan-payment-refund` job per request;
  `processPlanPaymentRefund` asks Razorpay with `ppr_<id>` as the idempotency key and the request's
  id in the notes, and checks the refund until it is processed or failed. Only
  `app.record_plan_payment_refund` (company scope, a refund fetched from Razorpay: from the job,
  `refund.processed` or the daily reconciliation) marks a refund processed, recognising HyFib's own
  by refund id or by its note, and it and the request take one advisory lock per payment so
  processed refunds never exceed the payment. The runtime role may only move a request to submitted
  or failed. A refund never changes the plan state or the subscription. The receipt and Billing's
  payments table show refunds; the platform page lists them and has the form.
- **Refund requests of plan payments (0081, ADR-104) [built]:** a member with `billing.manage` and
  a sign-in within 15 minutes asks from a plan payment's receipt for a refund of part or all of it,
  with a reason. `createPlanRefundRequestsService` reads the company's status under a share lock,
  counts the company's refund requests of both kinds in the last 24 hours (at most 5) under the
  advisory lock requests of service credit take (`assertRefundRequestAllowance`, shared with
  ADR-073), and checks what Razorpay has not refunded of the payment and a refund of it in progress;
  it inserts the open request with only the columns the company role may insert, and
  `plan_payment_refund_requests_one_open_uq` keeps one open request per payment. The company can
  withdraw an open request. `ops.platform_decide_plan_payment_refund_request` (platform owners)
  approves by calling `ops.platform_request_plan_payment_refund` (ADR-103) for the request's amount
  in the same transaction, which checks everything again, and links the refund; declining needs a
  note. The minute billing sweep's announcement to platform owners and its decline notices (0046)
  cover both kinds. `/platform/refunds?kind=plan` lists the requests
  (`ops.platform_plan_payment_refund_requests`) and every refund of a plan payment across companies
  (`ops.platform_plan_payment_refunds`), each newest first on exact keyset pages.
- **Plan choices (0082, 0083, ADR-105) [built]:** platform owners offer published plan versions
  (`ops.plans.offered_at`, `offered_by_user_id`; `offerPlan` and `withdrawPlanOffer` in the platform
  plans service, in the platform audit log). The plan guard lets only the offer change on a
  published version, and check constraints keep it to published versions priced at ₹1 or more, so
  retiring must clear it. `createPlanChoicesService` lists the offered versions for `billing.read`,
  each with its quote (`planPaymentQuote` with the company's add-ons and the tax), what it holds
  against what the company uses (`versionHoldingLimits`, `planShortfalls`) and why the company
  cannot choose now. `choose` (`billing.manage`, a recent sign-in) takes the four limit locks
  (`lockAllLimits`) and calls `app.choose_plan` (SECURITY DEFINER, runtime role), which takes the
  company and member from the session's scope, the subscription-start advisory lock, the company row
  for share and the plan state for update, checks the status, a live subscription, the offer and
  the tax, takes the chosen version's advisory lock shared (0083: the plan guard takes it
  exclusively when a published version stops being offered, so a withdrawal or retirement and a
  choice never interleave), and changes only `plan_id`, the note, who and when, and the version.
  The service then refuses a version the company could not pay for with its add-ons and the tax,
  counts what the company uses against the new version's entitlements and rolls back on a
  shortfall, and audits `billing.plan_chosen`. Billing links to `/c/<slug>/billing/plans` when
  another offered version can be chosen; paying is unchanged (ADR-063): the payment offer and a
  started subscription use the version the company is on.
- **Plan add-ons (0084, ADR-106) [built]:** `createPlanAddOnsService` lists, for `billing.read`, the
  add-ons the company's version sells (extra seats, extra WhatsApp numbers, run packs) with each
  one's price, quantity, the most the version allows and the fewest that still hold what the
  company uses, the current quote, and why the company cannot change them now
  (`planChangeUnavailable`, shared with plan choices, plus a version no longer published). `choose`
  (`billing.manage`, a recent sign-in, digits only) takes the four limit locks and calls
  `app.choose_add_ons(seats, numbers, packs)` (SECURITY DEFINER, runtime role), which takes the
  company and member from the session's scope and the locks of `app.choose_plan`, checks the same
  conditions with a published version instead of an offered one, and changes only the three
  quantities, the note, who and when, and the version; the plan state's guard keeps them to what the
  version sells. The service then refuses a total that cannot be paid and, after a decrease, seats
  (with waiting invitations) or WhatsApp numbers that no longer fit, and audits
  `billing.add_ons_chosen`. Billing links to `/c/<slug>/billing/add-ons`, whose form shows the
  total as the quantities change (`planPaymentQuote` in the browser); paying is unchanged.
- **Price list for visitors (0085, ADR-107) [built]:** platform owners show or hide it
  (`showPriceList` / `hidePriceList` in the plan admin service, writing
  `ops.plan_settings.price_list_shown_at` and `price_list_shown_by_user_id`, audited). The public
  page `/pricing` (no sign-in) calls `createPriceListService().publicPriceList()`, which reads in
  the system scope as the runtime role, in a read-only transaction, whether the list is shown, the
  tax and the default trial (column grants from 0085), then the commercial terms of the published,
  offered versions, cheapest first, each with its total with the tax from `planPaymentQuote`; a
  version one plan payment cannot cover is left out. `priceListGaps` decides whether visitors see it
  (shown, Razorpay subscriptions on, the tax set, a default trial, a payable version) for the page,
  which is not found otherwise, and for the card on the platform Plans page, which names what is
  missing. `priceListLines` words what each version includes and the add-ons it sells.
- **Plan changes from the end of the paid period (0087, ADR-109) [built]:** `createPlanChangeService`
  (`billing/plan-changes.ts`) tells `billing.read` whether the company can change
  (`planChangeFromPeriodEndUnavailable`: not suspended or being deleted, Razorpay subscriptions on
  and the tax set, an `active` plan whose period its subscription paid, that subscription `active`
  or already ended, and at least 48 hours to the period's end), the versions it can change to (the
  offered ones and its own while published, each with what it holds against what the company
  uses), the subscription that follows the current one, and for one version the add-ons it sells,
  starting from the capacity the company has now (`addOnsKeepingCapacity`, `planChangeAddOns`).
  `scheduleChange` in the plan subscription service (`billing.manage`, a recent sign-in, the
  subscription advisory lock) checks the same with the add-on bounds, the shortfalls and the quote,
  then in order: cancels the current subscription at the end of its cycle at Razorpay (the company's
  own cancel, emailed as a change) unless it already ends; cancels at once a follow-on still waiting
  (a new choice replaces it); records the follow-on (`starts_at` = the plan's `period_end`,
  `follows_subscription_id` = the paying subscription, audited `billing.plan_change_started`) and
  creates it at Razorpay with `start_at`, as ADR-102. Checkout only authorises it.
  `app.guard_plan_subscription_follow` (BEFORE INSERT, invoker rights) refuses a follow-on whose
  predecessor is not the plan's paying subscription and charging no more, whose start is not the
  period's end at least 48 hours ahead, whose company is suspended or being deleted, whose version
  is not published and offered or current, whose add-ons the version does not sell, or whose price
  is not the version's with the tax. `plan_subscriptions_one_live_uq` excludes rows cancelled at
  their period's end, so the ending subscription and its follow-on can coexist but two rows that
  keep charging cannot. `app.apply_plan_transition` takes the renewal path (past due within the
  grace days, or expired) instead of canceled when an `authenticated`, `active`, `pending` or
  `halted` follow-on starts at the period's end. `app.apply_plan_subscription_period` applies a
  follow-on's paid cycle with its version and add-ons (audited with the previous ones), returns
  `mismatch` for any other subscription that does not match the plan, and `stale` for a cycle of
  another subscription that ends no later than the plan's period. The plan guard lets a retired
  version in only as the plan of that paid follow-on. The company's cancel picks the subscription
  that keeps charging (the follow-on, if any); staff cancels and company deletion cancel every live
  one, with ADR-101's notice sent once. Billing shows the next subscription and its status,
  `/c/<slug>/billing/change` lists the versions and `/c/<slug>/billing/change/<planId>` holds the
  form (`ChangePlanForm`: live total, a confirmation that names what cannot be undone, Checkout).
- **API request packs (0088, ADR-110) [built]:** a version with a monthly API request limit above 0
  may sell packs (`api_request_pack_size`, `api_request_pack_price_minor`, both or neither, checked
  by constraints and kept by the plan guard once published). `tenant_plans.api_request_packs` and
  `plan_subscriptions.api_request_packs` (0 to 10,000) carry them like run packs: staff set them with
  the plan (`setTenantPlan`), companies through `app.choose_add_ons(seats, numbers, run packs, API
packs)` and Change plan, subscriptions record and price them (`planPaymentQuote`'s
  `apiRequestPacksMinor`), and `app.apply_plan_subscription_period` applies them. The company's
  limit is the version's plus packs × size in `app.tenant_entitlements`, `ops.api_quota_reached`
  and `ops.usage_warnings_due`. No limit with packs passes 2,000,000,000 (`PLAN_BOUNDS.limitWithPacks`,
  `packsMax` in the forms, the plan state's and the follow-on's guards, for run packs too); the
  sweep lookups sum in 64 bits. `app.guard_plan_subscription_start` (BEFORE INSERT, invoker rights)
  refuses a subscription that follows none unless its version and add-ons are the plan state's. The
  three-quantity `app.choose_add_ons` stays for the previous release during a deploy.
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
- **Statements and receipts (0029–0031, ADR-057) [built]:** Billing → Statements lists every month
  from the wallet's creation to the current one, in the company's time zone, with money in and out
  and closing balances. A month's statement is computed on request from the ledger in one
  repeatable-read, read-only transaction:
  - opening balances are the available and reserved accounts' entries before local midnight on the
    1st (the first real instant on daylight-saving days, using the covering index
    `ledger_entries_account_time_idx`);
  - the lines are the month's transactions in time order, 100 per page, with running balances from
    a window over the month;
  - the closing balances are the opening balances plus every line.

  The CSV adds an opening-balance and a closing-balance row, with exact rupees built from paise. It
  is audited as `billing.statement_exported`. Plain negative numbers stay numbers under the CSV
  formula guard (contacts/csv).

  A paid top-up has a receipt page with the receipt number `tu_…`, the Razorpay payment and order
  ids, the method Razorpay reported, the saved card for an automatic top-up, and its refunds and
  chargebacks (`ledger_transactions_reference_idx`). A receipt is a payment confirmation, not a tax
  invoice. The method is recorded with the credit by `app.billing_record_payment_method`: a definer
  function that sets it once, only when the same payment id credited the top-up. The insert policy
  keeps a new top-up from carrying one. Each credit emails the billing managers a link to its
  receipt, in the credit's transaction. Nothing is stored for statements; a statement viewed again
  shows the same postings.

- **Staff refunds of unused credit (0032, ADR-058) [built]:** the platform company page shows the
  company's balances, its latest paid top-ups and refunds (`ops.platform_company_billing`: payments
  to HyFib, no company content, no support grant needed). A platform owner refunds part or all of a
  paid top-up with a reason. `ops.platform_request_credit_refund` (definer, platform role only)
  checks the owner, the reason, that the company is not being deleted, the top-up (paid or partly
  refunded, no refund of it open), the amount (at most what is left of the payment) and, under the
  wallet account's row lock, the available credit. In one transaction it places a hold
  (`credit_refund`, 90 days), records `app.credit_refunds` (`requested`) and writes the platform
  audit log with the reason. The minute billing sweep queues a signed `billing.credit-refund` job
  for each due request (`ops.credit_refunds_due`). The job writes the attempt down first, then calls
  `POST /v1/payments/:id/refund` with speed `normal` and `X-Refund-Idempotency: crf_<id>`, the same
  body on every try:
  - a refund returned: `submitted` with the refund id, audited, and the billing managers emailed;
  - a 4xx other than 401 and 409: `failed` through `app.billing_fail_credit_refund`, which releases
    the hold;
  - a 401, 409, 429, 5xx, timeout or lost response: tried again after 1, 5, 15 and 60 minutes,
    then hourly.

  A submitted refund is checked every 15 minutes, then hourly after an hour and every 6 hours
  after a day. `refund.processed` (webhook) or the job's check calls `app.billing_record_refund`
  (replaced in 0032). It releases the hold of an open request for the same refund id, or of one
  with no id stored yet and the same amount, and marks it `processed`, in the transaction that
  posts the refund: the credit the hold set aside is taken exactly once, even when the webhook
  arrives before the job stored the refund id. `refund.failed`, or a failed refund found by the
  check, fails the request and releases the hold. The company role reads its requests but not the
  staff reason or who asked (column grants). It may move an open request only between `requested`
  and `submitted` (a restrictive policy): `processed` and `failed` are reachable only through the
  definer functions that settle the hold. A due company deletion waits until no refund is open
  (the worker checks before it starts). Statements label the hold "Reserved for a refund" and its
  release "Refund reservation released"; the Billing page and the receipt show refunds in progress.

- **Refund requests from companies and the platform refunds list (0046, ADR-073) [built]:** a
  member with `billing.manage` and a sign-in within 15 minutes asks from a paid top-up's receipt for
  a refund of part or all of it, with a reason (10 to 1,000 characters). The service takes a
  per-company advisory lock, counts the company's requests of the last 24 hours (at most 5) and
  checks the top-up, what is left of it, a refund of it in progress and the unused credit
  (`wallet_available`); a company being deleted cannot ask. It inserts the open request with only
  the columns the company role may insert (a column grant: an inserted row is always `open`, with no
  decision), and the partial unique index `credit_refund_requests_one_open_uq` keeps one open
  request per top-up. The company can withdraw an open request (a restrictive policy lets its role
  move `open` only to `withdrawn`). A request moves no money and holds no credit.
  `/platform/refunds` lists the requests (open, decided or all) with the company, the top-up, its
  payment date, what is left of it, the company's unused credit now and whether a refund of it is
  running (`ops.platform_credit_refund_requests`), and every refund of service credit across
  companies (`ops.platform_credit_refunds`), both newest first on exact keyset pages (the request
  time as microsecond text and the id, ADR-072). Operators read; only a platform owner decides.
  `ops.platform_decide_credit_refund_request` locks the open request. Approving calls
  `ops.platform_request_credit_refund` (ADR-058) for the request's amount in the same transaction, so
  every check runs again under its locks, and links the refund; a request that no longer fits is
  refused with the reason and stays open. Declining needs a note the company reads. Both are in the
  platform audit log. The minute billing sweep emails platform owners once about requests not yet
  announced (a count only; `ops.credit_refund_requests_mark_announced` marks them in the
  transaction that queues the emails, and nothing is marked while there is no platform owner), and
  a company's billing managers once about a declined request, with the note
  (`app.credit_refund_request_mark_decline_notified`, in the company's own scope). An approved
  request needs no email of its own: the refund's emails follow. The receipt shows the requests,
  the decision note and the refund's state; who decided is platform-only (no column grant).

- **Daily settlement reconciliation (0034, ADR-059) [built]:** the minute billing sweep calls
  `ops.settlement_recon_due` with the latest day it may reconcile (the previous day in India from
  06:00 India time). That creates the run for the day and for any of the 6 days before it without
  one (never before the first day ever reconciled), fails runs that used their six attempts, and
  returns the runs due; one signed `billing.settlement-recon` job is queued for each. The job claims
  its run (`ops.settlement_recon_claim`: a 15-minute lease and a new attempt number that every
  write of the attempt names, so an attempt whose lease expired cannot write). It reads
  `GET /v1/settlements/recon/combined` a page of 1,000 at a time (R-110, R-111; at most 50 pages)
  and looks each page's provider ids up in HyFib's records (`ops.settlement_recon_facts`: top-ups by
  payment and order, card mandates by authorisation payment, order and refund, recorded refunds by
  ledger key through the refunded payment's top-up, and plan payments by payment id, 0037). A
  payment on a top-up's order that did not credit it goes through `applyPaymentById`, as does a
  payment on no order of HyFib's (it may be a plan subscription's charge, recorded by syncing the
  subscription), and a refund of a payment that credited a top-up but was never recorded goes
  through `applyRefundById`: both fetch from Razorpay first and use the functions the webhooks use,
  so the reconciliation is the backstop for lost webhooks and records nothing twice. Refunds of plan
  payments wait for a person (HyFib does not refund them). Everything else is classified (matched, a mismatch, for review, not HyFib's) and
  written with `ops.settlement_recon_record_items`; `ops.settlement_recon_complete` removes items
  Razorpay no longer lists for the day and totals the run. A Razorpay failure that may pass leaves
  the run due again after 5, 15, 60, 180 and 360 minutes (`ops.settlement_recon_defer`); any other
  4xx fails it (`ops.settlement_recon_fail`). The runtime roles have no privileges on
  `ops.settlement_recon_runs` or `ops.settlement_recon_items`: the worker writes through these
  definer functions, and `/platform/reconciliation` reads through
  `ops.platform_settlement_recon_runs`, `…_run` and `…_unsettled` (platform staff) and acts through
  `ops.platform_request_settlement_recon` and `ops.platform_resolve_settlement_item` (platform
  owners, audited with a reason or note). Items keep provider ids, amounts, fees and HyFib's match;
  never notes, descriptions, receipts or card fields.

- **Reconciliation alerts (0039, ADR-066) [built]:** the minute billing sweep
  (`packages/domain/src/billing/settlement-alerts.ts`, whether or not Razorpay is configured) lists
  finished attempts not emailed yet (`ops.settlement_recon_alerts_due`: failed runs and completed runs
  with transactions still waiting for a person, ids only), marks each with
  `ops.settlement_recon_mark_alerted` (which returns the day, the outcome, the last error and the open
  transactions by status, counted under the run's row lock) and, in the same transaction, queues one
  `platform.notice` email per platform owner (`ops.settlement_recon_alert_recipients`) listing the
  days. `alerted_attempt` on the run records the attempt emailed, so each attempt is emailed once and
  a day run again is emailed again.

- **Alerts for unsettled payments (0043, ADR-071) [built]:** `ops.settlement_unsettled_topups()` is
  the one definition of a payment no settlement showed (paid or partly refunded top-ups, no
  settlement item for the payment, every day from its payment day in India time to 7 days later
  completed), read by the page's list and by the minute billing sweep. The sweep
  (`alertUnsettledPayments`) lists payment ids not emailed yet
  (`ops.settlement_unsettled_alerts_due`), then `ops.settlement_mark_unsettled_alerted` checks each
  against the definition again and inserts it into `ops.settlement_unsettled_alerts` (payment id
  primary key; a concurrent sweep waits, then inserts nothing) in the transaction that queues one
  `platform.notice` email per platform owner, with the count and the payment days only. The list on
  `/platform/reconciliation` shows when owners were emailed about each payment.

- **Usage and rates (ADR-060) [built]:** Billing → Usage and rates
  (`packages/domain/src/billing/usage.ts`) shows owners, administrators and billing managers
  (`billing.read`) Meta's rates for the company's billing currency (Settings → Messaging) and this
  month's estimate, read in one repeatable-read, read-only transaction in the company's RLS scope:
  - the published card in force (the latest effective time not after now): list prices at volume
    tier 0 by market and pricing category, a missing price shown as not priced, never as zero;
  - the next published card (the earliest effective time after now) with every price it changes,
    adds or no longer lists, and the difference;
  - this month so far in the company's time zone: delivered, billable, free and not-yet-priced
    messages and the estimate by pricing category, from `estimateMetaCharges`, the function behind
    Reports → Estimated Meta charges (§6C), so each message is priced with the card in force when it
    was recorded and the two pages agree.

  Drafts and withdrawn cards are never shown. Nothing is stored, posted to the ledger or taken from
  service credit; Meta bills the company directly (ADR-011).

- **Rate change notices (0038, ADR-065) [built]:** the minute billing sweep
  (`packages/domain/src/billing/rate-notices.ts`, whether or not Razorpay is configured) lists, through
  the definer function `ops.rate_change_notices_due` (ids only), active companies whose billing
  currency has a published card taking effect within 7 days that they were not told about. Each
  pair is checked again in the company's scope (active, the card published, for its currency, still
  ahead and within the week) and recorded in `app.rate_change_notices` (unique per company and
  card, append-only) in the transaction that queues the billing notice to its owners and billing
  managers: when the card takes effect in the company's time zone, what it changes against the
  published card in force just before it, the largest changes and a link to Usage and rates. A
  failure records nothing and is retried by the next sweep without holding up other companies.

- **Browser security:** the billing and WhatsApp-channels pages get their own CSP allowing only
  that provider's script and frame. Because a CSP belongs to the loaded document, links to these
  pages are full page loads and the pages reload once if reached by client-side navigation.

## 8. Observability

Structured JSON logs (pino) with redaction and correlation ids **[built]**; failed queries logged
without the data they quote (a `DatabaseQueryError` from `db.run` and the logger's `err` serializer,
Better Auth's log lines included, ADR-129) **[built]**; every failed job attempt logged by the worker with its queue and job ids
**[built]**; audit and security events in the database **[built]**; queue counts and recorded dead
letters in the platform operations console (§6P) **[built]**; OpenTelemetry traces/metrics with one
hosted backend, queue lag and dead-letter alerts **[designed]**.

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
