import { z } from 'zod';
import { AppError, clipText, isAppError, jsonbText, notFound, uuidv7 } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  asc,
  channelAccounts,
  commerceCatalogs,
  commerceProducts,
  contactIdentities,
  contactTags,
  contacts,
  conversations,
  eq,
  inArray,
  isNotNull,
  isNull,
  messageTemplates,
  messages,
  sendIntents,
  sql,
  suppressions,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { endRunForHuman } from '../automations/runs';
import { lockCampaignSends, marketingCapReached } from '../campaigns/frequency-cap';
import {
  COMMERCE_LIMITS,
  productInteractive,
  type ResolvedProductMessage,
} from '../commerce/model';
import { checkTemplateEligibility, recordConsentEvents } from '../consent/service';
import { MAX_TAGS_PER_CONTACT, normalizeEmail, type AttributeValue } from '../contacts/fields';
import { normalizePhone, phoneFromWaId, waRecipientFromPhone } from '../contacts/phone';
import { contactForPhone } from '../contacts/service';
import { emitTenantEvent } from '../messaging/events';
import {
  INTERACTIVE_LIMITS,
  RESERVED_REPLY_ID_PREFIX,
  isReservedReplyId,
  listContent,
  listInteractive,
  replyButtonsContent,
  replyButtonsInteractive,
} from '../messaging/interactive';
import { SERVICE_WINDOW_MS, type OutboundDeps } from '../messaging/outbound';
import {
  answeredJoin,
  answeredMessages,
  answerProblem,
  isSingleEmoji,
} from '../messaging/reply-context';
import { STATUS_RANK } from '../messaging/status';
import { loadEntitlements } from '../plans/entitlements';
import {
  buildTemplateSend,
  fromMetaComponents,
  sendSpecFor,
  TEMPLATE_LIMITS,
  type SendSpec,
  type TemplateParams,
} from '../templates/definition';
import { decodeKeysetCursor, likePattern, parseInput } from '../validation';
import { apiContactById, toApiContact, type ApiContact } from './contact-view';
import {
  apiContactFieldFiltersSchema,
  apiContactPage,
  apiContactFieldsSchema,
  apiContactListFilters,
  apiFieldChanges,
  apiFieldFilters,
  apiTags,
  contactListQuery,
} from './contacts';
import { apiActor, assertAnyScope, assertScope, type ApiContext } from './context';
import {
  claimIdempotencyKey,
  storeIdempotentResponse,
  type ApiResponse,
  type IdempotencyInput,
} from './idempotency';
import { API_LIMITS, API_SEND_SCOPES } from './model';

/**
 * The resources of the public API v1 (ADR-052). The zod schemas below validate requests and are
 * also the source of the OpenAPI document, so the two cannot drift apart.
 */

export const phoneField = z
  .string({ error: 'Give the phone number' })
  .max(40)
  .describe('The number with its country code, starting with + (for example +919876543210).');

export const apiContactCreateSchema = z
  .object({
    phone: phoneField,
    name: z.string().trim().max(200).optional().describe('The contact’s name.'),
    email: z.string().trim().max(254).optional().describe('An email address.'),
    tags: z
      .array(z.string().max(40))
      .max(20)
      .optional()
      .describe('Tags to add (lower-cased; commas are not allowed).'),
    fields: apiContactFieldsSchema.optional(),
  })
  .strict();

export const apiContactListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
    phone: z.string().max(40).optional().describe('Only the contact with this number.'),
    email: z.string().max(254).optional().describe('Only contacts with this email address.'),
    name: z.string().max(200).optional().describe('Only contacts whose name contains this text.'),
    tag: z.string().max(40).optional().describe('Only contacts with this tag.'),
    fields: apiContactFieldFiltersSchema.optional(),
  })
  .strict();

export const apiConsentSchema = z
  .object({
    purpose: z.enum(['marketing', 'utility']),
    action: z.enum(['opt_in', 'opt_out']),
    evidence: z
      .string({ error: 'Say how the contact gave or withdrew consent' })
      .trim()
      .min(1, 'Say how the contact gave or withdrew consent')
      .max(500)
      .describe(
        'How the contact gave or withdrew consent, for example "Checkout form on example.com".',
      ),
  })
  .strict();

const variableValue = z.string().trim().min(1).max(TEMPLATE_LIMITS.parameterValue);

/** The values of a template's variables, as a send gives them. */
const templateVariablesField = z
  .object({
    header: z.array(variableValue).max(1).default([]),
    body: z.array(variableValue).max(TEMPLATE_LIMITS.bodyVariables).default([]),
  })
  .strict()
  .default({ header: [], body: [] })
  .describe('Values for the template’s {{1}}, {{2}}… in order.');

/** The number a template is sent from. */
const templateFromField = z
  .uuid()
  .optional()
  .describe(
    'The id of the WhatsApp number to send from; optional when the company has one active number.',
  );

export const apiSendMessageSchema = z
  .object({
    type: z.literal('template').optional().describe('`template`, the default.'),
    to: phoneField,
    templateId: z.uuid().describe('A template id from GET /api/v1/templates.'),
    from: templateFromField,
    variables: templateVariablesField,
  })
  .strict();

/** Sending one template to many numbers in one call (ADR-163), each with its own variables. */
export const apiSendManyTemplatesSchema = z
  .object({
    templateId: z.uuid().describe('A template id from GET /api/v1/templates.'),
    from: templateFromField,
    messages: z
      .array(z.object({ to: phoneField, variables: templateVariablesField }).strict())
      .min(1, 'Give at least one number to send to')
      .max(
        API_LIMITS.messagesPerSend,
        `At most ${API_LIMITS.messagesPerSend} messages are sent in one call`,
      )
      .describe(
        `The numbers to send the template to, each with the values of its variables, at most ${API_LIMITS.messagesPerSend}; each number once.`,
      ),
  })
  .strict();

/** The number a reply is sent from (ADR-070). */
const replyFromField = z
  .uuid()
  .optional()
  .describe(
    'The id of the WhatsApp number the contact wrote to; optional when the company has one active number.',
  );

/** The message a reply quotes (ADR-082), checked against the conversation when sending. */
const quoteField = z
  .uuid({ error: 'Give the id of a message in this conversation' })
  .optional()
  .describe(
    'The id of a message in the conversation to quote, from GET /conversations/{id}/messages, the message.received webhook or a send’s response: WhatsApp shows it above the reply. A message the contact sent, or one the business sent that WhatsApp accepted and that did not fail; not a reaction or a WhatsApp notice.',
  );

/** A free-form text reply to a contact who wrote in the last 24 hours (ADR-070). */
export const apiSendTextSchema = z
  .object({
    type: z.literal('text'),
    to: phoneField,
    from: replyFromField,
    replyTo: quoteField,
    text: z
      .string({ error: 'Give the text' })
      .trim()
      .min(1, 'Give the text')
      .max(
        API_LIMITS.textLength,
        `Text messages are limited to ${API_LIMITS.textLength} characters`,
      )
      .describe('The message.'),
    previewUrl: z
      .boolean()
      .default(false)
      .describe('Whether WhatsApp may show a preview of the first link in the text.'),
  })
  .strict();

const LIMITS = INTERACTIVE_LIMITS;

