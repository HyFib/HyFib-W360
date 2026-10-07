import type { NextRequest } from 'next/server';
import { apiDeleteClosedDay } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** DELETE /api/v1/business-hours/closed-days/{id}: opens a closed day again (ADR-290). */
export const dynamic = 'force-dynamic';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiDeleteClosedDay(runtime.outbound, ctx, id) },
  }));
}
