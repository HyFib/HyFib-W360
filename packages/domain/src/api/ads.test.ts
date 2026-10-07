import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { API_SCOPES, type Database, type SQL, type Tx } from '@w360/db';
import { ROLE_PERMISSIONS } from '../authz/permissions';
import { GROWTH_LIMITS } from '../growth/model';
import { apiAdListQuerySchema, apiAdSchema, apiListAds } from './ads';
import type { ApiContext } from './context';
import { API_SCOPE_INFO, API_SCOPE_KEYS } from './model';
import { API_ROUTES, buildOpenApiDocument } from './openapi';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f31';

const ctx = (scopes: string[], status = 'active') =>
  ({
    tenant: { id: TENANT, status },
    key: { id: 'k', scopes: new Set(scopes) },
    planScopes: null,
  }) as unknown as ApiContext;

/** A database that fails the test if anything is read or written. */
const untouched = {
  run: () => {
    throw new Error('used the database');
  },
} as unknown as Database;

/** The code and paths of a refusal. */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return [error.code, (error.issues ?? []).map((i) => i.path)];
  }
  throw new Error('expected a refusal');
}

const render = (condition: SQL) => {
  const { sql: text, params } = new PgDialect().sqlToQuery(condition);
  return [text.replace(/\s+/g, ' '), params];
};

/** A database whose one grouped read answers `rows`, recording how it was asked. */
function reading(rows: unknown[]) {
  const seen: {
    columns?: Record<string, unknown>;
    where?: SQL;
    groupBy?: unknown[];
    orderBy?: SQL[];
    limit?: number;
    options?: unknown;
  } = {};
  const chain = {
    from: () => chain,
    where: (condition: SQL) => {
      seen.where = condition;
      return chain;
    },
    groupBy: (...columns: unknown[]) => {
      seen.groupBy = columns;
      return chain;
    },
    orderBy: (...order: SQL[]) => {
      seen.orderBy = order;
      return chain;
    },
    limit: (n: number) => {
      seen.limit = n;
      return Promise.resolve(rows);
    },
  };
  const db = {
    run: (_scope: unknown, fn: (tx: Tx) => Promise<unknown>, options?: unknown) => {
      seen.options = options;
      return fn({
        select: (columns: Record<string, unknown>) => {
          seen.columns = columns;
          return chain;
        },
      } as unknown as Tx);
    },
  } as unknown as Database;
  return { db, seen };
}

describe('click-to-WhatsApp ads through the API (ADR-302)', () => {
  it('need ads.read, a reading scope the database accepts, granted with campaigns.read', () => {
    expect(API_SCOPES).toContain('ads.read');
    // After the chat link scopes, in the order the database's checks list them.
    expect(API_SCOPE_KEYS.indexOf('ads.read')).toBe(API_SCOPE_KEYS.indexOf('chat_links.write') + 1);
    expect(API_SCOPE_INFO['ads.read']).toMatchObject({
      label: 'Read ads',
      permission: 'campaigns.read',
      writes: false,
    });
    expect(API_SCOPE_INFO['ads.read'].description).toContain('never the ad click id');
    // Those who read campaigns grant it; agents, who do not, cannot.
    expect(ROLE_PERMISSIONS.marketer).toContain('campaigns.read');
    expect(ROLE_PERMISSIONS.agent).not.toContain('campaigns.read');
  });

  it('refuse a key without the scope, and any parameter, before touching the database', async () => {
    expect(await refusal(apiListAds({ db: untouched }, ctx(['chat_links.read']), {}))).toEqual([
      'forbidden',
      [],
    ]);
    expect(await refusal(apiListAds({ db: untouched }, ctx(['ads.read']), { limit: '5' }))).toEqual(
      ['validation_failed', ['']],
    );
    expect(apiAdListQuerySchema.safeParse({}).success).toBe(true);
  });

  it('list the ads as Growth → Ads reads them, read only, while the company is suspended too', async () => {
    const { db, seen } = reading([
      {
        sourceId: '120200000000001',
        sourceType: 'ad',
        headline: 'Diwali offer',
        sourceUrl: 'https://fb.me/diwali',
        conversations: 3,
        messages: 5,
        lastAt: new Date('2026-10-06T09:30:00.000Z'),
      },
      {
        sourceId: null,
        sourceType: null,
        headline: null,
        sourceUrl: null,
        conversations: 1,
        messages: 1,
        lastAt: '2026-10-05T08:00:00+00:00',
      },
    ]);
    const listed = await apiListAds({ db }, ctx(['ads.read'], 'suspended'), {});
    expect(listed).toEqual({
      data: [
        {
          id: '120200000000001',
          type: 'ad',
          headline: 'Diwali offer',
          url: 'https://fb.me/diwali',
          last30Days: { conversations: 3, messages: 5 },
          lastMessageAt: '2026-10-06T09:30:00.000Z',
        },
        {
          id: null,
          type: null,
          headline: null,
          url: null,
          last30Days: { conversations: 1, messages: 1 },
          lastMessageAt: '2026-10-05T08:00:00.000Z',
        },
      ],
    });
    for (const ad of listed.data) expect(apiAdSchema.safeParse(ad).success).toBe(true);
    expect(seen.options).toEqual({ accessMode: 'read only' });
    // The key's company's ad sources of the last 30 days, grouped by what identifies the ad.
    expect(render(seen.where!)).toEqual([
      `("app"."conversation_sources"."tenant_id" = $1 and "app"."conversation_sources"."kind" = $2 and "app"."conversation_sources"."occurred_at" > now() - interval '30 days')`,
      [TENANT, 'ad'],
    ]);
    expect(seen.groupBy).toHaveLength(4);
    // The most conversations first, then the latest, ties broken by every grouped column.
    expect(seen.orderBy!.map((o) => render(o)[0])).toEqual([
      'count(distinct "app"."conversation_sources"."conversation_id") desc',
      'max("app"."conversation_sources"."occurred_at") desc',
      '"app"."conversation_sources"."ad_source_id" asc nulls last',
      '"app"."conversation_sources"."ad_source_type" asc nulls last',
      '"app"."conversation_sources"."ad_headline" asc nulls last',
      '"app"."conversation_sources"."ad_source_url" asc nulls last',
    ]);
    expect(seen.limit).toBe(GROWTH_LIMITS.adsShown);
    expect(Object.keys(seen.columns ?? {})).toEqual([
      'sourceId',
      'sourceType',
      'headline',
      'sourceUrl',
      'conversations',
      'messages',
      'lastAt',
    ]);
  });

  it('are described: the scope, the order, the limit, what is never kept', () => {
    expect(API_ROUTES).toContainEqual(['get', '/ads']);
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, { operationId: string; description: string }>>;
      components: { schemas: Record<string, { properties: Record<string, unknown> }> };
    };
    const list = doc.paths['/ads']?.get;
    expect(list?.operationId).toBe('listAds');
    for (const words of [
      'Scope: `ads.read`.',
      'as Growth → Ads lists them',
      `at most ${GROWTH_LIMITS.adsShown}, those that started the most conversations first`,
      'never the ad click id',
      'spend and costs are not given',
      '`GET /conversations?adId=` finds an ad’s conversations',
    ]) {
      expect(list?.description).toContain(words);
    }
    expect(Object.keys(doc.components.schemas.Ad?.properties ?? {})).toEqual([
      'id',
      'type',
      'headline',
      'url',
      'last30Days',
      'lastMessageAt',
    ]);
  });
});
