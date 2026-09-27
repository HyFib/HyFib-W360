import { uuidv7, type Clock } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  automationRuns,
  automationVersions,
  channelAccounts,
  contactFields,
  contactIdentities,
  contactTags,
  contacts,
  conversations,
  eq,
  memberships,
  messages,
  sendIntents,
  sql,
  systemScope,
  tenants,
  type Database,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { permissionsForRoles } from '../authz/permissions';
import { MAX_TAGS_PER_CONTACT, coerceFieldValue } from '../contacts/fields';
import { businessStatusAt, loadBusinessCalendar } from '../inbox/business-hours';
import { emitTenantEvent } from '../messaging/events';
import { STATUS_RANK } from '../messaging/status';
import { RUN_BUDGETS, graphSchema, type AutomationGraph, type AutomationNode } from './graph';
import {
  advance,
  type InboundReply,
  type RunEffect,
  type RunEvent,
  type RunFacts,
  type RunState,
  type StepResult,
} from './interpreter';
import {
  appendRunStep,
  endRun,
  signalAutomationRun,
  type AutomationRun,
  type RunSignalDeps,
} from './runs';

/**
 * The automation runner (worker, queue `automation.run`). Each step is one transaction:
 * 1. lock the conversation, then the run (the order every writer uses);
 * 2. work out the event: a delivered reply, a due deadline, or entering the next node;
 * 3. check the hand-off lock, the run's age and the conversation state;
 * 4. call the pure interpreter with the pinned version's graph;
 * 5. apply its effects — bot messages go through the ordinary send pipeline (message, send intent
 *    and `message.send` job in this transaction; the send worker re-checks policy before any
 *    request leaves), contact updates, hand-off routing;
 * 6. append the step log row and store the new position, or end the run.
 * A crash before commit leaves nothing behind and the step runs again; after commit the next step
 * starts from the stored position. Nothing about a step is ever applied twice. A step that keeps
 * raising an error fails the run after `MAX_STEP_FAILURES` attempts, so the conversation goes to
 * people instead of waiting on a run that cannot advance.
 */
export interface AutomationRunnerDeps extends RunSignalDeps {
  db: Database;
  clock: Clock;
}

/** Steps one job processes before handing the run to a new job (fairness between runs). */
export const STEPS_PER_JOB = 25;
/** Failed attempts at a step (errors, not outcomes) before the run fails with `step_error`. */
export const MAX_STEP_FAILURES = 5;
const SERVICE_WINDOW_MS = 24 * 3600_000;

/** Versions never change, so parsed graphs are cached by version id. */
const graphCache = new Map<string, AutomationGraph>();
const GRAPH_CACHE_LIMIT = 500;

export async function loadVersionGraph(
  tx: Tx,
  tenantId: string,
  versionId: string,
): Promise<AutomationGraph | null> {
  const cached = graphCache.get(versionId);
  if (cached) return cached;
  const [row] = await tx
    .select({ graph: automationVersions.graph })
    .from(automationVersions)
    .where(and(eq(automationVersions.tenantId, tenantId), eq(automationVersions.id, versionId)));
  if (!row) return null;
  const parsed = graphSchema.safeParse(row.graph);
  if (!parsed.success) return null;
  if (graphCache.size >= GRAPH_CACHE_LIMIT) graphCache.clear();
  graphCache.set(versionId, parsed.data);
  return parsed.data;
}

export function runStateOf(run: AutomationRun): RunState {
  return {
    nodeId: run.currentNodeId,
    visit: run.nodeVisit,
    waiting:
      run.status === 'waiting' && run.waitingFor && run.waitUntil
        ? { for: run.waitingFor, until: run.waitUntil }
        : null,
    retries: run.retries,
    steps: run.stepCount,
    messages: run.messageCount,
    visits: run.visits,
    variables: run.variables,
  };
}

/** What a stored inbound message means to a waiting question. */
export function replyFromMessage(message: {
  type: string;
  content: Record<string, unknown>;
}): InboundReply {
  const content = message.content;
  if (message.type === 'text' && typeof content.text === 'string')
    return { type: 'text', text: content.text, buttonId: null };
  if (message.type === 'interactive') {
    const reply = content.reply as { id?: unknown; title?: unknown } | null | undefined;
    return {
      type: 'button',
      text: typeof reply?.title === 'string' ? reply.title : null,
      buttonId: typeof reply?.id === 'string' ? reply.id : null,
    };
  }
  if (message.type === 'button') {
    const text = typeof content.text === 'string' ? content.text : null;
    return { type: 'text', text, buttonId: null };
  }
  return { type: 'other', text: null, buttonId: null };
}

