import { QUEUES } from '@w360/contracts';
import {
  and,
  automationHttpCalls,
  automationRunSteps,
  automationRuns,
  conversations,
  eq,
  inArray,
  messages,
  sendIntents,
  sql,
  teams,
  type AutomationEndReason,
  type AutomationEndStatus,
  type AutomationStepOutcome,
  type Tx,
} from '@w360/db';
import { uuidv7 } from '@w360/core';
import { routeConversation } from '../inbox/routing';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { emitTenantEvent } from '../messaging/events';
import { STATUS_RANK } from '../messaging/status';

/**
 * Shared run helpers: signalling the runner, the step log, and ending a run. Every writer of a run
 * holds the conversation row lock first and the run row lock second (ingestion, the runner, a
 * member's reply or assignment, "Take over"), so these never deadlock and a run ends exactly once.
 */

export type AutomationRun = typeof automationRuns.$inferSelect;

export const ACTIVE_STATUSES = ['running', 'waiting'] as const;

export interface RunSignalDeps {
  jobs: JobQueue;
  signer: JobSigner;
}

/**
 * Signals the runner for a run. Jobs are only wake-ups: the run row decides what happens, so a
 * duplicate or stale signal does nothing. `key` distinguishes signals (start, reply, timer,
 * continuation), because the queue keeps at most one job per key.
 */
export async function signalAutomationRun(
  deps: RunSignalDeps,
  tx: Tx | null,
  input: { tenantId: string; runId: string; actorUserId: string | null; key: string; at?: Date },
): Promise<void> {
  await deps.jobs.enqueue(
    tx,
    QUEUES.automationRun.name,
    deps.signer.sign({
      kind: 'automation.run',
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      ref: input.runId,
    }),
    { singletonKey: `${input.runId}:${input.key}`, ...(input.at ? { startAfter: input.at } : {}) },
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Signals the run that sent a bot message once the message's send is settled (accepted, failed,
 * cancelled or unknown) or Meta reports it failed later, so the run continues, or passes the
 * conversation to people, without waiting for the sweep. Other messages and ended runs are left
 * alone.
 */
export async function signalRunOfBotMessage(
  deps: RunSignalDeps,
  tx: Tx,
  input: { tenantId: string; messageId: string; key: string },
): Promise<void> {
  const [message] = await tx
    .select({
      senderType: messages.senderType,
      runId: sql<string | null>`${messages.content}->>'automationRunId'`,
    })
    .from(messages)
    .where(and(eq(messages.tenantId, input.tenantId), eq(messages.id, input.messageId)));
  if (message?.senderType !== 'bot' || !message.runId || !UUID_RE.test(message.runId)) return;
  const [run] = await tx
    .select({ id: automationRuns.id, actorUserId: automationRuns.startedByUserId })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.tenantId, input.tenantId),
        eq(automationRuns.id, message.runId),
        inArray(automationRuns.status, ['running', 'waiting']),
      ),
    );
  if (!run) return;
  await signalAutomationRun(deps, tx, {
    tenantId: input.tenantId,
    runId: run.id,
    actorUserId: run.actorUserId,
    key: input.key,
  });
}

/** The conversation's active run, locked. The caller already holds the conversation row lock. */
export async function lockActiveRun(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<AutomationRun | null> {
  const [run] = await tx
    .select()
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.tenantId, tenantId),
        eq(automationRuns.conversationId, conversationId),
        inArray(automationRuns.status, [...ACTIVE_STATUSES]),
      ),
    )
    .for('update');
  return run ?? null;
}

/** Appends a row to the run's step log (numbered per run; the caller holds the run lock). */
export async function appendRunStep(
  tx: Tx,
  tenantId: string,
  runId: string,
  entry: {
    nodeId: string | null;
    nodeType: string | null;
    outcome: AutomationStepOutcome;
    branch?: string | null;
    messageId?: string | null;
    detail?: string | null;
  },
): Promise<void> {
  await tx.insert(automationRunSteps).values({
    id: uuidv7(),
    tenantId,
    runId,
    seq: sql`(select coalesce(max(s.seq), -1) + 1 from app.automation_run_steps s
               where s.tenant_id = ${tenantId}::uuid and s.run_id = ${runId}::uuid)`,
    nodeId: entry.nodeId,
    nodeType: entry.nodeType,
    outcome: entry.outcome,
    branch: entry.branch?.slice(0, 80) ?? null,
    messageId: entry.messageId ?? null,
    detail: entry.detail?.slice(0, 300) ?? null,
  });
}

