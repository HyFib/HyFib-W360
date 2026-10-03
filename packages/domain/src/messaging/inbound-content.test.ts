import { describe, expect, it } from 'vitest';
import { jsonbSize } from '@w360/core';
import { MAX_ANSWERS_JSONB_BYTES, parseFlowCompletion } from '../flows/responses';
import {
  INBOUND_CONTENT_BUDGET,
  normaliseInboundContent,
  statusErrorsToStore,
  statusPricingToStore,
  type MetaMessage,
} from './meta-webhook';

/** An inbound message as Meta's webhook holds it, with `fields` under its type's key. */
const inbound = (type: string, fields: unknown, extra: Record<string, unknown> = {}) =>
  ({
    id: 'wamid.in.1',
    from: '919876543210',
    timestamp: '1760000000',
    type,
    [type]: fields,
    ...extra,
  }) as unknown as MetaMessage;

/** A contact as a contact card holds it, with an address of about `bytes` bytes. */
const contact = (n: number, bytes: number) => ({
  name: { formatted_name: `Contact ${n}`, first_name: `Contact ${n}` },
  phones: [{ phone: `+9198765${String(n).padStart(5, '0')}`, type: 'CELL' }],
  addresses: [{ street: 'x'.repeat(bytes), city: 'Pune', type: 'HOME' }],
});

describe('normaliseInboundContent (ADR-131)', () => {
  it('clips a long text without splitting an emoji at the cut', () => {
    const { content, preview } = normaliseInboundContent(
      inbound('text', { body: `${'x'.repeat(4095)}😀 and more` }),
    );
    expect(content).toEqual({ text: 'x'.repeat(4095) });
    expect((content.text as string).isWellFormed()).toBe(true);
    expect(preview).toBe('x'.repeat(4095));
  });

  it('keeps text, finite numbers and true or false under the keys it reads, nothing else', () => {
    const { content } = normaliseInboundContent(
      inbound('image', {
        id: 'media-1',
        mime_type: 'image/jpeg',
        caption: { nested: 'x'.repeat(100_000) },
        voice: true,
        sha256: 7,
        filename: ['a'],
      }),
    );
    expect(content).toEqual({ id: 'media-1', mime_type: 'image/jpeg', voice: true, sha256: 7 });
    const location = normaliseInboundContent(
      inbound('location', { latitude: 18.52, longitude: Number.NaN, name: 'Office' }),
    );
    expect(location.content).toEqual({ latitude: 18.52, name: 'Office' });
  });

  it("keeps an interactive reply's id, title and description only", () => {
    const { content, preview } = normaliseInboundContent(
      inbound('interactive', {
        type: 'list_reply',
        list_reply: {
          id: 'slot-10',
          title: '10:00',
          description: 'Dr Rao',
          extra: { huge: 'x'.repeat(100_000) },
        },
      }),
    );
    expect(content).toEqual({
      interactiveType: 'list_reply',
      reply: { id: 'slot-10', title: '10:00', description: 'Dr Rao' },
    });
    expect(preview).toBe('10:00');
  });

  it("keeps at most 5 of an unsupported message's errors, each with its code, title, message and details", () => {
    const error = {
      code: 131051,
      title: 'Message type unknown',
      message: 'Message type unknown',
      error_data: { details: 'Message type is currently not supported.', other: [1, 2] },
      href: { huge: 'x'.repeat(100_000) },
    };
    const { type, content } = normaliseInboundContent(
      inbound('ephemeral', {}, { errors: Array.from({ length: 8 }, () => error) }),
    );
    expect(type).toBe('unsupported');
    expect(content).toEqual({
      originalType: 'ephemeral',
      errors: Array.from({ length: 5 }, () => ({
        code: 131051,
        title: 'Message type unknown',
        message: 'Message type unknown',
        error_data: { details: 'Message type is currently not supported.' },
      })),
    });
  });

  it('keeps the first contacts of a card that fit, and counts the ones left out', () => {
    const small = normaliseInboundContent(inbound('contacts', [contact(1, 50), contact(2, 50)]));
    expect(small.content).toEqual({ contacts: [contact(1, 50), contact(2, 50)] });

    const many = Array.from({ length: 25 }, (_, i) => contact(i + 1, 4_000));
    const large = normaliseInboundContent(inbound('contacts', many));
    const kept = large.content.contacts as unknown[];
    expect(kept.length).toBeGreaterThan(10);
    expect(kept.length).toBeLessThan(20);
    expect(kept).toEqual(many.slice(0, kept.length));
    expect(large.content.omittedContacts).toBe(25 - kept.length);
    expect(jsonbSize(large.content)).toBeLessThanOrEqual(INBOUND_CONTENT_BUDGET);
    expect(large.preview).toBe('[contact card]');

    // No more than 20 are kept however small, and the rest are counted.
    const tiny = normaliseInboundContent(
      inbound(
        'contacts',
        Array.from({ length: 30 }, (_, i) => contact(i, 1)),
      ),
    );
    expect((tiny.content.contacts as unknown[]).length).toBe(20);
    expect(tiny.content.omittedContacts).toBe(10);

    // A contact larger than the budget on its own is left out too.
    const huge = normaliseInboundContent(inbound('contacts', [contact(1, 70_000)]));
    expect(huge.content).toEqual({ contacts: [], omittedContacts: 1 });
  });

  it('keeps content that would still exceed the budget as too large', () => {
    const wide = '𝒳'.repeat(2048); // 4,096 code units, 8 KB as UTF-8
    const { type, content, preview } = normaliseInboundContent(
      inbound('system', {
        type: wide,
        body: wide,
        user_id: wide,
        parent_user_id: wide,
        previous_user_id: wide,
        previous_parent_user_id: wide,
        wa_id: wide,
        new_wa_id: wide,
      }),
    );
    expect({ type, content, preview }).toEqual({
      type: 'system',
      content: { tooLarge: true },
      preview: '[message too large to keep]',
    });
  });
});

