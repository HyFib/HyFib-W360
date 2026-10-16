import { z } from 'zod';
import { normalizeTag } from '../contacts/fields';
import {
  equalsKeyword,
  equalsKeywordWithTypos,
  matchesKeyword,
  matchesKeywordWithTypos,
  normalizeRoutingText,
  typoAllowance,
} from '../inbox/keywords';
import { parseAmountToMinor } from '../crm/money';
import { coerceDealFieldValue, type DealFieldShape } from '../crm/deal-field-values';
import { PRODUCT_MESSAGE_LIMITS } from '../commerce/product-message';
import { FLOW_LIMITS } from '../flows/flow-json';
import { TEMPLATE_LIMITS } from '../templates/definition';

/**
 * The automation model: a trigger (when a run starts) and a graph of typed nodes (what it does).
 * This module has no server dependencies: the builder validates and simulates in the browser with
 * the same code the worker runs. Limits on interactive messages follow Meta's OpenAPI description
 * of the Cloud API (research M-157): at most 3 reply buttons, titles up to 20 characters, body up
 * to 1024, header and footer up to 60. Template steps (ADR-050) send an approved template, which
 * WhatsApp allows outside the 24-hour service window, with the template limits of P3.
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
  /** Inputs an automation started through the API declares, and the characters of each value. */
  apiInputs: 10,
  apiInputLength: 1000,
  /** A CRM task's title (as the CRM allows) and how far ahead its due time may be (90 days). */
  taskTitleLength: 200,
  taskDueHours: 2160,
  /** A CRM deal's title (as the CRM allows), and the characters of its value as typed. */
  dealTitleLength: 120,
  dealValueLength: 24,
  /** How far ahead a deal step's expected close date may be, in days. */
  dealCloseDays: 365,
  /** A lost deal's reason, as the CRM limits it (ADR-251). */
  dealLostReasonLength: 200,
  /** Custom deal fields one step sets (ADR-386); a value has `fieldValueLength` characters. */
  dealFieldValues: 20,
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
  /** A tag on the run's conversation (ADR-222), as members put them on it in the inbox. */
  z.object({
    kind: z.literal('conversation_tag'),
    op: z.enum(['has', 'has_not']),
    tag: tagSchema,
  }),
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

/** Tags the run's conversation (ADR-222), as members do in the inbox. */
const updateConversationNode = z.object({
  id: nodeIdSchema,
  type: z.literal('update_conversation'),
  label: labelSchema,
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('add_tag'), tag: tagSchema }),
    z.object({ kind: z.literal('remove_tag'), tag: tagSchema }),
  ]),
  next: nextSchema,
});

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
/** Methods that send a body. */
export const HTTP_BODY_METHODS: ReadonlySet<HttpMethod> = new Set(['POST', 'PUT', 'PATCH']);
/**
 * How an HTTP step's body is written and sent (ADR-236): JSON (application/json, the default when
 * a step does not say), or form fields (application/x-www-form-urlencoded), whose placeholders are
 * URL-encoded.
 */
export const HTTP_BODY_FORMATS = ['json', 'form'] as const;
export type HttpBodyFormat = (typeof HTTP_BODY_FORMATS)[number];
export const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
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
  /** The body's format; left out, JSON (ADR-236). */
  bodyFormat: z.enum(HTTP_BODY_FORMATS).optional(),
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

/**
 * One of the company's WhatsApp forms (Flows) sent in the conversation (ADR-248), a session message
 * like a text: the customer's answers are applied to the contact as the form maps them. The message
 * may hold placeholders; the header, footer and button text are sent as written.
 */
const sendFlowNode = z.object({
  id: nodeIdSchema,
  type: z.literal('send_flow'),
  label: labelSchema,
  flowId: z.uuid('Choose a form.'),
  header: optionalShortText(FLOW_LIMITS.headerLength, 'header'),
  body: textSchema(FLOW_LIMITS.bodyLength, 'message'),
  footer: optionalShortText(FLOW_LIMITS.footerLength, 'footer'),
  cta: textSchema(FLOW_LIMITS.ctaLength, 'button text'),
  next: nextSchema,
});

/**
 * A CRM task about the run's contact for a member of the company (ADR-244), created by the
 * automation. The title may hold placeholders, filled in when the step runs.
 */
const createTaskNode = z.object({
  id: nodeIdSchema,
  type: z.literal('create_task'),
  label: labelSchema,
  title: textSchema(AUTOMATION_LIMITS.taskTitleLength, 'task title'),
  /** Who the task is for: an active member who can use the CRM, checked again when it runs. */
  assigneeMembershipId: z.uuid('Choose who the task is for.'),
  /** Due this many hours after the step runs; null: no due time. */
  dueInHours: z
    .number()
    .int('Use whole hours.')
    .min(1, 'At least 1 hour.')
    .max(AUTOMATION_LIMITS.taskDueHours, 'At most 90 days (2160 hours).')
    .nullable(),
  /** Email the member when the task is due (ADR-246); needs a due time. Absent: no reminder. */
  remind: z.boolean().optional(),
  next: nextSchema,
});

/** What a products step sends: one product, a list of products, or the catalog (ADR-383). */
export const PRODUCT_STEP_KINDS = ['product', 'product_list', 'catalog'] as const;
export type ProductStepKind = (typeof PRODUCT_STEP_KINDS)[number];

/**
 * Products of each catalog the automation builder lists for products steps, the first by name (as
 * many as the inbox lists).
 */
export const PRODUCT_PICKER_LIMIT = 500;

/**
 * Products of one of the company's catalogs sent in the conversation (ADR-383), a session message
 * like a text: one product, a list of products (one section), or the catalog shown with one of its
 * products. Products are named by HyFib's ids and sent by their retailer ids in their catalog. The
 * message may hold placeholders; the heading, section title and footer are sent as written. What
 * each kind needs is checked with the graph, so an unfinished draft can be saved.
 */
