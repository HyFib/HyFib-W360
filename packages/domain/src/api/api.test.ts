import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { AppError, isAppError, sha256Hex } from '@w360/core';
import { API_SCOPES, CAMPAIGN_STATUSES, MESSAGE_STATUSES, RECIPIENT_STATES } from '@w360/db';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../authz/permissions';
import { apiErrorResponse, apiRequestError } from './errors';
import { NUL_CHARACTER_MESSAGE } from '../validation';
import { assertNoNulCharacter, nulCharacterPath } from './request-text';
import {
  apiCampaignListQuerySchema,
  apiCampaignRecipientQuerySchema,
  apiCampaignResultsSchema,
  apiCancelCampaign,
  apiGetCampaign,
  apiListCampaignRecipients,
  apiListCampaigns,
  apiPauseCampaign,
  apiResumeCampaign,
  apiCreateCampaign,
  apiCreateCampaignSchema,
  apiDraftInputFrom,
  apiUpdateCampaign,
  apiUpdateCampaignSchema,
  apiCampaignReviewSchema,
  apiReviewCampaign,
  apiSubmitCampaign,
  apiSubmitCampaignSchema,
  apiWithdrawCampaign,
  toApiCampaignReview,
} from './campaigns';
import {
  apiArchiveSegment,
  apiCreateSegment,
  apiGetSegment,
  apiListSegmentContacts,
  apiListSegments,
  apiUpdateSegment,
} from './segments';
import { SEGMENT_NAME_TAKEN, segmentNameRefusal } from '../campaigns/segments';
import { RECIPIENT_OUTCOMES } from '../campaigns/outcomes';
import {
  campaignDraftInputOf,
  microsToAmount,
  prepareCampaignDraft,
  type CampaignDraftInput,
  type CampaignDraftReview,
} from '../campaigns/service';
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
  apiMergeContacts,
  apiMergeContactsSchema,
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
import { messageSnippet, outboundText, SNIPPET_LENGTH } from '../messaging/message-text';
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
  apiSendManyTemplates,
  apiSendManyTemplatesSchema,
  apiSendMessage,
  apiSendMessageSchema,
  apiSendProductListSchema,
  apiSendProductSchema,
  apiSendReactionSchema,
  apiSendTextSchema,
  API_MEDIA_TYPES,
  apiSendMediaSchema,
  isMediaLink,
  API_MESSAGE_TYPES,
  apiMessageType,
  apiSendLocationSchema,
  decimalDegrees,
  apiSendContactsSchema,
  isCardLink,
  whatsappContact,
} from './resources';
import { contactCards } from '../webhooks/payloads';
import {
  apiCreateWebhookEndpointSchema,
  apiUpdateWebhookEndpointSchema,
  apiReplayFailedDeliveriesSchema,
  apiWebhookDeliveryListQuerySchema,
  createApiWebhookEndpoints,
  endpointAnnouncement,
} from './webhook-endpoints';
import {
  WEBHOOK_FIELDS_NEED_THE_PART,
  WEBHOOK_RUN_TRIGGERS_NEED_THE_EVENTS,
  WEBHOOK_RUN_API_KEYS_NEED_THE_EVENTS,
  WEBHOOK_MESSAGE_API_KEYS_NEED_THE_EVENT,
  WEBHOOK_CRM_EXCLUDED_API_KEYS_NEED_THE_EVENTS,
  WEBHOOK_CONSENT_CHANGES_NEED_THE_EVENT,
  WEBHOOK_CONTACT_SOURCES_NEED_THE_EVENT,
  WEBHOOK_MESSAGE_TYPES_NEED_THE_EVENT,
  WEBHOOK_RUN_END_REASONS_NEED_THE_EVENT,
  WEBHOOK_RUN_END_REASONS_NEED_THE_ENDS,
  WEBHOOK_ASSIGNEES_NEED_THE_EVENTS,
  WEBHOOK_AUTOMATIONS_NEED_THE_EVENTS,
  WEBHOOK_CAMPAIGNS_NEED_THE_EVENTS,
  WEBHOOK_PIPELINES_NEED_THE_EVENTS,
  WEBHOOK_STAGES_NEED_THE_EVENTS,
  WEBHOOK_OWNERS_NEED_THE_EVENTS,
  WEBHOOK_TASK_ASSIGNEES_NEED_THE_EVENTS,
  WEBHOOK_TASK_PIPELINES_NEED_THE_EVENTS,
  WEBHOOK_TASK_STAGES_NEED_THE_EVENTS,
  WEBHOOK_TASK_DEAL_OWNERS_NEED_THE_EVENTS,
  WEBHOOK_NOTE_PIPELINES_NEED_THE_EVENTS,
  WEBHOOK_NOTE_STAGES_NEED_THE_EVENTS,
  WEBHOOK_NOTE_DEAL_OWNERS_NEED_THE_EVENTS,
  WEBHOOK_CRM_CHANGE_MAKERS_NEED_THE_EVENTS,
  WEBHOOK_SURVEY_SCORES_NEED_THE_EVENT,
  WEBHOOK_SURVEY_ASSIGNEES_NEED_THE_EVENT,
  WEBHOOK_SURVEY_TEAMS_NEED_THE_EVENT,
  WEBHOOK_SURVEY_CONTACT_TAGS_NEED_THE_EVENT,
  WEBHOOK_SURVEY_CONVERSATION_TAGS_NEED_THE_EVENT,
  WEBHOOK_CONTACT_EVENT_TAGS_NEED_THE_EVENTS,
  WEBHOOK_CONTACT_TAGS_NEED_THE_EVENTS,
  WEBHOOK_CONVERSATION_TAGS_NEED_THE_EVENTS,
  WEBHOOK_CAMPAIGN_STATUSES_NEED_THE_EVENT,
  WEBHOOK_CHANNELS_NEED_THE_EVENTS,
  WEBHOOK_CONVERSATION_STATUSES_NEED_THE_EVENT,
  WEBHOOK_ORDER_STATUSES_NEED_THE_EVENT,
  WEBHOOK_PAYMENT_LINK_STATUSES_NEED_THE_EVENT,
  WEBHOOK_DEAL_STATUSES_NEED_THE_EVENT,
  WEBHOOK_TASK_STATUSES_NEED_THE_EVENT,
  WEBHOOK_DEAL_DETAILS_NEED_THE_EVENT,
  WEBHOOK_TASK_DETAILS_NEED_THE_EVENT,
  WEBHOOK_RUN_END_STATUSES_NEED_THE_EVENT,
  WEBHOOK_SENDERS_NEED_THE_EVENT,
  WEBHOOK_TEAMS_NEED_THE_EVENTS,
  WEBHOOK_TEMPLATES_NEED_THE_EVENTS,
  WEBHOOK_TEMPLATE_STATUSES_NEED_THE_EVENT,
} from '../webhooks/service';
import {
  WEBHOOK_CAMPAIGN_EVENTS,
  WEBHOOK_PIPELINE_EVENTS,
  WEBHOOK_TASK_EVENTS,
  WEBHOOK_CHANNEL_EVENTS,
  WEBHOOK_TEAM_EVENTS,
  WEBHOOK_TEMPLATE_EVENTS,
  WEBHOOK_EVENT_KEYS,
  WEBHOOK_FAILURE_KINDS,
  WEBHOOK_LIMITS,
  WEBHOOK_PAYMENT_LINK_STATUSES,
  WEBHOOK_DEAL_STATUSES,
  WEBHOOK_TASK_STATUSES,
  WEBHOOK_DEAL_DETAILS,
  WEBHOOK_TASK_DETAILS,
} from '../webhooks/model';
import {
  apiStartManyAutomationRuns,
  apiStartManyAutomationRunsSchema,
  apiStopManyAutomationRuns,
  apiStopManyAutomationRunsSchema,
} from './automations';

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
      'templates.write',
      'templates.submit',
      'contacts.write',
      'contacts.merge',
      'contact_fields.manage',
      'messages.send',
      'messages.send_marketing',
      'messages.reply',
      'conversations.write',
      'campaigns.write',
      'campaigns.stop',
      'campaigns.resume',
      'chat_links.write',
      'automations.start',
      'orders.write',
      'orders.request_payment',
      'deals.write',
      'pipelines.manage',
      'tasks.write',
      'notes.write',
      'teams.manage',
      'availability.write',
      'business_hours.manage',
      'saved_replies.manage',
      'webhooks.manage',
    ]);
    expect([...API_SEND_SCOPES]).toEqual(API_SCOPE_KEYS.filter((s) => s.startsWith('messages.')));
  });

  it('need the permission a member needs for the same work', () => {
    // Members see the company's numbers in Settings → Channels with channels.read (ADR-171).
    expect(API_SCOPE_INFO['channels.read'].permission).toBe('channels.read');
    expect(API_SCOPE_INFO['messages.send'].permission).toBe('inbox.reply');
    // Members add and change drafts on the Templates page with templates.write (ADR-295).
    expect(API_SCOPE_INFO['templates.write'].permission).toBe('templates.write');
    // And submit them to Meta, and delete those Meta has, with templates.submit (ADR-296).
    expect(API_SCOPE_INFO['templates.submit'].permission).toBe('templates.submit');
    expect(API_SCOPE_INFO['messages.send_marketing'].permission).toBe('campaigns.send');
    expect(API_SCOPE_INFO['messages.reply'].permission).toBe('inbox.reply');
    expect(API_SCOPE_INFO['contacts.write'].permission).toBe('contacts.write');
    // Merging deletes a contact: members merge with contacts.write and contacts.delete (ADR-227).
    expect(API_SCOPE_INFO['contacts.merge'].permission).toBe('contacts.delete');
    // Members define fields in Settings with tenant.settings.manage (ADR-115).
    expect(API_SCOPE_INFO['contact_fields.manage'].permission).toBe('tenant.settings.manage');
    // Members pause and cancel campaigns with campaigns.send (ADR-128).
    expect(API_SCOPE_INFO['campaigns.stop'].permission).toBe('campaigns.send');
    // And resume them with it (ADR-176).
    expect(API_SCOPE_INFO['campaigns.resume'].permission).toBe('campaigns.send');
    // Members create and edit drafts with campaigns.write (ADR-186).
    expect(API_SCOPE_INFO['campaigns.write'].permission).toBe('campaigns.write');
    expect(API_SCOPE_INFO['conversations.read'].permission).toBe('inbox.read_all');
    expect(API_SCOPE_INFO['conversations.write'].permission).toBe('inbox.supervise');
    expect(API_SCOPE_INFO['automations.start'].permission).toBe('automations.publish');
    // Members read orders with commerce.read (ADR-167) and change them with inbox.reply (ADR-168).
    expect(API_SCOPE_INFO['orders.read'].permission).toBe('commerce.read');
    expect(API_SCOPE_INFO['orders.write'].permission).toBe('inbox.reply');
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
    // WhatsApp's own kinds the API sends otherwise (buttons and lists as `buttons` and `list`), and
    // types in another case (ADR-194, ADR-195, ADR-197 and ADR-198 send the media, locations,
    // contact cards and stickers named in lower case).
    for (const body of [
      { type: 'interactive' },
      { type: 'STICKER' },
      { type: 'CONTACTS' },
      { type: 'LOCATION' },
      { type: 'IMAGE' },
      { type: 'TEXT' },
      { type: null },
    ]) {
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
      'assigneeIds',
      'automationIds',
      'campaignIds',
      'campaignStatuses',
      'channelIds',
      'consentChanges',
      'contactEventTags',
      'contactFieldKeys',
      'contactParts',
      'contactSources',
      'contactTags',
      'conversationStatuses',
      'conversationTags',
      'crmChangeMakers',
      'crmExcludedApiKeyIds',
      'dealDetails',
      'dealStatuses',
      'description',
      'enabled',
      'events',
      'headers',
      'messageApiKeyIds',
      'messageSenders',
      'messageStatuses',
      'messageTypes',
      'noteDealOwnerIds',
      'notePipelineIds',
      'noteStageIds',
      'oauth',
      'orderStatuses',
      'ownerIds',
      'paymentLinkStatuses',
      'pipelineIds',
      'runApiKeyIds',
      'runEndReasons',
      'runEndStatuses',
      'runTriggers',
      'stageIds',
      'surveyAssigneeIds',
      'surveyContactTags',
      'surveyConversationTags',
      'surveyScores',
      'surveyTeamIds',
      'taskAssigneeIds',
      'taskDealOwnerIds',
      'taskDetails',
      'taskPipelineIds',
      'taskStageIds',
      'taskStatuses',
      'teamIds',
      'templateIds',
      'templateStatuses',
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
    // Who sent the messages whose statuses an endpoint receives (ADR-172): a list, or null.
    const senders = (answered.properties as Record<string, { anyOf?: unknown[] }>).messageSenders;
    expect(senders?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('messageSenders');
    expect(webhooks['message.status']?.post?.description).toContain(
      'and the statuses of every message unless it names who sent them (its `messageSenders`',
    );
    // The contact parts an endpoint receives as contact.updated (ADR-123): a list, or null.
    const parts = (answered.properties as Record<string, { anyOf?: unknown[] }>).contactParts;
    expect(parts?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('contactParts');
    const createBody = schemas.CreateWebhookEndpoint as { properties: Record<string, unknown> };
    expect(Object.keys(createBody.properties)).toContain('contactParts');
    expect(webhooks['contact.updated']?.post?.description).toContain(
      'An endpoint receives every change unless it names the parts it takes',
    );
    // The automations whose runs an endpoint receives (ADR-145): a list, or null.
    const chosen = (answered.properties as Record<string, { anyOf?: unknown[] }>).automationIds;
    expect(chosen?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('automationIds');
    expect(Object.keys(createBody.properties)).toContain('automationIds');
    expect(webhooks['automation.run_started']?.post?.description).toContain(
      "An endpoint receives every automation's runs unless it names the automations it takes",
    );
    expect(webhooks['automation.run_ended']?.post?.description).toContain(
      'An endpoint that names the automations or API keys it takes receives only their runs',
    );
    // The campaign statuses an endpoint receives (ADR-146): a list, or null.
    const campaignStatuses = (answered.properties as Record<string, { anyOf?: unknown[] }>)
      .campaignStatuses;
    expect(campaignStatuses?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('campaignStatuses');
    expect(Object.keys(createBody.properties)).toContain('campaignStatuses');
    expect(webhooks['campaign.status_changed']?.post?.description).toContain(
      'An endpoint receives every status unless it names the statuses it takes',
    );
    // The order statuses an endpoint receives (ADR-147): a list, or null.
    const orderStatuses = (answered.properties as Record<string, { anyOf?: unknown[] }>)
      .orderStatuses;
    expect(orderStatuses?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('orderStatuses');
    expect(Object.keys(createBody.properties)).toContain('orderStatuses');
    expect(webhooks['order.status_changed']?.post?.description).toContain(
      'An endpoint receives every status unless it names the statuses it takes (its `orderStatuses`',
    );
    // The Payment Link statuses an endpoint receives (ADR-308): a list, or null.
    const paymentLinkStatuses = (answered.properties as Record<string, { anyOf?: unknown[] }>)
      .paymentLinkStatuses;
    expect(paymentLinkStatuses?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('paymentLinkStatuses');
    expect(Object.keys(createBody.properties)).toContain('paymentLinkStatuses');
    expect(webhooks['payment_link.status_changed']?.post?.description).toContain(
      'An endpoint receives every status unless it names the statuses it takes (its `paymentLinkStatuses`',
    );
    // The deal and task statuses an endpoint receives (ADR-309): lists, or null.
    for (const [field, event] of [
      ['dealStatuses', 'deal.status_changed'],
      ['taskStatuses', 'task.status_changed'],
    ] as const) {
      const list = (answered.properties as Record<string, { anyOf?: unknown[] }>)[field];
      expect(list?.anyOf, field).toHaveLength(2);
      expect(answered.required).toContain(field);
      expect(Object.keys(createBody.properties)).toContain(field);
      expect(webhooks[event]?.post?.description).toContain(
        `An endpoint receives every status unless it names the statuses it takes (its \`${field}\``,
      );
    }
    // The deal and task details whose changes an endpoint receives (ADR-310): lists, or null.
    for (const [field, event] of [
      ['dealDetails', 'deal.updated'],
      ['taskDetails', 'task.updated'],
    ] as const) {
      const list = (answered.properties as Record<string, { anyOf?: unknown[] }>)[field];
      expect(list?.anyOf, field).toHaveLength(2);
      expect(answered.required).toContain(field);
      expect(Object.keys(createBody.properties)).toContain(field);
      expect(webhooks[event]?.post?.description).toContain(
        `An endpoint receives every change unless it names the details it takes (its \`${field}\``,
      );
    }
    // The members credited with survey answers and the teams of their conversations (ADR-311).
    for (const field of ['surveyAssigneeIds', 'surveyTeamIds']) {
      const list = (answered.properties as Record<string, { anyOf?: unknown[] }>)[field];
      expect(list?.anyOf, field).toHaveLength(2);
      expect(answered.required).toContain(field);
      expect(Object.keys(createBody.properties)).toContain(field);
      expect(webhooks['satisfaction_survey.answered']?.post?.description).toContain(
        `(its \`${field}\`: `,
      );
    }
    // The contact and conversation tags of survey answers (ADR-312).
    for (const field of ['surveyContactTags', 'surveyConversationTags']) {
      const list = (answered.properties as Record<string, { anyOf?: unknown[] }>)[field];
      expect(list?.anyOf, field).toHaveLength(2);
      expect(answered.required).toContain(field);
      expect(Object.keys(createBody.properties)).toContain(field);
    }
    expect(webhooks['satisfaction_survey.answered']?.post?.description).toContain(
      'Tags narrow it too (its `surveyContactTags` and `surveyConversationTags`',
    );
    // The tags of added and changed contacts (ADR-316).
    const contactEventTags = (answered.properties as Record<string, { anyOf?: unknown[] }>)
      .contactEventTags;
    expect(contactEventTags?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('contactEventTags');
    expect(Object.keys(createBody.properties)).toContain('contactEventTags');
    for (const event of ['contact.created', 'contact.updated']) {
      expect(webhooks[event]?.post?.description, event).toContain(
        'An endpoint that names tags (its `contactEventTags`',
      );
    }
    // The template statuses an endpoint receives (ADR-148): a list, or null.
    const templateStatuses = (answered.properties as Record<string, { anyOf?: unknown[] }>)
      .templateStatuses;
    expect(templateStatuses?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('templateStatuses');
    expect(Object.keys(createBody.properties)).toContain('templateStatuses');
    expect(webhooks['template.status_changed']?.post?.description).toContain(
      'An endpoint receives every status unless it names the statuses it takes (its `templateStatuses`',
    );
    // The conversation statuses an endpoint receives (ADR-149): a list, or null.
    const conversationStatuses = (answered.properties as Record<string, { anyOf?: unknown[] }>)
      .conversationStatuses;
    expect(conversationStatuses?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('conversationStatuses');
    expect(Object.keys(createBody.properties)).toContain('conversationStatuses');
    expect(webhooks['conversation.status_changed']?.post?.description).toContain(
      'An endpoint receives every status unless it names the statuses it takes (its `conversationStatuses`',
    );
    // How the runs an endpoint receives ended (ADR-151): a list, or null.
    const runEndStatuses = (answered.properties as Record<string, { anyOf?: unknown[] }>)
      .runEndStatuses;
    expect(runEndStatuses?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('runEndStatuses');
    expect(Object.keys(createBody.properties)).toContain('runEndStatuses');
    expect(webhooks['automation.run_ended']?.post?.description).toContain(
      'an endpoint receives every end unless it names the statuses it takes (its `runEndStatuses`',
    );
    // The numbers whose events an endpoint receives (ADR-170): a list, or null.
    const channelIds = (answered.properties as Record<string, { anyOf?: unknown[] }>).channelIds;
    expect(channelIds?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('channelIds');
    expect(Object.keys(createBody.properties)).toContain('channelIds');
    expect(doc.info.description).toContain(
      'An endpoint receives the events of every WhatsApp number unless it names the numbers it takes (its `channelIds`',
    );
  });

  it('take senders only with message.status, in their order once each, and a list of them alone is a change (ADR-172)', () => {
    const base = { url: 'https://hooks.example.com/w360', events: ['message.status'] };
    expect(
      apiCreateWebhookEndpointSchema.parse({ ...base, messageSenders: ['api', 'campaign', 'api'] })
        .messageSenders,
    ).toEqual(['campaign', 'api']);
    const createBody = (
      buildOpenApiDocument('https://app.example.com/api/v1').components as unknown as {
        schemas: Record<string, { properties: Record<string, unknown> }>;
      }
    ).schemas.CreateWebhookEndpoint;
    expect(Object.keys(createBody?.properties ?? {})).toContain('messageSenders');
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['message.received'],
      messageSenders: ['api'],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['messageSenders', WEBHOOK_SENDERS_NEED_THE_EVENT],
    ]);
    for (const body of [
      { ...base, messageSenders: [] },
      { ...base, messageSenders: ['contact'] },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(apiUpdateWebhookEndpointSchema.parse({ messageSenders: null })).toEqual({
      messageSenders: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ messageSenders: ['bot'] })).toEqual({
      messageSenders: ['bot'],
    });
  });

  it('take an OAuth client with its secret and answer it without, and a client alone is a change (ADR-173)', () => {
    const base = { url: 'https://hooks.example.com/w360', events: ['message.status'] };
    const oauth = {
      tokenUrl: 'https://auth.example.com/oauth2/token',
      clientId: 'hyfib',
      clientSecret: 's3cret',
      scope: '',
    };
    expect(apiCreateWebhookEndpointSchema.parse({ ...base, oauth }).oauth).toEqual({
      ...oauth,
      scope: null,
    });
    expect(apiCreateWebhookEndpointSchema.parse({ ...base, oauth: null }).oauth).toBeNull();
    expect(
      apiCreateWebhookEndpointSchema.safeParse({ ...base, oauth: { ...oauth, grant: 'password' } })
        .success,
    ).toBe(false);
    // A change may remove the client, or leave its secret out to keep the stored one.
    expect(apiUpdateWebhookEndpointSchema.parse({ oauth: null })).toEqual({ oauth: null });
    const kept = { tokenUrl: oauth.tokenUrl, clientId: oauth.clientId, scope: '' };
    expect(apiUpdateWebhookEndpointSchema.parse({ oauth: kept })).toEqual({
      oauth: { ...kept, scope: null },
    });
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    type Client = { anyOf?: { properties?: Record<string, unknown> }[] };
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const given = (schemas.CreateWebhookEndpoint as { properties: { oauth?: Client } }).properties
      .oauth;
    const answered = schemas.WebhookEndpoint as {
      properties: { oauth?: Client };
      required?: string[];
    };
    const keys = (client: Client | undefined) =>
      Object.keys(client?.anyOf?.find((s) => s.properties)?.properties ?? {}).sort();
    expect(keys(given)).toEqual(['clientId', 'clientSecret', 'scope', 'tokenUrl']);
    // The secret is never answered.
    expect(keys(answered.properties.oauth)).toEqual(['clientId', 'scope', 'tokenUrl']);
    expect(answered.required).toContain('oauth');
    expect(doc.info.description).toContain('send it as `Authorization: Bearer <token>`');
  });

  it('take templates only with message.status or template.status_changed, each once, and a list of them alone is a change (ADR-175)', () => {
    const a = '0190e9a1-0000-7000-8000-00000000002a';
    const b = '0190e9a1-0000-7000-8000-00000000002b';
    const base = { url: 'https://hooks.example.com/w360', events: ['contact.created'] };
    for (const event of WEBHOOK_TEMPLATE_EVENTS) {
      expect(
        apiCreateWebhookEndpointSchema.parse({
          ...base,
          events: ['contact.created', event],
          templateIds: [b, a.toUpperCase(), b],
        }).templateIds,
        event,
      ).toEqual([b, a]);
    }
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['message.received', 'campaign.status_changed'],
      templateIds: [a],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['templateIds', WEBHOOK_TEMPLATES_NEED_THE_EVENTS],
    ]);
    const statuses = { ...base, events: ['message.status'] };
    for (const body of [
      { ...statuses, templateIds: [] },
      { ...statuses, templateIds: ['order_update'] },
      {
        ...statuses,
        templateIds: Array.from(
          { length: WEBHOOK_LIMITS.templates + 1 },
          (_, i) => `0190e9a1-0000-7000-8000-${String(i).padStart(12, '0')}`,
        ),
      },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(
      apiCreateWebhookEndpointSchema.parse({ ...statuses, templateIds: null }).templateIds,
    ).toBe(null);
    expect(apiUpdateWebhookEndpointSchema.parse({ templateIds: null })).toEqual({
      templateIds: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ templateIds: [a] })).toEqual({
      templateIds: [a],
    });
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: unknown[] }>;
      required?: string[];
    };
    expect(answered.properties.templateIds?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('templateIds');
    expect(
      Object.keys((schemas.CreateWebhookEndpoint as { properties: object }).properties),
    ).toContain('templateIds');
    expect(doc.info.description).toContain(
      'And it can name templates (its `templateIds`): then it receives the statuses of the messages sent with them and their changes only',
    );
  });

  it('take campaigns only with message.status or campaign.status_changed, each once, and a list of them alone is a change (ADR-185)', () => {
    const a = '0190e9a1-0000-7000-8000-00000000003a';
    const b = '0190e9a1-0000-7000-8000-00000000003b';
    const base = { url: 'https://hooks.example.com/w360', events: ['contact.created'] };
    for (const event of WEBHOOK_CAMPAIGN_EVENTS) {
      expect(
        apiCreateWebhookEndpointSchema.parse({
          ...base,
          events: ['contact.created', event],
          campaignIds: [b, a.toUpperCase(), b],
        }).campaignIds,
        event,
      ).toEqual([b, a]);
    }
    // Template changes are not a campaign's.
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['message.received', 'template.status_changed'],
      campaignIds: [a],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['campaignIds', WEBHOOK_CAMPAIGNS_NEED_THE_EVENTS],
    ]);
    const statuses = { ...base, events: ['campaign.status_changed'] };
    for (const body of [
      { ...statuses, campaignIds: [] },
      { ...statuses, campaignIds: ['autumn_launch'] },
      {
        ...statuses,
        campaignIds: Array.from(
          { length: WEBHOOK_LIMITS.campaigns + 1 },
          (_, i) => `0190e9a1-0000-7000-8000-${String(i).padStart(12, '0')}`,
        ),
      },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(
      apiCreateWebhookEndpointSchema.parse({ ...statuses, campaignIds: null }).campaignIds,
    ).toBe(null);
    expect(apiUpdateWebhookEndpointSchema.parse({ campaignIds: null })).toEqual({
      campaignIds: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ campaignIds: [a] })).toEqual({
      campaignIds: [a],
    });
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: unknown[] }>;
      required?: string[];
    };
    expect(answered.properties.campaignIds?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('campaignIds');
    expect(
      Object.keys((schemas.CreateWebhookEndpoint as { properties: object }).properties),
    ).toContain('campaignIds');
    expect(doc.info.description).toContain(
      'or campaigns (its `campaignIds`): then the statuses of the messages they sent and their changes only.',
    );
  });

  it('take pipelines only with a deal event, each once, and a list of them alone is a change (ADR-263)', () => {
    const sales = '0190e9a1-0000-7000-8000-00000000004a';
    const renewals = '0190e9a1-0000-7000-8000-00000000004b';
    const base = { url: 'https://hooks.example.com/w360', events: ['contact.created'] };
    for (const event of WEBHOOK_PIPELINE_EVENTS) {
      expect(
        apiCreateWebhookEndpointSchema.parse({
          ...base,
          events: ['contact.created', event],
          pipelineIds: [renewals, sales.toUpperCase(), renewals],
        }).pipelineIds,
        event,
      ).toEqual([renewals, sales]);
    }
    // Task events, even of a deal's tasks, are not a pipeline's.
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['task.created', 'task.status_changed'],
      pipelineIds: [sales],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['pipelineIds', WEBHOOK_PIPELINES_NEED_THE_EVENTS],
    ]);
    const deals = { ...base, events: ['deal.stage_changed'] };
    for (const body of [
      { ...deals, pipelineIds: [] },
      { ...deals, pipelineIds: ['Sales'] },
      {
        ...deals,
        pipelineIds: Array.from(
          { length: WEBHOOK_LIMITS.pipelines + 1 },
          (_, i) => `0190e9a1-0000-7000-8000-${String(i).padStart(12, '0')}`,
        ),
      },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(apiCreateWebhookEndpointSchema.parse({ ...deals, pipelineIds: null }).pipelineIds).toBe(
      null,
    );
    expect(apiUpdateWebhookEndpointSchema.parse({ pipelineIds: null })).toEqual({
      pipelineIds: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ pipelineIds: [sales] })).toEqual({
      pipelineIds: [sales],
    });
    expect(apiUpdateWebhookEndpointSchema.safeParse({}).error?.issues[0]?.message).toContain(
      'the campaigns, the pipelines, the stages, the deal owners',
    );
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: unknown[]; description?: string }>;
      required?: string[];
    };
    expect(answered.properties.pipelineIds?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('pipelineIds');
    const given = (schemas.CreateWebhookEndpoint as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(given)).toContain('pipelineIds');
    expect(JSON.stringify(given.pipelineIds)).toContain(
      'deal.stage_changed reaches the endpoints of the pipeline a move to another pipeline left',
    );
    expect(doc.info.description).toContain(
      "And it can name CRM pipelines (its `pipelineIds`): then it receives the events of those pipelines' deals only",
    );
  });

  it('take stages only with a deal event, each once, and a list of them alone is a change (ADR-264)', () => {
    const proposal = '0190e9a1-0000-7000-8000-00000000005a';
    const signed = '0190e9a1-0000-7000-8000-00000000005b';
    const base = { url: 'https://hooks.example.com/w360', events: ['contact.created'] };
    for (const event of WEBHOOK_PIPELINE_EVENTS) {
      expect(
        apiCreateWebhookEndpointSchema.parse({
          ...base,
          events: ['contact.created', event],
          stageIds: [signed, proposal.toUpperCase(), signed],
        }).stageIds,
        event,
      ).toEqual([signed, proposal]);
    }
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['task.created'],
      stageIds: [proposal],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['stageIds', WEBHOOK_STAGES_NEED_THE_EVENTS],
    ]);
    const deals = { ...base, events: ['deal.created'] };
    for (const body of [
      { ...deals, stageIds: [] },
      { ...deals, stageIds: ['Proposal'] },
      {
        ...deals,
        stageIds: Array.from(
          { length: WEBHOOK_LIMITS.stages + 1 },
          (_, i) => `0190e9a1-0000-7000-8000-${String(i).padStart(12, '0')}`,
        ),
      },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(apiCreateWebhookEndpointSchema.parse({ ...deals, stageIds: null }).stageIds).toBe(null);
    expect(apiUpdateWebhookEndpointSchema.parse({ stageIds: null })).toEqual({ stageIds: null });
    expect(apiUpdateWebhookEndpointSchema.parse({ stageIds: [signed] })).toEqual({
      stageIds: [signed],
    });
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: unknown[] }>;
      required?: string[];
    };
    expect(answered.properties.stageIds?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('stageIds');
    const given = (schemas.CreateWebhookEndpoint as { properties: Record<string, unknown> })
      .properties;
    expect(JSON.stringify(given.stageIds)).toContain(
      'deal.stage_changed reaches the endpoints of the stage the deal left',
    );
    expect(JSON.stringify(given.stageIds)).toContain(
      'With pipelines (`pipelineIds`) or owners (`ownerIds`) too, an event must pass them all.',
    );
    expect(doc.info.description).toContain(
      'or stages (its `stageIds`): then those of the deals in those stages only',
    );
  });

  it('take deal owners only with a deal event, each once, and a list of them alone is a change (ADR-265)', () => {
    const asha = '0190e9a1-0000-7000-8000-00000000006a';
    const dev = '0190e9a1-0000-7000-8000-00000000006b';
    const base = { url: 'https://hooks.example.com/w360', events: ['contact.created'] };
    for (const event of WEBHOOK_PIPELINE_EVENTS) {
      expect(
        apiCreateWebhookEndpointSchema.parse({
          ...base,
          events: ['contact.created', event],
          ownerIds: [dev, asha.toUpperCase(), dev],
        }).ownerIds,
        event,
      ).toEqual([dev, asha]);
    }
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['task.created', 'message.received'],
      ownerIds: [asha],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['ownerIds', WEBHOOK_OWNERS_NEED_THE_EVENTS],
    ]);
    const deals = { ...base, events: ['deal.status_changed'] };
    for (const body of [
      { ...deals, ownerIds: [] },
      { ...deals, ownerIds: ['asha@example.com'] },
      {
        ...deals,
        ownerIds: Array.from(
          { length: WEBHOOK_LIMITS.owners + 1 },
          (_, i) => `0190e9a1-0000-7000-8000-${String(i).padStart(12, '0')}`,
        ),
      },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(apiCreateWebhookEndpointSchema.parse({ ...deals, ownerIds: null }).ownerIds).toBe(null);
    expect(apiUpdateWebhookEndpointSchema.parse({ ownerIds: null })).toEqual({ ownerIds: null });
    expect(apiUpdateWebhookEndpointSchema.parse({ ownerIds: [dev] })).toEqual({ ownerIds: [dev] });
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: unknown[] }>;
      required?: string[];
    };
    expect(answered.properties.ownerIds?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('ownerIds');
    const given = (schemas.CreateWebhookEndpoint as { properties: Record<string, unknown> })
      .properties;
    expect(JSON.stringify(given.ownerIds)).toContain(
      "A deal's event belongs to the member who owns the deal when the event happens",
    );
    // A change of owner is a deal event, and reaches both owners (ADR-269).
    expect(JSON.stringify(given.ownerIds)).toContain(
      'deal.owner_changed reaches the endpoints of the owner the deal left as well as of the one it was given to',
    );
    for (const field of ['pipelineIds', 'stageIds', 'ownerIds'] as const) {
      expect(JSON.stringify(given[field]), field).toContain(
        'deal.created, deal.updated, deal.stage_changed, deal.owner_changed or deal.status_changed',
      );
    }
    expect(JSON.stringify(answered.properties.ownerIds)).toContain(
      'deal.owner_changed also by the owner it left',
    );
    expect(doc.info.description).toContain(
      'a change of owner reaching the endpoints of the owner it left as well',
    );
    expect(doc.info.description).toContain(
      "or the deals' owners (its `ownerIds`): then those of the deals the members own when the event happens only",
    );
  });

  it('take task assignees only with a task event, each once, and a list of them alone is a change (ADR-266)', () => {
    const asha = '0190e9a1-0000-7000-8000-00000000006a';
    const dev = '0190e9a1-0000-7000-8000-00000000006b';
    const base = { url: 'https://hooks.example.com/w360', events: ['contact.created'] };
    for (const event of WEBHOOK_TASK_EVENTS) {
      expect(
        apiCreateWebhookEndpointSchema.parse({
          ...base,
          events: ['contact.created', event],
          taskAssigneeIds: [dev, asha.toUpperCase(), dev],
        }).taskAssigneeIds,
        event,
      ).toEqual([dev, asha]);
    }
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['deal.created', 'message.received'],
      taskAssigneeIds: [asha],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['taskAssigneeIds', WEBHOOK_TASK_ASSIGNEES_NEED_THE_EVENTS],
    ]);
    const tasks = { ...base, events: ['task.status_changed'] };
    for (const body of [
      { ...tasks, taskAssigneeIds: [] },
      { ...tasks, taskAssigneeIds: ['asha@example.com'] },
      {
        ...tasks,
        taskAssigneeIds: Array.from(
          { length: WEBHOOK_LIMITS.taskAssignees + 1 },
          (_, i) => `0190e9a1-0000-7000-8000-${String(i).padStart(12, '0')}`,
        ),
      },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(
      apiCreateWebhookEndpointSchema.parse({ ...tasks, taskAssigneeIds: null }).taskAssigneeIds,
    ).toBe(null);
    expect(apiUpdateWebhookEndpointSchema.parse({ taskAssigneeIds: null })).toEqual({
      taskAssigneeIds: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ taskAssigneeIds: [dev] })).toEqual({
      taskAssigneeIds: [dev],
    });
    expect(apiUpdateWebhookEndpointSchema.safeParse({}).error?.issues[0]?.message).toContain(
      'the deal owners, the task assignees, the pipelines, stages and owners of tasks’ deals and of notes’ deals, who made the CRM changes, the API keys whose CRM changes are left out, the survey scores, the members credited with survey answers and the teams of their conversations, the contact and conversation tags of survey answers, the tags of added and changed contacts, the members, the contact tags, the conversation tags, the OAuth client',
    );
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: unknown[] }>;
      required?: string[];
    };
    expect(answered.properties.taskAssigneeIds?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('taskAssigneeIds');
    const given = (schemas.CreateWebhookEndpoint as { properties: Record<string, unknown> })
      .properties;
    expect(JSON.stringify(given.taskAssigneeIds)).toContain(
      "A task's event belongs to the member it is assigned to when the event happens",
    );
    expect(doc.info.description).toContain(
      'then it receives the events of the tasks assigned to them when the event happens only',
    );
    // A change of assignee is a task event, and reaches both assignees (ADR-274).
    expect(JSON.stringify(given.taskAssigneeIds)).toContain(
      'task.created, task.updated, task.assignee_changed or task.status_changed',
    );
    expect(JSON.stringify(given.taskAssigneeIds)).toContain(
      'task.assignee_changed reaches the endpoints of the member the task left as well as of the one it was given to',
    );
    expect(JSON.stringify(answered.properties.taskAssigneeIds)).toContain(
      'task.assignee_changed also by the member it left',
    );
    expect(JSON.stringify(answered.properties.taskAssigneeIds)).toContain(
      '(task.created, task.updated, task.assignee_changed, task.status_changed)',
    );
    expect(doc.info.description).toContain(
      'a change of assignee reaching the endpoints of the member it left as well',
    );
    expect(
      apiCreateWebhookEndpointSchema.parse({
        ...tasks,
        events: ['task.assignee_changed'],
        taskAssigneeIds: [dev],
      }).taskAssigneeIds,
    ).toEqual([dev]);
    // So is a change of details (ADR-276).
    expect(
      apiCreateWebhookEndpointSchema.parse({
        ...tasks,
        events: ['task.updated'],
        taskAssigneeIds: [dev],
      }).taskAssigneeIds,
    ).toEqual([dev]);
  });

  it('take the pipelines of tasks’ deals only with a task event, each once, and a list of them alone is a change (ADR-303)', () => {
    const sales = '0190e9a1-0000-7000-8000-00000000007a';
    const renewals = '0190e9a1-0000-7000-8000-00000000007b';
    const base = { url: 'https://hooks.example.com/w360', events: ['contact.created'] };
    for (const event of WEBHOOK_TASK_EVENTS) {
      expect(
        apiCreateWebhookEndpointSchema.parse({
          ...base,
          events: ['contact.created', event],
          taskPipelineIds: [renewals, sales.toUpperCase(), renewals],
        }).taskPipelineIds,
        event,
      ).toEqual([renewals, sales]);
    }
    // Deal events take pipelines of their own (pipelineIds).
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['deal.created', 'message.received'],
      taskPipelineIds: [sales],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['taskPipelineIds', WEBHOOK_TASK_PIPELINES_NEED_THE_EVENTS],
    ]);
    const tasks = { ...base, events: ['task.created'] };
    for (const body of [
      { ...tasks, taskPipelineIds: [] },
      { ...tasks, taskPipelineIds: ['Sales'] },
      {
        ...tasks,
        taskPipelineIds: Array.from(
          { length: WEBHOOK_LIMITS.taskPipelines + 1 },
          (_, i) => `0190e9a1-0000-7000-8000-${String(i).padStart(12, '0')}`,
        ),
      },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(
      apiCreateWebhookEndpointSchema.parse({ ...tasks, taskPipelineIds: null }).taskPipelineIds,
    ).toBe(null);
    expect(
      apiCreateWebhookEndpointSchema.parse({
        ...tasks,
        pipelineIds: undefined,
        taskAssigneeIds: undefined,
      }).taskPipelineIds,
    ).toBeUndefined();
    expect(apiUpdateWebhookEndpointSchema.parse({ taskPipelineIds: null })).toEqual({
      taskPipelineIds: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ taskPipelineIds: [sales] })).toEqual({
      taskPipelineIds: [sales],
    });
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: unknown[] }>;
      required?: string[];
    };
    expect(answered.properties.taskPipelineIds?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('taskPipelineIds');
    expect(JSON.stringify(answered.properties.taskPipelineIds)).toContain(
      "by the pipeline of the task's deal when an event happens; a task without a deal is on no list",
    );
    const given = (schemas.CreateWebhookEndpoint as { properties: Record<string, unknown> })
      .properties;
    expect(JSON.stringify(given.taskPipelineIds)).toContain(
      "A task's event belongs to the pipeline of the deal the task is about when the event happens",
    );
    expect(JSON.stringify(given.taskPipelineIds)).toContain(
      'task.created, task.updated, task.assignee_changed or task.status_changed',
    );
    expect(doc.info.description).toContain(
      'or the pipelines, stages or owners of the deals whose tasks it takes (its `taskPipelineIds`, `taskStageIds` and `taskDealOwnerIds`): then those of the tasks about deals in those pipelines or stages, or owned by those members, when the event happens only',
    );
  });

  it('take the stages and owners of tasks’ deals only with a task event, each once, and a list of them alone is a change (ADR-304)', () => {
    const proposal = '0190e9a1-0000-7000-8000-00000000008a';
    const asha = '0190e9a1-0000-7000-8000-00000000008b';
    const dev = '0190e9a1-0000-7000-8000-00000000008c';
    const base = { url: 'https://hooks.example.com/w360', events: ['contact.created'] };
    for (const event of WEBHOOK_TASK_EVENTS) {
      const parsed = apiCreateWebhookEndpointSchema.parse({
        ...base,
        events: ['contact.created', event],
        taskStageIds: [proposal, proposal.toUpperCase()],
        taskDealOwnerIds: [dev, asha.toUpperCase(), dev],
      });
      expect([parsed.taskStageIds, parsed.taskDealOwnerIds], event).toEqual([
        [proposal],
        [dev, asha],
      ]);
    }
    // Deal events take stages and owners of their own (stageIds, ownerIds).
    for (const [field, message] of [
      ['taskStageIds', WEBHOOK_TASK_STAGES_NEED_THE_EVENTS],
      ['taskDealOwnerIds', WEBHOOK_TASK_DEAL_OWNERS_NEED_THE_EVENTS],
    ] as const) {
      const refused = apiCreateWebhookEndpointSchema.safeParse({
        ...base,
        events: ['deal.created', 'message.received'],
        [field]: [asha],
      });
      expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
        [field, message],
      ]);
      const tasks = { ...base, events: ['task.updated'] };
      for (const value of [
        [],
        ['Proposal'],
        Array.from(
          { length: 51 },
          (_, i) => `0190e9a1-0000-7000-8000-${String(i).padStart(12, '0')}`,
        ),
      ]) {
        expect(
          apiCreateWebhookEndpointSchema.safeParse({ ...tasks, [field]: value }).success,
          `${field} ${JSON.stringify(value)}`,
        ).toBe(false);
      }
      expect(apiCreateWebhookEndpointSchema.parse({ ...tasks, [field]: null })[field]).toBe(null);
      expect(apiUpdateWebhookEndpointSchema.parse({ [field]: null })).toEqual({ [field]: null });
      expect(apiUpdateWebhookEndpointSchema.parse({ [field]: [asha] })).toEqual({
        [field]: [asha],
      });
    }
    expect(WEBHOOK_LIMITS.taskStages).toBe(50);
    expect(WEBHOOK_LIMITS.taskDealOwners).toBe(50);
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: unknown[] }>;
      required?: string[];
    };
    for (const field of ['taskStageIds', 'taskDealOwnerIds']) {
      expect(answered.properties[field]?.anyOf, field).toHaveLength(2);
      expect(answered.required).toContain(field);
    }
    expect(JSON.stringify(answered.properties.taskStageIds)).toContain(
      "by the stage of the task's deal when an event happens; a task without a deal is on no list",
    );
    expect(JSON.stringify(answered.properties.taskDealOwnerIds)).toContain(
      "by the owner of the task's deal when an event happens; a task without a deal, or of a deal without an owner, is on no list",
    );
    const given = (schemas.CreateWebhookEndpoint as { properties: Record<string, unknown> })
      .properties;
    expect(JSON.stringify(given.taskStageIds)).toContain(
      "A task's event belongs to the stage of the deal the task is about when the event happens",
    );
    expect(JSON.stringify(given.taskDealOwnerIds)).toContain(
      "A task's event belongs to the member who owns the deal the task is about when the event happens",
    );
    for (const field of ['taskStageIds', 'taskDealOwnerIds']) {
      expect(JSON.stringify(given[field]), field).toContain(
        'task.created, task.updated, task.assignee_changed or task.status_changed',
      );
    }
  });

  it('take the pipelines, stages and owners of notes’ deals only with note.created, each once, and a list of them alone is a change (ADR-305)', () => {
    const sales = '0190e9a1-0000-7000-8000-00000000008d';
    const proposal = '0190e9a1-0000-7000-8000-00000000008e';
    const asha = '0190e9a1-0000-7000-8000-00000000008f';
    const base = {
      url: 'https://hooks.example.com/w360',
      events: ['contact.created', 'note.created'],
    };
    const parsed = apiCreateWebhookEndpointSchema.parse({
      ...base,
      notePipelineIds: [sales, sales.toUpperCase()],
      noteStageIds: [proposal],
      noteDealOwnerIds: [asha, asha],
    });
    expect([parsed.notePipelineIds, parsed.noteStageIds, parsed.noteDealOwnerIds]).toEqual([
      [sales],
      [proposal],
      [asha],
    ]);
    // Deal and task events take lists of their own.
    for (const [field, message] of [
      ['notePipelineIds', WEBHOOK_NOTE_PIPELINES_NEED_THE_EVENTS],
      ['noteStageIds', WEBHOOK_NOTE_STAGES_NEED_THE_EVENTS],
      ['noteDealOwnerIds', WEBHOOK_NOTE_DEAL_OWNERS_NEED_THE_EVENTS],
    ] as const) {
      const refused = apiCreateWebhookEndpointSchema.safeParse({
        ...base,
        events: ['deal.created', 'task.created'],
        [field]: [asha],
      });
      expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
        [field, message],
      ]);
      const notes = { ...base, events: ['note.created'] };
      for (const value of [
        [],
        ['Sales'],
        Array.from(
          { length: 51 },
          (_, i) => `0190e9a1-0000-7000-8000-${String(i).padStart(12, '0')}`,
        ),
      ]) {
        expect(
          apiCreateWebhookEndpointSchema.safeParse({ ...notes, [field]: value }).success,
          `${field} ${JSON.stringify(value)}`,
        ).toBe(false);
      }
      expect(apiCreateWebhookEndpointSchema.parse({ ...notes, [field]: null })[field]).toBe(null);
      expect(apiUpdateWebhookEndpointSchema.parse({ [field]: null })).toEqual({ [field]: null });
      expect(apiUpdateWebhookEndpointSchema.parse({ [field]: [asha] })).toEqual({
        [field]: [asha],
      });
    }
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: unknown[] }>;
      required?: string[];
    };
    for (const field of ['notePipelineIds', 'noteStageIds', 'noteDealOwnerIds']) {
      expect(answered.properties[field]?.anyOf, field).toHaveLength(2);
      expect(answered.required).toContain(field);
    }
    expect(JSON.stringify(answered.properties.notePipelineIds)).toContain(
      "by the pipeline of the note's deal when the note is added; a note about a contact alone is on no list",
    );
    expect(JSON.stringify(answered.properties.noteStageIds)).toContain(
      "by the stage of the note's deal when the note is added; a note about a contact alone is on no list",
    );
    expect(JSON.stringify(answered.properties.noteDealOwnerIds)).toContain(
      "by the owner of the note's deal when the note is added; a note about a contact alone, or of a deal without an owner, is on no list",
    );
    const given = (schemas.CreateWebhookEndpoint as { properties: Record<string, unknown> })
      .properties;
    expect(JSON.stringify(given.notePipelineIds)).toContain(
      "A note's event belongs to the pipeline of the deal the note is about when the note is added",
    );
    expect(JSON.stringify(given.noteStageIds)).toContain(
      "A note's event belongs to the stage of the deal the note is about when the note is added",
    );
    expect(JSON.stringify(given.noteDealOwnerIds)).toContain(
      "A note's event belongs to the member who owns the deal the note is about when the note is added",
    );
    for (const field of ['notePipelineIds', 'noteStageIds', 'noteDealOwnerIds']) {
      expect(JSON.stringify(given[field]), field).toContain('only with note.created');
    }
    expect(doc.info.description).toContain(
      'And it can name the pipelines, stages or owners of the deals whose notes it takes (its `notePipelineIds`, `noteStageIds` and `noteDealOwnerIds`): then it receives the events of the notes about deals in those pipelines or stages, or owned by those members, when the note is added only',
    );
    expect(doc.info.description).toContain(
      'and still every consent, contact, template, deal, task and note event it takes',
    );
    const noteEvent = (doc.webhooks as Record<string, { post?: { description?: string } }>)[
      'note.created'
    ]?.post?.description;
    expect(noteEvent).toContain(
      'An endpoint can narrow it by the pipeline, stage or owner of the note’s deal when the note is added (`notePipelineIds`, `noteStageIds`, `noteDealOwnerIds`): a note about a contact alone then matches none.',
    );
    expect(noteEvent).not.toContain('No endpoint filter narrows it.');
  });

  it('take who made the CRM changes only with a deal, task or note event, once each, and a list of them alone is a change (ADR-306)', () => {
    const base = { url: 'https://hooks.example.com/w360' };
    for (const events of [['deal.updated'], ['task.created'], ['note.created']]) {
      expect(
        apiCreateWebhookEndpointSchema.parse({
          ...base,
          events,
          crmChangeMakers: ['api', 'member', 'api'],
        }).crmChangeMakers,
        events[0],
      ).toEqual(['member', 'api']);
    }
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['contact.updated', 'message.status'],
      crmChangeMakers: ['member'],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['crmChangeMakers', WEBHOOK_CRM_CHANGE_MAKERS_NEED_THE_EVENTS],
    ]);
    for (const value of [[], ['agent'], ['api', 'api', 'api', 'api']]) {
      expect(
        apiCreateWebhookEndpointSchema.safeParse({
          ...base,
          events: ['deal.created'],
          crmChangeMakers: value,
        }).success,
        JSON.stringify(value),
      ).toBe(false);
    }
    expect(apiUpdateWebhookEndpointSchema.parse({ crmChangeMakers: null })).toEqual({
      crmChangeMakers: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ crmChangeMakers: ['automation'] })).toEqual({
      crmChangeMakers: ['automation'],
    });
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: { items?: { enum?: string[] } }[] }>;
      required?: string[];
    };
    expect(answered.properties.crmChangeMakers?.anyOf?.[0]?.items?.enum).toEqual([
      'member',
      'automation',
      'api',
    ]);
    expect(answered.required).toContain('crmChangeMakers');
    expect(JSON.stringify(answered.properties.crmChangeMakers)).toContain(
      'A change HyFib did not record the maker of (changedBy null) is sent whoever is listed.',
    );
    const given = (schemas.CreateWebhookEndpoint as { properties: Record<string, unknown> })
      .properties;
    expect(JSON.stringify(given.crmChangeMakers)).toContain(
      'one or more of `member`, `automation`, `api`, as the events name them (`deal.changedBy`, `task.changedBy`, `note.writtenBy`), only with a deal, task or note event',
    );
    expect(JSON.stringify(given.crmChangeMakers)).toContain(
      'An addition belongs to whoever added the deal or task, a note to whoever wrote it',
    );
    expect(doc.info.description).toContain(
      'And it can name who made the changes whose deal, task and note events it takes (its `crmChangeMakers`: members, automations or API keys, as `changedBy` and `writtenBy` name them): then it receives the events of the changes they made only, and those HyFib did not record the maker of',
    );
  });

  it('take survey scores only with satisfaction_survey.answered, once each, and a list of them alone is a change (ADR-307)', () => {
    const base = {
      url: 'https://hooks.example.com/w360',
      events: ['satisfaction_survey.answered'],
    };
    expect(
      apiCreateWebhookEndpointSchema.parse({ ...base, surveyScores: [1, 3, 1] }).surveyScores,
    ).toEqual([3, 1]);
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['conversation.status_changed'],
      surveyScores: [1],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['surveyScores', WEBHOOK_SURVEY_SCORES_NEED_THE_EVENT],
    ]);
    for (const value of [[], [0], ['1'], [1, 1, 1, 1]]) {
      expect(
        apiCreateWebhookEndpointSchema.safeParse({ ...base, surveyScores: value }).success,
        JSON.stringify(value),
      ).toBe(false);
    }
    expect(apiUpdateWebhookEndpointSchema.parse({ surveyScores: null })).toEqual({
      surveyScores: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ surveyScores: [1] })).toEqual({
      surveyScores: [1],
    });
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: { items?: { enum?: number[] } }[] }>;
      required?: string[];
    };
    expect(answered.properties.surveyScores?.anyOf?.[0]?.items?.enum).toEqual([3, 2, 1]);
    expect(answered.required).toContain('surveyScores');
    const given = (schemas.CreateWebhookEndpoint as { properties: Record<string, unknown> })
      .properties;
    expect(JSON.stringify(given.surveyScores)).toContain('one or more of 3, 2, 1, as the survey');
    expect(JSON.stringify(given.surveyScores)).toContain('only with satisfaction_survey.answered');
    const surveyEvent = (doc.webhooks as Record<string, { post?: { description?: string } }>)[
      'satisfaction_survey.answered'
    ]?.post?.description;
    expect(surveyEvent).toContain(
      'An endpoint receives every answer unless it names the scores it takes (its `surveyScores`, or the scores ticked in Settings → Webhooks).',
    );
  });

  it('take contact tags only with an event of a conversation, as contacts carry them, and a list of them alone is a change (ADR-267)', () => {
    const base = { url: 'https://hooks.example.com/w360', events: ['contact.created'] };
    for (const event of WEBHOOK_TEAM_EVENTS) {
      expect(
        apiCreateWebhookEndpointSchema.parse({
          ...base,
          events: ['contact.created', event],
          contactTags: ['VIP', 'vip ', 'Wholesale'],
        }).contactTags,
        event,
      ).toEqual(['vip', 'wholesale']);
    }
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['deal.created', 'task.created'],
      contactTags: ['vip'],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['contactTags', WEBHOOK_CONTACT_TAGS_NEED_THE_EVENTS],
    ]);
    const messages = { ...base, events: ['message.received'] };
    for (const body of [
      { ...messages, contactTags: [] },
      { ...messages, contactTags: ['a,b'] },
      { ...messages, contactTags: Array.from({ length: 51 }, (_, i) => `tag ${i}`) },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(
      apiCreateWebhookEndpointSchema.parse({ ...messages, contactTags: null }).contactTags,
    ).toBe(null);
    expect(apiUpdateWebhookEndpointSchema.parse({ contactTags: null })).toEqual({
      contactTags: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ contactTags: ['Gold'] })).toEqual({
      contactTags: ['gold'],
    });
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: unknown[] }>;
      required?: string[];
    };
    expect(answered.properties.contactTags?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('contactTags');
    const given = (schemas.CreateWebhookEndpoint as { properties: Record<string, unknown> })
      .properties;
    expect(JSON.stringify(given.contactTags)).toContain(
      'counts when the contact has any of the tags when the event happens',
    );
    expect(doc.info.description).toContain(
      'or contact tags (its `contactTags`): then those of the conversations whose contact has any of the tags when the event happens only',
    );
  });

  it('take conversation tags only with an event of a conversation, as conversations carry them, and a list of them alone is a change (ADR-273)', () => {
    const base = { url: 'https://hooks.example.com/w360', events: ['contact.created'] };
    for (const event of WEBHOOK_TEAM_EVENTS) {
      expect(
        apiCreateWebhookEndpointSchema.parse({
          ...base,
          events: ['contact.created', event],
          conversationTags: ['Refund', 'refund ', 'Delivery   Delay'],
        }).conversationTags,
        event,
      ).toEqual(['refund', 'delivery delay']);
    }
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['deal.created', 'task.created'],
      conversationTags: ['refund'],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['conversationTags', WEBHOOK_CONVERSATION_TAGS_NEED_THE_EVENTS],
    ]);
    const messages = { ...base, events: ['message.received'] };
    for (const body of [
      { ...messages, conversationTags: [] },
      { ...messages, conversationTags: ['a,b'] },
      { ...messages, conversationTags: ['x'.repeat(41)] },
      { ...messages, conversationTags: Array.from({ length: 51 }, (_, i) => `tag ${i}`) },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(
      apiCreateWebhookEndpointSchema.parse({ ...messages, conversationTags: null })
        .conversationTags,
    ).toBe(null);
    // Contact tags and conversation tags are separate lists.
    expect(
      apiCreateWebhookEndpointSchema.parse({
        ...messages,
        contactTags: ['vip'],
        conversationTags: ['refund'],
      }),
    ).toMatchObject({ contactTags: ['vip'], conversationTags: ['refund'] });
    expect(apiUpdateWebhookEndpointSchema.parse({ conversationTags: null })).toEqual({
      conversationTags: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ conversationTags: ['Urgent'] })).toEqual({
      conversationTags: ['urgent'],
    });
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: unknown[]; description?: string }>;
      required?: string[];
    };
    expect(answered.properties.conversationTags?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('conversationTags');
    expect(JSON.stringify(answered.properties.conversationTags)).toContain(
      'by the tags the conversation has when the event happens',
    );
    const given = (schemas.CreateWebhookEndpoint as { properties: Record<string, unknown> })
      .properties;
    expect(JSON.stringify(given.conversationTags)).toContain(
      'counts when its conversation has any of the tags when the event happens',
    );
    expect(JSON.stringify(given.conversationTags)).toContain('GET /conversation-tags');
    expect(doc.info.description).toContain(
      'or conversation tags (its `conversationTags`): then those of the conversations that have any of the tags when the event happens only',
    );
    const paths = doc.paths as Record<string, Record<string, { description?: string }>>;
    expect(paths['/conversation-tags']?.get?.description).toContain(
      'webhook endpoints name (`conversationTags`)',
    );
  });

  it('take custom fields only with contact.updated for every part or for fields, each once, and a list of them alone is a change (ADR-184)', () => {
    const base = { url: 'https://hooks.example.com/w360', events: ['contact.updated'] };
    expect(
      apiCreateWebhookEndpointSchema.parse({ ...base, contactFieldKeys: ['tier', 'city', 'tier'] })
        .contactFieldKeys,
    ).toEqual(['tier', 'city']);
    expect(
      apiCreateWebhookEndpointSchema.parse({
        ...base,
        contactParts: ['email', 'fields'],
        contactFieldKeys: ['city'],
      }).contactFieldKeys,
    ).toEqual(['city']);
    // Parts without fields, or no contact.updated, take no field changes to narrow.
    for (const body of [
      { ...base, contactParts: ['email', 'tags'], contactFieldKeys: ['city'] },
      { ...base, events: ['contact.created'], contactFieldKeys: ['city'] },
    ]) {
      const refused = apiCreateWebhookEndpointSchema.safeParse(body);
      expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toContainEqual([
        'contactFieldKeys',
        WEBHOOK_FIELDS_NEED_THE_PART,
      ]);
    }
    for (const contactFieldKeys of [[], ['City'], ['fields.city']]) {
      expect(
        apiCreateWebhookEndpointSchema.safeParse({ ...base, contactFieldKeys }).success,
        JSON.stringify(contactFieldKeys),
      ).toBe(false);
    }
    expect(apiUpdateWebhookEndpointSchema.parse({ contactFieldKeys: null })).toEqual({
      contactFieldKeys: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ contactFieldKeys: ['tier'] })).toEqual({
      contactFieldKeys: ['tier'],
    });
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: unknown[] }>;
      required?: string[];
    };
    expect(answered.properties.contactFieldKeys?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('contactFieldKeys');
    const created = schemas.CreateWebhookEndpoint as {
      properties: Record<string, { description?: string }>;
    };
    expect(created.properties.contactFieldKeys?.description).toContain('GET /contact-fields');
  });

  it('take what started the runs only with a run event, each once, and a list of them alone is a change (ADR-183)', () => {
    const base = { url: 'https://hooks.example.com/w360', events: ['contact.created'] };
    for (const event of ['automation.run_started', 'automation.run_ended']) {
      expect(
        apiCreateWebhookEndpointSchema.parse({
          ...base,
          events: ['contact.created', event],
          runTriggers: ['api', 'keyword', 'api'],
        }).runTriggers,
        event,
      ).toEqual(['keyword', 'api']);
    }
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['message.received', 'order.received'],
      runTriggers: ['api'],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['runTriggers', WEBHOOK_RUN_TRIGGERS_NEED_THE_EVENTS],
    ]);
    const runs = { ...base, events: ['automation.run_started'] };
    for (const body of [
      { ...runs, runTriggers: [] },
      { ...runs, runTriggers: ['test'] },
      { ...runs, runTriggers: ['webhook'] },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(apiCreateWebhookEndpointSchema.parse({ ...runs, runTriggers: null }).runTriggers).toBe(
      null,
    );
    expect(apiUpdateWebhookEndpointSchema.parse({ runTriggers: null })).toEqual({
      runTriggers: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ runTriggers: ['api'] })).toEqual({
      runTriggers: ['api'],
    });
    // Answered as a list of the triggers run events name, or null.
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: { items?: { enum?: unknown } }[] }>;
      required?: string[];
    };
    expect(answered.properties.runTriggers?.anyOf?.find((s) => s.items)?.items?.enum).toEqual([
      'keyword',
      'conversation_started',
      'any_message',
      'store_event',
      'api',
    ]);
    expect(answered.required).toContain('runTriggers');
    expect(
      Object.keys((schemas.CreateWebhookEndpoint as { properties: object }).properties),
    ).toContain('runTriggers');
  });

  it('take consent changes only with consent.changed, each once, and a list of them alone is a change (ADR-189)', () => {
    const base = { url: 'https://hooks.example.com/w360', events: ['consent.changed'] };
    expect(
      apiCreateWebhookEndpointSchema.parse({
        ...base,
        consentChanges: ['utility_opt_in', 'marketing_opt_out', 'utility_opt_in'],
      }).consentChanges,
    ).toEqual(['marketing_opt_out', 'utility_opt_in']);
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['contact.created', 'contact.updated'],
      consentChanges: ['marketing_opt_out'],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['consentChanges', WEBHOOK_CONSENT_CHANGES_NEED_THE_EVENT],
    ]);
    for (const body of [
      { ...base, consentChanges: [] },
      { ...base, consentChanges: ['opt_out'] },
      { ...base, consentChanges: ['marketing'] },
      { ...base, consentChanges: ['Marketing_opt_out'] },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(
      apiCreateWebhookEndpointSchema.parse({ ...base, consentChanges: null }).consentChanges,
    ).toBe(null);
    expect(apiUpdateWebhookEndpointSchema.parse({ consentChanges: null })).toEqual({
      consentChanges: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ consentChanges: ['utility_opt_out'] })).toEqual({
      consentChanges: ['utility_opt_out'],
    });
    // Answered as a list of the changes, or null.
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: { items?: { enum?: unknown } }[] }>;
      required?: string[];
    };
    expect(answered.properties.consentChanges?.anyOf?.find((c) => c.items)?.items?.enum).toEqual([
      'marketing_opt_in',
      'marketing_opt_out',
      'utility_opt_in',
      'utility_opt_out',
    ]);
    expect(answered.required).toContain('consentChanges');
    expect(
      Object.keys((schemas.CreateWebhookEndpoint as { properties: object }).properties),
    ).toContain('consentChanges');
  });

  it('take where contacts came from only with contact.created, each once, and a list of them alone is a change (ADR-190)', () => {
    const base = { url: 'https://hooks.example.com/w360', events: ['contact.created'] };
    expect(
      apiCreateWebhookEndpointSchema.parse({
        ...base,
        contactSources: ['store', 'whatsapp', 'store'],
      }).contactSources,
    ).toEqual(['whatsapp', 'store']);
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['contact.updated', 'contact.erased'],
      contactSources: ['whatsapp'],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['contactSources', WEBHOOK_CONTACT_SOURCES_NEED_THE_EVENT],
    ]);
    for (const body of [
      { ...base, contactSources: [] },
      { ...base, contactSources: ['agent'] },
      { ...base, contactSources: ['flow'] },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(
      apiCreateWebhookEndpointSchema.parse({ ...base, contactSources: null }).contactSources,
    ).toBe(null);
    expect(apiUpdateWebhookEndpointSchema.parse({ contactSources: null })).toEqual({
      contactSources: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ contactSources: ['import', 'api'] })).toEqual({
      contactSources: ['import', 'api'],
    });
    // Answered as a list of sources, or null.
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: { items?: { enum?: unknown } }[] }>;
      required?: string[];
    };
    expect(answered.properties.contactSources?.anyOf?.find((c) => c.items)?.items?.enum).toEqual([
      'whatsapp',
      'manual',
      'import',
      'api',
      'store',
    ]);
    expect(answered.required).toContain('contactSources');
    const create = schemas.CreateWebhookEndpoint as {
      properties: Record<string, { description?: string }>;
    };
    expect(create.properties.contactSources?.description).toContain(
      'Leave out `api` not to hear of the contacts your own keys add.',
    );
  });

  it('take the types of received messages only with message.received, each once, and a list of them alone is a change (ADR-191)', () => {
    const base = { url: 'https://hooks.example.com/w360', events: ['message.received'] };
    expect(
      apiCreateWebhookEndpointSchema.parse({ ...base, messageTypes: ['order', 'text', 'order'] })
        .messageTypes,
    ).toEqual(['text', 'order']);
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['message.status'],
      messageTypes: ['text'],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['messageTypes', WEBHOOK_MESSAGE_TYPES_NEED_THE_EVENT],
    ]);
    for (const body of [
      { ...base, messageTypes: [] },
      { ...base, messageTypes: ['template'] },
      { ...base, messageTypes: ['button_reply'] },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(apiCreateWebhookEndpointSchema.parse({ ...base, messageTypes: null }).messageTypes).toBe(
      null,
    );
    expect(apiUpdateWebhookEndpointSchema.parse({ messageTypes: null })).toEqual({
      messageTypes: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ messageTypes: ['interactive'] })).toEqual({
      messageTypes: ['interactive'],
    });
    // Answered as a list of types, or null.
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: { items?: { enum?: unknown[] } }[] }>;
      required?: string[];
    };
    const answeredTypes = answered.properties.messageTypes?.anyOf?.find((t) => t.items)?.items
      ?.enum;
    expect(answeredTypes).toHaveLength(14);
    expect(answeredTypes).not.toContain('template');
    expect(answered.required).toContain('messageTypes');
    expect(
      Object.keys((schemas.CreateWebhookEndpoint as { properties: object }).properties),
    ).toContain('messageTypes');
  });

  it('take end reasons only with automation.run_ended and of the ends chosen, each once, and a list of them alone is a change (ADR-192)', () => {
    const base = { url: 'https://hooks.example.com/w360', events: ['automation.run_ended'] };
    expect(
      apiCreateWebhookEndpointSchema.parse({
        ...base,
        runEndReasons: ['send_failed', 'end_node', 'send_failed'],
      }).runEndReasons,
    ).toEqual(['end_node', 'send_failed']);
    const withoutTheEvent = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['automation.run_started'],
      runEndReasons: ['expired'],
    });
    expect(withoutTheEvent.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['runEndReasons', WEBHOOK_RUN_END_REASONS_NEED_THE_EVENT],
    ]);
    // A reason of an end the endpoint does not take would never be sent.
    const ofAnotherEnd = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      runEndStatuses: ['completed', 'stopped'],
      runEndReasons: ['end_node', 'send_failed'],
    });
    expect(ofAnotherEnd.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['runEndReasons', WEBHOOK_RUN_END_REASONS_NEED_THE_ENDS],
    ]);
    expect(
      apiCreateWebhookEndpointSchema.parse({
        ...base,
        runEndStatuses: ['completed', 'failed'],
        runEndReasons: ['send_failed'],
      }).runEndReasons,
    ).toEqual(['send_failed']);
    for (const body of [
      { ...base, runEndReasons: [] },
      { ...base, runEndReasons: ['failed'] },
      { ...base, runEndReasons: ['budget'] },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(
      apiCreateWebhookEndpointSchema.parse({ ...base, runEndReasons: null }).runEndReasons,
    ).toBe(null);
    expect(apiUpdateWebhookEndpointSchema.parse({ runEndReasons: null })).toEqual({
      runEndReasons: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ runEndReasons: ['expired'] })).toEqual({
      runEndReasons: ['expired'],
    });
    // Answered as a list of reasons, or null.
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: { items?: { enum?: unknown[] } }[] }>;
      required?: string[];
    };
    const answeredReasons = answered.properties.runEndReasons?.anyOf?.find((t) => t.items)?.items
      ?.enum;
    expect(answeredReasons).toHaveLength(21);
    expect(answeredReasons).not.toContain('failed');
    expect(answered.required).toContain('runEndReasons');
    expect(
      Object.keys((schemas.CreateWebhookEndpoint as { properties: object }).properties),
    ).toContain('runEndReasons');
  });

  it('take members only with an event of a conversation, each once, and a list of them alone is a change (ADR-181)', () => {
    const a = '0190e9a1-0000-7000-8000-00000000003a';
    const b = '0190e9a1-0000-7000-8000-00000000003b';
    const base = { url: 'https://hooks.example.com/w360', events: ['contact.created'] };
    // Each event of a conversation allows a list, alongside events of none.
    for (const event of WEBHOOK_TEAM_EVENTS) {
      expect(
        apiCreateWebhookEndpointSchema.parse({
          ...base,
          events: ['contact.created', event],
          assigneeIds: [b, a.toUpperCase(), b],
        }).assigneeIds,
        event,
      ).toEqual([b, a]);
    }
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['order.received', 'automation.run_started', 'template.status_changed'],
      assigneeIds: [a],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['assigneeIds', WEBHOOK_ASSIGNEES_NEED_THE_EVENTS],
    ]);
    const message = { ...base, events: ['message.received'] };
    for (const body of [
      { ...message, assigneeIds: [] },
      { ...message, assigneeIds: ['agent@example.com'] },
      {
        ...message,
        assigneeIds: Array.from(
          { length: WEBHOOK_LIMITS.assignees + 1 },
          (_, i) => `0190e9a1-0000-7000-8000-${String(i).padStart(12, '0')}`,
        ),
      },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(
      apiCreateWebhookEndpointSchema.parse({ ...message, assigneeIds: null }).assigneeIds,
    ).toBe(null);
    expect(apiUpdateWebhookEndpointSchema.parse({ assigneeIds: null })).toEqual({
      assigneeIds: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ assigneeIds: [a] })).toEqual({
      assigneeIds: [a],
    });
    // Answered as a list or null, given as GET /members lists members, and in the overview.
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: unknown[] }>;
      required?: string[];
    };
    expect(answered.properties.assigneeIds?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('assigneeIds');
    const created = schemas.CreateWebhookEndpoint as {
      properties: Record<string, { description?: string }>;
    };
    expect(created.properties.assigneeIds?.description).toContain('as GET /members lists them');
    expect(doc.info.description).toContain(
      'or members (its `assigneeIds`): then those of the conversations assigned to them only, by the member a conversation is assigned to when the event happens',
    );
  });

  it('take teams only with an event of a conversation, each once, and a list of them alone is a change (ADR-174)', () => {
    const a = '0190e9a1-0000-7000-8000-00000000001a';
    const b = '0190e9a1-0000-7000-8000-00000000001b';
    const base = { url: 'https://hooks.example.com/w360', events: ['contact.created'] };
    // Each event of a conversation allows a list, alongside events of none.
    for (const event of WEBHOOK_TEAM_EVENTS) {
      expect(
        apiCreateWebhookEndpointSchema.parse({
          ...base,
          events: ['contact.created', event],
          teamIds: [b, a.toUpperCase(), b],
        }).teamIds,
        event,
      ).toEqual([b, a]);
    }
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['order.received', 'automation.run_started', 'campaign.status_changed'],
      teamIds: [a],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['teamIds', WEBHOOK_TEAMS_NEED_THE_EVENTS],
    ]);
    const message = { ...base, events: ['message.received'] };
    for (const body of [
      { ...message, teamIds: [] },
      { ...message, teamIds: ['support'] },
      {
        ...message,
        teamIds: Array.from(
          { length: WEBHOOK_LIMITS.teams + 1 },
          (_, i) => `0190e9a1-0000-7000-8000-${String(i).padStart(12, '0')}`,
        ),
      },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(apiCreateWebhookEndpointSchema.parse({ ...message, teamIds: null }).teamIds).toBe(null);
    expect(apiUpdateWebhookEndpointSchema.parse({ teamIds: null })).toEqual({ teamIds: null });
    expect(apiUpdateWebhookEndpointSchema.parse({ teamIds: [a] })).toEqual({ teamIds: [a] });
    // Answered as a list or null, and described in the overview.
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: unknown[] }>;
      required?: string[];
    };
    expect(answered.properties.teamIds?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('teamIds');
    expect(
      Object.keys((schemas.CreateWebhookEndpoint as { properties: object }).properties),
    ).toContain('teamIds');
    expect(doc.info.description).toContain(
      'It can likewise name teams (its `teamIds`, or the teams chosen in Settings → Webhooks)',
    );
  });

  it('take numbers only with an event that happens on one, each once, and a list of them alone is a change (ADR-170)', () => {
    const a = '0190e9a1-0000-7000-8000-00000000000a';
    const b = '0190e9a1-0000-7000-8000-00000000000b';
    const base = { url: 'https://hooks.example.com/w360', events: ['contact.created'] };
    // Each event that happens on a number allows a list, alongside events that do not.
    for (const event of WEBHOOK_CHANNEL_EVENTS) {
      expect(
        apiCreateWebhookEndpointSchema.parse({
          ...base,
          events: ['contact.created', event],
          channelIds: [b, a.toUpperCase(), b],
        }).channelIds,
        event,
      ).toEqual([b, a]);
    }
    // Consent, contact, template, deal, task and note events happen on no number.
    expect(WEBHOOK_EVENT_KEYS.filter((e) => !WEBHOOK_CHANNEL_EVENTS.some((c) => c === e))).toEqual([
      'consent.changed',
      'template.status_changed',
      'contact.created',
      'contact.updated',
      'contact.erased',
      'contact.merged',
      'deal.created',
      'deal.updated',
      'deal.stage_changed',
      'deal.owner_changed',
      'deal.status_changed',
      'task.created',
      'task.updated',
      'task.assignee_changed',
      'task.status_changed',
      'note.created',
    ]);
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['consent.changed', 'template.status_changed', 'contact.updated'],
      channelIds: [a],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['channelIds', WEBHOOK_CHANNELS_NEED_THE_EVENTS],
    ]);
    const message = { ...base, events: ['message.received'] };
    for (const body of [
      { ...message, channelIds: [] },
      { ...message, channelIds: ['not-a-number'] },
      {
        ...message,
        channelIds: Array.from(
          { length: WEBHOOK_LIMITS.channels + 1 },
          (_, i) => `0190e9a1-0000-7000-8000-${String(i).padStart(12, '0')}`,
        ),
      },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(apiCreateWebhookEndpointSchema.parse({ ...message, channelIds: null }).channelIds).toBe(
      null,
    );
    expect(apiUpdateWebhookEndpointSchema.parse({ channelIds: null })).toEqual({
      channelIds: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ channelIds: [a] })).toEqual({ channelIds: [a] });
  });

  it('take run end statuses only with automation.run_ended, and a list of them alone is a change (ADR-151)', () => {
    const base = { url: 'https://hooks.example.com/w360', events: ['automation.run_ended'] };
    expect(
      apiCreateWebhookEndpointSchema.parse({ ...base, runEndStatuses: ['failed', 'stopped'] })
        .runEndStatuses,
    ).toEqual(['stopped', 'failed']);
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['automation.run_started'],
      runEndStatuses: ['failed'],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['runEndStatuses', WEBHOOK_RUN_END_STATUSES_NEED_THE_EVENT],
    ]);
    for (const body of [
      { ...base, runEndStatuses: [] },
      { ...base, runEndStatuses: ['running'] },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(apiUpdateWebhookEndpointSchema.parse({ runEndStatuses: null })).toEqual({
      runEndStatuses: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ runEndStatuses: ['failed'] })).toEqual({
      runEndStatuses: ['failed'],
    });
  });

  it('take conversation statuses only with conversation.status_changed, and a list of them alone is a change (ADR-149)', () => {
    const base = { url: 'https://hooks.example.com/w360', events: ['conversation.status_changed'] };
    expect(
      apiCreateWebhookEndpointSchema.parse({
        ...base,
        conversationStatuses: ['resolved', 'open'],
      }).conversationStatuses,
    ).toEqual(['open', 'resolved']);
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['conversation.team_changed'],
      conversationStatuses: ['resolved'],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['conversationStatuses', WEBHOOK_CONVERSATION_STATUSES_NEED_THE_EVENT],
    ]);
    for (const body of [
      { ...base, conversationStatuses: [] },
      { ...base, conversationStatuses: ['pending'] },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(apiUpdateWebhookEndpointSchema.parse({ conversationStatuses: null })).toEqual({
      conversationStatuses: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ conversationStatuses: ['resolved'] })).toEqual({
      conversationStatuses: ['resolved'],
    });
  });

  it('take template statuses only with template.status_changed, and a list of them alone is a change (ADR-148)', () => {
    const base = { url: 'https://hooks.example.com/w360', events: ['template.status_changed'] };
    expect(
      apiCreateWebhookEndpointSchema.parse({
        ...base,
        templateStatuses: ['paused', 'rejected', 'paused'],
      }).templateStatuses,
    ).toEqual(['rejected', 'paused']);
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['message.status'],
      templateStatuses: ['rejected'],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['templateStatuses', WEBHOOK_TEMPLATE_STATUSES_NEED_THE_EVENT],
    ]);
    for (const body of [
      { ...base, templateStatuses: [] },
      { ...base, templateStatuses: ['draft'] },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(apiUpdateWebhookEndpointSchema.parse({ templateStatuses: null })).toEqual({
      templateStatuses: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ templateStatuses: ['disabled'] })).toEqual({
      templateStatuses: ['disabled'],
    });
  });

  it('take order statuses only with order.status_changed, and a list of them alone is a change (ADR-147)', () => {
    const base = { url: 'https://hooks.example.com/w360', events: ['order.status_changed'] };
    expect(
      apiCreateWebhookEndpointSchema.parse({
        ...base,
        orderStatuses: ['cancelled', 'paid', 'cancelled'],
      }).orderStatuses,
    ).toEqual(['paid', 'cancelled']);
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['order.received'],
      orderStatuses: ['paid'],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['orderStatuses', WEBHOOK_ORDER_STATUSES_NEED_THE_EVENT],
    ]);
    for (const body of [
      { ...base, orderStatuses: [] },
      { ...base, orderStatuses: ['received'] },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(apiUpdateWebhookEndpointSchema.parse({ orderStatuses: null })).toEqual({
      orderStatuses: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ orderStatuses: ['fulfilled'] })).toEqual({
      orderStatuses: ['fulfilled'],
    });
  });

  it('take Payment Link statuses only with payment_link.status_changed, and a list of them alone is a change (ADR-308)', () => {
    const base = {
      url: 'https://hooks.example.com/w360',
      events: ['payment_link.status_changed'],
    };
    expect(
      apiCreateWebhookEndpointSchema.parse({
        ...base,
        paymentLinkStatuses: ['failed', 'paid', 'failed'],
      }).paymentLinkStatuses,
    ).toEqual(['paid', 'failed']);
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['order.status_changed'],
      paymentLinkStatuses: ['paid'],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['paymentLinkStatuses', WEBHOOK_PAYMENT_LINK_STATUSES_NEED_THE_EVENT],
    ]);
    for (const body of [
      { ...base, paymentLinkStatuses: [] },
      { ...base, paymentLinkStatuses: ['creating'] },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(apiUpdateWebhookEndpointSchema.parse({ paymentLinkStatuses: null })).toEqual({
      paymentLinkStatuses: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ paymentLinkStatuses: ['expired'] })).toEqual({
      paymentLinkStatuses: ['expired'],
    });
    expect(apiUpdateWebhookEndpointSchema.safeParse({}).error?.issues[0]?.message).toContain(
      'the order statuses, the Payment Link statuses, the template statuses',
    );
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: { items?: { enum?: string[] } }[] }>;
    };
    expect(answered.properties.paymentLinkStatuses?.anyOf?.[0]?.items?.enum).toEqual([
      ...WEBHOOK_PAYMENT_LINK_STATUSES,
    ]);
    const given = (schemas.CreateWebhookEndpoint as { properties: Record<string, unknown> })
      .properties;
    expect(JSON.stringify(given.paymentLinkStatuses)).toContain(
      'as payment_link.status_changed (created, partially_paid, paid, expired, cancelled, failed), only with the payment_link.status_changed event',
    );
  });

  it('take deal and task statuses only with their status changes, and a list of them alone is a change (ADR-309)', () => {
    const url = 'https://hooks.example.com/w360';
    expect(
      apiCreateWebhookEndpointSchema.parse({
        url,
        events: ['deal.status_changed', 'task.status_changed'],
        dealStatuses: ['lost', 'won', 'lost'],
        taskStatuses: ['cancelled', 'open'],
      }),
    ).toMatchObject({ dealStatuses: ['won', 'lost'], taskStatuses: ['open', 'cancelled'] });
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      url,
      events: ['deal.created', 'task.created'],
      dealStatuses: ['won'],
      taskStatuses: ['done'],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['dealStatuses', WEBHOOK_DEAL_STATUSES_NEED_THE_EVENT],
      ['taskStatuses', WEBHOOK_TASK_STATUSES_NEED_THE_EVENT],
    ]);
    // Each list needs its own event: a deal's status changes take no task statuses, and back.
    for (const [events, lists, path] of [
      [['deal.status_changed'], { taskStatuses: ['done'] }, 'taskStatuses'],
      [['task.status_changed'], { dealStatuses: ['won'] }, 'dealStatuses'],
    ] as const) {
      const crossed = apiCreateWebhookEndpointSchema.safeParse({ url, events, ...lists });
      expect(crossed.error?.issues.map((i) => i.path.join('.'))).toEqual([path]);
    }
    for (const body of [
      { url, events: ['deal.status_changed'], dealStatuses: [] },
      { url, events: ['deal.status_changed'], dealStatuses: ['done'] },
      { url, events: ['task.status_changed'], taskStatuses: [] },
      { url, events: ['task.status_changed'], taskStatuses: ['won'] },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    for (const change of [
      { dealStatuses: null },
      { dealStatuses: ['open'] },
      { taskStatuses: null },
      { taskStatuses: ['done'] },
    ]) {
      expect(apiUpdateWebhookEndpointSchema.parse(change)).toEqual(change);
    }
    expect(apiUpdateWebhookEndpointSchema.safeParse({}).error?.issues[0]?.message).toContain(
      'the conversation statuses, the deal statuses, the task statuses, the run end statuses',
    );
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: { items?: { enum?: string[] } }[] }>;
    };
    expect(answered.properties.dealStatuses?.anyOf?.[0]?.items?.enum).toEqual([
      ...WEBHOOK_DEAL_STATUSES,
    ]);
    expect(answered.properties.taskStatuses?.anyOf?.[0]?.items?.enum).toEqual([
      ...WEBHOOK_TASK_STATUSES,
    ]);
    const given = (schemas.CreateWebhookEndpoint as { properties: Record<string, unknown> })
      .properties;
    expect(JSON.stringify(given.dealStatuses)).toContain(
      'as deal.status_changed (open, won, lost; open is a deal reopened), only with the deal.status_changed event',
    );
    expect(JSON.stringify(given.taskStatuses)).toContain(
      'as task.status_changed (open, done, cancelled; open is a task reopened), only with the task.status_changed event',
    );
  });

  it('take deal and task details only with their detail changes, and a list of them alone is a change (ADR-310)', () => {
    const url = 'https://hooks.example.com/w360';
    expect(
      apiCreateWebhookEndpointSchema.parse({
        url,
        events: ['deal.updated', 'task.updated'],
        dealDetails: ['expectedCloseOn', 'valueMinor', 'expectedCloseOn'],
        taskDetails: ['remindAt', 'dueAt'],
      }),
    ).toMatchObject({
      dealDetails: ['valueMinor', 'expectedCloseOn'],
      taskDetails: ['dueAt', 'remindAt'],
    });
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      url,
      events: ['deal.created', 'task.created'],
      dealDetails: ['title'],
      taskDetails: ['notes'],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['dealDetails', WEBHOOK_DEAL_DETAILS_NEED_THE_EVENT],
      ['taskDetails', WEBHOOK_TASK_DETAILS_NEED_THE_EVENT],
    ]);
    // Each list needs its own event: a deal's detail changes take no task details, and back.
    for (const [events, lists, path] of [
      [['deal.updated'], { taskDetails: ['notes'] }, 'taskDetails'],
      [['task.updated'], { dealDetails: ['title'] }, 'dealDetails'],
    ] as const) {
      const crossed = apiCreateWebhookEndpointSchema.safeParse({ url, events, ...lists });
      expect(crossed.error?.issues.map((i) => i.path.join('.'))).toEqual([path]);
    }
    for (const body of [
      { url, events: ['deal.updated'], dealDetails: [] },
      { url, events: ['deal.updated'], dealDetails: ['notes'] },
      { url, events: ['task.updated'], taskDetails: [] },
      { url, events: ['task.updated'], taskDetails: ['valueMinor'] },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    for (const change of [
      { dealDetails: null },
      { dealDetails: ['valueMinor'] },
      { taskDetails: null },
      { taskDetails: ['dueAt'] },
    ]) {
      expect(apiUpdateWebhookEndpointSchema.parse(change)).toEqual(change);
    }
    expect(apiUpdateWebhookEndpointSchema.safeParse({}).error?.issues[0]?.message).toContain(
      'the contact parts, the deal and task details, the custom fields',
    );
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: { items?: { enum?: string[] } }[] }>;
    };
    expect(answered.properties.dealDetails?.anyOf?.[0]?.items?.enum).toEqual([
      ...WEBHOOK_DEAL_DETAILS,
    ]);
    expect(answered.properties.taskDetails?.anyOf?.[0]?.items?.enum).toEqual([
      ...WEBHOOK_TASK_DETAILS,
    ]);
    const given = (schemas.CreateWebhookEndpoint as { properties: Record<string, unknown> })
      .properties;
    expect(JSON.stringify(given.dealDetails)).toContain(
      "as deal.updated (title, valueMinor, expectedCloseOn, as the event's changes names them): a change is sent when it changed one of them, naming every detail it changed; only with the deal.updated event",
    );
    expect(JSON.stringify(given.taskDetails)).toContain(
      "as task.updated (title, notes, dueAt, remindAt, as the event's changes names them): a change is sent when it changed one of them, naming every detail it changed; only with the task.updated event",
    );
  });

  it('take the members credited with survey answers and the teams of their conversations only with satisfaction_survey.answered, each once, and a list of them alone is a change (ADR-311)', () => {
    const a = '0190e9a1-0000-7000-8000-00000000031a';
    const b = '0190e9a1-0000-7000-8000-00000000031b';
    const url = 'https://hooks.example.com/w360';
    const answers = { url, events: ['satisfaction_survey.answered'] };
    expect(
      apiCreateWebhookEndpointSchema.parse({
        ...answers,
        surveyAssigneeIds: [b, a.toUpperCase(), b],
        surveyTeamIds: [a, a],
      }),
    ).toMatchObject({ surveyAssigneeIds: [b, a], surveyTeamIds: [a] });
    // Conversations' events take the conversations' lists, not the answers'.
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      url,
      events: [...WEBHOOK_TEAM_EVENTS],
      surveyAssigneeIds: [a],
      surveyTeamIds: [b],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['surveyAssigneeIds', WEBHOOK_SURVEY_ASSIGNEES_NEED_THE_EVENT],
      ['surveyTeamIds', WEBHOOK_SURVEY_TEAMS_NEED_THE_EVENT],
    ]);
    const many = Array.from(
      { length: WEBHOOK_LIMITS.surveyAssignees + 1 },
      (_, i) => `0190e9a1-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    for (const body of [
      { ...answers, surveyAssigneeIds: [] },
      { ...answers, surveyAssigneeIds: ['agent@example.com'] },
      { ...answers, surveyAssigneeIds: many },
      { ...answers, surveyTeamIds: [] },
      { ...answers, surveyTeamIds: ['support'] },
      { ...answers, surveyTeamIds: many.slice(0, WEBHOOK_LIMITS.surveyTeams + 1) },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(
      apiCreateWebhookEndpointSchema.parse({ ...answers, surveyTeamIds: many.slice(0, 50) })
        .surveyTeamIds,
    ).toHaveLength(50);
    for (const change of [
      { surveyAssigneeIds: null },
      { surveyAssigneeIds: [a] },
      { surveyTeamIds: null },
      { surveyTeamIds: [b] },
    ]) {
      expect(apiUpdateWebhookEndpointSchema.parse(change)).toEqual(change);
    }
    expect(apiUpdateWebhookEndpointSchema.safeParse({}).error?.issues[0]?.message).toContain(
      'the survey scores, the members credited with survey answers and the teams of their conversations,',
    );
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const given = (schemas.CreateWebhookEndpoint as { properties: Record<string, unknown> })
      .properties;
    expect(JSON.stringify(given.surveyAssigneeIds)).toContain(
      '1 to 50 member ids (as GET /members lists them: active members who take conversations), only with satisfaction_survey.answered. An answer is credited to the member its conversation was assigned to when it was resolved',
    );
    expect(JSON.stringify(given.surveyTeamIds)).toContain(
      "1 to 50 ids of the company's teams, only with satisfaction_survey.answered. An answer belongs to the team its conversation is in when the customer answers",
    );
    const surveyEvent = (doc.webhooks as Record<string, { post?: { description?: string } }>)[
      'satisfaction_survey.answered'
    ]?.post?.description;
    expect(surveyEvent).toContain(
      'an answer credited to no member, or of a conversation in no team, matches no such list, and with more than one list an answer must pass them all',
    );
  });

  it('take the contact and conversation tags of survey answers only with satisfaction_survey.answered, as contacts and conversations carry them, and a list of them alone is a change (ADR-312)', () => {
    const url = 'https://hooks.example.com/w360';
    const answers = { url, events: ['satisfaction_survey.answered'] };
    expect(
      apiCreateWebhookEndpointSchema.parse({
        ...answers,
        surveyContactTags: ['VIP', 'Gold   Member', 'vip'],
        surveyConversationTags: [' Refund '],
      }),
    ).toMatchObject({
      surveyContactTags: ['vip', 'gold member'],
      surveyConversationTags: ['refund'],
    });
    // Conversations' events take the conversations' tag lists, not the answers'.
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      url,
      events: [...WEBHOOK_TEAM_EVENTS],
      surveyContactTags: ['vip'],
      surveyConversationTags: ['refund'],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['surveyContactTags', WEBHOOK_SURVEY_CONTACT_TAGS_NEED_THE_EVENT],
      ['surveyConversationTags', WEBHOOK_SURVEY_CONVERSATION_TAGS_NEED_THE_EVENT],
    ]);
    const many = Array.from({ length: WEBHOOK_LIMITS.surveyContactTags + 1 }, (_, i) => `tag ${i}`);
    for (const body of [
      { ...answers, surveyContactTags: [] },
      { ...answers, surveyContactTags: ['a,b'] },
      { ...answers, surveyContactTags: many },
      { ...answers, surveyConversationTags: [] },
      { ...answers, surveyConversationTags: [42] },
      { ...answers, surveyConversationTags: many },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    for (const change of [
      { surveyContactTags: null },
      { surveyContactTags: ['vip'] },
      { surveyConversationTags: null },
      { surveyConversationTags: ['refund'] },
    ]) {
      expect(apiUpdateWebhookEndpointSchema.parse(change)).toEqual(change);
    }
    expect(apiUpdateWebhookEndpointSchema.safeParse({}).error?.issues[0]?.message).toContain(
      'the teams of their conversations, the contact and conversation tags of survey answers,',
    );
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const given = (schemas.CreateWebhookEndpoint as { properties: Record<string, unknown> })
      .properties;
    expect(JSON.stringify(given.surveyContactTags)).toContain(
      '1 to 50 tags as contacts carry them (as GET /contacts gives them: compared as tags are written, in lower case with single spaces, each up to 40 characters without commas), only with satisfaction_survey.answered. An answer counts when the answering contact has any of the tags when they answer',
    );
    expect(JSON.stringify(given.surveyConversationTags)).toContain(
      'only with satisfaction_survey.answered. An answer counts when its conversation has any of the tags when the customer answers',
    );
    const surveyEvent = (doc.webhooks as Record<string, { post?: { description?: string } }>)[
      'satisfaction_survey.answered'
    ]?.post?.description;
    expect(surveyEvent).toContain(
      'an answer is sent when the answering contact, or its conversation, has any of the tags when the customer answers.',
    );
  });

  it('take the tags of added and changed contacts only with contact.created or contact.updated, as contacts carry them, and a list of them alone is a change (ADR-316)', () => {
    const url = 'https://hooks.example.com/w360';
    for (const events of [
      ['contact.created'],
      ['contact.updated'],
      ['contact.created', 'contact.updated'],
    ]) {
      expect(
        apiCreateWebhookEndpointSchema.parse({
          url,
          events,
          contactEventTags: ['VIP', 'Gold   Member', 'vip'],
        }),
        events.join(),
      ).toMatchObject({ contactEventTags: ['vip', 'gold member'] });
    }
    // Erased and merged contacts, and conversations' events, take no such list.
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      url,
      events: ['contact.erased', 'contact.merged', 'message.received'],
      contactEventTags: ['vip'],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['contactEventTags', WEBHOOK_CONTACT_EVENT_TAGS_NEED_THE_EVENTS],
    ]);
    const contacts = { url, events: ['contact.updated'] };
    const many = Array.from({ length: WEBHOOK_LIMITS.contactEventTags + 1 }, (_, i) => `tag ${i}`);
    for (const body of [
      { ...contacts, contactEventTags: [] },
      { ...contacts, contactEventTags: ['a,b'] },
      { ...contacts, contactEventTags: [42] },
      { ...contacts, contactEventTags: many },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    for (const change of [{ contactEventTags: null }, { contactEventTags: ['vip'] }]) {
      expect(apiUpdateWebhookEndpointSchema.parse(change)).toEqual(change);
    }
    expect(apiUpdateWebhookEndpointSchema.safeParse({}).error?.issues[0]?.message).toContain(
      'the contact and conversation tags of survey answers, the tags of added and changed contacts, the members,',
    );
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const given = (schemas.CreateWebhookEndpoint as { properties: Record<string, unknown> })
      .properties;
    expect(JSON.stringify(given.contactEventTags)).toContain(
      '1 to 50 tags as contacts carry them (as GET /contacts gives them: compared as tags are written, in lower case with single spaces, each up to 40 characters without commas), only with contact.created or contact.updated. A change is sent when the contact has any of the tags when it is saved, or when it adds or removes one of them.',
    );
    const updated = (doc.webhooks as Record<string, { post?: { description?: string } }>)[
      'contact.updated'
    ]?.post?.description;
    expect(updated).toContain(
      'receives the changes of contacts that have one of them when they are saved, and the changes that add or remove one.',
    );
  });

  it('take campaign statuses only with campaign.status_changed, and a list of them alone is a change (ADR-146)', () => {
    const base = { url: 'https://hooks.example.com/w360', events: ['campaign.status_changed'] };
    expect(
      apiCreateWebhookEndpointSchema.parse({
        ...base,
        campaignStatuses: ['completed', 'paused', 'completed'],
      }).campaignStatuses,
    ).toEqual(['paused', 'completed']);
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['message.status'],
      campaignStatuses: ['paused'],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['campaignStatuses', WEBHOOK_CAMPAIGN_STATUSES_NEED_THE_EVENT],
    ]);
    for (const body of [
      { ...base, campaignStatuses: [] },
      { ...base, campaignStatuses: ['sending'] },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(apiUpdateWebhookEndpointSchema.parse({ campaignStatuses: null })).toEqual({
      campaignStatuses: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ campaignStatuses: ['canceled'] })).toEqual({
      campaignStatuses: ['canceled'],
    });
  });

  it('take automations only with an automation run event, and a list of them alone is a change (ADR-145)', () => {
    const greeter = '0E1A2B3C-4D5E-4F60-8172-8394A5B6C7D8';
    const farewell = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';
    for (const events of [
      ['automation.run_started'],
      ['automation.run_ended', 'consent.changed'],
    ]) {
      expect(
        apiCreateWebhookEndpointSchema.parse({
          url: 'https://hooks.example.com/w360',
          events,
          automationIds: [greeter, farewell, greeter.toLowerCase()],
        }).automationIds,
        JSON.stringify(events),
      ).toEqual([greeter.toLowerCase(), farewell]);
    }
    const base = { url: 'https://hooks.example.com/w360', events: ['automation.run_ended'] };
    expect(apiCreateWebhookEndpointSchema.parse({ ...base, automationIds: null })).toEqual({
      ...base,
      automationIds: null,
    });
    const tooMany = Array.from(
      { length: 21 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(
      apiCreateWebhookEndpointSchema.safeParse({ ...base, automationIds: tooMany.slice(1) })
        .success,
    ).toBe(true);
    for (const body of [
      { ...base, events: ['consent.changed'], automationIds: [greeter] },
      { ...base, automationIds: [] },
      { ...base, automationIds: ['greeter'] },
      { ...base, automationIds: tooMany },
      { ...base, automationIds: greeter },
    ]) {
      const parsed = apiCreateWebhookEndpointSchema.safeParse(body);
      expect(parsed.success, JSON.stringify(body)).toBe(false);
    }
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['consent.changed'],
      automationIds: [greeter],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['automationIds', WEBHOOK_AUTOMATIONS_NEED_THE_EVENTS],
    ]);
    expect(apiUpdateWebhookEndpointSchema.parse({ automationIds: null })).toEqual({
      automationIds: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ automationIds: [farewell] })).toEqual({
      automationIds: [farewell],
    });
  });

  it('take API keys only with an automation run event, each once, and a list of them alone is a change (ADR-319)', () => {
    const store = '0E1A2B3C-4D5E-4F60-8172-8394A5B6C7D8';
    const crm = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';
    for (const events of [
      ['automation.run_started'],
      ['automation.run_ended', 'consent.changed'],
    ]) {
      expect(
        apiCreateWebhookEndpointSchema.parse({
          url: 'https://hooks.example.com/w360',
          events,
          runApiKeyIds: [store, crm, store.toLowerCase()],
        }).runApiKeyIds,
        JSON.stringify(events),
      ).toEqual([store.toLowerCase(), crm]);
    }
    const base = { url: 'https://hooks.example.com/w360', events: ['automation.run_ended'] };
    expect(apiCreateWebhookEndpointSchema.parse({ ...base, runApiKeyIds: null })).toEqual({
      ...base,
      runApiKeyIds: null,
    });
    const tooMany = Array.from(
      { length: 21 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(
      apiCreateWebhookEndpointSchema.safeParse({ ...base, runApiKeyIds: tooMany.slice(1) }).success,
    ).toBe(true);
    for (const body of [
      { ...base, runApiKeyIds: [] },
      { ...base, runApiKeyIds: ['w360_aaaaaaaaaaaa'] },
      { ...base, runApiKeyIds: tooMany },
      { ...base, runApiKeyIds: store },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['message.received', 'order.received'],
      runApiKeyIds: [store],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['runApiKeyIds', WEBHOOK_RUN_API_KEYS_NEED_THE_EVENTS],
    ]);
    expect(apiUpdateWebhookEndpointSchema.parse({ runApiKeyIds: null })).toEqual({
      runApiKeyIds: null,
    });
    expect(apiUpdateWebhookEndpointSchema.parse({ runApiKeyIds: [crm] })).toEqual({
      runApiKeyIds: [crm],
    });
    expect(apiUpdateWebhookEndpointSchema.safeParse({}).error?.issues[0]?.message).toContain(
      'what started the runs, the API keys that started them, the consent changes,',
    );
    // Answered as a list of key ids, or null, and set out with the run events.
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: unknown[] }>;
      required?: string[];
    };
    expect(answered.properties.runApiKeyIds?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('runApiKeyIds');
    expect(
      Object.keys((schemas.CreateWebhookEndpoint as { properties: object }).properties),
    ).toContain('runApiKeyIds');
    const webhooks = doc.webhooks as Record<string, { post?: { description?: string } }>;
    expect(webhooks['automation.run_started']?.post?.description).toContain(
      'and every run unless it names the API keys whose runs it takes (its `runApiKeyIds`',
    );
  });

  it('take API keys for messages only with message.status, each once, and a list of them alone is a change (ADR-320)', () => {
    const store = '0E1A2B3C-4D5E-4F60-8172-8394A5B6C7D8';
    const crm = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';
    const base = { url: 'https://hooks.example.com/w360', events: ['message.status'] };
    expect(
      apiCreateWebhookEndpointSchema.parse({
        ...base,
        messageApiKeyIds: [store, crm, store.toLowerCase()],
      }).messageApiKeyIds,
    ).toEqual([store.toLowerCase(), crm]);
    expect(
      apiCreateWebhookEndpointSchema.parse({ ...base, messageApiKeyIds: null }).messageApiKeyIds,
    ).toBeNull();
    for (const body of [
      { ...base, messageApiKeyIds: [] },
      { ...base, messageApiKeyIds: ['w360_aaaaaaaaaaaa'] },
      { ...base, messageApiKeyIds: store },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    // Received messages are not narrowed by key, so they cannot keep a list.
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['message.received'],
      messageApiKeyIds: [store],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['messageApiKeyIds', WEBHOOK_MESSAGE_API_KEYS_NEED_THE_EVENT],
    ]);
    for (const change of [{ messageApiKeyIds: null }, { messageApiKeyIds: [crm] }]) {
      expect(apiUpdateWebhookEndpointSchema.parse(change)).toEqual(change);
    }
    expect(apiUpdateWebhookEndpointSchema.safeParse({}).error?.issues[0]?.message).toContain(
      'who sent the messages, the API keys that sent them, the contact parts,',
    );
    // Answered as a list of key ids, or null, and set out with the event.
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: unknown[] }>;
      required?: string[];
    };
    expect(answered.properties.messageApiKeyIds?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('messageApiKeyIds');
    expect(
      Object.keys((schemas.CreateWebhookEndpoint as { properties: object }).properties),
    ).toContain('messageApiKeyIds');
    const webhooks = doc.webhooks as Record<string, { post?: { description?: string } }>;
    expect(webhooks['message.status']?.post?.description).toContain(
      'or the API keys that sent them (its `messageApiKeyIds`',
    );
  });

  it('leave out API keys only with a deal, task or note event, each once, and a list of them alone is a change (ADR-321)', () => {
    const store = '0E1A2B3C-4D5E-4F60-8172-8394A5B6C7D8';
    const crm = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';
    const base = { url: 'https://hooks.example.com/w360', events: ['deal.updated'] };
    for (const events of [
      ['deal.created'],
      ['task.status_changed', 'consent.changed'],
      ['note.created'],
    ]) {
      expect(
        apiCreateWebhookEndpointSchema.parse({
          ...base,
          events,
          crmExcludedApiKeyIds: [store, crm, store.toLowerCase()],
        }).crmExcludedApiKeyIds,
        JSON.stringify(events),
      ).toEqual([store.toLowerCase(), crm]);
    }
    expect(
      apiCreateWebhookEndpointSchema.parse({ ...base, crmExcludedApiKeyIds: null })
        .crmExcludedApiKeyIds,
    ).toBeNull();
    for (const body of [
      { ...base, crmExcludedApiKeyIds: [] },
      { ...base, crmExcludedApiKeyIds: ['w360_aaaaaaaaaaaa'] },
      { ...base, crmExcludedApiKeyIds: store },
    ]) {
      expect(apiCreateWebhookEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    const refused = apiCreateWebhookEndpointSchema.safeParse({
      ...base,
      events: ['message.status', 'contact.updated'],
      crmExcludedApiKeyIds: [store],
    });
    expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['crmExcludedApiKeyIds', WEBHOOK_CRM_EXCLUDED_API_KEYS_NEED_THE_EVENTS],
    ]);
    for (const change of [{ crmExcludedApiKeyIds: null }, { crmExcludedApiKeyIds: [crm] }]) {
      expect(apiUpdateWebhookEndpointSchema.parse(change)).toEqual(change);
    }
    expect(apiUpdateWebhookEndpointSchema.safeParse({}).error?.issues[0]?.message).toContain(
      'who made the CRM changes, the API keys whose CRM changes are left out, the survey scores,',
    );
    // Answered as a list of key ids, or null, and set out with the webhooks.
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const answered = schemas.WebhookEndpoint as {
      properties: Record<string, { anyOf?: unknown[] }>;
      required?: string[];
    };
    expect(answered.properties.crmExcludedApiKeyIds?.anyOf).toHaveLength(2);
    expect(answered.required).toContain('crmExcludedApiKeyIds');
    expect(
      Object.keys((schemas.CreateWebhookEndpoint as { properties: object }).properties),
    ).toContain('crmExcludedApiKeyIds');
    expect(JSON.stringify(doc)).toContain(
      'or it can leave out only the changes chosen keys made (its `crmExcludedApiKeyIds`',
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
      { since: '2026-09-30T08:00:00Z', events: [] },
      { since: '2026-09-30T08:00:00Z', events: ['order.shipped'] },
      { since: '2026-09-30T08:00:00Z', events: 'message.received' },
      { since: '2026-09-30T08:00:00Z', failures: [] },
      { since: '2026-09-30T08:00:00Z', failures: ['server_errors'] },
      { since: '2026-09-30T08:00:00Z', failures: 'no_answer' },
    ]) {
      expect(apiReplayFailedDeliveriesSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
  });

  it('takes the events to replay, kept once each in the list’s order (ADR-156)', () => {
    expect(
      apiReplayFailedDeliveriesSchema.parse({
        since: '2026-09-30T08:00:00Z',
        events: ['contact.created', 'message.received', 'contact.created'],
      }),
    ).toEqual({ since: '2026-09-30T08:00:00Z', events: ['message.received', 'contact.created'] });
  });

  it('takes how the failures to replay went, kept once each in the list’s order (ADR-159)', () => {
    expect(
      apiReplayFailedDeliveriesSchema.parse({
        since: '2026-09-30T08:00:00Z',
        failures: ['not_attempted', 'no_answer', 'server_error', 'no_answer'],
      }),
    ).toEqual({
      since: '2026-09-30T08:00:00Z',
      failures: ['server_error', 'no_answer', 'not_attempted'],
    });
    expect(
      apiReplayFailedDeliveriesSchema.parse({
        since: '2026-09-30T08:00:00Z',
        failures: [...WEBHOOK_FAILURE_KINDS].reverse(),
      }).failures,
    ).toEqual(['server_error', 'client_error', 'other_answer', 'no_answer', 'not_attempted']);
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
    const replayFields = (
      schemas.ReplayFailedDeliveries as {
        properties: Record<string, { items?: { enum?: string[] }; description?: string }>;
      }
    ).properties;
    expect(Object.keys(replayFields)).toEqual(['since', 'events', 'failures']);
    expect(replayFields.failures?.items?.enum).toEqual([...WEBHOOK_FAILURE_KINDS]);
    for (const kind of WEBHOOK_FAILURE_KINDS) {
      expect(replayFields.failures?.description).toContain(`\`${kind}\``);
    }
    expect(op?.description).toContain('only those of the `events` given');
    expect(op?.description).toContain(
      'only those whose latest failed delivery failed in one of the `failures` given',
    );
    expect(Object.keys((schemas.FailedReplay as { properties: object }).properties)).toEqual([
      'queued',
      'more',
    ]);
  });

  it('refuses a time still to come for every endpoint too, before anything is read (ADR-160)', async () => {
    const endpoints = createApiWebhookEndpoints({
      clock: { now: () => new Date('2026-09-30T08:00:00Z') },
    } as never);
    const ctx = {
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set(['webhooks.manage']) },
      planScopes: null,
    } as unknown as ApiContext;
    const error: unknown = await endpoints
      .replayAllFailed(ctx, { since: '2026-09-30T08:00:01Z' }, { key: 'k-1', requestHash: 'h' })
      .catch((caught: unknown) => caught);
    expect(isAppError(error) && error.code).toBe('validation_failed');
    expect(isAppError(error) && error.issues).toEqual([
      { path: 'since', message: 'Give a time in the past.' },
    ]);
  });

  it('describes the replay of every endpoint: the same body, 500 across the endpoints that are on, what each queued (ADR-160)', () => {
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
            responses: Record<string, { content?: unknown }>;
          }
        >
      >
    )['/webhook-endpoints/replay-failed']?.post;
    expect(op?.operationId).toBe('replayAllFailedWebhookDeliveries');
    expect(op?.parameters).toEqual([{ $ref: '#/components/parameters/IdempotencyKey' }]);
    expect(op?.requestBody).toEqual({
      required: true,
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/ReplayFailedDeliveries' } },
      },
    });
    expect(Object.keys(op?.responses ?? {})).toEqual(expect.arrayContaining(['200', '412', '422']));
    expect(Object.keys(op?.responses ?? {})).not.toContain('404');
    expect(op?.responses['200']?.content).toEqual({
      'application/json': {
        schema: {
          type: 'object',
          properties: { data: { $ref: '#/components/schemas/FailedReplayAcrossEndpoints' } },
          required: ['data'],
        },
      },
    });
    for (const words of [
      'every endpoint the API key added that is on',
      'at most 500 new deliveries per call across them',
      'in the order they were added',
      'Endpoints that are off are left out; when none is on, the call is refused (412)',
      'once per endpoint',
    ]) {
      expect(op?.description).toContain(words);
    }
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const across = schemas.FailedReplayAcrossEndpoints as {
      properties: Record<string, { maxItems?: number; items?: { properties: object } }>;
    };
    expect(Object.keys(across.properties)).toEqual(['queued', 'more', 'endpoints']);
    expect(across.properties.endpoints?.maxItems).toBe(WEBHOOK_LIMITS.endpoints);
    expect(Object.keys(across.properties.endpoints?.items?.properties ?? {})).toEqual([
      'id',
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
      () => endpoints.replayAllFailed(ctx, { since: 'x' }, idempotency),
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
  const KEPT_CONTACT = '0192f3a4-5b6c-7d8e-9f00-1122334455aa';

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
    // A merged contact names the contact it belongs to now (ADR-225); nothing else of the details.
    const merged = (details: Record<string, unknown>) =>
      apiErrorResponse(new AppError('not_found', 'Merged.', { details }), 'r').body.error;
    expect(
      merged({ apiReason: 'contact_merged', mergedInto: KEPT_CONTACT, tenantId: 'x' }),
    ).toEqual({
      code: 'not_found',
      message: 'Merged.',
      reason: 'contact_merged',
      mergedInto: KEPT_CONTACT,
    });
    expect(merged({ mergedInto: 42 })).toEqual({ code: 'not_found', message: 'Merged.' });
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

  it('says which messages were too large to keep and how many contacts a card left out (ADR-132)', () => {
    type Shape = { required?: string[]; properties?: Record<string, Shape>; type?: string };
    const schemas = doc.components.schemas as Record<string, Shape>;
    const received = schemas.WebhookMessageReceived?.properties?.data?.properties?.message;
    for (const message of [schemas.ConversationMessage, schemas.FeedMessage, received]) {
      expect(message?.required).toEqual(
        expect.arrayContaining(['contentTooLarge', 'contactsLeftOut']),
      );
      expect(message?.properties?.contentTooLarge).toMatchObject({ type: 'boolean' });
      expect(message?.properties?.contactsLeftOut).toMatchObject({ type: 'integer', minimum: 0 });
    }
  });

  it('gives a contact card’s contacts on every message and in message.received (ADR-196)', () => {
    type Shape = {
      required?: string[];
      properties?: Record<string, Shape>;
      type?: string;
      items?: Shape;
      anyOf?: Shape[];
      description?: string;
    };
    const schemas = doc.components.schemas as Record<string, Shape>;
    const received = schemas.WebhookMessageReceived?.properties?.data?.properties?.message;
    for (const message of [schemas.ConversationMessage, schemas.FeedMessage, received]) {
      expect(message?.required).toEqual(expect.arrayContaining(['contacts']));
      const contacts = message?.properties?.contacts;
      expect(contacts?.description).toContain('For a contact card: the contacts it shares');
      expect(contacts?.anyOf?.map((branch) => branch.type).sort()).toEqual(['array', 'null']);
      const card = contacts?.anyOf?.find((branch) => branch.type === 'array')?.items;
      const parts = ['addresses', 'birthday', 'emails', 'name', 'org', 'phones', 'urls'];
      expect(Object.keys(card?.properties ?? {}).sort()).toEqual(parts);
      expect([...(card?.required ?? [])].sort()).toEqual(parts);
      expect(Object.keys(card?.properties?.name?.properties ?? {}).sort()).toEqual([
        'firstName',
        'formattedName',
        'lastName',
        'middleName',
        'prefix',
        'suffix',
      ]);
      expect(Object.keys(card?.properties?.phones?.items?.properties ?? {}).sort()).toEqual([
        'phone',
        'type',
        'waId',
      ]);
      expect(message?.properties?.contactsLeftOut?.description).toContain(
        'The contacts kept are in `contacts`.',
      );
    }
    // A received message's words name a location too.
    expect(received?.properties?.text?.description).toContain(
      'a location’s name (its address if it has no name)',
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
        { $ref: '#/components/schemas/SendImage' },
        { $ref: '#/components/schemas/SendVideo' },
        { $ref: '#/components/schemas/SendAudio' },
        { $ref: '#/components/schemas/SendDocument' },
        { $ref: '#/components/schemas/SendSticker' },
        { $ref: '#/components/schemas/SendLocation' },
        { $ref: '#/components/schemas/SendContacts' },
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
      'addTags',
      'removeTags',
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
      'phone',
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
      'addTags',
      'removeTags',
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

  it('change at least one of name, email, number, fields and tags, and nothing else', () => {
    expect(apiContactUpdateSchema.parse({ name: '  Priya  ', email: null })).toEqual({
      name: 'Priya',
      email: null,
    });
    expect(apiContactUpdateSchema.parse({ addTags: ['vip'], removeTags: ['new'] })).toEqual({
      addTags: ['vip'],
      removeTags: ['new'],
    });
    // A number alone is a change (ADR-180), in a call changing many contacts too (ADR-188).
    expect(apiContactUpdateSchema.parse({ phone: '+919876543210' })).toEqual({
      phone: '+919876543210',
    });
    expect(apiContactUpdateSchema.safeParse({}).error?.issues[0]?.message).toBe(
      'Give name, email, phone, fields, addTags or removeTags.',
    );
    expect(
      apiUpdateManyContactsSchema.safeParse({
        contacts: [{ id: '0190a000-0000-7000-8000-000000000001', phone: '+919876543210' }],
      }).success,
    ).toBe(true);
    for (const bad of [
      {},
      { phone: null },
      { phone: 919876543210 },
      { phone: '+9'.padEnd(41, '1') },
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
    // A number that is not one is refused by its place before any read (ADR-180).
    await expect(
      apiUpdateContact({} as never, ctx(['contacts.write']), id, { phone: '98111' }),
    ).rejects.toMatchObject({ code: 'validation_failed', issues: [{ path: 'phone' }] });
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
      // A number alone, or with other changes (ADR-188).
      { contacts: [{ id, phone: '+919876543210' }] },
      { contacts: [{ id, name: 'A', phone: '+919876543210' }] },
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
      { contacts: [{ id, phone: null }] },
      { contacts: [{ id, phone: 919876543210 }] },
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
      { path: 'contacts.1', message: 'Give name, email, phone, fields, addTags or removeTags.' },
    ]);
  });

  it('take numbers in a call that changes many contacts, each given once, refused by its place before anything is read (ADR-188)', async () => {
    const other = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
    const third = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03';
    const many = (body: unknown) =>
      apiUpdateManyContacts({} as never, ctx(['contacts.write']), body).catch(
        (error: unknown) => error,
      );
    const refusal = async (body: unknown) => {
      const error = await many(body);
      return isAppError(error) ? { code: error.code, issues: error.issues } : error;
    };
    // A number that is not one, by its place.
    expect(
      await refusal({
        contacts: [
          { id, name: 'Priya' },
          { id: other, phone: '98111' },
        ],
      }),
    ).toMatchObject({ code: 'validation_failed', issues: [{ path: 'contacts.1.phone' }] });
    // The same number twice, written two ways: the second is named.
    expect(
      await refusal({
        contacts: [
          { id, phone: '+919876543210' },
          { id: other, name: 'Bina' },
          { id: third, phone: '+91 98765 43210' },
        ],
      }),
    ).toEqual({
      code: 'validation_failed',
      issues: [{ path: 'contacts.2.phone', message: 'Give each number once.' }],
    });
    // Different numbers pass every check that needs no database, and reach it (none is given).
    expect(
      await many({
        contacts: [
          { id, phone: '+919876543210' },
          { id: other, phone: '+919876543211' },
        ],
      }),
    ).toBeInstanceOf(TypeError);
    // Described: what a number needs, that the call never swaps or moves them, and the refusals.
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const paths = doc.paths as unknown as Record<
      string,
      Record<string, { summary: string; description: string; responses: Record<string, unknown> }>
    >;
    const updateMany = paths['/contacts/update-many']?.post;
    expect(updateMany?.summary).toContain('numbers');
    for (const words of [
      'A number changes as PATCH /contacts/{id} changes one',
      'Each number must be free before the call',
      'a call never swaps or moves numbers between contacts',
      'A number given twice, in any form, is refused with 422',
      '`contacts.2.phone`',
    ]) {
      expect(updateMany?.description).toContain(words);
    }
    expect(Object.keys(updateMany?.responses ?? {})).toEqual(
      expect.arrayContaining(['409', '412', '422']),
    );
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
    for (const words of [
      'A number changes only when it was typed for the contact, as members change it',
      'is refused with 412, as is a number on the company',
      'a number another contact has is refused with 409, without naming that contact',
      'POST /contacts/update-many changes numbers too; the same change for many contacts does not.',
    ]) {
      expect(paths['/contacts/{id}']?.patch?.description).toContain(words);
    }
    const patchResponses = (
      paths['/contacts/{id}']?.patch as unknown as { responses: Record<string, unknown> }
    ).responses;
    expect(Object.keys(patchResponses)).toEqual(expect.arrayContaining(['409', '412', '422']));
    // A merged contact's id answers 404 naming the contact it belongs to now (ADR-225).
    for (const op of [
      paths['/contacts/{id}']?.get,
      paths['/contacts/{id}']?.patch,
      paths['/contacts/{id}/consent']?.post,
    ]) {
      expect(op?.description).toContain(
        'A contact merged into another is not found: 404 with reason `contact_merged`, and `mergedInto` naming the contact it belongs to now.',
      );
    }
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
      'phone',
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
    // A name holds at most 200 characters, so a longer text finds nothing (ADR-124).
    expect(parse({ name: 'x'.repeat(200) })).toBe(true);
    expect(parse({ name: 'x'.repeat(201) })).toBe(false);
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
      name: null,
    });
    expect(apiContactListFilters({})).toEqual({ email: null, tag: null, name: null });
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
    expect(await code({ name: '  ' })).toBe('validation_failed');
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
      'name',
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

describe('finding contacts by name, and text with the NUL character (ADR-124)', () => {
  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      if (isAppError(error))
        return { code: error.code, status: error.httpStatus, issues: error.issues };
      throw error;
    }
    throw new Error('expected a refusal');
  };

  it('read part of a name as written, without the spaces at its ends, and refuse an empty one', () => {
    expect(apiContactListFilters({ name: '  Asha Rao ' }).name).toBe('Asha Rao');
    // Wildcards stay characters here; the query escapes them.
    expect(apiContactListFilters({ name: '100%_x' }).name).toBe('100%_x');
    for (const name of ['', ' ', '\t\n']) {
      expect(refusal(() => apiContactListFilters({ name }))).toEqual({
        code: 'validation_failed',
        status: 422,
        issues: [{ path: 'name', message: 'Give part of a name to find.' }],
      });
    }
  });

  it('are described: the name filter, its window and the rule on the NUL character', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const get = (
      doc.paths as unknown as Record<
        string,
        Record<string, { description: string; parameters: Record<string, unknown>[] }>
      >
    )['/contacts']?.get;
    const name = get?.parameters.find((p) => p.name === 'name');
    expect(name).toMatchObject({
      in: 'query',
      schema: { type: 'string', minLength: 1, maxLength: 200 },
    });
    expect(String(name?.description)).toContain('letters whatever their case');
    expect(String(name?.description)).toContain('`%` and `_` are characters, not patterns');
    expect(get?.description).toContain(
      'A page filtered by `name`, `tag` or `fields` reads at most',
    );
    expect(doc.info.description).toContain(
      'Text cannot hold the NUL character (U+0000): a request with it anywhere in its query string or body is refused with 422, naming where it is.',
    );
  });

  it('find the NUL character wherever a request holds it, and name where, in order', () => {
    expect(nulCharacterPath({}, undefined)).toBeNull();
    expect(nulCharacterPath({ limit: '10', name: 'Asha' }, { name: 'Asha' })).toBeNull();
    // A parameter by its name as sent, the name itself holding it written out.
    expect(nulCharacterPath({ limit: '10', name: 'a\u0000' }, undefined)).toBe('name');
    expect(nulCharacterPath({ 'fields[city]': '\u0000' }, undefined)).toBe('fields[city]');
    expect(nulCharacterPath({ 'a\u0000b': 'x' }, undefined)).toBe('a\\u0000b');
    // The body by the path validation issues use; the query is read first.
    expect(nulCharacterPath({}, { phone: '+919800000000', name: 'A\u0000' })).toBe('name');
    expect(
      nulCharacterPath({}, { contacts: [{ name: 'ok' }, { fields: { city: 'x\u0000' } }] }),
    ).toBe('contacts.1.fields.city');
    expect(nulCharacterPath({}, { fields: { 'ci\u0000ty': 'Pune' } })).toBe('fields.ci\\u0000ty');
    expect(nulCharacterPath({}, 'a\u0000')).toBe('');
    expect(nulCharacterPath({}, { a: ['x', 'y\u0000'], b: 'z\u0000' })).toBe('a.1');
    expect(nulCharacterPath({ q: '\u0000' }, { name: '\u0000' })).toBe('q');
    // Other control characters, the escape written out as text and other values are kept.
    expect(
      nulCharacterPath(
        { q: 'a\u0001\u001f' },
        { text: 'a\u0001\u007f b', note: '\\u0000', n: 0, ok: false, gone: null },
      ),
    ).toBeNull();
    // No nesting a body can have exhausts the stack.
    let deep: unknown = 'x\u0000';
    for (let i = 0; i < 50_000; i += 1) deep = [deep];
    expect(nulCharacterPath({}, deep)?.split('.')).toHaveLength(50_000);
  });

  it('refuse a request holding it with 422, naming where, as the API answers', () => {
    expect(() => assertNoNulCharacter({ name: 'Asha' }, { name: 'ok' })).not.toThrow();
    let thrown: unknown;
    try {
      assertNoNulCharacter({}, { contacts: [{}, { name: 'B\u0000' }] });
    } catch (error) {
      thrown = error;
    }
    const answer = apiErrorResponse(thrown, 'req');
    expect([answer.status, answer.internal, answer.body.error]).toEqual([
      422,
      false,
      {
        code: 'validation_failed',
        message: NUL_CHARACTER_MESSAGE,
        issues: [{ path: 'contacts.1.name', message: NUL_CHARACTER_MESSAGE }],
      },
    ]);
  });
});

describe('reading campaigns (ADR-125)', () => {
  const ctx = (scopes: string[]) =>
    ({
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: null,
    }) as unknown as ApiContext;
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'done',
      (error: unknown) => (isAppError(error) ? error.code : String(error)),
    );

  it('have their own reading scope, which members who see campaigns grant', () => {
    expect(API_SCOPE_KEYS).toContain('campaigns.read');
    expect(API_SCOPE_INFO['campaigns.read']).toMatchObject({
      label: 'Read campaigns',
      permission: 'campaigns.read',
      writes: false,
    });
    expect(API_SCOPE_INFO['campaigns.read'].description).toContain(
      "A key that also reads contacts lists each campaign's recipients and what happened to each. Never members or costs.",
    );
  });

  it('take a page and one status, and nothing else', () => {
    const parse = (query: Record<string, unknown>) =>
      apiCampaignListQuerySchema.safeParse(query).success;
    for (const status of CAMPAIGN_STATUSES) expect(parse({ status })).toBe(true);
    expect(parse({ limit: '100', cursor: 'x' })).toBe(true);
    expect(parse({ status: 'finished' })).toBe(false);
    expect(parse({ limit: '0' })).toBe(false);
    expect(parse({ limit: '101' })).toBe(false);
    expect(parse({ name: 'Festive' })).toBe(false);
    expect(apiCampaignListQuerySchema.parse({}).limit).toBe(50);
  });

  it('are refused before anything is read without the scope, and a bad id is not found', async () => {
    expect(await code(apiListCampaigns({} as never, ctx(['contacts.read']), {}))).toBe('forbidden');
    expect(await code(apiGetCampaign({} as never, ctx(['contacts.read']), 'x'))).toBe('forbidden');
    expect(
      await code(apiListCampaigns({} as never, ctx(['campaigns.read']), { status: 'x' })),
    ).toBe('validation_failed');
    expect(await code(apiGetCampaign({} as never, ctx(['campaigns.read']), 'not-an-id'))).toBe(
      'not_found',
    );
  });

  it('are described: the list with its status filter, the campaign with its results, counts only', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    type Operation = {
      description: string;
      parameters: Record<string, unknown>[];
      responses: Record<string, { content?: Record<string, { schema: unknown }> }>;
    };
    const paths = doc.paths as unknown as Record<string, Record<string, Operation>>;
    const list = paths['/campaigns']?.get;
    expect(list?.parameters.map((p) => p.name ?? p.$ref)).toEqual(['limit', 'cursor', 'status']);
    expect(list?.parameters.find((p) => p.name === 'status')).toMatchObject({
      in: 'query',
      schema: { enum: [...CAMPAIGN_STATUSES] },
    });
    expect(JSON.stringify(list?.responses['200'])).toContain('#/components/schemas/Campaign"');
    const one = paths['/campaigns/{id}']?.get;
    expect(JSON.stringify(one?.responses['200'])).toContain('CampaignWithResults');
    expect(Object.keys(one?.responses ?? {})).toContain('404');
    expect(one?.description).toContain(
      'Counts only (GET /campaigns/{id}/recipients lists the recipients): never members or costs.',
    );
    const schemas = doc.components.schemas as unknown as Record<
      string,
      { properties: Record<string, { description?: string }>; required: string[] }
    >;
    expect(schemas.CampaignWithResults?.required).toContain('results');
    expect(schemas.Campaign?.properties).not.toHaveProperty('results');
    // Null for a draft: the schema allows null, whatever its description says.
    expect(schemas.CampaignWithResults?.properties.results).toMatchObject({
      anyOf: expect.arrayContaining([{ type: 'null' }]),
    });
    // Counts only: no recipients, members or costs. The draft's settings and version are answered
    // to keys that edit drafts only, and are null for the others (ADR-186).
    expect(Object.keys(schemas.CampaignWithResults?.properties ?? {}).sort()).toEqual(
      [...Object.keys(schemas.Campaign?.properties ?? {}), 'results', 'settings', 'version'].sort(),
    );
    for (const hidden of ['recipients', 'variables', 'budgetMicros', 'launchedBy', 'segmentId']) {
      expect(Object.keys(schemas.CampaignWithResults?.properties ?? {})).not.toContain(hidden);
    }
    for (const held of ['settings', 'version'] as const) {
      expect(schemas.CampaignWithResults?.properties[held]).toMatchObject({
        anyOf: expect.arrayContaining([{ type: 'null' }]),
      });
      expect(schemas.CampaignWithResults?.properties[held]?.description).toContain(
        'Null unless the key holds campaigns.write.',
      );
    }
    expect(doc.info.description).toContain('read campaigns, their results and their recipients');
    expect(API_ROUTES).toEqual(
      expect.arrayContaining([
        ['get', '/campaigns'],
        ['get', '/campaigns/{id}'],
      ]),
    );
  });
});

