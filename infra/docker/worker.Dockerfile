# syntax=docker/dockerfile:1.7
# HyFib W360 worker and migration runner. Build from the repository root:
#   docker build -f infra/docker/worker.Dockerfile -t w360-worker .
# Run the worker:     docker run w360-worker
# Run migrations:     docker run -e DATABASE_URL_MIGRATE=... w360-worker node dist/migrate.js
ARG NODE_IMAGE=node:24.21.0-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# Optional extra CA bundle for builds behind a TLS-intercepting proxy (never baked into the image):
#   docker build --secret id=extra_ca,src=/path/to/ca.pem ...
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm install -g pnpm@11.28.0
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ui/package.json packages/ui/
COPY tests/integration/package.json tests/integration/
COPY tests/e2e/package.json tests/e2e/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile
COPY . .
# `deploy` re-checks its lockfile against pnpm's supply-chain policies, which needs full registry
# metadata for any dependency that published recently; --prefer-offline lets it fetch that
# metadata while packages still come from the store (exact versions from the lockfile).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm --filter @w360/worker build \
 && pnpm --filter @w360/worker deploy --prod --prefer-offline /out \
 && cp -r apps/worker/dist /out/dist \
 && cp -r packages/db/migrations /out/migrations

FROM ${NODE_IMAGE} AS runtime
# The runtime only needs `node`: drop the package managers bundled with the base image so their
# dependency trees (and any CVEs in them) are not shipped.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production W360_MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 9464
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9464/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/main.js"]
