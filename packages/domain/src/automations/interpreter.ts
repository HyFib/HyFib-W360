import { clipText } from '@w360/core/text';
import { EMAIL_RE, normalizeTag } from '../contacts/fields';
import { TEMPLATE_LIMITS } from '../templates/definition';
import {
  AUTOMATION_LIMITS,
  HTTP_BODY_METHODS,
  HTTP_WAIT_MINUTES,
  RUN_BUDGETS,
  encodeFormValue,
  encodeJsonString,
  FORM_CONTENT_TYPE,
  httpPathTemplate,
  renderHttpHeader,
  renderHttpText,
  renderText,
  type AutomationGraph,
  type AutomationNode,
  type ConditionRule,
  type HttpHeaderPart,
  type HttpMethod,
  type NodeOf,
  type OrderPlaceholderValues,
} from './graph';
import { FLOW_LIMITS } from '../flows/flow-json';
import { normalizeRoutingText } from '../inbox/keywords';

/** A form's message as WhatsApp takes it (ADR-248). */
const FLOW_BODY_LENGTH = FLOW_LIMITS.bodyLength;

/**
 * The automation interpreter: a pure function from (graph, run state, event, facts) to the next
 * state, the effects to apply and a log entry. One call is one step: entering a node, or handling
 * a reply or deadline at the node the run waits in. The worker applies the effects and stores the
 * new state in one transaction per step; the builder's simulator calls the same function with
 * simulated facts and applies nothing.
 */

export interface RunState {
  /** The node to enter next (running) or the node the run waits in (waiting); null when ended. */
  nodeId: string | null;
  /** How many times the current node has been entered. */
  visit: number;
  waiting: { for: 'reply' | 'timer' | 'http'; until: Date } | null;
  /** Unrecognised replies at the current question. */
  retries: number;
  steps: number;
  messages: number;
  /** HTTP calls made (budget). */
  httpCalls: number;
  visits: Readonly<Record<string, number>>;
  variables: Readonly<Record<string, string>>;
}

export interface InboundReply {
  type: 'text' | 'button' | 'other';
  /** Text typed, or the tapped button's title. */
  text: string | null;
  /** Id of a tapped reply button. */
  buttonId: string | null;
}

export type RunEvent =
  | { kind: 'continue' }
  | { kind: 'reply'; reply: InboundReply }
  /** The reply deadline, the wait timer or the HTTP result deadline is due. */
  | { kind: 'deadline' }
  /**
   * The result of the HTTP call the run waits for: `ok` for a 2xx response, `values` saved from it
   * (by answer name), `detail` the status code or error code for the step log.
   */
  | {
      kind: 'http_result';
      ok: boolean;
      values: Readonly<Record<string, string>>;
      detail: string | null;
    };

export interface RunFacts {
  contactName: string | null;
  companyName: string;
  tags: ReadonlySet<string>;
  /** The tags on the run's conversation (ADR-222). */
  conversationTags: ReadonlySet<string>;
  fields: Readonly<Record<string, string | number | boolean>>;
  /** Whether the business is open now (true when business hours are off). */
  businessOpen: boolean;
  /**
   * The order a run started by order messages is about, read when the step runs ({{order.<field>}});
   * null for other runs, or when the order was deleted or redacted.
   */
  order?: OrderPlaceholderValues | null;
}

