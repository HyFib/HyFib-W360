import { describe, expect, it } from 'vitest';
import type { Database } from '@w360/db';
import { emailPayloadSchema } from '../email/templates';
import { alertFailures, failureAlert, type FailureAlertCount } from './failure-alerts';

const BASE = 'https://app.w360.test';

describe('the alert about work that failed for good (ADR-091)', () => {
  it('counts dead letters by queue, receipts by provider and unmatched events by reason', () => {
    const alert = failureAlert(
      [
        { source: 'dead_letter', label: 'whatsapp.send', items: 3 },
        { source: 'dead_letter', label: 'commerce.store', items: 1 },
        { source: 'receipt', label: 'razorpay', items: 1 },
        { source: 'quarantine', label: 'meta_whatsapp:unknown_asset', items: 2 },
      ],
      BASE,
    );
    expect(alert.subject).toBe('7 failures need a look');
    expect(alert.url).toBe(`${BASE}/platform/ops`);
    expect(alert.lines).toEqual([
      '4 jobs used all their retries and went to the dead-letter queue: whatsapp.send 3, commerce.store 1. The minute sweeps signal most work again, so look for the cause in the worker’s logs. Operations → Queues lists them.',
      '1 provider webhook receipt used all 12 processing attempts: Razorpay 1. Once the cause is fixed, retry it on Operations → Integrations within 7 days of receipt, while its body is kept.',
      '2 provider events could not be matched to a company: Meta (WhatsApp), unknown account or number 2. Review them on Operations → Integrations.',
      'This alert gives counts only: the companies, receipts and errors are on the operations console. Further alerts come at most every 15 minutes.',
    ]);
    expect(() => emailPayloadSchema.parse({ kind: 'platform.notice', ...alert })).not.toThrow();
  });

  it('links the tab that lists what it tells, and says one item as one', () => {
    const one = failureAlert([{ source: 'dead_letter', label: 'billing.sweep', items: 1 }], BASE);
    expect(one.subject).toBe('1 failure needs a look');
    expect(one.url).toBe(`${BASE}/platform/ops/queues`);
    expect(one.lines[0]).toMatch(/^1 job used all its retries/);
    const receipts = failureAlert([{ source: 'receipt', label: 'meta_whatsapp', items: 2 }], BASE);
    expect(receipts.url).toBe(`${BASE}/platform/ops/integrations`);
    expect(receipts.lines[0]).toContain('retry them');
  });

  it('names six entries a line at most and counts the rest, within a notice line', () => {
    const counts: FailureAlertCount[] = Array.from({ length: 40 }, (_, i) => ({
      source: 'dead_letter',
      label: `queue.with-a-rather-long-name-${String(i).padStart(2, '0')}`,
      items: i + 1,
    }));
    const alert = failureAlert(counts, BASE);
    const line = alert.lines[0]!;
    // The six largest, then the rest counted: 1 + … + 34 = 595.
    expect(line).toContain('queue.with-a-rather-long-name-39 40');
    expect(line).toContain('queue.with-a-rather-long-name-34 35 and 595 more.');
    expect(line).not.toContain('queue.with-a-rather-long-name-33 ');
    expect(() => emailPayloadSchema.parse({ kind: 'platform.notice', ...alert })).not.toThrow();
  });

  it('shortens long queue names, so the longest names the tables allow still fit a notice', () => {
    // Queue names of 100 characters (the most ops.dead_letters allows), every provider and every
    // quarantine reason, each with a four-digit count.
    const longQueue = (i: number) => `q${String(i).padStart(2, '0')}.${'x'.repeat(96)}`;
    const counts: FailureAlertCount[] = [
      ...Array.from({ length: 12 }, (_, i) => ({
        source: 'dead_letter' as const,
        label: longQueue(i),
        items: 9000 + i,
      })),
      { source: 'receipt', label: 'meta_whatsapp', items: 9999 },
      { source: 'receipt', label: 'razorpay', items: 9999 },
      ...['meta_whatsapp', 'razorpay'].flatMap((provider) =>
        ['unknown_asset', 'asset_mismatch', 'malformed', 'unsupported_object'].map((reason) => ({
          source: 'quarantine' as const,
          label: `${provider}:${reason}`,
          items: 9999,
        })),
      ),
    ];
    expect(longQueue(0)).toHaveLength(100);
    const alert = failureAlert(counts, BASE);
    expect(() => emailPayloadSchema.parse({ kind: 'platform.notice', ...alert })).not.toThrow();
    const deadLetters = alert.lines[0]!;
    expect(deadLetters).toContain(`${longQueue(11).slice(0, 39)}… 9011`);
    expect(deadLetters).not.toContain(longQueue(11));
    // Labelled providers and reasons are never shortened.
    expect(alert.lines[2]).toContain(
      'Meta (WhatsApp), number not in the account it came with 9999',
    );
  });

  it('marks nothing and reports what waits while there is no platform administrator', async () => {
    const calls: string[] = [];
    // Answers the sweep's three reads in order; marking would be a fourth call.
    const answers = [{ rows: [{ due: 3 }] }, { rows: [] }];
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
    const result = await alertFailures({
      db,
      outbox: {} as never,
      appBaseUrl: BASE,
    });
    expect(result).toEqual({ alerted: 0, unsent: 3, recipients: 0, posted: false });
    expect(calls).toHaveLength(2);
  });
});
