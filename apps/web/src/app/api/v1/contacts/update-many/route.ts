import type { NextRequest } from 'next/server';
import { apiUpdateManyContacts } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** POST /api/v1/contacts/update-many: up to 100 contacts changed at once, all or none (ADR-122). */
export const dynamic = 'force-dynamic';

export function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: { data: await apiUpdateManyContacts(runtime.outbound, ctx, body) },
    }),
    { json: true },
  );
}