async function loadFacts(
  tx: Tx,
  run: AutomationRun,
  node: AutomationNode | undefined,
  now: Date,
): Promise<RunFacts> {
  const [tenant] = await tx
    .select({ name: tenants.name, timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, run.tenantId));
  const [contact] = await tx
    .select({ name: contacts.displayName, attributes: contacts.attributes })
    .from(contacts)
    .where(and(eq(contacts.tenantId, run.tenantId), eq(contacts.id, run.contactId)));
  const tagRows = await tx
    .select({ tag: contactTags.tag })
    .from(contactTags)
    .where(and(eq(contactTags.tenantId, run.tenantId), eq(contactTags.contactId, run.contactId)));
  let businessOpen = true;
  if (node?.type === 'condition' && node.rules.some((r) => r.kind === 'business_hours')) {
    const hours = await loadBusinessCalendar(tx, run.tenantId, tenant?.timezone ?? 'UTC');
    businessOpen = hours.enabled ? businessStatusAt(hours.calendar, now).open : true;
  }
  return {
    contactName: contact?.name ?? null,
    companyName: tenant?.name ?? '',
    tags: new Set(tagRows.map((t) => t.tag)),
    fields: contact?.attributes ?? {},
    businessOpen,
  };
}

type SendEffect = Extract<RunEffect, { kind: 'send_text' | 'send_buttons' }>;

/**
 * Queues a bot message through the send pipeline, after the checks a member's reply gets: the
 * number is active, the 24-hour window is open and the contact has a WhatsApp id on this number.
 */
export async function queueBotMessage(
  tx: Tx,
  deps: RunSignalDeps,
  input: {
    run: AutomationRun;
    conversation: {
      id: string;
      channelAccountId: string;
      contactId: string;
      lastInboundAt: Date | null;
    };
    effect: SendEffect;
    now: Date;
  },
): Promise<{ ok: true; messageId: string } | { ok: false; code: string }> {
  const { run, conversation, effect, now } = input;
  const [channel] = await tx
    .select({
      status: channelAccounts.status,
      whatsappAccountId: channelAccounts.whatsappAccountId,
    })
    .from(channelAccounts)
    .where(
      and(
        eq(channelAccounts.tenantId, run.tenantId),
        eq(channelAccounts.id, conversation.channelAccountId),
      ),
    );
  if (!channel || channel.status !== 'active') return { ok: false, code: 'channel_inactive' };
  if (
    !conversation.lastInboundAt ||
    now.getTime() - conversation.lastInboundAt.getTime() > SERVICE_WINDOW_MS
  ) {
    return { ok: false, code: 'window_closed' };
  }
  const [identity] = await tx
    .select({ waId: contactIdentities.waId })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.tenantId, run.tenantId),
        eq(contactIdentities.contactId, conversation.contactId),
        eq(contactIdentities.whatsappAccountId, channel.whatsappAccountId),
        sql`${contactIdentities.waId} is not null`,
      ),
    )
    .limit(1);
  if (!identity?.waId) return { ok: false, code: 'no_phone' };

  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: identity.waId };
  const request =
    effect.kind === 'send_text'
      ? { ...base, type: 'text', text: { body: effect.text, preview_url: false } }
      : {
          ...base,
          type: 'interactive',
          interactive: {
            type: 'button',
            ...(effect.header ? { header: { type: 'text', text: effect.header } } : {}),
            body: { text: effect.body },
            ...(effect.footer ? { footer: { text: effect.footer } } : {}),
            action: {
              buttons: effect.buttons.map((b) => ({
                type: 'reply',
                reply: { id: b.id, title: b.title },
              })),
            },
          },
        };
  const content =
    effect.kind === 'send_text'
      ? { text: effect.text, automationRunId: run.id }
      : {
          header: effect.header,
          body: effect.body,
          footer: effect.footer,
          buttons: effect.buttons.map((b) => b.title),
          automationRunId: run.id,
        };
  const preview = effect.kind === 'send_text' ? effect.text : effect.body;
  const messageId = uuidv7();
  const intentId = uuidv7();
  await tx.insert(messages).values({
    id: messageId,
    tenantId: run.tenantId,
    conversationId: conversation.id,
    channelAccountId: conversation.channelAccountId,
    direction: 'outbound',
    type: effect.kind === 'send_text' ? 'text' : 'interactive',
    content,
    status: 'queued',
    statusRank: STATUS_RANK.queued,
    senderType: 'bot',
    senderMembershipId: null,
  });
  await tx.insert(sendIntents).values({
    id: intentId,
    tenantId: run.tenantId,
    messageId,
    channelAccountId: conversation.channelAccountId,
    request,
    actorUserId: run.startedByUserId,
  });
  await tx
    .update(conversations)
    .set({ lastMessageAt: now, lastMessagePreview: preview.slice(0, 200) })
    .where(and(eq(conversations.tenantId, run.tenantId), eq(conversations.id, conversation.id)));
  await emitTenantEvent(tx, run.tenantId, {
    type: 'message.created',
    conversationId: conversation.id,
    payload: { messageId },
  });
  await deps.jobs.enqueue(
    tx,
    QUEUES.messageSend.name,
    deps.signer.sign({
      kind: 'message.send',
      tenantId: run.tenantId,
      actorUserId: run.startedByUserId,
      ref: intentId,
    }),
    { singletonKey: intentId, group: { id: conversation.channelAccountId } },
  );
  return { ok: true, messageId };
}

