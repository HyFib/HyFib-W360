import { z } from 'zod';
import { AppError, notFound, uuidv7 } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  asc,
  channelAccounts,
  contactIdentities,
  contactTags,
  contacts,
  conversations,
  desc,
  eq,
  exactTimestamp,
  inArray,
  isNotNull,
  isNull,
  messageTemplates,
  messages,
  outerColumn,
  sendIntents,
  sql,
  suppressions,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { endRunForHuman } from '../automations/runs';
import { lockCampaignSends, marketingCapReached } from '../campaigns/frequency-cap';
import { checkTemplateEligibility, recordConsentEvents } from '../consent/service';
import { normalizeEmail, normalizeTag } from '../contacts/fields';
import { normalizePhone, phoneFromWaId, waRecipientFromPhone } from '../contacts/phone';
import { contactForPhone } from '../contacts/service';
import { emitTenantEvent } from '../messaging/events';
import { SERVICE_WINDOW_MS, type OutboundDeps } from '../messaging/outbound';
import { STATUS_RANK } from '../messaging/status';
import {
  buildTemplateSend,
  fromMetaComponents,
  sendSpecFor,
  TEMPLATE_LIMITS,
} from '../templates/definition';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { apiActor, assertScope, type ApiContext } from './context';
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

const phoneField = z
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
  })
  .strict();

export const apiContactListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
    phone: z.string().max(40).optional().describe('Only the contact with this number.'),
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

export const apiSendMessageSchema = z
  .object({
    type: z.literal('template').optional().describe('`template`, the default.'),
    to: phoneField,
    templateId: z.uuid().describe('A template id from GET /api/v1/templates.'),
    from: z
      .uuid()
      .optional()
      .describe(
        'The id of the WhatsApp number to send from; optional when the company has one active number.',
      ),
    variables: z
      .object({
        header: z.array(variableValue).max(1).default([]),
        body: z.array(variableValue).max(TEMPLATE_LIMITS.bodyVariables).default([]),
      })
      .strict()
      .default({ header: [], body: [] })
      .describe('Values for the template’s {{1}}, {{2}}… in order.'),
  })
  .strict();

/** A free-form text reply to a contact who wrote in the last 24 hours (ADR-070). */
export const apiSendTextSchema = z
  .object({
    type: z.literal('text'),
    to: phoneField,
    from: z
      .uuid()
      .optional()
      .describe(
        'The id of the WhatsApp number the contact wrote to; optional when the company has one active number.',
      ),
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

export interface ApiContact {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  tags: string[];
  consent: { marketing: 'opted_in' | 'opted_out' | null; utility: 'opted_in' | 'opted_out' | null };
  source: string;
  createdAt: string;
}

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
  type: 'template' | 'text';
  status: string;
  statusAt: string;
  to: string | null;
  templateId: string | null;
  templateName: string | null;
  channelId: string;
  contactId: string;
  error: { code: string | null; title: string | null } | null;
  createdAt: string;
}

// Outer columns named in full: these selects have no joins, so drizzle would leave the table out
// and `id` would bind to the subquery's own table.
const consentState = (purpose: 'marketing' | 'utility') =>
  sql<'opted_in' | 'opted_out' | null>`(select cc.status from app.contact_consents cc
    where cc.tenant_id = ${outerColumn(contacts.tenantId)} and cc.contact_id = ${outerColumn(contacts.id)}
      and cc.purpose = ${purpose})`;

const contactColumns = {
  id: contacts.id,
  name: contacts.displayName,
  phone: contacts.phoneE164,
  email: contacts.email,
  source: contacts.source,
  createdAt: contacts.createdAt,
  erasedAt: contacts.erasedAt,
  tags: sql<string[]>`coalesce((select array_agg(t.tag order by t.tag) from app.contact_tags t
    where t.tenant_id = ${outerColumn(contacts.tenantId)} and t.contact_id = ${outerColumn(contacts.id)}), '{}')`,
  marketing: consentState('marketing'),
  utility: consentState('utility'),
};

type ContactRow = {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  source: string;
  createdAt: Date;
  tags: string[];
  marketing: 'opted_in' | 'opted_out' | null;
  utility: 'opted_in' | 'opted_out' | null;
};

const toApiContact = (r: ContactRow): ApiContact => ({
  id: r.id,
  name: r.name,
  phone: r.phone,
  email: r.email,
  tags: r.tags,
  consent: { marketing: r.marketing, utility: r.utility },
  source: r.source,
  createdAt: r.createdAt.toISOString(),
});

async function contactById(tx: Tx, tenantId: string, id: string): Promise<ContactRow | null> {
  const [row] = await tx
    .select(contactColumns)
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, id), isNull(contacts.erasedAt)));
  return row ?? null;
}