describe('listing a campaign’s recipients (ADR-127)', () => {
  const ctx = (scopes: string[]) =>
    ({
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: null,
    }) as unknown as ApiContext;
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'done',
      (error: unknown) => (isAppError(error) ? error.code : String(error)),
    );
  const id = '0190a000-0000-7000-8000-000000000001';

  it('leave other scopes’ labels out of the scope’s description, so each checkbox has its own name', () => {
    for (const scope of API_SCOPE_KEYS) {
      for (const other of API_SCOPE_KEYS.filter((k) => k !== scope)) {
        expect([scope, API_SCOPE_INFO[scope].description]).not.toEqual([
          scope,
          expect.stringContaining(API_SCOPE_INFO[other].label),
        ]);
      }
    }
  });

  it('name each outcome after the count of the results it lists', () => {
    const camel = (outcome: string) =>
      outcome === 'message_canceled'
        ? 'messagesCanceled'
        : outcome.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    const counts = Object.keys(apiCampaignResultsSchema.shape);
    for (const outcome of RECIPIENT_OUTCOMES) expect(counts).toContain(camel(outcome));
    // Every count of recipients has its outcome, less the audience (every recipient: no outcome).
    expect(
      counts.filter((k) => !['audience', 'skipReasons', 'failureCodes'].includes(k)).sort(),
    ).toEqual(RECIPIENT_OUTCOMES.map(camel).sort());
  });

  it('take a page and one outcome, and nothing else', () => {
    const parse = (query: Record<string, unknown>) =>
      apiCampaignRecipientQuerySchema.safeParse(query);
    for (const outcome of RECIPIENT_OUTCOMES) expect(parse({ outcome }).success).toBe(true);
    expect(parse({ limit: '100', cursor: id }).success).toBe(true);
    expect(parse({ outcome: 'all' }).success).toBe(false);
    expect(parse({ outcome: 'clicked' }).success).toBe(false);
    expect(parse({ limit: '0' }).success).toBe(false);
    expect(parse({ limit: '101' }).success).toBe(false);
    expect(parse({ state: 'queued' }).success).toBe(false);
    expect(parse({ cursor: 'eyJhdCI6IjIwMjYifQ' }).error?.issues[0]).toMatchObject({
      path: ['cursor'],
      message: 'Invalid cursor: give the nextCursor of the previous page.',
    });
    expect(apiCampaignRecipientQuerySchema.parse({}).limit).toBe(50);
  });

  it('need both scopes, checked before anything is read, and a bad id is not found', async () => {
    const list = (scopes: string[], campaignId: string, query: unknown = {}) =>
      code(apiListCampaignRecipients({} as never, ctx(scopes), campaignId, query));
    expect(await list(['contacts.read'], id)).toBe('forbidden');
    expect(await list(['campaigns.read'], id)).toBe('forbidden');
    await expect(
      apiListCampaignRecipients({} as never, ctx(['campaigns.read']), id, {}),
    ).rejects.toThrow('This API key does not have the contacts.read scope.');
    await expect(
      apiListCampaignRecipients({} as never, ctx(['contacts.read']), id, {}),
    ).rejects.toThrow('This API key does not have the campaigns.read scope.');
    const both = ['campaigns.read', 'contacts.read'];
    expect(await list(both, 'not-an-id')).toBe('not_found');
    expect(await list(both, id, { outcome: 'clicked' })).toBe('validation_failed');
    expect(await list(both, id, { cursor: 'x' })).toBe('validation_failed');
    // A plan without either scope refuses it, naming the plan.
    const planless = { ...ctx(both), planScopes: new Set(['campaigns.read']) } as ApiContext;
    await expect(apiListCampaignRecipients({} as never, planless, id, {})).rejects.toMatchObject({
      code: 'forbidden',
      details: { apiReason: 'not_in_plan' },
    });
  });

  it('are described: both scopes, the outcomes, the recipient without costs', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    type Operation = {
      operationId: string;
      description: string;
      parameters: Record<string, unknown>[];
      responses: Record<string, unknown>;
    };
    const paths = doc.paths as unknown as Record<string, Record<string, Operation>>;
    const op = paths['/campaigns/{id}/recipients']?.get;
    expect(op?.operationId).toBe('listCampaignRecipients');
    expect(op?.description).toContain('Scope: `campaigns.read`. Also needs `contacts.read`');
    expect(op?.description).toContain('the API never lists erased contacts');
    expect(op?.parameters.map((p) => p.name ?? p.$ref)).toEqual([
      '#/components/parameters/Id',
      'limit',
      'cursor',
      'outcome',
    ]);
    expect(op?.parameters.find((p) => p.name === 'outcome')).toMatchObject({
      in: 'query',
      schema: { enum: [...RECIPIENT_OUTCOMES] },
    });
    expect(JSON.stringify(op?.responses['200'])).toContain(
      '#/components/schemas/CampaignRecipient"',
    );
    expect(Object.keys(op?.responses ?? {})).toEqual(expect.arrayContaining(['403', '404', '422']));
    const schemas = doc.components.schemas as unknown as Record<
      string,
      {
        properties: Record<
          string,
          { properties?: Record<string, unknown>; enum?: string[]; anyOf?: unknown[] }
        >;
      }
    >;
    const recipient = schemas.CampaignRecipient?.properties ?? {};
    expect(Object.keys(recipient).sort()).toEqual(
      [
        'id',
        'contact',
        'state',
        'skipReason',
        'message',
        'queuedAt',
        'repliedAt',
        'optedOutAt',
      ].sort(),
    );
    expect(Object.keys(recipient.contact?.properties ?? {}).sort()).toEqual([
      'id',
      'name',
      'phone',
    ]);
    expect(recipient.state?.enum).toEqual([...RECIPIENT_STATES]);
    expect(JSON.stringify(recipient.message)).toContain(JSON.stringify([...MESSAGE_STATUSES]));
    expect(recipient.message?.anyOf).toEqual(expect.arrayContaining([{ type: 'null' }]));
    for (const hidden of ['market', 'estimatedCostMicros', 'cost', 'email', 'tags']) {
      expect(JSON.stringify(schemas.CampaignRecipient)).not.toContain(`"${hidden}"`);
    }
    expect(API_ROUTES).toEqual(expect.arrayContaining([['get', '/campaigns/{id}/recipients']]));
  });
});

