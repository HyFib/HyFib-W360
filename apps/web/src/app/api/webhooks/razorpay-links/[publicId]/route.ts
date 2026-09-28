import type { NextRequest } from 'next/server';
import { resolveClientIp, toError } from '@w360/core';
import { handlePaymentWebhook, recordSecurityEvent, takeToken } from '@w360/domain';
import { getRuntime } from '@/server/runtime';
import { readLimitedBody } from '@/server/webhook-body';

/**
 * Webhooks from a company's own Razorpay account, for its Payment Links (the address is shown in
 * Commerce → Payments). The domain handler finds the company by the address id, verifies
 * X-Razorpay-Signature with that company's webhook secret and records the event id; a delivery
 * only makes the worker fetch the link from Razorpay, so nothing in the body changes an order.
 * The body is not stored; logs carry the outcome, the company and (once signed) the event name.
 */
export const dynamic = 'force-dynamic';

const PAYMENT_WEBHOOK_LIMIT_BYTES = 256 * 1024;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ publicId: string }> },
) {
  const { publicId } = await params;
  const runtime = await getRuntime();
  const body = await readLimitedBody(request, PAYMENT_WEBHOOK_LIMIT_BYTES);
  if (!body) return new Response(null, { status: 413 });
  try {
    const result = await handlePaymentWebhook(runtime.paymentWebhook, {
      publicId,
      rawBody: body,
      signature: request.headers.get('x-razorpay-signature'),
      eventId: request.headers.get('x-razorpay-event-id'),
    });
    runtime.logger.info({ ...result.log, status: result.status }, 'payment link webhook');
    if (result.log.outcome === 'bad_signature') {
      // Bounded so a flood of forged requests cannot flood the security log.
      const record = await takeToken(runtime.db, 'security:webhook-invalid-signature', {
        capacity: 20,
        refillPerSecond: 0.2,
      }).catch(() => false);
      if (record) {
        await recordSecurityEvent(
          runtime.db,
          {
            eventType: 'webhook.invalid_signature',
            severity: 'warning',
            tenantId: result.log.tenantId ?? null,
            details: { provider: 'razorpay_payment_links', bytes: body.length },
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
    }
    return new Response(null, { status: result.status });
  } catch (error) {
    runtime.logger.error({ err: toError(error) }, 'payment link webhook failed');
    return new Response(null, { status: 500 });
  }
}
