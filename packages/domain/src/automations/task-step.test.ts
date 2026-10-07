import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_LIMITS,
  NODE_TYPES,
  NODE_TYPE_LABELS,
  checkGraph,
  edgesOf,
  parseGraph,
  type AutomationGraph,
} from './graph';
import { advance, initialRunState, type RunFacts, type RunState } from './interpreter';

/** Steps that create a CRM task about the run's contact (ADR-244). */

const RUN = '0190a3e4-1111-7000-8000-000000000001';
const MEMBER = '0190a3e4-2222-7000-8000-000000000002';
const OTHER = '0190a3e4-3333-7000-8000-000000000003';
const NOW = new Date('2026-10-06T10:00:00Z');
const facts: RunFacts = {
  contactName: 'Asha Rao',
  companyName: 'Acme',
  tags: new Set(),
  conversationTags: new Set(),
  fields: {},
  businessOpen: true,
};

const task = (overrides: Record<string, unknown> = {}) => ({
  id: 'task',
  type: 'create_task',
  title: 'Call {{name}} about {{answer.product}}',
  assigneeMembershipId: MEMBER,
  dueInHours: 24,
  next: 'bye',
  ...overrides,
});

const graphInput = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  start: 'ask',
  nodes: [
    {
      id: 'ask',
      type: 'ask_text',
      text: 'Which product?',
      saveAs: 'product',
      format: 'any',
      retryText: null,
      retries: 0,
      invalidNext: null,
      timeoutMinutes: 60,
      timeoutNext: null,
      next: 'task',
    },
    task(overrides),
    { id: 'bye', type: 'send_text', text: 'Someone will call you.', next: null },
  ],
});

