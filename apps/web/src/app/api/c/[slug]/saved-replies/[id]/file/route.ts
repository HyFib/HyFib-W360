import { isAppError } from '@w360/core';
import { REPLY_FILE_MAX_BYTES } from '@w360/domain';
import { getRuntime } from '@/server/runtime';
import { assertTrustedOrigin, requestMeta, requireTenant } from '@/server/session';
import { readLimitedBody } from '@/server/webhook-body';

export const dynamic = 'force-dynamic';

/** Room for the form's boundaries beside the file. */
const FORM_OVERHEAD_BYTES = 64 * 1024;

const answer = (status: number, body: { ok: boolean; message?: string }) =>
  Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } });

type Params = { params: Promise<{ slug: string; id: string }> };

/**
 * The file a saved reply carries (ADR-411), posted by Settings → Saved replies as multipart form
 * data, in place of any it had; DELETE takes it away. Under /api so that Next's proxy neither
 * buffers nor cuts a 16 MB body; only HyFib's own pages may post it (trusted origin), with the
 * member's session. The service checks `inbox.supervise`.
 */
export async function POST(request: Request, { params }: Params) {
  const { slug, id } = await params;
  try {
    await assertTrustedOrigin();
  } catch {
    return answer(403, { ok: false, message: 'Request origin not allowed.' });
  }
  const ctx = await requireTenant(slug);
  const { savedReplies } = await getRuntime();
  const type = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data;/i.test(type))
    return answer(415, { ok: false, message: 'Send the file as a form.' });
  const raw = await readLimitedBody(request, REPLY_FILE_MAX_BYTES + FORM_OVERHEAD_BYTES);
  if (!raw) return answer(413, { ok: false, message: 'Files are limited to 16 MB.' });
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(raw), {
      headers: { 'content-type': type },
    }).formData();
  } catch {
    return answer(400, { ok: false, message: 'The file could not be read. Choose it again.' });
  }
  const file = form.get('file');
  if (!(file instanceof File)) return answer(422, { ok: false, message: 'Choose a file.' });
  try {
    await savedReplies.attachSavedReplyFile(
      ctx,
      id,
      { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) },
      await requestMeta(),
    );
  } catch (error) {
    if (isAppError(error))
      return answer(error.httpStatus, { ok: false, message: error.publicMessage });
    throw error;
  }
  return answer(200, { ok: true });
}

export async function DELETE(_request: Request, { params }: Params) {
  const { slug, id } = await params;
  try {
    await assertTrustedOrigin();
  } catch {
    return answer(403, { ok: false, message: 'Request origin not allowed.' });
  }
  const ctx = await requireTenant(slug);
  const { savedReplies } = await getRuntime();
  try {
    await savedReplies.removeSavedReplyFile(ctx, id, await requestMeta());
  } catch (error) {
    if (isAppError(error))
      return answer(error.httpStatus, { ok: false, message: error.publicMessage });
    throw error;
  }
  return answer(200, { ok: true });
}
