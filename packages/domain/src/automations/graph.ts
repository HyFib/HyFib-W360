import { z } from 'zod';
import { normalizeTag } from '../contacts/fields';
import { equalsKeyword, matchesKeyword, normalizeRoutingText } from '../inbox/keywords';

/**
 * The automation model: a trigger (when a run starts) and a graph of typed nodes (what it does).
 * This module has no server dependencies: the builder validates and simulates in the browser with
 * the same code the worker runs. Limits on interactive messages follow Meta's OpenAPI description
 * of the Cloud API (research M-157): at most 3 reply buttons, titles up to 20 characters, body up
 * to 1024, header and footer up to 60.
 */

export const NODE_ID_RE = /^[a-z0-9_-]{1,32}$/;
export const VARIABLE_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

export const AUTOMATION_LIMITS = {
  nodes: 60,
  keywords: 20,
  keywordLength: 60,
  textLength: 4096,
  questionLength: 1024,
  headerLength: 60,
  footerLength: 60,
  buttons: 3,
  buttonTitleLength: 20,
  rules: 10,
  ruleValueLength: 200,
  fieldValueLength: 500,
  answerLength: 1000,
  variables: 20,
  retries: 3,
  minutes: 1440,
  cooldownMinutes: 1440,
  labelLength: 60,
  httpUrlLength: 2000,
  httpHeaders: 10,
  httpHeaderValueLength: 1000,
  httpBodyLength: 8000,
  httpSaves: 10,
} as const;

/**
 * Run budgets: a run that reaches one fails and passes the conversation to people, so a mistake in
 * a graph (or a customer's auto-responder answering the bot) cannot loop for ever.
 */
export const RUN_BUDGETS = {
  /** Node executions and processed replies per run. */
  maxSteps: 200,
  /** Entries into one node per run (loops). */
  maxVisitsPerNode: 20,
  /** Messages the bot sends per run, including repeated questions. */
  maxMessages: 50,
  /** A run older than this fails as expired the next time it wakes. */
  maxRunMs: 7 * 24 * 3600_000,
  /** Runs started in one conversation per hour, across automations (bot-to-bot loops). */
  maxRunsPerConversationPerHour: 10,
  /** HTTP calls per run. */
  maxHttpCalls: 20,
} as const;

const nodeIdSchema = z.string().regex(NODE_ID_RE, 'Step ids use a-z, 0-9, - and _ (at most 32).');
const nextSchema = nodeIdSchema.nullable();
const labelSchema = z
  .string()
  .trim()
  .max(
    AUTOMATION_LIMITS.labelLength,
    `Step names are limited to ${AUTOMATION_LIMITS.labelLength} characters.`,
  )
  .optional();
const variableSchema = z
  .string()
  .regex(VARIABLE_RE, 'Answer names start with a letter and use a-z, 0-9 and _ (at most 32).');
const minutesSchema = z
  .number()
  .int('Use whole minutes.')
  .min(1, 'At least 1 minute.')
  .max(AUTOMATION_LIMITS.minutes, 'At most 24 hours (1440 minutes).');
const retriesSchema = z.number().int().min(0).max(AUTOMATION_LIMITS.retries);

function textSchema(max: number, what: string) {
  return z
    .string()
    .trim()
    .min(1, `Write the ${what}.`)
    .max(max, `The ${what} is limited to ${max} characters.`);
}

const optionalShortText = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, `The ${what} is limited to ${max} characters.`)
    .nullable()
    .transform((v) => (v ? v : null));

const tagSchema = z.string().transform((raw, ctx) => {
  const result = normalizeTag(raw);
  if (!result.ok) {
    ctx.addIssue({ code: 'custom', message: result.message });
    return z.NEVER;
  }
  return result.tag;
});

// Nodes ------------------------------------------------------------------------------------------

const sendTextNode = z.object({
  id: nodeIdSchema,
  type: z.literal('send_text'),
  label: labelSchema,
  text: textSchema(AUTOMATION_LIMITS.textLength, 'message'),
  next: nextSchema,
});

const askButtonsNode = z.object({
  id: nodeIdSchema,
  type: z.literal('ask_buttons'),
  label: labelSchema,
  header: optionalShortText(AUTOMATION_LIMITS.headerLength, 'header'),
  body: textSchema(AUTOMATION_LIMITS.questionLength, 'question'),
  footer: optionalShortText(AUTOMATION_LIMITS.footerLength, 'footer'),
  buttons: z
    .array(
      z.object({
        title: z
          .string()
          .trim()
          .min(1, 'Every button needs a title.')
          .max(
            AUTOMATION_LIMITS.buttonTitleLength,
            `WhatsApp limits button titles to ${AUTOMATION_LIMITS.buttonTitleLength} characters.`,
          ),
        next: nextSchema,
      }),
    )
    .min(1, 'Add at least one button.')
    .max(AUTOMATION_LIMITS.buttons, `WhatsApp allows at most ${AUTOMATION_LIMITS.buttons} buttons.`)
    .refine(
      (buttons) => new Set(buttons.map((b) => b.title.toLowerCase())).size === buttons.length,
      'Button titles must be different from each other.',
    ),
  saveAs: variableSchema.nullable(),
  retryText: optionalShortText(AUTOMATION_LIMITS.questionLength, 'repeated question'),
  retries: retriesSchema,
  noMatchNext: nextSchema,
  timeoutMinutes: minutesSchema,
  timeoutNext: nextSchema,
});

