import type { NextRequest } from 'next/server';
import { apiListEnrolledContacts } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/automations/{id}/enrollments/{enrollmentId}/contacts: the enrolment's contacts in
 * position order with their outcomes, on keyset pages (ADR-408).
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; enrollmentId: string }> },
) {
  const { id, enrollmentId } = await params;
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListEnrolledContacts(runtime.outbound, ctx, id, enrollmentId, query)) },
  }));
}
