import { z } from 'zod';
import { AppError, notFound, uuidv7, type Clock, type Keyring } from '@w360/core';
import { QUEUES } from '@w360/contracts';
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
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { recordAudit, recordSystemAudit, type RequestMeta } from '../audit';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import type { GraphClient, RemoteTemplate } from '../messaging/graph';
import { requestAccessCheck } from '../messaging/access';
import { credentialAad } from '../messaging/credentials';
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

export const PROVIDER_TEMPLATE_STATUS: Record<string, TemplateStatus> = {
  APPROVED: 'approved',
  PENDING: 'pending',
  REJECTED: 'rejected',
  PAUSED: 'paused',
  DISABLED: 'disabled',
  IN_APPEAL: 'in_appeal',
  FLAGGED: 'flagged',
  ARCHIVED: 'archived',
  PENDING_DELETION: 'pending_deletion',
  DELETED: 'deleted',
  LIMIT_EXCEEDED: 'limit_exceeded',
  LOCKED: 'locked',
};

export function mapProviderTemplateStatus(status: string | null | undefined): TemplateStatus {
  return (status && PROVIDER_TEMPLATE_STATUS[status.toUpperCase()]) || 'unknown';
}

const LOCAL_STATES: readonly TemplateStatus[] = ['draft', 'submitting', 'submit_failed'];
const EDITABLE_STATES: readonly TemplateStatus[] = ['draft', 'submit_failed'];