describe('pausing and cancelling campaigns (ADR-128)', () => {
  const ctx = (scopes: string[], status = 'active', planScopes: string[] | null = null) =>
    ({
      tenant: { id: 't', status },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: planScopes ? new Set(planScopes) : null,
    }) as unknown as ApiContext;
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'done',
      (error: unknown) => (isAppError(error) ? error.code : String(error)),
    );
  const id = '0190a000-0000-7000-8000-000000000001';

  it('have their own writing scope, which members who pause and cancel campaigns grant', () => {
    expect(API_SCOPE_INFO['campaigns.stop']).toMatchObject({
      label: 'Pause and cancel campaigns',
      permission: 'campaigns.send',
      writes: true,
    });
    expect(API_SCOPE_INFO['campaigns.stop'].description).toContain(
      "Approving, scheduling and editing stay in the app, under a member's authority, and so does resuming, except a campaign a key paused.",
    );
    // Reading them stays its own scope: stopping does not read results or recipients.
    expect(API_SCOPE_INFO['campaigns.read'].writes).toBe(false);
  });

  it('are refused before anything is read: without the scope, outside the plan, while the company is not active, and a bad id is not found', async () => {
    for (const stop of [apiPauseCampaign, apiCancelCampaign]) {
      expect(await code(stop({} as never, ctx(['campaigns.read']), id))).toBe('forbidden');
      await expect(stop({} as never, ctx(['campaigns.read']), id)).rejects.toThrow(
        'This API key does not have the campaigns.stop scope.',
      );
      await expect(
        stop({} as never, ctx(['campaigns.stop'], 'active', ['campaigns.read']), id),
      ).rejects.toMatchObject({ code: 'forbidden', details: { apiReason: 'not_in_plan' } });
      for (const status of ['suspended', 'restricted']) {
        expect(await code(stop({} as never, ctx(['campaigns.stop'], status), id))).toBe(
          'tenant_suspended',
        );
      }
      expect(await code(stop({} as never, ctx(['campaigns.stop']), 'not-an-id'))).toBe('not_found');
    }
  });

  it('are described: the scope, what each changes and refuses, and the campaign as the answer', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    type Operation = {
      operationId: string;
      description: string;
      parameters: Record<string, unknown>[];
      requestBody?: unknown;
      responses: Record<string, unknown>;
    };
    const paths = doc.paths as unknown as Record<string, Record<string, Operation>>;
    const pause = paths['/campaigns/{id}/pause']?.post;
    const cancel = paths['/campaigns/{id}/cancel']?.post;
    expect(pause?.operationId).toBe('pauseCampaign');
    expect(cancel?.operationId).toBe('cancelCampaign');
    for (const op of [pause, cancel]) {
      expect(op?.description).toContain('Scope: `campaigns.stop`.');
      expect(op?.description).toContain('so a retry is harmless');
      expect(op?.description).toContain('No `Idempotency-Key` is needed.');
      expect(op?.description).toContain('`campaign.status_changed` webhooks report the change.');
      expect(op?.parameters.map((p) => p.$ref)).toEqual(['#/components/parameters/Id']);
      // No body: the call names the campaign and nothing else.
      expect(op?.requestBody).toBeUndefined();
      expect(JSON.stringify(op?.responses['200'])).toContain('#/components/schemas/Campaign"');
      expect(Object.keys(op?.responses ?? {})).toEqual(
        expect.arrayContaining(['403', '404', '409', '423']),
      );
    }
    expect(pause?.description).toContain('its `pauseReason` is `api`');
    expect(pause?.description).toContain(
      'Members resume the campaign in the app, and so can a key with `campaigns.resume`',
    );
    expect(pause?.description).toContain(
      'A draft, a campaign waiting for approval, a completed and a cancelled one are refused with 409',
    );
    expect(cancel?.description).toContain('A draft is refused with 409');
    expect(cancel?.description).toContain('A cancelled campaign is never resumed.');
    const responses = paths['/campaigns/{id}/pause']?.post?.responses as Record<
      string,
      { description: string }
    >;
    expect(responses['409']?.description).toContain(
      'Pausing, resuming or cancelling a campaign: its status does not allow it, or, resuming, a member or HyFib paused it; the message names the status or the pause reason.',
    );
    expect(doc.info.description).toContain('pause and cancel campaigns');
    const schemas = doc.components.schemas as unknown as Record<
      string,
      { properties: Record<string, { description?: string }> }
    >;
    expect(schemas.Campaign?.properties.pauseReason?.description).toContain(
      'a member paused it (manual), an API key did (api)',
    );
    // campaign.status_changed says so too.
    expect(JSON.stringify(schemas.WebhookCampaignStatusChanged)).toContain(
      'a member paused it (manual), an API key did (api)',
    );
    expect(API_ROUTES).toEqual(
      expect.arrayContaining([
        ['post', '/campaigns/{id}/pause'],
        ['post', '/campaigns/{id}/cancel'],
      ]),
    );
  });
});