/** Text in a reply buttons or list message, trimmed, within Meta's limit (M-157, M-159, M-179). */
const interactiveText = (label: string, max: number) =>
  z
    .string({ error: `Give the ${label}` })
    .trim()
    .min(1, `Give the ${label}`)
    .max(max, `The ${label} is limited to ${max} characters`);

/**
 * A button's or row's id: the integration's own, returned when the customer taps it. Kept exactly
 * as given (Meta refuses spaces around it), and never one of HyFib's own ids (ADR-080).
 */
const replyIdField = (max: number) =>
  z
    .string({ error: 'Give an id' })
    .min(1, 'Give an id')
    .max(max, `Ids are limited to ${max} characters`)
    .refine((id) => id.trim() === id, 'Ids cannot start or end with a space')
    .refine(
      (id) => !isReservedReplyId(id),
      `Ids cannot start with “${RESERVED_REPLY_ID_PREFIX}”: HyFib’s own buttons use it`,
    );

const interactiveFrame = {
  to: phoneField,
  from: replyFromField,
  replyTo: quoteField,
  header: interactiveText('header', LIMITS.headerLength)
    .optional()
    .describe('Text shown above the body.'),
  body: interactiveText('body', LIMITS.bodyLength).describe('The message.'),
  footer: interactiveText('footer', LIMITS.footerLength)
    .optional()
    .describe('Small text shown below the body.'),
};

/** Adds an issue at each value already seen before it (compared as `key` gives them). */
function refineUnique(
  ctx: z.RefinementCtx,
  values: { path: (string | number)[]; key: string }[],
  message: string,
) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.key)) ctx.addIssue({ code: 'custom', path: value.path, message });
    seen.add(value.key);
  }
}

/** Reply buttons to a contact who wrote in the last 24 hours (ADR-080). */
export const apiSendButtonsSchema = z
  .object({
    type: z.literal('buttons'),
    ...interactiveFrame,
    buttons: z
      .array(
        z
          .object({
            id: replyIdField(LIMITS.buttonIdLength).describe(
              'Returned as `reply.id` in the `message.received` webhook when the customer taps it.',
            ),
            title: interactiveText('button title', LIMITS.buttonTitleLength).describe(
              'The button’s label, different from the others.',
            ),
          })
          .strict(),
      )
      .min(1, 'Give at least one button')
      .max(LIMITS.buttons, `A message has at most ${LIMITS.buttons} buttons`)
      .describe('The buttons, each with its own id and label.'),
  })
  .strict()
  .superRefine((data, ctx) => {
    refineUnique(
      ctx,
      data.buttons.map((b, i) => ({ path: ['buttons', i, 'title'], key: b.title.toLowerCase() })),
      'Give each button a different title',
    );
    refineUnique(
      ctx,
      data.buttons.map((b, i) => ({ path: ['buttons', i, 'id'], key: b.id })),
      'Give each button a different id',
    );
  });

/** A list message to a contact who wrote in the last 24 hours (ADR-080). */
export const apiSendListSchema = z
  .object({
    type: z.literal('list'),
    ...interactiveFrame,
    button: interactiveText('list button', LIMITS.listButtonLength).describe(
      'The label of the button that opens the list.',
    ),
    sections: z
      .array(
        z
          .object({
            title: interactiveText('section title', LIMITS.sectionTitleLength)
              .optional()
              .describe('Required when there is more than one section.'),
            rows: z
              .array(
                z
                  .object({
                    id: replyIdField(LIMITS.rowIdLength).describe(
                      'Returned as `reply.id` in the `message.received` webhook when the customer picks the row.',
                    ),
                    title: interactiveText('row title', LIMITS.rowTitleLength),
                    description: interactiveText('row description', LIMITS.rowDescriptionLength)
                      .optional()
                      .describe('Shown under the row’s title.'),
                  })
                  .strict(),
              )
              .min(1, 'Give each section at least one row')
              .max(LIMITS.rows, `A list has at most ${LIMITS.rows} rows`),
          })
          .strict(),
      )
      .min(1, 'Give at least one section')
      .max(LIMITS.sections, `A list has at most ${LIMITS.sections} sections`)
      .describe(
        `The rows the customer picks from, in sections: at most ${LIMITS.rows} rows in all, each with its own id.`,
      ),
  })
  .strict()
  .superRefine((data, ctx) => {
    const rows = data.sections.flatMap((section, s) =>
      section.rows.map((row, r) => ({ row, path: ['sections', s, 'rows', r] })),
    );
    if (rows.length > LIMITS.rows) {
      ctx.addIssue({
        code: 'custom',
        path: ['sections'],
        message: `A list has at most ${LIMITS.rows} rows in all`,
      });
    }
    if (data.sections.length > 1) {
      data.sections.forEach((section, s) => {
        if (!section.title) {
          ctx.addIssue({
            code: 'custom',
            path: ['sections', s, 'title'],
            message: 'Give each section a title when there is more than one',
          });
        }
      });
    }
    refineUnique(
      ctx,
      rows.map(({ row, path }) => ({ path: [...path, 'id'], key: row.id })),
      'Give each row a different id',
    );
  });

/** The longest emoji accepted, in UTF-16 code units. */
const EMOJI_LENGTH = 32;

/** A reaction to a message the contact sent in the last 30 days (ADR-082). */
export const apiSendReactionSchema = z
  .object({
    type: z.literal('reaction'),
    to: phoneField,
    from: replyFromField,
    replyTo: z
      .uuid({ error: 'Give the id of the contact’s message to react to' })
      .describe(
        'The id of the message to react to: one the contact sent in the last 30 days, from GET /conversations/{id}/messages or the message.received webhook.',
      ),
    emoji: z
      .string({ error: 'Give one emoji, such as 👍' })
      .max(EMOJI_LENGTH, 'Give one emoji, such as 👍')
      .refine(isSingleEmoji, 'Give one emoji, such as 👍')
      .describe(
        'One emoji, such as 👍, from Unicode’s recommended set: skin tones, flags and keycaps count as one.',
      ),
  })
  .strict();

/** A product's content id in a catalog (its retailer id), exactly as Meta keeps it (ADR-086). */
const retailerIdField = z
  .string({ error: 'Give the product’s content id' })
  .min(1, 'Give the product’s content id')
  .max(100, 'Content ids are limited to 100 characters')
  .describe(
    'The product’s content id (its SKU) in the catalog, exactly as Commerce Manager shows it.',
  );

const productFrame = {
  to: phoneField,
  from: replyFromField,
  replyTo: quoteField,
  catalogId: z
    .string()
    .regex(/^[0-9]{1,32}$/, 'Give the Meta catalog id (digits only)')
    .optional()
    .describe(
      'The Meta catalog the products are in; needed only when more than one catalog connected to the WhatsApp number has all the content ids.',
    ),
  footer: interactiveText('footer', COMMERCE_LIMITS.footerLength)
    .optional()
    .describe('Small text shown below the body.'),
};

/** One product from a catalog of the number, to a contact who wrote in the last 24 hours (ADR-086). */
export const apiSendProductSchema = z
  .object({
    type: z.literal('product'),
    ...productFrame,
    retailerId: retailerIdField,
    body: interactiveText('body', COMMERCE_LIMITS.bodyLength)
      .optional()
      .describe('Text shown with the product.'),
  })
  .strict();

