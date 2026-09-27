# Deployment

Last updated 2026-09-26. Nothing has been deployed to a shared environment yet; this document is the
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

## Production topology (target)

- Load balancer with TLS 1.2+ and HTTP/2 (SSE), WAF/rate limiting at the edge.
- `web` ≥ 2 replicas (stateless); `worker` ≥ 2 replicas (jobs are claim-safe; schedules are
  deduplicated by pg-boss).
- Managed PostgreSQL 17 or 18 with high availability, encryption at rest, automated backups and
  point-in-time recovery (target RPO 15 minutes, RTO 4 hours — goals subject to provider capability
  and a recorded restore drill).
- Private S3-compatible bucket (phase 2 media), SMTP provider, secret manager, OpenTelemetry
  collector/hosted backend.
- Region: India (`ap-south-1` or equivalent) for the initial launch; `tenants.data_region` records
  the region; other regions are separate deployments.
- Outbound network for the worker: Meta Graph, Razorpay and SMTP, plus HTTPS (443 or ports from 1024)
  to the domains companies allow for automation web requests. The egress guard already refuses
  private, loopback, link-local and metadata addresses and pins DNS (ADR-042); as a second layer,
  route that traffic through an egress proxy or firewall that denies private ranges and the cloud
  metadata endpoint. The web tier makes no such requests.

**Pilot option (lower cost):** single web and worker replicas and a single managed PostgreSQL
instance with PITR. Limitations: no redundancy during deploys or instance failure (brief downtime),
lower burst capacity. Acceptable only with customers informed of the availability target.

## Connection budgets

`DATABASE_POOL_MAX_APP` (default 10) + `DATABASE_POOL_MAX_AUTH` (5) + `DATABASE_POOL_MAX_PLATFORM` (2)

- pg-boss producer (2) per web replica; worker: app pool 10 + pg-boss `max(4, concurrency+2)`.
  Keep the sum across replicas below the database's `max_connections` minus 20% headroom. LISTEN
  connections (pg-boss notify, SSE hints) must connect directly, not through a transaction-mode pooler.

## First-time database setup

1. Create the database (provider console) and an administrative login.
2. Run `infra/db/bootstrap-roles.sql` once with passwords from the secret manager (PostgreSQL 16+
   required for `GRANT … WITH INHERIT FALSE, SET TRUE`).
3. Store the four role connection strings in the secret manager: migrate (owner), app, auth,
   platform. Web receives app/auth/platform; worker receives app/platform; only the migration job
   receives the owner string.

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
`TRUSTED_PROXIES` entry stops start-up.

## Razorpay

1. In the Razorpay Dashboard (test mode first, then live), create API keys and set
   `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` on web and worker. Live keys (`rzp_live_…`) are refused
   unless `APP_ENV=production`; `RAZORPAY_API_BASE_URL` is refused outside `APP_ENV=local|test`.
2. Add a webhook to `https://<app host>/api/webhooks/razorpay` with a random secret
   (`RAZORPAY_WEBHOOK_SECRET`) and the events `payment.authorized`, `payment.captured`,
   `payment.failed`, `order.paid`, `refund.processed`, `payment.dispute.lost`, `token.confirmed`,
   `token.rejected`, `token.cancelled`, `token.paused`.
3. Rotate the webhook secret by setting the old value as `RAZORPAY_WEBHOOK_SECRET_PREVIOUS`, the new
   one as `RAZORPAY_WEBHOOK_SECRET`, deploying, changing it in the Dashboard, and removing the
   previous value after 24 h (Razorpay's retry window).
4. Auto-recharge stays unavailable until Razorpay enables Recurring Payments (card mandates) for
   the merchant; then set `RAZORPAY_RECURRING_CARDS_ENABLED=true`.
5. Not yet verified against the Razorpay sandbox from this build environment (razorpay.com was
   unreachable): before launch, run a test-mode top-up, a failed payment, a refund and a card
   mandate end to end, and confirm the Checkout CSP (script `checkout.razorpay.com`, frame and
   connect `api.razorpay.com` / `checkout.razorpay.com`) is sufficient in all supported browsers.

## Health and probes

| Probe     | Web                                     | Worker                                                |
| --------- | --------------------------------------- | ----------------------------------------------------- |
| Liveness  | `GET /api/health/live`                  | `GET :9464/live`                                      |
| Readiness | `GET /api/health/ready` (DB round trip) | `GET :9464/ready` (DB round trip; 503 while stopping) |

Workers handle SIGTERM gracefully (stop fetching, finish in-flight jobs up to 30 s).