describe('resuming campaigns keys paused (ADR-176)', () => {
  const ctx = (scopes: string[], status = 'active', planScopes: string[] | null = null) =>
    ({
      tenant: { id: 't', status },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: planScopes ? new Set(planScopes) : null,
    }) as unknown as ApiContext;
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'done',
      (error: unknown) => (isAppError(error) ? error.code : String(error)),
    );
  const id = '0190a000-0000-7000-8000-000000000002';

  it("have their own writing scope, which members who resume campaigns grant, keeping the launcher's authority", () => {
    expect(API_SCOPE_KEYS.indexOf('campaigns.resume')).toBe(
      API_SCOPE_KEYS.indexOf('campaigns.stop') + 1,
    );
    expect(API_SCOPE_INFO['campaigns.resume']).toMatchObject({
      label: 'Resume campaigns keys paused',
      permission: 'campaigns.send',
      writes: true,
    });
    for (const words of [
      'Resume a campaign a key paused',
      'the template still approved, the number active, neither cap reached',
      'under the authority of the member who launched it, who must still be allowed to send campaigns',
      'A campaign a member or HyFib paused stays for members to resume in the app.',
    ]) {
      expect(API_SCOPE_INFO['campaigns.resume'].description).toContain(words);
    }
  });

  it('are refused before anything is read: without the scope (stopping is not enough), outside the plan, while the company is not active, and a bad id is not found', async () => {
    for (const scopes of [['campaigns.read'], ['campaigns.stop']]) {
      expect(await code(apiResumeCampaign({} as never, ctx(scopes), id))).toBe('forbidden');
    }
    await expect(apiResumeCampaign({} as never, ctx(['campaigns.stop']), id)).rejects.toThrow(
      'This API key does not have the campaigns.resume scope.',
    );
    await expect(
      apiResumeCampaign({} as never, ctx(['campaigns.resume'], 'active', ['campaigns.stop']), id),
    ).rejects.toMatchObject({ code: 'forbidden', details: { apiReason: 'not_in_plan' } });
    for (const status of ['suspended', 'restricted']) {
      expect(
        await code(apiResumeCampaign({} as never, ctx(['campaigns.resume'], status), id)),
      ).toBe('tenant_suspended');
    }
    expect(await code(apiResumeCampaign({} as never, ctx(['campaigns.resume']), 'not-an-id'))).toBe(
      'not_found',
    );
  });

  it('are described: the scope, the checks, the pauses it lifts and refuses, and the campaign as the answer', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    type Operation = {
      operationId: string;
      description: string;
      parameters: Record<string, unknown>[];
      requestBody?: unknown;
      responses: Record<string, unknown>;
    };
    const paths = doc.paths as unknown as Record<string, Record<string, Operation>>;
    const resume = paths['/campaigns/{id}/resume']?.post;
    expect(resume?.operationId).toBe('resumeCampaign');
    for (const words of [
      'Scope: `campaigns.resume`.',
      'Resumes a campaign whose `pauseReason` is `api`',
      'the template is still approved by Meta and the number active (412 otherwise)',
      'neither the message cap nor the spending cap is reached (412',
      'under the authority of the member who launched it, who must still be allowed to send campaigns (412 otherwise',
      'A scheduled or running campaign is answered as it is, so a retry is harmless.',
      'A campaign a member or HyFib paused (any other `pauseReason`) is refused with 409, naming it',
      'A draft, a campaign waiting for approval, a completed and a cancelled one are refused with 409',
      'No `Idempotency-Key` is needed.',
      '`campaign.status_changed` webhooks report the change.',
    ]) {
      expect(resume?.description).toContain(words);
    }
    expect(resume?.parameters.map((p) => p.$ref)).toEqual(['#/components/parameters/Id']);
    expect(resume?.requestBody).toBeUndefined();
    expect(JSON.stringify(resume?.responses['200'])).toContain('#/components/schemas/Campaign"');
    expect(Object.keys(resume?.responses ?? {})).toEqual(
      expect.arrayContaining(['403', '404', '409', '412', '423']),
    );
    expect(doc.info.description).toContain(
      'pause and cancel campaigns and resume the ones you paused',
    );
    expect(API_ROUTES).toEqual(expect.arrayContaining([['post', '/campaigns/{id}/resume']]));
  });
});