/** Up to 30 products in sections, to a contact who wrote in the last 24 hours (ADR-086). */
export const apiSendProductListSchema = z
  .object({
    type: z.literal('product_list'),
    ...productFrame,
    header: interactiveText('header', COMMERCE_LIMITS.headerLength).describe(
      'The heading shown above the products.',
    ),
    body: interactiveText('body', COMMERCE_LIMITS.bodyLength).describe('The message.'),
    sections: z
      .array(
        z
          .object({
            title: interactiveText('section title', COMMERCE_LIMITS.sectionTitleLength)
              .optional()
              .describe('Required when there is more than one section.'),
            retailerIds: z
              .array(retailerIdField)
              .min(1, 'Give each section at least one product')
              .max(
                COMMERCE_LIMITS.productsPerMessage,
                `A message has at most ${COMMERCE_LIMITS.productsPerMessage} products`,
              ),
          })
          .strict(),
      )
      .min(1, 'Give at least one section')
      .max(COMMERCE_LIMITS.sections, `A message has at most ${COMMERCE_LIMITS.sections} sections`)
      .describe(
        `The products, in sections: at most ${COMMERCE_LIMITS.productsPerMessage} in all, each once, all from one catalog.`,
      ),
  })
  .strict()
  .superRefine((data, ctx) => {
    const products = data.sections.flatMap((section, s) =>
      section.retailerIds.map((id, i) => ({ id, path: ['sections', s, 'retailerIds', i] })),
    );
    if (products.length > COMMERCE_LIMITS.productsPerMessage) {
      ctx.addIssue({
        code: 'custom',
        path: ['sections'],
        message: `A message has at most ${COMMERCE_LIMITS.productsPerMessage} products in all`,
      });
    }
    if (data.sections.length > 1) {
      data.sections.forEach((section, s) => {
        if (!section.title) {
          ctx.addIssue({
            code: 'custom',
            path: ['sections', s, 'title'],
            message: 'Give each section a title when there is more than one',
          });
        }
      });
    }
    refineUnique(
      ctx,
      products.map(({ id, path }) => ({ path, key: id })),
      'Give each product once',
    );
  });

/** The number's catalog, opened from a product's picture (ADR-086). */
export const apiSendCatalogSchema = z
  .object({
    type: z.literal('catalog'),
    ...productFrame,
    thumbnailRetailerId: retailerIdField.describe(
      'The content id of the product whose picture the message shows.',
    ),
    body: interactiveText('body', COMMERCE_LIMITS.bodyLength).describe('The message.'),
  })
  .strict();

export interface ApiTemplate {
  id: string;
  name: string;
  language: string;
  category: 'utility' | 'marketing';
  variables: { header: number; body: number };
  text: { header: string | null; body: string; footer: string | null };
  channels: { id: string; phone: string | null }[];
}

export interface ApiMessage {
  id: string;
  type: 'template' | 'text' | 'interactive' | 'reaction';
  status: string;
  statusAt: string;
  to: string | null;
  templateId: string | null;
  templateName: string | null;
  channelId: string;
  contactId: string;
  /** The message it quotes or reacts to, when it is in the conversation (ADR-082). */
  replyTo: string | null;
  error: { code: string | null; title: string | null } | null;
  createdAt: string;
}

export const explicitPhone = (raw: string) => {
  const phone = normalizePhone(raw, { kind: 'explicit' });
  if (!phone.ok)
    throw new AppError('validation_failed', phone.message, {
      issues: [{ path: 'phone', message: phone.message }],
    });
  return phone.e164;
};

/** A number in a list of starts or sends, refused at its place in the list when it is not one. */
export function phoneAt(raw: string, path: string): string {
  const phone = normalizePhone(raw, { kind: 'explicit' });
  if (!phone.ok) {
    throw new AppError('validation_failed', phone.message, {
      issues: [{ path, message: phone.message }],
    });
  }
  return phone.e164;
}

/**
 * Refuses a list of starts or sends that gives a number twice, naming the later place
 * (ADR-161, ADR-163).
 */
export function assertEachNumberOnce(items: readonly { place: string; phone: string }[]): void {
  const firstAt = new Map<string, string>();
  for (const item of items) {
    const earlier = firstAt.get(item.phone);
    if (earlier !== undefined) {
      const message = `Give each number once: ${item.place}.to is the number of ${earlier}.to.`;
      throw new AppError('validation_failed', message, {
        issues: [{ path: `${item.place}.to`, message }],
      });
    }
    firstAt.set(item.phone, item.place);
  }
}

/** Runs work once per idempotency key (when given) in one transaction with it. */
export async function idempotent(
  tx: Tx,
  ctx: ApiContext,
  idempotency: IdempotencyInput | null,
  now: Date,
  work: () => Promise<{ status: number; body: Record<string, unknown> }>,
  /** What is kept for a replay, when not the whole body (a secret is shown once, ADR-081). */
  kept: (body: Record<string, unknown>) => Record<string, unknown> = (body) => body,
): Promise<ApiResponse> {
  let claimed: string | null = null;
  if (idempotency) {
    const claim = await claimIdempotencyKey(tx, ctx, idempotency, now);
    if ('replay' in claim) return claim.replay;
    claimed = claim.claimed;
  }
  const result = await work();
  if (claimed) {
    await storeIdempotentResponse(tx, ctx, claimed, {
      status: result.status,
      body: kept(result.body),
    });
  }
  return { ...result, replayed: false };
}

export async function apiListTemplates(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
): Promise<{ data: ApiTemplate[] }> {
  assertScope(ctx, 'templates.read');
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const rows = await tx
        .select({
          id: messageTemplates.id,
          name: messageTemplates.name,
          language: messageTemplates.language,
          category: messageTemplates.category,
          components: messageTemplates.components,
          whatsappAccountId: messageTemplates.whatsappAccountId,
        })
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.tenantId, ctx.tenant.id),
            eq(messageTemplates.status, 'approved'),
            inArray(messageTemplates.category, ['UTILITY', 'MARKETING']),
          ),
        )
        .orderBy(asc(messageTemplates.name), asc(messageTemplates.language));
      const numbers = await tx
        .select({
          id: channelAccounts.id,
          phone: channelAccounts.displayPhoneNumber,
          whatsappAccountId: channelAccounts.whatsappAccountId,
        })
        .from(channelAccounts)
        .where(
          and(eq(channelAccounts.tenantId, ctx.tenant.id), eq(channelAccounts.status, 'active')),
        );
      const data: ApiTemplate[] = [];
      for (const t of rows) {
        const spec = sendSpecFor(t.category, t.components);
        const definition = fromMetaComponents(t.category, t.components);
        if (!spec.supported || !definition) continue;
        data.push({
          id: t.id,
          name: t.name,
          language: t.language,
          category: t.category === 'MARKETING' ? 'marketing' : 'utility',
          variables: { header: spec.headerParams, body: spec.bodyParams },
          text: {
            header: definition.header.type === 'text' ? definition.header.text : null,
            body: definition.body.text,
            footer: definition.footer ?? null,
          },
          channels: numbers
            .filter((n) => n.whatsappAccountId === t.whatsappAccountId)
            .map((n) => ({ id: n.id, phone: n.phone })),
        });
      }
      return { data };
    },
    { accessMode: 'read only' },
  );
}

/**
 * The company's contacts newest first on exact keyset pages, found by number, email address, tag
 * and custom field values (ADR-113) and part of the name (ADR-124), all of which a contact must
 * match. A page filtered by name, tag or field reads at most API_CONTACT_SEARCH_WINDOW contacts:
 * when the filters leave out most of them it shows fewer than the limit, or none, and its cursor
 * continues after the last one it read. Both reads see one snapshot.
 */
