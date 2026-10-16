import type { NextRequest } from 'next/server';
import { apiRemoveDealItem } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** DELETE /api/v1/deals/{id}/items/{itemId} (removes a product from a CRM deal; ADR-378). */
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string; itemId: string }> };

export async function DELETE(request: NextRequest, { params }: Params) {
  const { id, itemId } = await params;
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { data: await apiRemoveDealItem(runtime.outbound, ctx, id, itemId, query) },
  }));
}
