#!/usr/bin/env bash
# Local development PostgreSQL (Docker). Development credentials only; never reuse elsewhere.
set -euo pipefail
NAME="${W360_PG_CONTAINER:-w360-postgres}"
IMAGE="${W360_PG_IMAGE:-postgres:18-alpine}"
PORT="${W360_PG_PORT:-54329}"
DB="${W360_PG_DB:-w360}"
ADMIN_URL="postgres://postgres:postgres@127.0.0.1:${PORT}/postgres"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

wait_ready() {
  for _ in $(seq 1 60); do
    # Probe over TCP: during first-run initialisation the image starts a temporary server that
    # listens only on the Unix socket, so a socket probe reports ready before the real server is up.
    if docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "PostgreSQL did not become ready" >&2
  exit 1
}

bootstrap() {
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -tc "SELECT 1 FROM pg_database WHERE datname = '${DB}'" | grep -q 1 \
    || psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DB}"
  psql "postgres://postgres:postgres@127.0.0.1:${PORT}/${DB}" -v ON_ERROR_STOP=1 \
    -v db_name="$DB" \
    -v owner_password=dev-only-owner \
    -v app_password=dev-only-app \
    -v auth_password=dev-only-auth \
    -v platform_password=dev-only-platform \
    -f "$ROOT/infra/db/bootstrap-roles.sql"
  echo "Bootstrap complete. Run: DATABASE_URL_MIGRATE=postgres://w360_owner:dev-only-owner@127.0.0.1:${PORT}/${DB} pnpm db:migrate"
}

case "${1:-up}" in
  up)
    if ! docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
      docker run -d --name "$NAME" -e POSTGRES_PASSWORD=postgres -p "127.0.0.1:${PORT}:5432" "$IMAGE" >/dev/null
    else
      docker start "$NAME" >/dev/null
    fi
    wait_ready
    bootstrap
    ;;
  down)
    docker stop "$NAME" >/dev/null || true
    ;;
  reset)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    "$0" up
    ;;
  *)
    echo "usage: $0 up|down|reset" >&2
    exit 2
    ;;
esac