export const ANSWER_FORMATS = ['any', 'number', 'email'] as const;
export type AnswerFormat = (typeof ANSWER_FORMATS)[number];

const askTextNode = z.object({
  id: nodeIdSchema,
  type: z.literal('ask_text'),
  label: labelSchema,
  text: textSchema(AUTOMATION_LIMITS.textLength, 'question'),
  saveAs: variableSchema,
  format: z.enum(ANSWER_FORMATS),
  retryText: optionalShortText(AUTOMATION_LIMITS.textLength, 'repeated question'),
  retries: retriesSchema,
  invalidNext: nextSchema,
  timeoutMinutes: minutesSchema,
  timeoutNext: nextSchema,
  next: nextSchema,
});

export const COMPARISONS = [
  'equals',
  'not_equals',
  'contains',
  'is_set',
  'is_not_set',
  'greater_than',
  'less_than',
] as const;
export type Comparison = (typeof COMPARISONS)[number];
const VALUELESS: ReadonlySet<Comparison> = new Set(['is_set', 'is_not_set']);

const ruleValue = z
  .string()
  .trim()
  .max(
    AUTOMATION_LIMITS.ruleValueLength,
    `Values are limited to ${AUTOMATION_LIMITS.ruleValueLength} characters.`,
  )
  .nullable();

const ruleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('answer'),
    variable: variableSchema,
    op: z.enum(COMPARISONS),
    value: ruleValue,
  }),
  z.object({
    kind: z.literal('field'),
    field: z.string().regex(FIELD_KEY_RE, 'Choose a contact field.'),
    op: z.enum(COMPARISONS),
    value: ruleValue,
  }),
  z.object({ kind: z.literal('tag'), op: z.enum(['has', 'has_not']), tag: tagSchema }),
  z.object({ kind: z.literal('business_hours'), op: z.enum(['open', 'closed']) }),
]);
export type ConditionRule = z.infer<typeof ruleSchema>;

const conditionNode = z.object({
  id: nodeIdSchema,
  type: z.literal('condition'),
  label: labelSchema,
  match: z.enum(['all', 'any']),
  rules: z
    .array(ruleSchema)
    .min(1, 'Add at least one rule.')
    .max(AUTOMATION_LIMITS.rules, `At most ${AUTOMATION_LIMITS.rules} rules.`),
  then: nextSchema,
  else: nextSchema,
});

const updateContactNode = z.object({
  id: nodeIdSchema,
  type: z.literal('update_contact'),
  label: labelSchema,
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('add_tag'), tag: tagSchema }),
    z.object({ kind: z.literal('remove_tag'), tag: tagSchema }),
    z.object({
      kind: z.literal('set_field'),
      field: z.string().regex(FIELD_KEY_RE, 'Choose a contact field.'),
      value: textSchema(AUTOMATION_LIMITS.fieldValueLength, 'value'),
    }),
  ]),
  next: nextSchema,
});

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
/** Methods that send a body. */
export const HTTP_BODY_METHODS: ReadonlySet<HttpMethod> = new Set(['POST', 'PUT', 'PATCH']);
/** How long a run waits for an HTTP call's result before taking the failure branch. */
export const HTTP_WAIT_MINUTES = 2;
const HTTP_HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,59}$/;
/** Headers the egress client sets itself (framing, routing, the connection). */
const RESERVED_HTTP_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'accept-encoding',
]);
/** A path into a JSON response: keys and array positions separated by dots (data.items.0.id). */
export const RESPONSE_PATH_RE = /^[A-Za-z0-9_$-]{1,64}(\.[A-Za-z0-9_$-]{1,64}){0,9}$/;

const httpRequestNode = z.object({
  id: nodeIdSchema,
  type: z.literal('http_request'),
  label: labelSchema,
  method: z.enum(HTTP_METHODS),
  url: z
    .string()
    .trim()
    .min(1, 'Enter the address to call.')
    .max(
      AUTOMATION_LIMITS.httpUrlLength,
      `Addresses are limited to ${AUTOMATION_LIMITS.httpUrlLength} characters.`,
    ),
  headers: z
    .array(
      z.object({
        name: z
          .string()
          .trim()
          .regex(HTTP_HEADER_NAME_RE, 'Header names use letters, digits and - (at most 60).')
          .refine(
            (n) => !RESERVED_HTTP_HEADERS.has(n.toLowerCase()) && !/^proxy-/i.test(n),
            'HyFib sets this header itself.',
          ),
        value: z
          .string()
          .max(
            AUTOMATION_LIMITS.httpHeaderValueLength,
            `Header values are limited to ${AUTOMATION_LIMITS.httpHeaderValueLength} characters.`,
          )
          .refine(
            (v) => /^[\x20-\x7e]*$/.test(v),
            'Header values use printable ASCII characters, without line breaks (put other text in the body).',
          ),
      }),
    )
    .max(AUTOMATION_LIMITS.httpHeaders, `At most ${AUTOMATION_LIMITS.httpHeaders} headers.`),
  body: z
    .string()
    .max(
      AUTOMATION_LIMITS.httpBodyLength,
      `The body is limited to ${AUTOMATION_LIMITS.httpBodyLength} characters.`,
    )
    .nullable()
    .transform((v) => (v && v.trim() ? v : null)),
  /** Values to save from a JSON response, as answers. */
  save: z
    .array(
      z.object({
        path: z.string().trim().regex(RESPONSE_PATH_RE, 'Use a path such as data.order.status.'),
        saveAs: variableSchema,
      }),
    )
    .max(AUTOMATION_LIMITS.httpSaves, `At most ${AUTOMATION_LIMITS.httpSaves} saved values.`),
  /** A 2xx response. */
  next: nextSchema,
  /** Anything else: another status, a refused or failed call, no result in time. */
  failureNext: nextSchema,
});

