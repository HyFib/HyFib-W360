import type { NextRequest } from 'next/server';
import { AppError } from '@w360/core';
import { contentDisposition } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * GET /api/v1/messages/{id}/media: the file a customer sent with a message, fetched from WhatsApp
 * for this request and passed on as it arrives (ADR-217). Refusals come before the first byte, as
 * the API's JSON errors.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApiRequest(request, async ({ ctx, runtime }) => {
    if (!runtime.receivedMedia) {
      throw new AppError('unsupported', 'WhatsApp is not set up on this server.');
    }
    const file = await runtime.receivedMedia.openReceivedMediaForKey(ctx, id);
    return {
      status: 200,
      file: {
        body: file.body,
        headers: {
          'Content-Type': file.contentType,
          'Content-Disposition': contentDisposition(file.disposition, file.filename),
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        },
      },
    };
  });
}
