# HyFib W360 — working rules

Multi-company customer-engagement SaaS on the official WhatsApp Business Platform. TypeScript modular
monolith (pnpm workspace): `apps/web` (Next.js 16), `apps/worker` (pg-boss consumers),
`packages/{core,db,domain,contracts,ui}`, `tests/{integration,e2e}`. Read `docs/ARCHITECTURE.md` first.

## Commands

```bash
export PATH=/opt/node24/bin:$PATH            # Node 24 LTS (see .node-version)
pnpm install --frozen-lockfile
pnpm db:local:up                              # Docker Postgres 18 on :54329 + role bootstrap
set -a; . ./.env; set +a; pnpm db:migrate     # owner role only
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
pnpm test:integration                         # real PostgreSQL; creates a throwaway database
pnpm build
pnpm test:e2e                                 # needs web+worker+Mailpit running (docs/PROGRESS.md)
python3 scripts/feature-matrix/build.py       # regenerate docs/FEATURE-MATRIX.md
```

## Non-negotiable rules

- **Tenant isolation.** All data access goes through `db.run(scope, fn)` with a scope created only
  after authorization (`resolveTenantContext`, signed job verification, verified provider mapping).
  Never use a raw pool, never trust tenant ids from URLs/forms/headers/job payloads without that check.
- **Every tenant table:** `tenant_id NOT NULL`, `UNIQUE (tenant_id, id)`, composite FKs to tenant
  parents, `SELECT ops.apply_tenant_rls('app.<table>')`, least-privilege grants (column grants for
  sensitive columns). The isolation suite checks FORCE RLS on every table with `tenant_id`.
- **Migrations** are forward-only reviewed SQL in `packages/db/migrations`; never edit an applied
  file (checksums are enforced). Use expand/contract for breaking changes.
- **Functions:** nothing is executable by PUBLIC (tested). For a SECURITY DEFINER function, pin
  `search_path`, `GRANT EXECUTE` to the calling role **before** `ALTER FUNCTION … OWNER TO
w360_definer` (the migration role cannot grant afterwards), and give w360_definer only the table
  privileges and policies it needs.
- **Provider traffic in tests** comes from `tests/support/graph-stand-in.ts` only; production config
  refuses non-Meta Graph origins outside `APP_ENV=local|test`. Never add a fake provider to app code.
- **Money** is integer minor units (`bigint`), never floats. Ledgers are append-only.
- **No mock production integrations, no placeholder features, no swallowed errors, no arbitrary
  sleeps.** Fakes live only in tests. Unavailable capabilities are reported as unavailable.
- **Statuses are honest** (`docs/FEATURE-MATRIX.md` legend). Never claim verification that did not run.
- **Next.js 16 differs from older versions:** read `apps/web/node_modules/next/dist/docs/` before
  using an API. Pages re-check authorization themselves (layouts are not re-run on navigation).
- Pages/actions must call domain services; business logic stays out of React components.
- Update `docs/PROGRESS.md` (and the matrix/backlog when status changes) at the end of each slice.

## Where things live

Security model and permission matrix: `docs/SECURITY.md` · Threats: `docs/THREAT-MODEL.md` ·
Decisions: `docs/DECISIONS.md` · Plan: `docs/BACKLOG.md` · Meta onboarding: `docs/META-SETUP.md` ·
Ops: `docs/DEPLOYMENT.md`, `docs/RUNBOOKS.md` · Retention: `docs/DATA-RETENTION.md`.
