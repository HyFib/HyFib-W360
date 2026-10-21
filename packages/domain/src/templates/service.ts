import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock, type Keyring } from '@w360/core';
import {
  and,
  asc,
  channelAccounts,
  desc,
  eq,
  inArray,
  messageTemplates,
  sql,
  systemScope,
  templateStatusEvents,
  users,
  whatsappAccounts,
  type Database,
  type TemplateStatus,
  type TenantScope,
  type Tx,
  isUniqueViolation,
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { recordAudit, recordSystemAudit, type RequestMeta } from '../audit';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import type { GraphClient, RemoteTemplate } from '../messaging/graph';
import { requestAccessCheck } from '../messaging/access';
import {
  activeManagementPause,
  assertManagementOpen,
  managementResumeAt,
  noteManagementUsage,
  refusedForPause,
  type ManagementPaused,
} from '../messaging/management-pace';
import { parseInput } from '../validation';
import {
  TEMPLATE_LANGUAGE_RE,
  TEMPLATE_NAME_RE,
  fromMetaComponents,
  renderExample,
  sendSpecFor,
  templateDefinitionSchema,
  toMetaComponents,
  validateDefinition,
  type TemplateDefinition,
} from './definition';
import { databaseNow, reconcileTemplateEdit, templateUsage, writeEditTemplate } from './edit';
import { templateEditBlocker } from './edit-model';
import {
  enqueueTemplateJob,
  insertStatusEvent,
  mapProviderTemplateStatus,
  requestSyncTx,
  templateAccount,
  wabaCredential,
} from './shared';

export { PROVIDER_TEMPLATE_STATUS, mapProviderTemplateStatus, wabaCredential } from './shared';

/**
 * WhatsApp message templates. Local states (`draft`, `submitting`, `submit_failed`) exist before
 * Meta has the template; afterwards Meta's review state is mirrored and the Graph API listing is
 * authoritative (webhooks only request a re-sync).
 *
 * Submission is write-ahead: the template is marked `submitting` before the create request is
 * sent. If the response is lost, the next sync finds the template by name and language and adopts
 * it; if Meta has no such template ten minutes later, the submission is marked failed so the
 * member can submit again. Nothing is resubmitted automatically.
 */
const SUBMIT_CONFIRM_WINDOW_MS = 10 * 60_000;
/**
 * How long the sync leaves a template pending deletion while Meta still lists it (ADR-111): the
 * deletion job's retries take 4 to 5 hours, and a job that runs out of them has its deletion
 * settled by the sweep. A template whose deletion Meta refused (`delete_failed`) is not kept.
 */
const DELETION_KEEP_MS = 8 * 60 * 60_000;
const SYNC_MAX_PAGES = 50;
/** Extra fields beyond Meta's defaults (confirmed by a third-party library only, see M-085). */
const SYNC_FIELDS = 'id,name,language,status,category,components,rejected_reason,quality_score';
const DEFAULT_FIELDS_FALLBACK = 'id,name,language,status,category,components';

const LOCAL_STATES: readonly TemplateStatus[] = ['draft', 'submitting', 'submit_failed'];
const EDITABLE_STATES: readonly TemplateStatus[] = ['draft', 'submit_failed'];

/** A template's name and language, as the Templates page and the API take them (ADR-295). */
export const templateNameSchema = z
  .string()
  .trim()
  .regex(TEMPLATE_NAME_RE, 'Use lower-case letters, digits and underscores for the name');
export const templateLanguageSchema = z
  .string()
  .trim()
  .regex(TEMPLATE_LANGUAGE_RE, 'Enter a language code such as en or en_US');

export const draftInputSchema = z.object({
  whatsappAccountId: z.uuid(),
  name: templateNameSchema,
  language: templateLanguageSchema,
  definition: templateDefinitionSchema,
});

/** What an edit of a template Meta has takes (ADR-404): its whole new content. */
export const editTemplateSchema = z.object({
  definition: templateDefinitionSchema,
});

export const updateDraftSchema = z.object({
  expectedVersion: z.number().int().min(0),
  definition: templateDefinitionSchema,
});

export interface TemplateDeps {
  db: Database;
  jobs: JobQueue;
  signer: JobSigner;
  clock: Clock;
}

/** Refuses a definition with variables, examples or buttons Meta would not take (422). */
export function assertValidDefinition(def: TemplateDefinition) {
  const issues = validateDefinition(def);
  if (issues.length > 0) {
    throw new AppError('validation_failed', issues[0]?.message ?? 'Invalid template', { issues });
  }
}

/**
 * The template.sync queue's priorities (pg-boss fetches higher first): a refresh a member asked for
 * goes before the sweep's routine syncs, which keep the default (ADR-178).
 */
export const TEMPLATE_SYNC_PRIORITY = { requested: 10, routine: 0 } as const;

/** Who adds a draft: a member, or a key through the API (ADR-295). */
export type TemplateAuthor = { userId: string } | { apiKeyId: string };

/**
 * Adds a draft for the WhatsApp Business account, as the Templates page and the API do (ADR-295):
 * a deleted draft Meta never received under the same name and language becomes a draft again, by
 * its new author; any other template of that name and language answers 409. The caller checks the
 * account is the company's and the definition is valid, and maps a name taken at the same moment
 * with `templateNameError`.
 */
export async function writeCreateTemplateDraft(
  tx: Tx,
  tenantId: string,
  data: {
    whatsappAccountId: string;
    name: string;
    language: string;
    definition: TemplateDefinition;
  },
  author: TemplateAuthor,
): Promise<string> {
  const components = toMetaComponents(data.definition);
  const creator = {
    createdByUserId: 'userId' in author ? author.userId : null,
    createdByApiKeyId: 'apiKeyId' in author ? author.apiKeyId : null,
  };
  const [existing] = await tx
    .select({
      id: messageTemplates.id,
      status: messageTemplates.status,
      providerTemplateId: messageTemplates.providerTemplateId,
    })
    .from(messageTemplates)
    .where(
      and(
        eq(messageTemplates.tenantId, tenantId),
        eq(messageTemplates.whatsappAccountId, data.whatsappAccountId),
        eq(messageTemplates.name, data.name),
        eq(messageTemplates.language, data.language),
      ),
    )
    .for('update');
  if (existing) {
    // A deleted local draft (never known to Meta) may be reused; anything else is taken.
    if (existing.status !== 'deleted' || existing.providerTemplateId !== null) {
      throw new AppError('conflict', 'A template with this name and language already exists.');
    }
    await tx
      .update(messageTemplates)
      .set({
        components,
        category: data.definition.category,
        status: 'draft',
        submitError: null,
        ...creator,
        version: sql`${messageTemplates.version} + 1`,
      })
      .where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.id, existing.id)));
    return existing.id;
  }
  const id = uuidv7();
  await tx.insert(messageTemplates).values({
    id,
    tenantId,
    whatsappAccountId: data.whatsappAccountId,
    name: data.name,
    language: data.language,
    category: data.definition.category,
    components,
    status: 'draft',
    origin: 'local',
    ...creator,
  });
  return id;
}

