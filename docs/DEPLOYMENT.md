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
