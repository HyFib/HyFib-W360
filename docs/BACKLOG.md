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
  live updates. Remaining: list virtualisation, collision warnings (phase 3 with presence), template
  picker (phase 3).
- **P2-10 Channel settings UI** — done: connect (Embedded Signup), setup progress and errors, retry,
  disconnect, quality and health time. Remaining: messaging limits and granted permissions display.
- **P2-11 Platform quarantine view** — new: list and resolve quarantined webhooks in the platform area
  (today the platform role can read and resolve them in the database only).
- **P2-12 Token health** — new: periodic `debug_token` checks and reconnect prompts before sends fail.

## Phase 3 — contacts, consent, templates, campaigns, reports

- **P3-01 Contacts & CRM fields** — _implemented (2026-09-26)_: custom fields, tags, search and
  filters, import preview/mapping/row errors, one contact per number (dedupe across manual, import
  and inbound), formula-safe export, erasure; saved segments (P3-04). **Remaining:** safe merge
  (H-019), role-based number masking (W-044), bulk tag edits.
- **P3-02 Consent & suppression** — _implemented (2026-09-26)_: consent events with provenance,
  opt-out/opt-in keywords, Meta 131050 opt-outs, suppression list, send-time enforcement (race test
  with a queued template, and with campaigns). **Remaining:** review Meta's
  opt-in guidance (M-131) and per-market consent law; consent capture from growth tools (phase 4).
- **P3-03 Templates** — _implemented (2026-09-26), not verified against Meta_: drafts, validation,
  write-ahead submission with lost-response reconciliation, Graph listing sync (webhook-triggered
  and periodic), deletion, status history, template sends from contacts and the inbox.
  **Remaining:** media headers (Resumable Upload + media storage), URL buttons with variables (the
  example format must be confirmed), named parameters, authentication/OTP, carousel, LTO, copy-code
  and catalog templates, editing approved templates (`POST /{template-id}`), template library
  (W-070), and a sandbox run with a real WABA.
- **P3-04 Campaigns** — _implemented (2026-09-26), sends verified against the Graph stand-in
  only_: saved segments (incl. campaign-response retargeting), drafts with a review panel,
  audience snapshots re-checked when queued and before dispatch, optional four-eyes approval,
  wall-clock scheduling with daylight-saving rules, sending windows, deadlines, pacing, marketing
  frequency cap, message and estimated spending caps (platform rate cards), pause/resume and
  idempotent cancel, test sends, per-recipient outcomes, last-touch reply/opt-out attribution,
  results with denominators, CSV export. Local 10,000-recipient run: snapshot 0.6 s, all recipients
  queued in 21 ticks. **Remaining:** the 10k run in staging with real dispatch, per-recipient time
  zones, A/B variants, messaging-tier awareness (read the number's limit from Meta), campaign
  sends through the public API (the API sends single templates since P5-08), media-header
  templates.
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
  **Remaining:** per-team SLA targets and calendars, SLA breach notifications (email or in-app),
  presence and typing indicators, conversation tags (W-035), private team queues (would change
  visibility, ADR-029), mention emails, CSAT by template outside the window (needs a consent
  decision), CSAT with a real WABA, transcript download (W-042), phone-number masking (W-044).

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
  and the order-event trigger came with P4-06e. **Remaining:** Flow and catalog steps (sending a
  WhatsApp Flow or products from a run), starting runs from the public API or campaigns, enrolling
  contacts or segments in a sequence without a customer message or order event, fuzzy keyword
  matching, a drag-and-drop canvas (ADR-034), run export, usage billing for
  automation steps, a real sandbox run (release checklist).
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
  isolation), e2e `web-requests.spec.ts`. **Remaining:** calls against a real company API in an
  authorized environment (release checklist), response headers or non-JSON bodies as values,
  retries a company opts into for idempotent requests, form-encoded bodies, OAuth client flows.
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
  complete; encrypted requests through the route). **Remaining:** checks on an approved sandbox
  number and a real account's keys (release checklist), a visual form builder, sending flows from
  automations, campaigns and templates, flows that open with `data_exchange`, Meta's flow metrics.