/** A name and language the account's other template took at the same moment, as a conflict. */
export function templateNameError(error: unknown): unknown {
  return isUniqueViolation(error, 'message_templates_name_language_uq')
    ? new AppError('conflict', 'A template with this name and language already exists.')
    : error;
}

/** Whether a template is a draft that can still change: one Meta never received (ADR-295). */
export function isEditableDraft(row: {
  status: TemplateStatus;
  providerTemplateId: string | null;
}): boolean {
  return EDITABLE_STATES.includes(row.status) && row.providerTemplateId === null;
}

/**
 * Sets a locked draft's content, as the Templates page and the API save it (ADR-295): it becomes a
 * `draft` again and its version moves on. The caller checks it is an editable draft, its version
 * and the definition.
 */
export async function writeUpdateTemplateDraft(
  tx: Tx,
  tenantId: string,
  templateId: string,
  definition: TemplateDefinition,
): Promise<void> {
  await tx
    .update(messageTemplates)
    .set({
      components: toMetaComponents(definition),
      category: definition.category,
      status: 'draft',
      submitError: null,
      version: sql`${messageTemplates.version} + 1`,
    })
    .where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.id, templateId)));
}

/**
 * Deletes a locked template Meta never received, as the Templates page and the API do (ADR-295),
 * with its status change. The caller checks Meta never received it and it is not being submitted.
 */
export async function writeDeleteLocalTemplate(
  tx: Tx,
  tenantId: string,
  templateId: string,
  actorUserId: string | null,
  at: Date,
): Promise<void> {
  await tx
    .update(messageTemplates)
    .set({ status: 'deleted', version: sql`${messageTemplates.version} + 1` })
    .where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.id, templateId)));
  await insertStatusEvent(tx, tenantId, {
    templateId,
    status: 'deleted',
    source: 'delete',
    actorUserId,
    at,
  });
}

/**
 * Refuses a member's or key's management action on the account while Meta throttles its management
 * calls (ADR-399): a deletion at Meta is then not queued. `timeZone` as for `writeSubmitTemplate`.
 */
export async function assertTemplateAccountOpen(
  tx: Tx,
  tenantId: string,
  whatsappAccountId: string,
  at: Date,
  timeZone = 'UTC',
): Promise<void> {
  const waba = await templateAccount(tx, tenantId, whatsappAccountId);
  assertManagementOpen(waba.managementPausedUntil, at, timeZone);
}

/**
 * Submits a locked draft to Meta for review, as the Templates page and the API do (ADR-296): only a
 * draft Meta never received (412), whose content HyFib can send and Meta would take, for a
 * connected account (412). It is marked `submitting` before Meta hears of it (write-ahead), with
 * its status change, and the create request is queued. `actorUserId` is the member, null for a key.
 */
export async function writeSubmitTemplate(
  tx: Tx,
  deps: Pick<TemplateDeps, 'jobs' | 'signer'>,
  tenantId: string,
  row: Pick<
    typeof messageTemplates.$inferSelect,
    'id' | 'status' | 'providerTemplateId' | 'category' | 'components' | 'whatsappAccountId'
  >,
  actorUserId: string | null,
  at: Date,
  /** The company's time zone, for the time a pause ends (the API, which has none, gives UTC). */
  timeZone = 'UTC',
): Promise<void> {
  if (!isEditableDraft(row)) {
    throw new AppError('precondition_failed', 'This template has already been sent to Meta.');
  }
  const def = fromMetaComponents(row.category, row.components);
  if (!def) throw new AppError('unsupported', 'This template cannot be submitted from HyFib.');
  assertValidDefinition(def);
  const waba = await templateAccount(tx, tenantId, row.whatsappAccountId);
  if (waba.status !== 'connected') {
    throw new AppError(
      'precondition_failed',
      'Reconnect this WhatsApp account before submitting templates.',
    );
  }
  // Meta throttles the account's management calls: say so rather than queue a create (ADR-399).
  assertManagementOpen(waba.managementPausedUntil, at, timeZone);
  const [updated] = await tx
    .update(messageTemplates)
    .set({
      status: 'submitting',
      submittedAt: at,
      // A new request: an earlier deferral for a pause no longer applies (ADR-399).
      managementDeferredUntil: null,
      submitError: null,
      version: sql`${messageTemplates.version} + 1`,
    })
    .where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.id, row.id)))
    .returning({ version: messageTemplates.version });
  await insertStatusEvent(tx, tenantId, {
    templateId: row.id,
    status: 'submitting',
    source: 'submit',
    actorUserId,
    at,
  });
  await enqueueTemplateJob(
    tx,
    deps,
    'template.submit',
    tenantId,
    actorUserId,
    row.id,
    `${row.id}:${updated?.version ?? 0}`,
  );
}

/**
 * How a locked template is deleted, as the Templates page and the API delete it (ADR-296): `local`
 * for one Meta never received, `meta` for one Meta has, which also needs `templates.submit`. One
 * already deleted, or being deleted, answers 409; one being submitted, or whose edit is on its way
 * to Meta (ADR-404), 412.
 */
export function templateDeletion(row: {
  status: TemplateStatus;
  providerTemplateId: string | null;
  editState?: string | null;
}): 'local' | 'meta' {
  if (row.status === 'deleted' || row.status === 'pending_deletion') {
    throw new AppError('conflict', 'This template is already deleted.');
  }
  // Its edit could otherwise reach Meta after the deletion, or the deletion settle it (ADR-404).
  if (row.editState === 'sending') {
    throw new AppError(
      'precondition_failed',
      'Wait until Meta answers the edit of this template before deleting it.',
    );
  }
  if (row.status === 'submitting') {
    throw new AppError(
      'precondition_failed',
      'Wait until Meta confirms the submission before deleting.',
    );
  }
  return row.providerTemplateId === null ? 'local' : 'meta';
}

