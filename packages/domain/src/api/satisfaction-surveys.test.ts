import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import type { Database, SQL, Tx } from '@w360/db';
import type { ApiContext } from './context';
import { API_SCOPE_INFO } from './model';
import { API_ROUTES, apiSatisfactionSurveySchema, buildOpenApiDocument } from './openapi';
import {
  apiListSatisfactionSurveys,
  apiSatisfactionSurveyQuerySchema,
  toApiSatisfactionSurvey,
} from './satisfaction-surveys';
import { encodeKeysetCursor } from '../validation';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const SURVEY = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
const CONVERSATION = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03';
const MESSAGE = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f04';
const TAP = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f05';
const AGENT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f06';
const SUPERVISOR = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f07';
const SENT = new Date('2026-10-07T09:00:00.000Z');
const ANSWERED = new Date('2026-10-07T09:05:00.000Z');

const ctx = (scopes: string[], status = 'active') =>
  ({
    tenant: { id: TENANT, status },
    key: { id: 'k', scopes: new Set(scopes) },
    planScopes: null,
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

type SurveyRow = Parameters<typeof toApiSatisfactionSurvey>[0] & { cursorAt: string };

/** A survey row as it is read. */
const row = (overrides: Partial<SurveyRow> = {}): SurveyRow => ({
  id: SURVEY,
  conversationId: CONVERSATION,
  skipReason: null,
  messageId: MESSAGE,
  messageStatus: 'read',
  score: null,
  answerMessageId: null,
  answeredAt: null,
  assigneeId: AGENT,
  resolvedById: SUPERVISOR,
  createdAt: SENT,
  cursorAt: '2026-10-07T09:00:00.000123Z',
  ...overrides,
});

/** SQL as text, its parameters inline. */
const text = (query: SQL) => {
  const { sql, params } = new PgDialect().sqlToQuery(query);
  return sql.replace(/\$(\d+)/g, (_, n: string) => JSON.stringify(params[Number(n) - 1]));
};

/**
 * A database whose one read answers `rows`, recording the transaction's options, the conditions
 * (as SQL text and parameters), the joins and their conditions, the order and the limit it was
 * asked for.
 */
function reading(rows: unknown[]) {
  const seen: {
    options?: unknown;
    where?: { sql: string; params: unknown[] };
    joins: string[][];
    order: string[];
  } = { joins: [], order: [] };
  const limits: number[] = [];
  const chain = {
    from: () => chain,
    innerJoin: (_table: unknown, on: SQL) => {
      seen.joins.push(['inner', text(on)]);
      return chain;
    },
    leftJoin: (_table: unknown, on: SQL) => {
      seen.joins.push(['left', text(on)]);
      return chain;
    },
    where: (condition: SQL) => {
      seen.where = new PgDialect().sqlToQuery(condition);
      return chain;
    },
    orderBy: (...order: SQL[]) => {
      seen.order = order.map(text);
      return chain;
    },
    limit: (n: number) => {
      limits.push(n);
      return Promise.resolve(rows);
    },
  };
  const db = {
    run: (_scope: unknown, fn: (tx: Tx) => Promise<unknown>, options?: unknown) => {
      seen.options = options;
      return fn({ select: () => chain } as unknown as Tx);
    },
  } as unknown as Database;
  return { db, seen, limits };
}

describe('satisfaction surveys through the API (ADR-292)', () => {
  it('reads with conversations.read, which says so, and refuses any other key before reading', async () => {
    expect(API_SCOPE_INFO['conversations.read'].description).toContain(
      "read the conversations' internal notes and the satisfaction surveys sent when members resolve them",
    );
    expect(API_SCOPE_INFO['conversations.read'].writes).toBe(false);
    for (const scopes of [['messages.reply'], ['saved_replies.manage', 'conversations.write']]) {
      expect(await refusal(apiListSatisfactionSurveys({ db: untouched }, ctx(scopes), {}))).toEqual(
        ['forbidden', 'This API key does not have the conversations.read scope.', []],
      );
    }
    const key = ctx(['conversations.read']);
    expect(
      (await refusal(apiListSatisfactionSurveys({ db: untouched }, key, { status: 'sent' })))[2],
    ).toEqual(['status']);
    expect(
      (await refusal(apiListSatisfactionSurveys({ db: untouched }, key, { cursor: 'nope' })))[1],
    ).toBe('Invalid cursor.');
  });

  it('takes a page, a conversation, a status and a time, and nothing else', () => {
    expect(apiSatisfactionSurveyQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(
      apiSatisfactionSurveyQuerySchema.parse({
        limit: '10',
        conversationId: CONVERSATION,
        status: 'answered',
        createdSince: '2026-10-01T00:00:00+05:30',
      }),
    ).toEqual({
      limit: 10,
      conversationId: CONVERSATION,
      status: 'answered',
      createdSince: '2026-10-01T00:00:00+05:30',
    });
    for (const status of ['skipped', 'asked', 'answered']) {
      expect(apiSatisfactionSurveyQuerySchema.safeParse({ status }).success).toBe(true);
    }
    for (const input of [
      { limit: '0' },
      { limit: '101' },
      { conversationId: 'c1' },
      { status: 'sent' },
      { createdSince: 'yesterday' },
      { score: '3' },
    ]) {
      expect(apiSatisfactionSurveyQuerySchema.safeParse(input).success, JSON.stringify(input)).toBe(
        false,
      );
    }
  });

  it('says whether a survey was skipped, asked or answered, with what the customer chose', () => {
    expect(toApiSatisfactionSurvey(row())).toEqual({
      id: SURVEY,
      conversationId: CONVERSATION,
      status: 'asked',
      skipReason: null,
      messageId: MESSAGE,
      messageStatus: 'read',
      score: null,
      answerMessageId: null,
      answeredAt: null,
      assigneeId: AGENT,
      resolvedById: SUPERVISOR,
      createdAt: '2026-10-07T09:00:00.000Z',
    });
    expect(
      toApiSatisfactionSurvey(row({ score: 3, answerMessageId: TAP, answeredAt: ANSWERED })),
    ).toMatchObject({
      status: 'answered',
      score: 3,
      answerMessageId: TAP,
      answeredAt: '2026-10-07T09:05:00.000Z',
    });
    expect(
      toApiSatisfactionSurvey(
        row({ skipReason: 'window_closed', messageId: null, messageStatus: null }),
      ),
    ).toMatchObject({ status: 'skipped', skipReason: 'window_closed', messageId: null });
    for (const r of [
      row(),
      row({ score: 1, answerMessageId: TAP, answeredAt: ANSWERED }),
      row({ skipReason: 'opted_out', messageId: null, messageStatus: null, assigneeId: null }),
    ]) {
      expect(apiSatisfactionSurveySchema.safeParse(toApiSatisfactionSurvey(r)).success).toBe(true);
    }
  });

  it('lists the company’s surveys newest first on exact pages, read only, while suspended too', async () => {
    const rows = [row(), row({ id: TAP, cursorAt: '2026-10-07T08:00:00.000001Z' }), row()];
    const page = reading(rows);
    const result = await apiListSatisfactionSurveys(
      { db: page.db },
      ctx(['conversations.read'], 'suspended'),
      { limit: '2' },
    );
    expect(result.data.map((s) => s.id)).toEqual([SURVEY, TAP]);
    expect(result.nextCursor).toBe(encodeKeysetCursor('2026-10-07T08:00:00.000001Z', TAP));
    expect(page.limits).toEqual([3]);
    expect(page.seen.options).toEqual({ accessMode: 'read only' });
    // The conversation, its contact unless erased, and the survey message's status.
    expect(page.seen.joins.map(([kind]) => kind)).toEqual(['inner', 'inner', 'left']);
    expect(page.seen.joins[0]?.[1]).toContain(
      '"app"."conversations"."id" = "app"."csat_surveys"."conversation_id"',
    );
    expect(page.seen.joins[1]?.[1]).toContain('"app"."contacts"."erased_at" is null');
    expect(page.seen.joins[2]?.[1]).toContain(
      '"app"."messages"."id" = "app"."csat_surveys"."message_id"',
    );
    expect(page.seen.order).toEqual([
      '"app"."csat_surveys"."created_at" desc',
      '"app"."csat_surveys"."id" desc',
    ]);
    expect(page.seen.where?.sql).toContain('"csat_surveys"."tenant_id" = $1');
    expect(page.seen.where?.params).toEqual([TENANT]);
    const last = reading([row()]);
    expect(
      (await apiListSatisfactionSurveys({ db: last.db }, ctx(['conversations.read']), {}))
        .nextCursor,
    ).toBeNull();
    expect(last.limits).toEqual([51]);
    // A page exactly full is the last one.
    const full = reading([row(), row({ id: TAP })]);
    expect(
      (
        await apiListSatisfactionSurveys({ db: full.db }, ctx(['conversations.read']), {
          limit: '2',
        })
      ).nextCursor,
    ).toBeNull();
  });

  it('finds the surveys of a conversation, in a status, since a time, after a cursor', async () => {
    const where = async (query: Record<string, string>) => {
      const page = reading([]);
      await apiListSatisfactionSurveys({ db: page.db }, ctx(['conversations.read']), query);
      return page.seen.where ?? { sql: '', params: [] };
    };
    const conversation = await where({ conversationId: CONVERSATION });
    expect(conversation.sql).toContain('"csat_surveys"."conversation_id" = $2');
    expect(conversation.params).toEqual([TENANT, CONVERSATION]);
    expect((await where({ status: 'skipped' })).sql).toContain(
      '"csat_surveys"."skip_reason" is not null',
    );
    const asked = (await where({ status: 'asked' })).sql;
    expect(asked).toContain('"csat_surveys"."skip_reason" is null');
    expect(asked).toContain('"csat_surveys"."answered_at" is null');
    const answered = (await where({ status: 'answered' })).sql;
    expect(answered).toContain('"csat_surveys"."answered_at" is not null');
    expect(answered).not.toContain('skip_reason');
    const since = await where({ createdSince: '2026-10-01T00:00:00Z' });
    expect(since.sql).toContain('"csat_surveys"."created_at" >= $2::timestamptz');
    expect(since.params).toEqual([TENANT, '2026-10-01T00:00:00Z']);
    const after = await where({
      cursor: encodeKeysetCursor('2026-10-07T08:00:00.000001Z', SURVEY),
    });
    expect(after.sql).toContain(
      '("app"."csat_surveys"."created_at", "app"."csat_surveys"."id") < ($2::timestamptz, $3::uuid)',
    );
    expect(after.params).toEqual([TENANT, '2026-10-07T08:00:00.000001Z', SURVEY]);
    // No filter: the company's surveys only.
    expect((await where({})).params).toEqual([TENANT]);
  });

  it('is described: the scope, the statuses, the order and catching up on answers', () => {
    expect(API_ROUTES).toContainEqual(['get', '/satisfaction-surveys']);
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, { operationId: string; description: string }>>;
    };
    const list = doc.paths['/satisfaction-surveys']?.get;
    expect(list?.operationId).toBe('listSatisfactionSurveys');
    for (const words of [
      'Scope: `conversations.read`.',
      'when a member resolves a conversation while satisfaction surveys are on',
      'or skipped, with the reason',
      'Newest first by when it was sent or skipped; pages never skip or repeat a survey.',
      'The surveys of erased contacts’ conversations are left out',
      'to catch up on answers, read the surveys `asked` since you last saw them unanswered',
      'Conversations resolved through the API are never surveyed.',
    ]) {
      expect(list?.description).toContain(words);
    }
  });
});
