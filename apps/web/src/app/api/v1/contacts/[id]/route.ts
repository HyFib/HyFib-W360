import type { NextRequest } from 'next/server';
import { apiGetContact, apiUpdateContact } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/contacts/{id} (ADR-052); PATCH changes its name, email, fields and tags (ADR-112). */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiGetContact(runtime.outbound, ctx, id) },
  }));
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: { data: await apiUpdateContact(runtime.outbound, ctx, id, body) },
    }),
    { json: true },
  );
}
