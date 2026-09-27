import { uuidv7, type Clock } from '@w360/core';
import {
  and,
  asc,
  automationRuns,
  automationVersions,
  automations,
  eq,
  gt,
  isNull,
  or,
  sql,
  tenants,
  type Tx,
} from '@w360/db';
import { businessStatusAt, loadBusinessCalendar } from '../inbox/business-hours';
import { emitTenantEvent } from '../messaging/events';
import { RUN_BUDGETS, graphSchema, matchTrigger, triggerSchema, type TriggerRank } from './graph';
import {
  appendRunStep,
  endRun,
  lockActiveRun,
  signalAutomationRun,
  type RunSignalDeps,
} from './runs';

/**
 * Hands a stored customer message to automations, inside the ingestion transaction (the
 * conversation row is already locked):
 * - a run waiting for a reply receives it (the runner processes it next);
 * - an opt-out keyword stops an active run and never starts one;
 * - otherwise, when nobody is assigned and no run is active, the best-matching active automation
 *   starts: an exact keyword first, then a keyword in the message, then "conversation started",
 *   then "any message"; ties go to the automation whose name sorts first. Business-hours filters,
 *   per-automation cooldowns and a per-conversation hourly cap (bot-to-bot loops) apply.
 * Routing waits while a run is active (see routeConversation).
 */
export interface DispatchDeps extends RunSignalDeps {
  clock: Clock;
}

export interface InboundForAutomation {
  tenantId: string;
  conversationId: string;
  channelAccountId: string;
  contactId: string;
  assignedMembershipId: string | null;
  messageId: string;
  /** Text to match keywords against (text, tapped button title), if any. */
  text: string | null;
  /** First customer message of a new or reopened conversation. */
  newCase: boolean;
  /** The consent keyword the message matched, if any. */
  consent: 'opt_out_all' | 'opt_out_marketing' | 'opt_in' | null;
}

export type DispatchOutcome = 'delivered' | 'started' | 'stopped' | 'busy' | 'none';

export async function dispatchInboundToAutomation(
  tx: Tx,
  deps: DispatchDeps,
  input: InboundForAutomation,
): Promise<DispatchOutcome> {
  const now = deps.clock.now();
  const optOut = input.consent === 'opt_out_all' || input.consent === 'opt_out_marketing';
  const active = await lockActiveRun(tx, input.tenantId, input.conversationId);
  if (active) {
    if (input.consent === 'opt_out_all') {
      await appendRunStep(tx, input.tenantId, active.id, {
        nodeId: active.currentNodeId,
        nodeType: null,
        outcome: 'stopped',
        detail: 'opted_out',
      });
      await endRun(tx, active, { status: 'stopped', reason: 'opted_out', now });
      return 'stopped';
    }
    if (active.status === 'waiting' && active.waitingFor === 'reply' && !active.inputMessageId) {
      await tx
        .update(automationRuns)
        .set({ inputMessageId: input.messageId, nextStepAt: now })
        .where(and(eq(automationRuns.tenantId, input.tenantId), eq(automationRuns.id, active.id)));
      await signalAutomationRun(deps, tx, {
        tenantId: input.tenantId,
        runId: active.id,
        actorUserId: active.startedByUserId,
        key: `i:${input.messageId}`,
      });
      return 'delivered';
    }
    // The run is not waiting for a reply (or already has one to process): the message is stored
    // and shown in the inbox, where a member can take the conversation over.
    return 'busy';
  }
  if (optOut || input.assignedMembershipId) return 'none';
  // A suspended company sends nothing, so no run starts (it would hold the conversation).
  const [tenant] = await tx
    .select({ status: tenants.status, timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, input.tenantId));
  if (tenant?.status !== 'active') return 'none';

  const candidates = await tx
    .select({
      automationId: automations.id,
      name: automations.name,
      versionId: automationVersions.id,
      trigger: automationVersions.trigger,
      graph: automationVersions.graph,
    })
    .from(automations)
    .innerJoin(
      automationVersions,
      and(
        eq(automationVersions.tenantId, automations.tenantId),
        eq(automationVersions.id, automations.activeVersionId),
      ),
    )
    .where(
      and(
        eq(automations.tenantId, input.tenantId),
        eq(automations.status, 'active'),
        or(
          isNull(automationVersions.channelAccountId),
          eq(automationVersions.channelAccountId, input.channelAccountId),
        ),
      ),
    )
    .orderBy(asc(sql`lower(${automations.name})`), asc(automations.id));
  if (candidates.length === 0) return 'none';

  let open: boolean | null = null;
  const businessOpen = async () => {
    if (open !== null) return open;
    const hours = await loadBusinessCalendar(tx, input.tenantId, tenant.timezone);
    open = hours.enabled ? businessStatusAt(hours.calendar, now).open : true;
    return open;
  };

  let best: { rank: TriggerRank; candidate: (typeof candidates)[number]; start: string } | null =
    null;
  for (const candidate of candidates) {
    const trigger = triggerSchema.safeParse(candidate.trigger);
    const graph = graphSchema.safeParse(candidate.graph);
    if (!trigger.success || !graph.success) continue;
    const rank = matchTrigger(trigger.data, { text: input.text, newCase: input.newCase });
    if (rank === null || (best && best.rank <= rank)) continue;
    if (trigger.data.hours !== 'any') {
      const isOpen = await businessOpen();
      if ((trigger.data.hours === 'open') !== isOpen) continue;
    }
    if (trigger.data.cooldownMinutes > 0) {
      const [recent] = await tx
        .select({ id: automationRuns.id })
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.tenantId, input.tenantId),
            eq(automationRuns.conversationId, input.conversationId),
            eq(automationRuns.automationId, candidate.automationId),
            eq(automationRuns.mode, 'live'),
            gt(
              automationRuns.startedAt,
              new Date(now.getTime() - trigger.data.cooldownMinutes * 60_000),
            ),
          ),
        )
        .limit(1);
      if (recent) continue;
    }
    best = { rank, candidate, start: graph.data.start };
  }
  if (!best) return 'none';

  const [recentRuns] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.tenantId, input.tenantId),
        eq(automationRuns.conversationId, input.conversationId),
        gt(automationRuns.startedAt, new Date(now.getTime() - 3600_000)),
      ),
    );
  if ((recentRuns?.n ?? 0) >= RUN_BUDGETS.maxRunsPerConversationPerHour) return 'none';

  const runId = uuidv7();
  const triggerType = (['keyword', 'keyword', 'conversation_started', 'any_message'] as const)[
    best.rank
  ];
  await tx.insert(automationRuns).values({
    id: runId,
    tenantId: input.tenantId,
    automationId: best.candidate.automationId,
    versionId: best.candidate.versionId,
    conversationId: input.conversationId,
    contactId: input.contactId,
    channelAccountId: input.channelAccountId,
    mode: 'live',
    triggerType,
    triggerMessageId: input.messageId,
    status: 'running',
    currentNodeId: best.start,
    nextStepAt: now,
    startedAt: now,
  });
  await appendRunStep(tx, input.tenantId, runId, {
    nodeId: null,
    nodeType: null,
    outcome: 'started',
    detail: triggerType,
  });
  await emitTenantEvent(tx, input.tenantId, {
    type: 'automation.started',
    conversationId: input.conversationId,
    payload: { runId, automationId: best.candidate.automationId },
  });
  await signalAutomationRun(deps, tx, {
    tenantId: input.tenantId,
    runId,
    actorUserId: null,
    key: 'start',
  });
  return 'started';
}
