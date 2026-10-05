import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { and, type Database } from '@w360/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { ApiContext } from './context';
import {
  apiUpdateMatchingConversations,
  apiUpdateMatchingConversationsSchema,
  conversationFilterSql,
} from './conversations';
import { API_LIMITS } from './model';
import { API_ROUTES, buildOpenApiDocument } from './openapi';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const OTHER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
const THIRD = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03';

const ctx = (scopes: string[], status = 'active') =>
  ({
    tenant: { id: TENANT, status },
    key: { id: 'k', scopes: new Set(scopes) },
    planScopes: null,
  }) as unknown as ApiContext;

const both = ['conversations.read', 'conversations.write'];

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

const deps = (db: Database) => ({ db, clock: { now: () => new Date() } });

describe('changing the conversations a filter finds (ADR-166)', () => {
  const resolve = { status: 'resolved' };
  const body = (extra: Record<string, unknown> = {}) => ({
    filter: { status: 'open' },
    change: resolve,
    ...extra,
  });

  it('takes GET /conversations’ filters, at least one, a change, and a page of at most 100', () => {
    expect(API_LIMITS.conversationsPerChange).toBe(100);
    const parse = (input: unknown) => apiUpdateMatchingConversationsSchema.safeParse(input);
    const parsed = parse(body());
    expect(parsed.success && [parsed.data.limit, parsed.data.cursor]).toEqual([50, undefined]);
    for (const input of [
      body({ limit: 100, cursor: 'abc' }),
      body({ limit: 1 }),
      body({ filter: { assigneeId: 'none' } }),
      body({ filter: { teamId: 'none', channelId: TENANT } }),
      body({ filter: { assigneeId: OTHER, teamId: THIRD, contactId: TENANT } }),
      body({ filter: { updatedSince: '2026-10-01T00:00:00+05:30' } }),
      body({ filter: { status: 'pending' } }),
      body({ change: { assigneeId: null } }),
      body({ change: { teamId: OTHER, assigneeId: THIRD, status: 'open' } }),
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(true);
    }
    for (const input of [
      body({ filter: {} }),
      body({ filter: { status: undefined } }),
      body({ filter: undefined }),
      body({ filter: { status: 'closed' } }),
      body({ filter: { assigneeId: 'nobody' } }),
      body({ filter: { contactId: 'not-a-uuid' } }),
      body({ filter: { updatedSince: 'yesterday' } }),
      body({ filter: { status: 'open', limit: 5 } }),
      body({ filter: { status: 'open', direction: 'inbound' } }),
      body({ change: {} }),
      body({ change: { status: 'pending' } }),
      body({ change: { assigneeId: 'none' } }),
      body({ change: { ...resolve, note: 'Closing' } }),
      body({ change: undefined }),
      body({ limit: 101 }),
      body({ limit: 0 }),
      body({ limit: 2.5 }),
      body({ limit: '50' }),
      body({ conversationIds: [TENANT] }),
      { filter: { status: 'open' }, status: 'resolved' },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('needs conversations.read and conversations.write, and refuses a bad body, before it reads anything', async () => {
    const refused = async (scopes: string[], input: unknown, status = 'active') => {
      try {
        await apiUpdateMatchingConversations(deps(untouched), ctx(scopes, status), input);
      } catch (error) {
        if (isAppError(error)) {
          return [error.code, error.publicMessage, (error.issues ?? []).map((i) => i.path)];
        }
        throw error;
      }
      throw new Error('expected a refusal');
    };
    expect(await refused(['conversations.write'], body())).toEqual([
      'forbidden',
      'This API key does not have the conversations.read scope.',
      [],
    ]);
    expect(await refused(['conversations.read'], body())).toEqual([
      'forbidden',
      'This API key does not have the conversations.write scope.',
      [],
    ]);
    for (const status of ['suspended', 'restricted']) {
      expect((await refused(both, body(), status))[0]).toBe('tenant_suspended');
    }
    expect((await refused(both, body({ filter: {} })))[2]).toEqual(['filter']);
    expect((await refused(both, body({ change: {} })))[2]).toEqual(['change']);
    expect((await refused(both, body({ change: { teamId: 'sales' } })))[2]).toEqual([
      'change.teamId',
    ]);
    expect((await refused(both, body({ limit: 101 })))[2]).toEqual(['limit']);
    expect((await refused(both, body({ cursor: 'not a cursor' })))[0]).toBe('validation_failed');
  });

  it('reads and changes the page in one read committed transaction', async () => {
    const { db, runs } = reached();
    await expect(apiUpdateMatchingConversations(deps(db), ctx(both), body())).rejects.toThrow(
      'reached the database',
    );
    expect(runs).toEqual([undefined]);
  });

  it('filters as GET /conversations does, in the company, when the page is read and when its rows are locked', () => {
    const render = (filter: Parameters<typeof conversationFilterSql>[1]) => {
      const query = new PgDialect().sqlToQuery(
        and(...conversationFilterSql(TENANT, filter)) ?? conversationFilterSql(TENANT, filter)[0]!,
      );
      return [query.sql, query.params];
    };
    expect(render({})).toEqual([`"app"."conversations"."tenant_id" = $1`, [TENANT]]);
    expect(
      render({
        status: 'open',
        contactId: OTHER,
        channelId: THIRD,
        assigneeId: 'none',
        teamId: OTHER,
        updatedSince: '2026-10-01T00:00:00Z',
      }),
    ).toEqual([
      [
        `("app"."conversations"."tenant_id" = $1`,
        `"app"."conversations"."status" = $2`,
        `"app"."conversations"."contact_id" = $3`,
        `"app"."conversations"."channel_account_id" = $4`,
        `"app"."conversations"."assigned_membership_id" is null`,
        `"app"."conversations"."team_id" = $5`,
        `"app"."conversations"."updated_at" >= $6::timestamptz)`,
      ].join(' and '),
      [TENANT, 'open', OTHER, THIRD, OTHER, '2026-10-01T00:00:00Z'],
    ]);
    expect(render({ assigneeId: THIRD, teamId: 'none' })).toEqual([
      [
        `("app"."conversations"."tenant_id" = $1`,
        `"app"."conversations"."assigned_membership_id" = $2`,
        `"app"."conversations"."team_id" is null)`,
      ].join(' and '),
      [TENANT, THIRD],
    ]);
  });

  it('is described: both scopes, pages of the list, the change, refusals and retries', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(API_ROUTES).toContainEqual(['post', '/conversations/update-matching']);
    const op = doc.paths['/conversations/update-matching']?.post as {
      operationId: string;
      description: string;
      requestBody: unknown;
      responses: Record<string, { content?: unknown }>;
    };
    expect(op.operationId).toBe('updateMatchingConversations');
    expect(op.requestBody).toEqual({
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/UpdateMatchingConversations' },
        },
      },
    });
    expect(op.responses['200']?.content).toEqual(
      (doc.paths['/conversations']?.get as { responses: Record<string, { content?: unknown }> })
        .responses['200']?.content,
    );
    expect(Object.keys(op.responses)).toEqual(
      expect.arrayContaining(['200', '403', '409', '422', '423', '429']),
    );
    expect(Object.keys(op.responses)).not.toContain('404');
    for (const words of [
      'Scopes: `conversations.read` and `conversations.write`',
      'the same for every conversation',
      'changes each of them as PATCH /conversations/{id} changes one',
      'send the same filter and change with it until it is `null`',
      'a conversation the change takes out of the filter is not read again',
      'a page can hold fewer conversations than the limit while more follow',
      '(422, naming the field, as `change.teamId`), even when no conversation matches',
      'it can be refused as a whole (409, changing nothing): send it again with the same cursor',
      'a call sent again after a lost answer is safe without an `Idempotency-Key`',
      'A call counts as one request',
    ]) {
      expect(op.description).toContain(words);
    }
    const schema = doc.components.schemas.UpdateMatchingConversations as {
      properties: {
        filter: { properties: Record<string, unknown>; additionalProperties: boolean };
        change: { properties: Record<string, unknown>; additionalProperties: boolean };
        limit: { maximum: number; default: number };
      };
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(expect.arrayContaining(['filter', 'change']));
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties.filter.properties)).toEqual([
      'status',
      'contactId',
      'channelId',
      'assigneeId',
      'teamId',
      'updatedSince',
    ]);
    expect(Object.keys(schema.properties.change.properties)).toEqual([
      'status',
      'assigneeId',
      'teamId',
    ]);
    expect(schema.properties.filter.additionalProperties).toBe(false);
    expect(schema.properties.change.additionalProperties).toBe(false);
    expect([schema.properties.limit.maximum, schema.properties.limit.default]).toEqual([100, 50]);
    // PATCH and update-many meet the same refusal when routing crosses a move into a team.
    for (const [path, method] of [
      ['/conversations/{id}', 'patch'],
      ['/conversations/update-many', 'post'],
    ] as const) {
      const other = doc.paths[path]?.[method] as {
        description: string;
        responses: Record<string, unknown>;
      };
      expect(Object.keys(other.responses)).toContain('409');
      expect(other.description).toContain('at the same moment as a move into a team');
      expect(other.description).toContain('(409, changing nothing): send it again.');
    }
  });
});
