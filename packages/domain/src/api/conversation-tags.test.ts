import { describe, expect, it } from 'vitest';
import type { ApiContext } from './context';
import {
  apiConversationListQuerySchema,
  apiUpdateConversation,
  apiUpdateConversationSchema,
  apiUpdateManyConversations,
  apiUpdateMatchingConversations,
  apiUpdateMatchingConversationsSchema,
  type ApiConversation,
} from './conversations';
import { buildOpenApiDocument } from './openapi';

const ctx = (scopes: string[]) =>
  ({
    tenant: { id: 't', status: 'active' },
    key: { id: 'k', scopes: new Set(scopes) },
    planScopes: null,
  }) as unknown as ApiContext;
const writer = ctx(['conversations.read', 'conversations.write']);

/** Deps whose database fails the test if anything reaches it. */
const unreachable = {
  db: {
    run: () => {
      throw new Error('the database was reached');
    },
  },
  clock: { now: () => new Date() },
} as never;

const ID = '0192f3a4-5b6c-7d8e-9f00-112233445566';

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; publicMessage: string; issues?: { path: string }[] };
  }
  throw new Error('accepted');
};

describe('conversation tags through the API (ADR-221)', () => {
  it('takes tags to add or remove as a change of their own, at most 20 of each', () => {
    expect(apiUpdateConversationSchema.parse({ addTags: ['VIP', 'refund'] })).toEqual({
      addTags: ['VIP', 'refund'],
    });
    expect(apiUpdateConversationSchema.safeParse({ removeTags: ['vip'] }).success).toBe(true);
    const none = apiUpdateConversationSchema.safeParse({});
    expect(none.error?.issues[0]?.message).toBe(
      'Give status, assigneeId, teamId, addTags or removeTags.',
    );
    const many = Array.from({ length: 21 }, (_, i) => `t${i}`);
    for (const bad of [
      { addTags: many },
      { removeTags: many },
      { addTags: ['x'.repeat(41)] },
      { addTags: 'vip' },
      { addTags: [3] },
      { tags: ['vip'] },
    ]) {
      expect(apiUpdateConversationSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(
      apiUpdateMatchingConversationsSchema.safeParse({
        filter: { tag: 'vip' },
        change: { removeTags: ['vip'] },
      }).success,
    ).toBe(true);
  });

  it('lists the conversations with a tag, refusing a value that cannot be a tag', () => {
    expect(apiConversationListQuerySchema.parse({ tag: ' VIP ' })).toMatchObject({
      tag: ' VIP ',
    });
    for (const tag of ['a,b', 'x'.repeat(41), ' ', 'bad\u0007tag']) {
      const parsed = apiConversationListQuerySchema.safeParse({ tag });
      expect(parsed.success, tag).toBe(false);
      expect(parsed.error?.issues[0]).toMatchObject({
        path: ['tag'],
        message: 'Give a tag: up to 40 characters, without commas.',
      });
    }
  });

  it('refuses tags that cannot be tags, or added and removed at once, before reading', async () => {
    expect(
      await refusal(apiUpdateConversation(unreachable, writer, ID, { addTags: ['ok', 'not,one'] })),
    ).toMatchObject({ code: 'validation_failed', issues: [{ path: 'addTags' }] });
    expect(
      await refusal(
        apiUpdateConversation(unreachable, writer, ID, {
          addTags: ['VIP'],
          removeTags: [' vip'],
        }),
      ),
    ).toMatchObject({
      code: 'validation_failed',
      publicMessage: 'The tag vip cannot be both added and removed.',
      issues: [{ path: 'removeTags' }],
    });
    expect(
      await refusal(
        apiUpdateManyConversations(unreachable, writer, {
          conversationIds: [ID],
          removeTags: ['ok', 'a,b'],
        }),
      ),
    ).toMatchObject({ code: 'validation_failed', issues: [{ path: 'removeTags' }] });
    expect(
      await refusal(
        apiUpdateManyConversations(unreachable, writer, {
          conversationIds: [ID],
          addTags: ['x'],
          removeTags: ['X'],
        }),
      ),
    ).toMatchObject({ issues: [{ path: 'removeTags' }] });
    expect(
      await refusal(
        apiUpdateMatchingConversations(unreachable, writer, {
          filter: { status: 'open' },
          change: { addTags: ['x'], removeTags: ['x'] },
        }),
      ),
    ).toMatchObject({ issues: [{ path: 'change.removeTags' }] });
    // Tagging needs conversations.write, as every change does.
    expect(
      await refusal(
        apiUpdateConversation(unreachable, ctx(['conversations.read']), ID, { addTags: ['x'] }),
      ),
    ).toMatchObject({ code: 'forbidden' });
    // A good change goes on to the database.
    await expect(
      apiUpdateConversation(unreachable, writer, ID, { addTags: ['vip'], removeTags: ['old'] }),
    ).rejects.toThrow('the database was reached');
  });

  it('describes the tags, the filter and the change in the API document, which names no ADR', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1') as unknown as {
      paths: Record<string, Record<string, { parameters?: { name?: string }[] }>>;
      components: {
        schemas: Record<string, { properties: Record<string, unknown>; required?: string[] }>;
      };
    };
    const conversation = doc.components.schemas.Conversation!;
    expect(conversation.properties.tags).toMatchObject({ type: 'array' });
    expect(conversation.required).toContain('tags');
    const shown: (keyof ApiConversation)[] = ['tags'];
    for (const key of shown) expect(Object.keys(conversation.properties)).toContain(key);
    expect(doc.paths['/conversations']!.get!.parameters!.map((p) => p.name)).toContain('tag');
    for (const schema of ['UpdateConversation', 'UpdateManyConversations']) {
      expect(Object.keys(doc.components.schemas[schema]!.properties), schema).toEqual(
        expect.arrayContaining(['addTags', 'removeTags']),
      );
    }
    expect(JSON.stringify(doc)).not.toMatch(/ADR-\d/);
  });
});
