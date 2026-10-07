import type { NextRequest } from 'next/server';
import { apiRequestOrderPayment } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * POST /api/v1/orders/{id}/request-payment: ask the customer to pay a WhatsApp order with a Payment
 * Link from the company's Razorpay account, sent in the order's conversation (ADR-283).
 */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(
    request,
    ({ ctx, runtime, idempotency }) =>
      apiRequestOrderPayment(runtime.outbound, ctx, id, idempotency),
    { idempotency: 'optional' },
  );
}
