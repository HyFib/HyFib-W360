import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { ALL_QUEUES } from '@w360/contracts';
import { runMigrations } from '@w360/db/migrate';

/**
 * Creates a fresh database on a real PostgreSQL server for this test run, bootstraps roles with the
 * production bootstrap script, and applies all migrations with the owner role. Tests connect as the
 * runtime roles (w360_app, w360_auth, w360_platform) exactly like the application does.
 *
 * TEST_DATABASE_ADMIN_URL must point at a disposable server (local Docker or CI service). Never
 * point it at a shared or production cluster.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const TEST_PASSWORDS = {
  owner: 'dev-only-owner',
  app: 'dev-only-app',
  auth: 'dev-only-auth',
  platform: 'dev-only-platform',
};

function urlFor(adminUrl: string, database: string, user?: string, password?: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  if (user) url.username = user;
  if (password) url.password = password;
  return url.toString();
}

declare module 'vitest' {
  export interface ProvidedContext {
    dbUrls: { admin: string; owner: string; app: string; auth: string; platform: string; name: string };
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@127.0.0.1:54329/postgres';
  const dbName = `w360_it_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(dbName)}`);
  } finally {
    await admin.end();
  }

  const dbAdminUrl = urlFor(adminUrl, dbName);
  execFileSync(
    'psql',
    [
      dbAdminUrl,
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      `db_name=${dbName}`,
      '-v',
      `owner_password=${TEST_PASSWORDS.owner}`,
      '-v',
      `app_password=${TEST_PASSWORDS.app}`,
      '-v',
      `auth_password=${TEST_PASSWORDS.auth}`,
      '-v',
      `platform_password=${TEST_PASSWORDS.platform}`,
      '-f',
      `${ROOT}infra/db/bootstrap-roles.sql`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );

  const ownerUrl = urlFor(adminUrl, dbName, 'w360_owner', TEST_PASSWORDS.owner);
  await runMigrations({ connectionString: ownerUrl, queues: ALL_QUEUES });

  project.provide('dbUrls', {
    admin: dbAdminUrl,
    owner: ownerUrl,
    app: urlFor(adminUrl, dbName, 'w360_app', TEST_PASSWORDS.app),
    auth: urlFor(adminUrl, dbName, 'w360_auth', TEST_PASSWORDS.auth),
    platform: urlFor(adminUrl, dbName, 'w360_platform', TEST_PASSWORDS.platform),
    name: dbName,
  });

  return async () => {
    if (process.env.KEEP_TEST_DATABASE === '1') return;
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(dbName)} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  };
}
