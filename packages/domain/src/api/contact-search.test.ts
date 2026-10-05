import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import type { Database } from '@w360/db';
import { apiContactSearchSchema, apiSearchContacts } from './contact-search';
import type { ApiContext } from './context';
import { API_ROUTES, buildOpenApiDocument } from './openapi';

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

/** A database that records the read it was asked for, then stops it. */
function reached() {
  const reads: { accessMode?: string; isolationLevel?: string }[] = [];
  const db = {
    run: (
      _scope: unknown,
      _fn: unknown,
      options: { accessMode?: string; isolationLevel?: string },
    ) => {
      reads.push(options);
      throw new Error('reached the database');
    },
  } as unknown as Database;
  return { db, reads };
}

/** The code and paths of a refusal. */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return { code: error.code, paths: (error.issues ?? []).map((i) => i.path) };
  }
  throw new Error('expected a refusal');
}

const isSet = { type: 'field', key: 'city', op: 'is_set' };

describe('contact searches through the API (ADR-117)', () => {
  it('takes 1 to 20 conditions, all or any of them (all by default), a limit and a cursor, nothing else', () => {
    const parsed = apiContactSearchSchema.parse({ conditions: [isSet] });
    expect([parsed.match, parsed.limit, parsed.cursor]).toEqual(['all', 50, undefined]);
    for (const body of [
      { conditions: [] },
      { conditions: Array.from({ length: 21 }, () => isSet) },
      { conditions: [isSet], match: 'some' },
      { conditions: [isSet], limit: 0 },
      { conditions: [isSet], limit: 101 },
      { conditions: [isSet], limit: 2.5 },
      { conditions: [isSet], order: 'name' },
      { conditions: [{ ...isSet, extra: true }] },
      { conditions: [{ type: 'field', key: 'city', op: 'resembles', value: 'x' }] },
      { conditions: [{ type: 'field', key: 'city', op: 'equals', value: true }] },
      { conditions: [{ type: 'field', key: 'city', op: 'equals', value: 'x'.repeat(201) }] },
      { conditions: [{ type: 'tag', op: 'has' }] },
      { conditions: [{ type: 'consent', purpose: 'marketing', status: 'unknown' }] },
      { conditions: [{ type: 'source', source: 'fax' }] },
      { conditions: [{ type: 'calling_code', prefix: '+91' }] },
      { conditions: [{ type: 'calling_code', prefix: '01' }] },
      { conditions: [{ type: 'last_message', op: 'within_days', days: 0 }] },
      { conditions: [{ type: 'last_message', op: 'within_days', days: 366 }] },
      { conditions: [{ type: 'last_message', op: 'within_days', days: 2.5 }] },
      { conditions: [{ type: 'last_message', op: 'within_days', days: '7' }] },
      { conditions: [{ type: 'last_message', op: 'since', days: 7 }] },
      { conditions: [{ type: 'last_message', op: 'within_days' }] },
      { conditions: [{ type: 'last_message', op: 'within_days', days: 7, extra: 1 }] },
      { conditions: [{ type: 'campaign', campaignId: 'c1', outcome: 'replied' }] },
      { conditions: [{ type: 'campaign', campaignId: TENANT, outcome: 'clicked' }] },
      { conditions: [{ type: 'campaign', campaignId: TENANT }] },
      { conditions: [{ type: 'campaign', outcome: 'read' }] },
      { conditions: [{ type: 'name', op: 'greater_than', value: 'a' }] },
      { conditions: [{ type: 'name', op: 'equals', value: 5 }] },
      { conditions: [{ type: 'name', op: 'equals', value: 'x'.repeat(201) }] },
      { conditions: [{ type: 'name', op: 'contains', value: 'a', key: 'city' }] },
      { conditions: [{ type: 'name', value: 'a' }] },
    ]) {
      expect(apiContactSearchSchema.safeParse(body).success).toBe(false);
    }
    expect(
      apiContactSearchSchema.safeParse({
        match: 'any',
        limit: 100,
        cursor: 'abc',
        conditions: [
          { type: 'field', key: 'orders', op: 'greater_than', value: 3 },
          { type: 'field', key: 'orders', op: 'less_than', value: '3.5' },
          { type: 'name', op: 'contains', value: 'x'.repeat(200) },
          ...['is_set', 'is_not_set'].map((op) => ({ type: 'name', op })),
          ...['equals', 'not_equals'].map((op) => ({ type: 'name', op, value: 'Asha' })),
          { type: 'tag', op: 'not_has', tag: 'vip' },
          { type: 'consent', purpose: 'utility', status: 'not_recorded' },
          { type: 'created', op: 'after', date: '2026-01-01' },
          { type: 'source', source: 'store' },
          { type: 'calling_code', prefix: '971' },
          { type: 'last_message', op: 'within_days', days: 1 },
          { type: 'last_message', op: 'not_within_days', days: 365 },
          ...['delivered', 'not_delivered', 'read', 'replied', 'not_replied'].map((outcome) => ({
            type: 'campaign',
            campaignId: TENANT,
            outcome,
          })),
        ],
      }).success,
    ).toBe(true);
  });

  it('needs contacts.read, and refuses a bad body or cursor, before it reads anything', async () => {
    expect(
      (await refusal(apiSearchContacts({ db: untouched }, ctx(['contacts.write']), {}))).code,
    ).toBe('forbidden');
    expect(
      await refusal(
        apiSearchContacts({ db: untouched }, ctx(['contacts.read']), { conditions: [] }),
      ),
    ).toEqual({ code: 'validation_failed', paths: ['conditions'] });
    expect(
      await refusal(
        apiSearchContacts({ db: untouched }, ctx(['contacts.read']), {
          conditions: [isSet],
          cursor: 'not-a-cursor',
        }),
      ),
    ).toMatchObject({ code: 'validation_failed' });
  });

  it('needs conversations.read for a last_message condition and campaigns.read for a campaign one, before it reads anything (ADR-126)', async () => {
    const lastMessage = { type: 'last_message', op: 'within_days', days: 7 };
    const campaign = { type: 'campaign', campaignId: TENANT, outcome: 'delivered' };
    const refused = async (scopes: string[], conditions: unknown[]) => {
      try {
        await apiSearchContacts({ db: untouched }, ctx(scopes), { conditions });
      } catch (error) {
        if (isAppError(error)) return [error.code, error.publicMessage];
        throw error;
      }
      throw new Error('expected a refusal');
    };
    expect(await refused(['contacts.read'], [isSet, lastMessage])).toEqual([
      'forbidden',
      'This API key does not have the conversations.read scope.',
    ]);
    expect(await refused(['contacts.read', 'conversations.read'], [campaign])).toEqual([
      'forbidden',
      'This API key does not have the campaigns.read scope.',
    ]);
    expect(await refused(['conversations.read', 'campaigns.read'], [lastMessage])).toEqual([
      'forbidden',
      'This API key does not have the contacts.read scope.',
    ]);
    // With the scopes, the search goes on to the database.
    for (const [scopes, conditions] of [
      [['contacts.read', 'conversations.read'], [lastMessage]],
      [
        ['contacts.read', 'campaigns.read'],
        [campaign, isSet],
      ],
      [
        ['contacts.read', 'conversations.read', 'campaigns.read'],
        [lastMessage, campaign],
      ],
    ] as const) {
      const { db, reads } = reached();
      await expect(
        apiSearchContacts({ db }, ctx([...scopes]), { conditions: [...conditions] }),
      ).rejects.toThrow('reached the database');
      expect(reads).toHaveLength(1);
    }
  });

  it('reads for suspended and restricted companies too, in one read-only snapshot', async () => {
    for (const status of ['active', 'suspended', 'restricted']) {
      const { db, reads } = reached();
      await expect(
        apiSearchContacts({ db }, ctx(['contacts.read'], status), { conditions: [isSet] }),
      ).rejects.toThrow('reached the database');
      expect(reads).toEqual([{ isolationLevel: 'repeatable read', accessMode: 'read only' }]);
    }
  });

  it('is described: the scope, segments’ conditions, the windows and the body', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(API_ROUTES).toContainEqual(['post', '/contacts/search']);
    const search = doc.paths['/contacts/search']?.post as {
      operationId: string;
      description: string;
      requestBody: unknown;
      responses: Record<string, unknown>;
    };
    expect(search.operationId).toBe('searchContacts');
    expect(search.description).toContain('`contacts.read`');
    expect(search.description).toContain("segments' conditions");
    expect(search.description).toContain("comparisons: the contact's name, custom field values");
    expect(search.description).toContain('at most 2,000 of the company');
    expect(search.description).toContain('like `conditions.1.key`');
    expect(search.description).toContain('(`last_message`, which also needs `conversations.read`)');
    expect(search.description).toContain('(`campaign`, which also needs `campaigns.read`)');
    expect(search.description).toContain('or a campaign it does not have');
    expect(search.description).toContain('no `Idempotency-Key` is needed');
    expect(search.requestBody).toEqual({
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ContactSearch' } } },
    });
    expect(Object.keys(search.responses)).toEqual(
      expect.arrayContaining(['200', '400', '401', '403', '415', '422', '429', '500']),
    );
    const body = doc.components.schemas.ContactSearch as {
      properties: {
        conditions: { items: { oneOf: { properties: { type: { const: string } } }[] } };
      };
      additionalProperties: boolean;
    };
    expect(body.additionalProperties).toBe(false);
    expect(body.properties.conditions.items.oneOf.map((c) => c.properties.type.const)).toEqual([
      'field',
      'name',
      'tag',
      'consent',
      'created',
      'source',
      'calling_code',
      'last_message',
      'campaign',
    ]);
  });
});
