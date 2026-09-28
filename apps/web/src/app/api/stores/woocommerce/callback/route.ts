import type { NextRequest } from 'next/server';
import { toError } from '@w360/core';
import { getRuntime } from '@/server/runtime';
import { readLimitedBody } from '@/server/webhook-body';

/**
 * WooCommerce's key handover (WC-003): after the store owner approves HyFib, WooCommerce posts the
 * new Read/Write keys here with the single-use id HyFib sent as `user_id`. Only a handshake still
 * waiting accepts them, the worker proves them against the store's own address before reading
 * anything, and any answer but 200 makes WooCommerce delete the keys. Keys are never logged.
 */
export const dynamic = 'force-dynamic';

const HANDOVER_LIMIT_BYTES = 16 * 1024;

export async function POST(request: NextRequest) {
  const runtime = await getRuntime();
  const body = await readLimitedBody(request, HANDOVER_LIMIT_BYTES);
  if (!body) return new Response(null, { status: 413 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    runtime.logger.info({ outcome: 'malformed' }, 'woocommerce key handover');
    return new Response(null, { status: 400 });
  }
  try {
    const result = await runtime.stores.acceptWooKeys(parsed);
    runtime.logger.info(
      { outcome: result.outcome, status: result.status, tenantId: result.tenantId },
      'woocommerce key handover',
    );
    return new Response(null, { status: result.status });
  } catch (error) {
    runtime.logger.error({ err: toError(error) }, 'woocommerce key handover failed');
    return new Response(null, { status: 500 });
  }
}