const explicitPhone = (raw: string) => {
  const phone = normalizePhone(raw, { kind: 'explicit' });
  if (!phone.ok)
    throw new AppError('validation_failed', phone.message, {
      issues: [{ path: 'phone', message: phone.message }],
    });
  return phone.e164;
};

/** Runs work once per idempotency key (when given) in one transaction with it. */
async function idempotent(
  tx: Tx,
  ctx: ApiContext,
  idempotency: IdempotencyInput | null,
  now: Date,
  work: () => Promise<{ status: number; body: Record<string, unknown> }>,
): Promise<ApiResponse> {
  let claimed: string | null = null;
  if (idempotency) {
    const claim = await claimIdempotencyKey(tx, ctx, idempotency, now);
    if ('replay' in claim) return claim.replay;
    claimed = claim.claimed;
  }
  const result = await work();
  if (claimed) await storeIdempotentResponse(tx, ctx, claimed, result);
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

export async function apiListContacts(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiContact[]; nextCursor: string | null }> {
  assertScope(ctx, 'contacts.read');
  const q = parseInput(apiContactListQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  const phone = q.phone ? explicitPhone(q.phone) : null;
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const rows = await tx
        .select({ ...contactColumns, cursorAt: exactTimestamp(contacts.createdAt) })
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, ctx.tenant.id),
            isNull(contacts.erasedAt),
            phone ? eq(contacts.phoneE164, phone) : undefined,
            cursor
              ? sql`(${contacts.createdAt}, ${contacts.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(contacts.createdAt), desc(contacts.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        data: page.map(toApiContact),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
}

export async function apiGetContact(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  contactId: string,
): Promise<ApiContact> {
  assertScope(ctx, 'contacts.read');
  if (!z.uuid().safeParse(contactId).success) throw notFound('Contact');
  const row = await deps.db.run(ctx.scope, (tx) => contactById(tx, ctx.tenant.id, contactId), {
    accessMode: 'read only',
  });
  if (!row) throw notFound('Contact');
  return toApiContact(row);
}

/**
 * Creates a contact, or answers with the existing one for the number (200 instead of 201); a
 * name, email or tags given for an existing contact fill only what is empty (tags are added).
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
  const tags: string[] = [];
  for (const raw of data.tags ?? []) {
    const tag = normalizeTag(raw);
    if (!tag.ok) throw new AppError('validation_failed', tag.message);
    if (!tags.includes(tag.tag)) tags.push(tag.tag);
  }
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, (tx) =>
    idempotent(tx, ctx, idempotency, now, async () => {
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
          })
          .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, id)));
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
      const row = await contactById(tx, ctx.tenant.id, id);
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
    const row = await contactById(tx, ctx.tenant.id, contactId);
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
  // The template decides which of the two scopes is needed; a key with neither is refused first.
  if (!ctx.key.scopes.has('messages.send') && !ctx.key.scopes.has('messages.send_marketing'))
    assertScope(ctx, 'messages.send');
  const data = parseInput(apiSendMessageSchema, input);
  const phone = explicitPhone(data.to);
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, (tx) =>
    idempotent(tx, ctx, idempotency, now, async () => {
      const [template] = await tx
        .select()
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.tenantId, ctx.tenant.id),
            eq(messageTemplates.id, data.templateId),
          ),
        );
      if (!template) throw notFound('Template');
      assertScope(
        ctx,
        template.category === 'MARKETING' ? 'messages.send_marketing' : 'messages.send',
      );
      if (template.status !== 'approved') {
        throw new AppError('precondition_failed', 'Only templates approved by Meta can be sent.');
      }
      const spec = sendSpecFor(template.category, template.components);
      if (!spec.supported) throw new AppError('unsupported', spec.reason);
      if (
        data.variables.header.length !== spec.headerParams ||
        data.variables.body.length !== spec.bodyParams
      ) {
        throw new AppError(
          'validation_failed',
          `This template needs ${spec.headerParams} header and ${spec.bodyParams} body variables.`,
        );
      }

      const channel = await sendingNumber(tx, ctx, data.from);
      if (channel.whatsappAccountId !== template.whatsappAccountId) {
        throw new AppError(
          'validation_failed',
          'This template belongs to another WhatsApp account than the number it would be sent from.',
        );
      }
      if (channel.status !== 'active') {
        throw new AppError('precondition_failed', 'This WhatsApp number is not active.');
      }

      // Erasure, suppression and consent; a refusal rolls back the contact created for the number.
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
      if (template.category === 'MARKETING') {
        // Counted under the campaign runner's company lock, before any conversation is locked.
        await lockCampaignSends(tx, ctx.tenant.id, 'wait');
        if (await marketingCapReached(tx, ctx.tenant.id, contactId, now)) {
          throw new AppError(
            'precondition_failed',
            'The contact already received as many marketing messages as the company allows in the period.',
          );
        }
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
      const built = buildTemplateSend(template, spec, data.variables);

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
          lastMessagePreview: built.rendered.body.slice(0, 200),
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
            type: 'template',
            status: 'queued',
            contactId,
            channelId: channel.id,
            templateId: template.id,
          },
        },
      };
    }),
  );
}

/** The refusal for a number the reply cannot reach (ADR-070). */
const windowClosed = () =>
  new AppError(
    'precondition_failed',
    'This number has not written to this WhatsApp number in the last 24 hours, so only approved templates can be sent to it.',
    { details: { apiReason: 'window_closed' } },
  );

/**
 * Sends a free-form text message to a contact who wrote to the number in the last 24 hours, as the
 * inbox's reply does (ADR-070). The contact is never created: a number that is not a contact, has
 * no conversation on the number, was erased, or last wrote more than 24 hours ago gets one answer,
 * so the refusal tells a key without `contacts.read` nothing more than a sent reply would. The
 * reply takes the conversation over from an automation handling it (its queued messages are
 * cancelled), but it is not a member's reply: the conversation keeps waiting for a member. Exactly
 * one send per idempotency key; the window is checked again when the worker sends.
 */
export async function apiSendText(
  deps: OutboundDeps,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput,
): Promise<ApiResponse> {
  assertScope(ctx, 'messages.reply');
  const data = parseInput(apiSendTextSchema, input);
  const phone = explicitPhone(data.to);
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, (tx) =>
    idempotent(tx, ctx, idempotency, now, async () => {
      const channel = await sendingNumber(tx, ctx, data.from);
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

      await endRunForHuman(tx, {
        tenantId: ctx.tenant.id,
        conversationId: conversation.id,
        reason: 'api_replied',
        actorMembershipId: null,
        now,
      });
      const messageId = uuidv7();
      const intentId = uuidv7();
      await tx.insert(messages).values({
        id: messageId,
        tenantId: ctx.tenant.id,
        conversationId: conversation.id,
        channelAccountId: channel.id,
        direction: 'outbound',
        type: 'text',
        content: { text: data.text },
        status: 'queued',
        statusRank: STATUS_RANK.queued,
        senderType: 'api',
        apiKeyId: ctx.key.id,
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
          type: 'text',
          text: { body: data.text, preview_url: data.previewUrl },
        },
        actorUserId: null,
      });
      await tx
        .update(conversations)
        .set({
          lastMessageAt: now,
          lastMessagePreview: data.text.slice(0, 200),
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
            type: 'text',
            status: 'queued',
            contactId: contact.id,
            channelId: channel.id,
          },
        },
      };
    }),
  );
}

/** POST /api/v1/messages: a template (the default) or a text reply, by the body's `type`. */
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
  if (type === undefined || type === 'template') {
    return apiSendTemplate(deps, ctx, input, idempotency);
  }
  throw new AppError('validation_failed', 'Send a template or a text message.', {
    issues: [{ path: 'type', message: 'Use template or text.' }],
  });
}

/** The status of a message the API sent (any key of the company). */
export async function apiGetMessage(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  messageId: string,
): Promise<ApiMessage> {
  if (!API_SEND_SCOPES.some((scope) => ctx.key.scopes.has(scope)))
    assertScope(ctx, 'messages.send');
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
    type: row.type === 'text' ? 'text' : 'template',
    status: row.status,
    statusAt: row.statusAt.toISOString(),
    to: row.phone,
    templateId: row.templateId,
    templateName: template?.name ?? null,
    channelId: row.channelId,
    contactId: row.contactId,
    error: row.errorCode || row.errorTitle ? { code: row.errorCode, title: row.errorTitle } : null,
    createdAt: row.createdAt.toISOString(),
  };
}
