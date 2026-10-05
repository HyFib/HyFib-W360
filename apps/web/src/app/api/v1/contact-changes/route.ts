import type { NextRequest } from 'next/server';
import { apiContactChanges } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/contact-changes: contacts in the order they changed (ADR-114). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: {
      ...(await apiContactChanges({ db: runtime.db, keyring: runtime.keyring }, ctx, query)),
    },
  }));
}