const sendProductsNode = z.object({
  id: nodeIdSchema,
  type: z.literal('send_products'),
  label: labelSchema,
  kind: z.enum(PRODUCT_STEP_KINDS),
  productIds: z
    .array(z.uuid('Choose a product.'))
    .max(
      PRODUCT_MESSAGE_LIMITS.productsPerMessage,
      `Send at most ${PRODUCT_MESSAGE_LIMITS.productsPerMessage} products in one message.`,
    ),
  /** The list's section title (a product list only). */
  sectionTitle: optionalShortText(PRODUCT_MESSAGE_LIMITS.sectionTitleLength, 'section title'),
  /** The list's heading (a product list only, where it is required). */
  header: optionalShortText(PRODUCT_MESSAGE_LIMITS.headerLength, 'heading'),
  /** Required for a list and the catalog; a single product may go without. */
  body: z
    .string()
    .trim()
    .max(
      PRODUCT_MESSAGE_LIMITS.bodyLength,
      `The message is limited to ${PRODUCT_MESSAGE_LIMITS.bodyLength} characters.`,
    ),
  footer: optionalShortText(PRODUCT_MESSAGE_LIMITS.footerLength, 'footer'),
  next: nextSchema,
});

/** A template variable's text (an empty one is a check error, so an unfinished draft can be saved). */
const templateParamSchema = z
  .string()
  .trim()
  .max(
    TEMPLATE_LIMITS.parameterValue,
    `Template variables are limited to ${TEMPLATE_LIMITS.parameterValue} characters.`,
  );

/**
 * The template a step sends and the texts (with placeholders) for its variables, in order, and for
 * the ends of its links that take a value (ADR-229; versions saved before have none).
 */
const templateFields = {
  templateId: z.uuid('Choose a template.'),
  header: z.array(templateParamSchema).max(1, 'A template header has at most one variable.'),
  body: z
    .array(templateParamSchema)
    .max(
      TEMPLATE_LIMITS.bodyVariables,
      `A template has at most ${TEMPLATE_LIMITS.bodyVariables} variables.`,
    ),
  links: z
    .array(templateParamSchema)
    .max(
      TEMPLATE_LIMITS.urlButtons,
      `A template has at most ${TEMPLATE_LIMITS.urlButtons} links that take a value.`,
    )
    .default([]),
};

const sendTemplateNode = z.object({
  id: nodeIdSchema,
  type: z.literal('send_template'),
  label: labelSchema,
  ...templateFields,
  next: nextSchema,
});

const askTemplateNode = z.object({
  id: nodeIdSchema,
  type: z.literal('ask_template'),
  label: labelSchema,
  ...templateFields,
  /**
   * A branch for each quick-reply button of the template: `index` is the button's position among
   * the template's buttons, `title` its text when the step was set up.
   */
  buttons: z
    .array(
      z.object({
        index: z
          .number()
          .int()
          .min(0)
          .max(TEMPLATE_LIMITS.buttons - 1),
        title: z
          .string()
          .trim()
          .min(1, 'Every button needs its text.')
          .max(
            TEMPLATE_LIMITS.buttonText,
            `Template buttons are limited to ${TEMPLATE_LIMITS.buttonText} characters.`,
          ),
        next: nextSchema,
      }),
    )
    .max(TEMPLATE_LIMITS.buttons, `A template has at most ${TEMPLATE_LIMITS.buttons} buttons.`)
    .refine(
      (buttons) => new Set(buttons.map((b) => b.index)).size === buttons.length,
      'Each button has one branch.',
    ),
  saveAs: variableSchema.nullable(),
  /** Any other reply (every reply when the template has no quick-reply buttons). */
  replyNext: nextSchema,
  timeoutMinutes: minutesSchema,
  timeoutNext: nextSchema,
});

/**
 * A CRM deal for the run's contact and conversation in a stage of a pipeline (ADR-245), created by
 * the automation unless the contact already has an open deal in that pipeline. The title may hold
 * placeholders, filled in when the step runs.
 */
const createDealNode = z.object({
  id: nodeIdSchema,
  type: z.literal('create_deal'),
  label: labelSchema,
  title: textSchema(AUTOMATION_LIMITS.dealTitleLength, 'deal title'),
  pipelineId: z.uuid('Choose a pipeline.'),
  stageId: z.uuid('Choose a stage.'),
  /** The value as typed, in the pipeline's currency ("2,500.50"); null: no value. */
  value: z
    .string()
    .trim()
    .max(AUTOMATION_LIMITS.dealValueLength, 'Enter the value as a number.')
    .nullable()
    .transform((v) => (v ? v : null)),
  /** Who owns the deal: an active member who can use the CRM, checked again when it runs. */
  ownerMembershipId: z.uuid('Choose who owns the deal.').nullable(),
  /**
   * Expected to close this many days after the step runs, on the company's calendar (ADR-247);
   * absent or null: no expected date.
   */
  closeInDays: z
    .number()
    .int('Use whole days.')
    .min(0, 'Use 0 for the day the step runs, or more.')
    .max(AUTOMATION_LIMITS.dealCloseDays, 'At most a year (365 days).')
    .nullable()
    .optional(),
  next: nextSchema,
});

/**
 * Moves the run's contact's open deal in a pipeline to a stage of it (ADR-250), as the automation.
 * Nothing moves when the contact has no open deal there, or more than one (which one is meant is
 * not known).
 */
const moveDealNode = z.object({
  id: nodeIdSchema,
  type: z.literal('move_deal'),
  label: labelSchema,
  pipelineId: z.uuid('Choose a pipeline.'),
  stageId: z.uuid('Choose a stage.'),
  next: nextSchema,
});

/**
 * Closes the run's contact's open deal in a pipeline as won or lost (ADR-251), as the automation,
 * on the same terms as moving it: nothing closes when the contact has no open deal there, or more
 * than one. A lost deal may get a reason, kept as written.
 */