describe('parseFlowCompletion and the answers as jsonb (ADR-131)', () => {
  const TOKEN = 't'.repeat(43);
  const completion = (answers: Record<string, unknown>) =>
    parseFlowCompletion({
      type: 'nfm_reply',
      nfm_reply: {
        name: 'flow',
        body: 'Sent',
        response_json: JSON.stringify({ flow_token: TOKEN, ...answers }),
      },
    });

  it('treats answers whose jsonb would exceed the limit as too large, keeping the token', () => {
    // About 4 KB of JSON text, but each number takes up to 28 bytes as jsonb.
    const numbers = Array.from({ length: 2_100 }, () => 1);
    expect(jsonbSize({ picks: numbers })).toBeGreaterThan(MAX_ANSWERS_JSONB_BYTES);
    const tooLarge = completion({ picks: numbers });
    expect(tooLarge?.answers).toBeNull();
    expect(tooLarge?.tooLarge).toBe(true);
    expect(tooLarge?.token).toBe(TOKEN);
    expect(completion({ city: 'Pune' })).toMatchObject({
      answers: { city: 'Pune' },
      tooLarge: false,
    });
  });

  it("clips a completion's body without splitting an emoji", () => {
    const parsed = parseFlowCompletion({
      type: 'nfm_reply',
      nfm_reply: { body: `${'x'.repeat(1023)}😀`, response_json: '{}' },
    });
    expect(parsed?.body).toBe('x'.repeat(1023));
  });
});

describe("a status's errors and pricing as stored (ADR-131)", () => {
  it('keeps errors as WhatsApp sent them when they fit, and bounded ones when they do not', () => {
    const sent = [
      {
        code: 131047,
        title: 'Re-engagement message',
        message: 'Re-engagement message',
        error_data: { details: 'More than 24 hours have passed since the customer last replied.' },
        href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/',
      },
    ];
    expect(statusErrorsToStore(sent)).toEqual(sent);
    expect(statusErrorsToStore(undefined)).toBeNull();

    // Each error keeps its code, title, message and details, clipped; anything else is left out.
    const long = Array.from({ length: 3 }, () => ({
      code: 131000,
      title: 'Something went wrong',
      message: 'Something went wrong',
      error_data: { details: 'd'.repeat(2000) },
      extra: { nested: 'x'.repeat(5000) },
    }));
    expect(statusErrorsToStore(long)).toEqual(
      Array.from({ length: 3 }, () => ({
        code: 131000,
        title: 'Something went wrong',
        message: 'Something went wrong',
        error_data: { details: 'd'.repeat(500) },
      })),
    );

    // Only the errors that fit are kept: here the first.
    const wide = '𝒳'.repeat(250); // 500 code units, 1,000 bytes as UTF-8
    const fitting = statusErrorsToStore(
      Array.from({ length: 5 }, () => ({
        code: 1,
        title: wide,
        message: wide,
        error_data: { details: wide },
      })),
    );
    expect(fitting).toHaveLength(1);
    expect(jsonbSize(fitting)).toBeLessThanOrEqual(3584);

    // When not even the first fits, its code and title do.
    const devanagari = 'अ'.repeat(500); // 1,500 bytes as UTF-8
    expect(
      statusErrorsToStore([
        {
          code: 131026,
          title: devanagari,
          message: devanagari,
          error_data: { details: devanagari },
        },
      ]),
    ).toEqual([{ code: 131026, title: devanagari }]);
  });

  it('keeps pricing as WhatsApp sent it when it fits, and the values reports read when not', () => {
    const sent = { billable: true, pricing_model: 'PMP', category: 'utility', type: 'regular' };
    expect(statusPricingToStore(sent)).toEqual(sent);
    expect(statusPricingToStore(undefined)).toBeNull();
    expect(
      statusPricingToStore({
        billable: false,
        pricing_model: 'PMP',
        category: 'c'.repeat(100),
        type: 'regular',
        note: 'x'.repeat(4000),
      }),
    ).toEqual({ billable: false, pricing_model: 'PMP', category: 'c'.repeat(64), type: 'regular' });
  });
});
