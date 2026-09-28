import { uuidv7 } from '@w360/core';
import {
  and,
  automationRuns,
  automationVersions,
  automations,
  channelAccounts,
  conversations,
  eq,
  gt,
  sql,
  suppressions,
  type Tx,
} from '@w360/db';
import { RUN_BUDGETS, graphSchema, triggerSchema } from '../automations/graph';
import { appendRunStep, lockActiveRun, signalAutomationRun } from '../automations/runs';
import { checkTemplateEligibility } from '../consent/service';
import { contactForPhone } from '../contacts/service';
import { emitTenantEvent } from '../messaging/events';
import type { AutomationEvent, StoreMessageSkipReason } from './messages-model';
import type { StoreMessageQueueDeps } from './order-messages';

/**
 * Starts the automation an order message rule names (ADR-050), inside the store message job's
 * transaction (the store message row is locked; the order message checks already passed). The
 * automation must be active with a published version that starts from order messages and allows
 * the rule's number; the number must be active and not suppressed; the contact must accept messages
 * at all; the conversation must not be assigned to a member or handled by another automation; and
 * the per-conversation hourly limit on runs applies. The contact and the conversation are created
 * as for a template (a new conversation starts resolved: the customer's reply opens it).
 */
export async function startStoreAutomation(
  tx: Tx,
  deps: StoreMessageQueueDeps,
  input: {
    tenantId: string;
    event: AutomationEvent;
    orderId: string;
    automationId: string;
    channelAccountId: string;
    phone: string;
    customerName: string | null;
    now: Date;
  },
): Promise<
  { ok: true; runId: string; contactId: string } | { ok: false; reason: StoreMessageSkipReason }
> {
  const { tenantId, now } = input;
  const skip = (reason: StoreMessageSkipReason) => ({ ok: false as const, reason });
  const [automation] = await tx
    .select({
      id: automations.id,
      status: automations.status,
      activeVersionId: automations.activeVersionId,
    })
    .from(automations)
    .where(and(eq(automations.tenantId, tenantId), eq(automations.id, input.automationId)));
  if (!automation || automation.status !== 'active' || !automation.activeVersionId) {
    return skip('automation_unavailable');
  }
  const [version] = await tx
    .select({
      id: automationVersions.id,
      trigger: automationVersions.trigger,
      graph: automationVersions.graph,
      channelAccountId: automationVersions.channelAccountId,
    })
    .from(automationVersions)
    .where(
      and(
        eq(automationVersions.tenantId, tenantId),
        eq(automationVersions.id, automation.activeVersionId),
      ),
    );
  const trigger = triggerSchema.safeParse(version?.trigger);
  const graph = graphSchema.safeParse(version?.graph);
  if (!version || !trigger.success || trigger.data.type !== 'store_event' || !graph.success) {
    return skip('automation_unavailable');
  }
  if (version.channelAccountId && version.channelAccountId !== input.channelAccountId) {
    return skip('channel_unavailable');
  }
  const [channel] = await tx
    .select({ status: channelAccounts.status })
    .from(channelAccounts)
    .where(
      and(eq(channelAccounts.tenantId, tenantId), eq(channelAccounts.id, input.channelAccountId)),
    );
  if (!channel || channel.status !== 'active') return skip('channel_unavailable');

  // A suppressed number gets no contact created; erasure and opt-outs are the contact's consent.
  const [suppressed] = await tx
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(and(eq(suppressions.tenantId, tenantId), eq(suppressions.phoneE164, input.phone)))
    .limit(1);
  if (suppressed) return skip('suppressed');
  const contactId = await contactForPhone(tx, tenantId, {
    phoneE164: input.phone,
    displayName: input.customerName,
    source: 'store',
  });
  // Messages at all (the run checks each template's own category when it sends it).
  const eligibility = await checkTemplateEligibility(tx, {
    tenantId,
    contactId,
    recipientPhones: [input.phone],
    category: 'UTILITY',
  });
  if (!eligibility.ok) return skip(eligibility.code);

  await tx
    .insert(conversations)
    .values({
      id: uuidv7(),
      tenantId,
      channelAccountId: input.channelAccountId,
      contactId,
      status: 'resolved',
      resolvedAt: now,
    })
    .onConflictDoNothing();
  const [conversation] = await tx
    .select({
      id: conversations.id,
      status: conversations.status,
      resolvedAt: conversations.resolvedAt,
      assignedMembershipId: conversations.assignedMembershipId,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.channelAccountId, input.channelAccountId),
        eq(conversations.contactId, contactId),
      ),
    )
    .for('update');
  if (!conversation) throw new Error('Conversation upsert failed');
  if (conversation.assignedMembershipId) return skip('conversation_assigned');
  if (await lockActiveRun(tx, tenantId, conversation.id)) return skip('automation_busy');
  const [recent] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.tenantId, tenantId),
        eq(automationRuns.conversationId, conversation.id),
        gt(automationRuns.startedAt, new Date(now.getTime() - 3600_000)),
      ),
    );
  if ((recent?.n ?? 0) >= RUN_BUDGETS.maxRunsPerConversationPerHour) {
    return skip('automation_limit');
  }

  // The run may work in the conversation while it stays resolved as it is now (the runner compares
  // the time it was resolved with the run's start), so the start is never before that time.
  const startedAt =
    conversation.status === 'resolved' && conversation.resolvedAt && conversation.resolvedAt > now
      ? conversation.resolvedAt
      : now;
  const runId = uuidv7();
  await tx.insert(automationRuns).values({
    id: runId,
    tenantId,
    automationId: automation.id,
    versionId: version.id,
    conversationId: conversation.id,
    contactId,
    channelAccountId: input.channelAccountId,
    mode: 'live',
    triggerType: 'store_event',
    storeOrderId: input.orderId,
    storeEvent: input.event,
    status: 'running',
    currentNodeId: graph.data.start,
    nextStepAt: now,
    startedAt,
  });
  await appendRunStep(tx, tenantId, runId, {
    nodeId: null,
    nodeType: null,
    outcome: 'started',
    detail: `store_event:${input.event}`,
  });
  await emitTenantEvent(tx, tenantId, {
    type: 'automation.started',
    conversationId: conversation.id,
    payload: { runId, automationId: automation.id },
  });
  await signalAutomationRun(deps, tx, { tenantId, runId, actorUserId: null, key: 'start' });
  return { ok: true, runId, contactId };
}
