import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keyring } from '@w360/core';
import {
  AUTOMATION_END_REASONS,
  CAMPAIGN_COMPLETION_REASONS,
  CAMPAIGN_PAUSE_REASONS,
  CAMPAIGN_STATUSES,
  ORDER_STATUSES,
} from '@w360/db';
import { apiContactSchema } from '../api/contact-view';
import { buildOpenApiDocument } from '../api/openapi';
import { renderEmail } from '../email/templates';
import {
  WEBHOOK_EVENT_INFO,
  WEBHOOK_EVENT_KEYS,
  WEBHOOK_LIMITS,
  WEBHOOK_MESSAGE_STATUS_LABELS,
  WEBHOOK_MESSAGE_STATUSES,
  WEBHOOK_REPLAY_PERIODS,
  WEBHOOK_RETRY_SECONDS,
  webhookErrorLabel,
  webhookHost,
  webhookReplaySummary,
  webhookRetryDelaySeconds,
} from './model';
import {
  automationRunEndedPayloadSchema,
  automationRunStartedPayloadSchema,
  campaignStatusChangedPayloadSchema,
  consentChangedPayloadSchema,
  contactCreatedPayloadSchema,
  contactErasedPayloadSchema,
  contactUpdatedPayloadSchema,
  conversationAssignmentPayloadSchema,
  conversationStatusPayloadSchema,
  conversationTeamPayloadSchema,
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
  webhookHeadersAad,
  webhookHeadersSchema,
  webhookMessageStatusesFor,
  webhookMessageStatusesSchema,
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
    for (const [schema, type] of [
      [contactCreatedPayloadSchema, 'contact.created'],
      [contactUpdatedPayloadSchema, 'contact.updated'],
      [contactErasedPayloadSchema, 'contact.erased'],
    ] as const) {
      for (const shown of [person, erased]) {
        expect(schema.safeParse({ ...base, type, data: { contact: shown } }).success, type).toBe(
          true,
        );
      }
      // Custom field values are strings, numbers or booleans (ADR-112).
      for (const fields of [{ city: null }, { city: ['a'] }, { city: { name: 'a' } }]) {
        const shown = { ...person, fields };
        expect(schema.safeParse({ ...base, type, data: { contact: shown } }).success, type).toBe(
          false,
        );
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
          },
          channel: null,
        },
      }).success,
    ).toBe(true);
    // An unknown status or reason, a fractional count or another type is not described.
    for (const change of [
      { status: 'archived' },
      { previousStatus: 'sent' },
      { pauseReason: 'tired' },
      { completionReason: 'done' },
      { queuedCount: 1.5 },
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