/**
 * Cancels the conversation's bot messages that no send worker has claimed yet, so nothing the bot
 * queued goes out after a person took over. A message already handed to the sender cannot be
 * recalled. Returns how many were cancelled.
 */
export async function cancelQueuedBotMessages(
  tx: Tx,
  tenantId: string,
  conversationId: string,
  now: Date,
): Promise<number> {
  const canceled = await tx
    .update(sendIntents)
    .set({
      state: 'canceled',
      leaseUntil: null,
      resolvedAt: now,
      lastErrorCode: 'bot_stopped',
      lastError: 'Not sent: the automation stopped before this message left.',
    })
    .where(
      and(
        eq(sendIntents.tenantId, tenantId),
        inArray(sendIntents.state, ['queued', 'deferred']),
        sql`${sendIntents.messageId} in (select m.id from app.messages m
              where m.tenant_id = ${tenantId}::uuid and m.conversation_id = ${conversationId}::uuid
                and m.sender_type = 'bot' and m.direction = 'outbound')`,
      ),
    )
    .returning({ messageId: sendIntents.messageId });
  if (canceled.length === 0) return 0;
  await tx
    .update(messages)
    .set({
      status: 'canceled',
      statusRank: STATUS_RANK.canceled,
      statusAt: now,
      errorCode: 'bot_stopped',
      errorTitle: 'Not sent: the automation stopped before this message left.',
    })
    .where(
      and(
        eq(messages.tenantId, tenantId),
        inArray(
          messages.id,
          canceled.map((c) => c.messageId),
        ),
      ),
    );
  for (const c of canceled) {
    await emitTenantEvent(tx, tenantId, {
      type: 'message.status',
      conversationId,
      payload: { messageId: c.messageId },
    });
  }
  return canceled.length;
}

/** Endings after which people handle the conversation: it is routed like a new case. */
function returnsToPeople(status: AutomationEndStatus, reason: AutomationEndReason): boolean {
  if (status === 'handed_off' || status === 'failed') return true;
  return (
    status === 'stopped' &&
    (reason === 'stopped_by_member' || reason === 'opted_out' || reason === 'automation_archived')
  );
}

export interface EndRunInput {
  status: AutomationEndStatus;
  reason: AutomationEndReason;
  detail?: string | null;
  endedByMembershipId?: string | null;
  now: Date;
  /** Hand-off team (hand-off node). */
  teamId?: string | null;
  /** Extra run columns written with the end (the runner's final state). */
  state?: Partial<typeof automationRuns.$inferInsert>;
}

/**
 * Ends a locked active run: records the end, cancels unclaimed bot messages when a person or a
 * stop ended it, and routes the conversation when it returns to people (a hand-off to a team
 * places it there first). Reply turns react to the status change (migration 0011 trigger).
 */
