import type { NextRequest } from 'next/server';
import { apiGetReport } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/reports: the numbers the Reports page shows for a period, read as the page reads
 * them (ADR-297).
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { data: await apiGetReport(runtime.outbound, ctx, query) },
  }));
}