const waitNode = z.object({
  id: nodeIdSchema,
  type: z.literal('wait'),
  label: labelSchema,
  minutes: minutesSchema,
  next: nextSchema,
});

const handoffNode = z.object({
  id: nodeIdSchema,
  type: z.literal('handoff'),
  label: labelSchema,
  /** Team to place the conversation in (null: route as a new conversation of the number). */
  teamId: z.uuid('Choose a team.').nullable(),
});

const endNode = z.object({ id: nodeIdSchema, type: z.literal('end'), label: labelSchema });

export const nodeSchema = z.discriminatedUnion('type', [
  sendTextNode,
  askButtonsNode,
  askTextNode,
  conditionNode,
  updateContactNode,
  httpRequestNode,
  waitNode,
  handoffNode,
  endNode,
]);
export type AutomationNode = z.infer<typeof nodeSchema>;
export type NodeType = AutomationNode['type'];
export type NodeOf<T extends NodeType> = Extract<AutomationNode, { type: T }>;

export const NODE_TYPES: readonly NodeType[] = [
  'send_text',
  'ask_buttons',
  'ask_text',
  'condition',
  'update_contact',
  'http_request',
  'wait',
  'handoff',
  'end',
];

export const NODE_TYPE_LABELS: Record<NodeType, string> = {
  send_text: 'Send a message',
  ask_buttons: 'Ask with buttons',
  ask_text: 'Ask a question',
  condition: 'Condition',
  update_contact: 'Update contact',
  http_request: 'Call a web address',
  wait: 'Wait',
  handoff: 'Hand off to people',
  end: 'End',
};

/** Nodes that wait for the customer or a timer (a loop must pass through one). */
export const WAITING_NODE_TYPES: ReadonlySet<NodeType> = new Set([
  'ask_buttons',
  'ask_text',
  'wait',
]);

export const graphSchema = z.object({
  version: z.literal(1),
  start: nodeIdSchema,
  nodes: z
    .array(nodeSchema)
    .min(1, 'Add at least one step.')
    .max(AUTOMATION_LIMITS.nodes, `An automation has at most ${AUTOMATION_LIMITS.nodes} steps.`),
});
export type AutomationGraph = z.infer<typeof graphSchema>;

// Trigger ----------------------------------------------------------------------------------------

export const TRIGGER_TYPES = ['keyword', 'conversation_started', 'any_message'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];
export const TRIGGER_HOURS = ['any', 'open', 'closed'] as const;
export type TriggerHours = (typeof TRIGGER_HOURS)[number];

const keywordSchema = z
  .string()
  .max(
    AUTOMATION_LIMITS.keywordLength,
    `Keywords are limited to ${AUTOMATION_LIMITS.keywordLength} characters.`,
  )
  .transform((raw, ctx) => {
    const k = normalizeRoutingText(raw);
    if (!k) {
      ctx.addIssue({ code: 'custom', message: 'Keywords need at least one letter or digit.' });
      return z.NEVER;
    }
    return k;
  });

const triggerCommon = {
  /** Start only while the business is open, only while it is closed, or at any time. */
  hours: z.enum(TRIGGER_HOURS),
  /** Minimum minutes between two runs of this automation in one conversation. */
  cooldownMinutes: z
    .number()
    .int('Use whole minutes.')
    .min(0)
    .max(AUTOMATION_LIMITS.cooldownMinutes, 'At most 24 hours (1440 minutes).'),
};

export const triggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('keyword'),
    keywords: z
      .array(keywordSchema)
      .min(1, 'Add at least one keyword.')
      .max(AUTOMATION_LIMITS.keywords, `At most ${AUTOMATION_LIMITS.keywords} keywords.`)
      .transform((list) => [...new Set(list)]),
    match: z.enum(['exact', 'contains']),
    ...triggerCommon,
  }),
  z.object({ type: z.literal('conversation_started'), ...triggerCommon }),
  z.object({ type: z.literal('any_message'), ...triggerCommon }),
]);
export type AutomationTrigger = z.infer<typeof triggerSchema>;

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  keyword: 'A message contains a keyword',
  conversation_started: 'A customer starts a conversation',
  any_message: 'Any customer message',
};