export const draftInputSchema = z.object({
  whatsappAccountId: z.uuid(),
  name: z
    .string()
    .trim()
    .regex(TEMPLATE_NAME_RE, 'Use lower-case letters, digits and underscores for the name'),
  language: z
    .string()
    .trim()
    .regex(TEMPLATE_LANGUAGE_RE, 'Enter a language code such as en or en_US'),
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

function assertValidDefinition(def: TemplateDefinition) {
  const issues = validateDefinition(def);
  if (issues.length > 0) {
    throw new AppError('validation_failed', issues[0]?.message ?? 'Invalid template', { issues });
  }
}

async function insertStatusEvent(
  tx: Tx,
  tenantId: string,
  input: {
    templateId: string;
    status: string;
    reason?: string | null;
    source: 'submit' | 'sync' | 'send' | 'delete';
    actorUserId?: string | null;
    at: Date;
  },
) {
  await tx.insert(templateStatusEvents).values({
    id: uuidv7(),
    tenantId,
    templateId: input.templateId,
    status: input.status.slice(0, 32),
    reason: input.reason?.slice(0, 1000) ?? null,
    source: input.source,
    actorUserId: input.actorUserId ?? null,
    occurredAt: input.at,
  });
}

async function requestSyncTx(tx: Tx, tenantId: string, whatsappAccountId: string, at: Date) {
  await tx
    .update(whatsappAccounts)
    .set({ templatesSyncRequestedAt: at })
    .where(
      and(eq(whatsappAccounts.tenantId, tenantId), eq(whatsappAccounts.id, whatsappAccountId)),
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

  async function connectedWaba(tx: Tx, ctx: TenantContext, whatsappAccountId: string) {
    const [waba] = await tx
      .select({
        id: whatsappAccounts.id,
        status: whatsappAccounts.status,
        name: whatsappAccounts.name,
      })
      .from(whatsappAccounts)
      .where(
        and(
          eq(whatsappAccounts.tenantId, ctx.tenant.id),
          eq(whatsappAccounts.id, whatsappAccountId),
        ),
      );
    if (!waba) throw notFound('WhatsApp account');
    return waba;
  }

  async function enqueue(
    tx: Tx | null,
    kind: 'template.submit' | 'template.delete' | 'template.sync',
    tenantId: string,
    actorUserId: string | null,
    ref: string,
    singletonKey: string,
  ) {
    const queue =
      kind === 'template.submit'
        ? QUEUES.templateSubmit.name
        : kind === 'template.delete'
          ? QUEUES.templateDelete.name
          : QUEUES.templateSync.name;
    await deps.jobs.enqueue(tx, queue, deps.signer.sign({ kind, tenantId, actorUserId, ref }), {
      singletonKey,
    });
  }

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
          return {
            template: row,
            definition,
            editable: EDITABLE_STATES.includes(row.status) && row.providerTemplateId === null,
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
      const components = toMetaComponents(data.definition);
      return db.run(ctx.scope, async (tx) => {
        await connectedWaba(tx, ctx, data.whatsappAccountId);
        const [existing] = await tx
          .select({
            id: messageTemplates.id,
            status: messageTemplates.status,
            providerTemplateId: messageTemplates.providerTemplateId,
          })
          .from(messageTemplates)
          .where(
            and(
              eq(messageTemplates.tenantId, ctx.tenant.id),
              eq(messageTemplates.whatsappAccountId, data.whatsappAccountId),
              eq(messageTemplates.name, data.name),
              eq(messageTemplates.language, data.language),
            ),
          )
          .for('update');
        let id: string;
        if (existing) {
          // A deleted local draft (never known to Meta) may be reused; anything else is taken.
          if (existing.status !== 'deleted' || existing.providerTemplateId !== null) {
            throw new AppError(
              'conflict',
              'A template with this name and language already exists.',
            );
          }
          id = existing.id;
          await tx
            .update(messageTemplates)
            .set({
              components,
              category: data.definition.category,
              status: 'draft',
              submitError: null,
              version: sql`${messageTemplates.version} + 1`,
            })
            .where(and(eq(messageTemplates.tenantId, ctx.tenant.id), eq(messageTemplates.id, id)));
        } else {
          id = uuidv7();
          await tx.insert(messageTemplates).values({
            id,
            tenantId: ctx.tenant.id,
            whatsappAccountId: data.whatsappAccountId,
            name: data.name,
            language: data.language,
            category: data.definition.category,
            components,
            status: 'draft',
            origin: 'local',
            createdByUserId: ctx.user.id,
          });
        }
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
    },

    async updateDraft(ctx: TenantContext, templateId: string, input: unknown) {
      assertCan(ctx, 'templates.write');
      const data = parseInput(updateDraftSchema, input);
      assertValidDefinition(data.definition);
      await db.run(ctx.scope, async (tx) => {
        const row = await loadForUpdate(tx, ctx, templateId);
        if (!EDITABLE_STATES.includes(row.status) || row.providerTemplateId !== null) {
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
        await tx
          .update(messageTemplates)
          .set({
            components: toMetaComponents(data.definition),
            category: data.definition.category,
            status: 'draft',
            submitError: null,
            version: sql`${messageTemplates.version} + 1`,
          })
          .where(
            and(eq(messageTemplates.tenantId, ctx.tenant.id), eq(messageTemplates.id, templateId)),
          );
      });
    },

    /** Marks the template `submitting` and queues the create request (write-ahead). */
    async submitTemplate(ctx: TenantContext, templateId: string, meta: RequestMeta = {}) {
      assertCan(ctx, 'templates.submit');
      await db.run(ctx.scope, async (tx) => {
        const row = await loadForUpdate(tx, ctx, templateId);
        if (!EDITABLE_STATES.includes(row.status) || row.providerTemplateId !== null) {
          throw new AppError('precondition_failed', 'This template has already been sent to Meta.');
        }
        const def = fromMetaComponents(row.category, row.components);
        if (!def)
          throw new AppError('unsupported', 'This template cannot be submitted from HyFib.');
        assertValidDefinition(def);
        const waba = await connectedWaba(tx, ctx, row.whatsappAccountId);
        if (waba.status !== 'connected') {
          throw new AppError(
            'precondition_failed',
            'Reconnect this WhatsApp account before submitting templates.',
          );
        }
        const now = clock.now();
        const [updated] = await tx
          .update(messageTemplates)
          .set({
            status: 'submitting',
            submittedAt: now,
            submitError: null,
            version: sql`${messageTemplates.version} + 1`,
          })
          .where(
            and(eq(messageTemplates.tenantId, ctx.tenant.id), eq(messageTemplates.id, templateId)),
          )
          .returning({ version: messageTemplates.version });
        await insertStatusEvent(tx, ctx.tenant.id, {
          templateId,
          status: 'submitting',
          source: 'submit',
          actorUserId: ctx.user.id,
          at: now,
        });
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
        await enqueue(
          tx,
          'template.submit',
          ctx.tenant.id,
          ctx.user.id,
          templateId,
          `${templateId}:${updated?.version ?? 0}`,
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
        if (row.status === 'deleted' || row.status === 'pending_deletion') {
          throw new AppError('conflict', 'This template is already deleted.');
        }
        if (row.status === 'submitting') {
          throw new AppError(
            'precondition_failed',
            'Wait until Meta confirms the submission before deleting.',
          );
        }
        if (row.providerTemplateId === null) {
          await tx
            .update(messageTemplates)
            .set({ status: 'deleted', version: sql`${messageTemplates.version} + 1` })
            .where(
              and(
                eq(messageTemplates.tenantId, ctx.tenant.id),
                eq(messageTemplates.id, templateId),
              ),
            );
          await insertStatusEvent(tx, ctx.tenant.id, {
            templateId,
            status: 'deleted',
            source: 'delete',
            actorUserId: ctx.user.id,
            at: now,
          });
        } else {
          assertCan(ctx, 'templates.submit');
          await tx
            .update(messageTemplates)
            .set({ status: 'pending_deletion', version: sql`${messageTemplates.version} + 1` })
            .where(
              and(
                eq(messageTemplates.tenantId, ctx.tenant.id),
                eq(messageTemplates.id, templateId),
              ),
            );
          await insertStatusEvent(tx, ctx.tenant.id, {
            templateId,
            status: 'pending_deletion',
            source: 'delete',
            actorUserId: ctx.user.id,
            at: now,
          });
          await enqueue(
            tx,
            'template.delete',
            ctx.tenant.id,
            ctx.user.id,
            templateId,
            `${templateId}:delete`,
          );
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
        await requestSyncTx(tx, ctx.tenant.id, whatsappAccountId, clock.now());
        await enqueue(
          tx,
          'template.sync',
          ctx.tenant.id,
          null,
          whatsappAccountId,
          `sync:${whatsappAccountId}`,
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

/** The WhatsApp account's id at Meta and its decrypted token (null unless connected). */
export async function wabaCredential(
  tx: Tx,
  tenantId: string,
  whatsappAccountId: string,
  keyring: Keyring,
) {
  const [waba] = await tx
    .select({
      wabaId: whatsappAccounts.wabaId,
      status: whatsappAccounts.status,
      credential: whatsappAccounts.credentialCiphertext,
    })
    .from(whatsappAccounts)
    .where(
      and(eq(whatsappAccounts.tenantId, tenantId), eq(whatsappAccounts.id, whatsappAccountId)),
    );
  if (!waba || waba.status !== 'connected' || !waba.credential) return null;
  return {
    wabaId: waba.wabaId,
    token: keyring.decryptString(waba.credential, credentialAad(tenantId, whatsappAccountId)),
  };
}

export type TemplateJobOutcome = 'done' | 'skipped' | 'retry';

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
  const result = await deps.graph.createTemplate(credential.wabaId, credential.token, {
    name: row.name,
    language: row.language,
    category: row.category,
    components: row.components,
  });
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
  const result = await deps.graph.deleteTemplate(credential.wabaId, credential.token, {
    name: row.name,
    hsmId,
  });
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
 * Of the given templates pending deletion, those whose deletion was asked for since `since` and has
 * not failed: the last deletion event of each is the request itself (ADR-111).
 */
async function deletionsAskedSince(
  tx: Tx,
  tenantId: string,
  templateIds: string[],
  since: Date,
): Promise<Set<string>> {
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
      .filter((e) => e.status === 'pending_deletion' && e.occurredAt >= since)
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
  wabaId: string,
  token: string,
): Promise<
  { ok: true; templates: RemoteTemplate[] } | { ok: false; kind: string; detail: string }
> {
  let fields: string = SYNC_FIELDS;
  const templates: RemoteTemplate[] = [];
  let after: string | null = null;
  for (let page = 0; page < SYNC_MAX_PAGES; page += 1) {
    const result = await deps.graph.listTemplates(wabaId, token, { after, fields });
    if (!result.ok) {
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
  const listing = await listAllTemplates(deps, credential.wabaId, credential.token);
  if (!listing.ok) {
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
      local.filter((l) => l.status === 'pending_deletion').map((l) => l.id),
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
        if (
          row.submittedAt &&
          now.getTime() - row.submittedAt.getTime() > SUBMIT_CONFIRM_WINDOW_MS
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

/** Sweep input: WABAs whose templates need a sync (ids from a SECURITY DEFINER query). */
export async function findTemplateSyncsDue(
  db: Database,
  limit = 100,
): Promise<{ tenantId: string; whatsappAccountId: string }[]> {
  return db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{ tenant_id: string; whatsapp_account_id: string }>(
        sql`select tenant_id, whatsapp_account_id from ops.template_sync_due(${limit})`,
      );
      return res.rows.map((r) => ({
        tenantId: r.tenant_id,
        whatsappAccountId: r.whatsapp_account_id,
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
