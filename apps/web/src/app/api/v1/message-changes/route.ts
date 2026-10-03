import type { NextRequest } from 'next/server';
import { apiMessageChanges } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/message-changes: messages in the order they changed (ADR-116). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: {
      ...(await apiMessageChanges({ db: runtime.db, keyring: runtime.keyring }, ctx, query)),
    },
  }));
}