/** How strongly a trigger matched; lower wins (exact keyword, keyword, new conversation, any). */
export type TriggerRank = 0 | 1 | 2 | 3;

/**
 * Whether a customer message starts this trigger. `text` is the message text (or the tapped
 * button's text); `newCase` is true for the first message of a new conversation or of a reopened
 * one. Business hours and cooldowns are checked by the dispatcher.
 */
export function matchTrigger(
  trigger: AutomationTrigger,
  message: { text: string | null; newCase: boolean },
): TriggerRank | null {
  switch (trigger.type) {
    case 'keyword': {
      if (!message.text) return null;
      const text = message.text;
      if (trigger.match === 'exact')
        return trigger.keywords.some((k) => equalsKeyword(text, k)) ? 0 : null;
      if (trigger.keywords.some((k) => equalsKeyword(text, k))) return 0;
      return trigger.keywords.some((k) => matchesKeyword(text, k)) ? 1 : null;
    }
    case 'conversation_started':
      return message.newCase ? 2 : null;
    case 'any_message':
      return 3;
  }
}

export function describeTrigger(trigger: AutomationTrigger): string {
  const hours =
    trigger.hours === 'open'
      ? ' while the business is open'
      : trigger.hours === 'closed'
        ? ' while the business is closed'
        : '';
  switch (trigger.type) {
    case 'keyword':
      return `${trigger.match === 'exact' ? 'A message is exactly' : 'A message contains'} ${trigger.keywords
        .map((k) => `“${k}”`)
        .join(', ')}${hours}`;
    case 'conversation_started':
      return `A customer starts a conversation${hours}`;
    case 'any_message':
      return `Any customer message${hours}`;
  }
}

// Text placeholders -------------------------------------------------------------------------------

/** {{name}} (the contact's name), {{company}} and {{answer.<name>}} (a captured answer). */
export const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g;

export interface TextValues {
  contactName: string | null;
  companyName: string;
  variables: Readonly<Record<string, string>>;
}

export function renderText(template: string, values: TextValues): string {
  return template
    .replace(PLACEHOLDER_RE, (whole, raw: string) => {
      const name = raw.toLowerCase();
      if (name === 'name') return values.contactName ?? '';
      if (name === 'company') return values.companyName;
      if (name.startsWith('answer.')) return values.variables[name.slice(7)] ?? '';
      return whole;
    })
    .trim();
}

/** Names of HTTP secrets ({{secret.<name>}}), stored encrypted by the company. */
export const SECRET_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Renders the address or body of an HTTP step: {{name}}, {{company}} and {{answer.<name>}} are
 * filled through `encode` (URL-encoded in the address, JSON-escaped in the body). Secrets are only
 * allowed in header values (see `renderHttpHeader`); anything else stays as written.
 */
export function renderHttpText(
  template: string,
  values: TextValues,
  encode: (value: string) => string,
): string {
  return template.replace(PLACEHOLDER_RE, (whole, raw: string) => {
    const value = placeholderValue(raw.toLowerCase(), values);
    return value === null ? whole : encode(value);
  });
}

function placeholderValue(name: string, values: TextValues): string | null {
  if (name === 'name') return values.contactName ?? '';
  if (name === 'company') return values.companyName;
  if (name.startsWith('answer.')) return values.variables[name.slice(7)] ?? '';
  return null;
}

/** Escapes a value for use inside a JSON string of an HTTP body. */
export const encodeJsonString = (value: string): string => JSON.stringify(value).slice(1, -1);

const utf8 = new TextEncoder();
/**
 * Makes a value safe in a header value: printable ASCII other than % stays; anything else (line
 * breaks, other scripts, emoji, %) is percent-encoded as UTF-8, so the receiver can decode it.
 */
