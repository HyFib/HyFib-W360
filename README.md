# HyFib W360

Multi-company customer engagement on the **official WhatsApp Business Platform**: independent
businesses subscribe, invite their teams, connect their own WhatsApp Business Accounts and use
messaging, marketing, sales, support, automation, analytics and integrations.

> **Status (2026-09-26): implementation in progress — production blocked.** Phase 1 (identity,
> companies, memberships, RBAC, row-level security, invitations, platform administration, worker,
> CI/deployment baseline) is implemented and verified locally. WhatsApp messaging, billing and the
> remaining modules are planned or blocked on provider approvals. See
> [`docs/FEATURE-MATRIX.md`](docs/FEATURE-MATRIX.md) and [`docs/PROGRESS.md`](docs/PROGRESS.md).
> This product does not claim parity with any competitor.

## Stack

Node.js 24 LTS · TypeScript 6 (strict) · Next.js 16 App Router · React 19 · Tailwind CSS 4 ·
PostgreSQL 17/18 with forced row-level security · Drizzle ORM + reviewed SQL migrations ·
pg-boss 12 durable jobs · Better Auth (email/password, TOTP 2FA) · Vitest · Playwright · Docker.

## Repository layout

```
apps/web            Next.js app (UI, server actions, route handlers, auth endpoints)
apps/worker         Background worker (pg-boss consumers, schedulers, health probes)
packages/core       Config, errors, ids, crypto keyring, logger, money
packages/db         Drizzle schema, SQL migrations, scoped DB access, migration runner
packages/domain     Framework-independent services, authorization policy, jobs, email
packages/contracts  Zod schemas shared by browser and server; job queue contracts
packages/ui         Accessible UI primitives
tests/integration   Real-PostgreSQL tests (tenant isolation, jobs)
tests/e2e           Playwright end-to-end tests
infra/              Docker images, compose stack, database role bootstrap
docs/               Architecture, decisions, threat model, feature matrix, runbooks, progress
```

## Quick start (local)

Prerequisites: Node.js 24.21+, pnpm 11.28, Docker, `psql`.

```bash
pnpm install --frozen-lockfile
cp .env.example .env                 # then fill the generated secrets (see comments in the file)
pnpm db:local:up                     # PostgreSQL 18 in Docker + role bootstrap
docker compose -f infra/docker-compose.yml up -d mailpit
set -a; . ./.env; set +a
pnpm db:migrate
pnpm dev:web                         # http://localhost:3000
pnpm dev:worker                      # delivers queued email (Mailpit UI: http://localhost:8025)
```

Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`.

## Documentation

| Document                                       | Purpose                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| [ARCHITECTURE](docs/ARCHITECTURE.md)           | System design, tenant isolation, jobs, messaging and billing designs |
| [DECISIONS](docs/DECISIONS.md)                 | Architecture decision records                                        |
| [THREAT-MODEL](docs/THREAT-MODEL.md)           | Threats, mitigations and their status                                |
| [SECURITY](docs/SECURITY.md)                   | Controls and the role/permission matrix                              |
| [FEATURE-MATRIX](docs/FEATURE-MATRIX.md)       | Dated, sourced benchmark with truthful status                        |
| [BACKLOG](docs/BACKLOG.md)                     | Dependency-ordered tasks with acceptance criteria                    |
| [META-SETUP](docs/META-SETUP.md)               | Meta business verification, app review, Embedded Signup              |
| [DEPLOYMENT](docs/DEPLOYMENT.md)               | Environments, topology, releases, migrations                         |
| [RUNBOOKS](docs/RUNBOOKS.md)                   | Operational procedures                                               |
| [DATA-RETENTION](docs/DATA-RETENTION.md)       | Retention, export and deletion semantics                             |
| [RELEASE-CHECKLIST](docs/RELEASE-CHECKLIST.md) | Release gates and evidence                                           |
| [PROGRESS](docs/PROGRESS.md)                   | What is done, test results, blockers, next task                      |

WhatsApp is a trademark of its owner. HyFib W360 is an independent product that uses the official
WhatsApp Business Platform.
