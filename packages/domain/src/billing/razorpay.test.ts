import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RazorpayClient,
  verifyCheckoutSignature,
  verifyRazorpayWebhookSignature,
  verifySubscriptionCheckoutSignature,
} from './razorpay';

const hmac = (secret: string, data: string | Buffer) =>
  createHmac('sha256', secret).update(data).digest('hex');

describe('Razorpay signatures', () => {
  const body = Buffer.from('{"event":"payment.captured","payload":{}}');

  it('accepts the current or previous webhook secret and nothing else', () => {
    expect(verifyRazorpayWebhookSignature(body, hmac('current', body), ['current', 'old'])).toBe(
      true,
    );
    expect(verifyRazorpayWebhookSignature(body, hmac('old', body), ['current', 'old'])).toBe(true);
    expect(verifyRazorpayWebhookSignature(body, hmac('other', body), ['current', 'old'])).toBe(
      false,
    );
    expect(
      verifyRazorpayWebhookSignature(body, hmac('current', body).toUpperCase(), ['current']),
    ).toBe(true);
  });

  it('rejects missing, malformed and tampered signatures', () => {
    expect(verifyRazorpayWebhookSignature(body, null, ['current'])).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, 'not-hex', ['current'])).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, hmac('current', body), [])).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, hmac('current', body), [''])).toBe(false);
    const tampered = Buffer.from(body.toString().replace('captured', 'failed'));
    expect(verifyRazorpayWebhookSignature(tampered, hmac('current', body), ['current'])).toBe(
      false,
    );
  });

  it('verifies a subscription’s checkout response as payment id, then our subscription id', () => {
    const signature = hmac('key-secret', 'pay_1|sub_A');
    expect(verifySubscriptionCheckoutSignature('sub_A', 'pay_1', signature, 'key-secret')).toBe(
      true,
    );
    expect(verifySubscriptionCheckoutSignature('sub_B', 'pay_1', signature, 'key-secret')).toBe(
      false,
    );
    // The order-style payload (id first) is not the subscription one.
    expect(
      verifySubscriptionCheckoutSignature(
        'sub_A',
        'pay_1',
        hmac('key-secret', 'sub_A|pay_1'),
        'key-secret',
      ),
    ).toBe(false);
    expect(verifySubscriptionCheckoutSignature('sub_A', 'pay_1', signature, 'other')).toBe(false);
    expect(verifySubscriptionCheckoutSignature('sub_A', 'pay_1', 'zz', 'key-secret')).toBe(false);
  });

  it('verifies the checkout response against our own order id', () => {
    const signature = hmac('key-secret', 'order_A|pay_1');
    expect(verifyCheckoutSignature('order_A', 'pay_1', signature, 'key-secret')).toBe(true);
    expect(verifyCheckoutSignature('order_B', 'pay_1', signature, 'key-secret')).toBe(false);
    expect(verifyCheckoutSignature('order_A', 'pay_2', signature, 'key-secret')).toBe(false);
    expect(verifyCheckoutSignature('order_A', 'pay_1', 'zz', 'key-secret')).toBe(false);
  });
});