- **P4-04 CRM** — _implemented and locally verified (2026-09-27); reminder emails verified through
  Mailpit only_: pipelines (company settings, audited) with ordered stages and one currency each,
  archived instead of deleted; deals linked to a contact for life and optionally to a conversation,
  with exact minor-unit values, owners, stage moves, won/lost with a reason and reopening, all
  version-checked; a board per pipeline with owner filters and per-stage totals; won and lost
  lists; tasks with due times and reminders emailed once (durable job plus the minute sweep, skipped
  with a reason when stale, closed or the assignee lost access); notes; an append-only timeline per
  contact and deal; CRM panels on the contact page and beside a conversation; deal outcomes, win
  rate, time to win and open pipeline in reports and CSV; erasure of the CRM free text. T: reminders
  exactly once under repeated signals; erasure; isolation. **Remaining:** custom deal fields,
  products on deals, deal import and export, forecasting, moving deals between pipelines in the UI
  (the service supports it), automation steps that create deals or tasks, CRM connectors (HubSpot,
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
  notifications, paid and fulfilled). **Remaining:** checks on an approved sandbox number and with a
  company's Razorpay test keys (release checklist), product enquiries (`referred_product`), payments
  inside WhatsApp (`order_details`, needs Meta payment configuration), writing to catalogs and stock,
  refunds from HyFib, order reports and exports, sending products from automations.
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
  card; the used-up notices now skip counters of an earlier period); **[paying for plans by
  Razorpay subscription built, locally verified against the stand-in]** (ADR-063, see P5-07).
  Remaining: billing that starts when a trial ends, self-serve plan changes and higher-plan trials,
  proration, plan invoices, thresholds chosen per company, in-app notices, plan-change emails to
  companies, packs of extra API requests and AI credits (Phase 6).
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
  a note; paid top-ups no settlement showed 7 days after payment are listed. Remaining: refunds
  asked for by companies, a platform-wide refunds list, alerts for reconciliation findings, bank
  statement (UTR) matching, fee and tax accounting, and GST invoices (GST treatment needs tax
  review).
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
  the daily reconciliation); **[plan payment receipts built, locally verified]** (ADR-064: a receipt page per plan payment with the plan, add-ons, billing period and tax, not a tax invoice, linked from Billing and the payment email). Remaining: invoices (tax review), refunds of
  plan payments, billing from the end of a trial, plan and add-on changes with proration, pausing,
  offers, alerts before a rate change, Razorpay test-mode checks (RELEASE-CHECKLIST).
- **P5-08 Public API** **[built, locally verified; sends through the Graph stand-in only]**
  (ADR-052): company API keys (SHA-256 only, scopes granted within the creator's permissions,
  expiry, rotation with an overlap, revocation, audit), `/api/v1` with approved template sends,
  contacts (cursor pages, create or existing), consent with evidence and message status; idempotency
  keys, per-key, per-company and failed-authentication rate limits, 64 KB bodies, an OpenAPI 3.1
  document from the validation schemas, Settings → API keys; monthly API requests and API access
  by plan (ADR-061, see P5-01). Remaining: session, media and interactive messages, conversation
  and message lists, starting automations (W-086), bulk sends in one call, IP allowlists, key expiry
  reminders, per-key quotas, tests of the rate limits.
- **P5-09 Outgoing webhooks** **[built, locally verified; delivered to local test receivers only]**
  (ADR-053): up to 10 endpoints per company (`developer.manage`) for `message.received`,
  `message.status`, `consent.changed` and `template.status_changed`, captured by database triggers
  in the company's scope; payloads built when delivered (erased contacts without personal data);
  HMAC-SHA256 signatures with secrets shown once, encrypted and rotated with a 24-hour overlap;
  delivery through the egress guard with leases, eight attempts over about 45 hours, interrupted
  attempts retried (at least once), automatic disabling after 72 hours of failures with an email,
  delivery history, replays, test events, 30-day retention, the OpenAPI `webhooks` section.
  Remaining: filters beyond the event type, custom headers, mutual TLS, fixed egress addresses,
  events for conversations, campaigns, automations, contact changes and orders, load tests.
- **P5-10 Platform ops screens** **[built, locally verified with test data only]** (ADR-054):
  `/platform/ops` with Overview, Onboarding (failed and abandoned signups, failed or stuck number
  setups, new companies without a number), Integrations (current failures with host-only labels,
  Meta and Razorpay receipts needing attention, quarantine, email delivery counts), Queues (pg-boss
  counts per queue with retry policy, dead letters recorded by the worker without error messages),
  Signals (7-day review flags and security event counts) and Usage (7, 30 or 90 days); a health
  card on each company's platform page; audited receipt retry and quarantine resolution. Remaining:
  alerts, trends, Meta's quality webhook, API request counts, exports, the oldest waiting job,
  redrive from the console, acknowledging issues, paging and rollups for many companies.
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
  again (step-up re-authentication for both since ADR-056). Remaining: staff-started
  deletion, stored exports, other formats, a deletion job run on staging, legal review of the kept
  records.

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
  re-validation, limits) used by all outbound HTTP — _built with P4-02 (ADR-042) and used by the
  automation HTTP step, the Flows data endpoint (P4-03) and outgoing webhooks (P5-09); imports
  must use it too. Remaining: a network
  egress policy as a second layer in deployment._
- **SEC-4** Dual-key job signing for rotation without draining.
- **SEC-5** Hash-chained audit checkpoints exported to WORM storage.
- **SEC-6** Media scanning pipeline (malware) before exposure.
- **SEC-7** OpenTelemetry tracing/metrics, alert rules (queue lag, dead letters, error rates, auth
  anomalies).
- **SEC-8** ~~Step-up verification endpoint (password + TOTP) recorded in
  `ops.step_up_verifications` for sensitive settings (billing, security).~~ Settled by ADR-056: a
  new sign-in within the last 15 minutes, which reuses the sign-in's rate limits, two-factor attempt
  limit and lockout instead of a second verification path.
- **SEC-9** Per-user login history view.
- **SEC-10** Keyring re-encryption job: re-encrypt every keyring ciphertext (provider tokens, HTTP
  secrets, flow private keys, stored webhook bodies) under the primary key so an old key can be
  removed (`Keyring.needsRotation` exists; the job does not).