export const encodeHeaderValue = (value: string): string =>
  value.replace(/[^\x20-\x24\x26-\x7e]/gu, (c) =>
    Array.from(utf8.encode(c), (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join(''),
  );

/** A header value of an HTTP call: text, and the secrets the worker fills in, in order. */
export type HttpHeaderPart = { text: string } | { secret: string };

/**
 * Renders a header value into parts. Values are filled as text (header-encoded) and never read as
 * placeholders again, so a customer's name or answer cannot pull in a secret; only the step's own
 * {{secret.<name>}} placeholders become secret parts.
 */
export function renderHttpHeader(template: string, values: TextValues): HttpHeaderPart[] {
  const parts: HttpHeaderPart[] = [];
  let text = '';
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    text += template.slice(last, match.index);
    last = match.index + match[0].length;
    const name = (match[1] ?? '').toLowerCase();
    if (name.startsWith('secret.') && SECRET_NAME_RE.test(name.slice(7))) {
      if (text) parts.push({ text });
      text = '';
      parts.push({ secret: name.slice(7) });
      continue;
    }
    const value = placeholderValue(name, values);
    text += value === null ? match[0] : encodeHeaderValue(value);
  }
  text += template.slice(last);
  if (text) parts.push({ text });
  return parts;
}

/** A header value for display: secrets are shown as their placeholders, never as values. */
export const httpHeaderText = (parts: readonly HttpHeaderPart[]): string =>
  parts.map((p) => ('secret' in p ? `{{secret.${p.secret}}}` : p.text)).join('');

/**
 * Whether `host` is on a company's list of allowed domains: an exact name ("api.example.com") or
 * any subdomain of a wildcard entry ("*.example.com", which does not include example.com itself).
 */
export function hostAllowed(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return domains.some((d) =>
    d.startsWith('*.') ? h.endsWith(d.slice(1)) && h.length > d.length - 1 : h === d,
  );
}

/** The host an HTTP step calls, when its address names one (no placeholders in the host). */
export function httpStepHost(url: string): string | null {
  const authority = url.replace(/^https?:\/\//i, '').split(/[/?#]/, 1)[0] ?? '';
  if (authority.includes('{{') || !URL.canParse(url.replace(PLACEHOLDER_RE, 'x'))) return null;
  const host = new URL(url.replace(PLACEHOLDER_RE, 'x')).hostname;
  return host.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '') || null;
}

/**
 * The path of an HTTP step's address as written, placeholders not filled in and without the query
 * (for the call record: it names the endpoint and never holds a customer's values).
 */
export function httpPathTemplate(url: string): string {
  const rest = url.replace(/^https?:\/\/[^/?#]*/i, '');
  const path = rest.split(/[?#]/, 1)[0] ?? '';
  return (path.startsWith('/') ? path : `/${path}`).slice(0, 300);
}

/** Placeholders used by a text: unknown ones, captured answers and (when allowed) secrets. */
function placeholdersIn(
  text: string,
  allowSecrets = false,
): { unknown: string[]; answers: string[]; secrets: string[]; literal: boolean } {
  const unknown: string[] = [];
  const answers: string[] = [];
  const secrets: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const name = (match[1] ?? '').toLowerCase();
    if (name === 'name' || name === 'company') continue;
    if (name.startsWith('answer.') && VARIABLE_RE.test(name.slice(7))) answers.push(name.slice(7));
    else if (allowSecrets && name.startsWith('secret.') && SECRET_NAME_RE.test(name.slice(7)))
      secrets.push(name.slice(7));
    else unknown.push(match[0]);
  }
  const literal = text.replace(PLACEHOLDER_RE, '').trim().length > 0;
  return { unknown, answers, secrets, literal };
}

/** Problems with an HTTP step's address and body (placeholders are checked separately). */
function httpStepIssues(node: NodeOf<'http_request'>, refs: GraphReferences): string[] {
  const out: string[] = [];
  const insecure = /^http:\/\//i.test(node.url);
  if (!/^https:\/\//i.test(node.url) && !(insecure && refs.allowInsecureHttp)) {
    out.push('Use an https:// address.');
  } else {
    const authority = node.url.replace(/^https?:\/\//i, '').split(/[/?#]/, 1)[0] ?? '';
    if (authority.includes('{{')) {
      out.push('The host name cannot contain placeholders.');
    } else {
      let parsed: URL | null = null;
      try {
        parsed = new URL(node.url.replace(PLACEHOLDER_RE, 'x'));
      } catch {
        out.push('Enter a valid address.');
      }
      if (parsed) {
        const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
        if (parsed.username || parsed.password) {
          out.push('Put credentials in a header, not in the address.');
        } else if (refs.allowedDomains && !hostAllowed(host, refs.allowedDomains)) {
          out.push(
            `${host} is not an allowed domain. An administrator can add it under Settings → Web requests.`,
          );
        }
      }
    }
  }
  if (node.body && !HTTP_BODY_METHODS.has(node.method)) {
    out.push(`${node.method} requests have no body.`);
  } else if (node.body) {
    try {
      JSON.parse(node.body.replace(PLACEHOLDER_RE, 'x'));
    } catch {
      out.push('The body must be JSON, with placeholders inside quotes.');
    }
  }
  return out;
}

// Graph checks -----------------------------------------------------------------------------------

export interface GraphIssue {
  level: 'error' | 'warning';
  /** The step the issue belongs to (null: the automation as a whole). */
  nodeId: string | null;
  message: string;
}

/** Outgoing edges of a node with a label for each. */
export function edgesOf(node: AutomationNode): { label: string; target: string | null }[] {
  switch (node.type) {
    case 'send_text':
    case 'update_contact':
    case 'wait':
      return [{ label: 'next', target: node.next }];
    case 'ask_buttons':
      return [
        ...node.buttons.map((b) => ({ label: b.title, target: b.next })),
        { label: 'other reply', target: node.noMatchNext },
        { label: 'no reply', target: node.timeoutNext },
      ];
    case 'ask_text':
      return [
        { label: 'answer', target: node.next },
        { label: 'invalid answer', target: node.invalidNext },
        { label: 'no reply', target: node.timeoutNext },
      ];
    case 'condition':
      return [
        { label: 'yes', target: node.then },
        { label: 'no', target: node.else },
      ];
    case 'http_request':
      return [
        { label: 'success', target: node.next },
        { label: 'failure', target: node.failureNext },
      ];
    case 'handoff':
    case 'end':
      return [];
  }
}

/** Texts a node sends or stores, for placeholder checks. */
function textsOf(node: AutomationNode): string[] {
  switch (node.type) {
    case 'send_text':
      return [node.text];
    case 'ask_buttons':
      return [node.body, ...(node.retryText ? [node.retryText] : [])];
    case 'ask_text':
      return [node.text, ...(node.retryText ? [node.retryText] : [])];
    case 'update_contact':
      return node.action.kind === 'set_field' ? [node.action.value] : [];
    default:
      return [];
  }
}

export interface GraphReferences {
  /** Teams of the company; when given, hand-off teams must be among them. */
  teamIds?: ReadonlySet<string>;
  /** Contact field keys of the company; when given, fields must be among them. */
  fieldKeys?: ReadonlySet<string>;
  /** Domains the company allows HTTP steps to call; when given, addresses must match one. */
  allowedDomains?: readonly string[];
  /**
   * The company's HTTP secrets by name, with the domain each may be sent to; when given, secrets
   * used must be among them and the step must call their domain.
   */
  secrets?: ReadonlyMap<string, string>;
  /** http:// addresses, for local test targets only (the server decides from its configuration). */
  allowInsecureHttp?: boolean;
}

/**
 * Checks a structurally valid graph: every step and branch target exists, answers are saved before
 * they are used, loops wait for the customer or a timer, and referenced teams and fields exist.
 * Errors block publishing; warnings are shown in the builder.
 */
export function checkGraph(graph: AutomationGraph, refs: GraphReferences = {}): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const byId = new Map<string, AutomationNode>();
  for (const node of graph.nodes) {
    if (byId.has(node.id))
      issues.push({
        level: 'error',
        nodeId: node.id,
        message: `Two steps use the id “${node.id}”.`,
      });
    byId.set(node.id, node);
  }
  if (!byId.has(graph.start))
    issues.push({ level: 'error', nodeId: null, message: 'The first step does not exist.' });

  const saved = new Set<string>();
  for (const node of graph.nodes) {
    if ((node.type === 'ask_buttons' || node.type === 'ask_text') && node.saveAs)
      saved.add(node.saveAs);
    if (node.type === 'http_request') for (const item of node.save) saved.add(item.saveAs);
  }
  const reachable = reachableFrom(graph.start, byId);
  const available = answerAvailability(graph.start, byId, reachable, saved);
  if (saved.size > AUTOMATION_LIMITS.variables) {
    issues.push({
      level: 'error',
      nodeId: null,
      message: `An automation can save at most ${AUTOMATION_LIMITS.variables} different answers.`,
    });
  }

  /** Errors or a warning when a step uses an answer that is not saved (on every path) before it. */
  const checkAnswerUse = (nodeId: string, a: string) => {
    const at = available.get(nodeId);
    if (!saved.has(a)) {
      issues.push({
        level: 'error',
        nodeId,
        message: `{{answer.${a}}} is not saved by any question or web request.`,
      });
    } else if (at && !at.may.has(a)) {
      issues.push({
        level: 'error',
        nodeId,
        message: `{{answer.${a}}} is used before any question saves it.`,
      });
    } else if (at && !at.must.has(a)) {
      issues.push({
        level: 'warning',
        nodeId,
        message: `{{answer.${a}}} can be empty here: some paths reach this step without saving it.`,
      });
    }
  };

  for (const node of graph.nodes) {
    for (const edge of edgesOf(node)) {
      if (edge.target !== null && !byId.has(edge.target)) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message: `“${edge.label}” goes to a step that does not exist (${edge.target}).`,
        });
      }
    }
    for (const text of textsOf(node)) {
      const found = placeholdersIn(text);
      for (const u of found.unknown) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message: `Unknown placeholder ${u}. Use {{name}}, {{company}} or {{answer.<name>}}.`,
        });
      }
      for (const a of found.answers) checkAnswerUse(node.id, a);
      if (!found.literal && node.type !== 'update_contact') {
        issues.push({
          level: 'warning',
          nodeId: node.id,
          message: 'This text is only placeholders; if they are empty the message cannot be sent.',
        });
      }
    }
    if (node.type === 'http_request') {
      for (const message of httpStepIssues(node, refs)) {
        issues.push({ level: 'error', nodeId: node.id, message });
      }
      const host = httpStepHost(node.url);
      const texts = [
        { text: node.url, headers: false },
        ...node.headers.map((h) => ({ text: h.value, headers: true })),
        ...(node.body ? [{ text: node.body, headers: false }] : []),
      ];
      for (const { text, headers } of texts) {
        const found = placeholdersIn(text, headers);
        for (const u of found.unknown) {
          issues.push({
            level: 'error',
            nodeId: node.id,
            message: headers
              ? `Unknown placeholder ${u}. Use {{name}}, {{company}}, {{answer.<name>}} or {{secret.<name>}}.`
              : /secret\./i.test(u)
                ? `Secrets can only be used in header values (${u}).`
                : `Unknown placeholder ${u}. Use {{name}}, {{company}} or {{answer.<name>}}.`,
          });
        }
        for (const a of found.answers) checkAnswerUse(node.id, a);
        for (const secret of found.secrets) {
          const domain = refs.secrets?.get(secret);
          if (refs.secrets && domain === undefined) {
            issues.push({
              level: 'error',
              nodeId: node.id,
              message: `The secret “${secret}” does not exist. An administrator can add it under Settings → Web requests.`,
            });
          } else if (domain !== undefined && host !== null && !hostAllowed(host, [domain])) {
            issues.push({
              level: 'error',
              nodeId: node.id,
              message: `The secret “${secret}” can only be sent to ${domain}.`,
            });
          }
        }
      }
      const names = node.save.map((item) => item.saveAs);
      if (new Set(names).size !== names.length) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message: 'Save each value under a different name.',
        });
      }
    }
    if (node.type === 'condition') {
      const at = available.get(node.id);
      for (const rule of node.rules) {
        if (rule.kind === 'answer' && !saved.has(rule.variable)) {
          issues.push({
            level: 'error',
            nodeId: node.id,
            message: `The answer “${rule.variable}” is not saved by any question or web request.`,
          });
        } else if (rule.kind === 'answer' && at && !at.may.has(rule.variable)) {
          issues.push({
            level: 'error',
            nodeId: node.id,
            message: `The answer “${rule.variable}” is checked before any question saves it.`,
          });
        } else if (
          rule.kind === 'answer' &&
          at &&
          !at.must.has(rule.variable) &&
          !VALUELESS.has(rule.op)
        ) {
          // “is set” / “is not set” exist precisely for answers that some paths skip.
          issues.push({
            level: 'warning',
            nodeId: node.id,
            message: `The answer “${rule.variable}” can be unset here: some paths reach this step without saving it.`,
          });
        }
        if (
          (rule.kind === 'answer' || rule.kind === 'field') &&
          !VALUELESS.has(rule.op) &&
          !rule.value
        ) {
          issues.push({ level: 'error', nodeId: node.id, message: 'A rule is missing its value.' });
        }
        if (rule.kind === 'field' && refs.fieldKeys && !refs.fieldKeys.has(rule.field)) {
          issues.push({
            level: 'error',
            nodeId: node.id,
            message: `The contact field “${rule.field}” does not exist.`,
          });
        }
      }
    }
    if (
      node.type === 'update_contact' &&
      node.action.kind === 'set_field' &&
      refs.fieldKeys &&
      !refs.fieldKeys.has(node.action.field)
    ) {
      issues.push({
        level: 'error',
        nodeId: node.id,
        message: `The contact field “${node.action.field}” does not exist.`,
      });
    }
    if (node.type === 'handoff' && node.teamId && refs.teamIds && !refs.teamIds.has(node.teamId)) {
      issues.push({ level: 'error', nodeId: node.id, message: 'The team no longer exists.' });
    }
    if (
      ((node.type === 'ask_buttons' || node.type === 'ask_text') && node.timeoutMinutes > 1380) ||
      (node.type === 'wait' && node.minutes > 1380)
    ) {
      issues.push({
        level: 'warning',
        nodeId: node.id,
        message:
          'After about 24 hours without a customer message WhatsApp allows only templates, so later messages of this run will fail.',
      });
    }
  }

  for (const node of graph.nodes) {
    if (!reachable.has(node.id)) {
      issues.push({ level: 'warning', nodeId: node.id, message: 'No step leads here.' });
    }
  }

  // A loop made only of steps that do not wait would run until the step budget ends it.
  for (const cycle of loopsWithoutWaiting(graph.nodes, byId)) {
    issues.push({
      level: 'error',
      nodeId: cycle[0] ?? null,
      message: `The steps ${cycle.join(' → ')} form a loop that never waits for the customer or a timer.`,
    });
  }
  return issues;
}