describe('RazorpayClient result classification', () => {
  function clientReturning(response: () => Promise<Response>) {
    const seen: { url: string; headers: Headers }[] = [];
    const client = new RazorpayClient({
      baseUrl: 'https://api.razorpay.test',
      keyId: 'rzp_test_unit',
      keySecret: 'unit-secret',
      fetchImpl: async (input, init) => {
        seen.push({ url: String(input), headers: new Headers(init?.headers) });
        return response();
      },
    });
    return { client, seen };
  }
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('maps HTTP outcomes to retryable, permanent, auth and unknown', async () => {
    const cases: [Response, string][] = [
      [json(401, { error: { description: 'bad key' } }), 'auth'],
      [json(429, { error: { description: 'slow down' } }), 'retryable'],
      [json(502, { error: { description: 'bad gateway' } }), 'retryable'],
      [
        json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'amount invalid' } }),
        'permanent',
      ],
      [new Response('not json', { status: 200 }), 'unknown'],
      [json(200, { unexpected: true }), 'unknown'],
    ];
    for (const [response, kind] of cases) {
      const { client } = clientReturning(async () => response);
      const result = await client.fetchPayment('pay_1');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe(kind);
    }
  });

  it('distinguishes a refused connection (not sent) from a lost response (unknown)', async () => {
    const refused = clientReturning(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    });
    const lost = clientReturning(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    });
    const a = await refused.client.createOrder({ amount: 100, currency: 'INR', receipt: 'r1' });
    const b = await lost.client.createOrder({ amount: 100, currency: 'INR', receipt: 'r1' });
    expect(a.ok || a.kind).toBe('retryable');
    expect(a.ok || a.httpStatus).toBeUndefined();
    expect(b.ok || b.kind).toBe('unknown');
  });

  it('sends credentials only in the Authorization header', async () => {
    const { client, seen } = clientReturning(async () =>
      json(200, { id: 'pay_1', amount: 100, currency: 'INR', status: 'captured', captured: true }),
    );
    const result = await client.fetchPayment('pay_1');
    expect(result.ok).toBe(true);
    expect(seen[0]!.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('rzp_test_unit:unit-secret').toString('base64')}`,
    );
    expect(seen[0]!.url).not.toContain('unit-secret');
  });

  it('refuses refund idempotency keys Razorpay would reject', () => {
    const { client } = clientReturning(async () => json(200, {}));
    expect(() => client.createRefund('pay_1', { amount: 100, idempotencyKey: 'short' })).toThrow();
  });

  it('sends a refund’s notes and reads them back, string values only (R-120)', async () => {
    const refund = (notes: unknown) => ({
      id: 'rfnd_1',
      payment_id: 'pay_1',
      amount: 100,
      status: 'pending',
      notes,
    });
    const sent: { body: unknown; headers: Headers }[] = [];
    const client = new RazorpayClient({
      baseUrl: 'https://api.razorpay.test',
      keyId: 'rzp_test_unit',
      keySecret: 'unit-secret',
      fetchImpl: async (_input, init) => {
        sent.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
        return json(200, refund({ hyfib_plan_refund: 'r-1' }));
      },
    });
    const result = await client.createRefund('pay_1', {
      amount: 100,
      idempotencyKey: 'ppr_request-1',
      notes: { hyfib_plan_refund: 'r-1' },
    });
    expect(sent[0]!.body).toEqual({
      amount: 100,
      speed: 'normal',
      notes: { hyfib_plan_refund: 'r-1' },
    });
    expect(sent[0]!.headers.get('x-refund-idempotency')).toBe('ppr_request-1');
    expect(result).toMatchObject({ ok: true, data: { notes: { hyfib_plan_refund: 'r-1' } } });
    // Razorpay sends [] when there are none; other values are not taken as notes.
    for (const [notes, expected] of [
      [[], {}],
      [null, {}],
      [{ a: 'b', n: 1, o: { x: 'y' } }, { a: 'b' }],
    ] as const) {
      const fetched = clientReturning(async () => json(200, refund(notes)));
      expect(await fetched.client.fetchRefund('pay_1', 'rfnd_1')).toMatchObject({
        ok: true,
        data: { id: 'rfnd_1', paymentId: 'pay_1', amount: 100, notes: expected },
      });
    }
  });
});

describe('RazorpayClient Payment Links', () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const link = (over: Record<string, unknown> = {}) => ({
    id: 'plink_Abc123Def456',
    reference_id: 'w360_abcdefghijklmnopqrst',
    status: 'created',
    amount: 15000,
    amount_paid: 0,
    currency: 'INR',
    short_url: 'https://rzp.io/i/abc123',
    ...over,
  });
  function clientReturning(response: () => Response) {
    const seen: { method: string; url: string; body: unknown }[] = [];
    const client = new RazorpayClient({
      baseUrl: 'https://api.razorpay.test',
      keyId: 'rzp_test_unit',
      keySecret: 'unit-secret',
      fetchImpl: async (input, init) => {
        seen.push({
          method: init?.method ?? 'GET',
          url: String(input),
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        });
        return response();
      },
    });
    return { client, seen };
  }

  it('creates links without partial payments, SMS, email or reminders from Razorpay', async () => {
    const { client, seen } = clientReturning(() => json(200, link()));
    const result = await client.createPaymentLink({
      amount: 15000,
      currency: 'INR',
      referenceId: 'w360_abcdefghijklmnopqrst',
      description: 'Order ABCDEFGH',
      expireBy: 1_900_000_000,
    });
    expect(result).toEqual({
      ok: true,
      data: {
        id: 'plink_Abc123Def456',
        referenceId: 'w360_abcdefghijklmnopqrst',
        status: 'created',
        amount: 15000,
        amountPaid: 0,
        currency: 'INR',
        shortUrl: 'https://rzp.io/i/abc123',
      },
    });
    expect(seen[0]).toEqual({
      method: 'POST',
      url: 'https://api.razorpay.test/v1/payment_links',
      body: {
        amount: 15000,
        currency: 'INR',
        accept_partial: false,
        reference_id: 'w360_abcdefghijklmnopqrst',
        description: 'Order ABCDEFGH',
        expire_by: 1_900_000_000,
        notify: { sms: false, email: false },
        reminder_enable: false,
      },
    });
  });

  it('refuses responses that are not Payment Links and addresses that are not https', async () => {
    const wrongId = await clientReturning(() =>
      json(200, link({ id: 'pay_123456' })),
    ).client.fetchPaymentLink('plink_Abc123Def456');
    expect(wrongId.ok || wrongId.kind).toBe('unknown');
    const insecure = await clientReturning(() =>
      json(200, link({ short_url: 'http://rzp.io/i/abc123' })),
    ).client.fetchPaymentLink('plink_Abc123Def456');
    expect(insecure.ok && insecure.data.shortUrl).toBeNull();
  });

  it('finds a link by its reference in either list shape, and only that reference', async () => {
    for (const key of ['payment_links', 'items']) {
      const { client, seen } = clientReturning(() =>
        json(200, {
          [key]: [link(), link({ id: 'plink_Other123456', reference_id: 'w360_other' })],
        }),
      );
      const found = await client.findPaymentLinksByReference('w360_abcdefghijklmnopqrst');
      expect(found.ok && found.data.map((l) => l.id)).toEqual(['plink_Abc123Def456']);
      expect(new URL(seen[0]!.url).searchParams.get('reference_id')).toBe(
        'w360_abcdefghijklmnopqrst',
      );
    }
    const unknownShape = await clientReturning(() =>
      json(200, { count: 0 }),
    ).client.findPaymentLinksByReference('w360_abcdefghijklmnopqrst');
    expect(unknownShape.ok || unknownShape.kind).toBe('unknown');
  });

  it('cancels by id and reports Razorpay’s refusal as permanent', async () => {
    const { client, seen } = clientReturning(() =>
      json(400, {
        error: { code: 'BAD_REQUEST_ERROR', description: 'Payment link cannot be cancelled' },
      }),
    );
    const result = await client.cancelPaymentLink('plink_Abc123Def456');
    expect(result.ok || result.kind).toBe('permanent');
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.razorpay.test/v1/payment_links/plink_Abc123Def456/cancel',
    });
  });
});

describe('RazorpayClient settlement reports', () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  // The documented sample (R-111), trimmed.
  const payment = {
    entity_id: 'pay_DEXrnipqTmWVGE',
    type: 'payment',
    debit: 0,
    credit: 97100,
    amount: 100000,
    currency: 'INR',
    fee: 2900,
    tax: 0,
    on_hold: false,
    settled: true,
    created_at: 1567692556,
    settled_at: 1568176960,
    settlement_id: 'setl_DGlQ1Rj8os78Ec',
    posted_at: null,
    credit_type: 'default',
    description: 'Recurring Payment via Subscription',
    notes: 'Beam me up Scotty.',
    payment_id: null,
    settlement_utr: '1568176960vxp0rj',
    order_id: 'order_DEXrnRiR3SNDHA',
    order_receipt: null,
    method: 'card',
    card_network: 'MasterCard',
    card_issuer: 'KARB',
    card_type: 'credit',
    dispute_id: null,
  };
  function clientReturning(response: () => Response) {
    const seen: string[] = [];
    const client = new RazorpayClient({
      baseUrl: 'https://api.razorpay.test',
      keyId: 'rzp_test_unit',
      keySecret: 'unit-secret',
      fetchImpl: async (input) => {
        seen.push(String(input));
        return response();
      },
    });
    return { client, seen };
  }

  it('asks for one day a page at a time and keeps only what reconciliation needs', async () => {
    const { client, seen } = clientReturning(() =>
      json(200, { entity: 'collection', count: 1, items: [payment] }),
    );
    const result = await client.fetchSettlementRecon({
      date: '2022-06-11',
      count: 1000,
      skip: 2000,
    });
    expect(seen).toEqual([
      'https://api.razorpay.test/v1/settlements/recon/combined?year=2022&month=06&day=11&count=1000&skip=2000',
    ]);
    expect(result).toEqual({
      ok: true,
      data: {
        items: [
          {
            entityId: 'pay_DEXrnipqTmWVGE',
            type: 'payment',
            amount: 100000,
            debit: 0,
            credit: 97100,
            fee: 2900,
            tax: 0,
            currency: 'INR',
            onHold: false,
            settled: true,
            settlementId: 'setl_DGlQ1Rj8os78Ec',
            settlementUtr: '1568176960vxp0rj',
            createdAt: 1567692556,
            settledAt: 1568176960,
            paymentId: null,
            orderId: 'order_DEXrnRiR3SNDHA',
            disputeId: null,
            method: 'card',
          },
        ],
      },
    });
  });

  it('marks an item it cannot read instead of reading it partly', async () => {
    const unreadable = [
      { ...payment, entity_id: undefined },
      { ...payment, entity_id: 'pay with spaces' },
      { ...payment, type: 'Payment!' },
      { ...payment, amount: -1 },
      { ...payment, amount: 10.5 },
      { ...payment, fee: '2900' },
      { ...payment, currency: 'inr' },
      { ...payment, on_hold: 'no' },
      { ...payment, settled_at: 'yesterday' },
      { ...payment, order_id: 'order/../../x' },
      { ...payment, method: 'Card' },
      'not an object',
      ['nor', 'an', 'array'],
      null,
    ];
    const { client } = clientReturning(() =>
      json(200, { entity: 'collection', count: unreadable.length, items: unreadable }),
    );
    const result = await client.fetchSettlementRecon({ date: '2022-06-11', count: 100, skip: 0 });
    expect(result.ok && result.data.items).toEqual(unreadable.map(() => null));
    // Missing optional fields read as absent; missing amounts other than `amount` as zero.
    const sparse = clientReturning(() =>
      json(200, {
        items: [
          { entity_id: 'adj_EhcHONhX4ChgNC', type: 'adjustment', amount: 1012, currency: 'INR' },
        ],
      }),
    );
    const read = await sparse.client.fetchSettlementRecon({
      date: '2022-06-11',
      count: 1,
      skip: 0,
    });
    expect(read.ok && read.data.items[0]).toMatchObject({
      entityId: 'adj_EhcHONhX4ChgNC',
      debit: 0,
      credit: 0,
      fee: 0,
      tax: 0,
      settlementId: null,
      settledAt: null,
      method: null,
    });
    const noItems = clientReturning(() => json(200, { entity: 'collection', count: 0 }));
    const empty = await noItems.client.fetchSettlementRecon({
      date: '2022-06-11',
      count: 1,
      skip: 0,
    });
    expect(empty.ok || empty.kind).toBe('unknown');
  });

  it('refuses a day, page size or offset Razorpay would reject before calling', () => {
    const { client, seen } = clientReturning(() => json(200, { items: [] }));
    expect(() => client.fetchSettlementRecon({ date: '11-06-2022', count: 10, skip: 0 })).toThrow();
    expect(() => client.fetchSettlementRecon({ date: '2022-06-11', count: 0, skip: 0 })).toThrow();
    expect(() =>
      client.fetchSettlementRecon({ date: '2022-06-11', count: 1001, skip: 0 }),
    ).toThrow();
    expect(() =>
      client.fetchSettlementRecon({ date: '2022-06-11', count: 10, skip: -1 }),
    ).toThrow();
    expect(seen).toEqual([]);
  });
});

describe('RazorpayClient subscriptions', () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const subscription = (over: Record<string, unknown> = {}) => ({
    id: 'sub_Abc123',
    entity: 'subscription',
    plan_id: 'plan_Def456',
    status: 'active',
    current_start: 1_790_000_000,
    current_end: 1_792_600_000,
    charge_at: 1_792_600_000,
    ended_at: null,
    paid_count: 1,
    total_count: 60,
    notes: [],
    ...over,
  });
  const invoice = (over: Record<string, unknown> = {}) => ({
    id: 'inv_Ghi789',
    entity: 'invoice',
    subscription_id: 'sub_Abc123',
    payment_id: 'pay_Jkl012',
    status: 'paid',
    amount: 141_482,
    amount_paid: 141_482,
    currency: 'INR',
    paid_at: 1_790_000_100,
    billing_start: 1_790_000_000,
    billing_end: 1_792_600_000,
    customer_details: { email: 'payer@example.test' },
    notes: [],
    ...over,
  });
  function clientReturning(response: () => Response) {
    const seen: { method: string; url: string; body: unknown }[] = [];
    const client = new RazorpayClient({
      baseUrl: 'https://api.razorpay.test',
      keyId: 'rzp_test_unit',
      keySecret: 'unit-secret',
      fetchImpl: async (input, init) => {
        seen.push({
          method: init?.method ?? 'GET',
          url: String(input),
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        });
        return response();
      },
    });
    return { client, seen };
  }

  it('creates a plan for the amount and a subscription that starts at once, with an authorisation deadline', async () => {
    const planned = clientReturning(() =>
      json(200, {
        id: 'plan_Def456',
        period: 'monthly',
        interval: 1,
        item: { amount: 141_482, currency: 'INR' },
      }),
    );
    const plan = await planned.client.createPlan({
      period: 'monthly',
      amount: 141_482,
      currency: 'INR',
      name: 'HyFib Growth plan',
      notes: { purpose: 'plan_subscription' },
    });
    expect(plan).toEqual({
      ok: true,
      data: { id: 'plan_Def456', period: 'monthly', interval: 1, amount: 141_482, currency: 'INR' },
    });
    expect(planned.seen[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.razorpay.test/v1/plans',
      body: {
        period: 'monthly',
        interval: 1,
        item: { name: 'HyFib Growth plan', amount: 141_482, currency: 'INR' },
        notes: { purpose: 'plan_subscription' },
      },
    });
    const created = clientReturning(() =>
      json(
        200,
        subscription({ status: 'created', current_start: null, current_end: null, paid_count: 0 }),
      ),
    );
    const sub = await created.client.createSubscription({
      planId: 'plan_Def456',
      totalCount: 60,
      expireBy: 1_790_003_600,
      customerNotify: true,
    });
    expect(sub).toMatchObject({
      ok: true,
      data: { id: 'sub_Abc123', status: 'created', paidCount: 0 },
    });
    // No start_at: the subscription starts when Checkout takes the first charge.
    expect(created.seen[0]!.body).toEqual({
      plan_id: 'plan_Def456',
      total_count: 60,
      quantity: 1,
      expire_by: 1_790_003_600,
      customer_notify: true,
    });
    // With a start, Razorpay charges the first cycle from then (ADR-102).
    const later = clientReturning(() =>
      json(
        200,
        subscription({ status: 'created', current_start: null, current_end: null, paid_count: 0 }),
      ),
    );
    await later.client.createSubscription({
      planId: 'plan_Def456',
      totalCount: 60,
      expireBy: 1_790_003_600,
      customerNotify: true,
      startAt: 1_790_200_000,
    });
    expect(later.seen[0]!.body).toEqual({
      plan_id: 'plan_Def456',
      total_count: 60,
      quantity: 1,
      expire_by: 1_790_003_600,
      customer_notify: true,
      start_at: 1_790_200_000,
    });
    const cancel = clientReturning(() =>
      json(200, subscription({ status: 'cancelled', ended_at: 1_790_500_000 })),
    );
    expect(
      await cancel.client.cancelSubscription('sub_Abc123', { cancelAtCycleEnd: true }),
    ).toMatchObject({
      ok: true,
      data: { status: 'cancelled', endedAt: 1_790_500_000 },
    });
    expect(cancel.seen[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.razorpay.test/v1/subscriptions/sub_Abc123/cancel',
      body: { cancel_at_cycle_end: true },
    });
  });

  it('reads a subscription strictly: an unknown status is null, a malformed field makes it unreadable', async () => {
    const read = (body: unknown) =>
      clientReturning(() => json(200, body)).client.fetchSubscription('sub_Abc123');
    expect(await read(subscription())).toEqual({
      ok: true,
      data: {
        id: 'sub_Abc123',
        planId: 'plan_Def456',
        status: 'active',
        currentStart: 1_790_000_000,
        currentEnd: 1_792_600_000,
        chargeAt: 1_792_600_000,
        endedAt: null,
        paidCount: 1,
        totalCount: 60,
      },
    });
    expect(await read(subscription({ status: 'resumed' }))).toMatchObject({
      ok: true,
      data: { status: null },
    });
    for (const broken of [
      subscription({ id: 'order_Abc' }),
      subscription({ plan_id: null }),
      subscription({ current_end: '1792600000' }),
      subscription({ current_start: -5 }),
      subscription({ paid_count: 1.5 }),
    ]) {
      expect(await read(broken)).toMatchObject({ ok: false, kind: 'unknown' });
    }
  });

  it('reads a subscription’s invoices a page at a time and marks one it cannot read', async () => {
    const page = clientReturning(() =>
      json(200, {
        entity: 'collection',
        count: 4,
        items: [
          invoice(),
          invoice({
            id: 'inv_Issued1',
            status: 'issued',
            payment_id: null,
            amount_paid: 0,
            paid_at: null,
          }),
          invoice({ id: 'inv_Bad1', billing_end: 'soon' }),
          invoice({ id: 'inv_Bad2', payment_id: 'order_x' }),
        ],
      }),
    );
    const result = await page.client.fetchSubscriptionInvoices('sub_Abc123', {
      count: 100,
      skip: 200,
    });
    expect(page.seen[0]!.url).toBe(
      'https://api.razorpay.test/v1/invoices?subscription_id=sub_Abc123&count=100&skip=200',
    );
    if (!result.ok) throw new Error('expected a page');
    expect(result.data.items).toHaveLength(4);
    expect(result.data.items[0]).toEqual({
      id: 'inv_Ghi789',
      subscriptionId: 'sub_Abc123',
      paymentId: 'pay_Jkl012',
      status: 'paid',
      amount: 141_482,
      amountPaid: 141_482,
      currency: 'INR',
      paidAt: 1_790_000_100,
      billingStart: 1_790_000_000,
      billingEnd: 1_792_600_000,
    });
    expect(result.data.items[1]).toMatchObject({
      status: 'issued',
      paymentId: null,
      amountPaid: 0,
    });
    expect(result.data.items.slice(2)).toEqual([null, null]);
    expect(() =>
      page.client.fetchSubscriptionInvoices('sub_Abc123', { count: 101, skip: 0 }),
    ).toThrow();
    expect(() =>
      page.client.fetchSubscriptionInvoices('sub_Abc123', { count: 10, skip: -1 }),
    ).toThrow();
  });

  it('reads the invoice a payment paid', async () => {
    const payment = clientReturning(() =>
      json(200, {
        id: 'pay_Jkl012',
        amount: 141_482,
        currency: 'INR',
        status: 'captured',
        captured: true,
        order_id: 'order_Mno345',
        invoice_id: 'inv_Ghi789',
      }),
    );
    expect(await payment.client.fetchPayment('pay_Jkl012')).toMatchObject({
      ok: true,
      data: { invoiceId: 'inv_Ghi789', orderId: 'order_Mno345' },
    });
    const read = clientReturning(() => json(200, invoice()));
    expect(await read.client.fetchInvoice('inv_Ghi789')).toMatchObject({
      ok: true,
      data: { subscriptionId: 'sub_Abc123' },
    });
    expect(read.seen[0]!.url).toBe('https://api.razorpay.test/v1/invoices/inv_Ghi789');
  });
});
