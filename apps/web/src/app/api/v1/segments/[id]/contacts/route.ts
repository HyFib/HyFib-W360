import type { NextRequest } from 'next/server';
import { apiListSegmentContacts } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/segments/{id}/contacts: the contacts a saved segment holds now (ADR-208). */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListSegmentContacts(runtime.outbound, ctx, id, query)) },
  }));
}