/** Steps the first step leads to, directly or not (the first step included). */
function reachableFrom(start: string, byId: ReadonlyMap<string, AutomationNode>): Set<string> {
  const reachable = new Set<string>();
  const stack = byId.has(start) ? [start] : [];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const node = byId.get(id);
    if (!node) continue;
    for (const edge of edgesOf(node))
      if (edge.target && byId.has(edge.target)) stack.push(edge.target);
  }
  return reachable;
}

/**
 * The answers a step saves when the run leaves it by the edge at `index` of `edgesOf`: `must` are
 * always set, `may` perhaps. A question's answered edges (a button, or a valid typed answer) set its
 * answer; other replies, invalid answers and timeouts do not. A web request's success edge may set
 * its values (a response can lack a field).
 */
function answersSavedOnEdge(
  node: AutomationNode,
  index: number,
): { may: readonly string[]; must: readonly string[] } {
  const none = { may: [], must: [] };
  if (node.type === 'ask_buttons') {
    return index < node.buttons.length && node.saveAs
      ? { may: [node.saveAs], must: [node.saveAs] }
      : none;
  }
  if (node.type === 'ask_text') {
    return index === 0 ? { may: [node.saveAs], must: [node.saveAs] } : none;
  }
  if (node.type === 'http_request' && index === 0) {
    return { may: node.save.map((item) => item.saveAs), must: [] };
  }
  return none;
}