/**
 * Applies a contact update; returns a note for the step log when it was skipped. The contact row is
 * not locked first: single statements change it (the step already holds the conversation lock,
 * and contact erasure takes conversation locks before the contact's, so the order is the same).
 */
async function applyContactEffect(
  tx: Tx,
  run: AutomationRun,
  effect: Extract<RunEffect, { kind: 'add_tag' | 'remove_tag' | 'set_field' }>,
): Promise<string | null> {
  const [contact] = await tx
    .select({ erasedAt: contacts.erasedAt })
    .from(contacts)
    .where(and(eq(contacts.tenantId, run.tenantId), eq(contacts.id, run.contactId)));
  if (!contact || contact.erasedAt) return 'contact_erased';
  if (effect.kind === 'remove_tag') {
    await tx
      .delete(contactTags)
      .where(
        and(
          eq(contactTags.tenantId, run.tenantId),
          eq(contactTags.contactId, run.contactId),
          eq(contactTags.tag, effect.tag),
        ),
      );
    return null;
  }
  if (effect.kind === 'add_tag') {
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(contactTags)
      .where(and(eq(contactTags.tenantId, run.tenantId), eq(contactTags.contactId, run.contactId)));
    if ((count?.n ?? 0) >= MAX_TAGS_PER_CONTACT) return 'too_many_tags';
    await tx
      .insert(contactTags)
      .values({ id: uuidv7(), tenantId: run.tenantId, contactId: run.contactId, tag: effect.tag })
      .onConflictDoNothing();
    return null;
  }
  const [field] = await tx
    .select({ key: contactFields.key, label: contactFields.label, type: contactFields.type })
    .from(contactFields)
    .where(and(eq(contactFields.tenantId, run.tenantId), eq(contactFields.key, effect.field)));
  if (!field) return 'field_missing';
  const coerced = coerceFieldValue(field, effect.value);
  if (!coerced.ok) return 'invalid_value';
  const updated = await tx
    .update(contacts)
    .set({
      attributes:
        coerced.value === null
          ? sql`${contacts.attributes} - ${field.key}::text`
          : sql`${contacts.attributes} || jsonb_build_object(${field.key}::text, ${JSON.stringify(coerced.value)}::jsonb)`,
    })
    .where(
      and(
        eq(contacts.tenantId, run.tenantId),
        eq(contacts.id, run.contactId),
        sql`${contacts.erasedAt} is null`,
      ),
    )
    .returning({ id: contacts.id });
  return updated.length > 0 ? null : 'contact_erased';
}

type StepOutcome =
  | { kind: 'progress' }
  | { kind: 'waiting' }
  | { kind: 'ended' }
  | { kind: 'not_due' }
  | { kind: 'idle' };

