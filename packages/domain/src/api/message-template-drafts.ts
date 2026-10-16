import { z } from 'zod';
import { AppError, notFound } from '@w360/core';
import { and, channelAccounts, eq, messageTemplates } from '@w360/db';
import { recordSystemAudit } from '../audit';
import { canonicalJson } from '../automations/graph';
import type { OutboundDeps } from '../messaging/outbound';
import { templateDefinitionSchema, toMetaComponents } from '../templates/definition';
import {
  assertValidDefinition,
  isEditableDraft,
  templateDeletion,
  templateLanguageSchema,
  templateNameError,
  templateNameSchema,
  writeCreateTemplateDraft,
  writeDeleteLocalTemplate,
  assertTemplateAccountOpen,
  writeDeleteTemplateAtMeta,
  writeSubmitTemplate,
  writeUpdateTemplateDraft,
} from '../templates/service';
import { parseInput } from '../validation';
import { apiActor, assertScope, type ApiContext } from './context';
import {
  claimIdempotencyKey,
  storeIdempotentResponse,
  type ApiResponse,
  type IdempotencyInput,
} from './idempotency';
import { readApiMessageTemplate, type ApiMessageTemplateDetail } from './message-templates';

/**
 * Template drafts through the public API (ADR-295): keys with `templates.write` add drafts, change
 * their content and delete drafts Meta never received, through the writes the Templates page uses,
 * recorded as the key's. With `templates.submit`, keys also submit drafts to Meta and delete
 * templates Meta has (ADR-296), through the Templates page's writes too.
 */

/** What `POST /message-templates` takes: a draft as the template editor saves one. */
export const apiCreateMessageTemplateSchema = z
  .object({
    channelId: z
      .uuid()
      .describe('One of the company’s numbers: the draft is its WhatsApp Business account’s.'),
    name: templateNameSchema,
    language: templateLanguageSchema,
    definition: templateDefinitionSchema,
  })
  .strict();

/** What `PATCH /message-templates/{id}` takes: the draft's whole content. */
export const apiUpdateMessageTemplateSchema = z
  .object({
    definition: templateDefinitionSchema,
    expectedVersion: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('The `version` read; another answers 409 instead of changing it.'),
  })
  .strict();

const isUuid = (id: string) => z.uuid().safeParse(id).success;

async function readDetail(
  tx: Parameters<typeof readApiMessageTemplate>[0],
  tenantId: string,
  id: string,
) {
  const detail = await readApiMessageTemplate(tx, tenantId, id);
  if (!detail) throw notFound('Template');
  return detail;
}

/**
 * Adds a draft for the WhatsApp Business account of one of the company's numbers, as members do on
 * the Templates page (409 for a name and language the account has), and answers it. Once per
 * `Idempotency-Key` when one is given.
 */
export async function apiCreateMessageTemplate(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput | null,
): Promise<ApiResponse> {
  assertScope(ctx, 'templates.write');
  const data = parseInput(apiCreateMessageTemplateSchema, input);
  assertValidDefinition(data.definition);
  const now = deps.clock.now();
  try {
    return await deps.db.run(ctx.scope, async (tx) => {
      // Claimed in the draft's transaction, so a refused draft leaves the key unused.
      let claimed: string | null = null;
      if (idempotency) {
        const claim = await claimIdempotencyKey(tx, ctx, idempotency, now);
        if ('replay' in claim) return claim.replay;
        claimed = claim.claimed;
      }
      const [channel] = await tx
        .select({ whatsappAccountId: channelAccounts.whatsappAccountId })
        .from(channelAccounts)
        .where(
          and(eq(channelAccounts.tenantId, ctx.tenant.id), eq(channelAccounts.id, data.channelId)),
        );
      if (!channel) throw notFound('WhatsApp number');
      const id = await writeCreateTemplateDraft(
        tx,
        ctx.tenant.id,
        {
          whatsappAccountId: channel.whatsappAccountId,
          name: data.name,
          language: data.language,
          definition: data.definition,
        },
        { apiKeyId: ctx.key.id },
      );
      await recordSystemAudit(
        tx,
        ctx.tenant.id,
        {
          action: 'template.draft_saved',
          subjectType: 'template',
          subjectId: id,
          correlationId: ctx.requestId,
          metadata: { name: data.name, language: data.language, source: 'api' },
        },
        apiActor(ctx),
      );
      const response = { status: 201, body: { data: await readDetail(tx, ctx.tenant.id, id) } };
      if (claimed) await storeIdempotentResponse(tx, ctx, claimed, response);
      return { ...response, replayed: false };
    });
  } catch (error) {
    throw templateNameError(error);
  }
}

/**
 * Sets a draft's content, as members save it on the Templates page: only a draft Meta never
 * received (412 otherwise), from `expectedVersion` when given (409 otherwise). Content the draft
 * already has answers it as it is, with no audit entry, so a retry needs no key.
 */
