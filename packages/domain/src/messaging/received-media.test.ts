import { describe, expect, it } from 'vitest';
import { API_ROUTES, buildOpenApiDocument } from '../api/openapi';
import { GraphClient } from './graph';
import {
  MEDIA_MAX_BYTES,
  baseMediaType,
  contentDisposition,
  limitedStream,
  mediaDownloadFailure,
  mediaFilename,
  mediaLocationFailure,
  mediaPresentation,
} from './received-media';

const MESSAGE = '0192f3a4-5b6c-7d8e-9f00-112233445566';

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const streamOf = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

describe('how a file a customer sent reaches the browser (ADR-216)', () => {
  it('reads the type without its parameters, and nothing that is not a type', () => {
    expect(baseMediaType('audio/ogg; codecs=opus')).toBe('audio/ogg');
    expect(baseMediaType(' Image/JPEG ')).toBe('image/jpeg');
    expect(baseMediaType('not a type')).toBeNull();
    expect(baseMediaType('text/html\r\nx-injected: 1')).toBeNull();
    expect(baseMediaType(null)).toBeNull();
  });

  it('shows photos, stickers, recordings and videos in the page, and downloads every other file', () => {
    expect(mediaPresentation('image/jpeg')).toEqual({
      contentType: 'image/jpeg',
      disposition: 'inline',
    });
    expect(mediaPresentation('image/webp')).toEqual({
      contentType: 'image/webp',
      disposition: 'inline',
    });
    expect(mediaPresentation('audio/ogg; codecs=opus')).toEqual({
      contentType: 'audio/ogg',
      disposition: 'inline',
    });
    expect(mediaPresentation('video/mp4')).toEqual({
      contentType: 'video/mp4',
      disposition: 'inline',
    });
    // A document, and anything a browser could run as a page or a script, is a plain download.
    for (const type of ['application/pdf', 'image/svg+xml', 'text/html', 'text/plain', null]) {
      expect(mediaPresentation(type)).toEqual({
        contentType: 'application/octet-stream',
        disposition: 'attachment',
      });
    }
  });

  it('keeps the name a document came with, without what a file name or a header cannot hold', () => {
    const named = (filename: string | null, mimeType: string | null = 'application/pdf') =>
      mediaFilename({ type: 'document', mimeType, filename, messageId: MESSAGE });
    expect(named('Invoice March.pdf')).toBe('Invoice March.pdf');
    expect(named('Facture été 2026.pdf')).toBe('Facture été 2026.pdf');
    expect(named('../../etc/passwd')).toBe('etc passwd');
    expect(named('a"b\r\nc\u0000d<e>.pdf')).toBe('a b c d e .pdf');
    expect(named('...hidden')).toBe('hidden');
    expect(Array.from(named('é'.repeat(200)))).toHaveLength(150);
    // Without a name: the kind of file, the message and the extension of its type.
    expect(named(null)).toBe('whatsapp-document-0192f3a4.pdf');
    expect(named('  / ')).toBe('whatsapp-document-0192f3a4.pdf');
    expect(named(null, 'application/x-unknown')).toBe('whatsapp-document-0192f3a4');
    expect(
      mediaFilename({
        type: 'audio',
        mimeType: 'audio/ogg; codecs=opus',
        filename: null,
        messageId: MESSAGE,
      }),
    ).toBe('whatsapp-audio-0192f3a4.ogg');
  });

  it('names the file in the header in ASCII and in UTF-8', () => {
    expect(contentDisposition('attachment', 'Invoice March.pdf')).toBe(
      `attachment; filename="Invoice March.pdf"; filename*=UTF-8''Invoice%20March.pdf`,
    );
    expect(contentDisposition('inline', 'Facture été (1).pdf')).toBe(
      `inline; filename="Facture _t_ (1).pdf"; filename*=UTF-8''Facture%20%C3%A9t%C3%A9%20%281%29.pdf`,
    );
    expect(contentDisposition('attachment', 'a%b\\c')).toBe(
      `attachment; filename="a_b_c"; filename*=UTF-8''a%25b%5Cc`,
    );
  });

  it('passes a file on whole up to the limit, and fails the stream past it', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    expect([
      ...(await readAll(limitedStream(streamOf(bytes.slice(0, 2), bytes.slice(2)), 5))),
    ]).toEqual([1, 2, 3, 4, 5]);
    await expect(readAll(limitedStream(streamOf(bytes, new Uint8Array([6])), 5))).rejects.toThrow(
      'larger than HyFib passes on',
    );
    expect(MEDIA_MAX_BYTES).toBe(100 * 1024 * 1024);
  });

  it('tells the member why a file could not be fetched', () => {
    expect(mediaLocationFailure('auth')).toMatchObject({
      code: 'precondition_failed',
      publicMessage: expect.stringContaining('Settings → Channels') as unknown as string,
    });
    expect(mediaLocationFailure('permanent')).toMatchObject({
      code: 'not_found',
      publicMessage:
        'WhatsApp no longer gives this file. It keeps the files customers send for a limited time.',
    });
    for (const kind of ['retryable', 'unknown'] as const) {
      expect(mediaLocationFailure(kind)).toMatchObject({ code: 'provider_unavailable' });
    }
    expect(mediaDownloadFailure({ ok: false, kind: 'auth', title: 'HTTP 401' })).toMatchObject({
      code: 'precondition_failed',
    });
    expect(
      mediaDownloadFailure({ ok: false, kind: 'permanent', title: 'unusable_media_url' }),
    ).toMatchObject({ code: 'provider_unavailable' });
  });
});

