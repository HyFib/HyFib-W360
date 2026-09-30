import { describe, expect, it } from 'vitest';
import { ALL_QUEUES, DEFAULT_MAX_WAIT_MINUTES, queueMaxWaitMinutes } from '@w360/contracts';
import type { Database } from '@w360/db';
import { emailPayloadSchema } from '../email/templates';
import {
  QUEUE_ALERT_INTERVAL_MINUTES,
  alertLateQueues,
  lateQueueAlert,
  queueWaitLimits,
  waitLabel,
  type LateQueue,
} from './queue-waits';

const BASE = 'https://app.w360.test';
const CHECKED = new Date('2026-09-30T12:00:00Z');

const late = (
  queue: string,
  waiting: number,
  waitedMinutes: number,
  limitMinutes = 15,
): LateQueue => ({
  queue,
  waiting,
  oldestWaitingSince: new Date(CHECKED.getTime() - waitedMinutes * 60_000),
  limitMinutes,
  checkedAt: CHECKED,
});

describe('queue wait limits (ADR-096)', () => {
  it('gives every declared queue a limit, longer only for long jobs run one or two at a time', () => {
    const limits = queueWaitLimits(ALL_QUEUES);
    expect(limits.map((l) => l.name)).toEqual(ALL_QUEUES.map((q) => q.name));
    for (const limit of limits) {
      expect(limit.limitMinutes, limit.name).toBeGreaterThanOrEqual(1);
      expect(limit.limitMinutes, limit.name).toBeLessThanOrEqual(1440);
    }
    expect(
      limits
        .filter((l) => l.limitMinutes !== DEFAULT_MAX_WAIT_MINUTES)
        .map((l) => [l.name, l.limitMinutes])
        .sort(),
    ).toEqual([
      ['billing.settlement-recon', 60],
      ['commerce.store', 60],
      ['commerce.sync', 60],
      ['template.sync', 60],
      ['tenant.delete', 60],
    ]);
    expect(DEFAULT_MAX_WAIT_MINUTES).toBe(15);
    expect(queueMaxWaitMinutes({ ...ALL_QUEUES[0]!, maxWaitMinutes: 5 })).toBe(5);
  });
});

describe('the alert about late queues (ADR-096)', () => {
  it('says waits in whole minutes and hours', () => {
    expect(waitLabel(-5_000)).toBe('under a minute');
    expect(waitLabel(59_999)).toBe('under a minute');
    expect(waitLabel(60_000)).toBe('1 minute');
    expect(waitLabel(23 * 60_000 + 59_000)).toBe('23 minutes');
    expect(waitLabel(60 * 60_000)).toBe('1 hour');
    expect(waitLabel(125 * 60_000)).toBe('2 hours 5 minutes');
    expect(waitLabel(121 * 60_000)).toBe('2 hours 1 minute');
  });

  it('names each late queue with its jobs, its oldest wait and its limit, the longest wait first', () => {
    const alert = lateQueueAlert(
      [late('email.send', 1, 16), late('message.send', 1204, 83), late('tenant.delete', 2, 61, 60)],
      BASE,
    );
    expect(alert.subject).toBe('3 queues are falling behind');
    expect(alert.url).toBe(`${BASE}/platform/ops/queues`);
    expect(alert.actionLabel).toBe('Open queues');
    expect(alert.lines).toEqual([
      '3 queues have jobs waiting for a worker longer than their limits:',
      'message.send: 1204 jobs waiting, the oldest for 1 hour 23 minutes (its limit is 15 minutes).',
      'tenant.delete: 2 jobs waiting, the oldest for 1 hour 1 minute (its limit is 60 minutes).',
      'email.send: 1 job waiting, the oldest for 16 minutes (its limit is 15 minutes).',
      'Jobs wait when the worker is stopped, busy with other work, or cannot reach the database. Look at the worker’s health and logs; Operations → Queues shows every queue’s counts and waits.',
      `This email gives queue names and counts only. A queue is told again only after it has caught up and falls behind again; further alerts come at most every ${QUEUE_ALERT_INTERVAL_MINUTES} minutes.`,
    ]);
    expect(emailPayloadSchema.safeParse({ kind: 'platform.notice', ...alert }).success).toBe(true);
    const one = lateQueueAlert([late('webhook.deliver', 7, 20)], BASE);
    expect(one.subject).toBe('Queue webhook.deliver is falling behind');
    expect(one.lines[0]).toBe('A queue has jobs waiting for a worker longer than its limit:');
  });

  it('names seven queues at most and counts the rest, with long names shortened, within a notice', () => {
    const name = (n: number) => `q${n}.${'x'.repeat(97)}`;
    const queues = Array.from({ length: 12 }, (_, i) => late(name(i), 1, 100 - i));
    const alert = lateQueueAlert(queues, BASE);
    expect(alert.subject).toMatch(/^12 queues are falling behind$/);
    const named = alert.lines.filter((l) => /^q\d+\./.test(l));
    expect(named).toHaveLength(7);
    expect(named.every((l) => l.includes('…:'))).toBe(true);
    expect(alert.lines).toContain('And 5 more queues: Operations → Queues lists them.');
    // Within the notice's limits: 12 lines at most, 600 characters each, whatever the names.
    expect(emailPayloadSchema.safeParse({ kind: 'platform.notice', ...alert }).success).toBe(true);
    // Eight fit without a count.
    const eight = lateQueueAlert(queues.slice(0, 8), BASE);
    expect(eight.lines.filter((l) => /^q\d+\./.test(l))).toHaveLength(8);
    expect(eight.lines.some((l) => l.startsWith('And '))).toBe(false);
    expect(emailPayloadSchema.safeParse({ kind: 'platform.notice', ...eight }).success).toBe(true);
  });

  it('marks nothing and reports the late queues while there is no platform administrator', async () => {
    const calls: string[] = [];
    // Answers the due count and the recipients; marking would be a third call.
    const answers = [{ rows: [{ due: 2 }] }, { rows: [] }];
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
    const result = await alertLateQueues({ db, outbox: {} as never, appBaseUrl: BASE });
    expect(result).toEqual({ alerted: 0, unsent: 2, recipients: 0 });
    expect(calls).toHaveLength(2);
  });
});