async function runStep(
  deps: AutomationRunnerDeps,
  scope: TenantScope,
  runId: string,
): Promise<StepOutcome> {
  const tenantId = scope.tenantId;
  return deps.db.run(scope, async (tx) => {
    const now = deps.clock.now();
    const [peek] = await tx
      .select({ conversationId: automationRuns.conversationId })
      .from(automationRuns)
      .where(and(eq(automationRuns.tenantId, tenantId), eq(automationRuns.id, runId)));
    if (!peek) return { kind: 'idle' };
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
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, peek.conversationId)))
      .for('update');
    const [run] = await tx
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.tenantId, tenantId), eq(automationRuns.id, runId)))
      .for('update');
    if (!conv || !run || (run.status !== 'running' && run.status !== 'waiting'))
      return { kind: 'idle' };

    const end = async (
      status: 'failed' | 'stopped' | 'taken_over',
      reason: 'expired' | 'error' | 'conversation_resolved' | 'assigned',
      detail: string | null,
    ) => {
      await appendRunStep(tx, tenantId, run.id, {
        nodeId: run.currentNodeId,
        nodeType: null,
        outcome: status,
        detail: detail ?? reason,
      });
      await endRun(tx, run, { status, reason, detail, now });
      return { kind: 'ended' as const };
    };

    // The hand-off lock and the run's limits, checked on every step.
    if (conv.status === 'resolved') return end('stopped', 'conversation_resolved', null);
    if (conv.assignedMembershipId && conv.assignedMembershipId !== run.startedByMembershipId)
      return end('taken_over', 'assigned', null);
    if (now.getTime() - run.startedAt.getTime() > RUN_BUDGETS.maxRunMs)
      return end('failed', 'expired', null);
    // A test run acts for the member who started it, so it stops once they may no longer test
    // (the job's actor check already stops it when they leave the company).
    if (run.mode === 'test' && !(await testerMayContinue(tx, tenantId, run.startedByMembershipId)))
      return end('failed', 'error', 'tester_not_permitted');

    let event: RunEvent;
    if (run.status === 'waiting') {
      if (run.inputMessageId) {
        const [message] = await tx
          .select({ type: messages.type, content: messages.content })
          .from(messages)
          .where(and(eq(messages.tenantId, tenantId), eq(messages.id, run.inputMessageId)));
        event = message
          ? { kind: 'reply', reply: replyFromMessage(message) }
          : { kind: 'reply', reply: { type: 'other', text: null, buttonId: null } };
      } else if (run.waitUntil && run.waitUntil <= now) {
        event = { kind: 'deadline' };
      } else {
        return { kind: 'not_due' };
      }
    } else {
      if (run.nextStepAt && run.nextStepAt > now) return { kind: 'not_due' };
      event = { kind: 'continue' };
    }

    const graph = await loadVersionGraph(tx, tenantId, run.versionId);
    if (!graph) return end('failed', 'error', 'version_unreadable');
    const node = graph.nodes.find((n) => n.id === run.currentNodeId);
    const facts = await loadFacts(tx, run, node, now);
    const result: StepResult = advance({
      graph,
      state: runStateOf(run),
      event,
      facts,
      runId: run.id,
      now,
    });

    if (result.noop) {
      // The event did not apply (for example a reply while a timer runs): drop it.
      await tx
        .update(automationRuns)
        .set({ inputMessageId: null, nextStepAt: run.waitUntil ?? now })
        .where(and(eq(automationRuns.tenantId, tenantId), eq(automationRuns.id, run.id)));
      return { kind: 'not_due' };
    }

    // Apply effects in order. A message that cannot be sent ends the run and passes the
    // conversation to people.
    let messageId: string | null = null;
    const notes: string[] = [];
    let blocked: string | null = null;
    let handoff: { teamId: string | null } | null = null;
    for (const effect of result.effects) {
      if (effect.kind === 'send_text' || effect.kind === 'send_buttons') {
        const sent = await queueBotMessage(tx, deps, { run, conversation: conv, effect, now });
        if (!sent.ok) {
          blocked = sent.code;
          break;
        }
        messageId = sent.messageId;
      } else if (effect.kind === 'handoff') {
        handoff = { teamId: effect.teamId };
      } else {
        const note = await applyContactEffect(tx, run, effect);
        if (note) notes.push(note);
      }
    }

    const state = result.state;
    const stored = {
      currentNodeId: state.nodeId ?? result.log.nodeId ?? run.currentNodeId,
      nodeVisit: state.visit,
      retries: state.retries,
      stepCount: state.steps,
      messageCount: state.messages,
      visits: { ...state.visits },
      variables: { ...state.variables },
    };
    if (blocked) {
      await appendRunStep(tx, tenantId, run.id, {
        nodeId: result.log.nodeId,
        nodeType: result.log.nodeType,
        outcome: 'failed',
        detail: blocked,
      });
      await endRun(tx, run, {
        status: 'failed',
        reason: 'send_blocked',
        detail: blocked,
        now,
        state: stored,
      });
      return { kind: 'ended' };
    }
    await appendRunStep(tx, tenantId, run.id, {
      nodeId: result.log.nodeId,
      nodeType: result.log.nodeType,
      outcome: result.log.outcome,
      branch: result.log.branch,
      messageId,
      detail: [result.log.detail, ...notes].filter(Boolean).join(', ') || null,
    });

    if (result.status === 'running' || result.status === 'waiting') {
      const waiting = result.status === 'waiting' ? state.waiting : null;
      await tx
        .update(automationRuns)
        .set({
          ...stored,
          status: result.status,
          waitingFor: waiting?.for ?? null,
          waitUntil: waiting?.until ?? null,
          inputMessageId: null,
          nextStepAt: waiting?.until ?? now,
          failures: 0,
        })
        .where(and(eq(automationRuns.tenantId, tenantId), eq(automationRuns.id, run.id)));
      if (waiting) {
        await signalAutomationRun(deps, tx, {
          tenantId,
          runId: run.id,
          actorUserId: run.startedByUserId,
          key: `w:${waiting.until.getTime()}:${state.steps}`,
          at: waiting.until,
        });
        await emitTenantEvent(tx, tenantId, {
          type: 'automation.waiting',
          conversationId: conv.id,
          payload: { runId: run.id },
        });
        return { kind: 'waiting' };
      }
      return { kind: 'progress' };
    }
    const reason = result.endReason ?? 'error';
    const status = result.status;
    await endRun(tx, run, {
      status,
      reason:
        status === 'completed'
          ? reason === 'end_node'
            ? 'end_node'
            : 'no_next'
          : status === 'handed_off'
            ? 'handoff_node'
            : (reason as 'budget_steps' | 'budget_loop' | 'budget_messages' | 'error'),
      detail: result.log.detail,
      now,
      teamId: handoff?.teamId ?? null,
      state: stored,
    });
    return { kind: 'ended' };
  });
}

