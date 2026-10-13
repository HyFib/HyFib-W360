import type { NextRequest } from 'next/server';
import { apiListDealFields } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/deal-fields: the company's custom deal fields (ADR-373), the keys deals take. */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiListDealFields(runtime.outbound, ctx) },
  }));
}
