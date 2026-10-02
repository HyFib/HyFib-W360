import type { NextRequest } from 'next/server';
import { apiListContactFields } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/contact-fields: the company's custom fields (ADR-112). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiListContactFields(runtime.outbound, ctx) },
  }));
}