export async function apiUpdateMessageTemplate(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  id: string,
  input: unknown,
): Promise<ApiMessageTemplateDetail> {
  assertScope(ctx, 'templates.write');
  if (!isUuid(id)) throw notFound('Template');
  const data = parseInput(apiUpdateMessageTemplateSchema, input);
  assertValidDefinition(data.definition);
  return deps.db.run(ctx.scope, async (tx) => {
    const [row] = await tx
      .select({
        status: messageTemplates.status,
        providerTemplateId: messageTemplates.providerTemplateId,
        version: messageTemplates.version,
        category: messageTemplates.category,
        components: messageTemplates.components,
        name: messageTemplates.name,
        language: messageTemplates.language,
      })
      .from(messageTemplates)
      .where(and(eq(messageTemplates.tenantId, ctx.tenant.id), eq(messageTemplates.id, id)))
      .for('update');
    if (!row) throw notFound('Template');
    if (!isEditableDraft(row)) {
      throw new AppError(
        'precondition_failed',
        'Only drafts that Meta has not received can be changed.',
      );
    }
    if (data.expectedVersion !== undefined && data.expectedVersion !== row.version) {
      throw new AppError(
        'conflict',
        'This template has changed since that version. Read it again.',
      );
    }
    const unchanged =
      row.status === 'draft' &&
      row.category === data.definition.category &&
      canonicalJson(row.components) === canonicalJson(toMetaComponents(data.definition));
    if (!unchanged) {
      await writeUpdateTemplateDraft(tx, ctx.tenant.id, id, data.definition);
      await recordSystemAudit(
        tx,
        ctx.tenant.id,
        {
          action: 'template.draft_saved',
          subjectType: 'template',
          subjectId: id,
          correlationId: ctx.requestId,
          metadata: { name: row.name, language: row.language, source: 'api' },
        },
        apiActor(ctx),
      );
    }
    return readDetail(tx, ctx.tenant.id, id);
  });
}

/**
 * Submits a draft to Meta for review, as members do on the Templates page (ADR-296): only a draft
 * Meta never received (412 otherwise, as for one submitted already), for a connected account (412).
 * It is `submitting` until the queued request has Meta's answer. Answers it; once per
 * `Idempotency-Key` when one is given.
 */
export async function apiSubmitMessageTemplate(
  deps: Pick<OutboundDeps, 'db' | 'jobs' | 'signer' | 'clock'>,
  ctx: ApiContext,
  id: string,
  idempotency: IdempotencyInput | null,
): Promise<ApiResponse> {
  assertScope(ctx, 'templates.submit');
  if (!isUuid(id)) throw notFound('Template');
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, async (tx) => {
    // Claimed in the submission's transaction, so a refused one leaves the key unused.
    let claimed: string | null = null;
    if (idempotency) {
      const claim = await claimIdempotencyKey(tx, ctx, idempotency, now);
      if ('replay' in claim) return claim.replay;
      claimed = claim.claimed;
    }
    const [row] = await tx
      .select({
        id: messageTemplates.id,
        status: messageTemplates.status,
        providerTemplateId: messageTemplates.providerTemplateId,
        category: messageTemplates.category,
        components: messageTemplates.components,
        whatsappAccountId: messageTemplates.whatsappAccountId,
        name: messageTemplates.name,
        language: messageTemplates.language,
      })
      .from(messageTemplates)
      .where(and(eq(messageTemplates.tenantId, ctx.tenant.id), eq(messageTemplates.id, id)))
      .for('update');
    if (!row) throw notFound('Template');
    await writeSubmitTemplate(tx, deps, ctx.tenant.id, row, null, now);
    await recordSystemAudit(
      tx,
      ctx.tenant.id,
      {
        action: 'template.submitted',
        subjectType: 'template',
        subjectId: id,
        correlationId: ctx.requestId,
        metadata: {
          name: row.name,
          language: row.language,
          category: row.category,
          source: 'api',
        },
      },
      apiActor(ctx),
    );
    const response = { status: 200, body: { data: await readDetail(tx, ctx.tenant.id, id) } };
    if (claimed) await storeIdempotentResponse(tx, ctx, claimed, response);
    return { ...response, replayed: false };
  });
}

/**
 * Deletes a template as members do on the Templates page: a draft Meta never received at once, and
 * one Meta has, with `templates.submit` too (ADR-296), through a request to Meta it waits for as
 * `pending_deletion`. One being submitted answers 412; one already deleted, or being deleted, 409.
 */
export async function apiDeleteMessageTemplate(
  deps: Pick<OutboundDeps, 'db' | 'jobs' | 'signer' | 'clock'>,
  ctx: ApiContext,
  id: string,
): Promise<{ id: string; deleted: boolean; status: 'deleted' | 'pending_deletion' }> {
  assertScope(ctx, 'templates.write');
  if (!isUuid(id)) throw notFound('Template');
  return deps.db.run(ctx.scope, async (tx) => {
    const [row] = await tx
      .select({
        status: messageTemplates.status,
        providerTemplateId: messageTemplates.providerTemplateId,
        name: messageTemplates.name,
        language: messageTemplates.language,
        whatsappAccountId: messageTemplates.whatsappAccountId,
      })
      .from(messageTemplates)
      .where(and(eq(messageTemplates.tenantId, ctx.tenant.id), eq(messageTemplates.id, id)))
      .for('update');
    if (!row) throw notFound('Template');
    const now = deps.clock.now();
    const atMeta = templateDeletion(row) === 'meta';
    if (atMeta) {
      assertScope(ctx, 'templates.submit');
      // Meta throttles the account's management calls: 503 rather than a queued deletion (ADR-399).
      await assertTemplateAccountOpen(tx, ctx.tenant.id, row.whatsappAccountId, now);
      await writeDeleteTemplateAtMeta(tx, deps, ctx.tenant.id, id, null, now);
    } else {
      await writeDeleteLocalTemplate(tx, ctx.tenant.id, id, null, now);
    }
    await recordSystemAudit(
      tx,
      ctx.tenant.id,
      {
        action: 'template.deleted',
        subjectType: 'template',
        subjectId: id,
        correlationId: ctx.requestId,
        metadata: { name: row.name, language: row.language, source: 'api' },
      },
      apiActor(ctx),
    );
    return atMeta
      ? { id, deleted: false, status: 'pending_deletion' }
      : { id, deleted: true, status: 'deleted' };
  });
}
