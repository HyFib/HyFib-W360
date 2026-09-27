# Progress

## 2026-09-27 — Phase 4: commerce on WhatsApp (P4-06a)

Status: **Commerce on WhatsApp implemented and locally verified; production blocked on checks with an
approved sandbox number, a connected catalog and a company's Razorpay test keys.** Companies read
the catalogs connected to their WhatsApp accounts, send products in conversations, receive the
orders customers send from their cart, and ask for payment with Payment Links from their own
Razorpay account. No request reached Meta or Razorpay: both were the local stand-ins, and webhooks
were signed by the tests the way Meta and Razorpay do. Store connectors (Shopify, WooCommerce) are
the next slice (P4-06b).

### Completed

- **Research (M-169 to M-174, R-106 to R-109):** product, multi-product and catalog messages, the
  order webhook, product enquiries, the catalog edges and product fields (official OpenAPI
  description and Meta's Python SDK, high confidence); which permission reading catalogs needs
  (M-173, low to medium confidence: partner documentation); payments inside WhatsApp (M-174, not
  used). Payment Links: single-use reference ids, finding a link by reference (the list's response
  envelope unconfirmed, R-107), the webhook payload and cancelling (Razorpay's documentation and
  Node SDK).
- **Schema (migration 0018, ADR-046):** catalog reads, catalogs, products, orders and items, the
  company's Razorpay account (keyring-encrypted secrets), written-ahead Payment Links and webhook
  event ids, with composite foreign keys, FORCE RLS and column grants; definer functions
  `ops.commerce_payment_webhook_target` and `ops.commerce_work_due`; `app.erase_contact` replaced to
  clear order notes and cancel open links.
- **Worker (`commerce.sync`, `commerce.link`, `commerce.account`):** catalogs and products read from
  Meta (up to 10 catalogs and 5,000 products each, removed products and disconnected catalogs
  marked after complete reads only, a daily re-read, Meta's permission refusals explained); each
  Payment Link created once with a single-use reference (after a lost response it is looked up,
  never created again), cancelled on request, fetched every 15 minutes on its first day and every
  six hours after that, and at once on a signed notification; a payment recorded only when Razorpay
  reports the link paid in full; the link sent in the chat while the service window is open; the
  company's keys checked. Locks follow the conversation → order → link order used by replies and
  erasure.
- **Orders and the merchant webhook:** orders captured from the Meta webhook in the message's
  transaction, with prices converted to minor units exactly and product names from HyFib's catalog
  copy; `/api/webhooks/razorpay-links/<address id>` verifies the company's own secret, records the
  event id and only signals a fetch.
- **Pages (`commerce.read`; catalog reads and keys need `commerce.manage`; sending, statuses and
  payment requests are replies):** Commerce → Orders with status filters and paging, an order page
  (items, total, note, status buttons, Payment Links with their address and not-sent reason, request
  and cancel), Catalogs with the read state and "Read from Meta", products with search, and Payments
  (write-only keys, the webhook address and events). The inbox has a "Send products" card (one
  product, several products or the whole catalog), an Orders panel, and message bubbles for orders,
  product messages and payment requests. The Commerce module is now listed as available.
- **Found while building:**
  - Correlated count subqueries in single-table selects bound to the subquery's own columns
    (drizzle drops table names there), so Settings → Pipelines always showed 0 open deals per stage.
    A new `outerColumn()` helper names the outer column; the CRM test now checks the counts, and the
    platform rate card list (which happened to work) uses it too.
  - Payment Link work locked the link before the order, the opposite of erasure and the order pages;
    the worker now locks conversation, order, then link.
  - A check that found the link busy was dropped, so a payment notified during a scheduled check
    waited up to 15 minutes; it is now retried.
  - Why a link was not sent in the chat was overwritten by the next check; it is now kept in its own
    column (`send_error`).
  - The order page's "creating" and "cancelling" notes lived in buttons that disappear once the link
    exists, so they vanished; they are now shown on the link itself.
  - Mutation checks: of 15 deliberate regressions (signature, paid status, float prices, order
    visibility in the list and the page, erasure of notes and links, unchecked keys, the service
    window, deduplication, live keys, lookup and recovery after a lost response, the busy lease, the
    not-sent reason), one survived (the lookup before creating again was covered only by the
    duplicate-reference recovery); a test now requires a single create request, and all 15 fail the
    tests.

### Test commands and results (local, 2026-09-27, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm test` (unit)                                                          | 172 passed. New: 13 commerce model tests (webhook prices to minor units, order parsing with dropped items, limits, unknown totals and notes; product, list and catalog message shapes and limits; member order transitions; references; the payment message) and 4 Payment Link client tests (create request without partial payments or Razorpay notifications, response checks, lookup by reference in either list shape, cancel refusal)                                                                                                                                                                                                                                                                                                                                         |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 251 passed, including `commerce.test.ts` 5: catalogs read with paging, removals, Meta's permission refusal and disconnection, the daily re-read; product messages (single, list, catalog) in the window with refusals; orders with exact amounts, redelivery, unknown totals, member statuses, stale versions, visibility by assignment and payment preconditions; Payment Links end to end (keys checked, test keys only, a lost create response looked up with a single create request, the chat message, a busy lease retried, forged, foreign and duplicate notifications, payment only from Razorpay, cancel, cancel racing payment, expiry with the not-sent reason kept, revoked keys); erasure and isolation. Also the CRM open-deal counts and the platform rate card list |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 46 passed (23 tests × 2), including `commerce.spec.ts`: a catalog read from Meta through the worker and searched, one product and a product list sent from a conversation (the requests WhatsApp received checked), a signed order webhook shown in the chat with its exact total, the order confirmed, the company's test keys saved and checked, payment requested (the link created once and sent in the chat), a forged notification refused, the payment recorded only after the link was paid at Razorpay and a signed notification arrived (a redelivery ignored), and the order fulfilled. After the last small page changes, `commerce.spec.ts` passed again on both projects; earlier it also passed 3 times in a row per project                          |

### Known gaps

- Not built: store connectors (P4-06b), product enquiries (`referred_product`), payments inside
  WhatsApp (`order_details`), writing to catalogs and stock, refunds from HyFib, order reports and
  exports, sending products from automations.
- Verified against the Graph and Razorpay stand-ins only. The catalog permission (M-173), the price
  text format (M-172), the list envelope for finding a link by reference (R-107) and Firefox and
  WebKit locally (they run in CI) are release checklist items.
- Keyring rotation of existing ciphertexts, now including companies' Razorpay secrets, needs the
  re-encryption job (SEC-10).

## 2026-09-27 — Phase 4: WhatsApp Flows (P4-03)

Status: **WhatsApp Flows implemented and locally verified; production blocked on checks with an
approved sandbox number and a real account's keys.** Companies write forms as Flow JSON, send them
to Meta as drafts, publish them, send them in conversations and save the answers on the contact.
Forms that fetch data use HyFib's encrypted endpoint, which forwards requests to the company's own
endpoint. No request reached Meta and no WhatsApp client opened a form: Meta was the local Graph
stand-in, and endpoint requests were encrypted and signed by the tests the way WhatsApp does.

### Completed

- **Research (M-161 to M-168):** flow creation, JSON upload with validation errors, publish,
  deprecate, delete and read (official OpenAPI description, high confidence); the business public
  key per phone number (M-164); the flow message (M-165); the completion webhook `nfm_reply`
  (M-166, medium confidence: third-party sources); endpoint status codes and encryption (Meta's
  sample endpoint, M-167); `flow_token_signature` (M-168, low confidence, not used). M-163 now also
  records the `health_status` fields (with M-107).
- **Schema (migration 0017, ADR-045):** `flows`, `flow_keys`, `flow_key_uploads`, `flow_sends` and
  `flow_responses`, with composite foreign keys, FORCE RLS and column grants; definer functions
  `ops.flow_endpoint_target` (the endpoint's lookup by public id) and `ops.flow_work_due` (the
  sweep); `app.erase_contact` replaced to delete answers and end tokens.
- **Worker (`flow.sync`, `flow.keys`):** every operation at Meta is written ahead on the flow row and
  performed once; a lost create response is recovered by adopting the flow whose name carries the
  flow's reference; publish, deprecate and delete read Meta's status first; operations waiting over
  two minutes are signalled again and those over 30 minutes fail with a message. Keys: one RSA-2048
  key per WhatsApp account, uploaded to every active number and read back, replaced with a 24-hour
  overlap, private keys deleted when retired.
- **Endpoint (`/api/flows/endpoint/<public id>`):** signature (432), decryption with the current or
  previous key (421), health checks and error notices answered by HyFib, HyFib's flow tokens only
  (427 with a message), suspended companies refused, forwarding through the egress guard to the
  company's endpoint on an allowed domain with its secret only for that host, the company's own 427
  passed on, and codes-only logging.
- **Pages (`flows.read`; drafts and settings need `flows.write`, publishing and key replacement
  `flows.publish`):** Flows list with archived view, New flow with the example form and live checks,
  and a flow page with status, Meta's validation errors with line and column, health, preview,
  lifecycle buttons (irreversible actions confirmed), the draft editor or the published JSON,
  answer and endpoint settings, the endpoint address and key state per number, and completed forms.
  The inbox has a "Send a form" card while the window is open, and shows sent and completed forms
  in the thread. The Flows module is now listed as available.
- **Found while building:**
  - Saving an unchanged draft said the changes were being sent to Meta; it now says nothing changed,
    and saving a restored draft (or one whose upload failed) sends it to Meta again. Unchanged saves
    are no longer audited.
  - Operations that ran out of time said Meta did not answer, also when the company had been
    suspended and nothing was sent; the message now names both causes.
  - The published Flow JSON widened the flow page on phones; the page grid now keeps it scrolling
    inside its card.
  - Mutation checks found two untested rules (a secret re-pointed to another domain, a completion by
    someone other than the form's contact); both now have integration tests, and all seven
    deliberate regressions tried (signature, expiry, secret domain, contact match, lost create
    response, draft sending, erasure) fail the tests.
  - PR #7's Firefox e2e run failed with `NS_BINDING_ABORTED` when the automations test left an inbox
    page with `page.goto` while a live refresh was in flight (Next.js answers a cancelled refresh by
    loading the current page again). The test now leaves inbox pages through the app navigation.

### Test commands and results (local, 2026-09-27, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `pnpm test` (unit)                                                          | 155 passed. New: 7 Flows tests (request decryption with the previous key during rotation and the inverted IV in answers; refusals of wrong keys, tampered data and malformed fields; Flow JSON checks on the starter form, errors and data flows; the flow message; health status)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 245 passed, including `flows.test.ts` 7: the lifecycle with permissions, validation errors, one operation at a time, publishing, new drafts, deprecation, deletion, restoring and re-sending a draft, and audit; a lost create response adopted without a second flow, refusals and the 30-minute limit; keys uploaded to every number, a mismatch, rotation and retirement; sending in the window (drafts to testers only), completion with answer outcomes, a completion by another contact, unknown tokens and answer visibility by role; erasure; the endpoint (signature, unknown flow, wrong key, health check, error notice, unknown and expired tokens, forwarding with the secret, the company's 427, failures, a removed domain, a secret moved to another domain, suspension, rotation); isolation |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 44 passed (22 tests × 2), including `flows.spec.ts`: a form created with live checks, sent to Meta, mapped, published after confirmation, sent in a conversation, completed by a signed `nfm_reply` with its answers shown in the chat, the contact renamed and the flow page listing the answers; and a data flow whose key is uploaded, answering an encrypted health check through the route, refusing a bad signature (432) and a token HyFib did not issue (427), and forwarding a data exchange from a test send to a local company endpoint with its secret                                                                                                                                                                                                                             |

### Known gaps

- Not built: a visual form builder, sending flows from automations, campaigns or templates, flows
  that open with `data_exchange`, Meta's flow metrics and `flow_token_signature`.
- Verified against the Graph stand-in only. Whether one key per account is accepted on every
  number, the `nfm_reply` shape (third-party sources) and Meta's wait for the endpoint are release
  checklist items, as are Firefox and WebKit locally (they run in CI).
- Keyring rotation of existing ciphertexts, now including flow private keys, needs the
  re-encryption job (SEC-10).

## 2026-09-27 — Phase 4: growth tools (P4-05)

Status: **Growth tools implemented and locally verified; production blocked on checks with real
devices and a real click-to-WhatsApp test ad.** Companies can share chat links and QR codes that
open WhatsApp with a pre-filled message, see clicks per day and the conversations each link
started, add a WhatsApp button to their website, and see which click-to-WhatsApp ads started
conversations. Nothing about visitors is stored. No message was exchanged with WhatsApp and no ad
traffic was received: the webhooks in the tests are signed test payloads.

### Completed

- **Research (M-160):** a chat link is `https://wa.me/<number>?text=<urlencoded text>`, the number
  in full international form with digits only; the customer still sends the pre-filled message
  themselves. WhatsApp's Help Center page was blocked by this environment's network policy, so the
  row cites it through search results (OFF-DOC-SNIP). The ad referral object is research M-130.
- **Schema (migration 0016, ADR-044):** `chat_links` (number, name, pre-filled message, a reference
  code unique per company, a slug unique across companies, archived, version), `chat_link_clicks`
  (one count per link and company day), `chat_widgets` and `conversation_sources` (one row per
  attributed inbound message: a link, or an ad's id, type, address and headline). Two definer
  functions for the public routes, `ops.follow_chat_link` (counts the click, returns what the
  redirect needs) and `ops.chat_widget_config`, return nothing for archived links, numbers that are
  not active, disabled buttons or companies being deleted. `app.erase_contact` is replaced to delete
  the contact's sources and clear referral objects stored on its messages before 0016.
- **Ingestion:** an inbound message with a `referral` object records the ad (without the ad click
  id, media addresses or ad text; the raw object is no longer stored on the message); otherwise a
  complete "(ref ABC234)" marker records the link with that code, only if the link opens the number
  the message arrived on.
- **Growth pages (`campaigns.read`; changes need `campaigns.write` and are audited):** Chat links
  (clicks and conversations over 30 days, archived links, a form with a preview of the customer's
  message), the link page (short and direct links to copy, QR code as PNG and SVG, clicks per day
  in the company time zone, edit, archive or restore), Website button (script tag, a note for sites
  with a Content Security Policy, forms, badges when a button cannot show) and Ads (ads that started
  conversations in the last 30 days). The inbox says which link or ad a conversation came from.
- **Public routes:** `/l/<slug>` answers 302 to the wa.me address rebuilt from the stored link
  (`no-store`, no referrer, no cookie) or a 404 page; `/widget/<id>.js` serves the button script
  (cross-origin, cacheable for five minutes) or a 404 comment. The script stores nothing, loads
  nothing and sends nothing; it draws text only, in a shadow root with inline styles, and adds one
  button per page.
- **Found while building:**
  - A button whose number was disconnected would still have been drawn on sites and led to "not
    available"; the button lookup now applies the same conditions as the short link, and the
    Website button page says when a button's number is not active.
  - The button first used a closed shadow root, which hides nothing from the host page (it controls
    the page anyway) but kept accessibility tools and tests from reading the button; it now uses an
    open one.
  - Chromium does not let a page on a public origin load a script from a loopback address (Private
    Network Access). This does not affect production, where the app is public; the e2e test serves
    its embedding page from a loopback origin of its own.

### Test commands and results (local, 2026-09-27, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm test` (unit)                                                          | 148 passed. New: 6 growth tests (codes and slugs over their alphabets, the pre-filled text and wa.me format, finding a code in a message, ad referrals without the click id or media addresses, button text colour, and the widget script run against a stub DOM: text only, the short link, one button per page)                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm test:integration` (PostgreSQL 18.6)                                   | 238 passed, including `growth.test.ts` 8: links with permissions for five roles, validation, versions, archive and audit; clicks per company day and nothing for unknown or malformed slugs, archived links, a number that needs reconnecting or a company being deleted (a suspended company's links still open); limits; attribution on the link's number only (not another number of the company or another company); ad sources without the click id, media addresses or ad text; erasure of sources and legacy referral objects; buttons served only while shown and while their link can open; isolation, including a direct query in another company's scope |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 40 passed (20 tests × 2), including growth: a link created in the UI with its QR code, the short link's 302 to wa.me with `no-store` and `no-referrer`, the click count, the attributed conversation in the inbox, an ad listed under Ads, the button embedded on a page of another origin (it opens the short link; no other request, cookie or storage) and archiving stopping the link and the button. In the full run, 39 passed and the desktop web-request test failed with `dns_failed`: this sandbox had lost its hosts entry for the local test API name. With the entry restored, that test passed on its own.                             |

### Known gaps

- Not built: connecting ad accounts (ad sync, spend, cost per conversation), conversion reporting to
  Meta (W-072), campaign parameters on links, and a free public link generator.
- Verified with signed test webhooks and local browsers only; Firefox and WebKit run in CI only.
  Real devices, a printed QR code and a real click-to-WhatsApp test ad are release checklist items,
  as are edge rate limits for the public routes.

## 2026-09-27 — Phase 4: automation web requests and the egress guard (P4-02)

Status: **HTTP step implemented and locally verified against a local target server; production
blocked.** Automations can call a company's own API and branch on the result. Every call goes
through the new egress guard; calls to a real company API through a production egress path are a
release item. With this slice the "integration idempotency" part of the Phase 4 gate is verified
locally for the HTTP step; commerce (P4-06) is still open.

### Completed

- **Egress guard (`packages/core/src/egress.ts`, ADR-042):** https only, port 443 or 1024+, no URL
  credentials; one DNS resolution with every answer checked against blocked IPv4 and IPv6 ranges
  (private, loopback, link-local, CGNAT, multicast, reserved, documentation, metadata, mapped,
  NAT64, 6to4, unique- and site-local), then a socket pinned to the checked address with the name
  only in SNI and Host; IP literals checked in every notation; no redirects; a fresh connection per
  request; 64 KiB request, 256 KiB response, 10 s; reserved headers and line breaks refused; each
  error says whether the request may have been sent. `W360_EGRESS_ALLOW_LOOPBACK` (http:// and
  loopback test targets) is refused by web and worker configuration outside `APP_ENV=local|test`.
- **Schema (migration 0014):** `http_allowed_domains` (exact names or `*.` wildcards),
  `http_secrets` (encrypted value bound to the row, the one domain it may be sent to, version),
  `automation_http_calls` (one per step visit: method, host, path, the request encrypted until the
  call finishes, state, status or error code, duration, saved values); a trigger keeps a finished
  call final and refuses to queue a call that may have been sent; runs wait for `http` and count
  calls (budget 20, `budget_http`); `ops.automation_http_calls_due` for the sweep; retention and
  contact erasure replaced to clear saved values and cancel calls not yet made.
- **Step and runner (ADR-043):** "Call a web address" (method, address with URL-encoded
  placeholders, up to 10 headers, a JSON body with escaped placeholders, values saved from a JSON
  response by path, success and failure branches) with publish checks (allowed host, no
  placeholders in the host, secrets only in header values and only to their domain, valid JSON).
  The step's transaction writes the call ahead and the run waits up to two minutes; the
  `automation.http` worker claims a queued call, re-checks the current domains and secrets, sends it
  with no locks held and records the outcome, then signals the run. A call is only sent from
  `queued`; one that may have been received without a result is `unknown` at the deadline and never
  repeated; one not made by then (or whose job runs late, for example after a suspension) is
  cancelled. Saved values are kept only for a run that can still use them.
- **Web:** Settings → Web requests (domains; secrets saved write-only for one domain, replaced or
  deleted; a warning about servers that echo headers); the step editor (method, address, headers
  with a ready bearer-token header, body, values to save, both branches); the simulator shows the
  request it would make, sends nothing and lets the tester choose success (with values) or failure;
  run pages list each call with its outcome; the inbox banner says when a run waits for a web
  request; labels for every refusal and egress code.
- **Found while building:**
  - Customer text rendered into a header (a WhatsApp profile name or an answer containing
    `{{secret.x}}`) would have been read as a placeholder by the worker and filled with the secret.
    Header values are now rendered into text and secret parts, so rendered values are never parsed
    again, and customer text is percent-encoded unless it is printable ASCII (a name in another
    script can no longer make the call fail).
  - Anyone who can edit automations could have sent a secret meant for one allowed domain to
    another; secrets are now saved for one domain and the worker refuses a mismatch.
  - The runner read the call without a lock before settling it at the deadline, so a success
    recorded in between would have taken the failure branch; the runner now locks the call.
  - A queued call whose job ran after the run's deadline would have been sent late; it is now
    cancelled.
- **Review fixes (Codex on PR #6):**
  - The call record stored the rendered path, so a customer's value placed in the address outlived
    an erasure; it now keeps the step's path as written (placeholders not filled in).
  - A call left in flight by a worker that died stayed "in progress", with its encrypted request,
    when the run ended before its deadline; ending a run (and erasing its contact, migration 0015)
    now settles such calls as unknown and erases the request.
  - Name resolution now counts against the 10-second deadline, and at most two system lookups run
    at once per worker (they cannot be cancelled), so a slow name cannot hold the thread pool.
  - Every checked address is tried in turn, so one unreachable address (an AAAA record on an
    IPv4-only network, a dead pool member) no longer fails the call.

### Test commands and results (local, 2026-09-27, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm test` (unit)                                                          | 142 passed. New: 13 egress tests (blocked ranges and notations, pinning and Host, fallback to the next checked address, redirects, size and time limits including name resolution, the lookup limit, headers, DNS and connection failures) and HTTP step interpreter tests (rendering, waiting, saved values only on success, customer text never read as a secret, the call budget, publish checks including a secret's domain) |
| `pnpm test:integration` (PostgreSQL 18.x)                                   | 230 passed, including `automation-http.test.ts` 11: a call made once with its secret and values saved, error statuses and refusals by current settings, a crash leaving the call in flight and a late result both ending as unknown, a timeout, cancellation on take-over, at the deadline and for a late job, the lost-job sweep, retention, erasure, settings and isolation                                                    |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 38 passed (19 tests × 2), including web requests: Settings → Web requests, a step built in the editor with a stored secret, tried in the simulator, published, and a live run in which the worker calls a local target once with the secret and answers with the result, and the run page's call list                                                                                                             |

### Known gaps

- Not built: retries a company opts into for idempotent requests, form-encoded bodies, response
  headers or non-JSON bodies as values, OAuth client flows, calls from outgoing webhooks and imports
  (they must use the same guard), a network egress policy in deployment (release checklist).
- Verified only against a local target server; Firefox and WebKit run in CI only.

## 2026-09-27 — Phase 4: CRM (P4-04)

Status: **CRM implemented and locally verified, production blocked on email delivery only.**
Pipelines, deals, tasks, notes, the timeline and the deal reports work on HyFib's own data and send
nothing to Meta. Task reminders are emailed through the outbox; locally they arrive in Mailpit, and
delivery through the production SMTP provider is a release item.

### Completed

- **Schema (migration 0013):** pipelines with one ISO 4217 currency each (no runtime UPDATE grant)
  and ordered stages, both archived instead of deleted; deals (a contact for life, optionally the
  conversation they came from, a value in the currency's minor unit, owner, open/won/lost with a
  lost reason, expected close date, version); tasks (assignee, optionally a contact or one of its
  deals, due and reminder times, reminder state with the reason when skipped); the append-only
  timeline (a trigger refuses edits and deletes except inside contact erasure). Composite foreign
  keys keep references in the company, a deal's stage in its pipeline and a task's or entry's deal
  on the same contact. `ops.crm_reminders_due` (definer, ids of active companies only);
  `app.erase_contact` replaced to delete the contact's timeline, notes and tasks and blank deal
  titles and lost reasons; four metric definitions (deal outcomes v2, win rate, time to win, open
  pipeline).
- **Service:** pipelines (`tenant.settings.manage`, audited, 20 in use at most; removed stages are
  archived only when empty), deals (from a contact or a conversation the member can see; edit,
  move, won/lost/reopen), the board with owner filters and per-stage totals, tasks (mine or
  everyone's, open or closed; done, cancel, reopen, edit), notes, contact and deal timelines, and
  the member's overdue and due-today counts. Every change locks the row, checks its version and
  appends its timeline entry in one transaction. Amounts are parsed exactly (no floats) with the
  currency's ISO decimals.
- **Reminders (queue `crm.reminder`):** a delayed job at the reminder time and the minute sweep for
  lost jobs; the email is queued in the transaction that marks the reminder sent, so it goes out
  once; skipped with a reason when the task closed, the assignee lost CRM access or it is more than
  a day late.
- **Web:** CRM in the navigation (board, won and lost lists, deal page, tasks page),
  Settings → Pipelines, a CRM card on the contact page and next to the conversation in the inbox
  (deals, open tasks, timeline; add a deal, task or note), a "Your tasks" card on the overview,
  and a Deals section with CSV export in Reports. Task times are wall-clock times in the company
  time zone.
- **Found while building:**
  - The money helpers caught and hid errors (falling back to two decimals or a plain string); they
    no longer catch anything, since currency codes are validated when a pipeline is created.
  - "End of today" for due-today counts drifted by up to an hour on daylight-saving days; it is now
    computed from the calendar (unit tests for 23- and 25-hour days).
  - The contact CRM view returned an empty result for another company's contact; it now answers
    "not found", like every other lookup.
  - The pipeline limit counts pipelines in use, not archived ones; the settings page said otherwise.
- **Review fixes (independent review of the slice):**
  - A note, task or deal written while the contact was being erased could survive the erasure (and
    a deal change during an erasure could deadlock with it, or leave a timeline entry). Every CRM
    write now takes a key-share lock on the contact before its deal or task, in erasure's order.
  - A deal created, moved or reopened while an administrator removed its stage (or archived the
    pipeline) could end up open in an archived stage, off the board. Deal writers now share the
    pipeline row, which settings changes lock before counting open deals; a first attempt that also
    locked the stage rows deadlocked with settings changes in the new test and was replaced.
  - A closed deal whose stage had been removed could never be reopened (stages cannot be restored);
    it now reopens in the pipeline's first stage.
  - The deal owner list hid an owner who had lost CRM access; "Deal saved.", "Task saved." and
    "Pipeline saved." vanished when the saved form reloaded; the won and lost lists stopped at 50
    with no way further and their cursor dropped microseconds (skipping deals changed in the same
    millisecond); an impossible date such as 31 February caused an internal error instead of a
    validation message.

### Test commands and results (local, 2026-09-27, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm test` (unit)                                                          | 124 passed. New: 7 CRM tests — ISO currencies and decimals, exact parsing and its refusals, round trips and formatting, day boundaries across daylight-saving changes and month and year ends                                                                                                                                                                                                                                                                                                                                     |
| `pnpm test:integration` (PostgreSQL 18.x)                                   | 219 passed, including CRM 14: pipelines (settings, audit, archive and restore, limit), deals (stage moves, won/lost/reopen, versions, timeline), conversation visibility, notes and tasks on the timeline, reminders emailed exactly once with a fixed clock and their skips, the sweep, erasure (also racing a note and a change, with locks held on a second connection), a stage removed while a deal is created, reopening into a removed stage, paging through deals changed at the same moment, the deals report, isolation |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 36 passed (18 tests × 2), including a pipeline created in settings, a deal added from a contact and from a conversation, a stage move, a task whose reminder email arrives in Mailpit, a note, a win, the board, the tasks page and the reports, with no horizontal overflow on the new pages                                                                                                                                                                                                                      |

Firefox and WebKit run in CI only (not available in this environment).

### Known gaps

- Not built: custom deal fields, products on deals, deal import and export, forecasting, moving a
  deal to another pipeline from the UI (the service supports it), automation steps that create
  deals or tasks, and CRM connectors.
- Reminder emails have been delivered only to Mailpit; a production SMTP delivery is a release item.

## 2026-09-27 — Phase 4: automation engine (P4-01)

Status: **automation engine implemented and locally verified, production blocked.** Runs, the
hand-off to people, restart recovery and reports work on HyFib's own data. Bot messages, including
reply buttons with a header and footer, are verified only against the test-only Graph stand-in,
which checks them against the limits in Meta's OpenAPI spec; a real sandbox run is a release item.
The Phase 4 gate is partly met: "published flow survives restart" and "handoff" are verified
locally; "integration idempotency" waits for the HTTP step (P4-02) and commerce (P4-06).

### Completed

- **Schema (migration 0011):** automations with an editable draft (trigger, steps, number);
  immutable versions (published, and test snapshots of the draft) with a definition hash; runs
  pinned to a version with a durable position (current step, visits, wait state, captured answers,
  budget counters, consecutive failures); an append-only step log; one active run per conversation
  (partial unique index). Reply turns gain a start reason (customer or hand-off) and an `automated`
  end, and the turn trigger skips conversations an automation is handling.
  `ops.conversations_to_route` skips them too; `ops.automation_runs_due` and
  `ops.apply_automation_retention` are new definer functions (ids only). Contact erasure clears
  captured answers and stops the contact's active runs. Twelve metric definition rows: new versions
  of the inbox and member figures that leave automated time out, plus automation runs and outcomes.
- **Model and interpreter (browser-safe):** eight step types (message, question with reply buttons,
  question with a typed answer and format check, condition, contact update, wait, hand-off, end);
  checks for missing and unreachable steps, unknown teams, fields and placeholders, WhatsApp's
  interactive limits and loops that never wait. A pure interpreter is shared by the worker and the
  simulator. Reply-button ids name the run, step and visit; a typed reply equal to a button title
  counts as that button.
- **Dispatch and runner:** ingestion hands a reply to a waiting run, or starts the best matching
  automation (exact keyword, contained keyword, new conversation, any message). A run starts only
  in an unassigned conversation of an active company, subject to business-hours filters, cooldowns
  and 10 runs per conversation per hour.
  - Each step is one transaction (conversation lock, then run lock).
  - Bot messages go through the normal send pipeline, with window, number and WhatsApp id checks.
  - Budgets of 200 steps, 20 visits per step, 50 messages and 7 days.
  - A step that keeps raising an error fails the run after five attempts.
  - The minute sweep re-signals overdue runs and applies retention.
  - Suspended companies defer runs; test runs stop when the tester leaves or loses permission.
- **Hand-off lock:** a member's reply or template send, an assignment, Take over or a resolve ends
  the run and cancels its unclaimed bot sends. Routing skips conversations an automation handles. A
  run that hands off routes the conversation (to a chosen team, or like a new conversation) and opens
  a hand-off turn.
- **Web:**
  - Automations list and editor: trigger, steps with per-step fields, live checks and a generated
    diagram.
  - An in-browser simulator.
  - Save, publish with a note, pause, turn on, archive, restore and delete draft.
  - Test runs on a real conversation, and versions.
  - Run list and run pages with step logs and captured answers (captured answers only for members
    who can see the conversation).
  - Inbox: an "Automation" badge, labelled bot messages and a banner with Take over.
  - Reports → Automations: outcomes, failures by reason, per automation and per day, and a CSV
    export.
- **Found while building:**
  - The definer role could not read columns used in erasure's `CASE` expressions, so erasure now
    updates runs in two statements.
  - Erasure now locks conversations before contacts (the order every writer uses), avoiding a
    deadlock with the runner.
  - `GROUPING()` rejects parameterised expressions, so report rows are told apart by their null
    columns.
  - Versions of a metric definition must stay adjacent in the registry.
  - Mobile layouts needed `minmax(0,1fr)` columns.
  - A step that kept raising an error would have held the conversation for up to seven days; it now
    fails after five attempts.
- **Review fixes (Codex on PR #5):**
  - A run moved on (or completed) as soon as its message was queued, even if Meta then rejected it.
    Runs now wait for Meta to accept each message (migration 0012 records the pending message; the
    send worker signals the run when the send is settled). A rejected, cancelled, unknown or late
    message, or a failure Meta reports later, fails the run with `send_failed` and hands the
    conversation to people.
  - A marketing opt-out keyword was taken as the answer to a waiting question; any opt-out now stops
    the run.
  - An answer used before the question that saves it (for example in the first message) passed the
    checks. Answers are now checked along the paths that reach each step: never saved there is an
    error, saved on only some paths a warning ("is set" rules excepted).
  - Each bot message now takes a send job and an automation signal, so the worker polls the
    webhook, send and automation queues every second instead of every two.

### Test commands and results (local, 2026-09-27, fresh database)

| Command                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`                        | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm test` (unit)                                                          | 117 passed. New: 13 automation tests — graph checks (targets, reachability, answers saved on the way to each step, loops, teams and fields, WhatsApp limits), trigger ranking, and the interpreter (taps, typed titles, stale and forged ids, answers and formats, conditions, timers, budgets, placeholders)                                                                                                                                                                        |
| `pnpm test:integration` (PostgreSQL 18.x)                                   | 205 passed, including automations 15: versions and pinning, roles, a full flow with a team hand-off, no competing replies, hours, cooldown and hourly cap, concurrent arrivals, crash and lost-signal recovery with real pg-boss consumers, a step that keeps failing, Meta rejecting, later failing or not accepting a message, timers and budgets, opt-outs (all and marketing), erasure, test runs (and a tester losing permission), reports, suspension and retention, isolation |
| `pnpm build` / `pnpm test:e2e --project=chromium --project=mobile-chromium` | build passes / 32 passed (16 tests × 2), including an automation built in the editor, tried in the simulator, published with a note, run by the worker from a signed webhook, a typed button title handing over to people, the run log, Take over, the automation report and pause, with no horizontal overflow on the new pages                                                                                                                                                     |

### Known gaps

- Not built: the HTTP step (P4-02), Flows and catalog steps, starting runs from the API or
  campaigns, template follow-ups outside the service window, fuzzy keywords, a drag-and-drop
  canvas, and usage billing for automations.
- No run on a real WhatsApp number yet (release checklist). Migration 0011 re-checks the reply-turn
  constraints under a table lock; rehearse it on production-sized data.

## 2026-09-26 — Phase 3: inbox teams, routing, business hours, CSAT (P3-06)

Status: **implementation complete for the advanced inbox, production blocked** (routing, timers,
saved replies and mentions work on HyFib's own data; CSAT surveys are WhatsApp interactive messages
verified only against the test-only Graph stand-in, which checks them against the limits in Meta's
OpenAPI spec; a real tap from a sandbox number is a release item).

### Completed

- **Schema (migrations 0009, 0010):** teams, team members and member availability;
  `conversations.team_id` and a number's default team (`channel_accounts.default_team_id`);
  business hours and closed days; `app.conversation_cases` (open → resolve, maintained by triggers,
  immutable once resolved); saved replies; note mentions (deleted with their note); CSAT surveys
  (sent or skipped with a reason, first answer only, guarded by a trigger); the reply-turn trigger
  ignores CSAT taps; `ops.conversations_to_route` (definer, ids only) for the routing sweep; eleven
  metric definition rows (four new versions whose text said business hours were not supported, and
  business-hours first response, overdue, resolution time, CSAT surveys, response rate, score and
  CSAT per member). The team index is built concurrently in its own migration.
- **Routing:** keyword teams (whole words, any script) before the number's team; round robin to
  the next available member below the team's limit; one advisory lock per company; a minute sweep;
  immediate routing when a member becomes available or a team is saved; release of a member's
  conversations when they are suspended, removed, leave or lose inbox access; routing decisions in
  the audit log. Teams never change visibility (ADR-029).
- **Business hours and timers:** weekly ranges and closed days in the company time zone
  (daylight-saving aware); reply-due timers in the inbox list and thread, paused outside business
  hours; a longest-waiting order; team, number and customer filters.
- **Reports:** first response in business hours, overdue now, answered within target counted in
  business hours when business hours are on, resolution times from cases, a CSAT section with
  delivered and answered denominators and skip reasons, CSAT per member, new CSV columns and a CSAT
  export.
- **Saved replies, mentions, collisions:** supervisors manage saved replies with `{{name}}`,
  `{{agent}}` and `{{company}}` placeholders filled for the conversation; notes mention members who
  can see the conversation (Inbox → Mentions with an unread count); a reply is refused once when
  another member replied after the sender's last seen message.
- **CSAT:** on resolve, one question with three reply buttons inside the service window for contacts
  who have not opted out, at most once a day per conversation, re-checked at send time; the first
  tap matching the survey's button id and message context is recorded; taps never reopen the
  conversation, start a reply turn or count as keywords or campaign replies. Research rows M-157
  and M-158 record the reply-button limits and webhook shape from Meta's OpenAPI spec, fetched
  directly from GitHub (developers.facebook.com is blocked here).
- **Web:** Settings → Inbox (target, business hours, closed days, CSAT), Settings → Teams (teams,
  routing, who is taking conversations), Settings → Saved replies; inbox availability switch, filters,
  mentions view, timers, team control, saved-reply picker, mention picker, CSAT status and messages;
  reports sections. The response target moved from Settings → Messaging to Settings → Inbox.
- **Found while testing:** paging through the longest-waiting order repeated the first row on the
  next page, because turn start times carry microseconds and cursors milliseconds; the order and
  cursor now use millisecond-truncated times. Drizzle writes `FOR UPDATE OF` with a schema-qualified
  table name, which PostgreSQL rejects; the CSAT answer lock uses a plain row lock instead.

### Test commands and results (local, 2026-09-26, fresh database)

| Command                                                      | Result                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`         | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                                                                               |
| `pnpm test` (unit)                                           | 104 passed (adds business-time arithmetic across closing times, weekends, closed days and 23/25-hour days, open/closed status, paused timers, range parsing, keyword matching and rotation)                                                                                                                                                                                                  |
| `pnpm test:integration` (PostgreSQL 18.x)                    | 190 passed: inbox advanced 14 (teams, number and keyword routing, rotation, limits with six simultaneous customers, the sweep, release on suspension, team moves, cases, list filters and timers, saved replies, mentions, collisions), CSAT 6, reports 16 (adds business-hours figures, resolution times and CSAT against hand-computed values with a fixed clock), plus the earlier suites |
| `pnpm test:e2e --project=chromium --project=mobile-chromium` | 30 passed (15 tests × 2), including settings for business hours, closed days, CSAT, a round-robin team and a saved reply, routing to the available owner, the team filter, a saved reply sent, the CSAT question and a tap, the CSAT report, and no horizontal overflow on the new pages                                                                                                     |

### Known gaps (tracked in BACKLOG.md)

Per-team SLA targets and calendars, breach notifications, presence and typing indicators,
conversation tags, private team queues, mention emails, CSAT outside the service window, a CSAT run
with a real WABA.

## 2026-09-26 — Phase 3: reports (P3-05)

Status: **implementation complete for reports, production blocked** (every number is computed from
HyFib's own records, so reports are only as real as the messaging behind them: delivery statuses
and pricing come from Meta's webhooks, verified here only with the test-only Graph stand-in; cost
estimates need platform staff to publish Meta's current rate cards, none ship with HyFib).

### Completed

- **Schema (migrations 0007, 0008):** `ops.metric_definitions` (what each number counts,
  denominator, window, time-zone rule, missing-data semantics, freshness; immutable, versioned, and
  kept identical to the registry in `packages/domain/src/reports/definitions.ts` by a test);
  `app.conversation_turns` (reply turns: start at the first customer message without a member reply,
  end on a member reply or when the conversation is resolved) maintained by triggers on
  `app.messages` and `app.conversations`, so every write path is covered; the company's
  first-response target; `campaigns.estimate_currency`; a `(tenant_id, created_at)` index on
  messages built concurrently in its own migration.
- **Reports service:** one repeatable-read, read-only snapshot per report, periods of whole days in
  the company's time zone (daylight-saving days have their real length; a skipped midnight starts
  the day at its first real instant; at most 92 days):
  - messaging outcomes by day and sender with explicit denominators, and Meta's failure codes;
  - estimated Meta charges: delivered messages Meta marked billable, priced at the list price of the
    published rate card in force when each message was recorded, by the recipient's market and
    Meta's pricing category; free and not-yet-priced messages, and each reason a billable message
    could not be priced, are listed instead of guessed;
  - inbox queue now (open, unassigned, waiting, longest wait, reply windows closing, waiting past the
    target, by assignee) and reply turns of the period (median and 90th-percentile first response,
    share within the target, resolved without a reply, reply-time spread, per day);
  - member activity (replies and templates sent, turns answered first with their median, resolves
    from the audit log; members who can reply are listed even when quiet);
  - campaign funnels for campaigns started in the period;
  - automation outcomes, deal outcomes and retention cohorts reported as not available, with the
    reason.
- **Exports:** one CSV per section, formula-safe, `reports.export` only, audited before any data is
  returned (`report.exported` with the period).
- **Inbox:** resolving or reopening a conversation is audited (`conversation.status_changed`);
  Settings → Messaging → Inbox response target.
- **Web:** Reports page (period presets and custom dates, the sections above, definitions of every
  number) and export route; the Reports module is now available.
- **Found while building and testing:**
  - a campaign's estimates used the company's current billing currency on every tick, so changing
    the currency during a run would have mixed currencies; the currency is now fixed per campaign
    the first time it is known;
  - the inbox live stream started "now", so a message arriving between the page render and the
    browser connecting stayed hidden until the next event; pages now pass the event-log position
    read before loading their data and the stream replays from there;
  - several pages scrolled sideways on phones (grids let wide tables stretch the page, header
    buttons did not wrap); 17 company pages (lists, forms and settings) were measured at 412 px
    and now fit, and e2e tests assert no horizontal overflow on the reports and contacts pages
    (detail pages were not measured);
  - the integration fixture minted WhatsApp ids from a per-file counter, so two test files could
    collide (seen once on PostgreSQL 17 in CI); ids are now random.
- **Review findings on the campaigns slice (PR #4), fixed with regression tests:**
  - when the member whose authority a campaign used left, sends the worker rejected stayed
    "queued" with failed messages and the pause did not release the rest, so a resumed campaign
    never reached those recipients; rejected and unclaimed sends now return their recipients to
    pending (also after a company suspension) and the counters are recomputed;
  - opt-outs were credited to the last campaign message even when it had failed, and reply and
    opt-out rates could exceed their delivered denominator; only messages WhatsApp accepted are
    credited now, rates count delivered recipients only, and a 131050 failure is recorded before
    its opt-out so the failing message itself is never credited.

### Test commands and results (local, 2026-09-26, fresh database)

| Command                                                      | Result                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`         | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                                                     |
| `pnpm test` (unit)                                           | 96 passed (adds report periods: presets, company date, 23- and 25-hour days, skipped midnights, validation; exact export amounts)                                                                                                                                                                                                  |
| `pnpm test:integration` (PostgreSQL 18.x)                    | 166 passed: reports 12 (definitions persisted = registry and immutable, turns through real ingest/reply/resolve paths and immutable, report numbers against hand-computed values, exports and permissions, isolation), campaigns 17 (adds the launcher-removed regression and failed-message attribution), plus the earlier suites |
| `pnpm test:e2e --project=chromium --project=mobile-chromium` | 28 passed (14 tests × 2), including a response target set, two customers writing, one answered, the report's numbers, a CSV export and a rejected over-long period                                                                                                                                                                 |

### Known gaps (tracked in BACKLOG.md)

Business-hours calendars for response times; reconciling estimates with Meta's
`pricing_analytics` (research M-078, not verified); automation, deal and retention reports (their
modules are not built); scheduled report emails.

## 2026-09-26 — Phase 3: campaigns and saved segments (P3-04)

Status: **implementation complete for campaigns and segments, production blocked** (campaign
sends are verified only against the test-only Graph stand-in; a real Meta app, app review and a
sandbox WABA with test recipients are external prerequisites; cost estimates need platform staff to
copy Meta's current rate cards, none ship with HyFib; the 10,000-recipient run happened locally, not
in staging). Reports (P3-05) are not built yet.

### Completed

- **Schema (migration 0006):** segments; campaigns (template, number, variable mapping, audience,
  wall-clock schedule, window, pacing, caps, approval, lifecycle, counters); campaign recipients (ids
  and outcomes only) and campaign history (append-only); `messages.campaign_id`; company campaign
  settings (approval, marketing frequency cap, estimate currency); platform rate cards (immutable
  once published, guarded by triggers); `ops.campaigns_due` (definer, app role only). **Found by the
  10,000-recipient test:** with statistics stale after a bulk import, the planner used the
  `(tenant_id, purpose, status)` consent index and the `(tenant_id, whatsapp_account_id, wa_id)`
  identity index for per-contact lookups, making the snapshot quadratic (6.4 s and 1.7 M buffer hits
  for 10,000 contacts, a statement timeout in the test). The migration drops that consent index and
  adds a per-contact identity index; the same query now takes about 0.1 s.
- **Segments:** tags, consent, typed custom fields, creation date (company time zone), source, recent
  inbound messages, calling code and campaign responses (retargeting), all/any, parameterised SQL,
  preview, version-checked edits, archive.
- **Campaigns:** draft editor with a live preview and a review panel; submission freezes the
  audience; optional four-eyes approval; scheduling in IANA time zones (gaps move forward, repeated
  times use the first occurrence); sending window; deadline; pacing; marketing frequency cap; message
  and estimated spending caps; pause/resume (resumer takes over); idempotent cancel; test sends to
  existing contacts through the normal consent checks; per-recipient outcomes, last-touch reply and
  opt-out attribution within 72 hours, results with explicit denominators, failure codes explained,
  formula-safe audited CSV export.
- **Runner:** `campaign.run` ticks under the campaign's row lock and a per-company advisory lock,
  re-check each recipient with fresh data and queue ordinary messages through the Phase 2 pipeline
  (batch insert of messages, intents and jobs); the send worker refuses messages of paused or
  cancelled campaigns; the messaging sweep re-signals lost ticks. **Found by tests:** automatic pauses
  for a spending or message cap first released the sends queued in the same tick; only authority,
  template and number problems release queued sends now.
- **Platform:** rate-card console (CSV in Meta's layout, publish, withdraw with a reason; platform
  audit log).
- **Web:** Campaigns (list, new, draft/review, approval, controls, results, history, recipients,
  export), Contacts → Segments, Settings → Messaging → Campaigns, Platform → Meta rate cards. The
  Campaigns module is now available.

### Test commands and results (local, 2026-09-26, fresh database)

| Command                                                      | Result                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`         | 0 problems / all files formatted / all workspace packages pass                                                                                                                                                                                                                                     |
| `pnpm test` (unit)                                           | 90 passed (adds time zones and daylight saving, sending windows, variable mapping, cost arithmetic and prefixes, rate-card CSV)                                                                                                                                                                    |
| `pnpm test:integration` (PostgreSQL 18.x)                    | 153 passed: campaigns 16 (segments, lifecycle and attribution, live re-checks, test sends, cancel races, approval, pause/resume, launcher losing permission, schedules and windows, frequency cap, spending and message caps, isolation, 10,000 recipients), isolation 45, plus the earlier suites |
| `pnpm test:e2e --project=chromium --project=mobile-chromium` | 26 passed (13 tests × 2), including a campaign drafted, reviewed, started, queued by the worker, sent to the Graph stand-in, delivery counted, recipients and export                                                                                                                               |

10,000-recipient run (local, one machine, PostgreSQL 18 in Docker): snapshot 629 ms; 21 runner ticks
queued all 10,000 messages in 7.0 s. Real sending is paced by the per-number rate (default 20 per
second, about 8.5 minutes for 10,000) and by Meta's limits; that part was not measured.

### Known gaps (tracked in BACKLOG.md)

Reports (P3-05); the 10,000-recipient run in staging with real dispatch; per-recipient time zones;
A/B variants; reading the number's messaging tier from Meta; campaign sends through the public API;
media-header templates.

## 2026-09-26 — Phase 3: contacts, consent and templates

Status: **implementation complete for contacts, consent and templates, production blocked**
(template submission, sync and sends are verified only against the test-only Graph stand-in; a real
Meta app with `whatsapp_business_management`, app review and a sandbox WABA are external
prerequisites; Meta's opt-in guidance (M-131) and per-market consent law still need review).
Campaigns and reports (P3-04, P3-05) are not built.

### Completed

- **Schema (migration 0005):** contact email, typed custom values, source and erasure time; one
  contact per number (unique index); tags, custom field definitions, import runs; append-only
  consent events with trigger-maintained state (definer trigger); suppression list; company
  messaging settings; message templates with status history; template sync bookkeeping per WABA;
  `messages.template_id`; `app.erase_contact` and `ops.template_sync_due` (definer, app role only);
  a status-history guard that lets only the erasure function clear recipient ids. Found by the new
  tests: PostgreSQL regular expressions cap repetition counts at 255, so the template-name check is
  a character class plus a length check.
- **Contacts:** create, edit (numbers from WhatsApp are read-only), tags, typed custom fields,
  search and filters with keyset pages, CSV import (preview, explicit mapping, national or
  international numbers, never guessed; row errors by row number; consent only with an attestation
  and never over an opt-out), streaming formula-safe export, erasure. Inbound identities join the
  contact that already has the number, and the WhatsApp id Meta returns on a template send becomes
  an identity.
- **Consent:** keyword opt-outs/opt-ins from inbound text, quick-reply and interactive replies
  (company-configurable lists), member-recorded consent with a note, import consent, Meta 131050
  opt-outs, erasure opt-outs. Opt-outs win ties and the one-second uncertainty of Meta timestamps
  (found by a test in which a STOP sent in the same second as an agent's opt-in lost).
- **Templates:** editor with live preview and local validation; write-ahead submission; sync from
  the paged Graph listing (default-fields fallback), adoption of lost create responses and of
  templates made in WhatsApp Manager, failure of submissions Meta never received; deletion; template
  webhooks as sync signals through verified WABA bindings; per-minute sweep.
- **Template sends:** from a contact page (utility: inbox or campaign permission; marketing:
  campaign permission) and from the inbox when the 24-hour window has closed; consent, suppression
  and template approval re-checked right before dispatch; 132015/132016 mark the template paused or
  disabled; 131050 records an opt-out.
- **Web:** Contacts (list, add, detail, import, export), Templates (list per account with refresh,
  editor, detail with history), Settings → Messaging (keywords, marketing opt-in requirement,
  suppression list, custom fields); the inbox renders template messages and offers templates when
  the window is closed. Contacts and Templates modules are now available.

### Test commands and results (local, 2026-09-26, fresh database)

| Command                                                      | Result                                                                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`         | 0 problems / all files formatted / all workspace packages pass                                                                                               |
| `pnpm test` (unit)                                           | 72 passed (adds phone normalisation, CSV reader/writer, consent keywords and timing, template definitions)                                                   |
| `pnpm test:integration` (PostgreSQL 18.x)                    | 136 passed: contacts/consent/erasure 13, templates 12, isolation 44 (new function-privilege assertions), messaging 21, billing 30, jobs/email 14, services 2 |
| `pnpm test:e2e --project=chromium --project=mobile-chromium` | 24 passed (12 tests × 2), including contact creation, consent, CSV import/export and a template drafted, submitted, approved, synced and sent from the inbox |

Firefox and WebKit are not installed in this sandbox; they run in CI. Meta traffic in these tests
comes from the test-only Graph stand-in (`tests/support/graph-stand-in.ts`); no template has been
submitted to the real Graph API.

### Known gaps (tracked in BACKLOG.md)

Campaigns and saved segments (P3-04), reports (P3-05), safe contact merge (H-019), number masking
(W-044), media headers and other template types, URL buttons with variables (example format
unconfirmed, M-151), editing approved templates, sandbox verification of template submission, sync
fields (`rejected_reason`, `quality_score`) and template webhook payloads.

## 2026-09-26 — Phase 5 financial core (section 8A)

Status: **implementation complete for the wallet, top-up and auto-recharge slice, production
blocked** (Razorpay merchant activation, Recurring Payments for card mandates and a sandbox run are
external prerequisites; no request has reached the real Razorpay API; GST treatment of service
credit needs tax review; subscriptions are not built).

### Completed

- **Schema (migration 0004):** wallets, five ledger accounts per wallet, append-only ledger
  transactions and entries (balances by trigger, deferred balance check at commit), holds, Razorpay
  customers, card mandates (provider references and safe card metadata only), auto-recharge
  settings and attempts (one active attempt per wallet by partial unique index), top-ups. FORCE RLS
  everywhere, restrictive policies so runtime code can never mark a top-up paid or an attempt
  succeeded, support reads behind `billing.read` grants, and SECURITY DEFINER functions for every
  posting (credit, refund, dispute loss, hold/settle/release, auto-recharge decision) plus sweep
  and provider-id resolution functions.
- **Domain:** Razorpay client with classified results (retryable / permanent / auth / unknown) and
  constant-time signature checks; payment application from authoritative fetches only (payments,
  refunds, disputes, tokens); webhook receipt processing with quarantine; top-up reconciliation
  with backoff and expiry; the auto-recharge state machine with write-ahead unknown states and
  reconciliation by receipt / order payments; card mandate setup with the ₹1 authorisation refunded
  by idempotency key and abandoned tokens deleted; billing service for the web; owner/billing-role
  email notices; holds API for billable services.
- **Worker:** `billing.event-process`, `billing.auto-recharge` (check or advance), and a per-minute
  `ops.billing-sweep` (stale receipts, reconciliation, candidates, expired holds).
- **Web:** `/api/webhooks/razorpay`; Billing page (balance, add credit through Standard Checkout,
  card mandate, auto-recharge settings and attempts, payments, credit history) with the Razorpay
  CSP, COOP and Permissions-Policy scoped to that page. Found by the new e2e test: a CSP belongs to
  the loaded document, so provider pages (Billing, Channels) are now full page loads and reload
  once if reached by client-side navigation.
- **CI fix (0366b00):** WebKit e2e failed because input typed before hydration was reset by
  react-hook-form (and a pre-hydration click would have submitted the form natively). Client forms
  and click-handler buttons are disabled until hydration; regression test added. All 8 CI checks
  green on `0366b00`.

### Test commands and results (local, 2026-09-26, fresh database)

| Command                                                      | Result                                                                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck`         | 0 problems / all files formatted / all 9 workspace packages pass                                           |
| `pnpm test` (unit)                                           | 49 passed (adds Razorpay signatures, client classification, Razorpay config)                               |
| `pnpm test:integration` (PostgreSQL 18.x)                    | 111 passed: billing 30, isolation 44, messaging 21, jobs/email 14, services 2                              |
| `pnpm test:e2e --project=chromium --project=mobile-chromium` | 20 passed (10 tests × 2), including a card top-up through the billing page and the signed Razorpay webhook |

Razorpay traffic in these tests comes from a test-only stand-in (`tests/support/razorpay-stand-in.ts`);
in the e2e run Playwright replaces `checkout.js` inside the test browser only. The configuration
refuses a non-official Razorpay origin outside `APP_ENV=local|test` and live keys outside
production.

### Known gaps (tracked in BACKLOG.md)

Plans and subscriptions (P5-01), statements, receipts and GST invoices, refunds initiated from the
platform console, step-up re-authentication for payment settings, Razorpay sandbox verification of
every flow and of the Checkout CSP, billable services that use holds (phase 6).

## 2026-09-26 — Phase 2 messaging slice

Status: **implementation complete for the phase 2 slice, production blocked** (Meta app, business
verification, app review and Embedded Signup configuration are external prerequisites; no message
has been exchanged with the real WhatsApp Cloud API).

### Completed

- **Schema (migration 0003):** WhatsApp accounts and numbers, onboarding sessions, contacts with
  per-WABA identities (BSUID first, phone optional), conversations (optimistic versions), notes,
  messages, immutable status history, send intents, media metadata, company event log (xid8
  cursors, NOTIFY hint), provider asset bindings, encrypted webhook receipts, quarantine, token
  buckets, retention functions. FORCE RLS and composite FKs on every tenant table; definer functions
  granted before ownership transfer.
- **Hardening (migration 0002, from review):** membership directories behind `members.read` support
  grants; platform seat counts and owner lookup through narrow definer functions; PUBLIC execute
  removed from every function (it had been granted by PostgreSQL's global default), with a
  structural test.
- **Domain:** webhook signature verification (current + previous secret), durable receipts,
  idempotent ingestion with quarantine and monotonic statuses, outbound send state machine
  (retries with jitter, per-number token bucket and fairness groups, unknown outcomes never resent
  automatically, manual resolution, cancellation on suspension or sender removal), Embedded Signup
  onboarding with server-side verification, resumable setup jobs, inbox service (visibility,
  assignment and status with row locks and versions, notes, read state), live-update event log with
  visibility filtering, retention.
- **Worker:** `webhook.process`, `message.send` (re-signals at `retryAt` in the number's group),
  `channel.onboard`, and a per-minute messaging sweep (lost signals, dead workers, retention).
- **Web:** `/api/webhooks/meta` (handshake, streaming 4 MB cap, signature, receipt before 200),
  `/api/c/{slug}/events` (SSE with replay, 30 s re-validation, polling mode), Inbox (views, thread,
  composer with per-member-and-company drafts and idempotency keys, window indicator, assignment,
  resolve/reopen, notes, unknown-outcome decisions, live updates), Settings → Channels (Embedded
  Signup, setup status, retry, disconnect) with Facebook CSP/COOP scoped to that page.
- **CI fixes:** WebKit dropped `Secure` cookies on loopback http (cookie security now follows the
  https origin; staging/production refuse non-https in any build mode); runtime images no longer
  ship npm/corepack/yarn (HIGH CVEs in npm's bundled dependencies); reviewed gitleaks false positive
  recorded. All 8 CI checks green on `e01bc26`.

### Test commands and results (local, 2026-09-26, fresh database)

| Command                                                                 | Result                                                                                                               |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm format:check`                                       | 0 problems / all files formatted                                                                                     |
| `pnpm typecheck`                                                        | all 9 workspace packages pass                                                                                        |
| `pnpm test` (unit)                                                      | 39 passed (adds config safety, IP parsing)                                                                           |
| `pnpm test:integration` (PostgreSQL 18.x)                               | 81 passed: isolation 44, messaging 21, jobs/email 14 (+2 service tests)                                              |
| `pnpm test:e2e --project=chromium --project=mobile-chromium`            | 16 passed (8 tests × 2): live inbox (signed webhook → SSE → reply → delivery receipt), forms disabled until hydrated |
| Webhook smoke (`curl`)                                                  | handshake 200 with challenge; wrong verify token 403; unsigned 401; 5 MB body 413                                    |
| `docker build` web and worker; Trivy 0.74.0 (HIGH/CRITICAL, fixed only) | both images build; no findings                                                                                       |

Meta traffic in these tests comes from a test-only Graph API stand-in (`tests/support/`), which the
configuration refuses outside `APP_ENV=local|test`. Firefox and WebKit run in CI.

### Known gaps (tracked in BACKLOG.md)

Media download and storage, templates and template sends, message search, token health checks,
platform quarantine screen, messaging-limit display, collision warnings, Meta-side deregistration.

## 2026-09-26 — Phase 0 and Phase 1 vertical slice

### Completed

- **Phase 0:** repository assessment (empty repository: README + LICENSE only); toolchain research
  and pinning (ADR-002); research files for the WATI benchmark (164 capabilities), Meta WhatsApp
  platform (148 claims, Graph API v26.0) and Razorpay/RBI (105 claims) under
  `docs/research/`; dated feature matrix with truthful status (`docs/FEATURE-MATRIX.md`, generated);
  architecture, decisions, threat model, security, backlog, Meta setup, deployment, runbooks,
  retention, release checklist.
- **Phase 1:**
  - PostgreSQL roles (owner/app/auth/platform/definer), schemas `app`/`auth`/`ops`, FORCE RLS,
    column grants, SECURITY DEFINER entry points (create company, invitation preview/accept,
    last-owner guard, tenant status, account recovery), append-only audit tables.
  - Forward-only migration runner with checksums and pg-boss installation/queue declaration.
  - Better Auth identity (verified email required, TOTP 2FA, DB sessions, DB rate limits,
    enumeration protection).
  - Domain services: tenant context resolution, permission matrix, tenancy (companies, members,
    invitations, audit), platform administration, job signing/authorization, email outbox/delivery.
  - Web: sign-up/in, verification, reset, two-factor, onboarding, invitations, company overview,
    settings (general, members, security, audit log, modules), account (profile, 2FA, password,
    sessions), platform area (companies, suspension, support grants, MFA recovery); CSP nonces and
    security headers.
  - Worker: email delivery, outbox sweeper schedule, health probes, graceful shutdown.
  - Docker images (web, worker+migrate), compose dev stack, CI workflows (quality, integration on
    PG 17/18, build, e2e on Chromium/Firefox/WebKit/mobile, security, containers), Dependabot.

### Test commands and results (local, 2026-09-26)

| Command                                                                                                               | Result                                                                          |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm lint`                                                                                                           | 0 errors, 0 warnings                                                            |
| `pnpm format:check`                                                                                                   | all files formatted                                                             |
| `pnpm typecheck`                                                                                                      | all 9 workspace packages pass                                                   |
| `pnpm test` (unit)                                                                                                    | 24 passed (crypto, money, ids, permission matrix, job envelope, AppError brand) |
| `pnpm test:integration` (PostgreSQL 18.x in Docker)                                                                   | 54 passed: tenant isolation 40, jobs/email 14                                   |
| `pnpm build`                                                                                                          | web (22 routes) and worker bundles built                                        |
| `pnpm test:e2e --project=chromium --project=mobile-chromium` (local Chromium build 1194 via `PW_CHROMIUM_EXECUTABLE`) | 10 passed (5 tests × 2 projects)                                                |
| `pnpm audit --audit-level=high`                                                                                       | no known vulnerabilities                                                        |
| `docker build` web and worker images; run against local DB                                                            | both start; readiness OK; headers verified                                      |

Firefox and WebKit e2e runs happen in CI (browsers are not installed in this sandbox).

First CI run on PR #1 (commit `d9687b7`, 2026-09-26): lint/types/unit, integration on PostgreSQL 17
and 18, and the web/worker build passed; e2e passed on Chromium, Firefox and mobile but failed on
WebKit; both container scans and the secret scan failed. Root causes and fixes:

- WebKit drops `Secure` cookies on `http://localhost`, and the auth cookies were marked secure
  whenever `NODE_ENV=production` (CI runs `next start` over loopback http). Cookie security now
  follows the https origin, and staging/production refuse non-https origins in any build mode.
- Trivy flagged HIGH CVEs in the npm copy bundled with the Node base image (`brace-expansion`,
  `ip-address`, `tar`). The runtime images no longer ship npm, npx, corepack or yarn; local Trivy
  0.74.0 scans of both images report no HIGH/CRITICAL fixed vulnerabilities.
- gitleaks matched an empty `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=` in `.env.example` together with the
  next line (false positive; no value was committed). The fingerprint is recorded in
  `.gitleaksignore` and the variables are now separated by a comment.

Review round 1 (Codex on `d9687b7`), fixed in the following commit:

- Platform staff read company membership directories only through a `members.read` support grant;
  the console uses aggregate seat counts and an owners-only lookup (definer functions, platform
  administrators only). The company page loads by id instead of searching the newest 200.
- Support-access revocation is mirrored into the company audit log.
- Invitation issuance takes a per-company transaction lock, so the daily quota holds under
  concurrency (integration test: six concurrent requests at 99/100 yield exactly one invitation).
- Client IPs are resolved from `X-Forwarded-For` right-to-left past `TRUSTED_PROXIES` and validated
  with Node's IP parser; malformed values are dropped instead of failing the audited transaction.
- Found while testing: every `app`/`ops` function was executable by PUBLIC (a per-schema default
  cannot revoke the global default), and grants issued after transferring functions to
  `w360_definer` were no-ops. Migration `0002_platform_access_hardening` revokes PUBLIC, sets the
  global default for the migration role and re-grants as the owner; a structural test now fails if
  any function is executable by PUBLIC.

### Running end-to-end tests locally

```bash
bash scripts/local-db.sh up && docker compose -f infra/docker-compose.yml up -d mailpit
set -a; . ./.env; set +a; export APP_ENV=test
pnpm db:migrate && pnpm build
(cd apps/web && npx next start --port 3000 &) ; (cd apps/worker && NODE_ENV=production node dist/main.js &)
E2E_DATABASE_URL_AUTH=$DATABASE_URL_AUTH pnpm test:e2e --project=chromium
```

The inbox e2e test needs the test-only Meta settings in `.env` (web and worker):
`META_APP_ID`, `META_APP_SECRET` (any random value), `META_GRAPH_API_VERSION=v26.0`,
`META_WEBHOOK_VERIFY_TOKEN`, `META_GRAPH_BASE_URL=http://127.0.0.1:4010` and `E2E_GRAPH_PORT=4010`;
Playwright's global setup starts the Graph stand-in on that port. Without them the test is skipped.
The billing e2e test similarly needs `RAZORPAY_KEY_ID=rzp_test_…`, `RAZORPAY_KEY_SECRET` and
`RAZORPAY_WEBHOOK_SECRET` (random values), `RAZORPAY_API_BASE_URL=http://127.0.0.1:4020` and
`E2E_RAZORPAY_PORT=4020`.
The web request e2e test calls a local target server: set `W360_EGRESS_ALLOW_LOOPBACK=true` for the
web, the worker and Playwright, and `E2E_HTTP_HOST` to a name that resolves to 127.0.0.1 (for example
add `127.0.0.1 api.w360-e2e.test` to `/etc/hosts`, as CI does). Without them the test is skipped.

### Blockers (external)

- Network policy of this build environment blocked `wati.io`, `developers.facebook.com`,
  `business.whatsapp.com` and `razorpay.com`; research relies on search summaries and official GitHub
  sources and must be re-verified.
- Meta: business verification, Tech Provider app review, Embedded Signup configuration.
- Razorpay: merchant activation (Orders, Subscriptions, Recurring Payments card mandates).
- Owner decisions: SMTP provider and sending domain, hosting provider/region, legal entity for billing.

### Next task

Phase 3 foundations that unblock real usage: contacts with consent provenance and suppression,
message templates (drafts, Meta submission, approval sync) and template sends, then campaigns with
send-time consent checks. In parallel: phase 2 follow-ups (media storage, token health, quarantine
screen) and P5-01 plans and subscriptions.