export async function apiListContacts(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiContact[]; nextCursor: string | null }> {
  assertScope(ctx, 'contacts.read');
  const q = parseInput(apiContactListQuerySchema, contactListQuery(query));
  const cursor = decodeKeysetCursor(q.cursor);
  const phone = q.phone ? explicitPhone(q.phone) : null;
  const { email, tag, name } = apiContactListFilters(q);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const filters = await apiFieldFilters(tx, ctx.tenant.id, q.fields ?? {});
      if (tag) {
        filters.push(sql`exists (select 1 from app.contact_tags t where t.tenant_id = ${contacts.tenantId}
          and t.contact_id = ${contacts.id} and t.tag = ${tag})`);
      }
      // As members' search compares names: letters whatever their case, the text as written.
      if (name) filters.push(sql`${contacts.displayName} ilike ${likePattern(name)}`);
      return apiContactPage(tx, ctx.tenant.id, {
        cursor,
        limit: q.limit,
        narrow: [
          phone ? eq(contacts.phoneE164, phone) : undefined,
          email ? sql`lower(${contacts.email}) = lower(${email})` : undefined,
        ],
        filters,
      });
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export async function apiGetContact(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  contactId: string,
): Promise<ApiContact> {
  assertScope(ctx, 'contacts.read');
  if (!z.uuid().safeParse(contactId).success) throw notFound('Contact');
  const row = await deps.db.run(ctx.scope, (tx) => apiContactById(tx, ctx.tenant.id, contactId), {
    accessMode: 'read only',
  });
  if (!row) throw notFound('Contact');
  return toApiContact(row);
}

/**
 * Creates a contact, or answers with the existing one for the number (200 instead of 201); a
 * name, email or custom field values given for an existing contact fill only what is empty, and
 * tags are added (50 at most per contact, as members keep them).
 */
export async function apiCreateContact(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput | null,
): Promise<ApiResponse> {
  assertScope(ctx, 'contacts.write');
  const data = parseInput(apiContactCreateSchema, input);
  const phone = explicitPhone(data.phone);
  const email = normalizeEmail(data.email ?? '');
  if (!email.ok) throw new AppError('validation_failed', email.message);
  const tags = apiTags(data.tags ?? [], 'tags');
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, (tx) =>
    idempotent(tx, ctx, idempotency, now, async () => {
      // Values only: an empty string, which clears a value elsewhere, gives none here.
      const values: Record<string, AttributeValue> = {};
      for (const [key, value] of Object.entries(
        await apiFieldChanges(tx, ctx.tenant.id, data.fields ?? {}),
      )) {
        if (value !== null) values[key] = value;
      }
      const [suppressed] = await tx
        .select({ id: suppressions.id })
        .from(suppressions)
        .where(and(eq(suppressions.tenantId, ctx.tenant.id), eq(suppressions.phoneE164, phone)))
        .limit(1);
      if (suppressed) {
        throw new AppError(
          'precondition_failed',
          'This number is on the company’s suppression list, so no contact is created for it.',
        );
      }
      const [inserted] = await tx
        .insert(contacts)
        .values({
          id: uuidv7(),
          tenantId: ctx.tenant.id,
          displayName: data.name || null,
          phoneE164: phone,
          email: email.email,
          attributes: values,
          source: 'api',
        })
        .onConflictDoNothing({
          target: [contacts.tenantId, contacts.phoneE164],
          where: sql`phone_e164 is not null`,
        })
        .returning({ id: contacts.id });
      const id =
        inserted?.id ??
        (
          await tx
            .select({ id: contacts.id })
            .from(contacts)
            .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.phoneE164, phone)))
        )[0]?.id;
      if (!id) throw new Error('Contact with this number vanished during upsert');
      if (!inserted) {
        await tx
          .update(contacts)
          .set({
            displayName: sql`coalesce(${contacts.displayName}, ${data.name || null})`,
            email: sql`coalesce(${contacts.email}, ${email.email})`,
            // The contact's own values win over the request's.
            attributes: sql`${jsonbText(values)}::jsonb || ${contacts.attributes}`,
          })
          .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, id)));
        if (tags.length > 0) {
          const existing = await tx
            .select({ tag: contactTags.tag })
            .from(contactTags)
            .where(and(eq(contactTags.tenantId, ctx.tenant.id), eq(contactTags.contactId, id)));
          const all = new Set([...existing.map((e) => e.tag), ...tags]);
          if (all.size > MAX_TAGS_PER_CONTACT) {
            const message = `A contact can have at most ${MAX_TAGS_PER_CONTACT} tags.`;
            throw new AppError('validation_failed', message, {
              issues: [{ path: 'tags', message }],
            });
          }
        }
      }
      if (tags.length > 0) {
        await tx
          .insert(contactTags)
          .values(
            tags.map((tag) => ({ id: uuidv7(), tenantId: ctx.tenant.id, contactId: id, tag })),
          )
          .onConflictDoNothing();
      }
      if (inserted) {
        await recordSystemAudit(
          tx,
          ctx.tenant.id,
          {
            action: 'contact.created',
            subjectType: 'contact',
            subjectId: id,
            correlationId: ctx.requestId,
            metadata: { source: 'api' },
          },
          apiActor(ctx),
        );
      }
      const row = await apiContactById(tx, ctx.tenant.id, id);
      if (!row) throw new AppError('conflict', 'This contact was erased.');
      return {
        status: inserted ? 201 : 200,
        body: { data: toApiContact(row), created: Boolean(inserted) },
      };
    }),
  );
}

/** Records an opt-in or opt-out with its evidence, as the key (consent source `api`). */
export async function apiRecordConsent(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  contactId: string,
  input: unknown,
): Promise<ApiContact> {
  assertScope(ctx, 'contacts.write');
  if (!z.uuid().safeParse(contactId).success) throw notFound('Contact');
  const data = parseInput(apiConsentSchema, input);
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, async (tx) => {
    const [contact] = await tx
      .select({ id: contacts.id, erasedAt: contacts.erasedAt })
      .from(contacts)
      .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, contactId)))
      .for('update');
    if (!contact || contact.erasedAt) throw notFound('Contact');
    await recordConsentEvents(tx, [
      {
        tenantId: ctx.tenant.id,
        contactId,
        purpose: data.purpose,
        action: data.action,
        source: 'api',
        evidence: { note: data.evidence, apiKeyId: ctx.key.id },
        actorType: 'api_key',
        actorId: ctx.key.id,
        occurredAt: now,
      },
    ]);
    await recordSystemAudit(
      tx,
      ctx.tenant.id,
      {
        action: 'consent.recorded',
        subjectType: 'contact',
        subjectId: contactId,
        correlationId: ctx.requestId,
        metadata: { purpose: data.purpose, consentAction: data.action, source: 'api' },
      },
      apiActor(ctx),
    );
    const row = await apiContactById(tx, ctx.tenant.id, contactId);
    if (!row) throw notFound('Contact');
    return toApiContact(row);
  });
}

/**
 * The WhatsApp number a send uses: the one named by `from`, or the company's only active number.
 * Its state is checked by the caller, after checks that name the number's account.
 */
