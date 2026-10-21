import type { NextRequest } from 'next/server';
import { apiListEnrollments, apiStartEnrollment } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/automations/{id}/enrollments: the automation's enrolments, members' and keys', newest
 * first. POST: enrol a segment's members, or the contacts a tag and marketing consent find, once
 * per key (ADR-403).
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime, query }) => ({
    status: 200,
    body: { ...(await apiListEnrollments(runtime.outbound, ctx, id, query)) },
  }));
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    ({ ctx, runtime, body, idempotency }) => {
      if (!idempotency) throw new Error('Idempotency-Key is required to enrol contacts');
      return apiStartEnrollment(runtime.outbound, ctx, id, body, idempotency);
    },
    { json: true, idempotency: 'required' },
  );
}
