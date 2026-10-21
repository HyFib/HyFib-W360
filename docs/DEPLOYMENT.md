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
  chat-link, widget, price list and webhook OAuth JWKS routes, see below).
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
- The web tier also reaches `https://api.pwnedpasswords.com` to screen the passwords people set
  (ADR-317), on by default for staging and production: allow it, or set `PASSWORD_BREACH_CHECK=off`.
  When it cannot be reached, passwords are taken unchecked and the web log says
  `password breach check unavailable`; `PWNED_PASSWORDS_BASE_URL` is refused outside
  `APP_ENV=local|test`.

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
   run it at a quiet time. Migration 0251 (ADR-329) adds two columns to `app.contact_changes`
   without rewriting it and its checks `NOT VALID`, so it holds the table's lock only briefly; 0252
   validates them while contacts keep changing. From 0251 on, every change records its parts; until
   the new web version runs, the feed answers without `changes`. Once it does, the changes recorded
   before 0251, and passes begun with cursors the old version gave, read as unknown (`changes` null)
   until a page reads all there is. The new contact feed cursors also seal where the reader's pass
   began, a form web instances of the previous release refuse: an integration whose request reaches
   one during the rollout, or any after a rollback of the web app, gets 422 naming `cursor` and
   starts the feed again from the start, reading every contact once more. Switch the web instances
   over at once to avoid it. Until the new workers run, an automation and a member removing the same
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
   Migration 0114 (ADR-151) does for `run_end_statuses` and `automation.run_ended` what 0113 does
   for conversation statuses: a nullable column with a check validated by reading the table, and
   `app.capture_webhook_event` replaced with the same signature (keeping 0109's to 0113's filters);
   every endpoint starts with none. Web servers from before it neither show nor change the column:
   until the web rollout ends, an old server's change that drops `automation.run_ended` from an
   endpoint with a list fails on the check, and its other changes keep it.
   Migration 0115 (ADR-167) widens the same scope checks as 0100, with the same brief locks. Web
   servers from before it do not know the new scope: until the web rollout ends, an old server
   answers Settings → API keys with an error for a company with a key holding `orders.read` (and the
   platform plan pages for a plan version including it), and `/api/v1/orders` with 404; rolling web
   servers back to an image from before it does the same.
   Migration 0116 (ADR-168) widens the same scope checks again, with the same brief locks. Web
   servers from before it do not know `orders.write`: until the web rollout ends, an old server
   answers Settings → API keys with an error for a company with a key holding it (and the platform
   plan pages for a plan version including it), and `PATCH /api/v1/orders/{id}` with 405 (404 on an
   image from before 0115); rolling web servers back to an image from before it does the same.
   Migration 0117 (ADR-169) adds three nullable columns and a check to `ops.dead_letters` (a brief
   lock on a table of at most 30 days of dead letters) and the acknowledging function. Web servers
   from before it neither show nor write acknowledgements, and their Queues CSV has no "Acknowledged
   (UTC)" column; web servers of this release need it, or the Queues tab fails to load.
   Migration 0118 (ADR-170) adds `channel_account_ids` to `app.webhook_endpoints` with a check
   validated by reading the table, and replaces `app.capture_webhook_event` (keeping 0109's to
   0114's filters) and the trigger functions of message, conversation, automation run, order and
   campaign events with the same signatures; every endpoint starts with none. Web servers of this
   release need it, as their reads of endpoints name the column; workers do not read it. Web servers
   from before it neither show nor change the column: until the web rollout ends, an old server's
   change that drops every event of a number from an endpoint with a list fails on the check, and
   its other changes keep it.
   Migration 0119 (ADR-171) widens the same scope checks again, with the same brief locks. Web
   servers from before it do not know `channels.read`: until the web rollout ends, an old server
   answers Settings → API keys with an error for a company with a key holding it (and the platform
   plan pages for a plan version including it), and `/api/v1/channels` with 404; rolling web servers
   back to an image from before it does the same.
   Migration 0120 (ADR-172) adds `message_senders` to `app.webhook_endpoints` with a check validated
   by reading the table, and replaces `app.capture_webhook_event` (keeping 0109's to 0118's filters)
   and the message trigger function with the same signatures; every endpoint starts with none. Web
   servers of this release need it, as their reads of endpoints name the column; workers do not read
   it. Web servers from before it neither show nor change the column: until the web rollout ends, an
   old server's change that drops `message.status` from an endpoint with a list fails on the check,
   and its other changes keep it.
   Migration 0121 (ADR-173) adds the four OAuth columns to `app.webhook_endpoints` with a check
   validated by reading the table, grants their updates, and replaces `ops.sealed_value_keys()` with
   the OAuth secrets. Workers and web servers of this release need it: the workers' claims and the
   web servers' reads of endpoints name the columns. Workers roll out first, so no client can be set
   while a worker from before it runs; workers from before it ignore clients, and their keyring
   sweep leaves the OAuth secrets for the new ones. Rolling workers back while endpoints have
   clients sends their deliveries without a token: receivers refuse them, and they are retried until
   the new workers return or the endpoints have failed for 72 hours.
   Migration 0122 (ADR-174) adds `team_ids` to `app.webhook_endpoints` with a check validated by
   reading the table, and replaces `app.capture_webhook_event` (keeping 0109's to 0120's filters)
   with the same signature; every endpoint starts with none. Web servers of this release need it, as
   their reads of endpoints name the column; workers do not read it. Web servers from before it
   neither show nor change the column: until the web rollout ends, an old server's change that drops
   every message and conversation event from an endpoint with a list fails on the check, and its
   other changes keep it.
   Migration 0123 (ADR-175) adds `template_ids` to `app.webhook_endpoints` with a check validated by
   reading the table, and replaces `app.capture_webhook_event` (keeping the filters of 0095 to 0122)
   with the same signature; every endpoint starts with none. Web servers of this release need it, as
   their reads of endpoints name the column; workers do not read it. Web servers from before it
   neither show nor change the column: until the web rollout ends, an old server's change that drops
   both `message.status` and `template.status_changed` from an endpoint with a list fails on the
   check, and its other changes keep it.
   Migration 0124 (ADR-176) widens the same scope checks again, with the same brief locks. Web
   servers from before it do not know `campaigns.resume`: until the web rollout ends, an old server
   answers Settings → API keys with an error for a company with a key holding it (and the platform
   plan pages for a plan version including it), and `/api/v1/campaigns/{id}/resume` with 404;
   rolling web servers back to an image from before it does the same. Workers are not affected: the
   runner checks a campaign's launcher as before.
   Migration 0125 (ADR-177) adds three nullable columns and a check to `ops.queue_waits` (a row per
   queue, so the check is validated at once), narrows the worker role's read of the table to the
   check's columns, creates `ops.record_queue_waits` again with the same signature and owner, and
   adds `ops.platform_acknowledge_late_queue`. Workers of either release keep working: their sweep
   reads only those columns and calls the function as before. Web servers of this release need it,
   as the Queues tab reads the new columns; web servers from before it show no acknowledgements, and
   a note written meanwhile stays for the new ones.
   Migration 0126 (ADR-178) creates `ops.template_sync_due` again with a `requested` column and the
   accounts asked for first. Workers of this release read the column, so it must run before they
   start (this step does); workers from before it select the columns they know and queue every sync
   at the default priority, as before. Web servers are not involved beyond queueing a member's
   refresh at the higher priority, which workers of either release run.
   Migration 0127 (ADR-179) creates `ops.receipt_acknowledgements` (empty) and
   `ops.platform_acknowledge_webhook_receipt`. Workers are not involved. Web servers of this release
   need it, as the Integrations tab reads the table; web servers from before it show no
   acknowledgements.
   ADR-180 adds no migration. Until the web rollout ends, a web server from before it refuses
   `phone` in `PATCH /contacts/{id}` with 422, as it always did; rolling back does the same.
   Migration 0128 (ADR-181) adds `assignee_ids` to `app.webhook_endpoints` with a check validated by
   reading the table, and replaces `app.capture_webhook_event` (keeping the filters of 0095 to 0123)
   with the same signature; every endpoint starts with none. Web servers of this release need it, as
   their reads of endpoints name the column; workers do not read it. Web servers from before it
   neither show nor change the column: until the web rollout ends, an old server's change that drops
   every message and conversation event from an endpoint with a list fails on the check, and its
   other changes keep it.
   Migration 0129 (ADR-182) adds two nullable columns to `app.webhook_events` with a check added
   `NOT VALID` (no rewrite and no table read, so captures wait for its lock only briefly) and a
   definer function, and replaces the contact capture and tag trigger functions, which record the
   tags from then on; 0130 validates the check while captures go on. Workers from before it deliver
   `contact.updated` without the tag lists until the worker rollout ends; rolling workers back to an
   image from before it does the same, and the recorded lists stay for later deliveries and replays
   (an erasure clears them whatever the image).
   Migration 0131 (ADR-183) adds `run_triggers` to `app.webhook_endpoints` with a check validated by
   reading the table, and replaces `app.capture_webhook_event` (keeping the filters of 0095 to 0128)
   and the run trigger function with the same signatures; every endpoint starts with none. Web
   servers of this release need it, as their reads of endpoints name the column; workers do not read
   it. Web servers from before it neither show nor change the column: until the web rollout ends, an
   old server's change that drops both run events from an endpoint with a list fails on the check,
   and its other changes keep it.
   Migration 0132 (ADR-184) adds `contact_field_keys` to `app.webhook_endpoints` with a check
   validated by reading the table, and replaces `app.capture_contact_webhook_event` (keeping 0129's
   tag lists) with the same signature; every endpoint starts with none. Web servers of this release
   need it, as their reads of endpoints name the column; workers do not read it. Web servers from
   before it neither show nor change the column: until the web rollout ends, an old server's change
   that drops `contact.updated` or `fields` from an endpoint with a list fails on the check, and its
   other changes keep it.

   Migration 0133 (ADR-185) adds `campaign_ids` to `app.webhook_endpoints` with a check validated by
   reading the table, and replaces `app.capture_webhook_event` (keeping 0131's run trigger filter)
   and the message trigger's function with the same signatures; every endpoint starts with none. Web
   servers of this release need it, as their reads of endpoints name the column; workers do not read
   it. Web servers from before it neither show nor change the column: until the web rollout ends, an
   old server's change that drops both `message.status` and `campaign.status_changed` from an
   endpoint with a list fails on the check, and its other changes keep it. `message.status` payloads
   gain `message.campaignId` from workers of this release: until the worker rollout ends, a delivery
   an older worker prepares leaves it out.

   Migration 0134 (ADR-186) widens the same scope checks again, with the same brief locks. Web
   servers from before it do not know `campaigns.write`: until the web rollout ends, an old server
   answers Settings → API keys with an error for a company with a key holding it (and the platform
   plan pages for a plan version including it), and `POST /api/v1/campaigns` and
   `PATCH /api/v1/campaigns/{id}` with 405 (their routes only read there); rolling web servers back
   to an image from before it does the same. Workers are not affected.

   ADR-187 has no migration: until the web rollout ends, an old web server refuses a key's cancel of
   a draft with 409, as before.

   ADR-188 has no migration: until the web rollout ends, an old web server refuses `phone` in
   `POST /contacts/update-many` with 422, as before.

   Migration 0135 (ADR-189) adds `consent_changes` to `app.webhook_endpoints` with a check validated
   by reading the table, and replaces `app.capture_webhook_event` (keeping 0133's campaign filter)
   with the same signature; every endpoint starts with none. Web servers of this release need it, as
   their reads of endpoints name the column; workers do not read it. Web servers from before it
   neither show nor change the column: until the web rollout ends, an old server's change that drops
   `consent.changed` from an endpoint with a list fails on the check, and its other changes keep it.

   Migration 0136 (ADR-190) adds `contact_sources` to `app.webhook_endpoints` with a check validated
   by reading the table, and replaces `app.capture_contact_webhook_event` (keeping 0132's field
   filter) with the same signature; every endpoint starts with none. Web servers of this release
   need it, as their reads of endpoints name the column; workers do not read it. Web servers from
   before it neither show nor change the column: until the web rollout ends, an old server's change
   that drops `contact.created` from an endpoint with a list fails on the check, and its other
   changes keep it.

   Migration 0137 (ADR-191) adds `message_types` to `app.webhook_endpoints` with a check validated
   by reading the table, and replaces `app.capture_webhook_event` (keeping 0135's consent filter)
   with the same signature; every endpoint starts with none. Web servers of this release need it, as
   their reads of endpoints name the column; workers do not read it. Web servers from before it
   neither show nor change the column: until the web rollout ends, an old server's change that drops
   `message.received` from an endpoint with a list fails on the check, and its other changes keep
   it.

   Migration 0138 (ADR-192) adds `run_end_reasons` to `app.webhook_endpoints` with a check validated
   by reading the table, and replaces `app.capture_webhook_event` (keeping 0137's message type
   filter) with the same signature; every endpoint starts with none. Web servers of this release
   need it, as their reads of endpoints name the column; workers do not read it. Web servers from
   before it neither show nor change the column: until the web rollout ends, an old server's change
   that drops `automation.run_ended`, or an end the list names reasons of, from an endpoint with a
   list fails on the check, and its other changes keep it.

   ADR-193 has no migration: until the web rollout ends, an old web server has no such route and
   answers `GET /campaigns/{id}/review` with 404.

   ADR-194 has no migration: until the web rollout ends, an old web server refuses media in
   `POST /messages` with 422, as before.

   ADR-195 has no migration: until the web rollout ends, an old web server refuses locations in
   `POST /messages` with 422, as before.

   ADR-196 has no migration: until the web rollout ends, an old web server answers messages without
   `contacts`, and until the worker rollout ends, an old worker posts `message.received` without it.

   ADR-197 has no migration: until the web rollout ends, an old web server refuses contact cards in
   `POST /messages` with 422, as before, and shows the scope's old label.

   ADR-198 has no migration: until the web rollout ends, an old web server refuses stickers in
   `POST /messages` with 422, as before.

   Migration 0139 (ADR-199) creates `ops.quarantine_acknowledgements` (empty) and
   `ops.platform_acknowledge_quarantine_entry`. Workers are not involved. Web servers of this
   release need it, as the Integrations tab reads the table; web servers from before it show no
   acknowledgements.

   ADR-200 has no migration: until the web rollout ends, an old web server's export gives only the
   rows its tab shows.

   ADR-201 has no migration: until the web rollout ends, an old web server neither lists templates
   with a photo, video or document header in `GET /templates` nor sends them, refusing `headerMedia`
   with 422.

   Migrations 0140 and 0141 (ADR-202) add `app.campaigns.submitted_by_api_key_id` with its check and
   foreign key NOT VALID, then validate them; campaigns stay writable throughout. Web servers of
   this release need 0140. Until the web rollout ends, an old web server answers
   `POST /campaigns/{id}/submit` with 404, says a member submitted a key's submission, and fails
   with an error when a member approves one: approve such campaigns once the rollout ends.

   ADR-203 has no migration: until the web rollout ends, an old web server answers
   `POST /campaigns/{id}/withdraw` with 404.

   ADR-204 has no migration: until the web rollout ends, a submission an old web server takes emails
   nobody, and approvers find it on the Campaigns page as before.

   ADR-205 has no migration: until the web rollout ends, an approval, a rejection or a withdrawal an
   old web server takes emails nobody.

   ADR-206 has no migration: until the web rollout ends, an old web server answers `GET /segments`
   and `GET /segments/{id}` with 404.

   ADR-207 has no migration: until the web rollout ends, an old web server answers `POST /segments`
   and `PATCH` and `DELETE /segments/{id}` with 404, and gives members the generic message for a
   segment name another segment has.

   ADR-208 has no migration: until the web rollout ends, an old web server answers
   `GET /segments/{id}/contacts` with 404.

   ADR-209 has no migration: until the web rollout ends, an old web server sends approval emails and
   shows waiting campaigns without the time they can be approved until.

   ADR-210 has no migration: until the worker rollout ends, an old worker pauses campaigns without
   emailing anyone.

   ADR-211 has no SQL migration but adds the `note.mention` queue, which the migration job creates:
   run it before the web rollout, as a web server of this release queues a job whenever a note
   mentions another member, and queueing to a missing queue fails the note. Workers roll out first,
   so the jobs find a worker of this release.

   ADR-212 has no migration: until the web rollout ends, an old web server shows no "Download
   transcript" link and answers its address with 404.

   ADR-213 has no migration: until the web rollout ends, an old web server shows the contacts page
   without the bulk tag form.

   ADR-214 has no migration: until the worker rollout ends, an old worker completes campaigns
   without emailing anyone.

   Migration 0142 (ADR-215) adds `app.memberships.email_opt_outs` with an empty default and a check
   (memberships is small, so the check is validated at once) and creates
   `app.set_own_email_opt_outs`, owned by `w360_definer` and executable by the runtime role only.
   Old servers ignore the column: until the rollout ends, an old web server shows no Notifications
   tab and old workers and web servers email members who turned a kind off.

   ADR-216 has no migration. The web tier now makes outbound https requests to Meta on members'
   requests: to the Graph origin, as onboarding already did, and to the address each file's Graph
   answer gives, whose host Meta's description does not name. Allow the web tier the same outbound
   https to Meta as the worker. Until the web rollout ends, an old web server shows "Media download
   is not available yet." in place of a file.

   ADR-217 has no migration. Until the web rollout ends, an old web server answers
   `GET /api/v1/messages/{id}/media` with 404.

   ADR-218 has no migration. The web tier now uploads files of up to 16 MB to Meta: a load balancer
   or reverse proxy in front of it must accept request bodies of at least 17 MB on
   `/api/c/*/inbox/*/files`, and each upload holds its file in the web server's memory once. Until
   the web rollout ends, an old web server shows no "Send a file" card.

   Migration 0143 (ADR-219) adds `channel_account_id` and `api_key_id` to `app.media_objects`, with
   their foreign keys and check NOT VALID, so the table stays writable; 0144 validates them, reading
   the table without blocking writes. Old servers ignore the columns. `POST /api/v1/media` takes
   bodies of up to 16 MB and 64 KB: a load balancer in front of the web tier must accept them on
   that path too. Until the web rollout ends, an old web server answers it with 404 and refuses
   `mediaId` in `POST /messages`.

   Migration 0145 (ADR-220) creates `app.conversation_tags` and replaces `app.erase_contact` with
   the same function deleting the conversations' tags too; the new table starts empty, so the
   migration holds its locks briefly. Old servers ignore the table and erase contacts through the
   new function. Until the web rollout ends, an old web server shows no tags and ignores the inbox's
   `tag` filter.

   ADR-221 has no migration. Until the web rollout ends, an old web server answers conversations
   without `tags` and refuses `tag`, `addTags` and `removeTags` as unknown fields (422).

   ADR-222 has no migration, but roll the workers out before the web tier as usual: a worker of the
   previous release cannot read a published version with a "Tag the conversation" step and would
   fail its runs as unreadable.

   Migration 0146 (ADR-223) adds `app.messaging_settings.read_receipts` (off) without rewriting the
   table, and the migration command creates the `message.read` queue: run it before the rollout, or
   a member opening a conversation of a company that turned read receipts on fails to queue the job.
   Old servers ignore the column; until the web rollout ends, an old web server shows no setting and
   queues no receipts.

   Migration 0147 (ADR-224) creates `app.contact_merges` and `app.merge_contacts`, adds the `merge`
   consent source (its check is replaced, reading `app.consent_events` once under the migration's
   lock), replaces three guard functions with an exception only that function uses, and grants the
   definer role what it moves. 0148 and 0149 build `app.campaign_recipients_contact_idx` and
   `app.automation_runs_contact_idx` concurrently (outside a transaction), so campaigns and runs
   keep being written. Old servers never call the function; until the web rollout ends, an old web
   server shows no merge.

   Migration 0150 (ADR-225) replaces the endpoints' event check (validated at once: at most 10
   endpoints per company) and the events' type check (NOT VALID; 0151 validates it while captures go
   on), and adds a trigger on `app.contact_merges`. Workers roll out before web servers, so no
   endpoint takes `contact.merged` before every worker can describe it. A worker from before it
   cannot describe the event and fails its company's delivery run each time it claims one, so before
   rolling workers back to such an image, turn the event off on the endpoints that take it; newer
   workers fail only that delivery (`payload_failed`, replayable). Until the web rollout ends, an
   old web server answers Settings → Webhooks with an error for a company with an endpoint taking
   `contact.merged` (it has no label for it): add it to endpoints once the rollout ends, and turn it
   off before rolling web servers back to such an image.

   Migration 0152 (ADR-226) adds `app.tenants.masked_number_roles` (an empty list, without rewriting
   the table) with a check that reads the companies once under the migration's lock, and the runtime
   role's grant to change it. Old servers ignore the column: until the web rollout ends, an old web
   server shows no setting and masks nothing, so a company should choose roles once the rollout is
   done.

   Migration 0153 (ADR-227) widens the same scope checks again, with the same brief locks. Web
   servers from before it do not know `contacts.merge`: until the web rollout ends, an old server
   answers Settings → API keys with an error for a company with a key holding it (and the platform
   plan pages for a plan version including it), and `POST /api/v1/contacts/{id}/merge` with 404;
   rolling web servers back to an image from before it does the same. Workers are not affected.

   ADR-228 has no migration. Until the web rollout ends, an old web server refuses a draft whose
   website button's link ends with `{{1}}`, shows such templates as not sendable, leaves them out of
   GET /api/v1/templates, and answers a send giving `variables.buttons` with 422 (a field it does
   not know) and a send of such a template with 501; rolling web servers back to an image from
   before it does the same and cannot open such a draft in the editor. Workers send the request
   the web server stored; their own sends of these templates came with ADR-229, below.

   ADR-229 has no migration. Campaigns, automations and store messages now send templates whose
   links end with a value from workers, which roll out before web servers, so no member chooses such
   a template for them before every worker can send it. Rolling workers back to an image from before
   it pauses such campaigns (`template_not_approved`), skips such store messages
   (`template_unavailable`) and fails such automation runs (`template_unavailable`) until they roll
   forward. Web servers from before ADR-228 offer no such template to campaigns, automations or
   store messages, and drop `variables.buttons` from a campaign draft given through the API (a field
   of the variables they do not know), whose template they then report as one HyFib cannot send.

   Migration 0154 (ADR-230) adds `app.overdue_reply_notices`, the sweep function and the definer's
   reads, and replaces the members' email choice check with one allowing `reply_overdue` (validated
   under a brief lock on `app.memberships`, one row per membership). Migration 0155 builds the index
   of open reply turns concurrently, outside a transaction; if it fails, see `docs/RUNBOOKS.md`.
   Workers roll out first and start emailing about overdue replies once both are applied. Until the
   web rollout ends, an old web server does not list the new kind in Settings → Notifications, and a
   member saving their choices there keeps whatever they chose for it (kinds a server does not show
   keep their setting). Rolling workers back stops the emails; the notices stay and are honoured
   again when workers roll forward.

   Segment conditions on store orders (ADR-231) need no migration. Only web servers read segments'
   conditions: until the web rollout ends, an old web server refuses the new conditions and reports
   a segment or a draft's audience holding one as one it cannot read (the segment page, a campaign's
   review and the API say so). Rolling the web back leaves them so until it rolls forward; campaigns
   already submitted keep the recipients frozen when submitted.

   Form bodies for HTTP steps (ADR-236) need no migration. Workers make the calls, so roll them out
   before the web (as step 4 does): until the web rollout ends, an old web server neither shows nor
   keeps a step's body format, and saving an automation there turns its form body back into one
   checked as JSON. Rolling workers back while an automation with a form body is published would
   send that body as JSON: unpublish such automations first.

   Migration 0156 (ADR-242) adds `app.crm_stages.win_percent`, a nullable column without a default
   (the table is not rewritten), and the runtime role's update of it. Until the web rollout ends, an
   old web server neither shows nor sets stage chances and its board has no weighted figures, but
   saving a pipeline there keeps the chances it does not know (its update names only names and
   positions). Rolling the web back hides them until it rolls forward.

   Migration 0157 (ADR-243) adds `app.conversation_viewers` (with its deletion step and policies)
   and `ops.purge_conversation_viewers` for the worker; workers roll out first, so the purge runs
   before any page reports. Until the web rollout ends, an old web server's conversation pages
   neither report nor show who else has a conversation open, so its members are not named to others;
   a report from a new page that reaches an old server finds no route and the page says it could not
   check, until a report reaches a new server.

   Migration 0158 (ADR-244) adds `app.crm_tasks.created_by_automation_id`, makes
   `created_by_membership_id` nullable (both without rewriting the table) and adds, NOT VALID, the
   creator check, the foreign key to the automation and the run steps' outcome check with `created`
   and `skipped`; 0159 validates them while the tables stay writable. Roll the workers out before
   the web tier as usual: a worker of the previous release cannot read a published version with a
   task step and would fail its runs as unreadable. An old web server cannot read a draft with a
   task step either: its editor opens such an automation with the starter steps, and saving there
   would replace the draft, so do not edit automations with task steps until the web rollout ends.
   Old servers list the tasks automations create as before (they never show who created a task).

   Migration 0160 (ADR-245) does the same for deals (`app.crm_deals.created_by_automation_id`,
   `created_by_membership_id` nullable, the creator check and the foreign key NOT VALID) and 0161
   validates them. The same rollout rules apply to deal steps: workers first, and no editing of
   automations with deal steps on old web servers. Until the web rollout ends, an old web server
   shows a deal an automation created without saying who created it.

   ADR-246 has no migration. An old worker reads a task step's reminder as absent and creates the
   task without it, so roll the workers out before the web tier as usual.

   ADR-247 has no migration either: an old worker reads a deal step's expected close date as absent
   and creates the deal without it.

   ADR-248 has no migration. A worker of the previous release cannot read a published version with a
   form step and would fail its runs as unreadable, so roll the workers out first. An old web server
   cannot read a draft with a form step either: its editor opens it with the starter steps, and
   saving there would replace the draft, so do not edit automations with form steps until the web
   rollout ends.

   ADR-249 has no migration. Until the workers roll out, an old worker still creates the tasks and
   deals of automations whose company's plan no longer includes the CRM.

   Migration 0162 (ADR-250) replaces the run steps' outcome check, NOT VALID, to allow `moved`, and
   0163 validates it while the table stays writable. Roll the workers out first: a worker of the
   previous release cannot read a published version with a step that moves a deal and would fail its
   runs as unreadable. An old web server cannot read a draft with such a step either (its editor
   opens it with the starter steps, and saving there would replace the draft), so do not edit
   automations with these steps until the web rollout ends; an old server's run page shows the
   outcome as `moved`, untranslated.

   Migrations 0164 and 0165 (ADR-251) do the same for `closed`, with the same rollout rules for
   steps that close a deal: workers first, and no editing of automations with these steps on old web
   servers. Old servers show a deal an automation closed as closed by nobody; the timeline names the
   automation on new servers.

   Migration 0166 (ADR-252) adds the definition of the Reports page's weighted forecast to
   `ops.metric_definitions`. Until the web rollout ends, an old web server's Reports page shows no
   forecast; nothing else reads the new row.

   Migration 0167 (ADR-253) widens the same scope checks as 0153, with the same brief locks, and
   0168 builds `app.crm_deals_list_idx` concurrently, outside a transaction (if it fails, see
   `docs/RUNBOOKS.md`). Web servers from before them do not know `deals.read`: until the web rollout
   ends, an old server answers Settings → API keys with an error for a company with a key holding it
   (and the platform plan pages for a plan version including it), and `/api/v1/pipelines` and
   `/api/v1/deals` with 404; rolling web servers back to an image from before them does the same.
   Workers are not affected.

   Migration 0169 (ADR-254) widens the same scope checks again, with the same brief locks, adds
   `app.crm_deals.created_by_api_key_id` and replaces the deals' creator check with one taking a key
   as the creator, NOT VALID with the new foreign key (no row is read under the migration's lock);
   0170 validates both while the table stays writable. Web servers from before 0169 do not know
   `deals.write`: until the web rollout ends, an old server answers Settings → API keys with an
   error for a company with a key holding it (and the platform plan pages for a plan version
   including it), and `POST /api/v1/deals` with 405; an old server shows a deal a key created as
   created by nobody. Workers are not affected.

   ADR-255 has no migration. Until the web rollout ends, an old web server answers
   `PATCH /api/v1/deals/{id}` with 405, leaves `version` out of deals and describes the scope as
   creating deals only; rolling web servers back does the same. Workers are not affected.

   Migration 0171 (ADR-256) replaces the endpoints' event check (validated at once: at most 10
   endpoints per company) and the events' type check (NOT VALID; 0172 validates it while captures go
   on), and adds two triggers on `app.crm_deals`. Workers roll out before web servers, so no
   endpoint takes the deal events before every worker can describe them. A worker from before it
   fails each deal event's delivery without an attempt (`payload_failed`; replay it once newer
   workers run), so before rolling workers back to such an image, turn the deal events off on the
   endpoints that take them. An old web server's Settings and API do not offer them, and until the
   web rollout ends an old server answers Settings → Webhooks with an error for a company with an
   endpoint taking one (it has no label for them): add them to endpoints once the rollout ends, and
   turn them off before rolling web servers back to such an image.

   ADR-257 has no migration. Until the web rollout ends, an old web server refuses `pipelineId` on
   `PATCH /api/v1/deals/{id}` as an unknown field (422); rolling web servers back does the same.
   Workers are not affected.

   Migration 0173 (ADR-258) widens the same scope checks again, with the same brief locks, and 0174
   builds `app.crm_tasks_list_idx` concurrently, outside a transaction (if it fails, see
   `docs/RUNBOOKS.md`). Web servers from before them do not know `tasks.read`: until the web rollout
   ends, an old server answers Settings → API keys with an error for a company with a key holding it
   (and the platform plan pages for a plan version including it), and `/api/v1/tasks` with 404;
   rolling web servers back to an image from before them does the same. Workers are not affected.

   Migration 0175 (ADR-259) widens the same scope checks again, with the same brief locks, adds
   `app.crm_tasks.created_by_api_key_id` and replaces the tasks' creator check with one taking a key
   as the creator, NOT VALID with the new foreign key (no row is read under the migration's lock);
   0176 validates both while the table stays writable. Web servers from before 0175 do not know
   `tasks.write`: until the web rollout ends, an old server answers Settings → API keys with an
   error for a company with a key holding it (and the platform plan pages for a plan version
   including it), and `POST /api/v1/tasks` with 405 (404 before 0173). Workers are not affected:
   they send a key's task reminders as members' ones.

   ADR-260 has no migration. Until the web rollout ends, an old web server answers
   `PATCH /api/v1/tasks/{id}` with 405 and describes the scope as creating tasks only; rolling web
   servers back does the same. Workers are not affected.

   Migration 0177 (ADR-261) replaces the endpoints' event check (validated at once) and the events'
   type check (NOT VALID; 0178 validates it while captures go on), and adds two triggers on
   `app.crm_tasks`. Workers roll out before web servers, so no endpoint takes the task events before
   every worker can describe them. A worker from before it fails each task event's delivery without
   an attempt (`payload_failed`; replay it once newer workers run), so before rolling workers back
   to such an image, turn the task events off on the endpoints that take them. An old web server's
   Settings and API do not offer them, and until the web rollout ends an old server answers Settings
   → Webhooks with an error for a company with an endpoint taking one (it has no label for them):
   add them to endpoints once the rollout ends, and turn them off before rolling web servers back to
   such an image.

   Migration 0179 (ADR-263) adds `pipeline_ids` to `app.webhook_endpoints` with a check validated by
   reading the table, and replaces `app.capture_webhook_event` (keeping 0138's filters) with the
   same signature; every endpoint starts with none. Web servers of this release need it, as their
   reads of endpoints name the column; workers do not read it. Web servers from before it neither
   show nor change the column: until the web rollout ends, an old server's change that drops every
   deal event from an endpoint with a list fails on the check, and its other changes keep it.

   Migration 0180 (ADR-264) adds `stage_ids` to `app.webhook_endpoints` with a check validated by
   reading the table, and replaces `app.capture_webhook_event` (keeping 0179's filters) with the
   same signature; every endpoint starts with none. Web servers of this release need it, as their
   reads of endpoints name the column; workers do not read it. Web servers from before it neither
   show nor change the column: until the web rollout ends, an old server's change that drops every
   deal event from an endpoint with a list of stages fails on the check, and its other changes keep
   it.

   Migration 0181 (ADR-265) adds `owner_ids` to `app.webhook_endpoints` with a check validated by
   reading the table, and replaces `app.capture_webhook_event` (keeping 0180's filters) with the
   same signature; every endpoint starts with none. Web servers of this release need it, as their
   reads of endpoints name the column; workers do not read it. Web servers from before it neither
   show nor change the column: until the web rollout ends, an old server's change that drops every
   deal event from an endpoint with a list of owners fails on the check, and its other changes keep
   it.

   Migration 0182 (ADR-266) adds `task_assignee_ids` to `app.webhook_endpoints` with a check
   validated by reading the table, and replaces `app.capture_webhook_event` (keeping 0181's filters)
   with the same signature; every endpoint starts with none. Web servers of this release need it, as
   their reads of endpoints name the column; workers do not read it. Web servers from before it
   neither show nor change the column: until the web rollout ends, an old server's change that drops
   both task events from an endpoint with a list of assignees fails on the check, and its other
   changes keep it.

   Migration 0183 (ADR-267) adds `contact_tags` to `app.webhook_endpoints` with a check validated by
   reading the table, and replaces `app.capture_webhook_event` (keeping 0182's filters) with the
   same signature; every endpoint starts with none. Web servers of this release need it, as their
   reads of endpoints name the column; workers do not read it. Web servers from before it neither
   show nor change the column: until the web rollout ends, an old server's change that drops every
   event of a conversation from an endpoint with a list of tags fails on the check, and its other
   changes keep it.

   Migration 0184 (ADR-268) widens the API keys' and plan versions' scope checks again for
   `notes.write`, with the same brief locks, validated at once. Web servers from before it do not
   know `notes.write`: until the web rollout ends, an old server answers Settings → API keys with an
   error for a company with a key holding it (and the platform plan pages for a plan version
   including it), and `POST /api/v1/notes` with 404. Workers are not affected.

   Migration 0185 (ADR-269) replaces the endpoints' event check and the checks of their pipeline,
   stage and owner lists (validated at once: at most 10 endpoints per company), the events' type
   check (NOT VALID; 0186 validates it while captures go on), the deal trigger (now also on owner
   changes) and its function, and `app.capture_webhook_event` (keeping 0183's filters) with the same
   signature. Workers roll out before web servers, so no endpoint takes `deal.owner_changed` before
   every worker can describe it. A worker from before it fails each owner change's delivery without
   an attempt (`payload_failed`; replay it once newer workers run), so before rolling workers back
   to such an image, turn the event off on the endpoints that take it. An old web server's Settings
   and API do not offer it, and until the web rollout ends an old server answers Settings → Webhooks
   with an error for a company with an endpoint taking it (it has no label for it): add it to
   endpoints once the rollout ends, and turn it off before rolling web servers back to such an
   image.

   Migration 0187 (ADR-270) adds `status_changed_by`, `status_changed_by_api_key_id` and
   `status_changed_xact` to `app.commerce_orders` (nullable, so the table is not rewritten), a
   foreign key and a check NOT VALID (0188 validates both while the table stays writable), the
   runtime role's grant to update the columns, a trigger that clears a changer an earlier
   transaction recorded, and `app.webhook_capture_order` with the same signature. Servers from
   before it change statuses without recording who: until the rollout ends, the events of their
   changes say `changedBy` null, never the previous changer, and workers from before it deliver
   order events without `changedBy` and `apiKeyId`. Rolling back does the same. Nothing needs
   turning off first.

   ADR-271 has no migration. Until the web rollout ends, an old web server answers orders without
   `statusChangedBy` and `statusChangedByApiKeyId`; rolling web servers back does the same. Workers
   are not affected.

   ADR-272 has no migration. Until the web rollout ends, an old web server answers
   `GET /api/v1/contact-tags` and `GET /api/v1/conversation-tags` with 404; rolling web servers back
   does the same. Workers are not affected.

   Migration 0189 (ADR-273) adds `conversation_tags` to `app.webhook_endpoints` with a check
   validated by reading the table, grants the definer role a read of `app.conversation_tags.tag`,
   and replaces `app.capture_webhook_event` (keeping 0185's filters) with the same signature; every
   endpoint starts with none. Web servers of this release need it, as their reads of endpoints name
   the column; workers do not read it. Web servers from before it neither show nor change the
   column: until the web rollout ends, an old server's change that drops every event of a
   conversation from an endpoint with a list of conversation tags fails on the check, and its other
   changes keep it.

   Migration 0190 (ADR-274) replaces the endpoints' event check and the check of their assignee
   lists (validated at once: at most 10 endpoints per company), the events' type check (NOT VALID;
   0191 validates it while captures go on), the task trigger (now also on assignee changes) and its
   function, and `app.capture_webhook_event` (keeping 0189's filters) with the same signature.
   Workers roll out before web servers, so no endpoint takes `task.assignee_changed` before every
   worker can describe it. A worker from before it fails each assignee change's delivery without an
   attempt (`payload_failed`; replay it once newer workers run), so before rolling workers back to
   such an image, turn the event off on the endpoints that take it. An old web server's Settings and
   API do not offer it, and until the web rollout ends an old server answers Settings → Webhooks
   with an error for a company with an endpoint taking it (it has no label for it): add it to
   endpoints once the rollout ends, and turn it off before rolling web servers back to such an
   image.

   Migration 0192 (ADR-275) replaces the endpoints' event check and the checks of their pipeline,
   stage and owner lists (validated at once: at most 10 endpoints per company), the events' type
   check (NOT VALID; 0193 validates it while captures go on), the deal trigger (now also on its
   title, value and expected close date) and its function, grants the definer role a read of a
   deal's id and owner, and replaces `app.capture_webhook_event` (keeping 0190's filters) with the
   same signature. Workers roll out before web servers, so no endpoint takes `deal.updated` before
   every worker can describe it. A worker from before it fails each delivery of the event without an
   attempt (`payload_failed`; replay it once newer workers run), so before rolling workers back to
   such an image, turn the event off on the endpoints that take it. An old web server's Settings and
   API do not offer it, and until the web rollout ends an old server answers Settings → Webhooks
   with an error for a company with an endpoint taking it (it has no label for it): add it to
   endpoints once the rollout ends, and turn it off before rolling web servers back to such an
   image.

   Migration 0194 (ADR-276) replaces the endpoints' event check and the check of their assignee list
   (validated at once: at most 10 endpoints per company), the events' type check (NOT VALID; 0195
   validates it while captures go on), the task trigger (now also on its title, notes, due time and
   reminder time) and its function, and replaces `app.capture_webhook_event` (keeping 0192's
   filters) with the same signature. Workers roll out before web servers, so no endpoint takes
   `task.updated` before every worker can describe it. A worker from before it fails each delivery
   of the event without an attempt (`payload_failed`; replay it once newer workers run), so before
   rolling workers back to such an image, turn the event off on the endpoints that take it. An old
   web server's Settings and API do not offer it, and until the web rollout ends an old server
   answers Settings → Webhooks with an error for a company with an endpoint taking it (it has no
   label for it): add it to endpoints once the rollout ends, and turn it off before rolling web
   servers back to such an image.

   Migration 0196 (ADR-277) adds who changed a deal or task (`changed_by`, `changed_by_api_key_id`,
   `changed_xact`) to `app.crm_deals` and `app.crm_tasks`, nullable, so neither table is rewritten,
   with their foreign keys and checks NOT VALID (0197 validates them while the tables stay
   writable), the runtime role's grants, the trigger that clears a changer another transaction
   recorded, and the deal and task capture functions with the same signatures. Until the rollout
   ends, changes made by web servers and workers from before it record nobody, so their events name
   nobody (`changedBy` null), and a delivery an older worker builds has no `changedBy` or `apiKeyId`
   at all; rolling back leaves the columns, which older code neither reads nor writes.

   ADR-278 has no migration. Until the web rollout ends, an old web server answers deals and tasks
   without `changedBy` and `changedByApiKeyId`, and for 24 hours after it a retried `POST /deals` or
   `POST /tasks` whose first answer an old server stored replays that answer, without them; rolling
   web servers back does the same. Workers are not affected.

   Migration 0198 (ADR-279) widens the API keys' and plan versions' scope checks again for
   `notes.read`, with the same brief locks, validated at once; 0199 builds
   `crm_activities_notes_idx` concurrently, outside a transaction (if it fails, drop the INVALID
   index with `DROP INDEX CONCURRENTLY app.crm_activities_notes_idx;` and run the migrations again).
   Web servers from before it do not know `notes.read`: until the web rollout ends, an old server
   answers Settings → API keys with an error for a company with a key holding it (and the platform
   plan pages for a plan version including it), `GET /api/v1/notes` with 405 and
   `GET /api/v1/notes/{id}` with 404, and for 24 hours after it a retried `POST /notes` whose first
   answer an old server stored replays that answer, without `writtenBy` and `apiKeyId`. Workers are
   not affected.

   Migration 0200 (ADR-280) replaces the endpoints' event check (validated at once: at most 10
   endpoints per company) and the events' type check (NOT VALID; 0201 validates it while captures go
   on), and adds the note trigger on `app.crm_activities` and its function;
   `app.capture_webhook_event` is unchanged. Workers roll out before web servers, so no endpoint
   takes `note.created` before every worker can describe it. A worker from before it fails each
   delivery of the event without an attempt (`payload_failed`; replay it once newer workers run), so
   before rolling workers back to such an image, turn the event off on the endpoints that take it.
   An old web server's Settings and API do not offer it, and until the web rollout ends an old
   server answers Settings → Webhooks with an error for a company with an endpoint taking it (it has
   no label for it): add it to endpoints once the rollout ends, and turn it off before rolling web
   servers back to such an image.

   ADR-281 has no migration. Until the web rollout ends, an old web server answers
   `GET /api/v1/deals/{id}/history` with 404; rolling web servers back does the same. Workers are
   not affected.

   ADR-282 has no migration. Until the web rollout ends, an old web server answers deals and tasks
   without `createdBy` and `createdByApiKeyId`, and for 24 hours after it a retried `POST /deals` or
   `POST /tasks` whose first answer an old server stored replays that answer, without them; rolling
   web servers back does the same. Workers send the same events as before.

   Migration 0202 (ADR-283) widens the API keys' and plan versions' scope checks again for
   `orders.request_payment`, with the same brief locks, validated at once, and adds
   `commerce_payment_links.created_by_api_key_id` with its foreign key and the creator check NOT
   VALID, so the table is not read under the lock, letting a link have no member; 0203 validates
   both, reading the table without blocking its writes. Workers before web servers: an older worker
   sends a key's link message as a member's without naming the member, so do not roll workers back
   while keys have open links. Until the web rollout ends, an old web server answers Settings → API
   keys with an error for a company with a key holding the new scope, and the new endpoints with 404
   Not Found.

   ADR-284 has no migration. Until the web rollout ends, an old web server answers
   `GET /api/v1/orders/{id}/payment-links` with 404; rolling web servers back does the same. Workers
   are not affected.

   Migration 0204 (ADR-285) replaces the endpoints' event and number checks (validated at once: at
   most 10 endpoints per company) and the events' type check (NOT VALID; 0205 validates it while
   captures go on), adds the trigger on `app.commerce_payment_links` and its function, and replaces
   `app.capture_webhook_event` with the same signature (0194's, with the event among those of a
   number). Workers roll out before web servers, so no endpoint takes the event before every worker
   can describe it. A worker from before it fails each delivery of the event without an attempt
   (`payload_failed`; replay it once newer workers run), so before rolling workers back to such an
   image, turn the event off on the endpoints that take it. Until the web rollout ends, an old web
   server answers Settings → Webhooks with an error for a company with an endpoint taking it: add it
   to endpoints once the rollout ends, and turn it off before rolling web servers back.

   Migration 0206 (ADR-286) widens the API keys' and plan versions' scope checks again for
   `pipelines.manage`, with the same brief locks, validated at once, and adds
   `crm_pipelines.created_by_api_key_id` with its foreign key and the creator check NOT VALID, so
   the table is not read under the lock, letting a pipeline have no member; 0207 validates both,
   reading the table without blocking its writes. Older servers keep adding pipelines as members,
   which the check accepts, and workers do not read the column. Until the web rollout ends, an old
   web server answers Settings → API keys with an error for a company with a key holding the new
   scope, the new requests with 405 or 404, and API pipelines without `version`, `createdBy` and
   `createdByApiKeyId`; rolling web servers back does the same.

   Migration 0208 (ADR-287) widens the API keys' and plan versions' scope checks again for
   `teams.manage`, with the same brief locks, validated at once; no other table changes. Until the
   web rollout ends, an old web server answers Settings → API keys with an error for a company with
   a key holding the new scope and the new requests with 405 or 404, and still lists in Settings →
   Teams a team's members whose role cannot answer conversations; rolling web servers back does the
   same.

   ADR-288 has no migration. Until the web rollout ends, an old web server answers
   `GET /api/v1/pipelines/{id}/forecast` with 404; rolling web servers back does the same. Workers
   are not affected.

   Migration 0209 (ADR-289) widens the API keys' and plan versions' scope checks again for
   `availability.write`, with the same brief locks, validated at once; no other table changes. Until
   the web rollout ends, an old web server answers Settings → API keys with an error for a company
   with a key holding the new scope, and `PATCH /api/v1/members/{id}` with 405 or 404; rolling web
   servers back does the same.

   Migration 0210 (ADR-290) widens the API keys' and plan versions' scope checks again for
   `business_hours.read` and `business_hours.manage`, with the same brief locks, validated at once;
   no other table changes. Until the web rollout ends, an old web server answers Settings → API keys
   with an error for a company with a key holding a new scope, and the business hours requests with
   405 or 404; rolling web servers back does the same.

   Migrations 0211 and 0212 (ADR-291) widen the API keys' and plan versions' scope checks again for
   `saved_replies.manage`, with the same brief locks, validated at once, and give
   `app.saved_replies` the columns naming the key that added or last changed a reply: 0211 adds
   them, with their foreign keys and checks NOT VALID, under a brief lock (the member columns become
   nullable), and 0212 validates them, reading the table without blocking its writes. Until the web
   rollout ends, an old web server answers Settings → API keys with an error for a company with a
   key holding the new scope, and the saved reply requests with 405 or 404; it shows a reply a key
   added or changed without an editor's name, and its changes name its member, which the editor
   check accepts. Rolling web servers back does the same.

   ADR-292 has no migration. Until the web rollout ends, an old web server answers
   `GET /api/v1/satisfaction-surveys` with 404; rolling web servers back does the same.

   Migration 0213 (ADR-293) replaces the endpoints' event and number checks (validated at once: at
   most 10 endpoints per company) and the events' type check (NOT VALID; 0214 validates it while
   captures go on), adds the trigger on `app.csat_surveys` and its function, and replaces
   `app.capture_webhook_event` with the same signature (0204's, with the event among those of a
   number). Workers roll out before web servers, so no endpoint takes the event before every worker
   can describe it. A worker from before it fails each delivery of the event without an attempt
   (`payload_failed`; replay it once newer workers run), so before rolling workers back to such an
   image, turn the event off on the endpoints that take it. Until the web rollout ends, an old web
   server answers Settings → Webhooks with an error for a company with an endpoint taking it: add it
   to endpoints once the rollout ends, and turn it off before rolling web servers back.

   ADR-294 has no migration. Until the web rollout ends, an old web server answers
   `GET /api/v1/message-templates` and `GET /api/v1/message-templates/{id}` with 404; rolling web
   servers back does the same.

   Migration 0215 (review fix of ADR-275 and ADR-276) replaces the deal and task capture trigger
   functions and `app.capture_webhook_event` in place, with the same signatures (0213's capture), so
   endpoints naming owners or assignees are matched against the owner or assignee at each event's
   step. Only the database changes: workers and web servers of any version keep working, and stored
   events and payloads are unchanged.

   Migration 0216 (ADR-295) replaces the API keys' and plans' scope checks (validated at once: one
   row per key and per plan version) with `templates.write` and a bound of 64 scopes, adds
   `message_templates.created_by_api_key_id` with its foreign key and the author check (NOT VALID;
   0217 validates them while writes go on), and grants the runtime role the update of both author
   columns. Until the web rollout ends, an old web server answers Settings → API keys with an error
   for a company with a key holding `templates.write`, answers `POST /api/v1/message-templates` and
   `PATCH` and `DELETE /api/v1/message-templates/{id}` with 405, gives templates without
   `createdBy`, and uses a deleted draft again under its earlier author; rolling web servers back
   does the same.

   Migration 0218 (ADR-296) replaces the API keys' and plans' scope checks with `templates.submit`
   (validated at once). Until the web rollout ends, an old web server answers Settings → API keys
   with an error for a company with a key holding `templates.submit` and answers
   `POST /api/v1/message-templates/{id}/submit` with 404; one with ADR-295 but not ADR-296 refuses
   deleting a template Meta has through the API (412) and answers a deletion without `status`.
   Rolling web servers back does the same. Workers need no change: they already run template jobs
   that name no member.

   Migration 0219 (ADR-297) replaces the API keys' and plans' scope checks with `reports.read`
   (validated at once). Until the web rollout ends, an old web server answers Settings → API keys
   with an error for a company with a key holding `reports.read`, and answers `GET /api/v1/reports`
   with 404; rolling web servers back does the same. Workers are unaffected.

   Migration 0220 (ADR-298) replaces the API keys' and plans' scope checks with `flows.read`
   (validated at once); 0221 builds `flow_responses_received_idx` concurrently, outside a
   transaction (if it fails, drop the INVALID index with
   `DROP INDEX CONCURRENTLY app.flow_responses_received_idx;` and run the migrations again). Until
   the web rollout ends, an old web server answers Settings → API keys with an error for a company
   with a key holding `flows.read`, and answers `GET /api/v1/flows` and `GET /api/v1/flow-responses`
   with 404; rolling web servers back does the same. Workers are unaffected.

   Migration 0222 (ADR-299) replaces the API keys' and plans' scope checks with `chat_links.read`
   (validated at once). Until the web rollout ends, an old web server answers Settings → API keys
   with an error for a company with a key holding `chat_links.read`, and answers
   `GET /api/v1/chat-links` and `GET /api/v1/chat-links/{id}` with 404; rolling web servers back
   does the same. Workers are unaffected.

   Migration 0223 (ADR-300) replaces the API keys' and plans' scope checks with `chat_links.write`
   (validated at once), drops NOT NULL from `chat_links.created_by_membership_id` and adds
   `created_by_api_key_id` with its composite foreign key to the company's keys and the one-author
   check, both NOT VALID (brief locks; no row is read); 0224 validates them, reading the table
   without blocking its writes. Until the web rollout ends, an old web server answers Settings → API
   keys with an error for a company with a key holding `chat_links.write`, answers
   `POST /api/v1/chat-links` and `PATCH /api/v1/chat-links/{id}` with 404 (405 on one with ADR-299
   but not ADR-300), and gives links without `createdBy`; it always names the member who adds a
   link, so the check holds. Rolling web servers back does the same. Workers are unaffected.

   ADR-301 has no migration. Until the web rollout ends, an old web server gives conversations
   without `source` and refuses the `source` and `chatLinkId` filters of `GET /api/v1/conversations`
   and `POST /api/v1/conversations/update-matching` (422); rolling web servers back does the same.

   The team places fix (review of PR #40, ADR-287 amended) has no migration. Until the web rollout
   ends, an old web server still takes away, when it saves a team, the places of members who cannot
   answer conversations now; rolling web servers back does the same.

   Migration 0225 (ADR-302) replaces the API keys' and plans' scope checks with `ads.read`
   (validated at once). Until the web rollout ends, an old web server answers Settings → API keys
   with an error for a company with a key holding `ads.read`, answers `GET /api/v1/ads` with 404,
   and refuses the `adId` filter of `GET /api/v1/conversations` and
   `POST /api/v1/conversations/update-matching` (422); rolling web servers back does the same.
   Workers are unaffected.

   Migration 0226 (ADR-303) adds `task_pipeline_ids` to `app.webhook_endpoints` with a check
   validated by reading the table, and replaces `app.capture_webhook_event` (keeping 0215's filters)
   with the same signature; every endpoint starts with none. Web servers of this release need it, as
   their reads of endpoints name the column; workers do not read it. Web servers from before it
   neither show nor change the column: until the web rollout ends, an old server's change that drops
   every task event from an endpoint with a list of pipelines of tasks' deals fails on the check,
   its other changes keep it, and its API refuses `taskPipelineIds` (422) and leaves it out of the
   endpoints it answers.

   Migration 0227 (ADR-304) adds `task_stage_ids` and `task_deal_owner_ids` to
   `app.webhook_endpoints` with checks validated by reading the table, and replaces
   `app.capture_webhook_event` (keeping 0226's filters) with the same signature; every endpoint
   starts with neither list. Web servers of this release need it, as their reads of endpoints name
   the columns; workers do not read them. Web servers from before it neither show nor change the
   columns: until the web rollout ends, an old server's change that drops every task event from an
   endpoint with either list fails on the checks, its other changes keep them, and its API refuses
   `taskStageIds` and `taskDealOwnerIds` (422) and leaves them out of the endpoints it answers.

   Migration 0228 (ADR-305) adds `note_pipeline_ids`, `note_stage_ids` and `note_deal_owner_ids` to
   `app.webhook_endpoints` with checks validated by reading the table, and replaces
   `app.capture_webhook_event` (keeping 0227's filters) with the same signature; every endpoint
   starts with none of the lists. Web servers of this release need it, as their reads of endpoints
   name the columns; workers do not read them. Web servers from before it neither show nor change
   the columns: until the web rollout ends, an old server's change that drops `note.created` from an
   endpoint with any of the lists fails on the checks, its other changes keep them, and its API
   refuses `notePipelineIds`, `noteStageIds` and `noteDealOwnerIds` (422) and leaves them out of the
   endpoints it answers.

   Migration 0229 (ADR-306) adds `crm_change_makers` to `app.webhook_endpoints` with a check
   validated by reading the table, and replaces `app.capture_webhook_event` (keeping 0228's filters)
   with the same signature; every endpoint starts with no list. Web servers of this release need it,
   as their reads of endpoints name the column; workers do not read it. Web servers from before it
   neither show nor change the column: until the web rollout ends, an old server's change that drops
   every deal, task and note event from an endpoint with a list fails on the check, its other
   changes keep it, and its API refuses `crmChangeMakers` (422) and leaves it out of the endpoints
   it answers.

   Migration 0230 (ADR-307) adds `survey_scores` to `app.webhook_endpoints` with a check validated
   by reading the table, and replaces `app.capture_webhook_event` (keeping 0229's filters) with the
   same signature; every endpoint starts with no list. Web servers of this release need it, as their
   reads of endpoints name the column; workers do not read it. Web servers from before it neither
   show nor change the column: until the web rollout ends, an old server's change that drops
   `satisfaction_survey.answered` from an endpoint with a list fails on the check, its other changes
   keep it, and its API refuses `surveyScores` (422) and leaves it out of the endpoints it answers.

   Migration 0231 (ADR-308) adds `payment_link_statuses` to `app.webhook_endpoints` with a check
   validated by reading the table, and replaces `app.capture_webhook_event` (keeping 0230's filters)
   with the same signature; every endpoint starts with no list. Web servers of this release need it,
   as their reads of endpoints name the column; workers do not read it. Web servers from before it
   neither show nor change the column: until the web rollout ends, an old server's change that drops
   `payment_link.status_changed` from an endpoint with a list fails on the check, its other changes
   keep it, and its API refuses `paymentLinkStatuses` (422) and leaves it out of the endpoints it
   answers.

   Migration 0232 (ADR-309) adds `deal_statuses` and `task_statuses` to `app.webhook_endpoints` with
   checks validated by reading the table, and replaces `app.capture_webhook_event` (keeping 0231's
   filters) with the same signature; every endpoint starts with neither list. Web servers of this
   release need it, as their reads of endpoints name the columns; workers do not read them. Web
   servers from before it neither show nor change the columns: until the web rollout ends, an old
   server's change that drops `deal.status_changed` or `task.status_changed` from an endpoint with
   that event's list fails on the check, its other changes keep the lists, and its API refuses
   `dealStatuses` and `taskStatuses` (422) and leaves them out of the endpoints it answers.

   Migration 0233 (ADR-310) adds `deal_details` and `task_details` to `app.webhook_endpoints` with
   checks validated by reading the table, and replaces `app.capture_webhook_event` (keeping 0232's
   filters) with the same signature; every endpoint starts with neither list. Web servers of this
   release need it, as their reads of endpoints name the columns; workers do not read them. Web
   servers from before it neither show nor change the columns: until the web rollout ends, an old
   server's change that drops `deal.updated` or `task.updated` from an endpoint with that event's
   list fails on the check, its other changes keep the lists, and its API refuses `dealDetails` and
   `taskDetails` (422) and leaves them out of the endpoints it answers.

   Migration 0234 (ADR-311) adds `survey_assignee_ids` and `survey_team_ids` to
   `app.webhook_endpoints` with checks validated by reading the table, and replaces
   `app.capture_webhook_event` (keeping 0233's filters) with the same signature; every endpoint
   starts with neither list. Web servers of this release need it, as their reads of endpoints name
   the columns; workers do not read them. Web servers from before it neither show nor change the
   columns: until the web rollout ends, an old server's change that drops
   `satisfaction_survey.answered` from an endpoint with either list fails on the check, its other
   changes keep the lists, and its API refuses `surveyAssigneeIds` and `surveyTeamIds` (422) and
   leaves them out of the endpoints it answers.

   Migration 0235 (ADR-312) adds `survey_contact_tags` and `survey_conversation_tags` to
   `app.webhook_endpoints` with checks validated by reading the table, and replaces
   `app.capture_webhook_event` (keeping 0234's filters) with the same signature; every endpoint
   starts with neither list. Web servers of this release need it, as their reads of endpoints name
   the columns; workers do not read them. Web servers from before it neither show nor change the
   columns: until the web rollout ends, an old server's change that drops
   `satisfaction_survey.answered` from an endpoint with either list fails on the check, its other
   changes keep the lists, and its API refuses `surveyContactTags` and `surveyConversationTags`
   (422) and leaves them out of the endpoints it answers.

   Migration 0236 (ADR-313) creates `ops.integration_assignments` (empty) and
   `ops.platform_assign_integration_failure`, and replaces the console's
   `ops.platform_ops_integration_failures` (four columns more) and the sweep's
   `ops.integration_alerts_due` (which now keeps and forgets assignments too) with the same owners
   and grants. Web servers of this release need it, as the Integrations tab reads the new columns;
   workers run the same check, unchanged for them. Web servers from before it show no assignments
   and ignore the new columns.

   Migration 0237 (ADR-314) adds `notified_at` to `ops.integration_assignments`, set to when each
   existing assignment was made so that none is emailed, replaces
   `ops.platform_assign_integration_failure` with the same signature, owner and grant, and creates
   `ops.claim_integration_assignment_notices` for the worker's role. Workers of this release need
   it, as their minute sweep calls the new function; web servers call the assignment function as
   before. Assignments made while workers from before it run are emailed once a worker of this
   release runs.

   Migration 0238 (ADR-315) creates `ops.platform_ops_assigned_integration_failures` for the
   platform role and changes nothing else. Web servers of this release need it for "Assigned to me";
   web servers from before it do not call it, and workers are unaffected.

   Migration 0239 (ADR-316) adds `contact_event_tags` to `app.webhook_endpoints` with a check
   validated by reading the table, replaces `app.capture_contact_webhook_event` (keeping 0136's
   filters) and the tag trigger's `app.webhook_capture_contact_tag` with the same signatures, and
   creates `app.deliver_contact_webhook_tag` for the runtime and definer roles; every endpoint
   starts without a list. Web servers of this release need it, as their reads of endpoints name the
   column; workers do not read it. Web servers from before it neither show nor change the column:
   until the web rollout ends, an old server's change that drops both contact events from an
   endpoint with a list fails on the check, its other changes keep the list, and its API refuses
   `contactEventTags` (422) and leaves it out of the endpoints it answers.

   Migration 0240 (ADR-318) creates `ops.platform_ops_unassigned_integration_failures` for the
   platform role and changes nothing else. Web servers of this release need it for "Unassigned"; web
   servers from before it do not call it, and workers are unaffected.

   Migration 0241 (ADR-319) adds `run_api_key_ids` to `app.webhook_endpoints` with a check validated
   by reading the table, and replaces the run trigger's `app.webhook_capture_automation_run` and
   `app.capture_webhook_event` with the same signatures (keeping 0235's filters); every endpoint
   starts without a list. Web servers of this release need it, as their reads of endpoints name the
   column; workers do not read it. Web servers from before it neither show nor change the column:
   until the web rollout ends, an old server's change that drops both run events from an endpoint
   with a list fails on the check, its other changes keep the list, and its API refuses
   `runApiKeyIds` (422) and leaves it out of the endpoints it answers.

   Migration 0242 (ADR-320) adds `message_api_key_ids` to `app.webhook_endpoints` with a check
   validated by reading the table, creates `app.webhook_api_key_family` for the runtime and definer
   roles, and replaces the message trigger's `app.webhook_capture_message` and
   `app.capture_webhook_event` with the same signatures (keeping 0241's filters); every endpoint
   starts without a list. Web servers of this release need it, as their reads of endpoints name the
   column; workers do not read it. Web servers from before it neither show nor change the column:
   until the web rollout ends, an old server's change that drops `message.status` from an endpoint
   with a list fails on the check, its other changes keep the list, and its API refuses
   `messageApiKeyIds` (422) and leaves it out of the endpoints it answers.

   Migration 0243 (ADR-321) adds `crm_excluded_api_key_ids` to `app.webhook_endpoints` with a check
   validated by reading the table, and replaces `app.capture_webhook_event` with the same signature
   (keeping 0242's filters); every endpoint starts without a list. Web servers of this release need
   it, as their reads of endpoints name the column; workers do not read it. Web servers from before
   it neither show nor change the column: until the web rollout ends, an old server's change that
   drops every deal, task and note event from an endpoint with a list fails on the check, its other
   changes keep the list, and its API refuses `crmExcludedApiKeyIds` (422) and leaves it out of the
   endpoints it answers.

   Migration 0244 (ADR-322) adds `order_change_makers` to `app.webhook_endpoints` with a check
   validated by reading the table, and replaces `app.capture_webhook_event` with the same signature
   (keeping 0243's filters); every endpoint starts without a list. Web servers of this release need
   it, as their reads of endpoints name the column; workers do not read it. Web servers from before
   it neither show nor change the column: until the web rollout ends, an old server's change that
   drops `order.status_changed` from an endpoint with a list fails on the check, its other changes
   keep the list, and its API refuses `orderChangeMakers` (422) and leaves it out of the endpoints
   it answers.

   Migration 0245 (ADR-323) adds `order_excluded_api_key_ids` to `app.webhook_endpoints` with a
   check validated by reading the table, and replaces `app.capture_webhook_event` with the same
   signature (keeping 0244's filters); every endpoint starts without a list. Web servers of this
   release need it, as their reads of endpoints name the column; workers do not read it. Web servers
   from before it neither show nor change the column: until the web rollout ends, an old server's
   change that drops `order.status_changed` from an endpoint with a list fails on the check, its
   other changes keep the list, and its API refuses `orderExcludedApiKeyIds` (422) and leaves it out
   of the endpoints it answers.

   Migration 0246 (ADR-324) adds `payment_link_api_key_ids` to `app.webhook_endpoints` with a check
   validated by reading the table, and replaces the link trigger's
   `app.webhook_capture_payment_link` and `app.capture_webhook_event` with the same signatures
   (keeping 0245's filters); every endpoint starts without a list. Web servers of this release need
   it, as their reads of endpoints name the column; workers do not read it. Web servers from before
   it neither show nor change the column: until the web rollout ends, an old server's change that
   drops `payment_link.status_changed` from an endpoint with a list fails on the check, its other
   changes keep the list, and its API refuses `paymentLinkApiKeyIds` (422) and leaves it out of the
   endpoints it answers.

   Migration 0247 (ADR-326) replaces the endpoints' event, number, automation, trigger and run API
   key checks (validated at once: at most 10 endpoints per company) and the events' type check (NOT
   VALID; 0248 validates it while captures go on), adds the trigger on `app.automation_run_steps`
   and its function, and replaces `app.capture_webhook_event` with the same signature (0246's, with
   the step event among the run events). Every step a run records then calls the capture, which
   writes nothing while no endpoint takes the event. Workers roll out before web servers, so no
   endpoint takes `automation.run_step` before every worker can describe it. A worker from before it
   fails each delivery of the event without an attempt (`payload_failed`; replay it once newer
   workers run), so before rolling workers back to such an image, turn the event off on the
   endpoints that take it. Until the web rollout ends, an old web server answers Settings → Webhooks
   with an error for a company with an endpoint taking it: add it to endpoints once the rollout
   ends, and turn it off before rolling web servers back.

   Migration 0249 (ADR-327) adds `run_step_outcomes` to `app.webhook_endpoints` with a check
   validated by reading the table, and replaces `app.capture_webhook_event` with the same signature
   (keeping 0247's filters); every endpoint starts without a list. Web servers of this release need
   it, as their reads of endpoints name the column; workers do not read it. Web servers from before
   it neither show nor change the column: until the web rollout ends, an old server's change that
   drops `automation.run_step` from an endpoint with a list fails on the check, its other changes
   keep the list, and its API refuses `runStepOutcomes` (422) and leaves it out of the endpoints it
   answers.

   Migration 0250 (ADR-328) adds `run_step_node_types` to `app.webhook_endpoints` with a check
   validated by reading the table, and replaces the step trigger's
   `app.webhook_capture_automation_step` and `app.capture_webhook_event` with the same signatures
   (keeping 0249's filters); every endpoint starts without a list. Web servers of this release need
   it, as their reads of endpoints name the column; workers do not read it. Web servers from before
   it neither show nor change the column: until the web rollout ends, an old server's change that
   drops `automation.run_step` from an endpoint with a list fails on the check, its other changes
   keep the list, and its API refuses `runStepNodeTypes` (422) and leaves it out of the endpoints it
   answers.

   Migration 0253 (ADR-332) adds `contact_event_field_values` to `app.webhook_endpoints` with a
   check validated by reading the table, creates `app.webhook_contact_values_match` for the runtime
   and definer roles, grants the definer role the read of a contact's source, and replaces
   `app.capture_contact_webhook_event` and `app.deliver_contact_webhook_tag` with the same
   signatures (keeping 0239's filters); every endpoint starts without a list. Web servers of this
   release need it, as their reads of endpoints name the column; workers do not read it. Web
   servers from before it neither show nor change the column: until the web rollout ends, an old
   server's change that drops both contact events from an endpoint with a list fails on the check,
   its other changes keep the list, and its API refuses `contactEventFieldValues` (422) and leaves
   it out of the endpoints it answers.

   Migration 0254 (ADR-333) creates `ops.platform_ops_daily_activity` for the platform role. Web
   servers of this release need it, as the Usage tab reads it; workers do not. Web servers from
   before it do not call it, so it can be applied before them.

   Migration 0255 (ADR-334) adds `ops.platform_ops_daily_activity(timestamptz, uuid)` and recreates
   0254's one-argument function to read through it, with the same signature, owner and grants, in
   one transaction: a call made before it commits runs 0254's body and a later one the new function
   (a statement planned just before the commit and run just after can fail once, as with any
   function the migrations recreate). Web servers of this release call the two-argument function;
   a server of the release that added 0254, if one still runs, calls the one-argument function,
   which stays, so 0255 can be applied before the web rollout.

   Migration 0256 (ADR-335) replaces the check on `app.webhook_endpoints.contact_event_field_values`
   (validated by reading the table, which holds at most 10 endpoints a company) and
   `app.webhook_contact_values_match` with the same signature, so the capture keeps calling it.
   Every list stored before it passes the new check. Web servers of this release need it, as they
   store words and ranges; workers do not read the list. Web servers from before it neither show
   nor take words and ranges: until the web rollout ends, an old server shows such a condition as
   "undefined", refuses a change in Settings that keeps it, and its API refuses words and ranges
   (422) while answering them as stored. An old server also keeps a word or range the endpoint holds
   as a pair without a value, which the new check refuses: any change it makes to an endpoint
   holding one (in Settings or through the API, even a change that leaves the list out) fails with
   a 500 and leaves the endpoint as it was. Finish the web rollout before companies add words and
   ranges, or expect such failures until it ends.

   Migration 0257 (ADR-337) adds `app.webhook_endpoints.message_words` with its check (validated by
   reading the table, which holds at most 10 endpoints a company) and update grant, adds
   `app.webhook_message_text`, and replaces `app.capture_webhook_event` with the same signature,
   keeping every filter before it; every endpoint starts without a list. Web servers of this release
   need it, as their reads of endpoints name the column; workers do not read it, and the capture
   runs in the database. Web servers from before it neither show nor change the column: until the
   web rollout ends, an old server's change that drops Message received from an endpoint with words
   fails on the check (a 500, leaving the endpoint as it was), its other changes keep the words, and
   its API refuses `messageWords` (422) and leaves it out of the endpoints it answers. A web
   rollback after the migration brings the same back until this release is rolled out again: old
   servers can neither show nor clear words, so an endpoint with words cannot drop Message received
   there.

   Migration 0258 (ADR-338) adds `ops.platform_alert_channel` and `ops.platform_alert_posts` with
   their grants, the channel's definer functions (set, remove, test and read for platform staff;
   queue, claim, finish and purge the posts and re-encrypt the address for the worker) and replaces
   `ops.sealed_value_keys` with the channel's address as one more sealed kind. `pnpm db:migrate`
   also creates the queue `ops.alert-posts`. No channel is set until a platform owner sets one, so
   nothing is posted. Workers of this release need the migration (their alert sweeps queue posts in
   the transaction of their emails, and they schedule and run the posting job); workers from before
   it keep emailing only, and a post queued while an old worker runs is sent by a new one. Web
   servers of this release need it for Operations → Alerts and Keys; old web servers know neither.
   Roll out workers before setting a channel, as the deploy order below does. After a rollback the
   channel and its posts stay in the database unused: alerts are emailed only, as before.

   Migration 0259 (ADR-339) replaces the check on `app.api_idempotency_keys.response` with one of
   256 KiB (64 KiB before), added `NOT VALID` so that it takes its lock only briefly (every request
   sent with a key writes to the table), and 0260 validates it for the rows already there without
   blocking the table's writes. Web servers of either release work with it: those of this release
   refuse an answer larger than 256 KiB with 422 `idempotency_response_too_large`, and those from
   before it now keep answers between 64 and 256 KiB that their requests failed on (an internal
   error). A rollback of the web keeps the new check, which old servers satisfy.

   Migration 0261 (ADR-340) adds `ops.platform_alert_channel.kinds` (the three operations alerts for
   a channel already set), replaces the posts' kind check, `ops.queue_platform_alert_post`,
   `ops.platform_set_alert_channel`, `ops.platform_alert_channel_state` (one more column),
   `ops.finish_platform_alert_post` (a post failed as unticked while on its way is recorded as sent
   when the address accepted it, and the channel's row is locked before the post's) and
   `ops.claim_platform_alert_posts` (the posts waiting of an alert no longer ticked fail as
   unticked, and the channel's row is held until the claim's transaction ends) and adds
   `ops.platform_set_alert_channel_kinds`. Apply it before workers of this release roll out: while a
   channel is set, their financial alerts queue posts of the new kinds, which the posts' old check
   refuses, so the minute billing sweep fails at that alert, its emails rolled back, every minute
   until it is applied. Workers from before it keep posting the operations alerts, now only those
   the channel gets, and read the address in a transaction of their own after the claim, as before;
   those of this release read it in the claim's. Web servers of this release need it for the Alerts
   tab, whose state reads the kinds; those from before it show and change the channel without them,
   and a channel they replace keeps its kinds. After a rollback the kinds stay in the database: old
   workers post the operations alerts the channel gets and no financial one.

   Migration 0262 (ADR-341) adds `ops.platform_message_days` (each company's messages a UTC day,
   with forced row level security and the definer role's grants only),
   `ops.platform_message_days_counted`, the counts' step in company deletion and the functions that
   count, delete and read them; `pnpm db:migrate` also creates the queue `ops.message-days`. Workers
   of this release schedule the counting every minute: after the deployment they count the 365 days
   before today, 3 a minute, newest first (about two hours), reading each day's messages once
   through the `(tenant_id, created_at)` index, and then each day once it ends and once a day for a
   week after. Web servers of this release need the migration for the Usage tab's year; those from
   before it do not read it. After a rollback the counts stay in the database unused (company
   deletion still deletes a company's), and those older than 400 days are deleted once a worker of
   this release counts again.

   Migration 0263 (ADR-345) lets the chat channel get refund requests: the channel's kinds check
   (one to six known kinds), the posts' kind check and `ops.platform_set_alert_channel_kinds`,
   replaced with the new kind in its order. Apply it before web servers of this release roll out:
   they offer "Refund requests" among the alerts, which the kinds function from before it refuses
   ("Choose at least one of the alerts listed"). Workers of this release work either way: they post
   refund requests only while the channel gets them, which only 0263 allows. Web servers from before
   it neither list the kind nor keep it: saving the alerts from one unticks refund requests, so
   finish the web rollout before an owner ticks them. After a rollback the kind stays in the
   database: old workers queue no post of it, though their posting job still sends one already
   waiting.

   Migration 0264 (ADR-346) counts each day's sends cancelled, delivered and read:
   `ops.platform_message_days` gains `canceled`, `delivered` and `read` (null on the rows counted
   before it) with their check, `ops.platform_message_days_counted` gains `outcomes` (false on the
   days counted before it), and `ops.platform_ops_daily_activity` (the two-argument one),
   `ops.count_platform_message_days` and `ops.platform_ops_message_days` are replaced, the readers
   with three more columns. Apply it before web servers of this release roll out: they read the new
   columns. Web servers from before it read the columns they know by name and work with it, and so
   does 0255's one-argument function. The worker's code does not change: once it is applied, the
   counting job counts every day of the year again, 3 a minute, newest first (about two hours), each
   with its sends cancelled, delivered and read, and the year's delivery chart fills in as it does.
   After a rollback the columns stay, and old web servers do not read them.

   Migration 0265 (ADR-347) creates `ops.platform_ops_failure_reasons` for the platform role. Apply
   it before web servers of this release roll out: the Usage tab and a company's platform page call
   it. Web servers from before it do not, and after a rollback the function stays unused.

   Migration 0266 (ADR-348) replaces the endpoints' event and number checks (validated at once: at
   most 10 endpoints per company) and the events' type check (NOT VALID; 0267 validates it while
   captures go on), adds the trigger on `app.commerce_store_messages` and its function, and replaces
   `app.capture_webhook_event` with the same signature (0257's, with `store_order.cod_answered`
   among the events of a number). Each change of a cash on delivery answer then calls the capture,
   which writes nothing while no endpoint takes the event. Workers roll out before web servers, so no
   endpoint takes the event before every worker can describe it. A worker from before it fails each
   delivery of the event without an attempt (`payload_failed`; replay it once newer workers run), so
   before rolling workers back to such an image, turn the event off on the endpoints that take it.
   Until the web rollout ends, an old web server answers Settings → Webhooks with an error for a
   company with an endpoint taking it: add it to endpoints once the rollout ends, and turn it off
   before rolling web servers back.

   Migration 0268 (ADR-349) adds `cod_answers` and `store_ids` to `app.webhook_endpoints` with checks
   validated by reading the table, and replaces the confirmation trigger's
   `app.webhook_capture_store_cod_answer` and `app.capture_webhook_event` with the same signatures
   (keeping 0266's filters; the trigger now passes the store, which the capture takes out before the
   event is stored); every endpoint starts without a list. Web servers of this release need it, as
   their reads of endpoints name the columns; workers do not read them. Web servers from before it
   neither show nor change the columns: until the web rollout ends, an old server's change that
   drops `store_order.cod_answered` from an endpoint with a list fails on the checks, its other
   changes keep the lists, and its API refuses `codAnswers` and `storeIds` (422) and leaves them out
   of the endpoints it answers.

   Migration 0269 (ADR-350) creates `ops.platform_failure_reason_days` (each company's failed sends
   a UTC day by code, the definer role's alone, deleted with the company at step 36), adds
   `reasons` to `ops.platform_message_days_counted` (false on every day counted so far), replaces
   `ops.count_platform_message_days` and `ops.purge_platform_message_days` with the same signatures
   (dropped as their owner and created again, as 0264 did) and creates
   `ops.platform_ops_failure_reason_year` and `ops.platform_ops_failure_reason_days` for the platform
   role. The worker's counting job, unchanged, then counts every day of the year again, newest
   first, 3 days a minute: the year's reasons cover more days each minute, and the day counts stay
   readable meanwhile (each day's are replaced in one transaction, so days older than a week take
   the statuses reported since they were last counted). Web servers of this release
   need it; web servers from before it never read the new table or functions, and after a rollback
   the counting goes on keeping the codes, unused.

   Migration 0270 (ADR-351) replaces the endpoints' event check (validated at once: at most 10
   endpoints per company) and the events' type check (NOT VALID; 0271 validates it while captures go
   on), and adds two triggers on `app.commerce_store_messages` with their function; the capture is
   unchanged. Each order message skipped, by a store's read or a message's job, then calls the
   capture, which writes nothing while no endpoint takes the event. Workers roll out before web
   servers, so no endpoint takes the event before every worker can describe it. A worker from before
   it fails each delivery of the event without an attempt (`payload_failed`; replay it once newer
   workers run), so before rolling workers back to such an image, turn the event off on the
   endpoints that take it. Until the web rollout ends, an old web server answers Settings → Webhooks
   with an error for a company with an endpoint taking it: add it to endpoints once the rollout
   ends, and turn it off before rolling web servers back.

   Migration 0272 (ADR-352) adds `order_message_events` to `app.webhook_endpoints` and replaces the
   `store_ids` check (so skipped order messages can name stores), both validated by reading the
   table, and replaces `app.webhook_capture_store_message_skipped` and `app.capture_webhook_event`
   with the same signatures (keeping 0268's filters; the trigger now passes the store, which the
   capture takes out before the event is stored); every endpoint starts without the list. Web
   servers of this release need it, as their reads of endpoints name the column; workers do not
   read it. Web servers from before it neither show nor change the column: until the web rollout
   ends, an old server's change that drops `store_order.message_skipped` from an endpoint with a
   list fails on the check, its other changes keep the list, and its API refuses
   `orderMessageEvents` (422) and leaves it out of the endpoints it answers. Such a server also
   clears the stores of an endpoint that takes `store_order.message_skipped` without
   `store_order.cod_answered` whenever it changes that endpoint (its store list needs the answers),
   which then receives every store's skips, and its API refuses `storeIds` for such an endpoint
   (422): choose stores for skipped messages alone once the rollout ends, and check them after
   rolling web servers back.

   Migration 0273 (ADR-353) replaces the endpoints' event, number, store and order message checks
   (validated at once: at most 10 endpoints per company) and the events' type check (NOT VALID;
   0274 validates it while captures go on), adds a trigger on `app.commerce_store_messages` with
   its function and replaces `app.capture_webhook_event` with the same signature (keeping 0272's
   filters). Each order message a message's job queues or starts as an automation then calls the
   capture, which writes nothing while no endpoint takes the event. As for 0270: workers roll out
   before web servers, so no endpoint takes the event before every worker can describe it; a worker
   from before it fails each delivery of the event without an attempt (`payload_failed`; replay it
   once newer workers run), so turn the event off on the endpoints that take it before rolling
   workers back to such an image; and until the web rollout ends, an old web server answers
   Settings → Webhooks with an error for a company with an endpoint taking it, so add it to
   endpoints once the rollout ends and turn it off before rolling web servers back.

   Migration 0275 (ADR-354) adds `order_message_skip_reasons` to `app.webhook_endpoints`, its check
   validated by reading the table, and replaces `app.capture_webhook_event` with the same signature
   (keeping 0273's filters); every endpoint starts without the list. Web servers of this release
   need it, as their reads of endpoints name the column; workers do not read it. Web servers from
   before it neither show nor change the column: until the web rollout ends, an old server's change
   that drops `store_order.message_skipped` from an endpoint with a list fails on the check, its
   other changes keep the list, and its API refuses `orderMessageSkipReasons` (422) and leaves it
   out of the endpoints it answers.

   Migration 0276 (ADR-355) replaces the endpoints' event, number and store checks (validated at
   once: at most 10 endpoints per company) and the events' type check (NOT VALID; 0277 validates it
   while captures go on), adds a trigger on `app.commerce_store_messages` with its function and
   replaces `app.capture_webhook_event` with the same signature (keeping 0275's filters). Each cart
   reminder a message's job skips or queues then calls the capture, which writes nothing while no
   endpoint takes the reminder events. As for 0273: workers roll out before web servers, so no
   endpoint takes the events before every worker can describe them; a worker from before it fails
   each delivery of them without an attempt (`payload_failed`; replay them once newer workers run),
   so turn the events off on the endpoints that take them before rolling workers back to such an
   image; and until the web rollout ends, an old web server answers Settings → Webhooks with an
   error for a company with an endpoint taking them, so add them to endpoints once the rollout ends
   and turn them off before rolling web servers back.

   Migration 0278 (ADR-356) adds `cart_reminder_skip_reasons` to `app.webhook_endpoints`, its check
   validated by reading the table, and replaces `app.capture_webhook_event` with the same signature
   (keeping 0276's filters); every endpoint starts without the list. Web servers of this release
   need it, as their reads of endpoints name the column; workers do not read it. Web servers from
   before it neither show nor change the column: until the web rollout ends, an old server's change
   that drops `store_checkout.reminder_skipped` from an endpoint with a list fails on the check, its
   other changes keep the list, and its API refuses `cartReminderSkipReasons` (422) and leaves it
   out of the endpoints it answers.

   Migration 0279 (ADR-357) adds `oauth_client_auth` to `app.webhook_endpoints`, not null with a
   constant default (`client_secret_basic`, no table rewrite) and its check validated by reading
   the table. Workers and web servers of this release need it, as their reads of endpoints name the
   column. Workers roll out before web servers, and only web servers of this release can choose
   `client_secret_post`, so every worker sends the credentials in the body once a client asks for
   it; a worker from before it sends HTTP Basic for such a client, failing its token requests
   (retried as usual), so set those clients back to HTTP Basic before rolling workers back to such
   an image. Until the web rollout ends, an old web server adds, changes and removes clients without
   the column, leaving the method as it is, and its API refuses `clientAuthentication` (422) and
   leaves it out of the endpoints it answers. A body client an old server removes leaves the body in
   the column of an endpoint without a client, which a client an old server adds there afterwards
   would use; web servers of this release treat such an endpoint as HTTP Basic and set the way with
   every client they add, so only a client added by an old server during the rollout can inherit
   it (its endpoint's page then shows "its ID and secret sent in the request body": choose again).

   Migration 0280 (ADR-358) replaces the endpoints' event, number and campaign checks (validated at
   once: at most 10 endpoints per company) and the events' type check (NOT VALID; 0281 validates it
   while captures go on), and adds a row trigger on `app.campaigns`, a statement trigger on
   `app.campaign_recipients` and `app.capture_campaign_recipient_skips`, the set-based capture both
   call; `app.capture_webhook_event` is unchanged. A campaign's start and each statement of the
   runner that skips recipients then ask whether an endpoint of the company takes
   `campaign.recipient_skipped`, which none does before web servers of this release offer it, and
   every update of recipients keeps its old and new rows for the statement trigger (transition
   tables), in proportion to the rows it changes. As for 0276: workers roll out before web servers,
   so no endpoint takes the event before every worker can describe it; a worker from before it
   fails each delivery of it without an attempt (`payload_failed`; replay them once newer workers
   run), so turn the event off on the endpoints that take it before rolling workers back to such an
   image; and until the web rollout ends, an old web server answers Settings → Webhooks with an
   error for a company with an endpoint taking it, so add it to endpoints once the rollout ends and
   turn it off before rolling web servers back.

   Migration 0282 (ADR-359) adds `campaign_skip_reasons` to `app.webhook_endpoints`, its check
   validated by reading the table, and replaces `app.capture_campaign_recipient_skips` (0280) with
   the same signature; every endpoint starts without the list. Web servers of this release need it,
   as their reads of endpoints name the column; workers do not read it. Web servers from before it
   neither show nor change the column: until the web rollout ends, an old server's change that
   drops `campaign.recipient_skipped` from an endpoint with a list fails on the check, its other
   changes keep the list, and its API refuses `campaignSkipReasons` (422) and leaves it out of the
   endpoints it answers.

   Migration 0283 (ADR-360) creates `ops.platform_ops_failure_reason_months` for the platform role
   (owned by the definer role, granted before it is handed over); no table changes. Web servers of
   this release need it; web servers from before it never call it, and workers do not.

   Migration 0284 (ADR-361) adds `cart_reminders` to `app.webhook_endpoints`, its check validated
   by reading the table, and replaces `app.capture_webhook_event` with the same signature (keeping
   0278's filters); every endpoint starts without the list. Web servers of this release need it, as
   their reads of endpoints name the column; workers do not read it. Web servers from before it
   neither show nor change the column: until the web rollout ends, an old server's change that
   drops both cart reminder events from an endpoint with a list fails on the check, its other
   changes keep the list, and its API refuses `cartReminders` (422) and leaves it out of the
   endpoints it answers.

   Migration 0285 (ADR-362, ADR-364) creates `ops.platform_ops_failure_company_months` for the
   platform role (owned by the definer role, granted before it is handed over), each row with its
   companies' sends; no table changes. Web servers of this release need it; web servers from before
   it never call it, and workers do not.

   Migration 0286 (ADR-366) lets `app.webhook_endpoints.oauth_client_auth` hold
   `client_secret_jwt`, its check replaced and validated by reading the table. Workers roll out
   before web servers, and only web servers of this release can choose it, so every worker signs
   JWTs once a client asks for it; a worker from before it sends such a client's secret in an HTTP
   Basic header, which its server may take or refuse (a refusal is retried as usual), so set those
   clients back to another way before rolling workers back to such an image. Until the web rollout ends, an old web server that
   rotates such a client's secret keeps the method without the 32-byte check; a worker then asks
   nothing for it and records `oauth_token_secret_too_short` until the secret is set again.

   Migration 0287 (ADR-367) adds `oauth_private_key_ciphertext` and `oauth_public_key` to
   `app.webhook_endpoints` (nullable, no rewrite) with their update grant, lets `oauth_client_auth`
   hold `private_key_jwt`, replaces the OAuth check so a key pair goes only with that way and a
   secret with the others (both checks validated by reading the table, at most 10 endpoints a
   company), and replaces `ops.sealed_value_keys` so the keyring sweep re-encrypts the private keys.
   Workers roll out before web servers and only web servers of this release can choose the way, so
   every worker signs with the key once a client has one. A worker from before it sees no secret for
   such a client and sends its deliveries without a token, which the receiver refuses (retried as
   usual), so set those clients to another way before rolling workers back to such an image. Until
   the web rollout ends, an old web server shows such a client as if it used HTTP Basic and cannot
   change or remove it: a change asks for a secret and writes it beside the key pair, and a removal
   leaves the key pair, and the check refuses both (a server error), so nothing is stored.

   Migration 0288 (ADR-368) adds `oauth_next_private_key_ciphertext` and `oauth_next_public_key`
   to `app.webhook_endpoints` (nullable, no rewrite) with their update grant and a check that keeps
   a next key pair only beside a `private_key_jwt` client's pair in use, its two columns together
   (validated by reading the table, at most 10 endpoints a company), and replaces
   `ops.sealed_value_keys` so the keyring sweep re-encrypts the next private keys. Deliveries never
   read the columns; a worker from before it leaves the next private keys out of its keyring sweep
   (it does not know the kind) until workers of this release run. Web servers of this release need
   them, as their reads of endpoints name them. Until the web rollout ends, an old web server
   neither shows nor changes a next key pair, and its API refuses `nextKey` and `nextKeyId` (422):
   its changes that keep the way keep the next pair, but moving such a client to another way or
   removing its OAuth client leaves the next pair behind, which the check refuses (a server error),
   so nothing is stored. Drop next key pairs (`nextKey: "drop"`) before rolling web servers back to
   an image from before it, or such changes keep failing there.

   Migration 0289 (ADR-369) adds `oauth_assertion_audience` to `app.webhook_endpoints` (nullable,
   no rewrite) with its update grant and a check that keeps it an https URL of 9 to 2,048
   characters, only with a token URL and a way that signs JWTs (validated by reading the table, at
   most 10 endpoints a company). Workers of this release read it to name it in each assertion, and
   web servers of this release, which alone can set it, read and write it. Workers roll out first;
   a worker from before it names the token URL instead, which a server wanting another audience
   refuses (retried as usual), so clear audiences before rolling workers back to such an image.
   Until the web rollout ends, an old web server neither shows nor changes an audience, and its API
   refuses `assertionAudience` (422): its changes that keep a way that signs JWTs keep the audience,
   but moving such a client to another way or removing its OAuth client leaves the audience behind,
   which the check refuses (a server error), so nothing is stored. Clear audiences before rolling web
   servers back to an image from before it, or such changes keep failing there.

   Migration 0290 (ADR-370) adds `oauth_jwks_id` to `app.webhook_endpoints` (nullable, no rewrite)
   with its update grant, a unique constraint (its index is built under the table's lock, quickly:
   at most 10 endpoints a company) and a check that keeps it 16 base32 letters, only with
   `private_key_jwt` and a key pair in use (validated by reading the table), and creates
   `ops.webhook_oauth_jwks`, owned by the definer. There is no backfill: a client set to the way
   before it gets its JWKS URL at its next change. Workers never read the column. Web servers of
   this release read it (their reads of endpoints name it) and serve the URLs. Until the web
   rollout ends, an old web server neither shows nor serves them (it answers 404); its changes that
   keep the way keep the id, but moving such a client to another way or removing its OAuth client
   leaves the id behind, which the check refuses (a server error), so nothing is stored. Rolled back
   to an image from before it, the URLs answer 404 and such changes keep failing there; companies
   whose servers fetch the URLs register the public keys by hand meanwhile.

   Migration 0291 (ADR-371) adds `oauth_key_algorithm` and `oauth_next_key_algorithm` to
   `app.webhook_endpoints` (nullable, no rewrite) with their update grant and a check that keeps
   each one of RS256, PS256 or ES256, only beside its public key (validated by reading the table, at
   most 10 endpoints a company), and replaces `ops.webhook_oauth_jwks` (dropped as the definer and
   created again, its two public key columns kept) to return each key's algorithm too. Null reads as
   RS256, so pairs made before it sign as they did. Workers roll out first: a worker from before it
   opens only RSA keys and signs RS256, so an ES256 pair fails its deliveries (`payload_failed`,
   stage `oauth`) and a PS256 pair's tokens are refused by its server (retried as usual). Only web
   servers of this release offer the algorithm; until the web rollout ends, make no PS256 or ES256
   pair: an old web server shows a PS256 key as RS256's and fails to show an EC key (a server error,
   on its settings list, its API answers and its JWKS route), and a pair it makes leaves the
   algorithm column as it was, which a new worker then refuses for a key of another kind. Move
   clients to RS256 pairs before rolling web servers back to an image from before it.

   Migration 0292 (ADR-372) adds `oauth_certificate` and `oauth_next_certificate` to
   `app.webhook_endpoints` (nullable, no rewrite) with their update grant and a check keeping each
   one, of 1 to 4,000 characters, only beside its public key (validated by reading the table), and
   replaces `ops.webhook_oauth_jwks` (dropped as the definer and created again) to return them too.
   Workers roll out first: a worker from before it names no certificate and sends no `nbf`, so a
   server that finds certificates by thumbprint refuses its assertions (retried as usual). Until the
   web rollout ends, ask for no certificate: an old web server neither shows nor serves one, and a
   pair it makes leaves the certificate column as it was, which the new worker then refuses as a
   certificate of another key. Remove certificates (a new key pair without one) before rolling web
   servers back to an image from before it.

   Migration 0293 (ADR-373) creates `app.crm_deal_fields` (row security, its tenant deletion step
   and definer policies), adds `attributes` to `app.crm_deals` (jsonb, default `{}`, no rewrite)
   with a check of an object of at most 16 KiB and its update grant, and replaces
   `app.erase_contact` (as 0145 left it) to clear the erased contact's deals' values, whichever
   image calls it. It is additive: old web servers neither show nor write values, and their deal
   updates leave `attributes` as it is. Rolling an image back leaves the table and column in place,
   unused.

   Migration 0294 (ADR-375) creates `app.crm_deal_items` (row security, composite keys to deals,
   catalog products and memberships, `SELECT, INSERT, DELETE` for the app, its tenant deletion
   step 295 and definer policies). It is additive: old web servers neither show nor write items.
   Rolling an image back leaves the table in place, unused.

   Migration 0295 (ADR-376) creates `app.report_email_subscriptions` (row security, a composite
   key to memberships, column-limited updates for the app, tenant deletion step 175 and definer
   policies) and `ops.due_report_email_companies` (SECURITY DEFINER, executable by the app role
   only). The migration command also creates the `report.email` queue. It is additive: old workers
   neither signal nor consume the queue, so choices made meanwhile wait (an email over 72 hours
   late is skipped for the next period's), and old web servers do not show the choice. Rolling an
   image back leaves the table and queue in place, unused.

   Migration 0296 (ADR-377) adds `app.teams.first_response_target_minutes` (null for every team, so
   nothing changes until a team sets one), replaces `ops.overdue_reply_turns` (dropped by
   w360_definer and created again with the same grants) and adds two metric definition versions.
   Old web servers neither show nor write team targets; old workers' sweeps read the replaced
   function, which still answers the companies' turns with a target. Rolling an image back leaves
   the column, function and definitions in place: an older release ignores team targets.

   Migration 0297 (ADR-378) lets `app.crm_deal_items.created_by_membership_id` be null and adds
   `created_by_api_key_id`, with a foreign key to the company's keys and a check that exactly one of
   the two is set, both NOT VALID so the table is not read under the migration's lock; 0298
   validates them without blocking writes. It is additive: old web servers still add items as
   members and do not serve the new endpoints. Rolling an image back leaves the column in place;
   items keys added stay on their deals and show on the deal page.

   ADR-382 has no migration. Safari's and iOS's players ask for a recording or a video in parts,
   and each part is downloaded from Meta from the file's start, so playing one makes several
   requests to Graph and to Meta's media host; a proxy in front of the web tier must pass `Range`
   headers and 206 answers through. Until the web rollout ends, an old web server answers a range
   request with the whole file, as before.

   Migration 0299 (ADR-383) replaces the check on `app.webhook_endpoints.run_step_node_types` with
   one that also accepts `send_products` (1 to 19 kinds): every list it allowed is still allowed,
   and the table is small, so the check is validated at once. A worker of the previous release
   cannot read a published version with a products step and would fail its runs as unreadable, so
   roll the workers out first; an old web server opens such a draft with the starter steps, so do
   not edit automations with products steps until the web rollout ends. Rolling an image back
   leaves the wider check in place. An endpoint whose list was set through the API to all 18 earlier
   kinds (which ADR-328 made equal to null) keeps that list, so it does not receive products steps:
   tell its company to tick "Send products" in Settings → Webhooks, or set the list to null. Until
   the web rollout ends, an old web server refuses to save an endpoint whose list names products
   steps, in Settings and through the API ("Choose kinds of step from the list.").

   Migration 0300 (ADR-384) adds the automatic reply's four columns to `app.messaging_settings`
   (off for every company, constant defaults, so the table is not rewritten; the new checks are
   validated at once on its one row per company), creates `app.slow_reply_messages` (row security,
   composite keys to reply turns and messages, a guard trigger, deletion step 326) and the sweep
   function `ops.slow_reply_turns` (SECURITY DEFINER, owned by w360_definer, executable by w360_app
   only). Nothing is sent until a company turns the reply on. Old web servers neither show nor save
   the setting; old workers do not run the sweep, so a company that turns it on during the rollout
   gets its first automatic replies once the new workers run (only for waits that started after it
   was turned on, at most an hour late, otherwise skipped as `too_late`). Old workers send a queued
   automatic reply without the send-time consent check, which the new sweep already made when it
   queued it. Rolling an image back leaves the columns, table and function in place, unused.

   Migration 0301 (ADR-385) adds `app.crm_deal_fields.options` (null for every existing field),
   replaces the type check with one that also accepts `choice`, and adds a check on the options'
   shape; the table holds at most 50 rows a company, so both checks are validated at once. It is
   additive: old web servers neither offer nor change choice fields, and they cannot check a choice
   value: a deal form, an import or an API request that gives one a value fails with an internal
   error and stores nothing (so does saving, on an old server's deal page, a deal that has a choice
   value). Create choice fields only after the web rollout ends. Rolling an image back leaves the
   column and checks in place; an older release then fails the same way for deals with choice
   values until the choice fields are deleted.

   Migration 0302 (ADR-386) replaces the check on `app.webhook_endpoints.run_step_node_types` with
   one that also accepts `update_deal_fields` (1 to 20 kinds), as 0299 did for products steps:
   every list it allowed is still allowed, and the table is small, so the check is validated at
   once. A worker of the previous release cannot read a published version with a step that sets
   deal fields and would fail its runs as unreadable, so roll the workers out first and publish such
   automations only after the worker rollout ends; an old web server opens such a draft with the
   starter steps, so do not edit automations with these steps until the web rollout ends. Rolling an
   image back leaves the wider check in place. An endpoint whose list was set through the API to all
   19 earlier kinds keeps that list, so it does not receive these steps: tell its company to tick
   "Update deal fields" in Settings → Webhooks, or set the list to null. Until the web rollout ends,
   an old web server refuses to save an endpoint whose list names these steps ("Choose kinds of step
   from the list.").

   ADR-387 has no migration. Until the web rollout ends, an old web server treats a deals file as
   before: it ignores the deal id, status and lost reason columns and adds a deal for every row
   with a phone number and a title, so a deals export imported there would add its deals again.
   The new import page checks rows and imports through server actions an old server does not have
   (`checkDealImportAction`, `importCheckedDealsAction`), so its requests fail there with nothing
   written; an import page opened before the rollout fails on a new server the same way and needs a
   reload. Import files with deal ids only after the web rollout ends. Deal files are now limited
   to 928,000 bytes (was 976,000). Rolling an image back restores the earlier import.

   Migration 0304 (ADR-388) gives the alerts' chat channel a format:
   `ops.platform_alert_channel.format` (`text` for the channel already set, checked against `text`
   and `teams_card`, written only by the definer role) and `ops.platform_alert_posts.plain_body`
   (a post's text unescaped, null for every post already queued). It adds
   `ops.platform_set_alert_channel` with a format (five arguments),
   `ops.platform_set_alert_channel_format`, `ops.platform_test_alert_channel` and
   `ops.queue_platform_alert_post` with the unescaped text (three arguments) and
   `ops.claim_platform_alert_posts(integer, text[])`, which claims posts only while the channel's
   format is among those the worker names and returns each post's unescaped text and the format;
   `ops.platform_alert_channel_state` returns the format as one more column. The functions of the
   release before keep their signatures: setting a channel through the four-argument one sets the
   `text` format, the two-argument test and queue store the escaped text only, and the
   one-argument claim now hands out posts only while the format is `text`, with the columns it
   always returned. So, during the rollout: workers from before it keep sending JSON text exactly
   as before and are never handed a Teams channel's posts; workers of this release render each post
   in the channel's format, a post queued without unescaped text (before 0304, or by an old worker)
   sent as it was queued in `text` and unescaped for a card; web servers from before it show and
   change the channel without the format, an address they set taking `text`, and send test posts
   with the escaped text only. Roll out workers before web as usual and choose the Teams format only
   once no worker from before it runs: until then a Teams channel's posts wait (unclaimed, their
   attempts untouched) for a worker of this release. After a rollback of the workers with a Teams
   channel set, its posts wait the same way and are sent when this release returns; set the format
   back to JSON text (from a web server of this release, or by replacing the address from an old
   one) to have old workers send them as text. The columns stay in the database unused by older
   releases.

   Migration 0303 (ADR-389) adds `app.team_business_hours` (empty, so every team keeps the
   company's hours until one is given its own), its row security and grants, deletion step 655, an
   `AFTER UPDATE OF team_id` trigger on `app.conversations` that plans waiting automatic replies and
   overdue notices of the moved conversation again, and three metric definition versions. No
   definer function changes. Roll out workers before web: an old worker's sweeps count every
   conversation in the company's hours, so a team's own week would be ignored by overdue emails and
   automatic replies until the worker rollout ends; old web servers neither show nor write team
   hours, and `PATCH /teams` with `businessHours` is refused as an unknown field there. Give teams
   their own hours only after both rollouts end. Rolling an image back leaves the table, trigger and
   definitions in place: an older release ignores team hours (the trigger only moves due times of
   waiting rows earlier, which an older sweep simply plans again).

   Migration 0307 (ADR-392) adds `app.teams.own_closed_days` (false, so every team keeps the
   company's closed days until one is given its own list), a column grant on it, the table
   `app.team_closed_days` (empty) with its row security and grants, deletion step 656 and three
   metric definition versions. No function changes. Roll out workers before web: an old worker's
   sweeps count every team's conversations by the company's closed days, so a team's own list would
   be ignored by overdue emails and automatic replies until the worker rollout ends; old web
   servers neither show nor write a team's closed days (an old server's save of a team in Settings
   leaves its list as it is, as it never names the column), and `POST`/`PATCH /teams` with
   `closedDays` is refused as an unknown field there. Give teams their own closed days only after
   both rollouts end. Rolling an image back leaves the column, table and definitions in place: an
   older release ignores them and counts every team by the company's closed days again.

   Migration 0305 (ADR-390) replaces the deal capture function in place and widens its trigger and
   the changer trigger to `crm_deals.attributes`, so `deal.updated` names custom field value
   changes (`fields`, with `changedFields`) from the moment it runs, whichever release made the
   change. It widens `webhook_events.detail`'s size check to 4,096 bytes (NOT VALID, so the table
   is not read under the brief lock; 0306 validates it while captures go on) and the endpoints'
   `deal_details` check to accept `fields` (validated at once: at most 10 endpoints per company),
   and grants the definer role `SELECT (key, created_at)` on `app.crm_deal_fields` with a policy for
   the company in scope (erasure's capture). Workers from before it render such an event with
   `changes` leaving out `fields` (an empty list for a change of values alone, which the payload's
   description does not allow) and without `changedFields`: roll workers out promptly after the
   migration, and replay the deliveries an old worker made in between (on the endpoint's page in
   Settings → Webhooks, or `POST /webhook-deliveries/{id}/replay`; a replay is built by the worker
   that sends it) if a receiver relies on them; rolling workers back does the same. Web servers from
   before it neither offer nor read `fields`
   in an endpoint's deal details: until the web rollout ends, an old server shows such a list with
   an empty label and refuses to save that endpoint ("Choose deal details from the list."), and
   gives no `fields` in the API's deal history. Endpoints whose deal details list was saved before
   keep it, so they do not take a change of values alone until `fields` is added. Rolling back
   leaves the trigger, which old code does not need to know about; events keep their details.

   ADR-395 adds no migration. Workers build each payload when they deliver it: until the worker
   rollout ends, a deal event delivered by a worker from before it has no `deal.items` (a retry or a
   replay a newer worker delivers has them, read when it is sent), and rolling workers back to an
   image from before it does the same. The worker rollout also carries webhook deliveries' own
   egress client, which sends bodies up to 256 KiB (every other caller keeps 64 KiB); an old worker
   builds deal bodies without items, which its 64 KiB fits, so the two limits never meet one body.
   Rolling workers back restores both the 64 KiB limit and the bodies it fits. Until the web
   rollout ends, an old server's OpenAPI document does not describe `deal.items`. The worker reads
   `app.crm_deal_items`, `app.commerce_products` and `app.commerce_catalogs` as `w360_app`, which
   already holds `SELECT` on them (0018, 0294). The webhook client has a lookup budget of its own
   (two system lookups at once), so a worker process may have 8 in progress across its four
   clients (6 before).

   ADR-397 part one adds no migration. Its workers render `items` among a `deal.updated`'s
   `changes` (no event names it yet), its web servers record the member or key on the deal before
   adding or removing a product, and its API's deal history gives changes of products as `items`.
   Deploy it everywhere, every worker and web server, before the release carrying migration 0308
   (ADR-397 part two): that migration starts capturing those events, which a worker from before
   part one would send with `changes` empty and which, for removals made through a web server from
   before it, would name nobody. While 0308 is not applied, rolling this release back is safe; an
   old web server's history simply leaves changes of products out again.

   Migration 0308 (ADR-397 part two) adds a trigger on `app.crm_deal_items` and its capture
   function, so each product added to or removed from a deal sends `deal.updated` naming `items`
   from the moment it runs, and replaces the endpoints' `deal_details` check to accept `items`
   (validated at once: at most 10 endpoints per company). It adds no table, column, policy or grant,
   and leaves nothing to validate later. It is backward compatible with part one's workers and web
   servers (above), so the usual order is safe: the migration, then workers, then web servers. Part
   one's workers already render `items`, and its web servers record the member or key on the deal
   before removing a product, so every removal names its maker. Until the web rollout ends, a web
   server of part one neither offers "Products" among an endpoint's deal details nor saves an
   endpoint whose list holds `items` ("Choose deal details from the list."), and its OpenAPI
   document still says that no event is sent. Endpoints whose deal details list was saved before
   keep it, so they do not take a change of products until `items` is added.

   Rolling back to part one leaves the trigger, which part one's workers and web servers were built
   for. Rolling back past part one while 0308 is applied brings back what the split avoids: a worker
   from before part one sends these events with `changes` empty (it keeps only the details it
   knows), which the payload's description does not allow, and a product removed through a web
   server from before part one is captured with nobody as its maker (`changedBy` null), which
   endpoints naming makers or leaving out keys let through. So before redeploying a worker or web
   image from before part one, drop the trigger first in a forward-repair migration (step 5):
   `DROP TRIGGER crm_deal_items_webhook ON app.crm_deal_items` (the function can stay; only the
   trigger calls it). Products then change without an event, as before ADR-397, and a later
   migration creates the trigger again once part one runs everywhere. Deliveries a worker from
   before part one made with `changes` empty can be replayed once the workers are updated (on the
   endpoint's page in Settings → Webhooks, or `POST /webhook-deliveries/{id}/replay`; a replay is
   built by the worker that sends it), though a receiver that deduplicates on the event id ignores
   the replay.

   Migration 0309 (ADR-398) adds two nullable columns to `app.channel_accounts`:
   `messaging_limit` (1 to 64 characters, checked) and `messaging_limit_checked_at` (a limit only
   with it, checked), with column grants (`UPDATE` for the runtime role, `SELECT` for the platform
   role). Expand only and backward compatible: nothing is rewritten, both checks are validated at
   once (every row is null), no function changes, and web servers and workers of the release
   before never name the columns. Roll out workers before web as usual: until the worker rollout
   ends, a number whose health an old worker reads keeps the limit read before (or none), and old
   web servers show no limit. Numbers already active before this release show no limit (not "not
   reported") until their health is read again: when their account is reconnected after Meta
   stopped accepting its access, or when the number is connected again, which registers it again
   (Meta counts registrations; do not do it only for this). Retry setup does not apply to active
   numbers, and nothing reads them in bulk. A worker of this release asks Meta for
   `whatsapp_business_manager_messaging_limit` with every health read; when Graph refuses that read
   as permanent or as lost access (any code), it reads the health once more without the field (one
   request more) and handles only that read's failure as one, so a refusal of the field alone does
   not block setup or ask for a reconnect; retryable failures are retried as before. Check
   META-SETUP's messaging limit item on a real number before relying on the line.
   Rolling an image back leaves the columns in place and unused; a number whose health an older
   worker reads meanwhile shows, once this release returns, the limit read before beside the later
   "Checked" time.

   Migration 0311 (ADR-401) adds `app.automation_enrollments` and
   `app.automation_enrollment_contacts` (forced row security, grants, deletion steps 685 and 692),
   the nullable column `app.automation_runs.enrollment_id` with its foreign key, replaces the run
   check `automation_runs_api_key` (a key or an enrolment, exactly one, on an `api` run) and the run
   guard, and adds the sweep's due list `ops.automation_enrollments_due` (SECURITY DEFINER, pinned
   search path, executable by the runtime role only, reading running enrolments through a policy of
   their own). The check and the foreign key are added `NOT VALID`, so the migration holds the runs
   table's lock only briefly and reads none of it. Expand only and backward compatible: web servers
   and workers of the release before never name the new column or tables, and their API starts write
   runs the new check allows. The new queue `automation.enroll` is declared by the migration command
   with the others. Roll out workers before web as usual: an enrolment is started only by a web
   server of this release, and its first job waits in the queue until a worker of this release takes
   it. To roll back the application past this release, stop the running enrolments first (their jobs
   would otherwise wait unconsumed); the tables, column and function can stay.

   Migration 0312 (ADR-401) validates the check and the foreign key 0311 added `NOT VALID`, as 0054
   validated 0052's. Validation reads `app.automation_runs` without blocking writes; every row
   written since 0311 was checked when written, and the rows before it have no enrolment, so it
   cannot fail on them. It runs in the same deployment, after 0311.

   Migration 0313 (ADR-402) adds `app.channel_accounts.facts_attempted_at` (nullable, no default),
   with `UPDATE` on it for the runtime role only. Expand only and backward compatible: nothing is
   rewritten, no function or policy changes, and web servers and workers of the release before
   never name the column. Roll out workers before web as usual. From the first worker of this
   release, each healthy daily access check also reads the account's active numbers whose facts
   are 20 hours old or more (one or two `GET /{phone-number-id}` each, paced, at most 40 seconds a
   job), so the first day reads every active number once, numbers active before 0309 included;
   expect that many more Graph requests that day. Rolling an image back leaves the column in place
   and unused, and an older worker stops the refresh.

   Migration 0314 (ADR-401) builds `automation_runs_enrollment_idx` on
   `app.automation_runs (tenant_id, enrollment_id) WHERE enrollment_id IS NOT NULL` with
   `CREATE INDEX CONCURRENTLY` (`-- migrate:no-transaction`, as 0053), after 0311 and 0312, so runs
   keep being read and written while it is built. It serves the foreign key's check when company
   deletion removes enrolments (step 692); until it exists that check falls back to an index on the
   company's runs. If it fails, an INVALID index can remain: run
   `DROP INDEX CONCURRENTLY IF EXISTS app.automation_runs_enrollment_idx;` and the migrations again
   (RUNBOOKS).

   Migration 0315 (ADR-403) lets API keys start and stop enrolments: on
   `app.automation_enrollments` it makes the member columns nullable, adds `created_by_api_key_id`
   and `stopped_by_api_key_id` (composite foreign keys to `app.api_keys`, each with a partial index
   for company deletion's key step), a check that exactly one of member and key started it, and
   replaces the end check (five new reasons: `stopped_by_api`, `api_key_revoked`,
   `api_key_expired`, `api_not_in_plan`, `api_scope_missing`) and the stopper check (now also
   holding a running enrolment to naming nobody, `IS NOT DISTINCT FROM`). The table is small (one
   running enrolment per automation), so its checks are validated in place under a brief lock. The
   runtime role gets `UPDATE` on `stopped_by_api_key_id` only; nothing else changes (deletion steps,
   the due list and the export already cover the table; the export lists the new columns). Roll out
   workers before web: a worker of the release before would read a key's enrolment as one whose
   member left and end it (`member_removed`), and only a web server of this release starts one. To
   roll the application back past this release, stop the running enrolments keys started first
   (`SELECT id FROM app.automation_enrollments WHERE status = 'running' AND created_by_api_key_id
IS NOT NULL`); the columns and checks can stay.
   Enrolments that already ended with the new reasons (`stopped_by_api`, `api_key_revoked`,
   `api_key_expired`, `api_not_in_plan`, `api_scope_missing`) stay as they are, and the older
   release's enrolment page shows their reason blank or as "undefined"; this release's page shows
   a reason it has no label for as its code. Adding the two foreign keys briefly takes
   `SHARE ROW EXCLUSIVE` on `app.api_keys`, which holds key authentication's `last_used_at` update
   (and so API requests) until the migration commits; it reads only the small enrolments table.

   Migration 0316 (ADR-404) adds eight nullable columns for an edit of a template Meta has to
   `app.message_templates` (`edit_id`, `edit_state`, `edit_components`, `edit_error`,
   `edit_requested_at`, `edit_requested_by_user_id`, `edit_attempted_at`, `edit_failed_at`) with
   their checks, `UPDATE` on them for the runtime role and `SELECT` on `edit_state` and
   `edit_failed_at` for the definer; replaces `template_status_events`' source check to also take
   `edit` (validated in the migration, a short scan of an append-only table under the lock the
   replacement takes); and recreates `ops.template_sync_due` so an account with an edit sending is
   synced every 5 minutes (and one whose edit failed, for an hour after it failed). Expand only and
   backward compatible: nothing is rewritten, and the release before never names the columns. The
   migration runner declares the new `template.edit` queue. Roll out workers before web as usual: a web server of this release queues `template.edit` jobs, which
   only a worker of this release consumes (a job queued before then waits for it, and an edit whose
   job waits more than 10 minutes is called unconfirmed by the sync and can be sent again). Rolling
   back leaves the columns unused; an edit left `sending` stays so until a worker of this release
   returns, and meanwhile keeps its account due for a template sync every 5 minutes (the recreated
   `ops.template_sync_due` stays), spending Meta's management allowance. To stop that after a
   rollback, settle such edits as failed. The table has forced row security and the owner role has
   no policy on it, so an `UPDATE` as the owner changes nothing. `w360_definer` cannot log in:
   connected as `w360_owner`, run `SET ROLE w360_definer;` and list the companies with
   `SELECT DISTINCT tenant_id FROM app.message_templates WHERE edit_state = 'sending';` (the definer
   reads those columns under its read policy), then `RESET ROLE;`. Then, connected with the runtime
   role's own credentials (`w360_app`, as the web app connects), run for each company in its own
   transaction:

   ```sql
   BEGIN;
   SELECT set_config('app.tenant_id', '<company id>', true);
   UPDATE app.message_templates
      SET edit_state = 'failed', edit_failed_at = now(),
          edit_error = 'Not sent: HyFib was rolled back. Send the edit again.'
    WHERE edit_state = 'sending';
   COMMIT;
   ```

   Members can send them again once the release returns.

   Migration 0317 (ADR-405) first adds the column `app.campaign_recipients.variant` (`NOT NULL
DEFAULT 'A'`, a constant default, so nothing is rewritten) with its check added `NOT VALID`, so
   the recipients table is not read under the migration's lock, then creates
   `app.campaign_variants` (forced row security, `UNIQUE (tenant_id, id)`, composite foreign keys to
   the company's campaigns and templates, grants to the runtime role, deletion step 705). The
   recipients are altered before the new table's foreign key locks the campaigns, the order in which
   a runner tick takes them. The runtime role gets no `UPDATE` on the column. Expand only and
   backward compatible: web servers and workers of the release before never name the table or the
   column, and their snapshots write `A` by default. Roll out workers before web as usual, and let
   members use variants only after the web rollout completes: an older worker still running would
   send every recipient of a campaign with variant B variant A's template, and an older web server
   that submits a draft with variant B gives every recipient variant A. Such a campaign cannot get
   stuck: a variant with no pending recipients is never checked (so a B that got none is ignored),
   and it simply sends A to everyone. Rolling an image back after campaigns with variant B were
   submitted would send A's template to those still sending: pause them first. The table and
   column can stay.

   Migration 0318 (ADR-405) validates the check 0317 added `NOT VALID`, as 0312 validated 0311's.
   Validation reads `app.campaign_recipients` without blocking writes; every row written since 0317
   was checked when written and older rows hold the default, so it cannot fail on them. It runs in
   the same deployment, after 0317.

   Migration 0319 (ADR-406) adds `app.automation_http_calls.dropped_values` (jsonb, default `{}`,
   no table rewrite) with a check and `UPDATE` on it for the runtime role, and replaces the call's
   guard function with the same body plus the column among what a finished call keeps. Workers of
   the release before never name the column. Order matters for HTTP steps' saved value sources:
   apply 0319, then roll out **workers first**, then web servers. That forward order is safe.
   Rolling **workers** back once any graph uses `from` (a header, body text or status source) is
   not: the older `graphSchema` refuses those pinned versions, so their runs fail, and an older
   worker's `savedValuesFrom` throws a TypeError after the request was sent, so the call stays
   `in_flight` and becomes `unknown` at its run's deadline. Rolling **web servers** back makes such
   drafts fail to parse in the editor and at publishing. Before rolling either back, check for
   graphs with a source: `SELECT count(*) FROM app.automations WHERE
jsonb_path_exists(draft_graph, '$.nodes[*].save[*].from')`, and the same on
   `app.automation_versions.graph`.

   Migration 0320 (ADR-407) adds `app.contact_fields.options` (null for every existing field),
   replaces the type check with one that also accepts `choice`, adds a check on the options' shape
   (0301's, for contact fields) and grants the runtime role `UPDATE (options)`; the table holds at
   most 50 rows a company, so both checks are validated at once, under the migration's brief lock on
   the table. It is additive: old web servers and workers neither offer nor change choice fields,
   and they cannot read a choice field at all: a contact form, an import, a bulk edit, an API
   request, an automation step or a Flow answer that gives one a value fails with an internal error
   (or, in a run, a failed step) and stores nothing; saving or previewing a segment that names a
   choice field, a campaign's checks and send of such a segment, the API's segments and contact
   searches naming one, and `GET /contacts?fields[<key>]=…` for one all answer 500 (old code has no
   comparisons for the type). Create choice fields only after both the worker and the web rollouts
   end. Every write of contact field values now takes the company's contact-field advisory lock
   shared (`contact-fields:<company id>`, the key additions already took) and locks the rows of the
   fields it writes `FOR SHARE`; merges lock every field row. What can wait: adding a field or
   changing options waits for every write of values in progress (an import of up to 5,000 rows or a
   bulk edit of up to 10,000 contacts runs in one transaction), and writes wait for it; renaming a
   field waits for the writes of that field and for merges; deleting a field waits for those and for
   any transaction holding a contact that has a value of it (an import or a bulk edit over that
   contact), and later writes of that field wait behind it. Writers of values wait on each other's
   contact row locks, as before. An import with "update existing contacts" now locks every existing
   contact the file names in id order for its whole transaction (up to 5,000, unchanged ones
   included): `FOR NO KEY UPDATE`, or `FOR UPDATE` when it adds tags. Members' and keys' changes of
   those contacts, automation steps that set a field or create a deal, Flow answers and a first name
   from WhatsApp wait for it; automation steps' key share locks and foreign key checks (an inbound
   message's conversation, tags, consent events) wait only for an import that adds tags. Bulk field
   edits lock their contacts `FOR NO KEY UPDATE` too (bulk tag edits keep `FOR UPDATE`). Rare
   deadlocks remain between the API's many-contact calls, bulk tag edits or imports that add tags,
   automation steps and a field's deletion, and around imports and Flow answers during a deletion;
   PostgreSQL detects them and the failed request, step or inbound change is retried (ADR-407). Do
   deletions in quiet hours on busy companies. Rolling an image back leaves the column, checks and
   grant in place; an older release then fails the same way for choice values, and every segment,
   campaign and API filter naming a choice field fails with 500s, until the choice fields are
   deleted (which removes their values and leaves those segments refused as naming a field that does
   not exist).

   Migration 0323 (ADR-413, shipment messages) is expand only. It creates
   `app.commerce_store_shipments` (empty; tenant row security, grants), a trigger on
   `app.commerce_store_orders` that clears shipments' tracking when an order is redacted, and gives
   `app.commerce_store_messages` the null columns `shipment_id` and `dedupe_key` with
   `UNIQUE (tenant_id, shipment_id, event, dedupe_key)`. It replaces the event and subject checks of
   `app.commerce_store_messages`, the event and action checks of `app.commerce_store_message_rules`
   (validated: at most nine rows a store) and the `store_event` check of `app.automation_runs` with
   wider ones; every value the old checks allowed is still allowed. The two on the large tables are
   left `NOT VALID` (new and changed rows are checked; rows already there passed the narrower
   check), so the migration does not scan them under its lock. The unique key builds an index on
   `app.commerce_store_messages`, which blocks writes to it while it builds (order messages wait,
   nothing fails); on a large table apply it in a quiet hour. Locks: `ACCESS EXCLUSIVE` briefly on
   the three altered tables and `SHARE ROW EXCLUSIVE` on `app.commerce_store_orders` for the trigger.
   Rollout: apply 0323, then roll out workers and web as usual. A server of the release before
   ignores the new table and columns: shipment rules cannot be switched on from it, and it never
   writes a second message per order and event (shipment messages name no order). During the rollout
   an old web server showing a store's report could meet a shipment message's event and fail to
   render that page, so switch shipment rules on only after the web rollout ends. Rolling back an
   image leaves the table, trigger, columns and checks; older code then ignores them (shipment
   messages already waiting are never sent by older workers, which skip them as an order deleted).

   ADR-410 (campaigns that test up to five templates) has no migration: the labels B to Z, the
   shares of 10% to 90% in steps of 5, the unique label per campaign and the grants of 0317 already
   take variants C to E, and the recipients' check takes any label A to Z. It adds the web setting
   `CAMPAIGN_VARIANTS_MAX` (2 to 5, **2 when unset**): a web server lets a draft grow past two
   variants only up to it. Workers do not read it; they send, check and report any number of
   variants.

   Why the setting: a server of the release before (ADR-405, two variants) that meets a campaign
   with a variant C, D or E does the wrong thing. An older web server submitting such a draft reads
   variant B only, so C's contacts are given variant A and sent A's template (C's row is ignored);
   its review, campaign page and approval page show A and B only, so an approver would approve a
   template they never saw, and only A's and B's templates are checked; its results, the API's
   `variants` and the recipients list leave C out or report C's recipients as A. An older worker
   loads A and B only: a recipient recorded as C has no template there, so it is never sent (not
   sent the wrong template) and stays pending, a batch full of them stalls the campaign until a new
   worker takes it, and its `campaign.recipient_skipped` events name C's recipients as A. A release
   before ADR-405 ignores every variant, as DEPLOYMENT says for 0317. With the setting at 2 during
   the rollout no draft gets a third variant, so no older server can meet one; a new server with the
   setting at 2 behaves exactly as ADR-405 for two-variant campaigns and for those without
   variants, and reads, checks and sends a campaign that already has more correctly (it can edit or
   trim such a draft, never grow it).

   Rollout: deploy as usual (workers, then web) with `CAMPAIGN_VARIANTS_MAX` unset. Once every web
   server and worker runs this release (no image of the release before is left, including canaries
   and jobs that run web code), set `CAMPAIGN_VARIANTS_MAX=5` on the web servers and roll them
   again; servers still at 2 during that roll are of this release, so they read such drafts
   correctly.

   Rollback to an image without ADR-410. A campaign's labels C to E are recorded when it is
   submitted, so every campaign that has one, whatever its status, must be out of the older code's
   reach before the older image serves:

   1. Set `CAMPAIGN_VARIANTS_MAX=2` (or unset it) and roll the web servers, so no draft gets a
      third variant.
   2. List the campaigns that have one. The owner role cannot read them across companies (forced
      row security); connected with the runtime role's own credentials (`w360_app`, as the web app
      connects), run for each company in its own transaction:

      ```sql
      BEGIN;
      SELECT set_config('app.tenant_id', '<company id>', true);
      SELECT DISTINCT v.campaign_id, c.name, c.status
        FROM app.campaign_variants v
        JOIN app.campaigns c ON c.tenant_id = v.tenant_id AND c.id = v.campaign_id
       WHERE v.label > 'B'
         AND c.status IN ('draft', 'pending_approval', 'scheduled', 'running', 'paused');
      COMMIT;
      ```

   3. While the new release still serves, have each company (or support acting with its members)
      act on every one, in the app or through the API:
      - `pending_approval`: send it back (Reject; a key's submission can also be withdrawn), so it
        is a draft again. An older web server would approve it checking A's and B's templates only,
        showing the approver two of its templates.
      - `scheduled`, `running` and `paused`: cancel it. **A pause is not enough:** a member can
        resume a paused campaign on an older web server, which checks A's and B's templates only,
        and an older worker would then leave C to E's recipients pending for good and report them
        as A. A cancel (or a return to draft) ends that.
      - `draft`: trim it to two variants, or leave it unsubmitted until the release returns (an
        older web server would submit it as A and B, C's contacts getting A's template).
   4. Run the query again until it lists nothing but drafts left unsubmitted on purpose, then roll
      back.

   Rolling forward needs no step; raise the setting again once every server runs the release.

   Migration 0321 (ADR-411) creates `app.saved_reply_files` (a saved reply's file, its bytes in a
   `bytea` column, checked against its length and SHA-256) and `app.saved_reply_attachments` (which
   reply carries which file), both new and empty, with row security, grants (`SELECT`, `INSERT`,
   `DELETE`, no `UPDATE`) and the company deletion's steps 125 and 126. Nothing is rewritten:
   `app.saved_replies` is not altered, and the attachments' foreign key to it only takes a brief
   lock on it while the empty table is created. Workers do not use the tables. It is additive: web
   servers of the release before know nothing of files and keep listing, inserting and sending
   saved replies as text. Two things they do differently: deleting a reply removes its attachment
   row (the cascade) but leaves the file, which the next file a supervisor stores for the company
   deletes (no file stays without a reply for longer than that, and such files are exported); and
   changing the text of a reply that carries a photo, video or document past 1,024 characters is
   not refused, so a new server cuts the caption to 1,024 characters when the reply is inserted and
   says so. Apply 0321, then roll out web servers. There is no switch: supervisors can attach files
   as soon as the first new web server serves them, so while older ones still run, the two cases
   above can happen; both stay safe (no file is sent that a member did not review, and a leftover
   file is deleted later). Storage: files live in PostgreSQL (there is no object storage), at most
   16 MB each and 100 MB a company in all, so database size, backups and replicas grow with them;
   watch `pg_total_relation_size('app.saved_reply_files')` and its TOAST table. The column is
   stored uncompressed out of line (`STORAGE EXTERNAL`), so a range of a file reads only its own
   chunks. Memory per request on the web servers: node-postgres receives `bytea` as hex text (twice
   the bytes) and decodes it into a buffer, so reading a whole 16 MB file holds about 48 MB at its
   peak; that happens when a supervisor attaches a file (the posted body, up to 16 MB, plus the
   insert's hex text), when a member sends one (read, then uploaded to Meta from the same buffer),
   when an export writes one (plus its base64 text, about 21 MB) and when a preview is opened
   without a Range header. A Range request (what browsers' media players send) reads only its part.
   Nothing bounds how many such requests run at once beyond the web server's own concurrency, so
   size web memory for a few at a time. A company's export carries each file as base64 (about a
   third larger than the file), two files a page. Rolling an image
   back leaves the tables and grants in place; the older release ignores them, and the files stay
   until a release with ADR-411 deletes their replies or the company is deleted.

   Migration 0324 (ADR-414, automations started by replies to a campaign) runs in one transaction.
   It replaces `automation_runs_trigger_type_check` with one that also takes `campaign_reply`,
   `NOT VALID`, so `app.automation_runs` is not read under the migration's brief exclusive lock
   (every stored row passed the check it replaces, validated by 0054, whose values are a subset;
   the check stays unvalidated and nothing relies on `convalidated`). It creates the empty table
   `app.automation_run_campaigns` (row security forced, `SELECT` and `INSERT` for the runtime role,
   an update-rejecting trigger, deletion step 688), whose foreign keys take a brief lock on
   `app.automation_runs` and `app.campaigns` (no rows to check). No index is built on a large
   table: the reply lookup uses `messages_external_uq` and `campaign_recipients_message_uq`, which
   exist. No setting is added.

   Migration 0327 (ADR-414) replaces `webhook_endpoints_run_triggers` with one taking six
   triggers, `campaign_reply` among them, validated at once (at most 10 endpoints a company). It is
   a file and a transaction of its own because a run event's delivery reads
   `app.webhook_endpoints` before `app.automation_runs`: one transaction locking the runs (0324)
   and then the endpoints could deadlock with a delivery, so no transaction holds both. Both run in
   the same deployment, 0324 first; 0325 and 0326 belong to other changes and may run between them.

   Order: apply 0324 and 0327, roll out **workers first**, then web servers (the usual order), and publish
   automations started by replies to a campaign only once both rollouts end. A worker of the release
   before skips such automations when a reply arrives (it cannot parse the trigger), so nothing
   starts from it; but if a new worker started a run and an older worker took its next step, the
   older runner would send `{{campaign.name}}`, `{{campaign.variant}}` and `{{campaign.button}}`
   as written, not knowing them. Workers first avoids that during the rollout. Rolling **workers**
   back once such automations are published is not safe for the same reason: first pause them
   (Automations → the automation → Pause), listed for each company with the runtime role's own
   credentials, in its own transaction:

   ```sql
   BEGIN;
   SELECT set_config('app.tenant_id', '<company id>', true);
   SELECT a.id, a.name, a.status FROM app.automations a
     JOIN app.automation_versions v ON v.tenant_id = a.tenant_id AND v.id = a.active_version_id
    WHERE a.status = 'active' AND v.trigger ->> 'type' = 'campaign_reply';
   COMMIT;
   ```

   and let their running runs end (or stop them from the run pages). Webhook deliveries are built
   when they are sent, so a delivery of such a run still pending when workers are rolled back is
   built by the older payload code: `run.trigger` `campaign_reply`, a value its schema does not
   list, and no `run.campaign`. After the pause, wait until the endpoints that take run events
   have no pending delivery (an endpoint's Deliveries page lists them; run events are captured
   when a run starts or ends, so none are added once the runs ended), then roll back. An endpoint
   whose receiver must not see such a body can be disabled instead, which ends its pending
   deliveries unsent (`endpoint_disabled`). Rolling **web servers** back
   makes such drafts fail to parse in the editor (shown as an invalid trigger), and Settings →
   Webhooks of the release before shows an endpoint that chose `campaign_reply` with a blank label
   and refuses to save it until it is unticked. The table, the runs' check and the endpoints' check can stay
   after a rollback; older code never writes `campaign_reply`.

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

## Webhook OAuth JWKS URLs

`GET /api/webhook-oauth/jwks/<id>` (ADR-370) is public by design: authorization servers fetch a
webhook OAuth client's public keys from it, without a session. It answers public keys only.

- **`APP_BASE_URL` is registered at authorization servers.** Companies give the URL to their
  servers as a client's `jwks_uri`. Choose the production origin before the first company copies
  one; if it must change, keep redirecting `/api/webhook-oauth/jwks/*` from the old origin.
- **Caching.** The app sends `Cache-Control: public, max-age=300`, so the edge or a CDN may keep a
  set five minutes; purge it if a changed key must reach servers sooner. Do not keep it longer.
- **Rate limits.** Apply the per-address limits of the public routes above at the edge (the app does
  not limit it). Each request reads one row through a unique index.
- **Logs.** The app logs nothing per request. Access logs record the id and the server's address;
  the id names neither the company nor the endpoint.

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
   be listed, SH-003). Scopes: `read_orders,read_products,read_fulfillments`. HyFib fails a
   connection that is not granted `read_orders` and `read_products`; `read_fulfillments` (ADR-413,
   research SH-044) only lets it subscribe to Shopify's shipment webhooks, and a store works without
   it. If the Partner Dashboard asks for the app's access scopes, list all three (and
   `read_customers` as optional, step 9).
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
   are read with `read_orders` (research SH-030, SH-031), and the worker finds deliveries by
   reading orders in transit again every three hours. Shipment messages (ADR-413) also read
   shipments with the order; with `read_fulfillments` the store's webhook check subscribes
   `fulfillments/create` and `fulfillments/update` (SH-044), whose deliveries make HyFib read the
   order at once. Rollout: new connections ask for the scope from this release on; a store
   connected before keeps its token (no re-approval is forced, nothing breaks) and reads shipments
   as before until a manager allows shipment updates on its Order messages page, after which the
   same run subscribes the two topics. The six-hourly check creates only topics missing for HyFib's
   address, so it is safe to run any number of times, and a Shopify refusal of a shipment topic is
   shown on the store, not a failed sync. Before launch, on a development store: approve the new
   scope on an installed store, receive a `fulfillments/create` delivery and check its body has
   `order_id` (research SH-048). Each message is a `commerce.store-message` job scheduled for its send time
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