function graphOf(input: unknown): AutomationGraph {
  const parsed = parseGraph(input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.graph;
}

const atTask = (graph: AutomationGraph, variables: Record<string, string>): RunState => ({
  ...initialRunState(graph),
  nodeId: 'task',
  variables,
});

describe('steps that create a CRM task (ADR-244)', () => {
  it('is a step type with one way on', () => {
    const graph = graphOf(graphInput());
    const node = graph.nodes.find((n) => n.id === 'task')!;
    expect(NODE_TYPES).toContain('create_task');
    expect(NODE_TYPE_LABELS.create_task).toBe('Create a CRM task');
    expect(edgesOf(node)).toEqual([{ label: 'next', target: 'bye' }]);
    expect(AUTOMATION_LIMITS.taskTitleLength).toBe(200);
    expect(AUTOMATION_LIMITS.taskDueHours).toBe(2160);
  });

  it('takes a title, a member and a due time of whole hours up to 90 days, or none', () => {
    expect(parseGraph(graphInput({ dueInHours: null })).ok).toBe(true);
    expect(parseGraph(graphInput({ dueInHours: 1 })).ok).toBe(true);
    expect(parseGraph(graphInput({ dueInHours: 2160 })).ok).toBe(true);
    for (const bad of [
      { dueInHours: 0 },
      { dueInHours: 2161 },
      { dueInHours: 1.5 },
      { title: '   ' },
      { title: 'x'.repeat(201) },
      { assigneeMembershipId: 'someone' },
    ]) {
      expect(parseGraph(graphInput(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
    // A title is trimmed.
    const graph = graphOf(graphInput({ title: '  Call back  ' }));
    expect(graph.nodes.find((n) => n.id === 'task')).toMatchObject({ title: 'Call back' });
  });

  it('needs an active member who can use the CRM, and answers saved before it', () => {
    const graph = graphOf(graphInput());
    expect(checkGraph(graph, { crmMemberIds: new Set([MEMBER]) })).toEqual([]);
    expect(checkGraph(graph, { crmMemberIds: new Set([OTHER]) })).toEqual([
      {
        level: 'error',
        nodeId: 'task',
        message: 'Choose an active member who can use the CRM for the task.',
      },
    ]);
    // Without the company's members (in the browser before they load), nothing to check.
    expect(checkGraph(graph)).toEqual([]);
    // An answer no step saves before the task is an error, as in a message.
    const early = graphOf({
      ...graphInput(),
      start: 'task',
      nodes: graphInput().nodes.map((n) =>
        n.id === 'task' ? { ...n, next: 'ask' } : n.id === 'ask' ? { ...n, next: 'bye' } : n,
      ),
    });
    expect(
      checkGraph(early, { crmMemberIds: new Set([MEMBER]) }).some(
        (i) => i.level === 'error' && i.nodeId === 'task' && /product/.test(i.message),
      ),
    ).toBe(true);
  });

  it('creates the task with its placeholders filled in, on one line, and moves on', () => {
    const graph = graphOf(graphInput());
    const result = advance({
      graph,
      state: atTask(graph, { product: 'the blue\n  kettle' }),
      event: { kind: 'continue' },
      facts,
      runId: RUN,
      now: NOW,
    });
    expect(result).toMatchObject({
      effects: [
        {
          kind: 'create_task',
          title: 'Call Asha Rao about the blue kettle',
          assigneeMembershipId: MEMBER,
          dueInHours: 24,
          remind: false,
        },
      ],
      status: 'running',
      state: { nodeId: 'bye' },
      log: { nodeId: 'task', nodeType: 'create_task', outcome: 'created' },
    });
  });

  it('gives an empty title when the placeholders fill in nothing, and cuts a long one', () => {
    const empty = graphOf(graphInput({ title: '{{answer.product}}', dueInHours: null }));
    const none = advance({
      graph: empty,
      state: atTask(empty, {}),
      event: { kind: 'continue' },
      facts,
      runId: RUN,
      now: NOW,
    });
    expect(none.effects).toEqual([
      {
        kind: 'create_task',
        title: '',
        assigneeMembershipId: MEMBER,
        dueInHours: null,
        remind: false,
      },
    ]);
    // Only spaces and line breaks filled in: empty too.
    const blank = advance({
      graph: empty,
      state: atTask(empty, { product: ' \n ' }),
      event: { kind: 'continue' },
      facts,
      runId: RUN,
      now: NOW,
    });
    expect((blank.effects[0] as { title: string }).title).toBe('');
    // An empty placeholder at the start leaves no space before the rest.
    const edge = graphOf(graphInput({ title: '{{answer.product}} follow-up' }));
    const trimmed = advance({
      graph: edge,
      state: atTask(edge, {}),
      event: { kind: 'continue' },
      facts,
      runId: RUN,
      now: NOW,
    });
    expect((trimmed.effects[0] as { title: string }).title).toBe('follow-up');
    const long = advance({
      graph: empty,
      state: atTask(empty, { product: 'k'.repeat(300) }),
      event: { kind: 'continue' },
      facts,
      runId: RUN,
      now: NOW,
    });
    const title = (long.effects[0] as { title: string }).title;
    expect([...title]).toHaveLength(AUTOMATION_LIMITS.taskTitleLength);
  });

  it('emails the member a reminder when the task is due, only when asked and with a due time (ADR-246)', () => {
    const graph = graphOf(graphInput({ remind: true }));
    expect(checkGraph(graph, { crmMemberIds: new Set([MEMBER]) })).toEqual([]);
    const result = advance({
      graph,
      state: atTask(graph, { product: 'kettle' }),
      event: { kind: 'continue' },
      facts,
      runId: RUN,
      now: NOW,
    });
    expect(result.effects).toMatchObject([{ kind: 'create_task', dueInHours: 24, remind: true }]);
    // Without a due time a reminder has no time: refused when published.
    const undated = graphOf(graphInput({ remind: true, dueInHours: null }));
    expect(checkGraph(undated, { crmMemberIds: new Set([MEMBER]) })).toEqual([
      {
        level: 'error',
        nodeId: 'task',
        message: 'Give the task a due time for its reminder, or send no reminder.',
      },
    ]);
    // Run anyway (a draft tested in the browser), it creates the task without a reminder.
    expect(
      advance({
        graph: undated,
        state: atTask(undated, { product: 'kettle' }),
        event: { kind: 'continue' },
        facts,
        runId: RUN,
        now: NOW,
      }).effects,
    ).toMatchObject([{ kind: 'create_task', dueInHours: null, remind: false }]);
    // Absent (versions saved before) or false: no reminder.
    expect(graphOf(graphInput()).nodes.find((n) => n.id === 'task')).not.toHaveProperty('remind');
    expect(checkGraph(graphOf(graphInput({ remind: false, dueInHours: null })))).toEqual([]);
  });
});
