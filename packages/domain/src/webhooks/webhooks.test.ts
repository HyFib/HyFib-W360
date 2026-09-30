import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
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
    expect(webhookErrorLabel(null, null)).toBeNull();
    expect(webhookErrorLabel('something_new', null)).toBe('something_new');
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