/**
 * For each reachable step, the answers saved before it runs: `may` on at least one path from the
 * first step, `must` on every path (forward data flow over the edges, iterated to a fixed point so
 * loops are covered).
 */
function answerAvailability(
  start: string,
  byId: ReadonlyMap<string, AutomationNode>,
  reachable: ReadonlySet<string>,
  all: ReadonlySet<string>,
): Map<string, { may: Set<string>; must: Set<string> }> {
  const flow = new Map<string, { may: Set<string>; must: Set<string> }>();
  for (const id of reachable) {
    flow.set(id, { may: new Set(), must: id === start ? new Set() : new Set(all) });
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of reachable) {
      const node = byId.get(id);
      const from = flow.get(id);
      if (!node || !from) continue;
      edgesOf(node).forEach((edge, index) => {
        const to = edge.target === null ? undefined : flow.get(edge.target);
        if (!to) return;
        const answers = answersSavedOnEdge(node, index);
        for (const a of [...from.may, ...answers.may]) {
          if (!to.may.has(a)) {
            to.may.add(a);
            changed = true;
          }
        }
        // The first step is also entered with nothing saved, so its `must` stays empty.
        if (edge.target === start) return;
        for (const a of [...to.must]) {
          if (!answers.must.includes(a) && !from.must.has(a)) {
            to.must.delete(a);
            changed = true;
          }
        }
      });
    }
  }
  return flow;
}

