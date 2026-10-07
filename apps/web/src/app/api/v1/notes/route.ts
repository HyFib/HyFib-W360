import type { NextRequest } from 'next/server';
import { apiCreateNote } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** POST /api/v1/notes adds a note to a contact's or a deal's CRM timeline (ADR-268). */
export const dynamic = 'force-dynamic';

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) =>
      apiCreateNote(runtime.outbound, ctx, body, idempotency),
    { json: true, idempotency: 'optional' },
  );
}
