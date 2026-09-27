import 'server-only';
import { resolveClientIp, toError } from '@w360/core';
import { recordSecurityEvent, takeToken } from '@w360/domain';
import { getRuntime } from './runtime';

/**
 * Records a store webhook whose signature did not verify, bounded so that a flood of forged
 * requests cannot flood the security log (same budget as the other webhook routes).
 */
export async function recordForgedStoreWebhook(
  request: Request,
  provider: 'shopify' | 'woocommerce',
  tenantId: string | null,
  bytes: number,
): Promise<void> {
  const runtime = await getRuntime();
  const record = await takeToken(runtime.db, 'security:webhook-invalid-signature', {
    capacity: 20,
    refillPerSecond: 0.2,
  }).catch((error: unknown) => {
    runtime.logger.warn({ err: toError(error).message }, 'security event budget unavailable');
    return false;
  });
  if (!record) return;
  await recordSecurityEvent(
    runtime.db,
    {
      eventType: 'webhook.invalid_signature',
      severity: 'warning',
      tenantId,
      details: { provider, bytes },
    },
    {
      ipAddress: resolveClientIp(
        request.headers.get('x-forwarded-for'),
        request.headers.get('x-real-ip'),
        runtime.trustedProxies,
      ),
      userAgent: request.headers.get('user-agent'),
    },
  ).catch((error: unknown) =>
    runtime.logger.warn({ err: toError(error).message }, 'security event not recorded'),
  );
}
