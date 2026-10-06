import { describe, expect, it } from 'vitest';
import type { Database, TenantRole } from '@w360/db';
import type { TenantContext } from '../authz/context';
import { permissionsForRoles } from '../authz/permissions';
import {
  MAX_TAGS_PER_CONVERSATION,
  TAGS_IN_USE_LIMIT,
  createConversationTagsService,
  parseTagList,
} from './conversation-tags';

const ctxOf = (roles: TenantRole[]) =>
  ({
    tenant: { id: 't', status: 'active' },
    membership: { id: 'm' },
    permissions: permissionsForRoles(roles),
    rolePermissions: permissionsForRoles(roles),
    plan: { modules: new Set() },
    mfa: { blocking: false },
  }) as unknown as TenantContext;

/** A service whose database fails the test if anything reaches it. */
const service = createConversationTagsService({
  db: {
    run: () => {
      throw new Error('the database was reached');
    },
  } as unknown as Database,
});

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error as { code: string; publicMessage: string; issues: { path: string }[] };
  }
  throw new Error('accepted');
};

const CONVERSATION = '0192f3a4-5b6c-7d8e-9f00-112233445566';

describe('conversation tags (ADR-220)', () => {
  it('reads what a member typed as tags: split at commas, written as tags are, once each', () => {
    expect(parseTagList(' Refund , VIP,refund,, ')).toEqual(['refund', 'vip']);
    expect(parseTagList('Follow \t  up')).toEqual(['follow up']);
    // Full-width letters are written as their plain forms, as contact tags are.
    expect(parseTagList('ＶＩＰ')).toEqual(['vip']);
    expect(parseTagList('x'.repeat(40))).toEqual(['x'.repeat(40)]);
    expect(MAX_TAGS_PER_CONVERSATION).toBe(20);
    expect(TAGS_IN_USE_LIMIT).toBe(200);
  });

  it('refuses a list with nothing to tag, or with a piece that cannot be a tag', () => {
    for (const blank of ['', ' ', ' , ,']) {
      expect(refusal(() => parseTagList(blank))).toMatchObject({
        code: 'validation_failed',
        publicMessage: 'Write a tag.',
        issues: [{ path: 'tags' }],
      });
    }
    expect(refusal(() => parseTagList(`ok, ${'x'.repeat(41)}`))).toMatchObject({
      publicMessage: 'Tags are limited to 40 characters.',
      issues: [{ path: 'tags' }],
    });
    expect(refusal(() => parseTagList('bad\u0007tag')).publicMessage).toBe(
      'Tags cannot contain commas or control characters.',
    );
    // A full-width comma becomes a comma, which no tag holds.
    expect(refusal(() => parseTagList('vip，ok')).publicMessage).toBe(
      'Tags cannot contain commas or control characters.',
    );
  });

  it('checks the permission, then the input, before reaching the database', async () => {
    const owner = ctxOf(['owner']);
    // A marketer has no inbox.
    await expect(
      service.addTags(ctxOf(['marketer']), { conversationId: CONVERSATION, tags: 'vip' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      service.removeTag(ctxOf(['marketer']), { conversationId: CONVERSATION, tag: 'vip' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(service.tagsInUse(ctxOf(['marketer']))).rejects.toMatchObject({
      code: 'forbidden',
    });
    // An analyst reads reports, not conversations.
    await expect(service.tagsInUse(ctxOf(['analyst']))).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      service.addTags(owner, { conversationId: 'nope', tags: 'vip' }),
    ).rejects.toMatchObject({ code: 'validation_failed', issues: [{ path: 'conversationId' }] });
    await expect(
      // 200 short tags: each could be one, but not typed at once.
      service.addTags(owner, {
        conversationId: CONVERSATION,
        tags: Array.from({ length: 200 }, (_, i) => `tag${i}`).join(','),
      }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      publicMessage: 'Add fewer tags at once.',
      issues: [{ path: 'tags' }],
    });
    await expect(
      service.addTags(owner, { conversationId: CONVERSATION, tags: ', ,' }),
    ).rejects.toMatchObject({ code: 'validation_failed', publicMessage: 'Write a tag.' });
    await expect(
      service.removeTag(owner, { conversationId: CONVERSATION, tag: ' ' }),
    ).rejects.toMatchObject({ code: 'validation_failed', issues: [{ path: 'tag' }] });
    await expect(
      service.removeTag(owner, { conversationId: CONVERSATION, tag: 'a,b' }),
    ).rejects.toMatchObject({ code: 'validation_failed', issues: [{ path: 'tag' }] });
    // An agent may tag: the database is the next step.
    await expect(
      service.addTags(ctxOf(['agent']), { conversationId: CONVERSATION, tags: 'vip' }),
    ).rejects.toThrow('the database was reached');
    await expect(service.tagsInUse(ctxOf(['agent']))).rejects.toThrow('the database was reached');
  });
});