export async function endRun(tx: Tx, run: AutomationRun, input: EndRunInput): Promise<void> {
  const endedAt = input.now < run.startedAt ? run.startedAt : input.now;
  await tx
    .update(automationRuns)
    .set({
      ...input.state,
      status: input.status,
      endReason: input.reason,
      endDetail: input.detail?.slice(0, 300) ?? null,
      endedByMembershipId: input.endedByMembershipId ?? null,
      endedAt,
      waitingFor: null,
      waitUntil: null,
      inputMessageId: null,
      pendingMessageId: null,
      nextStepAt: null,
    })
    .where(and(eq(automationRuns.tenantId, run.tenantId), eq(automationRuns.id, run.id)));
  if (input.status === 'taken_over' || input.status === 'stopped') {
    await cancelQueuedBotMessages(tx, run.tenantId, run.conversationId, input.now);
  }
  // Calls the worker has not started are never made once the run has ended. A call in flight may
  // have been received: its outcome becomes unknown now (no runner is left to settle it), and a
  // result the worker records later is not kept.
  await tx
    .update(automationHttpCalls)
    .set({
      state: 'canceled',
      errorCode: 'run_ended',
      finishedAt: input.now,
      requestCiphertext: null,
    })
    .where(
      and(
        eq(automationHttpCalls.tenantId, run.tenantId),
        eq(automationHttpCalls.runId, run.id),
        eq(automationHttpCalls.state, 'queued'),
      ),
    );
  await tx
    .update(automationHttpCalls)
    .set({
      state: 'unknown',
      errorCode: 'run_ended_in_flight',
      finishedAt: input.now,
      leaseUntil: null,
      requestCiphertext: null,
    })
    .where(
      and(
        eq(automationHttpCalls.tenantId, run.tenantId),
        eq(automationHttpCalls.runId, run.id),
        eq(automationHttpCalls.state, 'in_flight'),
      ),
    );
  await emitTenantEvent(tx, run.tenantId, {
    type: 'automation.ended',
    conversationId: run.conversationId,
    payload: { runId: run.id, status: input.status, reason: input.reason },
  });
  if (!returnsToPeople(input.status, input.reason)) return;

  let routed = false;
  if (input.teamId) {
    const [team] = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.tenantId, run.tenantId), eq(teams.id, input.teamId)));
    if (team) {
      await tx
        .update(conversations)
        .set({ teamId: team.id, version: sql`${conversations.version} + 1` })
        .where(
          and(
            eq(conversations.tenantId, run.tenantId),
            eq(conversations.id, run.conversationId),
            sql`${conversations.assignedMembershipId} is null`,
          ),
        );
      await routeConversation(tx, run.tenantId, run.conversationId, { newCase: false, text: null });
      routed = true;
    }
  }
  if (!routed) {
    // Routed as the new case it was when the automation took it (routing keywords apply to the
    // message that started the run).
    const [trigger] = run.triggerMessageId
      ? await tx
          .select({ type: messages.type, content: messages.content })
          .from(messages)
          .where(and(eq(messages.tenantId, run.tenantId), eq(messages.id, run.triggerMessageId)))
      : [];
    const text =
      trigger?.type === 'text' && typeof trigger.content.text === 'string'
        ? trigger.content.text
        : null;
    await routeConversation(tx, run.tenantId, run.conversationId, { newCase: true, text });
  }
}

export type HumanTakeoverReason =
  'agent_replied' | 'assigned' | 'take_over' | 'conversation_resolved' | 'api_replied';

/**
 * Ends the conversation's active run because a person acted: replied, assigned it, took it over or
 * resolved it; or because a reply was sent through the public API (ADR-070), which takes the
 * conversation over the same way. Call with the conversation row locked, before the change is
 * written. A test run is not ended by assigning the conversation to the member testing it.
 */
export async function endRunForHuman(
  tx: Tx,
  input: {
    tenantId: string;
    conversationId: string;
    reason: HumanTakeoverReason;
    /** The member who acted. */
    actorMembershipId: string | null;
    /** For assignments: the new assignee. */
    assigneeMembershipId?: string | null;
    now: Date;
  },
): Promise<string | null> {
  const run = await lockActiveRun(tx, input.tenantId, input.conversationId);
  if (!run) return null;
  if (
    input.reason === 'assigned' &&
    run.startedByMembershipId !== null &&
    input.assigneeMembershipId === run.startedByMembershipId
  ) {
    return null;
  }
  const status = input.reason === 'conversation_resolved' ? 'stopped' : 'taken_over';
  await appendRunStep(tx, input.tenantId, run.id, {
    nodeId: run.currentNodeId,
    nodeType: null,
    outcome: status,
    detail: input.reason,
  });
  // The run row (ended_by_membership_id) and its step log record who took over; explicit actions
  // (Take over, Stop) are also audited by the automation service.
  await endRun(tx, run, {
    status,
    reason: input.reason,
    endedByMembershipId: input.actorMembershipId,
    now: input.now,
  });
  return run.id;
}
