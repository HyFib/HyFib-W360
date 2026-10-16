import type { NextRequest } from 'next/server';
import { apiAddDealItem, apiListDealItems } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/deals/{id}/items (a CRM deal's products; ADR-378); POST adds one. */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiListDealItems(runtime.outbound, ctx, id) },
  }));
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) =>
      apiAddDealItem(runtime.outbound, ctx, id, body, idempotency),
    { json: true, idempotency: 'optional' },
  );
}