async function sendingNumber(tx: Tx, ctx: ApiContext, from: string | undefined) {
  const numbers = await tx
    .select({
      id: channelAccounts.id,
      status: channelAccounts.status,
      whatsappAccountId: channelAccounts.whatsappAccountId,
    })
    .from(channelAccounts)
    .where(
      and(
        eq(channelAccounts.tenantId, ctx.tenant.id),
        from ? eq(channelAccounts.id, from) : eq(channelAccounts.status, 'active'),
      ),
    );
  const channel = numbers.length === 1 ? numbers[0] : undefined;
  if (!channel) {
    if (from) throw notFound('WhatsApp number');
    throw new AppError(
      'validation_failed',
      numbers.length === 0
        ? 'The company has no active WhatsApp number.'
        : 'The company has several WhatsApp numbers: say which one to send from (from).',
    );
  }
  return channel;
}

/** A template message as a send queues it (ADR-052). */
export interface ApiQueuedTemplate {
  id: string;
  type: 'template';
  status: 'queued';
  contactId: string;
  channelId: string;
  templateId: string;
}

/** What a send to many numbers answers for one number (ADR-163). */
export interface ApiTemplateSend {
  to: string;
  message: ApiQueuedTemplate | null;
  error: { code: 'precondition_failed'; message: string } | null;
}

/**
 * Sends an approved template to a number (the contact is created when new) with the same checks as
 * members' template sends: erasure, suppression, consent for the template's category, the
 * marketing frequency cap, and the template's and number's state. Exactly one send per idempotency
 * key; delivery follows the send pipeline.
 */
export async function apiSendTemplate(
  deps: OutboundDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  // The template decides which of the two scopes is needed; a request that may use neither is
  // refused first.
  assertAnyScope(ctx, ['messages.send', 'messages.send_marketing']);
  const data = parseInput(apiSendMessageSchema, input);
  const phone = explicitPhone(data.to);
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, (tx) =>
    idempotent(tx, ctx, idempotency, now, async () => {
      const sendable = await loadSendableTemplate(tx, ctx, data.templateId);
      assertTemplateVariables(sendable.spec, data.variables);
      const channel = await templateSendingNumber(tx, ctx, sendable.template, data.from);
      await lockMarketingSends(tx, ctx, sendable.template);
      const message = await queueTemplateFor(
        deps,
        tx,
        ctx,
        sendable,
        channel,
        phone,
        data.variables,
        now,
      );
      return { status: 201, body: { data: message } };
    }),
  );
}

/**
 * Sends an approved template to up to 50 numbers in one call (ADR-163), each with its own
 * variables. The template, every send's variables and the number sent from are checked once, then
 * each number is sent to as a send to one number is, in a savepoint: a refusal for its contact rolls
 * back to it and is answered in its place while the others are sent. Once per idempotency key.
 */
export async function apiSendManyTemplates(
  deps: OutboundDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  assertAnyScope(ctx, ['messages.send', 'messages.send_marketing']);
  const data = parseInput(apiSendManyTemplatesSchema, input);
  const sends = data.messages.map((message, i) => ({
    place: `messages.${i}`,
    phone: phoneAt(message.to, `messages.${i}.to`),
    variables: message.variables,
  }));
  assertEachNumberOnce(sends);
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, (tx) =>
    idempotent(tx, ctx, idempotency, now, async () => {
      const sendable = await loadSendableTemplate(tx, ctx, data.templateId);
      for (const send of sends) {
        assertTemplateVariables(sendable.spec, send.variables, `${send.place}.variables`);
      }
      const channel = await templateSendingNumber(tx, ctx, sendable.template, data.from);
      await lockMarketingSends(tx, ctx, sendable.template);
      const answers: ApiTemplateSend[] = [];
      for (const { phone, variables } of sends) {
        try {
          const message = await tx.transaction((sp) =>
            queueTemplateFor(deps, sp, ctx, sendable, channel, phone, variables, now),
          );
          answers.push({ to: phone, message, error: null });
        } catch (error) {
          // Consent, the suppression list and the frequency cap refuse one number; anything else
          // refuses the call.
          if (!isAppError(error) || error.code !== 'precondition_failed') throw error;
          answers.push({
            to: phone,
            message: null,
            error: { code: 'precondition_failed', message: error.publicMessage },
          });
        }
      }
      return { status: 200, body: { data: answers } };
    }),
  );
}

/** An approved template a key may send, with what a send of it needs. */
interface SendableTemplate {
  template: typeof messageTemplates.$inferSelect;
  spec: Extract<SendSpec, { supported: true }>;
}

/**
 * The template, when it is the company's, approved and one HyFib can send; its category decides the
 * scope the key needs.
 */
async function loadSendableTemplate(
  tx: Tx,
  ctx: ApiContext,
  templateId: string,
): Promise<SendableTemplate> {
  const [template] = await tx
    .select()
    .from(messageTemplates)
    .where(and(eq(messageTemplates.tenantId, ctx.tenant.id), eq(messageTemplates.id, templateId)));
  if (!template) throw notFound('Template');
  assertScope(ctx, template.category === 'MARKETING' ? 'messages.send_marketing' : 'messages.send');
  if (template.status !== 'approved') {
    throw new AppError('precondition_failed', 'Only templates approved by Meta can be sent.');
  }
  const spec = sendSpecFor(template.category, template.components);
  if (!spec.supported) throw new AppError('unsupported', spec.reason);
  return { template, spec };
}

/** Refuses values that do not fill the template's variables, naming `path` in a list of sends. */
function assertTemplateVariables(
  spec: SendableTemplate['spec'],
  variables: TemplateParams,
  path?: string,
): void {
  if (variables.header.length === spec.headerParams && variables.body.length === spec.bodyParams) {
    return;
  }
  const message = `This template needs ${spec.headerParams} header and ${spec.bodyParams} body variables.`;
  throw new AppError('validation_failed', message, path ? { issues: [{ path, message }] } : {});
}

/** The number the template is sent from: of the template's WhatsApp account, and active. */
async function templateSendingNumber(
  tx: Tx,
  ctx: ApiContext,
  template: SendableTemplate['template'],
  from: string | undefined,
) {
  const channel = await sendingNumber(tx, ctx, from);
  if (channel.whatsappAccountId !== template.whatsappAccountId) {
    throw new AppError(
      'validation_failed',
      'This template belongs to another WhatsApp account than the number it would be sent from.',
    );
  }
  if (channel.status !== 'active') {
    throw new AppError('precondition_failed', 'This WhatsApp number is not active.');
  }
  return channel;
}

/**
 * A marketing template is counted under the campaign runner's company lock (ADR-049), taken before
 * any contact is created or conversation locked, by a send to one number as by a send to many
 * (ADR-163), so the two take their locks in one order.
 */
async function lockMarketingSends(
  tx: Tx,
  ctx: ApiContext,
  template: SendableTemplate['template'],
): Promise<void> {
  if (template.category === 'MARKETING') await lockCampaignSends(tx, ctx.tenant.id, 'wait');
}

/**
 * Queues the template for the number: the contact (created when new), erasure, suppression and
 * consent, the marketing frequency cap, then the message, its send intent and its job. A refusal
 * throws; the caller's transaction or savepoint rolls back what it wrote, a contact created for the
 * number included. For a marketing template the caller holds the campaign runner's company lock.
 */
