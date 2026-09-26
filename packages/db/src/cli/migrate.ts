import { ALL_QUEUES } from '@w360/contracts';
import { migrationStatus, runMigrations } from '../migrate';

/**
 * Usage:
 *   DATABASE_URL_MIGRATE=postgres://w360_owner:...@host/db pnpm db:migrate
 *   DATABASE_URL_MIGRATE=... pnpm db:status
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_MIGRATE;
  if (!url) {
    console.error('DATABASE_URL_MIGRATE is required (owner role connection string).');
    process.exit(2);
  }
  if (process.argv.includes('--status')) {
    const status = await migrationStatus(url);
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    process.exit(status.mismatched.length > 0 ? 1 : 0);
  }
  const result = await runMigrations({
    connectionString: url,
    queues: ALL_QUEUES,
    log: (m) => process.stdout.write(`[migrate] ${m}\n`),
  });
  process.stdout.write(
    `[migrate] done: applied=${result.applied.length} already=${result.alreadyApplied.length} pgboss=${result.pgBossVersion}\n`,
  );
}

main().catch((error: unknown) => {
  console.error('[migrate] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