describe('the Graph client’s media calls (research M-047)', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = (respond: (url: string) => Response) =>
    new GraphClient({
      baseUrl: 'http://127.0.0.1:4010',
      version: 'v26.0',
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({ url, init: init ?? {} });
        return respond(url);
      },
    });
  const answer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('reads where to download a file, its type and its size given as text or as a number', async () => {
    calls.length = 0;
    const graph = client(() =>
      answer({
        messaging_product: 'whatsapp',
        url: 'https://media.example/file?id=1',
        mime_type: 'image/jpeg',
        sha256: 'abc',
        file_size: '303833',
        id: '2621233374848975',
      }),
    );
    expect(await graph.getMedia('2621233374848975', 'tok')).toEqual({
      ok: true,
      data: { url: 'https://media.example/file?id=1', mimeType: 'image/jpeg', fileSize: 303833 },
    });
    expect(calls[0]!.url).toBe('http://127.0.0.1:4010/v26.0/2621233374848975');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    const numeric = client(() => answer({ url: 'https://media.example/f', file_size: 12 }));
    expect(await numeric.getMedia('1', 'tok')).toMatchObject({
      ok: true,
      data: { fileSize: 12, mimeType: null },
    });
    const without = client(() => answer({ mime_type: 'image/jpeg' }));
    expect(await without.getMedia('1', 'tok')).toMatchObject({
      ok: false,
      title: 'unexpected_response_shape',
    });
    const gone = client(() =>
      answer({ error: { message: 'Unsupported get request.', code: 100 } }, 400),
    );
    expect(await gone.getMedia('1', 'tok')).toMatchObject({ ok: false, kind: 'permanent' });
  });

  it('sends the token only to an https address or the Graph origin itself, without redirects', async () => {
    calls.length = 0;
    const graph = client(
      () =>
        new Response('file', {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': '4' },
        }),
    );
    for (const url of [
      'http://media.example/file',
      'https://user:pass@media.example/file',
      'https://user@media.example/file',
      'not a url',
      'ftp://127.0.0.1:4010/file',
    ]) {
      expect(await graph.downloadMedia(url, 'tok')).toEqual({
        ok: false,
        kind: 'permanent',
        title: 'unusable_media_url',
      });
    }
    expect(calls).toHaveLength(0);

    const https = await graph.downloadMedia('https://media.example/file?id=1', 'tok');
    expect(https).toMatchObject({ ok: true, contentLength: 4 });
    if (https.ok) expect(Buffer.from(await readAll(https.body)).toString()).toBe('file');
    expect(calls[0]!.init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(calls[0]!.init.headers).toEqual({
      authorization: 'Bearer tok',
      'user-agent': 'HyFib-W360/1.0.0',
    });
    // The stand-in answers on the configured Graph origin, over http.
    expect(await graph.downloadMedia('http://127.0.0.1:4010/__media/1', 'tok')).toMatchObject({
      ok: true,
    });
  });

  it('classifies a failed download, an error page included', async () => {
    const failing = (status: number, type = 'text/plain') =>
      client(() => new Response('no', { status, headers: { 'content-type': type } }));
    expect(await failing(401).downloadMedia('https://m.example/f', 't')).toMatchObject({
      ok: false,
      kind: 'auth',
      httpStatus: 401,
    });
    expect(await failing(503).downloadMedia('https://m.example/f', 't')).toMatchObject({
      kind: 'retryable',
    });
    expect(await failing(429).downloadMedia('https://m.example/f', 't')).toMatchObject({
      kind: 'retryable',
    });
    expect(await failing(404).downloadMedia('https://m.example/f', 't')).toMatchObject({
      kind: 'permanent',
    });
    expect(
      await failing(200, 'text/html; charset=utf-8').downloadMedia('https://m.example/f', 't'),
    ).toMatchObject({ ok: false, kind: 'permanent', title: 'not_a_file' });
    const unanswered = new GraphClient({
      baseUrl: 'https://graph.test',
      version: 'v26.0',
      fetchImpl: async () => {
        throw Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } });
      },
    });
    expect(await unanswered.downloadMedia('https://m.example/f', 't')).toMatchObject({
      ok: false,
      kind: 'retryable',
    });
  });
});

describe('files customers send, through the API (ADR-217)', () => {
  it('names the reason of each refusal for the API', () => {
    expect(mediaLocationFailure('auth').details).toEqual({ apiReason: 'access_refused' });
    expect(mediaLocationFailure('permanent').details).toEqual({ apiReason: 'file_expired' });
    expect(mediaLocationFailure('retryable').details).toBeUndefined();
    expect(mediaDownloadFailure({ ok: false, kind: 'auth', title: 'HTTP 401' }).details).toEqual({
      apiReason: 'access_refused',
    });
  });

  it('describes GET /messages/{id}/media: the scope, the file and the reasons', () => {
    expect(API_ROUTES).toEqual(expect.arrayContaining([['get', '/messages/{id}/media']]));
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const operation = (
      doc.paths as unknown as Record<
        string,
        Record<
          string,
          {
            operationId: string;
            description: string;
            responses: Record<string, { description: string; content: Record<string, unknown> }>;
          }
        >
      >
    )['/messages/{id}/media']!.get!;
    expect(operation.operationId).toBe('getMessageMedia');
    expect(operation.description).toContain('Scope: `conversations.read`.');
    expect(operation.description).toContain('HyFib keeps no copy');
    expect(Object.keys(operation.responses['200']!.content)).toEqual(['application/octet-stream']);
    expect(operation.responses['404']!.description).toMatch(/no_file.*file_expired/);
    expect(operation.responses['412']!.description).toMatch(
      /channel_disconnected.*access_refused.*file_too_large/,
    );
    expect(Object.keys(operation.responses)).toEqual(
      expect.arrayContaining(['401', '403', '429', '500', '503']),
    );
  });
});
