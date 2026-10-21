import { describe, expect, it } from 'vitest';
import type { EgressClient } from '@w360/core/egress';
import { savedValuesFrom } from './automations/http';
import { RazorpayClient } from './billing/razorpay';
import { parseFlowCompletion } from './flows/responses';
import { GraphClient } from './messaging/graph';
import { storeRequest } from './stores/http';

/**
 * Text from providers and outside systems keeps a NUL character as U+FFFD (ADR-130): PostgreSQL
 * cannot store U+0000, so one such character would fail everything delivered beside it.
 */
const NUL = '\u0000';
const KEPT = '�';

/** A JSON answer as the provider writes it: the character escaped as `\u0000`. */
const answer = (body: unknown) => {
  const text = JSON.stringify(body);
  expect(text).toContain('\\u0000');
  return text;
};

describe('outside JSON with the NUL character', () => {
  it("keeps it as U+FFFD in Graph's answers", async () => {
    const graph = new GraphClient({
      baseUrl: 'https://graph.test',
      version: 'v26.0',
      fetchImpl: async () =>
        new Response(answer({ verified_name: `Acme${NUL} Store`, display_phone_number: '+91' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const result = await graph.getPhoneNumber('1234', 'token');
    expect(result.ok && result.data.verifiedName).toBe(`Acme${KEPT} Store`);
  });

  it("keeps it as U+FFFD in Razorpay's answers", async () => {
    const razorpay = new RazorpayClient({
      baseUrl: 'https://api.razorpay.test',
      keyId: 'rzp_test_unit',
      keySecret: 'unit-secret',
      fetchImpl: async () =>
        new Response(
          answer({ id: 'pay_1', amount: 100, error_description: `Card de${NUL}clined` }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
    const result = await razorpay.fetchPayment('pay_1');
    expect(result.ok && result.data.errorDescription).toBe(`Card de${KEPT}clined`);
  });

  it("keeps it as U+FFFD in a store's answers", async () => {
    const egress: EgressClient = {
      request: async () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(answer({ product: { title: `Mug${NUL}` } })),
        address: '203.0.113.10',
        durationMs: 1,
      }),
    };
    const response = await storeRequest(egress, { method: 'GET', url: 'https://shop.test/p.json' });
    expect(response.json).toEqual({ product: { title: `Mug${KEPT}` } });
  });

  it("keeps it as U+FFFD in what an automation saves from a company's endpoint", () => {
    const body = Buffer.from(answer({ customer: { name: `Pri${NUL}ya` } }));
    expect(
      savedValuesFrom({ status: 200, headers: {}, body }, [
        { path: 'customer.name', saveAs: 'name' },
      ]).values,
    ).toEqual({
      name: `Pri${KEPT}ya`,
    });
  });

  it('keeps it as U+FFFD in a body an automation saves as text (ADR-406)', () => {
    const body = Buffer.from(`Pri${NUL}ya`);
    const headers = { 'content-type': 'text/plain' };
    expect(
      savedValuesFrom({ status: 200, headers, body }, [{ from: 'text', saveAs: 'name' }]).values,
    ).toEqual({ name: `Pri${KEPT}ya` });
  });

  it("keeps it as U+FFFD in a completed Flow's answers", () => {
    // The answers are JSON text inside the message, so the character is escaped twice over.
    const completion = parseFlowCompletion({
      type: 'nfm_reply',
      nfm_reply: { body: 'Sent', response_json: answer({ city: `Pu${NUL}ne` }) },
    });
    expect(completion?.answers).toEqual({ city: `Pu${KEPT}ne` });
  });
});
