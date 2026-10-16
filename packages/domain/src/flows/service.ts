import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, clipText, notFound, uuidv7, type Clock } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import { EgressError, parseEgressUrl } from '@w360/core/egress';
import {
  and,
  asc,
  channelAccounts,
  contactFields,
  contactIdentities,
  contacts,
  conversations,
  count,
  desc,
  eq,
  flowKeyUploads,
  flowKeys,
  flowResponses,
  flowSends,
  flows,
  httpAllowedDomains,
  httpSecrets,
  inArray,
  isNotNull,
  isNull,
  isUniqueViolation,
  lt,
  messages,
  sendIntents,
  sql,
  whatsappAccounts,
  type Database,
  type FlowAnswerOutcome,
  type FlowMetaStatus,
  type FlowSyncOp,
  type Tx,
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { recordAudit, type RequestMeta } from '../audit';
import { hostAllowed } from '../automations/graph';
import { endRunForHuman } from '../automations/runs';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { emitTenantEvent } from '../messaging/events';
import { SERVICE_WINDOW_MS, canSeeConversation } from '../messaging/outbound';
import { STATUS_RANK } from '../messaging/status';
import { assertManagementOpen } from '../messaging/management-pace';
import { parseInput } from '../validation';
import { FLOW_CATEGORIES, FLOW_LIMITS, checkFlowJson } from './flow-json';
import {
  FLOW_TOKEN_DAYS,
  answerMappingSchema,
  buildFlowMessageRequest,
  flowEndpointUrl,
  flowMessageSchema,
  newFlowPublicId,
  newFlowToken,
} from './model';
import { assertModule } from '../plans/entitlements';

/**
 * WhatsApp Flows (P4-03). Reading needs `flows.read`; editing drafts, their settings and keys needs
 * `flows.write`; publishing and deprecating (irreversible at Meta) and rotating keys need
 * `flows.publish`; changes are audited. Everything done at Meta is written ahead on the flow row
 * (sync_op, sync_state) and performed by the worker, one operation at a time. Sending a form is a
 * reply (`inbox.reply`); answers are shown with contact details only to `contacts.read`.
 */

export interface FlowsDeps {
  db: Database;
  clock: Clock;
  jobs: JobQueue;
  signer: JobSigner;
  appBaseUrl: string;
  /** http:// endpoints are allowed for local test targets only (like web requests). */
  allowInsecureHttp: boolean;
}

const idSchema = z.object({ id: z.uuid() });
const versioned = idSchema.extend({ expectedVersion: z.number().int().min(1) });

const draftSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name the flow.')
    .max(FLOW_LIMITS.nameLength, `Use at most ${FLOW_LIMITS.nameLength} characters.`),
  categories: z
    .array(z.enum(FLOW_CATEGORIES))
    .min(1, 'Choose at least one category.')
    .max(FLOW_CATEGORIES.length),
  json: z.string().max(FLOW_LIMITS.jsonBytes * 2),
});

const createSchema = draftSchema.extend({
  whatsappAccountId: z.uuid('Choose a WhatsApp account.'),
});

const settingsSchema = versioned.extend({
  mapping: answerMappingSchema,
  endpointUrl: z
    .string()
    .trim()
    .max(2000)
    .transform((v) => v || null),
  endpointSecretName: z
    .string()
    .trim()
    .max(40)
    .transform((v) => v || null),
});

const sendSchema = flowMessageSchema.extend({
  conversationId: z.uuid(),
  flowId: z.uuid('Choose a form.'),
  mode: z.enum(['published', 'draft']),
  clientKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
});

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const stale = () =>
  new AppError(
    'conflict',
    'Someone else changed this. Reload to see the latest version, then try again.',
  );

const invalid = (path: string, message: string) =>
  new AppError('validation_failed', message, { issues: [{ path, message }] });

export const SENDABLE_STATUSES: readonly FlowMetaStatus[] = ['PUBLISHED', 'THROTTLED'];

export interface FlowListItem {
  id: string;
  name: string;
  accountName: string;
  metaStatus: FlowMetaStatus | null;
  syncState: string;
  syncOp: FlowSyncOp | null;
  syncError: string | null;
  validationErrors: number;
  usesEndpoint: boolean;
  unsentChanges: boolean;
  sends: number;
  responses: number;
  archivedAt: string | null;
  updatedAt: string;
}

