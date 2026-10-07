import type { NextRequest } from 'next/server';
import { apiListContactTags } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/contact-tags: the tags on the company's contacts, alphabetically (ADR-272). */
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListContactTags(runtime.outbound, ctx, query)) },
  }));
}
