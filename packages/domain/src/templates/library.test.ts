import { describe, expect, it } from 'vitest';
import { DEFAULT_MARKETING_OPT_OUT_KEYWORDS } from '../consent/keywords';
import {
  TEMPLATE_LIMITS,
  TEMPLATE_NAME_RE,
  fromMetaComponents,
  positionalVariables,
  templateDefinitionSchema,
  toMetaComponents,
  validateDefinition,
} from './definition';
import { TEMPLATE_STARTERS, findTemplateStarter, starterDraft } from './library';

const company = { marketingOptOutKeywords: [...DEFAULT_MARKETING_OPT_OUT_KEYWORDS] };

describe('starter templates (ADR-232)', () => {
  it('each pass the checks a draft passes, as the company would get it', () => {
    expect(TEMPLATE_STARTERS.length).toBeGreaterThanOrEqual(10);
    for (const starter of TEMPLATE_STARTERS) {
      const { name, definition } = starterDraft(starter, company);
      expect(name).toBe(starter.key);
      const parsed = templateDefinitionSchema.safeParse(definition);
      expect(parsed.success, starter.key).toBe(true);
      expect(validateDefinition(definition), starter.key).toEqual([]);
      expect(starter.key, starter.key).toMatch(TEMPLATE_NAME_RE);
      // The definition is already as the schema keeps it: nothing trimmed or dropped on saving.
      expect(parsed.data, starter.key).toEqual(definition);
      // And it reads back from Meta's format as it went.
      expect(fromMetaComponents(definition.category, toMetaComponents(definition))).toEqual(
        definition,
      );
    }
  });

  it('have their own names, labels and copy, and give an example for each variable', () => {
    const keys = TEMPLATE_STARTERS.map((s) => s.key);
    const labels = TEMPLATE_STARTERS.map((s) => s.label);
    const bodies = TEMPLATE_STARTERS.map((s) => s.definition.body.text);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(bodies).size).toBe(bodies.length);
    for (const { key, definition } of TEMPLATE_STARTERS) {
      const vars = positionalVariables(definition.body.text);
      expect(vars.ok, key).toBe(true);
      const count = vars.ok ? new Set(vars.numbers).size : 0;
      expect(definition.body.examples, key).toHaveLength(count);
      // HyFib's own rule for starters: a body neither starts nor ends with a variable.
      expect(definition.body.text, key).not.toMatch(/^\s*\{\{|\}\}\s*$/);
      // No website or phone buttons: those need the company's own address or number.
      expect(
        definition.buttons.every((b) => b.type === 'QUICK_REPLY'),
        key,
      ).toBe(true);
    }
    expect(TEMPLATE_STARTERS.some((s) => s.definition.category === 'UTILITY')).toBe(true);
    expect(TEMPLATE_STARTERS.some((s) => s.definition.category === 'MARKETING')).toBe(true);
  });

  it('give marketing starters the company’s marketing opt-out keyword as a button', () => {
    const offer = findTemplateStarter('seasonal_offer')!;
    const draft = starterDraft(offer, company);
    expect(draft.definition.buttons).toEqual([{ type: 'QUICK_REPLY', text: 'STOP PROMOTIONS' }]);
    expect(draft.optOutButton).toBe('STOP PROMOTIONS');
    expect(
      starterDraft(offer, { marketingOptOutKeywords: ['NO OFFERS', 'STOP PROMOTIONS'] }),
    ).toMatchObject({
      optOutButton: 'NO OFFERS',
      definition: { buttons: [{ type: 'QUICK_REPLY', text: 'NO OFFERS' }] },
    });
    // None, or one too long for a button: no opt-out button.
    expect(starterDraft(offer, { marketingOptOutKeywords: [] })).toMatchObject({
      optOutButton: null,
      definition: { buttons: [] },
    });
    const long = 'X'.repeat(TEMPLATE_LIMITS.buttonText + 1);
    expect(starterDraft(offer, { marketingOptOutKeywords: [long] })).toMatchObject({
      optOutButton: null,
      definition: { buttons: [] },
    });
    // Utility starters never get one, and the library itself is never changed.
    const reminder = findTemplateStarter('appointment_reminder')!;
    expect(starterDraft(reminder, company)).toMatchObject({
      optOutButton: null,
      definition: {
        buttons: [
          { type: 'QUICK_REPLY', text: 'Confirm' },
          { type: 'QUICK_REPLY', text: 'Reschedule' },
        ],
      },
    });
    expect(offer.definition.buttons).toEqual([]);
  });

  it('are found by their key only', () => {
    expect(findTemplateStarter('order_confirmation')?.label).toBe('Order confirmation');
    expect(findTemplateStarter('Order_Confirmation')).toBeNull();
    expect(findTemplateStarter('')).toBeNull();
  });
});
