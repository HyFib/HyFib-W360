import { isAppError } from '@w360/core';
import { REPLY_FILE_MAX_BYTES } from '@w360/domain';
import { getRuntime } from '@/server/runtime';
import { assertTrustedOrigin, requireTenant } from '@/server/session';
import { readLimitedBody } from '@/server/webhook-body';

export const dynamic = 'force-dynamic';

/** Room for the form's other fields and boundaries beside the file. */
const FORM_OVERHEAD_BYTES = 64 * 1024;

const answer = (status: number, body: { ok: boolean; message?: string; messageId?: string }) =>
  Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } });

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/**
 * A file a member sends in a conversation (ADR-218), posted by the conversation page as multipart
 * form data: uploaded to WhatsApp, then queued as a reply. Under /api so that Next's proxy does not
 * buffer (and cut) a body over its 10 MB; only HyFib's own pages may post it (trusted origin), with
 * the member's session.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; conversationId: string }> },
) {
  const { slug, conversationId } = await params;
  try {
    await assertTrustedOrigin();
  } catch {
    return answer(403, { ok: false, message: 'Request origin not allowed.' });
  }
  const ctx = await requireTenant(slug);
  const { fileReplies } = await getRuntime();
  if (!fileReplies)
    return answer(501, { ok: false, message: 'WhatsApp is not set up on this server.' });
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
  if (!(file instanceof File)) return answer(422, { ok: false, message: 'Choose a file to send.' });
  try {
    const sent = await fileReplies.queueFileReply(
      ctx,
      {
        conversationId,
        clientKey: field(form, 'clientKey'),
        caption: field(form, 'caption'),
        afterMessageId: field(form, 'afterMessageId'),
      },
      { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) },
    );
    return answer(200, { ok: true, messageId: sent.messageId });
  } catch (error) {
    if (isAppError(error))
      return answer(error.httpStatus, { ok: false, message: error.publicMessage });
    throw error;
  }
}
