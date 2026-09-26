import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema/index';
import type { Scope } from './scope';
import { mapDatabaseError } from './errors';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
/** A drizzle transaction handle bound to one scope. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface PoolOptions {
  connectionString: string;
  max: number;
  applicationName: string;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
}

/** Creates a pg pool with defensive per-connection timeouts. */
export function createPool(options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max,
    application_name: options.applicationName,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    lock_timeout: options.lockTimeoutMs ?? 5_000,
    // Stop idle-in-transaction connections from pinning locks/vacuum indefinitely.
    idle_in_transaction_session_timeout: 60_000,
  });
  // An idle client error (for example the server restarting) must not crash the process; the pool
  // discards the client and the next checkout reconnects.
  pool.on('error', () => undefined);
  return pool;
}

export interface Database {
  readonly pool: pg.Pool;
  /** Runs `fn` in a transaction whose RLS context is `scope`. */
  run<T>(scope: Scope, fn: (tx: Tx) => Promise<T>, options?: TransactionOptions): Promise<T>;
  close(): Promise<void>;
}

export interface TransactionOptions {
  isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
  accessMode?: 'read only' | 'read write';
}

/**
 * Wraps a pool so that every transaction explicitly sets (or clears) both context settings as its
 * first statement. Clearing matters: even if some other code path ever set a session-level value
 * on this connection, a transaction started here overrides it locally.
 */
export function createDatabase(pool: pg.Pool): Database {
  const db = drizzle({ client: pool, schema });
  return {
    pool,
    async run<T>(
      scope: Scope,
      fn: (tx: Tx) => Promise<T>,
      options: TransactionOptions = {},
    ): Promise<T> {
      const tenantId = scope.kind === 'tenant' ? scope.tenantId : '';
      const userId =
        scope.kind === 'tenant' ? (scope.userId ?? '') : scope.kind === 'user' ? scope.userId : '';
      try {
        return await db.transaction(
          async (tx) => {
            const result = await tx.execute<{ tenant: string; user_id: string }>(
              sql`select set_config('app.tenant_id', ${tenantId}, true) as tenant, set_config('app.user_id', ${userId}, true) as user_id`,
            );
            const row = result.rows[0];
            if (!row || row.tenant !== tenantId || row.user_id !== userId) {
              throw new Error('Failed to establish database scope');
            }
            return fn(tx);
          },
          {
            isolationLevel: options.isolationLevel ?? 'read committed',
            accessMode: options.accessMode ?? 'read write',
          },
        );
      } catch (error) {
        throw mapDatabaseError(error);
      }
    },
    close: () => pool.end(),
  };
}
