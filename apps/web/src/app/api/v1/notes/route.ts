import type { NextRequest } from 'next/server';
import { apiCreateNote, apiListNotes } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/notes (CRM notes, a page, newest first; ADR-279); POST adds a note to a contact's or
 * a deal's CRM timeline (ADR-268).
 */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListNotes(runtime.outbound, ctx, query)) },
  }));
}

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) =>
      apiCreateNote(runtime.outbound, ctx, body, idempotency),
    { json: true, idempotency: 'optional' },
  );
}