/**
 * Deletes a locked template Meta has, as the Templates page and the API do (ADR-296): it is
 * `pending_deletion`, with its status change, until the queued request to Meta settles it. The
 * caller checks it may be deleted (`templateDeletion`).
 */
export async function writeDeleteTemplateAtMeta(
  tx: Tx,
  deps: Pick<TemplateDeps, 'jobs' | 'signer'>,
  tenantId: string,
  templateId: string,
  actorUserId: string | null,
  at: Date,
): Promise<void> {
  await tx
    .update(messageTemplates)
    .set({
      status: 'pending_deletion',
      // A new request: an earlier deferral for a pause no longer applies (ADR-399).
      managementDeferredUntil: null,
      version: sql`${messageTemplates.version} + 1`,
    })
    .where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.id, templateId)));
  await insertStatusEvent(tx, tenantId, {
    templateId,
    status: 'pending_deletion',
    source: 'delete',
    actorUserId,
    at,
  });
  await enqueueTemplateJob(
    tx,
    deps,
    'template.delete',
    tenantId,
    actorUserId,
    templateId,
    `${templateId}:delete`,
  );
}

export function createTemplatesService(deps: TemplateDeps) {
  const { db, clock } = deps;

  async function loadForUpdate(tx: Tx, ctx: TenantContext, templateId: string) {
    if (!z.uuid().safeParse(templateId).success) throw notFound('Template');
    const [row] = await tx
      .select()
      .from(messageTemplates)
      .where(and(eq(messageTemplates.tenantId, ctx.tenant.id), eq(messageTemplates.id, templateId)))
      .for('update');
    if (!row) throw notFound('Template');
    return row;
  }

  const connectedWaba = (tx: Tx, ctx: TenantContext, whatsappAccountId: string) =>
    templateAccount(tx, ctx.tenant.id, whatsappAccountId);

  return {
    async listTemplates(
      ctx: TenantContext,
      input: { whatsappAccountId?: string; includeDeleted?: boolean } = {},
    ) {
      assertCan(ctx, 'templates.read');
      const wabaId =
        input.whatsappAccountId && z.uuid().safeParse(input.whatsappAccountId).success
          ? input.whatsappAccountId
          : null;
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: messageTemplates.id,
              whatsappAccountId: messageTemplates.whatsappAccountId,
              name: messageTemplates.name,
              language: messageTemplates.language,
              category: messageTemplates.category,
              status: messageTemplates.status,
              components: messageTemplates.components,
              rejectionReason: messageTemplates.rejectionReason,
              qualityScore: messageTemplates.qualityScore,
              submitError: messageTemplates.submitError,
              origin: messageTemplates.origin,
              updatedAt: messageTemplates.updatedAt,
            })
            .from(messageTemplates)
            .where(
              and(
                eq(messageTemplates.tenantId, ctx.tenant.id),
                wabaId ? eq(messageTemplates.whatsappAccountId, wabaId) : undefined,
                input.includeDeleted ? undefined : sql`${messageTemplates.status} <> 'deleted'`,
              ),
            )
            .orderBy(asc(messageTemplates.name), asc(messageTemplates.language))
            .limit(1000),
        { accessMode: 'read only' },
      );
      return rows.map((r) => {
        const spec = sendSpecFor(r.category, r.components);
        return {
          ...r,
          sendable: r.status === 'approved' && spec.supported,
          unsupportedReason: spec.supported ? null : spec.reason,
          preview: spec.supported ? renderExample(spec.definition) : null,
        };
      });
    },

    async getTemplate(ctx: TenantContext, templateId: string) {
      assertCan(ctx, 'templates.read');
      if (!z.uuid().safeParse(templateId).success) throw notFound('Template');
      return db.run(
        ctx.scope,
        async (tx) => {
          const [row] = await tx
            .select()
            .from(messageTemplates)
            .where(
              and(
                eq(messageTemplates.tenantId, ctx.tenant.id),
                eq(messageTemplates.id, templateId),
              ),
            );
          if (!row) throw notFound('Template');
          const history = await tx
            .select({
              id: templateStatusEvents.id,
              status: templateStatusEvents.status,
              reason: templateStatusEvents.reason,
              source: templateStatusEvents.source,
              actorName: users.name,
              occurredAt: templateStatusEvents.occurredAt,
            })
            .from(templateStatusEvents)
            .leftJoin(users, eq(users.id, templateStatusEvents.actorUserId))
            .where(
              and(
                eq(templateStatusEvents.tenantId, ctx.tenant.id),
                eq(templateStatusEvents.templateId, templateId),
              ),
            )
            .orderBy(desc(templateStatusEvents.occurredAt), desc(templateStatusEvents.id))
            .limit(50);
          const definition = fromMetaComponents(row.category, row.components);
          const spec = sendSpecFor(row.category, row.components);
          // The content an open edit sent (sending, or failed so it can be changed and sent again).
          const editDefinition =
            row.editState && row.editComponents
              ? fromMetaComponents(row.category, row.editComponents)
              : null;
          return {
            template: row,
            definition,
            editable: isEditableDraft(row),
            /**
             * Whether HyFib can send Meta an edit of it (ADR-404): Meta has it, it is not being
             * deleted, no edit is on its way and HyFib can represent its content. Meta decides the
             * rest (statuses, how often).
             */
            metaEditable: templateEditBlocker(row) === null,
            editDefinition,
            preview: definition ? renderExample(definition) : null,
            sendable: row.status === 'approved' && spec.supported,
            unsupportedReason: spec.supported ? null : spec.reason,
            history,
          };
        },
        { accessMode: 'read only' },
      );
    },

    async createDraft(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'templates.write');
      const data = parseInput(draftInputSchema, input);
      assertValidDefinition(data.definition);
      try {
        return await db.run(ctx.scope, async (tx) => {
          await connectedWaba(tx, ctx, data.whatsappAccountId);
          const id = await writeCreateTemplateDraft(tx, ctx.tenant.id, data, {
            userId: ctx.user.id,
          });
          await recordAudit(
            tx,
            ctx,
            {
              action: 'template.draft_saved',
              subjectType: 'template',
              subjectId: id,
              metadata: { name: data.name, language: data.language },
            },
            meta,
          );
          return { id };
        });
      } catch (error) {
        throw templateNameError(error);
      }
    },

    async updateDraft(ctx: TenantContext, templateId: string, input: unknown) {
      assertCan(ctx, 'templates.write');
      const data = parseInput(updateDraftSchema, input);
      assertValidDefinition(data.definition);
      await db.run(ctx.scope, async (tx) => {
        const row = await loadForUpdate(tx, ctx, templateId);
        if (!isEditableDraft(row)) {
          throw new AppError(
            'precondition_failed',
            'Only drafts that Meta has not received can be edited.',
          );
        }
        if (row.version !== data.expectedVersion) {
          throw new AppError(
            'conflict',
            'Someone else changed this template. Reload and try again.',
          );
        }
        await writeUpdateTemplateDraft(tx, ctx.tenant.id, templateId, data.definition);
      });
    },

    /**
     * Where a template is used (ADR-404): unfinished campaigns, published automations and store
     * rules that send it, shown before a member edits a template Meta has.
     */
    async templateUsage(ctx: TenantContext, templateId: string) {
      assertCan(ctx, 'templates.submit');
      if (!z.uuid().safeParse(templateId).success) throw notFound('Template');
      return db.run(
        ctx.scope,
        async (tx) => {
          const [row] = await tx
            .select({ id: messageTemplates.id })
            .from(messageTemplates)
            .where(
              and(
                eq(messageTemplates.tenantId, ctx.tenant.id),
                eq(messageTemplates.id, templateId),
              ),
            );
          if (!row) throw notFound('Template');
          const usage = await templateUsage(tx, ctx.tenant.id, templateId);
          // Every role that submits templates reads these (a unit test pins it); a company's own
          // permission choices could differ, so names are shown only to members who may read them.
          return {
            campaigns: usage.campaigns.map((c) => ({
              ...c,
              name: can(ctx, 'campaigns.read') ? c.name : null,
            })),
            automations: usage.automations.map((a) => ({
              ...a,
              name: can(ctx, 'automations.read') ? a.name : null,
            })),
            storeRules: usage.storeRules.map((r) => ({
              ...r,
              storeName: can(ctx, 'commerce.read') ? r.storeName : null,
            })),
          };
        },
        { accessMode: 'read only' },
      );
    },

    /**
     * Sends Meta an edit of a template it has (ADR-404), written ahead: the edit is `sending`, with
     * its status change, and the `template.edit` job queued. Name, language and category stay.
     */
    async editTemplate(
      ctx: TenantContext,
      templateId: string,
      input: unknown,
      meta: RequestMeta = {},
    ) {
      assertCan(ctx, 'templates.submit');
      const data = parseInput(editTemplateSchema, input);
      await db.run(ctx.scope, async (tx) => {
        const row = await loadForUpdate(tx, ctx, templateId);
        await writeEditTemplate(
          tx,
          deps,
          ctx.tenant.id,
          row,
          data.definition,
          ctx.user.id,
          clock.now(),
          ctx.tenant.timezone,
        );
        await recordAudit(
          tx,
          ctx,
          {
            action: 'template.edit_requested',
            subjectType: 'template',
            subjectId: templateId,
            metadata: { name: row.name, language: row.language, category: row.category },
          },
          meta,
        );
      });
    },

    /** Marks the template `submitting` and queues the create request (write-ahead). */
    async submitTemplate(ctx: TenantContext, templateId: string, meta: RequestMeta = {}) {
      assertCan(ctx, 'templates.submit');
      await db.run(ctx.scope, async (tx) => {
        const row = await loadForUpdate(tx, ctx, templateId);
        await writeSubmitTemplate(
          tx,
          deps,
          ctx.tenant.id,
          row,
          ctx.user.id,
          clock.now(),
          ctx.tenant.timezone,
        );
        await recordAudit(
          tx,
          ctx,
          {
            action: 'template.submitted',
            subjectType: 'template',
            subjectId: templateId,
            metadata: { name: row.name, language: row.language, category: row.category },
          },
          meta,
        );
      });
    },

    /**
     * Deletes a template. A draft Meta never received is marked deleted locally; a template Meta
     * has is marked `pending_deletion` and removed through the Graph API by the worker.
     */
    async deleteTemplate(ctx: TenantContext, templateId: string, meta: RequestMeta = {}) {
      assertCan(ctx, 'templates.write');
      await db.run(ctx.scope, async (tx) => {
        const row = await loadForUpdate(tx, ctx, templateId);
        const now = clock.now();
        if (templateDeletion(row) === 'local') {
          await writeDeleteLocalTemplate(tx, ctx.tenant.id, templateId, ctx.user.id, now);
        } else {
          assertCan(ctx, 'templates.submit');
          await assertTemplateAccountOpen(
            tx,
            ctx.tenant.id,
            row.whatsappAccountId,
            now,
            ctx.tenant.timezone,
          );
          await writeDeleteTemplateAtMeta(tx, deps, ctx.tenant.id, templateId, ctx.user.id, now);
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'template.deleted',
            subjectType: 'template',
            subjectId: templateId,
            metadata: { name: row.name, language: row.language },
          },
          meta,
        );
      });
    },

    /** Asks the worker to re-read this account's templates from Meta now. */
    async requestSync(ctx: TenantContext, whatsappAccountId: string) {
      assertCan(ctx, 'templates.read');
      if (!z.uuid().safeParse(whatsappAccountId).success) throw notFound('WhatsApp account');
      await db.run(ctx.scope, async (tx) => {
        const waba = await connectedWaba(tx, ctx, whatsappAccountId);
        if (waba.status !== 'connected') {
          throw new AppError('precondition_failed', 'Reconnect this WhatsApp account first.');
        }
        // Meta throttles the account's management calls: no sync is queued (ADR-399).
        assertManagementOpen(waba.managementPausedUntil, clock.now(), ctx.tenant.timezone);
        await requestSyncTx(tx, ctx.tenant.id, whatsappAccountId, clock.now());
        // A member waits for it, so it goes before the sweep's routine syncs (ADR-178).
        await enqueueTemplateJob(
          tx,
          deps,
          'template.sync',
          ctx.tenant.id,
          null,
          whatsappAccountId,
          `sync:${whatsappAccountId}`,
          TEMPLATE_SYNC_PRIORITY.requested,
        );
      });
    },

    /** Active numbers a member who may send templates can send from. */
    async sendChannels(ctx: TenantContext) {
      if (!can(ctx, 'inbox.reply') && !can(ctx, 'campaigns.send')) return [];
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: channelAccounts.id,
              displayPhoneNumber: channelAccounts.displayPhoneNumber,
              verifiedName: channelAccounts.verifiedName,
              whatsappAccountId: channelAccounts.whatsappAccountId,
            })
            .from(channelAccounts)
            .where(
              and(
                eq(channelAccounts.tenantId, ctx.tenant.id),
                eq(channelAccounts.status, 'active'),
              ),
            )
            .orderBy(asc(channelAccounts.createdAt)),
        { accessMode: 'read only' },
      );
      return rows.map((r) => ({
        id: r.id,
        label:
          [r.verifiedName, r.displayPhoneNumber].filter(Boolean).join(' · ') || 'WhatsApp number',
        whatsappAccountId: r.whatsappAccountId,
      }));
    },

    async syncStatus(ctx: TenantContext) {
      assertCan(ctx, 'templates.read');
      return db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: whatsappAccounts.id,
              name: whatsappAccounts.name,
              status: whatsappAccounts.status,
              templatesSyncedAt: whatsappAccounts.templatesSyncedAt,
              templatesSyncRequestedAt: whatsappAccounts.templatesSyncRequestedAt,
            })
            .from(whatsappAccounts)
            .where(eq(whatsappAccounts.tenantId, ctx.tenant.id))
            .orderBy(asc(whatsappAccounts.createdAt)),
        { accessMode: 'read only' },
      );
    },
  };
}

