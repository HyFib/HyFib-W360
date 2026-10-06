import { describe, expect, it } from 'vitest';
import {
  buildTemplateSend,
  fromMetaComponents,
  linkButtons,
  linkPrefix,
  linkValueProblem,
  linkValuesProblem,
  positionalVariables,
  renderExample,
  sendSpecFor,
  templateDefinitionSchema,
  templateParamsSchema,
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
    ).toMatch(/give an example of the link’s end/);
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
        buttonParams: 0,
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
        {
          type: 'BUTTONS',
          buttons: [{ type: 'URL', text: 'Go', url: 'https://x.test/{{1}}/more' }],
        },
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

describe('website buttons whose link ends with a value (ADR-228)', () => {
  const tracked: TemplateDefinition = {
    category: 'UTILITY',
    header: { type: 'none' },
    body: { text: 'Hi {{1}}, order {{2}} has shipped.', examples: ['Asha', 'A-1'] },
    footer: null,
    buttons: [
      { type: 'QUICK_REPLY', text: 'Stop updates' },
      { type: 'URL', text: 'Track', url: 'https://shop.example/track/{{1}}', example: 'A-1' },
      { type: 'URL', text: 'Help', url: 'https://shop.example/help' },
    ],
  };
  const linkIssues = (url: string, example?: string) =>
    validateDefinition({
      ...tracked,
      buttons: [{ type: 'URL', text: 'Track', url, ...(example === undefined ? {} : { example }) }],
    });

  it('takes one value, {{1}}, at the end of the link, after the website’s address', () => {
    expect(linkPrefix('https://shop.example/track/{{1}}')).toBe('https://shop.example/track/');
    expect(linkPrefix('https://shop.example/?order={{1}}')).toBe('https://shop.example/?order=');
    for (const url of [
      'https://shop.example/track',
      'https://shop.example/{{1}}/more',
      'https://shop.example/{{2}}',
      'https://shop.example/{{1}}{{1}}',
      'https://shop.example/{{ 1 }}',
      'https://shop.example/}}{{1}}',
    ]) {
      expect(linkPrefix(url), url).toBeNull();
    }
    expect(linkIssues('https://shop.example/track/{{1}}', 'A-1')).toEqual([]);
    expect(linkIssues('https://shop.example:8443/t?o={{1}}', 'A-1')).toEqual([]);
    // No example, or one the editor's field was emptied of.
    for (const example of [undefined, '']) {
      expect(linkIssues('https://shop.example/track/{{1}}', example)).toEqual([
        {
          path: 'buttons.0.example',
          message: 'Website button: give an example of the link’s end.',
        },
      ]);
    }
    expect(linkIssues('https://shop.example/track/{{1}}', 'A 1')).toEqual([
      { path: 'buttons.0.example', message: 'Example: The end of a link cannot contain spaces.' },
    ]);
    expect(linkIssues('https://shop.example/{{1}}/more', 'A-1')).toEqual([
      {
        path: 'buttons.0.url',
        message:
          'A website button’s link can end with one value, {{1}}, and hold no other variable.',
      },
    ]);
    for (const url of [
      'http://shop.example/{{1}}',
      'https://{{1}}',
      'https://me@shop.example/{{1}}',
      'ftp://shop.example/{{1}}',
    ]) {
      expect(linkIssues(url, 'A-1'), url).toEqual([
        { path: 'buttons.0.url', message: 'Website buttons need an https:// address.' },
      ]);
    }
    // A value right after the host or the port could change the website.
    for (const url of ['https://shop.example{{1}}', 'https://shop.example:8443{{1}}']) {
      expect(linkIssues(url, '/A-1')[0], url).toMatchObject({
        path: 'buttons.0.url',
        message: expect.stringContaining('Put {{1}} after the website’s address'),
      });
    }
  });

  it('refuses values with spaces or invisible characters, and values that change the website', () => {
    const url = 'https://shop.example/track/{{1}}';
    expect(linkValueProblem(url, 'A-1')).toBeNull();
    expect(linkValueProblem(url, '../../x?y=1#z')).toBeNull();
    expect(linkValueProblem(url, '\\evil.example')).toBeNull();
    expect(linkValueProblem(url, '')).toBe('Give the end of the link.');
    expect(linkValueProblem(url, 'A 1')).toBe('The end of a link cannot contain spaces.');
    expect(linkValueProblem(url, 'A\n1')).toBe('The end of a link cannot contain spaces.');
    expect(linkValueProblem(url, 'A\u00071')).toBe(
      'The end of a link cannot contain invisible characters.',
    );
    expect(linkValueProblem('https://shop.example/help', 'x')).toBe(
      'This button’s link takes no value.',
    );
    // A synced link whose value follows the host keeps its website, or the value is refused.
    const loose = 'https://shop.example{{1}}';
    expect(linkValueProblem(loose, '/track/A-1')).toBeNull();
    for (const value of ['.evil.example', '@evil.example', ':444', 'x']) {
      expect(linkValueProblem(loose, value), value).toBe(
        'This value would change the website the button opens.',
      );
    }
    expect(linkValuesProblem(tracked, ['A-1'])).toBeNull();
    expect(linkValuesProblem(tracked, ['A 1'])).toEqual({
      index: 0,
      message: 'Track: The end of a link cannot contain spaces.',
    });
    expect(linkValuesProblem(tracked, [])).toEqual({
      index: 0,
      message: 'Track: Give the end of the link.',
    });
  });

  it('creates the button with its example and reads it back from Meta (M-198)', () => {
    const components = toMetaComponents(tracked);
    expect(components.at(-1)).toEqual({
      type: 'BUTTONS',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Stop updates' },
        { type: 'URL', text: 'Track', url: 'https://shop.example/track/{{1}}', example: ['A-1'] },
        { type: 'URL', text: 'Help', url: 'https://shop.example/help' },
      ],
    });
    expect(fromMetaComponents('UTILITY', components)).toEqual(tracked);
    // An example given as text, or none, is kept as it is: Meta reviewed it.
    const read = (button: Record<string, unknown>) =>
      fromMetaComponents('UTILITY', [
        { type: 'BODY', text: 'Hi' },
        { type: 'BUTTONS', buttons: [button] },
      ])?.buttons;
    const url = 'https://shop.example/track/{{1}}';
    expect(
      read({ type: 'URL', text: 'Track', url, example: 'https://shop.example/track/A-1' }),
    ).toEqual([{ type: 'URL', text: 'Track', url, example: 'https://shop.example/track/A-1' }]);
    expect(read({ type: 'URL', text: 'Track', url })).toEqual([
      { type: 'URL', text: 'Track', url },
    ]);
    expect(
      read({ type: 'URL', text: 'Track', url: 'https://shop.example/{{1}}/x' }),
    ).toBeUndefined();
    expect(read({ type: 'URL', text: 'Track', url: 'https://shop.example{{1}}' })).toBeUndefined();
    // A static link carries no example even when the editor kept one.
    expect(
      toMetaComponents({
        ...tracked,
        buttons: [{ type: 'URL', text: 'Help', url: 'https://shop.example/help', example: 'x' }],
      }).at(-1),
    ).toEqual({
      type: 'BUTTONS',
      buttons: [{ type: 'URL', text: 'Help', url: 'https://shop.example/help' }],
    });
    expect(linkButtons(tracked)).toEqual([
      { index: 1, text: 'Track', url: 'https://shop.example/track/{{1}}' },
    ]);
  });

  it('is sendable only by callers that give the values, and sends each as its button’s text', () => {
    const components = toMetaComponents(tracked);
    expect(sendSpecFor('UTILITY', components)).toEqual({
      supported: false,
      reason:
        'This template has a website button whose link ends with a value given when sending: HyFib sends such templates from a contact or a conversation and through the API, not yet from campaigns, automations or store messages.',
    });
    expect(sendSpecFor('UTILITY', components, { mediaHeaders: true }).supported).toBe(false);
    const spec = sendSpecFor('UTILITY', components, { linkValues: true });
    expect(spec).toMatchObject({
      supported: true,
      headerParams: 0,
      bodyParams: 2,
      buttonParams: 1,
    });
    if (!spec.supported) throw new Error('unsupported');
    // Other templates need no link values.
    expect(sendSpecFor('UTILITY', toMetaComponents(def), { linkValues: true })).toMatchObject({
      supported: true,
      buttonParams: 0,
    });
    const built = buildTemplateSend(
      { name: 'order_shipped', language: 'en' },
      spec,
      { header: [], body: ['Ravi', 'B-2'], buttons: ['B-2?ref=wa'] },
      { quickReplyPayloads: new Map([[0, 'STOP']]) },
    );
    expect(built.template.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Ravi' },
          { type: 'text', text: 'B-2' },
        ],
      },
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '0',
        parameters: [{ type: 'payload', payload: 'STOP' }],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '1',
        parameters: [{ type: 'text', text: 'B-2?ref=wa' }],
      },
    ]);
    // Button components follow the buttons' order, whichever kind comes first.
    const linkFirst = sendSpecFor(
      'UTILITY',
      toMetaComponents({
        ...tracked,
        buttons: [tracked.buttons[1]!, { type: 'QUICK_REPLY', text: 'Stop updates' }],
      }),
      { linkValues: true },
    );
    if (!linkFirst.supported) throw new Error('unsupported');
    expect(
      buildTemplateSend(
        { name: 'x', language: 'en' },
        linkFirst,
        { header: [], body: ['Ravi', 'B-2'], buttons: ['B-2'] },
        { quickReplyPayloads: new Map([[1, 'STOP']]) },
      ).template.components,
    ).toMatchObject([
      { type: 'body' },
      { type: 'button', sub_type: 'url', index: '0' },
      { type: 'button', sub_type: 'quick_reply', index: '1' },
    ]);
    // The conversation keeps the link as sent.
    expect(built.rendered.buttons).toEqual([
      { type: 'QUICK_REPLY', text: 'Stop updates' },
      { type: 'URL', text: 'Track', url: 'https://shop.example/track/B-2?ref=wa' },
      { type: 'URL', text: 'Help' },
    ]);
    const send = (buttons?: string[]) =>
      buildTemplateSend({ name: 'x', language: 'en' }, spec, {
        header: [],
        body: ['Ravi', 'B-2'],
        ...(buttons ? { buttons } : {}),
      });
    expect(() => send()).toThrow('Template parameter count mismatch');
    expect(() => send(['B-2', 'B-3'])).toThrow('Template parameter count mismatch');
    expect(() => send(['B 2'])).toThrow('Track: The end of a link cannot contain spaces.');
    // Sends give at most two link values, each filled in.
    expect(templateParamsSchema.parse({ body: ['x'] })).toEqual({
      header: [],
      body: ['x'],
      buttons: [],
    });
    expect(templateParamsSchema.safeParse({ buttons: ['a', 'b', 'c'] }).success).toBe(false);
    expect(templateParamsSchema.safeParse({ buttons: [' '] }).success).toBe(false);
  });
});