export type RunEffect =
  | { kind: 'send_text'; text: string }
  | {
      kind: 'send_buttons';
      header: string | null;
      body: string;
      footer: string | null;
      buttons: { id: string; title: string }[];
    }
  /**
   * An approved template (allowed outside the service window) with its variables filled in. An
   * asking step also gives each quick-reply button its payload, by the button's position among the
   * template's buttons, with the text the step expects it to have.
   */
  | {
      kind: 'send_template';
      templateId: string;
      header: string[];
      body: string[];
      /** The ends of the template's links that take a value, as rendered (ADR-229). */
      links: string[];
      ask: boolean;
      buttons: { index: number; title: string; payload: string }[];
    }
  /**
   * One of the company's forms (ADR-248), with the message as rendered; the header, footer and
   * button text as written.
   */
  | {
      kind: 'send_flow';
      flowId: string;
      header: string | null;
      body: string;
      footer: string | null;
      cta: string;
    }
  | { kind: 'add_tag'; tag: string }
  | { kind: 'remove_tag'; tag: string }
  | { kind: 'set_field'; field: string; value: string }
  /** A tag added to or removed from the run's conversation (ADR-222). */
  | { kind: 'add_conversation_tag'; tag: string }
  | { kind: 'remove_conversation_tag'; tag: string }
  /**
   * An HTTP call to make (by the worker, outside the step's transaction). Texts are rendered;
   * header values keep references to secrets, which only the worker fills in.
   */
  | {
      kind: 'http_request';
      method: HttpMethod;
      url: string;
      /** The address's path as written (placeholders not filled in), for the call record. */
      path: string;
      headers: { name: string; parts: HttpHeaderPart[] }[];
      body: string | null;
      save: { path: string; saveAs: string }[];
    }
  /**
   * A CRM task about the run's contact for a member, created by the automation (ADR-244): the
   * title as rendered (empty when its placeholders filled in nothing), due after `dueInHours`.
   */
  | {
      kind: 'create_task';
      title: string;
      assigneeMembershipId: string;
      dueInHours: number | null;
      /** Email the member when the task is due (ADR-246): only with a due time. */
      remind: boolean;
    }
  /**
   * A CRM deal for the run's contact and conversation, created by the automation (ADR-245): the
   * title as rendered (empty when its placeholders filled in nothing), the value as typed.
   */
  | {
      kind: 'create_deal';
      title: string;
      pipelineId: string;
      stageId: string;
      value: string | null;
      ownerMembershipId: string | null;
      /** Days after the step runs that the deal is expected to close (ADR-247), or null. */
      closeInDays: number | null;
    }
  /** The run's contact's open deal in the pipeline moved to the stage, by the automation (ADR-250). */
  | { kind: 'move_deal'; pipelineId: string; stageId: string }
  | { kind: 'handoff'; teamId: string | null };

export type StepStatus = 'running' | 'waiting' | 'completed' | 'handed_off' | 'failed';
export type InterpreterEndReason =
  | 'end_node'
  | 'no_next'
  | 'handoff_node'
  | 'budget_steps'
  | 'budget_loop'
  | 'budget_messages'
  | 'budget_http'
  | 'error';

export type StepLogOutcome =
  | 'sent'
  | 'asked'
  | 'answered'
  | 'retried'
  | 'timed_out'
  | 'branched'
  | 'updated'
  | 'waiting'
  | 'resumed'
  | 'handed_off'
  | 'completed'
  | 'failed'
  | 'requested'
  | 'responded'
  | 'created'
  /** A step that moves a deal (ADR-250). */
  | 'moved'
  /**
   * Recorded by the runner when a task or deal step created nothing, or a step that moves a deal
   * moved nothing (ADR-244, ADR-245, ADR-250).
   */
  | 'skipped';

export interface StepResult {
  /** True when the event did not apply to the run's position (nothing to record or apply). */
  noop: boolean;
  state: RunState;
  effects: RunEffect[];
  status: StepStatus;
  endReason: InterpreterEndReason | null;
  log: {
    nodeId: string | null;
    nodeType: string | null;
    outcome: StepLogOutcome;
    branch: string | null;
    detail: string | null;
  };
}

export interface AdvanceInput {
  graph: AutomationGraph;
  state: RunState;
  event: RunEvent;
  facts: RunFacts;
  /** The run's id (reply button ids carry it). */
  runId: string;
  now: Date;
}

export const BOT_BUTTON_PREFIX = 'w360bot:';
/** The last part is the button's position: 0-2 for reply buttons, 0-9 among a template's buttons. */
const BOT_BUTTON_RE = /^w360bot:([0-9a-f-]{36}):([a-z0-9_-]{1,32}):(\d{1,4}):(\d)$/;

/**
 * Reply button id (also the payload of a template's quick-reply button): run, node, visit and button
 * position, so a tap answers exactly one question.
 */
export function botButtonId(runId: string, nodeId: string, visit: number, index: number): string {
  return `${BOT_BUTTON_PREFIX}${runId}:${nodeId}:${visit}:${index}`;
}

export function parseBotButtonId(
  id: string,
): { runId: string; nodeId: string; visit: number; index: number } | null {
  const m = BOT_BUTTON_RE.exec(id);
  if (!m) return null;
  return {
    runId: m[1] as string,
    nodeId: m[2] as string,
    visit: Number(m[3]),
    index: Number(m[4]),
  };
}

