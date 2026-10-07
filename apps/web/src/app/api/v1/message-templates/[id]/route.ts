import type { NextRequest } from 'next/server';
import { apiGetMessageTemplate } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/message-templates/{id}: one template of any status, with its history (ADR-294). */
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiGetMessageTemplate(runtime.outbound, ctx, id) },
  }));
}
