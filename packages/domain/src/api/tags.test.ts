import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import type { Database } from '@w360/db';
import type { ApiContext } from './context';
import {
  API_ROUTES,
  apiContactTagSchema,
  apiConversationTagSchema,
  buildOpenApiDocument,
} from './openapi';
import {
  apiListContactTags,
  apiListConversationTags,
  apiTagListQuery,
  decodeTagCursor,
  encodeTagCursor,
} from './tags';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';

const ctx = (scopes: string[], status = 'active') =>
  ({
    tenant: { id: TENANT, status },
    key: { id: 'k', scopes: new Set(scopes) },
    planScopes: null,
  }) as unknown as ApiContext;

/** A database that fails the test if anything is read. */
const untouched = {
  run: () => {
    throw new Error('read the database');
  },
} as unknown as Database;

/** A database that records the options of the transaction it was asked for, then stops it. */
function reached() {
  const runs: unknown[] = [];
  const db = {
    run: (_scope: unknown, _fn: unknown, options?: unknown) => {
      runs.push(options);
      throw new Error('reached the database');
    },
  } as unknown as Database;
  return { db, runs };
}

/** The code, message and paths of a refusal. */
function refusalOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (!isAppError(error)) throw error;
    return [error.code, error.publicMessage, (error.issues ?? []).map((i) => i.path)];
  }
  throw new Error('expected a refusal');
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return [error.code, error.publicMessage, (error.issues ?? []).map((i) => i.path)];
  }
  throw new Error('expected a refusal');
}

describe('the tags in use through the API (ADR-272)', () => {
  it('take a page size, a cursor and a prefix written as tags are, nothing else', () => {
    expect(apiTagListQuery({})).toEqual({ limit: 50, after: null, prefix: null });
    expect(apiTagListQuery({ limit: '100', prefix: '  VIP   Gold ' })).toEqual({
      limit: 100,
      after: null,
      prefix: 'vip gold',
    });
    for (const limit of ['0', '101', 'ten']) {
      expect(refusalOf(() => apiTagListQuery({ limit }))[2], limit).toEqual(['limit']);
    }
    expect(refusalOf(() => apiTagListQuery({ prefix: 'vip,gold' }))).toEqual([
      'validation_failed',
      'Tags cannot contain commas or control characters.',
      ['prefix'],
    ]);
    expect(refusalOf(() => apiTagListQuery({ prefix: '   ' }))[2]).toEqual(['prefix']);
    expect(refusalOf(() => apiTagListQuery({ tag: 'vip' }))[0]).toBe('validation_failed');
  });

  it('continue after the last tag of a page, and refuse a cursor that is not a tag as written', () => {
    for (const tag of ['vip', 'new customer', 'pagó', 'ग्राहक']) {
      expect(decodeTagCursor(encodeTagCursor(tag))).toBe(tag);
      expect(apiTagListQuery({ cursor: encodeTagCursor(tag) }).after).toBe(tag);
    }
    expect(decodeTagCursor(undefined)).toBeNull();
    // Not written as tags are (upper case, two spaces, a comma, nothing), or not a cursor at all.
    for (const cursor of [
      encodeTagCursor('VIP'),
      encodeTagCursor('new  customer'),
      encodeTagCursor('a,b'),
      '',
      'x'.repeat(201),
    ]) {
      expect(refusalOf(() => apiTagListQuery({ cursor }))[2], cursor).toEqual(['cursor']);
    }
  });

  it('need contacts.read or conversations.read and refuse bad requests before reading anything', async () => {
    expect(
      await refusal(apiListContactTags({ db: untouched }, ctx(['conversations.read']), {})),
    ).toEqual(['forbidden', 'This API key does not have the contacts.read scope.', []]);
    expect(
      await refusal(apiListConversationTags({ db: untouched }, ctx(['contacts.read']), {})),
    ).toEqual(['forbidden', 'This API key does not have the conversations.read scope.', []]);
    expect(
      (
        await refusal(
          apiListContactTags({ db: untouched }, ctx(['contacts.read']), { prefix: 'a,b' }),
        )
      )[2],
    ).toEqual(['prefix']);
    expect(
      (
        await refusal(
          apiListConversationTags({ db: untouched }, ctx(['conversations.read']), {
            cursor: 'not a cursor',
          }),
        )
      )[2],
    ).toEqual(['cursor']);
  });

  it('read in a read-only transaction, while the company is suspended too', async () => {
    for (const status of ['active', 'suspended', 'restricted']) {
      const { db, runs } = reached();
      await expect(apiListContactTags({ db }, ctx(['contacts.read'], status), {})).rejects.toThrow(
        'reached the database',
      );
      await expect(
        apiListConversationTags({ db }, ctx(['conversations.read'], status), {}),
      ).rejects.toThrow('reached the database');
      expect(runs).toEqual([{ accessMode: 'read only' }, { accessMode: 'read only' }]);
    }
  });

  it('are described: the scopes, the order, the counts, the prefix and how pages continue', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: {
        schemas: Record<string, { properties: Record<string, unknown>; required: string[] }>;
      };
      info: { description: string };
    };
    expect(API_ROUTES).toEqual(
      expect.arrayContaining([
        ['get', '/contact-tags'],
        ['get', '/conversation-tags'],
      ]),
    );
    for (const [path, operationId, scope, item, words] of [
      [
        '/contact-tags',
        'listContactTags',
        'contacts.read',
        'ContactTag',
        '`GET /contacts` filters by',
      ],
      [
        '/conversation-tags',
        'listConversationTags',
        'conversations.read',
        'ConversationTag',
        'changes add and remove (`addTags`, `removeTags`)',
      ],
    ] as const) {
      const list = doc.paths[path]?.get as {
        operationId: string;
        description: string;
        parameters: { name?: string; schema?: { maxLength?: number } }[];
        responses: Record<string, unknown>;
      };
      expect(list.operationId).toBe(operationId);
      expect(list.parameters.map((p) => p.name)).toEqual(['limit', 'cursor', 'prefix']);
      expect(list.parameters[2]?.schema?.maxLength).toBe(100);
      expect(Object.keys(list.responses)).toEqual(
        expect.arrayContaining(['200', '401', '403', '422', '429']),
      );
      for (const expected of [
        `Scope: \`${scope}\`.`,
        'alphabetically, each with how many',
        'when the page is read',
        words,
        'any more is not listed',
        'paging never skips or repeats a tag that stays in use',
        'a tag first used meanwhile before the cursor is listed on the next pass',
      ]) {
        expect(list.description, expected).toContain(expected);
      }
      const schema = doc.components.schemas[item];
      expect(schema?.required).toEqual(Object.keys(schema?.properties ?? {}));
    }
    expect(Object.keys(doc.components.schemas.ContactTag?.properties ?? {})).toEqual([
      'tag',
      'contacts',
    ]);
    expect(Object.keys(doc.components.schemas.ConversationTag?.properties ?? {})).toEqual([
      'tag',
      'conversations',
    ]);
    expect(apiContactTagSchema.shape.contacts.description).toContain('erased contacts have none');
    expect(apiConversationTagSchema.shape.tag.description).toContain('lower case, single spaces');
    expect(doc.info.description).toContain('list the tags in use on contacts and conversations');
  });
});
