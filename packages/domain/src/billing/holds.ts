import { AppError, isAppError } from '@w360/core';
import { authorizedTenantScope, sql, systemScope, type Database, type TenantScope } from '@w360/db';

/**
 * Reservations against available service credit for billable HyFib services. A hold moves credit
 * from available to held; settling charges the verified amount (at most the hold) and returns the
 * rest; releasing returns all of it. Every operation is idempotent and runs in SQL (0004_billing).
 */
export async function holdServiceCredit(
  db: Database,
  scope: TenantScope,
  input: {
    idempotencyKey: string;
    amountMinor: number;
    referenceType: string;
    referenceId: string;
    expiresAt: Date;
  },
): Promise<string> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new AppError(
      'validation_failed',
      'Hold amount must be a positive whole number of paise.',
    );
  }
  try {
    return await db.run(scope, async (tx) => {
      const res = await tx.execute<{ id: string }>(
        sql`select app.billing_hold(${input.idempotencyKey}, ${input.amountMinor}::bigint,
                                    ${input.referenceType}, ${input.referenceId},
                                    ${input.expiresAt.toISOString()}::timestamptz) as id`,
      );
      const id = res.rows[0]?.id;
      if (!id) throw new Error('hold returned no id');
      return id;
    });
  } catch (error) {
    if (isAppError(error) && error.code === 'insufficient_funds') {
      throw new AppError(
        'insufficient_funds',
        'Not enough service credit. Add credit and try again.',
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}

export async function settleServiceCredit(
  db: Database,
  scope: TenantScope,
  holdId: string,
  amountMinor: number,
): Promise<void> {
  await db.run(scope, (tx) =>
    tx.execute(sql`select app.billing_settle_hold(${holdId}::uuid, ${amountMinor}::bigint)`),
  );
}

export async function releaseServiceCredit(
  db: Database,
  scope: TenantScope,
  holdId: string,
): Promise<void> {
  await db.run(scope, (tx) => tx.execute(sql`select app.billing_release_hold(${holdId}::uuid)`));
}

/** Releases holds whose service never completed before they expired (bounded per call). */
export async function releaseExpiredHolds(db: Database, limit = 200): Promise<number> {
  const due = await db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{ tenant_id: string; hold_id: string }>(
        sql`select tenant_id, hold_id from ops.billing_expired_holds(${limit})`,
      );
      return res.rows;
    },
    { accessMode: 'read only' },
  );
  for (const row of due) {
    // Tenant ids come from the database (definer sweep query), never from a payload.
    await releaseServiceCredit(db, authorizedTenantScope(row.tenant_id, null), row.hold_id);
  }
  return due.length;
}
