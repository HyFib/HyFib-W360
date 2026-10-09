import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import * as schema from './schema/index';
import type { TransactionOptions, Tx } from './client';
import { mapDatabaseError } from './errors';

/**
 * Platform-administration database access (role w360_platform). Only the platform module may
 * import this entry point (enforced by lint). The role is NOBYPASSRLS: it sees other companies'
 * rows only on tables with an explicit `TO w360_platform` policy, and can update only the columns
 * granted to it (company status). Every call records the acting platform administrator in
 * app.user_id so SECURITY DEFINER helpers and audit rows can attribute the action.
 */
export interface PlatformDatabase {
  /**
   * Runs `fn` in a transaction as the acting administrator: read committed and read write unless
   * `options` asks otherwise (a read of several statements that must agree, one snapshot).
   */
  run<T>(actorUserId: string, fn: (tx: Tx) => Promise<T>, options?: TransactionOptions): Promise<T>;
  close(): Promise<void>;
}

export function createPlatformDatabase(pool: pg.Pool): PlatformDatabase {
  const db = drizzle({ client: pool, schema });
  return {
    async run<T>(
      actorUserId: string,
      fn: (tx: Tx) => Promise<T>,
      options: TransactionOptions = {},
    ): Promise<T> {
      if (!actorUserId) throw new Error('Platform actor required');
      try {
        return await db.transaction(
          async (tx) => {
            await tx.execute(
              sql`select set_config('app.tenant_id', '', true), set_config('app.user_id', ${actorUserId}, true)`,
            );
            return fn(tx as unknown as Tx);
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