async function queueTemplateFor(
  deps: OutboundDeps,
  tx: Tx,
  ctx: ApiContext,
  { template, spec }: SendableTemplate,
  channel: { id: string; whatsappAccountId: string },
  phone: string,
  variables: TemplateParams,
  now: Date,
): Promise<ApiQueuedTemplate> {
  const contactId = await contactForPhone(tx, ctx.tenant.id, {
    phoneE164: phone,
    displayName: null,
    source: 'api',
  });
  const eligibility = await checkTemplateEligibility(tx, {
    tenantId: ctx.tenant.id,
    contactId,
    recipientPhones: [phone],
    category: template.category,
  });
  if (!eligibility.ok) throw new AppError('precondition_failed', eligibility.message);
  if (
    template.category === 'MARKETING' &&
    (await marketingCapReached(tx, ctx.tenant.id, contactId, now))
  ) {
    throw new AppError(
      'precondition_failed',
      'The contact already received as many marketing messages as the company allows in the period.',
    );
  }
  const [identity] = await tx
    .select({ waId: contactIdentities.waId })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.tenantId, ctx.tenant.id),
        eq(contactIdentities.contactId, contactId),
        eq(contactIdentities.whatsappAccountId, channel.whatsappAccountId),
        isNotNull(contactIdentities.waId),
      ),
    )
    .limit(1);
  const recipient = phoneFromWaId(identity?.waId) ?? phone;
  const built = buildTemplateSend(template, spec, variables);

  // A conversation this message starts is resolved, like a campaign's; the reply opens it.
  await tx
    .insert(conversations)
    .values({
      id: uuidv7(),
      tenantId: ctx.tenant.id,
      channelAccountId: channel.id,
      contactId,
      status: 'resolved',
      resolvedAt: now,
    })
    .onConflictDoNothing();
  const [conversation] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, ctx.tenant.id),
        eq(conversations.channelAccountId, channel.id),
        eq(conversations.contactId, contactId),
      ),
    )
    .for('update');
  if (!conversation) throw new Error('Conversation upsert failed');
  const messageId = uuidv7();
  const intentId = uuidv7();
  await tx.insert(messages).values({
    id: messageId,
    tenantId: ctx.tenant.id,
    conversationId: conversation.id,
    channelAccountId: channel.id,
    direction: 'outbound',
    type: 'template',
    content: {
      template: {
        id: template.id,
        name: template.name,
        language: template.language,
        category: template.category,
      },
      rendered: built.rendered,
    },
    status: 'queued',
    statusRank: STATUS_RANK.queued,
    senderType: 'api',
    apiKeyId: ctx.key.id,
    templateId: template.id,
  });
  await tx.insert(sendIntents).values({
    id: intentId,
    tenantId: ctx.tenant.id,
    messageId,
    channelAccountId: channel.id,
    request: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: waRecipientFromPhone(recipient),
      type: 'template',
      template: built.template,
    },
    actorUserId: null,
  });
  await tx
    .update(conversations)
    .set({
      lastMessageAt: now,
      lastMessagePreview: clipText(built.rendered.body, 200),
      version: sql`${conversations.version} + 1`,
    })
    .where(and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversation.id)));
  await emitTenantEvent(tx, ctx.tenant.id, {
    type: 'message.created',
    conversationId: conversation.id,
    payload: { messageId },
  });
  await deps.jobs.enqueue(
    tx,
    QUEUES.messageSend.name,
    deps.signer.sign({
      kind: 'message.send',
      tenantId: ctx.tenant.id,
      actorUserId: null,
      ref: intentId,
    }),
    { singletonKey: intentId, group: { id: channel.id } },
  );
  return {
    id: messageId,
    type: 'template',
    status: 'queued',
    contactId,
    channelId: channel.id,
    templateId: template.id,
  };
}

/** The refusal for a number the reply cannot reach (ADR-070). */
const windowClosed = () =>
  new AppError(
    'precondition_failed',
    'This number has not written to this WhatsApp number in the last 24 hours, so only approved templates can be sent to it.',
    { details: { apiReason: 'window_closed' } },
  );

/**
 * The WhatsApp id of the message `messageId` of the conversation, which a reply quotes or a
 * reaction goes on (ADR-082). A message of another conversation is refused as unknown, like one
 * that does not exist.
 */
async function answeredMessage(
  tx: Tx,
  tenantId: string,
  conversationId: string,
  messageId: string,
  options: { kind: 'quote' | 'reaction'; now: Date },
): Promise<string> {
  const [target] = await tx
    .select({
      direction: messages.direction,
      type: messages.type,
      status: messages.status,
      externalMessageId: messages.externalMessageId,
      providerTimestamp: messages.providerTimestamp,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, tenantId),
        eq(messages.conversationId, conversationId),
        eq(messages.id, messageId),
      ),
    );
  const problem = target
    ? answerProblem(
        options.kind,
        { ...target, at: target.providerTimestamp ?? target.createdAt },
        options.now,
      )
    : 'Give the id of a message in this conversation.';
  if (problem) {
    throw new AppError('validation_failed', problem, {
      issues: [{ path: 'replyTo', message: problem }],
    });
  }
  if (!target?.externalMessageId) throw new Error('Only messages with a WhatsApp id are answered');
  return target.externalMessageId;
}

/** What a reply stores and sends (ADR-070, ADR-080, ADR-082). */
interface BuiltReply {
  content: Record<string, unknown>;
  preview: string;
  request: Record<string, unknown>;
}

interface ApiReply {
  type: 'text' | 'interactive' | 'reaction';
  /** The message the reply quotes, or the reaction is for, as the request names it. */
  replyTo: string | undefined;
  /** Checks that do not depend on the number, made first (the plan's modules). */
  precheck?: (tx: Tx) => Promise<void>;
  /**
   * The message's stored content (as the inbox shows it), the conversation's preview, and the
   * Graph request's `type` and its object, given the WhatsApp id of the message named by `replyTo`
   * and the WhatsApp account of the number it is sent from.
   */
  build(
    answered: string | null,
    sending: { tx: Tx; whatsappAccountId: string },
  ): BuiltReply | Promise<BuiltReply>;
}

/**
 * Sends a free-form message to a contact who wrote to the number in the last 24 hours, as the
 * inbox's reply does (ADR-070): text, reply buttons or a list (ADR-080), which may quote a message
 * of the conversation, or a reaction to a message the contact sent (ADR-082). The contact is never
 * created: a number that is not a contact, has no conversation on the number, was erased, or last
 * wrote more than 24 hours ago gets one answer, so the refusal tells a key without `contacts.read`
 * nothing more than a sent reply would. A reply takes the conversation over from an automation
 * handling it (its queued messages are cancelled), but it is not a member's reply: the
 * conversation keeps waiting for a member. A reaction is not an answer: it leaves an automation
 * running. Exactly one send per idempotency key; the window is checked again when the worker sends.
 */
