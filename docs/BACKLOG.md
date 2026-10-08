# Backlog

Dependency-ordered. Each item lists acceptance criteria (AC), tests (T) and prerequisites (PR).
Status values follow the feature matrix. Last updated 2026-09-28.

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
  live updates. **[Files customers send built; their database and browser tests run only in CI]**
  (ADR-216: photos, stickers, voice notes, videos and documents fetched from WhatsApp when shown and
  never stored; no migration). **[Sending files built; their database and browser tests run only in
  CI]** (ADR-218: photos, videos, recordings and documents up to 16 MB uploaded to WhatsApp when a
  member sends them and sent by their id; no migration). Remaining: list virtualisation, collision
  warnings (phase 3 with presence), template picker (phase 3), byte ranges so Safari plays
  recordings and videos.
- **P2-10 Channel settings UI** — done: connect (Embedded Signup), setup progress and errors, retry,
  disconnect, quality and health time. **[The overview's setup checklist built from the company's
  data; its database and browser tests run only in CI]** (ADR-233, W-026: two-factor, an active
  number or one to reconnect, an approved template, contacts, teammates or a pending invitation, a
  first-response target, each shown to members who can read its data; no migration). Remaining:
  messaging limits and granted permissions display.
- **P2-11 Platform quarantine view** — done with P5-10 (ADR-054): the operations console's
  Integrations page lists quarantined webhooks without their content and platform administrators
  resolve them, or retry their receipts, with a reason in the platform audit log.
- **P2-12 Token health** — _implemented and locally verified against the Graph stand-in (ADR-137)_:
  each connected WhatsApp account's token is checked daily with `debug_token` by onboarding's rules,
  and at once when Meta refuses it for a send or a template sync; a loss of access marks the account
  and its numbers for reconnecting, emails the owners and administrators once and shows a banner on
  every page of the company; an expiry Meta reports is reminded 7 days ahead and checked again as
  soon as it passes; reconnecting brings back the account's other numbers that Meta still lists.
  The same check lists the apps subscribed to the account's webhooks and subscribes HyFib's app
  again when Meta no longer lists it, telling the company; when that fails, every page says that
  messages are not reaching HyFib (ADR-138). **Remaining:** Meta's deauthorization callbacks
  (unconfirmed, M-146) and which webhook fields the app receives.

## Phase 3 — contacts, consent, templates, campaigns, reports

- **P3-01 Contacts & CRM fields** — _implemented (2026-09-26)_: custom fields, tags, search and
  filters, import preview/mapping/row errors, one contact per number (dedupe across manual, import
  and inbound), formula-safe export, erasure; saved segments (P3-04). **[Bulk tag edits built; their
  database and browser tests run only in CI]** (ADR-213: one tag added to or removed from up to
  10,000 contacts the page's filters match, refused if the matches changed since the member saw
  them; no migration). **[Merging contacts built; its database and browser tests run only in CI]**
  (ADR-224, H-019, migrations 0147 to 0149: owners and administrators merge a duplicate into the
  contact they keep after reviewing both; everything moves, the stricter consent stands, and the
  duplicate is deleted with a record of the merge). **[Number masking built; its database and
  browser tests run only in CI]** (ADR-226, W-044, migration 0152: owners and administrators choose
  the roles whose members see customers' numbers masked, enforced in the services, with searches by
  whole numbers only). **[Merges through the API built; their database tests run only in CI]**
  (ADR-227, migration 0153: a `contacts.merge` scope, granted by members who may delete contacts,
  for `POST /contacts/{id}/merge`). **[Bulk field edits built; their database and browser tests run
  only in CI]** (ADR-238: one custom field set to one value, or cleared, on up to 10,000 contacts
  the page's filters match, after a confirmation, with the checks of a member's edit and of bulk tag
  edits; no migration). **[Renaming custom fields in Settings built; its browser test runs only in
  CI]** (ADR-262: owners and administrators rename a field's label in Settings → Messaging, audited,
  its key and so every value, CSV column and API name kept; no migration). **Remaining:** joining
  conversations.
- **P3-02 Consent & suppression** — _implemented (2026-09-26)_: consent events with provenance,
  opt-out/opt-in keywords, Meta 131050 opt-outs, suppression list, send-time enforcement (race test
  with a queued template, and with campaigns). **Remaining:** review Meta's
  opt-in guidance (M-131) and per-market consent law; consent capture from growth tools (phase 4).
