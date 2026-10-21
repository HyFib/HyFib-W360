import type { NextRequest } from 'next/server';
import { apiGetEnrollment } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/** GET /api/v1/automations/{id}/enrollments/{enrollmentId}: one enrolment's progress (ADR-403). */
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; enrollmentId: string }> },
) {
  const { id, enrollmentId } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => ({
    status: 200,
    body: { data: await apiGetEnrollment(runtime.outbound, ctx, id, enrollmentId) },
  }));
}
