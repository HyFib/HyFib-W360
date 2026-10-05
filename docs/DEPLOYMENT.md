# Deployment

Last updated 2026-10-04. Nothing has been deployed to a shared environment yet; this document is the
deployment design plus the procedures verified locally (Docker images built and run against
PostgreSQL 18; CI workflow authored).

## Environments

| Environment | Purpose                            | Data                         | Notes                                                                                 |
| ----------- | ---------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| local       | Development                        | Synthetic                    | `scripts/local-db.sh`, Mailpit, `pnpm dev:*`                                          |
| CI          | Automated checks                   | Ephemeral                    | PostgreSQL 17/18 services, Mailpit, production builds with `APP_ENV=test` on loopback |
| staging     | Pre-production, provider sandboxes | Synthetic/test accounts only | Same topology as production, smaller sizes                                            |
| production  | Customers                          | Real                         | Requires every gate in `docs/RELEASE-CHECKLIST.md`                                    |

## Artefacts

- `infra/docker/web.Dockerfile` → Next.js standalone server (`node apps/web/server.js`, port 3000,
  non-root, health check `/api/health/live`).
- `infra/docker/worker.Dockerfile` → worker (`node dist/main.js`, health on `WORKER_HEALTH_PORT`,
  default 9464) and migration runner (`node dist/migrate.js`, SQL files at `/app/migrations`).
- Builds behind a TLS-intercepting proxy may pass an extra CA as a BuildKit secret
  (`--secret id=extra_ca,src=…`); it is never baked into images.
- Both runtime images install the updates Debian has released since the Node base image was built
  (the build fails when `deb.debian.org` cannot be reached), so a fixed vulnerability in a Debian
  package does not wait for the base image to be rebuilt. CI's image scan (Trivy) fails on any HIGH
  or CRITICAL vulnerability that has a fix.

## Production topology (target)

- Load balancer with TLS 1.2+ and HTTP/2 (SSE), WAF/rate limiting at the edge (including the public
  chat-link, widget and price list routes, see below).
- `web` ≥ 2 replicas (stateless); `worker` ≥ 2 replicas (jobs are claim-safe; schedules are
  deduplicated by pg-boss).
- Managed PostgreSQL 17 or 18 with high availability, encryption at rest, automated backups and
  point-in-time recovery (target RPO 15 minutes, RTO 4 hours — goals subject to provider capability
  and a recorded restore drill).
- Private S3-compatible bucket (phase 2 media), SMTP provider, secret manager, OpenTelemetry
  collector/hosted backend.
- Region: India (`ap-south-1` or equivalent) for the initial launch; `tenants.data_region` records
  the region; other regions are separate deployments.
- Outbound network for the worker: Meta Graph, Razorpay (HyFib's billing account and, for
  commerce, companies' own accounts, both at `api.razorpay.com`) and SMTP, plus HTTPS (443 or ports
  from 1024) to the domains companies allow for automation web requests. The egress guard already refuses
  private, loopback, link-local and metadata addresses and pins DNS (ADR-042); as a second layer,
  route that traffic through an egress proxy or firewall that denies private ranges and the cloud
  metadata endpoint.
- Outbound network for the web tier: Meta Graph and Razorpay (onboarding and top-ups), plus the
  same company-allowed domains for the WhatsApp Flows data endpoint, which forwards WhatsApp's
  requests to companies' endpoints while WhatsApp waits (section below). It uses the same egress
  guard; apply the same egress proxy or firewall to the web tier.

**Pilot option (lower cost):** single web and worker replicas and a single managed PostgreSQL
instance with PITR. Limitations: no redundancy during deploys or instance failure (brief downtime),
lower burst capacity. Acceptable only with customers informed of the availability target.

## Connection budgets

`DATABASE_POOL_MAX_APP` (default 10) + `DATABASE_POOL_MAX_AUTH` (5) + `DATABASE_POOL_MAX_PLATFORM` (2)

- pg-boss producer (2) per web replica; worker: app pool 10 + pg-boss `max(4, concurrency+2)`.
  Keep the sum across replicas below the database's `max_connections` minus 20% headroom. LISTEN
  connections (pg-boss notify, SSE hints) must connect directly, not through a transaction-mode pooler.

## First-time database setup

1. Create the database (provider console) and an administrative login. Use a UTF-8 locale such as
   `en_US.UTF-8` (not `C`): searches for contacts by name, members' and the API's (ADR-124), fold
   letters' case by the database's locale, and with `C` only ASCII letters fold.
