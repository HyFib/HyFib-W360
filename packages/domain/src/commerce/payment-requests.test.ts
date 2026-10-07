import { describe, expect, it } from 'vitest';
import { QUEUES } from '@w360/contracts';
import { isAppError } from '@w360/core';
import type { Tx } from '@w360/db';
import { COMMERCE_LIMITS } from './model';
import { writePaymentLinkCancel, writePaymentRequest, type PayableOrder } from './service';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const ORDER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
const CONVERSATION = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03';
const MEMBER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f04';
const WRITER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f05';
const LINK = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f06';
const NOW = new Date('2026-10-07T10:00:00.000Z');

const payable: PayableOrder = {
  id: ORDER,
  status: 'confirmed',
  droppedItems: 0,
  currency: 'INR',
  subtotalMinor: 49_900,
  conversationId: CONVERSATION,
  version: 3,
};

/** A transaction that fails the test if anything is read or written. */
const untouched = new Proxy(
  {},
  {
    get: () => {
      throw new Error('used the transaction');
    },
  },
) as Tx;

/**
 * A transaction that answers reads with `rows` and records what is inserted and updated, and jobs
 * that record what is enqueued and signed.
 */
function recorder(rows: unknown[]) {
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const result = Object.assign(Promise.resolve(rows), { for: () => Promise.resolve(rows) });
  const tx = {
    select: () => ({ from: () => ({ where: () => result }) }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserts.push(values);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updates.push(values);
          return Promise.resolve();
        },
      }),
    }),
  } as unknown as Tx;
  const enqueued: { queue: unknown; envelope: unknown; options: unknown }[] = [];
  const deps = {
    jobs: {
      enqueue: (_tx: unknown, queue: unknown, envelope: unknown, options: unknown) => {
        enqueued.push({ queue, envelope, options });
        return Promise.resolve('job');
      },
    },
    signer: { sign: (input: unknown) => input },
    clock: { now: () => NOW },
  } as unknown as Parameters<typeof writePaymentLinkCancel>[1];
  return { tx, deps, inserts, updates, enqueued };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return [error.code, error.publicMessage];
  }
  throw new Error('expected a refusal');
}