export function createFlowsService(deps: FlowsDeps) {
  const { db } = deps;

  async function enqueueSync(tx: Tx, ctx: TenantContext, flowId: string, version: number) {
    await deps.jobs.enqueue(
      tx,
      QUEUES.flowSync.name,
      deps.signer.sign({
        kind: 'flow.sync',
        tenantId: ctx.tenant.id,
        actorUserId: ctx.user.id,
        ref: flowId,
      }),
      { singletonKey: `${flowId}:${version}` },
    );
  }

  async function enqueueKeys(tx: Tx, ctx: TenantContext, whatsappAccountId: string) {
    await deps.jobs.enqueue(
      tx,
      QUEUES.flowKeys.name,
      deps.signer.sign({
        kind: 'flow.keys',
        tenantId: ctx.tenant.id,
        actorUserId: ctx.user.id,
        ref: whatsappAccountId,
      }),
      { singletonKey: `${whatsappAccountId}:${deps.clock.now().getTime()}` },
    );
  }

  /**
   * Writes the next operation ahead and signals the worker; refused while Meta throttles the
   * account's management calls (ADR-399).
   */
  async function requestOp(
    tx: Tx,
    ctx: TenantContext,
    row: { id: string; version: number; whatsappAccountId: string },
    op: FlowSyncOp,
    extra: Partial<typeof flows.$inferInsert> = {},
  ) {
    const [account] = await tx
      .select({ pausedUntil: whatsappAccounts.managementPausedUntil })
      .from(whatsappAccounts)
      .where(
        and(
          eq(whatsappAccounts.tenantId, ctx.tenant.id),
          eq(whatsappAccounts.id, row.whatsappAccountId),
        ),
      );
    assertManagementOpen(account?.pausedUntil, deps.clock.now(), ctx.tenant.timezone);
    const version = row.version + 1;
    await tx
      .update(flows)
      .set({
        ...extra,
        syncOp: op,
        syncState: 'queued',
        syncError: null,
        syncRequestedAt: deps.clock.now(),
        version,
      })
      .where(and(eq(flows.tenantId, ctx.tenant.id), eq(flows.id, row.id)));
    await enqueueSync(tx, ctx, row.id, version);
    return version;
  }

  async function lockFlow(tx: Tx, ctx: TenantContext, id: string, expectedVersion?: number) {
    const [row] = await tx
      .select()
      .from(flows)
      .where(and(eq(flows.tenantId, ctx.tenant.id), eq(flows.id, id)))
      .for('update');
    if (!row) throw notFound('Flow');
    if (expectedVersion !== undefined && row.version !== expectedVersion) throw stale();
    return row;
  }

  const busy = (row: { syncState: string }) =>
    row.syncState === 'queued' || row.syncState === 'running';
  const notBusy = (row: { syncState: string }) => {
    if (busy(row)) {
      throw new AppError(
        'conflict',
        'Meta is still processing the last change to this flow. Try again in a moment.',
      );
    }
  };

  function checked(json: string) {
    const check = checkFlowJson(json);
    if (!check.ok) {
      const first = check.issues[0] ?? { path: '$', message: 'The Flow JSON is not valid.' };
      throw new AppError('validation_failed', `${first.message} (${first.path})`, {
        issues: check.issues.map((i) => ({ path: 'json', message: `${i.path}: ${i.message}` })),
      });
    }
    return check.summary;
  }

  /**
   * A connected account of the company whose management calls Meta does not throttle: while it
   * does, the action says so instead of queuing work for Meta (ADR-399).
   */
  async function connectedAccount(tx: Tx, ctx: TenantContext, whatsappAccountId: string) {
    const [account] = await tx
      .select({
        id: whatsappAccounts.id,
        status: whatsappAccounts.status,
        managementPausedUntil: whatsappAccounts.managementPausedUntil,
      })
      .from(whatsappAccounts)
      .where(
        and(
          eq(whatsappAccounts.tenantId, ctx.tenant.id),
          eq(whatsappAccounts.id, whatsappAccountId),
        ),
      );
    if (!account || account.status !== 'connected') {
      throw invalid('whatsappAccountId', 'Choose a connected WhatsApp account.');
    }
    assertManagementOpen(account.managementPausedUntil, deps.clock.now(), ctx.tenant.timezone);
  }

  const nameTaken = () => invalid('name', 'Another flow of this WhatsApp account has this name.');

  return {
    /** The company's WhatsApp accounts a flow can belong to. */
    async accounts(ctx: TenantContext) {
      assertCan(ctx, 'flows.read');
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: whatsappAccounts.id,
              name: whatsappAccounts.name,
              status: whatsappAccounts.status,
              wabaId: whatsappAccounts.wabaId,
            })
            .from(whatsappAccounts)
            .where(eq(whatsappAccounts.tenantId, ctx.tenant.id))
            .orderBy(asc(whatsappAccounts.createdAt)),
        { accessMode: 'read only' },
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name ?? `WhatsApp account ${r.wabaId}`,
        connected: r.status === 'connected',
      }));
    },

    async list(ctx: TenantContext, options: { archived?: boolean } = {}): Promise<FlowListItem[]> {
      assertCan(ctx, 'flows.read');
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: flows.id,
              name: flows.name,
              accountName: sql<string>`coalesce(${whatsappAccounts.name}, 'WhatsApp account ' || ${whatsappAccounts.wabaId})`,
              metaStatus: flows.metaStatus,
              syncState: flows.syncState,
              syncOp: flows.syncOp,
              syncError: flows.syncError,
              validationErrors: sql<number>`jsonb_array_length(${flows.validationErrors})::int`,
              usesEndpoint: sql<boolean>`${flows.dataApiVersion} is not null`,
              flowJson: flows.flowJson,
              uploadedJsonSha256: flows.uploadedJsonSha256,
              sends: sql<number>`(select count(*) from app.flow_sends s where s.tenant_id = ${flows.tenantId} and s.flow_id = ${flows.id})::int`,
              responses: sql<number>`(select count(*) from app.flow_responses r where r.tenant_id = ${flows.tenantId} and r.flow_id = ${flows.id})::int`,
              archivedAt: flows.archivedAt,
              updatedAt: flows.updatedAt,
            })
            .from(flows)
            .innerJoin(
              whatsappAccounts,
              and(
                eq(whatsappAccounts.tenantId, flows.tenantId),
                eq(whatsappAccounts.id, flows.whatsappAccountId),
              ),
            )
            .where(
              and(
                eq(flows.tenantId, ctx.tenant.id),
                options.archived ? isNotNull(flows.archivedAt) : isNull(flows.archivedAt),
              ),
            )
            .orderBy(desc(flows.updatedAt), desc(flows.id))
            .limit(200),
        { accessMode: 'read only' },
      );
      return rows.map(({ flowJson, uploadedJsonSha256, ...r }) => ({
        ...r,
        unsentChanges:
          (r.metaStatus === null || r.metaStatus === 'DRAFT') &&
          uploadedJsonSha256 !== sha256(flowJson),
        archivedAt: r.archivedAt?.toISOString() ?? null,
        updatedAt: r.updatedAt.toISOString(),
      }));
    },

    /** One flow with its Meta state, key status and what the member may do. */
    async get(ctx: TenantContext, id: string) {
      assertCan(ctx, 'flows.read');
      if (!z.uuid().safeParse(id).success) throw notFound('Flow');
      return db.run(
        ctx.scope,
        async (tx) => {
          const [row] = await tx
            .select()
            .from(flows)
            .where(and(eq(flows.tenantId, ctx.tenant.id), eq(flows.id, id)));
          if (!row) throw notFound('Flow');
          const countsRes = await tx.execute<{
            sends: number;
            completed: number;
            responses: number;
          }>(sql`
            select
              (select count(*) from app.flow_sends s
                where s.tenant_id = ${ctx.tenant.id}::uuid and s.flow_id = ${id}::uuid)::int as sends,
              (select count(*) from app.flow_sends s
                where s.tenant_id = ${ctx.tenant.id}::uuid and s.flow_id = ${id}::uuid
                  and s.completed_at is not null)::int as completed,
              (select count(*) from app.flow_responses r
                where r.tenant_id = ${ctx.tenant.id}::uuid and r.flow_id = ${id}::uuid)::int as responses`);
          const counts = countsRes.rows[0];
          const draft = row.metaStatus === null || row.metaStatus === 'DRAFT';
          return {
            flow: {
              ...row,
              unsentChanges: draft && row.uploadedJsonSha256 !== sha256(row.flowJson),
              endpointAddress: row.dataApiVersion
                ? flowEndpointUrl(deps.appBaseUrl, row.publicId)
                : null,
            },
            counts: counts ?? { sends: 0, completed: 0, responses: 0 },
            canEdit: can(ctx, 'flows.write'),
            canPublish: can(ctx, 'flows.publish'),
          };
        },
        { accessMode: 'read only' },
      );
    },

    async create(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'flows.write');
      const data = parseInput(createSchema, input);
      const summary = checked(data.json);
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await db.run(ctx.scope, async (tx) => {
            await connectedAccount(tx, ctx, data.whatsappAccountId);
            const [open] = await tx
              .select({ n: count() })
              .from(flows)
              .where(and(eq(flows.tenantId, ctx.tenant.id), isNull(flows.archivedAt)));
            if ((open?.n ?? 0) >= 200) {
              throw new AppError(
                'conflict',
                'A company can have at most 200 flows; archive some first.',
              );
            }
            const id = uuidv7();
            await tx.insert(flows).values({
              id,
              tenantId: ctx.tenant.id,
              whatsappAccountId: data.whatsappAccountId,
              publicId: newFlowPublicId(),
              name: data.name,
              categories: data.categories,
              flowJson: data.json,
              jsonVersion: summary.version,
              dataApiVersion: summary.dataApiVersion,
              firstScreen: summary.firstScreen,
              answerKeys: summary.answerKeys,
              syncOp: 'create',
              syncState: 'queued',
              syncRequestedAt: deps.clock.now(),
              createdByMembershipId: ctx.membership.id,
            });
            await enqueueSync(tx, ctx, id, 1);
            if (summary.dataApiVersion) await enqueueKeys(tx, ctx, data.whatsappAccountId);
            await recordAudit(
              tx,
              ctx,
              {
                action: 'flow.created',
                subjectType: 'flow',
                subjectId: id,
                metadata: { name: data.name },
              },
              meta,
            );
            return { id };
          });
        } catch (error) {
          if (isUniqueViolation(error, 'flows_public_id_uq') && attempt < 4) continue;
          if (isUniqueViolation(error, 'flows_name_uq')) throw nameTaken();
          throw error;
        }
      }
    },

    /** Changes a draft's name, categories and Flow JSON (and sends them to Meta). */
    async updateDraft(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'flows.write');
      const data = parseInput(versioned.extend(draftSchema.shape), input);
      const summary = checked(data.json);
      try {
        return await db.run(ctx.scope, async (tx) => {
          const row = await lockFlow(tx, ctx, data.id, data.expectedVersion);
          if (row.archivedAt)
            throw new AppError('conflict', 'Restore the flow before changing it.');
          if (row.metaStatus !== null && row.metaStatus !== 'DRAFT') {
            throw new AppError(
              'conflict',
              'A published flow cannot change at Meta. Make a new draft from it instead.',
            );
          }
          notBusy(row);
          const changed =
            row.name !== data.name ||
            row.flowJson !== data.json ||
            row.categories.join(',') !== data.categories.join(',');
          const values = {
            name: data.name,
            categories: data.categories,
            flowJson: data.json,
            jsonVersion: summary.version,
            dataApiVersion: summary.dataApiVersion,
            firstScreen: summary.firstScreen,
            answerKeys: summary.answerKeys,
          };
          // Also sent when Meta does not have the current JSON yet (a failed upload, a restored
          // draft), so saving is always the way to bring Meta up to date.
          const syncing =
            changed || !row.metaFlowId || row.uploadedJsonSha256 !== sha256(data.json);
          let version = row.version;
          if (syncing) {
            version = await requestOp(tx, ctx, row, row.metaFlowId ? 'upload' : 'create', values);
            if (summary.dataApiVersion) await enqueueKeys(tx, ctx, row.whatsappAccountId);
          }
          if (changed) {
            await recordAudit(
              tx,
              ctx,
              {
                action: 'flow.updated',
                subjectType: 'flow',
                subjectId: row.id,
                metadata: { name: data.name },
              },
              meta,
            );
          }
          return { version, syncing };
        });
      } catch (error) {
        if (isUniqueViolation(error, 'flows_name_uq')) throw nameTaken();
        throw error;
      }
    },

    /** Where answers go and the company endpoint (HyFib settings; allowed in any state). */
    async updateSettings(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'flows.write');
      const data = parseInput(settingsSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const row = await lockFlow(tx, ctx, data.id, data.expectedVersion);
        const fieldKeys = new Set(
          (
            await tx
              .select({ key: contactFields.key })
              .from(contactFields)
              .where(eq(contactFields.tenantId, ctx.tenant.id))
          ).map((f) => f.key),
        );
        for (const m of data.mapping) {
          if (m.target.startsWith('field:') && !fieldKeys.has(m.target.slice(6))) {
            throw invalid('mapping', `The contact field “${m.target.slice(6)}” does not exist.`);
          }
        }
        if (data.endpointUrl) {
          let host: string;
          try {
            const target = parseEgressUrl(data.endpointUrl, {
              allowLoopbackForTests: deps.allowInsecureHttp,
            });
            host = target.hostname.toLowerCase();
          } catch (error) {
            if (error instanceof EgressError) throw invalid('endpointUrl', error.message);
            throw error;
          }
          const domains = (
            await tx
              .select({ domain: httpAllowedDomains.domain })
              .from(httpAllowedDomains)
              .where(eq(httpAllowedDomains.tenantId, ctx.tenant.id))
          ).map((d) => d.domain);
          if (!hostAllowed(host, domains)) {
            throw invalid(
              'endpointUrl',
              `${host} is not an allowed domain. Add it in Settings → Web requests first.`,
            );
          }
          if (data.endpointSecretName) {
            const [secret] = await tx
              .select({ domain: httpSecrets.domain })
              .from(httpSecrets)
              .where(
                and(
                  eq(httpSecrets.tenantId, ctx.tenant.id),
                  eq(httpSecrets.name, data.endpointSecretName),
                ),
              );
            if (!secret) throw invalid('endpointSecretName', 'There is no secret with this name.');
            if (!hostAllowed(host, [secret.domain])) {
              throw invalid(
                'endpointSecretName',
                `This secret is saved for ${secret.domain}, not for ${host}.`,
              );
            }
          }
        } else if (data.endpointSecretName) {
          throw invalid('endpointSecretName', 'Set the endpoint address before choosing a secret.');
        }
        const version = row.version + 1;
        await tx
          .update(flows)
          .set({
            answerMapping: data.mapping,
            endpointUrl: data.endpointUrl,
            endpointSecretName: data.endpointSecretName,
            version,
          })
          .where(and(eq(flows.tenantId, ctx.tenant.id), eq(flows.id, row.id)));
        await recordAudit(
          tx,
          ctx,
          {
            action: 'flow.settings_updated',
            subjectType: 'flow',
            subjectId: row.id,
            metadata: {
              answers: data.mapping.length,
              endpoint: data.endpointUrl ? new URL(data.endpointUrl).host : null,
            },
          },
          meta,
        );
        return { version };
      });
    },

    async publish(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'flows.publish');
      const data = parseInput(versioned, input);
      return db.run(ctx.scope, async (tx) => {
        const row = await lockFlow(tx, ctx, data.id, data.expectedVersion);
        notBusy(row);
        if (row.metaStatus !== 'DRAFT' || !row.metaFlowId) {
          throw new AppError('conflict', 'Only a draft that Meta has received can be published.');
        }
        if (row.uploadedJsonSha256 !== sha256(row.flowJson)) {
          throw new AppError('conflict', 'Send the latest changes to Meta before publishing.');
        }
        if (row.validationErrors.length > 0) {
          throw new AppError('conflict', 'Fix the problems Meta found in the Flow JSON first.');
        }
        if (row.dataApiVersion) {
          if (!row.endpointUrl) {
            throw new AppError(
              'conflict',
              'This flow fetches data: set your endpoint address first.',
            );
          }
          const numbers = await tx
            .select({ id: channelAccounts.id })
            .from(channelAccounts)
            .where(
              and(
                eq(channelAccounts.tenantId, ctx.tenant.id),
                eq(channelAccounts.whatsappAccountId, row.whatsappAccountId),
                eq(channelAccounts.status, 'active'),
              ),
            );
          const [key] = await tx
            .select({ id: flowKeys.id })
            .from(flowKeys)
            .where(
              and(
                eq(flowKeys.tenantId, ctx.tenant.id),
                eq(flowKeys.whatsappAccountId, row.whatsappAccountId),
                eq(flowKeys.state, 'active'),
              ),
            );
          const valid = key
            ? await tx
                .select({ channelAccountId: flowKeyUploads.channelAccountId })
                .from(flowKeyUploads)
                .where(
                  and(
                    eq(flowKeyUploads.tenantId, ctx.tenant.id),
                    eq(flowKeyUploads.keyId, key.id),
                    eq(flowKeyUploads.state, 'uploaded'),
                    eq(flowKeyUploads.signatureStatus, 'VALID'),
                  ),
                )
            : [];
          const ready = new Set(valid.map((v) => v.channelAccountId));
          if (numbers.length === 0 || numbers.some((n) => !ready.has(n.id))) {
            throw new AppError(
              'conflict',
              'This flow fetches data: the encryption key must be uploaded to every number of the account first.',
            );
          }
        }
        const version = await requestOp(tx, ctx, row, 'publish');
        await recordAudit(
          tx,
          ctx,
          {
            action: 'flow.publish_requested',
            subjectType: 'flow',
            subjectId: row.id,
            metadata: { name: row.name },
          },
          meta,
        );
        return { version };
      });
    },

    async deprecate(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'flows.publish');
      const data = parseInput(versioned, input);
      return db.run(ctx.scope, async (tx) => {
        const row = await lockFlow(tx, ctx, data.id, data.expectedVersion);
        notBusy(row);
        if (
          row.metaStatus !== 'PUBLISHED' &&
          row.metaStatus !== 'BLOCKED' &&
          row.metaStatus !== 'THROTTLED'
        ) {
          throw new AppError('conflict', 'Only a published flow can be deprecated.');
        }
        const version = await requestOp(tx, ctx, row, 'deprecate');
        await recordAudit(
          tx,
          ctx,
          {
            action: 'flow.deprecate_requested',
            subjectType: 'flow',
            subjectId: row.id,
            metadata: { name: row.name },
          },
          meta,
        );
        return { version };
      });
    },

    /** Deletes a draft (at Meta too, when Meta has it); published flows are deprecated instead. */
    async remove(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'flows.write');
      const data = parseInput(versioned, input);
      return db.run(ctx.scope, async (tx) => {
        const row = await lockFlow(tx, ctx, data.id, data.expectedVersion);
        notBusy(row);
        let version: number;
        if (!row.metaFlowId) {
          version = row.version + 1;
          await tx
            .update(flows)
            .set({
              archivedAt: deps.clock.now(),
              syncOp: null,
              syncState: 'idle',
              syncError: null,
              version,
            })
            .where(and(eq(flows.tenantId, ctx.tenant.id), eq(flows.id, row.id)));
        } else if (row.metaStatus === 'DRAFT') {
          version = await requestOp(tx, ctx, row, 'delete');
        } else {
          throw new AppError(
            'conflict',
            'Only drafts can be deleted; deprecate a published flow instead.',
          );
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'flow.deleted',
            subjectType: 'flow',
            subjectId: row.id,
            metadata: { name: row.name },
          },
          meta,
        );
        return { version };
      });
    },

    /** Reads the flow's status, health and preview from Meta again. */
    async refresh(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'flows.write');
      const data = parseInput(versioned, input);
      return db.run(ctx.scope, async (tx) => {
        const row = await lockFlow(tx, ctx, data.id, data.expectedVersion);
        notBusy(row);
        if (!row.metaFlowId) throw new AppError('conflict', 'Meta does not have this flow yet.');
        return { version: await requestOp(tx, ctx, row, 'refresh') };
      });
    },

    /** Tries a failed operation again. */
    async retry(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'flows.write');
      const data = parseInput(versioned, input);
      return db.run(ctx.scope, async (tx) => {
        const row = await lockFlow(tx, ctx, data.id, data.expectedVersion);
        if (row.syncState !== 'failed' || !row.syncOp) {
          throw new AppError('conflict', 'Nothing is waiting to be tried again.');
        }
        if (row.syncOp === 'publish' || row.syncOp === 'deprecate') assertCan(ctx, 'flows.publish');
        return { version: await requestOp(tx, ctx, row, row.syncOp) };
      });
    },

    /** A new draft with the same content (the way to change a published flow). */
    async duplicate(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'flows.write');
      const data = parseInput(idSchema, input);
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await db.run(ctx.scope, async (tx) => {
            const source = await lockFlow(tx, ctx, data.id);
            await connectedAccount(tx, ctx, source.whatsappAccountId);
            const id = uuidv7();
            const name = `${source.name.slice(0, FLOW_LIMITS.nameLength - 10)} (new ${attempt + 1})`;
            await tx.insert(flows).values({
              id,
              tenantId: ctx.tenant.id,
              whatsappAccountId: source.whatsappAccountId,
              publicId: newFlowPublicId(),
              name,
              categories: source.categories,
              flowJson: source.flowJson,
              jsonVersion: source.jsonVersion,
              dataApiVersion: source.dataApiVersion,
              firstScreen: source.firstScreen,
              answerKeys: source.answerKeys,
              answerMapping: source.answerMapping,
              endpointUrl: source.endpointUrl,
              endpointSecretName: source.endpointSecretName,
              derivedFromFlowId: source.id,
              syncOp: 'create',
              syncState: 'queued',
              syncRequestedAt: deps.clock.now(),
              createdByMembershipId: ctx.membership.id,
            });
            await enqueueSync(tx, ctx, id, 1);
            await recordAudit(
              tx,
              ctx,
              {
                action: 'flow.created',
                subjectType: 'flow',
                subjectId: id,
                metadata: { name, from: source.id },
              },
              meta,
            );
            return { id };
          });
        } catch (error) {
          if (
            (isUniqueViolation(error, 'flows_public_id_uq') ||
              isUniqueViolation(error, 'flows_name_uq')) &&
            attempt < 4
          ) {
            continue;
          }
          throw error;
        }
      }
    },

    /** Hides a flow from the list (drafts are deleted instead; deprecated flows can be archived). */
    async setArchived(
      ctx: TenantContext,
      input: unknown,
      archived: boolean,
      meta: RequestMeta = {},
    ) {
      assertCan(ctx, 'flows.write');
      const data = parseInput(versioned, input);
      try {
        return await db.run(ctx.scope, async (tx) => {
          const row = await lockFlow(tx, ctx, data.id, data.expectedVersion);
          notBusy(row);
          if (Boolean(row.archivedAt) === archived) return { version: row.version };
          // A delete that failed because Meta no longer has the flow can be settled by archiving.
          const failedDelete = row.syncState === 'failed' && row.syncOp === 'delete';
          if (
            archived &&
            !failedDelete &&
            row.metaStatus !== 'DEPRECATED' &&
            row.metaStatus !== null
          ) {
            throw new AppError(
              'conflict',
              'Deprecate a published flow, or delete a draft, instead of archiving it.',
            );
          }
          const version = row.version + 1;
          await tx
            .update(flows)
            .set({
              archivedAt: archived ? deps.clock.now() : null,
              version,
              ...(archived && failedDelete
                ? {
                    metaFlowId: null,
                    metaStatus: null,
                    syncOp: null,
                    syncState: 'idle' as const,
                    syncError: null,
                  }
                : {}),
            })
            .where(and(eq(flows.tenantId, ctx.tenant.id), eq(flows.id, row.id)));
          await recordAudit(
            tx,
            ctx,
            {
              action: archived ? 'flow.archived' : 'flow.restored',
              subjectType: 'flow',
              subjectId: row.id,
              metadata: { name: row.name },
            },
            meta,
          );
          return { version };
        });
      } catch (error) {
        if (isUniqueViolation(error, 'flows_name_uq')) throw nameTaken();
        throw error;
      }
    },

    /** The account's flow encryption key and where it has been uploaded. */
    async keyStatus(ctx: TenantContext, whatsappAccountId: string) {
      assertCan(ctx, 'flows.read');
      if (!z.uuid().safeParse(whatsappAccountId).success) throw notFound('WhatsApp account');
      return db.run(
        ctx.scope,
        async (tx) => {
          const keys = await tx
            .select({
              id: flowKeys.id,
              state: flowKeys.state,
              fingerprint: flowKeys.fingerprint,
              createdAt: flowKeys.createdAt,
              replacedAt: flowKeys.replacedAt,
            })
            .from(flowKeys)
            .where(
              and(
                eq(flowKeys.tenantId, ctx.tenant.id),
                eq(flowKeys.whatsappAccountId, whatsappAccountId),
                inArray(flowKeys.state, ['active', 'previous']),
              ),
            );
          const active = keys.find((k) => k.state === 'active') ?? null;
          const numbers = await tx
            .select({
              id: channelAccounts.id,
              name: sql<string>`coalesce(${channelAccounts.verifiedName}, ${channelAccounts.displayPhoneNumber}, ${channelAccounts.phoneNumberId})`,
              status: channelAccounts.status,
              uploadState: flowKeyUploads.state,
              signatureStatus: flowKeyUploads.signatureStatus,
              errorCode: flowKeyUploads.errorCode,
              checkedAt: flowKeyUploads.checkedAt,
            })
            .from(channelAccounts)
            .leftJoin(
              flowKeyUploads,
              and(
                eq(flowKeyUploads.tenantId, channelAccounts.tenantId),
                eq(flowKeyUploads.channelAccountId, channelAccounts.id),
                eq(flowKeyUploads.keyId, active?.id ?? '00000000-0000-0000-0000-000000000000'),
              ),
            )
            .where(
              and(
                eq(channelAccounts.tenantId, ctx.tenant.id),
                eq(channelAccounts.whatsappAccountId, whatsappAccountId),
              ),
            )
            .orderBy(asc(channelAccounts.createdAt));
          return {
            active: active
              ? { fingerprint: active.fingerprint, createdAt: active.createdAt.toISOString() }
              : null,
            previous: keys.some((k) => k.state === 'previous'),
            numbers: numbers.map((n) => ({
              ...n,
              active: n.status === 'active',
              checkedAt: n.checkedAt?.toISOString() ?? null,
            })),
          };
        },
        { accessMode: 'read only' },
      );
    },

    /** Generates the account's key if needed and uploads it to numbers that do not have it. */
    async setupKeys(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'flows.write');
      const data = parseInput(z.object({ whatsappAccountId: z.uuid() }), input);
      return db.run(ctx.scope, async (tx) => {
        await connectedAccount(tx, ctx, data.whatsappAccountId);
        // Failed uploads are tried again from scratch.
        await tx
          .update(flowKeyUploads)
          .set({ state: 'pending', attempts: 0, errorCode: null })
          .where(
            and(
              eq(flowKeyUploads.tenantId, ctx.tenant.id),
              eq(flowKeyUploads.state, 'failed'),
              inArray(
                flowKeyUploads.keyId,
                tx
                  .select({ id: flowKeys.id })
                  .from(flowKeys)
                  .where(
                    and(
                      eq(flowKeys.tenantId, ctx.tenant.id),
                      eq(flowKeys.whatsappAccountId, data.whatsappAccountId),
                      eq(flowKeys.state, 'active'),
                    ),
                  ),
              ),
            ),
          );
        await enqueueKeys(tx, ctx, data.whatsappAccountId);
        await recordAudit(
          tx,
          ctx,
          {
            action: 'flow.keys_requested',
            subjectType: 'whatsapp_account',
            subjectId: data.whatsappAccountId,
            metadata: {},
          },
          meta,
        );
        return { ok: true as const };
      });
    },

    /**
     * Replaces the account's key: the current one keeps opening requests for 24 hours while
     * WhatsApp clients pick up the new one, then it is retired and its private key deleted.
     */
    async rotateKey(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'flows.publish');
      const data = parseInput(z.object({ whatsappAccountId: z.uuid() }), input);
      return db.run(ctx.scope, async (tx) => {
        await connectedAccount(tx, ctx, data.whatsappAccountId);
        const now = deps.clock.now();
        const account = and(
          eq(flowKeys.tenantId, ctx.tenant.id),
          eq(flowKeys.whatsappAccountId, data.whatsappAccountId),
        );
        const [active] = await tx
          .select({ id: flowKeys.id })
          .from(flowKeys)
          .where(and(account, eq(flowKeys.state, 'active')))
          .for('update');
        if (!active)
          throw new AppError('conflict', 'This account has no flow key yet: set one up first.');
        await tx
          .update(flowKeys)
          .set({ state: 'retired', privateKeyCiphertext: null, retiredAt: now })
          .where(and(account, eq(flowKeys.state, 'previous')));
        await tx
          .update(flowKeys)
          .set({ state: 'previous', replacedAt: now })
          .where(and(account, eq(flowKeys.id, active.id)));
        await enqueueKeys(tx, ctx, data.whatsappAccountId);
        await recordAudit(
          tx,
          ctx,
          {
            action: 'flow.key_rotated',
            subjectType: 'whatsapp_account',
            subjectId: data.whatsappAccountId,
            metadata: {},
          },
          meta,
        );
        return { ok: true as const };
      });
    },

    /** Forms that can be sent in a conversation (drafts only to members who edit flows, for testing). */
    async sendable(ctx: TenantContext, conversationId: string) {
      assertCan(ctx, 'inbox.reply');
      if (!can(ctx, 'flows.read') || !z.uuid().safeParse(conversationId).success) return [];
      return db.run(
        ctx.scope,
        async (tx) => {
          const [conv] = await tx
            .select({ whatsappAccountId: channelAccounts.whatsappAccountId })
            .from(conversations)
            .innerJoin(
              channelAccounts,
              and(
                eq(channelAccounts.tenantId, conversations.tenantId),
                eq(channelAccounts.id, conversations.channelAccountId),
              ),
            )
            .where(
              and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversationId)),
            );
          if (!conv) return [];
          const rows = await tx
            .select({
              id: flows.id,
              name: flows.name,
              metaStatus: flows.metaStatus,
              flowJson: flows.flowJson,
              uploadedJsonSha256: flows.uploadedJsonSha256,
              validationErrors: sql<number>`jsonb_array_length(${flows.validationErrors})::int`,
            })
            .from(flows)
            .where(
              and(
                eq(flows.tenantId, ctx.tenant.id),
                eq(flows.whatsappAccountId, conv.whatsappAccountId),
                isNull(flows.archivedAt),
                isNotNull(flows.metaFlowId),
              ),
            )
            .orderBy(asc(flows.name));
          const tester = can(ctx, 'flows.write');
          return rows.flatMap((r): { id: string; name: string; mode: 'published' | 'draft' }[] => {
            if (r.metaStatus && SENDABLE_STATUSES.includes(r.metaStatus)) {
              return [{ id: r.id, name: r.name, mode: 'published' as const }];
            }
            if (
              tester &&
              r.metaStatus === 'DRAFT' &&
              r.validationErrors === 0 &&
              r.uploadedJsonSha256 === sha256(r.flowJson)
            ) {
              return [{ id: r.id, name: `${r.name} (draft, for testing)`, mode: 'draft' as const }];
            }
            return [];
          });
        },
        { accessMode: 'read only' },
      );
    },

    /** Sends a form in a conversation (a reply: the customer service window must be open). */
    async send(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'inbox.reply');
      assertModule(ctx.plan, 'flows');
      const data = parseInput(sendSchema, input);
      if (data.mode === 'draft') assertCan(ctx, 'flows.write');
      const now = deps.clock.now();
      return db.run(ctx.scope, async (tx) => {
        const [existing] = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.tenantId, ctx.tenant.id), eq(messages.clientKey, data.clientKey)));
        if (existing) return { messageId: existing.id, duplicate: true };
        const [conv] = await tx
          .select({
            id: conversations.id,
            assignedMembershipId: conversations.assignedMembershipId,
            lastInboundAt: conversations.lastInboundAt,
            channelAccountId: conversations.channelAccountId,
            contactId: conversations.contactId,
          })
          .from(conversations)
          .where(
            and(
              eq(conversations.tenantId, ctx.tenant.id),
              eq(conversations.id, data.conversationId),
            ),
          )
          .for('update');
        if (!conv || !canSeeConversation(ctx, conv.assignedMembershipId))
          throw notFound('Conversation');
        const [channel] = await tx
          .select({
            status: channelAccounts.status,
            whatsappAccountId: channelAccounts.whatsappAccountId,
          })
          .from(channelAccounts)
          .where(
            and(
              eq(channelAccounts.tenantId, ctx.tenant.id),
              eq(channelAccounts.id, conv.channelAccountId),
            ),
          );
        if (!channel || channel.status !== 'active') {
          throw new AppError(
            'precondition_failed',
            'This WhatsApp number is not active. Reconnect it in Settings → Channels.',
          );
        }
        if (
          !conv.lastInboundAt ||
          now.getTime() - conv.lastInboundAt.getTime() > SERVICE_WINDOW_MS
        ) {
          throw new AppError(
            'precondition_failed',
            'The 24-hour customer service window has closed. Forms can be sent only while it is open.',
          );
        }
        const [flow] = await tx
          .select({
            id: flows.id,
            name: flows.name,
            whatsappAccountId: flows.whatsappAccountId,
            metaFlowId: flows.metaFlowId,
            metaStatus: flows.metaStatus,
            archivedAt: flows.archivedAt,
          })
          .from(flows)
          .where(and(eq(flows.tenantId, ctx.tenant.id), eq(flows.id, data.flowId)));
        if (
          !flow ||
          flow.archivedAt ||
          flow.whatsappAccountId !== channel.whatsappAccountId ||
          !flow.metaFlowId
        ) {
          throw invalid('flowId', 'Choose a form of this WhatsApp account.');
        }
        const sendable =
          data.mode === 'published'
            ? flow.metaStatus !== null && SENDABLE_STATUSES.includes(flow.metaStatus)
            : flow.metaStatus === 'DRAFT';
        if (!sendable) {
          throw invalid(
            'flowId',
            data.mode === 'published'
              ? 'This form is not published.'
              : 'Only a draft can be sent for testing.',
          );
        }
        const [identity] = await tx
          .select({ waId: contactIdentities.waId })
          .from(contactIdentities)
          .where(
            and(
              eq(contactIdentities.tenantId, ctx.tenant.id),
              eq(contactIdentities.contactId, conv.contactId),
              eq(contactIdentities.whatsappAccountId, channel.whatsappAccountId),
            ),
          )
          .limit(1);
        if (!identity?.waId) {
          throw new AppError(
            'unsupported',
            'This contact is known only by a WhatsApp user id. Sending to user ids is not enabled until Meta’s request format is verified.',
          );
        }
        await endRunForHuman(tx, {
          tenantId: ctx.tenant.id,
          conversationId: conv.id,
          reason: 'agent_replied',
          actorMembershipId: ctx.membership.id,
          now,
        });
        const messageId = uuidv7();
        const intentId = uuidv7();
        const token = newFlowToken();
        const message = {
          header: data.header,
          body: data.body,
          footer: data.footer,
          cta: data.cta,
        };
        await tx.insert(messages).values({
          id: messageId,
          tenantId: ctx.tenant.id,
          conversationId: conv.id,
          channelAccountId: conv.channelAccountId,
          direction: 'outbound',
          type: 'interactive',
          content: { flow: { id: flow.id, name: flow.name, mode: data.mode, ...message } },
          status: 'queued',
          statusRank: STATUS_RANK.queued,
          senderType: 'agent',
          senderMembershipId: ctx.membership.id,
          clientKey: data.clientKey,
        });
        await tx.insert(sendIntents).values({
          id: intentId,
          tenantId: ctx.tenant.id,
          messageId,
          channelAccountId: conv.channelAccountId,
          request: buildFlowMessageRequest(identity.waId, message, {
            metaFlowId: flow.metaFlowId,
            token,
            mode: data.mode,
          }),
          actorUserId: ctx.user.id,
        });
        await tx.insert(flowSends).values({
          id: uuidv7(),
          tenantId: ctx.tenant.id,
          flowId: flow.id,
          conversationId: conv.id,
          contactId: conv.contactId,
          messageId,
          token,
          mode: data.mode,
          sentByMembershipId: ctx.membership.id,
          expiresAt: new Date(now.getTime() + FLOW_TOKEN_DAYS * 86_400_000),
        });
        const claim = conv.assignedMembershipId === null;
        await tx
          .update(conversations)
          .set({
            lastMessageAt: now,
            lastMessagePreview: clipText(`[Form] ${flow.name}`, 200),
            unreadCount: 0,
            status: 'open',
            ...(claim ? { assignedMembershipId: ctx.membership.id } : {}),
            version: sql`${conversations.version} + 1`,
          })
          .where(and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conv.id)));
        await emitTenantEvent(tx, ctx.tenant.id, {
          type: 'message.created',
          conversationId: conv.id,
          assignedMembershipId: claim ? ctx.membership.id : conv.assignedMembershipId,
          payload: { messageId },
        });
        await deps.jobs.enqueue(
          tx,
          QUEUES.messageSend.name,
          deps.signer.sign({
            kind: 'message.send',
            tenantId: ctx.tenant.id,
            actorUserId: ctx.user.id,
            ref: intentId,
          }),
          { singletonKey: intentId, group: { id: conv.channelAccountId } },
        );
        return { messageId, duplicate: false };
      });
    },

    /**
     * Completed forms of a flow, newest first. Answers and contact names are shown only to members
     * who can read contacts; others see when forms were completed and what was applied.
     */
    async responses(ctx: TenantContext, flowId: string, options: { before?: string } = {}) {
      assertCan(ctx, 'flows.read');
      if (!z.uuid().safeParse(flowId).success) throw notFound('Flow');
      const withAnswers = can(ctx, 'contacts.read');
      const before =
        options.before && !Number.isNaN(Date.parse(options.before))
          ? new Date(options.before)
          : null;
      const rows = await db.run(
        ctx.scope,
        (tx) =>
          tx
            .select({
              id: flowResponses.id,
              receivedAt: flowResponses.receivedAt,
              answers: flowResponses.answers,
              applied: flowResponses.applied,
              contactId: flowResponses.contactId,
              conversationId: flowResponses.conversationId,
              contactName: contacts.displayName,
              contactErased: sql<boolean>`${contacts.erasedAt} is not null`,
            })
            .from(flowResponses)
            .innerJoin(
              contacts,
              and(
                eq(contacts.tenantId, flowResponses.tenantId),
                eq(contacts.id, flowResponses.contactId),
              ),
            )
            .where(
              and(
                eq(flowResponses.tenantId, ctx.tenant.id),
                eq(flowResponses.flowId, flowId),
                before ? lt(flowResponses.receivedAt, before) : undefined,
              ),
            )
            .orderBy(desc(flowResponses.receivedAt), desc(flowResponses.id))
            .limit(51),
        { accessMode: 'read only' },
      );
      const page = rows.slice(0, 50);
      const last = page.at(-1);
      return {
        withAnswers,
        responses: page.map((r) => ({
          id: r.id,
          receivedAt: r.receivedAt.toISOString(),
          applied: r.applied as FlowAnswerOutcome[],
          ...(withAnswers
            ? {
                answers: r.answers,
                contactId: r.contactId,
                conversationId: r.conversationId,
                contactName: r.contactErased ? 'Erased contact' : r.contactName,
              }
            : {}),
        })),
        older: rows.length > 50 && last ? last.receivedAt.toISOString() : null,
      };
    },
  };
}

export type FlowsService = ReturnType<typeof createFlowsService>;
