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
roles. Auth cookies are `Secure` whenever the origin is https. Share
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` across web replicas.

Client addresses (audit, security events, rate limits) come from `X-Forwarded-For`. The edge load
balancer must overwrite or append that header (never pass a client-supplied value through
unchanged), and `TRUSTED_PROXIES` must list the addresses or CIDR ranges of every proxy hop we
operate. Resolution reads hops from the right, skips trusted proxies, and stores the first other
address only if it is a valid IP; malformed values are dropped rather than stored. A malformed
`TRUSTED_PROXIES` entry stops start-up.

## Health and probes

| Probe     | Web                                     | Worker                                                |
| --------- | --------------------------------------- | ----------------------------------------------------- |
| Liveness  | `GET /api/health/live`                  | `GET :9464/live`                                      |
| Readiness | `GET /api/health/ready` (DB round trip) | `GET :9464/ready` (DB round trip; 503 while stopping) |

Workers handle SIGTERM gracefully (stop fetching, finish in-flight jobs up to 30 s).