export function initialRunState(graph: AutomationGraph): RunState {
  return {
    nodeId: graph.start,
    visit: 0,
    waiting: null,
    retries: 0,
    steps: 0,
    messages: 0,
    httpCalls: 0,
    visits: {},
    variables: {},
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${clipText(text, max - 1)}…`;
}

function numberOf(value: string | number | boolean | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  return Number(normalized);
}

function compare(
  actual: string | number | boolean | undefined,
  op: ConditionRule & { op: string },
  value: string | null,
): boolean {
  const text = actual === undefined || actual === null ? '' : String(actual).trim();
  const expected = (value ?? '').trim();
  switch (op.op) {
    case 'is_set':
      return text.length > 0;
    case 'is_not_set':
      return text.length === 0;
    case 'equals':
      return text.toLowerCase() === expected.toLowerCase();
    case 'not_equals':
      return text.toLowerCase() !== expected.toLowerCase();
    case 'contains':
      return expected.length > 0 && text.toLowerCase().includes(expected.toLowerCase());
    case 'greater_than':
    case 'less_than': {
      const a = numberOf(actual);
      const b = numberOf(expected);
      if (a === null || b === null) return false;
      return op.op === 'greater_than' ? a > b : a < b;
    }
    default:
      return false;
  }
}

export function evaluateRule(
  rule: ConditionRule,
  facts: RunFacts,
  variables: Readonly<Record<string, string>>,
): boolean {
  switch (rule.kind) {
    case 'answer':
      return compare(variables[rule.variable], rule, rule.value);
    case 'field':
      return compare(facts.fields[rule.field], rule, rule.value);
    case 'tag': {
      const normalized = normalizeTag(rule.tag);
      const has = normalized.ok && facts.tags.has(normalized.tag);
      return rule.op === 'has' ? has : !has;
    }
    case 'conversation_tag': {
      const normalized = normalizeTag(rule.tag);
      const has = normalized.ok && facts.conversationTags.has(normalized.tag);
      return rule.op === 'has' ? has : !has;
    }
    case 'business_hours':
      return rule.op === 'open' ? facts.businessOpen : !facts.businessOpen;
  }
}

/** Validates a typed answer against the question's format; returns the value to save. */
export function acceptAnswer(
  format: NodeOf<'ask_text'>['format'],
  reply: InboundReply,
): string | null {
  if (reply.type !== 'text' || !reply.text) return null;
  const text = reply.text.trim();
  if (!text) return null;
  if (format === 'number') return numberOf(text) === null ? null : text;
  if (format === 'email') return text.length <= 254 && EMAIL_RE.test(text) ? text : null;
  return clipText(text, AUTOMATION_LIMITS.answerLength);
}

/** The button a reply chose: a tap on this question's button, or its title typed as text. */
export function chosenButton(
  node: NodeOf<'ask_buttons'>,
  reply: InboundReply,
  runId: string,
  visit: number,
): number | null {
  if (reply.buttonId) {
    const parsed = parseBotButtonId(reply.buttonId);
    if (
      parsed &&
      parsed.runId === runId &&
      parsed.nodeId === node.id &&
      parsed.visit === visit &&
      parsed.index < node.buttons.length
    ) {
      return parsed.index;
    }
    if (parsed) return null;
  }
  if (!reply.text) return null;
  const typed = normalizeRoutingText(reply.text);
  if (!typed) return null;
  const index = node.buttons.findIndex((b) => normalizeRoutingText(b.title) === typed);
  return index >= 0 ? index : null;
}

/**
 * The branch (position in the step's `buttons`) a reply to an asking template step chose: a tap on a
 * quick-reply button this step and visit sent, or a button's text typed. A tap sent by another step
 * or visit chooses nothing.
 */
export function chosenTemplateButton(
  node: NodeOf<'ask_template'>,
  reply: InboundReply,
  runId: string,
  visit: number,
): number | null {
  if (reply.buttonId) {
    const parsed = parseBotButtonId(reply.buttonId);
    if (parsed && parsed.runId === runId && parsed.nodeId === node.id && parsed.visit === visit) {
      const index = node.buttons.findIndex((b) => b.index === parsed.index);
      return index >= 0 ? index : null;
    }
    if (parsed) return null;
  }
  if (!reply.text) return null;
  const typed = normalizeRoutingText(reply.text);
  if (!typed) return null;
  const index = node.buttons.findIndex((b) => normalizeRoutingText(b.title) === typed);
  return index >= 0 ? index : null;
}

/** A template variable's value: one line (whitespace collapsed), within the parameter limit. */
function templateParam(value: string): string {
  return truncate(value.replace(/\s+/g, ' ').trim(), TEMPLATE_LIMITS.parameterValue);
}

/**
 * Advances a run by one step. Never throws for problems caused by the graph or the customer: a
 * missing node, an exhausted budget or an empty message ends the run as failed with a reason.
 */
export function advance(input: AdvanceInput): StepResult {
  const { graph, event, facts, runId, now } = input;
  const state = input.state;
  const node = state.nodeId ? graph.nodes.find((n) => n.id === state.nodeId) : undefined;
  const values = (variables: Readonly<Record<string, string>>) => ({
    contactName: facts.contactName,
    companyName: facts.companyName,
    variables,
    order: facts.order ?? null,
  });

  const fail = (
    reason: InterpreterEndReason,
    detail: string | null,
    base: RunState = state,
  ): StepResult => ({
    noop: false,
    state: { ...base, waiting: null, nodeId: null },
    effects: [],
    status: 'failed',
    endReason: reason,
    log: {
      nodeId: node?.id ?? state.nodeId,
      nodeType: node?.type ?? null,
      outcome: 'failed',
      branch: null,
      detail,
    },
  });

  if (!node) return fail('error', 'missing_node');
  if (state.steps + 1 > RUN_BUDGETS.maxSteps) return fail('budget_steps', 'budget_steps');

  /** Moves to `target` (or ends the run when there is none). */
  const moveTo = (
    target: string | null,
    base: RunState,
    effects: RunEffect[],
    outcome: StepLogOutcome,
    branch: string | null,
    detail: string | null = null,
  ): StepResult => ({
    noop: false,
    state: { ...base, nodeId: target, waiting: null, retries: 0 },
    effects,
    status: target === null ? 'completed' : 'running',
    endReason: target === null ? 'no_next' : null,
    log: { nodeId: node.id, nodeType: node.type, outcome, branch, detail },
  });

  const waitFor = (
    kind: 'reply' | 'timer' | 'http',
    minutes: number,
    base: RunState,
    effects: RunEffect[],
    outcome: StepLogOutcome,
  ): StepResult => ({
    noop: false,
    state: { ...base, waiting: { for: kind, until: new Date(now.getTime() + minutes * 60_000) } },
    effects,
    status: 'waiting',
    endReason: null,
    log: { nodeId: node.id, nodeType: node.type, outcome, branch: null, detail: null },
  });

  /** A message effect, counted against the message budget; null when the text renders empty. */
  const message = (
    base: RunState,
    build: () => RunEffect | null,
  ): { effect: RunEffect; state: RunState } | StepResult => {
    if (base.messages + 1 > RUN_BUDGETS.maxMessages)
      return fail('budget_messages', 'budget_messages', base);
    const effect = build();
    if (!effect) return fail('error', 'empty_message', base);
    return { effect, state: { ...base, messages: base.messages + 1 } };
  };
  const isResult = (value: unknown): value is StepResult =>
    typeof value === 'object' && value !== null && 'status' in value;

  const textEffect = (template: string, variables: Readonly<Record<string, string>>) => {
    const text = truncate(renderText(template, values(variables)), AUTOMATION_LIMITS.textLength);
    return text ? ({ kind: 'send_text', text } as const) : null;
  };
  const buttonsEffect = (
    askNode: NodeOf<'ask_buttons'>,
    body: string,
    visit: number,
    variables: Readonly<Record<string, string>>,
  ): RunEffect | null => {
    const rendered = truncate(
      renderText(body, values(variables)),
      AUTOMATION_LIMITS.questionLength,
    );
    if (!rendered) return null;
    return {
      kind: 'send_buttons',
      header: askNode.header,
      body: rendered,
      footer: askNode.footer,
      buttons: askNode.buttons.map((b, i) => ({
        id: botButtonId(runId, askNode.id, visit, i),
        title: b.title,
      })),
    };
  };

  const enter = (current: AutomationNode, base: RunState): StepResult => {
    switch (current.type) {
      case 'send_text': {
        const built = message(base, () => textEffect(current.text, base.variables));
        if (isResult(built)) return built;
        return moveTo(current.next, built.state, [built.effect], 'sent', null);
      }
      case 'send_flow': {
        const built = message(base, () => {
          const body = truncate(renderText(current.body, values(base.variables)), FLOW_BODY_LENGTH);
          return body
            ? {
                kind: 'send_flow',
                flowId: current.flowId,
                header: current.header,
                body,
                footer: current.footer,
                cta: current.cta,
              }
            : null;
        });
        if (isResult(built)) return built;
        return moveTo(current.next, built.state, [built.effect], 'sent', null);
      }
      case 'ask_buttons': {
        const built = message(base, () =>
          buttonsEffect(current, current.body, base.visit, base.variables),
        );
        if (isResult(built)) return built;
        return waitFor('reply', current.timeoutMinutes, built.state, [built.effect], 'asked');
      }
      case 'ask_text': {
        const built = message(base, () => textEffect(current.text, base.variables));
        if (isResult(built)) return built;
        return waitFor('reply', current.timeoutMinutes, built.state, [built.effect], 'asked');
      }
      case 'send_template':
      case 'ask_template': {
        if (base.messages + 1 > RUN_BUDGETS.maxMessages)
          return fail('budget_messages', 'budget_messages', base);
        const vals = values(base.variables);
        const header = current.header.map((t) => templateParam(renderText(t, vals)));
        const body = current.body.map((t) => templateParam(renderText(t, vals)));
        // The end of a link is kept as rendered (no white space collapsed): whether it can end
        // the template's link is checked when the template is queued.
        const links = current.links.map((t) => renderText(t, vals).trim());
        // Nothing is sent with a blank variable.
        if ([...header, ...body, ...links].some((v) => !v)) {
          return fail('error', 'missing_variable', base);
        }
        const ask = current.type === 'ask_template';
        const effect: RunEffect = {
          kind: 'send_template',
          templateId: current.templateId,
          header,
          body,
          links,
          ask,
          buttons: ask
            ? current.buttons.map((b) => ({
                index: b.index,
                title: b.title,
                payload: botButtonId(runId, current.id, base.visit, b.index),
              }))
            : [],
        };
        const sent: RunState = { ...base, messages: base.messages + 1 };
        return current.type === 'ask_template'
          ? waitFor('reply', current.timeoutMinutes, sent, [effect], 'asked')
          : moveTo(current.next, sent, [effect], 'sent', null);
      }
      case 'condition': {
        const results = current.rules.map((r) => evaluateRule(r, facts, base.variables));
        const yes = current.match === 'all' ? results.every(Boolean) : results.some(Boolean);
        return moveTo(yes ? current.then : current.else, base, [], 'branched', yes ? 'yes' : 'no');
      }
      case 'update_contact': {
        const action = current.action;
        const effect: RunEffect =
          action.kind === 'set_field'
            ? {
                kind: 'set_field',
                field: action.field,
                value: clipText(
                  renderText(action.value, values(base.variables)),
                  AUTOMATION_LIMITS.fieldValueLength,
                ),
              }
            : { kind: action.kind, tag: action.tag };
        return moveTo(current.next, base, [effect], 'updated', null);
      }
      case 'update_conversation': {
        const effect: RunEffect = {
          kind:
            current.action.kind === 'add_tag' ? 'add_conversation_tag' : 'remove_conversation_tag',
          tag: current.action.tag,
        };
        return moveTo(current.next, base, [effect], 'updated', null);
      }
      case 'create_task': {
        const effect: RunEffect = {
          kind: 'create_task',
          // One line: renderText trims, and line breaks or runs of spaces become one space.
          title: clipText(
            renderText(current.title, values(base.variables)).replace(/\s+/g, ' '),
            AUTOMATION_LIMITS.taskTitleLength,
          ),
          assigneeMembershipId: current.assigneeMembershipId,
          dueInHours: current.dueInHours,
          remind: current.remind === true && current.dueInHours !== null,
        };
        return moveTo(current.next, base, [effect], 'created', null);
      }
      case 'create_deal': {
        const effect: RunEffect = {
          kind: 'create_deal',
          // One line, as for task titles.
          title: clipText(
            renderText(current.title, values(base.variables)).replace(/\s+/g, ' '),
            AUTOMATION_LIMITS.dealTitleLength,
          ),
          pipelineId: current.pipelineId,
          stageId: current.stageId,
          value: current.value,
          ownerMembershipId: current.ownerMembershipId,
          closeInDays: current.closeInDays ?? null,
        };
        return moveTo(current.next, base, [effect], 'created', null);
      }
      case 'move_deal': {
        const effect: RunEffect = {
          kind: 'move_deal',
          pipelineId: current.pipelineId,
          stageId: current.stageId,
        };
        return moveTo(current.next, base, [effect], 'moved', null);
      }
      case 'http_request': {
        if (base.httpCalls + 1 > RUN_BUDGETS.maxHttpCalls)
          return fail('budget_http', 'budget_http', base);
        const vals = values(base.variables);
        const sendsBody = current.body !== null && HTTP_BODY_METHODS.has(current.method);
        // A form body's values are URL-encoded and it says so (ADR-236); JSON is the default.
        const form = sendsBody && current.bodyFormat === 'form';
        const effect: RunEffect = {
          kind: 'http_request',
          method: current.method,
          url: renderHttpText(current.url, vals, encodeURIComponent),
          path: httpPathTemplate(current.url),
          headers: [
            ...current.headers.map((h) => ({
              name: h.name,
              parts: renderHttpHeader(h.value, vals),
            })),
            ...(form ? [{ name: 'Content-Type', parts: [{ text: FORM_CONTENT_TYPE }] }] : []),
          ],
          body:
            sendsBody && current.body
              ? renderHttpText(current.body, vals, form ? encodeFormValue : encodeJsonString)
              : null,
          save: current.save.map((item) => ({ path: item.path, saveAs: item.saveAs })),
        };
        return waitFor(
          'http',
          HTTP_WAIT_MINUTES,
          { ...base, httpCalls: base.httpCalls + 1 },
          [effect],
          'requested',
        );
      }
      case 'wait':
        return waitFor('timer', current.minutes, base, [], 'waiting');
      case 'handoff':
        return {
          noop: false,
          state: { ...base, nodeId: null, waiting: null },
          effects: [{ kind: 'handoff', teamId: current.teamId }],
          status: 'handed_off',
          endReason: 'handoff_node',
          log: {
            nodeId: current.id,
            nodeType: current.type,
            outcome: 'handed_off',
            branch: null,
            detail: null,
          },
        };
      case 'end':
        return {
          noop: false,
          state: { ...base, nodeId: null, waiting: null },
          effects: [],
          status: 'completed',
          endReason: 'end_node',
          log: {
            nodeId: current.id,
            nodeType: current.type,
            outcome: 'completed',
            branch: null,
            detail: null,
          },
        };
    }
  };

  // Handling a reply or a deadline at the node the run waits in.
  if (state.waiting) {
    if (event.kind === 'continue') {
      // Nothing to do yet; the runner never asks for this, but it must not advance the run.
      return {
        noop: true,
        state,
        effects: [],
        status: 'waiting',
        endReason: null,
        log: {
          nodeId: node.id,
          nodeType: node.type,
          outcome: 'waiting',
          branch: null,
          detail: 'not_due',
        },
      };
    }
    const counted: RunState = { ...state, steps: state.steps + 1 };
    const ignored = (detail: string): StepResult => ({
      noop: true,
      state,
      effects: [],
      status: 'waiting',
      endReason: null,
      log: {
        nodeId: node.id,
        nodeType: node.type,
        outcome: 'waiting',
        branch: null,
        detail,
      },
    });
    if (state.waiting.for === 'http' || node.type === 'http_request') {
      if (node.type !== 'http_request') return fail('error', 'not_a_request', counted);
      if (event.kind === 'reply') return ignored('ignored_reply');
      if (event.kind === 'deadline') {
        return moveTo(node.failureNext, counted, [], 'responded', 'failure', 'no_result');
      }
      if (!event.ok) {
        return moveTo(node.failureNext, counted, [], 'responded', 'failure', event.detail);
      }
      const variables: Record<string, string> = { ...counted.variables };
      for (const item of node.save) {
        const value = event.values[item.saveAs];
        if (typeof value === 'string') {
          variables[item.saveAs] = clipText(value, AUTOMATION_LIMITS.answerLength);
        }
      }
      return moveTo(node.next, { ...counted, variables }, [], 'responded', 'success', event.detail);
    }
    if (event.kind === 'http_result') return ignored('ignored_http_result');
    if (state.waiting.for === 'timer' || node.type === 'wait') {
      if (event.kind !== 'deadline') {
        return {
          noop: true,
          state,
          effects: [],
          status: 'waiting',
          endReason: null,
          log: {
            nodeId: node.id,
            nodeType: node.type,
            outcome: 'waiting',
            branch: null,
            detail: 'ignored_reply',
          },
        };
      }
      return moveTo(node.type === 'wait' ? node.next : null, counted, [], 'resumed', null);
    }
    if (event.kind === 'deadline') {
      const target =
        node.type === 'ask_buttons' || node.type === 'ask_text' || node.type === 'ask_template'
          ? node.timeoutNext
          : null;
      return moveTo(target, counted, [], 'timed_out', 'no reply');
    }
    // A reply.
    const reply = event.reply;
    if (node.type === 'ask_template') {
      const index = chosenTemplateButton(node, reply, runId, state.visit);
      if (index !== null) {
        const button = node.buttons[index] as { title: string; next: string | null };
        const variables = node.saveAs
          ? { ...counted.variables, [node.saveAs]: button.title }
          : counted.variables;
        return moveTo(button.next, { ...counted, variables }, [], 'answered', button.title);
      }
      return moveTo(
        node.replyNext,
        counted,
        [],
        'answered',
        node.buttons.length > 0 ? 'other reply' : 'reply',
      );
    }
    if (node.type === 'ask_buttons') {
      const index = chosenButton(node, reply, runId, state.visit);
      if (index !== null) {
        const button = node.buttons[index] as { title: string; next: string | null };
        const variables = node.saveAs
          ? { ...counted.variables, [node.saveAs]: button.title }
          : counted.variables;
        return moveTo(button.next, { ...counted, variables }, [], 'answered', button.title);
      }
      if (counted.retries < node.retries) {
        const built = message(counted, () =>
          buttonsEffect(node, node.retryText ?? node.body, counted.visit, counted.variables),
        );
        if (isResult(built)) return built;
        return waitFor(
          'reply',
          node.timeoutMinutes,
          { ...built.state, retries: counted.retries + 1 },
          [built.effect],
          'retried',
        );
      }
      return moveTo(node.noMatchNext, counted, [], 'answered', 'other reply');
    }
    if (node.type === 'ask_text') {
      const value = acceptAnswer(node.format, reply);
      if (value !== null) {
        return moveTo(
          node.next,
          { ...counted, variables: { ...counted.variables, [node.saveAs]: value } },
          [],
          'answered',
          'answer',
        );
      }
      if (counted.retries < node.retries) {
        const built = message(counted, () =>
          textEffect(node.retryText ?? node.text, counted.variables),
        );
        if (isResult(built)) return built;
        return waitFor(
          'reply',
          node.timeoutMinutes,
          { ...built.state, retries: counted.retries + 1 },
          [built.effect],
          'retried',
        );
      }
      return moveTo(node.invalidNext, counted, [], 'answered', 'invalid answer');
    }
    return fail('error', 'not_a_question', counted);
  }

  // Entering the node.
  if (event.kind !== 'continue') {
    // A reply or deadline for a run that is not waiting is not for this run.
    return {
      noop: true,
      state,
      effects: [],
      status: 'running',
      endReason: null,
      log: {
        nodeId: node.id,
        nodeType: node.type,
        outcome: 'waiting',
        branch: null,
        detail: 'unexpected_event',
      },
    };
  }
  const visits = (state.visits[node.id] ?? 0) + 1;
  if (visits > RUN_BUDGETS.maxVisitsPerNode) return fail('budget_loop', 'budget_loop');
  const entered: RunState = {
    ...state,
    steps: state.steps + 1,
    visit: visits,
    retries: 0,
    visits: { ...state.visits, [node.id]: visits },
  };
  return enter(node, entered);
}
