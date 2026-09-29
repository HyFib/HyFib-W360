import type { NextRequest } from 'next/server';
import { handleApiRequest } from '@/server/api';

/** One endpoint an API key added: read it, change it, or delete it (ADR-081). */
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await runtime.apiWebhookEndpoints.get(ctx, id) },
  }));
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: { data: await runtime.apiWebhookEndpoints.update(ctx, id, body) },
    }),
    { json: true },
  );
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => {
    await runtime.apiWebhookEndpoints.remove(ctx, id);
    return { status: 200, body: { data: { id, deleted: true } } };
  });
}
