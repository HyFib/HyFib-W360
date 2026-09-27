import type { NextRequest } from 'next/server';
import { toError } from '@w360/core';
import { handleShopifyWebhook } from '@w360/domain';
import { getRuntime } from '@/server/runtime';
import { recordForgedStoreWebhook } from '@/server/store-webhook';
import { readLimitedBody } from '@/server/webhook-body';

/**
 * Shopify webhooks for connected stores, including the compliance topics set on HyFib's Shopify
 * app. The domain handler verifies X-Shopify-Hmac-Sha256 with HyFib's app secret (401 when it does
 * not verify, as Shopify's review expects), records the delivery id and only signals what the worker
 * reads from Shopify; uninstalls and privacy requests act on the store's copy. Bodies are not stored
 * or logged: logs carry the outcome, the topic and the companies concerned.
 */
export const dynamic = 'force-dynamic';

const SHOPIFY_WEBHOOK_LIMIT_BYTES = 256 * 1024;

export async function POST(request: NextRequest) {
  const runtime = await getRuntime();
  const body = await readLimitedBody(request, SHOPIFY_WEBHOOK_LIMIT_BYTES);
  if (!body) return new Response(null, { status: 413 });
  try {
    const result = await handleShopifyWebhook(runtime.storeWebhook, {
      rawBody: body,
      hmac: request.headers.get('x-shopify-hmac-sha256'),
      topic: request.headers.get('x-shopify-topic'),
      shopDomain: request.headers.get('x-shopify-shop-domain'),
      webhookId: request.headers.get('x-shopify-webhook-id'),
    });
    runtime.logger.info({ ...result.log, status: result.status }, 'shopify webhook');
    if (result.log.outcome === 'bad_signature') {
      await recordForgedStoreWebhook(request, 'shopify', null, body.length);
    }
    return new Response(null, { status: result.status });
  } catch (error) {
    runtime.logger.error({ err: toError(error) }, 'shopify webhook failed');
    return new Response(null, { status: 500 });
  }
}
