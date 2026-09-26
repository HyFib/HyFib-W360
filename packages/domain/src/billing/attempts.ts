import {
  and,
  autoRechargeAttempts,
  eq,
  inArray,
  topups,
  type TenantScope,
  type Tx,
} from '@w360/db';

/** Marks an open top-up failed (a later capture of its order still credits it). */
export async function failTopup(tx: Tx, scope: TenantScope, topupId: string, reason: string) {
  await tx
    .update(topups)
    .set({ status: 'failed', failureReason: reason.slice(0, 500) })
    .where(
      and(
        eq(topups.tenantId, scope.tenantId),
        eq(topups.id, topupId),
        inArray(topups.status, ['creating', 'awaiting_payment']),
      ),
    );
}

/** Stops attempts that have not asked the bank for money yet (settings turned off or changed). */
export async function cancelPendingAutoRecharge(
  tx: Tx,
  scope: TenantScope,
  reason: string,
  now: Date,
) {
  const canceled = await tx
    .update(autoRechargeAttempts)
    .set({
      status: 'canceled',
      unknownStep: null,
      lastError: reason.slice(0, 500),
      resolvedAt: now,
    })
    .where(
      and(
        eq(autoRechargeAttempts.tenantId, scope.tenantId),
        inArray(autoRechargeAttempts.status, ['scheduled', 'order_created']),
      ),
    )
    .returning({ topupId: autoRechargeAttempts.topupId });
  for (const row of canceled) await failTopup(tx, scope, row.topupId, reason);
  return canceled.length;
}