export type RunTickOutcome = 'ended' | 'waiting' | 'yielded' | 'not_due' | 'idle';

/**
 * Advances a run until it waits, ends, or has taken `STEPS_PER_JOB` steps (then a new job takes
 * over). `scope` comes from `authorizeJob`.
 */
export async function advanceAutomationRun(
  deps: AutomationRunnerDeps,
  scope: TenantScope,
  runId: string,
  actorUserId: string | null,
): Promise<{ outcome: RunTickOutcome; steps: number }> {
  let steps = 0;
  for (let i = 0; i < STEPS_PER_JOB; i += 1) {
    let outcome: StepOutcome;
    try {
      outcome = await runStep(deps, scope, runId);
    } catch (error) {
      // The job still fails with the error (pg-boss retries it and keeps it for inspection); the
      // run only counts the attempt, and fails once the step has failed too often.
      try {
        await recordStepFailure(deps, scope, runId);
      } catch (recordError) {
        throw new AggregateError(
          [error, recordError],
          'An automation step failed, and so did recording the failure',
          { cause: recordError },
        );
      }
      throw error;
    }
    if (outcome.kind !== 'progress') {
      return {
        outcome: outcome.kind,
        steps: steps + (outcome.kind === 'idle' || outcome.kind === 'not_due' ? 0 : 1),
      };
    }
    steps += 1;
  }
  await signalAutomationRun(deps, null, {
    tenantId: scope.tenantId,
    runId,
    actorUserId,
    key: `c:${deps.clock.now().getTime()}`,
  });
  return { outcome: 'yielded', steps };
}

/** Whether the member who started a test run is still active and may still run tests. */
async function testerMayContinue(
  tx: Tx,
  tenantId: string,
  membershipId: string | null,
): Promise<boolean> {
  if (!membershipId) return false;
  const [member] = await tx
    .select({ roles: memberships.roles })
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.id, membershipId),
        eq(memberships.status, 'active'),
      ),
    );
  if (!member) return false;
  const permissions = permissionsForRoles(member.roles);
  return permissions.has('automations.write') && permissions.has('inbox.reply');
}

