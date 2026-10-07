import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isAppError, Keyring } from '@w360/core';
import {
  ACTIVE_RUN_STATUSES,
  AUTOMATION_END_REASONS,
  AUTOMATION_RUN_STATUSES,
  CAMPAIGN_COMPLETION_REASONS,
  CAMPAIGN_PAUSE_REASONS,
  CAMPAIGN_STATUSES,
  CHANNEL_STATUSES,
  CONTACT_SOURCES,
  CONVERSATION_STATUSES,
  DEAL_STATUSES,
  MESSAGE_TYPES,
  ORDER_STATUSES,
  TASK_STATUSES,
  TEMPLATE_STATUSES,
  WEBHOOK_EVENT_TYPES,
} from '@w360/db';
import { apiCampaignResultsSchema } from '../api/campaigns';
import { apiContactSchema } from '../api/contact-view';
import { buildOpenApiDocument } from '../api/openapi';
import {
  campaignResultsSchema,
  toCampaignResults,
  type CampaignAnalytics,
} from '../campaigns/results';
import { renderEmail } from '../email/templates';
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
  webhookOwnerText,
  webhookPipelineText,
  webhookRetryDelaySeconds,
  webhookTakesAutomationRuns,
  webhookTakesCampaignEvents,
  webhookTakesChannelEvents,
  webhookTakesPipelineEvents,
  webhookTakesTaskEvents,
  webhookTakesTeamEvents,
  webhookTakesTemplateEvents,
  webhookTeamText,
  webhookTemplateText,
  webhookRunEndReasonsChosen,
  webhookRunEndReasonsTicked,
  webhookRunEndTakesReason,
  webhookStageText,
} from './model';
import {
  automationRunEndedPayloadSchema,
  automationRunStartedPayloadSchema,
  buildWebhookPayload,
  campaignStatusChangedPayloadSchema,
  dealCreatedPayloadSchema,
  dealStageChangedPayloadSchema,
  dealOwnerChangedPayloadSchema,
  dealStatusChangedPayloadSchema,
  taskCreatedPayloadSchema,
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
import { webhookOAuthSecretAad } from './oauth';
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
  webhookConsentChangesFor,
  webhookConsentChangesSchema,
  webhookContactSourcesFor,
  webhookContactSourcesSchema,
  webhookMessageTypesFor,
  webhookMessageTypesSchema,
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
  webhookContactTagsFor,
  webhookContactTagsSchema,
  WEBHOOK_CONTACT_TAGS_NEED_THE_EVENTS,
  webhookTemplateStatusesFor,
  webhookTemplateStatusesSchema,
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
  const base = { id: '0192a1b2-0000-7000-8000-000000000001', createdAt: '2026-09-28T10:00:00Z' };
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
      dealId: null,
      createdBy: 'member',
      createdAt: base.createdAt,
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
    // An unknown status or creator, an id or time that is not one, a field left out, or another
    // type is not described.
    for (const change of [
      { status: 'closed' },
      { previousStatus: 'won' },
      { createdBy: 'import' },
      { assigneeId: 'agent-1' },
      { dueAt: '2026-10-09' },
      { dealId: undefined },
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
    // A task is sent without its notes, which GET /tasks/{id} reads.
    expect(Object.keys(taskCreatedPayloadSchema.shape.data.shape.task.shape)).toEqual([
      'id',
      'title',
      'status',
      'previousStatus',
      'dueAt',
      'assigneeId',
      'dealId',
      'createdBy',
      'createdAt',
    ]);
    // The database takes exactly the events the API describes, in its order.
    expect([...WEBHOOK_EVENT_TYPES]).toEqual([...WEBHOOK_EVENT_KEYS]);
    expect(WEBHOOK_EVENT_INFO['task.created'].label).toBe('Task added');
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
      'contact.created',
      'contact.updated',
      'contact.erased',
      'contact.merged',
      'automation.run_started',
      'automation.run_ended',
      'order.received',
      'order.status_changed',
      'campaign.status_changed',
      'deal.created',
      'deal.stage_changed',
      'deal.owner_changed',
      'deal.status_changed',
      'task.created',
      'task.status_changed',
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
      'still every consent, contact, template, deal and task event it takes',
    );
    const schemas = doc.components.schemas as unknown as Record<
      string,
      { properties: Record<string, { description?: string }> } | undefined
    >;
    const described = (schema: string) => schemas[schema]?.properties.channelIds?.description;
    expect(described('WebhookEndpoint')).toContain(
      'Consent, contact, template, deal and task events are not narrowed.',
    );
    expect(described('CreateWebhookEndpoint')).toContain(
      'Consent, contact, template, deal and task events belong to no number',
    );
    expect(
      Object.keys(doc.components.schemas).filter((name) => name.startsWith('WebhookDeal')),
    ).toEqual([
      'WebhookDealCreated',
      'WebhookDealStageChanged',
      'WebhookDealOwnerChanged',
      'WebhookDealStatusChanged',
    ]);
    const owned = doc.webhooks['deal.owner_changed'].post.description;
    for (const words of [
      'by a member or an API key',
      'deal.ownerId and deal.previousOwnerId are the change (null for no owner)',
      'reopened, moved, given to another owner, closed',
      'for the owner the deal left as well as for the one it was given to',
    ]) {
      expect(owned).toContain(words);
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
      'Editing a task’s details or its reminder sends nothing.',
      'the latest change is the one with the latest createdAt',
    ]) {
      expect(text('task.status_changed')).toContain(words);
    }
    expect(
      Object.keys(doc.components.schemas).filter((name) => name.startsWith('WebhookTask')),
    ).toEqual(['WebhookTaskCreated', 'WebhookTaskStatusChanged']);
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
    } as unknown as Parameters<typeof buildWebhookPayload>[1];
    await expect(buildWebhookPayload(unreadable, event, 'endpoint')).rejects.toThrow(
      'No webhook payload is built for events of type contact.forgotten',
    );
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

  it('apply to the two automation run events and no other', () => {
    expect(WEBHOOK_AUTOMATION_EVENTS).toEqual(['automation.run_started', 'automation.run_ended']);
    expect(webhookTakesAutomationRuns(['automation.run_started'])).toBe(true);
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
    expect(webhookAutomationIdsFor(['consent.changed'], [greeter], [farewell])).toBeNull();
    expect(webhookAutomationIdsFor(['message.received'], undefined, [farewell])).toBeNull();
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
      'automation.run_started',
      'automation.run_ended',
      'order.received',
      'order.status_changed',
      'campaign.status_changed',
    ]);
    const payloads = {
      'message.received': messageReceivedPayloadSchema,
      'message.status': messageStatusPayloadSchema,
      'consent.changed': consentChangedPayloadSchema,
      'template.status_changed': templateStatusPayloadSchema,
      'conversation.status_changed': conversationStatusPayloadSchema,
      'conversation.assignment_changed': conversationAssignmentPayloadSchema,
      'conversation.team_changed': conversationTeamPayloadSchema,
      'contact.created': contactCreatedPayloadSchema,
      'contact.updated': contactUpdatedPayloadSchema,
      'contact.erased': contactErasedPayloadSchema,
      'contact.merged': contactMergedPayloadSchema,
      'automation.run_started': automationRunStartedPayloadSchema,
      'automation.run_ended': automationRunEndedPayloadSchema,
      'order.received': orderReceivedPayloadSchema,
      'order.status_changed': orderStatusChangedPayloadSchema,
      'campaign.status_changed': campaignStatusChangedPayloadSchema,
      'deal.created': dealCreatedPayloadSchema,
      'deal.stage_changed': dealStageChangedPayloadSchema,
      'deal.owner_changed': dealOwnerChangedPayloadSchema,
      'deal.status_changed': dealStatusChangedPayloadSchema,
      'task.created': taskCreatedPayloadSchema,
      'task.status_changed': taskStatusChangedPayloadSchema,
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
    });
    // Another token URL would receive the secret: it is needed again.
    expect(
      refusal(() =>
        checkedWebhookOAuth(
          { ...base, tokenUrl: 'https://elsewhere.example.com/t' },
          stored,
          policy,
        ),
      ),
    ).toEqual([{ path: 'oauth.clientSecret', message: WEBHOOK_OAUTH_SECRET_FOR_NEW_URL }]);
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
    });
    expect(() => openWebhookOAuthClient(ring, other, endpoint, columns)).toThrow();
    expect(() => openWebhookOAuthClient(ring, tenant, other, columns)).toThrow();
    // No client keeps nothing, and opens as none.
    expect(webhookOAuthColumns(ring, tenant, endpoint, null, columns)).toEqual(NO_WEBHOOK_OAUTH);
    expect(openWebhookOAuthClient(ring, tenant, endpoint, NO_WEBHOOK_OAUTH)).toBeNull();
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

  it('are described by the token URL’s host, and their failures named for members', () => {
    expect(webhookOAuthText({ ...base, scope: null })).toBe(
      'OAuth access tokens from auth.example.com, as client hyfib',
    );
    expect(webhookOAuthText({ ...base, scope: 'read write' })).toBe(
      'OAuth access tokens from auth.example.com, as client hyfib, scope read write',
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

  it('apply to message statuses and campaign changes, whose payloads name the campaign, and no other event', () => {
    expect(WEBHOOK_CAMPAIGN_EVENTS).toEqual(['message.status', 'campaign.status_changed']);
    for (const type of WEBHOOK_EVENT_KEYS) {
      const ofACampaign = WEBHOOK_CAMPAIGN_EVENTS.some((t) => t === type);
      expect(webhookTakesCampaignEvents([type]), type).toBe(ofACampaign);
    }
    // Each names its campaign, so a receiver can tell them apart.
    expect('campaignId' in messageStatusPayloadSchema.shape.data.shape.message.shape).toBe(true);
    expect('id' in campaignStatusChangedPayloadSchema.shape.data.shape.campaign.shape).toBe(true);
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

  it('apply to the four deal events, whose payloads give the pipeline and the one a move left, and to no other event', () => {
    expect(WEBHOOK_PIPELINE_EVENTS).toEqual([
      'deal.created',
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

  it('apply to the two task events, whose payloads give the assignee, and to no other event', () => {
    expect(WEBHOOK_TASK_EVENTS).toEqual(['task.created', 'task.status_changed']);
    for (const type of WEBHOOK_EVENT_KEYS) {
      expect(webhookTakesTaskEvents([type]), type).toBe(type.startsWith('task.'));
    }
    // Deal events are not a task's, even of a deal with tasks.
    expect(webhookTakesTaskEvents(['deal.created', 'deal.status_changed'])).toBe(false);
    expect(webhookTakesTaskEvents(['deal.created', 'task.status_changed'])).toBe(true);
    for (const schema of [taskCreatedPayloadSchema, taskStatusChangedPayloadSchema]) {
      expect('assigneeId' in schema.shape.data.shape.task.shape).toBe(true);
    }
    // The refusal names the events as Settings lists them.
    for (const type of WEBHOOK_TASK_EVENTS) {
      expect(WEBHOOK_TASK_ASSIGNEES_NEED_THE_EVENTS).toContain(WEBHOOK_EVENT_INFO[type].label);
    }
  });

  it('are kept only while the endpoint takes a task event: given, kept, or cleared', () => {
    expect(webhookTaskAssigneeIdsFor(['task.created'], [asha], null)).toEqual([asha]);
    expect(webhookTaskAssigneeIdsFor(['task.status_changed'], undefined, [dev])).toEqual([dev]);
    expect(webhookTaskAssigneeIdsFor(['task.created'], null, [dev])).toBeNull();
    expect(webhookTaskAssigneeIdsFor(['task.status_changed'], undefined, null)).toBeNull();
    expect(
      webhookTaskAssigneeIdsFor(['deal.created', 'contact.created'], [asha], [dev]),
    ).toBeNull();
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
    for (const schema of [automationRunStartedPayloadSchema, automationRunEndedPayloadSchema]) {
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
