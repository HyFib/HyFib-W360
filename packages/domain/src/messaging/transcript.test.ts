import { describe, expect, it } from 'vitest';
import {
  transcriptEntry,
  transcriptHeader,
  transcriptSender,
  transcriptText,
  transcriptTime,
  type TranscriptMessage,
} from './transcript';

const message = (overrides: Partial<TranscriptMessage>): TranscriptMessage => ({
  direction: 'outbound',
  type: 'text',
  content: { text: 'Hello' },
  status: 'delivered',
  errorTitle: null,
  senderType: 'agent',
  memberName: 'Ravi Kumar',
  apiKeyName: null,
  campaignName: null,
  at: new Date('2026-10-06T04:30:00Z'),
  ...overrides,
});

describe('a conversation transcript (ADR-212)', () => {
  it('gives times as year, month, day, hours and minutes in the company’s time zone', () => {
    const at = new Date('2026-10-06T18:30:00Z');
    expect(transcriptTime(at, 'Asia/Kolkata')).toBe('2026-10-07 00:00');
    expect(transcriptTime(at, 'America/New_York')).toBe('2026-10-06 14:30');
    expect(transcriptTime(new Date('2026-01-05T09:05:00Z'), 'UTC')).toBe('2026-01-05 09:05');
  });

  it('opens with the contact, the number, the company, the time zone and who downloaded it', () => {
    const head = {
      contactName: 'Asha Rao',
      contactPhone: '+919820000001',
      number: '+91 22 4000 0000',
      companyName: 'Acme',
      timeZone: 'Asia/Kolkata',
      downloadedBy: 'Meena Iyer',
      downloadedAt: new Date('2026-10-06T05:00:00Z'),
    };
    expect(transcriptHeader(head)).toBe(
      [
        'Conversation with Asha Rao · +919820000001',
        'WhatsApp number: +91 22 4000 0000',
        'Company: Acme',
        'Times are in Asia/Kolkata. Internal notes are not included.',
        'Downloaded by Meena Iyer on 2026-10-06 10:30.',
        '',
        '',
      ].join('\n'),
    );
    expect(
      transcriptHeader({ ...head, contactName: null, contactPhone: null, number: null }).split(
        '\n',
      ),
    ).toEqual(
      expect.arrayContaining([
        'Conversation with a contact without a name or number',
        'WhatsApp number: unknown',
      ]),
    );
  });

  it('names the customer, the member, or what sent a message for the company', () => {
    const sender = (overrides: Partial<TranscriptMessage>, contact: string | null = 'Asha Rao') =>
      transcriptSender(message(overrides), contact);
    expect(sender({ direction: 'inbound', senderType: 'contact' })).toBe('Asha Rao');
    expect(sender({ direction: 'inbound', senderType: 'contact' }, null)).toBe('Customer');
    expect(sender({})).toBe('Ravi Kumar');
    expect(sender({ memberName: null })).toBe('A member');
    expect(sender({ senderType: 'bot', memberName: null })).toBe('Automation');
    expect(sender({ senderType: 'campaign', campaignName: 'Diwali offer' })).toBe(
      'Campaign “Diwali offer”',
    );
    expect(sender({ senderType: 'campaign' })).toBe('Campaign');
    expect(sender({ senderType: 'api', apiKeyName: 'Helpdesk' })).toBe('API key “Helpdesk”');
    expect(sender({ senderType: 'api' })).toBe('API');
    expect(sender({ senderType: 'system' })).toBe('Sent automatically');
  });

  it('gives each message’s words in full, after its kind when it is not plain text', () => {
    expect(transcriptText('inbound', 'text', { text: 'Line one\r\nLine two  ' })).toBe(
      'Line one\nLine two',
    );
    expect(
      transcriptText('inbound', 'image', { caption: 'The parcel', mime_type: 'image/jpeg' }),
    ).toBe('[Photo] The parcel');
    expect(transcriptText('inbound', 'audio', { mime_type: 'audio/ogg' })).toBe('[Audio]');
    expect(
      transcriptText('outbound', 'template', { rendered: { body: 'Your order shipped.' } }),
    ).toBe('[Template] Your order shipped.');
    expect(transcriptText('inbound', 'button', { text: 'Stop promotions', payload: 'x' })).toBe(
      '[Button reply] Stop promotions',
    );
    expect(transcriptText('outbound', 'location', { address: '12 Park Street' })).toBe(
      '[Location] 12 Park Street',
    );
    expect(
      transcriptText('inbound', 'contacts', {
        contacts: [
          { name: { formatted_name: 'Gita Rao' }, phones: [{ phone: '+919820000002' }] },
          { name: { formatted_name: 'Hari Das' } },
        ],
      }),
    ).toBe('[Contact card] Gita Rao, Hari Das');
    expect(transcriptText('inbound', 'reaction', { emoji: '👍' })).toBe('[Reacted 👍]');
    expect(transcriptText('inbound', 'reaction', {})).toBe('[Removed a reaction]');
    expect(transcriptText('inbound', 'text', { redacted: true })).toBe('[Content removed]');
    expect(
      transcriptText('outbound', 'template', { redacted: true, rendered: { body: 'Hi there' } }),
    ).toBe('[Template] Hi there');
    expect(transcriptText('inbound', 'text', { tooLarge: true })).toBe(
      '[This message was too large to keep]',
    );
    expect(transcriptText('inbound', 'unsupported', {})).toBe('[Message]');
    expect(transcriptText('inbound', 'text', {})).toBe('[Message]');
  });

  it('writes one entry per message, further lines indented, with what happened to one not delivered', () => {
    expect(
      transcriptEntry(
        message({
          direction: 'inbound',
          senderType: 'contact',
          content: { text: 'Hi\nI need help' },
        }),
        'Asha Rao',
        'Asia/Kolkata',
      ),
    ).toBe('[2026-10-06 10:00] Asha Rao: Hi\n    I need help\n');
    expect(transcriptEntry(message({}), 'Asha Rao', 'Asia/Kolkata')).toBe(
      '[2026-10-06 10:00] Ravi Kumar: Hello\n',
    );
    const outcome = (overrides: Partial<TranscriptMessage>) =>
      transcriptEntry(message(overrides), null, 'UTC');
    expect(outcome({ status: 'failed', errorTitle: 'Re-engagement message' })).toBe(
      '[2026-10-06 04:30] Ravi Kumar: Hello (not delivered: Re-engagement message)\n',
    );
    expect(outcome({ status: 'failed' })).toBe(
      '[2026-10-06 04:30] Ravi Kumar: Hello (not delivered)\n',
    );
    expect(outcome({ status: 'canceled' })).toBe(
      '[2026-10-06 04:30] Ravi Kumar: Hello (canceled)\n',
    );
    expect(outcome({ status: 'unknown_outcome' })).toBe(
      '[2026-10-06 04:30] Ravi Kumar: Hello (delivery unknown)\n',
    );
    // A customer's message has no delivery outcome.
    expect(outcome({ direction: 'inbound', senderType: 'contact', status: 'failed' })).toBe(
      '[2026-10-06 04:30] Customer: Hello\n',
    );
  });
});