describe('campaign drafts through the API (ADR-186)', () => {
  const ctx = (scopes: string[], status = 'active', planScopes: string[] | null = null) =>
    ({
      tenant: { id: 't', status },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: planScopes ? new Set(planScopes) : null,
    }) as unknown as ApiContext;
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'done',
      (error: unknown) => (isAppError(error) ? error.code : String(error)),
    );
  const id = '0190a000-0000-7000-8000-000000000003';
  const segment = '0190a000-0000-7000-8000-000000000004';
  const number = '0190a000-0000-7000-8000-000000000005';
  const base: CampaignDraftInput = {
    name: 'Diwali offer',
    channelAccountId: number,
    templateId: null,
    variables: { header: [], body: [{ source: 'name', fallback: 'there' }], buttons: [] },
    audience: { kind: 'segment', segmentId: segment },
    schedule: { kind: 'later', local: '2026-11-01T09:00', timezone: 'Asia/Kolkata' },
    window: { start: '09:00', end: '20:00' },
    ratePerMinute: 100,
    maxMessages: 5000,
    budget: { amount: '2500.5', currency: 'INR' },
    stopAfterHours: 48,
  };

  it('have their own writing scope, which members who edit drafts grant, and never start a campaign', () => {
    expect(API_SCOPE_KEYS.indexOf('campaigns.write')).toBe(
      API_SCOPE_KEYS.indexOf('campaigns.read') + 1,
    );
    expect(API_SCOPE_INFO['campaigns.write']).toMatchObject({
      label: 'Create, edit and submit campaign drafts',
      permission: 'campaigns.write',
      writes: true,
    });
    for (const words of [
      'Create campaign drafts and edit them as members do',
      'the audience (a segment or conditions)',
      "submit drafts, which then always wait for a member's approval",
      "A key never starts a campaign: a member approves a key's submission, or submits a draft, in the app, and the campaign sends under the authority of a member allowed to send campaigns.",
    ]) {
      expect(API_SCOPE_INFO['campaigns.write'].description).toContain(words);
    }
  });

  it('are refused before anything is read: without the scope, outside the plan, while the company is not active, and a bad id is not found', async () => {
    const body = { name: 'Diwali offer' };
    for (const scopes of [['campaigns.read'], ['campaigns.stop', 'campaigns.resume']]) {
      expect(await code(apiCreateCampaign({} as never, ctx(scopes), body, null))).toBe('forbidden');
      expect(await code(apiUpdateCampaign({} as never, ctx(scopes), id, body))).toBe('forbidden');
    }
    await expect(
      apiCreateCampaign({} as never, ctx(['campaigns.read']), body, null),
    ).rejects.toThrow('This API key does not have the campaigns.write scope.');
    await expect(
      apiUpdateCampaign(
        {} as never,
        ctx(['campaigns.write'], 'active', ['campaigns.read']),
        id,
        body,
      ),
    ).rejects.toMatchObject({ code: 'forbidden', details: { apiReason: 'not_in_plan' } });
    for (const status of ['suspended', 'restricted']) {
      expect(
        await code(apiCreateCampaign({} as never, ctx(['campaigns.write'], status), body, null)),
      ).toBe('tenant_suspended');
    }
    expect(
      await code(apiUpdateCampaign({} as never, ctx(['campaigns.write']), 'not-an-id', body)),
    ).toBe('not_found');
  });

  it("take a name and any of a draft's settings, refusing unknown or malformed ones", () => {
    expect(apiCreateCampaignSchema.parse({ name: '  Diwali offer ' })).toEqual({
      name: 'Diwali offer',
    });
    const full = {
      name: 'Diwali offer',
      channelId: number,
      templateId: null,
      variables: { body: [{ source: 'static', value: 'Asha' }] },
      audience: { conditions: [{ type: 'tag', op: 'has', tag: 'vip' }] },
      schedule: { kind: 'later', local: '2026-11-01T09:00' },
      window: { start: '09:00', end: '20:00' },
      ratePerMinute: 100,
      maxMessages: 5000,
      budget: { amount: '2500', currency: 'INR' },
      stopAfterHours: 48,
    };
    expect(apiCreateCampaignSchema.parse(full)).toEqual({
      ...full,
      variables: { header: [], body: [{ source: 'static', value: 'Asha' }], buttons: [] },
      audience: { match: 'all', conditions: [{ type: 'tag', op: 'has', tag: 'vip' }] },
    });
    expect(apiCreateCampaignSchema.parse({ name: 'A', audience: { segmentId: segment } })).toEqual({
      name: 'A',
      audience: { segmentId: segment },
    });
    for (const body of [
      {},
      { name: ' ' },
      { name: 'x'.repeat(121) },
      { name: 'A', launch: true },
      { name: 'A', status: 'scheduled' },
      { name: 'A', channelId: 'main' },
      { name: 'A', audience: { segmentId: segment, conditions: [] } },
      { name: 'A', audience: { conditions: [] } },
      {
        name: 'A',
        audience: {
          conditions: [
            { type: 'group', match: 'any', conditions: [{ type: 'tag', op: 'has', tag: 'a' }] },
          ],
        },
      },
      { name: 'A', schedule: { kind: 'later' } },
      { name: 'A', schedule: { kind: 'soon' } },
      { name: 'A', variables: { body: [{ source: 'static', value: '' }] } },
      { name: 'A', ratePerMinute: 0 },
      { name: 'A', maxMessages: 1_000_001 },
      { name: 'A', budget: { amount: '2500', currency: 'inr' } },
      { name: 'A', stopAfterHours: 169 },
      { name: 'A', window: { start: '09:00' } },
    ]) {
      expect(apiCreateCampaignSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
    expect(apiUpdateCampaignSchema.parse({ maxMessages: null })).toEqual({ maxMessages: null });
    expect(apiUpdateCampaignSchema.parse({ expectedVersion: 3, name: 'B' })).toEqual({
      expectedVersion: 3,
      name: 'B',
    });
    for (const body of [{}, { expectedVersion: 3 }, { expectedVersion: -1, name: 'B' }]) {
      expect(apiUpdateCampaignSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
    expect(
      apiUpdateCampaignSchema.safeParse({ expectedVersion: 3 }).error?.issues[0]?.message,
    ).toBe('Give at least one setting to change');
  });

  it('keep every setting left out, clear those given as null and keep the time zone without one', () => {
    expect(apiDraftInputFrom(base, {})).toEqual(base);
    expect(apiDraftInputFrom(base, { name: 'Renamed', maxMessages: null })).toEqual({
      ...base,
      name: 'Renamed',
      maxMessages: null,
    });
    expect(
      apiDraftInputFrom(base, {
        channelId: null,
        audience: null,
        window: null,
        ratePerMinute: null,
        budget: null,
      }),
    ).toEqual({
      ...base,
      channelAccountId: null,
      audience: { kind: 'none' },
      window: null,
      ratePerMinute: null,
      budget: null,
    });
    const conditions = {
      match: 'any' as const,
      conditions: [{ type: 'tag' as const, op: 'has' as const, tag: 'vip' }],
    };
    expect(apiDraftInputFrom(base, { audience: conditions }).audience).toEqual({
      kind: 'conditions',
      definition: conditions,
    });
    expect(apiDraftInputFrom(base, { schedule: { kind: 'now' } }).schedule).toEqual({
      kind: 'now',
      timezone: 'Asia/Kolkata',
    });
    expect(
      apiDraftInputFrom(base, {
        schedule: { kind: 'later', local: '2026-12-01T10:30', timezone: 'Europe/London' },
      }).schedule,
    ).toEqual({ kind: 'later', local: '2026-12-01T10:30', timezone: 'Europe/London' });
  });

  it('read a stored draft back as members type it, and pass members’ checks again unchanged', () => {
    expect([2_500_000_000, 2_500_500_000, 1, 0].map(microsToAmount)).toEqual([
      '2500',
      '2500.5',
      '0.000001',
      '0',
    ]);
    const stored = {
      name: 'Diwali offer',
      channelAccountId: number,
      templateId: null,
      variables: { header: [], body: [{ source: 'name', fallback: 'there' }] },
      segmentId: null,
      audienceDefinition: { match: 'all', conditions: [{ type: 'tag', op: 'has', tag: 'vip' }] },
      scheduleKind: 'later',
      scheduledLocal: '2026-11-01 09:00:00',
      timezone: 'Asia/Kolkata',
      windowStart: '09:00:00',
      windowEnd: '20:00:00',
      ratePerMinute: 100,
      maxMessages: 5000,
      budgetMicros: 2_500_500_000,
      budgetCurrency: 'INR',
      stopAfterHours: 48,
    } as unknown as Parameters<typeof campaignDraftInputOf>[0];
    const input = campaignDraftInputOf(stored);
    expect(input).toEqual({
      ...base,
      audience: { kind: 'conditions', definition: stored.audienceDefinition },
    });
    const prepared = prepareCampaignDraft(input);
    expect(prepared).toMatchObject({
      scheduledLocal: '2026-11-01 09:00:00',
      budget: { budgetMicros: 2_500_500_000, budgetCurrency: 'INR' },
    });
    expect(
      campaignDraftInputOf({
        ...stored,
        segmentId: segment,
        audienceDefinition: null,
        scheduleKind: 'now',
        scheduledLocal: null,
        windowStart: null,
        windowEnd: null,
        budgetMicros: null,
        budgetCurrency: null,
      }),
    ).toMatchObject({
      audience: { kind: 'segment', segmentId: segment },
      schedule: { kind: 'now', timezone: 'Asia/Kolkata' },
      window: null,
      budget: null,
    });
  });

  it('are described: the scope, the checks, drafts only, the version and the draft as the answer', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    type Operation = {
      operationId: string;
      description: string;
      parameters: Record<string, unknown>[];
      requestBody?: unknown;
      responses: Record<string, unknown>;
    };
    const paths = doc.paths as unknown as Record<string, Record<string, Operation>>;
    const create = paths['/campaigns']?.post;
    expect(create?.operationId).toBe('createCampaign');
    expect(create?.parameters).toEqual([
      { $ref: '#/components/parameters/IdempotencyKeyOptional' },
    ]);
    expect(JSON.stringify(create?.requestBody)).toContain('#/components/schemas/CreateCampaign"');
    expect(JSON.stringify(create?.responses['201'])).toContain('CampaignWithResults');
    for (const words of [
      'Scope: `campaigns.write`.',
      "checked as members' drafts are",
      "A draft sends nothing: a member submits it in the app, or a key submits it for a member's approval (POST /campaigns/{id}/submit)",
      'One draft per `Idempotency-Key`',
    ]) {
      expect(create?.description).toContain(words);
    }
    const update = paths['/campaigns/{id}']?.patch;
    expect(update?.operationId).toBe('updateCampaign');
    expect(Object.keys(update?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '404', '409', '422', '423']),
    );
    for (const words of [
      'Scope: `campaigns.write`.',
      'Changes the settings given and keeps the others',
      'Only a draft is edited: any other status is refused with 409, naming it.',
      'With `expectedVersion`, a draft changed since you read it',
    ]) {
      expect(update?.description).toContain(words);
    }
    const schemas = doc.components.schemas as unknown as Record<
      string,
      { properties: Record<string, unknown>; required?: string[] }
    >;
    expect(schemas.CreateCampaign?.required).toEqual(['name']);
    expect(Object.keys(schemas.UpdateCampaign?.properties ?? {})).toContain('expectedVersion');
    expect(Object.keys(schemas.CreateCampaign?.properties ?? {})).not.toContain('expectedVersion');
    expect(paths['/campaigns/{id}']?.get?.description).toContain(
      'A key that also holds `campaigns.write` gets its settings',
    );
    expect(API_ROUTES).toEqual(
      expect.arrayContaining([
        ['post', '/campaigns'],
        ['patch', '/campaigns/{id}'],
      ]),
    );
  });
});

describe('cancelling campaign drafts through the API (ADR-187)', () => {
  const ctx = (scopes: string[], status = 'active', planScopes: string[] | null = null) =>
    ({
      tenant: { id: 't', status },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: planScopes ? new Set(planScopes) : null,
    }) as unknown as ApiContext;
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'done',
      (error: unknown) => (isAppError(error) ? error.code : String(error)),
    );
  const cancel = (scopes: string[], status = 'active', planScopes: string[] | null = null) =>
    apiCancelCampaign({} as never, ctx(scopes, status, planScopes), 'not-an-id');

  it('take a key that writes drafts as well as one that stops campaigns, checked before anything is read', async () => {
    // Either scope passes the checks made before the campaign is read (a bad id is then not found).
    for (const scopes of [
      ['campaigns.write'],
      ['campaigns.stop'],
      ['campaigns.write', 'campaigns.stop'],
    ]) {
      expect(await code(cancel(scopes)), scopes.join()).toBe('not_found');
    }
    // Neither: refused naming campaigns.stop, as before.
    await expect(cancel(['campaigns.read', 'campaigns.resume'])).rejects.toThrow(
      'This API key does not have the campaigns.stop scope.',
    );
    // A writing scope: refused while the company is not active, and outside the plan.
    for (const status of ['suspended', 'restricted']) {
      expect(await code(cancel(['campaigns.write'], status))).toBe('tenant_suspended');
    }
    await expect(cancel(['campaigns.write'], 'active', ['campaigns.read'])).rejects.toMatchObject({
      code: 'forbidden',
      details: { apiReason: 'not_in_plan' },
    });
    // A stopping key outside the plan with a writing key in it cancels drafts only.
    expect(
      await code(cancel(['campaigns.write', 'campaigns.stop'], 'active', ['campaigns.write'])),
    ).toBe('not_found');
  });

  it('are described: drafts with campaigns.write, everything else with campaigns.stop', () => {
    expect(API_SCOPE_INFO['campaigns.write'].description).toContain('; and cancel drafts.');
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const cancelOp = (
      doc.paths as unknown as Record<string, Record<string, { description: string }>>
    )['/campaigns/{id}/cancel']?.post;
    for (const words of [
      'Scope: `campaigns.stop`.',
      'A draft is cancelled by a key with `campaigns.write` instead',
      'A cancelled or completed campaign is answered as it is to a key with either scope',
      'A draft is refused with 409 to a key without `campaigns.write`',
      'A key with only `campaigns.write` is refused any other campaign with 403.',
    ]) {
      expect(cancelOp?.description).toContain(words);
    }
  });
});

