import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import {
  API_SCOPES,
  channelAccounts,
  chatLinkClicks,
  chatLinks,
  tenants,
  type Database,
  type SQL,
  type Tx,
} from '@w360/db';
import { ROLE_PERMISSIONS } from '../authz/permissions';
import { encodeKeysetCursor } from '../validation';
import {
  apiChatLinkDetailSchema,
  apiChatLinkListQuerySchema,
  apiChatLinkSchema,
  apiCreateChatLink,
  apiGetChatLink,
  apiListChatLinks,
  apiUpdateChatLink,
  apiUpdateChatLinkSchema,
} from './chat-links';
import type { ApiContext } from './context';
import { API_SCOPE_INFO, API_SCOPE_KEYS } from './model';
import { API_ROUTES, buildOpenApiDocument } from './openapi';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f11';
const LINK = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f12';
const OTHER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f13';
const NUMBER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f14';
const CREATED = new Date('2026-09-20T09:00:00.000Z');
const UPDATED = new Date('2026-10-06T10:00:00.000Z');
const BASE = 'https://app.example.test/';

const CALLER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f15';
const NOW = new Date('2026-10-07T11:00:00.000Z');

const ctx = (scopes: string[], status = 'active') =>
  ({
    tenant: { id: TENANT, status },
    key: { id: CALLER, scopes: new Set(scopes) },
    planScopes: null,
    requestId: 'req-1',
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
 * each read's table, joins, columns, conditions, order and limit. A read beyond them fails the test.
 */
function reading(answers: unknown[][]) {
  const queue = [...answers];
  type Read = {
    table?: unknown;
    joined: unknown[];
    columns: Record<string, string>;
    where?: string;
    order?: string[];
    limit?: number;
  };
  const seen: { options?: unknown; reads: Read[] } = { reads: [] };
  const select = (fields: Record<string, unknown>) => {
    const read: Read = { joined: [], columns: {} };
    for (const [name, field] of Object.entries(fields)) {
      if (field && typeof field === 'object' && 'getSQL' in field) {
        read.columns[name] = text((field as { getSQL: () => SQL }).getSQL()).replace(/\s+/g, ' ');
      }
    }
    seen.reads.push(read);
    const chain = {
      from: (table: unknown) => {
        read.table = table;
        return chain;
      },
      innerJoin: (table: unknown, on: SQL) => {
        read.joined.push(table, text(on));
        return chain;
      },
      where: (condition: SQL) => {
        read.where = text(condition);
        return chain;
      },
      orderBy: (...order: SQL[]) => {
        read.order = order.map(text);
        return chain;
      },
      limit: (n: number) => {
        read.limit = n;
        return chain;
      },
      then: (resolve: (rows: unknown[]) => void, reject: (error: unknown) => void) => {
        const rows = queue.shift();
        if (rows) resolve(rows);
        else reject(new Error('an unexpected read'));
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

const link = (overrides: Record<string, unknown> = {}) => ({
  id: LINK,
  name: 'Instagram bio',
  message: 'Hello from Instagram',
  refCode: 'ABC234',
  includeRef: true,
  slug: 'abcdefgh2345',
  channelId: NUMBER,
  channelStatus: 'active',
  phone: '+91 90000 00000',
  archivedAt: null,
  version: 3,
  createdByApiKeyId: null,
  createdAt: CREATED,
  updatedAt: UPDATED,
  cursorAt: '2026-09-20T09:00:00.000123Z',
  clicks: 41,
  conversations: 7,
  ...overrides,
});

const deps = (db: Database) => ({ db, appBaseUrl: BASE });

describe('chat links through the API (ADR-299)', () => {
  it('need chat_links.read, a reading scope the database accepts, granted with campaigns.read', async () => {
    expect(API_SCOPES).toContain('chat_links.read');
    expect(API_SCOPE_KEYS.indexOf('chat_links.read')).toBe(
      API_SCOPE_KEYS.indexOf('campaigns.resume') + 1,
    );
    expect(API_SCOPE_INFO['chat_links.read']).toMatchObject({
      label: 'Read chat links',
      permission: 'campaigns.read',
      writes: false,
    });
    expect(API_SCOPE_INFO['chat_links.read'].description).toContain(
      'with its clicks per day and the conversations it started in the last 30 days',
    );
    for (const role of ['owner', 'admin', 'supervisor', 'marketer', 'analyst'] as const) {
      expect(ROLE_PERMISSIONS[role].has('campaigns.read')).toBe(true);
    }
    expect(ROLE_PERMISSIONS.agent.has('campaigns.read')).toBe(false);
    for (const read of [
      () => apiListChatLinks(deps(untouched), ctx(['campaigns.read']), {}),
      () => apiGetChatLink(deps(untouched), ctx(['campaigns.read']), LINK),
    ]) {
      expect(await refusal(read())).toEqual([
        'forbidden',
        'This API key does not have the chat_links.read scope.',
        [],
      ]);
    }
    const key = ctx(['chat_links.read']);
    for (const [query, path] of [
      [{ archived: 'yes' }, 'archived'],
      [{ limit: '0' }, 'limit'],
      [{ limit: '101' }, 'limit'],
      [{ channelId: NUMBER }, ''],
    ] as const) {
      const [code, , paths] = await refusal(apiListChatLinks(deps(untouched), key, query));
      expect(code).toBe('validation_failed');
      if (path) expect(paths).toContain(path);
    }
    expect(
      (await refusal(apiListChatLinks(deps(untouched), key, { cursor: 'nope' }))).slice(0, 2),
    ).toEqual(['validation_failed', 'Invalid cursor.']);
    expect(await refusal(apiGetChatLink(deps(untouched), key, 'instagram'))).toEqual([
      'not_found',
      'Chat link not found.',
      [],
    ]);
    expect(apiChatLinkListQuerySchema.parse({})).toEqual({ limit: 50 });
  });

  it('list the links in use newest first on exact pages, read only, while suspended too, with their numbers and counts', async () => {
    const page = reading([
      [{ timezone: 'Asia/Kolkata' }],
      [
        link(),
        link({
          id: OTHER,
          includeRef: false,
          message: '',
          phone: null,
          channelStatus: 'disconnected',
          cursorAt: 'x',
          conversations: 0,
        }),
        link(),
      ],
    ]);
    const result = await apiListChatLinks(deps(page.db), ctx(['chat_links.read'], 'suspended'), {
      limit: '2',
    });
    expect(result.data).toEqual([
      {
        id: LINK,
        name: 'Instagram bio',
        message: 'Hello from Instagram',
        refCode: 'ABC234',
        includeRef: true,
        shortUrl: 'https://app.example.test/l/abcdefgh2345',
        waMeUrl: 'https://wa.me/919000000000?text=Hello%20from%20Instagram%20(ref%20ABC234)',
        channel: { id: NUMBER, phone: '+91 90000 00000', active: true },
        archived: false,
        version: 3,
        createdBy: 'member',
        createdByApiKeyId: null,
        createdAt: CREATED.toISOString(),
        updatedAt: UPDATED.toISOString(),
        last30Days: { clicks: 41, conversations: 7 },
      },
      expect.objectContaining({
        id: OTHER,
        waMeUrl: null,
        channel: { id: NUMBER, phone: null, active: false },
        last30Days: { clicks: 41, conversations: null },
      }),
    ]);
    for (const item of result.data) expect(apiChatLinkSchema.safeParse(item).success).toBe(true);
    expect(result.nextCursor).toBe(encodeKeysetCursor('x', OTHER));
    expect(page.seen.options).toEqual({ accessMode: 'read only' });
    const [company, links] = page.seen.reads;
    expect(company?.table).toBe(tenants);
    expect(company?.where).toBe(`"app"."tenants"."id" = "${TENANT}"`);
    expect(links?.table).toBe(chatLinks);
    expect(links?.joined).toEqual([
      channelAccounts,
      '("app"."channel_accounts"."tenant_id" = "app"."chat_links"."tenant_id" and "app"."channel_accounts"."id" = "app"."chat_links"."channel_account_id")',
    ]);
    expect(links?.where).toBe(
      `("app"."chat_links"."tenant_id" = "${TENANT}" and "app"."chat_links"."archived_at" is null)`,
    );
    expect(links?.order).toEqual([
      '"app"."chat_links"."created_at" desc',
      '"app"."chat_links"."id" desc',
    ]);
    expect(links?.limit).toBe(3);
    // The counts are the Growth pages': the company's last 30 days, today included.
    expect(links?.columns.clicks).toContain(
      `k.day > (now() at time zone "Asia/Kolkata")::date - 30`,
    );
    expect(links?.columns.conversations).toContain(
      `s.link_id = "app"."chat_links"."id" and s.occurred_at > now() - interval '30 days'`,
    );
    expect(page.unread()).toBe(0);
    // Archived links when asked, after a cursor; an exactly full page is the last.
    const archived = reading([[{ timezone: 'UTC' }], [link({ archivedAt: UPDATED })]]);
    const last = await apiListChatLinks(deps(archived.db), ctx(['chat_links.read']), {
      archived: 'true',
      limit: '1',
      cursor: encodeKeysetCursor('2026-09-21T09:00:00.000123Z', OTHER),
    });
    expect(last).toMatchObject({ data: [{ archived: true }], nextCursor: null });
    expect(archived.seen.reads[1]?.where).toBe(
      `("app"."chat_links"."tenant_id" = "${TENANT}" and "app"."chat_links"."archived_at" is not null and ("app"."chat_links"."created_at", "app"."chat_links"."id") < ("2026-09-21T09:00:00.000123Z"::timestamptz, "${OTHER}"::uuid))`,
    );
    expect(
      (
        await apiListChatLinks(
          deps(reading([[{ timezone: 'UTC' }], [link()]]).db),
          ctx(['chat_links.read']),
          { archived: 'false' },
        )
      ).data,
    ).toHaveLength(1);
  });

  it('read one link, archived or not, with the days of the last 30 it was clicked on', async () => {
    const one = reading([
      [{ timezone: 'Asia/Kolkata' }],
      [link({ archivedAt: UPDATED })],
      [
        { day: '2026-10-06', clicks: 4 },
        { day: '2026-09-30', clicks: 1 },
      ],
    ]);
    const detail = await apiGetChatLink(deps(one.db), ctx(['chat_links.read']), LINK);
    expect(detail).toMatchObject({
      id: LINK,
      archived: true,
      clicksByDay: [
        { day: '2026-10-06', clicks: 4 },
        { day: '2026-09-30', clicks: 1 },
      ],
    });
    expect(apiChatLinkDetailSchema.safeParse(detail).success).toBe(true);
    expect(one.seen.options).toEqual({ accessMode: 'read only' });
    const [, row, days] = one.seen.reads;
    expect(row?.where).toBe(
      `("app"."chat_links"."tenant_id" = "${TENANT}" and "app"."chat_links"."id" = "${LINK}")`,
    );
    expect(row?.limit).toBe(1);
    expect(days?.table).toBe(chatLinkClicks);
    expect(days?.where).toBe(
      `("app"."chat_link_clicks"."tenant_id" = "${TENANT}" and "app"."chat_link_clicks"."link_id" = "${LINK}" and "app"."chat_link_clicks"."day" >= (now() at time zone "Asia/Kolkata")::date - 29)`,
    );
    expect(days?.order).toEqual(['"app"."chat_link_clicks"."day" desc']);
    expect(one.unread()).toBe(0);
    // Another company's link, or none, is not found.
    const none = reading([[{ timezone: 'UTC' }], []]);
    expect(await refusal(apiGetChatLink(deps(none.db), ctx(['chat_links.read']), OTHER))).toEqual([
      'not_found',
      'Chat link not found.',
      [],
    ]);
    expect(none.unread()).toBe(0);
  });

  it('are described: the scope, the archived links, the counts', () => {
    for (const route of [
      ['get', '/chat-links'],
      ['get', '/chat-links/{id}'],
    ]) {
      expect(API_ROUTES).toContainEqual(route);
    }
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, { operationId: string; description: string }>>;
      components: { schemas: Record<string, { required?: string[] }> };
    };
    const list = doc.paths['/chat-links']?.get;
    expect(list?.operationId).toBe('listChatLinks');
    for (const words of [
      'Scope: `chat_links.read`.',
      'Those in use, or archived ones with `archived=true`',
      'Visitors are never identified',
    ]) {
      expect(list?.description).toContain(words);
    }
    const one = doc.paths['/chat-links/{id}']?.get;
    expect(one?.operationId).toBe('getChatLink');
    expect(one?.description).toContain('a link without its reference counts none');
    expect(doc.components.schemas.ChatLink?.required).toContain('last30Days');
    expect(doc.components.schemas.ChatLinkDetail?.required).toContain('clicksByDay');
  });
});

/**
 * A database whose reads answer, in order, with `answers`, recording each step: transactions, reads
 * with their table, conditions, limit and lock, inserts and updates with SQL values as text. A read
 * beyond the answers fails the test.
 */
function writing(answers: unknown[][]) {
  const queue = [...answers];
  const steps: unknown[][] = [];
  const plain = (values: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        value && typeof value === 'object' && 'queryChunks' in value ? text(value as SQL) : value,
      ]),
    );
  const select = () => {
    const step: unknown[] = ['read'];
    steps.push(step);
    const chain = {
      from: (table: Parameters<typeof getTableName>[0]) => {
        step.push(getTableName(table));
        return chain;
      },
      innerJoin: () => chain,
      where: (condition: SQL) => {
        step.push(text(condition));
        return chain;
      },
      orderBy: () => chain,
      limit: (n: number) => {
        step.push(n);
        return chain;
      },
      for: (mode: string) => {
        step.push(mode);
        return chain;
      },
      then: (resolve: (rows: unknown[]) => void, reject: (error: unknown) => void) => {
        const rows = queue.shift();
        if (rows) resolve(rows);
        else reject(new Error('an unexpected read'));
      },
    };
    return chain;
  };
  const tx = {
    select,
    insert: (table: Parameters<typeof getTableName>[0]) => ({
      values: (values: Record<string, unknown>) => {
        steps.push(['insert', getTableName(table), plain(values)]);
        return Promise.resolve();
      },
    }),
    update: (table: Parameters<typeof getTableName>[0]) => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: SQL) => {
          steps.push(['update', getTableName(table), plain(values), text(condition)]);
          return Promise.resolve();
        },
      }),
    }),
  } as unknown as Tx;
  const db = {
    run: (_scope: unknown, fn: (tx: Tx) => Promise<unknown>, options?: unknown) => {
      steps.push(['run', options ?? null]);
      return fn(tx);
    },
  } as unknown as Database;
  return { db, steps, unread: () => queue.length };
}

