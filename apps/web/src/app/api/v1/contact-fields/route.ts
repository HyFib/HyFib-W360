import type { NextRequest } from 'next/server';
import { apiCreateContactField, apiListContactFields } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/contact-fields: the company's custom fields (ADR-112). POST: add one (ADR-115), once
 * per Idempotency-Key when one is given.
 */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiListContactFields(runtime.outbound, ctx) },
  }));
}

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) =>
      apiCreateContactField(runtime.outbound, ctx, body, idempotency),
    { json: true, idempotency: 'optional' },
  );
}