describe('starting an automation for many contacts in one call (ADR-161)', () => {
  const ctx = (scopes: string[]) =>
    ({
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: null,
      requestId: 'r',
    }) as unknown as ApiContext;
  const automationId = '0192a1b2-0000-7000-8000-000000000001';
  const run = (to: string) => ({ to, inputs: { patient: 'Asha' } });
  // Every refusal here comes before anything is read: the dependencies are never used.
  const start = (scopes: string[], id: string, body: unknown) =>
    apiStartManyAutomationRuns({} as never, ctx(scopes), id, body, { key: 'k-1', requestHash: 'h' })
      .then(() => null)
      .catch((caught: unknown) => caught);

  it('takes 1 to 50 runs, each as a start of one run takes it', () => {
    const parse = (body: unknown) => apiStartManyAutomationRunsSchema.safeParse(body).success;
    expect(parse({ runs: [run('+919811100001')] })).toBe(true);
    expect(
      parse({
        runs: Array.from({ length: API_LIMITS.runsPerStart }, (_, i) =>
          run(`+9198111${String(i).padStart(5, '0')}`),
        ),
      }),
    ).toBe(true);
    expect(API_LIMITS.runsPerStart).toBe(50);
    for (const body of [
      { runs: [] },
      {
        runs: Array.from({ length: API_LIMITS.runsPerStart + 1 }, (_, i) =>
          run(`+9198111${String(i).padStart(5, '0')}`),
        ),
      },
      { runs: [{ ...run('+919811100001'), from: 'x' }] },
      { runs: [run('+919811100001')], automationId },
      { runs: run('+919811100001') },
      {},
    ]) {
      expect(parse(body), JSON.stringify(body).slice(0, 80)).toBe(false);
    }
  });

  it('refuses before anything is read: the scope, the automation id, a number that is not one or given twice', async () => {
    const forbidden = await start(['contacts.read'], automationId, {
      runs: [run('+919811100001')],
    });
    expect(isAppError(forbidden) && forbidden.code).toBe('forbidden');
    const missing = await start(['automations.start'], 'not-a-uuid', {
      runs: [run('+919811100001')],
    });
    expect(isAppError(missing) && missing.code).toBe('not_found');
    const empty = await start(['automations.start'], automationId, { runs: [] });
    expect(isAppError(empty) && empty.code).toBe('validation_failed');
    const notANumber = await start(['automations.start'], automationId, {
      runs: [run('+919811100001'), run('+919811100002'), run('12345')],
    });
    expect(isAppError(notANumber) && notANumber.code).toBe('validation_failed');
    expect(isAppError(notANumber) && notANumber.issues?.map((i) => i.path)).toEqual(['runs.2.to']);
    // The same number twice, however it is written.
    const twice = await start(['automations.start'], automationId, {
      runs: [run('+91 98111 00001'), run('+919811100002'), run('+919811100001')],
    });
    expect(isAppError(twice) && twice.code).toBe('validation_failed');
    expect(isAppError(twice) && twice.issues).toEqual([
      {
        path: 'runs.2.to',
        message: 'Give each number once: runs.2.to is the number of runs.0.to.',
      },
    ]);
  });

  it('is described: each start answered in its place, the call refused as a whole only for what cannot start at all', () => {
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
            responses: Record<string, { content?: unknown }>;
          }
        >
      >
    )['/automations/{id}/runs/start-many']?.post;
    expect(op?.operationId).toBe('startManyAutomationRuns');
    expect(op?.parameters).toEqual([
      { $ref: '#/components/parameters/Id' },
      { $ref: '#/components/parameters/IdempotencyKey' },
    ]);
    expect(op?.requestBody).toEqual({
      required: true,
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/StartManyAutomationRuns' } },
      },
    });
    expect(op?.responses['200']?.content).toEqual({
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { $ref: '#/components/schemas/AutomationRunStart' } },
          },
          required: ['data'],
        },
      },
    });
    expect(Object.keys(op?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '403', '404', '409', '412', '422']),
    );
    for (const words of [
      'for up to 50 contacts, in the order given',
      'The call counts as one request.',
      'a refused start changes nothing, a contact created for it included, and the others still start',
      'a number that is not valid or given twice',
      'naming the place, as `runs.3.inputs`',
      'One call per `Idempotency-Key`',
      'it can be refused as a whole (409, starting nothing): send it again with the same `Idempotency-Key`',
    ]) {
      expect(op?.description).toContain(words);
    }
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const body = schemas.StartManyAutomationRuns as {
      properties: { runs: { minItems?: number; maxItems?: number; items?: { $ref?: string } } };
      required: string[];
      additionalProperties: boolean;
    };
    expect(body.required).toEqual(['runs']);
    expect(body.additionalProperties).toBe(false);
    expect(body.properties.runs.minItems).toBe(1);
    expect(body.properties.runs.maxItems).toBe(API_LIMITS.runsPerStart);
    const answer = schemas.AutomationRunStart as {
      properties: Record<
        string,
        { anyOf?: { properties?: Record<string, { enum?: string[] }> }[] }
      >;
      required: string[];
    };
    expect(Object.keys(answer.properties)).toEqual(['to', 'run', 'error']);
    expect(answer.required).toEqual(['to', 'run', 'error']);
    const error = answer.properties.error?.anyOf?.find((o) => o.properties);
    expect(error?.properties?.code?.enum).toEqual(['conflict', 'precondition_failed']);
  });
});

describe('stopping many runs in one call (ADR-162)', () => {
  const ctx = (scopes: string[]) =>
    ({
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: null,
      requestId: 'r',
    }) as unknown as ApiContext;
  const runId = (i: number) => `0192a1b2-0000-7000-8000-${String(i).padStart(12, '0')}`;
  // Every refusal here comes before anything is read: the dependencies are never used.
  const stop = (scopes: string[], body: unknown) =>
    apiStopManyAutomationRuns({} as never, ctx(scopes), body)
      .then(() => null)
      .catch((caught: unknown) => caught);

  it('takes 1 to 100 run ids, each once, and nothing else', () => {
    const parse = (body: unknown) => apiStopManyAutomationRunsSchema.safeParse(body).success;
    expect(API_LIMITS.runsPerStop).toBe(100);
    expect(parse({ runIds: [runId(1)] })).toBe(true);
    expect(
      parse({ runIds: Array.from({ length: API_LIMITS.runsPerStop }, (_, i) => runId(i)) }),
    ).toBe(true);
    for (const body of [
      { runIds: [] },
      { runIds: Array.from({ length: API_LIMITS.runsPerStop + 1 }, (_, i) => runId(i)) },
      { runIds: [runId(1), runId(2), runId(1)] },
      { runIds: ['not-a-run'] },
      { runIds: [runId(1)], reason: 'done' },
      { runIds: runId(1) },
      {},
    ]) {
      expect(parse(body), JSON.stringify(body).slice(0, 80)).toBe(false);
    }
  });

  it('refuses before anything is read: the scope, an empty list, a repeat, an id that is not one', async () => {
    const forbidden = await stop(['contacts.read'], { runIds: [runId(1)] });
    expect(isAppError(forbidden) && forbidden.code).toBe('forbidden');
    const suspended = await apiStopManyAutomationRuns(
      {} as never,
      { ...ctx(['automations.start']), tenant: { id: 't', status: 'suspended' } } as ApiContext,
      { runIds: [runId(1)] },
    ).catch((caught: unknown) => caught);
    expect(isAppError(suspended) && suspended.code).toBe('tenant_suspended');
    for (const body of [
      { runIds: [] },
      { runIds: [runId(1), runId(1)] },
      { runIds: [runId(1), 'x'] },
    ]) {
      const refused = await stop(['automations.start'], body);
      expect(isAppError(refused) && refused.code, JSON.stringify(body)).toBe('validation_failed');
    }
  });

  it('is described: all or none, in the order given, a retry safe without a key', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const op = (
      doc.paths as unknown as Record<
        string,
        Record<
          string,
          {
            operationId: string;
            description: string;
            parameters?: unknown[];
            requestBody: unknown;
            responses: Record<string, { content?: unknown }>;
          }
        >
      >
    )['/automation-runs/stop-many']?.post;
    expect(op?.operationId).toBe('stopManyAutomationRuns');
    expect(op?.parameters).toBeUndefined();
    expect(op?.requestBody).toEqual({
      required: true,
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/StopManyAutomationRuns' } },
      },
    });
    expect(op?.responses['200']?.content).toEqual({
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { $ref: '#/components/schemas/AutomationRun' } },
          },
          required: ['data'],
        },
      },
    });
    expect(Object.keys(op?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '403', '422', '423']),
    );
    expect(Object.keys(op?.responses ?? {})).not.toContain('404');
    for (const words of [
      'Up to 100 runs keys of the company started',
      'a run that has already ended is answered as it is',
      'All of them or none',
      '(422, naming the field, as `runIds.3`)',
      'The runs are stopped in the order given and answered in it.',
      'A call counts as one request',
      'a retry is safe without an `Idempotency-Key`',
    ]) {
      expect(op?.description).toContain(words);
    }
    const body = (doc.components as { schemas: Record<string, Record<string, unknown>> }).schemas
      .StopManyAutomationRuns as {
      properties: { runIds: { minItems?: number; maxItems?: number } };
      required: string[];
      additionalProperties: boolean;
    };
    expect(body.required).toEqual(['runIds']);
    expect(body.additionalProperties).toBe(false);
    expect(body.properties.runIds.minItems).toBe(1);
    expect(body.properties.runIds.maxItems).toBe(API_LIMITS.runsPerStop);
  });
});

describe('sending a template to many numbers in one call (ADR-163)', () => {
  const ctx = (scopes: string[]) =>
    ({
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: null,
      requestId: 'r',
    }) as unknown as ApiContext;
  const templateId = '0192a1b2-0000-7000-8000-000000000001';
  const message = (to: string) => ({ to, variables: { body: ['Asha', 'A-1001'] } });
  // Every refusal here comes before anything is read: the dependencies are never used.
  const send = (scopes: string[], body: unknown) =>
    apiSendManyTemplates({} as never, ctx(scopes), body, { key: 'k-1', requestHash: 'h' })
      .then(() => null)
      .catch((caught: unknown) => caught);

  it('takes one template and 1 to 50 numbers, each with the values of its variables', () => {
    const parse = (body: unknown) => apiSendManyTemplatesSchema.safeParse(body);
    expect(API_LIMITS.messagesPerSend).toBe(50);
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => message(`+9198111${String(i).padStart(5, '0')}`));
    expect(parse({ templateId, messages: many(1) }).success).toBe(true);
    expect(parse({ templateId, messages: many(API_LIMITS.messagesPerSend) }).success).toBe(true);
    expect(parse({ templateId, from: templateId, messages: many(2) }).success).toBe(true);
    // Values left out are none, as for one send.
    expect(parse({ templateId, messages: [{ to: '+919811100001' }] }).data?.messages).toEqual([
      { to: '+919811100001', variables: { header: [], body: [], buttons: [] } },
    ]);
    for (const body of [
      { templateId, messages: [] },
      { templateId, messages: many(API_LIMITS.messagesPerSend + 1) },
      { messages: many(1) },
      { templateId: 'x', messages: many(1) },
      { templateId, messages: many(1), type: 'template' },
      { templateId, messages: [{ ...message('+919811100001'), templateId }] },
      { templateId, messages: [{ to: '+919811100001', variables: { header: ['a', 'b'] } }] },
      { templateId, messages: [{ to: '+919811100001', variables: { body: [' '] } }] },
      { templateId, messages: message('+919811100001') },
      {},
    ]) {
      expect(parse(body).success, JSON.stringify(body).slice(0, 80)).toBe(false);
    }
  });

  it('refuses before anything is read: the scope, an empty list, a number that is not one or given twice', async () => {
    const forbidden = await send(['messages.reply'], {
      templateId,
      messages: [message('+919811100001')],
    });
    expect(isAppError(forbidden) && forbidden.code).toBe('forbidden');
    const empty = await send(['messages.send'], { templateId, messages: [] });
    expect(isAppError(empty) && empty.code).toBe('validation_failed');
    const notANumber = await send(['messages.send_marketing'], {
      templateId,
      messages: [message('+919811100001'), message('+919811100002'), message('12345')],
    });
    expect(isAppError(notANumber) && notANumber.code).toBe('validation_failed');
    expect(isAppError(notANumber) && notANumber.issues?.map((i) => i.path)).toEqual([
      'messages.2.to',
    ]);
    // The same number twice, however it is written.
    const twice = await send(['messages.send'], {
      templateId,
      messages: [message('+91 98111 00001'), message('+919811100002'), message('+919811100001')],
    });
    expect(isAppError(twice) && twice.code).toBe('validation_failed');
    expect(isAppError(twice) && twice.issues).toEqual([
      {
        path: 'messages.2.to',
        message: 'Give each number once: messages.2.to is the number of messages.0.to.',
      },
    ]);
  });

  it('is described: each number answered in its place, the call refused as a whole only for what cannot send at all', () => {
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
            responses: Record<string, { content?: unknown }>;
          }
        >
      >
    )['/messages/send-many']?.post;
    expect(op?.operationId).toBe('sendManyTemplates');
    expect(op?.parameters).toEqual([{ $ref: '#/components/parameters/IdempotencyKey' }]);
    expect(op?.requestBody).toEqual({
      required: true,
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/SendManyTemplates' } },
      },
    });
    expect(op?.responses['200']?.content).toEqual({
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { $ref: '#/components/schemas/TemplateSend' } },
          },
          required: ['data'],
        },
      },
    });
    expect(Object.keys(op?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '403', '404', '409', '412', '422', '423']),
    );
    for (const words of [
      'Utility templates need `messages.send`, marketing templates `messages.send_marketing`.',
      'Sends the template to up to 50 numbers',
      'consent, the suppression list and the marketing frequency cap are checked for each',
      'The call counts as one request against the rate and monthly limits',
      'a refused number changes nothing, a contact created for it included, and the others are still sent',
      'a number that is not valid or given twice',
      'naming the place, as `messages.3.variables`',
      'One call per `Idempotency-Key`',
      'it can be refused as a whole (409, sending nothing): send it again with the same `Idempotency-Key`',
    ]) {
      expect(op?.description).toContain(words);
    }
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const body = schemas.SendManyTemplates as {
      properties: { messages: { minItems?: number; maxItems?: number } };
      required: string[];
      additionalProperties: boolean;
    };
    expect(body.required).toEqual(['templateId', 'messages']);
    expect(body.additionalProperties).toBe(false);
    expect(body.properties.messages.minItems).toBe(1);
    expect(body.properties.messages.maxItems).toBe(API_LIMITS.messagesPerSend);
    const answer = schemas.TemplateSend as {
      properties: Record<
        string,
        { anyOf?: { properties?: Record<string, { const?: string; enum?: string[] }> }[] }
      >;
      required: string[];
    };
    expect(Object.keys(answer.properties)).toEqual(['to', 'message', 'error']);
    expect(answer.required).toEqual(['to', 'message', 'error']);
    const error = answer.properties.error?.anyOf?.find((o) => o.properties);
    expect(error?.properties?.code?.const).toBe('precondition_failed');
    const queued = answer.properties.message?.anyOf?.find((o) => o.properties);
    expect(Object.keys(queued?.properties ?? {})).toEqual(
      expect.arrayContaining(['id', 'status', 'contactId', 'channelId', 'templateId']),
    );
  });
});

describe('reviewing campaign drafts through the API (ADR-193)', () => {
  const ctx = (scopes: string[], status = 'active', planScopes: string[] | null = null) =>
    ({
      tenant: { id: 't', status },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: planScopes ? new Set(planScopes) : null,
    }) as unknown as ApiContext;
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'done',
      (error: unknown) => (isAppError(error) ? error.code : String(error)),
    );
  const review = (scopes: string[], status = 'active', planScopes: string[] | null = null) =>
    apiReviewCampaign({} as never, ctx(scopes, status, planScopes), 'not-an-id');
  const id = '0190a000-0000-7000-8000-000000000193';

  it('take a key that writes drafts, whatever the company’s status, checked before anything is read', async () => {
    // A review changes nothing: a key that writes drafts passes the checks made before the campaign
    // is read (a bad id is then not found) even while the company is not active.
    for (const status of ['active', 'suspended', 'restricted']) {
      expect(await code(review(['campaigns.write'], status)), status).toBe('not_found');
    }
    // It shows costs and the audience, which reading campaigns never does.
    await expect(review(['campaigns.read', 'campaigns.stop', 'campaigns.resume'])).rejects.toThrow(
      'This API key does not have the campaigns.write scope.',
    );
    await expect(review(['campaigns.write'], 'active', ['campaigns.read'])).rejects.toMatchObject({
      code: 'forbidden',
      details: { apiReason: 'not_in_plan' },
    });
  });

  it('answer members’ review in the API’s words: skip reasons commonest first, amounts in major units, times in ISO 8601', () => {
    const members: CampaignDraftReview = {
      problems: ['The template is not approved by Meta.'],
      audience: {
        total: 12,
        eligible: 5,
        skipped: { opted_out: 2, suppressed: 2, missing_variable: 3, no_phone: 0 },
      },
      estimate: {
        currency: 'INR',
        totalMicros: 4_312_500,
        pricedCount: 4,
        unpricedCount: 1,
        byMarket: [
          { market: 'India', count: 3, micros: 2_587_500 },
          { market: 'United Arab Emirates', count: 1, micros: 1_725_000 },
        ],
      },
      costCurrency: 'INR',
      scheduledAt: new Date('2026-11-01T03:30:00Z'),
      adjustment: null,
      approvalRequired: true,
      frequencyCap: { count: 2, days: 7 },
    };
    const answered = toApiCampaignReview({ id, version: 4 }, members);
    expect(answered).toEqual({
      campaignId: id,
      version: 4,
      problems: ['The template is not approved by Meta.'],
      audience: {
        total: 12,
        eligible: 5,
        // Ties in alphabetical order; a reason no contact has is not listed.
        skipReasons: [
          { reason: 'missing_variable', count: 3 },
          { reason: 'opted_out', count: 2 },
          { reason: 'suppressed', count: 2 },
        ],
      },
      estimate: {
        currency: 'INR',
        total: '4.3125',
        pricedCount: 4,
        unpricedCount: 1,
        byMarket: [
          { market: 'India', count: 3, amount: '2.5875' },
          { market: 'United Arab Emirates', count: 1, amount: '1.725' },
        ],
      },
      costCurrency: 'INR',
      scheduledAt: '2026-11-01T03:30:00.000Z',
      scheduleAdjustment: null,
      approvalRequired: true,
      frequencyCap: { count: 2, days: 7 },
    });
    expect(apiCampaignReviewSchema.parse(answered)).toEqual(answered);
    // A draft without an audience or an estimate yet, at a local time the clocks skip.
    const incomplete = toApiCampaignReview(
      { id, version: 0 },
      {
        ...members,
        problems: ['Choose the WhatsApp number to send from.', 'Choose an approved template.'],
        audience: null,
        estimate: null,
        costCurrency: null,
        scheduledAt: null,
        adjustment: 'gap_shifted',
        approvalRequired: false,
        frequencyCap: null,
      },
    );
    expect(incomplete).toEqual({
      campaignId: id,
      version: 0,
      problems: ['Choose the WhatsApp number to send from.', 'Choose an approved template.'],
      audience: null,
      estimate: null,
      costCurrency: null,
      scheduledAt: null,
      scheduleAdjustment: 'gap_shifted',
      approvalRequired: false,
      frequencyCap: null,
    });
    expect(apiCampaignReviewSchema.parse(incomplete)).toEqual(incomplete);
  });

  it('are described as a read of drafts for keys that write them, never of contacts', () => {
    expect(API_SCOPE_INFO['campaigns.write'].description).toContain(
      'review drafts as members do before they submit them (who they would reach and what they would cost)',
    );
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    expect(doc.info.description).toContain(
      'create, edit, review and submit campaign drafts for a member’s approval',
    );
    const op = (
      doc.paths as unknown as Record<
        string,
        Record<string, { operationId: string; description: string; responses: object }>
      >
    )['/campaigns/{id}/review']?.get;
    expect(op?.operationId).toBe('reviewCampaign');
    for (const words of [
      'Scope: `campaigns.write`.',
      "It changes nothing, and is answered whatever the company's status.",
      'Counts only: never contacts or members.',
      'Only a draft is reviewed: any other status is refused with 409, naming it',
    ]) {
      expect(op?.description).toContain(words);
    }
    // Answered whatever the company's status, so never 423.
    expect(Object.keys(op?.responses ?? {}).sort()).toEqual(
      ['200', '401', '403', '404', '409', '429', '500'].sort(),
    );
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const reviewSchema = schemas.CampaignReview as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    const fields = [
      'approvalRequired',
      'audience',
      'campaignId',
      'costCurrency',
      'estimate',
      'frequencyCap',
      'problems',
      'scheduleAdjustment',
      'scheduledAt',
      'version',
    ];
    expect(Object.keys(reviewSchema.properties).sort()).toEqual(fields);
    expect([...(reviewSchema.required ?? [])].sort()).toEqual(fields);
    expect(API_ROUTES).toEqual(expect.arrayContaining([['get', '/campaigns/{id}/review']]));
  });
});

