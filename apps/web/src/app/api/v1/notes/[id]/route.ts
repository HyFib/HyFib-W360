import type { NextRequest } from 'next/server';
import { apiGetNote } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/notes/{id} (a CRM note; ADR-279). */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiGetNote(runtime.outbound, ctx, id) },
  }));
}
