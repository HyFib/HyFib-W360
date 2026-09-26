-- HyFib W360 database role bootstrap.
--
-- Run ONCE per database by a database administrator, never by the application. Passwords must come
-- from the secret manager; they are passed as psql variables and never committed.
--
--   psql "$ADMIN_DATABASE_URL" \
--     -v db_name=w360 \
--     -v owner_password="$W360_OWNER_PASSWORD" \
--     -v app_password="$W360_APP_PASSWORD" \
--     -v auth_password="$W360_AUTH_PASSWORD" \
--     -v platform_password="$W360_PLATFORM_PASSWORD" \
--     -f infra/db/bootstrap-roles.sql
--
-- Roles:
--   w360_owner    Migration role. Owns schemas and tables. Used only by the migrate command.
--   w360_app      Runtime role for web and worker tenant work. Not an owner, not superuser,
--                 NOBYPASSRLS. Every tenant table enforces FORCE ROW LEVEL SECURITY.
--   w360_auth     Runtime role used only by the authentication library for identity tables.
--   w360_platform Platform-administration role with explicit cross-tenant read policies on a few
--                 tables. NOBYPASSRLS. Used only by the separately authorised platform area.
--   w360_definer  NOLOGIN. Owns the small set of SECURITY DEFINER functions (create company,
--                 accept invitation, last-owner guard, provider asset resolution).
\set ON_ERROR_STOP on

SELECT format('CREATE ROLE w360_owner LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION', :'owner_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'w360_owner') \gexec
SELECT format('CREATE ROLE w360_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'w360_app') \gexec
SELECT format('CREATE ROLE w360_auth LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION', :'auth_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'w360_auth') \gexec
SELECT format('CREATE ROLE w360_platform LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION', :'platform_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'w360_platform') \gexec
SELECT 'CREATE ROLE w360_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'w360_definer') \gexec

-- The migration role must be able to hand function ownership to w360_definer (SET), but must not
-- inherit its privileges or RLS policies (INHERIT FALSE). Requires PostgreSQL 16+.
GRANT w360_definer TO w360_owner WITH INHERIT FALSE, SET TRUE;

SELECT format('GRANT CONNECT, CREATE ON DATABASE %I TO w360_owner', :'db_name') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO w360_app, w360_auth, w360_platform', :'db_name') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db_name') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Defensive session defaults. Pools also set statement timeouts per connection.
ALTER ROLE w360_app SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE w360_auth SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE w360_platform SET idle_in_transaction_session_timeout = '60s';
