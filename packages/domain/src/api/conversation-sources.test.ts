import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { and, sql, type Database, type SQL, type Tx } from '@w360/db';
import { conversationSourceOf } from '../growth/sources';
import type { ApiContext } from './context';
import {
  apiConversationListQuerySchema,
  apiGetConversation,
  apiUpdateMatchingConversationsSchema,
  conversationFilterSql,
} from './conversations';
import { apiConversationSchema, buildOpenApiDocument } from './openapi';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f21';
const CONVERSATION = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f22';
const LINK = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f23';
const CONTACT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f24';
const NUMBER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f25';
const CREATED = new Date('2026-10-01T09:00:00.000Z');

const ctx = {
  tenant: { id: TENANT, status: 'active' },
  key: { id: 'k', scopes: new Set(['conversations.read']) },
  planScopes: null,
} as unknown as ApiContext;

/** SQL and its parameters as PostgreSQL receives them. */
const query = (condition: SQL) => {
  const { sql: text, params } = new PgDialect().sqlToQuery(condition);
  return [text.replace(/\s+/g, ' '), params];
};

/** A database whose one read answers with `rows`, recording what it selected and where. */
function reading(rows: unknown[]) {
  const seen: { columns?: Record<string, unknown>; where?: SQL; options?: unknown } = {};
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: (condition: SQL) => {
      seen.where = condition;
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

const row = (source: unknown) => ({
  id: CONVERSATION,
  contactId: CONTACT,
  channelId: NUMBER,
  status: 'open',
  assignedMembershipId: null,
  teamId: null,
  tags: [],
  source,
  unreadCount: 0,
  lastMessageAt: CREATED,
  lastInboundAt: CREATED,
  createdAt: CREATED,
  updatedAt: CREATED,
  resolvedAt: null,
});

describe('where conversations came from, through the API (ADR-301)', () => {
  it('filter GET /conversations, and the conversations a change finds, by source and chat link', () => {
    for (const input of [
      { source: 'link' },
      { source: 'ad' },
      { chatLinkId: LINK },
      { source: 'link', chatLinkId: LINK, status: 'open' },
      { adId: '120200000000001' },
      { source: 'ad', adId: ' 120200000000001 ' },
    ]) {
      expect(apiConversationListQuerySchema.safeParse(input).success, JSON.stringify(input)).toBe(
        true,
      );
      expect(
        apiUpdateMatchingConversationsSchema.safeParse({
          filter: input,
          change: { status: 'resolved' },
        }).success,
      ).toBe(true);
    }
    for (const input of [
      { source: 'campaign' },
      { source: 'LINK' },
      { chatLinkId: 'bio' },
      { adId: '' },
      { adId: '  ' },
      { adId: '1'.repeat(129) },
    ]) {
      expect(apiConversationListQuerySchema.safeParse(input).success, JSON.stringify(input)).toBe(
        false,
      );
    }
    const render = (filter: Parameters<typeof conversationFilterSql>[1]) =>
      query(and(...conversationFilterSql(TENANT, filter))!);
    const exists = (more: string) =>
      `exists (select 1 from "app"."conversation_sources" where ("app"."conversation_sources"."tenant_id" = "app"."conversations"."tenant_id" and "app"."conversation_sources"."conversation_id" = "app"."conversations"."id"${more}))`;
    expect(render({ source: 'link', chatLinkId: LINK })).toEqual([
      `("app"."conversations"."tenant_id" = $1 and ${exists(
        ` and "app"."conversation_sources"."kind" = $2 and "app"."conversation_sources"."link_id" = $3`,
      )})`,
      [TENANT, 'link', LINK],
    ]);
    expect(render({ source: 'ad' })).toEqual([
      `("app"."conversations"."tenant_id" = $1 and ${exists(
        ` and "app"."conversation_sources"."kind" = $2`,
      )})`,
      [TENANT, 'ad'],
    ]);
    expect(render({ chatLinkId: LINK })).toEqual([
      `("app"."conversations"."tenant_id" = $1 and ${exists(
        ` and "app"."conversation_sources"."link_id" = $2`,
      )})`,
      [TENANT, LINK],
    ]);
    // An ad's conversations (ADR-302), trimmed as Meta's ids are kept.
    expect(apiConversationListQuerySchema.parse({ adId: ' 120200000000001 ' }).adId).toBe(
      '120200000000001',
    );
    expect(render({ adId: '120200000000001' })).toEqual([
      `("app"."conversations"."tenant_id" = $1 and ${exists(
        ` and "app"."conversation_sources"."ad_source_id" = $2`,
      )})`,
      [TENANT, '120200000000001'],
    ]);
    expect(render({ status: 'open' })[0]).not.toContain('conversation_sources');
  });

  it('give each conversation its latest source, as the inbox shows it: a chat link, an ad or none', async () => {
    // The latest of the conversation's sources, in its company, with its link's name.
    expect(query(conversationSourceOf(sql`t.tenant`, sql`t.id`))).toEqual([
      [
        `(select jsonb_build_object('kind', s.kind, 'at', s.occurred_at, 'linkId', s.link_id,`,
        `'linkName', l.name, 'adId', s.ad_source_id, 'adType', s.ad_source_type,`,
        `'adHeadline', s.ad_headline, 'adUrl', s.ad_source_url)`,
        `from app.conversation_sources s`,
        `left join app.chat_links l on l.tenant_id = s.tenant_id and l.id = s.link_id`,
        `where s.tenant_id = t.tenant and s.conversation_id = t.id`,
        `order by s.occurred_at desc, s.id desc limit 1)`,
      ].join(' '),
      [],
    ]);
    const link = reading([
      row({
        kind: 'link',
        at: '2026-10-02T15:30:00.123456+00:00',
        linkId: LINK,
        linkName: 'Instagram bio',
        adId: null,
        adType: null,
        adHeadline: null,
        adUrl: null,
      }),
    ]);
    const fromLink = await apiGetConversation({ db: link.db }, ctx, CONVERSATION);
    expect(fromLink.source).toEqual({
      kind: 'link',
      at: '2026-10-02T15:30:00.123Z',
      chatLink: { id: LINK, name: 'Instagram bio' },
      ad: null,
    });
    expect(apiConversationSchema.safeParse(fromLink).success).toBe(true);
    // Each conversation's source is read with it, from its own row.
    expect(
      query((link.seen.columns?.source as { getSQL: () => SQL }).getSQL())[0] as string,
    ).toContain(
      `where s.tenant_id = "app"."conversations"."tenant_id" and s.conversation_id = "app"."conversations"."id"`,
    );
    expect(link.seen.options).toEqual({ accessMode: 'read only' });

    const ad = reading([
      row({
        kind: 'ad',
        at: '2026-10-03T08:00:00+00:00',
        linkId: null,
        linkName: null,
        adId: '120200000000001',
        adType: 'post',
        adHeadline: 'Diwali sale',
        adUrl: 'https://shop.example.test/diwali',
      }),
    ]);
    const fromAd = await apiGetConversation({ db: ad.db }, ctx, CONVERSATION);
    expect(fromAd.source).toEqual({
      kind: 'ad',
      at: '2026-10-03T08:00:00.000Z',
      chatLink: null,
      ad: {
        id: '120200000000001',
        type: 'post',
        headline: 'Diwali sale',
        url: 'https://shop.example.test/diwali',
      },
    });
    expect(apiConversationSchema.safeParse(fromAd).success).toBe(true);
    // An ad Meta sent without its id, type, headline or address is still an ad.
    const bare = reading([
      row({
        kind: 'ad',
        at: '2026-10-03T09:00:00+00:00',
        linkId: null,
        linkName: null,
        adId: null,
        adType: null,
        adHeadline: null,
        adUrl: null,
      }),
    ]);
    const fromBareAd = await apiGetConversation({ db: bare.db }, ctx, CONVERSATION);
    expect(fromBareAd.source).toEqual({
      kind: 'ad',
      at: '2026-10-03T09:00:00.000Z',
      chatLink: null,
      ad: { id: null, type: null, headline: null, url: null },
    });
    expect(apiConversationSchema.safeParse(fromBareAd).success).toBe(true);

    const none = reading([row(null)]);
    const plain = await apiGetConversation({ db: none.db }, ctx, CONVERSATION);
    expect(plain.source).toBeNull();
    expect(apiConversationSchema.safeParse(plain).success).toBe(true);
  });

  it('are described: the source of each conversation and the two filters', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<
        string,
        Record<string, { parameters: { name?: string; schema?: Record<string, unknown> }[] }>
      >;
      components: {
        schemas: Record<string, { properties: Record<string, Record<string, unknown>> }>;
      };
    };
    const params = doc.paths['/conversations']?.get?.parameters ?? [];
    expect(params.find((p) => p.name === 'source')?.schema).toEqual({
      type: 'string',
      enum: ['ad', 'link'],
    });
    expect(params.find((p) => p.name === 'chatLinkId')?.schema).toEqual({
      type: 'string',
      format: 'uuid',
    });
    expect(params.find((p) => p.name === 'adId')?.schema).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 128,
    });
    const source = doc.components.schemas.Conversation?.properties.source;
    expect(source?.description).toContain(
      'Where the conversation came from, as the inbox shows it',
    );
    expect(JSON.stringify(source)).toContain('never the ad click id');
  });
});