const closeDealNode = z.object({
  id: nodeIdSchema,
  type: z.literal('close_deal'),
  label: labelSchema,
  pipelineId: z.uuid('Choose a pipeline.'),
  outcome: z.enum(['won', 'lost'], { error: 'Choose won or lost.' }),
  lostReason: z
    .string()
    .trim()
    .max(AUTOMATION_LIMITS.dealLostReasonLength, 'The reason is limited to 200 characters.')
    .nullable()
    .transform((v) => (v ? v : null)),
  next: nextSchema,
});

/**
 * Sets custom field values (ADR-373, ADR-385) on the run's contact's open deal in a pipeline
 * (ADR-386), as the automation, on the same terms as moving it: nothing changes when the contact
 * has no open deal there, or more than one. Each value is typed as a member types it in the deal's
 * form and may hold placeholders, filled in when the step runs; a value left empty clears the
 * field. Which fields exist and what their values take is checked with the graph, so an unfinished
 * draft can be saved, and again when the step runs.
 */
const updateDealFieldsNode = z.object({
  id: nodeIdSchema,
  type: z.literal('update_deal_fields'),
  label: labelSchema,
  pipelineId: z.uuid('Choose a pipeline.'),
  values: z
    .array(
      z.object({
        field: z.string().regex(FIELD_KEY_RE, 'Choose a deal field.'),
        value: z
          .string()
          .trim()
          .max(
            AUTOMATION_LIMITS.fieldValueLength,
            `Values are limited to ${AUTOMATION_LIMITS.fieldValueLength} characters.`,
          ),
      }),
    )
    .max(
      AUTOMATION_LIMITS.dealFieldValues,
      `A step sets at most ${AUTOMATION_LIMITS.dealFieldValues} deal fields.`,
    ),
  next: nextSchema,
});

/**
 * A deal step's value in minor units of the pipeline's currency: null without a value, undefined
 * when the text is not an amount in that currency or is more than a deal can hold.
 */
export function dealValueMinor(value: string | null, currency: string): number | null | undefined {
  if (value === null) return null;
  return parseAmountToMinor(value, currency) ?? undefined;
}

export const nodeSchema = z.discriminatedUnion('type', [
  sendTextNode,
  askButtonsNode,
  askTextNode,
  sendTemplateNode,
  askTemplateNode,
  sendFlowNode,
  sendProductsNode,
  conditionNode,
  updateContactNode,
  updateConversationNode,
  httpRequestNode,
  createTaskNode,
  createDealNode,
  moveDealNode,
  closeDealNode,
  updateDealFieldsNode,
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
  'send_template',
  'ask_template',
  'send_flow',
  'send_products',
  'condition',
  'update_contact',
  'update_conversation',
  'http_request',
  'create_task',
  'create_deal',
  'move_deal',
  'close_deal',
  'update_deal_fields',
  'wait',
  'handoff',
  'end',
];

export const NODE_TYPE_LABELS: Record<NodeType, string> = {
  send_text: 'Send a message',
  ask_buttons: 'Ask with buttons',
  ask_text: 'Ask a question',
  send_template: 'Send a template',
  ask_template: 'Ask with a template',
  send_flow: 'Send a form',
  send_products: 'Send products',
  condition: 'Condition',
  update_contact: 'Update contact',
  update_conversation: 'Tag the conversation',
  http_request: 'Call a web address',
  create_task: 'Create a CRM task',
  create_deal: 'Create a CRM deal',
  move_deal: 'Move the CRM deal',
  close_deal: 'Close the CRM deal',
  update_deal_fields: 'Update deal fields',
  wait: 'Wait',
  handoff: 'Hand off to people',
  end: 'End',
};

/** Nodes that wait for the customer or a timer (a loop must pass through one). */
export const WAITING_NODE_TYPES: ReadonlySet<NodeType> = new Set([
  'ask_buttons',
  'ask_text',
  'ask_template',
  'wait',
]);

/**
 * Session messages: WhatsApp delivers them only inside the 24-hour customer service window, so in an
 * automation started by order messages they must follow a customer reply (ADR-050).
 */
export const SESSION_MESSAGE_NODE_TYPES: ReadonlySet<NodeType> = new Set([
  'send_text',
  'ask_buttons',
  'ask_text',
  'send_flow',
  'send_products',
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

export const TRIGGER_TYPES = [
  'keyword',
  'conversation_started',
  'any_message',
  'store_event',
  'api',
] as const;
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
    /**
     * Also start when a word of the message is a keyword word with a small typo (ADR-240); absent
     * means words must match exactly, as before.
     */
    typos: z.boolean().optional(),
    ...triggerCommon,
  }),
  z.object({ type: z.literal('conversation_started'), ...triggerCommon }),
  z.object({ type: z.literal('any_message'), ...triggerCommon }),
  /**
   * Started by a store's order message rule (ADR-050), never by a customer message: the rule decides
   * when, with its delay and sending hours.
   */
  z.object({ type: z.literal('store_event') }),
  /**
   * Started through the public API by a key (ADR-077), never by a customer message. Every call gives
   * the inputs named here, which the steps use as {{input.<name>}}.
   */
  z.object({
    type: z.literal('api'),
    inputs: z
      .array(
        z
          .string()
          .regex(
            VARIABLE_RE,
            'Input names start with a letter and use a-z, 0-9 and _ (at most 32).',
          ),
      )
      .max(AUTOMATION_LIMITS.apiInputs, `At most ${AUTOMATION_LIMITS.apiInputs} inputs.`)
      .transform((list) => [...new Set(list)]),
  }),
]);
export type AutomationTrigger = z.infer<typeof triggerSchema>;
/** Triggers that start from customer messages (with business hours and cooldowns). */
export type MessageTrigger = Exclude<AutomationTrigger, { type: 'store_event' | 'api' }>;

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  keyword: 'A message contains a keyword',
  conversation_started: 'A customer starts a conversation',
  any_message: 'Any customer message',
  store_event: 'An order event in a store (chosen in the store’s Order messages)',
  api: 'A call from your systems through the HyFib W360 API',
};

/**
 * How strongly a trigger matched; lower wins: the message is a keyword, contains one, matches one
 * only with typos (ADR-240), a new conversation, any message.
 */
