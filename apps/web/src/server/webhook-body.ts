import 'server-only';

/**
 * Reads a request body up to `limit` bytes without buffering more than that; returns null when the
 * declared or actual size exceeds the limit. Webhook signatures are computed over these raw bytes.
 */
export async function readLimitedBody(request: Request, limit: number): Promise<Buffer | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
