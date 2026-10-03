import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { AppError, isAppError, sha256Hex } from '@w360/core';
import { API_SCOPES } from '@w360/db';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../authz/permissions';
import { apiErrorResponse, apiRequestError } from './errors';
import { allowedNetworksSchema, bearerToken, generateApiToken, networkEntryProblem } from './keys';
import {
  apiAddressRefusal,
  assertAnyScope,
  assertScope,
  hasScope,
  type ApiContext,
} from './context';
import { apiScopesNotInPlan, scopesNotInPlan } from '../plans/entitlements';
import {
  apiAddConversationNote,
  apiAddNoteSchema,
  apiConversationListQuerySchema,
  apiListConversationNotes,
  apiListMessages,
  apiMessageFeedQuerySchema,
  apiNoteListQuerySchema,
  apiUpdateConversation,
  apiUpdateConversationSchema,
  apiUpdateManyConversations,
  apiUpdateManyConversationsSchema,
} from './conversations';
import { apiListMembers, apiListTeams, apiMemberListQuerySchema } from './members';
import { apiContactSchema } from './contact-view';
import {
  API_CONTACT_SEARCH_WINDOW,
  apiContactFieldsSchema,
  apiContactListFilters,
  apiContactUpdateSchema,
  apiListContactFields,
  apiTags,
  apiUpdateContact,
  apiUpdateManyContacts,
  apiUpdateManyContactsSchema,
  contactListQuery,
} from './contacts';
import {
  API_LIMITS,
  API_SCOPE_INFO,
  API_SCOPE_KEYS,
  API_SEND_SCOPES,
  API_TOKEN_RE,
  IDEMPOTENCY_KEY_RE,
  apiKeyState,
  formatAllowedNetwork,
} from './model';
import { API_ROUTES, buildOpenApiDocument } from './openapi';
import {
  INTERACTIVE_LIMITS,
  listContent,
  listInteractive,
  replyButtonsContent,
  replyButtonsInteractive,
} from '../messaging/interactive';
import { messageSnippet, SNIPPET_LENGTH } from '../messaging/message-text';
import { NOTE_MAX_LENGTH } from '../messaging/notes';
import {
  answerProblem,
  answeredExternalIdOf,
  isSingleEmoji,
  REACTION_MAX_AGE_MS,
  type AnswerTarget,
} from '../messaging/reply-context';
import {
  apiContactListQuerySchema,
  apiListContacts,
  apiSendButtonsSchema,
  apiSendCatalogSchema,
  apiSendListSchema,
  apiSendMessage,
  apiSendProductListSchema,
  apiSendProductSchema,
  apiSendReactionSchema,
  apiSendTextSchema,
} from './resources';
import {
  apiCreateWebhookEndpointSchema,
  apiUpdateWebhookEndpointSchema,
  apiReplayFailedDeliveriesSchema,
  apiWebhookDeliveryListQuerySchema,
  createApiWebhookEndpoints,
  endpointAnnouncement,
} from './webhook-endpoints';

describe('API tokens', () => {
  it('have a public prefix, a 256-bit secret and only their SHA-256 is kept', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const { keyPrefix, token, tokenHash } = generateApiToken();
      expect(keyPrefix).toMatch(/^w360_[a-z2-7]{12}$/);
      expect(token).toMatch(API_TOKEN_RE);
      expect(token.startsWith(`${keyPrefix}_`)).toBe(true);
      expect(token.slice(keyPrefix.length + 1)).toHaveLength(43);
      expect(tokenHash).toBe(sha256Hex(token));
      expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
      seen.add(keyPrefix);
      seen.add(token);
    }
    expect(seen.size).toBe(400);
  });

  it('are read from a bearer header only when they have the token shape', () => {
    const { token } = generateApiToken();
    expect(bearerToken(`Bearer ${token}`)).toBe(token);
    expect(bearerToken(`bearer ${token}`)).toBe(token);
    expect(bearerToken(`  Bearer ${token}  `)).toBe(token);
    for (const header of [
      null,
      undefined,
      '',
      'Bearer',
      'Bearer ',
      token,
      `Basic ${token}`,
      `Bearer  ${token}`,
      `Bearer ${token} ${token}`,
      `Bearer ${token}x`,
      `Bearer ${token.slice(0, -1)}`,
      `Bearer ${token.replace('w360_', 'w361_')}`,
      `Bearer ${token.toUpperCase()}`,
    ]) {
      expect(bearerToken(header)).toBeNull();
    }
  });
});

describe('API scopes', () => {
  it('are the scopes the database accepts, each granted by a real permission', () => {
    expect([...API_SCOPE_KEYS].sort()).toEqual([...API_SCOPES].sort());
    expect(Object.keys(API_SCOPE_INFO).sort()).toEqual([...API_SCOPES].sort());
    for (const scope of API_SCOPE_KEYS) {
      expect(PERMISSIONS).toContain(API_SCOPE_INFO[scope].permission);
    }
  });

  it('mark exactly the changing scopes as writes (refused while a company is not active)', () => {
    const writes = API_SCOPE_KEYS.filter((s) => API_SCOPE_INFO[s].writes);
    expect(writes).toEqual([
      'contacts.write',
      'contact_fields.manage',
      'messages.send',
      'messages.send_marketing',
      'messages.reply',
      'conversations.write',
      'automations.start',
      'webhooks.manage',
    ]);
    expect([...API_SEND_SCOPES]).toEqual(API_SCOPE_KEYS.filter((s) => s.startsWith('messages.')));
  });

  it('need the permission a member needs for the same work', () => {
    expect(API_SCOPE_INFO['messages.send'].permission).toBe('inbox.reply');
    expect(API_SCOPE_INFO['messages.send_marketing'].permission).toBe('campaigns.send');
    expect(API_SCOPE_INFO['messages.reply'].permission).toBe('inbox.reply');
    expect(API_SCOPE_INFO['contacts.write'].permission).toBe('contacts.write');
    // Members define fields in Settings with tenant.settings.manage (ADR-115).
    expect(API_SCOPE_INFO['contact_fields.manage'].permission).toBe('tenant.settings.manage');
    expect(API_SCOPE_INFO['conversations.read'].permission).toBe('inbox.read_all');
    expect(API_SCOPE_INFO['conversations.write'].permission).toBe('inbox.supervise');
    expect(API_SCOPE_INFO['automations.start'].permission).toBe('automations.publish');
    expect(API_SCOPE_INFO['webhooks.manage'].permission).toBe('developer.manage');
  });

  it('let only members who manage webhook endpoints in settings grant webhooks.manage, who also read every conversation (ADR-081)', () => {
    const granting = Object.entries(ROLE_PERMISSIONS).filter(([, permissions]) =>
      permissions.has('developer.manage'),
    );
    expect(granting.map(([role]) => role).sort()).toEqual(['admin', 'owner']);
    // An endpoint for message.received gets what contacts write: the grantors read it all already.
    for (const [, permissions] of granting) expect(permissions.has('inbox.read_all')).toBe(true);
  });

  it('let only members who publish automations grant automations.start (ADR-077)', () => {
    const granting = Object.entries(ROLE_PERMISSIONS).filter(([, permissions]) =>
      permissions.has('automations.publish'),
    );
    expect(granting.map(([role]) => role).sort()).toEqual(['admin', 'owner']);
  });

  it('let only members who resolve and assign every conversation in the inbox grant conversations.write', () => {
    const granting = Object.entries(ROLE_PERMISSIONS).filter(([, permissions]) =>
      permissions.has('inbox.supervise'),
    );
    expect(granting.map(([role]) => role).sort()).toEqual(['admin', 'owner', 'supervisor']);
    for (const [, permissions] of granting) {
      expect(permissions.has('inbox.read_all')).toBe(true);
      expect(permissions.has('inbox.reply')).toBe(true);
      // Assigning conversations and moving them between teams (ADR-093).
      expect(permissions.has('inbox.assign')).toBe(true);
    }
  });

  it('let only members who see the team grant conversations.read, which names members (ADR-093)', () => {
    const granting = Object.entries(ROLE_PERMISSIONS).filter(([, permissions]) =>
      permissions.has('inbox.read_all'),
    );
    expect(granting.map(([role]) => role).sort()).toEqual(['admin', 'owner', 'supervisor']);
    for (const [, permissions] of granting) expect(permissions.has('members.read')).toBe(true);
  });
});

describe('scopes by plan (ADR-092)', () => {
  const ctx = (scopes: string[], planScopes: string[] | null, status = 'active') =>
    ({
      tenant: { id: 't', status },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: planScopes === null ? null : new Set(planScopes),
    }) as unknown as ApiContext;
  const refusal = (run: () => void) => {
    try {
      run();
    } catch (error) {
      return isAppError(error)
        ? { code: error.code, message: error.publicMessage, details: error.details }
        : error;
    }
    return 'allowed';
  };

  it('let a request use a scope only when its key has it and the plan includes it', () => {
    const c = ctx(['contacts.read', 'webhooks.manage'], ['contacts.read', 'templates.read']);
    expect(hasScope(c, 'contacts.read')).toBe(true);
    expect(hasScope(c, 'webhooks.manage')).toBe(false);
    expect(hasScope(c, 'templates.read')).toBe(false);
    expect(hasScope(ctx(['webhooks.manage'], null), 'webhooks.manage')).toBe(true);
    expect(refusal(() => assertScope(c, 'contacts.read'))).toBe('allowed');
    expect(refusal(() => assertScope(c, 'webhooks.manage'))).toEqual({
      code: 'forbidden',
      message:
        "Your company's plan does not include the webhooks.manage scope. Ask HyFib to change the plan.",
      details: { apiReason: 'not_in_plan' },
    });
    // The key's own scopes are checked first, with the message they always had.
    expect(refusal(() => assertScope(c, 'templates.read'))).toMatchObject({
      message: 'This API key does not have the templates.read scope.',
      details: undefined,
    });
    // Plan before the company's status: a suspended company hears the plan leaves the scope out.
    expect(
      refusal(() =>
        assertScope(ctx(['contacts.write'], ['contacts.read'], 'suspended'), 'contacts.write'),
      ),
    ).toMatchObject({ details: { apiReason: 'not_in_plan' } });
  });

  it('refuse a read any of several scopes allows only when the plan leaves out all the key has', () => {
    const sending = ['messages.send', 'messages.send_marketing', 'messages.reply'] as const;
    expect(
      refusal(() =>
        assertAnyScope(ctx(['messages.send', 'messages.reply'], ['messages.reply']), sending),
      ),
    ).toBe('allowed');
    // Reads stay allowed while the company is suspended.
    expect(refusal(() => assertAnyScope(ctx(['messages.reply'], null, 'suspended'), sending))).toBe(
      'allowed',
    );
    expect(
      refusal(() => assertAnyScope(ctx(['messages.reply'], ['contacts.read']), sending)),
    ).toMatchObject({
      message:
        "Your company's plan does not include the messages.reply scope. Ask HyFib to change the plan.",
    });
    expect(refusal(() => assertAnyScope(ctx(['contacts.read'], null), sending))).toMatchObject({
      message: 'This API key does not have the messages.send scope.',
    });
  });

  it('name the scopes the plan leaves out', () => {
    const plan = { apiScopes: new Set(['contacts.read'] as const) };
    expect(scopesNotInPlan(plan, ['contacts.read', 'messages.send', 'webhooks.manage'])).toEqual([
      'messages.send',
      'webhooks.manage',
    ]);
    expect(scopesNotInPlan({ apiScopes: null }, ['webhooks.manage'])).toEqual([]);
    expect(
      apiScopesNotInPlan(['messages.send', 'conversations.read', 'webhooks.manage']).publicMessage,
    ).toBe(
      "Your company's plan does not include the messages.send, conversations.read and webhooks.manage scopes. Ask HyFib to change the plan.",
    );
  });
});