async function sendReply(
  deps: OutboundDeps,
  ctx: ApiContext,
  target: { to: string; from?: string | undefined },
  idempotency: IdempotencyInput,
  reply: ApiReply,
): Promise<ApiResponse> {
  const phone = explicitPhone(target.to);
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, (tx) =>
    idempotent(tx, ctx, idempotency, now, async () => {
      if (reply.precheck) await reply.precheck(tx);
      const channel = await sendingNumber(tx, ctx, target.from);
      if (channel.status !== 'active') {
        throw new AppError('precondition_failed', 'This WhatsApp number is not active.');
      }
      const [contact] = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, ctx.tenant.id),
            eq(contacts.phoneE164, phone),
            isNull(contacts.erasedAt),
          ),
        );
      if (!contact) throw windowClosed();
      // Locked like a member's reply: serialised with assignments, other replies and the
      // automation's own steps on the conversation.
      const [conversation] = await tx
        .select({ id: conversations.id, lastInboundAt: conversations.lastInboundAt })
        .from(conversations)
        .where(
          and(
            eq(conversations.tenantId, ctx.tenant.id),
            eq(conversations.channelAccountId, channel.id),
            eq(conversations.contactId, contact.id),
          ),
        )
        .for('update');
      if (
        !conversation?.lastInboundAt ||
        now.getTime() - conversation.lastInboundAt.getTime() > SERVICE_WINDOW_MS
      ) {
        throw windowClosed();
      }
      const [identity] = await tx
        .select({ waId: contactIdentities.waId })
        .from(contactIdentities)
        .where(
          and(
            eq(contactIdentities.tenantId, ctx.tenant.id),
            eq(contactIdentities.contactId, contact.id),
            eq(contactIdentities.whatsappAccountId, channel.whatsappAccountId),
            isNotNull(contactIdentities.waId),
          ),
        )
        .limit(1);
      if (!identity?.waId) {
        throw new AppError(
          'unsupported',
          'This contact wrote from a WhatsApp user id without a phone number. Sending to user ids is not enabled until Meta’s request format is verified.',
        );
      }
      const reaction = reply.type === 'reaction';
      const answered = reply.replyTo
        ? await answeredMessage(tx, ctx.tenant.id, conversation.id, reply.replyTo, {
            kind: reaction ? 'reaction' : 'quote',
            now,
          })
        : null;

      if (!reaction) {
        await endRunForHuman(tx, {
          tenantId: ctx.tenant.id,
          conversationId: conversation.id,
          reason: 'api_replied',
          actorMembershipId: null,
          now,
        });
      }
      const built = await reply.build(answered, {
        tx,
        whatsappAccountId: channel.whatsappAccountId,
      });
      const messageId = uuidv7();
      const intentId = uuidv7();
      await tx.insert(messages).values({
        id: messageId,
        tenantId: ctx.tenant.id,
        conversationId: conversation.id,
        channelAccountId: channel.id,
        direction: 'outbound',
        type: reply.type,
        content: built.content,
        status: 'queued',
        statusRank: STATUS_RANK.queued,
        senderType: 'api',
        apiKeyId: ctx.key.id,
        // A quoted reply keeps the quoted message's WhatsApp id as inbound replies do; a
        // reaction keeps it in its content, as inbound reactions do.
        contextExternalId: reaction ? null : answered,
      });
      await tx.insert(sendIntents).values({
        id: intentId,
        tenantId: ctx.tenant.id,
        messageId,
        channelAccountId: channel.id,
        request: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: identity.waId,
          ...(answered && !reaction ? { context: { message_id: answered } } : {}),
          ...built.request,
        },
        actorUserId: null,
      });
      await tx
        .update(conversations)
        .set({
          lastMessageAt: now,
          lastMessagePreview: clipText(built.preview, 200),
          version: sql`${conversations.version} + 1`,
        })
        .where(
          and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversation.id)),
        );
      await emitTenantEvent(tx, ctx.tenant.id, {
        type: 'message.created',
        conversationId: conversation.id,
        payload: { messageId },
      });
      await deps.jobs.enqueue(
        tx,
        QUEUES.messageSend.name,
        deps.signer.sign({
          kind: 'message.send',
          tenantId: ctx.tenant.id,
          actorUserId: null,
          ref: intentId,
        }),
        { singletonKey: intentId, group: { id: channel.id } },
      );
      return {
        status: 201,
        body: {
          data: {
            id: messageId,
            type: reply.type,
            status: 'queued',
            contactId: contact.id,
            channelId: channel.id,
          },
        },
      };
    }),
  );
}

/** A free-form text reply (ADR-070); see `sendReply`. */
export async function apiSendText(
  deps: OutboundDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  assertScope(ctx, 'messages.reply');
  const data = parseInput(apiSendTextSchema, input);
  return sendReply(deps, ctx, data, idempotency, {
    type: 'text',
    replyTo: data.replyTo,
    build: () => ({
      content: { text: data.text },
      preview: data.text,
      request: { type: 'text', text: { body: data.text, preview_url: data.previewUrl } },
    }),
  });
}

/** Reply buttons (ADR-080); see `sendReply`. */
export async function apiSendButtons(
  deps: OutboundDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  assertScope(ctx, 'messages.reply');
  const data = parseInput(apiSendButtonsSchema, input);
  return sendReply(deps, ctx, data, idempotency, {
    type: 'interactive',
    replyTo: data.replyTo,
    build: () => ({
      content: replyButtonsContent(data),
      preview: data.body,
      request: { type: 'interactive', interactive: replyButtonsInteractive(data) },
    }),
  });
}

/** A list message (ADR-080); see `sendReply`. */
export async function apiSendList(
  deps: OutboundDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  assertScope(ctx, 'messages.reply');
  const data = parseInput(apiSendListSchema, input);
  return sendReply(deps, ctx, data, idempotency, {
    type: 'interactive',
    replyTo: data.replyTo,
    build: () => ({
      content: listContent(data),
      preview: data.body,
      request: { type: 'interactive', interactive: listInteractive(data) },
    }),
  });
}

/**
 * A reaction to a message the contact sent in the last 30 days (ADR-082); see `sendReply`. Stored
 * as inbound reactions are, with the WhatsApp id of the message in its content.
 */
export async function apiSendReaction(
  deps: OutboundDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  assertScope(ctx, 'messages.reply');
  const data = parseInput(apiSendReactionSchema, input);
  return sendReply(deps, ctx, data, idempotency, {
    type: 'reaction',
    replyTo: data.replyTo,
    build: (answered) => {
      if (!answered) throw new Error('A reaction is sent only for a message it names');
      return {
        content: { emoji: data.emoji, message_id: answered },
        preview: `Reacted ${data.emoji}`,
        request: { type: 'reaction', reaction: { message_id: answered, emoji: data.emoji } },
      };
    },
  });
}

/**
 * The products a message names by content id, in one catalog connected to the sending number's
 * WhatsApp account, neither disconnected nor removed at Meta (ADR-086). `catalogId` picks the
 * catalog when two of them hold the ids. Unknown ids are refused by name.
 */
