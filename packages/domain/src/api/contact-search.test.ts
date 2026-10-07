import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { commerceStores, type Database, type Tx } from '@w360/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  apiContactSearchSchema,
  apiSearchContacts,
  apiSegmentConditions,
  apiUpdateMatchingContacts,
  apiUpdateMatchingContactsSchema,
  contactSearchSql,
  type ApiSearchCondition,
} from './contact-search';
import { apiCreateCampaign, apiUpdateCampaign } from './campaigns';
import type { ApiContext } from './context';
import { API_ROUTES, buildOpenApiDocument } from './openapi';
import { apiCreateSegment, apiUpdateSegment } from './segments';

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
    expect(search.description).toContain('or a campaign or store it does not have');
    expect(search.description).toContain('(`orders` and `spend`, which also need `orders.read`)');
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
      'orders',
      'spend',
      'group',
    ]);
  });
});

describe('groups of conditions in contact searches (ADR-164)', () => {
  const source = (value: string) => ({ type: 'source', source: value });
  const group = (match: string, conditions: unknown[]) => ({ type: 'group', match, conditions });

  it('takes groups of 1 to 20 conditions, each with its match, holding no groups, 20 conditions in all', () => {
    const parse = (conditions: unknown[]) => apiContactSearchSchema.safeParse({ conditions });
    expect(parse([isSet, group('any', [source('api'), source('import')])]).success).toBe(true);
    expect(parse([group('all', [isSet])]).success).toBe(true);
    // 20 conditions in all, counted inside groups too.
    expect(
      parse([...Array.from({ length: 10 }, () => isSet), group('any', Array(10).fill(isSet))])
        .success,
    ).toBe(true);
    const tooMany = parse([
      ...Array.from({ length: 11 }, () => isSet),
      group('any', Array(10).fill(isSet)),
    ]);
    expect(tooMany.success).toBe(false);
    expect(tooMany.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['conditions', 'At most 20 conditions in all, those in groups included.'],
    ]);
    // More than 20 items is refused once, by the list's own limit.
    expect(
      parse(Array.from({ length: 21 }, () => isSet)).error?.issues.map((i) => i.path.join('.')),
    ).toEqual(['conditions']);
    for (const conditions of [
      [group('any', [])],
      [group('any', Array(21).fill(isSet))],
      [group('some', [isSet])],
      [{ type: 'group', conditions: [isSet] }],
      [group('any', [group('all', [isSet])])],
      [{ ...group('any', [isSet]), extra: true }],
      [group('any', [{ ...isSet, extra: true }])],
    ]) {
      expect(parse(conditions).success, JSON.stringify(conditions)).toBe(false);
    }
  });

  it('looks inside groups for the scopes conditions need, before it reads anything', async () => {
    const lastMessage = { type: 'last_message', op: 'within_days', days: 7 };
    const campaign = { type: 'campaign', campaignId: TENANT, outcome: 'delivered' };
    const refused = async (scopes: string[], conditions: unknown[]) => {
      try {
        await apiSearchContacts({ db: untouched }, ctx(scopes), { conditions });
      } catch (error) {
        if (isAppError(error)) return error.publicMessage;
        throw error;
      }
      throw new Error('expected a refusal');
    };
    expect(await refused(['contacts.read'], [isSet, group('any', [isSet, lastMessage])])).toBe(
      'This API key does not have the conversations.read scope.',
    );
    expect(await refused(['contacts.read', 'conversations.read'], [group('all', [campaign])])).toBe(
      'This API key does not have the campaigns.read scope.',
    );
    const { db, reads } = reached();
    await expect(
      apiSearchContacts({ db }, ctx(['contacts.read', 'conversations.read', 'campaigns.read']), {
        conditions: [group('any', [lastMessage, campaign])],
      }),
    ).rejects.toThrow('reached the database');
    expect(reads).toHaveLength(1);
  });

  it('joins each group’s conditions by its match, inside the search’s match', () => {
    const render = (match: 'all' | 'any', items: Parameters<typeof contactSearchSql>[1]) =>
      new PgDialect().sqlToQuery(contactSearchSql(match, items, 'Asia/Kolkata', new Map()));
    const col = (name: string) => `"app"."contacts"."${name}"`;
    expect(
      render('any', [
        { type: 'source', source: 'api' },
        {
          match: 'all',
          conditions: [
            { type: 'source', source: 'import' },
            { type: 'calling_code', prefix: '91' },
          ],
        },
      ]),
    ).toMatchObject({
      sql: `(((${col('source')} = $1)) or ((${col('source')} = $2) and (${col('phone_e164')} like $3)))`,
      params: ['api', 'import', '+91%'],
    });
    expect(
      render('all', [
        {
          match: 'any',
          conditions: [
            { type: 'source', source: 'api' },
            { type: 'source', source: 'import' },
          ],
        },
        { type: 'calling_code', prefix: '971' },
      ]),
    ).toMatchObject({
      sql: `(((${col('source')} = $1) or (${col('source')} = $2)) and ((${col('phone_e164')} like $3)))`,
      params: ['api', 'import', '+971%'],
    });
  });

  it('is described: groups, their limit and the place of a refusal inside one', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, { description: string }>>;
      components: { schemas: Record<string, unknown> };
    };
    const description = doc.paths['/contacts/search']?.post?.description ?? '';
    for (const words of [
      'Conditions can also be put in groups a contact matches together',
      'a group holds conditions, not groups, and a search holds at most 20 conditions in all',
      '`conditions.2.conditions.0.key` in a group',
    ]) {
      expect(description).toContain(words);
    }
    const body = doc.components.schemas.ContactSearch as {
      properties: {
        conditions: {
          items: {
            oneOf: {
              properties: {
                type: { const: string };
                match?: { enum: string[] };
                conditions?: { minItems: number; maxItems: number; items: { oneOf: unknown[] } };
              };
              required: string[];
            }[];
          };
        };
      };
    };
    const groupShape = body.properties.conditions.items.oneOf.find(
      (o) => o.properties.type.const === 'group',
    );
    expect(groupShape?.required).toEqual(['type', 'match', 'conditions']);
    expect(groupShape?.properties.match?.enum).toEqual(['all', 'any']);
    expect(groupShape?.properties.conditions).toMatchObject({ minItems: 1, maxItems: 20 });
    expect(groupShape?.properties.conditions?.items.oneOf).toHaveLength(11);
  });
});