describe('asking a customer to pay an order (ADR-283, shared by members and keys)', () => {
  const ask = (order: Partial<PayableOrder>) =>
    refusal(
      writePaymentRequest(
        untouched,
        recorder([]).deps,
        TENANT,
        { ...payable, ...order },
        { apiKeyId: WRITER },
        NOW,
      ),
    );

  it('refuses what cannot be paid with a link before reading anything', async () => {
    for (const status of ['awaiting_payment', 'paid', 'fulfilled', 'cancelled'] as const) {
      expect(await ask({ status })).toEqual([
        'conflict',
        'Payment can be requested only for received or confirmed orders.',
      ]);
    }
    expect((await ask({ droppedItems: 1 }))[0]).toBe('precondition_failed');
    expect(await ask({ currency: 'USD' })).toEqual([
      'precondition_failed',
      'Payment Links are for amounts in Indian rupees.',
    ]);
    expect(await ask({ currency: null })).toEqual([
      'precondition_failed',
      'Payment Links are for amounts in Indian rupees.',
    ]);
    expect(await ask({ subtotalMinor: null })).toEqual([
      'precondition_failed',
      'The order total could not be worked out from the prices WhatsApp sent.',
    ]);
    expect(await ask({ subtotalMinor: COMMERCE_LIMITS.minPaymentMinor - 1 })).toEqual([
      'precondition_failed',
      'Razorpay needs at least ₹1.',
    ]);
    expect((await ask({ subtotalMinor: COMMERCE_LIMITS.maxPaymentMinor + 1 }))[1]).toContain(
      'HyFib asks for at most',
    );
  });

  it('needs the company’s Razorpay account checked', async () => {
    for (const [rows, message] of [
      [[], 'Add your Razorpay account in Commerce → Payments first.'],
      [
        [{ status: 'failed' }],
        'Your Razorpay account has not been checked successfully. Check it in Commerce → Payments.',
      ],
    ] as const) {
      const r = recorder([...rows]);
      expect(
        await refusal(
          writePaymentRequest(r.tx, r.deps, TENANT, payable, { apiKeyId: WRITER }, NOW),
        ),
      ).toEqual(['precondition_failed', message]);
      expect([r.inserts, r.updates, r.enqueued]).toEqual([[], [], []]);
    }
  });

  it('writes the link ahead for the worker, as the key, and the order waits for payment', async () => {
    const r = recorder([{ status: 'verified' }]);
    const asked = await writePaymentRequest(
      r.tx,
      r.deps,
      TENANT,
      { ...payable, subtotalMinor: COMMERCE_LIMITS.minPaymentMinor },
      { apiKeyId: WRITER },
      NOW,
    );
    expect(asked.version).toBe(4);
    expect(r.inserts).toEqual([
      {
        id: asked.linkId,
        tenantId: TENANT,
        orderId: ORDER,
        conversationId: CONVERSATION,
        reference: expect.stringMatching(/^w360_/),
        amountMinor: COMMERCE_LIMITS.minPaymentMinor,
        currency: 'INR',
        expiresAt: new Date(NOW.getTime() + COMMERCE_LIMITS.paymentLinkDays * 86_400_000),
        nextCheckAt: NOW,
        createdByMembershipId: null,
        createdByApiKeyId: WRITER,
      },
    ]);
    expect(r.updates).toEqual([
      {
        status: 'awaiting_payment',
        statusChangedAt: NOW,
        version: 4,
        statusChangedBy: 'api',
        statusChangedByApiKeyId: WRITER,
        statusChangedXact: expect.anything(),
      },
    ]);
    expect(r.enqueued).toEqual([
      {
        queue: QUEUES.commerceLink.name,
        envelope: { kind: 'commerce.link', tenantId: TENANT, actorUserId: null, ref: asked.linkId },
        options: { singletonKey: `${asked.linkId}:create` },
      },
    ]);
  });

  it('records a member’s request as the member’s, and the most HyFib asks for is allowed', async () => {
    const r = recorder([{ status: 'verified' }]);
    const asked = await writePaymentRequest(
      r.tx,
      r.deps,
      TENANT,
      { ...payable, status: 'received', subtotalMinor: COMMERCE_LIMITS.maxPaymentMinor },
      { membershipId: MEMBER, userId: 'user-1' },
      NOW,
    );
    expect(r.inserts[0]).toMatchObject({
      createdByMembershipId: MEMBER,
      createdByApiKeyId: null,
      amountMinor: COMMERCE_LIMITS.maxPaymentMinor,
    });
    expect(r.updates[0]).toMatchObject({
      statusChangedBy: 'member',
      statusChangedByApiKeyId: null,
    });
    expect(r.enqueued[0]?.envelope).toEqual({
      kind: 'commerce.link',
      tenantId: TENANT,
      actorUserId: 'user-1',
      ref: asked.linkId,
    });
  });
});

describe('cancelling an order’s open Payment Link (ADR-283, shared by members and keys)', () => {
  it('asks the worker to cancel it once, and refuses an order without an open link', async () => {
    const open = recorder([{ id: LINK, cancelRequestedAt: null }]);
    expect(await writePaymentLinkCancel(open.tx, open.deps, TENANT, ORDER, null)).toEqual({
      requested: true,
    });
    expect(open.updates).toEqual([
      { cancelRequestedAt: NOW, nextCheckAt: NOW, version: expect.anything() },
    ]);
    expect(open.enqueued).toEqual([
      {
        queue: QUEUES.commerceLink.name,
        envelope: { kind: 'commerce.link', tenantId: TENANT, actorUserId: null, ref: LINK },
        options: { singletonKey: `${LINK}:cancel` },
      },
    ]);

    const again = recorder([{ id: LINK, cancelRequestedAt: NOW }]);
    expect(await writePaymentLinkCancel(again.tx, again.deps, TENANT, ORDER, 'user-1')).toEqual({
      requested: false,
    });
    expect([again.updates, again.enqueued]).toEqual([[], []]);

    const none = recorder([]);
    expect(await refusal(writePaymentLinkCancel(none.tx, none.deps, TENANT, ORDER, null))).toEqual([
      'conflict',
      'This order has no open Payment Link.',
    ]);
  });
});
