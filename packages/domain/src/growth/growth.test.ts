import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  REF_CODE_RE,
  SLUG_RE,
  WIDGET_ID_RE,
  findRefCode,
  newRefCode,
  newSlug,
  newWidgetId,
  phoneDigits,
  prefilledText,
  waMeUrl,
} from './model';
import { parseAdReferral } from './sources';
import { readableTextColor, renderWidgetScript } from './widget-script';

describe('chat links', () => {
  it('makes codes and slugs over their alphabets', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(newRefCode()).toMatch(REF_CODE_RE);
      expect(newSlug()).toMatch(SLUG_RE);
      expect(newWidgetId()).toMatch(WIDGET_ID_RE);
    }
    // Codes avoid characters that are easy to misread.
    expect(Array.from({ length: 500 }, newRefCode).join('')).not.toMatch(/[IO01]/);
  });

  it('pre-fills the message with the reference marker and builds the wa.me address', () => {
    expect(prefilledText('Hi, I saw your ad', 'ABC234', true)).toBe(
      'Hi, I saw your ad (ref ABC234)',
    );
    expect(prefilledText('  ', 'ABC234', true)).toBe('(ref ABC234)');
    expect(prefilledText('Hello ', 'ABC234', false)).toBe('Hello');
    expect(waMeUrl('+91 90000-00000', 'Hi & bye\nnow (ref ABC234)')).toBe(
      'https://wa.me/919000000000?text=Hi%20%26%20bye%0Anow%20(ref%20ABC234)',
    );
    expect(waMeUrl('919000000000', '')).toBe('https://wa.me/919000000000');
    expect(phoneDigits('+91 90000 00000')).toBe('919000000000');
    expect(phoneDigits('12345')).toBeNull();
    expect(phoneDigits(null)).toBeNull();
  });

  it('finds a reference code in a customer message', () => {
    expect(findRefCode('Hi, I saw your ad (ref ABC234)')).toBe('ABC234');
    expect(findRefCode('hello (REF abc234) thanks')).toBe('ABC234');
    // Codes never contain I, O, 0 or 1, and the marker must be complete.
    expect(findRefCode('(ref ABCI23)')).toBeNull();
    expect(findRefCode('(ref ABC23)')).toBeNull();
    expect(findRefCode('ref ABC234')).toBeNull();
  });
});

describe('ad referrals', () => {
  it('keeps what identifies the ad and drops the click id and media addresses', () => {
    expect(
      parseAdReferral({
        source_url: 'https://fb.me/abc',
        source_id: '120200000000',
        source_type: 'ad',
        headline: 'Diwali offer',
        body: 'Long ad text',
        media_type: 'image',
        image_url: 'https://scontent.example/x.jpg',
        ctwa_clid: 'click-id-that-identifies-the-visitor',
      }),
    ).toEqual({
      sourceUrl: 'https://fb.me/abc',
      sourceId: '120200000000',
      sourceType: 'ad',
      headline: 'Diwali offer',
    });
    expect(
      parseAdReferral({ source_url: 'javascript:alert(1)', headline: 'x'.repeat(500) }),
    ).toEqual({
      sourceUrl: null,
      sourceId: null,
      sourceType: null,
      headline: 'x'.repeat(200),
    });
    expect(parseAdReferral('not an object')).toBeNull();
    expect(parseAdReferral({ headline: 42 })).toBeNull();
  });
});

describe('website widget', () => {
  it('picks readable text for the button colour', () => {
    expect(readableTextColor('#1f7a4d')).toBe('#ffffff');
    expect(readableTextColor('#ffffff')).toBe('#111111');
    expect(readableTextColor('#ffd400')).toBe('#111111');
  });

  it('draws the button with text content only, and stores and sends nothing', () => {
    const script = renderWidgetScript(
      {
        label: 'Chat </script><img src=x onerror=alert(1)>',
        greeting: 'Hi there',
        side: 'left',
        color: '#1f7a4d',
        slug: 'abcdefghjkmn',
      },
      'abcdefghijklmnop',
      'https://app.example.com/',
    );
    expect(script).not.toContain('</script>');
    expect(script).not.toContain(' ');
    for (const forbidden of [
      'innerHTML',
      'cookie',
      'localStorage',
      'sessionStorage',
      'fetch(',
      'XMLHttpRequest',
    ]) {
      expect(script).not.toContain(forbidden);
    }

    // Run it against a minimal DOM: the label and greeting become text, the link opens the short link.
    const created: Record<string, unknown>[] = [];
    const element = (tag: string) => {
      const el: Record<string, unknown> = {
        tag,
        style: {},
        children: [] as unknown[],
        attrs: {} as Record<string, string>,
        setAttribute(name: string, value: string) {
          (el.attrs as Record<string, string>)[name] = value;
        },
        appendChild(child: unknown) {
          (el.children as unknown[]).push(child);
        },
        attachShadow() {
          return el;
        },
      };
      created.push(el);
      return el;
    };
    const body = element('body');
    const window: Record<string, unknown> = {};
    runInNewContext(script, {
      window,
      document: { body, createElement: element, addEventListener: () => undefined },
    });
    const link = created.find((e) => e.tag === 'a');
    expect(link).toMatchObject({
      href: 'https://app.example.com/l/abcdefghjkmn',
      target: '_blank',
      rel: 'noopener noreferrer',
      referrerPolicy: 'no-referrer',
      textContent: 'Chat </script><img src=x onerror=alert(1)>',
    });
    expect(created.find((e) => e.tag === 'p')).toMatchObject({ textContent: 'Hi there' });
    expect((body.children as unknown[]).length).toBe(1);
    // A second copy of the script on the same page does not add a second button.
    runInNewContext(script, {
      window,
      document: { body, createElement: element, addEventListener: () => undefined },
    });
    expect((body.children as unknown[]).length).toBe(1);
  });
});
