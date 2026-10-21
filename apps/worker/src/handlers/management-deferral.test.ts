import { describe, expect, it } from 'vitest';
import { QUEUES } from '@w360/contracts';
import { pausedJobKey } from '@w360/domain';
import { RetryableJobError } from './email';
import { PAUSE_DEFERRAL_QUEUES, deferPausedWork } from './management-deferral';

/** What the worker does with a job whose work Meta's pause deferred (ADR-399). */
const PAUSED_UNTIL = new Date('2026-10-16T10:05:00.000Z');

function fakeRuntime(enqueued: string | null = 'queued-id') {
  const sent: { queue: string; envelope: unknown; options: unknown }[] = [];
  const logs: { facts: Record<string, unknown>; message: string }[] = [];
  const rt = {
    jobs: {
      enqueue: async (_tx: unknown, queue: string, envelope: unknown, options: unknown) => {
        sent.push({ queue, envelope, options });
        return enqueued;
      },
    },
    signer: { sign: (input: unknown) => ({ signed: input }) },
    // The pause ends 5 minutes from this worker's now.
    clock: { now: () => new Date(PAUSED_UNTIL.getTime() - 300_000) },
    logger: {
      info: (facts: Record<string, unknown>, message: string) => logs.push({ facts, message }),
    },
  } as unknown as Parameters<typeof deferPausedWork>[0];
  return { rt, sent, logs };
}

const work = (kind: string) => ({
  jobId: 'job-7',
  kind,
  tenantId: '01900000-0000-7000-8000-000000000001',
  actorUserId: 'user-1',
  ref: '01900000-0000-7000-8000-000000000002',
  pausedUntil: PAUSED_UNTIL,
});

describe('deferPausedWork', () => {
  it('queues each paced kind on its own queue, keyed by the deferring job, after the pause', async () => {
    const expected: [string, string][] = [
      ['template.submit', QUEUES.templateSubmit.name],
      ['template.delete', QUEUES.templateDelete.name],
      ['template.edit', QUEUES.templateEdit.name],
      ['flow.sync', QUEUES.flowSync.name],
      ['flow.keys', QUEUES.flowKeys.name],
      ['commerce.sync', QUEUES.commerceSync.name],
      ['channel.onboard', QUEUES.channelOnboard.name],
    ];
    for (const [kind, queue] of expected) {
      const { rt, sent, logs } = fakeRuntime();
      await deferPausedWork(rt, work(kind));
      expect(sent, kind).toEqual([
        {
          queue,
          envelope: {
            signed: {
              kind,
              tenantId: work(kind).tenantId,
              actorUserId: 'user-1',
              ref: work(kind).ref,
            },
          },
          options: {
            singletonKey: pausedJobKey('job-7'),
            // Seconds from the database's now: until 30 seconds after the pause.
            startAfter: 330,
          },
        },
      ]);
      expect(logs[0]?.message).toMatch(/queued for after the pause/);
    }
  });

  it('queues nothing for a template sync, which the sweep signals after the pause', async () => {
    const { rt, sent, logs } = fakeRuntime();
    await deferPausedWork(rt, work('template.sync'));
    expect(sent).toEqual([]);
    expect(logs[0]?.facts.resumeAt).toBeNull();
    expect(logs[0]?.message).toMatch(/the sweep signals it after the pause/);
    expect(PAUSE_DEFERRAL_QUEUES['template.sync']).toBeNull();
  });

  it('fails the job for a retry when the deferral was not queued', async () => {
    const { rt, logs } = fakeRuntime(null);
    await expect(deferPausedWork(rt, work('flow.keys'))).rejects.toBeInstanceOf(RetryableJobError);
    expect(logs).toEqual([]);
  });

  it('refuses a kind that is not paced (commerce links and accounts go to Razorpay)', async () => {
    for (const kind of ['commerce.link', 'commerce.account', 'toString']) {
      const { rt, sent } = fakeRuntime();
      await expect(deferPausedWork(rt, work(kind))).rejects.toThrow(/not paced/);
      expect(sent).toEqual([]);
    }
  });
});
