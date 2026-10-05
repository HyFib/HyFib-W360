import type { NextRequest } from 'next/server';
import { apiListChannels } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/channels: the company's WhatsApp numbers, oldest first (ADR-171). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListChannels(runtime.outbound, ctx, query)) },
  }));
}
