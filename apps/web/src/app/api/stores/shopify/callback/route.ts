import type { NextRequest } from 'next/server';
import { isAppError, resolveClientIp, toError } from '@w360/core';
import { resolveTenantContext } from '@w360/domain';
import { getRuntime } from '@/server/runtime';

/**
 * Where Shopify sends the member back after they approve HyFib (SH-004). The query is checked before
 * anything else (HMAC with HyFib's app secret, timestamp, shop, a handshake still waiting); then
 * the signed-in member must be the one who started the handshake, with commerce.manage in that
 * company. The authorization code is handed to the worker, which exchanges it with Shopify.
 */
export const dynamic = 'force-dynamic';

function page(status: number, message: string) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HyFib W360</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">Connecting your Shopify store</h1><p>${message}</p><p><a href="/">Back to HyFib W360</a></p></body></html>`;
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function GET(request: NextRequest) {
  const runtime = await getRuntime();
  const url = new URL(request.url);
  try {
    const checked = await runtime.stores.shopifyCallback(url.searchParams);
    if (!checked.ok) {
      runtime.logger.info({ outcome: checked.reason }, 'shopify callback refused');
      return page(
        400,
        'Shopify’s approval could not be verified or has expired. Start connecting the store again from Commerce → Stores.',
      );
    }
    const stores = `${runtime.config.APP_BASE_URL}/c/${checked.tenantSlug}/commerce/stores`;
    const session = await runtime.auth.api.getSession({ headers: request.headers });
    if (!session?.user.emailVerified) {
      return page(
        401,
        'Sign in to HyFib W360 in this browser, then start connecting the store again from Commerce → Stores.',
      );
    }
    let ctx;
    try {
      ctx = await resolveTenantContext(
        {
          db: runtime.db,
          clock: runtime.clock,
          mfaGracePeriodHours: runtime.config.MFA_GRACE_PERIOD_HOURS,
        },
        {
          userId: session.user.id,
          sessionId: session.session.id,
          tenantSlug: checked.tenantSlug,
          correlationId: crypto.randomUUID(),
        },
      );
    } catch (error) {
      if (isAppError(error) && (error.code === 'not_found' || error.code === 'forbidden')) {
        return page(403, 'This approval belongs to a company you are not a member of.');
      }
      throw error;
    }
    try {
      const { storeId } = await runtime.stores.acceptShopifyApproval(
        ctx,
        {
          storeId: checked.storeId,
          tokenHash: checked.tokenHash,
          code: checked.code,
          shop: checked.shop,
        },
        {
          ipAddress: resolveClientIp(
            request.headers.get('x-forwarded-for'),
            request.headers.get('x-real-ip'),
            runtime.trustedProxies,
          ),
          userAgent: request.headers.get('user-agent'),
        },
      );
      return Response.redirect(`${stores}/${storeId}`, 303);
    } catch (error) {
      if (isAppError(error)) {
        const reason =
          error.code === 'forbidden'
            ? 'forbidden'
            : error.code === 'conflict'
              ? 'expired'
              : 'invalid';
        runtime.logger.info(
          { outcome: reason, tenantId: ctx.tenant.id },
          'shopify callback refused',
        );
        return Response.redirect(`${stores}?error=${reason}`, 303);
      }
      throw error;
    }
  } catch (error) {
    runtime.logger.error({ err: toError(error) }, 'shopify callback failed');
    return page(500, 'Something went wrong while connecting the store. Please try again.');
  }
}
