import type { NextRequest } from 'next/server';
import { AppError } from '@w360/core';
import { REPLY_FILE_MAX_BYTES, apiUploadMedia } from '@w360/domain';
import { handleApiRequest } from '@/server/api';

/**
 * POST /api/v1/media: uploads a file for one of the company's numbers, to send by id from it
 * (ADR-219). Multipart form data: `file`, and `from` when the company has several numbers.
 */
export const dynamic = 'force-dynamic';

/** Room for the form's other fields and boundaries beside the file. */
const FORM_OVERHEAD_BYTES = 64 * 1024;

export async function POST(request: NextRequest) {
  return handleApiRequest(
    request,
    async ({ ctx, runtime, form }) => {
      if (!runtime.mediaGraph) {
        throw new AppError('unsupported', 'WhatsApp is not set up on this server.');
      }
      const file = form?.get('file');
      if (!(file instanceof File)) {
        throw new AppError('validation_failed', 'Send the file as the form field `file`.', {
          issues: [{ path: 'file', message: 'Send the file as the form field `file`.' }],
        });
      }
      const from = form?.get('from');
      const media = await apiUploadMedia(
        {
          db: runtime.db,
          keyring: runtime.keyring,
          graph: runtime.mediaGraph,
          clock: runtime.clock,
        },
        ctx,
        { from: typeof from === 'string' && from !== '' ? from : undefined },
        { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) },
      );
      return { status: 201, body: { data: media } };
    },
    { multipartBytes: REPLY_FILE_MAX_BYTES + FORM_OVERHEAD_BYTES },
  );
}