- **P3-03 Templates** — _implemented (2026-09-26), not verified against Meta_: drafts, validation,
  write-ahead submission with lost-response reconciliation, Graph listing sync (webhook-triggered
  and periodic), deletion, status history, template sends from contacts and the inbox.
  **[Website buttons whose link ends with a value built; their database and browser tests run only
  in CI]** (ADR-228: created with their example, synced, and sent from contacts, conversations and
  the API; ADR-229: filled by campaigns, automations and store messages too). **[Starter templates
  built; their browser test runs only in CI]** (ADR-232, W-070: twelve starters in HyFib's own copy,
  eight utility and four marketing, that fill the New template editor; marketing ones get the
  company's marketing opt-out keyword as a button; no migration). **Remaining:** creating media
  headers (Resumable Upload + media storage) and sending them outside the API (which sends them with
  a link since ADR-201), named parameters, authentication/OTP, carousel, LTO, copy-code and catalog
  templates, editing approved templates (`POST /{template-id}`), starters in other languages, and a
  sandbox run with a real WABA.
- **P3-04 Campaigns** — _implemented (2026-09-26), sends verified against the Graph stand-in
  only_: saved segments (incl. campaign-response retargeting), drafts with a review panel,
  audience snapshots re-checked when queued and before dispatch, optional four-eyes approval,
  wall-clock scheduling with daylight-saving rules, sending windows, deadlines, pacing, marketing
  frequency cap, message and estimated spending caps (platform rate cards), pause/resume and
  idempotent cancel, test sends, per-recipient outcomes, last-touch reply/opt-out attribution,
  results with denominators, CSV export. Local 10,000-recipient run: snapshot 0.6 s, all recipients
  queued in 21 ticks. Segments refuse dates that do not exist (ADR-117; a creation day of 30
  February used to fail the preview, the segment page and a campaign's audience), and compare
  contacts' names (ADR-143). **[Emails when HyFib pauses a campaign by itself built; its database
  tests run only in CI]** (ADR-210: the member it sends under, or the owners and administrators once
  that member left or lost the permission, are emailed once per pause with the cause and what to do;
  members' and keys' own pauses email nobody; no migration). **[Emails when a campaign finishes
  built; its database and browser tests run only in CI]** (ADR-214: the member it sent under is told
  it finished, or that its sending period ended and how many contacts it had not reached, with its
  counts; no migration). Keys draft, review and submit campaigns for a member's approval through the
  public API (ADR-186, ADR-193, ADR-202). **[Segment conditions on store orders built; their
  database tests run only in CI]** (ADR-231, W-051: how many orders a contact placed, or what they
  spent in one currency, in the last days or ever, in one store or all, matched by number; members
  need store order access to use them and keys `orders.read`; no migration). **Remaining:** the 10k
  run in staging with real dispatch, per-recipient time zones, A/B variants, messaging-tier
  awareness (read the number's limit from Meta), media-header templates (only the API sends them,
  ADR-201).
- **P3-05 Reports** — _implemented (2026-09-26); provider data verified against the Graph stand-in
  only_: persisted, versioned metric definitions; periods of whole days in the company time zone;
  messaging outcomes with denominators; estimated Meta charges from Meta's billable flag and
  published rate cards, with unpriced reasons; inbox queue and reply-turn response times against a
  company first-response target (turns recorded by triggers); member activity; campaign funnels;
  unavailable metrics shown with reasons; audited formula-safe exports; business-hours figures,
  resolution times and CSAT (with P3-06). **Remaining:** reconciliation with Meta's
  `pricing_analytics` (M-078, verify first), materialised daily aggregates if report queries near
  the statement timeout, scheduled report emails, retention reports once that module exists
  (automation outcomes were added with P4-01, deal outcomes with P4-04).
- **P3-06 Inbox advanced** — _implemented (2026-09-26); CSAT sends verified against the Graph
  stand-in only_: teams with members and numbers, keyword and number routing, round robin with
  explicit availability and per-member limits, a minute sweep, release when members leave;
  business hours and closed days; reply-due timers and a longest-waiting order; team, number and
  customer filters; conversation cases and resolution times; business-hours report figures; saved
  replies; note mentions; a send-time collision warning; CSAT surveys with three reply buttons.
  **[Emails about unread mentions built; its database tests run only in CI]** (ADR-211: a member
  mentioned in a note who has not opened the conversation 10 minutes later is emailed who mentioned
  them and a link, never the note or the customer; no SQL migration, one new queue). **[Transcript
  download built; its database and browser tests run only in CI]** (ADR-212, W-042: owners,
  administrators and supervisors who can see a conversation download its messages as plain text,
  audited, without notes; a new `inbox.export` permission; no migration). **[Email preferences
  built; their database and browser tests run only in CI]** (ADR-215, migration 0142: each member
  turns off, per company, the notice emails about mentions and campaigns; security, sign-in and
  billing emails stay on). **[Conversation tags built; their database and browser tests run only in
  CI]** (ADR-220, W-035, migration 0145: members who can reply tag the conversations they can see,
  and the inbox shows the tags and filters by one; erasing the contact deletes them). **[Read
  receipts and typing indicators built; their database and browser tests run only in CI]** (ADR-223,
  migration 0146: a company setting, off by default, marks the customer's message read when a member
  opens the conversation and shows the customer a typing indicator while a member writes).
  **[Emails when a reply is overdue built; their database tests run only in CI]** (ADR-230,
  migrations 0154 and 0155: the member it is assigned to, else its team, else the members who assign
  conversations, once per wait, one email per member per sweep, never the customer's details;
  members can turn them off). **[A notice of overdue replies in the inbox built; its database test
  runs only in CI]** (ADR-241: above the conversation list, how many customers the member can see
  wait past the target, counted against the clock in the browser from due times only; no migration).
  **[Presence of members built; its database and browser tests run only in CI]** (ADR-243, migration
  0157: a conversation names the other members who have it open, reported every 20 seconds while its
  page is visible; a member's row is deleted when they leave and an hour after their last report).
  **Remaining:** per-team SLA targets and calendars, private team queues (would change visibility,
  ADR-029), CSAT by template outside the window (needs a consent decision), CSAT with a real WABA
  (phone-number masking: P3-01, ADR-226).

## Phase 4 — automation, Flows, CRM, commerce

- **P4-01 Automation engine** — _implemented and locally verified (2026-09-27); WhatsApp sends
  verified against the Graph stand-in only_: keyword, new-conversation and any-message triggers with
  business-hours filters and cooldowns; eight step types (message, question with reply buttons,
  question with a typed answer and format check, condition, contact update, wait, hand-off, end);
  checks at save and publish (including loops that never wait); immutable published versions and
  runs pinned to them; durable one-step-per-transaction runs on pg-boss with a minute sweep for lost
  signals; budgets (steps, loops, messages, 7 days, runs per hour) and a limit on failing steps; test
  runs of the draft on a real conversation; the bot/human hand-off lock with Take over; step logs,
  captured answers with retention; an automation report section; a builder with a generated diagram
  and an in-browser simulator. T: restart and lost signals resume from the stored position; bot and
  person never answer at once. Template steps (send a template, ask with a template's quick replies)
  and the order-event trigger came with P4-06e. **[Steps that tag the conversation built; their
  database and browser tests run only in CI]** (ADR-222: a step adds or removes a tag on the run's
  conversation and a condition reads its tags; no migration). **[Run export built; its database test
  runs only in CI]** (ADR-237: the runs the list shows as CSV, with its filters, without customer
  data, with `automations.read`, audited; no migration). **[Keyword typos built; their database test
  runs only in CI]** (ADR-240: keyword triggers may also start on small typos, by word length, never
  in short words or numbers, ranked below every match without typos; no migration). **[Form steps
  built; their database and browser tests run only in CI]** (ADR-248: a published form sent in the
  conversation with a token of its own, as a member sends it, while the plan includes WhatsApp
  Flows; no migration). Steps that create, move and close CRM tasks and deals are recorded under
  P4-04 (ADR-244 to ADR-247, ADR-249 to ADR-251), and runs started through the public API under
  P5-08 (ADR-077). **Remaining:** catalog steps (sending products from a run), starting runs from
  campaigns, enrolling contacts or segments in a sequence without a customer message or order event,
  a drag-and-drop canvas (ADR-034), usage billing for automation steps, a real sandbox run (release
  checklist).
- **P4-02 HTTP node + egress guard** — _implemented and locally verified (2026-09-27) against a
  local target server only_: "Call a web address" steps (method, address with URL-encoded
  placeholders, headers, JSON body, values saved from the response, success and failure branches);
  per-company allowed domains and encrypted write-only secrets bound to a domain (Settings → Web
  requests, `integrations.manage`, audited); calls written ahead and made once by the
  `automation.http` worker through the egress guard, unknown (never retried) when they may have been
  received without a result, cancelled when not made before the run's two-minute deadline; call
  outcomes on run pages; erasure and retention of saved values. T: egress unit suite (blocked
  ranges and notations, pinning, redirects, limits, headers), `automation-http.test.ts` (made once,
  refusals, crash and late results, timeouts, cancellation, sweep, erasure, retention, settings,
  isolation), e2e `web-requests.spec.ts`. **[Form bodies built; their database test runs only in
  CI]** (ADR-236: a step's body as URL-encoded form fields, placeholders URL-encoded, sent as
  `application/x-www-form-urlencoded`; no migration). **Remaining:** calls against a real company
  API in an authorized environment (release checklist), response headers or non-JSON bodies as
  values, retries a company opts into for idempotent requests, OAuth client flows.
- **P4-03 WhatsApp Flows** — _implemented and locally verified (2026-09-27) against the Graph
  stand-in and signed, encrypted test requests; no live WhatsApp traffic yet_: Flow JSON written as
  text with checks while typing; drafts sent to Meta by the worker, one written-ahead operation at a
  time (create, upload, publish, deprecate, delete, refresh), a lost create response adopting the
  flow instead of creating a second, Meta's validation errors with line and column; publishing
  (owners and administrators, confirmed) and new drafts from published flows; one RSA key per
  WhatsApp account uploaded to every number, checked, and replaced with a 24-hour overlap; HyFib's
  encrypted data endpoint (signature, key, health check, error notices, HyFib's flow tokens,
  forwarding to the company's endpoint on an allowed domain through the egress guard); forms sent
  from a conversation in the service window (drafts to testers); completed forms kept and mapped to
  the contact's name, email and custom fields; erasure of answers and tokens. T:
  `flows.test.ts` (lifecycle, lost create response, validation errors, keys and rotation, sending
  and completion, a completion by another contact, erasure, the endpoint with every refusal and a
  secret moved to another domain, isolation), unit tests (Flow JSON checks, decryption with
  rotation and tampering, the message, health status), e2e `flows.spec.ts` (create, publish, send,
  complete; encrypted requests through the route). **[Sending forms from automations built; its
  database and browser tests run only in CI]** (ADR-248). **Remaining:** checks on an approved
  sandbox number and a real account's keys (release checklist), a visual form builder, sending flows
  from campaigns and templates, flows that open with `data_exchange`, Meta's flow metrics.
- **P4-04 CRM** — _implemented and locally verified (2026-09-27); reminder emails verified through
  Mailpit only_: pipelines (company settings, audited) with ordered stages and one currency each,
  archived instead of deleted; deals linked to a contact for life and optionally to a conversation,
  with exact minor-unit values, owners, stage moves, won/lost with a reason and reopening, all
  version-checked; a board per pipeline with owner filters and per-stage totals; won and lost
  lists; tasks with due times and reminders emailed once (durable job plus the minute sweep, skipped
  with a reason when stale, closed or the assignee lost access); notes; an append-only timeline per
  contact and deal; CRM panels on the contact page and beside a conversation; deal outcomes, win
  rate, time to win and open pipeline in reports and CSV; erasure of the CRM free text. T: reminders
  exactly once under repeated signals; erasure; isolation. **[Moving deals between pipelines in the
  app built; its database and browser tests run only in CI]** (ADR-234: the deal page offers the
  company's other active pipelines and their stages; the service keeps its rules; no migration).
  **[Deal export built; its database tests run only in CI]** (ADR-239: the deals a view shows as
  CSV, with `crm.read` and `contacts.export`, numbers masked as for the member, audited; no
  migration). **[Stage chances and a weighted forecast built; their database and browser tests run
  only in CI]** (ADR-242, migration 0156: a chance of winning per stage weighs the board's open
  deals, for the pipeline and for the deals expected to close this month). **[Automation steps that
  create a CRM task built; their database and browser tests run only in CI]** (ADR-244, migrations
  0158 and 0159: a step creates a task about the run's contact for an active member who can use the
  CRM, recorded as created by the automation; a member who left is skipped and the run goes on).
  **[Automation steps that create a CRM deal built; their database and browser tests run only in
  CI]** (ADR-245, migrations 0160 and 0161: a deal for the run's contact and conversation in a stage
  of an active pipeline, with an optional value in its currency and owner, unless the contact
  already has an open deal there). **[Reminders for automation tasks built; their database and
  browser tests run only in CI]** (ADR-246: a task step may email the member when the task is due,
  as a member's task reminder does; no migration). **[Expected close dates from deal steps built;
  their database and browser tests run only in CI]** (ADR-247: a number of days after the step runs,
  on the company's calendar; no migration). **[CRM steps that follow the plan built; their database
  test runs only in CI]** (ADR-249: without the CRM in the plan, task and deal steps create nothing
  and say why, and cannot be published; no migration). **[Automation steps that move deals built;
  their database and browser tests run only in CI]** (ADR-250, migrations 0162 and 0163: the
  contact's single open deal in a pipeline moved to an active stage, as the automation; nothing
  moves when it is unclear which deal). **[Automation steps that close deals built; their database
  test runs only in CI]** (ADR-251, migrations 0164 and 0165: the contact's single open deal in a
  pipeline closed as won or lost, with an optional reason, as the automation). **[A weighted
  forecast in Reports built; its database and browser tests run only in CI]** (ADR-252, migration
  0166: open deals by expected close month, weighed by each stage's chance as on the board).
  **[Reading pipelines and deals through the public API built; its database and browser tests run
  only in CI]** (ADR-253, migrations 0167 and 0168; recorded under P5-08). **[Creating deals through
  the public API built; its database and browser tests run only in CI]** (ADR-254, migrations 0169
  and 0170; recorded under P5-08). **[Changing deals through the public API built; its database and
  browser tests run only in CI]** (ADR-255, no migration; recorded under P5-08). **[Deal webhook
  events built; their database tests run only in CI]** (ADR-256, migrations 0171 and 0172; recorded
  under P5-09). **[Moving deals to another pipeline through the public API built; its database tests
  run only in CI]** (ADR-257, no migration; recorded under P5-08).
  **[A deal's history through the public API built; its database tests run only in CI]** (ADR-281,
  no migration; recorded under P5-08).
  **[Reading tasks through the
  public API built; its database tests run only in CI]** (ADR-258, migrations 0173 and 0174;
  recorded under P5-08). **[Creating tasks through the public API built; its database tests run only
  in CI]** (ADR-259, migrations 0175 and 0176; recorded under P5-08). **[Changing tasks through the
  public API built; its database tests run only in CI]** (ADR-260, no migration; recorded under
  P5-08). **[Notes through the public API built; their database tests run only in CI]** (ADR-268,
  migration 0184; recorded under P5-08).
  **[Reading notes through the public API built; its database tests run only in CI]** (ADR-279,
  migrations 0198 and 0199; recorded under P5-08).
  **[Task webhook events built; their database tests run only
  in CI]** (ADR-261, migrations 0177 and 0178; recorded under P5-09). **[Pipeline filters for deal
  webhook events built; their database and browser tests run only in CI]** (ADR-263, migration 0179;
  recorded under P5-09). **[Stage filters for deal webhook events built; their database and browser
  tests run only in CI]** (ADR-264, migration 0180; recorded under P5-09). **[Owner filters for deal
  webhook events built; their database tests run only in CI]** (ADR-265, migration 0181; recorded
  under P5-09). **[Assignee filters for task webhook events built; their database tests run only in
  CI]** (ADR-266, migration 0182; recorded under P5-09). **[Pipeline filters for task webhook events
  built; their database tests run only in CI]** (ADR-303, migration 0226; recorded under P5-09).
  **[Stage and owner filters for task webhook events built; their database tests run only in CI]**
  (ADR-304, migration 0227; recorded under P5-09).
  **[Pipeline, stage and owner filters for note webhook events built; their database tests run only
  in CI]** (ADR-305, migration 0228; recorded under P5-09).
  **[Change-maker filters for deal, task and note webhook events built; their database tests run
  only in CI]** (ADR-306, migration 0229; recorded under P5-09).
  **[Status filters for deal and task webhook events built; their database tests run only in CI]**
  (ADR-309, migration 0232; recorded under P5-09).
  **[Detail filters for deal and task webhook events built; their database tests run only in CI]**
  (ADR-310, migration 0233; recorded under P5-09).
  **[Deal owner webhook events built; their database tests run only in CI]** (ADR-269, migrations
  0185 and 0186; recorded under P5-09).
  **Remaining:** custom deal fields, products on deals, deal import, CRM connectors (HubSpot,
  Salesforce, Zoho: integrations), reminder emails through the production SMTP provider (release
  checklist).
- **P4-05 Growth tools** — _implemented and locally verified (2026-09-27); no live WhatsApp or ad
  traffic yet_: click-to-chat links (a short link that counts clicks per link and company day
  without any visitor data and redirects to wa.me with a pre-filled message and an optional
  reference code; QR codes as PNG and SVG; archive and restore; audited); conversations attributed
  to a link by its reference code, on the number the link opens only; click-to-WhatsApp ad
  referrals captured from inbound webhooks (the ad's id, type, address and headline, never the ad
  click id) and listed under Growth → Ads; the inbox says where a conversation came from; a website
  button that stores and sends nothing (no cookie consent needed) and is not served while its link
  cannot open; conversation sources erased with the contact. T: `growth.test.ts` (permissions,
  validation, versions, clicks per company day, attribution on the link's number only, ad sources
  without the click id, erasure, widgets, limits, isolation), unit tests (codes, wa.me format,
  referral parsing, the widget script against a stub DOM), e2e `growth.spec.ts` (link, QR code,
  redirect headers, attributed conversation, ads list, the button embedded on another origin,
  archive). **Remaining:** checks on real devices and with a real click-to-WhatsApp test ad on an
  approved sandbox number (release checklist), connecting ad accounts (ad sync, spend, cost per
  conversation) and conversion reporting to Meta (W-072), campaign parameters on links, a free
  public link generator for people without an account.
- **P4-06a Commerce on WhatsApp** — _implemented and locally verified (2026-09-27) against the Graph
  and Razorpay stand-ins and signed test webhooks; no live Meta or Razorpay traffic yet_: catalogs
  connected to each WhatsApp account read from Meta by the worker (up to 10 catalogs and 5,000
  products each, removed and disconnected marked, daily re-read, Meta's permission refusals shown in
  plain words); products with search; single-product, multi-product and catalog messages from a
  conversation in the service window; orders captured from the webhook with exact minor-unit
  prices, product names from the catalog copy, member statuses and visibility with the
  conversation; Payment Links in the company's own Razorpay account (write-only keys, live keys only
  in production, keys checked), written ahead and created once per single-use reference (a lost
  response looked up, never repeated), sent in the chat, checked on a schedule and on signed
  notifications, paid only from Razorpay's own report, cancelled on request, expiry returning the
  order; erasure of order notes and cancellation of open links. T: `commerce.test.ts` (catalog reads
  and refusals, product messages, orders and amounts, visibility, Payment Links end to end, busy
  lease, not-sent reason, erasure, isolation; 15 deliberate regressions caught), unit tests (prices,
  order parsing, message shapes, limits, references, the Payment Link client), e2e
  `commerce.spec.ts` (catalog read, products sent, order, keys, payment request, forged and signed
  notifications, paid and fulfilled). **[Order exports built; their database test runs only in CI]**
  (ADR-235: the orders a member can see as CSV, filtered by status, with `commerce.read` and
  `contacts.export`, numbers masked as for the member, erased contacts blanked, audited; no
  migration). **Remaining:** checks on an approved sandbox number and with a company's Razorpay test
  keys (release checklist), product enquiries (`referred_product`), payments inside WhatsApp
  (`order_details`, needs Meta payment configuration), writing to catalogs and stock, refunds from
  HyFib, order reports, sending products from automations.
- **P4-06b Store connectors** — _implemented and locally verified (2026-09-27) against the Shopify
  and WooCommerce stand-ins; no live store traffic yet_: companies connect Shopify stores through
  HyFib's Shopify app (a signed callback bound to the member who started it, `read_orders` and
  `read_products` only, expiring offline tokens refreshed by the worker and stored only if the
  access was not changed meanwhile) and WooCommerce stores with Read/Write keys (the approval page
  or pasted keys, proven against the entered address, sent only in the Authorization header over
  https); orders of the last 60 days and products (at most 20,000) are read into a copy kept in
  step by verified, deduplicated webhooks that only signal reads, an hourly read of what changed
  (a cursor on whole seconds with a page token within a second), six-hourly checks that re-create
  or re-enable HyFib's webhooks, one job at a time per store; amounts exact in minor units;
  customers' numbers linked to contacts in E.164 or with the company's calling code; store orders
  next to the customer's conversation; Shopify's uninstall and privacy requests (sticky
  redaction, data requests for the company to answer, shop redaction); removal that uninstalls
  HyFib or deletes its webhooks; erasure. T: `stores.test.ts` (13 tests: handshakes and their
  forgeries, webhooks, a 130-order burst in one second, lost subscriptions, token refresh and a
  refresh racing a credential change, throttling, withheld data, a signal during a read, uninstall
  and privacy requests, removal, key handover refusals, erasure, the product limit, isolation; 20
  deliberate regressions caught), unit tests (addresses, signatures, amounts, numbers, dates,
  parsers, HTTP errors), e2e `stores.spec.ts` (both platforms: approval, first read, orders and
  products, the chat panel, a webhook-driven update, removal). The GraphQL operations were
  checked against Shopify's 2026-07 and 2025-10 Admin schemas. **Remaining:** checks on a Shopify
  development store and a WooCommerce test site (release checklist), Shopify's public app review
  and protected customer data approval (docs/DEPLOYMENT.md), store customers, other platforms.
- **P4-06c Order messages** — _implemented and locally verified (2026-09-27) against the Shopify,
  WooCommerce and Graph stand-ins; no live store or WhatsApp traffic yet_ (ADR-048): per store and
  event (order placed, cash on delivery confirmation, shipped, delivered (Shopify), cancelled) a
  manager chooses an approved utility or marketing template, the number, variables filled from the
  order (number, customer, total, items, status page, tracking, store name) with fallbacks, a delay
  and, for cash on delivery, the confirm and cancel buttons; no rule can be switched on before a
  manager confirms the customers' opt-in; events come from the store copy (Shopify shipments and
  gateways read with `read_orders`, WooCommerce payment method and completion), never about the
  past and at most once per order and event; test orders and events seen over 48 hours late are
  recorded, not sent; sending hours in the company's time zone; every check again at send time
  (rule, opt-in, order, number, template, variables, suppression, erasure, opt-out, marketing
  opt-in); Shopify deliveries found by reading orders in transit again every three hours; the
  customer's cash on delivery tap recorded from that message only; a report per store, the messages
  on the order page, and contacts from store orders as a segment source. T: `stores.test.ts` (7 new
  tests; 30 deliberate regressions caught), unit tests (detection, send time, variables, payloads,
  parsers), e2e `stores.spec.ts` (a rule set up after the opt-in, a cash on delivery order sent
  with its button payloads, the customer's tap on the order page). **Remaining:** checks with a
  real store, approved templates and a WhatsApp test number (release checklist), Shopify's delivery
  timing (research SH-034).
- **P4-06d Cart reminders (Shopify)** — _implemented and locally verified (2026-09-27) against the
  Shopify and Graph stand-ins; no live store or WhatsApp traffic yet_ (ADR-049): up to two approved
  marketing templates per store remind customers about a checkout they left; checkouts read every
  15 minutes with `read_orders` (SH-037, SH-038), only those updated since the first reminder was
  switched on, with a cursor that never goes back; the number from the customer (with customer
  access and the store consent setting) or the addresses; marketing opt-in from HyFib's records or,
  when a manager allows customer access (`read_customers`, asked for only then) and turns the
  setting on, from the WhatsApp consent Shopify records (SH-041); never after the checkout was
  completed or an order with the same number was placed, never more than three days later; the
  company's marketing frequency cap for every store message with a marketing template; reminders
  sent, checkouts recovered and their value on the store's Order messages page. WooCommerce has no
  carts (WC-023). T: `stores.test.ts` (4 cart reminder tests; 52 deliberate regressions caught),
  unit tests (reminders, delays, checkout values, consent states), e2e `stores.spec.ts` (customer
  access approved in Shopify, the store consent setting, a reminder sent to a customer whose opt-in
  the store recorded, the recovery counted). **Remaining:** checks with a development store, an
  approved marketing template and a WhatsApp test number (release checklist): the staff permission
  for checkouts (SH-037), customer access on an installed store (SH-042), Shopify's consent at a
  real checkout (SH-041).
- **P4-06e Store events in automations** — _implemented and locally verified (2026-09-28) against
  the Shopify and Graph stand-ins; no live store or WhatsApp traffic yet_ (ADR-050): an order rule
  (placed, shipped, delivered on Shopify, cancelled) can start a published automation instead of
  sending its template; the "An order event in a store" trigger never matches a customer message;
  the rule's checks, then the automation, number, consent, conversation (not assigned, no other run)
  and the hourly run limit before a run starts with a reference to the order; template steps ("Send
  a template", "Ask with a template" whose quick replies are branches, with payloads bound to the
  run, step and visit) with order fields, checked again when they run (template, number, consent,
  marketing opt-in, the frequency cap under the campaign runner's company lock, tried so a busy
  lock retries the step); only templates before the customer replies, checked on every path; the
  long-wait warning only when a message that is not a template follows; the store's report, the
  order page and the run page link each other; tests with a chosen order. T: `stores.test.ts`
  (5 tests, including a keyword automation that follows up with a template after the window
  closed), unit tests `automations/templates.test.ts`, e2e `stores.spec.ts` (an order starting an
  automation whose template the customer taps); 76 deliberate regressions caught. **Remaining:**
  checks with a development store, approved templates and a WhatsApp test number (release
  checklist).
- **P4-06f Store follow-ups not built yet**: messages per shipment or on tracking changes (a rule
  fires once per order and event); cash on delivery confirmations and cart reminders starting
  automations (their answers and checks depend on their own templates); order data other than the
  fields listed (for example addresses or discount codes).

## Phase 5 — billing, wallet, platform, public API

- **P5-01 Plans & entitlements** **[built, locally verified]** (ADR-051): platform-owner plan
  catalog of immutable versions (no hard-coded prices) with trials, grace days, seats, WhatsApp
  numbers, teams, live automations, monthly automation runs, add-ons (extra seats and numbers, run
  packs) and modules; a default trial or complimentary access for new companies; staff assignment
  with audit; a minute sweep for trial, period and grace ends with notices; restricted companies;
  limits checked where things are added (seats in SQL too) and an atomic run quota; module gating
  in permissions and workers; plan card, limit hints and banners for companies; platform plan
  screens; **[monthly API requests per plan version built, locally verified]** (ADR-061: empty
  for no limit, 0 leaves the public API out; counted atomically, refused with 429 when used up and
  403 without the API, one notice per period); **[a warning at 80% of the month's automation runs
  or API requests built, locally verified]** (ADR-062: one email per counter, marked on the plan
  card; the used-up notices now skip counters of an earlier period); **[notices in the app before
  and at a monthly limit built, locally verified]** (ADR-140: on every page of an active company,
  automation runs or API requests nearly used up (80%) or used up, for members who read billing,
  and once used up for members who read automations or manage API keys, with what stops and until
  when); **[paying for plans by
  Razorpay subscription built, locally verified against the stand-in]** (ADR-063, see P5-07);
  **[API scopes by plan built, locally verified]** (ADR-092, W-137: a version includes every API
  scope or only those chosen; requests needing another are refused with 403 `not_in_plan` whatever
  the key has, new keys cannot be given one, existing keys keep theirs and are marked);
  **[emails about plans staff set built, locally verified]** (ADR-100: the company's billing
  managers are emailed once about each plan HyFib staff set, with the plan now, its dates and
  add-ons and HyFib's reason, from the worker's minute sweep); **[emails when staff cancel a
  subscription built, locally verified]** (ADR-101, see P5-07); **[paying from the end of the trial
  built, locally verified against the stand-in]** (ADR-102, see P5-07); **[companies choose the
  plan they pay for built, locally verified against the stand-in]** (ADR-105: platform owners offer
  published versions; owners and billing managers with a recent sign-in choose one under Billing
  while on a trial or without a paid period and with no live subscription, if it holds the seats,
  numbers, teams and live automations they use, then pay for it; a trial keeps its end);
  **[companies choose their add-ons built, locally verified against the stand-in]** (ADR-106: on
  the same companies, owners and billing managers with a recent sign-in set the extra seats, extra
  WhatsApp numbers and run packs their published version sells, within its maximums, under Billing
  → Add-ons; a decrease cannot leave fewer seats or numbers than they use; then they pay for them
  with the plan); **[a price list for visitors built, locally verified]** (ADR-107: platform owners
  show the offered versions at `/pricing`, with their prices before and with the tax, what they
  include and their add-ons, for anyone who has not signed in; not found unless paying for plans,
  the tax, a default trial and a payable version are set); **[paying companies change their plan or
  add-ons from the end of the paid period built, locally verified against the stand-in]** (ADR-109:
  owners and billing managers with a recent sign-in choose an offered version, or their own, with
  its add-ons under Billing → Change plan until 48 hours before the paid period ends; the current
  subscription is cancelled at the end of its cycle first and a new one, authorised in Checkout,
  starts then and is charged for the new plan, so the two never both charge; its first paid cycle
  applies the new version and add-ons; Razorpay test-mode checks are on the release checklist);
  **[packs of extra API requests built, locally verified against the stand-in]** (ADR-110: a
  version with a monthly API request limit sells packs of a size and price, as it sells run packs;
  staff set them with the plan and companies under Billing → Add-ons and Change plan; the limit is
  the version's requests plus packs × size in admission, the plan card, the 80% warning and the
  used-up notice; limits with packs are bounded at 2,000,000,000 for run packs too, which fixed
  limits past the 32-bit range that failed every company's sweep lookups); **[usage warnings at a
  share each company chooses built, locally verified]** (ADR-144: members who manage billing choose
  50% to 95% in steps of 5 under Billing → Usage warnings, 80% until then; the sweep's email, the
  notices on every page and the plan card all warn from that share, still once per counter and
  period; API keys' own limits keep 80%).
  Remaining: changes that take effect at once and proration, plan invoices, packs bought once, and
  AI credits (Phase 6).
- **P5-02 Ledger** **[built, locally verified]**: accounts, append-only journal balanced at commit,
  balances by trigger, holds, settlements, releases (expiry sweep), refunds and chargebacks as
  compensating postings; INR paise; monthly statements computed from the ledger (ADR-057).
  Remaining: manual adjustments with dual approval. A credit adjustment breaks the rule that credit
  comes only from a captured Razorpay payment (CLAUDE.md, 0004_billing), so it needs a product decision
  before it is built.
- **P5-03 Manual top-up** **[built; Razorpay traffic simulated by a test-only stand-in]**: top-ups,
  Razorpay orders (unique receipt), Standard Checkout, webhook processing (signature, event-id and
  body dedupe, out-of-order), authoritative fetch, credit exactly once, reconciliation sweep, expiry,
  refunds, lost disputes; a receipt page per paid top-up with the method Razorpay reported, emailed
  to the billing managers (ADR-057; printable, not a tax invoice). Remaining: Razorpay sandbox
  verification.
- **P5-04 Auto-recharge** **[built; externally blocked on Razorpay Recurring Payments]**: settings
  with caps, card mandate lifecycle (₹1 authorisation refunded, token status, removal), state machine
  with write-ahead unknown states, one active attempt, caps including pending attempts,
  reconciliation before retry, cooldown, suspension after three failures, owner notices, feature
  flag `RAZORPAY_RECURRING_CARDS_ENABLED`; a recent sign-in for adding a card and turning automatic
  top-ups on or changing them (ADR-056). Remaining: "requires customer action" state if Razorpay
  reports AFA for a debit.
- **P5-05 Refunds, disputes, reconciliation runs, statements, receipts vs invoices.** Refunds and
  lost disputes are recorded from webhooks; statements and payment receipts are built (ADR-057,
  receipts are payment confirmations, not tax invoices). **[Staff refunds of unused credit built;
  Razorpay traffic simulated by a test-only stand-in]** (ADR-058): platform owners refund part or
  all of a paid top-up from the company's platform page, with a reason in the platform audit log;
  the credit is held at once, the worker asks Razorpay with an idempotency key and checks until
  Razorpay processes or fails the refund, and the refund is recorded from what Razorpay reports.
  **[Daily settlement reconciliation built; Razorpay traffic simulated by a test-only stand-in]**
  (ADR-059): each day from 06:00 India time the worker reads Razorpay's settlement report for the
  previous day and matches every transaction against HyFib's records; a captured payment or
  processed refund HyFib had missed is fetched and recorded through the usual paths, everything
  else that does not match waits on `/platform/reconciliation` for a platform owner to resolve with
  a note; paid top-ups no settlement showed 7 days after payment are listed. **[Alerts for
  reconciliation findings built, locally verified]** (ADR-066: platform owners emailed once per
  finished attempt when a day waits for a person or fails, naming days and counts only);
  **[alerts for unsettled payments built, locally verified]** (ADR-071: platform owners emailed
  once about each paid top-up no settlement showed 7 days after payment, from the same definition
  as the page's list, with counts and payment days only; the list says when). **[Refund requests
  from companies and a platform-wide refunds list built; Razorpay traffic simulated by a test-only
  stand-in]** (ADR-073): billing managers with a recent sign-in ask from a paid top-up's receipt for
  a refund of unused credit, with a reason (5 a day, one open per top-up, withdrawable); platform
  owners are emailed a count and decide on `/platform/refunds`, where approving starts the staff
  refund with every check run again and declining needs a note the company is emailed; the page
  also lists every refund across companies on exact keyset pages. Remaining: bank statement (UTR)
  matching, fee and tax accounting, and GST invoices (GST treatment needs tax review).
- **P5-06 Mandatory financial tests** **[29 integration tests + 2 e2e]**: concurrent spends on last
  funds; many low-balance triggers → one attempt; repeated and out-of-order events; timeout after
  capture (reconciliation); delayed success after UI timeout; decline; mandate revocation; cap
  exhaustion incl. in-flight; settings change during a pending charge; refund vs usage race;
  partial refunds; chargeback after spend; restart recovery; cross-company wallet access. Remaining:
  cancelled subscription with credit (plans are paid by subscription since ADR-063, but plan payments
  never touch the wallet: they are not service credit) and AFA-required debits for card mandates
  (not reachable while mandates are capped at ₹15,000).
- **P5-07 Billing screens**: overview, plans, wallet & recharge, auto-recharge, payment methods,
  usage & rate card, transactions & receipts, invoices; step-up auth for sensitive changes
  **[step-up built, locally verified]** (ADR-056: a sign-in within the last 15 minutes for the
  company export and deletion, payment settings, the company's Razorpay keys, API keys, webhook
  endpoints, new owners and turning off required two-factor); **[statements and receipts built,
  locally verified]** (ADR-057: Billing → Statements with every month since the first payment in
  the company's time zone, opening and closing balances, every ledger line with running balances,
  a printable page and an audited CSV; a receipt per paid top-up, emailed to billing managers);
  **[usage and rates built, locally verified]** (ADR-060: Billing → Usage and rates with Meta's
  rates in force for the billing currency, the next published change and what it changes, and
  this month's estimated Meta charges by pricing category, read-only, for billing managers too);
  **[paying for plans built, locally verified against the Razorpay stand-in; behind
  `RAZORPAY_SUBSCRIPTIONS_ENABLED`]** (ADR-063: Billing → Paying for your plan with the price, add-ons
  and the tax platform owners set; owners and billing managers with a recent sign-in start a Razorpay
  subscription (written ahead, Razorpay plan and subscription, Checkout), and the plan becomes
  active for each cycle Razorpay reports paid, fetched and checked by HyFib (Checkout, webhooks,
  hourly and daily checks, before period ends); failed charges, stopped retries, cancelling at the
  end of the period, staff cancelling at once, deletion cancelling at Razorpay, plan payments in
  the daily reconciliation); **[plan payment receipts built, locally verified]** (ADR-064: a receipt page per plan payment with the plan, add-ons, billing period and tax, not a tax invoice, linked from Billing and the payment email); **[rate change notices built, locally verified]** (ADR-065: billing managers emailed once when a published card for the company's billing currency takes effect within 7 days, with what it changes); **[emails when staff cancel a subscription built, locally verified]** (ADR-101: the company's billing managers are emailed once when a platform owner cancels its subscription, with HyFib's reason and what the plan keeps, from the worker's minute sweep); **[paying from the end of the trial built, locally verified against the stand-in]** (ADR-102: a trial ending at least 48 hours ahead is paid from its end; Checkout only authorises, Razorpay charges the first cycle when the trial ends, and the ended trial waits for that charge for the plan version's grace days); **[refunds of plan payments built, locally verified against the stand-in]** (ADR-103: platform owners refund part or all of a plan payment from the company's platform page with a reason; the worker asks Razorpay with an idempotency key and the request in the notes, refunds made in the Dashboard are recorded from the webhook or the daily reconciliation, the receipt and Billing show them, and the plan does not change); **[refund requests of plan payments built, locally verified against the stand-in]** (ADR-104: billing managers with a recent sign-in ask from a plan payment's receipt, with one daily limit shared with requests of service credit; platform owners approve, which starts the refund of ADR-103 with every check run again, or decline with a note the billing managers are emailed; `/platform/refunds` lists requests and every refund of plan payments across companies); **[choosing the plan to pay for built, locally verified against the stand-in]** (ADR-105, see P5-01: Billing → Choose a plan lists the versions platform owners offer with what each would cost with the company's add-ons and the tax, and what it holds less of); **[choosing add-ons built, locally verified against the stand-in]** (ADR-106, see P5-01: Billing → Add-ons with each add-on's price and bounds, and the total as the quantities change); **[a price list for visitors built, locally verified]** (ADR-107, see P5-01: `/pricing` with the offered versions, shown and hidden by platform owners); **[changing the plan or add-ons a subscription pays for, from the end of the paid period, built, locally verified against the stand-in]** (ADR-109, see P5-01: Billing → Change plan, a new subscription that follows the current one, and the next subscription on Billing and the platform company page); **[API request packs on the billing screens built, locally verified against the stand-in]** (ADR-110, see P5-01: the plan card with the limit the packs raise, Add-ons, Change plan, the payment card and receipts). Remaining: invoices (tax review), plan and add-on changes at once with proration, pausing,
  offers, Razorpay test-mode checks (RELEASE-CHECKLIST).
- **P5-08 Public API** **[built, locally verified; sends through the Graph stand-in only]**
  (ADR-052): company API keys (SHA-256 only, scopes granted within the creator's permissions,
  expiry, rotation with an overlap, revocation, audit), `/api/v1` with approved template sends,
  contacts (cursor pages, create or existing), consent with evidence and message status; idempotency
  keys, per-key, per-company and failed-authentication rate limits, 64 KB bodies, an OpenAPI 3.1
  document from the validation schemas, Settings → API keys; monthly API requests and API access
  by plan (ADR-061, see P5-01); **[reminders before keys expire built, locally verified]** (ADR-067:
  owners and administrators emailed once, 7 days before a usable key that was not rotated expires,
  with its name and prefix, never a token; marked on Settings → API keys); **[rate limits tested,
  full buckets deleted, locally verified]** (ADR-068: integration tests of the buckets and each
  limit, an e2e burst refused with 429; buckets full again deleted every minute, so failed-
  authentication addresses are kept only while they limit); **[text replies built, locally
  verified against the Graph stand-in]** (ADR-070: a `messages.reply` key sends free-form text to a
  contact who wrote to the number in the last 24 hours, refused otherwise with one answer; it ends a
  running automation and marks the message with its key, and the customer keeps waiting for a
  member); **[conversation and message reads built, locally verified]** (ADR-072: a
  `conversations.read` key, granted only by members who read every conversation, lists the
  company's conversations by status, contact, number and time of change, reads one, and pages its
  messages in the webhooks' words; erased contacts' conversations are hidden; keyset cursors now
  keep PostgreSQL's microseconds, which fixed rows skipped at page ends in the contacts list and
  export, API contacts, the inbox thread and the audit log); **[resolving and reopening
  conversations built, locally verified]** (ADR-075: a `conversations.write` key, granted only by
  owners, administrators and supervisors, resolves or reopens a conversation as the inbox does,
  under its row lock: the automation stops, the reply turn and case close, the webhook fires; audited
  as the key, no satisfaction survey, no member credited); **[networks per key built, locally
  verified]** (ADR-076: up to 20 IPv4 or IPv6 networks a key accepts requests from, checked in the
  lookup before the key is marked used, 403 `ip_not_allowed` counted as a failed authentication,
  set at creation, copied on rotation, changed with a recent sign-in and audited); **[starting
  automations built, locally verified against the Graph stand-in]** (ADR-077, W-086: an
  `automations.start` key, granted only by owners and administrators, starts a published automation
  whose trigger is "Started through the API" for one contact with the inputs it declares, once per
  `Idempotency-Key`, with an order rule's checks and a reason for each refusal; templates until the
  contact replies, from the automation's one number; the run records its key, its inputs are kept
  and cleared with its answers, and keys read the runs they started); **[stopping runs built,
  locally verified]** (ADR-079: the same scope stops a run keys started, as `stopped_by_api`,
  cancelling what it queued without handing the conversation to people; an ended run is answered as
  it is); **[buttons and lists built, locally verified against the Graph stand-in]** (ADR-080: a
  `messages.reply` key also sends up to 3 reply buttons or a list of up to 10 rows to a contact who
  wrote in the last 24 hours, within Meta's limits and with its own ids, never HyFib's `w360…`; taps
  come back with `reply.type` and a row's description); **[webhook endpoints through the API
  built, locally verified]** (ADR-081, W-139: a `webhooks.manage` key, granted only by owners and
  administrators, adds, reads, changes, rotates the secret of and deletes the endpoints keys added,
  never members' ones; secrets shown once and never kept for replays; owners and administrators
  emailed about each endpoint a key adds); **[quotes and reactions built, locally verified against
  the Graph stand-in]** (ADR-082: a text, buttons or a list may quote a message of the conversation
  with `replyTo`, and a `messages.reply` key reacts with one emoji to a message the contact sent in
  the last 30 days, without ending an automation; the API, the `message.received` webhook and the
  inbox name the message a message quotes, reacts to or taps a button of); **[webhook deliveries
  through the API built, locally verified; delivered to local test receivers only]** (ADR-083: the
  same `webhooks.manage` key pages the deliveries of the endpoints keys added, reads one, sends a
  test event and replays a finished delivery, once per `Idempotency-Key`; deliveries say how
  sending went, never a body); **[notes built, locally verified]** (ADR-084: a
  `conversations.write` key adds internal notes to a conversation, once per `Idempotency-Key`,
  named as the key's in the inbox and never sent to WhatsApp; a note sent while the contact is being
  erased waits for the erasure and is refused); **[product messages built, locally verified]**
  (ADR-086: `product`, `product_list` and `catalog` replies under `messages.reply`, products named
  by content id in the sending number's catalogs, Commerce in the plan); **[message feed built,
  locally verified]** (ADR-088: `GET /messages` pages every conversation's messages newest first
  under `conversations.read`, with the contact and number, filtered by direction, number and time;
  each page reads at most 2,000 messages, so filters give short pages rather than slow ones);
  **[reading notes built, locally verified]** (ADR-089: the same scope reads a conversation's
  notes newest first, members' and keys' alike, never naming members or mentions); **[assigning
  and moving conversations built, locally verified]** (ADR-093: `conversations.write` gives a
  conversation to a member who can answer it, unassigns it or moves it to a team, routed as the
  inbox routes it; `conversations.read` lists those members, by name, and the teams; conversations
  name their member and team by id; the inbox now offers and accepts only such members too);
  **[monthly limits per key built, locally verified]** (ADR-097: every admitted request is counted
  for its key in the company's usage period, and a key may have its own monthly limit, set at
  creation and changed after a recent sign-in; a request its key refuses (429
  `key_quota_exceeded`) counts for neither the key nor the company, nor one the company refuses;
  Settings → API keys shows each key's requests this period); **[emails about a key's limit
  built, locally verified]** (ADR-098: owners and administrators are emailed once at 80% of a key's
  own limit and once at the limit, in each period, and again after the limit changes); **[addresses
  for all keys built, locally verified]** (ADR-099: owners and administrators list up to 20 networks
  every key of the company accepts requests from, on top of each key's own); **[packs of extra API
  requests built, locally verified against the stand-in]** (ADR-110, see P5-01: they raise the
  company's monthly limit, never a key's own); **[custom fields and contact changes built, locally
  verified]** (ADR-112: every contact the API returns carries the values of the company's custom
  fields, typed; `GET /contact-fields` lists the fields; `POST /contacts` sets them on a new contact
  and fills an existing one's empty ones; `PATCH /contacts/{id}` changes the name, email, field
  values and tags of a contact under its row lock, each value checked strictly against its field's
  type and a refusal saving nothing; the 50-tag limit now holds through `POST /contacts` too);
  **[finding contacts built, locally verified]** (ADR-113: `GET /contacts` by email, tag and up to 5
  custom field values, typed, all of which a contact must match; pages filtered by tag or field read
  at most 2,000 contacts and never skip or repeat one); **[following contact changes built, locally
  verified]** (ADR-114: `GET /contact-changes` reads every contact once, as it is now, in the order
  its changes were saved (name, number, email, field values, tags, consent, added, erased), from the
  start or from a cursor sealed to the company; changes are recorded by triggers in the transactions
  that make them and read only once every transaction begun before them has finished, so following
  the cursor misses none; the minute sweep deletes the records later changes replaced);
  **[defining contact fields built, locally verified]** (ADR-115: a key with
  `contact_fields.manage`, granted only by owners and administrators, adds, renames and deletes the
  company's custom fields by key, as Settings does, through the same functions; key and type never
  change; additions take turns under a lock, so the 50-field limit holds for members and keys at
  once; renames are audited, in Settings too); **[following message changes built, locally
  verified]** (ADR-116: `GET /message-changes` reads every message once, as it is now, in the order
  its changes were saved (received or sent, its status, status time or error, its contact erased),
  from the start or from a cursor sealed to the company and the feed; the trigger on messages moves
  each message's one row to the transaction that changed it, so following the cursor misses no
  status and nothing needs compacting); **[searching contacts with segment conditions built,
  locally verified]** (ADR-117: `POST /contacts/search` finds contacts with segments' conditions,
  compiled by segments' code: custom field comparisons, tags, consent, the creation day in the
  company's time zone, source and calling code, all or any of them, on the pages `GET /contacts`
  reads; refusals name the condition's part). **[Changing many conversations in one call built,
  locally verified]** (ADR-120: `POST /conversations/update-many` assigns, moves, resolves or reopens
  up to 100 conversations, each as `PATCH` changes one, all of them or none, locked in id order).
  **[Changing many contacts in one call built, locally verified]** (ADR-122:
  `POST /contacts/update-many` changes the name, email, custom field values and tags of up to 100
  contacts, each as `PATCH` changes one, all of them or none, the fields locked first and the
  contacts in id order).
  **[Finding contacts by name built, locally verified]** (ADR-124: `name` on `GET /contacts` finds
  contacts whose name contains a text whatever its case, as members' search does, the text taken as
  written, on the windowed pages of the other filters; a request whose query string or body holds
  the NUL character is refused with 422 naming where, instead of failing in the database).
  **[Reading campaigns built, locally verified]** (ADR-125: a new reading scope, `campaigns.read`,
  lists the company's campaigns newest first, in one status or all, and reads one with its results
  counted when read as its page counts them: recipients by state, messages sent, delivered, read and
  failed, replies, opt-outs, skip reasons and failure codes; counts only, no recipients, members or
  costs; migration 0099).
  **[Conversation and campaign conditions in contact searches built, locally verified]** (ADR-126:
  `POST /contacts/search` takes segments' `last_message` condition with `conversations.read` and
  `campaign` condition with `campaigns.read`, finding the contacts a segment with the same
  conditions finds).
  **[Name conditions in contact searches built, locally verified]** (ADR-143:
  `POST /contacts/search` and segments take a `name` condition with a text field's comparisons, the
  whole name compared whatever its case, `contains` taking the text as written, a name of spaces
  only counted as none).
  **[A campaign's recipients built, locally verified]** (ADR-127: `GET /campaigns/{id}/recipients`
  lists a campaign's recipients with what happened to each one's message, with `campaigns.read` and
  `contacts.read`, by the outcomes its results count, erased contacts left out).
  **[Pausing and cancelling campaigns built, locally verified]** (ADR-128: a new writing scope,
  `campaigns.stop`, granted by `campaigns.send`, pauses a scheduled or running campaign and cancels
  one that has not finished, as members do, the key named in the campaign's history and the audit;
  resuming stays with members; migration 0100).
  **[What was left out of a message built, locally verified]** (ADR-132: every message says
  `contentTooLarge` when WhatsApp sent more than a message may hold, so its content was not kept,
  and `contactsLeftOut` when a contact card left contacts out; the same in `message.received`).
  **[An API reference page built, locally verified]** (ADR-152, W-140: `/developers`, for anyone,
  shows the OpenAPI document the API serves, each operation, webhook event and schema once, with
  named types, limits, allowed values and defaults, the fields inside fields and the shapes of
  unions, as text; linked from Settings → API keys and Settings → Webhooks).
  **[Starting an automation for many contacts built; its database tests run only in CI]** (ADR-161:
  `POST /automations/{id}/runs/start-many` starts an automation for up to 50 contacts, each with its
  own inputs, in the order given, each start with a start's checks in a savepoint, so a start
  refused for its contact is answered in its place and changes nothing while the others start;
  numbers that are not valid or given twice and inputs the automation does not take refuse the
  call).
  **[Stopping many runs built; its database tests run only in CI]** (ADR-162:
  `POST /automation-runs/stop-many` stops up to 100 runs keys started, each as one stop does, all of
  them or none: an id that names no run a key of the company started refuses the call, naming its
  place; the conversations are locked in id order).
  **[Sending a template to many numbers built; its database tests run only in CI]** (ADR-163:
  `POST /messages/send-many` sends one approved template to up to 50 numbers, each with its own
  values and each checked as one send is, in a savepoint, so a refused number is answered in its
  place and changes nothing while the others are sent; numbers that are not valid or given twice and
  values that do not fill the variables refuse the call).
  **[Groups of conditions in contact searches built; their database tests run only in CI]**
  (ADR-164: `POST /contacts/search` takes groups of conditions a contact matches together, all of a
  group's conditions or any, one level deep, 20 conditions in all; a refusal inside a group names
  its place).
  **[Changing the contacts a search finds built; its database tests run only in CI]** (ADR-165:
  `POST /contacts/update-matching` changes the contacts of one search page per call, each as
  `PATCH /contacts/{id}` changes one, custom field values and tags only, in one snapshot; it needs
  `contacts.read` and `contacts.write`).
  **[Changing the conversations a filter finds built; its database tests run only in CI]** (ADR-166:
  `POST /conversations/update-matching` changes the conversations of one page of
  `GET /conversations` per call, at least one filter, each as `PATCH` changes one, with the filter
  checked again under the rows' locks; it needs `conversations.read` and `conversations.write`).
  **[Reading WhatsApp orders built; its database tests run only in CI]** (ADR-167: `GET /orders` and
  `GET /orders/{id}` with the new `orders.read` scope, granted with `commerce.read`, and Commerce in
  the plan: the orders customers send from the catalog, newest first on exact pages, filtered by
  status, contact, conversation, reference or time of change, with their items, amounts in minor
  units and ids only, never Payment Links; migration 0115).
  **[Changing WhatsApp orders built; its database tests run only in CI]** (ADR-168:
  `PATCH /orders/{id}` with the new `orders.write` scope, granted with `inbox.reply`, and Commerce
  in the plan: an order confirmed, fulfilled or cancelled as members move it, from an expected
  status when one is given, payment statuses left to Razorpay; a retry changes nothing; migration
  0116).
  **[Asking for payment of WhatsApp orders built; its database tests run only in CI]** (ADR-283,
  migrations 0202 and 0203: `POST /orders/{id}/request-payment` and
  `POST /orders/{id}/cancel-payment` with the new `orders.request_payment` scope, granted with
  `inbox.reply`, and Commerce in the plan: a Payment Link for the order's total from the company's
  own Razorpay account, sent in the chat as the key, and cancelled, as members do; only Razorpay's
  report marks an order paid).
  **[Reading an order's Payment Links built; its database tests run only in CI]** (ADR-284, no
  migration: `GET /orders/{id}/payment-links` with `orders.read` gives an order's links newest first
  on exact pages, each with its status, amounts, expiry, the message that sent it or why it was not
  sent, and who asked, never its address or Razorpay's ids).
  **[Who last changed an order, through the API, built; its database and browser tests run only in
  CI]** (ADR-271, no migration: `GET /orders`, `GET /orders/{id}` and the answer of
  `PATCH /orders/{id}` name who made an order's latest status change, a member, a key by its id or
  the Payment Link, as `order.status_changed` does since ADR-270).
  **[Listing the tags in use built; its database tests run only in CI]** (ADR-272, no migration:
  `GET /contact-tags` with `contacts.read` and `GET /conversation-tags` with `conversations.read`
  list the company's tags alphabetically with how many contacts or conversations have each, on pages
  that continue after the last tag, narrowed by a prefix).
  **[Reading CRM notes built; its database tests run only in CI]** (ADR-279, migrations 0198 and
  0199: `notes.read`, granted with `crm.read`, for `GET /notes` and `GET /notes/{id}`: members' and
  keys' notes newest first on exact pages, by contact, deal and time, each saying whether a member
  or a key wrote it, a key by its id, never which member; never the rest of the timeline).
  **[Who last changed a deal or task, through the API, built; its database tests run only in CI]**
  (ADR-278, no migration: `GET /deals`, `GET /tasks`, their single reads and the answers of their
  writes name who made a deal's or task's latest change, a member, an automation or a key by its id,
  as the deal and task events do since ADR-277).
  **[Who added a deal or task, through the API, built; its database tests run only in CI]**
  (ADR-282, no migration: deals and tasks read and answered through the API name who added them, a
  member, an automation or a key by its id, as `deal.created` and `task.created` do).
  **[Reading WhatsApp numbers built; its database tests run only in CI]** (ADR-171: `GET /channels`
  with the new `channels.read` scope, granted with the permission of the same name: every number of
  the company oldest first on exact pages, filtered by status, with its number, verified name and
  status and the id the rest of the API names it by, never Meta's ids; migration 0119).
  **[Resuming the campaigns keys paused built; its database tests run only in CI]** (ADR-176:
  `POST /campaigns/{id}/resume` with the new `campaigns.resume` scope, granted with
  `campaigns.send`: a campaign a key paused runs again after members' checks, under the
  authority of the member who launched it, who must still be allowed to send campaigns; what
  members or HyFib paused stays with members; migration 0124).
  **[Changing typed numbers built; its database tests run only in CI]** (ADR-180:
  `PATCH /contacts/{id}` takes `phone` and changes a number as members do: one WhatsApp gave
  stays, one another contact has or one on the suppression list is refused; only that call
  changes numbers; no migration).
  **[Creating and editing campaign drafts built; its database tests run only in CI]** (ADR-186:
  `POST /campaigns` and `PATCH /campaigns/{id}` with the new `campaigns.write` scope, granted with
  `campaigns.write`: a draft's settings as members edit them, checked as members' are, with a
  version; members submit and start it; migration 0134).
  **[Cancelling campaign drafts built; its database tests run only in CI]** (ADR-187:
  `POST /campaigns/{id}/cancel` cancels a draft for a key holding `campaigns.write`, as members
  cancel drafts; anything else still needs `campaigns.stop`; no migration).
  **[Changing typed numbers in calls that change many contacts built; its database tests run only in
  CI]** (ADR-188: `POST /contacts/update-many` takes `phone` for each contact, as `PATCH` does;
  every number must be free before the call and is given once, so a call never swaps or moves
  numbers, and a refusal names its place; no migration).
  **[Reviewing campaign drafts built; its database tests run only in CI]** (ADR-193:
  `GET /campaigns/{id}/review` answers a draft's review as members see it, for a key holding
  `campaigns.write`: what blocks it, who it would reach and an upper bound of its cost; no
  migration).
  **[Sending media from links built; its database tests run only in CI]** (ADR-194: a key replies
  with a photo, a video, audio or a document WhatsApp fetches from an https link, with a caption
  except for audio, within the 24-hour window; HyFib keeps the link, never the media; no migration).
  **[Sending locations built; its database tests run only in CI]** (ADR-195: a key replies with a
  place's coordinates, and its name and address if wanted, within the 24-hour window, sent as Meta's
  spec types them; no migration).
  **[Contact cards' contacts built; their database tests run only in CI]** (ADR-196: every message
  the API gives, and `message.received`, carry a contact card's contacts as WhatsApp gave them,
  every part optional; the inbox shows their names and numbers; no migration).
  **[Sending contact cards built; its database tests run only in CI]** (ADR-197: a key shares 1 to 5
  contacts as Meta's spec describes them, each part checked, within the 24-hour window; kept as
  received cards are, so reads give them back; no migration).
  **[Sending stickers from links built; its database tests run only in CI]** (ADR-198: a key replies
  with a sticker WhatsApp fetches from an https link, without a caption; no migration).
  **[Sending templates with a photo, video or document header built; its database tests run only in
  CI]** (ADR-201: a key gives the header's file by https link in each send, which WhatsApp fetches;
  the inbox, campaigns and automations still cannot send them, and say why; no migration).
  **[Submitting campaign drafts built; its database tests run only in CI]** (ADR-202: a key submits
  a draft with members' checks, and the submission always waits for a member's approval, who must be
  able to send campaigns and under whose authority it sends; migrations 0140 and 0141).
  **[Withdrawing a key's submission built; its database tests run only in CI]** (ADR-203: the key
  that submitted a campaign takes it back to a draft at a new version while it waits for approval;
  no migration).
  **[Emailing approvers of a waiting campaign built; its database tests run only in CI]** (ADR-204:
  the company's owners and administrators other than the submitter are emailed when a member's or a
  key's submission waits for approval, in the submission's transaction; no migration).
  **[Telling the submitter what the approver did built; its database tests run only in CI]**
  (ADR-205: the member who submitted a campaign is emailed when an approver approves it, sends it
  back with a note or takes it back; no migration).
  **[Reading saved segments built; its database tests run only in CI]** (ADR-206: `GET /segments`
  and `GET /segments/{id}` with `campaigns.read` give the company's segments with their conditions
  in the API's words, why one cannot be used and how many contacts one matches now; no migration).
  **[Writing saved segments built; its database tests run only in CI]** (ADR-207: `POST /segments`,
  `PATCH /segments/{id}` and `DELETE /segments/{id}` with `campaigns.write` create, change and
  archive segments as members do, with conditions checked as searches are; a name another segment
  has is refused with words that say so, for members too; no migration).
  **[Listing a segment's contacts built; its database tests run only in CI]** (ADR-208:
  `GET /segments/{id}/contacts` gives the contacts a segment holds now, on the pages of
  `POST /contacts/search`, with the scopes a search with its conditions needs; no migration).
  **[Saying until when a waiting campaign can be approved built; its database tests run only in
  CI]** (ADR-209: the approval email and the campaign's page give the end of its sending period,
  after which approving is refused, and the page then offers no Approve button; no migration).
  **[Downloading the files customers send built; its database and browser tests run only in CI]**
  (ADR-217: `GET /messages/{id}/media` gives a key that reads conversations the file of a message a
  customer sent, as WhatsApp gives it, with reasons when it cannot; no migration).
  **[Uploading files to send by id built; its database and browser tests run only in CI]** (ADR-219,
  migrations 0143 and 0144: `POST /media` uploads a file for a number, which `POST /messages` sends
  as `mediaId` from that number for 30 days).
  **[Conversation tags through the API built; their database and browser tests run only in CI]**
  (ADR-221: conversations carry `tags`, `GET /conversations` filters by `tag`, and the three calls
  that change conversations take `addTags` and `removeTags`; no migration).
  **[Merging contacts through the API built; its database tests run only in CI]** (ADR-227,
  migration 0153: `POST /contacts/{id}/merge` with the `contacts.merge` scope merges a contact into
  another as owners and administrators do, answering the kept contact and what moved).
  **[Website buttons whose link ends with a value built; their database and browser tests run only
  in CI]** (ADR-228: GET /templates gives each such button's link in `links` and how many values a
  send gives in `variables.buttons`; a send gives the end of each link in `variables.buttons`).
  **[Campaign drafts take the ends of links; their database tests run only in CI]** (ADR-229:
  `variables.buttons`, one source per link, as members choose them).
  **[Reading CRM pipelines and deals built; its database and browser tests run only in CI]**
  (ADR-253, migrations 0167 and 0168: `GET /pipelines`, `GET /deals` and `GET /deals/{id}` with the
  new `deals.read` scope, granted with `crm.read`, and the CRM in the plan: pipelines with their
  stages and chances, deals newest first on exact pages, filtered by pipeline, stage, status,
  contact, owner or time of change, values in minor units and ids only).
  **[Creating CRM deals built; its database and browser tests run only in CI]** (ADR-254, migrations
  0169 and 0170: `POST /deals` with the new `deals.write` scope, granted with `crm.write`, and the
  CRM in the plan: a deal for a contact in an active stage, as members create one, recorded as
  created through the API, with an optional `Idempotency-Key`).
  **[Changing CRM deals built; its database and browser tests run only in CI]** (ADR-255:
  `PATCH /deals/{id}` with `deals.write` reopens, moves, edits and closes a deal as members do, from
  an `expectedVersion` when given, recorded as done through the API; deals carry `version`; no
  migration).
  **[Moving CRM deals to another pipeline built; its database tests run only in CI]** (ADR-257:
  `pipelineId` on `PATCH /deals/{id}` moves an open deal to another active pipeline, to `stageId` or
  its first active stage, a deal with a value only to a pipeline of its currency, as members move
  deals; no migration).
  **[Reading a deal's history built; its database tests run only in CI]** (ADR-281:
  `GET /deals/{id}/history` with `deals.read` gives the changes the deal events report, newest first
  on exact pages, each with who made it, a key by its id and never which member; never notes or
  tasks; no migration).
  **[Managing CRM pipelines built; its database tests run only in CI]** (ADR-286, migrations 0206
  and 0207: `POST /pipelines` and `PATCH /pipelines/{id}` with the new `pipelines.manage` scope,
  granted with `tenant.settings.manage`, add pipelines with their stages and chances, rename them,
  change their stages, and archive and restore them through the Settings writes, recorded as the
  key's; pipelines carry `version`, `createdBy` and `createdByApiKeyId`).
  **[Managing teams built; its database tests run only in CI]** (ADR-287, migration 0208:
  `GET /teams/{id}`, `POST /teams`, `PATCH /teams/{id}` and `DELETE /teams/{id}` with the new
  `teams.manage` scope, granted with `inbox.supervise`, read, add, change and delete teams with
  their settings, members and numbers through the Settings writes, recorded as the key's; a team's
  members are only those who answer conversations, in Settings too).
  **[A pipeline's forecast through the public API built; its database tests run only in CI]**
  (ADR-288, no migration: `GET /pipelines/{id}/forecast` with `deals.read` gives the pipeline's open
  deals by expected close month in the company's time zone, weighed by each stage's chance with
  Reports' reader and arithmetic).
  **[Setting members' availability built; its database tests run only in CI]** (ADR-289, migration
  0209: `PATCH /members/{id}` with the new `availability.write` scope, granted with `inbox.assign`,
  sets whether a member takes the conversations routing gives out, through the write Settings uses,
  which now locks the member's row; recorded as the key's).
  **[Business hours through the public API built; its database tests run only in CI]** (ADR-290,
  migration 0210: `business_hours.read` reads the week, whether the company is open now, and its
  closed days a year at a time; `business_hours.manage`, granted with `tenant.settings.manage`, also
  sets the week and adds and removes closed days, through the checks and writes Settings uses,
  recorded as the key's).
  **[Saved replies through the public API built; its database tests run only in CI]** (ADR-291,
  migrations 0211 and 0212: `saved_replies.manage`, granted with `inbox.supervise`, lists, adds,
  changes and deletes the company's saved replies through the checks and writes Settings uses,
  recorded as the key's, and keys with `messages.reply` read them; a company keeps at most 500).
  **[Satisfaction surveys through the public API built; its database tests run only in CI]**
  (ADR-292, no migration: keys with `conversations.read` list the company's satisfaction surveys
  newest first on exact pages, skipped, asked or answered with the score, by conversation, status
  and time, without erased contacts' conversations).
  **[Templates of every status through the public API built; its database tests run only in CI]**
  (ADR-294, no migration: keys with `templates.read` list the company's templates newest first on
  exact pages, drafts, those Meta reviews, rejected, paused, disabled and, when asked, deleted ones,
  by status, number and name, and read each with its latest 50 status changes).
  **[Template drafts through the public API built; their database tests run only in CI]** (ADR-295,
  migrations 0216 and 0217: `templates.write` adds drafts for a number's account, changes their
  content from a version and deletes drafts Meta never received, through the Templates page's
  writes, recorded as the key's).
  **[Template submission and deletion at Meta through the public API built; their database tests run
  only in CI]** (ADR-296, migration 0218: `templates.submit` submits drafts to Meta for review and,
  with `templates.write`, deletes templates Meta has, through the Templates page's writes, the
  requests to Meta queued with the change).
  **[Reports through the public API built; their database tests run only in CI]** (ADR-297,
  migration 0219: `reports.read` reads the numbers the Reports page shows for a period, by the
  page's reader in one snapshot, with members by id and name).
  **[Flows and their responses through the public API built; their database tests run only in CI]**
  (ADR-298, migrations 0220 and 0221: `flows.read` lists the company's flows and the forms customers
  completed with them, newest first on exact pages; who completed them and what they typed only with
  `contacts.read`).
  **[Reading chat links through the public API built; its database tests run only in CI]** (ADR-299,
  migration 0222: `chat_links.read` lists the company's chat links newest first on exact pages and
  reads each one with its clicks per day, counted as the Growth pages count them).
  **[Writing chat links through the public API built; its database tests run only in CI]** (ADR-300,
  migrations 0223 and 0224: `chat_links.write` adds links on the company's active numbers, changes,
  archives and restores them through the Growth pages' writes, recorded as the key's).
  **[Where conversations came from, through the public API, built; its database tests run only in
  CI]** (ADR-301, no migration: conversations give their latest source, a chat link or a
  click-to-WhatsApp ad, as the inbox shows it, and are listed and changed by source and chat link).
  **[Click-to-WhatsApp ads through the public API built; its database tests run only in CI]**
  (ADR-302, migration 0225: `ads.read` lists the ads customers wrote from in the last 30 days as
  Growth → Ads lists them, by the page's reader, and `GET /conversations` finds an ad's
  conversations by `adId`).
  **[Reading CRM tasks built; its database tests run only in CI]** (ADR-258, migrations 0173 and
  0174: `tasks.read` lists the company's tasks newest first on exact pages, filtered by status,
  assignee, contact, deal and time, and reads each one, with the reminder and the assignee, contact
  and deal by id; needs the CRM in the plan).
  **[Creating CRM tasks built; its database tests run only in CI]** (ADR-259, migrations 0175 and
  0176: `tasks.write` creates tasks as members do, about a contact, a deal or nobody, with an
  assignee, notes, a due time and an emailed reminder, recorded as created through the API).
  **[Changing CRM tasks built; its database tests run only in CI]** (ADR-260: `PATCH /tasks/{id}`
  edits an open task's details, completes, cancels and reopens tasks as members do, from an expected
  version, recorded as done through the API; no migration).
  **[Adding CRM notes built; its database tests run only in CI]** (ADR-268, migration 0184:
  `notes.write` adds a note to a contact's or a deal's timeline as members do, recorded as written
  through the API; notes are not read through the API).
  Remaining: call-to-action messages through the API, taking
  reactions back,
  changing a field's type,
  which fields of a contact changed in the contact feed (webhooks name them since ADR-121),
  resuming what members or HyFib paused, campaign
  recipients through webhooks, limits per endpoint, availability per single endpoint (plans choose
  per scope since ADR-092). The one-argument key lookup kept for rolling deploys (0051) is dropped
  (0074). Replaying many deliveries in one call is built with P5-09 (ADR-095).
- **P5-09 Outgoing webhooks** **[built, locally verified; delivered to local test receivers only]**
  (ADR-053): up to 10 endpoints per company (`developer.manage`) for `message.received`,
  `message.status`, `consent.changed` and `template.status_changed`, captured by database triggers
  in the company's scope; payloads built when delivered (erased contacts without personal data);
  HMAC-SHA256 signatures with secrets shown once, encrypted and rotated with a 24-hour overlap;
  delivery through the egress guard with leases, eight attempts over about 45 hours, interrupted
  attempts retried (at least once), automatic disabling after 72 hours of failures with an email,
  delivery history, replays, test events, 30-day retention, the OpenAPI `webhooks` section.
  **[Conversation and contact events built, locally verified]** (ADR-074:
  `conversation.status_changed`, `conversation.assignment_changed` (whether a member is assigned,
  never who), `contact.created`, `contact.updated` (name, number, email, tags) and `contact.erased`,
  one contact event per contact and transaction, erasure sending only `contact.erased` with no
  personal data). **[Automation run events built, locally verified]** (ADR-078:
  `automation.run_started` and `automation.run_ended` for live runs, whatever started them, with
  what started the run, the API key for runs started through the API, the status and end reason;
  test runs send nothing; no answers or inputs). **[Endpoints, deliveries, test events and replays
  through the API built, locally verified]** (ADR-081, ADR-083: for the endpoints API keys add; see
  P5-08). **[WhatsApp order events built, locally verified]** (ADR-085: `order.received` with the
  cart, amounts in minor units and the customer's note, and `order.status_changed` with the status
  before it, whoever changes it, Razorpay's payment through the worker included; no Payment Link or
  payment details). **[Campaign events built, locally verified]** (ADR-087:
  `campaign.status_changed` for every status change, by members or the runner, with the status
  before it and why it paused or completed; counts only, no recipients or members). **[Member and
  team ids in conversation events built, locally verified]** (ADR-094: `conversation.assignment_changed`
  for every change of the member with the member before and after, a new
  `conversation.team_changed` for every change of the team, whoever makes it, a team's deletion
  included; ids as `GET /members` and `GET /teams` list them, no names or emails; stamped with the
  time each change is captured). **[Replaying an endpoint's failed deliveries in one call built,
  locally verified]** (ADR-095: every event whose deliveries to an endpoint that is on all failed
  since a chosen time, 500 at most per call, oldest first, each once, from Settings → Webhooks or
  `POST /webhook-endpoints/{id}/replay-failed`; events delivered or waiting, gone events and test
  events left out; audited once per call). **[Custom field changes built, locally verified]**
  (ADR-112: `contact.updated` also for a change of a custom field's value, whoever makes it, once per
  contact and transaction; the contact carries its `fields`; a field's deletion or rename sends
  nothing). **[Endpoint headers built, locally verified]** (ADR-118: up to 5 headers an endpoint's
  receiver asks for, such as an `Authorization` header it issued, given in Settings or through the
  API, sent with every attempt, test event and replay; values sealed and never shown, logged,
  audited or exported; names HyFib or the transport sets refused). **[Message status filters built,
  locally verified]** (ADR-119: an endpoint takes only the `message.status` statuses it chooses, in
  Settings or through the API, or every status as before; applied where events are captured, so a
  status no endpoint takes is not recorded). **[What a contact change changed built, locally
  verified]** (ADR-121: `contact.updated` names what its transaction changed, `name`, `phone`,
  `email`, `tags` and `fields.<key>`, never a value; null for events captured before). **[Contact
  part filters built, locally verified]** (ADR-123: an endpoint takes `contact.updated` only for
  the parts it chooses, `name`, `phone`, `email`, `tags` and `fields`, in Settings or through the
  API, or every change as before; applied where events are captured, a later change in the
  transaction queuing the endpoints it newly concerns). **[What was left out of a message built,
  locally verified]** (ADR-132: `message.received` says `contentTooLarge` and `contactsLeftOut`,
  as the API does; bodies are built when delivered, so replays of earlier events say them too).
  **[Automation filters built, locally verified]** (ADR-145: an endpoint takes
  `automation.run_started` and `automation.run_ended` only for the automations it chooses, up to
  20 of the company's published automations, in Settings or through the API, or every
  automation's runs as before; applied where events are captured, so a run no endpoint takes is not
  recorded). **[Campaign status filters built, locally verified]** (ADR-146: an endpoint takes
  `campaign.status_changed` only for the statuses a campaign reaches that it chooses, in Settings
  or through the API, or every status as before; applied where events are captured, so a change no
  endpoint takes is not recorded). **[Order status filters built, locally verified]** (ADR-147: an
  endpoint takes `order.status_changed` only for the statuses an order reaches that it chooses,
  `confirmed`, `awaiting_payment`, `paid`, `fulfilled` and `cancelled`, in Settings or through the
  API, or every status as before; applied where events are captured, whoever changes the order).
  **[Template status filters built, locally verified]** (ADR-148: an endpoint takes
  `template.status_changed` only for the template statuses it chooses, the eleven the event
  reports, in Settings or through the API, or every status as before; applied where events are
  captured, whoever records the status). **[Conversation status filters built, locally
  verified]** (ADR-149: an endpoint takes `conversation.status_changed` only for the statuses a
  conversation reaches that it chooses, `open` or `resolved`, in Settings or through the API, or
  every status as before; applied where events are captured). **[Campaign results in campaign events
  built, locally verified]** (ADR-150: `campaign.status_changed` carries the campaign's results as
  `GET /campaigns/{id}` counts them, counted when each event is delivered, so a retry or a replay
  counts again; null while it is a draft; counts only, never costs). **[Run end filters built,
  locally verified]** (ADR-151: an endpoint takes `automation.run_ended` only for the ways a run
  ends that it chooses, completed, handed off, taken over, stopped or failed, in Settings or through
  the API, or every end as before; applied where events are captured, with the automations it
  names). **[Replays by event type built; their database tests run only in CI]** (ADR-156: an
  endpoint's failed deliveries replayed for the events chosen only, `events` through the API or one
  of the endpoint's events in Settings, audited with them). **[Replays by how deliveries failed
  built; their database tests run only in CI]** (ADR-159: only the events whose latest failed
  delivery was answered with a server error, refused, answered otherwise, not validly answered or
  not attempted, as chosen, `failures` through the API or one kind in Settings, audited with them).
  **[Replays of every endpoint built; their database tests run only in CI]** (ADR-160: one replay
  for every endpoint that is on, 500 across them in the order they were added, in Settings or
  `POST /webhook-endpoints/replay-failed` for the endpoints keys added, audited once per endpoint).
  **[Number filters built; their database tests run only in CI]** (ADR-170: an endpoint takes the
  message, conversation, automation run, order and campaign events of the WhatsApp numbers it
  chooses, 1 to 100 of the company's numbers, in Settings or through the API, or every number's as
  before; applied where events are captured, with the number the changed row has; consent, contact
  and template events are not narrowed). **[Message sender filters built; their database tests run
  only in CI]** (ADR-172: an endpoint takes `message.status` only for the messages members,
  automations, campaigns, the API or HyFib sent, as it chooses, in Settings or through the API, or
  every message's as before; applied where events are captured, with the statuses and numbers it
  names). **[OAuth client credentials built; their database tests run only in CI]** (ADR-173: an
  endpoint gets an access token from its receiver's authorization server as the client a member or
  key sets, and sends it as a bearer token with every delivery; the secret sealed and needed again
  for a new token URL, tokens kept in the worker's memory only). **[Team filters built; their
  database tests run only in CI]** (ADR-174: an endpoint takes the message and conversation events
  of the conversations of the teams it chooses, 1 to 50 of the company's teams, in Settings or
  through the API, or every conversation's as before; by the team a conversation is in when the
  event is captured, a change of team also reaching the team it left). **[Template filters built;
  their database tests run only in CI]** (ADR-175: an endpoint takes `message.status` for the
  messages sent with the templates it chooses and `template.status_changed` for their changes, 1
  to 50 of the company's templates, in Settings or through the API, or every template's as
  before). **[Assignee filters built; their database tests run only in CI]** (ADR-181: an endpoint
  takes the message and conversation events of the conversations assigned to the members it chooses,
  1 to 50 members who take conversations, in Settings or through the API, or every conversation's as
  before; by the member a conversation is assigned to when the event is captured, a change of
  assignee also reaching the member it left). **[Tag changes built; their database tests run only in
  CI]** (ADR-182: a `contact.updated` names the tags its change added and removed, net within the
  change, cleared from stored events when the contact is erased). **[Run trigger filters built;
  their database tests run only in CI]** (ADR-183: an endpoint takes the run events of the runs
  started by the triggers it chooses, in Settings or through the API, or every run's as before).
  **[Custom field filters built; their database tests run only in CI]** (ADR-184: an endpoint takes
  the changes of the custom fields it chooses, 1 to 50 of the company's fields, alongside the parts
  it takes, or every field's as before). **[Campaign filters built; their database tests run only in
  CI]** (ADR-185: `message.status` names the campaign that sent the message, and an endpoint takes
  the statuses of the messages of the campaigns it chooses and their changes, 1 to 50 of the
  company's campaigns, in Settings or through the API, or every campaign's as before). **[Consent
  change filters built; their database tests run only in CI]** (ADR-189: an endpoint takes the
  consent changes it chooses, by purpose and action, in Settings or through the API, or every change
  as before). **[Contact source filters built; their database tests run only in CI]** (ADR-190: an
  endpoint takes the `contact.created` of the contacts from the sources it chooses, such as all but
  `api` for an integration that adds contacts itself, or every contact's as before). **[Message type
  filters built; their database tests run only in CI]** (ADR-191: an endpoint takes the received
  messages of the types it chooses, such as text and button and list replies for a chatbot, or every
  message as before). **[Run end reason filters built; their database tests run only in CI]**
  (ADR-192: an endpoint takes the ends of the runs that ended for the reasons it chooses, each
  narrowing the end it belongs to, such as only the failures to send among failed runs, or every end
  as before). **[Contact cards' contacts built; their database tests run only in CI]** (ADR-196:
  `message.received` gives a contact card's contacts, as the API does). **[Merge events built; their
  database tests run only in CI]** (ADR-225: `contact.merged` names the merged contact and gives the
  contact it belongs to now; the API answers a merged contact's id with 404, reason
  `contact_merged`, naming that contact, and `GET /contact-changes` lists the contacts merged into
  each contact it reads). **[CRM deal events built; their database tests run only in CI]** (ADR-256,
  migrations 0171 and 0172: `deal.created`, `deal.stage_changed` and `deal.status_changed` for every
  deal added, moved, won, lost or reopened, by members, automations or API keys; one change of both
  the stage and the status sends both, in the order the steps happen, each with the deal as its step
  left it; erasure, merges and edits of a deal's title, value or expected date send nothing; no
  filter narrows them).
  **[CRM task events built; their database tests run only in CI]** (ADR-261, migrations 0177 and
  0178: `task.created` for every task added, by members, automations or API keys, and
  `task.status_changed` for every completion, cancellation and reopening; never a task's notes;
  edits, reminders, merges and erasure send nothing; no filter narrows them).
  **[Pipeline filters for deal events built; their database and browser tests run only in CI]**
  (ADR-263, migration 0179: an endpoint takes the deal events of 1 to 50 of the company's pipelines,
  archived ones included, in Settings → Webhooks or through the API's `pipelineIds`; a move to
  another pipeline reaches the endpoints of both; task and other events are not narrowed).
  **[Stage filters for deal events built; their database and browser tests run only in CI]**
  (ADR-264, migration 0180: an endpoint takes the deal events of 1 to 50 of the company's stages,
  removed ones included; a move reaches the endpoints of the stage it left as well; with pipelines
  too, an event must pass both).
  **[Owner filters for deal events built; their database tests run only in CI]** (ADR-265, migration
  0181: an endpoint takes the events of the deals 1 to 50 chosen members own when the events happen;
  a list adds only members who can own deals and keeps those who left; with pipelines or stages too,
  an event must pass every list).
  **[Assignee filters for task events built; their database tests run only in CI]** (ADR-266,
  migration 0182: an endpoint takes the events of the tasks assigned to 1 to 50 chosen members when
  the events happen; a list adds only members who can be assigned tasks and keeps those who left;
  deal and other events are not narrowed).
  **[Pipeline filters for task events built; their database tests run only in CI]** (ADR-303,
  migration 0226: an endpoint takes the events of the tasks about the deals of 1 to 50 of the
  company's pipelines when the events happen, archived ones included; a task about no deal is in
  none; with task assignees too, an event must pass both; deal and other events are not narrowed).
  **[Stage and owner filters for task events built; their database tests run only in CI]** (ADR-304,
  migration 0227: an endpoint takes the events of the tasks about the deals in 1 to 50 of the
  company's stages, removed ones included, or owned by 1 to 50 chosen members, when the events
  happen; an owner list adds only members who can own deals and keeps those who left; a task about
  no deal matches neither list; with task assignees or pipelines too, an event must pass every list;
  deal and other events are not narrowed).
  **[Pipeline, stage and owner filters for note events built; their database tests run only in CI]**
  (ADR-305, migration 0228: an endpoint takes the events of the notes about the deals in 1 to 50 of
  the company's pipelines or stages, archived and removed ones included, or owned by 1 to 50 chosen
  members, when each note is added; an owner list adds only members who can own deals and keeps
  those who left; a note about a contact alone matches no list; with more than one list, an event
  must pass them all; deal, task and other events are not narrowed).
  **[Change-maker filters for deal, task and note events built; their database tests run only in
  CI]** (ADR-306, migration 0229: an endpoint takes the deal, task and note events of the changes
  members, automations' runs or API keys made, by the maker each event names, an addition's creator
  and a note's writer; a change that recorded no maker is always sent; other events are not
  narrowed).
  **[Deal and task status filters built; their database tests run only in CI]** (ADR-309, migration
  0232: an endpoint takes the deal and task status changes of chosen statuses, by the status each
  change reached; other events are not narrowed).
  **[Deal and task detail filters built; their database tests run only in CI]** (ADR-310, migration
  0233: an endpoint takes the deal and task detail changes that changed chosen details, by the
  details each change names; other events are not narrowed).
  **[Contact tag filters for message and conversation events built; their database tests run only in
  CI]** (ADR-267, migration 0183: an endpoint takes the events of the conversations whose contact
  has any of 1 to 50 tags when the events happen; tags are compared as contacts carry them, and one
  no contact has yet may be named; with numbers, teams or members too, an event must pass every
  list).
  **[Deal owner events built; their database tests run only in CI]** (ADR-269, migrations 0185 and
  0186: `deal.owner_changed` for every deal given to another member or left without an owner, by
  members or API keys, with both owners; an endpoint naming owners hears it for the owner the deal
  left as well; one change that also moves or closes the deal sends each event in the order the
  steps happen; automations, erasure and merges send none).
  **[Who changed an order built; its database tests run only in CI]** (ADR-270, migrations 0187 and
  0188: `order.status_changed` names who made each change, a member, an API key by its id or the
  Payment Link, recorded with the status; a change that does not record its maker names nobody,
  never the one before).
  **[Conversation tag filters for message and conversation events built; their database tests run
  only in CI]** (ADR-273, migration 0189: an endpoint takes the events of the conversations that
  have any of 1 to 50 tags when the events happen; tags are compared as conversations carry them,
  and one no conversation has yet may be named; with numbers, teams, members or contact tags too, an
  event must pass every list).
  **[Task assignee events built; their database tests run only in CI]** (ADR-274, migrations 0190
  and 0191: `task.assignee_changed` for every task given to another member, by members or API keys,
  with both assignees; an endpoint naming assignees hears it for the member the task left as well;
  one change that also reopens or closes the task sends each event in the order the steps happen;
  automations, erasure and merges send none).
  **[Deal detail events built; their database tests run only in CI]** (ADR-275, migrations 0192 and
  0193: `deal.updated` for every change of a deal's title, value or expected close date, by members
  or API keys, and for erasure's retitling, naming what changed, never the values before; the
  pipeline, stage and owner lists narrow it; one change that also moves, reopens, closes or gives
  the deal away sends each event in the order the steps happen).
  **[Task detail events built; their database tests run only in CI]** (ADR-276, migrations 0194 and
  0195: `task.updated` for every change of a task's title, notes, due time or reminder by members or
  API keys, naming what changed, never the values or the notes; the assignee list narrows it; one
  change that also reopens, closes or gives the task away sends each event in the order the steps
  happen).
  **[Who changed a deal or task built; its database tests run only in CI]** (ADR-277, migrations
  0196 and 0197: every deal and task event's `changedBy` names the member (never which), automation
  or key (`apiKeyId`) that made the change, recorded with the change and cleared when another
  transaction recorded it, so an integration can ignore its own changes).
  **[Note events built; their database tests run only in CI]** (ADR-280, migrations 0200 and 0201:
  `note.created` for every note a member or a key adds, with who wrote it (a key by its id, never
  which member), the deal and the contact, never the text, which `notes.read` reads; merges and
  erasure send none).
  **[Payment Link events built; their database tests run only in CI]** (ADR-285, migrations 0204 and
  0205: `payment_link.status_changed` for every status the commerce worker writes, with the link as
  `GET /orders/{id}/payment-links` reads it, never its address or Razorpay's ids, narrowed by the
  order's number like the order events).
  **[Payment Link status filters built; their database tests run only in CI]** (ADR-308, migration
  0231: an endpoint takes the changes of chosen link statuses, by the status each change reached;
  order and other events are not narrowed).
  **[Satisfaction survey events built; their database tests run only in CI]** (ADR-293, migrations
  0213 and 0214: `satisfaction_survey.answered` once for each survey a customer answers, with the
  survey as `GET /satisfaction-surveys` reads it, narrowed by the conversation's number).
  **[Score filters for satisfaction survey answers built; their database tests run only in CI]**
  (ADR-307, migration 0230: an endpoint takes the answers of chosen scores, 3, 2 or 1, by the score
  each answered survey records; other events are not narrowed).
  **[Member and team filters for satisfaction survey answers built; their database tests run only in
  CI]** (ADR-311, migration 0234: an endpoint takes the answers credited to chosen members, the
  conversation's assignee when it was resolved, or of chosen teams' conversations, the team when the
  customer answers; other events are not narrowed).
  **[Tag filters for satisfaction survey answers built; their database tests run only in CI]**
  (ADR-312, migration 0235: an endpoint takes the answers of contacts or conversations with chosen
  tags, as they have them when the customer answers; other events are not narrowed).
  **[Tag filters for added and changed contacts built; their database tests run only in CI]**
  (ADR-316, migration 0239: an endpoint takes the `contact.created` and `contact.updated` of
  contacts with chosen tags, and the changes adding or removing one; erased and merged contacts are
  not narrowed).
  **[API key filters for run events built; their database tests run only in CI]** (ADR-319,
  migration 0241: an endpoint takes the run events of the runs chosen API keys started, the keys
  they were rotated from or into included; runs started otherwise are not sent to a list).
  **[API key filters for message statuses built; their database tests run only in CI]** (ADR-320,
  migration 0242: an endpoint takes the statuses of the messages chosen API keys sent, the keys they
  were rotated from or into included; messages sent otherwise are not sent to a list).
  **[API key exclusions for deal, task and note events built; their database tests run only in CI]**
  (ADR-321, migration 0243: an endpoint leaves out the changes chosen API keys made, the keys they
  were rotated from or into included; changes made otherwise are never left out).
  Remaining: filters for other event types and on a message's or contact's values (such as a field's
  value, or the key that made an order change), other authentication (headers computed per delivery,
  other OAuth grants), mutual TLS, fixed egress addresses, events for store orders and each step of
  a run, `createdAt` finer than the millisecond, load tests.
- **P5-10 Platform ops screens** **[built, locally verified with test data only]** (ADR-054):
  `/platform/ops` with Overview, Onboarding (failed and abandoned signups, failed or stuck number
  setups, new companies without a number), Integrations (current failures with host-only labels,
  Meta and Razorpay receipts needing attention, quarantine, email delivery counts), Queues (pg-boss
  counts per queue with retry policy, dead letters recorded by the worker without error messages),
  Signals (7-day review flags and security event counts) and Usage (7, 30 or 90 days); a health card
  on each company's platform page; audited receipt retry and quarantine resolution. **[Failure
  alerts built, locally verified]** (ADR-091: every platform administrator emailed once about each
  dead letter, each receipt that used all its attempts and each unresolved quarantine entry, at most
  every 15 minutes, counts only; a receipt whose worker stopped during its last attempt is now
  listed and retryable). **[Queue waits and alerts for late queues built, locally verified]**
  (ADR-096: the worker's minute sweep records each queue's ready jobs and the oldest one's wait,
  shown on the Queues tab with the queue's limit; every platform administrator is emailed once each
  time a queue's oldest job waits past its limit, at most every 15 minutes, and the console says
  when the worker stopped checking). **[Dead letter retries built, locally verified]** (ADR-108: a
  platform administrator sends a dead letter's failed job back to its queue once, with a reason, in
  the platform audit log; refused for unverified jobs, companies being deleted, jobs pg-boss no
  longer keeps, queues that never retry or whose receipts have their own retry, and work already
  waiting; needed for `template.submit`, whose work no sweep signals again). **[Stranded work
  settled, locally verified]** (ADR-111: the minute sweep ends the work of `channel.onboard`,
  `commerce.account` and `template.delete` dead letters in the company's scope, unless a job for the
  same work waits or runs again: the number's setup fails with its step, the keys' check fails, a
  deletion goes back to Meta's last status; the template sync keeps a deletion while its job tries;
  deletions and key checks retry longer). **[Alerts for companies' failing integrations built,
  locally verified]** (ADR-139: every platform administrator emailed once about each failure the
  Integrations page lists, by kind and with counts only, at most every 15 minutes, from the
  console's own list; a failure not listed for an hour is forgotten). **[Acknowledging failing
  integrations built, locally verified]** (ADR-141: a platform administrator acknowledges a failure
  Current failures lists with a note, shown with who and when to the other administrators and kept
  in the platform audit log; replaced by a later note; refused once the failure recovered or changed
  state; forgotten an hour after the failure stops being listed). **[API request counts on the Usage
  tab built; its tests run only in CI]** (ADR-153: each company's latest API request counter, the
  plan's, beside its automation runs, read by the platform role). **[An export of the Usage tab
  built; its database tests run only in CI]** (ADR-154: "Download CSV" for the window shown,
  formula-safe, each export in the platform audit log before the file is returned). **[Exports of
  the health and signals lists built; their database tests run only in CI]** (ADR-155: "Download
  CSV" on the Overview for every company's health, worst first, and on the Signals tab, through one
  audited export for the console's lists). **[The window before on the Usage tab built; its database
  tests run only in CI]** (ADR-157: each company's sending and receipts in the 7 or 30 days before,
  with the change, on screen and in the CSV; read in one snapshot). **[Exports of the action lists
  built; their database tests run only in CI]** (ADR-158: "Download CSV" on each list of the
  Onboarding, Integrations and Queues tabs, as the tab reads it, each export audited and refused to
  anyone but a platform administrator before any read; who acknowledged or retried and the notes
  left out). **[Acknowledging dead letters built; its database tests run only in CI]** (ADR-169: a
  platform administrator acknowledges a dead letter on the Queues tab with a note, shown with who
  and when to the other administrators, replaced by a later note and kept in the platform audit log;
  it lasts as long as the dead letter, and the CSV gives when, never who or the note).
  **[Acknowledging late queues built; its database tests run only in CI]** (ADR-177: a platform
  administrator acknowledges a late queue on the Queues tab with a note, shown with who and when
  to the other administrators, replaced by a later note and kept in the platform audit log; it
  lasts while the queue stays late, and the CSV gives when, never who or the note).
  **[Acknowledging webhook receipts built; its database tests run only in CI]** (ADR-179: a
  platform administrator acknowledges a Meta or Razorpay receipt that needs attention with a
  note, shown with who and when, replaced by a later note, audited and deleted with the
  receipt; the CSV gives when, never who or the note).
  **[Acknowledging quarantine entries built; its database tests run only in CI]** (ADR-199: a
  platform administrator acknowledges an open quarantine entry with a note, shown with who and when,
  replaced by a later note, audited and deleted with the entry; a resolved entry takes none; the CSV
  gives when, never who or the note).
  **[Exports beyond the rows a tab shows built; its database tests run only in CI]** (ADR-200: a
  list's CSV gives up to 5,000 rows, 1,000 failures and 500 signups, in the tab's order; the tabs
  keep their rows). **[Assigning failing integrations, emailing the assignee and listing one's own
  and the unassigned built; their database and browser tests run only in CI]** (ADR-313: a platform
  administrator assigns a failure Current failures lists to a platform administrator, themselves or
  another, shown with to whom, by whom and when, audited, lasting while the failure is listed; the
  CSV leaves it out. ADR-314: an assignee is emailed once about each failure another administrator
  assigned them, with counts only. ADR-315: "Assigned to me" lists only the failures assigned to the
  administrator reading. ADR-318: "Unassigned" lists only the failures assigned to nobody).
  Remaining:
  other alert channels, longer trends and charts, Meta's quality webhook (unconfirmed),
  paging and rollups for many companies.
- **P5-11 Account export/deletion workflow** **[built, locally verified with test data only]**
  (ADR-055): Settings → Company data for owners. A streamed, gzip-compressed JSON Lines export of
  every company table from one read-only transaction (each table and column exported or excluded
  with a reason, secrets never exported, one export at a time, audited, owners and administrators
  emailed). Deletion typed with the company address, 14 days of grace working as suspended and
  cancellable by any owner, then a resumable `tenant.delete` worker job: provider clean-up once
  (WhatsApp app unsubscribed, Shopify app uninstalled, WooCommerce webhooks deleted, card token
  deleted at Razorpay), batched deletion in foreign-key order, a tombstone company row, billing
  records and plan history kept, final emails. Also fixed: erasure now redacts past send requests,
  public entry points serve companies pending deletion, and the ended-run guard freezes two columns
  again (step-up re-authentication for both since ADR-056). **[Staff-started deletion built,
  locally verified]** (ADR-090: platform owners schedule a company's deletion on its platform page
  with the address typed and a reason the owners and administrators are emailed and read in the
  company; the same 14 days and job; whoever scheduled a deletion cancels it, so owners cannot
  cancel HyFib's and staff cannot cancel an owner's). Remaining: stored exports, other formats, a
  deletion job run on staging, legal review of the kept records.

## Phase 6 — AI, calling, channels, connectors, enterprise

AI copilot (budgets, retrieval with pgvector only when shipped, prompt-injection tests); Instagram and
Messenger; SMS provider; calling (eligibility-gated); HubSpot, Salesforce, Zoho connectors; MCP
server; SSO (SAML/OIDC via maintained implementation); agency/partner features.

## Phase 7 — hardening and rollout

k6 load tests against the envelope; accessibility audit; backup restore drill; independent security
review; production rollout per RELEASE-CHECKLIST.

## Security backlog

- **SEC-1** WebAuthn/passkeys for privileged roles.
- **SEC-2** ~~Breached-password screening at sign-up/reset (k-anonymity API or offline list).~~
  Settled by ADR-317: the password a sign-up, reset or change sets is checked with the Pwned
  Passwords range API (the first five characters of its SHA-1 hash, padded answers) and refused when
  it appears in a breach; a check that cannot be made takes it with a warning. On by default for
  staging and production; its end-to-end test runs in CI against a stand-in, and the live API is to
  be checked from production.
- **SEC-3** Central SSRF-safe egress client (DNS pinning, private/metadata range blocking, redirect
  re-validation, limits) used by all outbound HTTP — _built with P4-02 (ADR-042) and used by the
  automation HTTP step, the Flows data endpoint (P4-03) and outgoing webhooks (P5-09); imports
  must use it too. Remaining: a network
  egress policy as a second layer in deployment._
- **SEC-4** ~~Dual-key job signing for rotation without draining.~~ Settled by ADR-135: a next key
  is accepted before any instance signs with it, then the previous key is accepted while the
  worker's minute sweep signs the queued jobs it signed again with the new one, so the job signing
  key rotates in three deploys without draining a queue; Operations → Keys shows what each key still
  signs.
- **SEC-5** Hash-chained audit checkpoints exported to WORM storage.
- **SEC-6** Media scanning pipeline (malware) before exposure.
- **SEC-7** OpenTelemetry tracing/metrics, alert rules (queue lag, dead letters, error rates, auth
  anomalies).
- **SEC-8** ~~Step-up verification endpoint (password + TOTP) recorded in
  `ops.step_up_verifications` for sensitive settings (billing, security).~~ Settled by ADR-056: a
  new sign-in within the last 15 minutes, which reuses the sign-in's rate limits, two-factor attempt
  limit and lockout instead of a second verification path.
- **SEC-9** ~~Per-user login history view.~~ Settled by ADR-136: every completed sign-in (the
  password step once two-factor has decided, an authenticator or backup code, the email
  confirmation link) is a security event with its address, browser and method, and Account &
  security lists each person's last 20; failed attempts are not listed.
- **SEC-10** ~~Keyring re-encryption job: re-encrypt every keyring ciphertext (provider tokens,
  HTTP secrets, flow private keys, stored webhook bodies) under the primary key so an old key can be
  removed (`Keyring.needsRotation` exists; the job does not).~~ Settled by ADR-134: while a key
  other than the primary is configured, the minute sweep seals every stored value (15 kinds) that
  key sealed again with the primary key, in its company's scope, with a compare and set and without
  moving a row's time; Operations → Keys shows what each key still seals.
- **SEC-11** ~~Keep failed queries' parameters out of error logs. A query that fails with an error
  the app does not map is logged whole by the API's and server actions' error logs, the worker's job
  log and several webhook routes, and the driver's message repeats the query's parameters (names,
  emails, message text), against the logger's rule; `errorClassAndCode` (class and SQLSTATE only)
  exists and webhook delivery uses it. Found with ADR-124, whose check now keeps the NUL character
  from reaching queries; a probe of members' contact search with it showed the search text in the
  error's message.~~ Settled by ADR-129: `db.run` and the platform database's `run` replace a
  driver's error with a `DatabaseQueryError` (SQLSTATE, the names PostgreSQL gave, its message only
  where that quotes no values, and the frames), and every logger's `err` serializer does the same.
- **SEC-12** ~~Bound inbound message content. A message's stored content may be at most 64 KB, and
  a contact card or an interactive reply with an oversized field is stored whole, so one such
  message fails its webhook receipt with every message and status delivered beside it (WhatsApp's
  own limits keep real messages far below it). Found with ADR-130, whose test of a receipt failing
  in the database uses one.~~ Settled by ADR-131: inbound content is bounded by construction under
  the 64 KB a message holds (a contact card keeps the contacts that fit and counts the rest;
  anything larger is kept as too large), a status's errors and pricing are kept within their
  columns, and jsonb is written as JSON PostgreSQL stores (half of an emoji as U+FFFD), which also
  kept long messages with emoji from failing their receipts.