export type TriggerRank = 0 | 1 | 2 | 3 | 4;

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
      if (trigger.keywords.some((k) => equalsKeyword(text, k))) return 0;
      if (trigger.match === 'contains' && trigger.keywords.some((k) => matchesKeyword(text, k))) {
        return 1;
      }
      // A match only with typos ranks below every match without them, of any automation.
      if (!trigger.typos) return null;
      const near = trigger.match === 'exact' ? equalsKeywordWithTypos : matchesKeywordWithTypos;
      return trigger.keywords.some((k) => near(text, k)) ? 2 : null;
    }
    case 'conversation_started':
      return message.newCase ? 3 : null;
    case 'any_message':
      return 4;
    case 'store_event':
    case 'api':
      return null;
  }
}

export function describeTrigger(trigger: AutomationTrigger): string {
  if (trigger.type === 'store_event') return 'Started by a store’s order messages';
  if (trigger.type === 'api') {
    return trigger.inputs.length > 0
      ? `Started through the API with ${trigger.inputs.map((i) => `“${i}”`).join(', ')}`
      : 'Started through the API';
  }
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
        .join(', ')}${trigger.typos ? `, allowing small typos${hours ? ',' : ''}` : ''}${hours}`;
    case 'conversation_started':
      return `A customer starts a conversation${hours}`;
    case 'any_message':
      return `Any customer message${hours}`;
  }
}

// Text placeholders -------------------------------------------------------------------------------

/**
 * {{name}} (the contact's name), {{company}}, {{answer.<name>}} (a captured answer), in automations
 * started by order messages {{order.<field>}} (the order the run is about), and in automations
 * started through the API {{input.<name>}} (a value the call gave, ADR-077).
 */
export const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g;

/**
 * What {{order.<field>}} stands for in a run started by order messages (ADR-050): read from the
 * order when the step runs, empty when the order has no such value (or was deleted or redacted).
 */
export const ORDER_PLACEHOLDERS = {
  number: 'Order number (for example #1001)',
  customer_name: 'Customer name',
  total: 'Order total (for example ₹1,499.00)',
  items: 'Items (for example "Darjeeling tea and 2 more")',
  status_url: 'Order status page (Shopify)',
  tracking_number: 'Tracking number (Shopify)',
  carrier: 'Carrier (Shopify)',
  tracking_url: 'Tracking link (Shopify)',
  store: 'Store name',
} as const;
export type OrderPlaceholder = keyof typeof ORDER_PLACEHOLDERS;
export type OrderPlaceholderValues = Readonly<Partial<Record<OrderPlaceholder, string | null>>>;

const isOrderPlaceholder = (field: string): field is OrderPlaceholder =>
  Object.hasOwn(ORDER_PLACEHOLDERS, field);

export interface TextValues {
  contactName: string | null;
  companyName: string;
  variables: Readonly<Record<string, string>>;
  /** The order of a run started by order messages (null otherwise, or when it is gone). */
  order?: OrderPlaceholderValues | null;
}

export function renderText(template: string, values: TextValues): string {
  return template
    .replace(
      PLACEHOLDER_RE,
      (whole, raw: string) => placeholderValue(raw.toLowerCase(), values) ?? whole,
    )
    .trim();
}

/** Names of HTTP secrets ({{secret.<name>}}), stored encrypted by the company. */
export const SECRET_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Renders the address or body of an HTTP step: {{name}}, {{company}}, {{answer.<name>}} and
 * {{order.<field>}} are filled through `encode` (URL-encoded in the address, JSON-escaped in the
 * body). Secrets are only
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
  // Only answer names (no dot), so {{answer.…}} never reads an API input (ADR-077).
  if (name.startsWith('answer.'))
    return VARIABLE_RE.test(name.slice(7)) ? (values.variables[name.slice(7)] ?? '') : null;
  if (name.startsWith('order.') && isOrderPlaceholder(name.slice(6)))
    return values.order?.[name.slice(6) as OrderPlaceholder] ?? '';
  // A run started through the API keeps the call's inputs with its answers (ADR-077); answer names
  // have no dot, so a step never overwrites them.
  if (name.startsWith('input.') && VARIABLE_RE.test(name.slice(6)))
    return values.variables[name] ?? '';
  return null;
}

/** Escapes a value for use inside a JSON string of an HTTP body. */
export const encodeJsonString = (value: string): string => JSON.stringify(value).slice(1, -1);

/** Encodes a value for a field of a form body (ADR-236): every character but A–Z a–z 0–9 -_.!~*'(). */
export const encodeFormValue = (value: string): string => encodeURIComponent(value);

/** A form field as written, placeholders taken as values: a name, `=`, a value, URL-encoded. */
const FORM_FIELD_RE = /^[A-Za-z0-9._~*'()!\-[\]%+]+=[A-Za-z0-9._~*'()!\-[\]%+]*$/;

/**
 * Why a form body (ADR-236) cannot be sent as written, or null: fields joined by &, each a name
 * and a value already URL-encoded (%20 or + for a space), placeholders standing for values.
 */
export function formBodyProblem(body: string): string | null {
  const fields = body.replace(PLACEHOLDER_RE, 'x').split('&');
  for (const field of fields) {
    if (!FORM_FIELD_RE.test(field)) {
      return 'A form body is name=value fields joined by &, written URL-encoded, for example phone={{answer.phone}}&note=Hello%20there.';
    }
    try {
      decodeURIComponent(field.replace(/\+/g, ' '));
    } catch {
      return 'A % in a form body starts an encoded character, like %20 for a space.';
    }
  }
  return null;
}

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

/**
 * Placeholders used by a text: unknown ones, captured answers, (when allowed) secrets and order
 * fields, order fields used where they are not available, and API inputs used where they are not
 * available or not declared (`inputs` are the trigger's, in automations started through the API).
 */
function placeholdersIn(
  text: string,
  allow: { secrets?: boolean; order?: boolean; inputs?: ReadonlySet<string> } = {},
): {
  unknown: string[];
  answers: string[];
  secrets: string[];
  misplacedOrder: string[];
  misplacedInputs: string[];
  undeclaredInputs: string[];
  literal: boolean;
} {
  const unknown: string[] = [];
  const answers: string[] = [];
  const secrets: string[] = [];
  const misplacedOrder: string[] = [];
  const misplacedInputs: string[] = [];
  const undeclaredInputs: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const name = (match[1] ?? '').toLowerCase();
    if (name === 'name' || name === 'company') continue;
    if (name.startsWith('answer.') && VARIABLE_RE.test(name.slice(7))) answers.push(name.slice(7));
    else if (allow.secrets && name.startsWith('secret.') && SECRET_NAME_RE.test(name.slice(7)))
      secrets.push(name.slice(7));
    else if (name.startsWith('order.') && isOrderPlaceholder(name.slice(6))) {
      if (!allow.order) misplacedOrder.push(match[0]);
    } else if (name.startsWith('input.') && VARIABLE_RE.test(name.slice(6))) {
      if (!allow.inputs) misplacedInputs.push(match[0]);
      else if (!allow.inputs.has(name.slice(6))) undeclaredInputs.push(match[0]);
    } else unknown.push(match[0]);
  }
  const literal = text.replace(PLACEHOLDER_RE, '').trim().length > 0;
  return { unknown, answers, secrets, misplacedOrder, misplacedInputs, undeclaredInputs, literal };
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
  } else if (node.body && node.bodyFormat === 'form') {
    const problem = formBodyProblem(node.body);
    if (problem) out.push(problem);
    if (node.headers.some((h) => h.name.toLowerCase() === 'content-type')) {
      out.push(`HyFib sends form bodies as ${FORM_CONTENT_TYPE}: remove the Content-Type header.`);
    }
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

/** Template ids a graph's template steps use. */
export function templatesOf(graph: AutomationGraph): string[] {
  return [
    ...new Set(
      graph.nodes.flatMap((n) =>
        n.type === 'send_template' || n.type === 'ask_template' ? [n.templateId] : [],
      ),
    ),
  ];
}

/** Product ids a graph's products steps send (ADR-383). */
export function productsOf(graph: AutomationGraph): string[] {
  return [...new Set(graph.nodes.flatMap((n) => (n.type === 'send_products' ? n.productIds : [])))];
}

/**
 * The values a call (or a member's test run) gives an automation started through the API, checked
 * against the inputs its trigger declares (ADR-077): each declared input once, not blank, at most
 * `apiInputLength` characters, and no other names. Kept with the run's answers as
 * `input.<name>`, where {{input.<name>}} reads them.
 */
export function apiInputValues(
  declared: readonly string[],
  given: unknown,
): { ok: true; variables: Record<string, string> } | { ok: false; message: string } {
  const values = given ?? {};
  if (typeof values !== 'object' || Array.isArray(values)) {
    return { ok: false, message: 'Give the inputs as an object of names and texts.' };
  }
  const entries = Object.entries(values as Record<string, unknown>);
  const unknown = entries.map(([name]) => name).filter((name) => !declared.includes(name));
  if (unknown.length > 0) {
    return { ok: false, message: `The automation has no input named “${unknown[0]}”.` };
  }
  const variables: Record<string, string> = {};
  for (const name of declared) {
    const value = (values as Record<string, unknown>)[name];
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, message: `Give the input “${name}” a value.` };
    }
    if (value.length > AUTOMATION_LIMITS.apiInputLength) {
      return {
        ok: false,
        message: `The input “${name}” is limited to ${AUTOMATION_LIMITS.apiInputLength} characters.`,
      };
    }
    variables[`input.${name}`] = value;
  }
  return { ok: true, variables };
}

/**
 * Problems with the trigger together with the automation's number: one started through the API
 * sends from the one number it is limited to, as calls do not choose a number (ADR-077).
 */
export function triggerIssues(
  trigger: AutomationTrigger,
  channelAccountId: string | null,
): GraphIssue[] {
  if (trigger.type === 'api' && !channelAccountId) {
    return [
      {
        level: 'error',
        nodeId: null,
        message: 'An automation started through the API sends from one WhatsApp number: choose it.',
      },
    ];
  }
  if (
    trigger.type === 'keyword' &&
    trigger.typos &&
    !trigger.keywords.some((k) => k.split(' ').some((w) => typoAllowance(w) > 0))
  ) {
    return [
      {
        level: 'warning',
        nodeId: null,
        message:
          'Typos are allowed only in words of five letters or more without digits, so these keywords still match exactly.',
      },
    ];
  }
  return [];
}

/** Outgoing edges of a node with a label for each. */
export function edgesOf(node: AutomationNode): { label: string; target: string | null }[] {
  switch (node.type) {
    case 'send_text':
    case 'send_template':
    case 'send_flow':
    case 'send_products':
    case 'update_contact':
    case 'update_conversation':
    case 'create_task':
    case 'create_deal':
    case 'move_deal':
    case 'close_deal':
    case 'update_deal_fields':
    case 'wait':
      return [{ label: 'next', target: node.next }];
    case 'ask_template':
      return [
        ...node.buttons.map((b) => ({ label: b.title, target: b.next })),
        { label: node.buttons.length > 0 ? 'other reply' : 'reply', target: node.replyNext },
        { label: 'no reply', target: node.timeoutNext },
      ];
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

/**
 * Whether leaving `node` by the edge at `index` of `edgesOf` means the customer replied: an answer
 * or another reply at a question or an asking template step (not a timeout).
 */
function replyOnEdge(node: AutomationNode, index: number): boolean {
  switch (node.type) {
    case 'ask_buttons':
    case 'ask_template':
      return index <= node.buttons.length;
    case 'ask_text':
      return index <= 1;
    default:
      return false;
  }
}

/** Texts a node sends or stores, for placeholder checks. */
function textsOf(node: AutomationNode): string[] {
  switch (node.type) {
    case 'send_text':
      return [node.text];
    case 'send_flow':
      return [node.body];
    case 'send_products':
      // A single product may go without a message (an empty one has nothing to check).
      return node.body ? [node.body] : [];
    case 'send_template':
    case 'ask_template':
      return [...node.header, ...node.body];
    case 'ask_buttons':
      return [node.body, ...(node.retryText ? [node.retryText] : [])];
    case 'ask_text':
      return [node.text, ...(node.retryText ? [node.retryText] : [])];
    case 'update_contact':
      return node.action.kind === 'set_field' ? [node.action.value] : [];
    case 'create_task':
    case 'create_deal':
      return [node.title];
    case 'update_deal_fields':
      // A value left empty clears its field (nothing to check).
      return node.values.flatMap((v) => (v.value ? [v.value] : []));
    default:
      return [];
  }
}

export interface GraphReferences {
  /** Teams of the company; when given, hand-off teams must be among them. */
  teamIds?: ReadonlySet<string>;
  /**
   * The company's forms by id, with their WhatsApp account and whether they can be sent (published
   * at Meta); when given, form steps must use one that can, of the automation's account (ADR-248).
   */
  flows?: ReadonlyMap<string, { whatsappAccountId: string; sendable: boolean }>;
  /**
   * Products in the company's connected catalogs, by id, with their catalog and its WhatsApp
   * account; when given, products steps must send products of one of them, of the automation's
   * account (ADR-383).
   */
  products?: ReadonlyMap<string, { catalogId: string; whatsappAccountId: string }>;
  /**
   * Active members who can use the CRM; when given, the members task steps create tasks for must
   * be among them (ADR-244).
   */
  crmMemberIds?: ReadonlySet<string>;
  /**
   * Active pipelines by id, with their currency and active stages; when given, deal steps must use
   * an active stage of an active pipeline and a value in its currency (ADR-245), and steps that move
   * deals an active stage of an active pipeline (ADR-250).
   */
  crmPipelines?: ReadonlyMap<string, { currency: string; stageIds: ReadonlySet<string> }>;
  /** Contact field keys of the company; when given, fields must be among them. */
  fieldKeys?: ReadonlySet<string>;
  /**
   * The company's custom deal fields by key (ADR-373, ADR-385); when given, steps that set deal
   * fields must set existing ones, and values without placeholders must fit them (ADR-386).
   */
  dealFields?: ReadonlyMap<string, DealFieldShape>;
  /** Domains the company allows HTTP steps to call; when given, addresses must match one. */
  allowedDomains?: readonly string[];
  /**
   * The company's HTTP secrets by name, with the domain each may be sent to; when given, secrets
   * used must be among them and the step must call their domain.
   */
  secrets?: ReadonlyMap<string, string>;
  /** http:// addresses, for local test targets only (the server decides from its configuration). */
  allowInsecureHttp?: boolean;
  /**
   * The automation starts from a store's order messages: {{order.<field>}} is available, and
   * messages that need the service window must follow a customer reply (ADR-050).
   */
  storeEvent?: boolean;
  /**
   * The automation starts through the API (ADR-077): the inputs its trigger declares are available
   * as {{input.<name>}}, and, as for order messages, messages that need the service window must
   * follow a customer reply.
   */
  apiInputs?: ReadonlySet<string>;
  /** The company's templates by id; when given, template steps must use one HyFib can send. */
  templates?: ReadonlyMap<string, TemplateReference>;
  /** The WhatsApp account of the automation's number, when it is limited to one. */
  channelWhatsappAccountId?: string | null;
}

/** What the checks need to know about a template (from its latest copy synced from Meta). */
export interface TemplateReference {
  name: string;
  category: string;
  status: string;
  whatsappAccountId: string;
  /** Why HyFib cannot send it (for example a media header), or null. */
  unsupported: string | null;
  headerParams: number;
  bodyParams: number;
  /** Its website buttons whose link ends with a value, in the order a step fills them (ADR-229). */
  links: readonly { index: number; text: string; url: string }[];
  /** Its quick-reply buttons, by their position among the template's buttons. */
  quickReplies: readonly { index: number; title: string }[];
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
    if (
      (node.type === 'ask_buttons' || node.type === 'ask_text' || node.type === 'ask_template') &&
      node.saveAs
    )
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

  const extra = refs.storeEvent ? '{{order.<field>}}' : refs.apiInputs ? '{{input.<name>}}' : null;
  const known = extra
    ? `{{name}}, {{company}}, {{answer.<name>}} or ${extra}`
    : '{{name}}, {{company}} or {{answer.<name>}}';
  const knownInHeaders = extra
    ? `{{name}}, {{company}}, {{answer.<name>}}, ${extra} or {{secret.<name>}}`
    : '{{name}}, {{company}}, {{answer.<name>}} or {{secret.<name>}}';
  const misplacedOrder = (nodeId: string, placeholder: string) =>
    issues.push({
      level: 'error',
      nodeId,
      message: `${placeholder} is an order field: order fields work only in automations started by a store’s order messages.`,
    });
  const misplacedInput = (nodeId: string, placeholder: string) =>
    issues.push({
      level: 'error',
      nodeId,
      message: `${placeholder} is an API input: inputs work only in automations started through the API.`,
    });
  const undeclaredInput = (nodeId: string, placeholder: string) =>
    issues.push({
      level: 'error',
      nodeId,
      message: `${placeholder} is not one of the trigger’s inputs. Add it to the trigger’s inputs first.`,
    });

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
      const found = placeholdersIn(text, { order: refs.storeEvent, inputs: refs.apiInputs });
      for (const u of found.unknown) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message: `Unknown placeholder ${u}. Use ${known}.`,
        });
      }
      for (const u of found.misplacedOrder) misplacedOrder(node.id, u);
      for (const u of found.misplacedInputs) misplacedInput(node.id, u);
      for (const u of found.undeclaredInputs) undeclaredInput(node.id, u);
      for (const a of found.answers) checkAnswerUse(node.id, a);
      // A template variable that is only a placeholder is usual ({{1}} = {{name}}); left empty, the
      // step fails without sending instead. A single product left without its message is sent
      // without one.
      if (
        !found.literal &&
        node.type !== 'update_contact' &&
        node.type !== 'update_deal_fields' &&
        node.type !== 'send_template' &&
        node.type !== 'ask_template' &&
        !(node.type === 'send_products' && node.kind === 'product')
      ) {
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
        const found = placeholdersIn(text, {
          secrets: headers,
          order: refs.storeEvent,
          inputs: refs.apiInputs,
        });
        for (const u of found.unknown) {
          issues.push({
            level: 'error',
            nodeId: node.id,
            message: headers
              ? `Unknown placeholder ${u}. Use ${knownInHeaders}.`
              : /secret\./i.test(u)
                ? `Secrets can only be used in header values (${u}).`
                : `Unknown placeholder ${u}. Use ${known}.`,
          });
        }
        for (const u of found.misplacedOrder) misplacedOrder(node.id, u);
        for (const u of found.misplacedInputs) misplacedInput(node.id, u);
        for (const u of found.undeclaredInputs) undeclaredInput(node.id, u);
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
    if (node.type === 'create_task' && node.remind && node.dueInHours === null) {
      issues.push({
        level: 'error',
        nodeId: node.id,
        message: 'Give the task a due time for its reminder, or send no reminder.',
      });
    }
    if (
      node.type === 'create_task' &&
      refs.crmMemberIds &&
      !refs.crmMemberIds.has(node.assigneeMembershipId)
    ) {
      issues.push({
        level: 'error',
        nodeId: node.id,
        message: 'Choose an active member who can use the CRM for the task.',
      });
    }
    if (node.type === 'send_flow' && refs.flows) {
      const flow = refs.flows.get(node.flowId);
      const message = !flow
        ? 'The form no longer exists.'
        : !flow.sendable
          ? 'Publish the form before an automation sends it.'
          : refs.channelWhatsappAccountId &&
              flow.whatsappAccountId !== refs.channelWhatsappAccountId
            ? 'Choose a form of the WhatsApp account of the automation’s number.'
            : null;
      if (message) issues.push({ level: 'error', nodeId: node.id, message });
    }
    if (node.type === 'send_products') {
      for (const message of productStepIssues(node, refs)) {
        issues.push({ level: 'error', nodeId: node.id, message });
      }
    }
    if (node.type === 'move_deal' && refs.crmPipelines) {
      const pipeline = refs.crmPipelines.get(node.pipelineId);
      if (!pipeline || !pipeline.stageIds.has(node.stageId)) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message: 'Choose an active stage of an active pipeline to move the deal to.',
        });
      }
    }
    if (
      node.type === 'close_deal' &&
      refs.crmPipelines &&
      !refs.crmPipelines.has(node.pipelineId)
    ) {
      issues.push({
        level: 'error',
        nodeId: node.id,
        message: 'Choose an active pipeline for the deal to close.',
      });
    }
    if (node.type === 'update_deal_fields') {
      for (const message of dealFieldsStepIssues(node, refs)) {
        issues.push({ level: 'error', nodeId: node.id, message });
      }
    }
    if (node.type === 'create_deal') {
      for (const message of dealStepIssues(node, refs)) {
        issues.push({ level: 'error', nodeId: node.id, message });
      }
    }
    if (node.type === 'send_template' || node.type === 'ask_template') {
      if ([...node.header, ...node.body].some((v) => !v)) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message: 'Fill in every variable of the template.',
        });
      }
      if (refs.templates) {
        for (const message of templateStepIssues(node, refs)) {
          issues.push({ level: 'error', nodeId: node.id, message });
        }
      }
    }
    // After a day without the customer's message only templates can follow (a reply reopens it).
    if (
      ((node.type === 'ask_buttons' || node.type === 'ask_text' || node.type === 'ask_template') &&
        node.timeoutMinutes > 1380 &&
        sessionMessageBeforeReply(node.timeoutNext, byId)) ||
      (node.type === 'wait' && node.minutes > 1380 && sessionMessageBeforeReply(node.next, byId))
    ) {
      issues.push({
        level: 'warning',
        nodeId: node.id,
        message:
          'After about 24 hours without a customer message WhatsApp allows only templates, so a later message that is not a template will fail. Send a template instead.',
      });
    }
  }

  for (const node of graph.nodes) {
    if (!reachable.has(node.id)) {
      issues.push({ level: 'warning', nodeId: node.id, message: 'No step leads here.' });
    }
  }

  // Started by order messages or through the API: until the customer replies only templates reach
  // them (ADR-050, ADR-077).
  if (refs.storeEvent || refs.apiInputs) {
    const replied = repliedOnEveryPath(graph.start, byId, reachable);
    for (const node of graph.nodes) {
      if (!reachable.has(node.id) || replied.get(node.id)) continue;
      if (SESSION_MESSAGE_NODE_TYPES.has(node.type)) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message:
            'WhatsApp allows only templates until the customer replies, and a path reaches this step before a reply. Send a template first and continue from its reply branches.',
        });
      } else if (node.type === 'handoff') {
        issues.push({
          level: 'warning',
          nodeId: node.id,
          message:
            'A path reaches this hand-off before the customer replies: it cannot open the conversation, so people see it only once the customer writes.',
        });
      }
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

/** Whether a path from `from` reaches a message other than a template before the customer replies. */
function sessionMessageBeforeReply(
  from: string | null,
  byId: ReadonlyMap<string, AutomationNode>,
): boolean {
  const seen = new Set<string>();
  const stack = from ? [from] : [];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    if (SESSION_MESSAGE_NODE_TYPES.has(node.type)) return true;
    edgesOf(node).forEach((edge, index) => {
      if (edge.target !== null && !replyOnEdge(node, index)) stack.push(edge.target);
    });
  }
  return false;
}

/**
 * For each reachable step, whether the customer has replied on every path from the first step to it
 * (forward data flow over the edges, iterated to a fixed point so loops are covered).
 */
function repliedOnEveryPath(
  start: string,
  byId: ReadonlyMap<string, AutomationNode>,
  reachable: ReadonlySet<string>,
): Map<string, boolean> {
  const replied = new Map<string, boolean>();
  for (const id of reachable) replied.set(id, id !== start);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of reachable) {
      const node = byId.get(id);
      if (!node) continue;
      edgesOf(node).forEach((edge, index) => {
        // The first step is also entered before any reply, so it stays false.
        if (edge.target === null || edge.target === start || !replied.has(edge.target)) return;
        const after = (replied.get(id) ?? false) || replyOnEdge(node, index);
        if (!after && replied.get(edge.target)) {
          replied.set(edge.target, false);
          changed = true;
        }
      });
    }
  }
  return replied;
}

/** Problems with a template step's template, checked against the company's templates. */
function templateStepIssues(
  node: NodeOf<'send_template' | 'ask_template'>,
  refs: GraphReferences,
): string[] {
  const template = refs.templates?.get(node.templateId);
  if (!template) return ['The template no longer exists. Choose another one.'];
  const out: string[] = [];
  if (template.status !== 'approved') {
    out.push(`The template “${template.name}” is not approved by Meta (${template.status}).`);
  }
  if (template.category !== 'UTILITY' && template.category !== 'MARKETING') {
    out.push('Choose a utility or marketing template.');
  } else if (template.unsupported) {
    out.push(template.unsupported);
  } else if (
    node.header.length !== template.headerParams ||
    node.body.length !== template.bodyParams ||
    node.links.length !== template.links.length
  ) {
    const count = template.headerParams + template.bodyParams + template.links.length;
    out.push(
      `The template “${template.name}” has ${count} variable${count === 1 ? '' : 's'}: fill in each one.`,
    );
  }
  if (
    node.type === 'ask_template' &&
    !template.unsupported &&
    (node.buttons.length !== template.quickReplies.length ||
      node.buttons.some(
        (b, i) =>
          b.index !== template.quickReplies[i]?.index ||
          b.title !== template.quickReplies[i]?.title,
      ))
  ) {
    out.push(
      'The template’s quick-reply buttons changed: choose the template again to update the branches.',
    );
  }
  if (
    refs.channelWhatsappAccountId &&
    template.whatsappAccountId !== refs.channelWhatsappAccountId
  ) {
    out.push('The template belongs to another WhatsApp account than the automation’s number.');
  }
  return out;
}

/** What is wrong with a deal step in this company (ADR-245). */
function dealStepIssues(node: NodeOf<'create_deal'>, refs: GraphReferences): string[] {
  const issues: string[] = [];
  const pipeline = refs.crmPipelines?.get(node.pipelineId);
  if (refs.crmPipelines && (!pipeline || !pipeline.stageIds.has(node.stageId))) {
    issues.push('Choose an active stage of an active pipeline for the deal.');
  }
  if (pipeline && dealValueMinor(node.value, pipeline.currency) === undefined) {
    issues.push(`Enter the deal’s value as an amount in ${pipeline.currency}, or leave it empty.`);
  }
  if (
    node.ownerMembershipId &&
    refs.crmMemberIds &&
    !refs.crmMemberIds.has(node.ownerMembershipId)
  ) {
    issues.push('Choose an active member who can use the CRM to own the deal, or nobody.');
  }
  return issues;
}

/**
 * Problems with a step that sets deal fields (ADR-386): no field, a field set twice, a pipeline that
 * is not active, a field the company does not have, or a value without placeholders that the field
 * does not take (one with placeholders is checked when the step runs).
 */
function dealFieldsStepIssues(node: NodeOf<'update_deal_fields'>, refs: GraphReferences): string[] {
  const out: string[] = [];
  if (node.values.length === 0) out.push('Choose at least one deal field to set.');
  if (refs.crmPipelines && !refs.crmPipelines.has(node.pipelineId)) {
    out.push('Choose an active pipeline for the deal to update.');
  }
  const seen = new Set<string>();
  for (const { field, value } of node.values) {
    if (seen.has(field)) {
      out.push(`Set each deal field once: “${field}” is set twice.`);
      continue;
    }
    seen.add(field);
    if (!refs.dealFields) continue;
    const definition = refs.dealFields.get(field);
    if (!definition) {
      out.push(`The deal field “${field}” does not exist.`);
      continue;
    }
    if (!hasPlaceholder(value)) {
      const coerced = coerceDealFieldValue(definition, value);
      if (!coerced.ok) out.push(coerced.message);
    }
  }
  return out;
}

const hasPlaceholder = (text: string) => [...text.matchAll(PLACEHOLDER_RE)].length > 0;

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
  if (node.type === 'ask_buttons' || node.type === 'ask_template') {
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

/** What a products step lacks (ADR-383): its kind's products and texts, and, given, its catalog. */
function productStepIssues(node: NodeOf<'send_products'>, refs: GraphReferences): string[] {
  const out: string[] = [];
  const ids = node.productIds;
  if (ids.length === 0) {
    out.push(
      node.kind === 'product_list'
        ? 'Choose the products to send.'
        : node.kind === 'product'
          ? 'Choose a product.'
          : 'Choose the product shown on the message.',
    );
  } else if (node.kind !== 'product_list' && ids.length > 1) {
    out.push('Choose one product.');
  } else if (new Set(ids).size !== ids.length) {
    out.push('Each product can appear only once.');
  }
  if (node.kind === 'product_list' && !node.header) out.push('Write a heading.');
  if (node.kind !== 'product' && !node.body) out.push('Write the message.');
  if (refs.products && ids.length > 0) {
    const found = ids.map((id) => refs.products?.get(id));
    const catalogs = new Set(found.map((p) => p?.catalogId));
    if (found.some((p) => !p)) {
      out.push('A product of this step is no longer in a connected catalog.');
    } else if (catalogs.size > 1) {
      out.push('Choose products from one catalog.');
    } else if (
      refs.channelWhatsappAccountId &&
      found[0]?.whatsappAccountId !== refs.channelWhatsappAccountId
    ) {
      out.push(
        'Choose products from a catalog of the WhatsApp account of the automation’s number.',
      );
    }
  }
  return out;
}

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
