import type { NextRequest } from 'next/server';
import { apiCreateContact, apiListContacts } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/contacts (a page, newest first) and POST /api/v1/contacts (ADR-052). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListContacts(runtime.outbound, ctx, query)) },
  }));
}

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) =>
      apiCreateContact(runtime.outbound, ctx, body, idempotency),
    { json: true, idempotency: 'optional' },
  );
}
