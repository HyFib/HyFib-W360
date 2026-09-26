import type pg from 'pg';

/**
 * Start-up self check for runtime database roles. A runtime role that is a superuser, has
 * BYPASSRLS or owns protected tables would silently disable row level security, so processes
 * refuse to start (production) or warn loudly (development) when this check fails.
 */
export interface RoleSafetyReport {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  ownedProtectedTables: number;
  safe: boolean;
}

export async function checkRuntimeRoleSafety(pool: pg.Pool): Promise<RoleSafetyReport> {
  const client = await pool.connect();
  try {
    const role = await client.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    const owned = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_tables
        WHERE tableowner = current_user AND schemaname IN ('app', 'auth', 'ops', 'pgboss')`,
    );
    const r = role.rows[0];
    if (!r) throw new Error('Unable to read current role attributes');
    const ownedProtectedTables = Number(owned.rows[0]?.n ?? '0');
    return {
      role: r.rolname,
      superuser: r.rolsuper,
      bypassRls: r.rolbypassrls,
      ownedProtectedTables,
      safe: !r.rolsuper && !r.rolbypassrls && ownedProtectedTables === 0,
    };
  } finally {
    client.release();
  }
}

export async function assertRuntimeRoleSafety(
  pool: pg.Pool,
  options: { strict: boolean; warn: (message: string) => void },
): Promise<RoleSafetyReport> {
  const report = await checkRuntimeRoleSafety(pool);
  if (!report.safe) {
    const message = `Database role "${report.role}" is unsafe for runtime use (superuser=${report.superuser}, bypassrls=${report.bypassRls}, owned_tables=${report.ownedProtectedTables}).`;
    if (options.strict) throw new Error(message);
    options.warn(message);
  }
  return report;
}