export type TemplatesService = ReturnType<typeof createTemplatesService>;

export interface TemplateWorkerDeps {
  db: Database;
  keyring: Keyring;
  graph: GraphClient;
  clock: Clock;
}

/** `paused`: Meta throttles the account's management calls; nothing was sent (ADR-399). */
export type TemplateJobOutcome = 'done' | 'skipped' | 'retry' | ManagementPaused;

/**
 * A template's submission or deletion deferred because Meta throttles the account's management
 * calls (ADR-399): records when its job runs again, while the template still waits for it, so the
 * sync's confirmation window and the deletion's keep count from then (no time spent deferred
 * counts against the request), and gives the job's `paused` outcome.
 */
async function deferTemplateWork(
  deps: TemplateWorkerDeps,
  scope: TenantScope,
  templateId: string,
  status: 'submitting' | 'pending_deletion',
  pausedUntil: Date,
): Promise<ManagementPaused> {
  await deps.db.run(scope, (tx) =>
    tx
      .update(messageTemplates)
      .set({ managementDeferredUntil: managementResumeAt(pausedUntil) })
      .where(
        and(
          eq(messageTemplates.tenantId, scope.tenantId),
          eq(messageTemplates.id, templateId),
          eq(messageTemplates.status, status),
        ),
      ),
  );
  return { paused: pausedUntil };
}