/** Strongly connected groups of non-waiting nodes that contain a cycle (Tarjan). */
function loopsWithoutWaiting(
  nodes: readonly AutomationNode[],
  byId: ReadonlyMap<string, AutomationNode>,
): string[][] {
  const active = nodes.filter((n) => !WAITING_NODE_TYPES.has(n.type));
  const activeIds = new Set(active.map((n) => n.id));
  const successors = (node: AutomationNode) =>
    edgesOf(node)
      .map((e) => e.target)
      .filter((t): t is string => t !== null && activeIds.has(t) && byId.has(t));
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const loops: string[][] = [];
  const visit = (node: AutomationNode) => {
    indices.set(node.id, index);
    low.set(node.id, index);
    index += 1;
    stack.push(node.id);
    onStack.add(node.id);
    for (const next of successors(node)) {
      if (!indices.has(next)) {
        visit(byId.get(next) as AutomationNode);
        low.set(node.id, Math.min(low.get(node.id) as number, low.get(next) as number));
      } else if (onStack.has(next)) {
        low.set(node.id, Math.min(low.get(node.id) as number, indices.get(next) as number));
      }
    }
    if (low.get(node.id) === indices.get(node.id)) {
      const group: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        group.push(member);
      } while (member !== node.id);
      const selfLoop = group.length === 1 && successors(node).includes(node.id);
      if (group.length > 1 || selfLoop) loops.push(group.reverse());
    }
  };
  for (const node of active) if (!indices.has(node.id)) visit(node);
  return loops;
}

// Parsing ----------------------------------------------------------------------------------------

export interface GraphParseIssue {
  nodeId: string | null;
  message: string;
}

/**
 * Parses a submitted graph. Structural problems (missing fields, texts over WhatsApp's limits) are
 * returned per step; a graph that parses may still have `checkGraph` issues.
 */
export function parseGraph(
  input: unknown,
): { ok: true; graph: AutomationGraph } | { ok: false; issues: GraphParseIssue[] } {
  const parsed = graphSchema.safeParse(input);
  if (parsed.success) return { ok: true, graph: parsed.data };
  const nodes = (input as { nodes?: unknown } | null)?.nodes;
  const issues = parsed.error.issues.map((issue) => {
    let nodeId: string | null = null;
    if (issue.path[0] === 'nodes' && typeof issue.path[1] === 'number' && Array.isArray(nodes)) {
      const raw = nodes[issue.path[1]] as { id?: unknown } | undefined;
      nodeId = typeof raw?.id === 'string' ? raw.id : null;
    }
    return { nodeId, message: issue.message };
  });
  return { ok: false, issues };
}

export function parseTrigger(
  input: unknown,
): { ok: true; trigger: AutomationTrigger } | { ok: false; message: string } {
  const parsed = triggerSchema.safeParse(input);
  if (parsed.success) return { ok: true, trigger: parsed.data };
  return { ok: false, message: parsed.error.issues[0]?.message ?? 'The trigger is not valid.' };
}

/** A new automation's starting point: a greeting that ends the run. */
export function starterGraph(): AutomationGraph {
  return {
    version: 1,
    start: 'welcome',
    nodes: [
      {
        id: 'welcome',
        type: 'send_text',
        label: 'Welcome',
        text: 'Hello {{name}}! Thanks for your message.',
        next: null,
      },
    ],
  };
}

export function starterTrigger(): AutomationTrigger {
  return { type: 'conversation_started', hours: 'any', cooldownMinutes: 60 };
}

/** A step id not used in the graph, derived from the node type. */
export function newNodeId(graph: AutomationGraph, type: NodeType): string {
  const used = new Set(graph.nodes.map((n) => n.id));
  const base = type.replace(/_/g, '-');
  for (let i = 1; i < 1000; i += 1) {
    const id = `${base}-${i}`;
    if (!used.has(id)) return id;
  }
  throw new Error('No step id available');
}

/** Canonical JSON (sorted keys) for hashing a definition. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
