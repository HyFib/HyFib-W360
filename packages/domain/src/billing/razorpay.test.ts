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
