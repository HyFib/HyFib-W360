import { z } from 'zod';
import { eq, tenants, type Tx } from '@w360/db';
import { USAGE_WARNING_PERCENTS } from './model';

/**
 * The share of a monthly limit at which the company's billing managers are warned (ADR-144), 80%
 * until a member who manages billing chooses another; `tx` must be in the company's scope.
 */
export async function loadUsageWarningPercent(tx: Tx, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ percent: tenants.usageWarningPercent })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!row) throw new Error('The company does not exist');
  return row.percent;
}

const USAGE_WARNING_MESSAGE = 'Choose a share from 50% to 95%, in steps of 5.';

/** A share from the list; anything else, a fraction or not a number at all, gets one message. */
export const usageWarningSchema = z.object({
  percent: z.coerce
    .number({ error: USAGE_WARNING_MESSAGE })
    .refine(
      (p) => (USAGE_WARNING_PERCENTS as readonly number[]).includes(p),
      USAGE_WARNING_MESSAGE,
    ),
});
