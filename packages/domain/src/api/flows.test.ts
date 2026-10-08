import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { API_SCOPES, type Database, type SQL, type Tx } from '@w360/db';
import { ROLE_PERMISSIONS } from '../authz/permissions';
import { encodeKeysetCursor } from '../validation';
import type { ApiContext } from './context';
import {
  apiFlowResponseQuerySchema,
  apiFlowResponseSchema,
  apiFlowSchema,
  apiListFlowResponses,
  apiListFlows,
} from './flows';
import { API_SCOPE_INFO, API_SCOPE_KEYS } from './model';
import { API_ROUTES, buildOpenApiDocument } from './openapi';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const FLOW = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
const ACCOUNT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03';
const OTHER_ACCOUNT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f04';
const NUMBER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f05';
const OTHER_NUMBER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f06';
const RESPONSE = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f07';
const CONTACT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f08';
const CONVERSATION = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f09';
const MESSAGE = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f0a';
const CREATED = new Date('2026-10-01T09:00:00.000Z');
const UPDATED = new Date('2026-10-07T10:00:00.000Z');

const ctx = (scopes: string[], status = 'active', planScopes: string[] | null = null) =>
  ({
    tenant: { id: TENANT, status },
    key: { id: 'k', scopes: new Set(scopes) },
    planScopes: planScopes && new Set(planScopes),
  }) as unknown as ApiContext;

/** A database that fails the test if anything is read. */
const untouched = {
  run: () => {
    throw new Error('used the database');
  },
} as unknown as Database;

/** The code, message and paths of a refusal. */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return [error.code, error.publicMessage, (error.issues ?? []).map((i) => i.path)];
  }
  throw new Error('expected a refusal');
}

/** SQL as text with its parameters inline. */
const text = (query: SQL) => {
  const { sql, params } = new PgDialect().sqlToQuery(query);
  return sql.replace(/\$(\d+)/g, (_, n: string) => JSON.stringify(params[Number(n) - 1]));
};

/**
 * A database whose reads answer, in order, with `answers`, recording the transaction's options and
 * each read's conditions, order and limit. A read beyond them fails the test.
 */
function reading(answers: unknown[][]) {
  const queue = [...answers];
  type Read = { where: string; order?: string[]; limit?: number };
  const seen: { options?: unknown; reads: Read[] } = { reads: [] };
  const next = () => {
    const rows = queue.shift();
    if (!rows) throw new Error('an unexpected read');
    return rows;
  };
  const select = () => {
    const read: Read = { where: '' };
    seen.reads.push(read);
    const chain = {
      from: () => chain,
      where: (condition: SQL) => {
        read.where = text(condition);
        // Answered when awaited here; a read that goes on to its order and limit answers there.
        return {
          ...chain,
          then: (resolve: (rows: unknown[]) => void, reject: (error: unknown) => void) => {
            try {
              resolve(next());
            } catch (error) {
              reject(error);
            }
          },
        };
      },
      orderBy: (...order: SQL[]) => {
        read.order = order.map(text);
        return chain;
      },
      limit: (n: number) => {
        read.limit = n;
        return Promise.resolve(next());
      },
    };
    return chain;
  };
  const db = {
    run: (_scope: unknown, fn: (tx: Tx) => Promise<unknown>, options?: unknown) => {
      seen.options = options;
      return fn({ select } as unknown as Tx);
    },
  } as unknown as Database;
  return { db, seen, unread: () => queue.length };
}

const flow = (overrides: Record<string, unknown> = {}) => ({
  id: FLOW,
  whatsappAccountId: ACCOUNT,
  name: 'Lead form',
  metaStatus: 'PUBLISHED',
  categories: ['LEAD_GENERATION'],
  answerKeys: ['full_name', 'email'],
  answerMapping: [
    { key: 'full_name', target: 'name' },
    { key: 'email', target: 'email' },
  ],
  archivedAt: null,
  createdAt: CREATED,
  updatedAt: UPDATED,
  cursorAt: '2026-10-01T09:00:00.000123Z',
  ...overrides,
});

const numbers = [
  { id: NUMBER, phone: '+91 80 4567 8901', whatsappAccountId: ACCOUNT },
  { id: OTHER_NUMBER, phone: '+91 80 4567 8902', whatsappAccountId: OTHER_ACCOUNT },
];

