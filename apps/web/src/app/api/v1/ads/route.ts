import type { NextRequest } from 'next/server';
import { apiListAds } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/ads: the click-to-WhatsApp ads customers wrote from in the last 30 days, as Growth →
 * Ads lists them (ADR-302).
 */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListAds({ db: runtime.outbound.db }, ctx, query)) },
  }));
}
