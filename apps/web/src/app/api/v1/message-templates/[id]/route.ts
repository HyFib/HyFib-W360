import type { NextRequest } from 'next/server';
import {
  apiDeleteMessageTemplate,
  apiGetMessageTemplate,
  apiUpdateMessageTemplate,
} from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/message-templates/{id}: one template of any status, with its history (ADR-294);
 * PATCH changes a draft's content and DELETE deletes a draft Meta never received (ADR-295), or,
 * with templates.submit, a template Meta has (ADR-296).
 */
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiGetMessageTemplate(runtime.outbound, ctx, id) },
  }));
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => ({
      status: 200,
      body: { data: await apiUpdateMessageTemplate(runtime.outbound, ctx, id, body) },
    }),
    { json: true },
  );
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiDeleteMessageTemplate(runtime.outbound, ctx, id) },
  }));
}