describe('changing the contacts a search finds (ADR-165)', () => {
  const vip = { addTags: ['vip'] };
  const body = (extra: Record<string, unknown> = {}) => ({
    conditions: [isSet],
    change: vip,
    ...extra,
  });

  it('takes a search’s conditions, a change of fields or tags, and a page of at most 100', () => {
    const parse = (input: unknown) => apiUpdateMatchingContactsSchema.safeParse(input);
    const parsed = parse(body());
    expect(parsed.success && [parsed.data.match, parsed.data.limit]).toEqual(['all', 50]);
    for (const input of [
      body({ limit: 100 }),
      body({ change: { removeTags: ['old'] } }),
      body({ change: { fields: { city: 'Pune' } } }),
      body({ change: { fields: { city: null }, addTags: ['a'], removeTags: ['b'] } }),
      body({ match: 'any', cursor: 'abc' }),
      body({ conditions: [{ type: 'group', match: 'any', conditions: [isSet, isSet] }] }),
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(true);
    }
    for (const input of [
      body({ limit: 101 }),
      body({ limit: 0 }),
      body({ change: {} }),
      body({ change: { name: 'Asha' } }),
      body({ change: { email: 'a@example.com' } }),
      // The same number for many contacts is never a change (ADR-188).
      body({ change: { phone: '+919876543210' } }),
      body({ change: { ...vip, extra: true } }),
      body({ conditions: [] }),
      body({ order: 'name' }),
      { conditions: [isSet] },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('needs contacts.read and contacts.write, and refuses a bad change, before it reads anything', async () => {
    const refused = async (scopes: string[], input: unknown, status = 'active') => {
      try {
        await apiUpdateMatchingContacts({ db: untouched }, ctx(scopes, status), input);
      } catch (error) {
        if (isAppError(error)) {
          return [error.code, error.publicMessage, (error.issues ?? []).map((i) => i.path)];
        }
        throw error;
      }
      throw new Error('expected a refusal');
    };
    expect(await refused(['contacts.write'], body())).toEqual([
      'forbidden',
      'This API key does not have the contacts.read scope.',
      [],
    ]);
    expect(await refused(['contacts.read'], body())).toEqual([
      'forbidden',
      'This API key does not have the contacts.write scope.',
      [],
    ]);
    expect((await refused(['contacts.read', 'contacts.write'], body(), 'suspended'))[0]).toBe(
      'tenant_suspended',
    );
    expect(
      (
        await refused(['contacts.read', 'contacts.write'], {
          conditions: [{ type: 'last_message', op: 'within_days', days: 7 }],
          change: vip,
        })
      )[1],
    ).toBe('This API key does not have the conversations.read scope.');
    expect(
      (
        await refused(['contacts.read', 'contacts.write'], body({ change: { addTags: ['a,b'] } }))
      )[2],
    ).toEqual(['change.addTags']);
    expect(
      (
        await refused(
          ['contacts.read', 'contacts.write'],
          body({ change: { addTags: ['vip'], removeTags: ['VIP'] } }),
        )
      )[2],
    ).toEqual(['change.removeTags']);
  });

  it('reads and changes the page in one transaction that sees one snapshot', async () => {
    const { db, reads } = reached();
    await expect(
      apiUpdateMatchingContacts({ db }, ctx(['contacts.read', 'contacts.write']), body()),
    ).rejects.toThrow('reached the database');
    expect(reads).toEqual([{ isolationLevel: 'repeatable read' }]);
  });

  it('is described: both scopes, pages of the search, the change, refusals and retries', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(API_ROUTES).toContainEqual(['post', '/contacts/update-matching']);
    const op = doc.paths['/contacts/update-matching']?.post as {
      operationId: string;
      description: string;
      requestBody: unknown;
      responses: Record<string, { content?: unknown }>;
    };
    expect(op.operationId).toBe('updateMatchingContacts');
    expect(op.requestBody).toEqual({
      required: true,
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/UpdateMatchingContacts' } },
      },
    });
    expect(op.responses['200']?.content).toEqual(
      (doc.paths['/contacts/search']?.post as { responses: Record<string, { content?: unknown }> })
        .responses['200']?.content,
    );
    expect(Object.keys(op.responses)).toEqual(
      expect.arrayContaining(['200', '403', '409', '422', '423', '429']),
    );
    for (const words of [
      'Scopes: `contacts.read` and `contacts.write`',
      'the same for every contact',
      'changes each of them as PATCH /contacts/{id} changes one',
      'send the same conditions and change with it until it is `null`',
      'a contact the change takes out of the search is not read again',
      '(422, naming the part, as `change.fields.plan`)',
      'the call can be refused as a whole (409, changing nothing): send it again with the same cursor',
      'a call sent again after a lost answer is safe without an `Idempotency-Key`',
      'A call counts as one request',
    ]) {
      expect(op.description).toContain(words);
    }
    const schema = doc.components.schemas.UpdateMatchingContacts as {
      properties: {
        change: { properties: Record<string, unknown>; additionalProperties: boolean };
        limit: { maximum: number; default: number };
      };
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(expect.arrayContaining(['conditions', 'change']));
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties.change.properties)).toEqual([
      'fields',
      'addTags',
      'removeTags',
    ]);
    expect(schema.properties.change.additionalProperties).toBe(false);
    expect([schema.properties.limit.maximum, schema.properties.limit.default]).toEqual([100, 50]);
  });
});

describe('conditions on store orders through the API (ADR-231)', () => {
  const orders = { type: 'orders', op: 'at_least', count: 2, days: 90 };
  const spend = { type: 'spend', op: 'at_least', currency: 'INR', amountMinor: 500_000 };
  const message = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (isAppError(error)) return error.publicMessage;
      throw error;
    }
    throw new Error('expected a refusal');
  };
  const NO_ORDERS = 'This API key does not have the orders.read scope.';

  it('takes them in a search, a segment and a campaign’s audience', () => {
    expect(
      apiContactSearchSchema.safeParse({
        conditions: [
          orders,
          spend,
          { type: 'orders', op: 'fewer_than', count: 1, storeId: TENANT },
          { type: 'group', match: 'any', conditions: [orders, spend] },
        ],
      }).success,
    ).toBe(true);
    for (const wrong of [
      { ...orders, count: 0 },
      { ...orders, op: 'more_than' },
      { ...spend, currency: 'inr' },
      { ...spend, amountMinor: '500' },
      { ...spend, extra: true },
    ]) {
      expect(apiContactSearchSchema.safeParse({ conditions: [wrong] }).success).toBe(false);
    }
  });

  it('needs orders.read for them, wherever a key gives them, before anything is read', async () => {
    expect(
      await message(
        apiSearchContacts({ db: untouched }, ctx(['contacts.read']), { conditions: [orders] }),
      ),
    ).toBe(NO_ORDERS);
    expect(
      await message(
        apiSearchContacts({ db: untouched }, ctx(['contacts.read']), {
          conditions: [{ type: 'group', match: 'all', conditions: [isSet, spend] }],
        }),
      ),
    ).toBe(NO_ORDERS);
    expect(
      await message(
        apiCreateSegment(
          { db: untouched, clock: { now: () => new Date() } },
          ctx(['campaigns.write']),
          {
            name: 'Buyers',
            definition: { conditions: [orders] },
          },
          null,
        ),
      ),
    ).toBe(NO_ORDERS);
    expect(
      await message(
        apiCreateCampaign(
          { db: untouched, clock: { now: () => new Date() } },
          ctx(['campaigns.write']),
          { name: 'Win back', audience: { conditions: [spend] } },
          null,
        ),
      ),
    ).toBe(NO_ORDERS);
    // With the scope, the search goes on to the database.
    const { db, reads } = reached();
    await expect(
      apiSearchContacts({ db }, ctx(['contacts.read', 'orders.read']), {
        conditions: [orders, spend],
      }),
    ).rejects.toThrow('reached the database');
    expect(reads).toHaveLength(1);
  });

  it('needs orders.read to change a segment or a draft’s audience to them', async () => {
    const deps = { db: untouched, clock: { now: () => new Date() } };
    const id = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03';
    expect(
      await message(
        apiUpdateSegment(deps, ctx(['campaigns.write']), id, {
          definition: { conditions: [spend] },
        }),
      ),
    ).toBe(NO_ORDERS);
    expect(
      await message(
        apiUpdateCampaign(deps, ctx(['campaigns.write']), id, {
          audience: { match: 'any', conditions: [isSet, orders] },
        }),
      ),
    ).toBe(NO_ORDERS);
  });

  it('refuses a store the company does not have and a currency HyFib does not know', async () => {
    const STORE = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
    /** A transaction whose reads find no custom fields and only these stores. */
    const txWith = (stores: string[]) =>
      ({
        select: () => ({
          from: (table: unknown) => ({
            where: async () => (table === commerceStores ? stores.map((s) => ({ id: s })) : []),
          }),
        }),
      }) as unknown as Tx;
    const given = apiContactSearchSchema.parse({
      conditions: [orders, { ...spend, storeId: STORE }],
    }).conditions as ApiSearchCondition[];
    const refusal = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error) {
        if (isAppError(error)) return [error.code, error.issues];
        throw error;
      }
      throw new Error('expected a refusal');
    };
    expect(
      await refusal(apiSegmentConditions(txWith([]), TENANT, given, 'definition.conditions')),
    ).toEqual([
      'validation_failed',
      [
        {
          path: 'definition.conditions.1.storeId',
          message: 'The company has no store with this id.',
        },
      ],
    ]);
    expect(
      await apiSegmentConditions(txWith([STORE]), TENANT, given, 'definition.conditions'),
    ).toEqual([orders, { ...spend, storeId: STORE }]);
    const unknown = apiContactSearchSchema.parse({ conditions: [{ ...spend, currency: 'XQZ' }] })
      .conditions as ApiSearchCondition[];
    expect(await refusal(apiSegmentConditions(txWith([]), TENANT, unknown, 'conditions'))).toEqual([
      'validation_failed',
      [
        {
          path: 'conditions.0.currency',
          message: 'Give an ISO 4217 currency code HyFib knows, like INR.',
        },
      ],
    ]);
  });
});