/**
 * The later of a request's time and the time its deferred job runs again (ADR-399). The deferral
 * belongs to the row's current request: recording a new request clears it.
 */
export function requestClockStart(requestedAt: Date, deferredUntil: Date | null): Date {
  return deferredUntil && deferredUntil > requestedAt ? deferredUntil : requestedAt;
}

/** Worker: sends the create request for a template marked `submitting`. */
export async function processTemplateSubmit(
  deps: TemplateWorkerDeps,
  scope: TenantScope,
  templateId: string,
): Promise<TemplateJobOutcome> {
  const loaded = await deps.db.run(scope, async (tx) => {
    const [row] = await tx
      .select()
      .from(messageTemplates)
      .where(
        and(eq(messageTemplates.tenantId, scope.tenantId), eq(messageTemplates.id, templateId)),
      );
    if (!row || row.status !== 'submitting' || row.providerTemplateId !== null) return null;
    const credential = await wabaCredential(
      tx,
      scope.tenantId,
      row.whatsappAccountId,
      deps.keyring,
    );
    return { row, credential };
  });
  if (!loaded) return 'skipped';
  const { row, credential } = loaded;

  const settle = (
    set: Partial<typeof messageTemplates.$inferInsert>,
    event: { status: string; reason?: string | null },
    requestSync: boolean,
  ) =>
    deps.db.run(scope, async (tx) => {
      const now = deps.clock.now();
      const updated = await tx
        .update(messageTemplates)
        .set(set)
        .where(
          and(
            eq(messageTemplates.tenantId, scope.tenantId),
            eq(messageTemplates.id, templateId),
            eq(messageTemplates.status, 'submitting'),
          ),
        )
        .returning({ id: messageTemplates.id });
      if (updated.length === 0) return;
      await insertStatusEvent(tx, scope.tenantId, {
        templateId,
        ...event,
        source: 'submit',
        at: now,
      });
      if (requestSync) await requestSyncTx(tx, scope.tenantId, row.whatsappAccountId, now);
    });

  if (!credential) {
    await settle(
      {
        status: 'submit_failed',
        submitError: 'The WhatsApp account is not connected. Reconnect it and submit again.',
      },
      { status: 'submit_failed', reason: 'account not connected' },
      false,
    );
    return 'done';
  }
  const paused = activeManagementPause(credential.managementPausedUntil, deps.clock.now());
  if (paused) return deferTemplateWork(deps, scope, templateId, 'submitting', paused);
  const result = await deps.graph.createTemplate(credential.wabaId, credential.token, {
    name: row.name,
    language: row.language,
    category: row.category,
    components: row.components,
  });
  const pausedBy = await noteManagementUsage(deps, scope, credential, result);
  // Meta refused it for now and paused the account: submitted again after the pause, no retry spent.
  if (refusedForPause(result, pausedBy)) {
    return deferTemplateWork(deps, scope, templateId, 'submitting', pausedBy);
  }
  if (result.ok) {
    const status = mapProviderTemplateStatus(result.data.status ?? 'PENDING');
    await settle(
      {
        providerTemplateId: result.data.id,
        providerStatus: result.data.status,
        status,
        ...(result.data.category === 'MARKETING' ||
        result.data.category === 'UTILITY' ||
        result.data.category === 'AUTHENTICATION'
          ? { category: result.data.category }
          : {}),
        submitError: null,
      },
      { status },
      true,
    );
    return 'done';
  }
  if (result.kind === 'retryable' && result.httpStatus === undefined) {
    // The connection failed before the request was sent: safe to try again.
    return 'retry';
  }
  if (result.kind === 'unknown' || result.kind === 'retryable') {
    // Meta may or may not have created it; the next sync decides (adopt by name, or fail later).
    await deps.db.run(scope, async (tx) => {
      await tx
        .update(messageTemplates)
        .set({ submitError: 'Waiting for Meta to confirm the submission.' })
        .where(
          and(
            eq(messageTemplates.tenantId, scope.tenantId),
            eq(messageTemplates.id, templateId),
            eq(messageTemplates.status, 'submitting'),
          ),
        );
      await requestSyncTx(tx, scope.tenantId, row.whatsappAccountId, deps.clock.now());
    });
    return 'done';
  }
  const reason = (result.detail ?? result.title).slice(0, 900);
  await settle(
    {
      status: 'submit_failed',
      submitError:
        result.kind === 'auth'
          ? 'Meta rejected the stored credential. Reconnect the WhatsApp account and submit again.'
          : `Meta did not accept the template: ${reason}`,
    },
    {
      status: 'submit_failed',
      reason: `${result.code ?? result.httpStatus ?? result.kind}: ${reason}`,
    },
    // A lost earlier response can surface as "already exists": the sync adopts the template then.
    true,
  );
  return 'done';
}