async function catalogProducts(
  tx: Tx,
  tenantId: string,
  whatsappAccountId: string,
  retailerIds: string[],
  catalogId: string | undefined,
): Promise<{ catalogId: string; names: Map<string, string> }> {
  const rows = await tx
    .select({
      retailerId: commerceProducts.retailerId,
      name: commerceProducts.name,
      catalogId: commerceCatalogs.metaCatalogId,
    })
    .from(commerceProducts)
    .innerJoin(
      commerceCatalogs,
      and(
        eq(commerceCatalogs.tenantId, commerceProducts.tenantId),
        eq(commerceCatalogs.id, commerceProducts.catalogId),
      ),
    )
    .where(
      and(
        eq(commerceProducts.tenantId, tenantId),
        inArray(commerceProducts.retailerId, retailerIds),
        eq(commerceCatalogs.whatsappAccountId, whatsappAccountId),
        isNull(commerceCatalogs.disconnectedAt),
        isNull(commerceProducts.removedAt),
        catalogId ? eq(commerceCatalogs.metaCatalogId, catalogId) : undefined,
      ),
    );
  const refuse = (path: string, message: string) =>
    new AppError('validation_failed', message, { issues: [{ path, message }] });
  const known = new Set(rows.map((r) => r.retailerId));
  const missing = retailerIds.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw refuse(
      'products',
      `Not in a catalog of this WhatsApp number${catalogId ? ' with that id' : ''}: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`,
    );
  }
  const complete = [...new Set(rows.map((r) => r.catalogId))].filter((c) =>
    retailerIds.every((id) => rows.some((r) => r.catalogId === c && r.retailerId === id)),
  );
  const [chosen, other] = complete;
  if (!chosen) throw refuse('products', 'Give products from one catalog.');
  if (other) {
    throw refuse(
      'catalogId',
      'More than one catalog of this WhatsApp number has these products: name one with catalogId.',
    );
  }
  return {
    catalogId: chosen,
    names: new Map(rows.filter((r) => r.catalogId === chosen).map((r) => [r.retailerId, r.name])),
  };
}

type ApiProductInput =
  | z.infer<typeof apiSendProductSchema>
  | z.infer<typeof apiSendProductListSchema>
  | z.infer<typeof apiSendCatalogSchema>;

/**
 * A product, several products or the catalog (ADR-086), as the inbox sends them (P4-06); see
 * `sendReply`. The company's plan must include Commerce.
 */
export async function apiSendProducts(
  deps: OutboundDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  assertScope(ctx, 'messages.reply');
  const type =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as { type?: unknown }).type
      : undefined;
  const data: ApiProductInput =
    type === 'product'
      ? parseInput(apiSendProductSchema, input)
      : type === 'product_list'
        ? parseInput(apiSendProductListSchema, input)
        : parseInput(apiSendCatalogSchema, input);
  const retailerIds =
    data.type === 'product'
      ? [data.retailerId]
      : data.type === 'catalog'
        ? [data.thumbnailRetailerId]
        : data.sections.flatMap((s) => s.retailerIds);
  return sendReply(deps, ctx, data, idempotency, {
    type: 'interactive',
    replyTo: data.replyTo,
    precheck: async (tx) => {
      const entitlements = await loadEntitlements(tx, ctx.tenant.id);
      if (!entitlements.modules.has('commerce')) {
        throw new AppError('forbidden', "Your company's plan does not include Commerce.", {
          details: { apiReason: 'not_in_plan' },
        });
      }
    },
    build: async (_answered, sending) => {
      const found = await catalogProducts(
        sending.tx,
        ctx.tenant.id,
        sending.whatsappAccountId,
        retailerIds,
        data.catalogId,
      );
      const footer = data.footer ?? '';
      const resolved: ResolvedProductMessage =
        data.type === 'product'
          ? {
              kind: 'product',
              catalogId: found.catalogId,
              retailerId: data.retailerId,
              body: data.body ?? '',
              footer,
            }
          : data.type === 'catalog'
            ? {
                kind: 'catalog',
                thumbnailRetailerId: data.thumbnailRetailerId,
                body: data.body,
                footer,
              }
            : {
                kind: 'product_list',
                catalogId: found.catalogId,
                header: data.header,
                body: data.body,
                footer,
                sections: data.sections.map((s) => ({
                  title: s.title ?? '',
                  retailerIds: s.retailerIds,
                })),
              };
      const names = retailerIds.map((id) => found.names.get(id) ?? id);
      return {
        // Stored as the inbox stores the products it sends, so the thread shows them alike.
        content: {
          products: {
            kind: resolved.kind,
            names,
            ...(resolved.kind === 'product_list' ? { header: resolved.header } : {}),
            body: resolved.body,
            footer,
          },
        },
        preview:
          resolved.kind === 'catalog'
            ? '[Catalog]'
            : resolved.kind === 'product'
              ? `[Product] ${names[0] ?? ''}`
              : `[Products] ${names.length}`,
        request: { type: 'interactive', interactive: productInteractive(resolved) },
      };
    },
  });
}

/**
 * POST /api/v1/messages: a template (the default), or a reply inside the service window as text,
 * reply buttons, a list, products (ADR-086) or a reaction, by the body's `type`.
 */
export async function apiSendMessage(
  deps: OutboundDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  const type =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as { type?: unknown }).type
      : undefined;
  if (type === 'text') return apiSendText(deps, ctx, input, idempotency);
  if (type === 'buttons') return apiSendButtons(deps, ctx, input, idempotency);
  if (type === 'list') return apiSendList(deps, ctx, input, idempotency);
  if (type === 'reaction') return apiSendReaction(deps, ctx, input, idempotency);
  if (type === 'product' || type === 'product_list' || type === 'catalog') {
    return apiSendProducts(deps, ctx, input, idempotency);
  }
  if (type === undefined || type === 'template') {
    return apiSendTemplate(deps, ctx, input, idempotency);
  }
  throw new AppError(
    'validation_failed',
    'Send a template, a text, buttons, a list, products or a reaction.',
    {
      issues: [
        {
          path: 'type',
          message: 'Use template, text, buttons, list, product, product_list, catalog or reaction.',
        },
      ],
    },
  );
}

/** The status of a message the API sent (any key of the company). */
export async function apiGetMessage(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  messageId: string,
): Promise<ApiMessage> {
  assertAnyScope(ctx, API_SEND_SCOPES);
  if (!z.uuid().safeParse(messageId).success) throw notFound('Message');
  const row = await deps.db.run(
    ctx.scope,
    async (tx) => {
      const [m] = await tx
        .select({
          id: messages.id,
          type: messages.type,
          status: messages.status,
          statusAt: messages.statusAt,
          content: messages.content,
          templateId: messages.templateId,
          channelId: messages.channelAccountId,
          errorCode: messages.errorCode,
          errorTitle: messages.errorTitle,
          createdAt: messages.createdAt,
          contactId: conversations.contactId,
          phone: contacts.phoneE164,
          replyTo: answeredMessages.id,
        })
        .from(messages)
        .innerJoin(
          conversations,
          and(
            eq(conversations.tenantId, messages.tenantId),
            eq(conversations.id, messages.conversationId),
          ),
        )
        .innerJoin(
          contacts,
          and(
            eq(contacts.tenantId, conversations.tenantId),
            eq(contacts.id, conversations.contactId),
          ),
        )
        .leftJoin(answeredMessages, answeredJoin())
        .where(
          and(
            eq(messages.tenantId, ctx.tenant.id),
            eq(messages.id, messageId),
            eq(messages.senderType, 'api'),
            isNotNull(messages.apiKeyId),
          ),
        );
      return m ?? null;
    },
    { accessMode: 'read only' },
  );
  if (!row) throw notFound('Message');
  const template = (row.content as { template?: { name?: string } }).template;
  return {
    id: row.id,
    type:
      row.type === 'text' || row.type === 'interactive' || row.type === 'reaction'
        ? row.type
        : 'template',
    status: row.status,
    statusAt: row.statusAt.toISOString(),
    to: row.phone,
    templateId: row.templateId,
    templateName: template?.name ?? null,
    channelId: row.channelId,
    contactId: row.contactId,
    replyTo: row.replyTo,
    error: row.errorCode || row.errorTitle ? { code: row.errorCode, title: row.errorTitle } : null,
    createdAt: row.createdAt.toISOString(),
  };
}
