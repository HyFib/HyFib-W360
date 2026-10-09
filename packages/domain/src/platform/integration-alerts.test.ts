import { describe, expect, it } from 'vitest';
import type { Database } from '@w360/db';
import { emailPayloadSchema } from '../email/templates';
import {
  alertIntegrationFailures,
  integrationAlert,
  type IntegrationAlertCount,
} from './integration-alerts';
import { INTEGRATION_SOURCE_LABELS, INTEGRATION_STATE_LABELS } from './ops-model';

const BASE = 'https://app.w360.test';

describe('the alert about companies’ failing integrations (ADR-139)', () => {
  it('counts failures by the console’s kinds, largest first, and links the Integrations tab', () => {
    const alert = integrationAlert(
      [
        { source: 'whatsapp_number', state: 'needs_reconnect', items: 1 },
        { source: 'webhook_endpoint', state: 'failing', items: 3 },
        { source: 'whatsapp_webhooks', state: 'not_subscribed', items: 1 },
        { source: 'store', state: 'sync_error', items: 0 },
      ],
      BASE,
    );
    expect(alert.subject).toBe('5 company integrations are failing');
    expect(alert.url).toBe(`${BASE}/platform/ops/integrations`);
    expect(alert.actionLabel).toBe('Open integrations');
    expect(alert.lines).toEqual([
      'Operations → Integrations lists 5 failing integrations of companies that platform staff were not alerted about yet: Webhook endpoint, failing 3; WhatsApp number, needs reconnecting 1; WhatsApp webhooks, not subscribed 1.',
      'This alert gives counts only: the companies and errors are on the operations console. Each failure is told once while it lasts, and further alerts come at most every 15 minutes.',
    ]);
    expect(() => emailPayloadSchema.parse({ kind: 'platform.notice', ...alert })).not.toThrow();
  });

  it('says one failure as one', () => {
    const alert = integrationAlert([{ source: 'store', state: 'failed', items: 1 }], BASE);
    expect(alert.subject).toBe('1 company integration is failing');
    expect(alert.lines[0]).toBe(
      'Operations → Integrations lists 1 failing integration of companies that platform staff were not alerted about yet: Store, failed 1.',
    );
  });

  it('names six kinds at most and counts the rest, so every kind the console has fits a notice', () => {
    // Every source and state the console's list produces, each with a five-digit count.
    const kinds: [string, string][] = [
      ['whatsapp_number', 'needs_reconnect'],
      ['whatsapp_number', 'failed'],
      ['whatsapp_account', 'needs_reconnect'],
      ['whatsapp_access_check', 'not_checked'],
      ['whatsapp_webhooks', 'not_subscribed'],
      ['whatsapp_webhooks', 'not_checked'],
      ['store', 'failed'],
      ['store', 'sync_error'],
      ['store', 'webhook_error'],
      ['payment_account', 'failed'],
      ['catalog_sync', 'failed'],
      ['flow_sync', 'failed'],
      ['webhook_endpoint', 'failing'],
      ['webhook_endpoint', 'disabled'],
    ];
    for (const [source, state] of kinds) {
      expect(INTEGRATION_SOURCE_LABELS[source]).toBeDefined();
      expect(INTEGRATION_STATE_LABELS[state]).toBeDefined();
    }
    const counts: IntegrationAlertCount[] = kinds.map(([source, state], i) => ({
      source,
      state,
      items: 90000 + i,
    }));
    const alert = integrationAlert(counts, BASE);
    const line = alert.lines[0]!;
    // The six largest (indexes 13 down to 8), then the other eight counted: 720028.
    expect(line).toContain('Webhook endpoint, turned off for failing 90013');
    expect(line).toContain('Store, webhook error 90008 and 720028 more.');
    expect(line).not.toContain('Store, sync error');
    expect(() => emailPayloadSchema.parse({ kind: 'platform.notice', ...alert })).not.toThrow();
  });

  it('marks nothing and reports what waits while there is no platform administrator', async () => {
    const calls: string[] = [];
    // Answers the sweep's check and its read of recipients; marking would be a third call.
    const answers = [{ rows: [{ due: 4 }] }, { rows: [] }];
    const db = {
      run: async (_scope: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          execute: async (query: unknown) => {
            calls.push(String(query));
            const next = answers.shift();
            if (!next) throw new Error('marked without a recipient');
            return next;
          },
        }),
    } as unknown as Database;
    const result = await alertIntegrationFailures({ db, outbox: {} as never, appBaseUrl: BASE });
    expect(result).toEqual({ alerted: 0, unsent: 4, recipients: 0, posted: false });
    expect(calls).toHaveLength(2);
  });

  it('reads nothing more when no failure waits', async () => {
    let calls = 0;
    const db = {
      run: async (_scope: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          execute: async () => {
            calls += 1;
            if (calls > 1) throw new Error('read recipients with nothing to tell');
            return { rows: [{ due: 0 }] };
          },
        }),
    } as unknown as Database;
    expect(await alertIntegrationFailures({ db, outbox: {} as never, appBaseUrl: BASE })).toEqual({
      alerted: 0,
      unsent: 0,
      recipients: 0,
      posted: false,
    });
  });
});