const response = (overrides: Record<string, unknown> = {}) => ({
  id: RESPONSE,
  flowId: FLOW,
  contactId: CONTACT,
  conversationId: CONVERSATION,
  messageId: MESSAGE,
  answers: { full_name: 'Priya Sharma', email: 'priya@example.test' },
  applied: [
    { key: 'full_name', target: 'name', outcome: 'applied' },
    {
      key: 'email',
      target: 'email',
      outcome: 'invalid',
      message: 'The email address is not valid.',
    },
  ],
  receivedAt: UPDATED,
  cursorAt: '2026-10-07T10:00:00.000456Z',
  ...overrides,
});

describe('WhatsApp Flows and their responses through the API (ADR-298)', () => {
  it('need flows.read, a reading scope the database accepts, granted with the members’ flows.read', async () => {
    expect(API_SCOPES).toContain('flows.read');
    expect(API_SCOPE_KEYS.indexOf('flows.read')).toBe(
      API_SCOPE_KEYS.indexOf('automations.start') + 1,
    );
    expect(API_SCOPE_INFO['flows.read']).toMatchObject({
      label: 'Read flows',
      permission: 'flows.read',
      writes: false,
    });
    for (const words of [
      "List the company's WhatsApp Flows, the forms members send in chats, and the forms customers completed with them",
      'Who completed them and what they typed are given only to keys that also hold the scope that reads contacts',
    ]) {
      expect(API_SCOPE_INFO['flows.read'].description).toContain(words);
    }
    for (const role of ['owner', 'admin', 'marketer', 'analyst'] as const) {
      expect(ROLE_PERMISSIONS[role].has('flows.read')).toBe(true);
    }
    expect(ROLE_PERMISSIONS.agent.has('flows.read')).toBe(false);
    for (const read of [
      () => apiListFlows({ db: untouched }, ctx(['contacts.read']), {}),
      () => apiListFlowResponses({ db: untouched }, ctx(['contacts.read']), {}),
    ]) {
      expect(await refusal(read())).toEqual([
        'forbidden',
        'This API key does not have the flows.read scope.',
        [],
      ]);
    }
    const key = ctx(['flows.read']);
    for (const [read, path] of [
      [() => apiListFlows({ db: untouched }, key, { archived: 'yes' }), 'archived'],
      [() => apiListFlows({ db: untouched }, key, { status: 'published' }), ''],
      [() => apiListFlowResponses({ db: untouched }, key, { flowId: 'lead' }), 'flowId'],
      [() => apiListFlowResponses({ db: untouched }, key, { contactId: 'x' }), 'contactId'],
      [
        () => apiListFlowResponses({ db: untouched }, key, { receivedSince: 'yesterday' }),
        'receivedSince',
      ],
      [() => apiListFlowResponses({ db: untouched }, key, { limit: '0' }), 'limit'],
    ] as const) {
      const [code, , paths] = await refusal(read());
      expect(code).toBe('validation_failed');
      if (path) expect(paths).toContain(path);
    }
    expect(
      (await refusal(apiListFlowResponses({ db: untouched }, key, { cursor: 'nope' }))).slice(0, 2),
    ).toEqual(['validation_failed', 'Invalid cursor.']);
    expect(apiFlowResponseQuerySchema.parse({})).toEqual({ limit: 50 });
  });

  it('list the flows in use newest first on exact pages, read only, while suspended too, with their numbers', async () => {
    const page = reading([
      [
        flow(),
        flow({
          id: OTHER_ACCOUNT,
          whatsappAccountId: OTHER_ACCOUNT,
          metaStatus: null,
          cursorAt: 'x',
        }),
        flow(),
      ],
      numbers,
    ]);
    const result = await apiListFlows({ db: page.db }, ctx(['flows.read'], 'suspended'), {
      limit: '2',
    });
    expect(result.data).toEqual([
      {
        id: FLOW,
        name: 'Lead form',
        status: 'published',
        categories: ['LEAD_GENERATION'],
        answerKeys: ['full_name', 'email'],
        answerMapping: [
          { key: 'full_name', target: 'name' },
          { key: 'email', target: 'email' },
        ],
        channels: [{ id: NUMBER, phone: '+91 80 4567 8901' }],
        archived: false,
        createdAt: CREATED.toISOString(),
        updatedAt: UPDATED.toISOString(),
      },
      expect.objectContaining({
        id: OTHER_ACCOUNT,
        status: null,
        channels: [{ id: OTHER_NUMBER, phone: '+91 80 4567 8902' }],
      }),
    ]);
    for (const item of result.data) expect(apiFlowSchema.safeParse(item).success).toBe(true);
    expect(result.nextCursor).toBe(encodeKeysetCursor('x', OTHER_ACCOUNT));
    expect(page.seen.options).toEqual({ accessMode: 'read only' });
    const [flows, active] = page.seen.reads;
    expect(flows?.where).toBe(
      `("app"."flows"."tenant_id" = "${TENANT}" and "app"."flows"."archived_at" is null)`,
    );
    expect(flows?.order).toEqual(['"app"."flows"."created_at" desc', '"app"."flows"."id" desc']);
    expect(flows?.limit).toBe(3);
    expect(active?.where).toBe(
      `("app"."channel_accounts"."tenant_id" = "${TENANT}" and "app"."channel_accounts"."status" = "active")`,
    );
    expect(page.unread()).toBe(0);
    // Archived flows when asked, after a cursor; an empty page reads no numbers.
    const archived = reading([[]]);
    expect(
      await apiListFlows({ db: archived.db }, ctx(['flows.read']), {
        archived: 'true',
        cursor: encodeKeysetCursor('2026-10-01T09:00:00.000123Z', FLOW),
      }),
    ).toEqual({ data: [], nextCursor: null });
    expect(archived.seen.reads).toEqual([
      {
        where: `("app"."flows"."tenant_id" = "${TENANT}" and "app"."flows"."archived_at" is not null and ("app"."flows"."created_at", "app"."flows"."id") < ("2026-10-01T09:00:00.000123Z"::timestamptz, "${FLOW}"::uuid))`,
        order: ['"app"."flows"."created_at" desc', '"app"."flows"."id" desc'],
        limit: 51,
      },
    ]);
    // An exactly full page is the last; an archived flow says so.
    const full = reading([[flow({ archivedAt: UPDATED })], numbers]);
    const last = await apiListFlows({ db: full.db }, ctx(['flows.read']), {
      limit: '1',
      archived: 'false',
    });
    expect(last).toMatchObject({ data: [{ archived: true }], nextCursor: null });
  });

  it('list completed forms newest first on exact pages, by flow, contact and time, who and what only with contacts.read', async () => {
    const both = reading([
      [response(), response({ id: FLOW, flowId: null, cursorAt: 'y' }), response()],
    ]);
    const result = await apiListFlowResponses(
      { db: both.db },
      ctx(['flows.read', 'contacts.read'], 'restricted'),
      { limit: '2' },
    );
    expect(result.data[0]).toEqual({
      id: RESPONSE,
      flowId: FLOW,
      contactId: CONTACT,
      conversationId: CONVERSATION,
      messageId: MESSAGE,
      answers: { full_name: 'Priya Sharma', email: 'priya@example.test' },
      applied: [
        { key: 'full_name', target: 'name', outcome: 'applied', message: null },
        {
          key: 'email',
          target: 'email',
          outcome: 'invalid',
          message: 'The email address is not valid.',
        },
      ],
      receivedAt: UPDATED.toISOString(),
    });
    expect(result.data[1]).toMatchObject({ id: FLOW, flowId: null });
    for (const item of result.data)
      expect(apiFlowResponseSchema.safeParse(item).success).toBe(true);
    expect(result.nextCursor).toBe(encodeKeysetCursor('y', FLOW));
    expect(both.seen.options).toEqual({ accessMode: 'read only' });
    expect(both.seen.reads).toEqual([
      {
        where: `"app"."flow_responses"."tenant_id" = "${TENANT}"`,
        order: ['"app"."flow_responses"."received_at" desc', '"app"."flow_responses"."id" desc'],
        limit: 3,
      },
    ]);
    // Without contacts.read, in the key or the plan, who completed a form and what they typed stay
    // out, and the contact filter is refused before any query; the rest is the same.
    for (const key of [
      ctx(['flows.read']),
      ctx(['flows.read', 'contacts.read'], 'active', ['flows.read']),
    ]) {
      const without = reading([[response()]]);
      const plain = await apiListFlowResponses({ db: without.db }, key, {});
      expect(plain.data[0]).toEqual({
        ...result.data[0],
        contactId: null,
        conversationId: null,
        messageId: null,
        answers: null,
      });
      expect(apiFlowResponseSchema.safeParse(plain.data[0]).success).toBe(true);
      expect(plain.nextCursor).toBeNull();
      expect(
        await refusal(apiListFlowResponses({ db: untouched }, key, { contactId: CONTACT })),
      ).toEqual([
        'forbidden',
        key.planScopes
          ? "Your company's plan does not include the contacts.read scope. Ask HyFib to change the plan."
          : 'This API key does not have the contacts.read scope.',
        [],
      ]);
    }
    // Filters combine, after a cursor.
    const filtered = reading([[]]);
    await apiListFlowResponses({ db: filtered.db }, ctx(['flows.read', 'contacts.read']), {
      flowId: FLOW,
      contactId: CONTACT,
      receivedSince: '2026-10-01T00:00:00+05:30',
      cursor: encodeKeysetCursor('2026-10-07T10:00:00.000456Z', RESPONSE),
    });
    expect(filtered.seen.reads[0]?.where).toBe(
      `("app"."flow_responses"."tenant_id" = "${TENANT}" and "app"."flow_responses"."flow_id" = "${FLOW}" and "app"."flow_responses"."contact_id" = "${CONTACT}" and "app"."flow_responses"."received_at" >= "2026-10-01T00:00:00+05:30"::timestamptz and ("app"."flow_responses"."received_at", "app"."flow_responses"."id") < ("2026-10-07T10:00:00.000456Z"::timestamptz, "${RESPONSE}"::uuid))`,
    );
  });

  it('are described: the scope, the archived flows, who and what only with contacts.read', () => {
    for (const route of [
      ['get', '/flows'],
      ['get', '/flow-responses'],
    ]) {
      expect(API_ROUTES).toContainEqual(route);
    }
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<
        string,
        Record<
          string,
          { operationId: string; description: string; parameters: { name?: string }[] }
        >
      >;
      components: { schemas: Record<string, { required?: string[] }> };
    };
    const list = doc.paths['/flows']?.get;
    expect(list?.operationId).toBe('listFlows');
    for (const words of [
      'Scope: `flows.read`.',
      'those in use, or archived ones with `archived=true`',
      'Never the Flow JSON or its data endpoint.',
    ]) {
      expect(list?.description).toContain(words);
    }
    const responses = doc.paths['/flow-responses']?.get;
    expect(responses?.operationId).toBe('listFlowResponses');
    for (const words of [
      'newest first by when they were received',
      'Erasing a contact deletes its responses.',
      'and what they typed (`answers`) are given only to keys with `contacts.read` too',
      'other keys get null and may not filter by contact',
      'A form whose token matched no form HyFib sent has no flow (`flowId` null)',
    ]) {
      expect(responses?.description).toContain(words);
    }
    expect(responses?.parameters.map((p) => p.name).filter(Boolean)).toEqual(
      expect.arrayContaining(['flowId', 'contactId', 'receivedSince']),
    );
    expect(doc.components.schemas.FlowResponse?.required).toContain('answers');
    expect(doc.components.schemas.Flow?.required).toContain('answerMapping');
    // Answers are any JSON value, which the document names.
    const schemas = doc.components.schemas as Record<string, Record<string, unknown>>;
    expect((schemas.FlowResponse?.properties as Record<string, unknown>).answers).toMatchObject({
      anyOf: [
        { additionalProperties: { $ref: '#/components/schemas/JsonValue' } },
        { type: 'null' },
      ],
    });
    expect(schemas.JsonValue?.anyOf).toContainEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/JsonValue' },
    });
    const completed = {
      id: RESPONSE,
      flowId: FLOW,
      contactId: CONTACT,
      conversationId: CONVERSATION,
      messageId: MESSAGE,
      applied: [],
      receivedAt: UPDATED.toISOString(),
    };
    const nested = { chosen: ['a', 2, true, null, { files: [{ name: 'id.jpg' }] }], note: 'x' };
    expect(apiFlowResponseSchema.safeParse({ ...completed, answers: nested }).success).toBe(true);
    for (const answers of [
      { when: UPDATED },
      { n: Number.NaN },
      { list: [undefined] },
      { file: { size: Number.NaN } },
    ]) {
      expect(apiFlowResponseSchema.safeParse({ ...completed, answers }).success).toBe(false);
    }
  });
});
