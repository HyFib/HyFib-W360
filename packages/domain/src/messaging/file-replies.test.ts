import { describe, expect, it } from 'vitest';
import {
  REPLY_FILE_MAX_BYTES,
  checkReplyFile,
  fileReplySchema,
  uploadFailure,
} from './file-replies';
import { GraphClient, MEDIA_UPLOAD_TIMEOUT_MS } from './graph';

const file = (type: string, size = 10) => ({
  name: 'f',
  type,
  bytes: new Uint8Array(size),
});

describe('files members send from the inbox (ADR-218)', () => {
  it('sends each allowed type as its kind of message, whatever its parameters', () => {
    expect(checkReplyFile(file('image/jpeg'))).toEqual({ kind: 'image', mimeType: 'image/jpeg' });
    expect(checkReplyFile(file('image/png'))).toEqual({ kind: 'image', mimeType: 'image/png' });
    expect(checkReplyFile(file('video/mp4'))).toEqual({ kind: 'video', mimeType: 'video/mp4' });
    expect(checkReplyFile(file('audio/ogg; codecs=opus'))).toEqual({
      kind: 'audio',
      mimeType: 'audio/ogg',
    });
    expect(checkReplyFile(file('Application/PDF'))).toEqual({
      kind: 'document',
      mimeType: 'application/pdf',
    });
    expect(
      checkReplyFile(file('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
        .kind,
    ).toBe('document');
    expect(checkReplyFile(file('application/pdf', REPLY_FILE_MAX_BYTES)).kind).toBe('document');
  });

  it('refuses an empty file, one over 16 MB, and any other type', () => {
    const refusal = (f: ReturnType<typeof file>) => {
      try {
        checkReplyFile(f);
      } catch (error) {
        return error as { code: string; publicMessage: string; issues: { path: string }[] };
      }
      throw new Error('accepted');
    };
    expect(refusal(file('application/pdf', 0))).toMatchObject({
      code: 'validation_failed',
      publicMessage: 'Choose a file to send.',
      issues: [{ path: 'file' }],
    });
    expect(refusal(file('application/pdf', REPLY_FILE_MAX_BYTES + 1)).publicMessage).toBe(
      'Files are limited to 16 MB.',
    );
    expect(REPLY_FILE_MAX_BYTES).toBe(16 * 1024 * 1024);
    for (const type of ['image/gif', 'image/svg+xml', 'text/html', 'image/webp', '', 'nonsense']) {
      expect(refusal(file(type)).publicMessage).toMatch(/^Send a JPEG or PNG photo/);
    }
  });

  it('trims the caption, drops an empty one and refuses a long one', () => {
    const base = { conversationId: '0192f3a4-5b6c-7d8e-9f00-112233445566', clientKey: 'file-1234' };
    expect(fileReplySchema.parse({ ...base, caption: '  Your invoice ' }).caption).toBe(
      'Your invoice',
    );
    expect(fileReplySchema.parse({ ...base, caption: '   ' }).caption).toBeUndefined();
    expect(fileReplySchema.safeParse({ ...base, caption: 'x'.repeat(1025) }).success).toBe(false);
    expect(fileReplySchema.safeParse({ ...base, clientKey: 'short' }).success).toBe(false);
  });

  it('tells the member why WhatsApp did not take the file', () => {
    expect(uploadFailure({ kind: 'auth', title: 'OAuthException' })).toMatchObject({
      code: 'precondition_failed',
      publicMessage: expect.stringContaining('Settings → Channels') as unknown as string,
    });
    expect(
      uploadFailure({ kind: 'permanent', title: 'x', detail: 'Media upload error' }),
    ).toMatchObject({
      code: 'provider_rejected',
      publicMessage: 'WhatsApp did not accept the file: Media upload error',
    });
    expect(uploadFailure({ kind: 'permanent', title: 'x' }).publicMessage).toBe(
      'WhatsApp did not accept the file.',
    );
    for (const kind of ['retryable', 'unknown'] as const) {
      expect(uploadFailure({ kind, title: 'x' })).toMatchObject({ code: 'provider_unavailable' });
    }
  });

  it('uploads with messaging_product and the file, typed, and reads the media id', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const graph = (answer: unknown) =>
      new GraphClient({
        baseUrl: 'https://graph.test',
        version: 'v26.0',
        fetchImpl: async (input, init) => {
          seen.push({ url: String(input), init: init ?? {} });
          return new Response(JSON.stringify(answer), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      });
    const bytes = new Uint8Array([37, 80, 68, 70]);
    expect(
      await graph({ id: '4490709327384033' }).uploadMedia('1234', 'tok', {
        filename: 'Invoice.pdf',
        contentType: 'application/pdf',
        bytes,
      }),
    ).toEqual({ ok: true, data: { mediaId: '4490709327384033' } });
    const [call] = seen;
    expect(call!.url).toBe('https://graph.test/v26.0/1234/media');
    expect(call!.init.method).toBe('POST');
    expect((call!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    const form = call!.init.body as FormData;
    expect([...form.keys()]).toEqual(['messaging_product', 'file']);
    expect(form.get('messaging_product')).toBe('whatsapp');
    const part = form.get('file') as File;
    expect(part.name).toBe('Invoice.pdf');
    expect(part.type).toBe('application/pdf');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes);
    expect(MEDIA_UPLOAD_TIMEOUT_MS).toBe(120_000);
    expect(
      await graph({}).uploadMedia('1234', 'tok', {
        filename: 'a',
        contentType: 'application/pdf',
        bytes,
      }),
    ).toMatchObject({ ok: false, title: 'unexpected_response_shape' });
  });

  it('gives an upload longer than the client’s limit for other calls', async () => {
    // Answers after 50 ms unless the request's signal aborts first.
    const slow = new GraphClient({
      baseUrl: 'https://graph.test',
      version: 'v26.0',
      timeoutMs: 5,
      fetchImpl: (_input, init) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ id: '1', url: 'https://m.example/f' }), {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                }),
              ),
            50,
          );
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(init.signal?.reason as Error);
          });
        }),
    });
    expect(await slow.getMedia('1', 'tok')).toMatchObject({ ok: false });
    expect(
      await slow.uploadMedia('1234', 'tok', {
        filename: 'a.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array([1]),
      }),
    ).toEqual({ ok: true, data: { mediaId: '1' } });
  });
});
