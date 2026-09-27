import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, forbidden, notFound, uuidv7, type Clock } from '@w360/core';
import {
  and,
  asc,
  automationRunSteps,
  automationRuns,
  automationVersions,
  automations,
  channelAccounts,
  contactFields,
  conversations,
  desc,
  eq,
  gte,
  inArray,
  memberships,
  ne,
  sql,
  teams,
  users,
  type AutomationStatus,
  type Database,
  type Tx,
} from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { recordAudit, type RequestMeta } from '../audit';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { emitTenantEvent } from '../messaging/events';
import { canSeeConversation, SERVICE_WINDOW_MS } from '../messaging/outbound';
import { parseInput } from '../validation';
import {
  canonicalJson,
  checkGraph,
  describeTrigger,
  parseGraph,
  parseTrigger,
  starterGraph,
  starterTrigger,
  type AutomationGraph,
  type AutomationTrigger,
  type GraphIssue,
} from './graph';
import { appendRunStep, endRun, endRunForHuman, lockActiveRun, signalAutomationRun } from './runs';

/**
 * Automations for the web tier. Drafts are edited freely (`automations.write`); publishing
 * (`automations.publish`) checks the draft and freezes it into a numbered, immutable version that
 * new runs use, while runs in progress keep the version they started with. Pausing stops new runs;
 * archiving also stops runs in progress. Test runs execute a snapshot of the draft on a
 * conversation the member can see, sending real messages there.
 */
export interface AutomationServiceDeps {
  db: Database;
  clock: Clock;
  jobs: JobQueue;
  signer: JobSigner;
}

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Name the automation.')
  .max(80, 'Names are limited to 80 characters.');
const descriptionSchema = z
  .string()
  .trim()
  .max(300, 'Descriptions are limited to 300 characters.')
  .nullable()
  .transform((v) => (v ? v : null));

const createSchema = z.object({ name: nameSchema, description: descriptionSchema.default(null) });
const idSchema = z.object({ id: z.uuid(), expectedVersion: z.number().int().min(0) });
const updateSchema = idSchema.extend({
  name: nameSchema,
  description: descriptionSchema,
  channelAccountId: z.uuid().nullable(),
  trigger: z.unknown(),
  graph: z.unknown(),
});
const publishSchema = idSchema.extend({
  note: z
    .string()
    .trim()
    .max(300, 'Notes are limited to 300 characters.')
    .nullable()
    .transform((v) => (v ? v : null)),
});
const statusSchema = idSchema.extend({ status: z.enum(['active', 'paused']) });
const testRunSchema = idSchema.extend({ conversationId: z.uuid() });
const listRunsSchema = z.object({
  automationId: z.uuid().optional(),
  status: z
    .enum(['active', 'completed', 'handed_off', 'taken_over', 'stopped', 'failed'])
    .optional(),
  cursor: z.string().max(200).optional(),
});

export interface AutomationSummary {
  id: string;
  name: string;
  description: string | null;
  status: AutomationStatus;
  trigger: string | null;
  channelName: string | null;
  activeVersion: number | null;
  draftChanged: boolean;
  updatedAt: string;
  activeRuns: number;
  runsLast7Days: number;
}

export interface AutomationDetail {
  id: string;
  name: string;
  description: string | null;
  status: AutomationStatus;
  version: number;
  draft: {
    trigger: AutomationTrigger | null;
    graph: AutomationGraph | null;
    channelAccountId: string | null;
    updatedAt: string;
    updatedByName: string | null;
  };
  issues: GraphIssue[];
  draftChanged: boolean;
  activeVersion: { id: string; number: number; createdAt: string } | null;
  versions: {
    id: string;
    number: number;
    note: string | null;
    createdAt: string;
    createdByName: string | null;
    active: boolean;
  }[];
  options: {
    channels: { id: string; name: string; active: boolean }[];
    teams: { id: string; name: string }[];
    fields: { key: string; label: string; type: string }[];
  };
}

export interface RunSummary {
  id: string;
  automationId: string;
  automationName: string;
  versionNumber: number | null;
  mode: 'live' | 'test';
  status: string;
  endReason: string | null;
  triggerType: string;
  startedAt: string;
  endedAt: string | null;
  steps: number;
  messages: number;
  /** Present when the member can open the conversation. */
  conversationId: string | null;
}

export interface RunDetail extends RunSummary {
  currentNodeId: string | null;
  waitingFor: 'reply' | 'timer' | null;
  waitUntil: string | null;
  endDetail: string | null;
  endedByName: string | null;
  startedByName: string | null;
  graph: AutomationGraph | null;
  /** Answers the run captured; only for members who can see the conversation. */
  variables: Record<string, string> | null;
  log: {
    seq: number;
    nodeId: string | null;
    nodeType: string | null;
    outcome: string;
    branch: string | null;
    detail: string | null;
    messageId: string | null;
    createdAt: string;
  }[];
}

export interface ConversationAutomationState {
  runId: string;
  automationId: string;
  automationName: string;
  mode: 'live' | 'test';
  status: 'running' | 'waiting';
  waitingFor: 'reply' | 'timer' | null;
  waitUntil: string | null;
  startedAt: string;
}

function definitionSha(input: {
  trigger: unknown;
  graph: unknown;
  channelAccountId: string | null;
}): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime()) || !id || !z.uuid().safeParse(id).success) {
    throw new AppError('validation_failed', 'Invalid cursor.');
  }
  return { at, id };
}

const RUN_PAGE = 50;

