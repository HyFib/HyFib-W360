import { describe, expect, it } from 'vitest';
import { emailPayloadSchema, NOTICE_LINE_MAX, splitEmailText } from './templates';

describe('splitting text a person wrote over the lines of a notice', () => {
  it('keeps text that fits on one line as it is', () => {
    expect(splitEmailText("HyFib's note: see ticket 4410.", 500)).toEqual([
      "HyFib's note: see ticket 4410.",
    ]);
    expect(splitEmailText('   ', 500)).toEqual([]);
  });

  it('breaks between words, each line within the limit, nothing lost', () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const lines = splitEmailText(text, 50);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 50)).toBe(true);
    // Each line is as full as the next word allows.
    for (let i = 0; i < lines.length - 1; i += 1) {
      const next = lines[i + 1]!.split(' ')[0]!;
      expect(lines[i]!.length + 1 + next.length).toBeGreaterThan(50);
    }
    expect(lines.join(' ')).toBe(text);
  });

  it('fills a line up to the limit exactly, never past it', () => {
    expect(splitEmailText('aaaa bbbb', 9)).toEqual(['aaaa bbbb']);
    expect(splitEmailText('aaaa bbbb', 8)).toEqual(['aaaa', 'bbbb']);
    expect(splitEmailText('aaaa', 4)).toEqual(['aaaa']);
  });

  it('turns runs of spaces and line breaks into one space', () => {
    expect(splitEmailText('  One line.\n\nAnother\tline.  ', 500)).toEqual([
      'One line. Another line.',
    ]);
  });

  it('cuts a word longer than a line, never inside a surrogate pair', () => {
    expect(splitEmailText(`short ${'x'.repeat(25)} end`, 10)).toEqual([
      'short',
      'xxxxxxxxxx',
      'xxxxxxxxxx',
      'xxxxx end',
    ]);
    const emoji = '😀'.repeat(6); // 12 code units
    const lines = splitEmailText(`a${emoji}`, 4);
    expect(lines.join('')).toBe(`a${emoji}`);
    expect(lines.every((line) => line.length <= 4)).toBe(true);
    expect(lines.every((line) => !/[\ud800-\udbff]$/.test(line))).toBe(true);
  });

  it('lets a 1,000-character note through a billing notice', () => {
    const note = 'Refunds are for unused credit only; see the terms. '.repeat(20).slice(0, 1000);
    const lines = splitEmailText(`HyFib's note: ${note}`, NOTICE_LINE_MAX.billing);
    expect(() =>
      emailPayloadSchema.parse({
        kind: 'billing.notice',
        companyName: 'Acme',
        subject: 'HyFib declined your refund request',
        lines: ['HyFib declined your request.', ...lines, 'The credit stays in your wallet.'],
      }),
    ).not.toThrow();
    expect(() =>
      emailPayloadSchema.parse({
        kind: 'billing.notice',
        companyName: 'Acme',
        subject: 'HyFib declined your refund request',
        lines: [`HyFib's note: ${note}`],
      }),
    ).toThrow();
  });
});
