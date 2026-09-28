import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RazorpayClient,
  verifyCheckoutSignature,
  verifyRazorpayWebhookSignature,
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
