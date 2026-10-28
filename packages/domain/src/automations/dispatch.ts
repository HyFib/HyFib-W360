import { clipText, uuidv7, type Clock } from '@w360/core';
import {
  and,
  asc,
  automationRunCampaigns,
  automationRuns,
  automationVersions,
  automations,
  campaignRecipients,
  eq,
  gt,
  isNotNull,
  isNull,
  lte,
  messages,
  or,
  sql,
  tenants,
  type Tx,
} from '@w360/db';
import { businessStatusAt, loadBusinessCalendar } from '../inbox/business-hours';
import { emitTenantEvent } from '../messaging/events';
import {
  CAMPAIGN_REPLY_HOURS,
  RUN_BUDGETS,
  TRIGGER_TYPE_OF_RANK,
  graphSchema,
  matchTrigger,
  triggerSchema,
  type CampaignReplyContext,
  type TriggerRank,
} from './graph';
import {
  appendRunStep,
  endRun,
  lockActiveRun,
  signalAutomationRun,
  type RunSignalDeps,
} from './runs';
import { consumeAutomationRun } from '../plans/entitlements';

/**
 * Hands a stored customer message to automations, inside the ingestion transaction (the
 * conversation row is already locked):
 * - a run waiting for a reply receives it (the runner processes it next);
 * - an opt-out keyword stops an active run and never starts one;
 * - otherwise, when nobody is assigned and no run is active, the best-matching active automation
 *   starts: a reply to a campaign message first (ADR-414: the chosen campaign and button, the
 *   chosen campaign, any campaign and the chosen button, any campaign), then an exact keyword,
 *   then a keyword in the message, then one with small typos (ADR-240), then "conversation
 *   started", then "any message" (`TriggerRank`); ties go to the automation whose name sorts
 *   first. Business-hours filters,
 *   per-automation cooldowns and a per-conversation hourly cap (bot-to-bot loops) apply.
 *   Automations started by a store's order messages (ADR-050) or through the API (ADR-077) are
 *   never candidates.
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
  /**
   * The WAMID the message quotes or whose button it taps (`context.id`, research M-178 and M-186),
   * if any: a campaign message's starts automations started by replies to a campaign (ADR-414).
   */
  contextExternalId: string | null;
  /** The text of the template quick-reply button tapped (a `button` message), if any. */
  buttonText: string | null;
  /** When WhatsApp says the customer sent it (the webhook's timestamp). */
  sentAt: Date;
}

/** The campaign message a customer's message answers (ADR-414), as its recipient row records it. */
export interface CampaignReply extends CampaignReplyContext {
  /** The variant the customer was sent (ADR-405, ADR-410). */
  variant: string;
}

/**
 * The campaign message an inbound message answers (ADR-414): the outbound message of the same
 * number with the WAMID the inbound message's context names (`messages_external_uq`), the campaign
 * recipient row of that message (`campaign_recipients_message_uq`), of the same contact, queued at
 * most `CAMPAIGN_REPLY_HOURS` before the customer sent the reply (Meta's timestamps are whole
 * seconds, so the queueing time is compared at second precision, as attribution does). Null for a
 * message that names no such message, one that is not a campaign's (a member's, a bot's, a
 * template step's), another contact's, or an older one. Two unique-index lookups only.
 */
export async function findCampaignReply(
  tx: Tx,
  input: Pick<
    InboundForAutomation,
    'tenantId' | 'channelAccountId' | 'contactId' | 'contextExternalId' | 'buttonText' | 'sentAt'
  >,
): Promise<CampaignReply | null> {
  if (!input.contextExternalId) return null;
  const sentAt = input.sentAt.toISOString();
  const [row] = await tx
    .select({ campaignId: campaignRecipients.campaignId, variant: campaignRecipients.variant })
    .from(messages)
    .innerJoin(
      campaignRecipients,
      and(
        eq(campaignRecipients.tenantId, messages.tenantId),
        eq(campaignRecipients.messageId, messages.id),
      ),
    )
    .where(
      and(
        eq(messages.tenantId, input.tenantId),
        eq(messages.channelAccountId, input.channelAccountId),
        eq(messages.externalMessageId, input.contextExternalId),
        eq(messages.direction, 'outbound'),
        eq(campaignRecipients.contactId, input.contactId),
        isNotNull(campaignRecipients.queuedAt),
        lte(sql`date_trunc('second', ${campaignRecipients.queuedAt})`, sql`${sentAt}::timestamptz`),
        gt(
          campaignRecipients.queuedAt,
          sql`${sentAt}::timestamptz - make_interval(hours => ${CAMPAIGN_REPLY_HOURS})`,
        ),
      ),
    )
    .limit(1);
  if (!row) return null;
  const button = input.buttonText?.trim() ?? '';
  return {
    campaignId: row.campaignId,
    variant: row.variant,
    buttonText: button ? clipText(button, 60) : null,
  };
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
    // Any opt-out (all messages or marketing only) is a request to stop, never an answer.
    if (optOut) {
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

  const parsed = candidates.flatMap((candidate) => {
    const trigger = triggerSchema.safeParse(candidate.trigger);
    const graph = graphSchema.safeParse(candidate.graph);
    // Automations started by order messages or through the API never start from a customer message.
    if (
      !trigger.success ||
      !graph.success ||
      trigger.data.type === 'store_event' ||
      trigger.data.type === 'api'
    )
      return [];
    return [{ candidate, trigger: trigger.data, start: graph.data.start }];
  });
  // The campaign message it answers, looked up only when an automation starts from such replies.
  const campaign =
    input.contextExternalId && parsed.some((p) => p.trigger.type === 'campaign_reply')
      ? await findCampaignReply(tx, input)
      : null;

  let best: { rank: TriggerRank; candidate: (typeof candidates)[number]; start: string } | null =
    null;
  for (const { candidate, trigger, start } of parsed) {
    const rank = matchTrigger(trigger, { text: input.text, newCase: input.newCase, campaign });
    if (rank === null || (best && best.rank <= rank)) continue;
    if (trigger.hours !== 'any') {
      const isOpen = await businessOpen();
      if ((trigger.hours === 'open') !== isOpen) continue;
    }
    if (trigger.cooldownMinutes > 0) {
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
              new Date(now.getTime() - trigger.cooldownMinutes * 60_000),
            ),
          ),
        )
        .limit(1);
      if (recent) continue;
    }
    best = { rank, candidate, start };
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
  // The company's plan: automations included and a run left this month (ADR-051). Counted in this
  // transaction, so a run that is not inserted is not counted either.
  if (!(await consumeAutomationRun(tx, input.tenantId, now)).ok) return 'none';

  const runId = uuidv7();
  const triggerType = TRIGGER_TYPE_OF_RANK[best.rank];
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
  if (triggerType === 'campaign_reply' && campaign) {
    // What the run answers, fixed with it (ADR-414): {{campaign.*}}, the run's page and webhooks.
    await tx.insert(automationRunCampaigns).values({
      id: uuidv7(),
      tenantId: input.tenantId,
      runId,
      campaignId: campaign.campaignId,
      variant: campaign.variant,
      buttonText: campaign.buttonText,
    });
  }
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