describe('media from links through the API (ADR-194)', () => {
  const base = { to: '+919876543210', link: 'https://cdn.example.com/menu.pdf' };

  it('take an https link without a user name or password, and a trimmed caption except for audio', () => {
    expect([...API_MEDIA_TYPES]).toEqual(['image', 'video', 'audio', 'document', 'sticker']);
    expect(
      apiSendMediaSchema.parse({ ...base, type: 'document', caption: '  Our menu  ' }),
    ).toEqual({ ...base, type: 'document', caption: 'Our menu' });
    expect(
      apiSendMediaSchema.parse({ ...base, type: 'image', link: ' https://x.example/a.jpg ' }),
    ).toMatchObject({ link: 'https://x.example/a.jpg' });
    expect(apiSendMediaSchema.parse({ ...base, type: 'audio' })).toEqual({
      ...base,
      type: 'audio',
    });
    expect(
      apiSendMediaSchema.parse({ ...base, type: 'video', caption: 'c'.repeat(1024) }),
    ).toMatchObject({ caption: 'c'.repeat(1024) });
    for (const link of [
      'http://cdn.example.com/menu.pdf',
      'https://user:secret@cdn.example.com/menu.pdf',
      'https://user@cdn.example.com/menu.pdf',
      'https://:secret@cdn.example.com/menu.pdf',
      'ftp://cdn.example.com/menu.pdf',
      'javascript:alert(1)',
      'cdn.example.com/menu.pdf',
      '',
      `https://cdn.example.com/${'a'.repeat(2000)}`,
    ]) {
      expect(isMediaLink(link) && link.length <= 2000, link).toBe(false);
      expect(apiSendMediaSchema.safeParse({ ...base, type: 'image', link }).success, link).toBe(
        false,
      );
    }
    for (const bad of [
      { ...base, type: 'audio', caption: 'A voice note' },
      { ...base, type: 'image', caption: '   ' },
      { ...base, type: 'image', caption: 'c'.repeat(1025) },
      { ...base, type: 'document', filename: 'menu.pdf' },
      { ...base, type: 'image', id: '1003383421387256' },
      { to: base.to, type: 'image' },
      { ...base, type: 'sticker', caption: 'Thanks!' },
    ]) {
      expect(apiSendMediaSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(
      apiSendMediaSchema.safeParse({ ...base, type: 'image', link: 'http://x.example/a.jpg' }).error
        ?.issues[0]?.message,
    ).toBe('Give an https:// link to the media, without a user name or password');
  });

  it('are chosen by their type and need a key that replies', async () => {
    const ctx = {
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set(['messages.send']) },
      planScopes: null,
    } as unknown as ApiContext;
    for (const type of API_MEDIA_TYPES) {
      await expect(
        apiSendMessage({} as never, ctx, { ...base, type }, { key: 'k-1', requestHash: 'h' }),
      ).rejects.toThrow('This API key does not have the messages.reply scope.');
    }
  });

  it('name the media by its caption, or by what it is', () => {
    expect(outboundText('image', { link: base.link, caption: 'Today’s menu' })).toBe(
      'Today’s menu',
    );
    expect(outboundText('document', { link: base.link, caption: 'Menu' })).toBe('Menu');
    expect(outboundText('audio', { link: base.link })).toBeNull();
    expect(messageSnippet('outbound', 'video', { link: base.link })).toBe('Video');
    expect(messageSnippet('outbound', 'image', { link: base.link, caption: 'New\n stock' })).toBe(
      'New stock',
    );
  });

  it('are described in the send operation, each type with its own schema, and by the scope', () => {
    expect(API_SCOPE_INFO['messages.reply'].label).toBe(
      'Reply with text, media and other messages',
    );
    expect(API_SCOPE_INFO['messages.reply'].description).toContain(
      'photos, videos, audio, documents or stickers from links',
    );
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const send = (
      doc.paths as unknown as Record<
        string,
        Record<string, { summary: string; description: string }>
      >
    )['/messages']?.post;
    expect(send?.summary).toContain('a reaction, media, a location or contacts');
    for (const words of [
      '`image`, `video`, `audio`, `document` or `sticker`',
      'https:// `link` that WhatsApp fetches when it sends the message',
      'HyFib neither fetches nor keeps the media',
      'a `caption` of up to 1,024 characters; audio and stickers take none',
    ]) {
      expect(send?.description).toContain(words);
    }
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    // The link, or since ADR-219 the id of a file uploaded for the number, one of the two.
    for (const name of ['SendImage', 'SendVideo', 'SendDocument']) {
      const schema = schemas[name] as { properties: object; required: string[] };
      expect(Object.keys(schema.properties).sort(), name).toEqual(
        ['caption', 'from', 'link', 'mediaId', 'replyTo', 'to', 'type'].sort(),
      );
      expect([...schema.required].sort(), name).toEqual(['to', 'type']);
    }
    const audio = schemas.SendAudio as { properties: object; additionalProperties: unknown };
    expect(Object.keys(audio.properties)).not.toContain('caption');
    expect(audio.additionalProperties).toBe(false);
  });
});

describe('the types of the messages the API sends, in its answers (ADR-194)', () => {
  it('give media from links as their own type, as sent, never as a template', () => {
    for (const type of [
      'image',
      'video',
      'audio',
      'document',
      'sticker',
      'location',
      'contacts',
      'text',
      'interactive',
      'reaction',
    ]) {
      expect(apiMessageType(type)).toBe(type);
    }
    expect(apiMessageType('template')).toBe('template');
    const schemas = (
      buildOpenApiDocument('https://app.example.com/api/v1').components as unknown as {
        schemas: Record<string, { properties: { type: { enum: string[]; description: string } } }>;
      }
    ).schemas;
    for (const name of ['QueuedMessage', 'Message']) {
      expect(schemas[name]?.properties.type.enum).toEqual([...API_MESSAGE_TYPES]);
      expect(schemas[name]?.properties.type.description).toContain(
        'image, video, audio, document and sticker: media sent from a link; location: a place; contacts: contact cards.',
      );
    }
    expect(API_MESSAGE_TYPES).toEqual(
      expect.arrayContaining([
        'image',
        'video',
        'audio',
        'document',
        'sticker',
        'location',
        'contacts',
      ]),
    );
  });
});

describe('locations through the API (ADR-195)', () => {
  const base = { type: 'location', to: '+919876543210', latitude: 18.5204, longitude: 73.8567 };

  it('take coordinates within their ranges, and a trimmed name and address if given', () => {
    expect(
      apiSendLocationSchema.parse({
        ...base,
        name: '  Harbour Dental ',
        address: ' 12 Harbour Road, Pune ',
      }),
    ).toEqual({ ...base, name: 'Harbour Dental', address: '12 Harbour Road, Pune' });
    expect(apiSendLocationSchema.parse(base)).toEqual(base);
    for (const [latitude, longitude] of [
      [90, 180],
      [-90, -180],
      [0, 0],
    ]) {
      expect(
        apiSendLocationSchema.safeParse({ ...base, latitude, longitude }).success,
        `${latitude}, ${longitude}`,
      ).toBe(true);
    }
    expect(API_LIMITS.locationTextLength).toBe(1000);
    const longest = 'n'.repeat(API_LIMITS.locationTextLength);
    expect(apiSendLocationSchema.parse({ ...base, name: longest, address: longest })).toMatchObject(
      { name: longest, address: longest },
    );
    for (const bad of [
      { ...base, latitude: 90.0001 },
      { ...base, latitude: -91 },
      { ...base, longitude: 180.5 },
      { ...base, longitude: -181 },
      { ...base, latitude: '18.5204' },
      { ...base, latitude: undefined },
      { ...base, longitude: null },
      { ...base, name: '   ' },
      { ...base, address: '' },
      { ...base, name: 'n'.repeat(1001) },
      { ...base, address: 'a'.repeat(1001) },
      { ...base, url: 'https://harbour.example' },
      { ...base, type: 'image' },
    ]) {
      expect(apiSendLocationSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(
      apiSendLocationSchema.safeParse({ ...base, latitude: 91 }).error?.issues[0],
    ).toMatchObject({ path: ['latitude'], message: 'A latitude runs from -90 to 90 degrees' });
    expect(
      apiSendLocationSchema.safeParse({ ...base, longitude: '73.8567' }).error?.issues[0]?.message,
    ).toBe('Give the longitude as a number of degrees');
    expect(
      apiSendLocationSchema.safeParse({ ...base, address: 'a'.repeat(1001) }).error?.issues[0]
        ?.message,
    ).toBe('A location’s address is limited to 1000 characters');
  });

  it('give WhatsApp the coordinates as decimal text, never in exponent notation', () => {
    expect(decimalDegrees(37.758056)).toBe('37.758056');
    expect(decimalDegrees(-122.425332)).toBe('-122.425332');
    expect(decimalDegrees(90)).toBe('90');
    expect(decimalDegrees(0)).toBe('0');
    expect(decimalDegrees(0.000001)).toBe('0.000001');
    expect(decimalDegrees(1e-7)).toBe('0.0000001');
    expect(decimalDegrees(-5e-7)).toBe('-0.0000005');
    expect(decimalDegrees(1.5e-10)).toBe('0.00000000015');
  });

  it('are chosen by their type and need a key that replies', async () => {
    const idem = { key: 'k-1', requestHash: 'h' };
    const sending = {
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set(['messages.send']) },
      planScopes: null,
    } as unknown as ApiContext;
    await expect(apiSendMessage({} as never, sending, base, idem)).rejects.toThrow(
      'This API key does not have the messages.reply scope.',
    );
    // A key that replies reaches the location's own checks before anything is read.
    const replying = {
      ...sending,
      key: { id: 'k', scopes: new Set(['messages.reply']) },
    } as unknown as ApiContext;
    const refused: unknown = await apiSendMessage(
      {} as never,
      replying,
      { ...base, longitude: 181 },
      idem,
    ).catch((caught: unknown) => caught);
    expect(isAppError(refused) && refused.issues?.[0]?.path).toBe('longitude');
  });

  it('name the place, or its address without a name', () => {
    const at = { latitude: 18.5204, longitude: 73.8567 };
    expect(
      outboundText('location', { ...at, name: 'Harbour Dental', address: '12 Harbour Road' }),
    ).toBe('Harbour Dental');
    expect(outboundText('location', { ...at, address: '12 Harbour Road' })).toBe('12 Harbour Road');
    expect(outboundText('location', at)).toBeNull();
    expect(messageSnippet('outbound', 'location', at)).toBe('Location');
    expect(messageSnippet('outbound', 'location', { ...at, name: 'Harbour\n Dental' })).toBe(
      'Harbour Dental',
    );
  });

  it('are described in the send operation, with their own schema, and by the scope', () => {
    expect(API_SCOPE_INFO['messages.reply'].label).toBe(
      'Reply with text, media and other messages',
    );
    // Since ADR-219 the scope also names files uploaded for the number.
    expect(API_SCOPE_INFO['messages.reply'].description).toContain(
      'from links, or files uploaded for the number, locations and contact cards, to contacts who wrote',
    );
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const send = (
      doc.paths as unknown as Record<
        string,
        Record<string, { summary: string; description: string }>
      >
    )['/messages']?.post;
    expect(send?.summary).toContain('media, a location or contacts');
    for (const words of [
      '`location` or `contacts`) needs `messages.reply`',
      'A text, buttons, a list, products, media, a location or contacts can quote',
      'A location (`location`) is a place given by its `latitude` and `longitude` in decimal degrees',
      `up to ${API_LIMITS.locationTextLength.toLocaleString('en')} characters each`,
    ]) {
      expect(send?.description).toContain(words);
    }
    const schemas = (doc.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    const location = schemas.SendLocation as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties: unknown;
    };
    expect(Object.keys(location.properties).sort()).toEqual(
      ['address', 'from', 'latitude', 'longitude', 'name', 'replyTo', 'to', 'type'].sort(),
    );
    expect([...location.required].sort()).toEqual(['latitude', 'longitude', 'to', 'type']);
    expect(location.additionalProperties).toBe(false);
    expect(location.properties.latitude).toMatchObject({
      type: 'number',
      minimum: -90,
      maximum: 90,
    });
    expect(location.properties.longitude).toMatchObject({
      type: 'number',
      minimum: -180,
      maximum: 180,
    });
    expect(location.properties.address).toMatchObject({ type: 'string', maxLength: 1000 });
    // A message's words: a location's name, or its address, whichever way it went.
    const message = schemas.ConversationMessage as {
      properties: { text: { description: string } };
    };
    expect(message.properties.text.description).toContain(
      'a location’s name (its address if it has no name); for inbound messages also the title of a tapped reply, for outbound ones',
    );
  });
});

describe('contact cards through the API (ADR-197)', () => {
  const base = { type: 'contacts', to: '+919876543210' };
  const lucia = {
    name: { formattedName: ' Lucía Gómez ', firstName: 'Lucía', lastName: 'Gómez' },
    phones: [{ phone: '+91 98765 43210', type: 'WORK', waId: '919876543210' }],
    emails: [{ email: 'lucia@example.com', type: 'WORK' }],
    urls: [{ url: 'https://harbour.example', type: 'WORK' }],
    addresses: [
      {
        street: '12 Harbour Road',
        city: 'Pune',
        zip: '411001',
        country: 'India',
        countryCode: 'IN',
        type: 'WORK',
      },
    ],
    org: { company: 'Harbour Dental', title: 'Front desk' },
    birthday: '1990-02-28',
  };
  const ravi = { name: { formattedName: 'Ravi', firstName: 'Ravi' } };

  it('take 1 to 5 contacts as Meta’s spec describes them, each part checked', () => {
    expect(apiSendContactsSchema.parse({ ...base, contacts: [lucia] }).contacts[0]?.name).toEqual({
      formattedName: 'Lucía Gómez',
      firstName: 'Lucía',
      lastName: 'Gómez',
    });
    expect(apiSendContactsSchema.parse({ ...base, contacts: [ravi] }).contacts).toEqual([ravi]);
    const five = Array.from({ length: 5 }, () => lucia);
    expect(apiSendContactsSchema.safeParse({ ...base, contacts: five }).success).toBe(true);
    expect(API_LIMITS.contactsPerCard).toBe(5);
    const at = (change: Record<string, unknown>) => ({
      ...base,
      contacts: [{ ...lucia, ...change }],
    });
    const phone = '+91 98765 43210';
    for (const [label, bad] of [
      ['no contact', { ...base, contacts: [] }],
      ['six contacts', { ...base, contacts: [...five, ravi] }],
      ['only a formatted name', at({ name: { formattedName: 'Lucía Gómez' } })],
      ['no formatted name', at({ name: { firstName: 'Lucía' } })],
      ['a long name', at({ name: { formattedName: 'x'.repeat(257), firstName: 'x' } })],
      ['a name part the spec does not send', at({ name: { ...ravi.name, nickname: 'R' } })],
      ['a phone without digits', at({ phones: [{ phone: 'call me' }] })],
      ['a WhatsApp id with letters', at({ phones: [{ phone, waId: '91abc12345' }] })],
      ['a kind the spec does not name', at({ phones: [{ phone, type: 'MOBILE' }] })],
      ['six phones', at({ phones: Array.from({ length: 6 }, () => ({ phone })) })],
      ['an empty list', at({ phones: [] })],
      ['an email address that is not one', at({ emails: [{ email: 'lucia@' }] })],
      ['a script link', at({ urls: [{ url: 'javascript:alert(1)' }] })],
      ['a link with a password', at({ urls: [{ url: 'https://u:p@harbour.example' }] })],
      ['a password without a user name', at({ urls: [{ url: 'https://:p@harbour.example' }] })],
      ['an address without parts', at({ addresses: [{ type: 'HOME' }] })],
      ['a three-letter country code', at({ addresses: [{ city: 'Pune', countryCode: 'IND' }] })],
      ['an empty organisation', at({ org: {} })],
      ['a birthday that does not exist', at({ birthday: '1990-02-30' })],
      ['a birthday written otherwise', at({ birthday: '28/02/1990' })],
      ['a part the spec does not send', at({ photo: 'https://harbour.example/lucia.jpg' })],
    ] as const) {
      expect(apiSendContactsSchema.safeParse(bad).success, label).toBe(false);
    }
    expect(
      apiSendContactsSchema.safeParse(at({ name: { formattedName: 'Lucía Gómez' } })).error
        ?.issues[0],
    ).toMatchObject({
      path: ['contacts', 0, 'name', 'firstName'],
      message: 'Give a first name, a last name or another part of the name too',
    });
    expect(isCardLink('http://harbour.example/team')).toBe(true);
    expect(isCardLink('ftp://harbour.example')).toBe(false);
  });

  it('are sent and kept in WhatsApp’s words, which read back as received cards do', () => {
    const card = apiSendContactsSchema.parse({ ...base, contacts: [lucia] }).contacts[0]!;
    const kept = whatsappContact(card);
    expect(kept).toEqual({
      name: { formatted_name: 'Lucía Gómez', first_name: 'Lucía', last_name: 'Gómez' },
      phones: [{ phone: '+91 98765 43210', type: 'WORK', wa_id: '919876543210' }],
      emails: [{ email: 'lucia@example.com', type: 'WORK' }],
      urls: [{ url: 'https://harbour.example', type: 'WORK' }],
      addresses: [
        {
          street: '12 Harbour Road',
          city: 'Pune',
          zip: '411001',
          country: 'India',
          country_code: 'IN',
          type: 'WORK',
        },
      ],
      org: { company: 'Harbour Dental', title: 'Front desk' },
      birthday: '1990-02-28',
    });
    expect(whatsappContact(ravi)).toEqual({ name: { formatted_name: 'Ravi', first_name: 'Ravi' } });
    // Read back as a received card (ADR-196): the API gives what was sent.
    expect(contactCards('contacts', { contacts: [kept] })).toEqual([
      {
        name: {
          formattedName: 'Lucía Gómez',
          firstName: 'Lucía',
          lastName: 'Gómez',
          middleName: null,
          prefix: null,
          suffix: null,
        },
        phones: [{ phone: '+91 98765 43210', waId: '919876543210', type: 'WORK' }],
        emails: [{ email: 'lucia@example.com', type: 'WORK' }],
        urls: [{ url: 'https://harbour.example', type: 'WORK' }],
        addresses: [
          {
            street: '12 Harbour Road',
            city: 'Pune',
            state: null,
            zip: '411001',
            country: 'India',
            countryCode: 'IN',
            type: 'WORK',
          },
        ],
        org: { company: 'Harbour Dental', department: null, title: 'Front desk' },
        birthday: '1990-02-28',
      },
    ]);
    expect(outboundText('contacts', { contacts: [kept] })).toBeNull();
    expect(messageSnippet('outbound', 'contacts', { contacts: [kept] })).toBe('Contact card');
  });

  it('are chosen by their type, need a key that replies and must fit in a message', async () => {
    const idem = { key: 'k-1', requestHash: 'h' };
    const sending = {
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set(['messages.send']) },
      planScopes: null,
    } as unknown as ApiContext;
    await expect(
      apiSendMessage({} as never, sending, { ...base, contacts: [ravi] }, idem),
    ).rejects.toThrow('This API key does not have the messages.reply scope.');
    const replying = {
      ...sending,
      key: { id: 'k', scopes: new Set(['messages.reply']) },
    } as unknown as ApiContext;
    // Each part within its bound, but five contacts of long four-byte text are more than a message
    // may hold: refused before anything is read.
    const wide = '𝒳'.repeat(128);
    const place = { street: wide, city: wide, state: wide, zip: wide, country: wide };
    const heavy = {
      name: { formattedName: wide, firstName: wide, lastName: wide },
      addresses: Array.from({ length: 5 }, () => place),
    };
    const big = { ...base, contacts: Array.from({ length: 5 }, () => heavy) };
    expect(apiSendContactsSchema.safeParse(big).success).toBe(true);
    const refused: unknown = await apiSendMessage({} as never, replying, big, idem).catch(
      (caught: unknown) => caught,
    );
    expect(isAppError(refused) && refused.code).toBe('validation_failed');
    expect(isAppError(refused) && refused.issues?.[0]?.path).toBe('contacts');
  });

  it('are described in the send operation, with their own schema, and by the scope', () => {
    expect(API_SCOPE_INFO['messages.reply'].label).toBe(
      'Reply with text, media and other messages',
    );
    expect(API_SCOPE_INFO['messages.reply'].description).toContain(
      'locations and contact cards, to contacts who wrote',
    );
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const send = (
      doc.paths as unknown as Record<
        string,
        Record<string, { summary: string; description: string }>
      >
    )['/messages']?.post;
    expect(send?.summary).toContain('a location or contacts');
    for (const words of [
      '`location` or `contacts`) needs `messages.reply`',
      'Contacts (`contacts`) share 1 to 5 contact cards, as Meta’s spec describes them',
      'its `formattedName` and at least one other part',
      'up to 5 of each, each with a `type` of HOME or WORK if wanted',
      'each text up to 256 characters, a link up to 2,000',
      'Messages read back give them in `contacts`',
    ]) {
      expect(send?.description).toContain(words);
    }
    type Shape = {
      properties?: Record<string, Shape>;
      required?: string[];
      items?: Shape;
      minItems?: number;
      maxItems?: number;
      enum?: string[];
      additionalProperties?: unknown;
    };
    const schemas = (doc.components as { schemas: Record<string, Shape> }).schemas;
    const contacts = schemas.SendContacts;
    expect(Object.keys(contacts?.properties ?? {}).sort()).toEqual(
      ['contacts', 'from', 'replyTo', 'to', 'type'].sort(),
    );
    expect([...(contacts?.required ?? [])].sort()).toEqual(['contacts', 'to', 'type']);
    const list = contacts?.properties?.contacts;
    expect(list).toMatchObject({ minItems: 1, maxItems: 5 });
    const card = list?.items;
    expect(card?.additionalProperties).toBe(false);
    expect(Object.keys(card?.properties ?? {}).sort()).toEqual(
      ['addresses', 'birthday', 'emails', 'name', 'org', 'phones', 'urls'].sort(),
    );
    expect(card?.required).toEqual(['name']);
    expect(card?.properties?.phones).toMatchObject({ minItems: 1, maxItems: 5 });
    expect(card?.properties?.phones?.items?.properties?.type?.enum).toEqual(['HOME', 'WORK']);
  });
});

describe('stickers from links through the API (ADR-198)', () => {
  const base = {
    type: 'sticker',
    to: '+919876543210',
    link: 'https://cdn.example.com/thanks.webp',
  };

  it('take an https link and no caption, as audio does', () => {
    expect(apiSendMediaSchema.parse(base)).toEqual(base);
    expect(apiSendMediaSchema.parse({ ...base, link: ' https://x.example/s.webp ' })).toMatchObject(
      { link: 'https://x.example/s.webp' },
    );
    for (const bad of [
      { ...base, caption: 'Thanks!' },
      { ...base, link: 'http://cdn.example.com/thanks.webp' },
      { ...base, link: 'https://:secret@cdn.example.com/thanks.webp' },
      { ...base, id: '1003383421387256' },
      { ...base, animated: true },
    ]) {
      expect(apiSendMediaSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(outboundText('sticker', { link: base.link })).toBeNull();
    expect(messageSnippet('outbound', 'sticker', { link: base.link })).toBe('Sticker');
  });

  it('are chosen by their type and need a key that replies', async () => {
    const idem = { key: 'k-1', requestHash: 'h' };
    const sending = {
      tenant: { id: 't', status: 'active' },
      key: { id: 'k', scopes: new Set(['messages.send']) },
      planScopes: null,
    } as unknown as ApiContext;
    await expect(apiSendMessage({} as never, sending, base, idem)).rejects.toThrow(
      'This API key does not have the messages.reply scope.',
    );
    const replying = {
      ...sending,
      key: { id: 'k', scopes: new Set(['messages.reply']) },
    } as unknown as ApiContext;
    const refused: unknown = await apiSendMessage(
      {} as never,
      replying,
      { ...base, caption: 'Thanks!' },
      idem,
    ).catch((caught: unknown) => caught);
    expect(isAppError(refused) && refused.code).toBe('validation_failed');
  });

  it('are described in the send operation, with their own schema', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const send = (doc.paths as unknown as Record<string, Record<string, { description: string }>>)[
      '/messages'
    ]?.post;
    expect(send?.description).toContain('`document`, `sticker`, `location` or `contacts`) needs');
    expect(send?.description).toContain('WhatsApp decides whether a file can be a sticker');
    const sticker = (
      doc.components as unknown as {
        schemas: Record<
          string,
          { properties: object; required: string[]; additionalProperties: unknown }
        >;
      }
    ).schemas.SendSticker;
    expect(Object.keys(sticker?.properties ?? {}).sort()).toEqual(
      ['from', 'link', 'replyTo', 'to', 'type'].sort(),
    );
    expect([...(sticker?.required ?? [])].sort()).toEqual(['link', 'to', 'type']);
    expect(sticker?.additionalProperties).toBe(false);
  });
});

describe('templates with a photo, video or document header through the API (ADR-201)', () => {
  const templateId = '0192a1b2-0000-7000-8000-000000000001';
  const link = 'https://cdn.example.com/parcel.jpg';

  it('take the header’s file from an https link, for one number and for each of many', () => {
    expect(
      apiSendMessageSchema.parse({
        to: '+919876543210',
        templateId,
        headerMedia: { link: ` ${link} ` },
      }),
    ).toEqual({
      to: '+919876543210',
      templateId,
      variables: { header: [], body: [], buttons: [] },
      headerMedia: { link },
    });
    expect(apiSendMessageSchema.parse({ to: '+919876543210', templateId })).not.toHaveProperty(
      'headerMedia',
    );
    for (const headerMedia of [
      { link: 'http://cdn.example.com/parcel.jpg' },
      { link: 'https://user:secret@cdn.example.com/parcel.jpg' },
      { link: `https://cdn.example.com/${'a'.repeat(API_LIMITS.mediaLinkLength)}` },
      { link, caption: 'Your parcel' },
      { link, filename: 'parcel.pdf' },
      { id: '1003383421387256' },
      {},
      link,
    ]) {
      expect(
        apiSendMessageSchema.safeParse({ to: '+919876543210', templateId, headerMedia }).success,
        JSON.stringify(headerMedia).slice(0, 80),
      ).toBe(false);
    }
    const many = apiSendManyTemplatesSchema.parse({
      templateId,
      messages: [
        { to: '+919811100001', headerMedia: { link } },
        { to: '+919811100002', headerMedia: { link: 'https://cdn.example.com/other.jpg' } },
      ],
    });
    expect(many.messages.map((m) => m.headerMedia?.link)).toEqual([
      link,
      'https://cdn.example.com/other.jpg',
    ]);
    expect(
      apiSendManyTemplatesSchema.safeParse({
        templateId,
        headerMedia: { link },
        messages: [{ to: '+919811100001' }],
      }).success,
    ).toBe(false);
    expect(
      apiSendManyTemplatesSchema.safeParse({
        templateId,
        messages: [{ to: '+919811100001', headerMedia: { link: 'ftp://cdn.example.com/a.jpg' } }],
      }).success,
    ).toBe(false);
  });

  it('are described: the list names the file, a send gives it, each send of many its own', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const paths = doc.paths as unknown as Record<string, Record<string, { description: string }>>;
    expect(paths['/templates']?.get?.description).toContain(
      'for a header that is a photo, a video or a document, which file a send gives (`headerMedia`)',
    );
    for (const words of [
      'A template whose header is a photo, a video or a document (its `headerMedia` in GET /templates) needs the file in `headerMedia`',
      'Documents must be PDF files.',
      'HyFib neither fetches nor keeps the file, and stores the link with the message.',
      'Other templates take no file (422, `headerMedia`).',
    ]) {
      expect(paths['/messages']?.post?.description).toContain(words);
    }
    expect(paths['/messages/send-many']?.post?.description).toContain(
      'a header file missing or given when the template takes none (422, naming the place, as `messages.3.variables`, `messages.3.variables.buttons.0` or `messages.3.headerMedia`)',
    );
    const schemas = (
      doc.components as unknown as {
        schemas: Record<
          string,
          { properties: Record<string, Record<string, unknown>>; required: string[] }
        >;
      }
    ).schemas;
    expect(schemas.Template?.properties.headerMedia).toMatchObject({
      anyOf: [{ type: 'string', enum: ['image', 'video', 'document'] }, { type: 'null' }],
    });
    expect(schemas.Template?.required).toContain('headerMedia');
    expect(schemas.SendTemplate?.properties.headerMedia).toMatchObject({
      type: 'object',
      properties: { link: { type: 'string', maxLength: API_LIMITS.mediaLinkLength } },
      required: ['link'],
      additionalProperties: false,
    });
    expect(schemas.SendTemplate?.required).toEqual(['to', 'templateId']);
    const items = (
      schemas.SendManyTemplates?.properties.messages as {
        items: { properties: Record<string, unknown>; required: string[] };
      }
    ).items;
    expect(Object.keys(items.properties)).toEqual(['to', 'variables', 'headerMedia']);
    expect(items.required).toEqual(['to']);
  });
});

describe('templates whose website buttons’ links end with a value, through the API (ADR-228)', () => {
  const templateId = '0192a1b2-0000-7000-8000-000000000001';

  it('take the ends of the links in `variables.buttons`, at most two, each filled in', () => {
    expect(
      apiSendMessageSchema.parse({
        to: '+919876543210',
        templateId,
        variables: { body: ['Asha'], buttons: [' A-1 '] },
      }).variables,
    ).toEqual({ header: [], body: ['Asha'], buttons: ['A-1'] });
    for (const buttons of [['a', 'b', 'c'], [''], [' '], 'A-1', [1], ['x'.repeat(1001)]]) {
      expect(
        apiSendMessageSchema.safeParse({ to: '+919876543210', templateId, variables: { buttons } })
          .success,
        JSON.stringify(buttons).slice(0, 40),
      ).toBe(false);
    }
    expect(
      apiSendManyTemplatesSchema.parse({
        templateId,
        messages: [{ to: '+919811100001', variables: { buttons: ['A-1', 'B-2'] } }],
      }).messages[0]?.variables.buttons,
    ).toEqual(['A-1', 'B-2']);
  });

  it('are described: the list names the links, a send gives their ends', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const paths = doc.paths as unknown as Record<string, Record<string, { description: string }>>;
    expect(paths['/templates']?.get?.description).toContain(
      'and the website buttons whose link ends with a value a send gives (`links`)',
    );
    expect(paths['/messages']?.post?.description).toContain(
      'A template whose website buttons’ links end with a value (its `links` in GET /templates) needs the end of each link in `variables.buttons`, in the order of `links`: it replaces the link’s {{1}}, holds no spaces and cannot change the website the button opens (422, naming the value, as `variables.buttons.0`).',
    );
    const schemas = (
      doc.components as unknown as {
        schemas: Record<
          string,
          { properties: Record<string, Record<string, unknown>>; required: string[] }
        >;
      }
    ).schemas;
    expect(schemas.Template?.properties.links).toMatchObject({
      type: 'array',
      items: {
        type: 'object',
        properties: { button: { type: 'string' }, url: { type: 'string' } },
        required: ['button', 'url'],
      },
    });
    expect(schemas.Template?.required).toContain('links');
    expect(schemas.Template?.properties.variables).toMatchObject({
      properties: { buttons: { type: 'integer' } },
      required: ['header', 'body', 'buttons'],
    });
    expect(schemas.SendTemplate?.properties.variables).toMatchObject({
      properties: {
        buttons: {
          type: 'array',
          maxItems: 2,
          items: { type: 'string', minLength: 1, maxLength: 1000 },
        },
      },
      additionalProperties: false,
    });
  });
});