const writes = (db: Database) => ({ db, appBaseUrl: BASE, clock: { now: () => NOW } });

/** The stored link as the lock reads it. */
const stored = (overrides: Record<string, unknown> = {}) => ({
  id: LINK,
  tenantId: TENANT,
  channelAccountId: NUMBER,
  name: 'Instagram bio',
  message: 'Hello from Instagram',
  refCode: 'ABC234',
  includeRef: true,
  slug: 'abcdefgh2345',
  archivedAt: null,
  version: 3,
  createdByMembershipId: OTHER,
  createdByApiKeyId: null,
  createdAt: CREATED,
  updatedAt: UPDATED,
  ...overrides,
});

const linkRead = (overrides: Record<string, unknown> = {}) => [
  [{ timezone: 'Asia/Kolkata' }],
  [link(overrides)],
];

const lock = `("app"."chat_links"."tenant_id" = "${TENANT}" and "app"."chat_links"."id" = "${LINK}")`;

describe('chat links written through the API (ADR-300)', () => {
  it('need chat_links.write, a writing scope the database accepts, granted with campaigns.write', async () => {
    expect(API_SCOPES).toContain('chat_links.write');
    expect(API_SCOPE_KEYS.indexOf('chat_links.write')).toBe(
      API_SCOPE_KEYS.indexOf('chat_links.read') + 1,
    );
    expect(API_SCOPE_INFO['chat_links.write']).toMatchObject({
      label: 'Write chat links',
      permission: 'campaigns.write',
      writes: true,
    });
    expect(API_SCOPE_INFO['chat_links.write'].description).toContain(
      'Links a key creates name it as their author.',
    );
    for (const role of ['owner', 'admin', 'marketer'] as const) {
      expect(ROLE_PERMISSIONS[role].has('campaigns.write')).toBe(true);
    }
    for (const role of ['supervisor', 'analyst', 'agent'] as const) {
      expect(ROLE_PERMISSIONS[role].has('campaigns.write')).toBe(false);
    }
    const body = { name: 'Instagram bio', channelId: NUMBER };
    for (const write of [
      (key: ApiContext) => apiCreateChatLink(writes(untouched), key, body, null),
      (key: ApiContext) => apiUpdateChatLink(writes(untouched), key, LINK, { name: 'Bio' }),
    ]) {
      expect((await refusal(write(ctx(['chat_links.read']))))[0]).toBe('forbidden');
      // Refused while the company is suspended or restricted, before anything is read.
      for (const status of ['suspended', 'restricted']) {
        expect((await refusal(write(ctx(['chat_links.write'], status))))[0]).toBe(
          'tenant_suspended',
        );
      }
    }
    const key = ctx(['chat_links.write']);
    for (const [input, path] of [
      [{ channelId: NUMBER }, 'name'],
      [{ name: '   ', channelId: NUMBER }, 'name'],
      [{ name: 'x'.repeat(81), channelId: NUMBER }, 'name'],
      [{ name: 'Bio', channelId: 'first' }, 'channelId'],
      [{ name: 'Bio', channelId: NUMBER, message: 'x'.repeat(501) }, 'message'],
      [{ name: 'Bio', channelId: NUMBER, includeRef: 'yes' }, 'includeRef'],
      [{ name: 'Bio', channelId: NUMBER, slug: 'mine' }, ''],
    ] as const) {
      const [code, , paths] = await refusal(apiCreateChatLink(writes(untouched), key, input, null));
      expect(code).toBe('validation_failed');
      if (path) expect(paths).toContain(path);
    }
    for (const [input, path] of [
      [{}, ''],
      [{ expectedVersion: 3 }, ''],
      [{ expectedVersion: 0, name: 'Bio' }, 'expectedVersion'],
      [{ archived: true, name: 'Bio' }, 'archived'],
      [{ archived: false, includeRef: false }, 'archived'],
      [{ name: '' }, 'name'],
      [{ refCode: 'ABC234' }, ''],
      [{ name: 'Bio', refCode: 'ABC234' }, ''],
    ] as const) {
      const [code, message, paths] = await refusal(
        apiUpdateChatLink(writes(untouched), key, LINK, input),
      );
      expect(code).toBe('validation_failed');
      if (path) expect(paths).toContain(path);
      if (path === 'archived') {
        expect(message).toBe('Archive or restore a link in a request of its own.');
      }
    }
    expect(apiUpdateChatLinkSchema.safeParse({ archived: true }).success).toBe(true);
    expect(
      await refusal(apiUpdateChatLink(writes(untouched), key, 'bio', { name: 'Bio' })),
    ).toEqual(['not_found', 'Chat link not found.', []]);
  });

  it('add a link on an active number within the cap, named as the key’s, audited, and answer it', async () => {
    const db = writing([
      [{ id: NUMBER, status: 'active' }],
      [{ n: 499 }],
      ...linkRead({ createdByApiKeyId: CALLER, clicks: 0, conversations: 0 }),
    ]);
    const created = await apiCreateChatLink(
      writes(db.db),
      ctx(['chat_links.write']),
      { name: ' Instagram bio ', channelId: NUMBER, message: ' Hello from Instagram ' },
      null,
    );
    expect(created).toMatchObject({
      status: 201,
      replayed: false,
      body: {
        data: {
          id: LINK,
          createdBy: 'api',
          createdByApiKeyId: CALLER,
          last30Days: { clicks: 0, conversations: 0 },
        },
      },
    });
    expect(apiChatLinkSchema.safeParse(created.body.data).success).toBe(true);
    const [run, channel, open, insert, audit, company, read] = db.steps;
    expect(run).toEqual(['run', null]);
    expect(channel).toEqual([
      'read',
      'channel_accounts',
      `("app"."channel_accounts"."tenant_id" = "${TENANT}" and "app"."channel_accounts"."id" = "${NUMBER}")`,
    ]);
    expect(open).toEqual([
      'read',
      'chat_links',
      `("app"."chat_links"."tenant_id" = "${TENANT}" and "app"."chat_links"."archived_at" is null)`,
    ]);
    expect(insert?.[1]).toBe('chat_links');
    const values = insert?.[2] as Record<string, unknown>;
    expect(values).toMatchObject({
      tenantId: TENANT,
      channelAccountId: NUMBER,
      name: 'Instagram bio',
      message: 'Hello from Instagram',
      includeRef: true,
      createdByApiKeyId: CALLER,
    });
    expect(values).not.toHaveProperty('createdByMembershipId');
    expect(values.refCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(values.slug).toMatch(/^[a-z2-7]{12}$/);
    expect(audit).toEqual([
      'insert',
      'audit_events',
      expect.objectContaining({
        tenantId: TENANT,
        actorType: 'api_key',
        actorId: CALLER,
        action: 'growth.link_created',
        subjectType: 'chat_link',
        subjectId: values.id,
        correlationId: 'req-1',
        metadata: { name: 'Instagram bio', source: 'api' },
      }),
    ]);
    expect(company?.[1]).toBe('tenants');
    expect(read).toEqual([
      'read',
      'chat_links',
      `("app"."chat_links"."tenant_id" = "${TENANT}" and "app"."chat_links"."id" = "${String(values.id)}")`,
      1,
    ]);
    expect(db.unread()).toBe(0);

    // Only an active number of the company, within the cap; nothing is added otherwise.
    for (const [answers, expected] of [
      [[[{ id: NUMBER, status: 'disconnected' }]], ['validation_failed', ['channelId']]],
      [[[]], ['validation_failed', ['channelId']]],
      [
        [[{ id: NUMBER, status: 'active' }], [{ n: 500 }]],
        ['conflict', []],
      ],
    ] as const) {
      const refused = writing(answers as unknown as unknown[][]);
      const [code, message, paths] = await refusal(
        apiCreateChatLink(
          writes(refused.db),
          ctx(['chat_links.write']),
          { name: 'Bio', channelId: NUMBER },
          null,
        ),
      );
      expect([code, paths]).toEqual(expected);
      if (code === 'conflict') {
        expect(message).toBe('A company can have at most 500 links; archive some first.');
      }
      expect(refused.steps.some((step) => step[0] === 'insert')).toBe(false);
    }
    // Defaults: no message, and the reference in it.
    const plain = writing([[{ id: NUMBER, status: 'active' }], [{ n: 0 }], ...linkRead()]);
    await apiCreateChatLink(
      writes(plain.db),
      ctx(['chat_links.write']),
      { name: 'Bio', channelId: NUMBER },
      null,
    );
    expect(plain.steps[3]?.[2]).toMatchObject({ message: '', includeRef: true });
  });

  it('change a link from its version, as given, the rest kept, audited, or nothing when nothing changes', async () => {
    const db = writing([[stored()], [{ id: OTHER, status: 'active' }], ...linkRead()]);
    const changed = await apiUpdateChatLink(writes(db.db), ctx(['chat_links.write']), LINK, {
      expectedVersion: 3,
      channelId: OTHER,
      includeRef: false,
    });
    expect(apiChatLinkSchema.safeParse(changed).success).toBe(true);
    const [, locked, channel, update, audit] = db.steps;
    expect(locked).toEqual(['read', 'chat_links', lock, 'update']);
    expect(channel?.[2]).toContain(`"app"."channel_accounts"."id" = "${OTHER}"`);
    expect(update).toEqual([
      'update',
      'chat_links',
      {
        name: 'Instagram bio',
        channelAccountId: OTHER,
        message: 'Hello from Instagram',
        includeRef: false,
        version: 4,
      },
      lock,
    ]);
    expect(audit).toEqual([
      'insert',
      'audit_events',
      expect.objectContaining({
        actorType: 'api_key',
        actorId: CALLER,
        action: 'growth.link_updated',
        subjectId: LINK,
        metadata: { name: 'Instagram bio', source: 'api' },
      }),
    ]);
    expect(db.unread()).toBe(0);
    // The same number needs no check; without a version, the link as it is changes.
    const renamed = writing([[stored()], ...linkRead()]);
    await apiUpdateChatLink(writes(renamed.db), ctx(['chat_links.write']), LINK, {
      name: 'Bio',
      channelId: NUMBER,
      message: ' New text ',
    });
    expect(renamed.steps[2]).toEqual([
      'update',
      'chat_links',
      {
        name: 'Bio',
        channelAccountId: NUMBER,
        message: 'New text',
        includeRef: true,
        version: 4,
      },
      lock,
    ]);
    // Each field alone is a change.
    for (const [input, set] of [
      [{ name: 'Bio' }, { name: 'Bio' }],
      [{ message: 'New text' }, { message: 'New text' }],
      [{ includeRef: false }, { includeRef: false }],
    ] as const) {
      const one = writing([[stored()], ...linkRead()]);
      await apiUpdateChatLink(writes(one.db), ctx(['chat_links.write']), LINK, input);
      expect(one.steps[2]?.[2]).toMatchObject({ ...set, version: 4 });
    }
    // Nothing changes: nothing written, nothing audited, the link answered.
    const same = writing([[stored()], ...linkRead()]);
    expect(
      await apiUpdateChatLink(writes(same.db), ctx(['chat_links.write']), LINK, {
        name: 'Instagram bio',
        includeRef: true,
      }),
    ).toMatchObject({ id: LINK, version: 3 });
    expect(same.steps.filter((step) => step[0] !== 'read' && step[0] !== 'run')).toEqual([]);
    // Refusals: another version, an archived link, an inactive number, a link not found.
    for (const [answers, input, expected] of [
      [
        [[stored({ version: 4 })]],
        { expectedVersion: 3, name: 'Bio' },
        ['conflict', 'The chat link changed since version 3; its version is 4. Read it again.', []],
      ],
      [
        [[stored({ archivedAt: UPDATED })]],
        { name: 'Bio' },
        ['conflict', 'Restore the link before changing it.', []],
      ],
      [
        [[stored()], [{ id: OTHER, status: 'disconnected' }]],
        { channelId: OTHER },
        ['validation_failed', 'Choose an active WhatsApp number.', ['channelId']],
      ],
      [[[]], { name: 'Bio' }, ['not_found', 'Chat link not found.', []]],
    ] as const) {
      const refused = writing(answers as unknown as unknown[][]);
      expect(
        await refusal(
          apiUpdateChatLink(writes(refused.db), ctx(['chat_links.write']), LINK, input),
        ),
      ).toEqual(expected);
      expect(refused.steps.some((step) => step[0] === 'update' || step[0] === 'insert')).toBe(
        false,
      );
    }
  });

  it('archive and restore a link in a request of their own, audited, and nothing when it already is', async () => {
    const archive = writing([[stored()], ...linkRead({ archivedAt: NOW })]);
    expect(
      await apiUpdateChatLink(writes(archive.db), ctx(['chat_links.write']), LINK, {
        archived: true,
        expectedVersion: 3,
      }),
    ).toMatchObject({ archived: true });
    expect(archive.steps[2]).toEqual([
      'update',
      'chat_links',
      { archivedAt: NOW, version: 4 },
      lock,
    ]);
    expect(archive.steps[3]?.[2]).toMatchObject({
      action: 'growth.link_archived',
      metadata: { name: 'Instagram bio', source: 'api' },
    });
    const restore = writing([[stored({ archivedAt: UPDATED })], ...linkRead()]);
    await apiUpdateChatLink(writes(restore.db), ctx(['chat_links.write']), LINK, {
      archived: false,
    });
    expect(restore.steps[2]).toEqual([
      'update',
      'chat_links',
      { archivedAt: null, version: 4 },
      lock,
    ]);
    expect(restore.steps[3]?.[2]).toMatchObject({ action: 'growth.link_restored' });
    // Already archived, or already in use: nothing written or audited.
    for (const [row, archived] of [
      [stored({ archivedAt: UPDATED }), true],
      [stored(), false],
    ] as const) {
      const same = writing([[row], ...linkRead()]);
      await apiUpdateChatLink(writes(same.db), ctx(['chat_links.write']), LINK, { archived });
      expect(same.steps.filter((step) => step[0] !== 'read' && step[0] !== 'run')).toEqual([]);
    }
  });

  it('are described: the scope, the cap, the author, archiving in a request of its own', () => {
    for (const route of [
      ['post', '/chat-links'],
      ['patch', '/chat-links/{id}'],
    ]) {
      expect(API_ROUTES).toContainEqual(route);
    }
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, { operationId: string; description: string }>>;
      components: { schemas: Record<string, { required?: string[] }> };
    };
    const create = doc.paths['/chat-links']?.post;
    expect(create?.operationId).toBe('createChatLink');
    for (const words of [
      'Scope: `chat_links.write`.',
      'at most 500 links in use (409 at the limit: archive some first)',
      'names the key as its author (`createdBy` `api`)',
      'With an `Idempotency-Key`, a retry answers the first response.',
    ]) {
      expect(create?.description).toContain(words);
    }
    const update = doc.paths['/chat-links/{id}']?.patch;
    expect(update?.operationId).toBe('updateChatLink');
    for (const words of [
      'An archived link is changed only once restored (409)',
      '`archived` archives or restores it, in a request of its own',
      'A change that leaves the link as it is answers it as it is, with no audit entry',
    ]) {
      expect(update?.description).toContain(words);
    }
    expect(doc.components.schemas.CreateChatLink?.required).toEqual(['name', 'channelId']);
    expect(doc.components.schemas.UpdateChatLink?.required).toBeUndefined();
    expect(doc.components.schemas.ChatLink?.required).toEqual(
      expect.arrayContaining(['createdBy', 'createdByApiKeyId']),
    );
  });
});