/** The active run of a conversation, for the inbox. */
export async function automationStateForConversation(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<ConversationAutomationState | null> {
  const [row] = await tx
    .select({
      runId: automationRuns.id,
      automationId: automationRuns.automationId,
      automationName: automations.name,
      mode: automationRuns.mode,
      status: automationRuns.status,
      waitingFor: automationRuns.waitingFor,
      waitUntil: automationRuns.waitUntil,
      startedAt: automationRuns.startedAt,
    })
    .from(automationRuns)
    .innerJoin(
      automations,
      and(
        eq(automations.tenantId, automationRuns.tenantId),
        eq(automations.id, automationRuns.automationId),
      ),
    )
    .where(
      and(
        eq(automationRuns.tenantId, tenantId),
        eq(automationRuns.conversationId, conversationId),
        inArray(automationRuns.status, ['running', 'waiting']),
      ),
    );
  if (!row) return null;
  return {
    runId: row.runId,
    automationId: row.automationId,
    automationName: row.automationName,
    mode: row.mode,
    status: row.status as 'running' | 'waiting',
    waitingFor: row.waitingFor,
    waitUntil: row.waitUntil?.toISOString() ?? null,
    startedAt: row.startedAt.toISOString(),
  };
}

export function createAutomationService(deps: AutomationServiceDeps) {
  const { db, clock } = deps;

  const stale = () =>
    new AppError(
      'conflict',
      'Someone else changed this automation. Reload to see the latest version, then try again.',
    );

  async function lockAutomation(tx: Tx, ctx: TenantContext, id: string, expectedVersion?: number) {
    const [row] = await tx
      .select()
      .from(automations)
      .where(and(eq(automations.tenantId, ctx.tenant.id), eq(automations.id, id)))
      .for('update');
    if (!row) throw notFound('Automation');
    if (expectedVersion !== undefined && row.version !== expectedVersion) throw stale();
    return row;
  }

  async function references(tx: Tx, tenantId: string) {
    const teamRows = await tx
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(eq(teams.tenantId, tenantId))
      .orderBy(asc(sql`lower(${teams.name})`));
    const fieldRows = await tx
      .select({ key: contactFields.key, label: contactFields.label, type: contactFields.type })
      .from(contactFields)
      .where(eq(contactFields.tenantId, tenantId))
      .orderBy(asc(contactFields.label));
    return { teamRows, fieldRows };
  }

  /** Parses and checks a draft; throws when it cannot be run. */
  async function runnableDraft(tx: Tx, row: typeof automations.$inferSelect) {
    const trigger = parseTrigger(row.draftTrigger);
    const graph = parseGraph(row.draftGraph);
    if (!trigger.ok) throw new AppError('precondition_failed', trigger.message);
    if (!graph.ok) {
      throw new AppError(
        'precondition_failed',
        graph.issues[0]?.message ?? 'The steps are not valid.',
      );
    }
    const { teamRows, fieldRows } = await references(tx, row.tenantId);
    const errors = checkGraph(graph.graph, {
      teamIds: new Set(teamRows.map((t) => t.id)),
      fieldKeys: new Set(fieldRows.map((f) => f.key)),
    }).filter((i) => i.level === 'error');
    if (errors.length > 0) {
      throw new AppError(
        'precondition_failed',
        `Fix the automation first: ${errors[0]?.message ?? 'it has errors.'}`,
        { details: { errors: errors.length } },
      );
    }
    if (row.draftChannelAccountId) {
      const [channel] = await tx
        .select({ id: channelAccounts.id })
        .from(channelAccounts)
        .where(
          and(
            eq(channelAccounts.tenantId, row.tenantId),
            eq(channelAccounts.id, row.draftChannelAccountId),
          ),
        );
      if (!channel) throw new AppError('precondition_failed', 'Choose a WhatsApp number again.');
    }
    return { trigger: trigger.trigger, graph: graph.graph };
  }

  async function stopRunsOfAutomation(
    tx: Tx,
    ctx: TenantContext,
    automationId: string,
    now: Date,
  ): Promise<number> {
    const active = await tx
      .select({ id: automationRuns.id, conversationId: automationRuns.conversationId })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.tenantId, ctx.tenant.id),
          eq(automationRuns.automationId, automationId),
          inArray(automationRuns.status, ['running', 'waiting']),
        ),
      )
      .orderBy(asc(automationRuns.conversationId));
    let stopped = 0;
    for (const item of active) {
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, item.conversationId)),
        )
        .for('update');
      const run = await lockActiveRun(tx, ctx.tenant.id, item.conversationId);
      if (!run || run.id !== item.id) continue;
      await appendRunStep(tx, ctx.tenant.id, run.id, {
        nodeId: run.currentNodeId,
        nodeType: null,
        outcome: 'stopped',
        detail: 'automation_archived',
      });
      await endRun(tx, run, {
        status: 'stopped',
        reason: 'automation_archived',
        endedByMembershipId: ctx.membership.id,
        now,
      });
      stopped += 1;
    }
    return stopped;
  }

  return {
    async listAutomations(
      ctx: TenantContext,
      input: { includeArchived?: boolean } = {},
    ): Promise<AutomationSummary[]> {
      assertCan(ctx, 'automations.read');
      const since = new Date(clock.now().getTime() - 7 * 86_400_000);
      return db.run(
        ctx.scope,
        async (tx) => {
          const rows = await tx
            .select({
              id: automations.id,
              name: automations.name,
              description: automations.description,
              status: automations.status,
              draftTrigger: automations.draftTrigger,
              draftGraph: automations.draftGraph,
              draftChannelAccountId: automations.draftChannelAccountId,
              updatedAt: automations.updatedAt,
              activeNumber: automationVersions.number,
              activeTrigger: automationVersions.trigger,
              activeSha: automationVersions.definitionSha256,
              activeChannelId: automationVersions.channelAccountId,
              channelName: sql<
                string | null
              >`coalesce(${channelAccounts.verifiedName}, ${channelAccounts.displayPhoneNumber})`,
              activeRuns: sql<number>`(select count(*)::int from app.automation_runs r
                 where r.tenant_id = ${automations.tenantId} and r.automation_id = ${automations.id}
                   and r.status in ('running', 'waiting'))`,
              recentRuns: sql<number>`(select count(*)::int from app.automation_runs r
                 where r.tenant_id = ${automations.tenantId} and r.automation_id = ${automations.id}
                   and r.mode = 'live' and r.started_at >= ${since.toISOString()}::timestamptz)`,
            })
            .from(automations)
            .leftJoin(
              automationVersions,
              and(
                eq(automationVersions.tenantId, automations.tenantId),
                eq(automationVersions.id, automations.activeVersionId),
              ),
            )
            .leftJoin(
              channelAccounts,
              and(
                eq(channelAccounts.tenantId, automations.tenantId),
                eq(
                  channelAccounts.id,
                  sql`coalesce(${automationVersions.channelAccountId}, ${automations.draftChannelAccountId})`,
                ),
              ),
            )
            .where(
              and(
                eq(automations.tenantId, ctx.tenant.id),
                input.includeArchived ? undefined : ne(automations.status, 'archived'),
              ),
            )
            .orderBy(asc(sql`lower(${automations.name})`), asc(automations.id));
          return rows.map((r) => {
            const live = parseTrigger(r.activeTrigger ?? r.draftTrigger);
            const draftSha = definitionSha({
              trigger: r.draftTrigger,
              graph: r.draftGraph,
              channelAccountId: r.draftChannelAccountId,
            });
            return {
              id: r.id,
              name: r.name,
              description: r.description,
              status: r.status,
              trigger: live.ok ? describeTrigger(live.trigger) : null,
              channelName: r.channelName,
              activeVersion: r.activeNumber,
              draftChanged: r.activeSha !== null && r.activeSha !== draftSha,
              updatedAt: r.updatedAt.toISOString(),
              activeRuns: r.activeRuns,
              runsLast7Days: r.recentRuns,
            };
          });
        },
        { accessMode: 'read only' },
      );
    },

    async getAutomation(ctx: TenantContext, id: string): Promise<AutomationDetail> {
      assertCan(ctx, 'automations.read');
      if (!z.uuid().safeParse(id).success) throw notFound('Automation');
      return db.run(
        ctx.scope,
        async (tx) => {
          const [row] = await tx
            .select({
              automation: automations,
              updatedByName: users.name,
            })
            .from(automations)
            .leftJoin(
              memberships,
              and(
                eq(memberships.tenantId, automations.tenantId),
                eq(memberships.id, automations.draftUpdatedByMembershipId),
              ),
            )
            .leftJoin(users, eq(users.id, memberships.userId))
            .where(and(eq(automations.tenantId, ctx.tenant.id), eq(automations.id, id)));
          if (!row) throw notFound('Automation');
          const a = row.automation;
          const versions = await tx
            .select({
              id: automationVersions.id,
              number: automationVersions.number,
              note: automationVersions.note,
              createdAt: automationVersions.createdAt,
              sha: automationVersions.definitionSha256,
              createdByName: users.name,
            })
            .from(automationVersions)
            .leftJoin(
              memberships,
              and(
                eq(memberships.tenantId, automationVersions.tenantId),
                eq(memberships.id, automationVersions.createdByMembershipId),
              ),
            )
            .leftJoin(users, eq(users.id, memberships.userId))
            .where(
              and(
                eq(automationVersions.tenantId, ctx.tenant.id),
                eq(automationVersions.automationId, a.id),
                eq(automationVersions.kind, 'published'),
              ),
            )
            .orderBy(desc(automationVersions.number));
          const channels = await tx
            .select({
              id: channelAccounts.id,
              name: sql<string>`coalesce(${channelAccounts.verifiedName}, ${channelAccounts.displayPhoneNumber}, ${channelAccounts.phoneNumberId})`,
              status: channelAccounts.status,
            })
            .from(channelAccounts)
            .where(eq(channelAccounts.tenantId, ctx.tenant.id))
            .orderBy(asc(channelAccounts.createdAt));
          const { teamRows, fieldRows } = await references(tx, ctx.tenant.id);
          const trigger = parseTrigger(a.draftTrigger);
          const graph = parseGraph(a.draftGraph);
          const issues: GraphIssue[] = [];
          if (!trigger.ok) issues.push({ level: 'error', nodeId: null, message: trigger.message });
          if (graph.ok) {
            issues.push(
              ...checkGraph(graph.graph, {
                teamIds: new Set(teamRows.map((t) => t.id)),
                fieldKeys: new Set(fieldRows.map((f) => f.key)),
              }),
            );
          } else {
            issues.push(...graph.issues.map((i) => ({ level: 'error' as const, ...i })));
          }
          const active = versions.find((v) => v.id === a.activeVersionId) ?? null;
          const draftSha = definitionSha({
            trigger: a.draftTrigger,
            graph: a.draftGraph,
            channelAccountId: a.draftChannelAccountId,
          });
          return {
            id: a.id,
            name: a.name,
            description: a.description,
            status: a.status,
            version: a.version,
            draft: {
              trigger: trigger.ok ? trigger.trigger : null,
              graph: graph.ok ? graph.graph : null,
              channelAccountId: a.draftChannelAccountId,
              updatedAt: a.draftUpdatedAt.toISOString(),
              updatedByName: row.updatedByName,
            },
            issues,
            draftChanged: active ? active.sha !== draftSha : true,
            activeVersion: active
              ? {
                  id: active.id,
                  number: active.number ?? 0,
                  createdAt: active.createdAt.toISOString(),
                }
              : null,
            versions: versions.map((v) => ({
              id: v.id,
              number: v.number ?? 0,
              note: v.note,
              createdAt: v.createdAt.toISOString(),
              createdByName: v.createdByName,
              active: v.id === a.activeVersionId,
            })),
            options: {
              channels: channels.map((c) => ({
                id: c.id,
                name: c.name,
                active: c.status === 'active',
              })),
              teams: teamRows,
              fields: fieldRows,
            },
          };
        },
        { accessMode: 'read only' },
      );
    },

    /** A published version's definition (read only), for showing what a run executed. */
    async getVersion(ctx: TenantContext, automationId: string, versionId: string) {
      assertCan(ctx, 'automations.read');
      if (!z.uuid().safeParse(automationId).success || !z.uuid().safeParse(versionId).success)
        throw notFound('Version');
      return db.run(
        ctx.scope,
        async (tx) => {
          const [v] = await tx
            .select()
            .from(automationVersions)
            .where(
              and(
                eq(automationVersions.tenantId, ctx.tenant.id),
                eq(automationVersions.automationId, automationId),
                eq(automationVersions.id, versionId),
              ),
            );
          if (!v) throw notFound('Version');
          const trigger = parseTrigger(v.trigger);
          const graph = parseGraph(v.graph);
          return {
            id: v.id,
            kind: v.kind,
            number: v.number,
            note: v.note,
            createdAt: v.createdAt.toISOString(),
            trigger: trigger.ok ? trigger.trigger : null,
            graph: graph.ok ? graph.graph : null,
            channelAccountId: v.channelAccountId,
          };
        },
        { accessMode: 'read only' },
      );
    },

    async createAutomation(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'automations.write');
      const data = parseInput(createSchema, input);
      const id = uuidv7();
      await db.run(ctx.scope, async (tx) => {
        const [taken] = await tx
          .select({ id: automations.id })
          .from(automations)
          .where(
            and(
              eq(automations.tenantId, ctx.tenant.id),
              sql`lower(btrim(${automations.name})) = lower(${data.name})`,
            ),
          );
        if (taken) throw new AppError('conflict', 'Another automation already has this name.');
        await tx.insert(automations).values({
          id,
          tenantId: ctx.tenant.id,
          name: data.name,
          description: data.description,
          status: 'draft',
          draftTrigger: starterTrigger(),
          draftGraph: starterGraph(),
          draftChannelAccountId: null,
          draftUpdatedByMembershipId: ctx.membership.id,
          createdByMembershipId: ctx.membership.id,
        });
        await recordAudit(
          tx,
          ctx,
          { action: 'automation.created', subjectType: 'automation', subjectId: id },
          meta,
        );
      });
      return { id };
    },

    /** Saves the draft. Structural problems are refused; graph issues are returned. */
    async updateAutomation(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'automations.write');
      const data = parseInput(updateSchema, input);
      const trigger = parseTrigger(data.trigger);
      if (!trigger.ok) throw new AppError('validation_failed', trigger.message);
      const graph = parseGraph(data.graph);
      if (!graph.ok) {
        throw new AppError(
          'validation_failed',
          graph.issues[0]?.message ?? 'The steps are not valid.',
          {
            details: { issues: graph.issues },
          },
        );
      }
      return db.run(ctx.scope, async (tx) => {
        const row = await lockAutomation(tx, ctx, data.id, data.expectedVersion);
        if (row.status === 'archived')
          throw new AppError('precondition_failed', 'Restore the automation before editing it.');
        const [taken] = await tx
          .select({ id: automations.id })
          .from(automations)
          .where(
            and(
              eq(automations.tenantId, ctx.tenant.id),
              ne(automations.id, row.id),
              sql`lower(btrim(${automations.name})) = lower(${data.name})`,
            ),
          );
        if (taken) throw new AppError('conflict', 'Another automation already has this name.');
        if (data.channelAccountId) {
          const [channel] = await tx
            .select({ id: channelAccounts.id })
            .from(channelAccounts)
            .where(
              and(
                eq(channelAccounts.tenantId, ctx.tenant.id),
                eq(channelAccounts.id, data.channelAccountId),
              ),
            );
          if (!channel)
            throw new AppError('validation_failed', 'Choose a WhatsApp number of this company.');
        }
        const now = clock.now();
        await tx
          .update(automations)
          .set({
            name: data.name,
            description: data.description,
            draftTrigger: trigger.trigger,
            draftGraph: graph.graph,
            draftChannelAccountId: data.channelAccountId,
            draftUpdatedAt: now,
            draftUpdatedByMembershipId: ctx.membership.id,
            version: sql`${automations.version} + 1`,
          })
          .where(and(eq(automations.tenantId, ctx.tenant.id), eq(automations.id, row.id)));
        await recordAudit(
          tx,
          ctx,
          { action: 'automation.draft_saved', subjectType: 'automation', subjectId: row.id },
          meta,
        );
        const { teamRows, fieldRows } = await references(tx, ctx.tenant.id);
        return {
          version: row.version + 1,
          issues: checkGraph(graph.graph, {
            teamIds: new Set(teamRows.map((t) => t.id)),
            fieldKeys: new Set(fieldRows.map((f) => f.key)),
          }),
        };
      });
    },

    async publishAutomation(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'automations.publish');
      const data = parseInput(publishSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const row = await lockAutomation(tx, ctx, data.id, data.expectedVersion);
        if (row.status === 'archived')
          throw new AppError('precondition_failed', 'Restore the automation before publishing it.');
        const { trigger, graph } = await runnableDraft(tx, row);
        const sha = definitionSha({ trigger, graph, channelAccountId: row.draftChannelAccountId });
        if (row.activeVersionId) {
          const [current] = await tx
            .select({ sha: automationVersions.definitionSha256, number: automationVersions.number })
            .from(automationVersions)
            .where(
              and(
                eq(automationVersions.tenantId, ctx.tenant.id),
                eq(automationVersions.id, row.activeVersionId),
              ),
            );
          if (current?.sha === sha) {
            throw new AppError(
              'conflict',
              `Nothing changed since version ${current.number ?? ''}; it is already live.`,
            );
          }
        }
        const [last] = await tx
          .select({ n: sql<number>`coalesce(max(${automationVersions.number}), 0)::int` })
          .from(automationVersions)
          .where(
            and(
              eq(automationVersions.tenantId, ctx.tenant.id),
              eq(automationVersions.automationId, row.id),
            ),
          );
        const number = (last?.n ?? 0) + 1;
        const versionId = uuidv7();
        await tx.insert(automationVersions).values({
          id: versionId,
          tenantId: ctx.tenant.id,
          automationId: row.id,
          kind: 'published',
          number,
          trigger,
          graph,
          channelAccountId: row.draftChannelAccountId,
          definitionSha256: sha,
          note: data.note,
          createdByMembershipId: ctx.membership.id,
        });
        await tx
          .update(automations)
          .set({
            activeVersionId: versionId,
            status: row.status === 'draft' ? 'active' : row.status,
            version: sql`${automations.version} + 1`,
          })
          .where(and(eq(automations.tenantId, ctx.tenant.id), eq(automations.id, row.id)));
        await recordAudit(
          tx,
          ctx,
          {
            action: 'automation.published',
            subjectType: 'automation',
            subjectId: row.id,
            metadata: { version: number, versionId },
          },
          meta,
        );
        return { versionNumber: number, version: row.version + 1 };
      });
    },

    async setAutomationStatus(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'automations.publish');
      const data = parseInput(statusSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const row = await lockAutomation(tx, ctx, data.id, data.expectedVersion);
        if (row.status === 'archived' || row.status === 'draft' || !row.activeVersionId) {
          throw new AppError('precondition_failed', 'Publish the automation first.');
        }
        if (row.status === data.status) return { version: row.version };
        await tx
          .update(automations)
          .set({ status: data.status, version: sql`${automations.version} + 1` })
          .where(and(eq(automations.tenantId, ctx.tenant.id), eq(automations.id, row.id)));
        await recordAudit(
          tx,
          ctx,
          {
            action: data.status === 'active' ? 'automation.activated' : 'automation.paused',
            subjectType: 'automation',
            subjectId: row.id,
          },
          meta,
        );
        return { version: row.version + 1 };
      });
    },

    /** Archives an automation: no new runs, and runs in progress stop. */
    async archiveAutomation(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'automations.publish');
      const data = parseInput(idSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const row = await lockAutomation(tx, ctx, data.id, data.expectedVersion);
        if (row.status === 'archived') return { stopped: 0 };
        await tx
          .update(automations)
          .set({ status: 'archived', version: sql`${automations.version} + 1` })
          .where(and(eq(automations.tenantId, ctx.tenant.id), eq(automations.id, row.id)));
        const stopped = await stopRunsOfAutomation(tx, ctx, row.id, clock.now());
        await recordAudit(
          tx,
          ctx,
          {
            action: 'automation.archived',
            subjectType: 'automation',
            subjectId: row.id,
            metadata: { stoppedRuns: stopped },
          },
          meta,
        );
        return { stopped };
      });
    },

    /** Restores an archived automation as paused (published before) or as a draft. */
    async restoreAutomation(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'automations.publish');
      const data = parseInput(idSchema, input);
      await db.run(ctx.scope, async (tx) => {
        const row = await lockAutomation(tx, ctx, data.id, data.expectedVersion);
        if (row.status !== 'archived') return;
        await tx
          .update(automations)
          .set({
            status: row.activeVersionId ? 'paused' : 'draft',
            version: sql`${automations.version} + 1`,
          })
          .where(and(eq(automations.tenantId, ctx.tenant.id), eq(automations.id, row.id)));
        await recordAudit(
          tx,
          ctx,
          { action: 'automation.restored', subjectType: 'automation', subjectId: row.id },
          meta,
        );
      });
    },

    /** Deletes an automation that never ran and has no versions (otherwise archive it). */
    async deleteAutomation(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'automations.write');
      const data = parseInput(idSchema, input);
      await db.run(ctx.scope, async (tx) => {
        const row = await lockAutomation(tx, ctx, data.id, data.expectedVersion);
        const [used] = await tx
          .select({ id: automationVersions.id })
          .from(automationVersions)
          .where(
            and(
              eq(automationVersions.tenantId, ctx.tenant.id),
              eq(automationVersions.automationId, row.id),
            ),
          )
          .limit(1);
        if (used) {
          throw new AppError(
            'conflict',
            'This automation has been published or tested, so its history is kept. Archive it instead.',
          );
        }
        await tx
          .delete(automations)
          .where(and(eq(automations.tenantId, ctx.tenant.id), eq(automations.id, row.id)));
        await recordAudit(
          tx,
          ctx,
          {
            action: 'automation.deleted',
            subjectType: 'automation',
            subjectId: row.id,
            metadata: { name: row.name },
          },
          meta,
        );
      });
    },

    /**
     * Runs a snapshot of the draft on a conversation the member can see (real messages are sent
     * there). The conversation must be open, inside the 24-hour window, not assigned to someone
     * else, and not handled by another automation.
     */
    async startTestRun(ctx: TenantContext, input: unknown, meta: RequestMeta = {}) {
      assertCan(ctx, 'automations.write');
      assertCan(ctx, 'inbox.reply');
      const data = parseInput(testRunSchema, input);
      return db.run(ctx.scope, async (tx) => {
        const row = await lockAutomation(tx, ctx, data.id, data.expectedVersion);
        if (row.status === 'archived')
          throw new AppError('precondition_failed', 'Restore the automation before testing it.');
        const { trigger, graph } = await runnableDraft(tx, row);
        const [conv] = await tx
          .select({
            id: conversations.id,
            status: conversations.status,
            assignedMembershipId: conversations.assignedMembershipId,
            channelAccountId: conversations.channelAccountId,
            contactId: conversations.contactId,
            lastInboundAt: conversations.lastInboundAt,
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
        if (conv.status === 'resolved')
          throw new AppError('precondition_failed', 'Reopen the conversation to test on it.');
        const now = clock.now();
        if (
          !conv.lastInboundAt ||
          now.getTime() - conv.lastInboundAt.getTime() > SERVICE_WINDOW_MS
        ) {
          throw new AppError(
            'precondition_failed',
            'The 24-hour customer service window of this conversation is closed. Send a WhatsApp message to the number from the test phone first.',
          );
        }
        if (conv.assignedMembershipId && conv.assignedMembershipId !== ctx.membership.id) {
          throw forbidden('This conversation is assigned to another member.');
        }
        if (await lockActiveRun(tx, ctx.tenant.id, conv.id)) {
          throw new AppError('conflict', 'An automation is already handling this conversation.');
        }
        const sha = definitionSha({ trigger, graph, channelAccountId: row.draftChannelAccountId });
        const [snapshot] = await tx
          .select({ id: automationVersions.id })
          .from(automationVersions)
          .where(
            and(
              eq(automationVersions.tenantId, ctx.tenant.id),
              eq(automationVersions.automationId, row.id),
              eq(automationVersions.kind, 'test'),
              eq(automationVersions.definitionSha256, sha),
            ),
          )
          .limit(1);
        const versionId = snapshot?.id ?? uuidv7();
        if (!snapshot) {
          await tx.insert(automationVersions).values({
            id: versionId,
            tenantId: ctx.tenant.id,
            automationId: row.id,
            kind: 'test',
            number: null,
            trigger,
            graph,
            channelAccountId: row.draftChannelAccountId,
            definitionSha256: sha,
            note: null,
            createdByMembershipId: ctx.membership.id,
          });
        }
        const runId = uuidv7();
        await tx.insert(automationRuns).values({
          id: runId,
          tenantId: ctx.tenant.id,
          automationId: row.id,
          versionId,
          conversationId: conv.id,
          contactId: conv.contactId,
          channelAccountId: conv.channelAccountId,
          mode: 'test',
          triggerType: 'test',
          startedByMembershipId: ctx.membership.id,
          startedByUserId: ctx.user.id,
          status: 'running',
          currentNodeId: graph.start,
          nextStepAt: now,
          startedAt: now,
        });
        await appendRunStep(tx, ctx.tenant.id, runId, {
          nodeId: null,
          nodeType: null,
          outcome: 'started',
          detail: 'test',
        });
        await emitTenantEvent(tx, ctx.tenant.id, {
          type: 'automation.started',
          conversationId: conv.id,
          payload: { runId, automationId: row.id },
        });
        await signalAutomationRun(deps, tx, {
          tenantId: ctx.tenant.id,
          runId,
          actorUserId: ctx.user.id,
          key: 'start',
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'automation.test_started',
            subjectType: 'automation',
            subjectId: row.id,
            metadata: { runId, conversationId: conv.id },
          },
          meta,
        );
        return { runId };
      });
    },

    async listRuns(ctx: TenantContext, input: unknown = {}) {
      assertCan(ctx, 'automations.read');
      const data = parseInput(listRunsSchema, input);
      const cursor = data.cursor ? decodeCursor(data.cursor) : null;
      const inboxReader = can(ctx, 'inbox.read_all') || can(ctx, 'inbox.read_assigned');
      return db.run(
        ctx.scope,
        async (tx) => {
          const rows = await tx
            .select({
              run: automationRuns,
              automationName: automations.name,
              versionNumber: automationVersions.number,
              assigned: conversations.assignedMembershipId,
            })
            .from(automationRuns)
            .innerJoin(
              automations,
              and(
                eq(automations.tenantId, automationRuns.tenantId),
                eq(automations.id, automationRuns.automationId),
              ),
            )
            .innerJoin(
              automationVersions,
              and(
                eq(automationVersions.tenantId, automationRuns.tenantId),
                eq(automationVersions.id, automationRuns.versionId),
              ),
            )
            .innerJoin(
              conversations,
              and(
                eq(conversations.tenantId, automationRuns.tenantId),
                eq(conversations.id, automationRuns.conversationId),
              ),
            )
            .where(
              and(
                eq(automationRuns.tenantId, ctx.tenant.id),
                data.automationId ? eq(automationRuns.automationId, data.automationId) : undefined,
                data.status === 'active'
                  ? inArray(automationRuns.status, ['running', 'waiting'])
                  : data.status
                    ? eq(automationRuns.status, data.status)
                    : undefined,
                cursor
                  ? sql`(${automationRuns.startedAt}, ${automationRuns.id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`
                  : undefined,
              ),
            )
            .orderBy(desc(automationRuns.startedAt), desc(automationRuns.id))
            .limit(RUN_PAGE + 1);
          const page = rows.slice(0, RUN_PAGE);
          const last = page.at(-1);
          return {
            runs: page.map((r) => ({
              id: r.run.id,
              automationId: r.run.automationId,
              automationName: r.automationName,
              versionNumber: r.versionNumber,
              mode: r.run.mode,
              status: r.run.status,
              endReason: r.run.endReason,
              triggerType: r.run.triggerType,
              startedAt: r.run.startedAt.toISOString(),
              endedAt: r.run.endedAt?.toISOString() ?? null,
              steps: r.run.stepCount,
              messages: r.run.messageCount,
              conversationId:
                inboxReader && canSeeConversation(ctx, r.assigned) ? r.run.conversationId : null,
            })) satisfies RunSummary[],
            nextCursor:
              rows.length > RUN_PAGE && last ? encodeCursor(last.run.startedAt, last.run.id) : null,
          };
        },
        { accessMode: 'read only' },
      );
    },

    async getRun(ctx: TenantContext, runId: string): Promise<RunDetail> {
      assertCan(ctx, 'automations.read');
      if (!z.uuid().safeParse(runId).success) throw notFound('Run');
      const inboxReader = can(ctx, 'inbox.read_all') || can(ctx, 'inbox.read_assigned');
      return db.run(
        ctx.scope,
        async (tx) => {
          const [r] = await tx
            .select({
              run: automationRuns,
              automationName: automations.name,
              versionNumber: automationVersions.number,
              graph: automationVersions.graph,
              assigned: conversations.assignedMembershipId,
            })
            .from(automationRuns)
            .innerJoin(
              automations,
              and(
                eq(automations.tenantId, automationRuns.tenantId),
                eq(automations.id, automationRuns.automationId),
              ),
            )
            .innerJoin(
              automationVersions,
              and(
                eq(automationVersions.tenantId, automationRuns.tenantId),
                eq(automationVersions.id, automationRuns.versionId),
              ),
            )
            .innerJoin(
              conversations,
              and(
                eq(conversations.tenantId, automationRuns.tenantId),
                eq(conversations.id, automationRuns.conversationId),
              ),
            )
            .where(and(eq(automationRuns.tenantId, ctx.tenant.id), eq(automationRuns.id, runId)));
          if (!r) throw notFound('Run');
          const memberIds = [r.run.endedByMembershipId, r.run.startedByMembershipId].filter(
            (x): x is string => x !== null,
          );
          const names =
            memberIds.length > 0
              ? await tx
                  .select({ id: memberships.id, name: users.name })
                  .from(memberships)
                  .innerJoin(users, eq(users.id, memberships.userId))
                  .where(
                    and(
                      eq(memberships.tenantId, ctx.tenant.id),
                      inArray(memberships.id, memberIds),
                    ),
                  )
              : [];
          const nameOf = (id: string | null) => names.find((n) => n.id === id)?.name ?? null;
          const steps = await tx
            .select()
            .from(automationRunSteps)
            .where(
              and(
                eq(automationRunSteps.tenantId, ctx.tenant.id),
                eq(automationRunSteps.runId, r.run.id),
              ),
            )
            .orderBy(asc(automationRunSteps.seq));
          const visible = inboxReader && canSeeConversation(ctx, r.assigned);
          const graph = parseGraph(r.graph);
          return {
            id: r.run.id,
            automationId: r.run.automationId,
            automationName: r.automationName,
            versionNumber: r.versionNumber,
            mode: r.run.mode,
            status: r.run.status,
            endReason: r.run.endReason,
            triggerType: r.run.triggerType,
            startedAt: r.run.startedAt.toISOString(),
            endedAt: r.run.endedAt?.toISOString() ?? null,
            steps: r.run.stepCount,
            messages: r.run.messageCount,
            conversationId: visible ? r.run.conversationId : null,
            currentNodeId: r.run.currentNodeId,
            waitingFor: r.run.waitingFor,
            waitUntil: r.run.waitUntil?.toISOString() ?? null,
            endDetail: r.run.endDetail,
            endedByName: nameOf(r.run.endedByMembershipId),
            startedByName: nameOf(r.run.startedByMembershipId),
            graph: graph.ok ? graph.graph : null,
            variables: visible ? r.run.variables : null,
            log: steps.map((s) => ({
              seq: s.seq,
              nodeId: s.nodeId,
              nodeType: s.nodeType,
              outcome: s.outcome,
              branch: s.branch,
              detail: s.detail,
              messageId: visible ? s.messageId : null,
              createdAt: s.createdAt.toISOString(),
            })),
          };
        },
        { accessMode: 'read only' },
      );
    },

    /** Stops a run; the conversation returns to people (routed as a new case). */
    async stopRun(ctx: TenantContext, runId: string, meta: RequestMeta = {}) {
      assertCan(ctx, 'automations.publish');
      if (!z.uuid().safeParse(runId).success) throw notFound('Run');
      await db.run(ctx.scope, async (tx) => {
        const [peek] = await tx
          .select({
            conversationId: automationRuns.conversationId,
            automationId: automationRuns.automationId,
          })
          .from(automationRuns)
          .where(and(eq(automationRuns.tenantId, ctx.tenant.id), eq(automationRuns.id, runId)));
        if (!peek) throw notFound('Run');
        await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.tenantId, ctx.tenant.id),
              eq(conversations.id, peek.conversationId),
            ),
          )
          .for('update');
        const run = await lockActiveRun(tx, ctx.tenant.id, peek.conversationId);
        if (!run || run.id !== runId) throw new AppError('conflict', 'This run has already ended.');
        await appendRunStep(tx, ctx.tenant.id, run.id, {
          nodeId: run.currentNodeId,
          nodeType: null,
          outcome: 'stopped',
          detail: 'stopped_by_member',
        });
        await endRun(tx, run, {
          status: 'stopped',
          reason: 'stopped_by_member',
          endedByMembershipId: ctx.membership.id,
          now: clock.now(),
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'automation.run_stopped',
            subjectType: 'automation_run',
            subjectId: run.id,
            metadata: { automationId: peek.automationId },
          },
          meta,
        );
      });
    },

    /**
     * A member takes a conversation over from the automation handling it: the run ends, queued bot
     * messages are cancelled, and the conversation is assigned to the member if nobody has it.
     */
    async takeOver(ctx: TenantContext, conversationId: string, meta: RequestMeta = {}) {
      assertCan(ctx, 'inbox.reply');
      if (!z.uuid().safeParse(conversationId).success) throw notFound('Conversation');
      await db.run(ctx.scope, async (tx) => {
        const [conv] = await tx
          .select({
            id: conversations.id,
            assignedMembershipId: conversations.assignedMembershipId,
          })
          .from(conversations)
          .where(
            and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conversationId)),
          )
          .for('update');
        if (!conv || !canSeeConversation(ctx, conv.assignedMembershipId))
          throw notFound('Conversation');
        const runId = await endRunForHuman(tx, {
          tenantId: ctx.tenant.id,
          conversationId: conv.id,
          reason: 'take_over',
          actorMembershipId: ctx.membership.id,
          now: clock.now(),
        });
        if (!runId)
          throw new AppError('conflict', 'No automation is handling this conversation any more.');
        if (conv.assignedMembershipId === null) {
          await tx
            .update(conversations)
            .set({
              assignedMembershipId: ctx.membership.id,
              version: sql`${conversations.version} + 1`,
            })
            .where(and(eq(conversations.tenantId, ctx.tenant.id), eq(conversations.id, conv.id)));
          await emitTenantEvent(tx, ctx.tenant.id, {
            type: 'conversation.assigned',
            conversationId: conv.id,
            assignedMembershipId: ctx.membership.id,
            payload: { previous: null },
          });
        }
        await recordAudit(
          tx,
          ctx,
          {
            action: 'automation.taken_over',
            subjectType: 'conversation',
            subjectId: conv.id,
            metadata: { runId },
          },
          meta,
        );
      });
    },

    /** Conversations a member may run a test on: open, visible, recent customer message. */
    async testConversationOptions(ctx: TenantContext) {
      assertCan(ctx, 'automations.write');
      if (!can(ctx, 'inbox.reply')) return [];
      const since = new Date(clock.now().getTime() - SERVICE_WINDOW_MS);
      return db.run(
        ctx.scope,
        async (tx) => {
          const rows = await tx.execute<{
            id: string;
            name: string | null;
            phone: string | null;
            assigned: string | null;
            last_inbound_at: Date;
          }>(sql`
            select c.id, coalesce(ct.display_name, ci.profile_name) as name, ct.phone_e164 as phone,
                   c.assigned_membership_id as assigned, c.last_inbound_at
              from app.conversations c
              join app.contacts ct on ct.tenant_id = c.tenant_id and ct.id = c.contact_id
              left join lateral (select i.profile_name from app.contact_identities i
                                  where i.tenant_id = c.tenant_id and i.contact_id = c.contact_id
                                  limit 1) ci on true
             where c.tenant_id = ${ctx.tenant.id}::uuid and c.status <> 'resolved'
               and c.last_inbound_at >= ${since.toISOString()}::timestamptz
               and (c.assigned_membership_id is null or c.assigned_membership_id = ${ctx.membership.id}::uuid)
             order by c.last_inbound_at desc
             limit 50`);
          return rows.rows
            .filter((r) => canSeeConversation(ctx, r.assigned))
            .map((r) => ({ id: r.id, label: r.name ?? r.phone ?? 'Unknown contact' }));
        },
        { accessMode: 'read only' },
      );
    },
  };
}

export type AutomationService = ReturnType<typeof createAutomationService>;

/** Runs of automations started in a period, by outcome (reports). */
export async function automationRunOutcomes(
  tx: Tx,
  tenantId: string,
  period: { start: Date; end: Date },
) {
  const res = await tx
    .select({
      status: automationRuns.status,
      reason: automationRuns.endReason,
      n: sql<number>`count(*)::int`,
    })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.tenantId, tenantId),
        eq(automationRuns.mode, 'live'),
        gte(automationRuns.startedAt, period.start),
        sql`${automationRuns.startedAt} < ${period.end.toISOString()}::timestamptz`,
      ),
    )
    .groupBy(automationRuns.status, automationRuns.endReason);
  return res;
}