describe('conversation changes (ADR-075, ADR-093)', () => {
  const ctx = (scopes: string[], status = 'active') =>
    ({
      tenant: { id: 't', status },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: null,
    }) as unknown as ApiContext;
  const id = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
  const other = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'resolved',
      (error: unknown) => (isAppError(error) ? error.code : String(error)),
    );

  it('take a status the inbox sets, a member, a team or null for none, at least one of them', () => {
    for (const body of [
      { status: 'resolved' },
      { status: 'open' },
      { assigneeId: id },
      { assigneeId: null },
      { teamId: id },
      { teamId: null },
      { assigneeId: null, teamId: null },
      { status: 'resolved', assigneeId: id, teamId: other },
    ]) {
      expect(apiUpdateConversationSchema.parse(body)).toEqual(body);
    }
    for (const bad of [
      {},
      { status: 'pending' },
      { status: 'closed' },
      { status: 'RESOLVED' },
      { status: null },
      { status: 'resolved', assigned: false },
      { assigneeId: 'none' },
      { assigneeId: 'agent@example.com' },
      { teamId: 'none' },
      { teamId: 5 },
      { assignee: id },
      'resolved',
      null,
    ]) {
      expect(apiUpdateConversationSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('list by member or team, or those without one', () => {
    for (const query of [
      { assigneeId: id },
      { assigneeId: 'none' },
      { teamId: id },
      { teamId: 'none' },
      { assigneeId: 'none', teamId: other, status: 'open' },
    ]) {
      expect(apiConversationListQuerySchema.parse(query)).toMatchObject(query);
    }
    for (const bad of [{ assigneeId: 'nobody' }, { teamId: 'None' }, { assignee: id }]) {
      expect(apiConversationListQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  it('are refused before anything is read: without the scope, while the company is not active, for ids that are not ids, and for other bodies', async () => {
    const set = (c: ApiContext, conversationId: string, body: unknown) =>
      code(apiUpdateConversation({} as never, c, conversationId, body));
    for (const body of [{ status: 'resolved' }, { assigneeId: id }, { teamId: null }]) {
      expect(await set(ctx(['conversations.read']), id, body)).toBe('forbidden');
      for (const status of ['suspended', 'restricted']) {
        expect(await set(ctx(['conversations.write'], status), id, body)).toBe('tenant_suspended');
      }
      expect(await set(ctx(['conversations.write']), 'not-a-uuid', body)).toBe('not_found');
    }
    for (const body of [{ status: 'pending' }, {}, { assigneeId: 'none' }]) {
      expect(await set(ctx(['conversations.write']), id, body)).toBe('validation_failed');
    }
  });

  it('change 1 to 100 conversations at once, each named once, with the same fields (ADR-120)', async () => {
    expect(API_LIMITS.conversationsPerChange).toBe(100);
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `0192f0c4-8e2b-7c1d-9a3e-${String(i).padStart(12, '0')}`);
    for (const body of [
      { conversationIds: [id], status: 'resolved' },
      { conversationIds: [id, other], assigneeId: id },
      { conversationIds: ids(API_LIMITS.conversationsPerChange), teamId: null },
      { conversationIds: [other, id], status: 'open', assigneeId: null, teamId: other },
    ]) {
      expect(apiUpdateManyConversationsSchema.parse(body)).toEqual(body);
    }
    for (const bad of [
      { conversationIds: [], status: 'resolved' },
      { conversationIds: ids(API_LIMITS.conversationsPerChange + 1), status: 'resolved' },
      { conversationIds: [id, id], status: 'resolved' },
      { conversationIds: ['not-a-uuid'], status: 'resolved' },
      { conversationIds: id, status: 'resolved' },
      { conversationIds: [id] },
      { status: 'resolved' },
      { conversationIds: [id], status: 'pending' },
      { conversationIds: [id], assigneeId: 'none' },
      { conversationIds: [id], status: 'resolved', note: 'Closing' },
    ]) {
      expect(
        apiUpdateManyConversationsSchema.safeParse(bad).success,
        JSON.stringify(bad).slice(0, 80),
      ).toBe(false);
    }
    const many = (c: ApiContext, body: unknown) =>
      code(apiUpdateManyConversations({} as never, c, body));
    const body = { conversationIds: [id, other], status: 'resolved' };
    expect(await many(ctx(['conversations.read']), body)).toBe('forbidden');
    for (const status of ['suspended', 'restricted']) {
      expect(await many(ctx(['conversations.write'], status), body)).toBe('tenant_suspended');
    }
    for (const bad of [
      { conversationIds: [id, id], status: 'resolved' },
      { conversationIds: [id] },
    ]) {
      expect(await many(ctx(['conversations.write']), bad)).toBe('validation_failed');
    }
  });

  it('read members and teams with conversations.read only, checking the page asked for first', async () => {
    for (const list of [apiListMembers, apiListTeams]) {
      expect(await code(list({} as never, ctx(['conversations.write']), {}))).toBe('forbidden');
      for (const query of [{ limit: 0 }, { limit: API_LIMITS.pageSize + 1 }, { team: id }]) {
        expect(await code(list({} as never, ctx(['conversations.read']), query))).toBe(
          'validation_failed',
        );
      }
      expect(await code(list({} as never, ctx(['conversations.read']), { cursor: 'x' }))).toBe(
        'validation_failed',
      );
    }
    expect(apiMemberListQuerySchema.parse({})).toEqual({ limit: 50 });
  });
});

describe('internal notes (ADR-084)', () => {
  const ctx = (scopes: string[], status = 'active') =>
    ({
      tenant: { id: 't', status },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: null,
    }) as unknown as ApiContext;
  const id = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';

  it('take 1 to 4000 characters of trimmed text, as members’ notes do, and nothing else', () => {
    expect(apiAddNoteSchema.parse({ text: '  Ticket #4521 opened in the helpdesk.  ' })).toEqual({
      text: 'Ticket #4521 opened in the helpdesk.',
    });
    const long = 'x'.repeat(NOTE_MAX_LENGTH);
    expect(apiAddNoteSchema.parse({ text: long })).toEqual({ text: long });
    expect(NOTE_MAX_LENGTH).toBe(4000);
    for (const bad of [
      {},
      { text: '   ' },
      { text: `${long}x` },
      { text: 7 },
      { text: 'Hi', mentionIds: [id] },
      { body: 'Hi' },
      'Hi',
      null,
    ]) {
      expect(apiAddNoteSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('are refused before anything is read: without the scope, while the company is not active, for ids that are not ids, and for other bodies', async () => {
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => 'added',
        (error: unknown) => (isAppError(error) ? error.code : String(error)),
      );
    const idempotency = { key: 'n-1', requestHash: 'h' };
    const add = (c: ApiContext, conversationId: string, body: unknown) =>
      code(apiAddConversationNote({} as never, c, conversationId, body, idempotency));
    const body = { text: 'Refund issued.' };
    expect(await add(ctx(['conversations.read', 'messages.reply']), id, body)).toBe('forbidden');
    for (const status of ['suspended', 'restricted']) {
      expect(await add(ctx(['conversations.write'], status), id, body)).toBe('tenant_suspended');
    }
    expect(await add(ctx(['conversations.write']), 'not-a-uuid', body)).toBe('not_found');
    expect(await add(ctx(['conversations.write']), id, { text: '' })).toBe('validation_failed');
  });

  it('are described: one per Idempotency-Key, never sent to WhatsApp', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const post = (
      doc.paths as unknown as Record<
        string,
        Record<
          string,
          {
            description: string;
            parameters: unknown[];
            requestBody: unknown;
            responses: Record<string, unknown>;
          }
        >
      >
    )['/conversations/{id}/notes']?.post;
    expect(post?.parameters).toContainEqual({ $ref: '#/components/parameters/IdempotencyKey' });
    expect(post?.description).toContain('WhatsApp never receives it');
    expect(JSON.stringify(post?.requestBody)).toContain('#/components/schemas/AddConversationNote');
    expect(JSON.stringify(post?.responses['201'])).toContain(
      '#/components/schemas/ConversationNote',
    );
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    expect(schemas.AddConversationNote).toMatchObject({
      required: ['text'],
      additionalProperties: false,
      properties: { text: { type: 'string', minLength: 1, maxLength: NOTE_MAX_LENGTH } },
    });
    expect(Object.keys(schemas.ConversationNote?.properties as object).sort()).toEqual([
      'apiKeyId',
      'conversationId',
      'createdAt',
      'id',
      'text',
      'writtenBy',
    ]);
  });
});

describe('reading notes (ADR-089)', () => {
  it('takes a page and nothing else', () => {
    expect(apiNoteListQuerySchema.parse({ limit: '5', cursor: 'abc' })).toEqual({
      limit: 5,
      cursor: 'abc',
    });
    expect(apiNoteListQuerySchema.parse({})).toEqual({ limit: 50 });
    for (const bad of [{ limit: '0' }, { limit: '101' }, { since: 'now' }, { writtenBy: 'api' }]) {
      expect(apiNoteListQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('need the scope that reads conversations, checked before anything is read', async () => {
    const ctx = (scopes: string[]) =>
      ({
        tenant: { id: 't', status: 'active' },
        key: { id: 'k', scopes: new Set(scopes) },
        planScopes: null,
      }) as unknown as ApiContext;
    const id = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
    const codeOf = (promise: Promise<unknown>) =>
      promise.then(
        () => 'resolved',
        (caught: unknown) => (isAppError(caught) ? caught.code : 'other'),
      );
    expect(
      await codeOf(apiListConversationNotes({} as never, ctx(['conversations.write']), id, {})),
    ).toBe('forbidden');
    const reader = ctx(['conversations.read']);
    expect(await codeOf(apiListConversationNotes({} as never, reader, 'nope', {}))).toBe(
      'not_found',
    );
    expect(await codeOf(apiListConversationNotes({} as never, reader, id, { limit: 'many' }))).toBe(
      'validation_failed',
    );
  });

  it('are described: newest first, who wrote each without naming members', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const get = (
      doc.paths as unknown as Record<
        string,
        Record<
          string,
          {
            operationId: string;
            description: string;
            parameters: { name?: string; $ref?: string }[];
            responses: Record<string, unknown>;
          }
        >
      >
    )['/conversations/{id}/notes']?.get;
    expect(get?.operationId).toBe('listConversationNotes');
    expect(get?.description).toContain('`conversations.read`');
    expect(get?.description).toContain('Never which member wrote a note or whom it mentions');
    expect(get?.parameters.map((p) => p.name ?? p.$ref)).toEqual([
      '#/components/parameters/Id',
      'limit',
      'cursor',
    ]);
    expect(JSON.stringify(get?.responses['200'])).toContain(
      '#/components/schemas/ConversationNote',
    );
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const note = schemas.ConversationNote as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(note.required).toEqual(expect.arrayContaining(['writtenBy', 'apiKeyId']));
    expect(note.properties.writtenBy).toMatchObject({ enum: ['agent', 'api'] });
    expect(JSON.stringify(note.properties.apiKeyId)).toContain('null');
  });
});

describe('the message feed (ADR-088)', () => {
  it('takes a page, a direction, a number and a time, and nothing else', () => {
    const channelId = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
    expect(
      apiMessageFeedQuerySchema.parse({
        limit: '20',
        direction: 'inbound',
        channelId,
        since: '2026-09-30T10:00:00+05:30',
      }),
    ).toEqual({ limit: 20, direction: 'inbound', channelId, since: '2026-09-30T10:00:00+05:30' });
    expect(apiMessageFeedQuerySchema.parse({})).toEqual({ limit: 50 });
    for (const bad of [
      { limit: '0' },
      { limit: '101' },
      { direction: 'both' },
      { channelId: 'main' },
      { since: 'yesterday' },
      { status: 'read' },
    ]) {
      expect(apiMessageFeedQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('needs the scope that reads conversations, checked before anything is read', async () => {
    const ctx = (scopes: string[]) =>
      ({
        tenant: { id: 't', status: 'active' },
        key: { id: 'k', scopes: new Set(scopes) },
        planScopes: null,
      }) as unknown as ApiContext;
    for (const scopes of [['messages.send', 'messages.reply'], ['conversations.write']]) {
      const error: unknown = await apiListMessages({} as never, ctx(scopes), {}).catch(
        (caught: unknown) => caught,
      );
      expect(isAppError(error) && error.code, scopes.join()).toBe('forbidden');
    }
    const refused: unknown = await apiListMessages({} as never, ctx(['conversations.read']), {
      direction: 'sideways',
    }).catch((caught: unknown) => caught);
    expect(isAppError(refused) && refused.code).toBe('validation_failed');
  });
});

describe('text replies (ADR-070)', () => {
  const base = { type: 'text', to: '+919876543210' };

  it('take 1 to 4096 characters of trimmed text, with link previews off unless asked for', () => {
    expect(apiSendTextSchema.parse({ ...base, text: '  Your order ships today.  ' })).toEqual({
      ...base,
      text: 'Your order ships today.',
      previewUrl: false,
    });
    const long = 'x'.repeat(API_LIMITS.textLength);
    expect(apiSendTextSchema.parse({ ...base, text: long, previewUrl: true })).toMatchObject({
      text: long,
      previewUrl: true,
    });
    for (const bad of [
      { ...base, text: '   ' },
      { ...base, text: `${long}x` },
      { ...base },
      { ...base, text: 'Hi', templateId: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01' },
      { ...base, text: 'Hi', from: 'not-a-number-id' },
      { ...base, type: 'template', text: 'Hi' },
    ]) {
      expect(apiSendTextSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('are chosen by the body’s type; any other type is refused before anything is read', async () => {
    const ctx = {
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set() },
      planScopes: null,
    } as unknown as ApiContext;
    const idem = { key: 'k-1', requestHash: 'h' };
    for (const body of [{ type: 'image' }, { type: 'TEXT' }, { type: null }]) {
      const error: unknown = await apiSendMessage(
        {} as never,
        ctx,
        { ...body, to: '+919876543210' },
        idem,
      ).catch((caught: unknown) => caught);
      expect(isAppError(error) && error.code, JSON.stringify(body)).toBe('validation_failed');
      expect(isAppError(error) && error.issues?.[0]?.path).toBe('type');
    }
  });
});

describe('reply buttons and lists (ADR-080)', () => {
  const base = { to: '+919876543210' };
  const buttons = {
    ...base,
    type: 'buttons',
    header: '  Your appointment ',
    body: 'Tomorrow at 10:00 with Dr Rao. Can you come?',
    footer: 'Sunrise Clinic',
    buttons: [
      { id: 'appt-42:yes', title: ' Confirm ' },
      { id: 'appt-42:move', title: 'Reschedule' },
      { id: 'appt-42:no', title: 'Cancel' },
    ],
  };
  const list = {
    ...base,
    type: 'list',
    body: 'Pick a time for tomorrow.',
    button: 'See times',
    sections: [
      {
        title: 'Morning',
        rows: [
          { id: 'slot-10', title: '10:00', description: 'Dr Rao' },
          { id: 'slot-11', title: '11:00' },
        ],
      },
      { title: 'Afternoon', rows: [{ id: 'slot-15', title: '15:00', description: 'Dr Iyer' }] },
    ],
  };
  const refused = (schema: typeof apiSendButtonsSchema | typeof apiSendListSchema, body: unknown) =>
    schema.safeParse(body).success;

  it('use Meta’s published limits, with 10 rows in all (research M-157, M-159, M-179, M-181)', () => {
    expect(INTERACTIVE_LIMITS).toEqual({
      headerLength: 60,
      bodyLength: 1024,
      footerLength: 60,
      buttons: 3,
      buttonIdLength: 256,
      buttonTitleLength: 20,
      listButtonLength: 20,
      sections: 10,
      sectionTitleLength: 24,
      rows: 10,
      rowIdLength: 200,
      rowTitleLength: 24,
      rowDescriptionLength: 72,
    });
  });

  it('take 1 to 3 buttons with ids kept as given and trimmed texts within Meta’s limits', () => {
    expect(apiSendButtonsSchema.parse(buttons)).toEqual({
      ...buttons,
      header: 'Your appointment',
      buttons: [{ id: 'appt-42:yes', title: 'Confirm' }, ...buttons.buttons.slice(1)],
    });
    const L = INTERACTIVE_LIMITS;
    const one = {
      ...base,
      type: 'buttons',
      body: 'x'.repeat(L.bodyLength),
      buttons: [{ id: 'i'.repeat(L.buttonIdLength), title: 't'.repeat(L.buttonTitleLength) }],
    };
    expect(apiSendButtonsSchema.safeParse(one).success).toBe(true);
    const button = (b: Record<string, unknown>) => ({
      ...base,
      type: 'buttons',
      body: 'Hi',
      buttons: [b],
    });
    for (const bad of [
      { ...buttons, buttons: [] },
      { ...buttons, buttons: [...buttons.buttons, { id: 'four', title: 'Four' }] },
      {
        ...buttons,
        buttons: [
          { id: 'a', title: 'Yes' },
          { id: 'b', title: 'YES' },
        ],
      },
      {
        ...buttons,
        buttons: [
          { id: 'a', title: 'Yes' },
          { id: 'a', title: 'No' },
        ],
      },
      button({ id: ' a', title: 'Yes' }),
      button({ id: 'a ', title: 'Yes' }),
      button({ id: '', title: 'Yes' }),
      button({ id: 'i'.repeat(L.buttonIdLength + 1), title: 'Yes' }),
      button({ id: 'a', title: 't'.repeat(L.buttonTitleLength + 1) }),
      button({ id: 'a', title: '   ' }),
      button({ id: 'w360csat:0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01:3', title: 'Great' }),
      button({ id: 'W360bot:run:node:1:0', title: 'Yes' }),
      button({ id: 'a', title: 'Yes', url: 'https://example.com' }),
      { ...one, body: 'x'.repeat(L.bodyLength + 1) },
      { ...one, header: 'h'.repeat(L.headerLength + 1) },
      { ...one, footer: 'f'.repeat(L.footerLength + 1) },
      { ...one, body: '  ' },
      { ...one, text: 'Hi' },
      { ...one, type: 'list' },
    ]) {
      expect(refused(apiSendButtonsSchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('take up to 10 rows in all, in titled sections, with unique ids within Meta’s limits', () => {
    expect(apiSendListSchema.parse(list)).toEqual(list);
    const L = INTERACTIVE_LIMITS;
    const rows = (n: number, prefix = 'r') =>
      Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, title: `Row ${i}` }));
    const single = (section: Record<string, unknown>) => ({ ...list, sections: [section] });
    expect(apiSendListSchema.safeParse(single({ rows: rows(L.rows) })).success).toBe(true);
    const longest = {
      id: 'i'.repeat(L.rowIdLength),
      title: 't'.repeat(L.rowTitleLength),
      description: 'd'.repeat(L.rowDescriptionLength),
    };
    expect(
      apiSendListSchema.safeParse(
        single({ title: 's'.repeat(L.sectionTitleLength), rows: [longest] }),
      ).success,
    ).toBe(true);
    for (const bad of [
      single({ rows: rows(L.rows + 1) }),
      {
        ...list,
        sections: [
          { title: 'A', rows: rows(6, 'a') },
          { title: 'B', rows: rows(5, 'b') },
        ],
      },
      { ...list, sections: [{ title: 'A', rows: rows(1, 'a') }, { rows: rows(1, 'b') }] },
      {
        ...list,
        sections: [
          { title: 'A', rows: rows(1) },
          { title: 'B', rows: rows(1) },
        ],
      },
      {
        ...list,
        sections: Array.from({ length: L.sections + 1 }, (_, i) => ({
          title: `S${i}`,
          rows: rows(1, `s${i}-`),
        })),
      },
      { ...list, sections: [] },
      single({ rows: [] }),
      single({ title: 's'.repeat(L.sectionTitleLength + 1), rows: rows(1) }),
      single({ rows: [{ ...longest, id: 'i'.repeat(L.rowIdLength + 1) }] }),
      single({ rows: [{ ...longest, title: 't'.repeat(L.rowTitleLength + 1) }] }),
      single({ rows: [{ ...longest, description: 'd'.repeat(L.rowDescriptionLength + 1) }] }),
      single({ rows: [{ id: 'w360:anything', title: 'Row' }] }),
      single({ rows: [{ id: 'r ', title: 'Row' }] }),
      { ...list, button: 'b'.repeat(L.listButtonLength + 1) },
      { ...list, button: ' ' },
      { ...list, buttons: buttons.buttons },
    ]) {
      expect(refused(apiSendListSchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('become the interactive objects Meta describes, with the inbox’s content beside them', () => {
    const b = apiSendButtonsSchema.parse(buttons);
    expect(replyButtonsInteractive(b)).toEqual({
      type: 'button',
      header: { type: 'text', text: 'Your appointment' },
      body: { text: b.body },
      footer: { text: 'Sunrise Clinic' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'appt-42:yes', title: 'Confirm' } },
          { type: 'reply', reply: { id: 'appt-42:move', title: 'Reschedule' } },
          { type: 'reply', reply: { id: 'appt-42:no', title: 'Cancel' } },
        ],
      },
    });
    expect(replyButtonsContent(b)).toEqual({
      header: 'Your appointment',
      body: b.body,
      footer: 'Sunrise Clinic',
      buttons: ['Confirm', 'Reschedule', 'Cancel'],
    });
    const l = apiSendListSchema.parse(list);
    // No header or footer given, none sent; a row without a description has none.
    expect(listInteractive(l)).toEqual({
      type: 'list',
      body: { text: 'Pick a time for tomorrow.' },
      action: {
        button: 'See times',
        sections: [
          {
            title: 'Morning',
            rows: [
              { id: 'slot-10', title: '10:00', description: 'Dr Rao' },
              { id: 'slot-11', title: '11:00' },
            ],
          },
          { title: 'Afternoon', rows: [{ id: 'slot-15', title: '15:00', description: 'Dr Iyer' }] },
        ],
      },
    });
    expect(listContent(l)).toEqual({
      header: null,
      body: 'Pick a time for tomorrow.',
      footer: null,
      list: {
        button: 'See times',
        sections: [
          {
            title: 'Morning',
            rows: [
              { title: '10:00', description: 'Dr Rao' },
              { title: '11:00', description: null },
            ],
          },
          { title: 'Afternoon', rows: [{ title: '15:00', description: 'Dr Iyer' }] },
        ],
      },
    });
    // Ids stay out of what the inbox stores: they travel only in the request to Meta.
    expect(JSON.stringify(listContent(l))).not.toContain('slot-');
    expect(JSON.stringify(replyButtonsContent(b))).not.toContain('appt-42');
  });

  it('need the reply scope, checked before anything is read', async () => {
    const ctx = {
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set(['messages.send']) },
      planScopes: null,
    } as unknown as ApiContext;
    for (const body of [buttons, list]) {
      const error: unknown = await apiSendMessage({} as never, ctx, body, {
        key: 'k-1',
        requestHash: 'h',
      }).catch((caught: unknown) => caught);
      expect(isAppError(error) && error.code, body.type).toBe('forbidden');
    }
  });
});

describe('product messages (ADR-086)', () => {
  const to = '+919876543210';
  const product = { type: 'product', to, retailerId: 'chai-1' };
  const productList = {
    type: 'product_list',
    to,
    header: 'Tea time',
    body: 'Goes well with chai',
    sections: [
      { title: 'Tea', retailerIds: ['chai-1', 'chai-2'] },
      { title: 'Snacks', retailerIds: ['biscuit-1'] },
    ],
  };
  const catalog = { type: 'catalog', to, thumbnailRetailerId: 'chai-1', body: 'Our menu' };

  it('take products by content id, with Meta’s limits', () => {
    expect(apiSendProductSchema.parse({ ...product, body: '  Our best seller  ' })).toMatchObject({
      retailerId: 'chai-1',
      body: 'Our best seller',
    });
    expect(apiSendProductListSchema.safeParse(productList).success).toBe(true);
    expect(apiSendCatalogSchema.safeParse(catalog).success).toBe(true);
    // A content id is taken exactly as given; a catalog id is Meta's digits.
    expect(apiSendProductSchema.parse({ ...product, retailerId: ' sku 1 ' }).retailerId).toBe(
      ' sku 1 ',
    );
    const refused: [z.ZodType, unknown, string][] = [
      [apiSendProductSchema, { ...product, retailerId: '' }, 'no content id'],
      [apiSendProductSchema, { ...product, retailerId: 'x'.repeat(101) }, 'a long content id'],
      [apiSendProductSchema, { ...product, catalogId: 'main' }, 'a catalog id not in digits'],
      [apiSendProductSchema, { ...product, body: 'x'.repeat(1025) }, 'a long body'],
      [apiSendProductSchema, { ...product, footer: 'x'.repeat(61) }, 'a long footer'],
      [apiSendProductSchema, { ...product, header: 'Tea' }, 'a header on one product'],
      [apiSendProductListSchema, { ...productList, header: ' ' }, 'no header'],
      [apiSendProductListSchema, { ...productList, body: undefined }, 'no body'],
      [
        apiSendProductListSchema,
        { ...productList, sections: [{ retailerIds: ['a'] }, { retailerIds: ['b'] }] },
        'untitled sections',
      ],
      [
        apiSendProductListSchema,
        { ...productList, sections: [{ title: 'x'.repeat(25), retailerIds: ['a'] }] },
        'a long section title',
      ],
      [
        apiSendProductListSchema,
        {
          ...productList,
          sections: [
            { title: 'A', retailerIds: Array.from({ length: 16 }, (_, i) => `a-${i}`) },
            { title: 'B', retailerIds: Array.from({ length: 15 }, (_, i) => `b-${i}`) },
          ],
        },
        'more than 30 products',
      ],
      [
        apiSendProductListSchema,
        {
          ...productList,
          sections: Array.from({ length: 11 }, (_, i) => ({
            title: `S${i}`,
            retailerIds: [`p${i}`],
          })),
        },
        'more than 10 sections',
      ],
      [
        apiSendProductListSchema,
        {
          ...productList,
          sections: [
            { title: 'A', retailerIds: ['chai-1'] },
            { title: 'B', retailerIds: ['chai-1'] },
          ],
        },
        'a product twice',
      ],
      [apiSendCatalogSchema, { ...catalog, body: '' }, 'a catalog without a body'],
      [apiSendCatalogSchema, { ...catalog, thumbnailRetailerId: undefined }, 'no thumbnail'],
    ];
    for (const [schema, body, why] of refused) {
      expect(schema.safeParse(body).success, why).toBe(false);
    }
  });

  it('need the reply scope, checked before anything is read', async () => {
    const ctx = {
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set(['messages.send']) },
      planScopes: null,
    } as unknown as ApiContext;
    for (const body of [product, productList, catalog]) {
      const error: unknown = await apiSendMessage({} as never, ctx, body, {
        key: 'k-1',
        requestHash: 'h',
      }).catch((caught: unknown) => caught);
      expect(isAppError(error) && error.code, body.type).toBe('forbidden');
    }
  });
});

describe('quotes and reactions (ADR-082)', () => {
  const messageId = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
  const reaction = { type: 'reaction', to: '+919876543210', replyTo: messageId, emoji: '👍' };

  it('take one emoji from Unicode’s recommended set, sequences included', () => {
    for (const emoji of ['👍', '👍🏽', '❤️', '🇮🇳', '1️⃣', '👩🏽‍❤️‍💋‍👨🏿', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '🙏🏾']) {
      expect(isSingleEmoji(emoji), emoji).toBe(true);
    }
    for (const value of ['', 'a', '1', ':+1:', '👍👍', ' 👍', '👍 ', '☺', '👍'.repeat(20)]) {
      expect(isSingleEmoji(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('send a reaction with the message it goes on and one emoji, nothing else', () => {
    expect(apiSendReactionSchema.parse(reaction)).toEqual(reaction);
    expect(apiSendReactionSchema.parse({ ...reaction, from: messageId })).toEqual({
      ...reaction,
      from: messageId,
    });
    for (const bad of [
      { ...reaction, emoji: '' },
      { ...reaction, emoji: 'ok' },
      { ...reaction, emoji: '👍👎' },
      { ...reaction, replyTo: undefined },
      { ...reaction, replyTo: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI0RTJEOTc2ODVERUY5RDlGNkYA' },
      { ...reaction, messageId },
      { ...reaction, text: 'Thanks' },
      { ...reaction, to: undefined },
    ]) {
      expect(apiSendReactionSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('let a text, buttons or a list quote a message by its id', () => {
    const text = { type: 'text', to: '+919876543210', text: 'Yes, 10:00 works.' };
    expect(apiSendTextSchema.parse({ ...text, replyTo: messageId })).toMatchObject({
      replyTo: messageId,
    });
    expect(apiSendTextSchema.parse(text).replyTo).toBeUndefined();
    const buttons = {
      type: 'buttons',
      to: '+919876543210',
      body: 'Keep it?',
      buttons: [{ id: 'keep', title: 'Keep it' }],
      replyTo: messageId,
    };
    expect(apiSendButtonsSchema.parse(buttons).replyTo).toBe(messageId);
    const list = {
      type: 'list',
      to: '+919876543210',
      body: 'Pick a time.',
      button: 'Times',
      sections: [{ rows: [{ id: 'slot-10', title: '10:00' }] }],
      replyTo: messageId,
    };
    expect(apiSendListSchema.parse(list).replyTo).toBe(messageId);
    for (const bad of ['wamid.x', '', 42]) {
      expect(apiSendTextSchema.safeParse({ ...text, replyTo: bad }).success).toBe(false);
    }
  });

  it('quote messages WhatsApp knows, and react only to what the contact sent in the last 30 days', () => {
    const now = new Date('2026-09-29T12:00:00Z');
    const inbound: AnswerTarget = {
      direction: 'inbound',
      type: 'text',
      status: 'received',
      externalMessageId: 'wamid.in',
      at: new Date(now.getTime() - 3600_000),
    };
    const outbound: AnswerTarget = {
      ...inbound,
      direction: 'outbound',
      status: 'delivered',
      externalMessageId: 'wamid.out',
    };
    expect(answerProblem('quote', inbound, now)).toBeNull();
    for (const status of ['accepted', 'sent', 'delivered', 'read', 'played']) {
      expect(answerProblem('quote', { ...outbound, status }, now), status).toBeNull();
    }
    expect(answerProblem('quote', { ...outbound, status: 'failed' }, now)).toBe(
      'Only messages WhatsApp accepted can be quoted.',
    );
    expect(
      answerProblem('quote', { ...outbound, status: 'queued', externalMessageId: null }, now),
    ).toBe('Only messages WhatsApp accepted can be quoted.');
    for (const type of ['reaction', 'system']) {
      expect(answerProblem('quote', { ...inbound, type }, now)).toBe(
        'Reactions and WhatsApp notices cannot be quoted.',
      );
      expect(answerProblem('reaction', { ...inbound, type }, now)).toBe(
        'Reactions go on messages the contact sent, not on reactions or WhatsApp notices.',
      );
    }
    // A quote of an old message is fine; a reaction needs a message of the last 30 days.
    const old = { ...inbound, at: new Date(now.getTime() - REACTION_MAX_AGE_MS - 1) };
    expect(answerProblem('quote', old, now)).toBeNull();
    expect(answerProblem('reaction', old, now)).toBe(
      'Reactions go on messages from the last 30 days.',
    );
    expect(
      answerProblem(
        'reaction',
        { ...inbound, at: new Date(now.getTime() - REACTION_MAX_AGE_MS) },
        now,
      ),
    ).toBeNull();
    expect(answerProblem('reaction', { ...inbound, type: 'image' }, now)).toBeNull();
    expect(answerProblem('reaction', outbound, now)).toBe(
      'Reactions go on messages the contact sent.',
    );
    expect(REACTION_MAX_AGE_MS).toBe(30 * 24 * 3600_000);
  });

  it('find the message a reaction is for in its content, and a quoted or tapped one in its context', () => {
    expect(answeredExternalIdOf('reaction', { emoji: '👍', message_id: 'wamid.a' }, null)).toBe(
      'wamid.a',
    );
    expect(answeredExternalIdOf('reaction', { emoji: '👍', message_id: '' }, 'wamid.b')).toBeNull();
    expect(answeredExternalIdOf('text', { text: 'Yes', message_id: 'wamid.a' }, 'wamid.b')).toBe(
      'wamid.b',
    );
    expect(answeredExternalIdOf('interactive', { reply: null }, null)).toBeNull();
  });

  it('show the quoted message in one line, cut without splitting a character', () => {
    expect(messageSnippet('inbound', 'text', { text: 'Can I\n move   it?' })).toBe(
      'Can I move it?',
    );
    expect(
      messageSnippet('outbound', 'template', { rendered: { body: 'Your order shipped.' } }),
    ).toBe('Your order shipped.');
    expect(messageSnippet('outbound', 'interactive', { body: 'Keep it?', buttons: ['Yes'] })).toBe(
      'Keep it?',
    );
    expect(messageSnippet('inbound', 'image', { id: 'm', mime_type: 'image/jpeg' })).toBe('Photo');
    expect(messageSnippet('inbound', 'image', { caption: 'The receipt' })).toBe('The receipt');
    expect(messageSnippet('inbound', 'reaction', { emoji: '👍', message_id: 'w' })).toBe(
      'Reacted 👍',
    );
    expect(messageSnippet('outbound', 'reaction', { emoji: '🙏', message_id: 'w' })).toBe(
      'Reacted 🙏',
    );
    expect(messageSnippet('inbound', 'text', { redacted: true })).toBe('Content removed');
    expect(messageSnippet('inbound', 'unsupported', {})).toBe('Message');
    const long = messageSnippet('inbound', 'text', {
      text: `${'a'.repeat(SNIPPET_LENGTH - 2)}😀😀😀`,
    });
    expect(Array.from(long)).toHaveLength(SNIPPET_LENGTH);
    expect(long.endsWith('a😀…')).toBe(true);
    expect(SNIPPET_LENGTH).toBe(120);
  });

  it('need the reply scope, checked before anything is read', async () => {
    const ctx = {
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set(['messages.send', 'conversations.read']) },
      planScopes: null,
    } as unknown as ApiContext;
    const error: unknown = await apiSendMessage({} as never, ctx, reaction, {
      key: 'k-1',
      requestHash: 'h',
    }).catch((caught: unknown) => caught);
    expect(isAppError(error) && error.code).toBe('forbidden');
  });
});

describe('webhook endpoints through the API (ADR-081)', () => {
  it('take an address, events and a description, events in the settings order and once each', () => {
    expect(
      apiCreateWebhookEndpointSchema.parse({
        url: ' https://hooks.example.com/w360 ',
        events: ['contact.created', 'message.received', 'contact.created'],
        description: '  CRM sync ',
      }),
    ).toEqual({
      url: 'https://hooks.example.com/w360',
      events: ['message.received', 'contact.created'],
      description: 'CRM sync',
    });
    for (const body of [
      { events: ['message.received'] },
      { url: 'https://hooks.example.com', events: [] },
      { url: 'https://hooks.example.com', events: ['message.deleted'] },
      { url: 'https://hooks.example.com', events: ['message.received'], secret: 'whsec_mine' },
      {
        url: 'https://hooks.example.com',
        events: ['message.received'],
        description: 'x'.repeat(201),
      },
      { url: `https://hooks.example.com/${'x'.repeat(2048)}`, events: ['message.received'] },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
  });

  it('change the events, description or state, never the address, and need something to change', () => {
    expect(apiUpdateWebhookEndpointSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(apiUpdateWebhookEndpointSchema.parse({ description: '' })).toEqual({ description: '' });
    for (const body of [{}, { url: 'https://elsewhere.example.com' }, { events: [] }]) {
      expect(apiUpdateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
  });

  it('announce a key’s endpoint by its host and events, with the key’s name and prefix and the company’s time', () => {
    // A made-up prefix: the public part of a key, which settings list and the email names.
    const prefix = 'w360_abcdefghijkl';
    expect(
      endpointAnnouncement({
        keyName: 'Zap connector',
        keyPrefix: prefix,
        host: 'hooks.example.com',
        events: ['message.received', 'contact.created'],
        at: new Date('2026-09-29T10:15:00Z'),
        timeZone: 'Asia/Kolkata',
      }),
    ).toEqual({
      subject: 'Webhook endpoint added through the API',
      lines: [
        'The API key “Zap connector” (w360_abcdefghijkl_…) added a webhook endpoint at hooks.example.com on 29 September 2026 at 15:45 GMT+5:30. It receives: Message received, Contact added.',
        'If you did not expect this, delete the endpoint in Settings, Webhooks, and revoke the key in Settings, API keys.',
      ],
    });
  });

  it('need the scope, checked before anything is read', async () => {
    const endpoints = createApiWebhookEndpoints({} as never);
    const ctx = {
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set(['contacts.read']) },
      planScopes: null,
    } as unknown as ApiContext;
    const idempotency = { key: 'k-1', requestHash: 'h' };
    for (const call of [
      () => endpoints.list(ctx),
      () => endpoints.get(ctx, 'e'),
      () => endpoints.create(ctx, {}, idempotency),
      () => endpoints.update(ctx, 'e', {}),
      () => endpoints.remove(ctx, 'e'),
      () => endpoints.rotateSecret(ctx, 'e', idempotency),
    ]) {
      const error: unknown = await call().catch((caught: unknown) => caught);
      expect(isAppError(error) && error.code).toBe('forbidden');
    }
  });

  it('are described with the secret shown once and a body without the address for changes', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const paths = doc.paths as Record<string, Record<string, { parameters?: unknown[] }>>;
    expect(paths['/webhook-endpoints']?.post?.parameters).toEqual([
      { $ref: '#/components/parameters/IdempotencyKey' },
    ]);
    expect(paths['/webhook-endpoints/{id}/rotate-secret']?.post?.parameters).toContainEqual({
      $ref: '#/components/parameters/IdempotencyKey',
    });
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const withSecret = schemas.WebhookEndpointWithSecret as {
      properties: Record<string, { type?: unknown }>;
    };
    expect(withSecret.properties.secret?.type).toEqual(['string', 'null']);
    const update = schemas.UpdateWebhookEndpoint as {
      properties: Record<string, unknown>;
      additionalProperties: unknown;
    };
    expect(Object.keys(update.properties).sort()).toEqual([
      'description',
      'enabled',
      'events',
      'headers',
      'messageStatuses',
    ]);
    expect(update.additionalProperties).toBe(false);
    // Headers are given with their values, at most 5, and answered by name only (ADR-118).
    type HeaderList = {
      maxItems?: number;
      items?: { properties?: Record<string, unknown>; required?: string[] };
    };
    const given = (schemas.CreateWebhookEndpoint as { properties: { headers?: HeaderList } })
      .properties.headers;
    expect(given?.maxItems).toBe(5);
    expect([...(given?.items?.required ?? [])].sort()).toEqual(['name', 'value']);
    const answered = schemas.WebhookEndpoint as {
      properties: { headers?: HeaderList };
      required?: string[];
    };
    expect(Object.keys(answered.properties.headers?.items?.properties ?? {})).toEqual(['name']);
    expect(answered.required).toContain('headers');
    // The message statuses an endpoint receives (ADR-119): a list, or null for every status.
    const statuses = (answered.properties as Record<string, { anyOf?: unknown[] }>).messageStatuses;
    expect(statuses?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('messageStatuses');
    const webhooks = doc.webhooks as Record<string, { post?: { description?: string } }>;
    expect(webhooks['message.status']?.post?.description).toContain(
      'An endpoint receives every status unless it names the ones it takes',
    );
  });
});

describe("replaying an endpoint's failed deliveries through the API (ADR-095)", () => {
  it('takes a time with its offset, and nothing else', () => {
    for (const since of ['2026-09-30T08:00:00Z', '2026-09-30T13:30:00.123+05:30']) {
      expect(apiReplayFailedDeliveriesSchema.parse({ since })).toEqual({ since });
    }
    for (const body of [
      {},
      { since: 'yesterday' },
      { since: '2026-09-30' },
      { since: '2026-09-30T08:00:00Z', until: '2026-09-30T09:00:00Z' },
    ]) {
      expect(apiReplayFailedDeliveriesSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
  });

  it('refuses a time still to come before anything is read', async () => {
    const endpoints = createApiWebhookEndpoints({
      clock: { now: () => new Date('2026-09-30T08:00:00Z') },
    } as never);
    const ctx = {
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set(['webhooks.manage']) },
      planScopes: null,
    } as unknown as ApiContext;
    const error: unknown = await endpoints
      .replayFailed(
        ctx,
        '0192a1b2-0000-7000-8000-000000000001',
        { since: '2026-09-30T08:00:01Z' },
        { key: 'k-1', requestHash: 'h' },
      )
      .catch((caught: unknown) => caught);
    expect(isAppError(error) && error.code).toBe('validation_failed');
    expect(isAppError(error) && error.issues).toEqual([
      { path: 'since', message: 'Give a time in the past.' },
    ]);
  });

  it('is described: once per Idempotency-Key, 500 at most, the endpoint on', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const op = (
      doc.paths as unknown as Record<
        string,
        Record<
          string,
          {
            operationId: string;
            description: string;
            parameters: unknown[];
            requestBody: unknown;
            responses: Record<string, unknown>;
          }
        >
      >
    )['/webhook-endpoints/{id}/replay-failed']?.post;
    expect(op?.operationId).toBe('replayFailedWebhookDeliveries');
    expect(op?.parameters).toContainEqual({ $ref: '#/components/parameters/IdempotencyKey' });
    expect(op?.description).toContain('at most 500 per call');
    expect(Object.keys(op?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '404', '412', '422']),
    );
    expect(op?.requestBody).toEqual({
      required: true,
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/ReplayFailedDeliveries' } },
      },
    });
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    expect(schemas.ReplayFailedDeliveries).toMatchObject({
      required: ['since'],
      additionalProperties: false,
    });
    expect(Object.keys((schemas.FailedReplay as { properties: object }).properties)).toEqual([
      'queued',
      'more',
    ]);
  });
});

describe('webhook deliveries through the API (ADR-083)', () => {
  it('need the scope, checked before anything is read', async () => {
    const endpoints = createApiWebhookEndpoints({} as never);
    const ctx = {
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set(['contacts.read', 'messages.reply']) },
      planScopes: null,
    } as unknown as ApiContext;
    const idempotency = { key: 'k-1', requestHash: 'h' };
    for (const call of [
      () => endpoints.deliveries(ctx, 'e', {}),
      () => endpoints.getDelivery(ctx, 'd'),
      () => endpoints.sendTest(ctx, 'e', idempotency),
      () => endpoints.replay(ctx, 'd', idempotency),
      () => endpoints.replayFailed(ctx, 'e', { since: 'x' }, idempotency),
    ]) {
      const error: unknown = await call().catch((caught: unknown) => caught);
      expect(isAppError(error) && error.code).toBe('forbidden');
    }
  });

  it('page deliveries newest first, by state if asked', () => {
    expect(apiWebhookDeliveryListQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(apiWebhookDeliveryListQuerySchema.parse({ limit: '2', status: 'failed' })).toEqual({
      limit: 2,
      status: 'failed',
    });
    for (const query of [
      { limit: '0' },
      { limit: String(API_LIMITS.pageSize + 1) },
      { status: 'lost' },
      { eventType: 'ping' },
    ]) {
      expect(
        apiWebhookDeliveryListQuerySchema.safeParse(query).success,
        JSON.stringify(query),
      ).toBe(false);
    }
  });

  it('are described: tests and replays once per Idempotency-Key, a replay under way refused', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const paths = doc.paths as Record<
      string,
      Record<string, { parameters?: unknown[]; responses: Record<string, unknown> }>
    >;
    for (const path of ['/webhook-endpoints/{id}/test', '/webhook-deliveries/{id}/replay']) {
      expect(paths[path]?.post?.parameters, path).toContainEqual({
        $ref: '#/components/parameters/IdempotencyKey',
      });
      expect(Object.keys(paths[path]?.post?.responses ?? {}), path).toContain('412');
    }
    expect(Object.keys(paths['/webhook-deliveries/{id}/replay']?.post?.responses ?? {})).toContain(
      '409',
    );
    expect(paths['/webhook-endpoints/{id}/deliveries']?.get?.parameters).toContainEqual(
      expect.objectContaining({ name: 'status', in: 'query' }),
    );
    expect(paths['/webhook-deliveries/{id}']?.get).toBeDefined();
    const delivery = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas.WebhookDelivery as { properties: Record<string, { enum?: string[] }> };
    expect(delivery.properties.eventType?.enum).toContain('ping');
    expect(delivery.properties.status?.enum).toEqual([
      'pending',
      'delivering',
      'succeeded',
      'failed',
    ]);
  });
});

describe('allowed networks (ADR-076)', () => {
  it('take IPv4 and IPv6 addresses and networks, one per line or separated by commas or spaces', () => {
    expect(allowedNetworksSchema.parse(undefined)).toBeNull();
    expect(allowedNetworksSchema.parse('  \n ')).toBeNull();
    expect(
      allowedNetworksSchema.parse(
        '203.0.113.0/24\n198.51.100.7, 2001:db8::/32 2001:db8::1\n203.0.113.0/24',
      ),
    ).toEqual(['203.0.113.0/24', '198.51.100.7', '2001:db8::/32', '2001:db8::1']);
    const twenty = Array.from({ length: 20 }, (_, i) => `198.51.100.${i}`).join('\n');
    expect(allowedNetworksSchema.parse(twenty)).toHaveLength(20);
    expect(allowedNetworksSchema.safeParse(`${twenty}\n198.51.100.20`).success).toBe(false);
    expect(allowedNetworksSchema.safeParse('1'.repeat(2001)).success).toBe(false);
  });

  it('refuse what is not an address or network, a prefix longer than the address, /0 and mapped IPv4', () => {
    for (const entry of ['203.0.113.7', '203.0.113.0/24', '2001:db8::/32', '::1', '10.0.0.0/8']) {
      expect(networkEntryProblem(entry), entry).toBeNull();
    }
    const problems: [string, RegExp][] = [
      ['example.com', /not an IP address or network/],
      ['203.0.113', /not an IP address or network/],
      ['203.0.113.0/24/8', /not an IP address or network/],
      ['203.0.113.0/x', /not an IP address or network/],
      ['203.0.113.0/', /not an IP address or network/],
      ['203.0.113.0/33', /prefix length longer than the address/],
      ['2001:db8::/129', /prefix length longer than the address/],
      ['0.0.0.0/0', /accept every address/],
      ['::/0', /accept every address/],
      ['::ffff:203.0.113.7', /as the IPv4 address 203\.0\.113\.7/],
    ];
    for (const [entry, problem] of problems) {
      expect(networkEntryProblem(entry), entry).toMatch(problem);
      expect(allowedNetworksSchema.safeParse(`198.51.100.7\n${entry}`).success, entry).toBe(false);
    }
  });

  it('show a single address without its prefix length', () => {
    expect(formatAllowedNetwork('203.0.113.7/32')).toBe('203.0.113.7');
    expect(formatAllowedNetwork('203.0.113.0/24')).toBe('203.0.113.0/24');
    expect(formatAllowedNetwork('2001:db8::1/128')).toBe('2001:db8::1');
    expect(formatAllowedNetwork('2001:db8::/32')).toBe('2001:db8::/32');
  });
});

describe('addresses for all keys (ADR-099)', () => {
  it('names whose addresses refused the request, and the address it came from', () => {
    expect(apiAddressRefusal('key', '198.51.100.9')).toBe(
      'This API key does not accept requests from 198.51.100.9.',
    );
    expect(apiAddressRefusal('company', '198.51.100.9')).toBe(
      'The company this API key belongs to does not accept API requests from 198.51.100.9.',
    );
    expect(apiAddressRefusal('key', null)).toBe(
      'This API key accepts requests only from its listed addresses, and this request’s address could not be determined.',
    );
    expect(apiAddressRefusal('company', null)).toBe(
      'The company this API key belongs to accepts API requests only from its listed addresses, and this request’s address could not be determined.',
    );
  });

  it('says in the OpenAPI document that the company can limit the addresses of all its keys', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    expect(doc.info.description).toContain(
      'A key, and the company for all its keys, can be limited to the addresses its systems call from',
    );
  });
});

describe('apiKeyState', () => {
  const now = new Date('2026-09-28T10:00:00.000Z');
  it('is revoked before expired, and expired from the expiry instant on', () => {
    expect(apiKeyState({ revokedAt: null, expiresAt: null }, now)).toBe('active');
    expect(apiKeyState({ revokedAt: null, expiresAt: new Date(now.getTime() + 1) }, now)).toBe(
      'active',
    );
    expect(apiKeyState({ revokedAt: null, expiresAt: now }, now)).toBe('expired');
    expect(apiKeyState({ revokedAt: now, expiresAt: new Date(now.getTime() - 1) }, now)).toBe(
      'revoked',
    );
  });
});

describe('Idempotency-Key header', () => {
  it('accepts 1 to 255 visible ASCII characters', () => {
    expect(IDEMPOTENCY_KEY_RE.test('a')).toBe(true);
    expect(IDEMPOTENCY_KEY_RE.test('0b9f6c1e-6a52-4c1e-9d0e-3f5a2b7c8d9e')).toBe(true);
    expect(IDEMPOTENCY_KEY_RE.test('!~'.repeat(127) + '!')).toBe(true);
    for (const bad of ['', 'x'.repeat(256), 'has space', 'tab\tkey', 'naïve', 'line\nbreak']) {
      expect(IDEMPOTENCY_KEY_RE.test(bad)).toBe(false);
    }
  });
});

describe('API errors', () => {
  it('expose only the public message, issues and curated reason of application errors', () => {
    const mapped = apiErrorResponse(
      new AppError('validation_failed', 'Bad key', {
        details: { apiReason: 'idempotency_key_reused', secret: 'x' },
        issues: [{ path: 'to', message: 'Invalid' }],
      }),
      'req-1',
    );
    expect(mapped).toEqual({
      status: 422,
      internal: false,
      body: {
        error: {
          code: 'validation_failed',
          message: 'Bad key',
          reason: 'idempotency_key_reused',
          issues: [{ path: 'to', message: 'Invalid' }],
        },
        requestId: 'req-1',
      },
    });
    expect(apiErrorResponse(new AppError('tenant_suspended', 'Suspended'), 'r').status).toBe(423);
    expect(apiErrorResponse(new AppError('forbidden', 'No'), 'r').status).toBe(403);
  });

  it('turn anything else into a generic internal error without its message', () => {
    const mapped = apiErrorResponse(new Error('connection string postgres://secret'), 'req-2');
    expect(mapped.status).toBe(500);
    expect(mapped.internal).toBe(true);
    expect(JSON.stringify(mapped.body)).not.toContain('secret');
    expect(apiRequestError(401, 'unauthenticated', 'No key', 'r')).toEqual({
      status: 401,
      body: { error: { code: 'unauthenticated', message: 'No key' }, requestId: 'r' },
    });
    expect(apiRequestError(429, 'rate_limited', 'Used up', 'r', 'quota_exceeded')).toEqual({
      status: 429,
      body: {
        error: { code: 'rate_limited', message: 'Used up', reason: 'quota_exceeded' },
        requestId: 'r',
      },
    });
  });
});

describe('OpenAPI document', () => {
  const doc = buildOpenApiDocument('https://app.example.com/api/v1');
  type Operation = { operationId: string; responses: Record<string, unknown> };
  const paths = doc.paths as unknown as Record<string, Record<string, Operation>>;

  it('describes exactly the API routes, each with a unique operation id and error responses', () => {
    const described = Object.entries(paths).flatMap(([path, ops]) =>
      Object.keys(ops).map((method) => `${method} ${path}`),
    );
    expect(described.sort()).toEqual(API_ROUTES.map(([m, p]) => `${m} ${p}`).sort());
    const ids = described.map((d) => {
      const [method, path] = d.split(' ') as [string, string];
      return paths[path]?.[method]?.operationId;
    });
    expect(new Set(ids).size).toBe(ids.length);
    for (const [method, path] of API_ROUTES) {
      const responses = Object.keys(paths[path]?.[method]?.responses ?? {});
      // 403 and 429 also carry the plan's refusals (not_in_plan, quota_exceeded; ADR-061).
      expect(responses).toEqual(expect.arrayContaining(['401', '403', '429', '500']));
      expect(responses.some((s) => s.startsWith('2'))).toBe(true);
    }
  });

  it('lists the messages of every conversation with their contact and number (ADR-088)', () => {
    const feed = paths['/messages']?.get as unknown as {
      operationId: string;
      description: string;
      parameters: { name?: string }[];
    };
    expect(feed.operationId).toBe('listMessages');
    expect(feed.description).toContain('`conversations.read`');
    expect(feed.description).toContain('`since` a little before your previous pass began');
    expect(feed.description).toContain('Each page reads at most 2,000 of the company');
    expect(feed.description).toContain('follow it until it is `null`');
    expect(feed.parameters.map((p) => p.name).filter(Boolean)).toEqual([
      'limit',
      'cursor',
      'direction',
      'channelId',
      'since',
    ]);
    const schemas = doc.components.schemas as Record<string, { required?: string[] }>;
    expect(schemas.FeedMessage?.required).toEqual(
      expect.arrayContaining(['id', 'conversationId', 'contactId', 'channelId', 'createdAt']),
    );
  });

  it('names the plan refusals in the 403 and 429 responses and the error reason', () => {
    const responses = paths['/contacts']?.get?.responses as Record<string, { description: string }>;
    expect(responses['403']?.description).toContain('not_in_plan');
    expect(responses['429']?.description).toContain('reason quota_exceeded');
    // A key's own monthly limit (ADR-097).
    expect(responses['429']?.description).toContain('reason key_quota_exceeded');
    expect(JSON.stringify(doc.components)).toContain(
      'ip_not_allowed, key_quota_exceeded, not_in_plan, quota_exceeded or window_closed',
    );
    expect(responses['403']?.description).toContain('ip_not_allowed');
  });

  it('sends a template or a reply (text, buttons, list, products, reaction) from one operation, naming the window refusal', () => {
    const send = paths['/messages']?.post as unknown as {
      operationId: string;
      description: string;
      requestBody: { content: { 'application/json': { schema: unknown } } };
      responses: Record<string, { description: string }>;
    };
    expect(send.operationId).toBe('sendMessage');
    expect(send.requestBody.content['application/json'].schema).toEqual({
      oneOf: [
        { $ref: '#/components/schemas/SendTemplate' },
        { $ref: '#/components/schemas/SendText' },
        { $ref: '#/components/schemas/SendButtons' },
        { $ref: '#/components/schemas/SendList' },
        { $ref: '#/components/schemas/SendProduct' },
        { $ref: '#/components/schemas/SendProductList' },
        { $ref: '#/components/schemas/SendCatalog' },
        { $ref: '#/components/schemas/SendReaction' },
      ],
    });
    for (const scope of API_SEND_SCOPES) expect(send.description).toContain(`\`${scope}\``);
    expect(send.description).toContain('window_closed');
    expect(send.description).toContain('`reply.id`');
    expect(send.description).toContain('`w360`');
    expect(send.description).toContain('`replyTo`');
    expect(send.description).toContain('last 30 days');
    const schemas = doc.components.schemas as Record<
      string,
      {
        required?: string[];
        additionalProperties?: unknown;
        properties?: Record<string, { enum?: string[]; format?: string }>;
      }
    >;
    expect(schemas.SendReaction?.required?.sort()).toEqual(['emoji', 'replyTo', 'to', 'type']);
    expect(schemas.SendReaction?.additionalProperties).toBe(false);
    for (const name of [
      'SendText',
      'SendButtons',
      'SendList',
      'SendProduct',
      'SendProductList',
      'SendCatalog',
    ]) {
      expect(schemas[name]?.properties?.replyTo?.format, name).toBe('uuid');
      expect(schemas[name]?.required, name).not.toContain('replyTo');
    }
    // Products (ADR-086) are named by content id; the plan and the catalog rules are stated.
    expect(schemas.SendProduct?.required?.sort()).toEqual(['retailerId', 'to', 'type']);
    expect(schemas.SendProductList?.required?.sort()).toEqual([
      'body',
      'header',
      'sections',
      'to',
      'type',
    ]);
    expect(schemas.SendCatalog?.required?.sort()).toEqual([
      'body',
      'thumbnailRetailerId',
      'to',
      'type',
    ]);
    expect(send.description).toContain('Commerce');
    expect(send.description).toContain('`catalogId`');
    expect(schemas.Message?.properties?.type?.enum).toContain('reaction');
    expect(schemas.QueuedMessage?.properties?.type?.enum).toContain('reaction');
    expect(schemas.Message?.properties?.replyTo).toBeDefined();
    expect(schemas.ConversationMessage?.properties?.replyTo).toBeDefined();
    expect(JSON.stringify(schemas.WebhookMessageReceived)).toContain('"replyTo"');
    expect(send.responses['412']?.description).toContain('window_closed');
    const read = paths['/messages/{id}']?.get as unknown as { description: string };
    for (const scope of API_SEND_SCOPES) expect(read.description).toContain(`\`${scope}\``);
  });

  it('changes many conversations in one call, all or none (ADR-120)', () => {
    const post = paths['/conversations/update-many']?.post as unknown as {
      operationId: string;
      description: string;
      parameters?: unknown[];
      requestBody: { content: { 'application/json': { schema: unknown } } };
      responses: Record<string, unknown>;
    };
    expect(post.operationId).toBe('updateManyConversations');
    expect(post.description).toContain('`conversations.write`');
    expect(post.description).toContain('All of them or none');
    expect(post.description).toContain('counts as one request');
    expect(post.parameters ?? []).toEqual([]);
    expect(post.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/UpdateManyConversations',
    });
    expect(Object.keys(post.responses)).toEqual(expect.arrayContaining(['200', '422', '423']));
    expect(Object.keys(post.responses)).not.toContain('404');
    const schema = (
      doc.components.schemas as Record<
        string,
        {
          required?: string[];
          additionalProperties?: unknown;
          properties?: Record<string, { maxItems?: number; minItems?: number }>;
        }
      >
    ).UpdateManyConversations;
    expect(schema?.required).toEqual(['conversationIds']);
    expect(schema?.additionalProperties).toBe(false);
    expect(Object.keys(schema?.properties ?? {})).toEqual([
      'conversationIds',
      'status',
      'assigneeId',
      'teamId',
    ]);
    expect(schema?.properties?.conversationIds).toMatchObject({
      minItems: 1,
      maxItems: API_LIMITS.conversationsPerChange,
    });
  });

  it('changes many contacts in one call, all or none (ADR-122)', () => {
    const post = paths['/contacts/update-many']?.post as unknown as {
      operationId: string;
      description: string;
      requestBody: { content: { 'application/json': { schema: unknown } } };
      responses: Record<string, unknown>;
    };
    expect(post.operationId).toBe('updateManyContacts');
    expect(post.description).toContain('`contacts.write`');
    expect(post.description).toContain('All of them or none');
    expect(post.description).toContain('`contacts.3.fields.plan`');
    expect(post.description).toContain('counts as one request');
    expect(post.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/UpdateManyContacts',
    });
    expect(Object.keys(post.responses)).toEqual(expect.arrayContaining(['200', '422', '423']));
    expect(Object.keys(post.responses)).not.toContain('404');
    type Items = {
      minItems?: number;
      maxItems?: number;
      items?: { required?: string[]; additionalProperties?: unknown; properties?: object };
    };
    const schema = (
      doc.components.schemas as Record<
        string,
        { required?: string[]; additionalProperties?: unknown; properties?: { contacts?: Items } }
      >
    ).UpdateManyContacts;
    expect(schema?.required).toEqual(['contacts']);
    expect(schema?.additionalProperties).toBe(false);
    const items = schema?.properties?.contacts;
    expect(items).toMatchObject({ minItems: 1, maxItems: API_LIMITS.contactsPerChange });
    expect(items?.items?.required).toEqual(['id']);
    expect(items?.items?.additionalProperties).toBe(false);
    expect(Object.keys(items?.items?.properties ?? {})).toEqual([
      'id',
      'name',
      'email',
      'fields',
      'addTags',
      'removeTags',
    ]);
  });

  it('resolves, reopens, assigns or moves a conversation with any of the three fields (ADR-093)', () => {
    const patch = paths['/conversations/{id}']?.patch as unknown as {
      operationId: string;
      description: string;
      requestBody: { content: { 'application/json': { schema: unknown } } };
      responses: Record<string, unknown>;
    };
    expect(patch.operationId).toBe('updateConversation');
    expect(patch.description).toContain('`conversations.write`');
    expect(patch.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/UpdateConversation',
    });
    expect(Object.keys(patch.responses)).toEqual(
      expect.arrayContaining(['200', '404', '422', '423']),
    );
    const schemas = doc.components.schemas as Record<
      string,
      {
        required?: string[];
        additionalProperties?: unknown;
        properties?: Record<string, { enum?: string[]; anyOf?: unknown[] }>;
      }
    >;
    expect(schemas.UpdateConversation?.required ?? []).toEqual([]);
    expect(schemas.UpdateConversation?.additionalProperties).toBe(false);
    expect(Object.keys(schemas.UpdateConversation?.properties ?? {})).toEqual([
      'status',
      'assigneeId',
      'teamId',
    ]);
    expect(schemas.UpdateConversation?.properties?.status?.enum).toEqual(['open', 'resolved']);
    for (const field of ['assigneeId', 'teamId']) {
      expect(schemas.UpdateConversation?.properties?.[field]?.anyOf).toEqual([
        { type: 'string', format: 'uuid', pattern: expect.any(String) },
        { type: 'null' },
      ]);
    }
    // The conversation names its member and team, and the lists filter by them.
    expect(Object.keys(schemas.Conversation?.properties ?? {})).toEqual(
      expect.arrayContaining(['assigned', 'assigneeId', 'teamId']),
    );
    const list = paths['/conversations']?.get as unknown as { parameters: { name?: string }[] };
    expect(list.parameters.map((p) => p.name)).toEqual(
      expect.arrayContaining(['assigneeId', 'teamId']),
    );
    for (const [path, schema] of [
      ['/members', 'Member'],
      ['/teams', 'Team'],
    ] as const) {
      const get = paths[path]?.get as unknown as { description: string };
      expect(get.description).toContain('`conversations.read`');
      expect(schemas[schema]?.required).toEqual(expect.arrayContaining(['id', 'name']));
    }
    expect(Object.keys(schemas.Member?.properties ?? {}).sort()).toEqual([
      'available',
      'id',
      'name',
      'teamIds',
    ]);
  });

  it('resolves every reference to a component', () => {
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/(\w+)\/(\w+)"/g)];
    expect(refs.length).toBeGreaterThan(10);
    const components = doc.components as unknown as Record<string, Record<string, unknown>>;
    for (const [, section, name] of refs) {
      expect(components[section as string]?.[name as string], `${section}/${name}`).toBeDefined();
    }
  });

  it('takes request bodies from the validation schemas (strict, with required fields)', () => {
    const schemas = doc.components.schemas as Record<
      string,
      { required?: string[]; additionalProperties?: unknown }
    >;
    expect(schemas.SendTemplate?.required).toEqual(expect.arrayContaining(['to', 'templateId']));
    expect(schemas.SendTemplate?.required).not.toContain('type');
    expect(schemas.SendTemplate?.additionalProperties).toBe(false);
    expect(schemas.SendText?.required).toEqual(expect.arrayContaining(['type', 'to', 'text']));
    expect(schemas.SendText?.required).not.toContain('previewUrl');
    expect(schemas.SendText?.additionalProperties).toBe(false);
    expect(schemas.ContactCreate?.required).toEqual(['phone']);
    expect(schemas.Consent?.required).toEqual(
      expect.arrayContaining(['purpose', 'action', 'evidence']),
    );
    expect(doc.servers).toEqual([{ url: 'https://app.example.com/api/v1' }]);
  });

  it('matches the route handlers in the web app', () => {
    const root = fileURLToPath(new URL('../../../../apps/web/src/app/api/v1/', import.meta.url));
    for (const [method, path] of API_ROUTES) {
      const file = `${root}${path.slice(1).replace(/\{(\w+)\}/g, '[$1]')}/route.ts`;
      expect(existsSync(file), file).toBe(true);
      expect(readFileSync(file, 'utf8')).toMatch(
        new RegExp(`export (async )?function ${method.toUpperCase()}\\(`),
      );
    }
  });
});

describe('contact custom fields and changes (ADR-112)', () => {
  const ctx = (scopes: string[], status = 'active') =>
    ({
      tenant: { id: 't', status },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: null,
    }) as unknown as ApiContext;
  const id = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'done',
      (error: unknown) => (isAppError(error) ? error.code : String(error)),
    );

  it('take field values as strings, numbers or booleans, null only to clear one in a change', () => {
    expect(apiContactFieldsSchema.parse({ city: 'Chennai', orders: 3, vip: true })).toEqual({
      city: 'Chennai',
      orders: 3,
      vip: true,
    });
    for (const bad of [
      { city: null },
      { city: ['a'] },
      { city: { a: 1 } },
      { ['k'.repeat(41)]: 'x' },
    ]) {
      expect(apiContactFieldsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    const fifty = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, 'x']));
    expect(apiContactFieldsSchema.safeParse(fifty).success).toBe(true);
    expect(apiContactFieldsSchema.safeParse({ ...fifty, f50: 'x' }).success).toBe(false);
    expect(apiContactUpdateSchema.parse({ fields: { city: null, orders: 4 } })).toEqual({
      fields: { city: null, orders: 4 },
    });
    expect(apiContactUpdateSchema.safeParse({ fields: { ...fifty, f50: null } }).success).toBe(
      false,
    );
  });

  it('keep each tag once, as the app writes it', () => {
    expect(apiTags(['VIP', ' vip ', 'New', 'new'], 'addTags')).toEqual(['vip', 'new']);
    expect(apiTags([], 'removeTags')).toEqual([]);
  });

  it('change at least one of name, email, fields and tags, and nothing else', () => {
    expect(apiContactUpdateSchema.parse({ name: '  Priya  ', email: null })).toEqual({
      name: 'Priya',
      email: null,
    });
    expect(apiContactUpdateSchema.parse({ addTags: ['vip'], removeTags: ['new'] })).toEqual({
      addTags: ['vip'],
      removeTags: ['new'],
    });
    for (const bad of [
      {},
      { phone: '+919876543210' },
      { name: 'x'.repeat(201) },
      { email: 7 },
      { addTags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
      { tags: ['vip'] },
      'Priya',
      null,
    ]) {
      expect(apiContactUpdateSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('are refused before anything is read: without the scope, while the company is not active, for ids that are not ids, and for other bodies', async () => {
    const update = (c: ApiContext, contactId: string, body: unknown) =>
      code(apiUpdateContact({} as never, c, contactId, body));
    const body = { name: 'Priya' };
    expect(await update(ctx(['contacts.read']), id, body)).toBe('forbidden');
    for (const status of ['suspended', 'restricted']) {
      expect(await update(ctx(['contacts.write'], status), id, body)).toBe('tenant_suspended');
    }
    expect(await update(ctx(['contacts.write']), 'not-a-uuid', body)).toBe('not_found');
    expect(await update(ctx(['contacts.write']), id, {})).toBe('validation_failed');
    expect(await update(ctx(['contacts.write']), id, { email: 'not an address' })).toBe(
      'validation_failed',
    );
    expect(await update(ctx(['contacts.write']), id, { addTags: ['a,b'] })).toBe(
      'validation_failed',
    );
    // A tag both added and removed, however it is written.
    const both = await apiUpdateContact({} as never, ctx(['contacts.write']), id, {
      addTags: ['VIP'],
      removeTags: [' vip '],
    }).catch((error: unknown) => error);
    expect(isAppError(both) && both.issues).toEqual([
      { path: 'removeTags', message: 'The tag vip cannot be both added and removed.' },
    ]);
    expect(await code(apiListContactFields({} as never, ctx(['contacts.write'])))).toBe(
      'forbidden',
    );
  });

  it('change 1 to 100 contacts at once, each named once with what PATCH takes (ADR-122)', async () => {
    expect(API_LIMITS.contactsPerChange).toBe(100);
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `0192f0c4-8e2b-7c1d-9a3e-${String(i).padStart(12, '0')}`);
    const other = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
    for (const body of [
      { contacts: [{ id, name: 'Priya' }] },
      {
        contacts: [
          { id, addTags: ['vip'] },
          { id: other, fields: { city: null }, email: null },
        ],
      },
      { contacts: ids(API_LIMITS.contactsPerChange).map((c) => ({ id: c, removeTags: ['new'] })) },
    ]) {
      expect(apiUpdateManyContactsSchema.parse(body)).toEqual(body);
    }
    for (const bad of [
      { contacts: [] },
      { contacts: ids(API_LIMITS.contactsPerChange + 1).map((c) => ({ id: c, name: 'x' })) },
      {
        contacts: [
          { id, name: 'A' },
          { id, name: 'B' },
        ],
      },
      { contacts: [{ id: 'not-a-uuid', name: 'A' }] },
      { contacts: [{ name: 'A' }] },
      { contacts: [{ id }] },
      { contacts: [{ id, phone: '+919876543210' }] },
      { contacts: [{ id, name: 'A', phone: '+919876543210' }] },
      { contacts: { id, name: 'A' } },
      { contacts: [{ id, name: 'A' }], dryRun: true },
      {},
    ]) {
      expect(
        apiUpdateManyContactsSchema.safeParse(bad).success,
        JSON.stringify(bad).slice(0, 80),
      ).toBe(false);
    }
    // Refused before anything is read: without the scope, while the company is not active, and for
    // a bad change, naming its place.
    const many = (c: ApiContext, body: unknown) =>
      apiUpdateManyContacts({} as never, c, body).catch((error: unknown) => error);
    const body = { contacts: [{ id, name: 'Priya' }] };
    expect(await code(apiUpdateManyContacts({} as never, ctx(['contacts.read']), body))).toBe(
      'forbidden',
    );
    for (const status of ['suspended', 'restricted']) {
      expect(
        await code(apiUpdateManyContacts({} as never, ctx(['contacts.write'], status), body)),
      ).toBe('tenant_suspended');
    }
    const issues = async (change: Record<string, unknown>) => {
      const error = await many(ctx(['contacts.write']), {
        contacts: [
          { id, name: 'Priya' },
          { id: other, ...change },
        ],
      });
      return isAppError(error) ? error.issues : error;
    };
    expect(await issues({ email: 'not an address' })).toEqual([
      { path: 'contacts.1.email', message: 'Email address is not valid.' },
    ]);
    expect(await issues({ addTags: ['a,b'] })).toEqual([
      { path: 'contacts.1.addTags', message: expect.any(String) as unknown },
    ]);
    expect(await issues({ addTags: ['VIP'], removeTags: [' vip '] })).toEqual([
      { path: 'contacts.1.removeTags', message: 'The tag vip cannot be both added and removed.' },
    ]);
    expect(await issues({})).toEqual([
      { path: 'contacts.1', message: 'Give name, email, fields, addTags or removeTags.' },
    ]);
  });

  it('are described: the fields in every contact, their definitions, and the change', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const paths = doc.paths as unknown as Record<
      string,
      Record<string, { operationId: string; description: string; requestBody?: unknown }>
    >;
    expect(paths['/contacts/{id}']?.patch?.operationId).toBe('updateContact');
    expect(paths['/contacts/{id}']?.patch?.description).toContain('`contacts.write`');
    expect(paths['/contacts/{id}']?.patch?.description).toContain('`fields.<key>`');
    expect(paths['/contacts/{id}']?.patch?.description).toContain(
      'The phone number is not changed through the API.',
    );
    expect(paths['/contact-fields']?.get?.operationId).toBe('listContactFields');
    expect(paths['/contact-fields']?.get?.description).toContain('`contacts.read`');
    const schemas = doc.components.schemas as Record<
      string,
      { required?: string[]; additionalProperties?: unknown; properties?: Record<string, unknown> }
    >;
    expect(schemas.ContactUpdate?.additionalProperties).toBe(false);
    expect(schemas.ContactUpdate?.required ?? []).toEqual([]);
    expect(Object.keys(schemas.ContactUpdate?.properties ?? {}).sort()).toEqual([
      'addTags',
      'email',
      'fields',
      'name',
      'removeTags',
    ]);
    expect(schemas.ContactCreate?.properties).toHaveProperty('fields');
    expect(schemas.ContactField?.required).toEqual(
      expect.arrayContaining(['key', 'label', 'type', 'createdAt']),
    );
    expect(schemas.Contact?.required).toContain('fields');
    expect(Object.keys(apiContactSchema.shape)).toContain('fields');
    expect(API_SCOPE_INFO['contacts.write'].label).toBe(
      'Create and change contacts and record consent',
    );
  });
});

describe('finding contacts (ADR-113)', () => {
  const ctx = (scopes: string[]) =>
    ({
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: null,
    }) as unknown as ApiContext;
  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      if (isAppError(error)) return { code: error.code, issues: error.issues };
      throw error;
    }
    throw new Error('expected a refusal');
  };

  it('read fields[<key>] parameters as the fields filter, leaving everything else as it is', () => {
    expect(
      contactListQuery({ limit: '10', 'fields[city]': 'Pune', 'fields[orders]': '3', tag: 'vip' }),
    ).toEqual({ limit: '10', tag: 'vip', fields: { city: 'Pune', orders: '3' } });
    expect(contactListQuery({ phone: '+919800000000' })).toEqual({ phone: '+919800000000' });
    // A bracket with no key stays a parameter the schema refuses.
    expect(contactListQuery({ 'fields[]': 'x' })).toEqual({ 'fields[]': 'x' });
    for (const raw of [null, 'x', ['a']]) expect(contactListQuery(raw)).toBe(raw);
  });

  it('take at most 5 field filters of strings, besides number, email and tag', () => {
    const parse = (query: Record<string, unknown>) =>
      apiContactListQuerySchema.safeParse(contactListQuery(query)).success;
    const five = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`fields[f${i}]`, 'x']));
    expect(parse({ ...five, email: 'a@example.test', tag: 'vip', phone: '+919800000000' })).toBe(
      true,
    );
    expect(parse({ ...five, 'fields[f5]': 'x' })).toBe(false);
    expect(parse({ [`fields[${'k'.repeat(41)}]`]: 'x' })).toBe(false);
    expect(parse({ 'fields[city]': 'x'.repeat(501) })).toBe(false);
    expect(parse({ fields: 'city' })).toBe(false);
    expect(parse({ 'fields[]': 'x' })).toBe(false);
    expect(parse({ sort: 'name' })).toBe(false);
  });

  it('write the email address and tag as the app keeps them, and refuse bad ones by name', () => {
    expect(apiContactListFilters({ email: ' Asha@Example.test ', tag: ' VIP ' })).toEqual({
      email: 'Asha@Example.test',
      tag: 'vip',
    });
    expect(apiContactListFilters({})).toEqual({ email: null, tag: null });
    expect(refusal(() => apiContactListFilters({ email: 'not an address' }))).toEqual({
      code: 'validation_failed',
      issues: [{ path: 'email', message: 'Email address is not valid.' }],
    });
    expect(refusal(() => apiContactListFilters({ email: ' ' }))).toEqual({
      code: 'validation_failed',
      issues: [{ path: 'email', message: 'Give an email address to find.' }],
    });
    expect(refusal(() => apiContactListFilters({ tag: 'a,b' }))).toEqual({
      code: 'validation_failed',
      issues: [{ path: 'tag', message: 'Tags cannot contain commas or control characters.' }],
    });
  });

  it('are refused before anything is read without contacts.read or with a bad filter', async () => {
    const code = (query: Record<string, string>, scopes = ['contacts.read']) =>
      apiListContacts({} as never, ctx(scopes), query).then(
        () => 'done',
        (error: unknown) => (isAppError(error) ? error.code : String(error)),
      );
    expect(await code({}, ['contacts.write'])).toBe('forbidden');
    expect(await code({ email: 'nope' })).toBe('validation_failed');
    expect(await code({ tag: ',' })).toBe('validation_failed');
    expect(await code({ 'fields[a]': '1', unknown: 'x' })).toBe('validation_failed');
  });

  it('are described: the filters, the window and the refusals', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const get = (
      doc.paths as unknown as Record<
        string,
        Record<string, { description: string; parameters: Record<string, unknown>[] }>
      >
    )['/contacts']?.get;
    expect(get?.parameters.map((p) => p.name)).toEqual([
      'limit',
      'cursor',
      'phone',
      'email',
      'tag',
      'fields',
    ]);
    expect(get?.parameters.find((p) => p.name === 'fields')).toMatchObject({
      in: 'query',
      style: 'deepObject',
      explode: true,
      schema: { type: 'object', maxProperties: 5 },
    });
    expect(get?.description).toContain('a contact matches all of them');
    expect(get?.description).toContain(API_CONTACT_SEARCH_WINDOW.toLocaleString('en-US'));
    expect(String(get?.parameters.find((p) => p.name === 'fields')?.description)).toContain(
      '`fields.<key>`',
    );
  });
});
