import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keyring } from '@w360/core';
import {
  ACTIVE_RUN_STATUSES,
  AUTOMATION_END_REASONS,
  AUTOMATION_RUN_STATUSES,
  CAMPAIGN_COMPLETION_REASONS,
  CAMPAIGN_PAUSE_REASONS,
  CAMPAIGN_STATUSES,
  CONVERSATION_STATUSES,
  ORDER_STATUSES,
  TEMPLATE_STATUSES,
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
  WEBHOOK_CONTACT_PART_LABELS,
  WEBHOOK_CONTACT_PARTS,
  WEBHOOK_CONVERSATION_STATUS_LABELS,
  WEBHOOK_CONVERSATION_STATUSES,
  WEBHOOK_RUN_END_STATUS_LABELS,
  WEBHOOK_RUN_END_STATUSES,
  WEBHOOK_EVENT_INFO,
  WEBHOOK_EVENT_KEYS,
  WEBHOOK_LIMITS,
  WEBHOOK_MESSAGE_STATUS_LABELS,
  WEBHOOK_MESSAGE_STATUSES,
  WEBHOOK_ORDER_STATUS_LABELS,
  WEBHOOK_ORDER_STATUSES,
  WEBHOOK_REPLAY_PERIODS,
  WEBHOOK_RETRY_SECONDS,
  WEBHOOK_TEMPLATE_STATUS_LABELS,
  WEBHOOK_TEMPLATE_STATUSES,
  webhookErrorLabel,
  webhookHost,
  webhookReplaySummary,
  webhookRetryDelaySeconds,
  webhookTakesAutomationRuns,
} from './model';
import {
  automationRunEndedPayloadSchema,
  automationRunStartedPayloadSchema,
  campaignStatusChangedPayloadSchema,
  consentChangedPayloadSchema,
  contactCreatedPayloadSchema,
  contactErasedPayloadSchema,
  contactUpdatedPayloadSchema,
  CONTACT_CHANGE_PART_RE,
  conversationAssignmentPayloadSchema,
  conversationStatusPayloadSchema,
  conversationTeamPayloadSchema,
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
  openWebhookHeaders,
  reservedWebhookHeader,
  sealWebhookHeaders,
  webhookAutomationIdsFor,
  webhookAutomationIdsSchema,
  webhookCampaignStatusesFor,
  webhookCampaignStatusesSchema,
  webhookContactPartsFor,
  webhookContactPartsSchema,
  webhookConversationStatusesFor,
  webhookConversationStatusesSchema,
  webhookRunEndStatusesFor,
  webhookRunEndStatusesSchema,
  webhookHeadersAad,
  webhookHeadersSchema,
  webhookMessageStatusesFor,
  webhookMessageStatusesSchema,
  webhookOrderStatusesFor,
  webhookOrderStatusesSchema,
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
          },
          error: { code: '131026', title: 'Message undeliverable' },
          conversation,
          contact,
          channel,
        },
      }).success,
    ).toBe(true);
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
    const changes = { 'contact.updated': ['email', 'fields.city', 'tags'] };
    for (const [schema, type] of [
      [contactCreatedPayloadSchema, 'contact.created'],
      [contactUpdatedPayloadSchema, 'contact.updated'],
      [contactErasedPayloadSchema, 'contact.erased'],
    ] as const) {
      const data = (shown: unknown) =>
        type === 'contact.updated'
          ? { contact: shown, changes: changes[type] }
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
    // A contact reads as the API's contact, and whether it was erased.
    expect(Object.keys(contactCreatedPayloadSchema.shape.data.shape.contact.shape).sort()).toEqual(
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
      contactUpdatedPayloadSchema.safeParse({ ...base, type: 'contact.updated', data }).success;
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
});

describe('the OpenAPI document', () => {
  it('describes each webhook with its signed headers and a body schema that exists', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    expect(Object.keys(doc.webhooks)).toEqual([...WEBHOOK_EVENT_KEYS, 'ping']);
    expect(Object.keys(WEBHOOK_EVENT_INFO)).toEqual([...WEBHOOK_EVENT_KEYS]);
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
      'automation.run_started',
      'automation.run_ended',
      'order.received',
      'order.status_changed',
      'campaign.status_changed',
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
    expect(data.required).toEqual(['contact', 'changes']);
    const list = data.properties.changes?.anyOf?.find((s) => s.items);
    expect(list?.items?.pattern).toBe(CONTACT_CHANGE_PART_RE.source);
    expect(data.properties.changes?.anyOf).toContainEqual({ type: 'null' });
    const webhooks = doc.webhooks as Record<string, { post?: { description?: string } }>;
    expect(webhooks['contact.updated']?.post?.description).toContain('The event says which.');
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
