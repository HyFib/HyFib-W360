import type { NextRequest } from 'next/server';
import { apiDeleteContactField, apiUpdateContactField } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** One custom field, by key: rename it, or delete it with its values (ADR-115). */
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ key: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const { key } = await params;
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: { data: await apiUpdateContactField(runtime.outbound, ctx, key, body) },
    }),
    { json: true },
  );
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { key } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiDeleteContactField(runtime.outbound, ctx, key) },
  }));
}
