import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { getConstructionPlans, getMigrationPlans, PgBoss } from 'pg-boss';
import type { QueueDefinition } from '@w360/contracts';

/**
 * Forward-only migration runner.
 *
 * - Runs as the owner role (w360_owner), never as a runtime role.
 * - Serialised with an advisory lock so concurrent deploys cannot interleave.
 * - Records a SHA-256 checksum per file and refuses to continue if an applied file was edited
 *   (fix-forward with a new migration instead).
 * - Each file runs in its own transaction unless its first line is `-- migrate:no-transaction`
 *   (required for CREATE INDEX CONCURRENTLY in expand/contract changes).
 * - Installs or upgrades the pg-boss job schema and declares queues, then grants runtime DML.
 */
export const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const LOCK_KEY = 7_360_001;
export const PGBOSS_SCHEMA = 'pgboss';

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
  transactional: boolean;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
  pgBossVersion: number | null;
}

export async function loadMigrations(dir: URL = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const files: MigrationFile[] = [];
  for (const file of entries) {
    const sql = await readFile(join(dir.pathname, file), 'utf8');
    files.push({
      version: file.slice(0, 4),
      name: file,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
      transactional: !sql.startsWith('-- migrate:no-transaction'),
    });
  }
  const versions = new Set<string>();
  for (const f of files) {
    if (versions.has(f.version)) throw new Error(`Duplicate migration version ${f.version}`);
    versions.add(f.version);
  }
  return files;
}

async function ensureTrackingTable(client: pg.PoolClient): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS w360_migrations`);
  await client.query(`REVOKE ALL ON SCHEMA w360_migrations FROM PUBLIC`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS w360_migrations.applied (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      applied_by text NOT NULL DEFAULT current_user,
      duration_ms integer NOT NULL
    )`);
}

export async function migrationStatus(
  connectionString: string,
): Promise<{ applied: { version: string; name: string; checksum: string }[]; pending: string[]; mismatched: string[] }> {
  const files = await loadMigrations();
  const client = new pg.Client({ connectionString, application_name: 'w360-migrate-status' });
  await client.connect();
  try {
    const exists = await client.query(`SELECT to_regclass('w360_migrations.applied') AS t`);
    const applied = exists.rows[0]?.t
      ? (await client.query<{ version: string; name: string; checksum: string }>(
          `SELECT version, name, checksum FROM w360_migrations.applied ORDER BY version`,
        )).rows
      : [];
    const byVersion = new Map(applied.map((a) => [a.version, a]));
    const pending = files.filter((f) => !byVersion.has(f.version)).map((f) => f.name);
    const mismatched = files
      .filter((f) => byVersion.has(f.version) && byVersion.get(f.version)?.checksum !== f.checksum)
      .map((f) => f.name);
    return { applied, pending, mismatched };
  } finally {
    await client.end();
  }
}