2. Run `infra/db/bootstrap-roles.sql` once with passwords from the secret manager (PostgreSQL 16+
   required for `GRANT … WITH INHERIT FALSE, SET TRUE`).
3. Store the four role connection strings in the secret manager: migrate (owner), app, auth,
   platform. Web receives app/auth/platform; worker receives app/platform; only the migration job
   receives the owner string.
4. In the provider's database parameters, set `log_parameter_max_length` to 0 and keep
   `log_parameter_max_length_on_error` at 0 (PostgreSQL's default), so the server's log does not
   keep queries' parameters (names, numbers, message text) when it logs a slow or failed statement;
   HyFib's own logs leave them out (ADR-129).

## Release procedure

1. CI green on the commit (quality, integration on PG 17 and 18, build, e2e, security, containers).
2. Build and push images tagged with the git SHA; record image digests in the release notes.
3. Run the migration job (`node dist/migrate.js`) **before** rolling out new app versions. Migrations
   are forward-only and must be backward compatible with the currently running version
   (expand/contract):
   - expand: add nullable columns/tables/indexes (`CREATE INDEX CONCURRENTLY` in a
     `-- migrate:no-transaction` file), deploy code that writes both shapes;
   - migrate data in batches (owner role, temporarily `NO FORCE ROW LEVEL SECURITY` inside the
     migration if a backfill must read all rows, then `FORCE` again);
   - contract in a later release after no running version reads the old shape.

   Migration 0091 (ADR-114) records every existing contact once while its triggers hold write locks
   on contacts, tags and consent states, so writes to them wait for it; on a large contacts table
   run it at a quiet time. Until the new workers run, an automation and a member removing the same
   tag at the same moment can deadlock, as adding one already could; PostgreSQL ends one of the two
   with an error.
   Migration 0092 (ADR-115) only widens the scope checks of `app.api_keys` and `ops.plans`; it holds
   an exclusive lock on each until it commits, which is brief, since both tables are small. Web
   servers from before it do not know the new scope: until the web rollout ends, an old server
   answers Settings → API keys with an error for a company with a key holding it (and the platform
   plan pages for a plan version including it), and the new endpoints with 404 or 405.
   Migration 0093 (ADR-116) records every existing message once while its triggers hold a write lock
   on `app.messages`, so new and changed messages wait for it (measured locally: about 2.4 seconds
   for 400,000 messages); on a large messages table run it at a quiet time.
   Migration 0094 (ADR-118) adds two columns to `app.webhook_endpoints` (a constant default, so no
   rewrite) and a check it validates by reading the table, which is small (at most 10 endpoints per
   company); deliveries claimed meanwhile wait for its lock briefly. Workers roll out before web
   servers, so no worker without ADR-118 sees an endpoint's headers; rolling workers back to an
   image from before it sends deliveries without them, which their receivers may refuse (the
   deliveries are retried).
   Migration 0095 (ADR-119) adds a nullable column to `app.webhook_endpoints` with a check it
   validates by reading the table (small, as above) and replaces `app.capture_webhook_event`, which
   applies the filter from then on; every endpoint starts with none, so nothing changes until a
   member or a key chooses statuses. Web servers from before it neither show nor change the column:
   until the web rollout ends, an old server's change that drops `message.status` from an endpoint
   with statuses fails on the check (it works once the rollout ends), and its other changes keep
   them.
   ADR-120 adds no migration; until the web rollout ends, a server from before it answers
   `POST /api/v1/conversations/update-many` with 405 (the path reads as a conversation id there,
   which takes no POST). ADR-122 adds no migration either, and such a server answers
   `POST /api/v1/contacts/update-many` with 405 in the same way.
   Migration 0096 (ADR-121) adds a nullable column to `app.webhook_events` with a check added
   `NOT VALID` (no rewrite and no table read, so captures wait for its lock only briefly) and
   replaces the contact capture and trigger functions, which record what changed from then on;
   0097 validates the check while captures go on. Workers from before it deliver `contact.updated`
   without `changes` until the worker rollout ends; rolling workers back to an image from before it
   does the same, and the recorded lists stay for later deliveries and replays.
   Migration 0098 (ADR-123) adds a nullable column to `app.webhook_endpoints` with a check it
   validates by reading the table (small, as above) and replaces
   `app.capture_contact_webhook_event`, which applies the filter from then on; every endpoint
   starts with none, so nothing changes until a member or a key chooses parts. Web servers from
   before it neither show nor change the column: until the web rollout ends, an old server's
   change that drops `contact.updated` from an endpoint with parts fails on the check (it works once
   the rollout ends), and its other changes keep them.
   ADR-124 adds no migration; until the web rollout ends, a server from before it refuses
   `GET /api/v1/contacts?name=` with 422 (a parameter it does not know) and still answers a
   request holding the NUL character with 500.
   Migration 0099 (ADR-125) widens the same scope checks as 0092, with the same brief locks. As with
   0092, web servers from before it do not know the new scope: until the web rollout ends, an old
   server answers Settings → API keys with an error for a company with a key holding
   `campaigns.read` (and the platform plan pages for a plan version including it), and
   `/api/v1/campaigns` with 404; rolling web servers back to an image from before it does the same.
   ADR-126 adds no migration; until the web rollout ends, a server from before it refuses
   `last_message` and `campaign` conditions in `POST /api/v1/contacts/search` with 422 naming the
   condition's type.
   ADR-127 adds no migration; until the web rollout ends, a server from before it answers
   `GET /api/v1/campaigns/{id}/recipients` with 404, and Settings → API keys describes
   `campaigns.read` without recipients.
   Migration 0100 (ADR-128) widens the same scope checks as 0099, with the same brief locks, and
   replaces the campaigns' pause reason check (`api` added), validated under the table's lock
   (campaigns are made by hand, so the table is small). Web servers from before it know neither:
   until the web rollout ends, an old server answers Settings → API keys with an error for a company
   with a key holding `campaigns.stop` (and the platform plan pages for a plan version including
   it), answers `/api/v1/campaigns/{id}/pause` and `/cancel` with 404, and shows a campaign a key
   paused with the reason as stored (`api`); rolling web servers back to an image from before it
   does the same.
   Migration 0109 (ADR-145) adds a nullable column to `app.webhook_endpoints` with a check it
   validates by reading the table (small, as for 0098) and replaces `app.capture_webhook_event`
   with the same signature, which applies the automation filter from then on; every endpoint starts
   with none, so nothing changes until a member or a key chooses automations. Workers are not
   involved (capture runs in the database). Web servers from before it neither show nor change the
   column: until the web rollout ends, an old server's change that drops both automation run events
   from an endpoint with automations fails on the check (it works once the rollout ends), and its
   other changes keep them.
   Migration 0110 (ADR-146) adds a nullable column to `app.webhook_endpoints` with a check it
   validates by reading the table (small, as for 0098) and replaces `app.capture_webhook_event`
   with the same signature, which applies the campaign status filter from then on (and keeps
   0109's automation filter); every endpoint starts with none, so nothing changes until a member or
   a key chooses statuses. Workers are not involved (capture runs in the database). Web servers
   from before it neither show nor change the column: until the web rollout ends, an old server's
   change that drops `campaign.status_changed` from an endpoint with statuses fails on the check
   (it works once the rollout ends), and its other changes keep them.
   Migration 0111 (ADR-147) does the same for `order_statuses` and `order.status_changed`: a
   nullable column with a check validated by reading the table, and `app.capture_webhook_event`
   replaced with the same signature (keeping 0109's and 0110's filters); every endpoint starts
   with none. Web servers from before it neither show nor change the column: until the web rollout
   ends, an old server's change that drops `order.status_changed` from an endpoint with statuses
   fails on the check, and its other changes keep them.
   Migration 0112 (ADR-148) does the same for `template_statuses` and `template.status_changed`: a
   nullable column with a check validated by reading the table, and `app.capture_webhook_event`
   replaced with the same signature (keeping 0109's to 0111's filters); every endpoint starts with
   none. Web servers from before it neither show nor change the column: until the web rollout ends,
   an old server's change that drops `template.status_changed` from an endpoint with statuses fails
   on the check, and its other changes keep them.
   Migration 0113 (ADR-149) does the same for `conversation_statuses` and
   `conversation.status_changed`: a nullable column with a check validated by reading the table,
   and `app.capture_webhook_event` replaced with the same signature (keeping 0109's to 0112's
   filters); every endpoint starts with none. Web servers from before it neither show nor change
   the column: until the web rollout ends, an old server's change that drops
   `conversation.status_changed` from an endpoint with statuses fails on the check, and its other
   changes keep them.
   ADR-150 adds no migration. Workers build each payload when they deliver it: until the worker
   rollout ends, a `campaign.status_changed` delivered by a worker from before it has no
   `campaign.results` (a retry or a replay a newer worker delivers has them), and rolling workers
   back to an image from before it does the same; until the web rollout ends, an old server's
   OpenAPI document does not describe them.

4. Roll out workers, then web (rolling, readiness `/api/health/ready`), watching error rates, queue
   lag and dead letters.
5. Rollback: redeploy the previous image digest. Database changes are not rolled back
   automatically; if a migration is faulty, ship a forward-repair migration (see `docs/RUNBOOKS.md`).

## Required configuration

See `.env.example` (every variable documented). Start-up refuses a non-HTTPS `APP_BASE_URL` for
`APP_ENV=staging|production` in any build mode; production builds also refuse `APP_ENV=local`,
`APP_ENV=test` off loopback, placeholder-looking secrets, a missing SMTP host, and unsafe database
roles. `W360_EGRESS_ALLOW_LOOPBACK` (test targets for automation web requests) is refused outside
`APP_ENV=local|test`. Auth cookies are `Secure` whenever the origin is https. Share
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` across web replicas.

Client addresses (audit, security events, rate limits) come from `X-Forwarded-For`. The edge load
balancer must overwrite or append that header (never pass a client-supplied value through
unchanged), and `TRUSTED_PROXIES` must list the addresses or CIDR ranges of every proxy hop we
operate. Resolution reads hops from the right, skips trusted proxies, and stores the first other
address only if it is a valid IP; malformed values are dropped rather than stored. A malformed
`TRUSTED_PROXIES` entry stops start-up. API keys limited to networks (ADR-076) trust the same
address: if clients can reach the web app without passing the edge, they can claim any address, and
without `X-Forwarded-For` the connection's address is used (the web server fills the header in).

## Public chat links and website buttons

Two routes are public by design and must stay reachable without a session: `GET /l/<slug>` (chat
links and their QR codes) and `GET /widget/<id>.js` (the website button script embedded on
companies' sites).

- **`APP_BASE_URL` is printed.** QR codes and short links contain `APP_BASE_URL`, and companies
  print them. Choose the production origin before the first company creates a link and keep it; if
  it must change, keep redirecting `/l/*` and `/widget/*` from the old origin.
- **Caching.** Never cache `/l/*` at the edge or CDN (the app sends `Cache-Control: no-store`): a
  cached redirect would skip counting and keep working after a link is archived. `/widget/*` may be
  cached for its `max-age` (300 s); purge it if a button must disappear sooner.
- **Rate limits.** Apply per-address rate limits to both routes at the edge (the app does not limit
  them). Each `/l/*` request writes one counter row.
- **Access logs.** The app stores nothing about visitors. Load-balancer or CDN access logs record
  their addresses; keep such logs short-lived or exclude these routes, and mention them in the
  privacy notice if kept.
- **Headers.** The routes set their own `Cache-Control`, `Referrer-Policy: no-referrer` (links) and
  `Cross-Origin-Resource-Policy: cross-origin` (script); do not override them at the edge.

## Price list for visitors

`GET /pricing` (ADR-107) is public by design once a platform owner shows the price list; while it
is hidden it answers 404. Each view reads the database in one read-only transaction (two small
queries) and renders per request with the page's CSP nonce.

- **Rate limits.** Apply the per-address limits of the public routes above at the edge (the app
  does not limit it).
- **Caching.** Do not cache it at the edge or CDN: a cached copy would keep prices a platform owner
  has hidden or changed, and would reuse a CSP nonce.
- **Indexing.** The app asks search engines not to index any page, this one included; HyFib's own
  site links to it.

## WhatsApp Flows data endpoint

`POST /api/flows/endpoint/<public id>` is called by WhatsApp while a customer has a form open. It is
authenticated by Meta's signature and the flow's encryption key, not by a session.

- **`APP_BASE_URL` is registered at Meta.** The address is sent to Meta as each data flow's
  `endpoint_uri` when the flow is created or updated. Choose the production origin before the first
  company creates such a flow; after a change, every data flow needs a new draft (published flows
  cannot change at Meta).
- **Reachability and limits.** The route must be reachable from the internet over HTTPS without
  authentication at the edge. Allow request bodies up to 1 MB (the app refuses larger ones) and do
  not buffer or rewrite them: the signature covers the raw body. Do not cache responses (the app
  sends `no-store`).
- **Timeouts.** The app waits at most seven seconds for a company's endpoint. Keep the load
  balancer's upstream timeout above that (for example 15 seconds). Meta's own wait for the endpoint
  is not documented in our research; the release checklist measures it.
- **Rate limits.** Apply per-address limits at the edge generous enough for WhatsApp's servers
  (they send every request); the app does not limit the route.
- **Logs.** The app logs an outcome code and ids per request. Access logs must not record request
  bodies (they are encrypted, but keep them out of logs anyway).

## Public API

`/api/v1/*` (ADR-052) authenticates with company API keys. The app's request log holds the method,
path, status, company and key of each request, never its query string or body.

- **Access logs.** Query strings can hold personal data: `GET /api/v1/contacts` finds contacts by
  number, email address and part of a name (ADR-113, ADR-124). Load-balancer or CDN access logs must
  leave out the query strings of `/api/v1/*`, or be kept short-lived and named in the privacy
  notice.

## Razorpay

1. In the Razorpay Dashboard (test mode first, then live), create API keys and set
   `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` on web and worker. Live keys (`rzp_live_…`) are refused
   unless `APP_ENV=production`; `RAZORPAY_API_BASE_URL` is refused outside `APP_ENV=local|test`.
2. Add a webhook to `https://<app host>/api/webhooks/razorpay` with a random secret
   (`RAZORPAY_WEBHOOK_SECRET`) and the events `payment.authorized`, `payment.captured`,
   `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`, `payment.dispute.lost`,
   `token.confirmed`, `token.rejected`, `token.cancelled`, `token.paused`, and for paying for
   plans `subscription.authenticated`, `subscription.activated`, `subscription.charged`,
   `subscription.completed`, `subscription.updated`, `subscription.pending`, `subscription.halted`,
   `subscription.cancelled`, `subscription.paused`, `subscription.resumed`. Without `refund.failed`,
   a failed staff refund is still found by the worker's check (ADR-058), only later; without the
   subscription events, plan payments are still found by the worker's hourly and daily checks, only
   later.
3. Rotate the webhook secret by setting the old value as `RAZORPAY_WEBHOOK_SECRET_PREVIOUS`, the new
   one as `RAZORPAY_WEBHOOK_SECRET`, deploying, changing it in the Dashboard, and removing the
   previous value after 24 h (Razorpay's retry window).
4. Auto-recharge stays unavailable until Razorpay enables Recurring Payments (card mandates) for
   the merchant; then set `RAZORPAY_RECURRING_CARDS_ENABLED=true`.
5. Not yet verified against the Razorpay sandbox from this build environment (razorpay.com was
   unreachable): before launch, run a test-mode top-up, a failed payment, a refund and a card
   mandate end to end, and confirm the Checkout CSP (script `checkout.razorpay.com`, frame and
   connect `api.razorpay.com` / `checkout.razorpay.com`) is sufficient in all supported browsers.
6. Paying for plans (ADR-063) stays off until `RAZORPAY_SUBSCRIPTIONS_ENABLED=true` is set on web and
   worker, which needs Razorpay Subscriptions and Flash Checkout activated on the account (Razorpay
   documents Flash Checkout as required for Subscriptions) and a review of the tax on plan prices;
   a platform owner then sets the tax in Platform → Plans. HyFib creates one Razorpay plan per
   subscription (named "HyFib <plan> plan") and subscriptions of five years of cycles; they are
   visible in the Dashboard. Events for subscriptions that already exist are processed whether or
   not the flag is on.
7. The daily settlement reconciliation (ADR-059) uses the same API keys and needs nothing else to
   configure: the worker reads `GET /v1/settlements/recon/combined` for the previous day from
   06:00 India time. It runs only where Razorpay is configured, and the reconciliation page says so
   otherwise. Keep the worker's clock in sync (NTP): it decides which day is over.

## Commerce (companies' own Razorpay accounts)

1. Nothing is configured per deployment: each company saves its own key id, key secret and webhook
   secret in Commerce → Payments. Live keys are accepted only with `APP_ENV=production`.
2. Companies' Razorpay accounts send notifications to
   `https://<app host>/api/webhooks/razorpay-links/<address id>` (shown to the company). The route
   must be reachable from Razorpay like `/api/webhooks/razorpay`; it verifies each company's own
   secret and only makes the worker fetch the link, so it needs no allow-list beyond TLS.
3. Payment status reaches orders only through the worker's fetches (every 15 minutes on a link's
   first day, then every six hours), so the worker and its sweep must run for payments to be
   recorded; notifications only make it sooner.
4. Not yet verified against Razorpay's sandbox from this build environment: before launch, create,
   pay, cancel and expire a Payment Link with a company's test keys, and confirm the list response
   shape for `GET /v1/payment_links?reference_id=` (research R-107).

## Shopify app (companies' Shopify stores)

Optional: without it, the Stores page says Shopify is not set up and WooCommerce still works.

1. Create one Shopify app for HyFib (non-embedded; it uses the authorization code grant, research
   SH-002). Companies from many unrelated businesses connect their stores, so it needs public
   distribution through Shopify's app review (SH-001); custom distribution only reaches one store or
   one Plus organization, which is enough for a pilot.
2. Allowed redirection URL: `https://<app host>/api/stores/shopify/callback` (the whole address must
   be listed, SH-003). Scopes: `read_orders,read_products` only; HyFib asks for exactly these and
   fails a connection that is not granted both.
3. Compliance webhooks (set on the app, not per shop, SH-027): `customers/data_request`,
   `customers/redact` and `shop/redact` to `https://<app host>/api/webhooks/shopify`. HyFib creates
   the per-shop order, product and uninstall subscriptions itself.
4. Protected customer data (SH-020): request access to customers' name, phone and email in the
   Partner Dashboard (API access requests). Until Shopify approves it, orders arrive without those
   fields and cannot be linked to contacts (the store page says so).
5. Set `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` and `SHOPIFY_API_VERSION` (the connector's
   queries were checked against 2026-07 and 2025-10, SH-010) on web and worker.
   `SHOPIFY_TEST_BASE_URL` is refused outside `APP_ENV=local|test`. Rotating the client secret:
   `docs/SECURITY.md`.
6. The app uses expiring offline tokens (60 minutes, refreshed by the worker; research SH-007): the
   worker and its minute sweep must run for stores to stay connected.
7. Not yet verified against a real Shopify store from this build environment: before launch, on a
   development store, connect, read orders and products, receive `orders/updated`, uninstall and
   reinstall, and send the three compliance webhooks from the Partner Dashboard; confirm the token
   lifetimes, the retry schedule and the `shop/redact` timing listed as unconfirmed in
   `docs/research/store-connectors.md`.
8. Order messages (P4-06c) need no other scope or setting: shipments, tracking and payment gateways
   are read with `read_orders` (research SH-030, SH-031). The fulfillment webhooks would need
   `read_fulfillments` (SH-033), so the worker finds deliveries by reading orders in transit again
   every three hours. Each message is a `commerce.store-message` job scheduled for its send time
   (the queue is created by `pnpm db:migrate` with the others), and the worker's minute sweep
   queues again any message that is due but lost its job.
9. Cart reminders (P4-06d) read checkouts with `read_orders` (research SH-037). Customer access is
   optional and per store: the app must be allowed to request `read_customers` (declare it among
   the app's optional access if the Partner Dashboard asks for it), HyFib requests it only when a
   manager allows customer access for a store; if Shopify does not grant it, the store keeps working
   without it (a grant without `read_orders` or `read_products` fails the store until it is
   connected again). The
   customer's default phone is protected customer data like the address phones (SH-040), so the
   protected customer data request of step 4 must include phone. The store consent setting needs
   `SHOPIFY_API_VERSION` 2026-07 or later (SH-041). Checkouts are read every 15 minutes by the store
   job while a reminder is on; nothing else runs for them.

## WooCommerce stores

1. Nothing is configured per deployment. The site's owner approves Read/Write keys on their own
   site; WooCommerce posts the keys to `https://<app host>/api/stores/woocommerce/callback` and sends
   deliveries to `https://<app host>/api/webhooks/woocommerce/<address id>`. Both routes must be
   reachable from the internet like the other webhook routes.
2. Stores are reached over https through the egress client: sites on private addresses, behind
   redirects or on http:// are refused (http:// only with `W360_EGRESS_ALLOW_LOOPBACK`, local and
   test).
3. Not yet verified against a real WooCommerce site from this build environment: before launch,
   connect a test site through the approval page and with pasted keys, receive order and product
   webhooks, revoke the key, and remove the store.

## Health and probes

| Probe     | Web                                     | Worker                                                |
| --------- | --------------------------------------- | ----------------------------------------------------- |
| Liveness  | `GET /api/health/live`                  | `GET :9464/live`                                      |
| Readiness | `GET /api/health/ready` (DB round trip) | `GET :9464/ready` (DB round trip; 503 while stopping) |

Workers handle SIGTERM gracefully (stop fetching, finish in-flight jobs up to 30 s).
