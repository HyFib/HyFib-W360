import { describe, expect, it } from 'vitest';
import { AppError, jsonbSize } from '@w360/core';
import { AUTOMATION_END_REASONS, WEBHOOK_EVENT_TYPES } from '@w360/db';
import {
  WEBHOOK_CAMPAIGN_STATUSES,
  WEBHOOK_CONSENT_CHANGES,
  WEBHOOK_CONTACT_PARTS,
  WEBHOOK_CONTACT_SOURCES,
  WEBHOOK_CONVERSATION_STATUSES,
  WEBHOOK_CRM_CHANGE_MAKERS,
  WEBHOOK_DEAL_DETAILS,
  WEBHOOK_DEAL_STATUSES,
  WEBHOOK_LIMITS,
  WEBHOOK_MESSAGE_SENDERS,
  WEBHOOK_MESSAGE_STATUSES,
  WEBHOOK_ORDER_CHANGE_MAKERS,
  WEBHOOK_ORDER_STATUSES,
  WEBHOOK_PAYMENT_LINK_STATUSES,
  WEBHOOK_COD_ANSWERS,
  WEBHOOK_ORDER_MESSAGE_EVENTS,
  WEBHOOK_ORDER_MESSAGE_SKIP_REASONS,
  WEBHOOK_CART_REMINDER_SKIP_REASONS,
  WEBHOOK_RECEIVED_MESSAGE_TYPES,
  WEBHOOK_RUN_END_STATUSES,
  WEBHOOK_RUN_STEP_NODE_TYPES,
  WEBHOOK_RUN_STEP_OUTCOMES,
  WEBHOOK_RUN_TRIGGERS,
  WEBHOOK_SURVEY_SCORES,
  WEBHOOK_TASK_DETAILS,
  WEBHOOK_TASK_STATUSES,
  WEBHOOK_TEMPLATE_STATUSES,
} from '../webhooks/model';
import { storeIdempotentResponse } from './idempotency';
import { API_LIMITS } from './model';
import { buildOpenApiDocument } from './openapi';
import type { ApiWebhookEndpoint } from './webhook-endpoints';

/** A transaction that records what `storeIdempotentResponse` writes. */
function writing() {
  const writes: unknown[] = [];
  const tx = {
    update: () => ({
      set: (values: unknown) => ({
        where: async () => {
          writes.push(values);
        },
      }),
    }),
  };
  return { tx: tx as never, writes };
}

const ctx = { tenant: { id: '0192f3a4-5b6c-7d8e-9f00-112233445566' } } as never;