export async function runMigrations(options: {
  connectionString: string;
  queues: QueueDefinition[];
  runtimeRoles?: { app: string };
  log?: (message: string) => void;
}): Promise<MigrationResult> {
  const log = options.log ?? (() => undefined);
  const appRole = options.runtimeRoles?.app ?? 'w360_app';
  const pool = new pg.Pool({ connectionString: options.connectionString, max: 2, application_name: 'w360-migrate' });
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], alreadyApplied: [], pgBossVersion: null };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureTrackingTable(client);
    const files = await loadMigrations();
    const applied = new Map(
      (await client.query<{ version: string; checksum: string; name: string }>(
        'SELECT version, checksum, name FROM w360_migrations.applied',
      )).rows.map((r) => [r.version, r]),
    );

    for (const [version, row] of applied) {
      const file = files.find((f) => f.version === version);
      if (!file) throw new Error(`Applied migration ${row.name} is missing from the repository`);
      if (file.checksum !== row.checksum) {
        throw new Error(`Migration ${row.name} was modified after being applied; add a new migration instead`);
      }
    }

    for (const file of files) {
      if (applied.has(file.version)) {
        result.alreadyApplied.push(file.name);
        continue;
      }
      const started = Date.now();
      log(`applying ${file.name}`);
      if (file.transactional) {
        await client.query('BEGIN');
        try {
          await client.query(file.sql);
          await client.query(
            'INSERT INTO w360_migrations.applied (version, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)',
            [file.version, file.name, file.checksum, Date.now() - started],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${file.name} failed: ${(error as Error).message}`, { cause: error });
        }
      } else {
        await client.query(file.sql);
        await client.query(
          'INSERT INTO w360_migrations.applied (version, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)',
          [file.version, file.name, file.checksum, Date.now() - started],
        );
      }
      result.applied.push(file.name);
    }

    result.pgBossVersion = await installJobSchema(client, log);
    await grantJobSchema(client, appRole);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }

  // Declare queues with the owner connection so runtime roles never need queue DDL.
  await declareQueues(options.connectionString, options.queues, log);
  await pool.end();
  return result;
}

async function installJobSchema(client: pg.PoolClient, log: (m: string) => void): Promise<number> {
  const installed = await client.query(`SELECT to_regclass('${PGBOSS_SCHEMA}.version') AS t`);
  if (!installed.rows[0]?.t) {
    log('installing pg-boss schema');
    await client.query('BEGIN');
    try {
      await client.query(getConstructionPlans(PGBOSS_SCHEMA));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } else {
    const currentRaw = (await client.query<{ version: number }>(`SELECT version FROM ${PGBOSS_SCHEMA}.version`)).rows[0]
      ?.version;
    if (currentRaw === undefined) throw new Error('pg-boss version table is empty');
    const current = Number(currentRaw);
    const target = pgBossTargetVersion();
    if (current > target) {
      throw new Error(`pg-boss schema version ${current} is newer than this release supports (${target}); refusing to continue`);
    }
    if (current < target) {
      const plans = getMigrationPlans(PGBOSS_SCHEMA, current);
      log(`upgrading pg-boss schema from version ${current} to ${target}`);
      await client.query('BEGIN');
      try {
        await client.query(plans);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  }
  const version = (await client.query<{ version: number }>(`SELECT version FROM ${PGBOSS_SCHEMA}.version`)).rows[0]
    ?.version;
  return Number(version);
}

/** Schema version this pg-boss release installs, read from its public construction plan. */
export function pgBossTargetVersion(): number {
  const match = /INSERT INTO \S+\.version\s*\(version\)\s*VALUES\s*\('(\d+)'\)/i.exec(getConstructionPlans(PGBOSS_SCHEMA));
  if (!match?.[1]) throw new Error('Unable to determine pg-boss schema version from construction plan');
  return Number(match[1]);
}

async function grantJobSchema(client: pg.PoolClient, appRole: string): Promise<void> {
  const role = pg.escapeIdentifier(appRole);
  await client.query(`REVOKE ALL ON SCHEMA ${PGBOSS_SCHEMA} FROM PUBLIC`);
  await client.query(`GRANT USAGE ON SCHEMA ${PGBOSS_SCHEMA} TO ${role}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${PGBOSS_SCHEMA} TO ${role}`);
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${PGBOSS_SCHEMA} TO ${role}`);
  await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${PGBOSS_SCHEMA} TO ${role}`);
}

async function declareQueues(connectionString: string, queues: QueueDefinition[], log: (m: string) => void) {
  const boss = new PgBoss({
    connectionString,
    schema: PGBOSS_SCHEMA,
    migrate: false,
    createSchema: false,
    supervise: false,
    schedule: false,
    max: 2,
    application_name: 'w360-migrate-queues',
  });
  boss.on('error', (error: unknown) => log(`pg-boss error during queue declaration: ${(error as Error).message}`));
  await boss.start();
  try {
    // Dead-letter targets must exist before queues that reference them.
    const ordered = [...queues].sort((a, b) => Number(Boolean(a.deadLetter)) - Number(Boolean(b.deadLetter)));
    for (const q of ordered) {
      const options = {
        retryLimit: q.retryLimit,
        retryDelay: q.retryDelaySeconds,
        retryBackoff: q.retryBackoff,
        ...(q.retryDelayMaxSeconds !== undefined ? { retryDelayMax: q.retryDelayMaxSeconds } : {}),
        expireInSeconds: q.expireInSeconds,
        deleteAfterSeconds: q.deleteAfterHours * 3600,
        ...(q.deadLetter ? { deadLetter: q.deadLetter } : {}),
      };
      const existing = await boss.getQueue(q.name);
      if (!existing) {
        log(`creating queue ${q.name}`);
        await boss.createQueue(q.name, options);
      } else {
        const { deadLetter: _deadLetter, ...updatable } = options;
        await boss.updateQueue(q.name, updatable);
      }
    }
  } finally {
    await boss.stop({ graceful: false, close: true });
  }
}
