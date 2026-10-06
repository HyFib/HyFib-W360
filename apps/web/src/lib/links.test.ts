import { describe, expect, it } from 'vitest';
import { isHttpsLink } from './links';

describe('links the inbox opens (ADR-194)', () => {
  it('are https links with a host and no credentials, whatever the case of the scheme', () => {
    for (const link of [
      'https://cdn.example.com/menu.pdf',
      'HTTPS://cdn.example.com/menu.pdf',
      'Https://CDN.example.com/a%20b.jpg?x=1',
    ]) {
      expect(isHttpsLink(link), link).toBe(true);
    }
    for (const link of [
      null,
      '',
      'http://cdn.example.com/menu.pdf',
      'javascript:alert(1)',
      'https://user:secret@cdn.example.com/menu.pdf',
      'cdn.example.com/menu.pdf',
      'not a link',
    ]) {
      expect(isHttpsLink(link), String(link)).toBe(false);
    }
  });
});