/** Worker: deletes a template marked `pending_deletion` through the Graph API. */
export async function processTemplateDelete(
  deps: TemplateWorkerDeps,
  scope: TenantScope,
  templateId: string,
): Promise<TemplateJobOutcome> {
  const loaded = await deps.db.run(scope, async (tx) => {
    const [row] = await tx
      .select()
      .from(messageTemplates)
      .where(
        and(eq(messageTemplates.tenantId, scope.tenantId), eq(messageTemplates.id, templateId)),
      );
    if (!row || row.status !== 'pending_deletion' || !row.providerTemplateId) return null;
    const credential = await wabaCredential(
      tx,
      scope.tenantId,
      row.whatsappAccountId,
      deps.keyring,
    );
    return { row, hsmId: row.providerTemplateId, credential };
  });
  if (!loaded) return 'skipped';
  const { row, hsmId, credential } = loaded;
  if (!credential) {
    await deps.db.run(scope, (tx) =>
      requestSyncTx(tx, scope.tenantId, row.whatsappAccountId, deps.clock.now()),
    );
    return 'done';
  }
  const paused = activeManagementPause(credential.managementPausedUntil, deps.clock.now());
  if (paused) return deferTemplateWork(deps, scope, templateId, 'pending_deletion', paused);
  const result = await deps.graph.deleteTemplate(credential.wabaId, credential.token, {
    name: row.name,
    hsmId,
  });
  const pausedBy = await noteManagementUsage(deps, scope, credential, result);
  // Meta refused it for now and paused the account: deleted after the pause, no `delete_failed`.
  if (refusedForPause(result, pausedBy)) {
    return deferTemplateWork(deps, scope, templateId, 'pending_deletion', pausedBy);
  }
  if (!result.ok && result.kind === 'retryable' && result.httpStatus === undefined) return 'retry';
  await deps.db.run(scope, async (tx) => {
    const now = deps.clock.now();
    if (result.ok) {
      await tx
        .update(messageTemplates)
        .set({ status: 'deleted', providerStatus: 'DELETED' })
        .where(
          and(
            eq(messageTemplates.tenantId, scope.tenantId),
            eq(messageTemplates.id, templateId),
            eq(messageTemplates.status, 'pending_deletion'),
          ),
        );
      await insertStatusEvent(tx, scope.tenantId, {
        templateId,
        status: 'deleted',
        source: 'delete',
        at: now,
      });
    } else {
      await insertStatusEvent(tx, scope.tenantId, {
        templateId,
        status: 'delete_failed',
        reason: `${result.code ?? result.httpStatus ?? result.kind}: ${(result.detail ?? result.title).slice(0, 900)}`,
        source: 'delete',
        at: now,
      });
      await recordSystemAudit(tx, scope.tenantId, {
        action: 'template.delete_failed',
        subjectType: 'template',
        subjectId: templateId,
        result: 'failure',
        metadata: { kind: result.kind },
      });
    }
    // The listing is authoritative either way (a failed delete restores the real status).
    await requestSyncTx(tx, scope.tenantId, row.whatsappAccountId, now);
  });
  return 'done';
}

/**
 * Of the given templates pending deletion (with when a deferred deletion job runs again), those
 * whose deletion was asked for since `since` and has not failed: the last deletion event of each is
 * the request itself (ADR-111). A deletion deferred for a pause after it was asked counts from when
 * its job runs again (ADR-399).
 */
async function deletionsAskedSince(
  tx: Tx,
  tenantId: string,
  deferredUntil: ReadonlyMap<string, Date | null>,
  since: Date,
): Promise<Set<string>> {
  const templateIds = [...deferredUntil.keys()];
  if (templateIds.length === 0) return new Set();
  const last = await tx
    .selectDistinctOn([templateStatusEvents.templateId], {
      templateId: templateStatusEvents.templateId,
      status: templateStatusEvents.status,
      occurredAt: templateStatusEvents.occurredAt,
    })
    .from(templateStatusEvents)
    .where(
      and(
        eq(templateStatusEvents.tenantId, tenantId),
        inArray(templateStatusEvents.templateId, templateIds),
        eq(templateStatusEvents.source, 'delete'),
      ),
    )
    .orderBy(
      templateStatusEvents.templateId,
      desc(templateStatusEvents.occurredAt),
      desc(templateStatusEvents.id),
    );
  return new Set(
    last
      .filter(
        (e) =>
          e.status === 'pending_deletion' &&
          requestClockStart(e.occurredAt, deferredUntil.get(e.templateId) ?? null) >= since,
      )
      .map((e) => e.templateId),
  );
}

/**
 * Sweep: ends a deletion whose job ran out of retries (ADR-111). A template still pending deletion
 * goes back to the status Meta last reported (the sync requested here refreshes it), with a
 * `delete_failed` event and one for that status, as after a deletion Meta refuses and the sync that
 * follows it, so the company can delete it again. False when nothing was left to end.
 */
export async function settleTemplateDeletion(
  tx: Tx,
  tenantId: string,
  templateId: string,
  at: Date,
): Promise<boolean> {
  const [row] = await tx
    .select({
      status: messageTemplates.status,
      providerStatus: messageTemplates.providerStatus,
      whatsappAccountId: messageTemplates.whatsappAccountId,
    })
    .from(messageTemplates)
    .where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.id, templateId)))
    .for('update');
  if (!row || row.status !== 'pending_deletion') return false;
  const status = mapProviderTemplateStatus(row.providerStatus);
  // Meta deleting the template itself: the next sync finds it deleted.
  if (status === 'pending_deletion' || status === 'deleted') return false;
  await tx
    .update(messageTemplates)
    .set({ status })
    .where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.id, templateId)));
  await insertStatusEvent(tx, tenantId, {
    templateId,
    status: 'delete_failed',
    reason: 'Meta could not be reached to delete it after repeated attempts. Delete it again.',
    source: 'delete',
    at,
  });
  await insertStatusEvent(tx, tenantId, {
    templateId,
    status,
    reason: 'Back to the status Meta last reported.',
    source: 'delete',
    at,
  });
  await recordSystemAudit(tx, tenantId, {
    action: 'template.delete_failed',
    subjectType: 'template',
    subjectId: templateId,
    result: 'failure',
    metadata: { kind: 'retries_exhausted' },
  });
  await requestSyncTx(tx, tenantId, row.whatsappAccountId, at);
  return true;
}

