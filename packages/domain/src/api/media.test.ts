import { describe, expect, it } from 'vitest';
import type { ApiContext } from './context';
import { apiUploadMedia, type ApiMediaDeps } from './media';
import { API_ROUTES, buildOpenApiDocument } from './openapi';
import { apiSendMediaSchema } from './resources';

const ctx = (scopes: string[]) =>
  ({
    tenant: { id: 't', status: 'active' },
    key: { id: 'k', scopes: new Set(scopes) },
    planScopes: null,
  }) as unknown as ApiContext;

/** Deps whose database and Graph fail the test if anything reaches them. */
const unreachable = {
  db: {
    run: () => {
      throw new Error('the database was reached');
    },
  },
  keyring: {},
  graph: {
    uploadMedia: () => {
      throw new Error('Graph was reached');
    },
  },
  clock: { now: () => new Date() },
} as unknown as ApiMediaDeps;

const pdf = { name: 'a.pdf', type: 'application/pdf', bytes: new Uint8Array([37, 80]) };
const MEDIA = '0192f3a4-5b6c-7d8e-9f00-112233445566';

describe('files keys upload and send by id (ADR-219)', () => {
  it('sends media from a link or an uploaded file, exactly one of them', () => {
    const base = { to: '+919800000001' };
    expect(
      apiSendMediaSchema.safeParse({ ...base, type: 'document', mediaId: MEDIA }).success,
    ).toBe(true);
    expect(apiSendMediaSchema.safeParse({ ...base, type: 'audio', mediaId: MEDIA }).success).toBe(
      true,
    );
    expect(
      apiSendMediaSchema.safeParse({
        ...base,
        type: 'image',
        link: 'https://cdn.example.com/a.jpg',
      }).success,
    ).toBe(true);
    const both = apiSendMediaSchema.safeParse({
      ...base,
      type: 'video',
      link: 'https://cdn.example.com/a.mp4',
      mediaId: MEDIA,
    });
    expect(both.success).toBe(false);
    expect(both.error?.issues[0]).toMatchObject({
      path: ['link'],
      message: 'Give the link to the media, or the id of a file you uploaded, but not both.',
    });
    expect(apiSendMediaSchema.safeParse({ ...base, type: 'document' }).success).toBe(false);
    expect(
      apiSendMediaSchema.safeParse({ ...base, type: 'document', mediaId: 'nope' }).success,
    ).toBe(false);
    // A sticker is never uploaded.
    expect(apiSendMediaSchema.safeParse({ ...base, type: 'sticker', mediaId: MEDIA }).success).toBe(
      false,
    );
  });

  it('refuses an upload without the scope, of another type or naming no number, before anything else', async () => {
    await expect(
      apiUploadMedia(unreachable, ctx(['contacts.read']), {}, pdf),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      apiUploadMedia(unreachable, ctx(['messages.reply']), {}, { ...pdf, type: 'image/svg+xml' }),
    ).rejects.toMatchObject({ code: 'validation_failed', issues: [{ path: 'file' }] });
    await expect(
      apiUploadMedia(unreachable, ctx(['messages.reply']), { from: 'not-a-number' }, pdf),
    ).rejects.toMatchObject({ code: 'validation_failed', issues: [{ path: 'from' }] });
  });

  it('describes POST /media, its form, its answer and the mediaId of a send', () => {
    expect(API_ROUTES).toEqual(expect.arrayContaining([['post', '/media']]));
    const doc = buildOpenApiDocument('https://app.example.com/api/v1') as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: {
        schemas: Record<
          string,
          { properties: Record<string, { description?: string }>; required?: string[] }
        >;
      };
    };
    const upload = doc.paths['/media']!.post as {
      operationId: string;
      description: string;
      requestBody: { content: Record<string, { schema: { required: string[] } }> };
      responses: Record<string, unknown>;
    };
    expect(upload.operationId).toBe('uploadMedia');
    expect(upload.description).toContain('Scope: `messages.reply`.');
    expect(upload.description).toContain('for 30 days');
    expect(upload.requestBody.content['multipart/form-data']?.schema.required).toEqual(['file']);
    expect(Object.keys(upload.responses)).toEqual(
      expect.arrayContaining(['201', '401', '403', '412', '413', '422', '429', '500', '503']),
    );
    const uploaded = doc.components.schemas.UploadedMedia!;
    expect(uploaded.required).toEqual([
      'id',
      'channelId',
      'type',
      'mimeType',
      'size',
      'fileName',
      'createdAt',
      'expiresAt',
    ]);
    expect(doc.components.schemas.SendDocument!.properties.mediaId?.description).toContain(
      'POST /media',
    );
  });
});