describe('submitting campaign drafts through the API (ADR-202)', () => {
  const ctx = (scopes: string[], status = 'active', planScopes: string[] | null = null) =>
    ({
      tenant: { id: 't', status },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: planScopes ? new Set(planScopes) : null,
    }) as unknown as ApiContext;
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'done',
      (error: unknown) => (isAppError(error) ? error.code : String(error)),
    );
  const id = '0190a000-0000-7000-8000-000000000003';

  it("take the draft's version as read, and nothing else", () => {
    expect(apiSubmitCampaignSchema.parse({ expectedVersion: 4 })).toEqual({ expectedVersion: 4 });
    expect(apiSubmitCampaignSchema.parse({ expectedVersion: 0 })).toEqual({ expectedVersion: 0 });
    for (const body of [
      {},
      { expectedVersion: -1 },
      { expectedVersion: 1.5 },
      { expectedVersion: '4' },
      { expectedVersion: 4, approve: true },
      { expectedVersion: 4, status: 'scheduled' },
      null,
    ]) {
      expect(apiSubmitCampaignSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('are refused before anything is read: without the scope, outside the plan, while the company is not active, a bad id, and no version', async () => {
    const body = { expectedVersion: 3 };
    // Stopping, resuming or reading campaigns submits nothing.
    for (const scopes of [['campaigns.read'], ['campaigns.stop', 'campaigns.resume']]) {
      expect(await code(apiSubmitCampaign({} as never, ctx(scopes), id, body))).toBe('forbidden');
    }
    await expect(apiSubmitCampaign({} as never, ctx(['campaigns.read']), id, body)).rejects.toThrow(
      'This API key does not have the campaigns.write scope.',
    );
    await expect(
      apiSubmitCampaign(
        {} as never,
        ctx(['campaigns.write'], 'active', ['campaigns.read']),
        id,
        body,
      ),
    ).rejects.toMatchObject({ code: 'forbidden', details: { apiReason: 'not_in_plan' } });
    for (const status of ['suspended', 'restricted']) {
      expect(
        await code(apiSubmitCampaign({} as never, ctx(['campaigns.write'], status), id, body)),
      ).toBe('tenant_suspended');
    }
    expect(
      await code(apiSubmitCampaign({} as never, ctx(['campaigns.write']), 'not-an-id', body)),
    ).toBe('not_found');
    expect(await code(apiSubmitCampaign({} as never, ctx(['campaigns.write']), id, {}))).toBe(
      'validation_failed',
    );
  });

  it("are described: members' checks, a member's approval always, the version and safe retries", () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const op = (
      doc.paths as unknown as Record<
        string,
        Record<
          string,
          {
            operationId: string;
            description: string;
            requestBody: unknown;
            responses: Record<string, { content?: unknown }>;
          }
        >
      >
    )['/campaigns/{id}/submit']?.post;
    expect(op?.operationId).toBe('submitCampaign');
    expect(op?.requestBody).toEqual({
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitCampaign' } } },
    });
    expect(op?.responses['200']?.content).toEqual({
      'application/json': {
        schema: {
          type: 'object',
          properties: { data: { $ref: '#/components/schemas/Campaign' } },
          required: ['data'],
        },
      },
    });
    expect(Object.keys(op?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '403', '404', '409', '412', '422', '423']),
    );
    for (const words of [
      'Scope: `campaigns.write`.',
      'it must be at `expectedVersion` and pass the checks its review lists (GET /campaigns/{id}/review)',
      "It then waits for a member's approval (`pending_approval`), whatever the company's settings: a key never starts a campaign.",
      'A member who may approve and send campaigns approves it in the app, and it sends under their authority',
      'A draft changed since you read it is refused with 409 and stays a draft',
      'refused with 412, naming the first thing to change',
      'A campaign this key submitted is answered as it is, so a retry changes nothing',
    ]) {
      expect(op?.description).toContain(words);
    }
    const schemas = (
      doc.components as unknown as {
        schemas: Record<
          string,
          {
            properties: Record<string, { description?: string }>;
            required: string[];
            additionalProperties: unknown;
          }
        >;
      }
    ).schemas;
    expect(Object.keys(schemas.SubmitCampaign?.properties ?? {})).toEqual(['expectedVersion']);
    expect(schemas.SubmitCampaign?.required).toEqual(['expectedVersion']);
    expect(schemas.SubmitCampaign?.additionalProperties).toBe(false);
    expect(schemas.CampaignReview?.properties.approvalRequired?.description).toContain(
      "A key's submission (POST /campaigns/{id}/submit) always waits for a member's approval.",
    );
    expect(schemas.CampaignReview?.properties.version?.description).toContain(
      'POST /campaigns/{id}/submit',
    );
    expect(API_ROUTES).toContainEqual(['post', '/campaigns/{id}/submit']);
  });
});

describe('withdrawing campaign submissions through the API (ADR-203)', () => {
  const ctx = (scopes: string[], status = 'active', planScopes: string[] | null = null) =>
    ({
      tenant: { id: 't', status },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: planScopes ? new Set(planScopes) : null,
    }) as unknown as ApiContext;
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'done',
      (error: unknown) => (isAppError(error) ? error.code : String(error)),
    );
  const id = '0190a000-0000-7000-8000-000000000003';

  it('are refused before anything is read: without the scope, outside the plan, while the company is not active, and a bad id', async () => {
    for (const scopes of [['campaigns.read'], ['campaigns.stop', 'campaigns.resume']]) {
      expect(await code(apiWithdrawCampaign({} as never, ctx(scopes), id))).toBe('forbidden');
    }
    await expect(apiWithdrawCampaign({} as never, ctx(['campaigns.read']), id)).rejects.toThrow(
      'This API key does not have the campaigns.write scope.',
    );
    await expect(
      apiWithdrawCampaign({} as never, ctx(['campaigns.write'], 'active', ['campaigns.read']), id),
    ).rejects.toMatchObject({ code: 'forbidden', details: { apiReason: 'not_in_plan' } });
    for (const status of ['suspended', 'restricted']) {
      expect(
        await code(apiWithdrawCampaign({} as never, ctx(['campaigns.write'], status), id)),
      ).toBe('tenant_suspended');
    }
    expect(
      await code(apiWithdrawCampaign({} as never, ctx(['campaigns.write']), 'not-an-id')),
    ).toBe('not_found');
  });

  it('are described: the key that submitted it only, a draft again at a new version, safe retries', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const paths = doc.paths as unknown as Record<
      string,
      Record<
        string,
        {
          operationId: string;
          description: string;
          requestBody?: unknown;
          responses: Record<string, { content?: unknown }>;
        }
      >
    >;
    const op = paths['/campaigns/{id}/withdraw']?.post;
    expect(op?.operationId).toBe('withdrawCampaign');
    expect(op?.requestBody).toBeUndefined();
    expect(op?.responses['200']?.content).toEqual({
      'application/json': {
        schema: {
          type: 'object',
          properties: { data: { $ref: '#/components/schemas/Campaign' } },
          required: ['data'],
        },
      },
    });
    expect(Object.keys(op?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '403', '404', '409', '423']),
    );
    for (const words of [
      'Scope: `campaigns.write`.',
      "Takes a campaign this key submitted (POST /campaigns/{id}/submit) back to a draft while it waits for a member's approval",
      'its audience is dropped (nothing was sent), its version goes up',
      'A draft is answered as it is, so a retry changes nothing.',
      'A submission a member or another key made is refused with 403 (members withdraw it in the app)',
      'a campaign that no longer waits for approval with 409, naming its status',
    ]) {
      expect(op?.description).toContain(words);
    }
    expect(paths['/campaigns/{id}/submit']?.post?.description).toContain(
      'or the key withdraws it (POST /campaigns/{id}/withdraw), and it is a draft again at a new version',
    );
    expect(API_SCOPE_INFO['campaigns.write'].description).toContain(
      "submit drafts, which then always wait for a member's approval, and take back what it submitted;",
    );
    expect(API_ROUTES).toContainEqual(['post', '/campaigns/{id}/withdraw']);
  });
});

describe('reading saved segments through the API (ADR-206)', () => {
  const ctx = (scopes: string[], status = 'active', planScopes: string[] | null = null) =>
    ({
      tenant: { id: 't', status },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: planScopes ? new Set(planScopes) : null,
    }) as unknown as ApiContext;
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'done',
      (error: unknown) => (isAppError(error) ? error.code : String(error)),
    );
  const id = '0190a000-0000-7000-8000-000000000004';
  // A database that is reached only once every check before it has passed.
  const reached = {
    db: {
      run: () => Promise.reject(new Error('the database was reached')),
    },
  } as never;

  it('are refused before anything is read: without the scope, outside the plan, a bad id or a bad page; a suspended company still reads', async () => {
    for (const scopes of [['campaigns.write'], ['contacts.read', 'campaigns.stop']]) {
      expect(await code(apiListSegments(reached, ctx(scopes), {}))).toBe('forbidden');
      expect(await code(apiGetSegment(reached, ctx(scopes), id))).toBe('forbidden');
    }
    await expect(apiListSegments(reached, ctx(['campaigns.write']), {})).rejects.toThrow(
      'This API key does not have the campaigns.read scope.',
    );
    await expect(
      apiGetSegment(reached, ctx(['campaigns.read'], 'active', ['contacts.read']), id),
    ).rejects.toMatchObject({ code: 'forbidden', details: { apiReason: 'not_in_plan' } });
    expect(await code(apiGetSegment(reached, ctx(['campaigns.read']), 'not-an-id'))).toBe(
      'not_found',
    );
    for (const query of [
      { limit: '0' },
      { limit: '101' },
      { cursor: 'not-a-cursor' },
      { page: '2' },
    ]) {
      expect(await code(apiListSegments(reached, ctx(['campaigns.read']), query))).toBe(
        'validation_failed',
      );
    }
    for (const status of ['active', 'suspended', 'restricted']) {
      await expect(apiListSegments(reached, ctx(['campaigns.read'], status), {})).rejects.toThrow(
        'the database was reached',
      );
      await expect(apiGetSegment(reached, ctx(['campaigns.read'], status), id)).rejects.toThrow(
        'the database was reached',
      );
    }
  });

  it('are described: newest first with their conditions and problem, one counted now, counts only', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const paths = doc.paths as unknown as Record<
      string,
      Record<
        string,
        {
          operationId: string;
          description: string;
          parameters: { name?: string; $ref?: string }[];
          responses: Record<string, { content?: unknown }>;
        }
      >
    >;
    const list = paths['/segments']?.get;
    expect(list?.operationId).toBe('listSegments');
    expect(list?.parameters.map((p) => p.name)).toEqual(['limit', 'cursor']);
    expect(list?.responses['200']?.content).toMatchObject({
      'application/json': {
        schema: { properties: { data: { items: { $ref: '#/components/schemas/Segment' } } } },
      },
    });
    for (const words of [
      'Scope: `campaigns.read`.',
      "The company's saved segments that are not archived, as members' Segments page lists them",
      "conditions in the words POST /contacts/search and drafts' audiences take",
      "A draft's audience takes a segment by its id (`segmentId`).",
    ]) {
      expect(list?.description).toContain(words);
    }
    const one = paths['/segments/{id}']?.get;
    expect(one?.operationId).toBe('getSegment');
    expect(one?.parameters).toEqual([{ $ref: '#/components/parameters/Id' }]);
    expect(one?.responses['200']?.content).toEqual({
      'application/json': {
        schema: {
          type: 'object',
          properties: { data: { $ref: '#/components/schemas/SegmentWithCount' } },
          required: ['data'],
        },
      },
    });
    expect(Object.keys(one?.responses ?? {})).toEqual(expect.arrayContaining(['200', '404']));
    for (const words of [
      'how many contacts match it now, erased contacts left out',
      "Dates are read in the company's time zone.",
      'Counts only: POST /contacts/search with the same conditions finds the contacts',
      "An archived segment and another company's are not found.",
    ]) {
      expect(one?.description).toContain(words);
    }
    const schemas = (
      doc.components as unknown as { schemas: Record<string, { properties: object }> }
    ).schemas;
    expect(Object.keys(schemas.Segment?.properties ?? {})).toEqual([
      'id',
      'name',
      'definition',
      'problem',
      'version',
      'createdAt',
      'updatedAt',
    ]);
    expect(Object.keys(schemas.SegmentWithCount?.properties ?? {})).toEqual([
      'id',
      'name',
      'definition',
      'problem',
      'version',
      'createdAt',
      'updatedAt',
      'count',
    ]);
    expect(API_SCOPE_INFO['campaigns.read'].description).toContain(
      "Also read the company's saved segments, their conditions and how many contacts each matches.",
    );
    expect(API_ROUTES).toEqual(
      expect.arrayContaining([
        ['get', '/segments'],
        ['get', '/segments/{id}'],
      ]),
    );
  });
});

describe('writing saved segments through the API (ADR-207)', () => {
  const ctx = (scopes: string[], status = 'active', planScopes: string[] | null = null) =>
    ({
      tenant: { id: 't', status },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: planScopes ? new Set(planScopes) : null,
    }) as unknown as ApiContext;
  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => ({ code: 'done', paths: [] as string[], message: '' }),
      (error: unknown) =>
        isAppError(error)
          ? {
              code: error.code,
              paths: (error.issues ?? []).map((i) => i.path),
              message: error.publicMessage,
            }
          : { code: String(error), paths: [], message: '' },
    );
  const id = '0190a000-0000-7000-8000-000000000005';
  const reached = {
    db: { run: () => Promise.reject(new Error('the database was reached')) },
    clock: { now: () => new Date() },
  } as never;
  const writer = ctx(['campaigns.write']);
  const vip = { match: 'all', conditions: [{ type: 'tag', op: 'has', tag: 'vip' }] };

  it('are refused before anything is read: without the scope, outside the plan, while the company is not active, a bad id or a bad body', async () => {
    const all = (c: ApiContext) => [
      apiCreateSegment(reached, c, { name: 'VIP', definition: vip }, null),
      apiUpdateSegment(reached, c, id, { name: 'VIP' }),
      apiArchiveSegment(reached, c, id),
    ];
    for (const attempt of all(ctx(['campaigns.read', 'contacts.write']))) {
      expect(await refusal(attempt)).toMatchObject({
        code: 'forbidden',
        message: 'This API key does not have the campaigns.write scope.',
      });
    }
    for (const attempt of all(ctx(['campaigns.write'], 'active', ['campaigns.read']))) {
      await expect(attempt).rejects.toMatchObject({ details: { apiReason: 'not_in_plan' } });
    }
    for (const status of ['suspended', 'restricted']) {
      for (const attempt of all(ctx(['campaigns.write'], status))) {
        expect((await refusal(attempt)).code).toBe('tenant_suspended');
      }
    }
    for (const attempt of [
      apiUpdateSegment(reached, writer, 'not-an-id', { name: 'VIP' }),
      apiArchiveSegment(reached, writer, 'not-an-id'),
    ]) {
      expect((await refusal(attempt)).code).toBe('not_found');
    }
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      type: 'tag',
      op: 'has',
      tag: `t${i}`,
    }));
    for (const [body, paths] of [
      [{}, ['name', 'definition']],
      [{ name: ' ', definition: vip }, ['name']],
      [{ name: 'N'.repeat(81), definition: vip }, ['name']],
      [{ name: 'VIP', definition: { conditions: [] } }, ['definition.conditions']],
      [{ name: 'VIP', definition: { conditions: tooMany } }, ['definition.conditions']],
      [{ name: 'VIP', definition: { ...vip, extra: true } }, ['definition']],
      [
        {
          name: 'VIP',
          definition: { conditions: [{ type: 'group', match: 'any', conditions: vip.conditions }] },
        },
        ['definition.conditions.0.type'],
      ],
      [{ name: 'VIP', definition: vip, owner: 'me' }, ['']],
    ] as const) {
      expect(
        await refusal(apiCreateSegment(reached, writer, body, null)),
        JSON.stringify(body),
      ).toMatchObject({ code: 'validation_failed', paths });
    }
    expect(await refusal(apiUpdateSegment(reached, writer, id, { expectedVersion: 1 }))).toEqual({
      code: 'validation_failed',
      paths: [''],
      message: 'Give a name or conditions to change',
    });
    expect(
      (await refusal(apiUpdateSegment(reached, writer, id, { expectedVersion: -1, name: 'x' })))
        .paths,
    ).toEqual(['expectedVersion']);
    // A good request reaches the database.
    for (const attempt of all(writer)) {
      await expect(attempt).rejects.toThrow('the database was reached');
    }
  });

  it('refuse a name another segment has with words that say so, members included', () => {
    const taken = segmentNameRefusal(
      new AppError('conflict', 'A record with the same unique value already exists.', {
        details: { constraint: 'segments_name_uq' },
      }),
    );
    expect(taken).toMatchObject({
      code: 'conflict',
      publicMessage: 'Another segment already has this name.',
      issues: [{ path: 'name', message: SEGMENT_NAME_TAKEN }],
    });
    const other = new AppError('conflict', 'A record with the same unique value already exists.', {
      details: { constraint: 'campaigns_pkey' },
    });
    expect(segmentNameRefusal(other)).toBe(other);
    const unexpected = new Error('connection lost');
    expect(segmentNameRefusal(unexpected)).toBe(unexpected);
  });

  it('are described: checked as searches are, a taken name refused, archiving answered as it is', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const paths = doc.paths as unknown as Record<
      string,
      Record<
        string,
        {
          operationId: string;
          description: string;
          parameters: { $ref?: string }[];
          requestBody?: { content: unknown };
          responses: Record<string, { content?: unknown }>;
        }
      >
    >;
    const create = paths['/segments']?.post;
    expect(create?.operationId).toBe('createSegment');
    expect(create?.parameters).toEqual([
      { $ref: '#/components/parameters/IdempotencyKeyOptional' },
    ]);
    expect(create?.requestBody?.content).toEqual({
      'application/json': { schema: { $ref: '#/components/schemas/CreateSegment' } },
    });
    expect(Object.keys(create?.responses ?? {})).toEqual(
      expect.arrayContaining(['201', '409', '422', '423']),
    );
    for (const words of [
      'Scope: `campaigns.write`.',
      'each condition is checked as POST /contacts/search checks it',
      'naming the condition, like `definition.conditions.1.key`',
      'A name another segment of the company has, whatever its case, is refused with 409.',
      'One segment per `Idempotency-Key`',
    ]) {
      expect(create?.description).toContain(words);
    }
    const update = paths['/segments/{id}']?.patch;
    expect(update?.operationId).toBe('updateSegment');
    expect(update?.requestBody?.content).toEqual({
      'application/json': { schema: { $ref: '#/components/schemas/UpdateSegment' } },
    });
    for (const words of [
      'what is left out stays, new conditions replace its conditions',
      'With `expectedVersion`, a segment changed since you read it is refused with 409',
      'Campaigns already submitted keep the audience they were submitted with',
    ]) {
      expect(update?.description).toContain(words);
    }
    const archive = paths['/segments/{id}']?.delete;
    expect(archive?.operationId).toBe('archiveSegment');
    expect(archive?.requestBody).toBeUndefined();
    for (const words of [
      'it leaves the lists and reads, and its name is free again',
      'A segment already archived is answered as it is, so a retry is harmless',
    ]) {
      expect(archive?.description).toContain(words);
    }
    const schemas = (
      doc.components as unknown as { schemas: Record<string, { properties: object }> }
    ).schemas;
    expect(Object.keys(schemas.CreateSegment?.properties ?? {})).toEqual(['name', 'definition']);
    expect(Object.keys(schemas.UpdateSegment?.properties ?? {})).toEqual([
      'expectedVersion',
      'name',
      'definition',
    ]);
    expect(API_SCOPE_INFO['campaigns.write'].description).toContain(
      "Also create, change and archive the company's saved segments.",
    );
    expect(API_ROUTES).toEqual(
      expect.arrayContaining([
        ['post', '/segments'],
        ['patch', '/segments/{id}'],
        ['delete', '/segments/{id}'],
      ]),
    );
  });
});

describe("listing a segment's contacts through the API (ADR-208)", () => {
  const ctx = (scopes: string[], status = 'active', planScopes: string[] | null = null) =>
    ({
      tenant: { id: 't', status },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: planScopes ? new Set(planScopes) : null,
    }) as unknown as ApiContext;
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'done',
      (error: unknown) => (isAppError(error) ? error.code : String(error)),
    );
  const id = '0190a000-0000-7000-8000-000000000006';
  const reached = {
    db: { run: () => Promise.reject(new Error('the database was reached')) },
  } as never;
  const both = ['campaigns.read', 'contacts.read'];

  it('is refused before anything is read: without either scope, outside the plan, a bad id or a bad page; a suspended company still reads', async () => {
    for (const [scopes, missing] of [
      [['contacts.read', 'campaigns.write'], 'campaigns.read'],
      [['campaigns.read', 'contacts.write'], 'contacts.read'],
    ] as const) {
      await expect(apiListSegmentContacts(reached, ctx([...scopes]), id, {})).rejects.toThrow(
        `This API key does not have the ${missing} scope.`,
      );
    }
    await expect(
      apiListSegmentContacts(reached, ctx(both, 'active', ['campaigns.read']), id, {}),
    ).rejects.toMatchObject({ code: 'forbidden', details: { apiReason: 'not_in_plan' } });
    expect(await code(apiListSegmentContacts(reached, ctx(both), 'not-an-id', {}))).toBe(
      'not_found',
    );
    for (const query of [{ limit: '0' }, { limit: '101' }, { cursor: 'nope' }, { tag: 'vip' }]) {
      expect(await code(apiListSegmentContacts(reached, ctx(both), id, query))).toBe(
        'validation_failed',
      );
    }
    for (const status of ['active', 'suspended', 'restricted']) {
      await expect(apiListSegmentContacts(reached, ctx(both, status), id, {})).rejects.toThrow(
        'the database was reached',
      );
    }
  });

  it('is described: both scopes, pages as searches give them, a segment with a problem refused', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const op = (
      doc.paths as unknown as Record<
        string,
        Record<
          string,
          {
            operationId: string;
            description: string;
            parameters: { name?: string; $ref?: string }[];
            responses: Record<string, { content?: unknown }>;
          }
        >
      >
    )['/segments/{id}/contacts']?.get;
    expect(op?.operationId).toBe('listSegmentContacts');
    expect(op?.parameters.map((p) => p.$ref ?? p.name)).toEqual([
      '#/components/parameters/Id',
      'limit',
      'cursor',
    ]);
    expect(op?.responses['200']?.content).toMatchObject({
      'application/json': {
        schema: { properties: { data: { items: { $ref: '#/components/schemas/Contact' } } } },
      },
    });
    expect(Object.keys(op?.responses ?? {})).toEqual(expect.arrayContaining(['404', '412']));
    for (const words of [
      'Scope: `campaigns.read`.',
      'Also needs `contacts.read`, `conversations.read` for a segment with a `last_message` condition and `orders.read` for one with an `orders` or `spend` condition',
      'newest first, erased contacts left out, pages that never skip or repeat a contact',
      'Each page reads at most 2,000 of the company',
      'A segment with a `problem` (GET /segments/{id}) is refused with 412 saying it',
    ]) {
      expect(op?.description).toContain(words);
    }
    expect(API_SCOPE_INFO['campaigns.read'].description).toContain(
      'With contacts read as well, list the contacts each segment holds.',
    );
    expect(API_ROUTES).toContainEqual(['get', '/segments/{id}/contacts']);
  });
});

describe('merging contacts through the API (ADR-227)', () => {
  const KEEP = '0192f3a4-5b6c-7d8e-9f00-112233445566';
  const MERGE = '0192f3a4-5b6c-7d8e-9f00-112233445577';
  const ctx = (scopes: string[], status = 'active') =>
    ({
      tenant: { id: 't', status },
      key: { id: 'k', scopes: new Set(scopes) },
      planScopes: null,
    }) as unknown as ApiContext;
  const unreachable = {
    db: {
      run: () => {
        throw new Error('the database was reached');
      },
    },
    clock: { now: () => new Date('2026-10-06T00:00:00Z') },
  } as unknown as Parameters<typeof apiMergeContacts>[0];
  const merge = (c: ApiContext, id: string, body: unknown) =>
    apiMergeContacts(unreachable, c, id, body, null);

  it('needs the contacts.merge scope, an active company and two contact ids, before the database', async () => {
    await expect(
      merge(ctx(['contacts.read', 'contacts.write']), KEEP, { mergeContactId: MERGE }),
    ).rejects.toMatchObject({
      code: 'forbidden',
      publicMessage: 'This API key does not have the contacts.merge scope.',
    });
    await expect(
      merge(ctx(['contacts.merge'], 'suspended'), KEEP, { mergeContactId: MERGE }),
    ).rejects.toMatchObject({ code: 'tenant_suspended' });
    await expect(
      merge(ctx(['contacts.merge']), 'nope', { mergeContactId: MERGE }),
    ).rejects.toMatchObject({ code: 'not_found' });
    for (const body of [{}, { mergeContactId: 'nope' }, { mergeContactId: MERGE, keep: KEEP }]) {
      await expect(
        merge(ctx(['contacts.merge']), KEEP, body),
        JSON.stringify(body),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    }
    await expect(merge(ctx(['contacts.merge']), KEEP, { mergeContactId: MERGE })).rejects.toThrow(
      'the database was reached',
    );
    expect(apiMergeContactsSchema.parse({ mergeContactId: MERGE })).toEqual({
      mergeContactId: MERGE,
    });
  });

  it('is described with its scope, an optional Idempotency-Key, what it answers and its refusals', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const op = (
      doc.paths as unknown as Record<
        string,
        Record<
          string,
          {
            operationId: string;
            description: string;
            parameters: { $ref: string }[];
            responses: Record<string, unknown>;
          }
        >
      >
    )['/contacts/{id}/merge']?.post;
    expect(op?.operationId).toBe('mergeContacts');
    expect(op?.description).toContain('`contacts.merge`');
    expect(op?.description).toContain('which cannot be undone');
    expect(op?.parameters.map((p) => p.$ref)).toEqual([
      '#/components/parameters/Id',
      '#/components/parameters/IdempotencyKeyOptional',
    ]);
    expect(Object.keys(op?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '404', '409', '412', '422', '423']),
    );
    const schemas = doc.components.schemas as Record<
      string,
      { required?: string[]; additionalProperties?: unknown }
    >;
    expect(schemas.ContactMerge?.required).toEqual(['mergeContactId']);
    expect(schemas.ContactMerge?.additionalProperties).toBe(false);
    expect(schemas.ContactMergeResult?.required).toEqual(['contact', 'mergedContactId', 'moved']);
    expect(API_ROUTES).toEqual(expect.arrayContaining([['post', '/contacts/{id}/merge']]));
  });
});
