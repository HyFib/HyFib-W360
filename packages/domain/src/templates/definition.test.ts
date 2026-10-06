import { describe, expect, it } from 'vitest';
import {
  buildTemplateSend,
  fromMetaComponents,
  positionalVariables,
  renderExample,
  sendSpecFor,
  templateDefinitionSchema,
  toMetaComponents,
  validateDefinition,
  type TemplateDefinition,
} from './definition';

const def: TemplateDefinition = {
  category: 'UTILITY',
  header: { type: 'text', text: 'Order {{1}}', example: 'A-1' },
  body: { text: 'Hi {{1}}, order {{2}} ships {{1}}-first.', examples: ['Asha', 'A-1'] },
  footer: 'Reply STOP to opt out',
  buttons: [
    { type: 'QUICK_REPLY', text: 'Stop updates' },
    { type: 'URL', text: 'Track', url: 'https://example.test/track' },
    { type: 'PHONE_NUMBER', text: 'Call', phoneNumber: '+919876500000' },
  ],
};

describe('template definitions', () => {
  it('round-trips through Meta’s component format', () => {
    const components = toMetaComponents(def);
    expect(components[0]).toEqual({
      type: 'HEADER',
      format: 'TEXT',
      text: 'Order {{1}}',
      example: { header_text: ['A-1'] },
    });
    expect(components[1]).toEqual({
      type: 'BODY',
      text: def.body.text,
      example: { body_text: [['Asha', 'A-1']] },
    });
    expect(fromMetaComponents('UTILITY', components)).toEqual(def);
  });

  it('flags gaps, missing examples, footer variables and dynamic URLs', () => {
    const issues = (d: Partial<TemplateDefinition>) =>
      validateDefinition({ ...def, ...d }).map((i) => i.message);
    expect(issues({})).toEqual([]);
    expect(issues({ body: { text: 'Hi {{2}}', examples: ['x', 'y'] } })[0]).toMatch(/without gaps/);
    expect(issues({ body: { text: 'Hi {{1}} {{2}}', examples: ['x'] } })[0]).toMatch(/example/);
    expect(issues({ body: { text: 'Hi {{name}}', examples: [] } })[0]).toMatch(/numbered/);
    expect(issues({ footer: 'Hi {{1}}' })[0]).toMatch(/Footer/);
    expect(issues({ header: { type: 'text', text: '{{1}} {{2}}', example: 'x' } })[0]).toMatch(
      /at most one/,
    );
    expect(
      issues({ buttons: [{ type: 'URL', text: 'Go', url: 'https://x.test/{{1}}' }] })[0],
    ).toMatch(/not supported/);
    expect(issues({ buttons: [{ type: 'URL', text: 'Go', url: 'http://x.test' }] })[0]).toMatch(
      /https/,
    );
    expect(templateDefinitionSchema.safeParse({ ...def, footer: 'x'.repeat(61) }).success).toBe(
      false,
    );
  });

  it('marks templates outside the supported scope as not sendable', () => {
    expect(sendSpecFor('AUTHENTICATION', []).supported).toBe(false);
    expect(
      sendSpecFor('MARKETING', [
        { type: 'HEADER', format: 'IMAGE' },
        { type: 'BODY', text: 'x' },
      ]).supported,
    ).toBe(false);
    expect(
      sendSpecFor('MARKETING', [
        { type: 'CAROUSEL', cards: [] },
        { type: 'BODY', text: 'x' },
      ]).supported,
    ).toBe(false);
    expect(
      sendSpecFor('MARKETING', [
        { type: 'BODY', text: 'x' },
        { type: 'BUTTONS', buttons: [{ type: 'OTP', text: 'Copy' }] },
      ]).supported,
    ).toBe(false);
    const spec = sendSpecFor('UTILITY', toMetaComponents(def));
    expect(spec).toMatchObject({ supported: true, headerParams: 1, bodyParams: 2 });
  });

  it('sends a photo, video or document header only for callers giving its file (ADR-201)', () => {
    const body = {
      type: 'BODY',
      text: 'Parcel {{1}} was delivered.',
      example: { body_text: [['P-1']] },
    };
    const withHeader = (format: string) => [
      { type: 'HEADER', format, example: { header_handle: ['4::aW1hZ2U='] } },
      body,
    ];
    // The inbox, campaigns, automations and store messages are told why they cannot send it.
    expect(sendSpecFor('UTILITY', withHeader('IMAGE'))).toEqual({
      supported: false,
      reason:
        'This template has a photo header: HyFib sends such templates only through the API, which gives a link to the file.',
    });
    expect(sendSpecFor('MARKETING', withHeader('DOCUMENT'))).toMatchObject({
      reason: expect.stringContaining('a document header'),
    });
    // The API gives the file, so the header asks for no text value.
    for (const [format, media] of [
      ['IMAGE', 'image'],
      ['VIDEO', 'video'],
      ['DOCUMENT', 'document'],
    ] as const) {
      expect(sendSpecFor('UTILITY', withHeader(format), { mediaHeaders: true })).toEqual({
        supported: true,
        headerParams: 0,
        bodyParams: 1,
        headerMedia: media,
        definition: {
          category: 'UTILITY',
          header: { type: 'none' },
          body: { text: 'Parcel {{1}} was delivered.', examples: ['P-1'] },
          footer: null,
          buttons: [],
        },
      });
    }
    // Other headers and other content stay out of reach, for the API too.
    for (const components of [
      withHeader('LOCATION'),
      withHeader('GIF'),
      [
        ...withHeader('IMAGE'),
        { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Go', url: 'https://x.test/{{1}}' }] },
      ],
    ]) {
      expect(sendSpecFor('UTILITY', components, { mediaHeaders: true })).toEqual({
        supported: false,
        reason:
          'This template uses content HyFib cannot send yet (for example a location header or a button with a variable).',
      });
    }
    expect(sendSpecFor('UTILITY', toMetaComponents(def), { mediaHeaders: true })).toMatchObject({
      supported: true,
      headerParams: 1,
      headerMedia: null,
    });

    // The file goes first, as the header's one parameter; the text has no header.
    const spec = sendSpecFor('UTILITY', withHeader('VIDEO'), { mediaHeaders: true });
    if (!spec.supported) throw new Error('unsupported');
    const link = 'https://cdn.example.com/parcel.mp4';
    const built = buildTemplateSend(
      { name: 'parcel_video', language: 'en' },
      spec,
      { header: [], body: ['P-7'] },
      { headerMediaLink: link },
    );
    expect(built.template.components).toEqual([
      { type: 'header', parameters: [{ type: 'video', video: { link } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'P-7' }] },
    ]);
    expect(built.headerMedia).toEqual({ type: 'video', link });
    expect(built.rendered).toMatchObject({ header: null, body: 'Parcel P-7 was delivered.' });
    expect(() =>
      buildTemplateSend({ name: 'x', language: 'en' }, spec, { header: [], body: ['P-7'] }),
    ).toThrow('The template’s header needs a link');
    const text = sendSpecFor('UTILITY', toMetaComponents(def), { mediaHeaders: true });
    if (!text.supported) throw new Error('unsupported');
    expect(() =>
      buildTemplateSend(
        { name: 'x', language: 'en' },
        text,
        { header: ['B-2'], body: ['Ravi', 'B-2'] },
        { headerMediaLink: link },
      ),
    ).toThrow('The template has no media header');
    expect(
      buildTemplateSend({ name: 'x', language: 'en' }, text, {
        header: ['B-2'],
        body: ['Ravi', 'B-2'],
      }).headerMedia,
    ).toBeNull();
  });

  it('builds the send object with the deterministic language policy and renders the text', () => {
    const spec = sendSpecFor('UTILITY', toMetaComponents(def));
    if (!spec.supported) throw new Error('unsupported');
    const built = buildTemplateSend({ name: 'order_update', language: 'en_US' }, spec, {
      header: ['B-2'],
      body: ['Ravi', 'B-2'],
    });
    expect(built.template).toEqual({
      name: 'order_update',
      language: { policy: 'deterministic', code: 'en_US' },
      components: [
        { type: 'header', parameters: [{ type: 'text', text: 'B-2' }] },
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Ravi' },
            { type: 'text', text: 'B-2' },
          ],
        },
      ],
    });
    expect(built.rendered.body).toBe('Hi Ravi, order B-2 ships Ravi-first.');
    expect(() =>
      buildTemplateSend({ name: 'x', language: 'en' }, spec, { header: [], body: [] }),
    ).toThrow();
    expect(renderExample(def).header).toBe('Order A-1');
    expect(positionalVariables('{{1}} and {{ 2 }}')).toEqual({ ok: true, numbers: [1, 2] });
  });
});
