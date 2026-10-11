import { createHmac, randomBytes, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isAppError, jsonbSize, Keyring, sha256Hex } from '@w360/core';
import {
  ACTIVE_RUN_STATUSES,
  AUTOMATION_END_REASONS,
  AUTOMATION_RUN_STATUSES,
  AUTOMATION_STEP_OUTCOMES,
  CAMPAIGN_COMPLETION_REASONS,
  CAMPAIGN_PAUSE_REASONS,
  CAMPAIGN_STATUSES,
  CHANNEL_STATUSES,
  CONTACT_SOURCES,
  CONVERSATION_STATUSES,
  CRM_CHANGERS,
  DEAL_STATUSES,
  MESSAGE_TYPES,
  ORDER_STATUS_CHANGERS,
  ORDER_STATUSES,
  PAYMENT_LINK_STATUSES,
  SKIP_REASONS,
  STORE_MESSAGE_ANSWERS,
  TASK_STATUSES,
  TEMPLATE_STATUSES,
  WEBHOOK_EVENT_TYPES,
  type Tx,
} from '@w360/db';
import { apiCampaignResultsSchema } from '../api/campaigns';
import { API_KEY_LIMITS } from '../api/model';
import { apiContactSchema } from '../api/contact-view';
import { apiSatisfactionSurveySchema } from '../api/satisfaction-survey-view';
import { buildOpenApiDocument } from '../api/openapi';
import { NODE_TYPE_LABELS, NODE_TYPES } from '../automations/graph';
import {
  campaignResultsSchema,
  toCampaignResults,
  type CampaignAnalytics,
} from '../campaigns/results';
import { renderEmail } from '../email/templates';
import {
  CART_EVENTS,
  ORDER_MESSAGE_EVENTS,
  STORE_MESSAGE_EVENT_INFO,
  STORE_MESSAGE_SKIP_REASONS,
} from '../stores/messages-model';
import {
  WEBHOOK_AUTOMATION_EVENTS,
  WEBHOOK_CAMPAIGN_STATUS_LABELS,
  WEBHOOK_CAMPAIGN_STATUSES,
  WEBHOOK_CHANNEL_EVENTS,
  WEBHOOK_CHANNEL_STATUS_NOTES,
  WEBHOOK_CONTACT_PART_LABELS,
  WEBHOOK_CONTACT_PARTS,
  WEBHOOK_CONVERSATION_STATUS_LABELS,
  WEBHOOK_CONVERSATION_STATUSES,
  WEBHOOK_RUN_END_STATUS_LABELS,
  WEBHOOK_RUN_END_STATUSES,
  WEBHOOK_RUN_TRIGGER_LABELS,
  WEBHOOK_RUN_TRIGGERS,
  WEBHOOK_CONSENT_CHANGE_LABELS,
  WEBHOOK_CONSENT_CHANGES,
  WEBHOOK_CONTACT_SOURCE_LABELS,
  WEBHOOK_CONTACT_SOURCES,
  WEBHOOK_RECEIVED_MESSAGE_TYPE_LABELS,
  WEBHOOK_RECEIVED_MESSAGE_TYPES,
  WEBHOOK_RUN_END_REASON_LABELS,
  WEBHOOK_RUN_END_REASONS,
  WEBHOOK_RUN_END_REASONS_BY_END,
  WEBHOOK_CAMPAIGN_EVENTS,
  WEBHOOK_PIPELINE_EVENTS,
  WEBHOOK_TASK_EVENTS,
  WEBHOOK_TEAM_EVENTS,
  WEBHOOK_TEMPLATE_EVENTS,
  WEBHOOK_EVENT_INFO,
  WEBHOOK_EVENT_KEYS,
  WEBHOOK_LIMITS,
  WEBHOOK_MESSAGE_SENDER_LABELS,
  WEBHOOK_MESSAGE_SENDERS,
  WEBHOOK_MESSAGE_STATUS_LABELS,
  WEBHOOK_MESSAGE_STATUSES,
  WEBHOOK_ORDER_STATUS_LABELS,
  WEBHOOK_ORDER_STATUSES,
  WEBHOOK_PAYMENT_LINK_STATUS_LABELS,
  WEBHOOK_PAYMENT_LINK_STATUSES,
  WEBHOOK_RUN_STEP_OUTCOME_LABELS,
  WEBHOOK_COD_ANSWERS,
  WEBHOOK_COD_ANSWER_LABELS,
  WEBHOOK_ORDER_MESSAGE_EVENT_LABELS,
  WEBHOOK_ORDER_MESSAGE_EVENTS,
  WEBHOOK_ORDER_MESSAGE_SKIP_REASONS,
  WEBHOOK_CART_REMINDERS,
  WEBHOOK_CART_REMINDER_SKIP_REASONS,
  WEBHOOK_CAMPAIGN_SKIP_REASONS,
  WEBHOOK_STORE_EVENTS,
  webhookTakesStoreEvents,
  WEBHOOK_ORDER_MESSAGE_TYPES,
  webhookTakesOrderMessages,
  WEBHOOK_CART_REMINDER_TYPES,
  webhookTakesCartReminders,
  webhookStoreLabel,
  webhookStoreText,
  WEBHOOK_RUN_STEP_OUTCOMES,
  WEBHOOK_RUN_STEP_NODE_TYPE_LABELS,
  WEBHOOK_RUN_STEP_NODE_TYPES,
  WEBHOOK_ORDER_CHANGE_MAKER_LABELS,
  WEBHOOK_ORDER_CHANGE_MAKERS,
  WEBHOOK_DEAL_STATUS_LABELS,
  WEBHOOK_DEAL_STATUSES,
  WEBHOOK_TASK_STATUS_LABELS,
  WEBHOOK_TASK_STATUSES,
  WEBHOOK_DEAL_DETAIL_LABELS,
  WEBHOOK_DEAL_DETAILS,
  WEBHOOK_TASK_DETAIL_LABELS,
  WEBHOOK_TASK_DETAILS,
  WEBHOOK_REPLAY_PERIODS,
  WEBHOOK_RETRY_SECONDS,
  WEBHOOK_TEMPLATE_STATUS_LABELS,
  WEBHOOK_TEMPLATE_STATUSES,
  webhookAssigneeText,
  webhookCampaignText,
  webhookErrorLabel,
  webhookFieldText,
  webhookTakesFieldChanges,
  webhookHost,
  webhookReplayAllSummary,
  webhookReplaySummary,
  webhookChannelText,
  webhookOAuthText,
  WEBHOOK_OAUTH_CLIENT_AUTHENTICATION_LABELS,
  webhookOwnerText,
  webhookPipelineText,
  webhookRetryDelaySeconds,
  webhookApiKeyText,
  webhookTakesAutomationRuns,
  webhookTakesCampaignEvents,
  webhookTakesChannelEvents,
  webhookTakesPipelineEvents,
  webhookTakesTaskEvents,
  webhookTakesNoteEvents,
  webhookTakesCrmChanges,
  WEBHOOK_CRM_CHANGE_MAKERS,
  WEBHOOK_CRM_CHANGE_MAKER_LABELS,
  WEBHOOK_SURVEY_SCORES,
  WEBHOOK_SURVEY_SCORE_LABELS,
  webhookTakesTeamEvents,
  webhookTakesTemplateEvents,
  webhookTeamText,
  webhookTemplateText,
  webhookRunEndReasonsChosen,
  webhookRunEndReasonsTicked,
  webhookRunEndTakesReason,
  webhookStageText,
  webhookContactEventFieldValuesText,
  webhookContactFieldConditionText,
  webhookContactFieldKind,
  webhookContactFieldValueId,
  webhookFieldConditionEditable,
  webhookFieldRangeFromInputs,
  webhookFieldValueEditable,
  webhookFieldValuesFromLines,
  webhookFieldWordsFromLines,
  webhookFieldValueText,
  webhookMessageWordsFromLines,
  webhookMessageWordsText,
} from './model';
import {
  noteCreatedPayloadSchema,
  satisfactionSurveyAnsweredPayloadSchema,
  storeOrderCodAnsweredPayloadSchema,
  storeOrderMessageSkippedPayloadSchema,
  storeOrderMessageSentPayloadSchema,
  storeCheckoutReminderSkippedPayloadSchema,
  storeCheckoutReminderSentPayloadSchema,
  paymentLinkStatusChangedPayloadSchema,
  automationRunEndedPayloadSchema,
  automationRunStartedPayloadSchema,
  automationRunStepPayloadSchema,
  buildWebhookPayload,
  WebhookEventGoneError,
  WEBHOOK_EXACT_TIME_RE,
  toWebhookMillisecond,
  capturedCrmChanger,
  campaignStatusChangedPayloadSchema,
  campaignRecipientSkippedPayloadSchema,
  dealCreatedPayloadSchema,
  dealStageChangedPayloadSchema,
  dealOwnerChangedPayloadSchema,
  dealStatusChangedPayloadSchema,
  dealUpdatedPayloadSchema,
  WEBHOOK_DEAL_DETAIL_CHANGES,
  taskCreatedPayloadSchema,
  taskUpdatedPayloadSchema,
  WEBHOOK_TASK_DETAIL_CHANGES,
  taskAssigneeChangedPayloadSchema,
  taskStatusChangedPayloadSchema,
  consentChangedPayloadSchema,
  contactCreatedPayloadSchema,
  contactErasedPayloadSchema,
  contactMergedPayloadSchema,
  contactUpdatedPayloadSchema,
  CONTACT_CHANGE_PART_RE,
  conversationAssignmentPayloadSchema,
  conversationStatusPayloadSchema,
  conversationTeamPayloadSchema,
  contactCards,
  contactCardSchema,
  inboundOmissions,
  inboundSummary,
  messageReceivedPayloadSchema,
  messageStatusPayloadSchema,
  orderReceivedPayloadSchema,
  orderStatusChangedPayloadSchema,
  pingPayloadSchema,
  tappedReplySchema,
  templateStatusPayloadSchema,
} from './payloads';
import { webhookSignature, webhookSignatureHeader, verifyWebhookSignature } from './signing';
import {
  webhookOAuthKeyAad,
  webhookOAuthNextKeyAad,
  webhookOAuthPublicKey,
  webhookOAuthSecretAad,
} from './oauth';
import {
  assertWebhookAuthorization,
  checkedWebhookOAuth,
  NO_WEBHOOK_OAUTH,
  openWebhookHeaders,
  openWebhookOAuthClient,
  reservedWebhookHeader,
  sealWebhookHeaders,
  WEBHOOK_OAUTH_AUTHORIZATION,
  WEBHOOK_OAUTH_SECRET_FOR_NEW_URL,
  WEBHOOK_OAUTH_SECRET_NEEDED,
  webhookOAuthAudit,
  webhookOAuthClientAuthAudit,
  webhookOAuthNextKeyAudit,
  webhookOAuthColumns,
  webhookOAuthSchema,
  webhookAssigneeIdsFor,
  webhookAssigneeIdsSchema,
  webhookAutomationIdsFor,
  webhookAutomationIdsSchema,
  webhookCampaignStatusesFor,
  webhookCampaignStatusesSchema,
  webhookChannelIdsFor,
  webhookChannelIdsSchema,
  webhookChannelLabel,
  webhookContactFieldKeysFor,
  webhookContactFieldKeysSchema,
  webhookContactPartsFor,
  webhookContactPartsSchema,
  webhookConversationStatusesFor,
  webhookConversationStatusesSchema,
  webhookRunEndStatusesFor,
  webhookRunEndStatusesSchema,
  webhookRunTriggersFor,
  webhookRunTriggersSchema,
  webhookRunApiKeyIdsFor,
  webhookRunApiKeyIdsSchema,
  WEBHOOK_MESSAGE_KEY_SCOPES,
  WEBHOOK_CRM_KEY_SCOPES,
  webhookCrmExcludedApiKeyIdsFor,
  webhookCrmExcludedApiKeyIdsSchema,
  WEBHOOK_ORDER_KEY_SCOPES,
  WEBHOOK_PAYMENT_LINK_KEY_SCOPES,
  WEBHOOK_PAYMENT_LINK_API_KEYS_NEED_THE_EVENT,
  webhookPaymentLinkApiKeyIdsFor,
  webhookPaymentLinkApiKeyIdsSchema,
  WEBHOOK_ORDER_EXCLUDED_API_KEYS_NEED_THE_EVENT,
  webhookOrderExcludedApiKeyIdsFor,
  webhookOrderExcludedApiKeyIdsSchema,
  webhookMessageApiKeyIdsFor,
  webhookMessageApiKeyIdsSchema,
  webhookConsentChangesFor,
  webhookConsentChangesSchema,
  webhookContactSourcesFor,
  webhookContactSourcesSchema,
  webhookMessageTypesFor,
  webhookMessageTypesSchema,
  webhookMessageWordsFor,
  webhookMessageWordsSchema,
  webhookRunEndReasonsFor,
  webhookRunEndReasonsNeedTheEnds,
  webhookRunEndReasonsSchema,
  WEBHOOK_RUN_END_REASONS_NEED_THE_ENDS,
  webhookHeadersAad,
  webhookHeadersSchema,
  webhookMessageSendersFor,
  webhookMessageSendersSchema,
  webhookMessageStatusesFor,
  webhookMessageStatusesSchema,
  webhookOrderStatusesFor,
  webhookOrderStatusesSchema,
  webhookPaymentLinkStatusesFor,
  webhookPaymentLinkStatusesSchema,
  WEBHOOK_PAYMENT_LINK_STATUSES_NEED_THE_EVENT,
  webhookRunStepOutcomesFor,
  webhookRunStepOutcomesSchema,
  webhookCodAnswersFor,
  webhookCodAnswersSchema,
  webhookStoreIdsFor,
  webhookStoreIdsSchema,
  assertWebhookStores,
  WEBHOOK_COD_ANSWERS_NEED_THE_EVENT,
  WEBHOOK_STORES_NEED_THE_EVENT,
  WEBHOOK_CHANNELS_NEED_THE_EVENTS,
  WEBHOOK_STORES_NOT_FOUND,
  webhookOrderMessageEventsFor,
  webhookOrderMessageEventsSchema,
  WEBHOOK_ORDER_MESSAGES_NEED_THE_EVENT,
  webhookOrderMessageSkipReasonsFor,
  webhookOrderMessageSkipReasonsSchema,
  webhookCartRemindersFor,
  webhookCartRemindersSchema,
  WEBHOOK_CART_REMINDERS_NEED_THE_EVENT,
  webhookCartReminderSkipReasonsFor,
  webhookCartReminderSkipReasonsSchema,
  WEBHOOK_CART_REMINDER_SKIP_REASONS_NEED_THE_EVENT,
  webhookCampaignSkipReasonsFor,
  webhookCampaignSkipReasonsSchema,
  WEBHOOK_CAMPAIGN_SKIP_REASONS_NEED_THE_EVENT,
  WEBHOOK_ORDER_MESSAGE_SKIP_REASONS_NEED_THE_EVENT,
  WEBHOOK_RUN_STEP_OUTCOMES_NEED_THE_EVENT,
  webhookRunStepNodeTypesFor,
  webhookRunStepNodeTypesSchema,
  WEBHOOK_RUN_STEP_NODE_TYPES_NEED_THE_EVENT,
  webhookOrderChangeMakersFor,
  webhookOrderChangeMakersSchema,
  WEBHOOK_ORDER_CHANGE_MAKERS_NEED_THE_EVENT,
  webhookDealStatusesFor,
  webhookDealStatusesSchema,
  WEBHOOK_DEAL_STATUSES_NEED_THE_EVENT,
  webhookTaskStatusesFor,
  webhookTaskStatusesSchema,
  WEBHOOK_TASK_STATUSES_NEED_THE_EVENT,
  webhookDealDetailsFor,
  webhookDealDetailsSchema,
  WEBHOOK_DEAL_DETAILS_NEED_THE_EVENT,
  webhookTaskDetailsFor,
  webhookTaskDetailsSchema,
  WEBHOOK_TASK_DETAILS_NEED_THE_EVENT,
  webhookSurveyAssigneeIdsFor,
  webhookSurveyAssigneeIdsSchema,
  webhookSurveyTeamIdsFor,
  webhookSurveyTeamIdsSchema,
  WEBHOOK_SURVEY_ASSIGNEES_NEED_THE_EVENT,
  WEBHOOK_SURVEY_TEAMS_NEED_THE_EVENT,
  webhookSurveyContactTagsFor,
  webhookSurveyContactTagsSchema,
  webhookSurveyConversationTagsFor,
  webhookSurveyConversationTagsSchema,
  WEBHOOK_SURVEY_CONTACT_TAGS_NEED_THE_EVENT,
  WEBHOOK_SURVEY_CONVERSATION_TAGS_NEED_THE_EVENT,
  webhookContactEventTagsFor,
  webhookContactEventTagsSchema,
  WEBHOOK_CONTACT_EVENT_TAGS_NEED_THE_EVENTS,
  webhookContactEventFieldValuesChecked,
  webhookContactEventFieldValuesFor,
  webhookContactEventFieldValuesSchema,
  WEBHOOK_CONTACT_EVENT_FIELD_VALUES_NEED_THE_EVENTS,
  WEBHOOK_FIELDS_NOT_FOUND,
  WEBHOOK_AUTOMATIONS_NEED_THE_EVENTS,
  WEBHOOK_RUN_TRIGGERS_NEED_THE_EVENTS,
  WEBHOOK_RUN_API_KEYS_NEED_THE_EVENTS,
  webhookTeamIdsFor,
  webhookTeamIdsSchema,
  webhookTemplateIdsFor,
  webhookTemplateIdsSchema,
  webhookCampaignIdsFor,
  webhookCampaignIdsSchema,
  webhookPipelineIdsFor,
  webhookPipelineIdsSchema,
  WEBHOOK_PIPELINES_NEED_THE_EVENTS,
  webhookStageIdsFor,
  webhookStageIdsSchema,
  WEBHOOK_STAGES_NEED_THE_EVENTS,
  webhookOwnerIdsFor,
  webhookOwnerIdsSchema,
  WEBHOOK_OWNERS_NEED_THE_EVENTS,
  webhookTaskAssigneeIdsFor,
  webhookTaskAssigneeIdsSchema,
  WEBHOOK_TASK_ASSIGNEES_NEED_THE_EVENTS,
  webhookTaskPipelineIdsFor,
  webhookTaskPipelineIdsSchema,
  WEBHOOK_TASK_PIPELINES_NEED_THE_EVENTS,
  webhookTaskStageIdsFor,
  webhookTaskStageIdsSchema,
  WEBHOOK_TASK_STAGES_NEED_THE_EVENTS,
  webhookTaskDealOwnerIdsFor,
  webhookTaskDealOwnerIdsSchema,
  WEBHOOK_TASK_DEAL_OWNERS_NEED_THE_EVENTS,
  webhookNotePipelineIdsFor,
  webhookNotePipelineIdsSchema,
  WEBHOOK_NOTE_PIPELINES_NEED_THE_EVENTS,
  webhookNoteStageIdsFor,
  webhookNoteStageIdsSchema,
  WEBHOOK_NOTE_STAGES_NEED_THE_EVENTS,
  webhookNoteDealOwnerIdsFor,
  webhookNoteDealOwnerIdsSchema,
  WEBHOOK_NOTE_DEAL_OWNERS_NEED_THE_EVENTS,
  webhookCrmChangeMakersFor,
  webhookCrmChangeMakersSchema,
  WEBHOOK_CRM_CHANGE_MAKERS_NEED_THE_EVENTS,
  webhookSurveyScoresFor,
  webhookSurveyScoresSchema,
  WEBHOOK_SURVEY_SCORES_NEED_THE_EVENT,
  webhookContactTagsFor,
  webhookContactTagsSchema,
  WEBHOOK_CONTACT_TAGS_NEED_THE_EVENTS,
  webhookConversationTagsFor,
  webhookConversationTagsSchema,
  WEBHOOK_CONVERSATION_TAGS_NEED_THE_EVENTS,
  webhookTemplateStatusesFor,
  webhookTemplateStatusesSchema,
  webhookEndpointAuditMetadata,
} from './service';

const SECRET = 'whsec_test-secret-one';
const OTHER = 'whsec_test-secret-two';
const BODY = '{"id":"0192a1b2-0000-7000-8000-000000000001","type":"ping"}';

describe('webhook signatures', () => {
  it('signs "<timestamp>.<body>" with HMAC-SHA256 as hex', () => {
    const expected = createHmac('sha256', SECRET).update(`1700000000.${BODY}`).digest('hex');
    expect(webhookSignature(SECRET, 1_700_000_000, BODY)).toBe(expected);
    expect(webhookSignatureHeader([SECRET], 1_700_000_000, BODY)).toBe(
      `t=1700000000,v1=${expected}`,
    );
  });

  it('carries one v1 value per secret, each verifying with its own secret', () => {
    const header = webhookSignatureHeader([SECRET, OTHER], 1_700_000_000, BODY);
    expect(header.split(',')).toHaveLength(3);
    for (const secret of [SECRET, OTHER]) {
      expect(
        verifyWebhookSignature({ header, secret, body: BODY, nowSeconds: 1_700_000_100 }),
      ).toBe(true);
    }
    expect(
      verifyWebhookSignature({
        header,
        secret: 'whsec_someone-else',
        body: BODY,
        nowSeconds: 1_700_000_100,
      }),
    ).toBe(false);
  });

  it('refuses a changed body, an old or future time, and malformed headers', () => {
    const header = webhookSignatureHeader([SECRET], 1_700_000_000, BODY);
    const check = (h: string, body = BODY, nowSeconds = 1_700_000_000) =>
      verifyWebhookSignature({ header: h, secret: SECRET, body, nowSeconds });
    expect(check(header)).toBe(true);
    expect(check(header, BODY.replace('ping', 'pong'))).toBe(false);
    expect(check(header, BODY, 1_700_000_301)).toBe(false);
    expect(check(header, BODY, 1_699_999_699)).toBe(false);
    expect(check(header, BODY, 1_700_000_300)).toBe(true);
    expect(check(header.replace(/^t=\d+/, 't=1700000001'))).toBe(false);
    expect(check(header.replace(/,v1=.*/, ''))).toBe(false);
    expect(check(header.replace(/^t=\d+,/, ''))).toBe(false);
    expect(check('garbage')).toBe(false);
    expect(check('')).toBe(false);
  });
});

describe('webhook retries', () => {
  it('waits 1 min, 5 min, 30 min, 2 h, 6 h, 12 h and 24 h, then gives up after eight attempts', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7].map((attempt) => webhookRetryDelaySeconds(attempt));
    expect(delays).toEqual([60, 300, 1_800, 7_200, 21_600, 43_200, 86_400]);
    expect(webhookRetryDelaySeconds(WEBHOOK_LIMITS.attempts)).toBeNull();
    expect(webhookRetryDelaySeconds(9)).toBeNull();
    const hours = WEBHOOK_RETRY_SECONDS.reduce((sum, s) => sum + s, 0) / 3_600;
    expect(hours).toBeGreaterThan(44);
    expect(hours).toBeLessThan(46);
  });
});

describe('inbound message summaries', () => {
  it('keeps the readable part of each message type and nothing else', () => {
    expect(inboundSummary('text', { text: 'Hello' })).toEqual({
      text: 'Hello',
      reply: null,
      mimeType: null,
    });
    expect(
      inboundSummary('image', { caption: 'Receipt', mime_type: 'image/jpeg', id: 'media-1' }),
    ).toEqual({ text: 'Receipt', reply: null, mimeType: 'image/jpeg' });
    expect(inboundSummary('button', { text: 'Yes', payload: 'confirm' })).toEqual({
      text: 'Yes',
      reply: { id: 'confirm', title: 'Yes', type: 'button', description: null },
      mimeType: null,
    });
    expect(
      inboundSummary('interactive', { reply: { id: 'opt-2', title: 'Tomorrow', kind: 'list' } }),
    ).toEqual({
      text: 'Tomorrow',
      reply: { id: 'opt-2', title: 'Tomorrow', type: null, description: null },
      mimeType: null,
    });
    expect(inboundSummary('interactive', {})).toEqual({ text: null, reply: null, mimeType: null });
    expect(inboundSummary('reaction', { emoji: '👍', message_id: 'x' }).text).toBe('👍');
    expect(inboundSummary('location', { latitude: 1, longitude: 2, name: 'Shop' }).text).toBe(
      'Shop',
    );
    expect(inboundSummary('location', { latitude: 1, longitude: 2 }).text).toBeNull();
    expect(inboundSummary('order', { catalog_id: 'c', product_items: [] })).toEqual({
      text: null,
      reply: null,
      mimeType: null,
    });
    // Values of the wrong type are left out, not passed on.
    expect(inboundSummary('text', { text: 42 }).text).toBeNull();
  });

  it('says what was left out: content too large to keep and contacts a card left out (ADR-132)', () => {
    // Content kept as too large (ADR-131) has nothing to read, a tapped button included.
    const nothing = { text: null, reply: null, mimeType: null };
    expect(inboundSummary('button', { tooLarge: true })).toEqual(nothing);
    expect(inboundSummary('image', { tooLarge: true })).toEqual(nothing);
    expect(inboundOmissions('system', { tooLarge: true })).toEqual({
      contentTooLarge: true,
      contactsLeftOut: 0,
    });
    expect(inboundOmissions('text', { text: 'Hello' })).toEqual({
      contentTooLarge: false,
      contactsLeftOut: 0,
    });
    expect(inboundOmissions('contacts', { contacts: [{}], omittedContacts: 3 })).toEqual({
      contentTooLarge: false,
      contactsLeftOut: 3,
    });
    expect(inboundOmissions('contacts', { contacts: [] }).contactsLeftOut).toBe(0);
    // Only a contact card's count is given, and only a whole number above 0.
    expect(inboundOmissions('text', { text: 'x', omittedContacts: 3 }).contactsLeftOut).toBe(0);
    for (const omittedContacts of [-1, 1.5, '3', Number.NaN, Number.POSITIVE_INFINITY])
      expect(inboundOmissions('contacts', { omittedContacts }).contactsLeftOut).toBe(0);
    // Only true marks content as too large.
    expect(inboundOmissions('text', { tooLarge: 'true' }).contentTooLarge).toBe(false);
  });

  it('gives a contact card’s contacts in the API’s words, every part optional (ADR-196)', () => {
    // Meta's example of a received card (research M-193), and a fuller one.
    const lucia = {
      name: { first_name: 'Lucía', last_name: 'Gómez', formatted_name: 'Lucía Gómez' },
      org: { company: 'Google' },
      phones: [{ phone: '+1 (983) 555-2319', wa_id: '19835552319', type: 'MOBILE' }],
    };
    const john = {
      name: {
        formatted_name: 'Dr John D. Smith Jr',
        first_name: 'John',
        last_name: 'Smith',
        middle_name: 'D.',
        prefix: 'Dr',
        suffix: 'Jr',
      },
      addresses: [
        {
          street: '1 Hacker Way',
          city: 'Menlo Park',
          state: 'CA',
          zip: '94025',
          country: 'United States',
          country_code: 'us',
          type: 'HOME',
        },
      ],
      birthday: '2012-08-18',
      emails: [{ email: 'test@fb.com', type: 'WORK' }],
      org: { company: 'WhatsApp', department: 'Design', title: 'Manager' },
      urls: [{ url: 'https://www.facebook.com', type: 'WORK' }],
    };
    const cards = contactCards('contacts', { contacts: [lucia, john], omittedContacts: 2 });
    expect(cards).toEqual([
      {
        name: {
          formattedName: 'Lucía Gómez',
          firstName: 'Lucía',
          lastName: 'Gómez',
          middleName: null,
          prefix: null,
          suffix: null,
        },
        phones: [{ phone: '+1 (983) 555-2319', waId: '19835552319', type: 'MOBILE' }],
        emails: [],
        urls: [],
        addresses: [],
        org: { company: 'Google', department: null, title: null },
        birthday: null,
      },
      {
        name: {
          formattedName: 'Dr John D. Smith Jr',
          firstName: 'John',
          lastName: 'Smith',
          middleName: 'D.',
          prefix: 'Dr',
          suffix: 'Jr',
        },
        phones: [],
        emails: [{ email: 'test@fb.com', type: 'WORK' }],
        urls: [{ url: 'https://www.facebook.com', type: 'WORK' }],
        addresses: [
          {
            street: '1 Hacker Way',
            city: 'Menlo Park',
            state: 'CA',
            zip: '94025',
            country: 'United States',
            countryCode: 'us',
            type: 'HOME',
          },
        ],
        org: { company: 'WhatsApp', department: 'Design', title: 'Manager' },
        birthday: '2012-08-18',
      },
    ]);
    for (const card of cards ?? []) expect(contactCardSchema.parse(card)).toEqual(card);
    // What a card leaves out, or gives in the wrong shape, is left out.
    expect(
      contactCards('contacts', {
        contacts: [
          'not a contact',
          null,
          {
            name: { formatted_name: 42, first_name: 'Asha' },
            phones: [{ type: 'HOME' }, { phone: '' }, 'x', { phone: '+91 98200 00000', wa_id: 7 }],
            emails: [{ email: 'asha@example.com', type: 3 }, { type: 'WORK' }],
            urls: [{ url: 9 }, { url: 'asha.example' }],
            addresses: [{ type: 'HOME' }, { city: 'Pune' }],
            org: { company: '', title: null },
            birthday: 20120818,
          },
          {},
        ],
      }),
    ).toEqual([
      {
        name: {
          formattedName: null,
          firstName: 'Asha',
          lastName: null,
          middleName: null,
          prefix: null,
          suffix: null,
        },
        phones: [{ phone: '+91 98200 00000', waId: null, type: null }],
        emails: [{ email: 'asha@example.com', type: null }],
        urls: [{ url: 'asha.example', type: null }],
        addresses: [
          {
            street: null,
            city: 'Pune',
            state: null,
            zip: null,
            country: null,
            countryCode: null,
            type: null,
          },
        ],
        org: null,
        birthday: null,
      },
      {
        name: {
          formattedName: null,
          firstName: null,
          lastName: null,
          middleName: null,
          prefix: null,
          suffix: null,
        },
        phones: [],
        emails: [],
        urls: [],
        addresses: [],
        org: null,
        birthday: null,
      },
    ]);
    // Only a contact card's kept contacts: none for other messages, removed or too large content.
    expect(contactCards('text', { text: 'Hi', contacts: [lucia] })).toBeNull();
    expect(contactCards('contacts', { redacted: true })).toBeNull();
    expect(contactCards('contacts', { tooLarge: true, contacts: [lucia] })).toBeNull();
    expect(contactCards('contacts', { contacts: { 0: lucia } })).toBeNull();
    expect(contactCards('contacts', { contacts: [] })).toEqual([]);
  });

  it('says whether a tap was a reply button or a list row, with the row’s description (ADR-080)', () => {
    const tap = (interactiveType: string, reply: Record<string, unknown>) =>
      inboundSummary('interactive', { interactiveType, reply }).reply;
    expect(tap('button_reply', { id: 'yes', title: 'Yes', description: 'ignored' })).toEqual({
      id: 'yes',
      title: 'Yes',
      type: 'button',
      description: null,
    });
    expect(tap('list_reply', { id: 'slot-2', title: '11:00', description: 'With Dr Rao' })).toEqual(
      { id: 'slot-2', title: '11:00', type: 'list', description: 'With Dr Rao' },
    );
    // A row sent without a description may come back with an empty one or none.
    expect(tap('list_reply', { id: 'slot-3', title: '12:00', description: '' })?.description).toBe(
      null,
    );
    expect(tap('list_reply', { id: 'slot-3', title: '12:00' })?.description).toBeNull();
    expect(tap('something_new', { id: 'x', title: 'X' })?.type).toBeNull();
    const parsed = tappedReplySchema.parse(
      tap('list_reply', { id: 'slot-2', title: '11:00', description: 'With Dr Rao' }),
    );
    expect(parsed).toEqual({
      id: 'slot-2',
      title: '11:00',
      type: 'list',
      description: 'With Dr Rao',
    });
  });
});

describe('webhook payload schemas', () => {
  const base = {
    id: '0192a1b2-0000-7000-8000-000000000001',
    createdAt: '2026-09-28T10:00:00Z',
    createdAtExact: '2026-09-28T10:00:00.000000Z',
  };
  const contact = { id: '0192a1b2-0000-7000-8000-000000000002', phone: null, name: null };
  const channel = { id: '0192a1b2-0000-7000-8000-000000000003', phone: '+91 90000 00000' };
  const conversation = { id: '0192a1b2-0000-7000-8000-000000000004' };

  it('describe every event body, erased contacts included', () => {
    expect(
      messageReceivedPayloadSchema.safeParse({
        ...base,
        type: 'message.received',
        data: {
          message: {
            id: base.id,
            type: 'text',
            text: 'Hi',
            reply: null,
            replyTo: null,
            mimeType: null,
            contentTooLarge: false,
            contactsLeftOut: 0,
            contacts: null,
            receivedAt: base.createdAt,
          },
          conversation,
          contact,
          channel,
        },
      }).success,
    ).toBe(true);
    expect(
      messageStatusPayloadSchema.safeParse({
        ...base,
        type: 'message.status',
        data: {
          message: {
            id: base.id,
            status: 'failed',
            templateId: null,
            templateName: null,
            sentBy: 'api',
            apiKeyId: base.id,
            campaignId: null,
          },
          error: { code: '131026', title: 'Message undeliverable' },
          conversation,
          contact,
          channel,
        },
      }).success,
    ).toBe(true);
    // A campaign's message names its campaign (ADR-185); the field is always there.
    const campaignMessage = {
      id: base.id,
      status: 'delivered',
      templateId: base.id,
      templateName: 'autumn_sale',
      sentBy: 'campaign',
      apiKeyId: null,
      campaignId: base.id,
    };
    const campaignStatus = {
      ...base,
      type: 'message.status',
      data: { message: campaignMessage, error: null, conversation, contact, channel },
    };
    expect(messageStatusPayloadSchema.safeParse(campaignStatus).success).toBe(true);
    const { campaignId: _left, ...withoutCampaign } = campaignMessage;
    for (const message of [withoutCampaign, { ...campaignMessage, campaignId: 'autumn' }]) {
      expect(
        messageStatusPayloadSchema.safeParse({
          ...campaignStatus,
          data: { ...campaignStatus.data, message },
        }).success,
        JSON.stringify(message),
      ).toBe(false);
    }
    expect(
      consentChangedPayloadSchema.safeParse({
        ...base,
        type: 'consent.changed',
        data: { contact, purpose: 'marketing', action: 'opt_out', source: 'erasure' },
      }).success,
    ).toBe(true);
    expect(
      templateStatusPayloadSchema.safeParse({
        ...base,
        type: 'template.status_changed',
        data: {
          template: {
            id: base.id,
            name: 'order_update',
            language: 'en',
            category: 'utility',
            status: 'approved',
            reason: null,
          },
        },
      }).success,
    ).toBe(true);
    expect(
      pingPayloadSchema.safeParse({
        ...base,
        type: 'ping',
        data: { endpointId: base.id, message: 'test' },
      }).success,
    ).toBe(true);
  });

  it('describe the conversation and contact events (ADR-074, ADR-094)', () => {
    const member = '0192a1b2-0000-7000-8000-000000000007';
    const team = '0192a1b2-0000-7000-8000-000000000008';
    expect(
      conversationStatusPayloadSchema.safeParse({
        ...base,
        type: 'conversation.status_changed',
        data: {
          conversation: {
            id: base.id,
            status: 'resolved',
            previousStatus: 'open',
            assigned: true,
            assigneeId: member,
            teamId: team,
            resolvedAt: base.createdAt,
          },
          contact,
          channel,
        },
      }).success,
    ).toBe(true);
    // Moved from one member to none; captured before members were named, both ids are null.
    for (const [assigneeId, previousAssigneeId] of [
      [null, member],
      [member, null],
      [null, null],
    ]) {
      expect(
        conversationAssignmentPayloadSchema.safeParse({
          ...base,
          type: 'conversation.assignment_changed',
          data: {
            conversation: {
              id: base.id,
              status: 'open',
              assigned: assigneeId !== null,
              assigneeId,
              previousAssigneeId,
              teamId: null,
            },
            contact,
            channel,
          },
        }).success,
      ).toBe(true);
    }
    // The member is required: a body without it does not match.
    expect(
      conversationAssignmentPayloadSchema.safeParse({
        ...base,
        type: 'conversation.assignment_changed',
        data: {
          conversation: {
            id: base.id,
            status: 'open',
            assigned: false,
            previousAssigneeId: member,
            teamId: null,
          },
          contact,
          channel,
        },
      }).success,
    ).toBe(false);
    for (const [teamId, previousTeamId] of [
      [team, null],
      [null, team],
    ]) {
      expect(
        conversationTeamPayloadSchema.safeParse({
          ...base,
          type: 'conversation.team_changed',
          data: {
            conversation: { id: base.id, status: 'open', teamId, previousTeamId, assigneeId: null },
            contact,
            channel,
          },
        }).success,
      ).toBe(true);
    }
    expect(
      conversationTeamPayloadSchema.safeParse({
        ...base,
        type: 'conversation.team_changed',
        data: {
          conversation: {
            id: base.id,
            status: 'open',
            teamId: 'support',
            previousTeamId: null,
            assigneeId: null,
          },
          contact,
          channel,
        },
      }).success,
    ).toBe(false);
    const person = {
      id: contact.id,
      name: 'Priya',
      phone: '+919876543210',
      email: 'priya@example.com',
      tags: ['vip'],
      fields: { city: 'Chennai', orders: 3, birthday: '1990-04-01', vip: true },
      consent: { marketing: 'opted_in', utility: null },
      source: 'whatsapp',
      createdAt: base.createdAt,
      erased: false,
    };
    const erased = {
      ...person,
      name: null,
      phone: null,
      email: null,
      tags: [],
      fields: {},
      consent: { marketing: null, utility: null },
      erased: true,
    };
    // An update also names what it changed (ADR-121), even once the contact is erased: names only.
    // Its tags are given while the contact is not erased (ADR-182).
    const changes = { 'contact.updated': ['email', 'fields.city', 'tags'] };
    for (const [schema, type] of [
      [contactCreatedPayloadSchema, 'contact.created'],
      [contactUpdatedPayloadSchema, 'contact.updated'],
      [contactErasedPayloadSchema, 'contact.erased'],
    ] as const) {
      const data = (shown: unknown) =>
        type === 'contact.updated'
          ? {
              contact: shown,
              changes: changes[type],
              ...(shown === erased
                ? { tagsAdded: null, tagsRemoved: null }
                : { tagsAdded: ['vip'], tagsRemoved: ['new'] }),
            }
          : { contact: shown };
      for (const shown of [person, erased]) {
        expect(schema.safeParse({ ...base, type, data: data(shown) }).success, type).toBe(true);
      }
      // Custom field values are strings, numbers or booleans (ADR-112).
      for (const fields of [{ city: null }, { city: ['a'] }, { city: { name: 'a' } }]) {
        const shown = { ...person, fields };
        expect(schema.safeParse({ ...base, type, data: data(shown) }).success, type).toBe(false);
      }
    }
    // A merge names the merged contact, and gives the contact it belongs to now (ADR-225).
    const merged = (data: Record<string, unknown>) =>
      contactMergedPayloadSchema.safeParse({ ...base, type: 'contact.merged', data }).success;
    for (const shown of [person, erased]) {
      expect(merged({ contact: shown, mergedContactId: base.id })).toBe(true);
    }
    expect(merged({ contact: person })).toBe(false);
    expect(merged({ contact: person, mergedContactId: 'gone' })).toBe(false);
    expect(merged({ contact: null, mergedContactId: base.id })).toBe(false);
    // A contact reads as the API's contact, and whether it was erased.
    expect(Object.keys(contactCreatedPayloadSchema.shape.data.shape.contact.shape).sort()).toEqual(
      [...Object.keys(apiContactSchema.shape), 'erased'].sort(),
    );
    expect(Object.keys(contactMergedPayloadSchema.shape.data.shape.contact.shape).sort()).toEqual(
      [...Object.keys(apiContactSchema.shape), 'erased'].sort(),
    );
    expect(
      conversationStatusPayloadSchema.safeParse({
        ...base,
        type: 'conversation.status_changed',
        data: {
          conversation: {
            id: base.id,
            status: 'closed',
            previousStatus: 'open',
            assigned: false,
            assigneeId: null,
            teamId: null,
            resolvedAt: null,
          },
          contact,
          channel,
        },
      }).success,
    ).toBe(false);
  });

  it('say what a contact.updated changed: known parts and field keys, or null for an older event (ADR-121)', () => {
    const person = {
      id: contact.id,
      name: 'Priya',
      phone: '+919876543210',
      email: null,
      tags: [],
      fields: {},
      consent: { marketing: null, utility: null },
      source: 'manual',
      createdAt: base.createdAt,
      erased: false,
    };
    const parse = (data: Record<string, unknown>) =>
      contactUpdatedPayloadSchema.safeParse({
        ...base,
        type: 'contact.updated',
        data: { tagsAdded: [], tagsRemoved: [], ...data },
      }).success;
    for (const changes of [
      ['name'],
      ['email', 'fields.city', 'name', 'phone', 'tags'],
      ['fields.a', `fields.a${'b'.repeat(39)}`],
      null,
    ]) {
      expect(parse({ contact: person, changes }), JSON.stringify(changes)).toBe(true);
    }
    // Always given; parts in the API contact's names, field keys as the fields' keys are written.
    expect(parse({ contact: person })).toBe(false);
    for (const part of [
      'Name',
      'nickname',
      'consent',
      'source',
      'fields',
      'fields.',
      'fields.City',
      'fields.1st',
      'fields.a-b',
      `fields.a${'b'.repeat(40)}`,
      ' name',
    ]) {
      expect(parse({ contact: person, changes: [part] }), part).toBe(false);
    }
    expect(parse({ contact: person, changes: 'name' })).toBe(false);
  });

  it('say which tags a contact.updated added and removed: lists of tags, or null for an older event or an erased contact (ADR-182)', () => {
    const person = {
      id: contact.id,
      name: 'Priya',
      phone: '+919876543210',
      email: null,
      tags: ['repeat', 'vip'],
      fields: {},
      consent: { marketing: null, utility: null },
      source: 'manual',
      createdAt: base.createdAt,
      erased: false,
    };
    const parse = (tags: Record<string, unknown>) =>
      contactUpdatedPayloadSchema.safeParse({
        ...base,
        type: 'contact.updated',
        data: { contact: person, changes: ['tags'], ...tags },
      }).success;
    for (const tags of [
      { tagsAdded: ['vip'], tagsRemoved: [] },
      { tagsAdded: [], tagsRemoved: ['new'] },
      { tagsAdded: ['repeat', 'vip'], tagsRemoved: ['new', 'trial'] },
      { tagsAdded: [], tagsRemoved: [] },
      { tagsAdded: null, tagsRemoved: null },
    ]) {
      expect(parse(tags), JSON.stringify(tags)).toBe(true);
    }
    // Always given, as lists of tags or null.
    for (const tags of [
      {},
      { tagsAdded: ['vip'] },
      { tagsRemoved: [] },
      { tagsAdded: 'vip', tagsRemoved: [] },
      { tagsAdded: [42], tagsRemoved: [] },
      { tagsAdded: [], tagsRemoved: [null] },
    ]) {
      expect(parse(tags), JSON.stringify(tags)).toBe(false);
    }
  });

  it('describe the automation run events (ADR-078)', () => {
    const run = {
      id: base.id,
      automationId: '0192a1b2-0000-7000-8000-000000000005',
      automationName: 'Welcome',
      trigger: 'api',
      apiKeyId: '0192a1b2-0000-7000-8000-000000000006',
      status: 'running',
      endReason: null,
      startedAt: base.createdAt,
      endedAt: null,
    };
    const started = {
      ...base,
      type: 'automation.run_started',
      data: { run, conversation, contact, channel },
    };
    expect(automationRunStartedPayloadSchema.safeParse(started).success).toBe(true);
    const ended = {
      ...base,
      type: 'automation.run_ended',
      data: {
        run: {
          ...run,
          automationName: null,
          trigger: 'keyword',
          apiKeyId: null,
          status: 'completed',
          endReason: 'no_next',
          endedAt: '2026-09-28T10:00:05Z',
        },
        conversation,
        contact,
        channel,
      },
    };
    expect(automationRunEndedPayloadSchema.safeParse(ended).success).toBe(true);
    // Every way a run ends is described, a stop through the API included (ADR-079).
    for (const [status, reasons] of Object.entries(AUTOMATION_END_REASONS)) {
      for (const endReason of reasons) {
        expect(
          automationRunEndedPayloadSchema.safeParse({
            ...ended,
            data: { ...ended.data, run: { ...ended.data.run, status, endReason } },
          }).success,
          endReason,
        ).toBe(true);
      }
    }
    expect(AUTOMATION_END_REASONS.stopped).toContain('stopped_by_api');
    // Each type has its own body; a test run's trigger and an unknown reason are not described.
    expect(automationRunEndedPayloadSchema.safeParse(started).success).toBe(false);
    for (const change of [{ trigger: 'test' }, { endReason: 'timeout' }, { status: 'queued' }]) {
      expect(
        automationRunEndedPayloadSchema.safeParse({
          ...ended,
          data: { ...ended.data, run: { ...ended.data.run, ...change } },
        }).success,
        JSON.stringify(change),
      ).toBe(false);
    }
  });

  it('describe the order events (ADR-085)', () => {
    const order = {
      id: base.id,
      reference: 'K7M2QX9P',
      status: 'received',
      previousStatus: null,
      changedBy: null,
      apiKeyId: null,
      messageId: '0192a1b2-0000-7000-8000-000000000007',
      catalogId: '5550001',
      currency: 'INR',
      subtotalMinor: 28_998,
      itemCount: 2,
      droppedItems: 0,
      customerNote: 'Please gift wrap',
      items: [
        {
          retailerId: 'sku-1',
          name: 'Masala chai',
          quantity: 2,
          unitPriceMinor: 1_999,
          currency: 'INR',
        },
        { retailerId: 'sku-9', name: null, quantity: 1, unitPriceMinor: 25_000, currency: 'INR' },
      ],
      receivedAt: base.createdAt,
      paidAt: null,
    };
    const received = {
      ...base,
      type: 'order.received',
      data: { order, conversation, contact, channel },
    };
    expect(orderReceivedPayloadSchema.safeParse(received).success).toBe(true);
    // Every status an order can reach is described, with the one before it.
    for (const status of ORDER_STATUSES) {
      expect(
        orderStatusChangedPayloadSchema.safeParse({
          ...received,
          type: 'order.status_changed',
          data: {
            ...received.data,
            order: { ...order, status, previousStatus: 'confirmed', paidAt: base.createdAt },
          },
        }).success,
        status,
      ).toBe(true);
    }
    // Who made a change (ADR-270): a member, a key it names, the Payment Link, or not recorded.
    for (const [changedBy, apiKeyId] of [
      ['member', null],
      ['api', base.id],
      ['payment_link', null],
      [null, null],
    ]) {
      expect(
        orderStatusChangedPayloadSchema.safeParse({
          ...received,
          type: 'order.status_changed',
          data: {
            ...received.data,
            order: {
              ...order,
              status: 'confirmed',
              previousStatus: 'received',
              changedBy,
              apiKeyId,
            },
          },
        }).success,
        String(changedBy),
      ).toBe(true);
    }
    for (const change of [
      { changedBy: 'automation' },
      { changedBy: undefined },
      { apiKeyId: 'key-1' },
      { apiKeyId: undefined },
    ]) {
      expect(
        orderStatusChangedPayloadSchema.safeParse({
          ...received,
          type: 'order.status_changed',
          data: { ...received.data, order: { ...order, status: 'confirmed', ...change } },
        }).success,
        JSON.stringify(change),
      ).toBe(false);
    }
    // An order without a total (an unreadable price, mixed currencies) or a note is described too.
    expect(
      orderReceivedPayloadSchema.safeParse({
        ...received,
        data: {
          ...received.data,
          order: {
            ...order,
            currency: null,
            subtotalMinor: null,
            droppedItems: 1,
            customerNote: null,
            items: [{ ...order.items[0], unitPriceMinor: null, currency: null }],
          },
        },
      }).success,
    ).toBe(true);
    // Each type has its own body; an unknown status or a fractional amount is not described.
    expect(orderStatusChangedPayloadSchema.safeParse(received).success).toBe(false);
    for (const change of [{ status: 'shipped' }, { subtotalMinor: 289.98 }]) {
      expect(
        orderReceivedPayloadSchema.safeParse({
          ...received,
          data: { ...received.data, order: { ...order, ...change } },
        }).success,
        JSON.stringify(change),
      ).toBe(false);
    }
  });

  it('describe the campaign event (ADR-087)', () => {
    const campaign = {
      id: base.id,
      name: 'Festive sale',
      status: 'running',
      previousStatus: 'scheduled',
      pauseReason: null,
      completionReason: null,
      templateId: base.id,
      templateName: 'festive_sale',
      scheduledAt: base.createdAt,
      startedAt: base.createdAt,
      completedAt: null,
      canceledAt: null,
      audienceCount: 1_200,
      queuedCount: 350,
      skippedCount: 12,
      results: {
        audience: 1_200,
        pending: 838,
        skipped: 12,
        canceled: 0,
        queued: 350,
        inProgress: 50,
        sent: 300,
        delivered: 290,
        read: 120,
        failed: 0,
        unknown: 0,
        messagesCanceled: 0,
        replied: 14,
        optedOut: 2,
        skipReasons: [{ reason: 'no_marketing_opt_in', count: 12 }],
        failureCodes: [],
      },
    };
    const channel = { id: base.id, phone: '+91 98765 43210' };
    const event = { ...base, type: 'campaign.status_changed', data: { campaign, channel } };
    expect(campaignStatusChangedPayloadSchema.safeParse(event).success).toBe(true);
    // Every status a campaign can reach, from every other one.
    for (const status of CAMPAIGN_STATUSES) {
      for (const previousStatus of CAMPAIGN_STATUSES) {
        expect(
          campaignStatusChangedPayloadSchema.safeParse({
            ...event,
            data: { campaign: { ...campaign, status, previousStatus }, channel },
          }).success,
          `${previousStatus} → ${status}`,
        ).toBe(true);
      }
    }
    // Every reason for a pause or a completion.
    for (const pauseReason of CAMPAIGN_PAUSE_REASONS) {
      expect(
        campaignStatusChangedPayloadSchema.safeParse({
          ...event,
          data: { campaign: { ...campaign, status: 'paused', pauseReason }, channel },
        }).success,
        pauseReason,
      ).toBe(true);
    }
    for (const completionReason of CAMPAIGN_COMPLETION_REASONS) {
      expect(
        campaignStatusChangedPayloadSchema.safeParse({
          ...event,
          data: {
            campaign: {
              ...campaign,
              status: 'completed',
              completionReason,
              completedAt: base.createdAt,
            },
            channel,
          },
        }).success,
        completionReason,
      ).toBe(true);
    }
    // A draft without a template or a number is described too.
    expect(
      campaignStatusChangedPayloadSchema.safeParse({
        ...event,
        data: {
          campaign: {
            ...campaign,
            status: 'draft',
            previousStatus: 'pending_approval',
            templateId: null,
            templateName: null,
            scheduledAt: null,
            startedAt: null,
            audienceCount: 0,
            queuedCount: 0,
            skippedCount: 0,
            results: null,
          },
          channel: null,
        },
      }).success,
    ).toBe(true);
    // An unknown status or reason, a fractional count, results left out or not counted as the API
    // counts them (ADR-150), or another type is not described.
    for (const change of [
      { status: 'archived' },
      { previousStatus: 'sent' },
      { pauseReason: 'tired' },
      { completionReason: 'done' },
      { queuedCount: 1.5 },
      { results: undefined },
      { results: { ...campaign.results, delivered: 2.5 } },
      { results: { ...campaign.results, skipReasons: [{ reason: 'tired', count: 1 }] } },
    ]) {
      expect(
        campaignStatusChangedPayloadSchema.safeParse({
          ...event,
          data: { campaign: { ...campaign, ...change }, channel },
        }).success,
        JSON.stringify(change),
      ).toBe(false);
    }
    expect(
      campaignStatusChangedPayloadSchema.safeParse({ ...event, type: 'order.status_changed' })
        .success,
    ).toBe(false);
  });

  it('describe the deal events (ADR-256)', () => {
    const deal = {
      id: base.id,
      title: 'Annual plan',
      pipelineId: base.id,
      stageId: base.id,
      status: 'open',
      previousStageId: null,
      previousPipelineId: null,
      previousStatus: null,
      previousOwnerId: null,
      valueMinor: 250_050,
      currency: 'INR',
      ownerId: base.id,
      expectedCloseOn: '2026-12-31',
      lostReason: null,
      createdBy: 'member',
      createdAt: base.createdAt,
      changedBy: 'member',
      apiKeyId: null,
    };
    const person = { id: base.id, phone: '+919876543210', name: 'Jaya' };
    const created = {
      ...base,
      type: 'deal.created',
      data: { deal, conversation: null, contact: person },
    };
    expect(dealCreatedPayloadSchema.safeParse(created).success).toBe(true);
    // A move, to another pipeline too, by each kind of creator.
    for (const createdBy of ['member', 'automation', 'api']) {
      expect(
        dealStageChangedPayloadSchema.safeParse({
          ...created,
          type: 'deal.stage_changed',
          data: {
            ...created.data,
            deal: { ...deal, previousStageId: base.id, previousPipelineId: base.id, createdBy },
          },
        }).success,
        createdBy,
      ).toBe(true);
    }
    // A deal given to another member, from one or from nobody, or left without an owner (ADR-269).
    for (const [ownerId, previousOwnerId] of [
      [base.id, base.id],
      [base.id, null],
      [null, base.id],
    ]) {
      expect(
        dealOwnerChangedPayloadSchema.safeParse({
          ...created,
          type: 'deal.owner_changed',
          data: { ...created.data, deal: { ...deal, ownerId, previousOwnerId } },
        }).success,
        JSON.stringify([ownerId, previousOwnerId]),
      ).toBe(true);
    }
    expect(dealOwnerChangedPayloadSchema.safeParse(created).success).toBe(false);
    // A change of details names what changed, once each, in its order (ADR-275).
    const updated = { ...created, type: 'deal.updated' };
    for (const changes of [
      ['title'],
      ['valueMinor'],
      ['expectedCloseOn'],
      ['title', 'valueMinor', 'expectedCloseOn'],
    ]) {
      expect(
        dealUpdatedPayloadSchema.safeParse({ ...updated, data: { ...created.data, changes } })
          .success,
        JSON.stringify(changes),
      ).toBe(true);
    }
    for (const changes of [[], ['owner'], ['lostReason'], undefined]) {
      expect(
        dealUpdatedPayloadSchema.safeParse({ ...updated, data: { ...created.data, changes } })
          .success,
        JSON.stringify(changes),
      ).toBe(false);
    }
    expect(WEBHOOK_DEAL_DETAIL_CHANGES).toEqual(['title', 'valueMinor', 'expectedCloseOn']);
    expect(dealUpdatedPayloadSchema.safeParse(created).success).toBe(false);
    // Who made what the event reports, as captured (ADR-277): each kind, the key for a key's
    // change, or nobody when the change did not record it (erasure's retitling).
    expect(CRM_CHANGERS).toEqual(['member', 'automation', 'api']);
    for (const [changedBy, apiKeyId] of [
      ['member', null],
      ['automation', null],
      ['api', base.id],
      [null, null],
    ]) {
      expect(
        dealUpdatedPayloadSchema.safeParse({
          ...updated,
          data: { ...created.data, deal: { ...deal, changedBy, apiKeyId }, changes: ['title'] },
        }).success,
        String(changedBy),
      ).toBe(true);
    }
    // Every status a deal can reach, from every other one, with a lost deal's reason.
    for (const status of DEAL_STATUSES) {
      for (const previousStatus of DEAL_STATUSES) {
        expect(
          dealStatusChangedPayloadSchema.safeParse({
            ...created,
            type: 'deal.status_changed',
            data: {
              ...created.data,
              deal: {
                ...deal,
                status,
                previousStatus,
                lostReason: status === 'lost' ? 'Budget cut' : null,
              },
            },
          }).success,
          `${previousStatus} → ${status}`,
        ).toBe(true);
      }
    }
    // An automation's deal names the conversation; an erased contact's deal has no number or name,
    // and a deal may have no value, owner or expected date.
    expect(
      dealCreatedPayloadSchema.safeParse({
        ...created,
        data: {
          deal: {
            ...deal,
            title: 'Deal (contact erased)',
            valueMinor: null,
            ownerId: null,
            expectedCloseOn: null,
            createdBy: 'automation',
          },
          conversation,
          contact,
        },
      }).success,
    ).toBe(true);
    // An unknown status or creator, a fraction of the minor unit, a date in another form, an id
    // that is not one, a field left out, or another type is not described.
    for (const change of [
      { status: 'closed' },
      { previousStatus: 'pending' },
      { createdBy: 'import' },
      { valueMinor: 2_500.5 },
      { expectedCloseOn: '31/12/2026' },
      { stageId: 'stage-1' },
      { previousPipelineId: undefined },
      { previousOwnerId: undefined },
      { previousOwnerId: 'asha' },
      { changedBy: 'erasure' },
      { changedBy: undefined },
      { apiKeyId: 'key-1' },
      { apiKeyId: undefined },
    ]) {
      expect(
        dealCreatedPayloadSchema.safeParse({
          ...created,
          data: { ...created.data, deal: { ...deal, ...change } },
        }).success,
        JSON.stringify(change),
      ).toBe(false);
    }
    expect(dealStatusChangedPayloadSchema.safeParse(created).success).toBe(false);
    expect(
      dealCreatedPayloadSchema.safeParse({ ...created, data: { deal, conversation: null } })
        .success,
    ).toBe(false);
  });

  it('describe the task events, without notes (ADR-261)', () => {
    const task = {
      id: base.id,
      title: 'Call Jaya back',
      status: 'open',
      previousStatus: null,
      dueAt: base.createdAt,
      assigneeId: base.id,
      previousAssigneeId: null,
      dealId: null,
      createdBy: 'member',
      createdAt: base.createdAt,
      changedBy: 'member',
      apiKeyId: null,
    };
    const person = { id: base.id, phone: '+919876543210', name: 'Jaya' };
    const created = { ...base, type: 'task.created', data: { task, contact: person } };
    expect(taskCreatedPayloadSchema.safeParse(created).success).toBe(true);
    // A task about a deal or about nobody, without a due time, by each kind of creator.
    for (const createdBy of ['member', 'automation', 'api']) {
      expect(
        taskCreatedPayloadSchema.safeParse({
          ...created,
          data: { task: { ...task, dealId: base.id, dueAt: null, createdBy }, contact: null },
        }).success,
        createdBy,
      ).toBe(true);
    }
    // Every status a task can reach, from every other one.
    for (const status of TASK_STATUSES) {
      for (const previousStatus of TASK_STATUSES) {
        expect(
          taskStatusChangedPayloadSchema.safeParse({
            ...created,
            type: 'task.status_changed',
            data: { ...created.data, task: { ...task, status, previousStatus } },
          }).success,
          `${previousStatus} → ${status}`,
        ).toBe(true);
      }
    }
    // A task given to another member, open or closed (ADR-274).
    for (const status of TASK_STATUSES) {
      expect(
        taskAssigneeChangedPayloadSchema.safeParse({
          ...created,
          type: 'task.assignee_changed',
          data: { ...created.data, task: { ...task, status, previousAssigneeId: base.id } },
        }).success,
        status,
      ).toBe(true);
    }
    expect(taskAssigneeChangedPayloadSchema.safeParse(created).success).toBe(false);
    // A change of details names what changed, once each, in its order, open or closed (ADR-276).
    const updated = { ...created, type: 'task.updated' };
    for (const changes of [
      ['title'],
      ['notes'],
      ['dueAt'],
      ['remindAt'],
      ['title', 'notes', 'dueAt', 'remindAt'],
    ]) {
      for (const status of TASK_STATUSES) {
        expect(
          taskUpdatedPayloadSchema.safeParse({
            ...updated,
            data: { ...created.data, task: { ...task, status }, changes },
          }).success,
          `${JSON.stringify(changes)} ${status}`,
        ).toBe(true);
      }
    }
    for (const changes of [[], ['assignee'], ['status'], ['reminder'], ['due'], undefined]) {
      expect(
        taskUpdatedPayloadSchema.safeParse({ ...updated, data: { ...created.data, changes } })
          .success,
        JSON.stringify(changes),
      ).toBe(false);
    }
    expect(WEBHOOK_TASK_DETAIL_CHANGES).toEqual(['title', 'notes', 'dueAt', 'remindAt']);
    expect(taskUpdatedPayloadSchema.safeParse(created).success).toBe(false);
    // An unknown status or creator, an id or time that is not one, a field left out, or another
    // type is not described; a task always has an assignee.
    for (const change of [
      { status: 'closed' },
      { previousStatus: 'won' },
      { createdBy: 'import' },
      { assigneeId: 'agent-1' },
      { assigneeId: null },
      { previousAssigneeId: 'agent-1' },
      { previousAssigneeId: undefined },
      { dueAt: '2026-10-09' },
      { dealId: undefined },
      { changedBy: 'erasure' },
      { changedBy: undefined },
      { apiKeyId: 'key-1' },
    ]) {
      expect(
        taskCreatedPayloadSchema.safeParse({
          ...created,
          data: { ...created.data, task: { ...task, ...change } },
        }).success,
        JSON.stringify(change),
      ).toBe(false);
    }
    expect(taskStatusChangedPayloadSchema.safeParse(created).success).toBe(false);
    expect(taskCreatedPayloadSchema.safeParse({ ...created, data: { task } }).success).toBe(false);
    // A task is sent without its notes or reminder, which GET /tasks/{id} reads, even when they
    // are what changed.
    for (const schema of [taskCreatedPayloadSchema, taskUpdatedPayloadSchema]) {
      expect(Object.keys(schema.shape.data.shape.task.shape)).toEqual([
        'id',
        'title',
        'status',
        'previousStatus',
        'dueAt',
        'assigneeId',
        'previousAssigneeId',
        'dealId',
        'createdBy',
        'createdAt',
        'changedBy',
        'apiKeyId',
      ]);
    }
    // A key's change names the key; a change that did not record its maker names nobody (ADR-277).
    for (const [changedBy, apiKeyId] of [
      ['api', base.id],
      [null, null],
    ]) {
      expect(
        taskStatusChangedPayloadSchema.safeParse({
          ...created,
          type: 'task.status_changed',
          data: { ...created.data, task: { ...task, status: 'done', changedBy, apiKeyId } },
        }).success,
        String(changedBy),
      ).toBe(true);
    }
    expect(Object.keys(taskUpdatedPayloadSchema.shape.data.shape)).toEqual([
      'task',
      'contact',
      'changes',
    ]);
    // The database takes exactly the events the API describes, in its order.
    expect([...WEBHOOK_EVENT_TYPES]).toEqual([...WEBHOOK_EVENT_KEYS]);
    expect(WEBHOOK_EVENT_INFO['task.created'].label).toBe('Task added');
    expect(WEBHOOK_EVENT_INFO['task.updated']).toEqual({
      label: 'Task details',
      description:
        'A CRM task’s title, notes, due time or reminder changed: by a member or an API key.',
    });
    expect(WEBHOOK_EVENT_INFO['task.assignee_changed']).toEqual({
      label: 'Task assignee',
      description: 'A CRM task was given to another member: by a member or an API key.',
    });
    expect(WEBHOOK_EVENT_INFO['task.status_changed']).toEqual({
      label: 'Task done, cancelled or reopened',
      description: 'A CRM task was completed, cancelled or reopened: by a member or an API key.',
    });
  });

  it('refuse a body of another type or with an unknown status', () => {
    expect(pingPayloadSchema.safeParse({ ...base, type: 'message.status', data: {} }).success).toBe(
      false,
    );
    expect(
      messageStatusPayloadSchema.safeParse({
        ...base,
        type: 'message.status',
        data: {
          message: {
            id: base.id,
            status: 'queued',
            templateId: null,
            templateName: null,
            sentBy: 'agent',
            apiKeyId: null,
            campaignId: null,
          },
          error: null,
          conversation,
          contact,
          channel,
        },
      }).success,
    ).toBe(false);
  });
});

describe('webhook labels and hosts', () => {
  it('names status codes and error codes for members', () => {
    expect(webhookErrorLabel(null, 503)).toBe('HTTP 503');
    expect(webhookErrorLabel('timeout', null)).toBe('No answer within 10 seconds');
    expect(webhookErrorLabel('address_blocked', null)).toBe('The address is private or reserved');
    expect(webhookErrorLabel('endpoint_disabled', null)).toBe('The endpoint was turned off');
    expect(webhookErrorLabel('event_gone', null)).toBe('What the event is about no longer exists');
    expect(webhookErrorLabel('payload_failed', null)).toBe('HyFib could not prepare the request');
    expect(webhookErrorLabel(null, null)).toBeNull();
    expect(webhookErrorLabel('something_new', null)).toBe('something_new');
  });

  it('names why a delivery ended without an attempt over the status an earlier attempt left', () => {
    // Attempt 1 got a 503; the delivery then ended at its next claim, which keeps that status.
    expect(webhookErrorLabel('payload_failed', 503)).toBe('HyFib could not prepare the request');
    expect(webhookErrorLabel('event_gone', 500)).toBe('What the event is about no longer exists');
    expect(webhookErrorLabel('endpoint_disabled', 500)).toBe('The endpoint was turned off');
    expect(webhookErrorLabel('interrupted', 502)).toBe('The attempt was interrupted');
  });

  it('takes only the host of an endpoint URL', () => {
    expect(webhookHost('https://hooks.example.com:8443/w360?token=abc')).toBe('hooks.example.com');
    expect(webhookHost('not a url')).toBeNull();
  });
});

describe('the endpoint-disabled email', () => {
  it('names the host, links to the settings and escapes what it shows', () => {
    const email = renderEmail({
      kind: 'webhook.endpoint_disabled',
      companyName: 'Acme <Traders>',
      host: 'hooks.example.com',
      url: 'https://app.example.com/c/acme/settings/webhooks',
    });
    expect(email.subject).toBe('Webhook endpoint turned off · Acme <Traders>');
    expect(email.text).toContain('hooks.example.com');
    expect(email.text).toContain('https://app.example.com/c/acme/settings/webhooks');
    expect(email.html).toContain('Acme &lt;Traders&gt;');
    expect(email.html).not.toContain('<Traders>');
  });
});

describe('replaying failed deliveries (ADR-095)', () => {
  it('offers periods up to the deliveries kept, and says what a replay queued', () => {
    expect(WEBHOOK_REPLAY_PERIODS.map((p) => [p.key, p.hours])).toEqual([
      ['1h', 1],
      ['24h', 24],
      ['7d', 168],
      ['30d', 720],
    ]);
    expect(Math.max(...WEBHOOK_REPLAY_PERIODS.map((p) => p.hours))).toBe(
      WEBHOOK_LIMITS.retentionDays * 24,
    );
    expect(webhookReplaySummary({ queued: 0, more: false })).toBe(
      'No failed deliveries to replay from that period.',
    );
    expect(webhookReplaySummary({ queued: 1, more: false })).toBe('Replaying 1 delivery.');
    expect(webhookReplaySummary({ queued: 12, more: false })).toBe('Replaying 12 deliveries.');
    expect(webhookReplaySummary({ queued: 500, more: true })).toBe(
      'Replaying 500 deliveries. More failed deliveries remain: replay again to queue the next ones.',
    );
  });

  it('says what a replay of every endpoint queued, by endpoint host (ADR-160)', () => {
    const at = (host: string | null, queued: number) => ({ host, queued });
    expect(
      webhookReplayAllSummary({ queued: 0, more: false, endpoints: [at('a.example.com', 0)] }),
    ).toBe('No failed deliveries to replay from that period.');
    expect(
      webhookReplayAllSummary({
        queued: 1,
        more: false,
        endpoints: [at('a.example.com', 0), at('b.example.com', 1)],
      }),
    ).toBe('Replaying 1 delivery: 1 to b.example.com.');
    expect(
      webhookReplayAllSummary({
        queued: 12,
        more: false,
        endpoints: [at('a.example.com', 7), at(null, 5)],
      }),
    ).toBe('Replaying 12 deliveries: 7 to a.example.com, 5 to an endpoint.');
    expect(
      webhookReplayAllSummary({
        queued: 500,
        more: true,
        endpoints: [at('a.example.com', 500), at('b.example.com', 0)],
      }),
    ).toBe(
      'Replaying 500 deliveries: 500 to a.example.com. More failed deliveries remain: replay again to queue the next ones.',
    );
  });
});

describe('the OpenAPI document', () => {
  it('describes each webhook with its signed headers and a body schema that exists', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    expect(Object.keys(doc.webhooks)).toEqual([...WEBHOOK_EVENT_KEYS, 'ping']);
    expect(Object.keys(WEBHOOK_EVENT_INFO)).toEqual([...WEBHOOK_EVENT_KEYS]);
    // Each event has a label of its own, as Settings → Webhooks lists them.
    const labels = Object.values(WEBHOOK_EVENT_INFO).map((info) => info.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(WEBHOOK_EVENT_KEYS).toEqual([
      'message.received',
      'message.status',
      'consent.changed',
      'template.status_changed',
      'conversation.status_changed',
      'conversation.assignment_changed',
      'conversation.team_changed',
      'satisfaction_survey.answered',
      'contact.created',
      'contact.updated',
      'contact.erased',
      'contact.merged',
      'automation.run_started',
      'automation.run_ended',
      'automation.run_step',
      'order.received',
      'order.status_changed',
      'payment_link.status_changed',
      'store_order.cod_answered',
      'store_order.message_skipped',
      'store_order.message_sent',
      'store_checkout.reminder_skipped',
      'store_checkout.reminder_sent',
      'campaign.status_changed',
      'campaign.recipient_skipped',
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
    const schemas = doc.components.schemas as Record<string, unknown>;
    const parameters = doc.components.parameters as Record<string, { name: string }>;
    for (const hook of Object.values(doc.webhooks)) {
      const { $ref: ref } = hook.post.requestBody.content['application/json'].schema as {
        $ref: string;
      };
      expect(schemas[ref.replace('#/components/schemas/', '')]).toBeDefined();
      const headers = hook.post.parameters.map(
        (p) => parameters[p.$ref.replace('#/components/parameters/', '')]?.name,
      );
      expect(headers).toEqual([
        'W360-Signature',
        'W360-Event-Id',
        'W360-Event-Type',
        'W360-Delivery-Id',
        'W360-Delivery-Attempt',
      ]);
      expect(hook.post.security).toEqual([]);
    }
  });

  it('gives every body its time to the microsecond, and createdAt as the same moment to the millisecond (ADR-330)', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = doc.components.schemas as Record<
      string,
      {
        required?: string[];
        properties?: Record<string, { pattern?: string; description?: string }>;
      }
    >;
    for (const [type, hook] of Object.entries(doc.webhooks)) {
      const { $ref: ref } = hook.post.requestBody.content['application/json'].schema as {
        $ref: string;
      };
      const body = schemas[ref.replace('#/components/schemas/', '')];
      expect(body?.required, type).toContain('createdAtExact');
      expect(body?.properties?.createdAtExact?.pattern, type).toBe(WEBHOOK_EXACT_TIME_RE.source);
      expect(body?.properties?.createdAtExact?.description, type).toContain(
        'createdAt to the microsecond, in UTC with six fractional digits (like 2026-10-09T08:15:30.123456Z), so such times sort as text.',
      );
    }
    expect(doc.webhooks['conversation.assignment_changed'].post.description).toContain(
      "createdAtExact gives each change's own time to the microsecond, as it was captured, which tells the two apart.",
    );
    for (const good of ['2026-10-09T08:15:30.123456Z', '2026-12-31T23:59:59.000000Z']) {
      expect(WEBHOOK_EXACT_TIME_RE.test(good), good).toBe(true);
    }
    for (const bad of [
      '2026-10-09T08:15:30.123Z',
      '2026-10-09T08:15:30.1234567Z',
      '2026-10-09T08:15:30.123456',
      '2026-10-09 08:15:30.123456Z',
      '2026-10-09T08:15:30.123456+00:00',
      ' 2026-10-09T08:15:30.123456Z',
    ]) {
      expect(WEBHOOK_EXACT_TIME_RE.test(bad), bad).toBe(false);
    }
    // createdAt is the exact time cut, never rounded, to the millisecond.
    expect(toWebhookMillisecond('2026-10-09T08:15:30.123999Z')).toBe('2026-10-09T08:15:30.123Z');
    expect(toWebhookMillisecond('2026-10-09T08:15:30.000001Z')).toBe('2026-10-09T08:15:30.000Z');
  });

  it('describes the deal events: what each step left, and the order of two from one change (ADR-256)', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const text = (type: 'deal.created' | 'deal.stage_changed' | 'deal.status_changed') =>
      doc.webhooks[type].post.description;
    expect(text('deal.created')).toContain(
      'deal.stageId, deal.pipelineId and deal.status are those it was added with',
    );
    expect(text('deal.stage_changed')).toContain(
      'with deal.previousPipelineId when it moved to another pipeline, and deal.status is its status as it moved',
    );
    expect(text('deal.stage_changed')).toContain('is reopened and then moved');
    expect(text('deal.stage_changed')).toContain('is moved and then closed');
    expect(text('deal.stage_changed')).toContain('the two can have the same createdAt');
    expect(text('deal.status_changed')).toContain('with the stage and pipeline it was in');
    // No number filter narrows them: an endpoint that names numbers still receives every one it
    // takes (pipelines can, ADR-263).
    expect(doc.info.description).toContain(
      'still every consent, contact, template, skipped order message, skipped cart reminder, deal, task and note event it takes',
    );
    const schemas = doc.components.schemas as unknown as Record<
      string,
      { properties: Record<string, { description?: string }> } | undefined
    >;
    const described = (schema: string) => schemas[schema]?.properties.channelIds?.description;
    expect(described('WebhookEndpoint')).toContain(
      'Consent, contact, template, skipped order message, skipped cart reminder, deal, task and note events are not narrowed.',
    );
    expect(described('CreateWebhookEndpoint')).toContain(
      'Consent, contact, template, skipped order message (store_order.message_skipped), skipped cart reminder (store_checkout.reminder_skipped), deal, task and note events belong to no number',
    );
    // The events of a number, every one of them (ADR-348 named those the lists had left out).
    expect(described('WebhookEndpoint')).toContain(
      'message, conversation, satisfaction survey answer, automation run, order, Payment Link, cash on delivery answer, sent order message, sent cart reminder and campaign events',
    );
    expect(doc.info.description).toContain(
      'message, conversation, satisfaction survey answer, automation run, order, Payment Link, cash on delivery answer, sent order message, sent cart reminder and campaign events of those numbers only',
    );
    expect(described('CreateWebhookEndpoint')).toContain(
      `only with an event that happens on a number: ${WEBHOOK_CHANNEL_EVENTS.slice(0, -1).join(', ')} or campaign.recipient_skipped.`,
    );
    expect(
      Object.keys(doc.components.schemas).filter((name) => name.startsWith('WebhookDeal')),
    ).toEqual([
      'WebhookDealCreated',
      'WebhookDealUpdated',
      'WebhookDealStageChanged',
      'WebhookDealOwnerChanged',
      'WebhookDealStatusChanged',
    ]);
    const owned = doc.webhooks['deal.owner_changed'].post.description;
    for (const words of [
      'by a member or an API key',
      'deal.ownerId and deal.previousOwnerId are the change (null for no owner)',
      'reopened, moved, details changed, given to another owner, closed',
      'for the owner the deal left as well as for the one it was given to',
    ]) {
      expect(owned).toContain(words);
    }
    // A change of details (ADR-275).
    const edited = doc.webhooks['deal.updated'].post.description;
    for (const words of [
      'by a member or an API key, or by its contact’s erasure, which retitles it',
      'changes names what changed (title, valueMinor, expectedCloseOn), never the values before',
      'reopened, moved, details changed, given to another owner, closed',
      'Pipelines, stages and owners an endpoint names narrow it as the other deal events',
    ]) {
      expect(edited).toContain(words);
    }
  });

  it('describes who changed an order: a member, a key it names or the Payment Link (ADR-270)', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const description = doc.webhooks['order.status_changed'].post.description;
    for (const words of [
      'order.changedBy who made it',
      'an API key (order.apiKeyId names it, so an integration can tell its own changes',
      'HyFib applying the order’s Payment Link',
    ]) {
      expect(description).toContain(words);
    }
    const order = orderStatusChangedPayloadSchema.shape.data.shape.order.shape;
    expect(order.changedBy.unwrap().options).toEqual(['member', 'api', 'payment_link']);
    expect(order.changedBy.description).toContain('never which member');
    expect(order.apiKeyId.description).toContain('when changedBy is api');
    // order.received names nobody: the customer sent the order.
    expect(orderReceivedPayloadSchema.shape.data.shape.order.shape.changedBy.description).toContain(
      'Null for order.received',
    );
  });

  it('reads who changed a deal or a task as its event captured it, naming a key only for a key’s change (ADR-277)', () => {
    const key = '0192a1b2-0000-7000-8000-00000000000c';
    expect(capturedCrmChanger({ changedBy: 'api', apiKeyId: key })).toEqual({
      changedBy: 'api',
      apiKeyId: key,
    });
    expect(capturedCrmChanger({ changedBy: 'member', apiKeyId: null })).toEqual({
      changedBy: 'member',
      apiKeyId: null,
    });
    expect(capturedCrmChanger({ changedBy: 'automation', apiKeyId: key })).toEqual({
      changedBy: 'automation',
      apiKeyId: null,
    });
    // Nobody: a change that did not record its maker, an event from before, or a maker unknown.
    for (const detail of [
      { changedBy: null, apiKeyId: null },
      {},
      { changedBy: 'erasure' },
      { changedBy: 'payment_link', apiKeyId: key },
    ]) {
      expect(capturedCrmChanger(detail), JSON.stringify(detail)).toEqual({
        changedBy: null,
        apiKeyId: null,
      });
    }
    expect(capturedCrmChanger({ changedBy: 'api', apiKeyId: 42 })).toEqual({
      changedBy: 'api',
      apiKeyId: null,
    });
  });

  it('describes who changed a deal or a task: a member, an automation or a key it names (ADR-277)', () => {
    const deal = dealUpdatedPayloadSchema.shape.data.shape.deal.shape;
    const task = taskUpdatedPayloadSchema.shape.data.shape.task.shape;
    for (const shape of [deal, task]) {
      expect(shape.changedBy.unwrap().options).toEqual(['member', 'automation', 'api']);
      expect(shape.changedBy.description).toContain('never which member');
      expect(shape.changedBy.description).toContain('as it was captured');
      expect(shape.apiKeyId.description).toContain('when changedBy is api');
    }
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    expect(doc.webhooks['deal.created'].post.description).toContain(
      "Every deal event's deal.changedBy says who made what it reports, as captured: a member, an automation or an API key, which deal.apiKeyId names, so an integration that changes deals through the API can tell its own changes",
    );
    expect(doc.webhooks['task.created'].post.description).toContain(
      "Every task event's task.changedBy says who made what it reports, as captured: a member, an automation (which only adds tasks) or an API key, which task.apiKeyId names",
    );
    expect(deal.changedBy.description).toContain('for deal.created, who added the deal');
    expect(deal.changedBy.description).toContain('such as erasure retitling the deal');
    expect(task.changedBy.description).toContain('for task.created, who added the task');
    // Every deal and task event carries them.
    for (const schema of [
      dealCreatedPayloadSchema,
      dealStageChangedPayloadSchema,
      dealOwnerChangedPayloadSchema,
      dealStatusChangedPayloadSchema,
    ]) {
      expect(Object.keys(schema.shape.data.shape.deal.shape).slice(-2)).toEqual([
        'changedBy',
        'apiKeyId',
      ]);
    }
    for (const schema of [
      taskCreatedPayloadSchema,
      taskAssigneeChangedPayloadSchema,
      taskStatusChangedPayloadSchema,
    ]) {
      expect(Object.keys(schema.shape.data.shape.task.shape).slice(-2)).toEqual([
        'changedBy',
        'apiKeyId',
      ]);
    }
  });

  it('describes the task events: the change, what is never sent and what sends nothing (ADR-261)', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const text = (type: 'task.created' | 'task.status_changed') =>
      doc.webhooks[type].post.description;
    for (const words of [
      'by a member, an automation or an API key',
      'task.status is the one it was added with',
      'A task’s notes are never sent: read the task with GET /tasks/{id} (`tasks.read`).',
      'the events of an erased contact’s task are no longer delivered',
    ]) {
      expect(text('task.created')).toContain(words);
    }
    for (const words of [
      'by a member or an API key',
      'task.status and task.previousStatus are the change (open, done or cancelled)',
      'Editing its title, notes, due time or reminder sends task.updated, and giving it to another member task.assignee_changed.',
      'the latest change is the one with the latest createdAt',
    ]) {
      expect(text('task.status_changed')).toContain(words);
    }
    // A change of assignee (ADR-274).
    const reassigned = doc.webhooks['task.assignee_changed'].post.description;
    for (const words of [
      'by a member or an API key',
      'task.assigneeId and task.previousAssigneeId are the change',
      'reopened, details changed, given to another member, closed',
      'for the member the task left as well as for the one it was given to',
    ]) {
      expect(reassigned).toContain(words);
    }
    // A change of details (ADR-276).
    const edited = doc.webhooks['task.updated'].post.description;
    for (const words of [
      'title, notes, due time or reminder changed: by a member or an API key',
      'changes names what changed (title, notes, dueAt, remindAt), never the values before',
      'its notes and reminder are never sent: read them with GET /tasks/{id} (`tasks.read`)',
      'reopened, details changed, given to another member, closed',
      'Assignees an endpoint names narrow it as the other task events',
    ]) {
      expect(edited).toContain(words);
    }
    expect(
      Object.keys(doc.components.schemas).filter((name) => name.startsWith('WebhookTask')),
    ).toEqual([
      'WebhookTaskCreated',
      'WebhookTaskUpdated',
      'WebhookTaskAssigneeChanged',
      'WebhookTaskStatusChanged',
    ]);
  });

  it('builds no body for an event type it does not know, before reading anything', async () => {
    const unreadable = new Proxy(
      {},
      {
        get: () => {
          throw new Error('the database was read');
        },
      },
    ) as unknown as Parameters<typeof buildWebhookPayload>[0];
    const event = {
      id: '0192f3a4-5b6c-7d8e-9f00-112233445566',
      tenantId: '0192f3a4-5b6c-7d8e-9f00-112233445577',
      type: 'contact.forgotten',
      messageId: null,
      conversationId: null,
      contactId: null,
      templateId: null,
      status: null,
      detail: {},
      contactChanges: null,
      tagsAdded: null,
      tagsRemoved: null,
      occurredAt: new Date('2026-10-06T00:00:00Z'),
      occurredAtExact: '2026-10-06T00:00:00.000000Z',
    } as unknown as Parameters<typeof buildWebhookPayload>[1];
    await expect(buildWebhookPayload(unreadable, event, 'endpoint')).rejects.toThrow(
      'No webhook payload is built for events of type contact.forgotten',
    );
  });

  it('stamps every body with its event’s time to the microsecond, createdAt cut from it (ADR-330)', async () => {
    const unreadable = new Proxy(
      {},
      {
        get: () => {
          throw new Error('the database was read');
        },
      },
    ) as unknown as Parameters<typeof buildWebhookPayload>[0];
    const event = {
      id: '0192f3a4-5b6c-7d8e-9f00-112233445566',
      tenantId: '0192f3a4-5b6c-7d8e-9f00-112233445577',
      type: 'ping',
      messageId: null,
      conversationId: null,
      contactId: null,
      templateId: null,
      status: null,
      detail: {},
      contactChanges: null,
      tagsAdded: null,
      tagsRemoved: null,
      // A JavaScript date keeps no microseconds: both times come from the exact one alone.
      occurredAt: new Date('2026-10-09T08:15:30.999Z'),
      occurredAtExact: '2026-10-09T08:15:30.123987Z',
    } as unknown as Parameters<typeof buildWebhookPayload>[1];
    const built = await buildWebhookPayload(
      unreadable,
      event,
      '0192f3a4-5b6c-7d8e-9f00-112233445588',
    );
    expect(built).toMatchObject({
      id: '0192f3a4-5b6c-7d8e-9f00-112233445566',
      type: 'ping',
      createdAt: '2026-10-09T08:15:30.123Z',
      createdAtExact: '2026-10-09T08:15:30.123987Z',
    });
    expect(Object.keys(built)).toEqual(['id', 'type', 'createdAt', 'createdAtExact', 'data']);
    expect(pingPayloadSchema.safeParse(built).success).toBe(true);
  });

  it('describes no event whose time has no form to the microsecond, before reading anything (ADR-330)', async () => {
    const unreadable = new Proxy(
      {},
      {
        get: () => {
          throw new Error('the database was read');
        },
      },
    ) as unknown as Parameters<typeof buildWebhookPayload>[0];
    // An infinite time has none (to_char gives null); a time cut short is not one either.
    for (const occurredAtExact of [null, '2026-10-09T08:15:30.123Z', 'infinity']) {
      const event = {
        id: '0192f3a4-5b6c-7d8e-9f00-112233445566',
        tenantId: '0192f3a4-5b6c-7d8e-9f00-112233445577',
        type: 'ping',
        messageId: null,
        conversationId: null,
        contactId: null,
        templateId: null,
        status: null,
        detail: {},
        contactChanges: null,
        tagsAdded: null,
        tagsRemoved: null,
        occurredAt: new Date(Number.NaN),
        occurredAtExact,
      } as unknown as Parameters<typeof buildWebhookPayload>[1];
      await expect(
        buildWebhookPayload(unreadable, event, '0192f3a4-5b6c-7d8e-9f00-112233445588'),
        String(occurredAtExact),
      ).rejects.toBeInstanceOf(RangeError);
    }
  });

  it('says what a contact.updated changed: always given, a list of parts or null (ADR-121)', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = doc.components.schemas as Record<string, unknown>;
    const updated = schemas.WebhookContactUpdated as {
      properties: {
        data: {
          required?: string[];
          properties: { changes?: { anyOf?: { items?: { pattern?: string } }[] } };
        };
      };
    };
    const data = updated.properties.data;
    expect(data.required).toEqual(['contact', 'changes', 'tagsAdded', 'tagsRemoved']);
    const list = data.properties.changes?.anyOf?.find((s) => s.items);
    expect(list?.items?.pattern).toBe(CONTACT_CHANGE_PART_RE.source);
    expect(data.properties.changes?.anyOf).toContainEqual({ type: 'null' });
    const webhooks = doc.webhooks as Record<string, { post?: { description?: string } }>;
    expect(webhooks['contact.updated']?.post?.description).toContain('The event says which');
  });

  it('gives the tags a contact.updated added and removed, as lists or null (ADR-182)', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = doc.components.schemas as Record<string, unknown>;
    type Tags = { anyOf?: { type?: unknown; items?: { type?: unknown } }[]; description?: string };
    const updated = schemas.WebhookContactUpdated as {
      properties: { data: { properties: { tagsAdded?: Tags; tagsRemoved?: Tags } } };
    };
    const { tagsAdded, tagsRemoved } = updated.properties.data.properties;
    for (const tags of [tagsAdded, tagsRemoved]) {
      expect(tags?.anyOf).toEqual([{ type: 'array', items: { type: 'string' } }, { type: 'null' }]);
      expect(tags?.description).toContain('once the contact is erased');
    }
    expect(tagsAdded?.description).toContain(
      'A tag added and removed again in the same change is in neither list.',
    );
    const webhooks = doc.webhooks as Record<string, { post?: { description?: string } }>;
    expect(webhooks['contact.updated']?.post?.description).toContain(
      'and which tags were added or removed.',
    );
  });

  it('carry a campaign’s results as the API answers them, without the cost estimate members see (ADR-150)', () => {
    const counted: CampaignAnalytics = {
      audience: 10,
      pending: 1,
      skipped: 2,
      canceled: 0,
      queued: 7,
      inProgress: 1,
      sent: 5,
      delivered: 4,
      read: 3,
      failed: 1,
      unknown: 0,
      messageCanceled: 1,
      replied: 2,
      optedOut: 1,
      estimateMicros: 123_000,
      estimateMissing: 1,
      skipReasons: [{ reason: 'no_marketing_opt_in', count: 2 }],
      failureCodes: [{ code: '131049', count: 1 }],
    };
    expect(toCampaignResults(counted)).toEqual({
      audience: 10,
      pending: 1,
      skipped: 2,
      canceled: 0,
      queued: 7,
      inProgress: 1,
      sent: 5,
      delivered: 4,
      read: 3,
      failed: 1,
      unknown: 0,
      messagesCanceled: 1,
      replied: 2,
      optedOut: 1,
      skipReasons: [{ reason: 'no_marketing_opt_in', count: 2 }],
      failureCodes: [{ code: '131049', count: 1 }],
    });
    // The API answers the same schema, and the event describes its results with it.
    expect(apiCampaignResultsSchema).toBe(campaignResultsSchema);
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const schemas = doc.components.schemas as Record<string, unknown>;
    const event = schemas.WebhookCampaignStatusChanged as {
      properties: {
        data: {
          properties: {
            campaign: {
              required?: string[];
              properties: { results?: { anyOf?: unknown[]; description?: string } };
            };
          };
        };
      };
    };
    const campaign = event.properties.data.properties.campaign;
    expect(campaign.required).toContain('results');
    expect(campaign.properties.results?.anyOf).toContainEqual({ type: 'null' });
    expect(campaign.properties.results?.description).toContain(
      'counted when this request was built (the t of its W360-Signature)',
    );
    const webhooks = doc.webhooks as Record<string, { post?: { description?: string } }>;
    expect(webhooks['campaign.status_changed']?.post?.description).toContain(
      'campaign.results are its results as GET /campaigns/{id} counts them, counted when the request is built',
    );
  });
});

describe('endpoint headers (ADR-118)', () => {
  const problems = (headers: unknown) => {
    const result = webhookHeadersSchema.safeParse(headers);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };
  const one = (name: string, value = 'v') => problems([{ name, value }]);

  it('take up to 5 headers with token names and printable ASCII values, trimmed', () => {
    expect(
      webhookHeadersSchema.parse([
        { name: ' Authorization ', value: '  Bearer abc.def  ' },
        { name: 'X-Api-Key', value: 'k=1; "quoted" ~!' },
      ]),
    ).toEqual([
      { name: 'Authorization', value: 'Bearer abc.def' },
      { name: 'X-Api-Key', value: 'k=1; "quoted" ~!' },
    ]);
    expect(webhookHeadersSchema.parse([])).toEqual([]);
    expect(one('a'.repeat(60), 'x'.repeat(WEBHOOK_LIMITS.headerValueLength))).toEqual([]);
    expect(
      problems(
        Array.from({ length: WEBHOOK_LIMITS.headers }, (_, i) => ({ name: `X-H${i}`, value: 'v' })),
      ),
    ).toEqual([]);
  });

  it('refuse the headers HyFib or the transport sets, whatever their case, and Proxy-* and W360-*', () => {
    for (const name of [
      'Content-Type',
      'content-encoding',
      'USER-AGENT',
      'Host',
      'Content-Length',
      'Transfer-Encoding',
      'Connection',
      'Keep-Alive',
      'Upgrade',
      'TE',
      'Trailer',
      'Expect',
      'Accept-Encoding',
      'Proxy-Authorization',
      'proxy-anything',
      'W360-Signature',
      'w360-event-id',
    ]) {
      expect(one(name), name).toEqual(['HyFib sets this header itself.']);
      expect(reservedWebhookHeader(name), name).toBe(true);
    }
    for (const name of [
      'Authorization',
      'X-Api-Key',
      'Accept',
      'Cookie',
      'W360',
      'Proxy',
      'X-W360-Id',
    ]) {
      expect(one(name), name).toEqual([]);
      expect(reservedWebhookHeader(name), name).toBe(false);
    }
  });

  it('refuse bad names and values, more than 5 headers, a header given twice and other keys', () => {
    for (const name of ['X_Key', 'X Key', '-X', '', 'a'.repeat(61), 'Clé', 'X:Y']) {
      expect(one(name), name).toEqual(['Header names use letters, digits and - (at most 60).']);
    }
    expect(one('Authorization', '')).toEqual(['Enter the header’s value.']);
    expect(one('Authorization', '   ')).toEqual(['Enter the header’s value.']);
    expect(one('Authorization', 'x'.repeat(WEBHOOK_LIMITS.headerValueLength + 1))).toEqual([
      `Header values are limited to ${WEBHOOK_LIMITS.headerValueLength} characters.`,
    ]);
    // No line breaks (a header injected after them), tabs or characters outside printable ASCII.
    for (const value of ['a\r\nX-Injected: 1', 'a\nb', 'a\tb', 'café', 'a\u0000b']) {
      expect(one('Authorization', value), JSON.stringify(value)).toEqual([
        'Header values use printable ASCII characters, without line breaks.',
      ]);
    }
    expect(
      problems(
        Array.from({ length: WEBHOOK_LIMITS.headers + 1 }, (_, i) => ({
          name: `X-H${i}`,
          value: 'v',
        })),
      ),
    ).toEqual([`An endpoint can have at most ${WEBHOOK_LIMITS.headers} headers.`]);
    expect(
      problems([
        { name: 'X-Key', value: 'a' },
        { name: 'x-key', value: 'b' },
      ]),
    ).toEqual(['Give each header once.']);
    expect(problems([{ name: 'X-Key', value: 'a', secret: true }])).toHaveLength(1);
    expect(problems({ 'X-Key': 'a' })).toHaveLength(1);
  });

  it('are sealed bound to the company and the endpoint, and opened only there', () => {
    const ring = new Keyring({ primaryKeyId: 'k1', keys: { k1: randomBytes(32) } });
    const tenant = '0192a1b2-0000-7000-8000-00000000000a';
    const endpoint = '0192a1b2-0000-7000-8000-00000000000b';
    const other = '0192a1b2-0000-7000-8000-00000000000c';
    const sealed = sealWebhookHeaders(ring, tenant, endpoint, [
      { name: 'Authorization', value: 'Bearer abc' },
      { name: 'X-Api-Key', value: 'k-1' },
    ]);
    expect(sealed.headerNames).toEqual(['Authorization', 'X-Api-Key']);
    expect(sealed.headersCiphertext).not.toMatch(/Bearer|abc|k-1/);
    expect(openWebhookHeaders(ring, tenant, endpoint, sealed.headersCiphertext)).toEqual({
      Authorization: 'Bearer abc',
      'X-Api-Key': 'k-1',
    });
    expect(() => openWebhookHeaders(ring, other, endpoint, sealed.headersCiphertext)).toThrow();
    expect(() => openWebhookHeaders(ring, tenant, other, sealed.headersCiphertext)).toThrow();
    // No headers seal nothing, and nothing sealed opens as no headers.
    expect(sealWebhookHeaders(ring, tenant, endpoint, [])).toEqual({
      headerNames: [],
      headersCiphertext: null,
    });
    expect(openWebhookHeaders(ring, tenant, endpoint, null)).toEqual({});
    // What the seal never writes is refused when opened: a name HyFib sets, or not a list of pairs.
    const aad = webhookHeadersAad(tenant, endpoint);
    for (const content of [
      [['W360-Signature', 't=1,v1=00']],
      [['content-type', 'text/plain']],
      { Authorization: 'Bearer abc' },
      [['Authorization']],
      [['Authorization', 'Bearer abc', 'X-Extra']],
      [[1, 'x']],
      [['Authorization', 2]],
    ]) {
      expect(
        () =>
          openWebhookHeaders(ring, tenant, endpoint, ring.encrypt(JSON.stringify(content), aad)),
        JSON.stringify(content),
      ).toThrow(/^Sealed webhook headers/);
    }
  });
});

describe('message status filters (ADR-119)', () => {
  it('take 1 to 8 known statuses, once each, in the order a message reaches them; null takes every status', () => {
    expect(webhookMessageStatusesSchema.parse(['failed', 'delivered', 'failed'])).toEqual([
      'delivered',
      'failed',
    ]);
    expect(webhookMessageStatusesSchema.parse(null)).toBeNull();
    expect(webhookMessageStatusesSchema.parse([...WEBHOOK_MESSAGE_STATUSES].reverse())).toEqual([
      ...WEBHOOK_MESSAGE_STATUSES,
    ]);
    for (const refused of [[], ['queued'], ['Failed'], 'failed', Array(9).fill('failed')]) {
      expect(webhookMessageStatusesSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(Object.keys(WEBHOOK_MESSAGE_STATUS_LABELS)).toEqual([...WEBHOOK_MESSAGE_STATUSES]);
  });

  it('are kept only while the endpoint takes message.status: given, kept, or cleared', () => {
    const both = ['message.status', 'consent.changed'] as const;
    expect(webhookMessageStatusesFor([...both], ['failed'], null)).toEqual(['failed']);
    expect(webhookMessageStatusesFor([...both], undefined, ['read'])).toEqual(['read']);
    expect(webhookMessageStatusesFor([...both], null, ['read'])).toBeNull();
    expect(webhookMessageStatusesFor([...both], undefined, null)).toBeNull();
    expect(webhookMessageStatusesFor(['consent.changed'], ['failed'], ['read'])).toBeNull();
    expect(webhookMessageStatusesFor(['consent.changed'], undefined, ['read'])).toBeNull();
  });
});

describe('contact part filters (ADR-123)', () => {
  it('take 1 to 5 known parts, once each, in the order Settings lists them; null takes every change', () => {
    expect(webhookContactPartsSchema.parse(['tags', 'email', 'tags'])).toEqual(['email', 'tags']);
    expect(webhookContactPartsSchema.parse(null)).toBeNull();
    expect(webhookContactPartsSchema.parse([...WEBHOOK_CONTACT_PARTS].reverse())).toEqual([
      ...WEBHOOK_CONTACT_PARTS,
    ]);
    expect(WEBHOOK_CONTACT_PARTS).toEqual(['name', 'phone', 'email', 'tags', 'fields']);
    // A part is what a change names before its first dot: fields.<key> is fields.
    for (const part of WEBHOOK_CONTACT_PARTS) {
      expect(CONTACT_CHANGE_PART_RE.test(part === 'fields' ? 'fields.plan' : part)).toBe(true);
    }
    for (const refused of [
      [],
      ['fields.plan'],
      ['Email'],
      ['address'],
      'email',
      Array(6).fill('email'),
    ]) {
      expect(webhookContactPartsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(Object.keys(WEBHOOK_CONTACT_PART_LABELS)).toEqual([...WEBHOOK_CONTACT_PARTS]);
  });

  it('are kept only while the endpoint takes contact.updated: given, kept, or cleared', () => {
    const both = ['contact.updated', 'contact.erased'] as const;
    expect(webhookContactPartsFor([...both], ['email'], null)).toEqual(['email']);
    expect(webhookContactPartsFor([...both], undefined, ['tags'])).toEqual(['tags']);
    expect(webhookContactPartsFor([...both], null, ['tags'])).toBeNull();
    expect(webhookContactPartsFor([...both], undefined, null)).toBeNull();
    expect(webhookContactPartsFor(['contact.erased'], ['email'], ['tags'])).toBeNull();
    expect(webhookContactPartsFor(['contact.created'], undefined, ['tags'])).toBeNull();
  });
});

describe('automation filters (ADR-145)', () => {
  const greeter = '0e1a2b3c-4d5e-4f60-8172-8394a5b6c7d8';
  const farewell = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';

  it('take 1 to 20 automation ids, once each and in lower case, in the order given; null takes every automation', () => {
    expect(
      webhookAutomationIdsSchema.parse([farewell, greeter.toUpperCase(), farewell, greeter]),
    ).toEqual([farewell, greeter]);
    expect(webhookAutomationIdsSchema.parse(null)).toBeNull();
    const ids = Array.from(
      { length: WEBHOOK_LIMITS.automations + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(WEBHOOK_LIMITS.automations).toBe(20);
    expect(webhookAutomationIdsSchema.parse(ids.slice(1))).toEqual(ids.slice(1));
    for (const refused of [[], ids, ['greeter'], [greeter, null], greeter, [42]]) {
      expect(webhookAutomationIdsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookAutomationIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one automation, or take every automation.',
    );
    expect(webhookAutomationIdsSchema.safeParse(ids).error?.issues[0]?.message).toBe(
      'Choose at most 20 automations.',
    );
  });

  it('apply to the three automation run events and no other', () => {
    expect(WEBHOOK_AUTOMATION_EVENTS).toEqual([
      'automation.run_started',
      'automation.run_ended',
      'automation.run_step',
    ]);
    expect(webhookTakesAutomationRuns(['automation.run_started'])).toBe(true);
    expect(webhookTakesAutomationRuns(['automation.run_step'])).toBe(true);
    expect(webhookTakesAutomationRuns(['consent.changed', 'automation.run_ended'])).toBe(true);
    for (const type of WEBHOOK_EVENT_KEYS.filter((t) => !t.startsWith('automation.'))) {
      expect(webhookTakesAutomationRuns([type]), type).toBe(false);
    }
    expect(webhookTakesAutomationRuns([])).toBe(false);
  });

  it('are kept only while the endpoint takes an automation run event: given, kept, or cleared', () => {
    const both = ['automation.run_started', 'automation.run_ended'] as const;
    expect(webhookAutomationIdsFor([...both], [greeter], null)).toEqual([greeter]);
    expect(webhookAutomationIdsFor([...both], undefined, [farewell])).toEqual([farewell]);
    expect(webhookAutomationIdsFor([...both], null, [farewell])).toBeNull();
    expect(webhookAutomationIdsFor([...both], undefined, null)).toBeNull();
    // One of the two events is enough to keep the list.
    expect(webhookAutomationIdsFor(['automation.run_ended'], undefined, [farewell])).toEqual([
      farewell,
    ]);
    // A run's steps narrow alike (ADR-326).
    expect(webhookAutomationIdsFor(['automation.run_step'], undefined, [farewell])).toEqual([
      farewell,
    ]);
    expect(webhookAutomationIdsFor(['consent.changed'], [greeter], [farewell])).toBeNull();
    expect(webhookAutomationIdsFor(['message.received'], undefined, [farewell])).toBeNull();
  });
});

describe('API key filters of run events (ADR-319)', () => {
  const store = '0e1a2b3c-4d5e-4f60-8172-8394a5b6c7d8';
  const crm = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';

  it('take 1 to 20 key ids, once each, in lower case; null takes every run', () => {
    expect(webhookRunApiKeyIdsSchema.parse([store.toUpperCase(), crm, store])).toEqual([
      store,
      crm,
    ]);
    expect(webhookRunApiKeyIdsSchema.parse(null)).toBeNull();
    // As many as a company can have working keys.
    expect(WEBHOOK_LIMITS.runApiKeys).toBe(API_KEY_LIMITS.activeKeys);
    const ids = Array.from(
      { length: 21 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(webhookRunApiKeyIdsSchema.safeParse(ids.slice(1)).success).toBe(true);
    expect(webhookRunApiKeyIdsSchema.safeParse(ids).error?.issues[0]?.message).toBe(
      'Choose at most 20 API keys.',
    );
    expect(webhookRunApiKeyIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one API key, or take every run.',
    );
    // A key's prefix is not its id.
    expect(
      webhookRunApiKeyIdsSchema.safeParse(['w360_aaaaaaaaaaaa']).error?.issues[0]?.message,
    ).toBe('Choose API keys from the list.');
  });

  it('are kept only while the endpoint takes an automation run event: given, kept, or cleared', () => {
    const both = ['automation.run_started', 'automation.run_ended'] as const;
    expect(webhookRunApiKeyIdsFor([...both], [store], null)).toEqual([store]);
    expect(webhookRunApiKeyIdsFor([...both], undefined, [crm])).toEqual([crm]);
    expect(webhookRunApiKeyIdsFor([...both], null, [crm])).toBeNull();
    expect(webhookRunApiKeyIdsFor([...both], undefined, null)).toBeNull();
    // One of the two events is enough to keep the list.
    expect(webhookRunApiKeyIdsFor(['automation.run_started'], undefined, [crm])).toEqual([crm]);
    expect(webhookRunApiKeyIdsFor(['automation.run_ended'], undefined, [crm])).toEqual([crm]);
    expect(webhookRunApiKeyIdsFor(['automation.run_step'], undefined, [crm])).toEqual([crm]);
    expect(webhookRunApiKeyIdsFor(['consent.changed'], [store], [crm])).toBeNull();
    expect(webhookRunApiKeyIdsFor(['message.received'], undefined, [crm])).toBeNull();
  });

  it('name a key as the list of endpoints names the key that added one, and say why it stopped working', () => {
    const key = { id: store, name: 'Store', keyPrefix: 'w360_aaaaaaaaaaaa' };
    expect(webhookApiKeyText({ ...key, state: 'active' })).toBe('“Store” (w360_aaaaaaaaaaaa_…)');
    expect(webhookApiKeyText({ ...key, state: 'revoked' })).toBe(
      '“Store” (w360_aaaaaaaaaaaa_…), revoked',
    );
    expect(webhookApiKeyText({ ...key, state: 'expired' })).toBe(
      '“Store” (w360_aaaaaaaaaaaa_…), expired',
    );
    expect(webhookApiKeyText({ id: store, name: null, keyPrefix: null, state: null })).toBe(
      'Unknown API key',
    );
  });
});

describe('API key filters of message statuses (ADR-320)', () => {
  const store = '0e1a2b3c-4d5e-4f60-8172-8394a5b6c7d8';
  const crm = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';

  it('take 1 to 20 key ids, once each, in lower case; null takes every message', () => {
    expect(webhookMessageApiKeyIdsSchema.parse([crm.toUpperCase(), store, crm])).toEqual([
      crm,
      store,
    ]);
    expect(webhookMessageApiKeyIdsSchema.parse(null)).toBeNull();
    expect(WEBHOOK_LIMITS.messageApiKeys).toBe(API_KEY_LIMITS.activeKeys);
    const ids = Array.from(
      { length: 21 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(webhookMessageApiKeyIdsSchema.safeParse(ids.slice(1)).success).toBe(true);
    expect(webhookMessageApiKeyIdsSchema.safeParse(ids).error?.issues[0]?.message).toBe(
      'Choose at most 20 API keys.',
    );
    expect(webhookMessageApiKeyIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one API key, or take every message.',
    );
    expect(
      webhookMessageApiKeyIdsSchema.safeParse(['w360_aaaaaaaaaaaa']).error?.issues[0]?.message,
    ).toBe('Choose API keys from the list.');
  });

  it('name the keys whose messages carry them: those sending or replying through the API, and those asking for payment', () => {
    expect([...WEBHOOK_MESSAGE_KEY_SCOPES].sort()).toEqual([
      'messages.reply',
      'messages.send',
      'messages.send_marketing',
      'orders.request_payment',
    ]);
  });

  it('are kept only while the endpoint takes message.status: given, kept, or cleared', () => {
    expect(webhookMessageApiKeyIdsFor(['message.status'], [store], null)).toEqual([store]);
    expect(
      webhookMessageApiKeyIdsFor(['message.status', 'message.received'], undefined, [crm]),
    ).toEqual([crm]);
    expect(webhookMessageApiKeyIdsFor(['message.status'], null, [crm])).toBeNull();
    expect(webhookMessageApiKeyIdsFor(['message.status'], undefined, null)).toBeNull();
    // Received messages are not narrowed by key: the list goes with message.status.
    expect(webhookMessageApiKeyIdsFor(['message.received'], [store], [crm])).toBeNull();
    expect(webhookMessageApiKeyIdsFor(['automation.run_started'], undefined, [crm])).toBeNull();
  });
});

describe('API keys left out of deal, task and note events (ADR-321)', () => {
  const store = '0e1a2b3c-4d5e-4f60-8172-8394a5b6c7d8';
  const crm = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';

  it('take 1 to 20 key ids, once each, in lower case; null leaves nothing out', () => {
    expect(webhookCrmExcludedApiKeyIdsSchema.parse([crm.toUpperCase(), store, crm])).toEqual([
      crm,
      store,
    ]);
    expect(webhookCrmExcludedApiKeyIdsSchema.parse(null)).toBeNull();
    expect(WEBHOOK_LIMITS.crmExcludedApiKeys).toBe(API_KEY_LIMITS.activeKeys);
    const ids = Array.from(
      { length: 21 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(webhookCrmExcludedApiKeyIdsSchema.safeParse(ids.slice(1)).success).toBe(true);
    expect(webhookCrmExcludedApiKeyIdsSchema.safeParse(ids).error?.issues[0]?.message).toBe(
      'Choose at most 20 API keys.',
    );
    expect(webhookCrmExcludedApiKeyIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one API key, or take every change.',
    );
  });

  it('name the keys that change deals, tasks or notes', () => {
    expect([...WEBHOOK_CRM_KEY_SCOPES].sort()).toEqual([
      'deals.write',
      'notes.write',
      'tasks.write',
    ]);
  });

  it('are kept only while the endpoint takes a deal, task or note event: given, kept, or cleared', () => {
    for (const type of ['deal.updated', 'task.created', 'note.created'] as const) {
      expect(webhookCrmExcludedApiKeyIdsFor([type], [store], null), type).toEqual([store]);
      expect(webhookCrmExcludedApiKeyIdsFor([type], undefined, [crm]), type).toEqual([crm]);
    }
    expect(webhookCrmExcludedApiKeyIdsFor(['deal.created'], null, [crm])).toBeNull();
    expect(webhookCrmExcludedApiKeyIdsFor(['deal.created'], undefined, null)).toBeNull();
    expect(webhookCrmExcludedApiKeyIdsFor(['contact.updated'], [store], [crm])).toBeNull();
    expect(webhookCrmExcludedApiKeyIdsFor(['automation.run_started'], undefined, [crm])).toBeNull();
  });
});

describe('API keys left out of order changes (ADR-323)', () => {
  const shop = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
  const erp = '3b4c5d6e-7f8a-4b9c-8d0e-2f3a4b5c6d7e';

  it('take 1 to 20 key ids, once each, in lower case; null leaves nothing out', () => {
    expect(webhookOrderExcludedApiKeyIdsSchema.parse([erp.toUpperCase(), shop, erp])).toEqual([
      erp,
      shop,
    ]);
    expect(webhookOrderExcludedApiKeyIdsSchema.parse(null)).toBeNull();
    expect(WEBHOOK_LIMITS.orderExcludedApiKeys).toBe(API_KEY_LIMITS.activeKeys);
    const ids = Array.from(
      { length: 21 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(webhookOrderExcludedApiKeyIdsSchema.safeParse(ids.slice(1)).success).toBe(true);
    expect(webhookOrderExcludedApiKeyIdsSchema.safeParse(ids).error?.issues[0]?.message).toBe(
      'Choose at most 20 API keys.',
    );
    expect(webhookOrderExcludedApiKeyIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one API key, or take every order change.',
    );
  });

  it('name the keys that change orders, asking for payment included', () => {
    expect([...WEBHOOK_ORDER_KEY_SCOPES].sort()).toEqual([
      'orders.request_payment',
      'orders.write',
    ]);
  });

  it('are kept only while the endpoint takes order.status_changed: given, kept, or cleared', () => {
    const both = ['order.status_changed', 'order.received'] as const;
    expect(webhookOrderExcludedApiKeyIdsFor([...both], [shop], null)).toEqual([shop]);
    expect(webhookOrderExcludedApiKeyIdsFor([...both], undefined, [erp])).toEqual([erp]);
    expect(webhookOrderExcludedApiKeyIdsFor([...both], null, [erp])).toBeNull();
    expect(webhookOrderExcludedApiKeyIdsFor([...both], undefined, null)).toBeNull();
    expect(
      webhookOrderExcludedApiKeyIdsFor(
        ['order.received', 'payment_link.status_changed'],
        [shop],
        [erp],
      ),
    ).toBeNull();
    expect(WEBHOOK_ORDER_EXCLUDED_API_KEYS_NEED_THE_EVENT).toBe(
      `Leave out the order changes of API keys only for an endpoint that receives ${WEBHOOK_EVENT_INFO['order.status_changed'].label}.`,
    );
  });
});

describe('API key filters of Payment Link events (ADR-324)', () => {
  const payments = '4c5d6e7f-8a9b-4c0d-9e1f-3a4b5c6d7e8f';
  const shop = '5d6e7f8a-9b0c-4d1e-8f2a-4b5c6d7e8f9a';

  it('take 1 to 20 key ids, once each, in lower case; null takes every link', () => {
    expect(webhookPaymentLinkApiKeyIdsSchema.parse([shop.toUpperCase(), payments, shop])).toEqual([
      shop,
      payments,
    ]);
    expect(webhookPaymentLinkApiKeyIdsSchema.parse(null)).toBeNull();
    expect(WEBHOOK_LIMITS.paymentLinkApiKeys).toBe(API_KEY_LIMITS.activeKeys);
    const ids = Array.from(
      { length: 21 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(webhookPaymentLinkApiKeyIdsSchema.safeParse(ids.slice(1)).success).toBe(true);
    expect(webhookPaymentLinkApiKeyIdsSchema.safeParse(ids).error?.issues[0]?.message).toBe(
      'Choose at most 20 API keys.',
    );
    expect(webhookPaymentLinkApiKeyIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one API key, or take every Payment Link.',
    );
  });

  it('name the keys that ask customers to pay', () => {
    expect([...WEBHOOK_PAYMENT_LINK_KEY_SCOPES]).toEqual(['orders.request_payment']);
  });

  it('are kept only while the endpoint takes payment_link.status_changed: given, kept, or cleared', () => {
    const both = ['payment_link.status_changed', 'order.status_changed'] as const;
    expect(webhookPaymentLinkApiKeyIdsFor([...both], [shop], null)).toEqual([shop]);
    expect(webhookPaymentLinkApiKeyIdsFor([...both], undefined, [payments])).toEqual([payments]);
    expect(webhookPaymentLinkApiKeyIdsFor([...both], null, [payments])).toBeNull();
    expect(webhookPaymentLinkApiKeyIdsFor([...both], undefined, null)).toBeNull();
    // An order's own events have no link asked for.
    expect(
      webhookPaymentLinkApiKeyIdsFor(
        ['order.status_changed', 'order.received'],
        [shop],
        [payments],
      ),
    ).toBeNull();
    expect(WEBHOOK_PAYMENT_LINK_API_KEYS_NEED_THE_EVENT).toBe(
      `Choose API keys only for an endpoint that receives ${WEBHOOK_EVENT_INFO['payment_link.status_changed'].label}.`,
    );
  });
});

describe('campaign status filters (ADR-146)', () => {
  it('take 1 to 7 campaign statuses, once each, in the order a campaign reaches them; null takes every status', () => {
    expect(webhookCampaignStatusesSchema.parse(['completed', 'paused', 'completed'])).toEqual([
      'paused',
      'completed',
    ]);
    expect(webhookCampaignStatusesSchema.parse(null)).toBeNull();
    expect(webhookCampaignStatusesSchema.parse([...WEBHOOK_CAMPAIGN_STATUSES].reverse())).toEqual([
      ...WEBHOOK_CAMPAIGN_STATUSES,
    ]);
    expect(WEBHOOK_CAMPAIGN_STATUSES).toEqual([...CAMPAIGN_STATUSES]);
    for (const refused of [
      [],
      ['sending'],
      ['Paused'],
      'paused',
      [null],
      Array(8).fill('paused'),
    ]) {
      expect(
        webhookCampaignStatusesSchema.safeParse(refused).success,
        JSON.stringify(refused),
      ).toBe(false);
    }
    expect(webhookCampaignStatusesSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one campaign status, or take every status.',
    );
    expect(Object.keys(WEBHOOK_CAMPAIGN_STATUS_LABELS)).toEqual([...WEBHOOK_CAMPAIGN_STATUSES]);
  });

  it('are kept only while the endpoint takes campaign.status_changed: given, kept, or cleared', () => {
    const both = ['campaign.status_changed', 'message.status'] as const;
    expect(webhookCampaignStatusesFor([...both], ['paused'], null)).toEqual(['paused']);
    expect(webhookCampaignStatusesFor([...both], undefined, ['completed'])).toEqual(['completed']);
    expect(webhookCampaignStatusesFor([...both], null, ['completed'])).toBeNull();
    expect(webhookCampaignStatusesFor([...both], undefined, null)).toBeNull();
    expect(webhookCampaignStatusesFor(['message.status'], ['paused'], ['completed'])).toBeNull();
    expect(webhookCampaignStatusesFor(['order.status_changed'], undefined, ['paused'])).toBeNull();
  });
});

describe('order status filters (ADR-147)', () => {
  it('take 1 to 5 of the statuses an order change reaches, once each, in the order an order reaches them; null takes every status', () => {
    expect(webhookOrderStatusesSchema.parse(['cancelled', 'paid', 'cancelled'])).toEqual([
      'paid',
      'cancelled',
    ]);
    expect(webhookOrderStatusesSchema.parse(null)).toBeNull();
    expect(webhookOrderStatusesSchema.parse([...WEBHOOK_ORDER_STATUSES].reverse())).toEqual([
      ...WEBHOOK_ORDER_STATUSES,
    ]);
    // Every order status but `received`, which only order.received reports.
    expect(WEBHOOK_ORDER_STATUSES).toEqual(ORDER_STATUSES.filter((s) => s !== 'received'));
    for (const refused of [
      [],
      ['received'],
      ['canceled'],
      ['Paid'],
      'paid',
      [null],
      Array(6).fill('paid'),
    ]) {
      expect(webhookOrderStatusesSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookOrderStatusesSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one order status, or take every status.',
    );
    expect(Object.keys(WEBHOOK_ORDER_STATUS_LABELS)).toEqual([...WEBHOOK_ORDER_STATUSES]);
  });

  it('are kept only while the endpoint takes order.status_changed: given, kept, or cleared', () => {
    const both = ['order.status_changed', 'order.received'] as const;
    expect(webhookOrderStatusesFor([...both], ['paid'], null)).toEqual(['paid']);
    expect(webhookOrderStatusesFor([...both], undefined, ['fulfilled'])).toEqual(['fulfilled']);
    expect(webhookOrderStatusesFor([...both], null, ['fulfilled'])).toBeNull();
    expect(webhookOrderStatusesFor([...both], undefined, null)).toBeNull();
    expect(webhookOrderStatusesFor(['order.received'], ['paid'], ['fulfilled'])).toBeNull();
    expect(webhookOrderStatusesFor(['campaign.status_changed'], undefined, ['paid'])).toBeNull();
  });
});

describe('Payment Link status filters (ADR-308)', () => {
  it('take 1 to 6 of the statuses a link reaches once created, once each, in the order Orders lists them; null takes every status', () => {
    expect(webhookPaymentLinkStatusesSchema.parse(['failed', 'paid', 'failed'])).toEqual([
      'paid',
      'failed',
    ]);
    expect(webhookPaymentLinkStatusesSchema.parse(null)).toBeNull();
    expect(
      webhookPaymentLinkStatusesSchema.parse([...WEBHOOK_PAYMENT_LINK_STATUSES].reverse()),
    ).toEqual([...WEBHOOK_PAYMENT_LINK_STATUSES]);
    // Every link status but `creating`, which sends no event.
    expect(WEBHOOK_PAYMENT_LINK_STATUSES).toEqual(
      PAYMENT_LINK_STATUSES.filter((s) => s !== 'creating'),
    );
    for (const refused of [
      [],
      ['creating'],
      ['canceled'],
      ['Paid'],
      'paid',
      [null],
      Array(7).fill('paid'),
    ]) {
      expect(
        webhookPaymentLinkStatusesSchema.safeParse(refused).success,
        JSON.stringify(refused),
      ).toBe(false);
    }
    expect(webhookPaymentLinkStatusesSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one Payment Link status, or take every status.',
    );
    expect(webhookPaymentLinkStatusesSchema.safeParse(['creating']).error?.issues[0]?.message).toBe(
      'Choose Payment Link statuses from the list.',
    );
    expect(
      webhookPaymentLinkStatusesSchema.safeParse(Array(7).fill('paid')).error?.issues[0]?.message,
    ).toBe('Give each Payment Link status once.');
    // Named as Orders names them.
    expect(WEBHOOK_PAYMENT_LINK_STATUS_LABELS).toEqual({
      created: 'Waiting for payment',
      partially_paid: 'Partly paid',
      paid: 'Paid',
      expired: 'Expired',
      cancelled: 'Cancelled',
      failed: 'Not created',
    });
    expect(Object.keys(WEBHOOK_PAYMENT_LINK_STATUS_LABELS)).toEqual([
      ...WEBHOOK_PAYMENT_LINK_STATUSES,
    ]);
  });

  it('are kept only while the endpoint takes payment_link.status_changed: given, kept, or cleared', () => {
    const both = ['payment_link.status_changed', 'order.status_changed'] as const;
    expect(webhookPaymentLinkStatusesFor([...both], ['paid'], null)).toEqual(['paid']);
    expect(webhookPaymentLinkStatusesFor([...both], undefined, ['failed'])).toEqual(['failed']);
    expect(webhookPaymentLinkStatusesFor([...both], null, ['failed'])).toBeNull();
    expect(webhookPaymentLinkStatusesFor([...both], undefined, null)).toBeNull();
    // The order's own events have no link status to choose.
    expect(
      webhookPaymentLinkStatusesFor(['order.status_changed'], ['paid'], ['failed']),
    ).toBeNull();
    expect(WEBHOOK_PAYMENT_LINK_STATUSES_NEED_THE_EVENT).toBe(
      `Choose Payment Link statuses only for an endpoint that receives ${WEBHOOK_EVENT_INFO['payment_link.status_changed'].label}.`,
    );
  });
});

describe('run step outcome filters (ADR-327)', () => {
  it('take 1 to 21 of the outcomes a run’s log records, once each, in the log’s order; null takes every step', () => {
    expect(webhookRunStepOutcomesSchema.parse(['failed', 'sent', 'failed'])).toEqual([
      'sent',
      'failed',
    ]);
    expect(webhookRunStepOutcomesSchema.parse(null)).toBeNull();
    expect(webhookRunStepOutcomesSchema.parse([...WEBHOOK_RUN_STEP_OUTCOMES].reverse())).toEqual([
      ...WEBHOOK_RUN_STEP_OUTCOMES,
    ]);
    // Every outcome the log records, as automation.run_step's step.outcome names them.
    expect(WEBHOOK_RUN_STEP_OUTCOMES).toEqual([...AUTOMATION_STEP_OUTCOMES]);
    expect(WEBHOOK_RUN_STEP_OUTCOMES).toHaveLength(21);
    for (const refused of [
      [],
      ['running'],
      ['Sent'],
      ['sent', 'queued'],
      'sent',
      [null],
      Array(22).fill('sent'),
    ]) {
      expect(webhookRunStepOutcomesSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookRunStepOutcomesSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one step outcome, or take every step.',
    );
    expect(webhookRunStepOutcomesSchema.safeParse(['running']).error?.issues[0]?.message).toBe(
      'Choose step outcomes from the list.',
    );
    expect(
      webhookRunStepOutcomesSchema.safeParse(Array(22).fill('sent')).error?.issues[0]?.message,
    ).toBe('Give each step outcome once.');
    // Named as a run's page names them, in the list's order.
    expect(Object.keys(WEBHOOK_RUN_STEP_OUTCOME_LABELS)).toEqual([...WEBHOOK_RUN_STEP_OUTCOMES]);
    expect(WEBHOOK_RUN_STEP_OUTCOME_LABELS).toMatchObject({
      sent: 'Sent a message',
      answered: 'Got an answer',
      timed_out: 'No reply in time',
      failed: 'Failed',
      requested: 'Made a web request',
      skipped: 'Skipped the step',
    });
  });

  it('are kept only while the endpoint takes automation.run_step: given, kept, or cleared', () => {
    const both = ['automation.run_step', 'automation.run_ended'] as const;
    expect(webhookRunStepOutcomesFor([...both], ['failed'], null)).toEqual(['failed']);
    expect(webhookRunStepOutcomesFor([...both], undefined, ['sent'])).toEqual(['sent']);
    expect(webhookRunStepOutcomesFor([...both], null, ['sent'])).toBeNull();
    expect(webhookRunStepOutcomesFor([...both], undefined, null)).toBeNull();
    // The run's own events have no step outcome to choose.
    expect(
      webhookRunStepOutcomesFor(
        ['automation.run_started', 'automation.run_ended'],
        ['failed'],
        ['sent'],
      ),
    ).toBeNull();
    expect(WEBHOOK_RUN_STEP_OUTCOMES_NEED_THE_EVENT).toBe(
      `Choose step outcomes only for an endpoint that receives ${WEBHOOK_EVENT_INFO['automation.run_step'].label}.`,
    );
  });
});

describe('run step kind of node filters (ADR-328)', () => {
  it('take 1 to 18 of the automation builder’s kinds of node and the steps outside one, once each, in its order; null takes every step', () => {
    expect(webhookRunStepNodeTypesSchema.parse(['wait', 'send_text', 'wait'])).toEqual([
      'send_text',
      'wait',
    ]);
    expect(webhookRunStepNodeTypesSchema.parse(['outside_node', 'end'])).toEqual([
      'end',
      'outside_node',
    ]);
    expect(webhookRunStepNodeTypesSchema.parse(null)).toBeNull();
    expect(webhookRunStepNodeTypesSchema.parse([...WEBHOOK_RUN_STEP_NODE_TYPES].reverse())).toEqual(
      [...WEBHOOK_RUN_STEP_NODE_TYPES],
    );
    // Every kind of node a step can run, as automation.run_step's step.nodeType names them, then
    // the steps outside a node (step.nodeType null), so every subset of steps can be named.
    expect(WEBHOOK_RUN_STEP_NODE_TYPES).toEqual([...NODE_TYPES, 'outside_node']);
    expect(WEBHOOK_RUN_STEP_NODE_TYPES).toHaveLength(18);
    // A trigger is not a node: no step runs one.
    for (const refused of [
      [],
      ['keyword'],
      ['api'],
      ['Send_text'],
      'wait',
      [null],
      ['none'],
      Array(19).fill('wait'),
    ]) {
      expect(
        webhookRunStepNodeTypesSchema.safeParse(refused).success,
        JSON.stringify(refused),
      ).toBe(false);
    }
    expect(webhookRunStepNodeTypesSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one kind of step, or take every step.',
    );
    expect(webhookRunStepNodeTypesSchema.safeParse(['keyword']).error?.issues[0]?.message).toBe(
      'Choose kinds of step from the list.',
    );
    expect(
      webhookRunStepNodeTypesSchema.safeParse(Array(19).fill('wait')).error?.issues[0]?.message,
    ).toBe('Give each kind of step once.');
    // Named as the automation builder names them, in the list's order.
    expect(WEBHOOK_RUN_STEP_NODE_TYPE_LABELS).toEqual({
      ...NODE_TYPE_LABELS,
      outside_node:
        'Outside a step (the run starting, being stopped or taken over, or failing between steps)',
    });
    expect(Object.keys(WEBHOOK_RUN_STEP_NODE_TYPE_LABELS)).toEqual([
      ...WEBHOOK_RUN_STEP_NODE_TYPES,
    ]);
  });

  it('are kept only while the endpoint takes automation.run_step: given, kept, or cleared', () => {
    const both = ['automation.run_step', 'automation.run_started'] as const;
    expect(webhookRunStepNodeTypesFor([...both], ['http_request'], null)).toEqual(['http_request']);
    expect(webhookRunStepNodeTypesFor([...both], undefined, ['wait'])).toEqual(['wait']);
    expect(webhookRunStepNodeTypesFor([...both], null, ['wait'])).toBeNull();
    expect(webhookRunStepNodeTypesFor([...both], undefined, null)).toBeNull();
    // The run's own events have no kind of step to choose.
    expect(
      webhookRunStepNodeTypesFor(
        ['automation.run_started', 'automation.run_ended'],
        ['wait'],
        ['end'],
      ),
    ).toBeNull();
    expect(WEBHOOK_RUN_STEP_NODE_TYPES_NEED_THE_EVENT).toBe(
      `Choose kinds of step only for an endpoint that receives ${WEBHOOK_EVENT_INFO['automation.run_step'].label}.`,
    );
  });
});

describe('who made the order changes (ADR-322)', () => {
  it('take 1 to 3 makers, once each, in the order Settings lists them; null takes every change', () => {
    expect(
      webhookOrderChangeMakersSchema.parse(['payment_link', 'member', 'payment_link']),
    ).toEqual(['member', 'payment_link']);
    expect(webhookOrderChangeMakersSchema.parse(['api'])).toEqual(['api']);
    expect(webhookOrderChangeMakersSchema.parse(null)).toBeNull();
    // Every maker an order status change records, as order.status_changed's changedBy names them.
    expect(WEBHOOK_ORDER_CHANGE_MAKERS).toEqual([...ORDER_STATUS_CHANGERS]);
    for (const refused of [
      [],
      ['automation'],
      ['Member'],
      ['member', 'customer'],
      'member',
      [null],
      Array(4).fill('api'),
    ]) {
      expect(
        webhookOrderChangeMakersSchema.safeParse(refused).success,
        JSON.stringify(refused),
      ).toBe(false);
    }
    expect(webhookOrderChangeMakersSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one maker, or take every order change.',
    );
    expect(webhookOrderChangeMakersSchema.safeParse(['automation']).error?.issues[0]?.message).toBe(
      'Choose who made the order changes from the list.',
    );
    expect(
      webhookOrderChangeMakersSchema.safeParse(Array(4).fill('api')).error?.issues[0]?.message,
    ).toBe('Give each maker once.');
    expect(WEBHOOK_ORDER_CHANGE_MAKER_LABELS).toEqual({
      member: 'Members',
      api: 'API keys',
      payment_link: 'Payment Links',
    });
    expect(Object.keys(WEBHOOK_ORDER_CHANGE_MAKER_LABELS)).toEqual([
      ...WEBHOOK_ORDER_CHANGE_MAKERS,
    ]);
  });

  it('are kept only while the endpoint takes order.status_changed: given, kept, or cleared', () => {
    const both = ['order.status_changed', 'order.received'] as const;
    expect(webhookOrderChangeMakersFor([...both], ['member'], null)).toEqual(['member']);
    expect(webhookOrderChangeMakersFor([...both], undefined, ['api'])).toEqual(['api']);
    expect(webhookOrderChangeMakersFor([...both], null, ['api'])).toBeNull();
    expect(webhookOrderChangeMakersFor([...both], undefined, null)).toBeNull();
    // A new order has no maker to choose, nor has a Payment Link's change.
    expect(
      webhookOrderChangeMakersFor(
        ['order.received', 'payment_link.status_changed'],
        ['member'],
        ['api'],
      ),
    ).toBeNull();
    expect(WEBHOOK_ORDER_CHANGE_MAKERS_NEED_THE_EVENT).toBe(
      `Choose who made the order changes only for an endpoint that receives ${WEBHOOK_EVENT_INFO['order.status_changed'].label}.`,
    );
  });
});

describe('deal and task status filters (ADR-309)', () => {
  it('take 1 to 3 of the statuses a deal or a task reaches, once each, in the order the CRM lists them; null takes every status', () => {
    expect(webhookDealStatusesSchema.parse(['lost', 'won', 'lost'])).toEqual(['won', 'lost']);
    expect(webhookTaskStatusesSchema.parse(['cancelled', 'open', 'cancelled'])).toEqual([
      'open',
      'cancelled',
    ]);
    expect(webhookDealStatusesSchema.parse(null)).toBeNull();
    expect(webhookTaskStatusesSchema.parse(null)).toBeNull();
    // Every status a deal or a task has: a change reaches any of them (`open` when reopened).
    expect(WEBHOOK_DEAL_STATUSES).toEqual([...DEAL_STATUSES]);
    expect(WEBHOOK_TASK_STATUSES).toEqual([...TASK_STATUSES]);
    for (const refused of [
      [],
      ['closed'],
      ['Won'],
      ['won', 'done'],
      'won',
      [null],
      Array(4).fill('won'),
    ]) {
      expect(webhookDealStatusesSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    for (const refused of [
      [],
      ['completed'],
      ['done', 'won'],
      'done',
      [null],
      Array(4).fill('done'),
    ]) {
      expect(webhookTaskStatusesSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookDealStatusesSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one deal status, or take every status.',
    );
    expect(webhookDealStatusesSchema.safeParse(['closed']).error?.issues[0]?.message).toBe(
      'Choose deal statuses from the list.',
    );
    expect(
      webhookDealStatusesSchema.safeParse(Array(4).fill('won')).error?.issues[0]?.message,
    ).toBe('Give each deal status once.');
    expect(webhookTaskStatusesSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one task status, or take every status.',
    );
    expect(webhookTaskStatusesSchema.safeParse(['completed']).error?.issues[0]?.message).toBe(
      'Choose task statuses from the list.',
    );
    expect(
      webhookTaskStatusesSchema.safeParse(Array(4).fill('done')).error?.issues[0]?.message,
    ).toBe('Give each task status once.');
    // Named by the change each reports.
    expect(WEBHOOK_DEAL_STATUS_LABELS).toEqual({ open: 'Reopened', won: 'Won', lost: 'Lost' });
    expect(WEBHOOK_TASK_STATUS_LABELS).toEqual({
      open: 'Reopened',
      done: 'Done',
      cancelled: 'Cancelled',
    });
  });

  it('are kept only while the endpoint takes the status changes: given, kept, or cleared', () => {
    const deals = ['deal.status_changed', 'deal.created'] as const;
    expect(webhookDealStatusesFor([...deals], ['won'], null)).toEqual(['won']);
    expect(webhookDealStatusesFor([...deals], undefined, ['lost'])).toEqual(['lost']);
    expect(webhookDealStatusesFor([...deals], null, ['lost'])).toBeNull();
    expect(webhookDealStatusesFor([...deals], undefined, null)).toBeNull();
    // A deal's other events, and a task's status changes, have no deal status to choose.
    expect(
      webhookDealStatusesFor(['deal.created', 'task.status_changed'], ['won'], ['lost']),
    ).toBeNull();
    const tasks = ['task.status_changed', 'task.created'] as const;
    expect(webhookTaskStatusesFor([...tasks], ['done'], null)).toEqual(['done']);
    expect(webhookTaskStatusesFor([...tasks], undefined, ['cancelled'])).toEqual(['cancelled']);
    expect(webhookTaskStatusesFor([...tasks], null, ['cancelled'])).toBeNull();
    expect(webhookTaskStatusesFor([...tasks], undefined, null)).toBeNull();
    expect(
      webhookTaskStatusesFor(['task.created', 'deal.status_changed'], ['done'], ['open']),
    ).toBeNull();
    expect(WEBHOOK_DEAL_STATUSES_NEED_THE_EVENT).toBe(
      `Choose deal statuses only for an endpoint that receives ${WEBHOOK_EVENT_INFO['deal.status_changed'].label}.`,
    );
    expect(WEBHOOK_TASK_STATUSES_NEED_THE_EVENT).toBe(
      `Choose task statuses only for an endpoint that receives ${WEBHOOK_EVENT_INFO['task.status_changed'].label}.`,
    );
  });
});

describe('deal and task detail filters (ADR-310)', () => {
  it('take 1 to 3 deal details or 1 to 4 task details, once each, in the order the events name their changes; null takes every change', () => {
    expect(webhookDealDetailsSchema.parse(['expectedCloseOn', 'title', 'expectedCloseOn'])).toEqual(
      ['title', 'expectedCloseOn'],
    );
    expect(webhookTaskDetailsSchema.parse(['remindAt', 'dueAt', 'remindAt'])).toEqual([
      'dueAt',
      'remindAt',
    ]);
    // Every detail at once, in any order.
    expect(webhookDealDetailsSchema.parse([...WEBHOOK_DEAL_DETAILS].reverse())).toEqual([
      ...WEBHOOK_DEAL_DETAILS,
    ]);
    expect(webhookTaskDetailsSchema.parse([...WEBHOOK_TASK_DETAILS].reverse())).toEqual([
      ...WEBHOOK_TASK_DETAILS,
    ]);
    expect(webhookDealDetailsSchema.parse(null)).toBeNull();
    expect(webhookTaskDetailsSchema.parse(null)).toBeNull();
    // The details the events' changes name, in their order.
    expect(WEBHOOK_DEAL_DETAILS).toEqual([...WEBHOOK_DEAL_DETAIL_CHANGES]);
    expect(WEBHOOK_TASK_DETAILS).toEqual([...WEBHOOK_TASK_DETAIL_CHANGES]);
    for (const refused of [
      [],
      ['value'],
      ['notes'],
      ['Title'],
      'title',
      [null],
      Array(4).fill('title'),
    ]) {
      expect(webhookDealDetailsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    for (const refused of [[], ['due'], ['valueMinor'], 'notes', [null], Array(5).fill('notes')]) {
      expect(webhookTaskDetailsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookDealDetailsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one deal detail, or take every change.',
    );
    expect(webhookDealDetailsSchema.safeParse(['value']).error?.issues[0]?.message).toBe(
      'Choose deal details from the list.',
    );
    expect(
      webhookDealDetailsSchema.safeParse(Array(4).fill('title')).error?.issues[0]?.message,
    ).toBe('Give each deal detail once.');
    expect(webhookTaskDetailsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one task detail, or take every change.',
    );
    expect(webhookTaskDetailsSchema.safeParse(['due']).error?.issues[0]?.message).toBe(
      'Choose task details from the list.',
    );
    expect(
      webhookTaskDetailsSchema.safeParse(Array(5).fill('notes')).error?.issues[0]?.message,
    ).toBe('Give each task detail once.');
    expect(WEBHOOK_DEAL_DETAIL_LABELS).toEqual({
      title: 'Title',
      valueMinor: 'Value',
      expectedCloseOn: 'Expected close date',
    });
    expect(WEBHOOK_TASK_DETAIL_LABELS).toEqual({
      title: 'Title',
      notes: 'Notes',
      dueAt: 'Due time',
      remindAt: 'Reminder',
    });
  });

  it('are kept only while the endpoint takes the detail changes: given, kept, or cleared', () => {
    const deals = ['deal.updated', 'deal.created'] as const;
    expect(webhookDealDetailsFor([...deals], ['title'], null)).toEqual(['title']);
    expect(webhookDealDetailsFor([...deals], undefined, ['valueMinor'])).toEqual(['valueMinor']);
    expect(webhookDealDetailsFor([...deals], null, ['valueMinor'])).toBeNull();
    expect(webhookDealDetailsFor([...deals], undefined, null)).toBeNull();
    // A deal's other events, and a task's detail changes, have no deal detail to choose.
    expect(
      webhookDealDetailsFor(['deal.created', 'task.updated'], ['title'], ['title']),
    ).toBeNull();
    const tasks = ['task.updated', 'task.created'] as const;
    expect(webhookTaskDetailsFor([...tasks], ['notes'], null)).toEqual(['notes']);
    expect(webhookTaskDetailsFor([...tasks], undefined, ['dueAt'])).toEqual(['dueAt']);
    expect(webhookTaskDetailsFor([...tasks], null, ['dueAt'])).toBeNull();
    expect(webhookTaskDetailsFor([...tasks], undefined, null)).toBeNull();
    expect(
      webhookTaskDetailsFor(['task.created', 'deal.updated'], ['title'], ['title']),
    ).toBeNull();
    expect(WEBHOOK_DEAL_DETAILS_NEED_THE_EVENT).toBe(
      `Choose deal details only for an endpoint that receives ${WEBHOOK_EVENT_INFO['deal.updated'].label}.`,
    );
    expect(WEBHOOK_TASK_DETAILS_NEED_THE_EVENT).toBe(
      `Choose task details only for an endpoint that receives ${WEBHOOK_EVENT_INFO['task.updated'].label}.`,
    );
  });
});

describe('survey member and team filters (ADR-311)', () => {
  const id = (i: number) => `0190e9a1-0000-7000-8000-${String(i).padStart(12, '0')}`;
  const ids = (n: number) => Array.from({ length: n }, (_, i) => id(i));

  it('take 1 to 50 members or teams, each once and in lower case; null takes every answer', () => {
    for (const schema of [webhookSurveyAssigneeIdsSchema, webhookSurveyTeamIdsSchema]) {
      expect(schema.parse([id(2), id(1).toUpperCase(), id(2)])).toEqual([id(2), id(1)]);
      expect(schema.parse(null)).toBeNull();
      expect(schema.parse(ids(50))).toEqual(ids(50));
      for (const refused of [[], ['support'], [null], id(1), ids(51)]) {
        expect(schema.safeParse(refused).success, JSON.stringify(refused)).toBe(false);
      }
    }
    expect(WEBHOOK_LIMITS.surveyAssignees).toBe(50);
    expect(WEBHOOK_LIMITS.surveyTeams).toBe(50);
    expect(webhookSurveyAssigneeIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one member, or take every answer.',
    );
    expect(webhookSurveyAssigneeIdsSchema.safeParse(['agent']).error?.issues[0]?.message).toBe(
      'Choose members from the list.',
    );
    expect(webhookSurveyAssigneeIdsSchema.safeParse(ids(51)).error?.issues[0]?.message).toBe(
      'Choose at most 50 members.',
    );
    expect(webhookSurveyTeamIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one team, or take every answer.',
    );
    expect(webhookSurveyTeamIdsSchema.safeParse(['support']).error?.issues[0]?.message).toBe(
      'Choose teams from the list.',
    );
    expect(webhookSurveyTeamIdsSchema.safeParse(ids(51)).error?.issues[0]?.message).toBe(
      'Choose at most 50 teams.',
    );
  });

  it('are kept only while the endpoint takes survey answers: given, kept, or cleared', () => {
    const answers = ['satisfaction_survey.answered', 'conversation.status_changed'] as const;
    for (const listFor of [webhookSurveyAssigneeIdsFor, webhookSurveyTeamIdsFor]) {
      expect(listFor([...answers], [id(1)], null)).toEqual([id(1)]);
      expect(listFor([...answers], undefined, [id(2)])).toEqual([id(2)]);
      expect(listFor([...answers], null, [id(2)])).toBeNull();
      expect(listFor([...answers], undefined, null)).toBeNull();
      // Conversations' own events have no answer to narrow.
      expect(
        listFor(['conversation.status_changed', 'message.received'], [id(1)], [id(1)]),
      ).toBeNull();
    }
    const event = WEBHOOK_EVENT_INFO['satisfaction_survey.answered'].label;
    expect(WEBHOOK_SURVEY_ASSIGNEES_NEED_THE_EVENT).toBe(
      `Choose the members credited with answers only for an endpoint that receives ${event}.`,
    );
    expect(WEBHOOK_SURVEY_TEAMS_NEED_THE_EVENT).toBe(
      `Choose the teams of answered surveys only for an endpoint that receives ${event}.`,
    );
  });
});

describe('survey tag filters (ADR-312)', () => {
  it('take 1 to 50 tags as contacts and conversations carry them, once each, in the order given; null takes every answer', () => {
    const tags = Array.from({ length: 51 }, (_, i) => `tag ${i}`);
    for (const schema of [webhookSurveyContactTagsSchema, webhookSurveyConversationTagsSchema]) {
      expect(schema.parse(['VIP', ' wholesale ', 'vip', 'Gold   Member'])).toEqual([
        'vip',
        'wholesale',
        'gold member',
      ]);
      expect(schema.parse(null)).toBeNull();
      expect(schema.parse(tags.slice(1))).toEqual(tags.slice(1));
      const refusal = (given: unknown) => {
        const issue = schema.safeParse(given).error?.issues[0];
        return issue && [issue.path.join('.'), issue.message];
      };
      expect(refusal([])).toEqual(['', 'Give at least one tag, or take every answer.']);
      expect(refusal(tags)).toEqual(['', 'Give at most 50 tags.']);
      expect(refusal(['vip', 'a,b'])).toEqual([
        '1',
        'Tags cannot contain commas or control characters.',
      ]);
      expect(refusal(['vip', 42])).toEqual(['1', 'Give tags as text.']);
      // Refused at the first entry that is not a tag, once.
      expect(schema.safeParse(['a,b', '   ']).error?.issues.map((i) => i.path.join('.'))).toEqual([
        '0',
      ]);
      expect(schema.safeParse('vip').success).toBe(false);
    }
    expect(WEBHOOK_LIMITS.surveyContactTags).toBe(50);
    expect(WEBHOOK_LIMITS.surveyConversationTags).toBe(50);
  });

  it('are kept only while the endpoint takes survey answers: given, kept, or cleared', () => {
    const answers = ['satisfaction_survey.answered', 'message.received'] as const;
    for (const listFor of [webhookSurveyContactTagsFor, webhookSurveyConversationTagsFor]) {
      expect(listFor([...answers], ['vip'], null)).toEqual(['vip']);
      expect(listFor([...answers], undefined, ['gold'])).toEqual(['gold']);
      expect(listFor([...answers], null, ['gold'])).toBeNull();
      expect(listFor([...answers], undefined, null)).toBeNull();
      // Conversations' own events take the conversations' tag lists, not the answers'.
      expect(
        listFor(['message.received', 'conversation.status_changed'], ['vip'], ['vip']),
      ).toBeNull();
    }
    const event = WEBHOOK_EVENT_INFO['satisfaction_survey.answered'].label;
    expect(WEBHOOK_SURVEY_CONTACT_TAGS_NEED_THE_EVENT).toBe(
      `Choose the contact tags of answered surveys only for an endpoint that receives ${event}.`,
    );
    expect(WEBHOOK_SURVEY_CONVERSATION_TAGS_NEED_THE_EVENT).toBe(
      `Choose the conversation tags of answered surveys only for an endpoint that receives ${event}.`,
    );
  });
});

describe('contact event tag filters (ADR-316)', () => {
  it('take 1 to 50 tags as contacts carry them, once each, in the order given; null takes every contact', () => {
    const tags = Array.from({ length: 51 }, (_, i) => `tag ${i}`);
    const schema = webhookContactEventTagsSchema;
    expect(schema.parse(['VIP', ' wholesale ', 'vip', 'Gold   Member'])).toEqual([
      'vip',
      'wholesale',
      'gold member',
    ]);
    expect(schema.parse(null)).toBeNull();
    expect(schema.parse(tags.slice(1))).toEqual(tags.slice(1));
    const refusal = (given: unknown) => {
      const issue = schema.safeParse(given).error?.issues[0];
      return issue && [issue.path.join('.'), issue.message];
    };
    expect(refusal([])).toEqual(['', 'Give at least one tag, or take every contact.']);
    expect(refusal(tags)).toEqual(['', 'Give at most 50 tags.']);
    expect(refusal(['vip', 'a,b'])).toEqual([
      '1',
      'Tags cannot contain commas or control characters.',
    ]);
    expect(refusal(['vip', 42])).toEqual(['1', 'Give tags as text.']);
    expect(schema.safeParse('vip').success).toBe(false);
    expect(WEBHOOK_LIMITS.contactEventTags).toBe(50);
  });

  it('are kept only while the endpoint takes added or changed contacts: given, kept, or cleared', () => {
    for (const events of [
      ['contact.created'],
      ['contact.updated'],
      ['contact.created', 'contact.updated', 'message.received'],
    ] as const) {
      expect(webhookContactEventTagsFor([...events], ['vip'], null), events.join()).toEqual([
        'vip',
      ]);
      expect(webhookContactEventTagsFor([...events], undefined, ['gold'])).toEqual(['gold']);
      expect(webhookContactEventTagsFor([...events], null, ['gold'])).toBeNull();
      expect(webhookContactEventTagsFor([...events], undefined, null)).toBeNull();
    }
    // Erased and merged contacts, and conversations' events, are not narrowed by these tags.
    expect(
      webhookContactEventTagsFor(
        ['contact.erased', 'contact.merged', 'message.received'],
        ['vip'],
        ['vip'],
      ),
    ).toBeNull();
    const added = WEBHOOK_EVENT_INFO['contact.created'].label;
    const changed = WEBHOOK_EVENT_INFO['contact.updated'].label;
    expect(WEBHOOK_CONTACT_EVENT_TAGS_NEED_THE_EVENTS).toBe(
      `Choose the tags of added and changed contacts only for an endpoint that receives ${added} or ${changed}.`,
    );
  });
});

describe('contact event field value filters (ADR-332)', () => {
  const schema = webhookContactEventFieldValuesSchema;
  const refusal = (given: unknown) => {
    const issue = schema.safeParse(given).error?.issues[0];
    return issue && [issue.path.join('.'), issue.message];
  };

  it('take 1 to 50 pairs of a field key and text, a number or true or false; null takes every contact', () => {
    const pairs = [
      { key: 'tier', value: 'gold' },
      { key: 'score', value: 5 },
      { key: 'vip', value: false },
    ];
    expect(schema.parse(pairs)).toEqual(pairs);
    expect(schema.parse(null)).toBeNull();
    const many = Array.from({ length: 51 }, (_, i) => ({ key: 'tier', value: `t${i}` }));
    expect(schema.parse(many.slice(1))).toHaveLength(50);
    expect(refusal([])).toEqual(['', 'Give at least one value, or take every contact.']);
    expect(refusal(many)).toEqual(['', 'Give at most 50 values.']);
    expect(refusal([{ key: 'Tier', value: 'gold' }])).toEqual([
      '0.key',
      'Choose fields from the list.',
    ]);
    expect(refusal([pairs[0], { key: 'tier', value: null }])).toEqual([
      '1.value',
      'Give text, a number, or true or false.',
    ]);
    expect(refusal([{ key: 'tier', value: { is: 'gold' } }])?.[0]).toBe('0.value');
    expect(refusal([{ key: 'tier', value: Number.POSITIVE_INFINITY }])?.[0]).toBe('0.value');
    expect(refusal([{ key: 'tier', value: 'gold', op: 'eq' }])?.[0]).toBe('0');
    expect(refusal(['tier'])).toEqual(['0', 'Give each value with its field’s key.']);
    expect(schema.safeParse({ tier: 'gold' }).success).toBe(false);
    expect(WEBHOOK_LIMITS.contactEventFieldValues).toBe(50);
    // At most 4,000 bytes as JSON in all, so that the audit entries carrying the list fit.
    expect(WEBHOOK_LIMITS.contactEventFieldValuesBytes).toBe(4000);
    const long = (count: number, length: number) =>
      Array.from({ length: count }, (_, i) => ({ key: 'tier', value: `${i}`.padEnd(length, 'x') }));
    const bytes = (pairs: unknown) => new TextEncoder().encode(JSON.stringify(pairs)).length;
    expect(bytes(long(8, 473))).toBe(3993);
    expect(schema.parse(long(8, 473))).toHaveLength(8);
    const exact = long(8, 474).map((p, i) =>
      i === 7 ? { ...p, value: p.value.slice(0, 473) } : p,
    );
    expect(bytes(exact)).toBe(4000);
    expect(schema.parse(exact)).toHaveLength(8);
    expect(bytes(long(8, 475))).toBe(4009);
    expect(refusal(long(8, 475))).toEqual([
      '',
      'Give shorter or fewer values: at most 4,000 bytes in all, as JSON.',
    ]);
    // Bytes, not characters: 500 Tamil letters are 1,500 bytes.
    expect(refusal(long(3, 500).map((p) => ({ ...p, value: 'த'.repeat(500) })))?.[0]).toBe('');
  });

  it('are kept only while the endpoint takes added or changed contacts: given, kept, or cleared', () => {
    const gold = [{ key: 'tier', value: 'gold' }];
    const silver = [{ key: 'tier', value: 'silver' }];
    for (const events of [
      ['contact.created'],
      ['contact.updated'],
      ['contact.created', 'contact.updated', 'message.received'],
    ] as const) {
      expect(webhookContactEventFieldValuesFor([...events], gold, null), events.join()).toEqual(
        gold,
      );
      expect(webhookContactEventFieldValuesFor([...events], undefined, silver)).toEqual(silver);
      expect(webhookContactEventFieldValuesFor([...events], null, silver)).toBeNull();
      expect(webhookContactEventFieldValuesFor([...events], undefined, null)).toBeNull();
    }
    expect(
      webhookContactEventFieldValuesFor(
        ['contact.erased', 'contact.merged', 'message.received'],
        gold,
        gold,
      ),
    ).toBeNull();
    const added = WEBHOOK_EVENT_INFO['contact.created'].label;
    const changed = WEBHOOK_EVENT_INFO['contact.updated'].label;
    expect(WEBHOOK_CONTACT_EVENT_FIELD_VALUES_NEED_THE_EVENTS).toBe(
      `Choose the field values of added and changed contacts only for an endpoint that receives ${added} or ${changed}.`,
    );
  });

  /** A transaction that answers each read of the company's fields with these, counting reads. */
  function fieldsTx(fields: { key: string; label: string; type: string }[]) {
    let reads = 0;
    const tx = {
      select: () => ({
        from: () => ({
          where: () => {
            reads += 1;
            return Promise.resolve(fields);
          },
        }),
      }),
    } as unknown as Tx;
    return { tx, reads: () => reads };
  }
  const fields = [
    { key: 'tier', label: 'Tier', type: 'text' },
    { key: 'score', label: 'Score', type: 'number' },
    { key: 'joined', label: 'Joined', type: 'date' },
    { key: 'vip', label: 'VIP', type: 'boolean' },
  ];
  async function issues(run: Promise<unknown>) {
    try {
      await run;
    } catch (error) {
      if (isAppError(error) && error.code === 'validation_failed') return error.issues;
      throw error;
    }
    throw new Error('expected a validation error');
  }

  it('read each value a list adds by its field’s type, once each, text whatever its case', async () => {
    const { tx, reads } = fieldsTx(fields);
    expect(
      await webhookContactEventFieldValuesChecked(tx, 'tenant', [
        { key: 'tier', value: ' Gold ' },
        { key: 'tier', value: 'gold' },
        { key: 'score', value: 5 },
        { key: 'score', value: 5.0 },
        { key: 'joined', value: '2026-01-31' },
        { key: 'vip', value: true },
        { key: 'vip', value: false },
      ]),
    ).toEqual([
      { key: 'tier', value: 'Gold' },
      { key: 'score', value: 5 },
      { key: 'joined', value: '2026-01-31' },
      { key: 'vip', value: true },
      { key: 'vip', value: false },
    ]);
    expect(reads()).toBe(1);
    expect(await webhookContactEventFieldValuesChecked(tx, 'tenant', null)).toBeNull();
    expect(reads()).toBe(1);
  });

  it('refuse a value of a field the company does not have, of another type, or empty', async () => {
    const { tx } = fieldsTx(fields);
    const check = (pairs: { key: string; value: string | number | boolean }[]) =>
      issues(webhookContactEventFieldValuesChecked(tx, 'tenant', pairs));
    expect(
      await check([
        { key: 'tier', value: 'gold' },
        { key: 'city', value: 'Chennai' },
      ]),
    ).toEqual([{ path: 'contactEventFieldValues.1.key', message: WEBHOOK_FIELDS_NOT_FOUND }]);
    expect(await check([{ key: 'score', value: '5' }])).toEqual([
      { path: 'contactEventFieldValues.0.value', message: 'Score takes a number.' },
    ]);
    expect(await check([{ key: 'score', value: 1e21 }])).toEqual([
      {
        path: 'contactEventFieldValues.0.value',
        message: 'Score takes a number with at most 15 digits before the point and 6 after.',
      },
    ]);
    expect(await check([{ key: 'joined', value: '2026-02-30' }])).toEqual([
      {
        path: 'contactEventFieldValues.0.value',
        message: 'Joined must be a date written as YYYY-MM-DD.',
      },
    ]);
    expect(await check([{ key: 'vip', value: 'yes' }])).toEqual([
      { path: 'contactEventFieldValues.0.value', message: 'VIP takes true or false.' },
    ]);
    expect(await check([{ key: 'tier', value: '   ' }])).toEqual([
      { path: 'contactEventFieldValues.0.value', message: 'Give a value of Tier to match.' },
    ]);
    expect(await check([{ key: 'tier', value: 'x'.repeat(501) }])).toEqual([
      { path: 'contactEventFieldValues.0.value', message: 'Tier is longer than 500 characters.' },
    ]);
  });

  it('keep the pairs the endpoint held as they were, a deleted field’s among them, without reading them', async () => {
    const { tx, reads } = fieldsTx(fields);
    const held = [
      { key: 'gone', value: 'Old' },
      { key: 'score', value: 7 },
    ];
    expect(
      await webhookContactEventFieldValuesChecked(
        tx,
        'tenant',
        [
          { key: 'gone', value: 'old' },
          { key: 'score', value: 7 },
        ],
        held,
      ),
    ).toEqual([
      { key: 'gone', value: 'old' },
      { key: 'score', value: 7 },
    ]);
    expect(reads()).toBe(0);
    // A value the endpoint did not hold is read, a deleted field's refused.
    expect(
      await issues(
        webhookContactEventFieldValuesChecked(tx, 'tenant', [{ key: 'gone', value: 'new' }], held),
      ),
    ).toEqual([{ path: 'contactEventFieldValues.0.key', message: WEBHOOK_FIELDS_NOT_FOUND }]);
  });

  it('tell pairs apart as the database compares them, and name them as Settings shows them', () => {
    const id = webhookContactFieldValueId;
    expect(id({ key: 'tier', value: 'Gold' })).toBe(id({ key: 'tier', value: 'gold' }));
    expect(id({ key: 'tier', value: 'gold' })).not.toBe(id({ key: 'rank', value: 'gold' }));
    expect(id({ key: 'score', value: 5 })).not.toBe(id({ key: 'score', value: '5' }));
    expect(id({ key: 'vip', value: true })).not.toBe(id({ key: 'vip', value: 'true' }));
    expect(webhookFieldValueText(true)).toBe('yes');
    expect(webhookFieldValueText(false)).toBe('no');
    expect(webhookFieldValueText(2.5)).toBe('2.5');
    expect(webhookFieldValueText('gold')).toBe('gold');
    expect(
      webhookContactEventFieldValuesText(
        [
          { key: 'tier', value: 'gold' },
          { key: 'vip', value: true },
          { key: 'tier', value: 'platinum' },
          { key: 'gone', value: 3 },
        ],
        new Map([
          ['tier', 'Tier'],
          ['vip', 'VIP'],
        ]),
      ),
    ).toBe('Tier: gold, platinum; VIP: yes; gone (deleted): 3');
  });

  it('show in a field’s input only the values it reads back as they are, keeping the others apart', () => {
    expect(webhookFieldValueEditable('boolean', true)).toBe(true);
    expect(webhookFieldValueEditable('number', 2.5)).toBe(true);
    expect(webhookFieldValueEditable('date', '2026-01-31')).toBe(true);
    expect(webhookFieldValueEditable('text', 'gold')).toBe(true);
    expect(webhookFieldValueEditable('text', '2026-01-31')).toBe(true);
    // A field deleted and added again with another type: the value it held is kept apart.
    expect(webhookFieldValueEditable('text', true)).toBe(false);
    expect(webhookFieldValueEditable('boolean', 'yes')).toBe(false);
    expect(webhookFieldValueEditable('number', '5')).toBe(false);
    expect(webhookFieldValueEditable('date', 'gold')).toBe(false);
    expect(webhookFieldValueEditable('date', 5)).toBe(false);
    // Text on several lines, given through the API, would come back as several values.
    expect(webhookFieldValueEditable('text', 'line one\nline two')).toBe(false);
    expect(webhookFieldValueEditable('text', 'line one\rline two')).toBe(false);
    // Every value Settings reads from a line is one it shows again as it is.
    for (const [type, line] of [
      ['text', 'Gold Member'],
      ['number', '5.10'],
      ['number', '-12'],
      ['date', '2026-02-28'],
    ] as const) {
      const read = webhookFieldValuesFromLines({ label: 'F', type }, line);
      if (!read.ok) throw new Error(read.message);
      expect(webhookFieldValueEditable(type, read.values[0]!), line).toBe(true);
      expect(
        webhookFieldValuesFromLines({ label: 'F', type }, webhookFieldValueText(read.values[0]!)),
      ).toEqual(read);
    }
  });

  it('read the lines Settings gives for a field as a member’s entries of it, skipping blank lines', () => {
    const tier = { label: 'Tier', type: 'text' } as const;
    expect(webhookFieldValuesFromLines(tier, ' gold \n\nplatinum\r\n')).toEqual({
      ok: true,
      values: ['gold', 'platinum'],
    });
    expect(webhookFieldValuesFromLines({ label: 'Score', type: 'number' }, '5\n2.50')).toEqual({
      ok: true,
      values: [5, 2.5],
    });
    expect(webhookFieldValuesFromLines({ label: 'Score', type: 'number' }, '5\nfive')).toEqual({
      ok: false,
      message: 'Score must be a number.',
    });
    expect(webhookFieldValuesFromLines({ label: 'Joined', type: 'date' }, '2026-13-01')).toEqual({
      ok: false,
      message: 'Joined must be a date written as YYYY-MM-DD.',
    });
    expect(webhookFieldValuesFromLines(tier, '')).toEqual({ ok: true, values: [] });
  });
});

describe('contact event field words and ranges (ADR-335)', () => {
  const schema = webhookContactEventFieldValuesSchema;
  const refusal = (given: unknown) => {
    const issue = schema.safeParse(given).error?.issues[0];
    return issue && [issue.path.join('.'), issue.message];
  };
  function fieldsTx(fields: { key: string; label: string; type: string }[]) {
    let reads = 0;
    const tx = {
      select: () => ({
        from: () => ({
          where: () => {
            reads += 1;
            return Promise.resolve(fields);
          },
        }),
      }),
    } as unknown as Tx;
    return { tx, reads: () => reads };
  }
  const fields = [
    { key: 'city', label: 'City', type: 'text' },
    { key: 'score', label: 'Score', type: 'number' },
    { key: 'renewal', label: 'Renewal', type: 'date' },
    { key: 'vip', label: 'VIP', type: 'boolean' },
  ];
  async function issues(run: Promise<unknown>) {
    try {
      await run;
    } catch (error) {
      if (isAppError(error) && error.code === 'validation_failed') return error.issues;
      throw error;
    }
    throw new Error('expected a validation error');
  }

  it('take a word, or a range with either end or both, beside the values, one kind a condition', () => {
    const conditions = [
      { key: 'city', value: 'Chennai' },
      { key: 'city', contains: 'chen' },
      { key: 'score', atLeast: 10 },
      { key: 'score', atMost: 2.5 },
      { key: 'renewal', atLeast: '2026-10-01', atMost: '2026-10-31' },
    ];
    expect(schema.parse(conditions)).toEqual(conditions);
    expect(conditions.map((c) => webhookContactFieldKind(c))).toEqual([
      'value',
      'contains',
      'range',
      'range',
      'range',
    ]);
    expect(refusal([{ key: 'city', value: 'Chennai', contains: 'chen' }])).toEqual([
      '0',
      'Give a value, a word or a range with a field’s key, not more than one.',
    ]);
    expect(refusal([{ key: 'score', contains: '5', atMost: 5 }])?.[0]).toBe('0');
    expect(refusal([{ key: 'score', value: 5, atLeast: 1 }])?.[0]).toBe('0');
    expect(refusal([{ key: 'score' }])).toEqual([
      '0',
      'Give a value, a word to look for or a range with each field’s key.',
    ]);
    expect(refusal([{ key: 'city', contains: ['chen'] }])).toEqual([
      '0.contains',
      'Give the word to look for as text.',
    ]);
    for (const end of [null, true, { from: 1 }, Number.NaN]) {
      expect(refusal([{ key: 'score', atLeast: end }])?.[0], String(end)).toBe('0.atLeast');
      expect(refusal([{ key: 'score', atMost: end }])?.[0], String(end)).toBe('0.atMost');
    }
    expect(refusal([{ key: 'score', atLeast: 1, op: 'gte' }])?.[0]).toBe('0');
  });

  it('read a word only for a text field and a range only for a number or date field, by its type', async () => {
    const { tx, reads } = fieldsTx(fields);
    expect(
      await webhookContactEventFieldValuesChecked(tx, 'tenant', [
        { key: 'city', contains: '  Chen  ' },
        { key: 'city', contains: 'CHEN' },
        { key: 'score', atLeast: 10 },
        { key: 'score', atLeast: 10.0 },
        { key: 'score', atLeast: 1, atMost: 1 },
        { key: 'renewal', atMost: '2026-12-31' },
        { key: 'renewal', atLeast: '2026-10-01', atMost: '2026-10-31' },
      ]),
    ).toEqual([
      { key: 'city', contains: 'Chen' },
      { key: 'score', atLeast: 10 },
      { key: 'score', atLeast: 1, atMost: 1 },
      { key: 'renewal', atMost: '2026-12-31' },
      { key: 'renewal', atLeast: '2026-10-01', atMost: '2026-10-31' },
    ]);
    expect(reads()).toBe(1);
    const check = (pairs: Parameters<typeof webhookContactEventFieldValuesChecked>[2]) =>
      issues(webhookContactEventFieldValuesChecked(tx, 'tenant', pairs));
    expect(await check([{ key: 'score', contains: '5' }])).toEqual([
      {
        path: 'contactEventFieldValues.0.contains',
        message: 'Score is not a text field: give a value or a range of it instead.',
      },
    ]);
    expect(await check([{ key: 'vip', contains: 'yes' }])).toEqual([
      {
        path: 'contactEventFieldValues.0.contains',
        message: 'VIP is not a text field: give a value of it instead.',
      },
    ]);
    expect(await check([{ key: 'city', contains: '   ' }])).toEqual([
      { path: 'contactEventFieldValues.0.contains', message: 'Give a word to look for in City.' },
    ]);
    expect(await check([{ key: 'city', contains: 'x'.repeat(501) }])).toEqual([
      {
        path: 'contactEventFieldValues.0.contains',
        message: 'City is longer than 500 characters.',
      },
    ]);
    expect(await check([{ key: 'city', atLeast: 'a' }])).toEqual([
      {
        path: 'contactEventFieldValues.0',
        message: 'City takes no range: give a value or a word to look for of it instead.',
      },
    ]);
    expect(await check([{ key: 'vip', atMost: 1 }])).toEqual([
      {
        path: 'contactEventFieldValues.0',
        message: 'VIP takes no range: give a value of it instead.',
      },
    ]);
    expect(await check([{ key: 'score', atLeast: '5' }])).toEqual([
      { path: 'contactEventFieldValues.0.atLeast', message: 'Score takes a number.' },
    ]);
    expect(await check([{ key: 'score', atMost: 1e21 }])).toEqual([
      {
        path: 'contactEventFieldValues.0.atMost',
        message: 'Score takes a number with at most 15 digits before the point and 6 after.',
      },
    ]);
    expect(await check([{ key: 'renewal', atMost: '2026-02-30' }])).toEqual([
      {
        path: 'contactEventFieldValues.0.atMost',
        message: 'Renewal must be a date written as YYYY-MM-DD.',
      },
    ]);
    expect(await check([{ key: 'renewal', atLeast: 20261001 }])).toEqual([
      {
        path: 'contactEventFieldValues.0.atLeast',
        message: 'Renewal takes a date written as YYYY-MM-DD.',
      },
    ]);
    expect(await check([{ key: 'score', atLeast: 10, atMost: 9.5 }])).toEqual([
      {
        path: 'contactEventFieldValues.0',
        message: 'The range of Score must start at or before its end.',
      },
    ]);
    expect(await check([{ key: 'renewal', atLeast: '2026-11-01', atMost: '2026-10-31' }])).toEqual([
      {
        path: 'contactEventFieldValues.0',
        message: 'The range of Renewal must start at or before its end.',
      },
    ]);
    expect(await check([{ key: 'town', contains: 'x' }])).toEqual([
      { path: 'contactEventFieldValues.0.key', message: WEBHOOK_FIELDS_NOT_FOUND },
    ]);
  });

  it('keep the words and ranges the endpoint held as they were, without reading them', async () => {
    const { tx, reads } = fieldsTx(fields);
    const held = [
      { key: 'gone', contains: 'Old' },
      { key: 'gone', atLeast: 5, atMost: 1 },
    ];
    expect(
      await webhookContactEventFieldValuesChecked(
        tx,
        'tenant',
        [
          { key: 'gone', contains: 'old' },
          { key: 'gone', atLeast: 5, atMost: 1 },
        ],
        held,
      ),
    ).toEqual([
      { key: 'gone', contains: 'old' },
      { key: 'gone', atLeast: 5, atMost: 1 },
    ]);
    expect(reads()).toBe(0);
    // A range whose ends are of another kind than a held one's is not that range: it is read.
    expect(
      await issues(
        webhookContactEventFieldValuesChecked(
          tx,
          'tenant',
          [{ key: 'score', atLeast: '10000' }],
          [{ key: 'score', atLeast: 10000 }],
        ),
      ),
    ).toEqual([{ path: 'contactEventFieldValues.0.atLeast', message: 'Score takes a number.' }]);
  });

  it('tell conditions apart as the database compares them, and name them as Settings shows them', () => {
    const id = webhookContactFieldValueId;
    expect(id({ key: 'city', contains: 'Chen' })).toBe(id({ key: 'city', contains: 'chen' }));
    expect(id({ key: 'city', contains: 'chen' })).not.toBe(id({ key: 'city', value: 'chen' }));
    expect(id({ key: 'score', atLeast: 1 })).not.toBe(id({ key: 'score', atMost: 1 }));
    expect(id({ key: 'score', atLeast: 1, atMost: 2 })).not.toBe(
      id({ key: 'score', atLeast: 1, atMost: 3 }),
    );
    expect(id({ key: 'score', atLeast: 1 })).not.toBe(id({ key: 'rank', atLeast: 1 }));
    expect(id({ key: 'score', atLeast: 10000 })).not.toBe(id({ key: 'score', atLeast: '10000' }));
    expect(id({ key: 'score', atMost: 1 })).not.toBe(id({ key: 'score', atMost: '1' }));
    expect(id({ key: 'score', atLeast: 1, atMost: 2 })).toBe(
      id({ key: 'score', atLeast: 1.0, atMost: 2 }),
    );
    expect(webhookContactFieldConditionText({ key: 'city', contains: 'chen' })).toBe(
      'containing "chen"',
    );
    expect(webhookContactFieldConditionText({ key: 'score', atLeast: 1, atMost: 9 })).toBe(
      '1 to 9',
    );
    expect(webhookContactFieldConditionText({ key: 'score', atLeast: 10 })).toBe('at least 10');
    expect(webhookContactFieldConditionText({ key: 'score', atMost: 2.5 })).toBe('at most 2.5');
    expect(webhookContactFieldConditionText({ key: 'renewal', atLeast: '2026-10-01' })).toBe(
      'from 2026-10-01',
    );
    expect(webhookContactFieldConditionText({ key: 'renewal', atMost: '2026-10-31' })).toBe(
      'until 2026-10-31',
    );
    expect(webhookContactFieldConditionText({ key: 'vip', value: true })).toBe('yes');
    expect(
      webhookContactEventFieldValuesText(
        [
          { key: 'city', value: 'Chennai' },
          { key: 'score', atLeast: 10 },
          { key: 'city', contains: 'chen' },
          { key: 'gone', atLeast: '2026-01-01', atMost: '2026-12-31' },
        ],
        new Map([
          ['city', 'City'],
          ['score', 'Score'],
        ]),
      ),
    ).toBe(
      'City: Chennai, containing "chen"; Score: at least 10; gone (deleted): 2026-01-01 to 2026-12-31',
    );
  });

  it('show a word or a range in a field’s inputs only when they read it back as it is', () => {
    expect(webhookFieldConditionEditable('text', { key: 'f', contains: 'chen' })).toBe(true);
    expect(webhookFieldConditionEditable('text', { key: 'f', contains: 'a\nb' })).toBe(false);
    expect(webhookFieldConditionEditable('number', { key: 'f', contains: 'chen' })).toBe(false);
    expect(webhookFieldConditionEditable('number', { key: 'f', atLeast: 1, atMost: 2 })).toBe(true);
    expect(webhookFieldConditionEditable('number', { key: 'f', atMost: 2 })).toBe(true);
    expect(webhookFieldConditionEditable('number', { key: 'f', atLeast: '2026-01-01' })).toBe(
      false,
    );
    expect(webhookFieldConditionEditable('date', { key: 'f', atLeast: '2026-01-01' })).toBe(true);
    expect(webhookFieldConditionEditable('date', { key: 'f', atMost: '2026-02-30' })).toBe(false);
    expect(webhookFieldConditionEditable('date', { key: 'f', atMost: 5 })).toBe(false);
    expect(webhookFieldConditionEditable('text', { key: 'f', atLeast: 1 })).toBe(false);
    expect(webhookFieldConditionEditable('boolean', { key: 'f', atLeast: 1 })).toBe(false);
    expect(webhookFieldConditionEditable('number', { key: 'f', value: 2 })).toBe(true);
    expect(webhookFieldConditionEditable('number', { key: 'f', value: '2' })).toBe(false);
  });

  it('read the words and the range Settings gives for a field as its entries are read', () => {
    expect(webhookFieldWordsFromLines({ label: 'City' }, ' chen \n\n  Madurai')).toEqual({
      ok: true,
      words: ['chen', 'Madurai'],
    });
    expect(webhookFieldWordsFromLines({ label: 'City' }, 'x'.repeat(501))).toEqual({
      ok: false,
      message: 'City is longer than 500 characters.',
    });
    const score = { key: 'score', label: 'Score', type: 'number' } as const;
    const renewal = { key: 'renewal', label: 'Renewal', type: 'date' } as const;
    expect(webhookFieldRangeFromInputs(score, '', ' ')).toEqual({ ok: true, range: null });
    expect(webhookFieldRangeFromInputs(score, '10', '')).toEqual({
      ok: true,
      range: { key: 'score', atLeast: 10 },
    });
    expect(webhookFieldRangeFromInputs(score, '', '2.5')).toEqual({
      ok: true,
      range: { key: 'score', atMost: 2.5 },
    });
    expect(webhookFieldRangeFromInputs(renewal, '2026-10-01', '2026-10-31')).toEqual({
      ok: true,
      range: { key: 'renewal', atLeast: '2026-10-01', atMost: '2026-10-31' },
    });
    expect(webhookFieldRangeFromInputs(score, 'ten', '')).toMatchObject({ ok: false });
    expect(webhookFieldRangeFromInputs(renewal, '', '2026-02-30')).toMatchObject({ ok: false });
    expect(
      webhookFieldRangeFromInputs({ key: 'city', label: 'City', type: 'text' }, 'a', ''),
    ).toEqual({ ok: false, message: 'City takes no range.' });
    expect(
      webhookFieldRangeFromInputs({ key: 'vip', label: 'VIP', type: 'boolean' }, '', ''),
    ).toEqual({ ok: false, message: 'VIP takes no range.' });
  });
});

describe('words in received messages (ADR-337)', () => {
  const refusal = (given: unknown) => {
    const issue = webhookMessageWordsSchema.safeParse(given).error?.issues[0];
    return issue && [issue.path.join('.'), issue.message];
  };

  it('take 1 to 50 words or phrases, trimmed and kept once whatever their case, in the order given', () => {
    expect(
      webhookMessageWordsSchema.parse(['  Refund ', 'cancel order', 'REFUND', 'a, b', 'பணம்']),
    ).toEqual(['Refund', 'cancel order', 'a, b', 'பணம்']);
    expect(webhookMessageWordsSchema.parse(null)).toBeNull();
    expect(webhookMessageWordsSchema.parse(['x'.repeat(100)])).toEqual(['x'.repeat(100)]);
    expect(
      webhookMessageWordsSchema.parse(Array.from({ length: 50 }, (_, i) => `w${i}`)),
    ).toHaveLength(50);
  });

  it('refuse an empty list, more than 50, a blank word, a long one or one with control characters, by place', () => {
    expect(refusal([])).toEqual(['', 'Give at least one word or phrase, or take every message.']);
    expect(refusal(Array.from({ length: 51 }, (_, i) => `w${i}`))).toEqual([
      '',
      'Give at most 50 words and phrases.',
    ]);
    // Counted as given, before a word given twice is dropped (as Settings counts its lines).
    expect(refusal(Array.from({ length: 100 }, (_, i) => `W${i % 50}`))).toEqual([
      '',
      'Give at most 50 words and phrases.',
    ]);
    expect(refusal(['ok', '  '])).toEqual(['1', 'Give each word or phrase as text, not blank.']);
    expect(refusal(['x'.repeat(101)])).toEqual([
      '0',
      'Give words and phrases of at most 100 characters.',
    ]);
    for (const bad of [
      'a\nb',
      'a\tb',
      'a\u0000b',
      'a\u001fb',
      'a\u007fb',
      'a\u0085b',
      'a\u2028b',
      'a\u2029b',
    ]) {
      expect(refusal(['ok', bad]), JSON.stringify(bad)).toEqual([
        '1',
        'Give words and phrases without line breaks or control characters.',
      ]);
    }
    expect(refusal([5])).toEqual(['0', 'Give the words and phrases as text.']);
    expect(refusal('refund')?.[0]).toBe('');
  });

  it('are kept only while the endpoint takes message.received: given, kept, or cleared', () => {
    expect(webhookMessageWordsFor(['message.received'], ['a'], null)).toEqual(['a']);
    expect(webhookMessageWordsFor(['message.received'], undefined, ['b'])).toEqual(['b']);
    expect(webhookMessageWordsFor(['message.received'], null, ['b'])).toBeNull();
    expect(webhookMessageWordsFor(['message.received'], undefined, null)).toBeNull();
    expect(webhookMessageWordsFor(['message.status'], ['a'], ['b'])).toBeNull();
  });

  it('read the words Settings gives, one a line, and name them as Settings shows them', () => {
    expect(webhookMessageWordsFromLines(' Refund \n\n  cancel order\r\nrefund\n')).toEqual({
      ok: true,
      words: ['Refund', 'cancel order'],
    });
    expect(webhookMessageWordsFromLines('  \n')).toEqual({ ok: true, words: [] });
    expect(webhookMessageWordsFromLines(`ok\n${'x'.repeat(101)}`)).toEqual({
      ok: false,
      message: 'Give words and phrases of at most 100 characters.',
    });
    expect(webhookMessageWordsFromLines('a\u0007b')).toEqual({
      ok: false,
      message: 'Give words and phrases without line breaks or control characters.',
    });
    expect(
      webhookMessageWordsFromLines(Array.from({ length: 51 }, (_, i) => `w${i}`).join('\n')),
    ).toEqual({ ok: false, message: 'Give at most 50 words and phrases.' });
    expect(
      webhookMessageWordsFromLines(Array.from({ length: 100 }, (_, i) => `W${i % 50}`).join('\n')),
    ).toEqual({ ok: false, message: 'Give at most 50 words and phrases.' });
    expect(
      webhookMessageWordsFromLines(Array.from({ length: 50 }, (_, i) => `W${i % 25}`).join('\n\n')),
    ).toEqual({ ok: true, words: Array.from({ length: 25 }, (_, i) => `W${i}`) });
    expect(webhookMessageWordsText(['refund', 'a, b'])).toBe('"refund", "a, b"');
  });
});

describe('endpoint audit entries within an audit entry’s 8 KiB (ADR-336, ADR-363)', () => {
  // A tag of 40 Tamil letters and digits: 114 bytes of UTF-8, as a company's tags may be.
  const tamil = (i: number) => `${'க'.repeat(37)}${String(i).padStart(3, '0')}`;
  const tags = (count: number) => Array.from({ length: count }, (_, i) => tamil(i));
  const digest = (list: unknown[]) => sha256Hex(JSON.stringify(list)).slice(0, 16);
  /** A list as an entry names it when it is too long to name item by item (ADR-363). */
  const named = (list: unknown[]) => `${list.length}:${digest(list)}`;

  it('keep an entry that fits as it is, with room for the source the API adds', () => {
    const metadata = {
      host: 'hooks.example.com',
      eventTypes: ['message.received'],
      contactTags: tags(50),
      teamIds: ['019245c1-5a4c-7b1e-9a1e-1f2d3c4b5a69'],
    };
    expect(jsonbSize(metadata)).toBeLessThanOrEqual(WEBHOOK_LIMITS.auditMetadataBytes);
    expect(webhookEndpointAuditMetadata(metadata)).toBe(metadata);
    expect(WEBHOOK_LIMITS.auditMetadataBytes + jsonbSize({ source: 'api' })).toBeLessThanOrEqual(
      8192,
    );
  });

  it('name the largest lists by length and digest, one after another and by name when as large, until the entry fits', () => {
    const teamIds = ['019245c1-5a4c-7b1e-9a1e-1f2d3c4b5a69'];
    const eventTypes = ['message.received', 'contact.updated', 'satisfaction_survey.answered'];
    // The largest list alone.
    const one = webhookEndpointAuditMetadata({
      host: 'hooks.example.com',
      eventTypes,
      conversationTags: tags(40),
      contactTags: tags(50),
      teamIds,
    });
    expect(one).toEqual({
      host: 'hooks.example.com',
      eventTypes,
      conversationTags: tags(40),
      teamIds,
      lists: { contactTags: named(tags(50)) },
    });
    expect(jsonbSize(one)).toBeLessThanOrEqual(WEBHOOK_LIMITS.auditMetadataBytes);
    // Two lists as large: by name, and only as many as it takes.
    const two = webhookEndpointAuditMetadata({
      host: 'hooks.example.com',
      eventTypes,
      surveyContactTags: tags(50),
      contactTags: tags(50),
      contactEventTags: tags(50),
    });
    expect(two).toEqual({
      host: 'hooks.example.com',
      eventTypes,
      surveyContactTags: tags(50),
      lists: { contactEventTags: named(tags(50)), contactTags: named(tags(50)) },
    });
    // The largest in bytes, not in items: 45 tags take more than 60 ids.
    const ids = Array.from(
      { length: 60 },
      (_, i) => `019245c1-5a4c-7b1e-9a1e-${String(i).padStart(12, '0')}`,
    );
    expect(
      webhookEndpointAuditMetadata({ host: 'h', eventTypes, teamIds: ids, contactTags: tags(45) }),
    ).toEqual({
      host: 'h',
      eventTypes,
      teamIds: ids,
      lists: { contactTags: named(tags(45)) },
    });
    // A list read back from the database, each object's keys in jsonb's order (by length: key,
    // atMost, atLeast), has the digest of the list as the services built it.
    const ranges = Array.from({ length: 50 }, (_, i) => ({
      key: 'score',
      atLeast: i,
      atMost: i + 1,
    }));
    const written = webhookEndpointAuditMetadata({
      host: 'h',
      eventTypes,
      conversationTags: tags(20),
      contactEventFieldValues: ranges,
    });
    // Named by the digest of its JSON with each object's keys in order (atLeast, atMost, key).
    expect(written.lists).toEqual({
      contactEventFieldValues: named(
        ranges.map(({ key, atLeast, atMost }) => ({ atLeast, atMost, key })),
      ),
    });
    expect(
      webhookEndpointAuditMetadata({
        host: 'h',
        eventTypes,
        conversationTags: tags(20),
        contactEventFieldValues: ranges.map(({ key, atLeast, atMost }) => ({
          key,
          atMost,
          atLeast,
        })),
      }).lists,
    ).toEqual(written.lists);
    // A list changed to as many tags has another digest.
    const changed = webhookEndpointAuditMetadata({
      host: 'hooks.example.com',
      eventTypes,
      conversationTags: tags(40),
      contactTags: tags(51).slice(1),
      teamIds,
    });
    expect(changed).toMatchObject({ lists: { contactTags: named(tags(51).slice(1)) } });
    expect((changed.lists as Record<string, string>).contactTags).toMatch(/^50:[0-9a-f]{16}$/);
    expect(changed.lists).not.toEqual(one.lists);
  });

  it('always name the events, of a change or of a replay, and fit with every list named by length and digest', () => {
    const events = Array.from({ length: 60 }, (_, i) => `event.${i}`.padEnd(100, 'x'));
    for (const key of ['eventTypes', 'events']) {
      expect(
        webhookEndpointAuditMetadata({ host: 'h', [key]: events, contactTags: tags(10) }),
      ).toEqual({
        host: 'h',
        [key]: events,
        lists: { contactTags: named(tags(10)) },
      });
    }
    // Every event type, hosts of 253 characters, an OAuth client's method and the 62 lists an
    // entry can name, each too long to keep whole beside the others named (30 tags of 114 bytes):
    // each named by its length and digest (ADR-363), the entry takes under 4,200 (4,075), within
    // the 7,000 kept. The bound is close on purpose, about three lists or four event types above
    // the entry: a filter that adds them raises it, saying what they cost.
    const keys = [
      'assigneeIds',
      'automationIds',
      'campaignIds',
      'campaignSkipReasons',
      'campaignStatuses',
      'cartReminderSkipReasons',
      'cartReminders',
      'channelIds',
      'codAnswers',
      'consentChanges',
      'contactEventFieldValues',
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
      'headers',
      'messageApiKeyIds',
      'messageSenders',
      'messageStatuses',
      'messageTypes',
      'messageWords',
      'noteDealOwnerIds',
      'notePipelineIds',
      'noteStageIds',
      'orderChangeMakers',
      'orderExcludedApiKeyIds',
      'orderMessageEvents',
      'orderMessageSkipReasons',
      'orderStatuses',
      'ownerIds',
      'paymentLinkApiKeyIds',
      'paymentLinkStatuses',
      'pipelineIds',
      'runApiKeyIds',
      'runEndReasons',
      'runEndStatuses',
      'runStepNodeTypes',
      'runStepOutcomes',
      'runTriggers',
      'stageIds',
      'storeIds',
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
    ];
    expect(keys).toHaveLength(62);
    const whole = webhookEndpointAuditMetadata({
      host: 'h'.repeat(253),
      eventTypes: [...WEBHOOK_EVENT_TYPES],
      ...Object.fromEntries(keys.map((key) => [key, tags(30)])),
      // Every OAuth field at once, more than an entry holds: a secret's or a key pair's, and what
      // became of a next key pair (ADR-368).
      oauthTokenHost: 'o'.repeat(253),
      oauthSecretReplaced: true,
      oauthKeyReplaced: true,
      oauthNextKey: 'dropped',
      oauthClientAuthentication: 'client_secret_basic',
    });
    expect(Object.keys(whole.lists as object)).toHaveLength(62);
    expect(jsonbSize(whole)).toBeLessThan(4200);
  });
});

describe('template status filters (ADR-148)', () => {
  it('take 1 to 11 of the statuses a template event reports, once each, in the order Templates lists them; null takes every status', () => {
    expect(webhookTemplateStatusesSchema.parse(['paused', 'rejected', 'paused'])).toEqual([
      'rejected',
      'paused',
    ]);
    expect(webhookTemplateStatusesSchema.parse(null)).toBeNull();
    expect(webhookTemplateStatusesSchema.parse([...WEBHOOK_TEMPLATE_STATUSES].reverse())).toEqual([
      ...WEBHOOK_TEMPLATE_STATUSES,
    ]);
    // Every template status but HyFib's own steps before Meta has the template, a deletion under
    // way or refused (not a template status) and an unrecognised one: none of them is sent.
    expect(WEBHOOK_TEMPLATE_STATUSES).toEqual(
      TEMPLATE_STATUSES.filter(
        (s) => !['draft', 'submitting', 'submit_failed', 'pending_deletion', 'unknown'].includes(s),
      ),
    );
    // The event says which statuses it reports, in the same order.
    expect(templateStatusPayloadSchema.shape.data.shape.template.shape.status.description).toBe(
      `${WEBHOOK_TEMPLATE_STATUSES.slice(0, -1).join(', ')} or ${WEBHOOK_TEMPLATE_STATUSES.at(-1)}.`,
    );
    for (const refused of [
      [],
      ['draft'],
      ['submit_failed'],
      ['pending_deletion'],
      ['delete_failed'],
      ['unknown'],
      ['Approved'],
      'approved',
      [null],
      Array(12).fill('approved'),
    ]) {
      expect(
        webhookTemplateStatusesSchema.safeParse(refused).success,
        JSON.stringify(refused),
      ).toBe(false);
    }
    expect(webhookTemplateStatusesSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one template status, or take every status.',
    );
    expect(Object.keys(WEBHOOK_TEMPLATE_STATUS_LABELS)).toEqual([...WEBHOOK_TEMPLATE_STATUSES]);
  });

  it('are kept only while the endpoint takes template.status_changed: given, kept, or cleared', () => {
    const both = ['template.status_changed', 'message.status'] as const;
    expect(webhookTemplateStatusesFor([...both], ['rejected'], null)).toEqual(['rejected']);
    expect(webhookTemplateStatusesFor([...both], undefined, ['paused'])).toEqual(['paused']);
    expect(webhookTemplateStatusesFor([...both], null, ['paused'])).toBeNull();
    expect(webhookTemplateStatusesFor([...both], undefined, null)).toBeNull();
    expect(webhookTemplateStatusesFor(['message.status'], ['rejected'], ['paused'])).toBeNull();
    expect(
      webhookTemplateStatusesFor(['campaign.status_changed'], undefined, ['paused']),
    ).toBeNull();
  });
});

describe('conversation status filters (ADR-149)', () => {
  it('take 1 or 2 of the statuses a conversation change reaches, once each, in the order the inbox lists them; null takes every status', () => {
    expect(webhookConversationStatusesSchema.parse(['resolved', 'open'])).toEqual([
      'open',
      'resolved',
    ]);
    expect(webhookConversationStatusesSchema.parse(['resolved', 'resolved'])).toEqual(['resolved']);
    expect(webhookConversationStatusesSchema.parse(null)).toBeNull();
    // Every conversation status but `pending`, which nothing sets (ADR-075); the event does not
    // say otherwise.
    expect(WEBHOOK_CONVERSATION_STATUSES).toEqual(
      CONVERSATION_STATUSES.filter((s) => s !== 'pending'),
    );
    expect(WEBHOOK_EVENT_INFO['conversation.status_changed'].description).not.toContain('pending');
    for (const refused of [
      [],
      ['pending'],
      ['closed'],
      ['Resolved'],
      'resolved',
      [null],
      Array(3).fill('open'),
    ]) {
      expect(
        webhookConversationStatusesSchema.safeParse(refused).success,
        JSON.stringify(refused),
      ).toBe(false);
    }
    expect(webhookConversationStatusesSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one conversation status, or take every status.',
    );
    expect(WEBHOOK_CONVERSATION_STATUS_LABELS).toEqual({ open: 'Open', resolved: 'Resolved' });
  });

  it('are kept only while the endpoint takes conversation.status_changed: given, kept, or cleared', () => {
    const both = ['conversation.status_changed', 'conversation.team_changed'] as const;
    expect(webhookConversationStatusesFor([...both], ['resolved'], null)).toEqual(['resolved']);
    expect(webhookConversationStatusesFor([...both], undefined, ['open'])).toEqual(['open']);
    expect(webhookConversationStatusesFor([...both], null, ['open'])).toBeNull();
    expect(webhookConversationStatusesFor([...both], undefined, null)).toBeNull();
    expect(
      webhookConversationStatusesFor(['conversation.team_changed'], ['resolved'], ['open']),
    ).toBeNull();
    expect(
      webhookConversationStatusesFor(['order.status_changed'], undefined, ['open']),
    ).toBeNull();
  });
});

describe('run end filters (ADR-151)', () => {
  it('take 1 to 5 of the statuses a run ends with, once each, in the order an automation’s runs list them; null takes every end', () => {
    expect(webhookRunEndStatusesSchema.parse(['failed', 'completed'])).toEqual([
      'completed',
      'failed',
    ]);
    expect(webhookRunEndStatusesSchema.parse(['failed', 'failed'])).toEqual(['failed']);
    expect(webhookRunEndStatusesSchema.parse(null)).toBeNull();
    // Every status a run can end with; the statuses of a run still going end nothing.
    expect(WEBHOOK_RUN_END_STATUSES).toEqual(
      AUTOMATION_RUN_STATUSES.filter(
        (s) => !(ACTIVE_RUN_STATUSES as readonly string[]).includes(s),
      ),
    );
    for (const refused of [
      [],
      ['running'],
      ['waiting'],
      ['crashed'],
      ['Failed'],
      'failed',
      [null],
      Array(6).fill('failed'),
    ]) {
      expect(webhookRunEndStatusesSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookRunEndStatusesSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one way a run ends, or take every end.',
    );
    expect(WEBHOOK_RUN_END_STATUS_LABELS).toEqual({
      completed: 'Completed',
      handed_off: 'Handed off',
      taken_over: 'Taken over',
      stopped: 'Stopped',
      failed: 'Failed',
    });
  });

  it('are kept only while the endpoint takes automation.run_ended: given, kept, or cleared', () => {
    const both = ['automation.run_started', 'automation.run_ended'] as const;
    expect(webhookRunEndStatusesFor([...both], ['failed'], null)).toEqual(['failed']);
    expect(webhookRunEndStatusesFor([...both], undefined, ['completed'])).toEqual(['completed']);
    expect(webhookRunEndStatusesFor([...both], null, ['completed'])).toBeNull();
    expect(webhookRunEndStatusesFor([...both], undefined, null)).toBeNull();
    expect(
      webhookRunEndStatusesFor(['automation.run_started'], ['failed'], ['completed']),
    ).toBeNull();
    expect(webhookRunEndStatusesFor(['order.status_changed'], undefined, ['completed'])).toBeNull();
  });
});

describe('number filters (ADR-170)', () => {
  const shop = '0e1a2b3c-4d5e-4f60-8172-8394a5b6c7d8';
  const outlet = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';

  it('take 1 to 100 numbers, once each and in lower case, in the order given; null takes every number', () => {
    expect(webhookChannelIdsSchema.parse([outlet, shop.toUpperCase(), outlet, shop])).toEqual([
      outlet,
      shop,
    ]);
    expect(webhookChannelIdsSchema.parse(null)).toBeNull();
    const ids = Array.from(
      { length: WEBHOOK_LIMITS.channels + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(WEBHOOK_LIMITS.channels).toBe(100);
    expect(webhookChannelIdsSchema.parse(ids.slice(1))).toEqual(ids.slice(1));
    for (const refused of [[], ids, ['shop'], [shop, null], shop, [42]]) {
      expect(webhookChannelIdsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookChannelIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one number, or take every number.',
    );
    expect(webhookChannelIdsSchema.safeParse(ids).error?.issues[0]?.message).toBe(
      'Choose at most 100 numbers.',
    );
  });

  it('apply to the events that happen on a number, each of which names its number, and no other', () => {
    expect(WEBHOOK_CHANNEL_EVENTS).toEqual([
      'message.received',
      'message.status',
      'conversation.status_changed',
      'conversation.assignment_changed',
      'conversation.team_changed',
      'satisfaction_survey.answered',
      'automation.run_started',
      'automation.run_ended',
      'automation.run_step',
      'order.received',
      'order.status_changed',
      'payment_link.status_changed',
      'store_order.cod_answered',
      'store_order.message_sent',
      'store_checkout.reminder_sent',
      'campaign.status_changed',
      'campaign.recipient_skipped',
    ]);
    const payloads = {
      'message.received': messageReceivedPayloadSchema,
      'message.status': messageStatusPayloadSchema,
      'consent.changed': consentChangedPayloadSchema,
      'template.status_changed': templateStatusPayloadSchema,
      'conversation.status_changed': conversationStatusPayloadSchema,
      'conversation.assignment_changed': conversationAssignmentPayloadSchema,
      'conversation.team_changed': conversationTeamPayloadSchema,
      'satisfaction_survey.answered': satisfactionSurveyAnsweredPayloadSchema,
      'contact.created': contactCreatedPayloadSchema,
      'contact.updated': contactUpdatedPayloadSchema,
      'contact.erased': contactErasedPayloadSchema,
      'contact.merged': contactMergedPayloadSchema,
      'automation.run_started': automationRunStartedPayloadSchema,
      'automation.run_ended': automationRunEndedPayloadSchema,
      'automation.run_step': automationRunStepPayloadSchema,
      'order.received': orderReceivedPayloadSchema,
      'order.status_changed': orderStatusChangedPayloadSchema,
      'payment_link.status_changed': paymentLinkStatusChangedPayloadSchema,
      'store_order.cod_answered': storeOrderCodAnsweredPayloadSchema,
      'store_order.message_skipped': storeOrderMessageSkippedPayloadSchema,
      'store_order.message_sent': storeOrderMessageSentPayloadSchema,
      'store_checkout.reminder_skipped': storeCheckoutReminderSkippedPayloadSchema,
      'store_checkout.reminder_sent': storeCheckoutReminderSentPayloadSchema,
      'campaign.status_changed': campaignStatusChangedPayloadSchema,
      'campaign.recipient_skipped': campaignRecipientSkippedPayloadSchema,
      'deal.created': dealCreatedPayloadSchema,
      'deal.updated': dealUpdatedPayloadSchema,
      'deal.stage_changed': dealStageChangedPayloadSchema,
      'deal.owner_changed': dealOwnerChangedPayloadSchema,
      'deal.status_changed': dealStatusChangedPayloadSchema,
      'task.created': taskCreatedPayloadSchema,
      'task.updated': taskUpdatedPayloadSchema,
      'task.assignee_changed': taskAssigneeChangedPayloadSchema,
      'task.status_changed': taskStatusChangedPayloadSchema,
      'note.created': noteCreatedPayloadSchema,
    } satisfies Record<(typeof WEBHOOK_EVENT_KEYS)[number], unknown>;
    for (const type of WEBHOOK_EVENT_KEYS) {
      const onANumber = WEBHOOK_CHANNEL_EVENTS.some((t) => t === type);
      expect(webhookTakesChannelEvents([type]), type).toBe(onANumber);
      // The payload of an event that happens on a number says which (`channel`); others do not.
      expect('channel' in payloads[type].shape.data.shape, type).toBe(onANumber);
    }
    expect(webhookTakesChannelEvents(['consent.changed', 'order.received'])).toBe(true);
    expect(webhookTakesChannelEvents([])).toBe(false);
  });

  it('are kept only while the endpoint takes an event of a number: given, kept, or cleared', () => {
    expect(webhookChannelIdsFor(['message.received'], [shop], null)).toEqual([shop]);
    expect(webhookChannelIdsFor(['campaign.status_changed'], undefined, [outlet])).toEqual([
      outlet,
    ]);
    expect(webhookChannelIdsFor(['message.received'], null, [outlet])).toBeNull();
    expect(webhookChannelIdsFor(['message.received'], undefined, null)).toBeNull();
    expect(
      webhookChannelIdsFor(['consent.changed', 'contact.updated'], [shop], [outlet]),
    ).toBeNull();
    expect(webhookChannelIdsFor(['template.status_changed'], undefined, [outlet])).toBeNull();
  });

  it('name a number by its number and verified name, noting one that is not active', () => {
    const label = (displayPhoneNumber: string | null, verifiedName: string | null) =>
      webhookChannelLabel({ displayPhoneNumber, verifiedName, phoneNumberId: '106540352242922' });
    expect(label('+91 90000 54321', 'E2E Outlet')).toBe('+91 90000 54321 · E2E Outlet');
    expect(label('+91 90000 54321', null)).toBe('+91 90000 54321');
    expect(label(null, 'E2E Outlet')).toBe('E2E Outlet');
    // Until Meta reports the number, Meta's id for it.
    expect(label(null, null)).toBe('Phone number ID 106540352242922');
    const text = (status: (typeof CHANNEL_STATUSES)[number] | null) =>
      webhookChannelText({ label: '+91 90000 54321', status });
    expect(CHANNEL_STATUSES.map(text)).toEqual([
      '+91 90000 54321 (setting up)',
      '+91 90000 54321',
      '+91 90000 54321 (reconnect needed)',
      '+91 90000 54321 (disconnected)',
      '+91 90000 54321 (setup failed)',
    ]);
    expect(CHANNEL_STATUSES).toEqual(Object.keys(WEBHOOK_CHANNEL_STATUS_NOTES));
    expect(text(null)).toBe('+91 90000 54321');
  });
});

describe('message sender filters (ADR-172)', () => {
  it('take 1 to 5 of the senders message.sentBy names, once each, in the order Settings lists them; null takes every sender', () => {
    expect(webhookMessageSendersSchema.parse(['api', 'agent', 'api'])).toEqual(['agent', 'api']);
    expect(webhookMessageSendersSchema.parse(null)).toBeNull();
    // Exactly the senders a message.status event reports.
    expect([...WEBHOOK_MESSAGE_SENDERS]).toEqual(
      messageStatusPayloadSchema.shape.data.shape.message.shape.sentBy.options,
    );
    expect(webhookMessageSendersSchema.parse([...WEBHOOK_MESSAGE_SENDERS].reverse())).toEqual([
      'agent',
      'bot',
      'campaign',
      'api',
      'system',
    ]);
    for (const refused of [
      [],
      ['contact'],
      ['Agent'],
      ['member'],
      'api',
      [null],
      Array(6).fill('api'),
    ]) {
      expect(webhookMessageSendersSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookMessageSendersSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one sender, or take the statuses of every message.',
    );
    expect(WEBHOOK_MESSAGE_SENDER_LABELS).toEqual({
      agent: 'Members',
      bot: 'Automations',
      campaign: 'Campaigns',
      api: 'The API',
      system: 'HyFib (store order updates and satisfaction surveys)',
    });
  });

  it('are kept only while the endpoint takes message.status: given, kept, or cleared', () => {
    expect(webhookMessageSendersFor(['message.status'], ['api'], null)).toEqual(['api']);
    expect(webhookMessageSendersFor(['message.status'], undefined, ['campaign'])).toEqual([
      'campaign',
    ]);
    expect(webhookMessageSendersFor(['message.status'], null, ['campaign'])).toBeNull();
    expect(webhookMessageSendersFor(['message.status'], undefined, null)).toBeNull();
    expect(webhookMessageSendersFor(['message.received'], ['api'], ['campaign'])).toBeNull();
    expect(webhookMessageSendersFor(['campaign.status_changed'], undefined, ['api'])).toBeNull();
  });
});

describe('endpoint OAuth clients (ADR-173)', () => {
  const ring = new Keyring({ primaryKeyId: 'k1', keys: { k1: randomBytes(32) } });
  const tenant = '0192a1b2-0000-7000-8000-00000000000a';
  const endpoint = '0192a1b2-0000-7000-8000-00000000000b';
  const other = '0192a1b2-0000-7000-8000-00000000000c';
  const policy = { allowLoopbackForTests: false };
  const base = { tokenUrl: 'https://auth.example.com/oauth2/token', clientId: 'hyfib' };
  const problems = (input: unknown) => {
    const result = webhookOAuthSchema.safeParse(input);
    return result.success
      ? []
      : result.error.issues.map((issue) => [issue.path.join('.'), issue.message]);
  };
  /** The field and message of the validation error `run` throws. */
  const refusal = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      if (isAppError(error) && error.code === 'validation_failed') return error.issues;
      throw error;
    }
    throw new Error('expected a validation error');
  };

  it('take a token URL, a client ID and secret in printable ASCII, and a scope, trimmed', () => {
    expect(
      webhookOAuthSchema.parse({
        tokenUrl: ' https://auth.example.com/t ',
        clientId: ' hyfib ',
        clientSecret: ' s3 cr~et ',
        scope: ' read events.write ',
      }),
    ).toEqual({
      tokenUrl: 'https://auth.example.com/t',
      clientId: 'hyfib',
      clientSecret: 's3 cr~et',
      scope: 'read events.write',
    });
    // An empty scope is none; a change may leave the secret, and the scope, out.
    expect(webhookOAuthSchema.parse({ ...base, clientSecret: 's', scope: ' ' })).toEqual({
      ...base,
      clientSecret: 's',
      scope: null,
    });
    expect(webhookOAuthSchema.parse({ ...base, scope: null })).toEqual({ ...base, scope: null });
    expect(webhookOAuthSchema.parse(base)).toEqual(base);
    expect(
      problems({
        ...base,
        clientId: 'i'.repeat(WEBHOOK_LIMITS.oauthClientIdLength),
        clientSecret: 's'.repeat(WEBHOOK_LIMITS.oauthClientSecretLength),
        scope: 's'.repeat(WEBHOOK_LIMITS.oauthScopeLength),
      }),
    ).toEqual([]);
  });

  it('refuse missing, long or unprintable parts, a malformed scope and other keys', () => {
    const client = { ...base, clientSecret: 's' };
    expect(problems({ ...client, tokenUrl: ' ' })).toEqual([['tokenUrl', 'Enter the token URL']]);
    expect(problems({ ...client, tokenUrl: 'u'.repeat(WEBHOOK_LIMITS.urlLength + 1) })).toEqual([
      ['tokenUrl', 'The token URL is too long'],
    ]);
    expect(problems({ ...client, clientId: ' ' })).toEqual([['clientId', 'Enter the client ID']]);
    expect(problems({ ...client, clientSecret: ' ' })).toEqual([
      ['clientSecret', 'Enter the client secret.'],
    ]);
    expect(
      problems({ ...client, clientId: 'i'.repeat(WEBHOOK_LIMITS.oauthClientIdLength + 1) }),
    ).toEqual([['clientId', 'Client IDs are limited to 200 characters.']]);
    expect(
      problems({ ...client, clientSecret: 's'.repeat(WEBHOOK_LIMITS.oauthClientSecretLength + 1) }),
    ).toEqual([['clientSecret', 'Client secrets are limited to 500 characters.']]);
    for (const bad of ['café', 'line\nbreak', 'tab\there']) {
      expect(problems({ ...client, clientId: bad }), bad).toEqual([
        ['clientId', 'Client IDs use printable ASCII characters.'],
      ]);
      expect(problems({ ...client, clientSecret: bad }), bad).toEqual([
        ['clientSecret', 'Client secrets use printable ASCII characters.'],
      ]);
    }
    for (const scope of ['a  b', 'quote"d', 'back\\slash', 'é']) {
      expect(problems({ ...client, scope }), scope).toEqual([
        [
          'scope',
          'Separate the scope’s values with single spaces; they cannot hold quotes or backslashes.',
        ],
      ]);
    }
    expect(problems({ ...client, scope: 's'.repeat(WEBHOOK_LIMITS.oauthScopeLength + 1) })).toEqual(
      [['scope', 'Scopes are limited to 500 characters.']],
    );
    expect(problems({ ...client, grantType: 'password' })).toHaveLength(1);
  });

  it('hold the token URL to an endpoint URL’s rules, and need a secret unless the same URL keeps it', () => {
    expect(
      checkedWebhookOAuth(
        {
          ...base,
          tokenUrl: 'https://auth.example.com/oauth2/token?tenant=7#part',
          clientSecret: 's',
        },
        NO_WEBHOOK_OAUTH,
        policy,
      ),
    ).toEqual({
      tokenUrl: 'https://auth.example.com/oauth2/token?tenant=7',
      host: 'auth.example.com',
      clientId: 'hyfib',
      clientSecret: 's',
      scope: null,
      clientAuthentication: 'client_secret_basic',
      replaceKey: false,
      nextKey: null,
    });
    for (const [tokenUrl, message] of [
      ['http://auth.example.com/t', 'Only https:// addresses can be called.'],
      ['https://user:pw@auth.example.com/t', 'Put credentials in a header, not in the address.'],
      ['https://auth.example.com:80/t', 'Use port 443 or a port from 1024 up.'],
      ['not a url', 'Enter a valid URL.'],
    ] as const) {
      expect(
        refusal(() =>
          checkedWebhookOAuth({ ...base, tokenUrl, clientSecret: 's' }, NO_WEBHOOK_OAUTH, policy),
        ),
        tokenUrl,
      ).toEqual([{ path: 'oauth.tokenUrl', message }]);
    }
    // A new client needs its secret.
    expect(refusal(() => checkedWebhookOAuth(base, NO_WEBHOOK_OAUTH, policy))).toEqual([
      { path: 'oauth.clientSecret', message: WEBHOOK_OAUTH_SECRET_NEEDED },
    ]);
    const stored = webhookOAuthColumns(
      ring,
      tenant,
      endpoint,
      checkedWebhookOAuth({ ...base, clientSecret: 's' }, NO_WEBHOOK_OAUTH, policy),
      NO_WEBHOOK_OAUTH,
    );
    // The same token URL keeps the stored secret, with a new identifier and scope.
    const kept = checkedWebhookOAuth(
      { ...base, clientId: 'renamed', scope: 'read' },
      stored,
      policy,
    );
    expect(kept.clientSecret).toBeNull();
    expect(webhookOAuthColumns(ring, tenant, endpoint, kept, stored)).toEqual({
      oauthTokenUrl: base.tokenUrl,
      oauthClientId: 'renamed',
      oauthClientSecretCiphertext: stored.oauthClientSecretCiphertext,
      oauthScope: 'read',
      oauthClientAuth: 'client_secret_basic',
      oauthPrivateKeyCiphertext: null,
      oauthPublicKey: null,
      oauthNextPrivateKeyCiphertext: null,
      oauthNextPublicKey: null,
    });
    // Another token URL would receive the secret, or what it signs: it is needed again.
    expect(
      refusal(() =>
        checkedWebhookOAuth(
          { ...base, tokenUrl: 'https://elsewhere.example.com/t' },
          stored,
          policy,
        ),
      ),
    ).toEqual([{ path: 'oauth.clientSecret', message: WEBHOOK_OAUTH_SECRET_FOR_NEW_URL }]);
    // Said so of every way, the secret used with the token URL rather than sent to it.
    expect(WEBHOOK_OAUTH_SECRET_FOR_NEW_URL).toBe(
      'Enter the client secret again: it is used with the token URL, which changed.',
    );
  });

  it('seal the secret bound to the company and the endpoint, and open it only there', () => {
    const columns = webhookOAuthColumns(
      ring,
      tenant,
      endpoint,
      checkedWebhookOAuth(
        { ...base, clientSecret: 's3cret', scope: 'read' },
        NO_WEBHOOK_OAUTH,
        policy,
      ),
      NO_WEBHOOK_OAUTH,
    );
    expect(columns.oauthClientSecretCiphertext).not.toContain('s3cret');
    expect(
      ring.decryptString(
        columns.oauthClientSecretCiphertext!,
        webhookOAuthSecretAad(tenant, endpoint),
      ),
    ).toBe('s3cret');
    expect(openWebhookOAuthClient(ring, tenant, endpoint, columns)).toEqual({
      tokenUrl: base.tokenUrl,
      clientId: 'hyfib',
      clientSecret: 's3cret',
      scope: 'read',
      clientAuthentication: 'client_secret_basic',
    });
    expect(() => openWebhookOAuthClient(ring, other, endpoint, columns)).toThrow();
    expect(() => openWebhookOAuthClient(ring, tenant, other, columns)).toThrow();
    // No client keeps nothing, and opens as none.
    expect(webhookOAuthColumns(ring, tenant, endpoint, null, columns)).toEqual(NO_WEBHOOK_OAUTH);
    expect(openWebhookOAuthClient(ring, tenant, endpoint, NO_WEBHOOK_OAUTH)).toBeNull();
  });

  it('send the client ID and secret in a Basic header unless the request body is chosen (ADR-357)', () => {
    const post = { ...base, clientSecret: 's', clientAuthentication: 'client_secret_post' };
    expect(webhookOAuthSchema.parse(post)).toEqual(post);
    expect(
      webhookOAuthSchema.parse({ ...base, clientAuthentication: 'client_secret_basic' }),
    ).toEqual({ ...base, clientAuthentication: 'client_secret_basic' });
    // Left out: the schema adds nothing, and the client uses HTTP Basic.
    expect(webhookOAuthSchema.parse(base)).not.toHaveProperty('clientAuthentication');
    for (const bad of ['tls_client_auth', 'none', 'CLIENT_SECRET_POST', '', null]) {
      expect(problems({ ...base, clientAuthentication: bad }), String(bad)).toEqual([
        [
          'clientAuthentication',
          'Choose how the client authenticates: client_secret_basic, client_secret_post, client_secret_jwt or private_key_jwt.',
        ],
      ]);
    }
    expect(
      checkedWebhookOAuth({ ...base, clientSecret: 's' }, NO_WEBHOOK_OAUTH, policy)
        .clientAuthentication,
    ).toBe('client_secret_basic');
    const columns = webhookOAuthColumns(
      ring,
      tenant,
      endpoint,
      checkedWebhookOAuth(webhookOAuthSchema.parse(post), NO_WEBHOOK_OAUTH, policy),
      NO_WEBHOOK_OAUTH,
    );
    expect(columns.oauthClientAuth).toBe('client_secret_post');
    expect(openWebhookOAuthClient(ring, tenant, endpoint, columns)?.clientAuthentication).toBe(
      'client_secret_post',
    );
    // A change that leaves the method out keeps it while the token URL stays the same, as a
    // connector written before ADR-357 rotating the secret does; one naming it changes it.
    const rotated = checkedWebhookOAuth({ ...base, clientSecret: 'rotated' }, columns, policy);
    expect(rotated.clientAuthentication).toBe('client_secret_post');
    expect(webhookOAuthColumns(ring, tenant, endpoint, rotated, columns).oauthClientAuth).toBe(
      'client_secret_post',
    );
    expect(
      checkedWebhookOAuth({ ...base, clientAuthentication: 'client_secret_basic' }, columns, policy)
        .clientAuthentication,
    ).toBe('client_secret_basic');
    // Another token URL is another server: left out, HTTP Basic, as for a new client, and as for
    // an endpoint without a client whatever its column holds.
    expect(
      checkedWebhookOAuth(
        { ...base, tokenUrl: 'https://elsewhere.example.com/t', clientSecret: 's' },
        columns,
        policy,
      ).clientAuthentication,
    ).toBe('client_secret_basic');
    expect(
      checkedWebhookOAuth(
        { ...base, clientSecret: 's' },
        { ...NO_WEBHOOK_OAUTH, oauthClientAuth: 'client_secret_post' },
        policy,
      ).clientAuthentication,
    ).toBe('client_secret_basic');
    // Removing the client puts the default back.
    expect(webhookOAuthColumns(ring, tenant, endpoint, null, columns).oauthClientAuth).toBe(
      'client_secret_basic',
    );
    expect(NO_WEBHOOK_OAUTH.oauthClientAuth).toBe('client_secret_basic');
  });

  it('sign JWTs with a secret of at least 32 bytes, the one given or the one kept (ADR-366)', () => {
    const long = 'k'.repeat(32);
    const jwt = { ...base, clientSecret: long, clientAuthentication: 'client_secret_jwt' as const };
    expect(webhookOAuthSchema.parse(jwt)).toEqual(jwt);
    const signing = webhookOAuthColumns(
      ring,
      tenant,
      endpoint,
      checkedWebhookOAuth(webhookOAuthSchema.parse(jwt), NO_WEBHOOK_OAUTH, policy),
      NO_WEBHOOK_OAUTH,
    );
    expect(signing.oauthClientAuth).toBe('client_secret_jwt');
    expect(openWebhookOAuthClient(ring, tenant, endpoint, signing)).toMatchObject({
      clientSecret: long,
      clientAuthentication: 'client_secret_jwt',
    });
    const shortRefusal = [
      {
        path: 'oauth.clientSecret',
        message: 'A client that signs JWTs needs a secret of at least 32 bytes (HMAC SHA-256).',
      },
    ];
    // A secret given too short is refused, and nothing is sealed.
    expect(
      refusal(() =>
        webhookOAuthColumns(
          ring,
          tenant,
          endpoint,
          checkedWebhookOAuth({ ...jwt, clientSecret: 'k'.repeat(31) }, NO_WEBHOOK_OAUTH, policy),
          NO_WEBHOOK_OAUTH,
        ),
      ),
    ).toEqual(shortRefusal);
    // The secret kept: opened and measured, so a short one sent in a Basic header so far cannot
    // sign; a long one can, and a client signing JWTs keeps its way when the secret rotates.
    const basicShort = webhookOAuthColumns(
      ring,
      tenant,
      endpoint,
      checkedWebhookOAuth({ ...base, clientSecret: 'short' }, NO_WEBHOOK_OAUTH, policy),
      NO_WEBHOOK_OAUTH,
    );
    const toJwt = { ...base, clientAuthentication: 'client_secret_jwt' as const };
    expect(
      refusal(() =>
        webhookOAuthColumns(
          ring,
          tenant,
          endpoint,
          checkedWebhookOAuth(toJwt, basicShort, policy),
          basicShort,
        ),
      ),
    ).toEqual(shortRefusal);
    const basicLong = webhookOAuthColumns(
      ring,
      tenant,
      endpoint,
      checkedWebhookOAuth({ ...base, clientSecret: long }, NO_WEBHOOK_OAUTH, policy),
      NO_WEBHOOK_OAUTH,
    );
    expect(
      webhookOAuthColumns(
        ring,
        tenant,
        endpoint,
        checkedWebhookOAuth(toJwt, basicLong, policy),
        basicLong,
      ).oauthClientAuth,
    ).toBe('client_secret_jwt');
    expect(
      checkedWebhookOAuth({ ...base, clientSecret: `${long}-rotated` }, signing, policy)
        .clientAuthentication,
    ).toBe('client_secret_jwt');
    // Moved to another token URL without naming a way, it goes on signing: a move never starts
    // sending a secret it kept unsent. Naming one changes it; an endpoint without a client has none
    // to keep, whatever its column holds.
    const elsewhere = { ...base, tokenUrl: 'https://elsewhere.example.com/t', clientSecret: long };
    expect(checkedWebhookOAuth(elsewhere, signing, policy).clientAuthentication).toBe(
      'client_secret_jwt',
    );
    expect(
      checkedWebhookOAuth(
        { ...elsewhere, clientAuthentication: 'client_secret_post' },
        signing,
        policy,
      ).clientAuthentication,
    ).toBe('client_secret_post');
    expect(
      checkedWebhookOAuth(
        { ...base, clientSecret: long },
        { ...NO_WEBHOOK_OAUTH, oauthClientAuth: 'client_secret_jwt' },
        policy,
      ).clientAuthentication,
    ).toBe('client_secret_basic');
    // A kept secret the keyring can no longer open is asked for again, not a server error.
    const elsewhereRing = new Keyring({ primaryKeyId: 'k9', keys: { k9: randomBytes(32) } });
    const unreadable = webhookOAuthColumns(
      elsewhereRing,
      tenant,
      endpoint,
      checkedWebhookOAuth({ ...base, clientSecret: long }, NO_WEBHOOK_OAUTH, policy),
      NO_WEBHOOK_OAUTH,
    );
    expect(
      refusal(() =>
        webhookOAuthColumns(
          ring,
          tenant,
          endpoint,
          checkedWebhookOAuth(toJwt, unreadable, policy),
          unreadable,
        ),
      ),
    ).toEqual([
      {
        path: 'oauth.clientSecret',
        message: 'Enter the client secret again: the one kept can no longer be read.',
      },
    ]);
    // Other ways take a secret of any length.
    expect(basicShort.oauthClientAuth).toBe('client_secret_basic');
  });

  it('sign with a key pair HyFib makes, kept until replaced and dropped with the way, taking no secret (ADR-367)', () => {
    const signer = { ...base, clientAuthentication: 'private_key_jwt' as const };
    expect(webhookOAuthSchema.parse(signer)).toEqual(signer);
    expect(webhookOAuthSchema.parse({ ...signer, replaceKey: true })).toEqual({
      ...signer,
      replaceKey: true,
    });
    expect(problems({ ...signer, replaceKey: 'yes' })).toEqual([
      ['replaceKey', 'Say true to replace the key pair.'],
    ]);
    // A secret is refused for it, and a new key pair for any other way.
    expect(
      refusal(() =>
        checkedWebhookOAuth({ ...signer, clientSecret: 's' }, NO_WEBHOOK_OAUTH, policy),
      ),
    ).toEqual([
      {
        path: 'oauth.clientSecret',
        message:
          'A client that signs with HyFib’s key pair has no secret: leave the client secret out.',
      },
    ]);
    expect(
      refusal(() =>
        checkedWebhookOAuth(
          { ...base, clientSecret: 's', replaceKey: true },
          NO_WEBHOOK_OAUTH,
          policy,
        ),
      ),
    ).toEqual([
      {
        path: 'oauth.replaceKey',
        message: 'Only a client that signs with HyFib’s key pair has a key pair to replace.',
      },
    ]);
    // A new client gets a key pair, the private key sealed bound to the endpoint, and no secret.
    const made = webhookOAuthColumns(
      ring,
      tenant,
      endpoint,
      checkedWebhookOAuth(signer, NO_WEBHOOK_OAUTH, policy),
      NO_WEBHOOK_OAUTH,
    );
    expect(made).toMatchObject({
      oauthTokenUrl: base.tokenUrl,
      oauthClientId: 'hyfib',
      oauthClientSecretCiphertext: null,
      oauthScope: null,
      oauthClientAuth: 'private_key_jwt',
    });
    const sealed = made.oauthPrivateKeyCiphertext!;
    const privateKey = ring.decryptString(sealed, webhookOAuthKeyAad(tenant, endpoint));
    expect(() => ring.decryptString(sealed, webhookOAuthKeyAad(tenant, other))).toThrow();
    expect(() => ring.decryptString(sealed, webhookOAuthSecretAad(tenant, endpoint))).toThrow();
    // The halves belong together.
    expect(
      verify(
        'sha256',
        Buffer.from('x'),
        made.oauthPublicKey!,
        sign('sha256', Buffer.from('x'), privateKey),
      ),
    ).toBe(true);
    // A client set to sign with a key pair that has none fails rather than asking without one.
    expect(() =>
      openWebhookOAuthClient(ring, tenant, endpoint, { ...made, oauthPublicKey: null }),
    ).toThrow(/has none stored/);
    // Opened for the worker: the private key and its public key's id.
    expect(openWebhookOAuthClient(ring, tenant, endpoint, made)).toEqual({
      tokenUrl: base.tokenUrl,
      clientId: 'hyfib',
      scope: null,
      clientAuthentication: 'private_key_jwt',
      privateKey,
      keyId: webhookOAuthPublicKey(made.oauthPublicKey!).keyId,
    });
    // A change keeps it, the way too, whatever else changes, the token URL included; one asking for
    // a new key pair gets one.
    const elsewhere = checkedWebhookOAuth(
      { ...base, tokenUrl: 'https://elsewhere.example.com/t', scope: 'read' },
      made,
      policy,
    );
    expect(webhookOAuthColumns(ring, tenant, endpoint, elsewhere, made)).toMatchObject({
      oauthTokenUrl: 'https://elsewhere.example.com/t',
      oauthScope: 'read',
      oauthClientAuth: 'private_key_jwt',
      oauthPrivateKeyCiphertext: sealed,
      oauthPublicKey: made.oauthPublicKey,
    });
    const replace = checkedWebhookOAuth({ ...signer, replaceKey: true }, made, policy);
    const replaced = webhookOAuthColumns(ring, tenant, endpoint, replace, made);
    expect(replaced.oauthPublicKey).not.toBe(made.oauthPublicKey);
    expect(replaced.oauthPrivateKeyCiphertext).not.toBe(sealed);
    // Another way needs a secret and drops the key pair; back to this way, a new key pair.
    expect(
      refusal(() =>
        checkedWebhookOAuth({ ...base, clientAuthentication: 'client_secret_post' }, made, policy),
      ),
    ).toEqual([{ path: 'oauth.clientSecret', message: 'Enter the client secret.' }]);
    const toPost = webhookOAuthColumns(
      ring,
      tenant,
      endpoint,
      checkedWebhookOAuth(
        { ...base, clientSecret: 's', clientAuthentication: 'client_secret_post' },
        made,
        policy,
      ),
      made,
    );
    expect(toPost).toMatchObject({
      oauthClientAuth: 'client_secret_post',
      oauthPrivateKeyCiphertext: null,
      oauthPublicKey: null,
    });
    expect(toPost.oauthClientSecretCiphertext).not.toBeNull();
    const back = webhookOAuthColumns(
      ring,
      tenant,
      endpoint,
      checkedWebhookOAuth(signer, toPost, policy),
      toPost,
    );
    expect(back).toMatchObject({
      oauthClientAuth: 'private_key_jwt',
      oauthClientSecretCiphertext: null,
    });
    expect(back.oauthPublicKey).not.toBeNull();
    expect(back.oauthPublicKey).not.toBe(made.oauthPublicKey);
    // Removing the client removes its key pair.
    expect(webhookOAuthColumns(ring, tenant, endpoint, null, made)).toEqual(NO_WEBHOOK_OAUTH);
    // Audit entries say whether a key pair was made, never the key.
    expect(webhookOAuthAudit(checkedWebhookOAuth(signer, made, policy), made)).toEqual({
      oauthTokenHost: 'auth.example.com',
      oauthKeyReplaced: false,
      oauthClientAuthentication: 'private_key_jwt',
    });
    expect(webhookOAuthAudit(replace, made)).toEqual({
      oauthTokenHost: 'auth.example.com',
      oauthKeyReplaced: true,
      oauthClientAuthentication: 'private_key_jwt',
    });
    expect(webhookOAuthAudit(checkedWebhookOAuth(signer, toPost, policy), toPost)).toEqual({
      oauthTokenHost: 'auth.example.com',
      oauthKeyReplaced: true,
      oauthClientAuthentication: 'private_key_jwt',
    });
  });

  it('make a next key pair beside the one in use, signing with it only once asked to, or drop it (ADR-368)', () => {
    const signer = { ...base, clientAuthentication: 'private_key_jwt' as const };
    expect(webhookOAuthSchema.parse({ ...signer, nextKey: 'make' })).toEqual({
      ...signer,
      nextKey: 'make',
    });
    expect(problems({ ...signer, nextKey: 'rotate' })).toEqual([
      ['nextKey', 'Choose what to do with the next key pair: make, use or drop.'],
    ]);
    const made = webhookOAuthColumns(
      ring,
      tenant,
      endpoint,
      checkedWebhookOAuth(signer, NO_WEBHOOK_OAUTH, policy),
      NO_WEBHOOK_OAUTH,
    );
    expect(made).toMatchObject({ oauthNextPrivateKeyCiphertext: null, oauthNextPublicKey: null });
    // Refused for another way, beside a new key pair, and to use or drop one there is not.
    expect(
      refusal(() =>
        checkedWebhookOAuth(
          { ...base, clientSecret: 's', nextKey: 'make' },
          NO_WEBHOOK_OAUTH,
          policy,
        ),
      ),
    ).toEqual([
      {
        path: 'oauth.nextKey',
        message: 'Only a client that signs with HyFib’s key pair has a next key pair.',
      },
    ]);
    expect(
      refusal(() =>
        checkedWebhookOAuth({ ...signer, replaceKey: true, nextKey: 'make' }, made, policy),
      ),
    ).toEqual([
      {
        path: 'oauth.nextKey',
        message: 'Replace the key pair or change its next one, not both at once.',
      },
    ]);
    for (const nextKey of ['use', 'drop'] as const) {
      expect(refusal(() => checkedWebhookOAuth({ ...signer, nextKey }, made, policy))).toEqual([
        { path: 'oauth.nextKey', message: 'There is no next key pair: make one first.' },
      ]);
    }
    // Made beside the pair in use, which stays and signs; sealed under a binding of its own.
    const make = checkedWebhookOAuth({ ...signer, nextKey: 'make' }, made, policy);
    const withNext = webhookOAuthColumns(ring, tenant, endpoint, make, made);
    expect(withNext).toMatchObject({
      oauthClientAuth: 'private_key_jwt',
      oauthClientSecretCiphertext: null,
      oauthPrivateKeyCiphertext: made.oauthPrivateKeyCiphertext,
      oauthPublicKey: made.oauthPublicKey,
    });
    const nextSealed = withNext.oauthNextPrivateKeyCiphertext!;
    const nextPrivateKey = ring.decryptString(nextSealed, webhookOAuthNextKeyAad(tenant, endpoint));
    expect(() => ring.decryptString(nextSealed, webhookOAuthKeyAad(tenant, endpoint))).toThrow();
    expect(() => ring.decryptString(nextSealed, webhookOAuthNextKeyAad(tenant, other))).toThrow();
    expect(
      verify(
        'sha256',
        Buffer.from('x'),
        withNext.oauthNextPublicKey!,
        sign('sha256', Buffer.from('x'), nextPrivateKey),
      ),
    ).toBe(true);
    expect(withNext.oauthNextPublicKey).not.toBe(made.oauthPublicKey);
    const privateKey = ring.decryptString(
      made.oauthPrivateKeyCiphertext!,
      webhookOAuthKeyAad(tenant, endpoint),
    );
    expect(openWebhookOAuthClient(ring, tenant, endpoint, withNext)).toMatchObject({
      privateKey,
      keyId: webhookOAuthPublicKey(made.oauthPublicKey!).keyId,
    });
    // A change keeps it, the token URL included, and so does a new pair in use.
    const elsewhere = checkedWebhookOAuth(
      { ...base, tokenUrl: 'https://elsewhere.example.com/t' },
      withNext,
      policy,
    );
    const nextKept = {
      oauthNextPrivateKeyCiphertext: nextSealed,
      oauthNextPublicKey: withNext.oauthNextPublicKey,
    };
    expect(webhookOAuthColumns(ring, tenant, endpoint, elsewhere, withNext)).toMatchObject(
      nextKept,
    );
    const replaced = webhookOAuthColumns(
      ring,
      tenant,
      endpoint,
      checkedWebhookOAuth({ ...signer, replaceKey: true }, withNext, policy),
      withNext,
    );
    expect(replaced.oauthPublicKey).not.toBe(made.oauthPublicKey);
    expect(replaced).toMatchObject(nextKept);
    // Made again, another takes its place.
    const remade = webhookOAuthColumns(ring, tenant, endpoint, make, withNext);
    expect(remade.oauthNextPublicKey).not.toBe(withNext.oauthNextPublicKey);
    expect(remade.oauthPublicKey).toBe(made.oauthPublicKey);
    // Used, it signs from then on, sealed again under the binding of the key in use; the old pair
    // goes.
    const use = checkedWebhookOAuth({ ...signer, nextKey: 'use' }, withNext, policy);
    const used = webhookOAuthColumns(ring, tenant, endpoint, use, withNext);
    expect(used).toMatchObject({
      oauthClientAuth: 'private_key_jwt',
      oauthClientSecretCiphertext: null,
      oauthPublicKey: withNext.oauthNextPublicKey,
      oauthNextPrivateKeyCiphertext: null,
      oauthNextPublicKey: null,
    });
    expect(
      ring.decryptString(used.oauthPrivateKeyCiphertext!, webhookOAuthKeyAad(tenant, endpoint)),
    ).toBe(nextPrivateKey);
    expect(openWebhookOAuthClient(ring, tenant, endpoint, used)).toMatchObject({
      privateKey: nextPrivateKey,
      keyId: webhookOAuthPublicKey(withNext.oauthNextPublicKey!).keyId,
    });
    // One the keyring can no longer open is refused: it is dropped and another made.
    const unreadable = {
      ...withNext,
      oauthNextPrivateKeyCiphertext: made.oauthPrivateKeyCiphertext,
    };
    expect(
      refusal(() =>
        webhookOAuthColumns(
          ring,
          tenant,
          endpoint,
          checkedWebhookOAuth({ ...signer, nextKey: 'use' }, unreadable, policy),
          unreadable,
        ),
      ),
    ).toEqual([
      {
        path: 'oauth.nextKey',
        message: 'The next key pair can no longer be read: drop it and make another.',
      },
    ]);
    // Dropped, the pair in use stays.
    const drop = checkedWebhookOAuth({ ...signer, nextKey: 'drop' }, withNext, policy);
    expect(webhookOAuthColumns(ring, tenant, endpoint, drop, withNext)).toMatchObject({
      oauthPrivateKeyCiphertext: made.oauthPrivateKeyCiphertext,
      oauthPublicKey: made.oauthPublicKey,
      oauthNextPrivateKeyCiphertext: null,
      oauthNextPublicKey: null,
    });
    // Another way drops both pairs, and so does removing the client.
    const toPost = webhookOAuthColumns(
      ring,
      tenant,
      endpoint,
      checkedWebhookOAuth(
        { ...base, clientSecret: 's', clientAuthentication: 'client_secret_post' },
        withNext,
        policy,
      ),
      withNext,
    );
    expect(toPost).toMatchObject({
      oauthPrivateKeyCiphertext: null,
      oauthPublicKey: null,
      oauthNextPrivateKeyCiphertext: null,
      oauthNextPublicKey: null,
    });
    expect(webhookOAuthColumns(ring, tenant, endpoint, null, withNext)).toEqual(NO_WEBHOOK_OAUTH);
    // A new client may get one with its first pair.
    const first = checkedWebhookOAuth({ ...signer, nextKey: 'make' }, NO_WEBHOOK_OAUTH, policy);
    const both = webhookOAuthColumns(ring, tenant, endpoint, first, NO_WEBHOOK_OAUTH);
    expect(both.oauthPublicKey).not.toBeNull();
    expect(both.oauthNextPublicKey).not.toBeNull();
    expect(both.oauthNextPublicKey).not.toBe(both.oauthPublicKey);
    expect(webhookOAuthNextKeyAudit(first)).toEqual({ oauthNextKey: 'made' });
    // Audit entries say what became of it, never a key; using it replaces the pair in use.
    const audited = {
      oauthTokenHost: 'auth.example.com',
      oauthClientAuthentication: 'private_key_jwt',
    };
    expect(webhookOAuthAudit(make, made)).toEqual({
      ...audited,
      oauthKeyReplaced: false,
      oauthNextKey: 'made',
    });
    expect(webhookOAuthAudit(use, withNext)).toEqual({
      ...audited,
      oauthKeyReplaced: true,
      oauthNextKey: 'used',
    });
    expect(webhookOAuthAudit(drop, withNext)).toEqual({
      ...audited,
      oauthKeyReplaced: false,
      oauthNextKey: 'dropped',
    });
    expect(webhookOAuthAudit(checkedWebhookOAuth(signer, withNext, policy), withNext)).toEqual({
      ...audited,
      oauthKeyReplaced: false,
    });
  });

  it('refuse an Authorization header of the endpoint’s own beside a client, naming what was given', () => {
    const headers = [
      { name: 'X-Api-Key', value: 'k' },
      { name: 'authorization', value: 'Bearer fixed' },
    ];
    const names = headers.map((h) => h.name);
    expect(refusal(() => assertWebhookAuthorization(names, true, headers))).toEqual([
      { path: 'headers.1.name', message: WEBHOOK_OAUTH_AUTHORIZATION },
    ]);
    // Headers kept from before: the client given now is at fault.
    expect(refusal(() => assertWebhookAuthorization(['AUTHORIZATION'], true, undefined))).toEqual([
      { path: 'oauth', message: WEBHOOK_OAUTH_AUTHORIZATION },
    ]);
    expect(() => assertWebhookAuthorization(names, false, headers)).not.toThrow();
    expect(() => assertWebhookAuthorization(['X-Api-Key'], true, undefined)).not.toThrow();
  });

  it('are audited by the token URL’s host and whether a secret was given, or as removed', () => {
    const stored = webhookOAuthColumns(
      ring,
      tenant,
      endpoint,
      checkedWebhookOAuth({ ...base, clientSecret: 's' }, NO_WEBHOOK_OAUTH, policy),
      NO_WEBHOOK_OAUTH,
    );
    expect(webhookOAuthAudit(undefined, stored)).toEqual({});
    expect(webhookOAuthAudit(checkedWebhookOAuth(base, stored, policy), stored)).toEqual({
      oauthTokenHost: 'auth.example.com',
      oauthSecretReplaced: false,
    });
    expect(
      webhookOAuthAudit(
        checkedWebhookOAuth({ ...base, clientSecret: 'new' }, stored, policy),
        stored,
      ),
    ).toEqual({ oauthTokenHost: 'auth.example.com', oauthSecretReplaced: true });
    expect(webhookOAuthAudit(null, stored)).toEqual({ oauthRemoved: true });
    // Removing a client the endpoint did not have changes nothing worth saying.
    expect(webhookOAuthAudit(null, NO_WEBHOOK_OAUTH)).toEqual({});
  });

  it('name the way a client authenticates in the audit when it is not HTTP Basic or goes back to it (ADR-357)', () => {
    const basic = webhookOAuthColumns(
      ring,
      tenant,
      endpoint,
      checkedWebhookOAuth({ ...base, clientSecret: 's' }, NO_WEBHOOK_OAUTH, policy),
      NO_WEBHOOK_OAUTH,
    );
    const toPost = checkedWebhookOAuth(
      { ...base, clientAuthentication: 'client_secret_post' },
      basic,
      policy,
    );
    expect(webhookOAuthAudit(toPost, basic)).toEqual({
      oauthTokenHost: 'auth.example.com',
      oauthSecretReplaced: false,
      oauthClientAuthentication: 'client_secret_post',
    });
    const post = webhookOAuthColumns(ring, tenant, endpoint, toPost, basic);
    // Kept in the body, named or left out: named again, since it is not the default.
    expect(webhookOAuthClientAuthAudit(toPost, post)).toEqual({
      oauthClientAuthentication: 'client_secret_post',
    });
    expect(webhookOAuthAudit(checkedWebhookOAuth(base, post, policy), post)).toEqual({
      oauthTokenHost: 'auth.example.com',
      oauthSecretReplaced: false,
      oauthClientAuthentication: 'client_secret_post',
    });
    // Back to HTTP Basic: named, so the entry says the method changed.
    const toBasic = checkedWebhookOAuth(
      { ...base, clientAuthentication: 'client_secret_basic' },
      post,
      policy,
    );
    expect(webhookOAuthAudit(toBasic, post)).toEqual({
      oauthTokenHost: 'auth.example.com',
      oauthSecretReplaced: false,
      oauthClientAuthentication: 'client_secret_basic',
    });
    // HTTP Basic kept, or a new client using it: nothing to say, even where a removal left the
    // body in the column of an endpoint without a client (a web server from before ADR-357).
    expect(webhookOAuthClientAuthAudit(toBasic, basic)).toEqual({});
    expect(webhookOAuthClientAuthAudit(toBasic, NO_WEBHOOK_OAUTH)).toEqual({});
    expect(
      webhookOAuthClientAuthAudit(toBasic, {
        ...NO_WEBHOOK_OAUTH,
        oauthClientAuth: 'client_secret_post',
      }),
    ).toEqual({});
    expect(webhookOAuthClientAuthAudit(toPost, NO_WEBHOOK_OAUTH)).toEqual({
      oauthClientAuthentication: 'client_secret_post',
    });
  });

  it('are described by the token URL’s host, and their failures named for members', () => {
    const basic = {
      ...base,
      clientAuthentication: 'client_secret_basic' as const,
      publicKey: null,
      nextPublicKey: null,
    };
    expect(webhookOAuthText({ ...basic, scope: null })).toBe(
      'OAuth access tokens from auth.example.com, as client hyfib',
    );
    expect(webhookOAuthText({ ...basic, scope: 'read write' })).toBe(
      'OAuth access tokens from auth.example.com, as client hyfib, scope read write',
    );
    expect(
      webhookOAuthText({ ...basic, scope: 'read', clientAuthentication: 'client_secret_post' }),
    ).toBe(
      'OAuth access tokens from auth.example.com, as client hyfib, scope read, its ID and secret sent in the request body',
    );
    expect(
      webhookOAuthText({ ...basic, scope: null, clientAuthentication: 'client_secret_jwt' }),
    ).toBe(
      'OAuth access tokens from auth.example.com, as client hyfib, proving it holds the secret with a signed JWT',
    );
    const publicKey = {
      keyId: 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs',
      jwk: {
        kty: 'RSA' as const,
        n: 'n',
        e: 'AQAB',
        kid: 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs',
        use: 'sig' as const,
        alg: 'RS256' as const,
      },
      pem: 'pem',
    };
    expect(
      webhookOAuthText({
        ...basic,
        scope: null,
        clientAuthentication: 'private_key_jwt',
        publicKey,
      }),
    ).toBe(
      'OAuth access tokens from auth.example.com, as client hyfib, signing JWTs with HyFib’s private key (key NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs)',
    );
    // And the next key pair it has not used yet (ADR-368).
    expect(
      webhookOAuthText({
        ...basic,
        scope: null,
        clientAuthentication: 'private_key_jwt',
        publicKey,
        nextPublicKey: { ...publicKey, keyId: 'next-key-id' },
      }),
    ).toBe(
      'OAuth access tokens from auth.example.com, as client hyfib, signing JWTs with HyFib’s private key (key NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs; next key next-key-id, not used yet)',
    );
    // Each way named for members as Settings → Webhooks offers it (ADR-357, ADR-366, ADR-367).
    expect(WEBHOOK_OAUTH_CLIENT_AUTHENTICATION_LABELS).toEqual({
      client_secret_basic: 'Its ID and secret in an Authorization header (HTTP Basic)',
      client_secret_post: 'Its ID and secret in the request body (client_id and client_secret)',
      client_secret_jwt: 'A JWT signed with the secret, which is never sent (client_secret_jwt)',
      private_key_jwt: 'A JWT signed with a key pair HyFib keeps, no secret (private_key_jwt)',
    });
    expect(webhookErrorLabel('oauth_token_secret_too_short', null)).toBe(
      'No access token: the client secret is too short to sign a JWT (at least 32 bytes)',
    );
    expect(webhookErrorLabel('oauth_token_refused_401', null)).toBe(
      'The authorization server refused an access token (HTTP 401)',
    );
    expect(webhookErrorLabel('oauth_token_refused', null)).toBe(
      'The authorization server refused an access token',
    );
    expect(webhookErrorLabel('oauth_token_invalid', null)).toBe(
      'The authorization server gave no usable access token',
    );
    expect(webhookErrorLabel('oauth_token_timeout', null)).toBe(
      'No access token: no answer within 10 seconds',
    );
    expect(webhookErrorLabel('oauth_token_address_blocked', null)).toBe(
      'No access token: the address is private or reserved',
    );
    expect(webhookErrorLabel('oauth_token_scheme_not_allowed', null)).toBe(
      'No access token (scheme_not_allowed)',
    );
    // The endpoint was not called, so no earlier status says more.
    expect(webhookErrorLabel('oauth_token_refused_400', 500)).toBe(
      'The authorization server refused an access token (HTTP 400)',
    );
  });
});

describe('team filters (ADR-174)', () => {
  const support = '2a3b4c5d-6e7f-4081-9293-a4b5c6d7e8f9';
  const sales = '3b4c5d6e-7f80-4192-a3b4-c5d6e7f8091a';

  it('take 1 to 50 teams, once each and in lower case, in the order given; null takes every conversation', () => {
    expect(webhookTeamIdsSchema.parse([sales, support.toUpperCase(), sales, support])).toEqual([
      sales,
      support,
    ]);
    expect(webhookTeamIdsSchema.parse(null)).toBeNull();
    const ids = Array.from(
      { length: WEBHOOK_LIMITS.teams + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(WEBHOOK_LIMITS.teams).toBe(50);
    expect(webhookTeamIdsSchema.parse(ids.slice(1))).toEqual(ids.slice(1));
    for (const refused of [[], ids, ['support'], [support, null], support, [42]]) {
      expect(webhookTeamIdsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(false);
    }
    expect(webhookTeamIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one team, or take every conversation.',
    );
    expect(webhookTeamIdsSchema.safeParse(ids).error?.issues[0]?.message).toBe(
      'Choose at most 50 teams.',
    );
  });

  it("apply to a conversation's messages and changes, whose payloads name it, and no other event", () => {
    expect(WEBHOOK_TEAM_EVENTS).toEqual([
      'message.received',
      'message.status',
      'conversation.status_changed',
      'conversation.assignment_changed',
      'conversation.team_changed',
    ]);
    const payloads = {
      'message.received': messageReceivedPayloadSchema,
      'message.status': messageStatusPayloadSchema,
      'conversation.status_changed': conversationStatusPayloadSchema,
      'conversation.assignment_changed': conversationAssignmentPayloadSchema,
      'conversation.team_changed': conversationTeamPayloadSchema,
    } satisfies Record<(typeof WEBHOOK_TEAM_EVENTS)[number], unknown>;
    for (const type of WEBHOOK_EVENT_KEYS) {
      const ofATeam = WEBHOOK_TEAM_EVENTS.some((t) => t === type);
      expect(webhookTakesTeamEvents([type]), type).toBe(ofATeam);
    }
    // Each names the conversation it belongs to, so a receiver can look its team up.
    for (const type of WEBHOOK_TEAM_EVENTS) {
      expect('conversation' in payloads[type].shape.data.shape, type).toBe(true);
    }
    expect(webhookTakesTeamEvents(['consent.changed', 'message.status'])).toBe(true);
    expect(webhookTakesTeamEvents(['order.received', 'automation.run_started'])).toBe(false);
    expect(webhookTakesTeamEvents([])).toBe(false);
  });

  it('are kept only while the endpoint takes an event of a conversation: given, kept, or cleared', () => {
    expect(webhookTeamIdsFor(['message.received'], [support], null)).toEqual([support]);
    expect(webhookTeamIdsFor(['conversation.team_changed'], undefined, [sales])).toEqual([sales]);
    expect(webhookTeamIdsFor(['message.status'], null, [sales])).toBeNull();
    expect(webhookTeamIdsFor(['message.received'], undefined, null)).toBeNull();
    expect(webhookTeamIdsFor(['consent.changed', 'order.received'], [support], [sales])).toBeNull();
    expect(webhookTeamIdsFor(['automation.run_ended'], undefined, [sales])).toBeNull();
  });

  it('name a team, or say it was deleted', () => {
    expect(webhookTeamText({ id: support, name: 'Support' })).toBe('Support');
    expect(webhookTeamText({ id: sales, name: null })).toBe('A deleted team');
  });
});

describe('template filters (ADR-175)', () => {
  const orders = '4c5d6e7f-8091-42a3-b4c5-d6e7f8091a2b';
  const otp = '5d6e7f80-91a2-43b4-85d6-e7f8091a2b3c';

  it('take 1 to 50 templates, once each and in lower case, in the order given; null takes every template', () => {
    expect(webhookTemplateIdsSchema.parse([otp, orders.toUpperCase(), otp, orders])).toEqual([
      otp,
      orders,
    ]);
    expect(webhookTemplateIdsSchema.parse(null)).toBeNull();
    const ids = Array.from(
      { length: WEBHOOK_LIMITS.templates + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(WEBHOOK_LIMITS.templates).toBe(50);
    expect(webhookTemplateIdsSchema.parse(ids.slice(1))).toEqual(ids.slice(1));
    for (const refused of [[], ids, ['order_update'], [orders, null], orders, [42]]) {
      expect(webhookTemplateIdsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookTemplateIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one template, or take every template.',
    );
    expect(webhookTemplateIdsSchema.safeParse(ids).error?.issues[0]?.message).toBe(
      'Choose at most 50 templates.',
    );
  });

  it('apply to message statuses and template changes, whose payloads name the template, and no other event', () => {
    expect(WEBHOOK_TEMPLATE_EVENTS).toEqual(['message.status', 'template.status_changed']);
    for (const type of WEBHOOK_EVENT_KEYS) {
      const ofATemplate = WEBHOOK_TEMPLATE_EVENTS.some((t) => t === type);
      expect(webhookTakesTemplateEvents([type]), type).toBe(ofATemplate);
    }
    // Each names its template, so a receiver can tell them apart.
    expect('templateId' in messageStatusPayloadSchema.shape.data.shape.message.shape).toBe(true);
    expect('id' in templateStatusPayloadSchema.shape.data.shape.template.shape).toBe(true);
    expect(webhookTakesTemplateEvents(['message.received', 'template.status_changed'])).toBe(true);
    expect(webhookTakesTemplateEvents(['message.received', 'campaign.status_changed'])).toBe(false);
  });

  it('are kept only while the endpoint takes an event of a template: given, kept, or cleared', () => {
    expect(webhookTemplateIdsFor(['message.status'], [orders], null)).toEqual([orders]);
    expect(webhookTemplateIdsFor(['template.status_changed'], undefined, [otp])).toEqual([otp]);
    expect(webhookTemplateIdsFor(['message.status'], null, [otp])).toBeNull();
    expect(webhookTemplateIdsFor(['message.status'], undefined, null)).toBeNull();
    expect(webhookTemplateIdsFor(['message.received'], [orders], [otp])).toBeNull();
  });

  it('name a template by its name and language', () => {
    expect(webhookTemplateText({ name: 'order_update', language: 'en_US' })).toBe(
      'order_update (en_US)',
    );
  });
});

describe('campaign filters (ADR-185)', () => {
  const autumn = '8091a2b3-c4d5-46e7-b8f9-0a1b2c3d4e5f';
  const diwali = '91a2b3c4-d5e6-47f8-89a0-b1c2d3e4f5a6';

  it('take 1 to 50 campaigns, once each and in lower case, in the order given; null takes every campaign', () => {
    expect(webhookCampaignIdsSchema.parse([diwali, autumn.toUpperCase(), diwali, autumn])).toEqual([
      diwali,
      autumn,
    ]);
    expect(webhookCampaignIdsSchema.parse(null)).toBeNull();
    const ids = Array.from(
      { length: WEBHOOK_LIMITS.campaigns + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(WEBHOOK_LIMITS.campaigns).toBe(50);
    expect(webhookCampaignIdsSchema.parse(ids.slice(1))).toEqual(ids.slice(1));
    for (const refused of [[], ids, ['autumn_launch'], [autumn, null], autumn, [42]]) {
      expect(webhookCampaignIdsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookCampaignIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one campaign, or take every campaign.',
    );
    expect(webhookCampaignIdsSchema.safeParse(ids).error?.issues[0]?.message).toBe(
      'Choose at most 50 campaigns.',
    );
    expect(webhookCampaignIdsSchema.safeParse(['autumn_launch']).error?.issues[0]?.message).toBe(
      'Choose campaigns from the list.',
    );
    // Settings offers the 200 newest; the API takes any of the company's.
    expect(WEBHOOK_LIMITS.campaignChoices).toBe(200);
  });

  it('apply to message statuses, campaign changes and skipped recipients, whose payloads name the campaign, and no other event', () => {
    expect(WEBHOOK_CAMPAIGN_EVENTS).toEqual([
      'message.status',
      'campaign.status_changed',
      'campaign.recipient_skipped',
    ]);
    for (const type of WEBHOOK_EVENT_KEYS) {
      const ofACampaign = WEBHOOK_CAMPAIGN_EVENTS.some((t) => t === type);
      expect(webhookTakesCampaignEvents([type]), type).toBe(ofACampaign);
    }
    // Each names its campaign, so a receiver can tell them apart.
    expect('campaignId' in messageStatusPayloadSchema.shape.data.shape.message.shape).toBe(true);
    expect('id' in campaignStatusChangedPayloadSchema.shape.data.shape.campaign.shape).toBe(true);
    expect('id' in campaignRecipientSkippedPayloadSchema.shape.data.shape.campaign.shape).toBe(
      true,
    );
    expect(webhookTakesCampaignEvents(['message.received', 'campaign.status_changed'])).toBe(true);
    expect(webhookTakesCampaignEvents(['message.received', 'template.status_changed'])).toBe(false);
  });

  it('are kept only while the endpoint takes an event of a campaign: given, kept, or cleared', () => {
    expect(webhookCampaignIdsFor(['message.status'], [autumn], null)).toEqual([autumn]);
    expect(webhookCampaignIdsFor(['campaign.status_changed'], undefined, [diwali])).toEqual([
      diwali,
    ]);
    expect(webhookCampaignIdsFor(['message.status'], null, [diwali])).toBeNull();
    expect(webhookCampaignIdsFor(['message.status'], undefined, null)).toBeNull();
    expect(webhookCampaignIdsFor(['template.status_changed'], [autumn], [diwali])).toBeNull();
  });

  it('name a campaign by its name and status, as Campaigns does', () => {
    expect(webhookCampaignText({ id: autumn, name: 'Autumn launch', status: 'running' })).toBe(
      'Autumn launch (Sending)',
    );
    expect(
      webhookCampaignText({ id: autumn, name: 'Autumn launch', status: 'pending_approval' }),
    ).toBe('Autumn launch (Waiting for approval)');
    expect(webhookCampaignText({ id: autumn, name: 'Autumn launch', status: null })).toBe(
      'Autumn launch',
    );
  });
});

describe('skipped campaign recipients (ADR-358)', () => {
  const body = {
    id: '0192a1b2-0000-7000-8000-0000000000e1',
    type: 'campaign.recipient_skipped',
    createdAt: '2026-10-10T10:00:00.000Z',
    createdAtExact: '2026-10-10T10:00:00.000123Z',
    data: {
      recipient: { id: '0192a1b2-0000-7000-8000-0000000000e2', skipReason: 'opted_out' },
      campaign: {
        id: '0192a1b2-0000-7000-8000-0000000000e3',
        name: 'Festive sale',
        status: 'running',
        templateId: '0192a1b2-0000-7000-8000-0000000000e4',
        templateName: 'festive_sale',
      },
      contact: {
        id: '0192a1b2-0000-7000-8000-0000000000e5',
        phone: '+919876543210',
        name: 'Asha',
      },
      channel: { id: '0192a1b2-0000-7000-8000-0000000000e6', phone: '+91 90000 00000' },
    },
  };
  const parses = (value: unknown) => campaignRecipientSkippedPayloadSchema.safeParse(value).success;

  it('give the recipient and its reason, the campaign, the contact and the number', () => {
    expect(parses(body)).toBe(true);
    // Every reason a campaign skips a recipient for, and none other.
    expect(
      campaignRecipientSkippedPayloadSchema.shape.data.shape.recipient.shape.skipReason.options,
    ).toEqual([...SKIP_REASONS]);
    for (const skipReason of SKIP_REASONS) {
      expect(
        parses({
          ...body,
          data: { ...body.data, recipient: { ...body.data.recipient, skipReason } },
        }),
        skipReason,
      ).toBe(true);
    }
    for (const skipReason of ['no_opt_in', 'checkout_completed', '', null]) {
      expect(
        parses({
          ...body,
          data: { ...body.data, recipient: { ...body.data.recipient, skipReason } },
        }),
        String(skipReason),
      ).toBe(false);
    }
    // An erased contact without its number or name, a campaign without a template or a number.
    expect(
      parses({
        ...body,
        data: {
          ...body.data,
          contact: { ...body.data.contact, phone: null, name: null },
          campaign: { ...body.data.campaign, templateId: null, templateName: null },
          channel: null,
        },
      }),
    ).toBe(true);
    expect(parses({ ...body, type: 'campaign.status_changed' })).toBe(false);
    expect(
      parses({ ...body, data: { ...body.data, recipient: { skipReason: 'opted_out' } } }),
    ).toBe(false);
  });

  /** A transaction answering each read with the next rows given, counting what is left. */
  function answering(answers: unknown[][]) {
    const queue = [...answers];
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => {
        const rows = queue.shift();
        if (!rows) throw new Error('an unexpected read');
        return Promise.resolve(rows);
      },
    };
    return {
      tx: { select: () => chain } as unknown as Parameters<typeof buildWebhookPayload>[0],
      unread: () => queue.length,
    };
  }
  const tenantId = '0192a1b2-0000-7000-8000-0000000000f0';
  const at = new Date('2026-10-10T10:00:00.000Z');
  const event = (status: unknown, recipientId: unknown) =>
    ({
      id: body.id,
      tenantId,
      type: 'campaign.recipient_skipped',
      messageId: null,
      conversationId: null,
      contactId: body.data.contact.id,
      templateId: null,
      status,
      detail: { recipientId },
      contactChanges: null,
      tagsAdded: null,
      tagsRemoved: null,
      occurredAt: at,
      occurredAtExact: '2026-10-10T10:00:00.000123Z',
    }) as unknown as Parameters<typeof buildWebhookPayload>[1];
  const recipientRow = {
    id: body.data.recipient.id,
    campaignId: body.data.campaign.id,
    contactId: body.data.contact.id,
  };
  const campaignRow = {
    ...body.data.campaign,
    scheduledAt: at,
    startedAt: at,
    completedAt: null,
    canceledAt: null,
    audienceCount: 5,
    queuedCount: 2,
    skippedCount: 3,
    channelId: body.data.channel.id,
    channelPhone: body.data.channel.phone,
  };

  it('build the body from the recipient, its campaign and contact as they are now, and the reason as captured', async () => {
    const reads = answering([
      [recipientRow],
      [campaignRow],
      [{ phone: '+919876543210', name: 'Asha', erasedAt: null }],
    ]);
    const built = await buildWebhookPayload(
      reads.tx,
      event('opted_out', recipientRow.id),
      'endpoint',
    );
    expect(built).toEqual(body);
    expect(campaignRecipientSkippedPayloadSchema.safeParse(built).success).toBe(true);
    expect(reads.unread()).toBe(0);
    // An erased contact without its number or name; a campaign without a number.
    const erased = answering([
      [recipientRow],
      [{ ...campaignRow, channelId: null, channelPhone: null }],
      [{ phone: '+919876543210', name: 'Asha', erasedAt: at }],
    ]);
    expect(
      (await buildWebhookPayload(erased.tx, event('contact_erased', recipientRow.id), 'endpoint'))
        .data,
    ).toEqual({
      ...body.data,
      recipient: { id: recipientRow.id, skipReason: 'contact_erased' },
      contact: { id: body.data.contact.id, phone: null, name: null },
      channel: null,
    });
  });

  it('send nothing for a recipient or campaign that is gone, reading nothing for an id that is not one', async () => {
    for (const answers of [[[]], [[recipientRow], []]]) {
      const gone = answering(answers);
      await expect(
        buildWebhookPayload(gone.tx, event('opted_out', recipientRow.id), 'endpoint'),
      ).rejects.toBeInstanceOf(WebhookEventGoneError);
      expect(gone.unread()).toBe(0);
    }
    for (const recipientId of ['recipient', null, 7]) {
      const none = answering([]);
      await expect(
        buildWebhookPayload(none.tx, event('opted_out', recipientId), 'endpoint'),
        String(recipientId),
      ).rejects.toBeInstanceOf(WebhookEventGoneError);
    }
  });

  it('describe no event captured without a campaign skip reason, before reading anything', async () => {
    for (const status of [null, 'checkout_completed', 'no_opt_in']) {
      const none = answering([]);
      await expect(
        buildWebhookPayload(none.tx, event(status, recipientRow.id), 'endpoint'),
        String(status),
      ).rejects.toThrow('The skipped campaign recipient was captured without its reason');
    }
  });

  it('are described for members and in the OpenAPI document', () => {
    expect(WEBHOOK_EVENT_INFO['campaign.recipient_skipped'].label).toBe(
      'Campaign recipient skipped',
    );
    expect(WEBHOOK_EVENT_INFO['campaign.recipient_skipped'].description).toContain(
      'Those skipped when the audience was taken are reported when the campaign starts.',
    );
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const hook = (
      doc.webhooks as Record<string, { post: { description: string; operationId: string } }>
    )['campaign.recipient_skipped'];
    expect(hook?.post.operationId).toBe('webhookCampaignRecipientSkipped');
    for (const part of [
      'so a campaign sent back to draft or cancelled before it starts sends none',
      'the campaigns an endpoint names (its `campaignIds`',
      'an endpoint that names numbers receives it for those numbers only',
      'fails as event_gone',
    ]) {
      expect(hook?.post.description, part).toContain(part);
    }
    expect(Object.keys(doc.components.schemas)).toContain('WebhookCampaignRecipientSkipped');
  });
});

describe('pipeline filters (ADR-263)', () => {
  const sales = 'a2b3c4d5-e6f7-4809-9a1b-2c3d4e5f6a7b';
  const renewals = 'b3c4d5e6-f7a8-491a-ab2c-3d4e5f6a7b8c';

  it('take 1 to 50 pipelines, once each and in lower case, in the order given; null takes every pipeline', () => {
    expect(
      webhookPipelineIdsSchema.parse([renewals, sales.toUpperCase(), renewals, sales]),
    ).toEqual([renewals, sales]);
    expect(webhookPipelineIdsSchema.parse(null)).toBeNull();
    const ids = Array.from(
      { length: WEBHOOK_LIMITS.pipelines + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(WEBHOOK_LIMITS.pipelines).toBe(50);
    expect(webhookPipelineIdsSchema.parse(ids.slice(1))).toEqual(ids.slice(1));
    for (const refused of [[], ids, ['Sales'], [sales, null], sales, [42]]) {
      expect(webhookPipelineIdsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookPipelineIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one pipeline, or take every pipeline.',
    );
    expect(webhookPipelineIdsSchema.safeParse(ids).error?.issues[0]?.message).toBe(
      'Choose at most 50 pipelines.',
    );
    expect(webhookPipelineIdsSchema.safeParse(['Sales']).error?.issues[0]?.message).toBe(
      'Choose pipelines from the list.',
    );
  });

  it('apply to the five deal events, whose payloads give the pipeline and the one a move left, and to no other event', () => {
    expect(WEBHOOK_PIPELINE_EVENTS).toEqual([
      'deal.created',
      'deal.updated',
      'deal.stage_changed',
      'deal.owner_changed',
      'deal.status_changed',
    ]);
    for (const type of WEBHOOK_EVENT_KEYS) {
      expect(webhookTakesPipelineEvents([type]), type).toBe(type.startsWith('deal.'));
    }
    // Task events are not a pipeline's, even a task about a deal.
    expect(webhookTakesPipelineEvents(['task.created', 'task.status_changed'])).toBe(false);
    expect(webhookTakesPipelineEvents(['task.created', 'deal.status_changed'])).toBe(true);
    for (const schema of [
      dealCreatedPayloadSchema,
      dealUpdatedPayloadSchema,
      dealStageChangedPayloadSchema,
      dealOwnerChangedPayloadSchema,
      dealStatusChangedPayloadSchema,
    ]) {
      const deal = schema.shape.data.shape.deal.shape;
      expect('pipelineId' in deal && 'previousPipelineId' in deal).toBe(true);
    }
    // The refusal names the events as Settings lists them.
    for (const type of WEBHOOK_PIPELINE_EVENTS) {
      expect(WEBHOOK_PIPELINES_NEED_THE_EVENTS).toContain(WEBHOOK_EVENT_INFO[type].label);
    }
  });

  it('are kept only while the endpoint takes a deal event: given, kept, or cleared', () => {
    expect(webhookPipelineIdsFor(['deal.created'], [sales], null)).toEqual([sales]);
    expect(webhookPipelineIdsFor(['deal.stage_changed'], undefined, [renewals])).toEqual([
      renewals,
    ]);
    expect(webhookPipelineIdsFor(['deal.status_changed'], null, [renewals])).toBeNull();
    expect(webhookPipelineIdsFor(['deal.created'], undefined, null)).toBeNull();
    expect(webhookPipelineIdsFor(['task.created', 'contact.created'], [sales], [renewals])).toBe(
      null,
    );
  });

  it('name a pipeline by its name, an archived one as archived', () => {
    expect(webhookPipelineText({ name: 'Sales' })).toBe('Sales');
    expect(webhookPipelineText({ name: 'Sales', archived: false })).toBe('Sales');
    expect(webhookPipelineText({ name: 'Renewals', archived: true })).toBe('Renewals (archived)');
  });
});

describe('stage filters (ADR-264)', () => {
  const proposal = 'c4d5e6f7-a8b9-4a2b-8c3d-4e5f6a7b8c9d';
  const signed = 'd5e6f7a8-b9c0-4b3c-9d4e-5f6a7b8c9d0e';

  it('take 1 to 50 stages, once each and in lower case, in the order given; null takes every stage', () => {
    expect(webhookStageIdsSchema.parse([signed, proposal.toUpperCase(), signed, proposal])).toEqual(
      [signed, proposal],
    );
    expect(webhookStageIdsSchema.parse(null)).toBeNull();
    const ids = Array.from(
      { length: WEBHOOK_LIMITS.stages + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(WEBHOOK_LIMITS.stages).toBe(50);
    expect(webhookStageIdsSchema.parse(ids.slice(1))).toEqual(ids.slice(1));
    for (const refused of [[], ids, ['Proposal'], [proposal, null], proposal, [42]]) {
      expect(webhookStageIdsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(false);
    }
    expect(webhookStageIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one stage, or take every stage.',
    );
    expect(webhookStageIdsSchema.safeParse(ids).error?.issues[0]?.message).toBe(
      'Choose at most 50 stages.',
    );
    expect(webhookStageIdsSchema.safeParse(['Proposal']).error?.issues[0]?.message).toBe(
      'Choose stages from the list.',
    );
  });

  it('apply to the deal events, whose payloads give the stage and the one a move left, and are kept only while one is taken', () => {
    for (const schema of [
      dealCreatedPayloadSchema,
      dealUpdatedPayloadSchema,
      dealStageChangedPayloadSchema,
      dealOwnerChangedPayloadSchema,
      dealStatusChangedPayloadSchema,
    ]) {
      const deal = schema.shape.data.shape.deal.shape;
      expect('stageId' in deal && 'previousStageId' in deal).toBe(true);
    }
    for (const type of WEBHOOK_PIPELINE_EVENTS) {
      expect(WEBHOOK_STAGES_NEED_THE_EVENTS).toContain(WEBHOOK_EVENT_INFO[type].label);
    }
    expect(webhookStageIdsFor(['deal.stage_changed'], [proposal], null)).toEqual([proposal]);
    expect(webhookStageIdsFor(['deal.created'], undefined, [signed])).toEqual([signed]);
    expect(webhookStageIdsFor(['deal.status_changed'], null, [signed])).toBeNull();
    expect(webhookStageIdsFor(['deal.created'], undefined, null)).toBeNull();
    expect(webhookStageIdsFor(['task.created', 'task.status_changed'], [proposal], [signed])).toBe(
      null,
    );
  });

  it('name a stage by its pipeline and name, a removed one and one of an archived pipeline as such', () => {
    const stage = { name: 'Proposal', pipelineName: 'Sales' };
    expect(webhookStageText(stage)).toBe('Sales: Proposal');
    expect(webhookStageText({ ...stage, removed: false, pipelineArchived: false })).toBe(
      'Sales: Proposal',
    );
    expect(webhookStageText({ ...stage, removed: true, pipelineArchived: true })).toBe(
      'Sales: Proposal (removed)',
    );
    expect(webhookStageText({ ...stage, pipelineArchived: true })).toBe(
      'Sales: Proposal (archived pipeline)',
    );
  });
});

describe('owner filters (ADR-265)', () => {
  const asha = 'e6f7a8b9-c0d1-4c4d-8e5f-6a7b8c9d0e1f';
  const dev = 'f7a8b9c0-d1e2-4d5e-9f6a-7b8c9d0e1f2a';

  it('take 1 to 50 members, once each and in lower case, in the order given; null takes every deal', () => {
    expect(webhookOwnerIdsSchema.parse([dev, asha.toUpperCase(), dev, asha])).toEqual([dev, asha]);
    expect(webhookOwnerIdsSchema.parse(null)).toBeNull();
    const ids = Array.from(
      { length: WEBHOOK_LIMITS.owners + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(WEBHOOK_LIMITS.owners).toBe(50);
    expect(webhookOwnerIdsSchema.parse(ids.slice(1))).toEqual(ids.slice(1));
    for (const refused of [[], ids, ['asha@example.com'], [asha, null], asha, [42]]) {
      expect(webhookOwnerIdsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(false);
    }
    expect(webhookOwnerIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one member, or take every deal.',
    );
    expect(webhookOwnerIdsSchema.safeParse(ids).error?.issues[0]?.message).toBe(
      'Choose at most 50 members.',
    );
    expect(webhookOwnerIdsSchema.safeParse(['asha@example.com']).error?.issues[0]?.message).toBe(
      'Choose members from the list.',
    );
  });

  it('apply to the deal events, whose payloads give the owner, and are kept only while one is taken', () => {
    for (const schema of [
      dealCreatedPayloadSchema,
      dealUpdatedPayloadSchema,
      dealStageChangedPayloadSchema,
      dealOwnerChangedPayloadSchema,
      dealStatusChangedPayloadSchema,
    ]) {
      expect('ownerId' in schema.shape.data.shape.deal.shape).toBe(true);
    }
    expect('previousOwnerId' in dealOwnerChangedPayloadSchema.shape.data.shape.deal.shape).toBe(
      true,
    );
    for (const type of WEBHOOK_PIPELINE_EVENTS) {
      expect(WEBHOOK_OWNERS_NEED_THE_EVENTS).toContain(WEBHOOK_EVENT_INFO[type].label);
    }
    expect(webhookOwnerIdsFor(['deal.created'], [asha], null)).toEqual([asha]);
    expect(webhookOwnerIdsFor(['deal.stage_changed'], undefined, [dev])).toEqual([dev]);
    expect(webhookOwnerIdsFor(['deal.status_changed'], null, [dev])).toBeNull();
    expect(webhookOwnerIdsFor(['deal.created'], undefined, null)).toBeNull();
    expect(webhookOwnerIdsFor(['task.created', 'contact.created'], [asha], [dev])).toBeNull();
  });

  it('name an owner, one who no longer uses the CRM as such', () => {
    expect(webhookOwnerText({ id: asha, name: 'Asha', active: true })).toBe('Asha');
    expect(webhookOwnerText({ id: asha, name: 'Asha', active: false })).toBe(
      'Asha (no longer uses the CRM)',
    );
    expect(webhookOwnerText({ id: asha, name: null, active: false })).toBe(
      'Unknown member (no longer uses the CRM)',
    );
  });
});

describe('task assignee filters (ADR-266)', () => {
  const asha = 'e6f7a8b9-c0d1-4c4d-8e5f-6a7b8c9d0e1f';
  const dev = 'f7a8b9c0-d1e2-4d5e-9f6a-7b8c9d0e1f2a';

  it('take 1 to 50 members, once each and in lower case, in the order given; null takes every task', () => {
    expect(webhookTaskAssigneeIdsSchema.parse([dev, asha.toUpperCase(), dev, asha])).toEqual([
      dev,
      asha,
    ]);
    expect(webhookTaskAssigneeIdsSchema.parse(null)).toBeNull();
    const ids = Array.from(
      { length: WEBHOOK_LIMITS.taskAssignees + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(WEBHOOK_LIMITS.taskAssignees).toBe(50);
    expect(webhookTaskAssigneeIdsSchema.parse(ids.slice(1))).toEqual(ids.slice(1));
    for (const refused of [[], ids, ['asha@example.com'], [asha, null], asha, [42]]) {
      expect(webhookTaskAssigneeIdsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookTaskAssigneeIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one member, or take every task.',
    );
    expect(webhookTaskAssigneeIdsSchema.safeParse(ids).error?.issues[0]?.message).toBe(
      'Choose at most 50 members.',
    );
    expect(
      webhookTaskAssigneeIdsSchema.safeParse(['asha@example.com']).error?.issues[0]?.message,
    ).toBe('Choose members from the list.');
  });

  it('apply to the four task events, whose payloads give the assignee, and to no other event', () => {
    expect(WEBHOOK_TASK_EVENTS).toEqual([
      'task.created',
      'task.updated',
      'task.assignee_changed',
      'task.status_changed',
    ]);
    for (const type of WEBHOOK_EVENT_KEYS) {
      expect(webhookTakesTaskEvents([type]), type).toBe(type.startsWith('task.'));
    }
    // Deal events are not a task's, even of a deal with tasks.
    expect(webhookTakesTaskEvents(['deal.created', 'deal.status_changed'])).toBe(false);
    expect(webhookTakesTaskEvents(['deal.created', 'task.status_changed'])).toBe(true);
    for (const schema of [
      taskCreatedPayloadSchema,
      taskUpdatedPayloadSchema,
      taskAssigneeChangedPayloadSchema,
      taskStatusChangedPayloadSchema,
    ]) {
      expect('assigneeId' in schema.shape.data.shape.task.shape).toBe(true);
      expect('previousAssigneeId' in schema.shape.data.shape.task.shape).toBe(true);
    }
    // The refusal names the events as Settings lists them.
    for (const type of WEBHOOK_TASK_EVENTS) {
      expect(WEBHOOK_TASK_ASSIGNEES_NEED_THE_EVENTS).toContain(WEBHOOK_EVENT_INFO[type].label);
    }
  });

  it('are kept only while the endpoint takes a task event: given, kept, or cleared', () => {
    expect(webhookTaskAssigneeIdsFor(['task.created'], [asha], null)).toEqual([asha]);
    expect(webhookTaskAssigneeIdsFor(['task.status_changed'], undefined, [dev])).toEqual([dev]);
    expect(webhookTaskAssigneeIdsFor(['task.updated'], [asha], null)).toEqual([asha]);
    expect(webhookTaskAssigneeIdsFor(['task.created'], null, [dev])).toBeNull();
    expect(webhookTaskAssigneeIdsFor(['task.status_changed'], undefined, null)).toBeNull();
    expect(
      webhookTaskAssigneeIdsFor(['deal.created', 'contact.created'], [asha], [dev]),
    ).toBeNull();
  });
});

describe('pipeline filters for task events (ADR-303)', () => {
  const sales = 'a8b9c0d1-e2f3-4e6f-8a7b-8c9d0e1f2a3b';
  const renewals = 'b9c0d1e2-f3a4-4f7a-9b8c-9d0e1f2a3b4c';

  it('take 1 to 50 pipelines, once each and in lower case, in the order given; null takes every task', () => {
    expect(
      webhookTaskPipelineIdsSchema.parse([renewals, sales.toUpperCase(), renewals, sales]),
    ).toEqual([renewals, sales]);
    expect(webhookTaskPipelineIdsSchema.parse(null)).toBeNull();
    const ids = Array.from(
      { length: WEBHOOK_LIMITS.taskPipelines + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(WEBHOOK_LIMITS.taskPipelines).toBe(50);
    expect(webhookTaskPipelineIdsSchema.parse(ids.slice(1))).toEqual(ids.slice(1));
    for (const refused of [[], ids, ['Sales'], [sales, null], sales, [42]]) {
      expect(webhookTaskPipelineIdsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookTaskPipelineIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one pipeline, or take every task.',
    );
    expect(webhookTaskPipelineIdsSchema.safeParse(ids).error?.issues[0]?.message).toBe(
      'Choose at most 50 pipelines.',
    );
    expect(webhookTaskPipelineIdsSchema.safeParse(['Sales']).error?.issues[0]?.message).toBe(
      'Choose pipelines from the list.',
    );
  });

  it('are kept only while the endpoint takes a task event: given, kept, or cleared', () => {
    for (const type of WEBHOOK_TASK_EVENTS) {
      expect(webhookTaskPipelineIdsFor([type], [sales], null), type).toEqual([sales]);
      expect(webhookTaskPipelineIdsFor([type], undefined, [renewals]), type).toEqual([renewals]);
    }
    expect(webhookTaskPipelineIdsFor(['task.created'], null, [renewals])).toBeNull();
    expect(webhookTaskPipelineIdsFor(['task.status_changed'], undefined, null)).toBeNull();
    // Deal events have pipelines of their own (ADR-263): a task list goes with the task events.
    expect(
      webhookTaskPipelineIdsFor(['deal.created', 'contact.created'], [sales], [renewals]),
    ).toBeNull();
    // The refusal names the events as Settings lists them.
    for (const type of WEBHOOK_TASK_EVENTS) {
      expect(WEBHOOK_TASK_PIPELINES_NEED_THE_EVENTS).toContain(WEBHOOK_EVENT_INFO[type].label);
    }
  });
});

describe('stage and owner filters for task events (ADR-304)', () => {
  const proposal = 'c0d1e2f3-a4b5-4a8b-8c9d-0e1f2a3b4c5d';
  const signed = 'd1e2f3a4-b5c6-4b9c-9d0e-1f2a3b4c5d6e';
  const asha = 'e2f3a4b5-c6d7-4cad-8e1f-2a3b4c5d6e7f';
  const dev = 'f3a4b5c6-d7e8-4dbe-9f2a-3b4c5d6e7f8a';
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

  it('take 1 to 50 stages or members, once each and in lower case, in the order given; null takes every task', () => {
    expect(webhookTaskStageIdsSchema.parse([signed, proposal.toUpperCase(), signed])).toEqual([
      signed,
      proposal,
    ]);
    expect(webhookTaskDealOwnerIdsSchema.parse([dev, asha.toUpperCase(), dev])).toEqual([
      dev,
      asha,
    ]);
    expect(webhookTaskStageIdsSchema.parse(null)).toBeNull();
    expect(webhookTaskDealOwnerIdsSchema.parse(null)).toBeNull();
    expect(WEBHOOK_LIMITS.taskStages).toBe(50);
    expect(WEBHOOK_LIMITS.taskDealOwners).toBe(50);
    expect(webhookTaskStageIdsSchema.parse(many(51).slice(1))).toEqual(many(51).slice(1));
    expect(webhookTaskDealOwnerIdsSchema.parse(many(51).slice(1))).toEqual(many(51).slice(1));
    for (const refused of [[], many(51), ['Proposal'], [proposal, null], proposal, [42]]) {
      expect(webhookTaskStageIdsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
      expect(
        webhookTaskDealOwnerIdsSchema.safeParse(refused).success,
        JSON.stringify(refused),
      ).toBe(false);
    }
    expect(webhookTaskStageIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one stage, or take every task.',
    );
    expect(webhookTaskStageIdsSchema.safeParse(many(51)).error?.issues[0]?.message).toBe(
      'Choose at most 50 stages.',
    );
    expect(webhookTaskStageIdsSchema.safeParse(['Proposal']).error?.issues[0]?.message).toBe(
      'Choose stages from the list.',
    );
    expect(webhookTaskDealOwnerIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one member, or take every task.',
    );
    expect(webhookTaskDealOwnerIdsSchema.safeParse(many(51)).error?.issues[0]?.message).toBe(
      'Choose at most 50 members.',
    );
    expect(
      webhookTaskDealOwnerIdsSchema.safeParse(['asha@example.com']).error?.issues[0]?.message,
    ).toBe('Choose members from the list.');
  });

  it('are kept only while the endpoint takes a task event: given, kept, or cleared', () => {
    for (const [keep, given, current] of [
      [webhookTaskStageIdsFor, proposal, signed],
      [webhookTaskDealOwnerIdsFor, asha, dev],
    ] as const) {
      for (const type of WEBHOOK_TASK_EVENTS) {
        expect(keep([type], [given], null), type).toEqual([given]);
        expect(keep([type], undefined, [current]), type).toEqual([current]);
      }
      expect(keep(['task.created'], null, [current])).toBeNull();
      expect(keep(['task.status_changed'], undefined, null)).toBeNull();
      // Deal events have stages and owners of their own (ADR-264, ADR-265).
      expect(keep(['deal.created', 'contact.created'], [given], [current])).toBeNull();
    }
    // The refusals name the events as Settings lists them.
    for (const type of WEBHOOK_TASK_EVENTS) {
      expect(WEBHOOK_TASK_STAGES_NEED_THE_EVENTS).toContain(WEBHOOK_EVENT_INFO[type].label);
      expect(WEBHOOK_TASK_DEAL_OWNERS_NEED_THE_EVENTS).toContain(WEBHOOK_EVENT_INFO[type].label);
    }
  });
});

describe('pipeline, stage and owner filters for note events (ADR-305)', () => {
  const sales = 'a4b5c6d7-e8f9-4a0b-8c1d-2e3f4a5b6c7d';
  const proposal = 'b5c6d7e8-f9a0-4b1c-9d2e-3f4a5b6c7d8e';
  const asha = 'c6d7e8f9-a0b1-4c2d-8e3f-4a5b6c7d8e9f';
  const dev = 'd7e8f9a0-b1c2-4d3e-9f4a-5b6c7d8e9f0a';
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

  it('take 1 to 50 pipelines, stages or members, once each and in lower case, in the order given; null takes every note', () => {
    for (const [schema, first, second, noun] of [
      [webhookNotePipelineIdsSchema, sales, proposal, 'pipeline'],
      [webhookNoteStageIdsSchema, proposal, sales, 'stage'],
      [webhookNoteDealOwnerIdsSchema, dev, asha, 'member'],
    ] as const) {
      expect(schema.parse([second, first.toUpperCase(), second]), noun).toEqual([second, first]);
      expect(schema.parse(null), noun).toBeNull();
      expect(schema.parse(many(51).slice(1)), noun).toEqual(many(51).slice(1));
      for (const refused of [[], many(51), ['Sales'], [first, null], first, [42]]) {
        expect(schema.safeParse(refused).success, `${noun} ${JSON.stringify(refused)}`).toBe(false);
      }
      expect(schema.safeParse([]).error?.issues[0]?.message).toBe(
        `Choose at least one ${noun}, or take every note.`,
      );
      expect(schema.safeParse(many(51)).error?.issues[0]?.message).toBe(
        `Choose at most 50 ${noun}s.`,
      );
      expect(schema.safeParse(['Sales']).error?.issues[0]?.message).toBe(
        `Choose ${noun}s from the list.`,
      );
    }
    expect(WEBHOOK_LIMITS.notePipelines).toBe(50);
    expect(WEBHOOK_LIMITS.noteStages).toBe(50);
    expect(WEBHOOK_LIMITS.noteDealOwners).toBe(50);
  });

  it('are kept only while the endpoint takes note events: given, kept, or cleared', () => {
    expect(webhookTakesNoteEvents(['note.created'])).toBe(true);
    expect(webhookTakesNoteEvents(['contact.created', 'note.created'])).toBe(true);
    expect(webhookTakesNoteEvents(['deal.created', ...WEBHOOK_TASK_EVENTS])).toBe(false);
    for (const [keep, given, current] of [
      [webhookNotePipelineIdsFor, sales, proposal],
      [webhookNoteStageIdsFor, proposal, sales],
      [webhookNoteDealOwnerIdsFor, asha, dev],
    ] as const) {
      expect(keep(['note.created'], [given], null)).toEqual([given]);
      expect(keep(['contact.created', 'note.created'], undefined, [current])).toEqual([current]);
      expect(keep(['note.created'], null, [current])).toBeNull();
      expect(keep(['note.created'], undefined, null)).toBeNull();
      // Deal and task events have lists of their own.
      expect(keep(['deal.created', 'task.created'], [given], [current])).toBeNull();
    }
    // The refusals name the event as Settings lists it.
    for (const message of [
      WEBHOOK_NOTE_PIPELINES_NEED_THE_EVENTS,
      WEBHOOK_NOTE_STAGES_NEED_THE_EVENTS,
      WEBHOOK_NOTE_DEAL_OWNERS_NEED_THE_EVENTS,
    ]) {
      expect(message).toContain(WEBHOOK_EVENT_INFO['note.created'].label);
    }
  });
});

describe('change-maker filters for deal, task and note events (ADR-306)', () => {
  it('take members, automations or API keys, once each in the order Settings lists them; null takes every change', () => {
    expect(WEBHOOK_CRM_CHANGE_MAKERS).toEqual(['member', 'automation', 'api']);
    expect(WEBHOOK_CRM_CHANGE_MAKER_LABELS).toEqual({
      member: 'Members',
      automation: 'Automations',
      api: 'API keys',
    });
    expect(webhookCrmChangeMakersSchema.parse(['api', 'member', 'api'])).toEqual(['member', 'api']);
    expect(webhookCrmChangeMakersSchema.parse(['automation'])).toEqual(['automation']);
    expect(webhookCrmChangeMakersSchema.parse(null)).toBeNull();
    for (const refused of [
      [],
      ['agent'],
      ['api', 'contact'],
      'api',
      [null],
      ['api', 'api', 'api', 'api'],
    ]) {
      expect(webhookCrmChangeMakersSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookCrmChangeMakersSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one maker, or take every change.',
    );
    expect(webhookCrmChangeMakersSchema.safeParse(['bot']).error?.issues[0]?.message).toBe(
      'Choose who made the changes from the list.',
    );
    expect(
      webhookCrmChangeMakersSchema.safeParse(['api', 'api', 'api', 'api']).error?.issues[0]
        ?.message,
    ).toBe('Give each maker once.');
  });

  it('are kept only while the endpoint takes a deal, task or note event: given, kept, or cleared', () => {
    for (const type of [
      ...WEBHOOK_PIPELINE_EVENTS,
      ...WEBHOOK_TASK_EVENTS,
      'note.created',
    ] as const) {
      expect(webhookTakesCrmChanges([type]), type).toBe(true);
      expect(webhookCrmChangeMakersFor([type], ['api'], null), type).toEqual(['api']);
      expect(webhookCrmChangeMakersFor([type], undefined, ['member']), type).toEqual(['member']);
    }
    expect(webhookCrmChangeMakersFor(['deal.created'], null, ['member'])).toBeNull();
    expect(webhookCrmChangeMakersFor(['note.created'], undefined, null)).toBeNull();
    // Contact, message and other events have no maker to choose.
    expect(
      webhookTakesCrmChanges(['contact.updated', 'message.status', 'order.status_changed']),
    ).toBe(false);
    expect(
      webhookCrmChangeMakersFor(['contact.updated', 'message.status'], ['api'], ['member']),
    ).toBeNull();
    expect(WEBHOOK_CRM_CHANGE_MAKERS_NEED_THE_EVENTS).toBe(
      'Choose who made the changes only for an endpoint that receives deal, task or note events.',
    );
  });
});

describe('score filters for satisfaction survey answers (ADR-307)', () => {
  it('take scores 3, 2 or 1, once each in the order Settings lists them; null takes every answer', () => {
    expect(WEBHOOK_SURVEY_SCORES).toEqual([3, 2, 1]);
    expect(WEBHOOK_SURVEY_SCORE_LABELS).toEqual({
      3: 'First button (best)',
      2: 'Second button',
      1: 'Third button',
    });
    expect(webhookSurveyScoresSchema.parse([1, 3, 1])).toEqual([3, 1]);
    expect(webhookSurveyScoresSchema.parse([2])).toEqual([2]);
    expect(webhookSurveyScoresSchema.parse(null)).toBeNull();
    for (const refused of [[], [0], [4], ['3'], [2.5], [1, null], 3, [1, 1, 1, 1]]) {
      expect(webhookSurveyScoresSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookSurveyScoresSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one score, or take every answer.',
    );
    expect(webhookSurveyScoresSchema.safeParse([4]).error?.issues[0]?.message).toBe(
      'Choose scores from the list.',
    );
    expect(webhookSurveyScoresSchema.safeParse([1, 1, 1, 1]).error?.issues[0]?.message).toBe(
      'Give each score once.',
    );
  });

  it('are kept only while the endpoint takes the answers: given, kept, or cleared', () => {
    expect(webhookSurveyScoresFor(['satisfaction_survey.answered'], [1], null)).toEqual([1]);
    expect(
      webhookSurveyScoresFor(['satisfaction_survey.answered', 'message.received'], undefined, [3]),
    ).toEqual([3]);
    expect(webhookSurveyScoresFor(['satisfaction_survey.answered'], null, [3])).toBeNull();
    expect(webhookSurveyScoresFor(['satisfaction_survey.answered'], undefined, null)).toBeNull();
    // Conversation events have no score to choose.
    expect(webhookSurveyScoresFor(['conversation.status_changed'], [1], [3])).toBeNull();
    expect(WEBHOOK_SURVEY_SCORES_NEED_THE_EVENT).toBe(
      `Choose the scores only for an endpoint that receives ${WEBHOOK_EVENT_INFO['satisfaction_survey.answered'].label}.`,
    );
  });
});

describe('assignee filters (ADR-181)', () => {
  const mira = '6e7f8091-a2b3-44c5-96e7-f8091a2b3c4d';
  const ravi = '7f8091a2-b3c4-45d6-a7f8-091a2b3c4d5e';

  it('take 1 to 50 members, once each and in lower case, in the order given; null takes every conversation', () => {
    expect(webhookAssigneeIdsSchema.parse([ravi, mira.toUpperCase(), ravi, mira])).toEqual([
      ravi,
      mira,
    ]);
    expect(webhookAssigneeIdsSchema.parse(null)).toBeNull();
    const ids = Array.from(
      { length: WEBHOOK_LIMITS.assignees + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(WEBHOOK_LIMITS.assignees).toBe(50);
    expect(webhookAssigneeIdsSchema.parse(ids.slice(1))).toEqual(ids.slice(1));
    for (const refused of [[], ids, ['mira@example.com'], [mira, null], mira, [42]]) {
      expect(webhookAssigneeIdsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookAssigneeIdsSchema.safeParse(['mira']).error?.issues[0]?.message).toBe(
      'Choose members from the list.',
    );
    expect(webhookAssigneeIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one member, or take every conversation.',
    );
    expect(webhookAssigneeIdsSchema.safeParse(ids).error?.issues[0]?.message).toBe(
      'Choose at most 50 members.',
    );
  });

  it("apply to the events teams narrow, and an assignment's payload names both members", () => {
    for (const type of WEBHOOK_EVENT_KEYS) {
      const ofAConversation = WEBHOOK_TEAM_EVENTS.some((t) => t === type);
      expect(webhookAssigneeIdsFor([type], [mira], null), type).toEqual(
        ofAConversation ? [mira] : null,
      );
    }
    // The member it went to and the member it left, as GET /members lists them.
    const assignment = conversationAssignmentPayloadSchema.shape.data.shape.conversation.shape;
    expect('assigneeId' in assignment && 'previousAssigneeId' in assignment).toBe(true);
  });

  it('are kept only while the endpoint takes an event of a conversation: given, kept, or cleared', () => {
    expect(webhookAssigneeIdsFor(['message.received'], [mira], null)).toEqual([mira]);
    expect(webhookAssigneeIdsFor(['conversation.assignment_changed'], undefined, [ravi])).toEqual([
      ravi,
    ]);
    expect(webhookAssigneeIdsFor(['message.status'], null, [ravi])).toBeNull();
    expect(webhookAssigneeIdsFor(['message.received'], undefined, null)).toBeNull();
    expect(webhookAssigneeIdsFor(['consent.changed', 'order.received'], [mira], [ravi])).toBeNull();
    expect(webhookAssigneeIdsFor(['automation.run_ended'], undefined, [ravi])).toBeNull();
  });

  it('name a member, and say when one no longer takes conversations', () => {
    expect(webhookAssigneeText({ id: mira, name: 'Mira', assignable: true })).toBe('Mira');
    expect(webhookAssigneeText({ id: ravi, name: 'Ravi', assignable: false })).toBe(
      'Ravi (no longer takes conversations)',
    );
    expect(webhookAssigneeText({ id: ravi, name: null, assignable: false })).toBe(
      'Unknown member (no longer takes conversations)',
    );
  });
});

describe('contact tag filters (ADR-267)', () => {
  it('take 1 to 50 tags as contacts carry them, once each, in the order given; null takes every conversation', () => {
    expect(webhookContactTagsSchema.parse(['VIP', ' wholesale ', 'vip', 'Gold   Member'])).toEqual([
      'vip',
      'wholesale',
      'gold member',
    ]);
    expect(webhookContactTagsSchema.parse(null)).toBeNull();
    const tags = Array.from({ length: WEBHOOK_LIMITS.contactTags + 1 }, (_, i) => `tag ${i}`);
    expect(WEBHOOK_LIMITS.contactTags).toBe(50);
    expect(webhookContactTagsSchema.parse(tags.slice(1))).toEqual(tags.slice(1));
    const refusal = (given: unknown) => {
      const issue = webhookContactTagsSchema.safeParse(given).error?.issues[0];
      return issue && [issue.path.join('.'), issue.message];
    };
    expect(refusal([])).toEqual(['', 'Give at least one tag, or take every conversation.']);
    expect(refusal(tags)).toEqual(['', 'Give at most 50 tags.']);
    expect(refusal(['vip', 'a,b'])).toEqual([
      '1',
      'Tags cannot contain commas or control characters.',
    ]);
    expect(refusal(['vip', 'gold', '   '])).toEqual(['2', 'Tags cannot be empty.']);
    expect(refusal(['x'.repeat(41)])).toEqual(['0', 'Tags are limited to 40 characters.']);
    expect(refusal(['vip', 42])).toEqual(['1', 'Give tags as text.']);
    expect(webhookContactTagsSchema.parse(['x'.repeat(40)])).toEqual(['x'.repeat(40)]);
    expect(webhookContactTagsSchema.safeParse('vip').success).toBe(false);
  });

  it('apply to the events of a conversation only, and are kept only while one is taken: given, kept, or cleared', () => {
    for (const type of WEBHOOK_EVENT_KEYS) {
      expect(webhookContactTagsFor([type], ['vip'], null), type).toEqual(
        (WEBHOOK_TEAM_EVENTS as readonly string[]).includes(type) ? ['vip'] : null,
      );
    }
    expect(webhookContactTagsFor(['conversation.team_changed'], undefined, ['vip'])).toEqual([
      'vip',
    ]);
    expect(webhookContactTagsFor(['message.status'], null, ['vip'])).toBeNull();
    expect(webhookContactTagsFor(['message.received'], undefined, null)).toBeNull();
    expect(
      webhookContactTagsFor(['deal.created', 'contact.created'], ['vip'], ['gold']),
    ).toBeNull();
    expect(WEBHOOK_CONTACT_TAGS_NEED_THE_EVENTS).toBe(
      'Choose contact tags only for an endpoint that receives message or conversation events.',
    );
  });
});

describe('conversation tag filters (ADR-273)', () => {
  it('take 1 to 50 tags as conversations carry them, once each, in the order given; null takes every conversation', () => {
    expect(
      webhookConversationTagsSchema.parse(['Refund', ' urgent ', 'refund', 'Delivery   Delay']),
    ).toEqual(['refund', 'urgent', 'delivery delay']);
    expect(webhookConversationTagsSchema.parse(null)).toBeNull();
    const tags = Array.from({ length: WEBHOOK_LIMITS.conversationTags + 1 }, (_, i) => `tag ${i}`);
    expect(WEBHOOK_LIMITS.conversationTags).toBe(50);
    expect(webhookConversationTagsSchema.parse(tags.slice(1))).toEqual(tags.slice(1));
    const refusal = (given: unknown) => {
      const issue = webhookConversationTagsSchema.safeParse(given).error?.issues[0];
      return issue && [issue.path.join('.'), issue.message];
    };
    expect(refusal([])).toEqual(['', 'Give at least one tag, or take every conversation.']);
    expect(refusal(tags)).toEqual(['', 'Give at most 50 tags.']);
    expect(refusal(['refund', 'a,b'])).toEqual([
      '1',
      'Tags cannot contain commas or control characters.',
    ]);
    expect(refusal(['refund', 'urgent', '   '])).toEqual(['2', 'Tags cannot be empty.']);
    expect(refusal(['x'.repeat(41)])).toEqual(['0', 'Tags are limited to 40 characters.']);
    expect(refusal(['refund', 42])).toEqual(['1', 'Give tags as text.']);
    expect(webhookConversationTagsSchema.parse(['x'.repeat(40)])).toEqual(['x'.repeat(40)]);
    expect(webhookConversationTagsSchema.safeParse('refund').success).toBe(false);
  });

  it('apply to the events of a conversation only, and are kept only while one is taken: given, kept, or cleared', () => {
    for (const type of WEBHOOK_EVENT_KEYS) {
      expect(webhookConversationTagsFor([type], ['refund'], null), type).toEqual(
        (WEBHOOK_TEAM_EVENTS as readonly string[]).includes(type) ? ['refund'] : null,
      );
    }
    expect(
      webhookConversationTagsFor(['conversation.assignment_changed'], undefined, ['refund']),
    ).toEqual(['refund']);
    expect(webhookConversationTagsFor(['message.status'], null, ['refund'])).toBeNull();
    expect(webhookConversationTagsFor(['message.received'], undefined, null)).toBeNull();
    expect(
      webhookConversationTagsFor(['deal.created', 'contact.created'], ['refund'], ['urgent']),
    ).toBeNull();
    expect(WEBHOOK_CONVERSATION_TAGS_NEED_THE_EVENTS).toBe(
      'Choose conversation tags only for an endpoint that receives message or conversation events.',
    );
  });
});

describe('run trigger filters (ADR-183)', () => {
  it('take 1 to 5 of the ways a live run starts, once each in the builder’s order; null takes every run', () => {
    expect(WEBHOOK_RUN_TRIGGERS).toEqual([
      'keyword',
      'conversation_started',
      'any_message',
      'store_event',
      'api',
    ]);
    expect(webhookRunTriggersSchema.parse(['api', 'keyword'])).toEqual(['keyword', 'api']);
    expect(webhookRunTriggersSchema.parse([...WEBHOOK_RUN_TRIGGERS].reverse())).toEqual([
      ...WEBHOOK_RUN_TRIGGERS,
    ]);
    expect(webhookRunTriggersSchema.parse(null)).toBeNull();
    // Members' test runs send no events, so `test` is not a choice; nor is anything else.
    for (const refused of [
      [],
      ['test'],
      ['API'],
      ['keyword', null],
      'api',
      [...WEBHOOK_RUN_TRIGGERS, 'api'],
    ]) {
      expect(webhookRunTriggersSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookRunTriggersSchema.safeParse(['test']).error?.issues[0]?.message).toBe(
      'Choose what started the runs from the list.',
    );
    expect(webhookRunTriggersSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one way a run starts, or take every run.',
    );
    expect(
      webhookRunTriggersSchema.safeParse([...WEBHOOK_RUN_TRIGGERS, 'api']).error?.issues[0]
        ?.message,
    ).toBe('Give each way a run starts once.');
  });

  it('are the triggers the run events report, each named as the automation pages name it', () => {
    for (const schema of [
      automationRunStartedPayloadSchema,
      automationRunEndedPayloadSchema,
      automationRunStepPayloadSchema,
    ]) {
      expect(schema.shape.data.shape.run.shape.trigger.options).toEqual([...WEBHOOK_RUN_TRIGGERS]);
    }
    expect(WEBHOOK_RUN_TRIGGER_LABELS).toEqual({
      keyword: 'Keyword',
      conversation_started: 'New conversation',
      any_message: 'Any message',
      store_event: 'Order messages',
      api: 'API',
    });
  });

  it('are kept only while the endpoint takes a run event: given, kept, or cleared', () => {
    expect(webhookRunTriggersFor(['automation.run_started'], ['api'], null)).toEqual(['api']);
    expect(webhookRunTriggersFor(['automation.run_ended'], undefined, ['keyword'])).toEqual([
      'keyword',
    ]);
    expect(webhookRunTriggersFor(['automation.run_step'], undefined, ['keyword'])).toEqual([
      'keyword',
    ]);
    expect(
      webhookRunTriggersFor(['automation.run_started', 'message.received'], null, ['api']),
    ).toBeNull();
    expect(webhookRunTriggersFor(['automation.run_ended'], undefined, null)).toBeNull();
    expect(
      webhookRunTriggersFor(['message.received', 'order.received'], ['api'], ['api']),
    ).toBeNull();
  });
});

describe('custom field filters (ADR-184)', () => {
  it('take 1 to 50 field keys, once each in the order given; null takes every field', () => {
    expect(webhookContactFieldKeysSchema.parse(['tier', 'city', 'tier'])).toEqual(['tier', 'city']);
    expect(webhookContactFieldKeysSchema.parse(null)).toBeNull();
    const keys = Array.from({ length: WEBHOOK_LIMITS.contactFields + 1 }, (_, i) => `f${i}`);
    expect(WEBHOOK_LIMITS.contactFields).toBe(50);
    expect(webhookContactFieldKeysSchema.parse(keys.slice(1))).toEqual(keys.slice(1));
    // Keys as GET /contact-fields lists them: no labels, parts or a whole `fields.<key>`.
    for (const refused of [
      [],
      keys,
      ['City'],
      ['fields.city'],
      ['1st'],
      ['city', null],
      'city',
      [7],
    ]) {
      expect(
        webhookContactFieldKeysSchema.safeParse(refused).success,
        JSON.stringify(refused),
      ).toBe(false);
    }
    expect(webhookContactFieldKeysSchema.safeParse(['City']).error?.issues[0]?.message).toBe(
      'Choose fields from the list.',
    );
    expect(webhookContactFieldKeysSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one field, or take every field.',
    );
    expect(webhookContactFieldKeysSchema.safeParse(keys).error?.issues[0]?.message).toBe(
      'Choose at most 50 fields.',
    );
  });

  it('apply while an endpoint takes contact.updated for every part or for fields, and are kept or cleared with them', () => {
    expect(webhookTakesFieldChanges(['contact.updated'], null)).toBe(true);
    expect(webhookTakesFieldChanges(['contact.updated'], ['email', 'fields'])).toBe(true);
    expect(webhookTakesFieldChanges(['contact.updated'], ['email', 'tags'])).toBe(false);
    expect(webhookTakesFieldChanges(['contact.created', 'contact.erased'], null)).toBe(false);
    expect(webhookContactFieldKeysFor(['contact.updated'], null, ['city'], null)).toEqual(['city']);
    expect(
      webhookContactFieldKeysFor(['contact.updated'], ['fields'], undefined, ['tier']),
    ).toEqual(['tier']);
    expect(webhookContactFieldKeysFor(['contact.updated'], null, null, ['tier'])).toBeNull();
    // Parts without fields, or no contact.updated, clear them.
    expect(
      webhookContactFieldKeysFor(['contact.updated'], ['name'], undefined, ['tier']),
    ).toBeNull();
    expect(webhookContactFieldKeysFor(['contact.created'], null, ['city'], ['tier'])).toBeNull();
  });

  it('name a field by its label and key, or say it was deleted', () => {
    expect(webhookFieldText({ key: 'city', label: 'City' })).toBe('City (city)');
    expect(webhookFieldText({ key: 'tier', label: null })).toBe('tier (deleted)');
  });
});

describe('consent change filters (ADR-189)', () => {
  it('take 1 to 4 consent changes, once each in the order Settings lists them; null takes every change', () => {
    expect(WEBHOOK_CONSENT_CHANGES).toEqual([
      'marketing_opt_in',
      'marketing_opt_out',
      'utility_opt_in',
      'utility_opt_out',
    ]);
    expect(webhookConsentChangesSchema.parse(['utility_opt_out', 'marketing_opt_out'])).toEqual([
      'marketing_opt_out',
      'utility_opt_out',
    ]);
    expect(webhookConsentChangesSchema.parse([...WEBHOOK_CONSENT_CHANGES].reverse())).toEqual([
      ...WEBHOOK_CONSENT_CHANGES,
    ]);
    expect(webhookConsentChangesSchema.parse(null)).toBeNull();
    for (const refused of [
      [],
      ['opt_in'],
      ['marketing'],
      ['marketing_opt_in', null],
      'marketing_opt_in',
      [...WEBHOOK_CONSENT_CHANGES, 'utility_opt_out'],
    ]) {
      expect(webhookConsentChangesSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookConsentChangesSchema.safeParse(['opt_in']).error?.issues[0]?.message).toBe(
      'Choose consent changes from the list.',
    );
    expect(webhookConsentChangesSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one consent change, or take every change.',
    );
    expect(
      webhookConsentChangesSchema.safeParse([...WEBHOOK_CONSENT_CHANGES, 'utility_opt_out']).error
        ?.issues[0]?.message,
    ).toBe('Give each consent change once.');
  });

  it('are every purpose and action consent.changed reports, each named', () => {
    const data = consentChangedPayloadSchema.shape.data.shape;
    expect(
      data.purpose.options.flatMap((purpose) =>
        data.action.options.map((action) => `${purpose}_${action}`),
      ),
    ).toEqual([...WEBHOOK_CONSENT_CHANGES]);
    expect(WEBHOOK_CONSENT_CHANGE_LABELS).toEqual({
      marketing_opt_in: 'Marketing opt-ins',
      marketing_opt_out: 'Marketing opt-outs',
      utility_opt_in: 'Utility opt-ins',
      utility_opt_out: 'Utility opt-outs',
    });
  });

  it('are kept only while the endpoint takes consent.changed: given, kept, or cleared', () => {
    expect(webhookConsentChangesFor(['consent.changed'], ['utility_opt_in'], null)).toEqual([
      'utility_opt_in',
    ]);
    expect(
      webhookConsentChangesFor(['consent.changed', 'contact.updated'], undefined, [
        'marketing_opt_out',
      ]),
    ).toEqual(['marketing_opt_out']);
    expect(webhookConsentChangesFor(['consent.changed'], null, ['marketing_opt_out'])).toBeNull();
    expect(webhookConsentChangesFor(['consent.changed'], undefined, null)).toBeNull();
    expect(
      webhookConsentChangesFor(
        ['contact.updated', 'message.received'],
        ['utility_opt_in'],
        ['utility_opt_in'],
      ),
    ).toBeNull();
  });
});

describe('contact source filters (ADR-190)', () => {
  it('take 1 to 5 of the places contacts come from, once each in their order; null takes every contact', () => {
    expect(WEBHOOK_CONTACT_SOURCES).toEqual(['whatsapp', 'manual', 'import', 'api', 'store']);
    expect(webhookContactSourcesSchema.parse(['store', 'whatsapp'])).toEqual(['whatsapp', 'store']);
    expect(webhookContactSourcesSchema.parse([...WEBHOOK_CONTACT_SOURCES].reverse())).toEqual([
      ...WEBHOOK_CONTACT_SOURCES,
    ]);
    expect(webhookContactSourcesSchema.parse(null)).toBeNull();
    for (const refused of [
      [],
      ['agent'],
      ['WhatsApp'],
      ['api', null],
      'api',
      [...WEBHOOK_CONTACT_SOURCES, 'api'],
    ]) {
      expect(webhookContactSourcesSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookContactSourcesSchema.safeParse(['agent']).error?.issues[0]?.message).toBe(
      'Choose where contacts came from from the list.',
    );
    expect(webhookContactSourcesSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one place contacts come from, or take every contact.',
    );
    expect(
      webhookContactSourcesSchema.safeParse([...WEBHOOK_CONTACT_SOURCES, 'api']).error?.issues[0]
        ?.message,
    ).toBe('Give each place contacts come from once.');
  });

  it('are every source a contact has, each named', () => {
    expect([...WEBHOOK_CONTACT_SOURCES]).toEqual([...CONTACT_SOURCES]);
    expect(WEBHOOK_CONTACT_SOURCE_LABELS).toEqual({
      whatsapp: 'Wrote on WhatsApp',
      manual: 'Added in the app',
      import: 'Imported from a file',
      api: 'Added through the API',
      store: 'From a store',
    });
  });

  it('are kept only while the endpoint takes contact.created: given, kept, or cleared', () => {
    expect(webhookContactSourcesFor(['contact.created'], ['whatsapp'], null)).toEqual(['whatsapp']);
    expect(
      webhookContactSourcesFor(['contact.created', 'contact.updated'], undefined, ['import']),
    ).toEqual(['import']);
    expect(webhookContactSourcesFor(['contact.created'], null, ['import'])).toBeNull();
    expect(webhookContactSourcesFor(['contact.created'], undefined, null)).toBeNull();
    expect(
      webhookContactSourcesFor(['contact.updated', 'contact.erased'], ['api'], ['api']),
    ).toBeNull();
  });
});

describe('message type filters (ADR-191)', () => {
  it('take 1 to 14 of the types a received message has, once each in their order; null takes every message', () => {
    expect(WEBHOOK_RECEIVED_MESSAGE_TYPES).toHaveLength(14);
    expect(webhookMessageTypesSchema.parse(['order', 'text', 'order'])).toEqual(['text', 'order']);
    expect(webhookMessageTypesSchema.parse([...WEBHOOK_RECEIVED_MESSAGE_TYPES].reverse())).toEqual([
      ...WEBHOOK_RECEIVED_MESSAGE_TYPES,
    ]);
    expect(webhookMessageTypesSchema.parse(null)).toBeNull();
    // A template is only ever sent, so it is no choice; nor is anything else.
    for (const refused of [
      [],
      ['template'],
      ['Text'],
      ['list_reply'],
      ['text', null],
      'text',
      [...WEBHOOK_RECEIVED_MESSAGE_TYPES, 'text'],
    ]) {
      expect(webhookMessageTypesSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookMessageTypesSchema.safeParse(['template']).error?.issues[0]?.message).toBe(
      'Choose message types from the list.',
    );
    expect(webhookMessageTypesSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one message type, or take every message.',
    );
    expect(
      webhookMessageTypesSchema.safeParse([...WEBHOOK_RECEIVED_MESSAGE_TYPES, 'text']).error
        ?.issues[0]?.message,
    ).toBe('Give each message type once.');
  });

  it('are every message type but a template, each named', () => {
    expect([...WEBHOOK_RECEIVED_MESSAGE_TYPES]).toEqual(
      MESSAGE_TYPES.filter((type) => type !== 'template'),
    );
    expect(Object.keys(WEBHOOK_RECEIVED_MESSAGE_TYPE_LABELS)).toEqual([
      ...WEBHOOK_RECEIVED_MESSAGE_TYPES,
    ]);
    expect(WEBHOOK_RECEIVED_MESSAGE_TYPE_LABELS).toMatchObject({
      text: 'Text',
      interactive: 'Replies to buttons and lists',
      button: 'Template button replies',
      system: 'WhatsApp account updates',
    });
  });

  it('are kept only while the endpoint takes message.received: given, kept, or cleared', () => {
    expect(webhookMessageTypesFor(['message.received'], ['order'], null)).toEqual(['order']);
    expect(
      webhookMessageTypesFor(['message.received', 'message.status'], undefined, ['text']),
    ).toEqual(['text']);
    expect(webhookMessageTypesFor(['message.received'], null, ['text'])).toBeNull();
    expect(webhookMessageTypesFor(['message.received'], undefined, null)).toBeNull();
    expect(webhookMessageTypesFor(['message.status'], ['text'], ['text'])).toBeNull();
  });
});

describe('run end reason filters (ADR-192)', () => {
  it('take 1 to 21 of the reasons a run ends for, once each in their order; null takes every reason', () => {
    expect(WEBHOOK_RUN_END_REASONS).toHaveLength(21);
    expect(webhookRunEndReasonsSchema.parse(['send_failed', 'end_node', 'send_failed'])).toEqual([
      'end_node',
      'send_failed',
    ]);
    expect(webhookRunEndReasonsSchema.parse([...WEBHOOK_RUN_END_REASONS].reverse())).toEqual([
      ...WEBHOOK_RUN_END_REASONS,
    ]);
    expect(webhookRunEndReasonsSchema.parse(null)).toBeNull();
    // A status is no reason, nor is anything else.
    for (const refused of [
      [],
      ['failed'],
      ['Expired'],
      ['budget'],
      ['expired', null],
      'expired',
      [...WEBHOOK_RUN_END_REASONS, 'expired'],
    ]) {
      expect(webhookRunEndReasonsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookRunEndReasonsSchema.safeParse(['failed']).error?.issues[0]?.message).toBe(
      'Choose end reasons from the list.',
    );
    expect(webhookRunEndReasonsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one end reason, or take every end.',
    );
    expect(
      webhookRunEndReasonsSchema.safeParse([...WEBHOOK_RUN_END_REASONS, 'expired']).error?.issues[0]
        ?.message,
    ).toBe('Give each end reason once.');
  });

  it('are the reasons runs end for, by the end they belong to, each named', () => {
    expect(WEBHOOK_RUN_END_REASONS_BY_END).toEqual(AUTOMATION_END_REASONS);
    expect(Object.keys(WEBHOOK_RUN_END_REASONS_BY_END)).toEqual([...WEBHOOK_RUN_END_STATUSES]);
    expect([...WEBHOOK_RUN_END_REASONS]).toEqual(Object.values(AUTOMATION_END_REASONS).flat());
    expect(Object.keys(WEBHOOK_RUN_END_REASON_LABELS)).toEqual([...WEBHOOK_RUN_END_REASONS]);
    expect(WEBHOOK_RUN_END_REASON_LABELS).toMatchObject({
      end_node: 'Reached an End step',
      stopped_by_api: 'Stopped through the API',
      expired: 'Older than 7 days',
      send_failed: 'A message did not reach the customer',
    });
  });

  it('narrow the ends they name reasons of, and are chosen among the ends taken only', () => {
    expect(webhookRunEndTakesReason(null, 'expired')).toBe(true);
    expect(webhookRunEndTakesReason(['failed'], 'expired')).toBe(true);
    expect(webhookRunEndTakesReason(['completed', 'failed'], 'end_node')).toBe(true);
    expect(webhookRunEndTakesReason(['completed'], 'expired')).toBe(false);
    expect(webhookRunEndTakesReason(['taken_over', 'stopped'], 'handoff_node')).toBe(false);
    const refused = webhookRunEndReasonsNeedTheEnds();
    expect(isAppError(refused) && refused.code).toBe('validation_failed');
    expect(refused.message).toBe('Choose end reasons only of the ends the endpoint receives.');
    expect(refused.issues).toEqual([
      { path: 'runEndReasons', message: WEBHOOK_RUN_END_REASONS_NEED_THE_ENDS },
    ]);
  });

  it('are kept only while the endpoint takes automation.run_ended: given, kept for the ends kept, or cleared', () => {
    const ended = ['automation.run_ended'] as const;
    expect(webhookRunEndReasonsFor([...ended], null, ['send_failed'], null)).toEqual([
      'send_failed',
    ]);
    expect(webhookRunEndReasonsFor([...ended], ['failed'], ['expired'], ['send_failed'])).toEqual([
      'expired',
    ]);
    expect(
      webhookRunEndReasonsFor([...ended], null, undefined, ['end_node', 'send_failed']),
    ).toEqual(['end_node', 'send_failed']);
    // The reasons of an end it no longer takes go; none left takes every reason.
    expect(
      webhookRunEndReasonsFor([...ended], ['failed'], undefined, ['end_node', 'send_failed']),
    ).toEqual(['send_failed']);
    expect(webhookRunEndReasonsFor([...ended], ['completed'], undefined, ['send_failed'])).toBe(
      null,
    );
    expect(webhookRunEndReasonsFor([...ended], ['failed'], null, ['send_failed'])).toBeNull();
    expect(webhookRunEndReasonsFor([...ended], null, undefined, null)).toBeNull();
    expect(
      webhookRunEndReasonsFor(['automation.run_started'], null, ['expired'], ['expired']),
    ).toBeNull();
  });

  it('are shown ticked as the runs are taken, and sent for the ends they narrow only', () => {
    expect(webhookRunEndReasonsTicked(null)).toEqual([...WEBHOOK_RUN_END_REASONS]);
    // An end the list names no reason of takes its every run, so all of its reasons show ticked.
    const ticked = webhookRunEndReasonsTicked(['send_failed', 'no_next']);
    expect(ticked).toEqual([
      'no_next',
      ...AUTOMATION_END_REASONS.handed_off,
      ...AUTOMATION_END_REASONS.taken_over,
      ...AUTOMATION_END_REASONS.stopped,
      'send_failed',
    ]);
    expect(webhookRunEndReasonsChosen(null, ticked)).toEqual(['no_next', 'send_failed']);
    expect(webhookRunEndReasonsChosen(null, [...WEBHOOK_RUN_END_REASONS])).toBeNull();
    expect(webhookRunEndReasonsChosen(['failed'], [...WEBHOOK_RUN_END_REASONS])).toBeNull();
    // An end not taken sends none of its reasons, however they are ticked.
    expect(webhookRunEndReasonsChosen(['completed', 'stopped'], ticked)).toEqual(['no_next']);
    expect(webhookRunEndReasonsChosen(['handed_off'], ticked)).toBeNull();
    expect(
      webhookRunEndReasonsChosen(
        ['failed'],
        WEBHOOK_RUN_END_REASONS.filter((r) => r !== 'expired' && r !== 'error'),
      ),
    ).toEqual([
      'budget_steps',
      'budget_loop',
      'budget_messages',
      'budget_http',
      'send_blocked',
      'send_failed',
    ]);
  });
});

describe('the event of a CRM note (ADR-280)', () => {
  it('is one event, on no number, that no filter narrows, labelled as Settings lists it', () => {
    expect(WEBHOOK_EVENT_INFO['note.created']).toEqual({
      label: 'Note added',
      description:
        'A note was added to a CRM contact’s or deal’s timeline: by a member or an API key.',
    });
    for (const takes of [
      webhookTakesChannelEvents,
      webhookTakesTaskEvents,
      webhookTakesPipelineEvents,
      webhookTakesTeamEvents,
    ]) {
      expect(takes(['note.created']), takes.name).toBe(false);
    }
  });

  it('gives the note without its text: what it is about, who wrote it and its contact now', () => {
    const data = noteCreatedPayloadSchema.shape.data.shape;
    expect(Object.keys(data)).toEqual(['note', 'contact']);
    const note = data.note.shape;
    expect(Object.keys(note)).toEqual(['id', 'dealId', 'writtenBy', 'apiKeyId', 'createdAt']);
    expect(note.writtenBy.options).toEqual(['member', 'api']);
    expect(note.writtenBy.description).toContain('(member, never which member)');
    expect(note.apiKeyId.description).toContain('when writtenBy is api; null otherwise');
    expect(note.id.description).toContain('GET /notes/{id}');
    expect(data.contact.description).toContain('the contact kept when a merge moved it');
    const id = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
    const body = (writtenBy: string, apiKeyId: string | null) => ({
      id,
      type: 'note.created',
      createdAt: '2026-10-07T10:00:00.000Z',
      createdAtExact: '2026-10-07T10:00:00.000000Z',
      data: {
        note: { id, dealId: null, writtenBy, apiKeyId, createdAt: '2026-10-07T10:00:00.000Z' },
        contact: { id, phone: '+919845012345', name: 'Asha' },
      },
    });
    expect(noteCreatedPayloadSchema.safeParse(body('member', null)).success).toBe(true);
    expect(noteCreatedPayloadSchema.safeParse(body('api', id)).success).toBe(true);
    expect(noteCreatedPayloadSchema.safeParse(body('automation', null)).success).toBe(false);
    const withoutContact = {
      ...body('member', null),
      data: { note: body('member', null).data.note },
    };
    expect(noteCreatedPayloadSchema.safeParse(withoutContact).success).toBe(false);
  });

  it('is described: never the text, read with notes.read, never changed, gone with erasure', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const described = doc.webhooks['note.created'].post.description;
    for (const words of [
      'A note was added to a CRM contact’s or deal’s timeline: by a member or an API key.',
      'who wrote it (`note.writtenBy`: a member, never which, or an API key, named by note.apiKeyId',
      'the contact kept when a merge has moved it',
      'Never the note’s text, which may hold anything a member wrote: read the note with GET /notes/{id} (`notes.read`).',
      'Notes are never changed, so no other note event is sent',
      'erasing a contact deletes its notes, so the events of an erased contact’s notes are no longer delivered',
      'An endpoint can narrow it by the pipeline, stage or owner of the note’s deal when the note is added',
    ]) {
      expect(described).toContain(words);
    }
  });
});

describe('the event of a Payment Link (ADR-285)', () => {
  it('is one event on the order’s number, labelled as Settings lists it', () => {
    expect(WEBHOOK_EVENT_INFO['payment_link.status_changed']).toEqual({
      label: 'Payment Link status',
      description:
        'A Payment Link for a WhatsApp order was created at Razorpay (sent in the chat or not), partly paid, paid, expired or cancelled, or Razorpay could not create it.',
    });
    expect(webhookTakesChannelEvents(['payment_link.status_changed'])).toBe(true);
    for (const takes of [
      webhookTakesTaskEvents,
      webhookTakesPipelineEvents,
      webhookTakesTeamEvents,
    ]) {
      expect(takes(['payment_link.status_changed']), takes.name).toBe(false);
    }
  });

  it('gives the link as the API reads it, with the change, its order, conversation, contact and number', () => {
    const data = paymentLinkStatusChangedPayloadSchema.shape.data.shape;
    expect(Object.keys(data)).toEqual([
      'paymentLink',
      'order',
      'conversation',
      'contact',
      'channel',
    ]);
    const link = data.paymentLink.shape;
    expect(Object.keys(link)).toEqual([
      'id',
      'orderId',
      'status',
      'amountMinor',
      'amountPaidMinor',
      'currency',
      'expiresAt',
      'paidAt',
      'cancelRequestedAt',
      'messageId',
      'notSentReason',
      'error',
      'requestedBy',
      'requestedByApiKeyId',
      'createdAt',
      'checkedAt',
      'previousStatus',
    ]);
    expect(link.status.description).toContain(
      'The status this event reports, as the worker wrote it',
    );
    expect(link.previousStatus.options).toEqual([...PAYMENT_LINK_STATUSES]);
    expect(Object.keys(data.order.shape)).toEqual(['id', 'reference', 'status']);
    expect(data.order.shape.status.description).toContain(
      'order.status_changed reports its changes',
    );
    // Never the link's address or Razorpay's ids.
    expect(JSON.stringify(z.toJSONSchema(paymentLinkStatusChangedPayloadSchema))).not.toMatch(
      /"(url|shortUrl|reference_id|providerLinkId|paymentId)"/,
    );
    const id = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
    const at = '2026-10-07T10:00:00.000Z';
    const body = (status: string, previousStatus: string) => ({
      id,
      type: 'payment_link.status_changed',
      createdAt: at,
      createdAtExact: '2026-10-07T10:00:00.000000Z',
      data: {
        paymentLink: {
          id,
          orderId: id,
          status,
          amountMinor: 3000,
          amountPaidMinor: 0,
          currency: 'INR',
          expiresAt: at,
          paidAt: null,
          cancelRequestedAt: null,
          messageId: null,
          notSentReason: 'The link was created but not sent: the WhatsApp number is not active.',
          error: null,
          requestedBy: 'api',
          requestedByApiKeyId: id,
          createdAt: at,
          checkedAt: at,
          previousStatus,
        },
        order: { id, reference: 'K7M2QX9P', status: 'awaiting_payment' },
        conversation: { id },
        contact: { id, phone: '+919845012345', name: 'Asha' },
        channel: { id, phone: '+91 80 4567 8901' },
      },
    });
    expect(
      paymentLinkStatusChangedPayloadSchema.safeParse(body('created', 'creating')).success,
    ).toBe(true);
    expect(
      paymentLinkStatusChangedPayloadSchema.safeParse(body('paid', 'partially_paid')).success,
    ).toBe(true);
    expect(paymentLinkStatusChangedPayloadSchema.safeParse(body('refunded', 'paid')).success).toBe(
      false,
    );
  });

  it('is described: the change as written, the link as the API reads it, never its address', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const described = doc.webhooks['payment_link.status_changed'].post.description;
    for (const words of [
      'A Payment Link for a WhatsApp order was created at Razorpay (sent in the chat or not), partly paid, paid, expired or cancelled, or Razorpay could not create it.',
      'paymentLink.status and paymentLink.previousStatus are the change, as the worker wrote it',
      'the rest is the link as GET /orders/{id}/payment-links reads it when the event is delivered',
      'why it was not sent (notSentReason)',
      'who asked for it (a member, never which, or an API key by its id)',
      'Never the link’s address or Razorpay’s ids.',
      'Only a link Razorpay reports paid marks the order paid, which order.status_changed reports.',
      'an endpoint that names numbers receives it for those numbers only',
    ]) {
      expect(described).toContain(words);
    }
  });
});

describe('the event of a satisfaction survey answer (ADR-293)', () => {
  const id = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
  const tenantId = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
  const at = new Date('2026-10-07T10:00:00.000Z');

  /** A transaction that answers its reads, in order, with `answers`; another read fails the test. */
  function answering(answers: unknown[][]) {
    const queue = [...answers];
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => {
        const rows = queue.shift();
        if (!rows) throw new Error('an unexpected read');
        return Promise.resolve(rows);
      },
    };
    return {
      tx: { select: () => chain } as unknown as Parameters<typeof buildWebhookPayload>[0],
      unread: () => queue.length,
    };
  }

  const event = (surveyId: unknown) =>
    ({
      id,
      tenantId,
      type: 'satisfaction_survey.answered',
      messageId: null,
      conversationId: id,
      contactId: id,
      templateId: null,
      status: null,
      detail: { surveyId },
      contactChanges: null,
      tagsAdded: null,
      tagsRemoved: null,
      occurredAt: at,
      occurredAtExact: at.toISOString().replace('Z', '000Z'),
    }) as unknown as Parameters<typeof buildWebhookPayload>[1];

  it('is one event on the conversation’s number, labelled as Settings lists it', () => {
    expect(WEBHOOK_EVENT_INFO['satisfaction_survey.answered']).toEqual({
      label: 'Satisfaction survey answered',
      description:
        'A customer answered the satisfaction survey sent when a member resolved their conversation, by tapping one of its three buttons.',
    });
    expect(webhookTakesChannelEvents(['satisfaction_survey.answered'])).toBe(true);
    for (const takes of [
      webhookTakesTaskEvents,
      webhookTakesPipelineEvents,
      webhookTakesTeamEvents,
    ]) {
      expect(takes(['satisfaction_survey.answered']), takes.name).toBe(false);
    }
  });

  it('gives the survey as GET /satisfaction-surveys reads it, with its conversation, contact and number', () => {
    const data = satisfactionSurveyAnsweredPayloadSchema.shape.data.shape;
    expect(Object.keys(data)).toEqual(['survey', 'conversation', 'contact', 'channel']);
    expect(Object.keys(data.survey.shape)).toEqual(Object.keys(apiSatisfactionSurveySchema.shape));
    const body = (score: number) => ({
      id,
      type: 'satisfaction_survey.answered',
      createdAt: at.toISOString(),
      createdAtExact: at.toISOString().replace('Z', '000Z'),
      data: {
        survey: {
          id,
          conversationId: id,
          status: 'answered',
          skipReason: null,
          messageId: id,
          messageStatus: 'read',
          score,
          answerMessageId: id,
          answeredAt: at.toISOString(),
          assigneeId: id,
          resolvedById: id,
          createdAt: at.toISOString(),
        },
        conversation: { id },
        contact: { id, phone: '+919845012345', name: 'Asha' },
        channel: { id, phone: '+91 80 4567 8901' },
      },
    });
    expect(satisfactionSurveyAnsweredPayloadSchema.safeParse(body(3)).success).toBe(true);
    expect(satisfactionSurveyAnsweredPayloadSchema.safeParse(body(4)).success).toBe(false);
  });

  it('builds the body from the survey as it is now and the contact as erasure left it', async () => {
    const [conversation, contact, channel, message, answer, member, captured] = [
      '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03',
      '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f04',
      '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f05',
      '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f06',
      '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f07',
      '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f08',
      '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f09',
    ];
    const survey = {
      id,
      conversationId: conversation,
      skipReason: null,
      messageId: message,
      messageStatus: 'delivered',
      score: 1,
      answerMessageId: answer,
      answeredAt: at,
      assigneeId: null,
      resolvedById: member,
      createdAt: at,
      cursorAt: '2026-10-07T10:00:00.000000Z',
      contactId: contact,
      channelId: channel,
      channelPhone: '+91 80 4567 8901',
    };
    const reads = answering([[survey], [{ phone: '+919845012345', name: 'Asha', erasedAt: at }]]);
    // The contact captured with the event, since merged away: the conversation's contact now is sent.
    const built = await buildWebhookPayload(
      reads.tx,
      { ...event(id), conversationId: conversation, contactId: captured },
      'endpoint',
    );
    expect(built).toEqual({
      id,
      type: 'satisfaction_survey.answered',
      createdAt: '2026-10-07T10:00:00.000Z',
      createdAtExact: '2026-10-07T10:00:00.000000Z',
      data: {
        survey: {
          id,
          conversationId: conversation,
          status: 'answered',
          skipReason: null,
          messageId: message,
          messageStatus: 'delivered',
          score: 1,
          answerMessageId: answer,
          answeredAt: '2026-10-07T10:00:00.000Z',
          assigneeId: null,
          resolvedById: member,
          createdAt: '2026-10-07T10:00:00.000Z',
        },
        conversation: { id: conversation },
        contact: { id: contact, phone: null, name: null },
        channel: { id: channel, phone: '+91 80 4567 8901' },
      },
    });
    expect(satisfactionSurveyAnsweredPayloadSchema.safeParse(built).success).toBe(true);
    expect(reads.unread()).toBe(0);
  });

  it('sends nothing for a survey that is not the company’s, reading nothing for an id that is not one', async () => {
    const gone = answering([[]]);
    await expect(buildWebhookPayload(gone.tx, event(id), 'endpoint')).rejects.toBeInstanceOf(
      WebhookEventGoneError,
    );
    expect(gone.unread()).toBe(0);
    for (const surveyId of ['survey', null, 7]) {
      const none = answering([]);
      await expect(
        buildWebhookPayload(none.tx, event(surveyId), 'endpoint'),
      ).rejects.toBeInstanceOf(WebhookEventGoneError);
    }
  });

  it('is described: the survey as the API reads it, once per survey, on the conversation’s number', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const described = doc.webhooks['satisfaction_survey.answered'].post.description;
    for (const words of [
      'A customer answered the satisfaction survey sent when a member resolved their conversation',
      'The survey is the survey as GET /satisfaction-surveys reads it when the event is delivered',
      'its score (3 for the first and best button, 1 for the third)',
      'a survey is answered once and this event is sent once for it; surveys skipped or never answered send nothing',
      'an endpoint that names numbers receives it for those numbers only; the team, member and tag filters of conversations’ events do not narrow it',
    ]) {
      expect(described).toContain(words);
    }
  });
});

describe('the event of an automation run step (ADR-326)', () => {
  const id = '0192f1d5-9f3c-7d2e-8b4f-6c7d8e9fa001';
  const tenantId = '0192f1d5-9f3c-7d2e-8b4f-6c7d8e9fa002';
  const [run, automation, conversation, contact, channel, message, key] = [
    '0192f1d5-9f3c-7d2e-8b4f-6c7d8e9fa003',
    '0192f1d5-9f3c-7d2e-8b4f-6c7d8e9fa004',
    '0192f1d5-9f3c-7d2e-8b4f-6c7d8e9fa005',
    '0192f1d5-9f3c-7d2e-8b4f-6c7d8e9fa006',
    '0192f1d5-9f3c-7d2e-8b4f-6c7d8e9fa007',
    '0192f1d5-9f3c-7d2e-8b4f-6c7d8e9fa008',
    '0192f1d5-9f3c-7d2e-8b4f-6c7d8e9fa009',
  ];
  const at = new Date('2026-10-08T09:00:00.000Z');
  const startedAt = new Date('2026-10-08T08:59:00.000Z');

  /** A transaction that answers its reads, in order, with `answers`; another read fails the test. */
  function answering(answers: unknown[][]) {
    const queue = [...answers];
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => {
        const rows = queue.shift();
        if (!rows) throw new Error('an unexpected read');
        return Promise.resolve(rows);
      },
    };
    return {
      tx: { select: () => chain } as unknown as Parameters<typeof buildWebhookPayload>[0],
      unread: () => queue.length,
    };
  }

  const event = (stepId: unknown) =>
    ({
      id,
      tenantId,
      type: 'automation.run_step',
      messageId: null,
      conversationId: conversation,
      contactId: contact,
      templateId: null,
      status: 'sent',
      detail: { stepId, runId: run, automationId: automation },
      contactChanges: null,
      tagsAdded: null,
      tagsRemoved: null,
      occurredAt: at,
      occurredAtExact: at.toISOString().replace('Z', '000Z'),
    }) as unknown as Parameters<typeof buildWebhookPayload>[1];

  const runRow = {
    id: run,
    automationId: automation,
    automationName: 'Welcome',
    triggerType: 'api',
    apiKeyId: key,
    startedAt,
    conversationId: conversation,
    contactId: contact,
    channelId: channel,
    channelPhone: '+91 80 4567 8901',
  };

  it('gives the step by its number, node type, outcome and message, never its detail or branch', () => {
    const data = automationRunStepPayloadSchema.shape.data.shape;
    expect(Object.keys(data)).toEqual(['run', 'step', 'conversation', 'contact', 'channel']);
    expect(Object.keys(data.step.shape)).toEqual(['number', 'nodeType', 'outcome', 'messageId']);
    expect(Object.keys(data.run.shape)).toEqual([
      'id',
      'automationId',
      'automationName',
      'trigger',
      'apiKeyId',
      'startedAt',
    ]);
    // Every kind of node and every outcome a run's log records.
    expect(data.step.shape.nodeType.unwrap().options).toEqual([...NODE_TYPES]);
    expect(data.step.shape.outcome.options).toEqual([...AUTOMATION_STEP_OUTCOMES]);
    const body = (step: Record<string, unknown>) => ({
      id,
      type: 'automation.run_step',
      createdAt: at.toISOString(),
      createdAtExact: at.toISOString().replace('Z', '000Z'),
      data: {
        run: {
          id: run,
          automationId: automation,
          automationName: 'Welcome',
          trigger: 'keyword',
          apiKeyId: null,
          startedAt: startedAt.toISOString(),
        },
        step: { number: 2, nodeType: 'ask_buttons', outcome: 'asked', messageId: message, ...step },
        conversation: { id: conversation },
        contact: { id: contact, phone: '+919845012345', name: 'Asha' },
        channel: { id: channel, phone: '+91 80 4567 8901' },
      },
    });
    expect(automationRunStepPayloadSchema.safeParse(body({})).success).toBe(true);
    // The run's start, outside a node and sending nothing.
    expect(
      automationRunStepPayloadSchema.safeParse(
        body({ number: 0, nodeType: null, outcome: 'started', messageId: null }),
      ).success,
    ).toBe(true);
    for (const step of [
      { number: -1 },
      { number: 1.5 },
      { nodeType: 'keyword' },
      { outcome: 'queued' },
      { messageId: 'w360_aaaaaaaaaaaa' },
    ]) {
      expect(
        automationRunStepPayloadSchema.safeParse(body(step)).success,
        JSON.stringify(step),
      ).toBe(false);
    }
    expect(
      automationRunStepPayloadSchema.safeParse({ ...body({}), type: 'automation.run_started' })
        .success,
    ).toBe(false);
  });

  it('builds the body from the step as the run’s log recorded it and the run as it is now', async () => {
    // What the log holds besides: the reads ask only for what the body gives.
    const step = {
      runId: run,
      seq: 3,
      nodeType: 'send_text',
      outcome: 'sent',
      messageId: message,
      detail: 'deal_owner_unavailable',
      branch: 'Yes, cancel my order',
    };
    const reads = answering([
      [step],
      [runRow],
      [{ phone: '+919845012345', name: 'Asha', erasedAt: null }],
    ]);
    const built = await buildWebhookPayload(reads.tx, event(id), 'endpoint');
    expect(built).toEqual({
      id,
      type: 'automation.run_step',
      createdAt: '2026-10-08T09:00:00.000Z',
      createdAtExact: '2026-10-08T09:00:00.000000Z',
      data: {
        run: {
          id: run,
          automationId: automation,
          automationName: 'Welcome',
          trigger: 'api',
          apiKeyId: key,
          startedAt: '2026-10-08T08:59:00.000Z',
        },
        step: { number: 3, nodeType: 'send_text', outcome: 'sent', messageId: message },
        conversation: { id: conversation },
        contact: { id: contact, phone: '+919845012345', name: 'Asha' },
        channel: { id: channel, phone: '+91 80 4567 8901' },
      },
    });
    expect(automationRunStepPayloadSchema.safeParse(built).success).toBe(true);
    expect(JSON.stringify(built)).not.toMatch(/deal_owner_unavailable|cancel my order/);
    expect(reads.unread()).toBe(0);
    // A step that sent no message, of a run whose automation is not found and contact was erased.
    const erased = answering([
      [{ ...step, seq: 5, nodeType: 'ask_text', outcome: 'answered', messageId: null }],
      [{ ...runRow, automationName: null, apiKeyId: null, triggerType: 'keyword' }],
      [{ phone: '+919845012345', name: 'Asha', erasedAt: at }],
    ]);
    const after = await buildWebhookPayload(erased.tx, event(id), 'endpoint');
    expect(after.data).toMatchObject({
      run: { automationName: null, apiKeyId: null, trigger: 'keyword' },
      step: { number: 5, nodeType: 'ask_text', outcome: 'answered', messageId: null },
      contact: { id: contact, phone: null, name: null },
    });
    expect(erased.unread()).toBe(0);
  });

  it('sends nothing for a step or a run that is gone, reading nothing for an id that is not one', async () => {
    const gone = answering([[]]);
    await expect(buildWebhookPayload(gone.tx, event(id), 'endpoint')).rejects.toBeInstanceOf(
      WebhookEventGoneError,
    );
    expect(gone.unread()).toBe(0);
    const runGone = answering([
      [{ runId: run, seq: 0, nodeType: null, outcome: 'started', messageId: null }],
      [],
    ]);
    await expect(buildWebhookPayload(runGone.tx, event(id), 'endpoint')).rejects.toBeInstanceOf(
      WebhookEventGoneError,
    );
    expect(runGone.unread()).toBe(0);
    for (const stepId of ['step', null, 7]) {
      const none = answering([]);
      await expect(buildWebhookPayload(none.tx, event(stepId), 'endpoint')).rejects.toBeInstanceOf(
        WebhookEventGoneError,
      );
    }
  });

  it('is described: a step’s number, kind, outcome and message, narrowed as the run events are', () => {
    expect(WEBHOOK_EVENT_INFO['automation.run_step'].label).toBe('Automation step');
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const described = doc.webhooks['automation.run_step'].post.description;
    for (const words of [
      'Members’ test runs are not sent.',
      'One event for each step a live run records in its log, its start included (step 0)',
      'never the branch it took (for an answered question, the title of the button the customer tapped, which is their answer',
      "order a run's steps by step.number",
      "receives only those runs' steps, as for automation.run_started",
      "a run's end statuses and end reasons do not narrow its steps",
    ]) {
      expect(described).toContain(words);
    }
    const schemas = doc.components.schemas as Record<
      string,
      { properties?: Record<string, { description?: string }> }
    >;
    // The run filters name the step event wherever they are described, and in their refusals.
    for (const schema of ['WebhookEndpoint', 'CreateWebhookEndpoint', 'UpdateWebhookEndpoint']) {
      for (const field of ['automationIds', 'runTriggers', 'runApiKeyIds']) {
        expect(schemas[schema]?.properties?.[field]?.description, `${schema}.${field}`).toContain(
          'automation.run_step',
        );
      }
    }
    for (const refusal of [
      WEBHOOK_AUTOMATIONS_NEED_THE_EVENTS,
      WEBHOOK_RUN_TRIGGERS_NEED_THE_EVENTS,
      WEBHOOK_RUN_API_KEYS_NEED_THE_EVENTS,
    ]) {
      expect(refusal).toMatch(
        /only for an endpoint that receives Automation started, Automation ended or Automation step\.$/,
      );
    }
  });
});

describe('the event of a cash on delivery answer (ADR-348)', () => {
  const id = '0192f2e6-a04d-7e3f-9c5a-7d8e9fa0b101';
  const tenantId = '0192f2e6-a04d-7e3f-9c5a-7d8e9fa0b102';
  const [order, store, conversation, contact, channel, message, tap, captured] = [
    '0192f2e6-a04d-7e3f-9c5a-7d8e9fa0b103',
    '0192f2e6-a04d-7e3f-9c5a-7d8e9fa0b104',
    '0192f2e6-a04d-7e3f-9c5a-7d8e9fa0b105',
    '0192f2e6-a04d-7e3f-9c5a-7d8e9fa0b106',
    '0192f2e6-a04d-7e3f-9c5a-7d8e9fa0b107',
    '0192f2e6-a04d-7e3f-9c5a-7d8e9fa0b108',
    '0192f2e6-a04d-7e3f-9c5a-7d8e9fa0b109',
    '0192f2e6-a04d-7e3f-9c5a-7d8e9fa0b10a',
  ];
  const at = new Date('2026-10-10T05:00:00.123Z');
  const placedAt = new Date('2026-10-10T04:00:00.000Z');

  /** A transaction that answers its reads, in order, with `answers`; another read fails the test. */
  function answering(answers: unknown[][]) {
    const queue = [...answers];
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => {
        const rows = queue.shift();
        if (!rows) throw new Error('an unexpected read');
        return Promise.resolve(rows);
      },
    };
    return {
      tx: { select: () => chain } as unknown as Parameters<typeof buildWebhookPayload>[0],
      unread: () => queue.length,
    };
  }

  const event = (detail: Record<string, unknown>, status = 'cancelled') =>
    ({
      id,
      tenantId,
      type: 'store_order.cod_answered',
      messageId: null,
      conversationId: conversation,
      contactId: captured,
      templateId: null,
      status,
      detail,
      contactChanges: null,
      tagsAdded: null,
      tagsRemoved: null,
      occurredAt: at,
      occurredAtExact: '2026-10-10T05:00:00.123456Z',
    }) as unknown as Parameters<typeof buildWebhookPayload>[1];
  // As the trigger captures it (0266): PostgreSQL writes the tap's time with its offset.
  const capturedDetail = {
    storeMessageId: id,
    previousAnswer: 'confirmed',
    answeredAt: '2026-10-10T10:29:58+05:30',
    answerMessageId: tap,
  };
  const row = {
    messageId: message,
    order: {
      id: order,
      externalId: '5640149885113',
      name: '#1042',
      status: 'open',
      financialStatus: 'pending',
      fulfillmentStatus: 'unfulfilled',
      test: false,
      currency: 'INR',
      totalMinor: 149_900,
      placedAt,
      cancelledAt: null,
      deletedAt: null,
    },
    store: {
      id: store,
      platform: 'shopify',
      name: 'Asha Textiles',
      url: 'https://asha-textiles.myshopify.com',
    },
    conversationId: conversation,
    contactId: contact,
    channelId: channel,
    channelPhone: '+91 80 4567 8901',
  };

  it('is one event on the confirmation’s number, labelled as Settings lists it', () => {
    expect(WEBHOOK_EVENT_INFO['store_order.cod_answered']).toEqual({
      label: 'Cash on delivery answered',
      description:
        'A customer confirmed or cancelled a cash on delivery order from a connected store by tapping a button of its confirmation message, or changed their answer.',
    });
    expect(webhookTakesChannelEvents(['store_order.cod_answered'])).toBe(true);
    for (const takes of [
      webhookTakesTaskEvents,
      webhookTakesPipelineEvents,
      webhookTakesTeamEvents,
      webhookTakesCampaignEvents,
      webhookTakesTemplateEvents,
      webhookTakesAutomationRuns,
    ]) {
      expect(takes(['store_order.cod_answered']), takes.name).toBe(false);
    }
  });

  it('gives the answer, the store’s order and its store, with the conversation, contact and number', () => {
    const data = storeOrderCodAnsweredPayloadSchema.shape.data.shape;
    expect(Object.keys(data)).toEqual([
      'confirmation',
      'storeOrder',
      'store',
      'conversation',
      'contact',
      'channel',
    ]);
    // Never the customer's details from the store: the contact stands for them.
    expect(Object.keys(data.storeOrder.shape)).toEqual([
      'id',
      'externalId',
      'name',
      'status',
      'financialStatus',
      'fulfillmentStatus',
      'test',
      'currency',
      'totalMinor',
      'placedAt',
      'cancelledAt',
      'deletedAt',
    ]);
    const body = (answer: unknown, previousAnswer: unknown, totalMinor: unknown = 149_900) => ({
      id,
      type: 'store_order.cod_answered',
      createdAt: at.toISOString(),
      createdAtExact: '2026-10-10T05:00:00.123456Z',
      data: {
        confirmation: {
          answer,
          previousAnswer,
          answeredAt: at.toISOString(),
          messageId: message,
          answerMessageId: tap,
        },
        storeOrder: { ...row.order, totalMinor, placedAt: placedAt.toISOString() },
        store: row.store,
        conversation: { id: conversation },
        contact: { id: contact, phone: '+919845012345', name: 'Asha' },
        channel: { id: channel, phone: '+91 80 4567 8901' },
      },
    });
    const parses = (value: unknown) => storeOrderCodAnsweredPayloadSchema.safeParse(value).success;
    expect(parses(body('confirmed', null))).toBe(true);
    expect(parses(body('cancelled', 'confirmed'))).toBe(true);
    expect(parses(body('declined', null))).toBe(false);
    expect(parses(body('confirmed', 'declined'))).toBe(false);
    expect(parses(body('confirmed', null, 1499.5))).toBe(false);
  });

  it('builds the body from the answer as captured and the order and store as they are now', async () => {
    const reads = answering([[row], [{ phone: '+919845012345', name: 'Asha', erasedAt: null }]]);
    // The contact captured with the event, since merged away: the conversation's contact now is sent.
    const built = await buildWebhookPayload(reads.tx, event(capturedDetail), 'endpoint');
    expect(built).toEqual({
      id,
      type: 'store_order.cod_answered',
      createdAt: '2026-10-10T05:00:00.123Z',
      createdAtExact: '2026-10-10T05:00:00.123456Z',
      data: {
        confirmation: {
          answer: 'cancelled',
          previousAnswer: 'confirmed',
          answeredAt: '2026-10-10T04:59:58.000Z',
          messageId: message,
          answerMessageId: tap,
        },
        storeOrder: {
          id: order,
          externalId: '5640149885113',
          name: '#1042',
          status: 'open',
          financialStatus: 'pending',
          fulfillmentStatus: 'unfulfilled',
          test: false,
          currency: 'INR',
          totalMinor: 149_900,
          placedAt: '2026-10-10T04:00:00.000Z',
          cancelledAt: null,
          deletedAt: null,
        },
        store: {
          id: store,
          platform: 'shopify',
          name: 'Asha Textiles',
          url: 'https://asha-textiles.myshopify.com',
        },
        conversation: { id: conversation },
        contact: { id: contact, phone: '+919845012345', name: 'Asha' },
        channel: { id: channel, phone: '+91 80 4567 8901' },
      },
    });
    expect(storeOrderCodAnsweredPayloadSchema.safeParse(built).success).toBe(true);
    expect(reads.unread()).toBe(0);
  });

  it('gives a first answer without one before it, an order the store cancelled or deleted with its times, and the contact as erasure left it', async () => {
    const cancelledAt = new Date('2026-10-10T06:00:00.000Z');
    const deletedAt = new Date('2026-10-10T07:00:00.000Z');
    const reads = answering([
      [
        {
          ...row,
          order: { ...row.order, status: 'cancelled', cancelledAt, deletedAt },
          channelPhone: null,
        },
      ],
      [{ phone: '+919845012345', name: 'Asha', erasedAt: at }],
    ]);
    const built = await buildWebhookPayload(
      reads.tx,
      event({ ...capturedDetail, previousAnswer: null }, 'confirmed'),
      'endpoint',
    );
    expect(built.data).toMatchObject({
      confirmation: { answer: 'confirmed', previousAnswer: null },
      storeOrder: {
        status: 'cancelled',
        cancelledAt: '2026-10-10T06:00:00.000Z',
        deletedAt: '2026-10-10T07:00:00.000Z',
      },
      contact: { id: contact, phone: null, name: null },
      channel: { id: channel, phone: null },
    });
    expect(storeOrderCodAnsweredPayloadSchema.safeParse(built).success).toBe(true);
    expect(reads.unread()).toBe(0);
  });

  it('sends nothing for a confirmation that is gone or not the company’s, reading nothing for an id that is not one', async () => {
    const gone = answering([[]]);
    await expect(
      buildWebhookPayload(gone.tx, event(capturedDetail), 'endpoint'),
    ).rejects.toBeInstanceOf(WebhookEventGoneError);
    expect(gone.unread()).toBe(0);
    for (const storeMessageId of ['confirmation', null, 7]) {
      const none = answering([]);
      await expect(
        buildWebhookPayload(none.tx, event({ ...capturedDetail, storeMessageId }), 'endpoint'),
      ).rejects.toBeInstanceOf(WebhookEventGoneError);
    }
  });

  it('describes no event captured without its tap, reading nothing', async () => {
    for (const missing of ['answeredAt', 'answerMessageId']) {
      const none = answering([]);
      const detail = Object.fromEntries(
        Object.entries(capturedDetail).filter(([key]) => key !== missing),
      );
      const built = buildWebhookPayload(none.tx, event(detail), 'endpoint');
      await expect(built, missing).rejects.toThrow(
        'The cash on delivery answer was captured without its tap',
      );
      await expect(built, missing).rejects.not.toBeInstanceOf(WebhookEventGoneError);
    }
  });

  it('is described: the answer as captured, the order as it is now, and what sends nothing', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const described = doc.webhooks['store_order.cod_answered'].post.description;
    for (const words of [
      'A customer confirmed or cancelled a cash on delivery order from a connected store',
      'HyFib changes nothing in the store: this event is how an order system learns the answer',
      'confirmation.answer and confirmation.previousAnswer are the change',
      'the store’s own order id (storeOrder.externalId) to find it there',
      'Never the customer’s details from the store',
      'a tap that repeats the answer, an older tap arriving late and a tap outside the confirmation’s conversation send nothing',
      'Store orders themselves are not sent',
      'an endpoint that names numbers receives it for those numbers only',
      'fails as event_gone',
    ]) {
      expect(described).toContain(words);
    }
    expect(doc.components.schemas).toHaveProperty('WebhookStoreOrderCodAnswered');
  });
});

describe('cash on delivery answer and store filters (ADR-349)', () => {
  const [shop, outlet, gone] = [
    '0192f3f7-b15e-7f40-8d6b-8e9fa0b1c201',
    '0192f3f7-b15e-7f40-8d6b-8e9fa0b1c202',
    '0192f3f7-b15e-7f40-8d6b-8e9fa0b1c203',
  ];

  it('take one or both answers, once each, in the confirmation’s order; null takes every answer', () => {
    expect(webhookCodAnswersSchema.parse(['cancelled', 'confirmed'])).toEqual([
      'confirmed',
      'cancelled',
    ]);
    expect(webhookCodAnswersSchema.parse(['cancelled', 'cancelled'])).toEqual(['cancelled']);
    expect(webhookCodAnswersSchema.parse(null)).toBeNull();
    // The answers a store message records, as confirmation.answer names them.
    expect(WEBHOOK_COD_ANSWERS).toEqual([...STORE_MESSAGE_ANSWERS]);
    for (const refused of [
      [],
      ['declined'],
      ['Confirmed'],
      'confirmed',
      [null],
      Array(3).fill('confirmed'),
    ]) {
      expect(webhookCodAnswersSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookCodAnswersSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one answer, or take every answer.',
    );
    expect(webhookCodAnswersSchema.safeParse(['declined']).error?.issues[0]?.message).toBe(
      'Choose answers from the list.',
    );
    expect(
      webhookCodAnswersSchema.safeParse(Array(3).fill('confirmed')).error?.issues[0]?.message,
    ).toBe('Give each answer once.');
    // Named as an order's page names them, in the list's order.
    expect(Object.keys(WEBHOOK_COD_ANSWER_LABELS)).toEqual([...WEBHOOK_COD_ANSWERS]);
    expect(WEBHOOK_COD_ANSWER_LABELS).toEqual({ confirmed: 'Confirmed', cancelled: 'Cancelled' });
  });

  it('take 1 to 20 of the company’s stores, once each, whatever their case; null takes every store', () => {
    expect(WEBHOOK_LIMITS.stores).toBe(20);
    expect(webhookStoreIdsSchema.parse([shop.toUpperCase(), shop, outlet])).toEqual([shop, outlet]);
    expect(webhookStoreIdsSchema.parse(null)).toBeNull();
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `0192f3f7-b15e-7f40-8d6b-${String(i).padStart(12, '0')}`);
    expect(webhookStoreIdsSchema.parse(ids(20))).toHaveLength(20);
    for (const refused of [[], ['shop'], [null], shop, ids(21)]) {
      expect(webhookStoreIdsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(false);
    }
    expect(webhookStoreIdsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one store, or take every store.',
    );
    expect(webhookStoreIdsSchema.safeParse(['shop']).error?.issues[0]?.message).toBe(
      'Choose stores from the list.',
    );
    expect(webhookStoreIdsSchema.safeParse(ids(21)).error?.issues[0]?.message).toBe(
      'Choose at most 20 stores.',
    );
  });

  it('are kept only while the endpoint takes store_order.cod_answered: given, kept, or cleared', () => {
    const both = ['store_order.cod_answered', 'order.received'] as const;
    expect(webhookCodAnswersFor([...both], ['cancelled'], null)).toEqual(['cancelled']);
    expect(webhookCodAnswersFor([...both], undefined, ['confirmed'])).toEqual(['confirmed']);
    expect(webhookCodAnswersFor([...both], null, ['confirmed'])).toBeNull();
    expect(webhookCodAnswersFor([...both], undefined, null)).toBeNull();
    expect(webhookStoreIdsFor([...both], [shop], null)).toEqual([shop]);
    expect(webhookStoreIdsFor([...both], undefined, [outlet])).toEqual([outlet]);
    expect(webhookStoreIdsFor([...both], null, [outlet])).toBeNull();
    expect(webhookStoreIdsFor([...both], undefined, null)).toBeNull();
    // WhatsApp orders' events have no answer or store to choose.
    for (const events of [['order.received', 'order.status_changed'] as const]) {
      expect(webhookCodAnswersFor([...events], ['cancelled'], ['confirmed'])).toBeNull();
      expect(webhookStoreIdsFor([...events], [shop], [outlet])).toBeNull();
    }
    const label = WEBHOOK_EVENT_INFO['store_order.cod_answered'].label;
    expect(WEBHOOK_COD_ANSWERS_NEED_THE_EVENT).toBe(
      `Choose answers only for an endpoint that receives ${label}.`,
    );
    expect(WEBHOOK_STORES_NEED_THE_EVENT).toBe(
      `Choose stores only for an endpoint that receives ${label}, ${WEBHOOK_EVENT_INFO['store_order.message_skipped'].label}, ${WEBHOOK_EVENT_INFO['store_order.message_sent'].label}, ${WEBHOOK_EVENT_INFO['store_checkout.reminder_skipped'].label} or ${WEBHOOK_EVENT_INFO['store_checkout.reminder_sent'].label}.`,
    );
  });

  it('name a store by its name, else its address, and one removed since it was chosen as such', () => {
    const url = 'https://asha-textiles.myshopify.com';
    expect(webhookStoreLabel({ name: ' Asha Textiles ', storeUrl: url })).toBe('Asha Textiles');
    expect(webhookStoreLabel({ name: null, storeUrl: url })).toBe(url);
    expect(webhookStoreLabel({ name: '   ', storeUrl: url })).toBe(url);
    expect(webhookStoreText({ id: shop, label: 'Asha Textiles' })).toBe('Asha Textiles');
    expect(webhookStoreText({ id: gone, label: null })).toBe('A removed store');
  });

  /** A transaction that answers the store read with the stores given, counting its reads. */
  function storesTx(found: string[]) {
    let reads = 0;
    const tx = {
      select: () => ({
        from: () => ({
          where: () => {
            reads += 1;
            return Promise.resolve(found.map((id) => ({ id })));
          },
        }),
      }),
    } as unknown as Tx;
    return { tx, reads: () => reads };
  }

  it('check only the stores a list adds, which must be the company’s; those it held may be gone', async () => {
    const ok = storesTx([shop, outlet]);
    await assertWebhookStores(ok.tx, 'tenant', [shop, outlet]);
    expect(ok.reads()).toBe(1);
    // Held stores are not read again, so a store removed since stays on the list.
    const held = storesTx([]);
    await assertWebhookStores(held.tx, 'tenant', [gone, shop], [gone, shop]);
    await assertWebhookStores(held.tx, 'tenant', null, [gone]);
    expect(held.reads()).toBe(0);
    // A store that is not the company's (or not one) is refused at its place in the list.
    const refused = await assertWebhookStores(storesTx([shop]).tx, 'tenant', [shop, gone], [shop])
      .then(() => null)
      .catch((error: unknown) => error);
    expect(isAppError(refused) && refused.code).toBe('validation_failed');
    expect(isAppError(refused) && refused.issues).toEqual([
      { path: 'storeIds.1', message: WEBHOOK_STORES_NOT_FOUND },
    ]);
    expect(WEBHOOK_STORES_NOT_FOUND).toBe('Choose stores of this company.');
  });
});

describe('the event of a skipped store order message (ADR-351)', () => {
  const id = '0192f4a8-c26f-7a51-9e7c-9fa0b1c2d301';
  const tenantId = '0192f4a8-c26f-7a51-9e7c-9fa0b1c2d302';
  const [storeMessage, order, store] = [
    '0192f4a8-c26f-7a51-9e7c-9fa0b1c2d303',
    '0192f4a8-c26f-7a51-9e7c-9fa0b1c2d304',
    '0192f4a8-c26f-7a51-9e7c-9fa0b1c2d305',
  ];
  const at = new Date('2026-10-10T08:00:00.123Z');
  const placedAt = new Date('2026-10-10T07:00:00.000Z');

  /** A transaction that answers its reads, in order, with `answers`; another read fails the test. */
  function answering(answers: unknown[][]) {
    const queue = [...answers];
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => {
        const rows = queue.shift();
        if (!rows) throw new Error('an unexpected read');
        return Promise.resolve(rows);
      },
    };
    return {
      tx: { select: () => chain } as unknown as Parameters<typeof buildWebhookPayload>[0],
      unread: () => queue.length,
    };
  }

  const event = (detail: Record<string, unknown>, status: string | null = 'cod_confirmation') =>
    ({
      id,
      tenantId,
      type: 'store_order.message_skipped',
      messageId: null,
      conversationId: null,
      contactId: null,
      templateId: null,
      status,
      detail,
      contactChanges: null,
      tagsAdded: null,
      tagsRemoved: null,
      occurredAt: at,
      occurredAtExact: '2026-10-10T08:00:00.123456Z',
    }) as unknown as Parameters<typeof buildWebhookPayload>[1];
  // As the trigger captures it (0270): PostgreSQL writes the event's time with its offset.
  const capturedDetail = {
    storeMessageId: storeMessage,
    skipReason: 'no_phone',
    occurredAt: '2026-10-10T12:30:00.25+05:30',
  };
  const row = {
    order: {
      id: order,
      externalId: '5640149885114',
      name: '#1043',
      status: 'open',
      financialStatus: 'pending',
      fulfillmentStatus: 'unfulfilled',
      test: false,
      currency: 'INR',
      totalMinor: 89_900,
      placedAt,
      cancelledAt: null,
      deletedAt: null,
    },
    store: {
      id: store,
      platform: 'woocommerce',
      name: 'Asha Textiles',
      url: 'https://asha-textiles.example',
    },
  };

  it('is one event of no number, labelled as Settings lists it, which no answer or number narrows', () => {
    expect(WEBHOOK_EVENT_INFO['store_order.message_skipped']).toEqual({
      label: 'Order message skipped',
      description:
        'A connected store’s message about an order (placed, cash on delivery confirmation, shipped, delivered or cancelled) was not sent: a test order, an event HyFib saw too late, an order placed message the cash on delivery confirmation replaced, or a check that failed when it was due, such as a customer who opted out or an order without a phone number.',
    });
    expect(WEBHOOK_EVENT_KEYS.indexOf('store_order.message_skipped')).toBe(
      WEBHOOK_EVENT_KEYS.indexOf('store_order.cod_answered') + 1,
    );
    for (const takes of [
      webhookTakesChannelEvents,
      webhookTakesTaskEvents,
      webhookTakesPipelineEvents,
      webhookTakesTeamEvents,
      webhookTakesCampaignEvents,
      webhookTakesTemplateEvents,
      webhookTakesAutomationRuns,
    ]) {
      expect(takes(['store_order.message_skipped']), takes.name).toBe(false);
    }
    expect(webhookCodAnswersFor(['store_order.message_skipped'], ['cancelled'], null)).toBeNull();
  });

  it('gives the message’s event, reason and time, the store’s order and its store, and nobody', () => {
    const data = storeOrderMessageSkippedPayloadSchema.shape.data.shape;
    // Never the customer's details from the store, and no contact or number: nothing was sent.
    expect(Object.keys(data)).toEqual(['orderMessage', 'storeOrder', 'store']);
    expect(Object.keys(data.orderMessage.shape)).toEqual(['event', 'skipReason', 'occurredAt']);
    expect(data.orderMessage.shape.event.options).toEqual([
      'order_placed',
      'cod_confirmation',
      'order_shipped',
      'order_delivered',
      'order_cancelled',
    ]);
    expect(data.orderMessage.shape.skipReason.options).toEqual([
      ...WEBHOOK_ORDER_MESSAGE_SKIP_REASONS,
    ]);
    expect(data.storeOrder).toBe(storeOrderCodAnsweredPayloadSchema.shape.data.shape.storeOrder);
    expect(data.store).toBe(storeOrderCodAnsweredPayloadSchema.shape.data.shape.store);
    const body = (orderMessage: Record<string, unknown>) => ({
      id,
      type: 'store_order.message_skipped',
      createdAt: at.toISOString(),
      createdAtExact: '2026-10-10T08:00:00.123456Z',
      data: {
        orderMessage: {
          event: 'cod_confirmation',
          skipReason: 'no_phone',
          occurredAt: placedAt.toISOString(),
          ...orderMessage,
        },
        storeOrder: { ...row.order, placedAt: placedAt.toISOString() },
        store: row.store,
      },
    });
    const parses = (value: unknown) =>
      storeOrderMessageSkippedPayloadSchema.safeParse(value).success;
    expect(parses(body({}))).toBe(true);
    expect(parses(body({ event: 'order_shipped', skipReason: 'test_order' }))).toBe(true);
    expect(parses(body({ event: 'cart_reminder' }))).toBe(false);
    expect(parses(body({ skipReason: 'not_a_reason' }))).toBe(false);
    expect(parses(body({ occurredAt: 'yesterday' }))).toBe(false);
  });

  it('builds the body from the message as captured and the order and store as they are now', async () => {
    const reads = answering([[row]]);
    const built = await buildWebhookPayload(reads.tx, event(capturedDetail), 'endpoint');
    expect(built).toEqual({
      id,
      type: 'store_order.message_skipped',
      createdAt: '2026-10-10T08:00:00.123Z',
      createdAtExact: '2026-10-10T08:00:00.123456Z',
      data: {
        orderMessage: {
          event: 'cod_confirmation',
          skipReason: 'no_phone',
          occurredAt: '2026-10-10T07:00:00.250Z',
        },
        storeOrder: {
          id: order,
          externalId: '5640149885114',
          name: '#1043',
          status: 'open',
          financialStatus: 'pending',
          fulfillmentStatus: 'unfulfilled',
          test: false,
          currency: 'INR',
          totalMinor: 89_900,
          placedAt: '2026-10-10T07:00:00.000Z',
          cancelledAt: null,
          deletedAt: null,
        },
        store: {
          id: store,
          platform: 'woocommerce',
          name: 'Asha Textiles',
          url: 'https://asha-textiles.example',
        },
      },
    });
    expect(storeOrderMessageSkippedPayloadSchema.safeParse(built).success).toBe(true);
    expect(reads.unread()).toBe(0);
  });

  it('gives an order the store cancelled and deleted since with their times', async () => {
    const cancelledAt = new Date('2026-10-10T09:00:00.000Z');
    const deletedAt = new Date('2026-10-10T10:00:00.000Z');
    const reads = answering([
      [{ ...row, order: { ...row.order, status: 'cancelled', cancelledAt, deletedAt } }],
    ]);
    const built = await buildWebhookPayload(
      reads.tx,
      event({ ...capturedDetail, skipReason: 'test_order' }, 'order_placed'),
      'endpoint',
    );
    expect(built.data).toMatchObject({
      orderMessage: { event: 'order_placed', skipReason: 'test_order' },
      storeOrder: {
        status: 'cancelled',
        cancelledAt: '2026-10-10T09:00:00.000Z',
        deletedAt: '2026-10-10T10:00:00.000Z',
      },
    });
    expect(storeOrderMessageSkippedPayloadSchema.safeParse(built).success).toBe(true);
    expect(reads.unread()).toBe(0);
  });

  it('sends nothing for a message that is gone, a cart reminder or another company’s, reading nothing for an id that is not one', async () => {
    const gone = answering([[]]);
    await expect(
      buildWebhookPayload(gone.tx, event(capturedDetail), 'endpoint'),
    ).rejects.toBeInstanceOf(WebhookEventGoneError);
    expect(gone.unread()).toBe(0);
    for (const storeMessageId of ['message', null, 7]) {
      const none = answering([]);
      await expect(
        buildWebhookPayload(none.tx, event({ ...capturedDetail, storeMessageId }), 'endpoint'),
      ).rejects.toBeInstanceOf(WebhookEventGoneError);
    }
  });

  it('describes no event captured without its event, reason or time, reading nothing', async () => {
    const cases: [Record<string, unknown>, string | null][] = [
      [capturedDetail, null],
      [{ storeMessageId: storeMessage, occurredAt: capturedDetail.occurredAt }, 'order_placed'],
      [{ storeMessageId: storeMessage, skipReason: 'no_phone' }, 'order_placed'],
    ];
    for (const [detail, status] of cases) {
      const none = answering([]);
      const built = buildWebhookPayload(none.tx, event(detail, status), 'endpoint');
      await expect(built).rejects.toThrow(
        'The skipped order message was captured without its event, reason or time',
      );
      await expect(built).rejects.not.toBeInstanceOf(WebhookEventGoneError);
    }
  });

  it('is described: the message as captured, the order as it is now, and what sends nothing', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const described = doc.webhooks['store_order.message_skipped'].post.description;
    for (const words of [
      'A connected store’s message about an order',
      'this event is how an order system learns that one did not, and why',
      'orderMessage gives the event the message was for, the reason and when the order’s event happened, as captured',
      'the store’s own order id (storeOrder.externalId) to find it there',
      'Never the customer’s details from the store, and no contact or number',
      'an endpoint that names numbers receives it whichever numbers it names',
      'more than 48 hours after it happened',
      'a message sent, or waiting for the store’s sending hours, sends nothing',
      'cart reminders, which are about checkouts, send store_checkout.reminder_skipped instead',
      'A skipReason of cash_on_delivery marks an order placed message that the cash on delivery confirmation replaced: the customer was asked to confirm the order instead',
      'fails as event_gone',
    ]) {
      expect(described).toContain(words);
    }
    expect(doc.components.schemas).toHaveProperty('WebhookStoreOrderMessageSkipped');
  });
});

describe('store and order message filters for skipped order messages (ADR-352)', () => {
  const [shop, outlet] = [
    '0192f4b9-d370-7b62-8f8d-a0b1c2d3e401',
    '0192f4b9-d370-7b62-8f8d-a0b1c2d3e402',
  ];

  it('take one to five order messages, once each, in the store’s order; null takes every message', () => {
    expect(
      webhookOrderMessageEventsSchema.parse([
        'order_cancelled',
        'cod_confirmation',
        'order_cancelled',
      ]),
    ).toEqual(['cod_confirmation', 'order_cancelled']);
    expect(webhookOrderMessageEventsSchema.parse(null)).toBeNull();
    // The messages about an order, as orderMessage.event names them; cart reminders send events of
    // their own (ADR-355).
    expect(WEBHOOK_ORDER_MESSAGE_EVENTS).toEqual([...ORDER_MESSAGE_EVENTS]);
    expect(webhookOrderMessageEventsSchema.parse([...WEBHOOK_ORDER_MESSAGE_EVENTS])).toEqual([
      ...WEBHOOK_ORDER_MESSAGE_EVENTS,
    ]);
    for (const refused of [
      [],
      ['cart_reminder'],
      ['Order_placed'],
      'order_placed',
      [null],
      Array(6).fill('order_placed'),
    ]) {
      expect(
        webhookOrderMessageEventsSchema.safeParse(refused).success,
        JSON.stringify(refused),
      ).toBe(false);
    }
    expect(webhookOrderMessageEventsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one order message, or take every order message.',
    );
    expect(
      webhookOrderMessageEventsSchema.safeParse(['cart_reminder']).error?.issues[0]?.message,
    ).toBe('Choose order messages from the list.');
    expect(
      webhookOrderMessageEventsSchema.safeParse(Array(6).fill('order_placed')).error?.issues[0]
        ?.message,
    ).toBe('Give each order message once.');
    // Named as a store's order messages name them, in the list's order.
    expect(Object.keys(WEBHOOK_ORDER_MESSAGE_EVENT_LABELS)).toEqual([
      ...WEBHOOK_ORDER_MESSAGE_EVENTS,
    ]);
    for (const event of WEBHOOK_ORDER_MESSAGE_EVENTS) {
      expect(WEBHOOK_ORDER_MESSAGE_EVENT_LABELS[event], event).toBe(
        STORE_MESSAGE_EVENT_INFO[event].label,
      );
    }
  });

  it('are kept only while the endpoint takes skipped order messages; stores while it takes either store event', () => {
    const skipped = ['store_order.message_skipped', 'order.received'] as const;
    expect(webhookOrderMessageEventsFor([...skipped], ['order_placed'], null)).toEqual([
      'order_placed',
    ]);
    expect(webhookOrderMessageEventsFor([...skipped], undefined, ['order_shipped'])).toEqual([
      'order_shipped',
    ]);
    expect(webhookOrderMessageEventsFor([...skipped], null, ['order_shipped'])).toBeNull();
    expect(webhookOrderMessageEventsFor([...skipped], undefined, null)).toBeNull();
    // Cash on delivery answers have no order message to choose.
    expect(
      webhookOrderMessageEventsFor(
        ['store_order.cod_answered'],
        ['order_placed'],
        ['order_shipped'],
      ),
    ).toBeNull();
    // The stores narrow both events of a store's orders, each alone or together.
    for (const events of [
      ['store_order.message_skipped'],
      ['store_order.cod_answered'],
      ['store_order.cod_answered', 'store_order.message_skipped'],
    ] as const) {
      expect(webhookTakesStoreEvents([...events]), events.join()).toBe(true);
      expect(webhookStoreIdsFor([...events], [shop], null), events.join()).toEqual([shop]);
      expect(webhookStoreIdsFor([...events], undefined, [outlet]), events.join()).toEqual([outlet]);
    }
    expect(WEBHOOK_STORE_EVENTS).toEqual([
      'store_order.cod_answered',
      'store_order.message_skipped',
      'store_order.message_sent',
      'store_checkout.reminder_skipped',
      'store_checkout.reminder_sent',
    ]);
    expect(webhookTakesStoreEvents(['order.received', 'order.status_changed'])).toBe(false);
    expect(webhookStoreIdsFor(['order.received'], [shop], [outlet])).toBeNull();
    expect(WEBHOOK_ORDER_MESSAGES_NEED_THE_EVENT).toBe(
      `Choose order messages only for an endpoint that receives ${WEBHOOK_EVENT_INFO['store_order.message_skipped'].label} or ${WEBHOOK_EVENT_INFO['store_order.message_sent'].label}.`,
    );
  });
});

describe('the event of a sent store order message (ADR-353)', () => {
  const id = '0192f4ca-e481-7c73-9a9e-b1c2d3e4f601';
  const tenantId = '0192f4ca-e481-7c73-9a9e-b1c2d3e4f602';
  const [storeMessage, order, store, conversation, contact, channel, message, run] = [
    '0192f4ca-e481-7c73-9a9e-b1c2d3e4f603',
    '0192f4ca-e481-7c73-9a9e-b1c2d3e4f604',
    '0192f4ca-e481-7c73-9a9e-b1c2d3e4f605',
    '0192f4ca-e481-7c73-9a9e-b1c2d3e4f606',
    '0192f4ca-e481-7c73-9a9e-b1c2d3e4f607',
    '0192f4ca-e481-7c73-9a9e-b1c2d3e4f608',
    '0192f4ca-e481-7c73-9a9e-b1c2d3e4f609',
    '0192f4ca-e481-7c73-9a9e-b1c2d3e4f60a',
  ];
  const at = new Date('2026-10-10T11:00:00.123Z');
  const placedAt = new Date('2026-10-10T10:00:00.000Z');

  /** A transaction that answers its reads, in order, with `answers`; another read fails the test. */
  function answering(answers: unknown[][]) {
    const queue = [...answers];
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => {
        const rows = queue.shift();
        if (!rows) throw new Error('an unexpected read');
        return Promise.resolve(rows);
      },
    };
    return {
      tx: { select: () => chain } as unknown as Parameters<typeof buildWebhookPayload>[0],
      unread: () => queue.length,
    };
  }

  const event = (
    detail: Record<string, unknown>,
    opts: {
      status?: string | null;
      messageId?: string | null;
      conversationId?: string | null;
    } = {},
  ) =>
    ({
      id,
      tenantId,
      type: 'store_order.message_sent',
      messageId: opts.messageId === undefined ? message : opts.messageId,
      conversationId: opts.conversationId === undefined ? conversation : opts.conversationId,
      contactId: contact,
      templateId: null,
      status: opts.status === undefined ? 'order_shipped' : opts.status,
      detail,
      contactChanges: null,
      tagsAdded: null,
      tagsRemoved: null,
      occurredAt: at,
      occurredAtExact: '2026-10-10T11:00:00.123456Z',
    }) as unknown as Parameters<typeof buildWebhookPayload>[1];
  // As the trigger captures it (0273) for a template: no run, the time with its offset.
  const capturedDetail = {
    storeMessageId: storeMessage,
    automationRunId: null,
    occurredAt: '2026-10-10T15:30:00+05:30',
  };
  const row = {
    order: {
      id: order,
      externalId: '5640149885115',
      name: '#1044',
      status: 'open',
      financialStatus: 'paid',
      fulfillmentStatus: 'fulfilled',
      test: false,
      currency: 'INR',
      totalMinor: 249_900,
      placedAt,
      cancelledAt: null,
      deletedAt: null,
    },
    store: {
      id: store,
      platform: 'shopify',
      name: 'Asha Textiles',
      url: 'https://asha-textiles.myshopify.com',
    },
    contactId: contact,
    channelId: channel,
    channelPhone: '+91 80 4567 8901',
  };
  const person = { phone: '+919845012345', name: 'Asha', erasedAt: null };

  it('is one event of a number, a store and an order message, labelled as Settings lists it', () => {
    expect(WEBHOOK_EVENT_INFO['store_order.message_sent']).toEqual({
      label: 'Order message sent',
      description:
        'A connected store’s message about an order (placed, cash on delivery confirmation, shipped, delivered or cancelled) went out: its template message was queued for WhatsApp, whose statuses follow as message status events, or the automation its rule chose started.',
    });
    expect(WEBHOOK_EVENT_KEYS.indexOf('store_order.message_sent')).toBe(
      WEBHOOK_EVENT_KEYS.indexOf('store_order.message_skipped') + 1,
    );
    const sent = ['store_order.message_sent'] as const;
    expect(webhookTakesChannelEvents([...sent])).toBe(true);
    expect(webhookTakesStoreEvents([...sent])).toBe(true);
    expect(webhookTakesOrderMessages([...sent])).toBe(true);
    expect(WEBHOOK_ORDER_MESSAGE_TYPES).toEqual([
      'store_order.message_skipped',
      'store_order.message_sent',
    ]);
    expect(webhookOrderMessageEventsFor([...sent], ['order_placed'], null)).toEqual([
      'order_placed',
    ]);
    expect(webhookStoreIdsFor([...sent], [store], null)).toEqual([store]);
    expect(webhookCodAnswersFor([...sent], ['cancelled'], null)).toBeNull();
    for (const takes of [
      webhookTakesTaskEvents,
      webhookTakesPipelineEvents,
      webhookTakesTeamEvents,
      webhookTakesCampaignEvents,
      webhookTakesTemplateEvents,
      webhookTakesAutomationRuns,
    ]) {
      expect(takes([...sent]), takes.name).toBe(false);
    }
  });

  it('gives the message’s event, time and message or run, the store’s order, its store, the conversation, contact and number', () => {
    const data = storeOrderMessageSentPayloadSchema.shape.data.shape;
    expect(Object.keys(data)).toEqual([
      'orderMessage',
      'storeOrder',
      'store',
      'conversation',
      'contact',
      'channel',
    ]);
    expect(Object.keys(data.orderMessage.shape)).toEqual([
      'event',
      'occurredAt',
      'messageId',
      'automationRunId',
    ]);
    expect(data.storeOrder).toBe(storeOrderCodAnsweredPayloadSchema.shape.data.shape.storeOrder);
    const body = (orderMessage: Record<string, unknown>) => ({
      id,
      type: 'store_order.message_sent',
      createdAt: at.toISOString(),
      createdAtExact: '2026-10-10T11:00:00.123456Z',
      data: {
        orderMessage: {
          event: 'order_shipped',
          occurredAt: placedAt.toISOString(),
          messageId: message,
          automationRunId: null,
          ...orderMessage,
        },
        storeOrder: { ...row.order, placedAt: placedAt.toISOString() },
        store: row.store,
        conversation: { id: conversation },
        contact: { id: contact, phone: '+919845012345', name: 'Asha' },
        channel: { id: channel, phone: '+91 80 4567 8901' },
      },
    });
    const parses = (value: unknown) => storeOrderMessageSentPayloadSchema.safeParse(value).success;
    expect(parses(body({}))).toBe(true);
    expect(parses(body({ messageId: null, automationRunId: run }))).toBe(true);
    expect(parses(body({ event: 'cart_reminder' }))).toBe(false);
    expect(parses(body({ messageId: 'wamid.HBg' }))).toBe(false);
    expect(parses(body({ occurredAt: 'today' }))).toBe(false);
  });

  it('builds the body of a template from the message as captured and the rest as it is now', async () => {
    const reads = answering([[row], [person]]);
    const built = await buildWebhookPayload(reads.tx, event(capturedDetail), 'endpoint');
    expect(built).toEqual({
      id,
      type: 'store_order.message_sent',
      createdAt: '2026-10-10T11:00:00.123Z',
      createdAtExact: '2026-10-10T11:00:00.123456Z',
      data: {
        orderMessage: {
          event: 'order_shipped',
          occurredAt: '2026-10-10T10:00:00.000Z',
          messageId: message,
          automationRunId: null,
        },
        storeOrder: {
          id: order,
          externalId: '5640149885115',
          name: '#1044',
          status: 'open',
          financialStatus: 'paid',
          fulfillmentStatus: 'fulfilled',
          test: false,
          currency: 'INR',
          totalMinor: 249_900,
          placedAt: '2026-10-10T10:00:00.000Z',
          cancelledAt: null,
          deletedAt: null,
        },
        store: {
          id: store,
          platform: 'shopify',
          name: 'Asha Textiles',
          url: 'https://asha-textiles.myshopify.com',
        },
        conversation: { id: conversation },
        contact: { id: contact, phone: '+919845012345', name: 'Asha' },
        channel: { id: channel, phone: '+91 80 4567 8901' },
      },
    });
    expect(storeOrderMessageSentPayloadSchema.safeParse(built).success).toBe(true);
    expect(reads.unread()).toBe(0);
  });

  it('gives an automation’s run instead of a message, and the contact as erasure left it', async () => {
    const reads = answering([[{ ...row, channelPhone: null }], [{ ...person, erasedAt: at }]]);
    const built = await buildWebhookPayload(
      reads.tx,
      event(
        { ...capturedDetail, automationRunId: run },
        { status: 'order_placed', messageId: null },
      ),
      'endpoint',
    );
    expect(built.data).toMatchObject({
      orderMessage: { event: 'order_placed', messageId: null, automationRunId: run },
      contact: { id: contact, phone: null, name: null },
      channel: { id: channel, phone: null },
    });
    expect(storeOrderMessageSentPayloadSchema.safeParse(built).success).toBe(true);
    expect(reads.unread()).toBe(0);
  });

  it('sends nothing for a message that is gone, a cart reminder or another company’s, reading nothing for an id that is not one', async () => {
    const gone = answering([[]]);
    await expect(
      buildWebhookPayload(gone.tx, event(capturedDetail), 'endpoint'),
    ).rejects.toBeInstanceOf(WebhookEventGoneError);
    expect(gone.unread()).toBe(0);
    for (const storeMessageId of ['message', null, 7]) {
      const none = answering([]);
      await expect(
        buildWebhookPayload(none.tx, event({ ...capturedDetail, storeMessageId }), 'endpoint'),
      ).rejects.toBeInstanceOf(WebhookEventGoneError);
    }
  });

  it('describes no event captured without its event, time, conversation, or with neither or both a message and a run, reading nothing', async () => {
    const cases: [Record<string, unknown>, Parameters<typeof event>[1]][] = [
      [capturedDetail, { status: null }],
      [{ storeMessageId: storeMessage, automationRunId: null }, {}],
      [capturedDetail, { conversationId: null }],
      [capturedDetail, { messageId: null }],
      [{ ...capturedDetail, automationRunId: run }, {}],
    ];
    for (const [detail, opts] of cases) {
      const none = answering([]);
      const built = buildWebhookPayload(none.tx, event(detail, opts), 'endpoint');
      await expect(built).rejects.toThrow(
        'The sent order message was captured without its event, time, conversation, message or run',
      );
      await expect(built).rejects.not.toBeInstanceOf(WebhookEventGoneError);
    }
  });

  it('is described: the message tied to its order, as captured, and what sends nothing', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const described = doc.webhooks['store_order.message_sent'].post.description;
    for (const words of [
      'A connected store’s message about an order',
      'whose message.status events name no order',
      'this event ties it to the order',
      'orderMessage.messageId, the template message whose message.status events follow',
      'orderMessage.automationRunId, the run whose automation.run_* events follow',
      'Never the customer’s details from the store',
      'when HyFib queues its template message for WhatsApp or starts the automation',
      'before WhatsApp accepts or delivers anything',
      'a skipped message sends store_order.message_skipped instead',
      'an endpoint that names numbers receives it for those numbers only',
      'its `storeIds` and `orderMessageEvents`',
      'fails as event_gone',
    ]) {
      expect(described).toContain(words);
    }
    expect(doc.components.schemas).toHaveProperty('WebhookStoreOrderMessageSent');
  });
});

describe('skip reason filters for skipped order messages (ADR-354)', () => {
  /** The reasons that concern cart reminders only: an order message is never skipped for them. */
  const cartOnly = [
    'checkout_completed',
    'checkout_deleted',
    'order_placed',
    'first_reminder_not_sent',
    'cart_too_old',
    'not_marketing_template',
  ];

  it('are the reasons a store’s Messages page explains, but cart reminders’ own', () => {
    expect(WEBHOOK_ORDER_MESSAGE_SKIP_REASONS).toEqual(
      Object.keys(STORE_MESSAGE_SKIP_REASONS).filter((reason) => !cartOnly.includes(reason)),
    );
    expect(WEBHOOK_ORDER_MESSAGE_SKIP_REASONS).toHaveLength(25);
    for (const reason of cartOnly) {
      expect(STORE_MESSAGE_SKIP_REASONS, reason).toHaveProperty(reason);
    }
  });

  it('take 1 to 25 reasons, once each, in that order; null takes every reason', () => {
    expect(
      webhookOrderMessageSkipReasonsSchema.parse(['opted_out', 'test_order', 'opted_out']),
    ).toEqual(['test_order', 'opted_out']);
    expect(webhookOrderMessageSkipReasonsSchema.parse(null)).toBeNull();
    expect(
      webhookOrderMessageSkipReasonsSchema.parse([...WEBHOOK_ORDER_MESSAGE_SKIP_REASONS].reverse()),
    ).toEqual([...WEBHOOK_ORDER_MESSAGE_SKIP_REASONS]);
    for (const refused of [
      [],
      ['cart_too_old'],
      ['order_placed'],
      ['No_phone'],
      'no_phone',
      [null],
      Array(26).fill('no_phone'),
    ]) {
      expect(
        webhookOrderMessageSkipReasonsSchema.safeParse(refused).success,
        JSON.stringify(refused),
      ).toBe(false);
    }
    expect(webhookOrderMessageSkipReasonsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one skip reason, or take every reason.',
    );
    expect(
      webhookOrderMessageSkipReasonsSchema.safeParse(['cart_too_old']).error?.issues[0]?.message,
    ).toBe('Choose skip reasons from the list.');
    expect(
      webhookOrderMessageSkipReasonsSchema.safeParse(Array(26).fill('no_phone')).error?.issues[0]
        ?.message,
    ).toBe('Give each skip reason once.');
  });

  it('are kept only while the endpoint takes skipped order messages: given, kept, or cleared', () => {
    const skipped = ['store_order.message_skipped', 'order.received'] as const;
    expect(webhookOrderMessageSkipReasonsFor([...skipped], ['no_phone'], null)).toEqual([
      'no_phone',
    ]);
    expect(webhookOrderMessageSkipReasonsFor([...skipped], undefined, ['opted_out'])).toEqual([
      'opted_out',
    ]);
    expect(webhookOrderMessageSkipReasonsFor([...skipped], null, ['opted_out'])).toBeNull();
    expect(webhookOrderMessageSkipReasonsFor([...skipped], undefined, null)).toBeNull();
    // A sent message or an answer has no reason to choose.
    for (const events of [
      ['store_order.message_sent'],
      ['store_order.cod_answered'],
      ['store_order.message_sent', 'store_order.cod_answered'],
    ] as const) {
      expect(
        webhookOrderMessageSkipReasonsFor([...events], ['no_phone'], ['opted_out']),
        events.join(),
      ).toBeNull();
    }
    expect(WEBHOOK_ORDER_MESSAGE_SKIP_REASONS_NEED_THE_EVENT).toBe(
      `Choose skip reasons only for an endpoint that receives ${WEBHOOK_EVENT_INFO['store_order.message_skipped'].label}.`,
    );
  });

  it('are described with the skipped event, which names them', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const described = doc.webhooks['store_order.message_skipped'].post.description;
    expect(described).toContain(
      'every reason’s unless it names the reasons (its `orderMessageSkipReasons`, or the reasons ticked under Order message skipped)',
    );
    expect(described).toContain('with more than one list, a skipped message must pass them all');
  });
});

describe('the events of a store’s cart reminders (ADR-355)', () => {
  const id = '0192f4d1-a5b2-7c83-9d4e-c1d2e3f4a601';
  const tenantId = '0192f4d1-a5b2-7c83-9d4e-c1d2e3f4a602';
  const [storeMessage, checkout, store, conversation, contact, channel, message] = [
    '0192f4d1-a5b2-7c83-9d4e-c1d2e3f4a603',
    '0192f4d1-a5b2-7c83-9d4e-c1d2e3f4a604',
    '0192f4d1-a5b2-7c83-9d4e-c1d2e3f4a605',
    '0192f4d1-a5b2-7c83-9d4e-c1d2e3f4a606',
    '0192f4d1-a5b2-7c83-9d4e-c1d2e3f4a607',
    '0192f4d1-a5b2-7c83-9d4e-c1d2e3f4a608',
    '0192f4d1-a5b2-7c83-9d4e-c1d2e3f4a609',
  ];
  const at = new Date('2026-10-10T12:00:00.123Z');
  const startedAt = new Date('2026-10-10T09:00:00.000Z');
  /**
   * The reasons a cart reminder is never skipped for: those of order messages only, and
   * `checkout_deleted`, as a reminder is deleted with its checkout.
   */
  const neverForReminders = [
    'checkout_deleted',
    'test_order',
    'too_late',
    'cash_on_delivery',
    'order_deleted',
    'order_cancelled',
    'automation_unavailable',
    'conversation_assigned',
    'automation_busy',
    'automation_limit',
    'automation_quota',
  ];

  /** A transaction that answers its reads, in order, with `answers`; another read fails the test. */
  function answering(answers: unknown[][]) {
    const queue = [...answers];
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => {
        const rows = queue.shift();
        if (!rows) throw new Error('an unexpected read');
        return Promise.resolve(rows);
      },
    };
    return {
      tx: { select: () => chain } as unknown as Parameters<typeof buildWebhookPayload>[0],
      unread: () => queue.length,
    };
  }

  const event = (
    type: 'store_checkout.reminder_skipped' | 'store_checkout.reminder_sent',
    detail: Record<string, unknown>,
    opts: {
      status?: string | null;
      messageId?: string | null;
      conversationId?: string | null;
    } = {},
  ) => {
    const sent = type === 'store_checkout.reminder_sent';
    return {
      id,
      tenantId,
      type,
      messageId: opts.messageId === undefined ? (sent ? message : null) : opts.messageId,
      conversationId:
        opts.conversationId === undefined ? (sent ? conversation : null) : opts.conversationId,
      contactId: sent ? contact : null,
      templateId: null,
      status: opts.status === undefined ? 'cart_reminder' : opts.status,
      detail,
      contactChanges: null,
      tagsAdded: null,
      tagsRemoved: null,
      occurredAt: at,
      occurredAtExact: '2026-10-10T12:00:00.123456Z',
    } as unknown as Parameters<typeof buildWebhookPayload>[1];
  };
  // As the triggers capture them (0276), the time with its offset.
  const skippedDetail = {
    storeMessageId: storeMessage,
    skipReason: 'checkout_completed',
    occurredAt: '2026-10-10T15:00:00+05:30',
  };
  const sentDetail = { storeMessageId: storeMessage, occurredAt: '2026-10-10T15:00:00+05:30' };
  const checkoutRow = {
    id: checkout,
    externalId: '37298746245307',
    name: '#C1007',
    currency: 'INR',
    totalMinor: 189_900,
    itemCount: 3,
    startedAt,
    completedAt: null,
  };
  const storeRow = {
    id: store,
    platform: 'shopify',
    name: 'Asha Textiles',
    url: 'https://asha-textiles.myshopify.com',
  };
  const sentRow = {
    checkout: checkoutRow,
    store: storeRow,
    contactId: contact,
    channelId: channel,
    channelPhone: '+91 80 4567 8901',
  };
  const person = { phone: '+919845012345', name: 'Asha', erasedAt: null };
  const writtenCheckout = {
    ...checkoutRow,
    startedAt: '2026-10-10T09:00:00.000Z',
    completedAt: null,
  };

  it('are two events of a store, the sent one also of a number, labelled as Settings lists them', () => {
    expect(WEBHOOK_EVENT_INFO['store_checkout.reminder_skipped']).toEqual({
      label: 'Cart reminder skipped',
      description:
        'A connected Shopify store’s cart reminder (the first or the second) about a checkout a customer left was not sent when it was due: the checkout was completed or too old, an order was placed since, the first reminder was not sent, or a check failed, such as a customer without a number or marketing opt-in, or the frequency cap.',
    });
    expect(WEBHOOK_EVENT_INFO['store_checkout.reminder_sent']).toEqual({
      label: 'Cart reminder sent',
      description:
        'A connected Shopify store’s cart reminder (the first or the second) about a checkout a customer left went out: its template message was queued for WhatsApp, whose statuses follow as message status events.',
    });
    expect(WEBHOOK_EVENT_KEYS.indexOf('store_checkout.reminder_skipped')).toBe(
      WEBHOOK_EVENT_KEYS.indexOf('store_order.message_sent') + 1,
    );
    expect(WEBHOOK_EVENT_KEYS.indexOf('store_checkout.reminder_sent')).toBe(
      WEBHOOK_EVENT_KEYS.indexOf('store_order.message_sent') + 2,
    );
    expect(WEBHOOK_CART_REMINDERS).toEqual(['cart_reminder', 'cart_second_reminder']);
    expect(WEBHOOK_CART_REMINDERS.map((r) => STORE_MESSAGE_EVENT_INFO[r].label)).toEqual([
      'Cart reminder',
      'Second cart reminder',
    ]);
    const skipped = ['store_checkout.reminder_skipped'] as const;
    const sent = ['store_checkout.reminder_sent'] as const;
    expect(webhookTakesChannelEvents([...skipped])).toBe(false);
    expect(webhookTakesChannelEvents([...sent])).toBe(true);
    for (const events of [skipped, sent, [...skipped, ...sent]]) {
      expect(webhookTakesStoreEvents([...events]), events.join()).toBe(true);
      expect(webhookStoreIdsFor([...events], [store], null), events.join()).toEqual([store]);
      // A reminder is no order message, has no reason to choose and no answer.
      expect(webhookTakesOrderMessages([...events]), events.join()).toBe(false);
      expect(
        webhookOrderMessageEventsFor([...events], ['order_placed'], ['order_shipped']),
        events.join(),
      ).toBeNull();
      expect(
        webhookOrderMessageSkipReasonsFor([...events], ['no_phone'], ['opted_out']),
        events.join(),
      ).toBeNull();
      expect(webhookCodAnswersFor([...events], ['cancelled'], null), events.join()).toBeNull();
      for (const takes of [
        webhookTakesTaskEvents,
        webhookTakesPipelineEvents,
        webhookTakesTeamEvents,
        webhookTakesCampaignEvents,
        webhookTakesTemplateEvents,
        webhookTakesAutomationRuns,
      ]) {
        expect(takes([...events]), `${takes.name} ${events.join()}`).toBe(false);
      }
    }
    expect(WEBHOOK_CHANNELS_NEED_THE_EVENTS).toContain('sent order message, sent cart reminder or');
  });

  it('skip for the reasons a store’s Messages page explains, but order messages’ own', () => {
    expect(WEBHOOK_CART_REMINDER_SKIP_REASONS).toEqual(
      Object.keys(STORE_MESSAGE_SKIP_REASONS).filter(
        (reason) => !neverForReminders.includes(reason),
      ),
    );
    expect(WEBHOOK_CART_REMINDER_SKIP_REASONS).toHaveLength(20);
    for (const reason of neverForReminders) {
      expect(STORE_MESSAGE_SKIP_REASONS, reason).toHaveProperty(reason);
    }
    // Five of the six the order message list leaves out: checkout_deleted is never sent either.
    expect(
      WEBHOOK_CART_REMINDER_SKIP_REASONS.filter(
        (reason) => !(WEBHOOK_ORDER_MESSAGE_SKIP_REASONS as readonly string[]).includes(reason),
      ),
    ).toEqual([
      'checkout_completed',
      'order_placed',
      'first_reminder_not_sent',
      'cart_too_old',
      'not_marketing_template',
    ]);
  });

  it('give the reminder, the checkout without the customer, its store, and when sent the conversation, contact and number', () => {
    const skippedData = storeCheckoutReminderSkippedPayloadSchema.shape.data.shape;
    expect(Object.keys(skippedData)).toEqual(['reminder', 'storeCheckout', 'store']);
    expect(Object.keys(skippedData.reminder.shape)).toEqual(['event', 'skipReason', 'occurredAt']);
    expect(Object.keys(skippedData.storeCheckout.shape)).toEqual([
      'id',
      'externalId',
      'name',
      'currency',
      'totalMinor',
      'itemCount',
      'startedAt',
      'completedAt',
    ]);
    expect(skippedData.store).toBe(storeOrderCodAnsweredPayloadSchema.shape.data.shape.store);
    const sentData = storeCheckoutReminderSentPayloadSchema.shape.data.shape;
    expect(Object.keys(sentData)).toEqual([
      'reminder',
      'storeCheckout',
      'store',
      'conversation',
      'contact',
      'channel',
    ]);
    expect(Object.keys(sentData.reminder.shape)).toEqual(['event', 'occurredAt', 'messageId']);
    expect(sentData.storeCheckout).toBe(skippedData.storeCheckout);
    const skippedBody = (reminder: Record<string, unknown>, checkoutPart = {}) => ({
      id,
      type: 'store_checkout.reminder_skipped',
      createdAt: at.toISOString(),
      createdAtExact: '2026-10-10T12:00:00.123456Z',
      data: {
        reminder: {
          event: 'cart_reminder',
          skipReason: 'checkout_completed',
          occurredAt: startedAt.toISOString(),
          ...reminder,
        },
        storeCheckout: { ...writtenCheckout, ...checkoutPart },
        store: storeRow,
      },
    });
    const skippedParses = (value: unknown) =>
      storeCheckoutReminderSkippedPayloadSchema.safeParse(value).success;
    expect(skippedParses(skippedBody({}))).toBe(true);
    expect(skippedParses(skippedBody({ event: 'cart_second_reminder' }))).toBe(true);
    expect(skippedParses(skippedBody({}, { name: null, currency: null, totalMinor: null }))).toBe(
      true,
    );
    expect(skippedParses(skippedBody({}, { completedAt: at.toISOString() }))).toBe(true);
    for (const skipReason of WEBHOOK_CART_REMINDER_SKIP_REASONS) {
      expect(skippedParses(skippedBody({ skipReason })), skipReason).toBe(true);
    }
    for (const refused of [
      { event: 'order_placed' },
      { skipReason: 'test_order' },
      { skipReason: 'automation_busy' },
      { skipReason: 'checkout_deleted' },
      { occurredAt: 'today' },
    ]) {
      expect(skippedParses(skippedBody(refused)), JSON.stringify(refused)).toBe(false);
    }
    const sentBody = (reminder: Record<string, unknown>) => ({
      id,
      type: 'store_checkout.reminder_sent',
      createdAt: at.toISOString(),
      createdAtExact: '2026-10-10T12:00:00.123456Z',
      data: {
        reminder: {
          event: 'cart_second_reminder',
          occurredAt: startedAt.toISOString(),
          messageId: message,
          ...reminder,
        },
        storeCheckout: writtenCheckout,
        store: storeRow,
        conversation: { id: conversation },
        contact: { id: contact, phone: '+919845012345', name: 'Asha' },
        channel: { id: channel, phone: '+91 80 4567 8901' },
      },
    });
    const sentParses = (value: unknown) =>
      storeCheckoutReminderSentPayloadSchema.safeParse(value).success;
    expect(sentParses(sentBody({}))).toBe(true);
    expect(sentParses(sentBody({ event: 'order_shipped' }))).toBe(false);
    expect(sentParses(sentBody({ messageId: null }))).toBe(false);
    expect(sentParses(sentBody({ messageId: 'wamid.HBg' }))).toBe(false);
  });

  it('builds a skipped reminder’s body from the reminder as captured and the rest as it is now', async () => {
    const reads = answering([[{ checkout: checkoutRow, store: storeRow }]]);
    const built = await buildWebhookPayload(
      reads.tx,
      event('store_checkout.reminder_skipped', skippedDetail),
      'endpoint',
    );
    expect(built).toEqual({
      id,
      type: 'store_checkout.reminder_skipped',
      createdAt: '2026-10-10T12:00:00.123Z',
      createdAtExact: '2026-10-10T12:00:00.123456Z',
      data: {
        reminder: {
          event: 'cart_reminder',
          skipReason: 'checkout_completed',
          occurredAt: '2026-10-10T09:30:00.000Z',
        },
        storeCheckout: {
          id: checkout,
          externalId: '37298746245307',
          name: '#C1007',
          currency: 'INR',
          totalMinor: 189_900,
          itemCount: 3,
          startedAt: '2026-10-10T09:00:00.000Z',
          completedAt: null,
        },
        store: {
          id: store,
          platform: 'shopify',
          name: 'Asha Textiles',
          url: 'https://asha-textiles.myshopify.com',
        },
      },
    });
    expect(storeCheckoutReminderSkippedPayloadSchema.safeParse(built).success).toBe(true);
    expect(reads.unread()).toBe(0);
  });

  it('builds a sent reminder’s body with the message and conversation as captured, the contact as erasure left it', async () => {
    const reads = answering([[sentRow], [person]]);
    const built = await buildWebhookPayload(
      reads.tx,
      event('store_checkout.reminder_sent', sentDetail, { status: 'cart_second_reminder' }),
      'endpoint',
    );
    expect(built).toEqual({
      id,
      type: 'store_checkout.reminder_sent',
      createdAt: '2026-10-10T12:00:00.123Z',
      createdAtExact: '2026-10-10T12:00:00.123456Z',
      data: {
        reminder: {
          event: 'cart_second_reminder',
          occurredAt: '2026-10-10T09:30:00.000Z',
          messageId: message,
        },
        storeCheckout: writtenCheckout,
        store: storeRow,
        conversation: { id: conversation },
        contact: { id: contact, phone: '+919845012345', name: 'Asha' },
        channel: { id: channel, phone: '+91 80 4567 8901' },
      },
    });
    expect(storeCheckoutReminderSentPayloadSchema.safeParse(built).success).toBe(true);
    expect(reads.unread()).toBe(0);
    const erased = answering([
      [{ ...sentRow, channelPhone: null, checkout: { ...checkoutRow, completedAt: at } }],
      [{ ...person, erasedAt: at }],
    ]);
    const later = await buildWebhookPayload(
      erased.tx,
      event('store_checkout.reminder_sent', sentDetail),
      'endpoint',
    );
    expect(later.data).toMatchObject({
      reminder: { event: 'cart_reminder', messageId: message },
      storeCheckout: { completedAt: '2026-10-10T12:00:00.123Z' },
      contact: { id: contact, phone: null, name: null },
      channel: { id: channel, phone: null },
    });
    expect(storeCheckoutReminderSentPayloadSchema.safeParse(later).success).toBe(true);
    expect(erased.unread()).toBe(0);
  });

  it('sends nothing for a reminder that is gone, an order message or another company’s, reading nothing for an id that is not one', async () => {
    for (const [type, detail] of [
      ['store_checkout.reminder_skipped', skippedDetail],
      ['store_checkout.reminder_sent', sentDetail],
    ] as const) {
      const gone = answering([[]]);
      await expect(
        buildWebhookPayload(gone.tx, event(type, detail), 'endpoint'),
        type,
      ).rejects.toBeInstanceOf(WebhookEventGoneError);
      expect(gone.unread(), type).toBe(0);
      for (const storeMessageId of ['message', null, 7]) {
        const none = answering([]);
        await expect(
          buildWebhookPayload(none.tx, event(type, { ...detail, storeMessageId }), 'endpoint'),
          `${type} ${String(storeMessageId)}`,
        ).rejects.toBeInstanceOf(WebhookEventGoneError);
      }
    }
  });

  it('describes no event captured without its reminder, reason, time, message or conversation, reading nothing', async () => {
    const cases: [Parameters<typeof event>[0], Record<string, unknown>, string][] = [
      [
        'store_checkout.reminder_skipped',
        { storeMessageId: storeMessage, occurredAt: skippedDetail.occurredAt },
        'The skipped cart reminder was captured without its reminder, reason or time',
      ],
      [
        'store_checkout.reminder_skipped',
        { storeMessageId: storeMessage, skipReason: 'no_phone' },
        'The skipped cart reminder was captured without its reminder, reason or time',
      ],
      [
        'store_checkout.reminder_sent',
        { storeMessageId: storeMessage },
        'The sent cart reminder was captured without its reminder, time, message or conversation',
      ],
    ];
    for (const [type, detail, message] of cases) {
      const none = answering([]);
      const built = buildWebhookPayload(none.tx, event(type, detail), 'endpoint');
      await expect(built, JSON.stringify(detail)).rejects.toThrow(message);
      await expect(built).rejects.not.toBeInstanceOf(WebhookEventGoneError);
    }
    const withouts: [
      Parameters<typeof event>[0],
      Record<string, unknown>,
      Parameters<typeof event>[2],
    ][] = [
      ['store_checkout.reminder_skipped', skippedDetail, { status: null }],
      ['store_checkout.reminder_sent', sentDetail, { status: null }],
      ['store_checkout.reminder_sent', sentDetail, { messageId: null }],
      ['store_checkout.reminder_sent', sentDetail, { conversationId: null }],
    ];
    for (const [type, detail, opts] of withouts) {
      const none = answering([]);
      const built = buildWebhookPayload(none.tx, event(type, detail, opts), 'endpoint');
      await expect(built, `${type} ${JSON.stringify(opts)}`).rejects.toThrow(
        'was captured without',
      );
      await expect(built).rejects.not.toBeInstanceOf(WebhookEventGoneError);
    }
  });

  it('are described: the reminder tied to its checkout, as captured, and what sends nothing', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const skipped = doc.webhooks['store_checkout.reminder_skipped'].post.description;
    for (const words of [
      'A connected Shopify store’s cart reminder',
      'this event is how a store system learns that one did not, and why',
      'reminder gives which reminder it was, the reason and when the checkout was last left, as captured',
      'the store’s own checkout id (storeCheckout.externalId) to find it there',
      'Never the customer’s details from the store, the items or the link back to the checkout, and no contact or number',
      'an endpoint that names numbers receives it whichever numbers it names',
      'unless it names the stores (its `storeIds`',
      'a reminder sent, or waiting for its delay, the store’s sending hours or the first reminder, sends nothing',
      'HyFib deletes a checkout 30 days after the store last updated it',
      'fails as event_gone',
    ]) {
      expect(skipped).toContain(words);
    }
    const sent = doc.webhooks['store_checkout.reminder_sent'].post.description;
    for (const words of [
      'whose message.status events name no checkout: this event ties it to the checkout',
      'reminder.messageId, the template message whose message.status events follow',
      'contact is the conversation’s contact, as erasure left it',
      'when HyFib queues its template message for WhatsApp, before WhatsApp accepts or delivers anything',
      'a skipped reminder sends store_checkout.reminder_skipped instead',
      'an endpoint that names numbers receives it for those numbers only',
      'with more than one of these lists, a sent reminder must pass them all',
      'fails as event_gone',
    ]) {
      expect(sent).toContain(words);
    }
    expect(doc.components.schemas).toHaveProperty('WebhookStoreCheckoutReminderSkipped');
    expect(doc.components.schemas).toHaveProperty('WebhookStoreCheckoutReminderSent');
    expect(doc.webhooks['store_order.message_sent'].post.description).toContain(
      'cart reminders, which are about checkouts, send store_checkout.reminder_sent and store_checkout.reminder_skipped instead',
    );
  });
});

describe('skip reason filters for skipped cart reminders (ADR-356)', () => {
  it('take 1 to 20 of a cart reminder’s reasons, once each, in that order; null takes every reason', () => {
    expect(
      webhookCartReminderSkipReasonsSchema.parse(['opted_out', 'rule_disabled', 'opted_out']),
    ).toEqual(['rule_disabled', 'opted_out']);
    expect(webhookCartReminderSkipReasonsSchema.parse(null)).toBeNull();
    expect(
      webhookCartReminderSkipReasonsSchema.parse([...WEBHOOK_CART_REMINDER_SKIP_REASONS].reverse()),
    ).toEqual([...WEBHOOK_CART_REMINDER_SKIP_REASONS]);
    expect(WEBHOOK_CART_REMINDER_SKIP_REASONS).toHaveLength(20);
    for (const refused of [
      [],
      ['test_order'],
      ['automation_busy'],
      ['checkout_deleted'],
      ['No_phone'],
      'no_phone',
      [null],
      Array(21).fill('no_phone'),
    ]) {
      expect(
        webhookCartReminderSkipReasonsSchema.safeParse(refused).success,
        JSON.stringify(refused),
      ).toBe(false);
    }
    expect(webhookCartReminderSkipReasonsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one cart reminder skip reason, or take every reason.',
    );
    expect(
      webhookCartReminderSkipReasonsSchema.safeParse(['test_order']).error?.issues[0]?.message,
    ).toBe('Choose cart reminder skip reasons from the list.');
    expect(
      webhookCartReminderSkipReasonsSchema.safeParse(Array(21).fill('no_phone')).error?.issues[0]
        ?.message,
    ).toBe('Give each cart reminder skip reason once.');
  });

  it('are kept only while the endpoint takes skipped cart reminders: given, kept, or cleared', () => {
    const skipped = ['store_checkout.reminder_skipped', 'order.received'] as const;
    expect(webhookCartReminderSkipReasonsFor([...skipped], ['no_phone'], null)).toEqual([
      'no_phone',
    ]);
    expect(webhookCartReminderSkipReasonsFor([...skipped], undefined, ['cart_too_old'])).toEqual([
      'cart_too_old',
    ]);
    expect(webhookCartReminderSkipReasonsFor([...skipped], null, ['cart_too_old'])).toBeNull();
    expect(webhookCartReminderSkipReasonsFor([...skipped], undefined, null)).toBeNull();
    // A sent reminder has no reason, and a skipped order message has a list of its own.
    for (const events of [
      ['store_checkout.reminder_sent'],
      ['store_order.message_skipped'],
      ['store_checkout.reminder_sent', 'store_order.message_skipped'],
    ] as const) {
      expect(
        webhookCartReminderSkipReasonsFor([...events], ['no_phone'], ['cart_too_old']),
        events.join(),
      ).toBeNull();
      expect(
        webhookOrderMessageSkipReasonsFor(['store_checkout.reminder_skipped'], ['no_phone'], null),
      ).toBeNull();
    }
    expect(WEBHOOK_CART_REMINDER_SKIP_REASONS_NEED_THE_EVENT).toBe(
      `Choose cart reminder skip reasons only for an endpoint that receives ${WEBHOOK_EVENT_INFO['store_checkout.reminder_skipped'].label}.`,
    );
  });

  it('are described with the skipped reminder event, which names them', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const described = doc.webhooks['store_checkout.reminder_skipped'].post.description;
    expect(described).toContain(
      'every reason’s unless it names the reasons (its `cartReminderSkipReasons`, or the reasons ticked under Cart reminder skipped); with more than one of these lists, a skipped reminder must pass them all',
    );
  });
});

describe('skip reason filters for skipped campaign recipients (ADR-359)', () => {
  it('take 1 to 9 of a campaign recipient’s reasons, once each, in that order; null takes every reason', () => {
    expect(webhookCampaignSkipReasonsSchema.parse(['expired', 'no_phone', 'expired'])).toEqual([
      'no_phone',
      'expired',
    ]);
    expect(webhookCampaignSkipReasonsSchema.parse(null)).toBeNull();
    expect(
      webhookCampaignSkipReasonsSchema.parse([...WEBHOOK_CAMPAIGN_SKIP_REASONS].reverse()),
    ).toEqual([...WEBHOOK_CAMPAIGN_SKIP_REASONS]);
    // Every reason a campaign recipient can be skipped for, in the database's order.
    expect(WEBHOOK_CAMPAIGN_SKIP_REASONS).toEqual([...SKIP_REASONS]);
    for (const refused of [
      [],
      ['cart_too_old'],
      ['canceled'],
      ['No_phone'],
      'no_phone',
      [null],
      Array(10).fill('no_phone'),
    ]) {
      expect(
        webhookCampaignSkipReasonsSchema.safeParse(refused).success,
        JSON.stringify(refused),
      ).toBe(false);
    }
    expect(webhookCampaignSkipReasonsSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one campaign skip reason, or take every reason.',
    );
    expect(
      webhookCampaignSkipReasonsSchema.safeParse(['cart_too_old']).error?.issues[0]?.message,
    ).toBe('Choose campaign skip reasons from the list.');
    expect(
      webhookCampaignSkipReasonsSchema.safeParse(Array(10).fill('no_phone')).error?.issues[0]
        ?.message,
    ).toBe('Give each campaign skip reason once.');
  });

  it('are kept only while the endpoint takes skipped campaign recipients: given, kept, or cleared', () => {
    const skipped = ['campaign.recipient_skipped', 'campaign.status_changed'] as const;
    expect(webhookCampaignSkipReasonsFor([...skipped], ['no_phone'], null)).toEqual(['no_phone']);
    expect(webhookCampaignSkipReasonsFor([...skipped], undefined, ['expired'])).toEqual([
      'expired',
    ]);
    expect(webhookCampaignSkipReasonsFor([...skipped], null, ['expired'])).toBeNull();
    expect(webhookCampaignSkipReasonsFor([...skipped], undefined, null)).toBeNull();
    // A campaign's other events have no skip reason, and skipped cart reminders a list of their own.
    for (const events of [
      ['campaign.status_changed'],
      ['message.status'],
      ['store_checkout.reminder_skipped'],
    ] as const) {
      expect(
        webhookCampaignSkipReasonsFor([...events], ['no_phone'], ['expired']),
        events.join(),
      ).toBeNull();
    }
    expect(
      webhookCartReminderSkipReasonsFor(['campaign.recipient_skipped'], ['no_phone'], null),
    ).toBeNull();
    expect(WEBHOOK_CAMPAIGN_SKIP_REASONS_NEED_THE_EVENT).toBe(
      `Choose campaign skip reasons only for an endpoint that receives ${WEBHOOK_EVENT_INFO['campaign.recipient_skipped'].label}.`,
    );
  });

  it('are described with the skipped recipient event, which names them', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const described = doc.webhooks['campaign.recipient_skipped'].post.description;
    expect(described).toContain(
      'an endpoint receives every reason’s skips unless it names the reasons (its `campaignSkipReasons`, or the reasons ticked under Campaign recipient skipped); with more than one of these lists, a skipped recipient must pass them all',
    );
  });
});

describe('cart reminder filters for cart reminder events (ADR-361)', () => {
  it('take the first, the second or both cart reminders, once each, in that order; null takes both', () => {
    expect(webhookCartRemindersSchema.parse(['cart_second_reminder', 'cart_reminder'])).toEqual([
      'cart_reminder',
      'cart_second_reminder',
    ]);
    expect(webhookCartRemindersSchema.parse(['cart_reminder', 'cart_reminder'])).toEqual([
      'cart_reminder',
    ]);
    expect(webhookCartRemindersSchema.parse(['cart_second_reminder'])).toEqual([
      'cart_second_reminder',
    ]);
    expect(webhookCartRemindersSchema.parse(null)).toBeNull();
    // A store's two cart reminders, as its Messages page lists them.
    expect(WEBHOOK_CART_REMINDERS).toEqual([...CART_EVENTS]);
    for (const refused of [
      [],
      ['order_placed'],
      ['cart_third_reminder'],
      ['Cart_reminder'],
      'cart_reminder',
      [null],
      Array(3).fill('cart_reminder'),
    ]) {
      expect(webhookCartRemindersSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false,
      );
    }
    expect(webhookCartRemindersSchema.safeParse([]).error?.issues[0]?.message).toBe(
      'Choose at least one cart reminder, or take both.',
    );
    expect(webhookCartRemindersSchema.safeParse(['order_placed']).error?.issues[0]?.message).toBe(
      'Choose cart reminders from the list.',
    );
    expect(
      webhookCartRemindersSchema.safeParse(Array(3).fill('cart_reminder')).error?.issues[0]
        ?.message,
    ).toBe('Give each cart reminder once.');
  });

  it('are kept only while the endpoint takes skipped or sent cart reminders: given, kept, or cleared', () => {
    expect(WEBHOOK_CART_REMINDER_TYPES).toEqual([
      'store_checkout.reminder_skipped',
      'store_checkout.reminder_sent',
    ]);
    for (const events of [
      ['store_checkout.reminder_skipped'],
      ['store_checkout.reminder_sent'],
      ['store_checkout.reminder_skipped', 'store_checkout.reminder_sent'],
      ['store_order.cod_answered', 'store_checkout.reminder_sent'],
    ] as const) {
      expect(webhookTakesCartReminders([...events]), events.join()).toBe(true);
      expect(webhookCartRemindersFor([...events], ['cart_reminder'], null)).toEqual([
        'cart_reminder',
      ]);
      expect(webhookCartRemindersFor([...events], undefined, ['cart_second_reminder'])).toEqual([
        'cart_second_reminder',
      ]);
      expect(webhookCartRemindersFor([...events], null, ['cart_second_reminder'])).toBeNull();
      expect(webhookCartRemindersFor([...events], undefined, null)).toBeNull();
    }
    // A store's other events are of no cart reminder.
    for (const events of [
      ['store_order.cod_answered'],
      ['store_order.message_skipped'],
      ['store_order.message_sent'],
      ['campaign.recipient_skipped'],
      [],
    ] as const) {
      expect(webhookTakesCartReminders([...events]), events.join()).toBe(false);
      expect(
        webhookCartRemindersFor([...events], ['cart_reminder'], ['cart_second_reminder']),
        events.join(),
      ).toBeNull();
    }
    // The skip reasons stay a list of the skipped event alone.
    expect(
      webhookCartReminderSkipReasonsFor(['store_checkout.reminder_sent'], ['no_phone'], null),
    ).toBeNull();
    expect(WEBHOOK_CART_REMINDERS_NEED_THE_EVENT).toBe(
      `Choose cart reminders only for an endpoint that receives ${WEBHOOK_EVENT_INFO['store_checkout.reminder_skipped'].label} or ${WEBHOOK_EVENT_INFO['store_checkout.reminder_sent'].label}.`,
    );
  });
});
