import type { NextRequest } from 'next/server';
import { toError } from '@w360/core';
import { handleWooWebhook } from '@w360/domain';
import { getRuntime } from '@/server/runtime';
import { recordForgedStoreWebhook } from '@/server/store-webhook';
import { readLimitedBody } from '@/server/webhook-body';

/**
 * Webhooks from a company's WooCommerce store (the address carries the store's random id). The
 * domain handler answers WooCommerce's unsigned creation ping, verifies X-WC-Webhook-Signature with
 * that store's own secret, records the delivery id and only signals what the worker reads from the
 * store. Bodies (whole orders) are not stored or logged.
 */
export const dynamic = 'force-dynamic';

const WOO_WEBHOOK_LIMIT_BYTES = 1024 * 1024;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ publicId: string }> },
) {
  const { publicId } = await params;
  const runtime = await getRuntime();
  const body = await readLimitedBody(request, WOO_WEBHOOK_LIMIT_BYTES);
  if (!body) return new Response(null, { status: 413 });
  try {
    const result = await handleWooWebhook(runtime.storeWebhook, {
      publicId,
      rawBody: body,
      signature: request.headers.get('x-wc-webhook-signature'),
      topic: request.headers.get('x-wc-webhook-topic'),
      deliveryId: request.headers.get('x-wc-webhook-delivery-id'),
    });
    runtime.logger.info({ ...result.log, status: result.status }, 'woocommerce webhook');
    if (result.log.outcome === 'bad_signature') {
      await recordForgedStoreWebhook(
        request,
        'woocommerce',
        result.log.tenantIds?.[0] ?? null,
        body.length,
      );
    }
    return new Response(null, { status: result.status });
  } catch (error) {
    runtime.logger.error({ err: toError(error) }, 'woocommerce webhook failed');
    return new Response(null, { status: 500 });
  }
}
