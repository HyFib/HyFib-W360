import type { NextRequest } from 'next/server';
import { apiStopEnrollment } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * POST /api/v1/automations/{id}/enrollments/{enrollmentId}/stop: stop a running enrolment; runs
 * already started go on (ADR-403).
 */
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; enrollmentId: string }> },
) {
  const { id, enrollmentId } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiStopEnrollment(runtime.outbound, ctx, id, enrollmentId) },
  }));
}