async function listAllTemplates(
  deps: TemplateWorkerDeps,
  scope: TenantScope,
  credential: { whatsappAccountId: string; wabaId: string; token: string },
): Promise<
  | { ok: true; templates: RemoteTemplate[] }
  | { ok: false; kind: string; detail: string }
  | { ok: false; paused: Date }
> {
  const { wabaId, token } = credential;
  let fields: string = SYNC_FIELDS;
  const templates: RemoteTemplate[] = [];
  let after: string | null = null;
  for (let page = 0; page < SYNC_MAX_PAGES; page += 1) {
    const result = await deps.graph.listTemplates(wabaId, token, { after, fields });
    const pausedUntil = await noteManagementUsage(deps, scope, credential, result);
    if (!result.ok) {
      // The response paused the account: no further call, not even the fallback below, and a
      // refusal for now is not a failure; the sync runs again after the pause (ADR-399).
      if (
        pausedUntil &&
        (result.kind === 'retryable' ||
          (page === 0 &&
            fields === SYNC_FIELDS &&
            result.kind === 'permanent' &&
            result.code === 100))
      ) {
        return { ok: false, paused: pausedUntil };
      }
      // Unknown extra fields are rejected with code 100: fall back to the default fields once.
      if (
        page === 0 &&
        fields === SYNC_FIELDS &&
        result.kind === 'permanent' &&
        result.code === 100
      ) {
        fields = DEFAULT_FIELDS_FALLBACK;
        page -= 1;
        continue;
      }
      return {
        ok: false,
        kind: result.kind,
        detail: `${result.code ?? result.httpStatus ?? ''} ${result.title}`.trim(),
      };
    }
    templates.push(...result.data.templates);
    after = result.data.after;
    if (!after) return { ok: true, templates };
    // Meta throttles the account from now on: the rest of the listing waits for the pause.
    if (pausedUntil) return { ok: false, paused: pausedUntil };
  }
  return { ok: false, kind: 'permanent', detail: `more than ${SYNC_MAX_PAGES} pages of templates` };
}

/**
 * Worker: reconciles a WABA's templates with Meta's listing. Matches by Meta id, then by name and
 * language (adopting templates created elsewhere or whose create response was lost). Records every
 * status change. `templates_synced_at` is set to the time the listing started, so a sync requested
 * while this one ran triggers another.
 */