describe('answers kept with an Idempotency-Key (ADR-339)', () => {
  it('keeps an answer of up to 256 KiB as jsonb and refuses a larger one with its reason, writing nothing', async () => {
    expect(API_LIMITS.idempotentResponseBytes).toBe(262_144);
    // {"data": <n characters>} takes 23 bytes and the characters as jsonb, at most.
    expect(jsonbSize({ data: 'x' })).toBe(24);
    const { tx, writes } = writing();
    await storeIdempotentResponse(tx, ctx, 'claim-1', {
      status: 201,
      body: { data: 'x'.repeat(262_121) },
    });
    expect(writes).toEqual([{ statusCode: 201, response: { data: 'x'.repeat(262_121) } }]);
    const refused = await storeIdempotentResponse(tx, ctx, 'claim-2', {
      status: 201,
      body: { data: 'x'.repeat(262_122) },
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AppError);
    expect(refused).toMatchObject({
      code: 'validation_failed',
      message:
        'The answer to this request takes more than 256 KiB, too much to keep with its Idempotency-Key, so nothing was done. Where the key is optional, send it again without one.',
      details: { apiReason: 'idempotency_response_too_large' },
    });
    expect(writes).toHaveLength(1);
  });

  it('is described with the keys, as happening only where the key is optional', () => {
    const { description } = buildOpenApiDocument('https://app.example.com/api/v1').info;
    expect(description).toContain(
      'holds up to 256 KiB: a request whose response would be larger is refused with 422 and reason `idempotency_response_too_large`, and nothing is done. Only requests whose key is optional can give a response that large, so send such a request again without a key.',
    );
    // POST /messages, whose key is required, is not told to go without one.
    expect(description).toMatch(/^POST \/messages needs [^\n]* responses are kept 24 hours\. /m);
    expect(description).not.toMatch(/^POST \/messages needs [^\n]*without/m);
  });

  it('fits the largest answer a webhook endpoint can give, every list full of three-byte text, in half of it', () => {
    // Text of n characters of three bytes each in UTF-8 (Tamil), as limits count characters.
    const text = (n: number, i = 0) => `${'க'.repeat(n - 4)}${String(i).padStart(4, '0')}`;
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `0192f3a4-5b6c-7d8e-9f00-${String(i).padStart(12, '0')}`);
    const tags = (n: number) => Array.from({ length: n }, (_, i) => text(40, i));
    const at = '2026-10-09T10:00:00.000Z';
    // The field values hold 4,000 bytes as JSON in all, the most they can (ADR-332).
    const fieldValues = Array.from({ length: WEBHOOK_LIMITS.contactEventFieldValues }, (_, i) => ({
      key: `f${String(i).padStart(39, '0')}`,
      value: 'x'.repeat(16),
    }));
    expect(Buffer.byteLength(JSON.stringify(fieldValues))).toBeLessThanOrEqual(
      WEBHOOK_LIMITS.contactEventFieldValuesBytes + 100,
    );
    const endpoint = {
      id: ids(1)[0]!,
      url: `https://${'a'.repeat(WEBHOOK_LIMITS.urlLength - 8)}`,
      description: text(WEBHOOK_LIMITS.descriptionLength),
      events: [...WEBHOOK_EVENT_TYPES],
      status: 'disabled',
      disabledReason: 'failing',
      failingSince: at,
      lastSuccessAt: at,
      lastFailureAt: at,
      secretVersion: 2_147_483_647,
      previousSecretExpiresAt: at,
      headers: Array.from({ length: WEBHOOK_LIMITS.headers }, (_, i) => ({
        name: `X-${String(i).padStart(58, '0')}`,
      })),
      messageStatuses: [...WEBHOOK_MESSAGE_STATUSES],
      messageSenders: [...WEBHOOK_MESSAGE_SENDERS],
      messageApiKeyIds: ids(WEBHOOK_LIMITS.messageApiKeys),
      contactParts: [...WEBHOOK_CONTACT_PARTS],
      contactFieldKeys: Array.from(
        { length: WEBHOOK_LIMITS.contactFields },
        (_, i) => `k${String(i).padStart(39, '0')}`,
      ),
      automationIds: ids(WEBHOOK_LIMITS.automations),
      campaignStatuses: [...WEBHOOK_CAMPAIGN_STATUSES],
      orderStatuses: [...WEBHOOK_ORDER_STATUSES],
      paymentLinkStatuses: [...WEBHOOK_PAYMENT_LINK_STATUSES],
      codAnswers: [...WEBHOOK_COD_ANSWERS],
      storeIds: ids(WEBHOOK_LIMITS.stores),
      orderMessageEvents: [...WEBHOOK_ORDER_MESSAGE_EVENTS],
      orderMessageSkipReasons: [...WEBHOOK_ORDER_MESSAGE_SKIP_REASONS],
      cartReminderSkipReasons: [...WEBHOOK_CART_REMINDER_SKIP_REASONS],
      runStepOutcomes: [...WEBHOOK_RUN_STEP_OUTCOMES],
      runStepNodeTypes: [...WEBHOOK_RUN_STEP_NODE_TYPES],
      orderChangeMakers: [...WEBHOOK_ORDER_CHANGE_MAKERS],
      orderExcludedApiKeyIds: ids(WEBHOOK_LIMITS.orderExcludedApiKeys),
      paymentLinkApiKeyIds: ids(WEBHOOK_LIMITS.paymentLinkApiKeys),
      dealStatuses: [...WEBHOOK_DEAL_STATUSES],
      taskStatuses: [...WEBHOOK_TASK_STATUSES],
      dealDetails: [...WEBHOOK_DEAL_DETAILS],
      taskDetails: [...WEBHOOK_TASK_DETAILS],
      templateStatuses: [...WEBHOOK_TEMPLATE_STATUSES],
      conversationStatuses: [...WEBHOOK_CONVERSATION_STATUSES],
      runEndStatuses: [...WEBHOOK_RUN_END_STATUSES],
      runTriggers: [...WEBHOOK_RUN_TRIGGERS],
      runApiKeyIds: ids(WEBHOOK_LIMITS.runApiKeys),
      consentChanges: [...WEBHOOK_CONSENT_CHANGES],
      contactSources: [...WEBHOOK_CONTACT_SOURCES],
      messageTypes: [...WEBHOOK_RECEIVED_MESSAGE_TYPES],
      messageWords: Array.from({ length: WEBHOOK_LIMITS.messageWords }, (_, i) =>
        text(WEBHOOK_LIMITS.messageWordLength, i),
      ),
      runEndReasons: Object.values(AUTOMATION_END_REASONS).flat(),
      channelIds: ids(WEBHOOK_LIMITS.channels),
      teamIds: ids(WEBHOOK_LIMITS.teams),
      templateIds: ids(WEBHOOK_LIMITS.templates),
      campaignIds: ids(WEBHOOK_LIMITS.campaigns),
      pipelineIds: ids(WEBHOOK_LIMITS.pipelines),
      stageIds: ids(WEBHOOK_LIMITS.stages),
      ownerIds: ids(WEBHOOK_LIMITS.owners),
      taskAssigneeIds: ids(WEBHOOK_LIMITS.taskAssignees),
      taskPipelineIds: ids(WEBHOOK_LIMITS.taskPipelines),
      taskStageIds: ids(WEBHOOK_LIMITS.taskStages),
      taskDealOwnerIds: ids(WEBHOOK_LIMITS.taskDealOwners),
      notePipelineIds: ids(WEBHOOK_LIMITS.notePipelines),
      noteStageIds: ids(WEBHOOK_LIMITS.noteStages),
      noteDealOwnerIds: ids(WEBHOOK_LIMITS.noteDealOwners),
      crmChangeMakers: [...WEBHOOK_CRM_CHANGE_MAKERS],
      crmExcludedApiKeyIds: ids(WEBHOOK_LIMITS.crmExcludedApiKeys),
      surveyScores: [...WEBHOOK_SURVEY_SCORES],
      surveyAssigneeIds: ids(WEBHOOK_LIMITS.surveyAssignees),
      surveyTeamIds: ids(WEBHOOK_LIMITS.surveyTeams),
      surveyContactTags: tags(WEBHOOK_LIMITS.surveyContactTags),
      surveyConversationTags: tags(WEBHOOK_LIMITS.surveyConversationTags),
      contactEventTags: tags(WEBHOOK_LIMITS.contactEventTags),
      contactEventFieldValues: fieldValues,
      assigneeIds: ids(WEBHOOK_LIMITS.assignees),
      contactTags: tags(WEBHOOK_LIMITS.contactTags),
      conversationTags: tags(WEBHOOK_LIMITS.conversationTags),
      oauth: {
        tokenUrl: `https://${'o'.repeat(WEBHOOK_LIMITS.urlLength - 8)}`,
        clientId: text(WEBHOOK_LIMITS.oauthClientIdLength),
        scope: text(WEBHOOK_LIMITS.oauthScopeLength),
        clientAuthentication: 'client_secret_basic',
      },
      apiKeyId: ids(1)[0]!,
      createdAt: at,
      updatedAt: at,
    } satisfies ApiWebhookEndpoint;
    // As POST /webhook-endpoints and its rotate-secret keep it: the secret shown once is null.
    const kept = { data: { ...endpoint, secret: null } };
    const size = jsonbSize(kept);
    // Over the 64 KiB an answer was kept within before (0024), within half of the check now.
    expect(size).toBeGreaterThan(65_536);
    expect(size).toBeLessThan(API_LIMITS.idempotentResponseBytes / 2);
  });
});
