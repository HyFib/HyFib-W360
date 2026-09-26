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
