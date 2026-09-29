import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_LIMITS,
  apiInputValues,
  checkGraph,
  describeTrigger,
  matchTrigger,
  parseGraph,
  parseTrigger,
  renderText,
  templatesOf,
  triggerIssues,
  type AutomationGraph,
  type TemplateReference,
} from './graph';
import { advance, initialRunState, type RunFacts } from './interpreter';

/** Automations started through the public API: the trigger, its inputs and the checks (ADR-077). */

const TEMPLATE = '0190a3e4-3333-7000-8000-000000000003';
const WABA = '0190a3e4-4444-7000-8000-000000000004';
const CHANNEL = '0190a3e4-5555-7000-8000-000000000005';

function graphOf(input: unknown): AutomationGraph {
  const parsed = parseGraph(input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.graph;
}

const reminder = {
  id: 'remind',
  type: 'ask_template',
  templateId: TEMPLATE,
  header: [],
  body: ['{{name}}', '{{input.appointment_time}}'],
  buttons: [{ index: 0, title: 'Confirm', next: 'thanks' }],
  saveAs: null,
  replyNext: 'thanks',
  timeoutMinutes: 60,
  timeoutNext: null,
};

const apiGraph = graphOf({
  version: 1,
  start: 'remind',
  nodes: [reminder, { id: 'thanks', type: 'send_text', text: 'See you, {{name}}.', next: null }],
});

const templateRef: TemplateReference = {
  name: 'appointment_reminder',
  category: 'UTILITY',
  status: 'approved',
  whatsappAccountId: WABA,
  unsupported: null,
  headerParams: 0,
  bodyParams: 2,
  quickReplies: [{ index: 0, title: 'Confirm' }],
};

const refs = (inputs: string[] | null) => ({
  templates: new Map([[TEMPLATE, templateRef]]),
  apiInputs: inputs ? new Set(inputs) : undefined,
});
const errorsOf = (graph: AutomationGraph, inputs: string[] | null) =>
  checkGraph(graph, refs(inputs))
    .filter((i) => i.level === 'error')
    .map((i) => i.message);

describe('the API trigger (ADR-077)', () => {
  it('declares its inputs by name, once each, and never matches a customer message', () => {
    const parsed = parseTrigger({ type: 'api', inputs: ['appointment_time', 'doctor', 'doctor'] });
    expect(parsed).toEqual({
      ok: true,
      trigger: { type: 'api', inputs: ['appointment_time', 'doctor'] },
    });
    if (!parsed.ok) return;
    for (const message of [
      { text: 'hello', newCase: true },
      { text: null, newCase: false },
    ]) {
      expect(matchTrigger(parsed.trigger, message)).toBeNull();
    }
    expect(describeTrigger(parsed.trigger)).toBe(
      'Started through the API with “appointment_time”, “doctor”',
    );
    expect(describeTrigger({ type: 'api', inputs: [] })).toBe('Started through the API');
  });

  it('refuses input names that are not answer-like, and more inputs than allowed', () => {
    for (const bad of ['Doctor', '1st', 'first-name', 'a'.repeat(33), '']) {
      expect(parseTrigger({ type: 'api', inputs: [bad] }).ok, bad).toBe(false);
    }
    const many = Array.from({ length: AUTOMATION_LIMITS.apiInputs + 1 }, (_, i) => `input_${i}`);
    expect(parseTrigger({ type: 'api', inputs: many }).ok).toBe(false);
    expect(parseTrigger({ type: 'api', inputs: many.slice(1) }).ok).toBe(true);
  });

  it('sends from one number, which the automation must be limited to', () => {
    const trigger = { type: 'api' as const, inputs: [] };
    expect(triggerIssues(trigger, null)).toEqual([
      expect.objectContaining({ level: 'error', nodeId: null }),
    ]);
    expect(triggerIssues(trigger, CHANNEL)).toEqual([]);
    expect(triggerIssues({ type: 'store_event' }, null)).toEqual([]);
    expect(triggerIssues({ type: 'any_message', hours: 'any', cooldownMinutes: 0 }, null)).toEqual(
      [],
    );
  });
});

describe('API inputs in the steps (ADR-077)', () => {
  it('are available as {{input.<name>}} when the trigger declares them', () => {
    expect(errorsOf(apiGraph, ['appointment_time'])).toEqual([]);
    expect(errorsOf(apiGraph, ['doctor'])).toEqual([
      '{{input.appointment_time}} is not one of the trigger’s inputs. Add it to the trigger’s inputs first.',
    ]);
    expect(errorsOf(apiGraph, null)).toContain(
      '{{input.appointment_time}} is an API input: inputs work only in automations started through the API.',
    );
  });

  it('are named in the list of placeholders of API automations', () => {
    const graph = graphOf({
      version: 1,
      start: 'remind',
      nodes: [
        { ...reminder, body: ['{{name}}', '{{appointment}}'] },
        { id: 'thanks', type: 'end' },
      ],
    });
    expect(errorsOf(graph, ['appointment_time'])).toEqual([
      'Unknown placeholder {{appointment}}. Use {{name}}, {{company}}, {{answer.<name>}} or {{input.<name>}}.',
    ]);
  });

  it('come with the service window rule: only templates before the contact replies', () => {
    const textFirst = graphOf({
      version: 1,
      start: 'hello',
      nodes: [{ id: 'hello', type: 'send_text', text: 'Hi {{input.doctor}}', next: null }],
    });
    expect(errorsOf(textFirst, ['doctor'])).toEqual([
      'WhatsApp allows only templates until the customer replies, and a path reaches this step before a reply. Send a template first and continue from its reply branches.',
    ]);
    // After a reply to the template, a text is allowed.
    expect(errorsOf(apiGraph, ['appointment_time'])).toEqual([]);
  });

  it('are filled in from the run’s inputs, kept with its answers', () => {
    const values = {
      contactName: 'Asha',
      companyName: 'Cora Clinic',
      variables: { 'input.appointment_time': '5 pm today', 'input.doctor': 'Dr. Rao' },
    };
    expect(renderText('{{name}}, {{input.doctor}} at {{input.appointment_time}}', values)).toBe(
      'Asha, Dr. Rao at 5 pm today',
    );
    // An answer name cannot be written with a dot, so {{answer.…}} never reads an input by accident.
    expect(renderText('{{answer.input.doctor}}', values)).toBe('{{answer.input.doctor}}');
  });

  it('fill the first template step’s variables', () => {
    const facts: RunFacts = {
      contactName: 'Asha',
      companyName: 'Cora Clinic',
      tags: new Set(),
      fields: {},
      businessOpen: true,
    };
    const state = {
      ...initialRunState(apiGraph),
      variables: { 'input.appointment_time': '5 pm today' },
    };
    const result = advance({
      graph: apiGraph,
      state,
      event: { kind: 'continue' },
      facts,
      runId: '0190a3e4-2222-7000-8000-000000000002',
      now: new Date('2026-09-29T10:00:00Z'),
    });
    expect(result.effects).toContainEqual(
      expect.objectContaining({ kind: 'send_template', body: ['Asha', '5 pm today'] }),
    );
  });

  it('lists the templates a graph sends, once each', () => {
    const twice = graphOf({
      version: 1,
      start: 'remind',
      nodes: [
        { ...reminder, buttons: [{ index: 0, title: 'Confirm', next: 'again' }] },
        {
          id: 'again',
          type: 'send_template',
          templateId: TEMPLATE,
          header: [],
          body: ['{{name}}', 'x'],
          next: null,
        },
      ],
    });
    expect(templatesOf(twice)).toEqual([TEMPLATE]);
  });
});

describe('the inputs a start gives (ADR-077)', () => {
  const declared = ['appointment_time', 'doctor'];

  it('are every declared input, as text, kept as input.<name>', () => {
    expect(apiInputValues(declared, { appointment_time: '5 pm', doctor: 'Dr. Rao' })).toEqual({
      ok: true,
      variables: { 'input.appointment_time': '5 pm', 'input.doctor': 'Dr. Rao' },
    });
    expect(apiInputValues([], undefined)).toEqual({ ok: true, variables: {} });
    expect(apiInputValues([], {})).toEqual({ ok: true, variables: {} });
  });

  it('refuse a missing, blank, unknown, non-text or too long input', () => {
    const cases: [unknown, RegExp][] = [
      [{ appointment_time: '5 pm' }, /Give the input “doctor” a value/],
      [{ appointment_time: '5 pm', doctor: '   ' }, /Give the input “doctor” a value/],
      [{ appointment_time: '5 pm', doctor: 7 }, /Give the input “doctor” a value/],
      [{ appointment_time: '5 pm', doctor: 'x', room: '4' }, /no input named “room”/],
      [
        { appointment_time: '5 pm', doctor: 'x'.repeat(AUTOMATION_LIMITS.apiInputLength + 1) },
        /limited to 1000 characters/,
      ],
      [['5 pm', 'x'], /object of names and texts/],
      ['5 pm', /object of names and texts/],
    ];
    for (const [given, message] of cases) {
      const result = apiInputValues(declared, given);
      expect(result.ok, JSON.stringify(given)).toBe(false);
      if (!result.ok) expect(result.message).toMatch(message);
    }
  });
});