export async function syncTemplates(
  deps: TemplateWorkerDeps,
  scope: TenantScope,
  whatsappAccountId: string,
): Promise<TemplateJobOutcome> {
  const startedAt = deps.clock.now();
  const credential = await deps.db.run(scope, (tx) =>
    wabaCredential(tx, scope.tenantId, whatsappAccountId, deps.keyring),
  );
  if (!credential) return 'skipped';
  // While Meta throttles the account's management calls nothing is asked; the sweep signals the
  // sync again once the pause has ended (ADR-399).
  const paused = activeManagementPause(credential.managementPausedUntil, startedAt);
  if (paused) return { paused };
  const listing = await listAllTemplates(deps, scope, credential);
  if (!listing.ok) {
    if ('paused' in listing) return { paused: listing.paused };
    if (listing.kind === 'retryable' || listing.kind === 'unknown') return 'retry';
    await deps.db.run(scope, async (tx) => {
      await tx
        .update(whatsappAccounts)
        .set({ templatesSyncedAt: startedAt })
        .where(
          and(
            eq(whatsappAccounts.tenantId, scope.tenantId),
            eq(whatsappAccounts.id, whatsappAccountId),
          ),
        );
      await recordSystemAudit(tx, scope.tenantId, {
        action: 'templates.sync_failed',
        subjectType: 'whatsapp_account',
        subjectId: whatsappAccountId,
        result: 'failure',
        metadata: { kind: listing.kind, detail: listing.detail.slice(0, 200) },
      });
      // Meta refused the token: check the account's access at once (ADR-137).
      if (listing.kind === 'auth') {
        await requestAccessCheck(tx, scope.tenantId, whatsappAccountId, startedAt);
      }
    });
    return 'done';
  }

  await deps.db.run(scope, async (tx) => {
    const now = deps.clock.now();
    // An edit's window is judged on the database's clock, which set its request time (ADR-404).
    const dbNow = await databaseNow(tx);
    const local = await tx
      .select()
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.tenantId, scope.tenantId),
          eq(messageTemplates.whatsappAccountId, whatsappAccountId),
        ),
      )
      .for('update');
    const byProviderId = new Map(
      local.flatMap((l) => (l.providerTemplateId ? [[l.providerTemplateId, l] as const] : [])),
    );
    const deletionsInProgress = await deletionsAskedSince(
      tx,
      scope.tenantId,
      new Map(
        local
          .filter((l) => l.status === 'pending_deletion')
          .map((l) => [l.id, l.managementDeferredUntil] as const),
      ),
      new Date(now.getTime() - DELETION_KEEP_MS),
    );
    const byKey = new Map(local.map((l) => [`${l.name}|${l.language}`, l]));
    const seen = new Set<string>();

    for (const remote of listing.templates) {
      if (!TEMPLATE_NAME_RE.test(remote.name) || !TEMPLATE_LANGUAGE_RE.test(remote.language))
        continue;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(remote.id)) continue;
      const status = mapProviderTemplateStatus(remote.status);
      const category =
        remote.category === 'MARKETING' ||
        remote.category === 'UTILITY' ||
        remote.category === 'AUTHENTICATION'
          ? remote.category
          : null;
      const components =
        JSON.stringify(remote.components).length <= 30_000 ? remote.components : null;
      const existing =
        byProviderId.get(remote.id) ?? byKey.get(`${remote.name}|${remote.language}`);
      if (existing && existing.providerTemplateId && existing.providerTemplateId !== remote.id) {
        // Same name and language but a different Meta template (recreated after a deletion):
        // keep our row only if it is gone at Meta; otherwise skip the ambiguous entry.
        if (existing.status !== 'deleted') continue;
      }
      if (existing) {
        seen.add(existing.id);
        // A deletion still being tried keeps its status; Meta's status is kept for when it ends.
        const kept =
          existing.status === 'pending_deletion' &&
          status !== 'deleted' &&
          deletionsInProgress.has(existing.id);
        const changed = existing.status !== status && !kept;
        const set: Partial<typeof messageTemplates.$inferInsert> = { lastSyncedAt: now };
        if (existing.providerTemplateId !== remote.id) set.providerTemplateId = remote.id;
        if (existing.providerStatus !== remote.status)
          set.providerStatus = remote.status.slice(0, 32);
        if (changed) set.status = status;
        if (category && existing.category !== category) set.category = category;
        if (components && JSON.stringify(existing.components) !== JSON.stringify(components))
          set.components = components;
        if ((remote.rejectedReason ?? null) !== existing.rejectionReason)
          set.rejectionReason = remote.rejectedReason?.slice(0, 200) ?? null;
        if ((remote.qualityScore ?? null) !== existing.qualityScore)
          set.qualityScore = remote.qualityScore?.slice(0, 16) ?? null;
        if (existing.submitError && !LOCAL_STATES.includes(status)) set.submitError = null;
        await tx
          .update(messageTemplates)
          .set(set)
          .where(
            and(
              eq(messageTemplates.tenantId, scope.tenantId),
              eq(messageTemplates.id, existing.id),
            ),
          );
        if (changed) {
          await insertStatusEvent(tx, scope.tenantId, {
            templateId: existing.id,
            status,
            reason:
              existing.status === 'pending_deletion' && status !== 'deleted'
                ? 'Meta still lists it, so the deletion did not go through.'
                : remote.rejectedReason,
            source: 'sync',
            at: now,
          });
        }
        // An edit whose answer was lost: Meta's content confirms it, or the window ends (ADR-404).
        await reconcileTemplateEdit(tx, scope.tenantId, existing, remote, now, dbNow);
      } else if (category && components) {
        const id = uuidv7();
        await tx.insert(messageTemplates).values({
          id,
          tenantId: scope.tenantId,
          whatsappAccountId,
          name: remote.name,
          language: remote.language,
          category,
          components,
          status,
          providerTemplateId: remote.id,
          providerStatus: remote.status.slice(0, 32),
          rejectionReason: remote.rejectedReason?.slice(0, 200) ?? null,
          qualityScore: remote.qualityScore?.slice(0, 16) ?? null,
          origin: 'synced',
          lastSyncedAt: now,
        });
        await insertStatusEvent(tx, scope.tenantId, {
          templateId: id,
          status,
          source: 'sync',
          at: now,
        });
      }
    }

    for (const row of local) {
      if (seen.has(row.id)) continue;
      if (row.status === 'submitting') {
        // Counted from the later of the submission and its deferred job's run, so a pause Meta
        // imposed before the create was sent does not fail it (ADR-399).
        if (
          row.submittedAt &&
          now.getTime() -
            requestClockStart(row.submittedAt, row.managementDeferredUntil).getTime() >
            SUBMIT_CONFIRM_WINDOW_MS
        ) {
          await tx
            .update(messageTemplates)
            .set({
              status: 'submit_failed',
              submitError: 'Meta has no record of this submission. Submit it again.',
            })
            .where(
              and(eq(messageTemplates.tenantId, scope.tenantId), eq(messageTemplates.id, row.id)),
            );
          await insertStatusEvent(tx, scope.tenantId, {
            templateId: row.id,
            status: 'submit_failed',
            reason: 'not found at Meta after the confirmation window',
            source: 'sync',
            at: now,
          });
        }
        continue;
      }
      if (
        row.providerTemplateId &&
        row.status !== 'deleted' &&
        !LOCAL_STATES.includes(row.status)
      ) {
        // Deleted outside HyFib (for example in WhatsApp Manager).
        await tx
          .update(messageTemplates)
          .set({ status: 'deleted', lastSyncedAt: now })
          .where(
            and(eq(messageTemplates.tenantId, scope.tenantId), eq(messageTemplates.id, row.id)),
          );
        await insertStatusEvent(tx, scope.tenantId, {
          templateId: row.id,
          status: 'deleted',
          reason: 'no longer listed by Meta',
          source: 'sync',
          at: now,
        });
        await reconcileTemplateEdit(tx, scope.tenantId, row, null, now, dbNow);
      }
    }
    await tx
      .update(whatsappAccounts)
      .set({ templatesSyncedAt: startedAt })
      .where(
        and(
          eq(whatsappAccounts.tenantId, scope.tenantId),
          eq(whatsappAccounts.id, whatsappAccountId),
        ),
      );
  });
  return 'done';
}

/**
 * Sweep input: WABAs whose templates need a sync (ids from a SECURITY DEFINER query), those asked
 * for since their last sync first (`requested`: a member's refresh, or Meta's template webhook,
 * ADR-178).
 */
export async function findTemplateSyncsDue(
  db: Database,
  limit = 100,
): Promise<{ tenantId: string; whatsappAccountId: string; requested: boolean }[]> {
  return db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{
        tenant_id: string;
        whatsapp_account_id: string;
        requested: boolean;
      }>(
        sql`select tenant_id, whatsapp_account_id, requested from ops.template_sync_due(${limit})`,
      );
      return res.rows.map((r) => ({
        tenantId: r.tenant_id,
        whatsappAccountId: r.whatsapp_account_id,
        requested: r.requested === true,
      }));
    },
    { accessMode: 'read only' },
  );
}

/** Records a send-time template error (paused/disabled) and asks for a re-sync. */
export async function markTemplateFromSendError(
  tx: Tx,
  tenantId: string,
  templateId: string,
  status: 'paused' | 'disabled',
  at: Date,
) {
  const [row] = await tx
    .update(messageTemplates)
    .set({ status })
    .where(
      and(
        eq(messageTemplates.tenantId, tenantId),
        eq(messageTemplates.id, templateId),
        inArray(messageTemplates.status, ['approved', 'paused', 'flagged']),
      ),
    )
    .returning({ whatsappAccountId: messageTemplates.whatsappAccountId });
  if (!row) return;
  await insertStatusEvent(tx, tenantId, {
    templateId,
    status,
    reason: 'reported by Meta when sending',
    source: 'send',
    at,
  });
  await requestSyncTx(tx, tenantId, row.whatsappAccountId, at);
}