/**
 * Counts a failed step attempt (its transaction rolled back, so nothing of the step remains). After
 * `MAX_STEP_FAILURES` attempts in a row the run fails with `step_error` and, like any failed run,
 * passes the conversation to people.
 */
async function recordStepFailure(
  deps: AutomationRunnerDeps,
  scope: TenantScope,
  runId: string,
): Promise<void> {
  const tenantId = scope.tenantId;
  await deps.db.run(scope, async (tx) => {
    const [peek] = await tx
      .select({ conversationId: automationRuns.conversationId })
      .from(automationRuns)
      .where(and(eq(automationRuns.tenantId, tenantId), eq(automationRuns.id, runId)));
    if (!peek) return;
    await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, peek.conversationId)))
      .for('update');
    const [run] = await tx
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.tenantId, tenantId), eq(automationRuns.id, runId)))
      .for('update');
    if (!run || (run.status !== 'running' && run.status !== 'waiting')) return;
    const failures = run.failures + 1;
    await tx
      .update(automationRuns)
      .set({ failures })
      .where(and(eq(automationRuns.tenantId, tenantId), eq(automationRuns.id, run.id)));
    if (failures < MAX_STEP_FAILURES) return;
    await appendRunStep(tx, tenantId, run.id, {
      nodeId: run.currentNodeId,
      nodeType: null,
      outcome: 'failed',
      detail: 'step_error',
    });
    await endRun(tx, run, {
      status: 'failed',
      reason: 'error',
      detail: 'step_error',
      now: deps.clock.now(),
    });
  });
}

/**
 * Stops a test run whose member is no longer active (the job's actor check failed). `scope` is
 * the company scope `authorizeJob` returns for clean-up.
 */
export async function stopRunForRemovedTester(
  deps: { db: Database; clock: Clock },
  scope: TenantScope,
  runId: string,
): Promise<boolean> {
  return deps.db.run(scope, async (tx) => {
    const [peek] = await tx
      .select({ conversationId: automationRuns.conversationId })
      .from(automationRuns)
      .where(and(eq(automationRuns.tenantId, scope.tenantId), eq(automationRuns.id, runId)));
    if (!peek) return false;
    await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(eq(conversations.tenantId, scope.tenantId), eq(conversations.id, peek.conversationId)),
      )
      .for('update');
    const [run] = await tx
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.tenantId, scope.tenantId), eq(automationRuns.id, runId)))
      .for('update');
    if (!run || (run.status !== 'running' && run.status !== 'waiting')) return false;
    await appendRunStep(tx, scope.tenantId, run.id, {
      nodeId: run.currentNodeId,
      nodeType: null,
      outcome: 'failed',
      detail: 'tester_not_member',
    });
    await endRun(tx, run, {
      status: 'failed',
      reason: 'error',
      detail: 'tester_not_member',
      now: deps.clock.now(),
    });
    return true;
  });
}

/** Runs the sweep must signal (definer function; ids only, active companies only). */
export async function findDueAutomationRuns(
  db: Database,
  limit = 200,
): Promise<{ tenantId: string; runId: string; actorUserId: string | null }[]> {
  return db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{
        tenant_id: string;
        run_id: string;
        actor_user_id: string | null;
      }>(sql`select tenant_id, run_id, actor_user_id from ops.automation_runs_due(${limit})`);
      return res.rows.map((r) => ({
        tenantId: r.tenant_id,
        runId: r.run_id,
        actorUserId: r.actor_user_id,
      }));
    },
    { accessMode: 'read only' },
  );
}

/** Clears captured answers 30 days after runs end and deletes runs after 180 days (bounded). */
export async function applyAutomationRetention(
  db: Database,
  limit = 1000,
): Promise<{ cleared: number; deleted: number }> {
  return db.run(systemScope, async (tx) => {
    const res = await tx.execute<{ cleared: number; deleted: number }>(
      sql`select cleared, deleted from ops.apply_automation_retention(${limit})`,
    );
    return { cleared: res.rows[0]?.cleared ?? 0, deleted: res.rows[0]?.deleted ?? 0 };
  });
}
