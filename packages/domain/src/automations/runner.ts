import { clipText, jsonbText, uuidv7, type Clock, type Keyring } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  asc,
  automationRuns,
  automationVersions,
  channelAccounts,
  contactFields,
  contactIdentities,
  contactTags,
  contacts,
  conversations,
  crmDeals,
  crmPipelines,
  crmStages,
  crmTasks,
  flowSends,
  flows,
  conversationTags,
  eq,
  gte,
  inArray,
  memberships,
  messageTemplates,
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
import { lockCampaignSends, marketingCapReached } from '../campaigns/frequency-cap';
import { checkTemplateEligibility } from '../consent/service';
import { MAX_TAGS_PER_CONTACT, coerceFieldValue } from '../contacts/fields';
import { addActivity, memberRefs } from '../crm/common';
import { localDateAfter } from '../crm/time';
import { scheduleTaskReminder } from '../crm/reminders';
import { FLOW_TOKEN_DAYS, buildFlowMessageRequest, newFlowToken } from '../flows/model';
import { SENDABLE_STATUSES } from '../flows/service';
import { loadEntitlements } from '../plans/entitlements';
import { phoneFromWaId, waRecipientFromPhone } from '../contacts/phone';
import { businessStatusAt, loadBusinessCalendar } from '../inbox/business-hours';
import { MAX_TAGS_PER_CONVERSATION } from '../inbox/conversation-tags';
import { emitTenantEvent } from '../messaging/events';
import { STATUS_RANK } from '../messaging/status';
import { orderPlaceholderValues } from '../stores/order-values';
import {
  TEMPLATE_LIMITS,
  buildTemplateSend,
  linkValuesProblem,
  sendSpecFor,
} from '../templates/definition';
import {
  RUN_BUDGETS,
  dealValueMinor,
  graphSchema,
  type AutomationGraph,
  type AutomationNode,
} from './graph';
import {
  FINISHED_HTTP_STATES,
  httpCallDetail,
  httpCallOfRun,
  queueHttpCall,
  settleOverdueHttpCall,
} from './http';
import {
  advance,
  parseBotButtonId,
  type InboundReply,
  type RunEffect,
  type RunEvent,
  type RunFacts,
  type RunState,
  type StepResult,
} from './interpreter';
import {
  appendRunStep,
  cancelQueuedBotMessages,
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
 * Template steps (ADR-050) are checked again and sent through the same pipeline without the service
 * window; their marketing frequency cap is counted under the campaign runner's company lock, which
 * the runner only tries (it already holds the conversation's lock): when busy, the step is tried
 * again shortly. A run started by order messages or through the API may run in the conversation it
 * started in while that stays resolved (until the customer replies); a conversation resolved later
 * stops it.
 * A step that queues a bot message leaves the run holding that message (`pending_message_id`): the
 * run takes no further step, and does not complete, until the send worker records Meta's
 * acceptance and signals it. A message that fails (at the send or later), is cancelled or has an
 * unknown outcome fails the run with `send_failed`, as does waiting longer than `SEND_WAIT_MS`.
 * A crash before commit leaves nothing behind and the step runs again; after commit the next step
 * starts from the stored position. Nothing about a step is ever applied twice. A step that keeps
 * raising an error fails the run after `MAX_STEP_FAILURES` attempts, so the conversation goes to
 * people instead of waiting on a run that cannot advance.
 */
export interface AutomationRunnerDeps extends RunSignalDeps {
  db: Database;
  clock: Clock;
  /** Encrypts the requests of HTTP steps (the worker decrypts them when it makes the call). */
  keyring: Keyring;
}

/** Steps one job processes before handing the run to a new job (fairness between runs). */
export const STEPS_PER_JOB = 25;
/** Failed attempts at a step (errors, not outcomes) before the run fails with `step_error`. */
export const MAX_STEP_FAILURES = 5;
/** How long a run waits for Meta to accept a bot message before passing the conversation on. */
export const SEND_WAIT_MS = 10 * 60_000;
/** While a message is in flight the sweep re-checks the run this often (a lost signal). */
const PENDING_RECHECK_MS = 60_000;
/** A template step waiting for the campaign runner's company lock tries again after this. */
export const COMPANY_LOCK_RETRY_MS = 2_000;
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
    httpCalls: run.httpCallCount,
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
    // A tap on a quick-reply button of a template: one a template step sent carries its bot button
    // id; any other (a campaign's, an order message's) stays a text reply.
    const text = typeof content.text === 'string' ? content.text : null;
    const payload = typeof content.payload === 'string' ? content.payload : null;
    return payload && parseBotButtonId(payload)
      ? { type: 'button', text, buttonId: payload }
      : { type: 'text', text, buttonId: null };
  }
  return { type: 'other', text: null, buttonId: null };
}

/** Steps whose texts can hold placeholders. */
const TEXT_NODE_TYPES: ReadonlySet<AutomationNode['type']> = new Set([
  'send_text',
  'ask_buttons',
  'ask_text',
  'send_template',
  'ask_template',
  'update_contact',
  'http_request',
]);

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
  const conversationTagRows = await tx
    .select({ tag: conversationTags.tag })
    .from(conversationTags)
    .where(
      and(
        eq(conversationTags.tenantId, run.tenantId),
        eq(conversationTags.conversationId, run.conversationId),
      ),
    );
  let businessOpen = true;
  if (node?.type === 'condition' && node.rules.some((r) => r.kind === 'business_hours')) {
    const hours = await loadBusinessCalendar(tx, run.tenantId, tenant?.timezone ?? 'UTC');
    businessOpen = hours.enabled ? businessStatusAt(hours.calendar, now).open : true;
  }
  // The order of a run started by order messages, as it is now (only for steps with texts).
  const order =
    run.storeOrderId && node && TEXT_NODE_TYPES.has(node.type)
      ? await orderPlaceholderValues(tx, run.tenantId, run.storeOrderId)
      : null;
  return {
    contactName: contact?.name ?? null,
    companyName: tenant?.name ?? '',
    tags: new Set(tagRows.map((t) => t.tag)),
    conversationTags: new Set(conversationTagRows.map((t) => t.tag)),
    fields: contact?.attributes ?? {},
    businessOpen,
    order,
  };
}

type SendEffect = Extract<RunEffect, { kind: 'send_text' | 'send_buttons' | 'send_flow' }>;

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
  if (effect.kind === 'send_flow') {
    return queueBotFlow(tx, deps, {
      run,
      conversation,
      effect,
      now,
      waId: identity.waId,
      whatsappAccountId: channel.whatsappAccountId,
    });
  }

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
    .set({ lastMessageAt: now, lastMessagePreview: clipText(preview, 200) })
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
 * Queues a form step's form (ADR-248) once the channel, window and number checks passed: as in the
 * inbox, the company's plan must include WhatsApp Flows (otherwise `flows_not_in_plan`), and the form
 * must still be published at Meta, of the number's WhatsApp account and not archived (otherwise
 * `flow_unavailable`). It is sent like a member's form, with a new flow token recorded for the
 * conversation and contact, so the customer's answers are applied as the form maps them.
 */
async function queueBotFlow(
  tx: Tx,
  deps: RunSignalDeps,
  input: {
    run: AutomationRun;
    conversation: { id: string; channelAccountId: string; contactId: string };
    effect: Extract<RunEffect, { kind: 'send_flow' }>;
    now: Date;
    waId: string;
    whatsappAccountId: string;
  },
): Promise<{ ok: true; messageId: string } | { ok: false; code: string }> {
  const { run, conversation, effect, now } = input;
  if (!(await loadEntitlements(tx, run.tenantId)).modules.has('flows')) {
    return { ok: false, code: 'flows_not_in_plan' };
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
    .where(and(eq(flows.tenantId, run.tenantId), eq(flows.id, effect.flowId)));
  if (
    !flow ||
    flow.archivedAt ||
    !flow.metaFlowId ||
    flow.whatsappAccountId !== input.whatsappAccountId ||
    !flow.metaStatus ||
    !SENDABLE_STATUSES.includes(flow.metaStatus)
  ) {
    return { ok: false, code: 'flow_unavailable' };
  }
  const message = {
    header: effect.header,
    body: effect.body,
    footer: effect.footer,
    cta: effect.cta,
  };
  const token = newFlowToken();
  const messageId = uuidv7();
  const intentId = uuidv7();
  await tx.insert(messages).values({
    id: messageId,
    tenantId: run.tenantId,
    conversationId: conversation.id,
    channelAccountId: conversation.channelAccountId,
    direction: 'outbound',
    type: 'interactive',
    content: {
      flow: { id: flow.id, name: flow.name, mode: 'published', ...message },
      automationRunId: run.id,
    },
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
    request: buildFlowMessageRequest(input.waId, message, {
      metaFlowId: flow.metaFlowId,
      token,
      mode: 'published',
    }),
    actorUserId: run.startedByUserId,
  });
  await tx.insert(flowSends).values({
    id: uuidv7(),
    tenantId: run.tenantId,
    flowId: flow.id,
    conversationId: conversation.id,
    contactId: conversation.contactId,
    messageId,
    token,
    mode: 'published',
    sentByMembershipId: null,
    expiresAt: new Date(now.getTime() + FLOW_TOKEN_DAYS * 86_400_000),
  });
  await tx
    .update(conversations)
    .set({ lastMessageAt: now, lastMessagePreview: clipText(`[Form] ${flow.name}`, 200) })
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

type TemplateEffect = Extract<RunEffect, { kind: 'send_template' }>;

/**
 * Queues a template step's template through the send pipeline (ADR-050), after checking again that
 * the template is approved, still utility or marketing, with the variables and quick-reply buttons
 * the step expects; that the number is active and of the template's account; the contact's consent
 * for the category; and, for marketing templates, the company's frequency cap. No service window
 * applies. `busy`: the campaign runner's company lock is taken (try again shortly; nothing written).
 */
export async function queueBotTemplate(
  tx: Tx,
  deps: RunSignalDeps,
  input: {
    run: AutomationRun;
    conversation: { id: string; channelAccountId: string; contactId: string };
    effect: TemplateEffect;
    now: Date;
  },
): Promise<{ ok: true; messageId: string } | { ok: false; code: string }> {
  const { run, conversation, effect, now } = input;
  const [template] = await tx
    .select()
    .from(messageTemplates)
    .where(
      and(eq(messageTemplates.tenantId, run.tenantId), eq(messageTemplates.id, effect.templateId)),
    );
  if (
    !template ||
    template.status !== 'approved' ||
    (template.category !== 'UTILITY' && template.category !== 'MARKETING')
  ) {
    return { ok: false, code: 'template_unavailable' };
  }
  const spec = sendSpecFor(template.category, template.components);
  if (!spec.supported) return { ok: false, code: 'template_unavailable' };
  if (
    effect.header.length !== spec.headerParams ||
    effect.body.length !== spec.bodyParams ||
    effect.links.length !== spec.buttonParams
  ) {
    return { ok: false, code: 'template_changed' };
  }
  // A rendered end of a link that the link cannot take (spaces, too long, another website).
  if (
    effect.links.some((v) => v.length > TEMPLATE_LIMITS.parameterValue) ||
    linkValuesProblem(spec.definition, effect.links)
  ) {
    return { ok: false, code: 'invalid_link' };
  }
  if (effect.ask) {
    // The quick-reply buttons the step branches on, exactly as the template has them now.
    const quickReplies = spec.definition.buttons.flatMap((b, index) =>
      b.type === 'QUICK_REPLY' ? [{ index, title: b.text }] : [],
    );
    if (
      quickReplies.length !== effect.buttons.length ||
      quickReplies.some(
        (q, i) => q.index !== effect.buttons[i]?.index || q.title !== effect.buttons[i]?.title,
      )
    ) {
      return { ok: false, code: 'template_changed' };
    }
  }
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
  if (
    !channel ||
    channel.status !== 'active' ||
    channel.whatsappAccountId !== template.whatsappAccountId
  ) {
    return { ok: false, code: 'channel_unavailable' };
  }
  const [contact] = await tx
    .select({ phoneE164: contacts.phoneE164, erasedAt: contacts.erasedAt })
    .from(contacts)
    .where(and(eq(contacts.tenantId, run.tenantId), eq(contacts.id, conversation.contactId)));
  if (!contact || contact.erasedAt) return { ok: false, code: 'contact_erased' };
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
  // The customer's WhatsApp id on this account, else the number HyFib has for them.
  const recipient = phoneFromWaId(identity?.waId) ?? contact.phoneE164;
  if (!recipient) return { ok: false, code: 'no_phone' };
  const eligibility = await checkTemplateEligibility(tx, {
    tenantId: run.tenantId,
    contactId: conversation.contactId,
    recipientPhones: [recipient],
    category: template.category,
  });
  if (!eligibility.ok) return { ok: false, code: eligibility.code };
  if (template.category === 'MARKETING') {
    if (!(await lockCampaignSends(tx, run.tenantId, 'try'))) return { ok: false, code: 'busy' };
    if (await marketingCapReached(tx, run.tenantId, conversation.contactId, now)) {
      return { ok: false, code: 'frequency_capped' };
    }
  }
  const built = buildTemplateSend(
    template,
    spec,
    { header: effect.header, body: effect.body, buttons: effect.links },
    { quickReplyPayloads: new Map(effect.buttons.map((b) => [b.index, b.payload])) },
  );
  const messageId = uuidv7();
  const intentId = uuidv7();
  await tx.insert(messages).values({
    id: messageId,
    tenantId: run.tenantId,
    conversationId: conversation.id,
    channelAccountId: conversation.channelAccountId,
    direction: 'outbound',
    type: 'template',
    content: {
      template: {
        id: template.id,
        name: template.name,
        language: template.language,
        category: template.category,
      },
      rendered: built.rendered,
      automationRunId: run.id,
    },
    status: 'queued',
    statusRank: STATUS_RANK.queued,
    senderType: 'bot',
    senderMembershipId: null,
    templateId: template.id,
  });
  await tx.insert(sendIntents).values({
    id: intentId,
    tenantId: run.tenantId,
    messageId,
    channelAccountId: conversation.channelAccountId,
    request: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: waRecipientFromPhone(recipient),
      type: 'template',
      template: built.template,
    },
    actorUserId: run.startedByUserId,
  });
  await tx
    .update(conversations)
    .set({ lastMessageAt: now, lastMessagePreview: clipText(built.rendered.body, 200) })
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
 * Applies a contact update; returns a note for the step log when it was skipped. Single statements
 * change the contact, after its row is locked for key share, the weakest lock: adding a tag takes
 * it for the tag's key anyway, and recording the change (0091) takes it when a tag is removed.
 * Members and keys hold the contact for update while they change its tags, so taking it before any
 * tag means that when a run and a member change the same tag, one waits for the other instead of
 * deadlocking (the step already holds the conversation lock, and contact erasure takes conversation
 * locks before the contact's, so the order is the same).
 */
async function applyContactEffect(
  tx: Tx,
  run: AutomationRun,
  effect: Extract<RunEffect, { kind: 'add_tag' | 'remove_tag' | 'set_field' }>,
): Promise<string | null> {
  const [contact] = await tx
    .select({ erasedAt: contacts.erasedAt })
    .from(contacts)
    .where(and(eq(contacts.tenantId, run.tenantId), eq(contacts.id, run.contactId)))
    .for('key share');
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
          : sql`${contacts.attributes} || jsonb_build_object(${field.key}::text, ${jsonbText(coerced.value)}::jsonb)`,
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

/**
 * Tags or untags the run's conversation (ADR-222) as members do in the inbox; returns a note for the
 * step log when it was skipped. The step holds the conversation's row lock, which members and keys
 * take before changing its tags, so the count of its tags and the change see one state. A
 * conversation at the limit of tags keeps its tags; one whose contact was erased takes none.
 */
async function applyConversationEffect(
  tx: Tx,
  run: AutomationRun,
  assignedMembershipId: string | null,
  effect: Extract<RunEffect, { kind: 'add_conversation_tag' | 'remove_conversation_tag' }>,
): Promise<string | null> {
  const thisConversation = and(
    eq(conversationTags.tenantId, run.tenantId),
    eq(conversationTags.conversationId, run.conversationId),
  );
  let changed: boolean;
  if (effect.kind === 'remove_conversation_tag') {
    const removed = await tx
      .delete(conversationTags)
      .where(and(thisConversation, eq(conversationTags.tag, effect.tag)))
      .returning({ id: conversationTags.id });
    changed = removed.length > 0;
  } else {
    const [contact] = await tx
      .select({ erasedAt: contacts.erasedAt })
      .from(contacts)
      .where(and(eq(contacts.tenantId, run.tenantId), eq(contacts.id, run.contactId)));
    if (!contact || contact.erasedAt) return 'contact_erased';
    const current = await tx
      .select({ tag: conversationTags.tag })
      .from(conversationTags)
      .where(thisConversation);
    if (current.some((row) => row.tag === effect.tag)) return null;
    if (current.length >= MAX_TAGS_PER_CONVERSATION) return 'conversation_too_many_tags';
    await tx.insert(conversationTags).values({
      id: uuidv7(),
      tenantId: run.tenantId,
      conversationId: run.conversationId,
      tag: effect.tag,
    });
    changed = true;
  }
  if (changed) {
    await tx
      .update(conversations)
      .set({ updatedAt: sql`now()` })
      .where(
        and(eq(conversations.tenantId, run.tenantId), eq(conversations.id, run.conversationId)),
      );
    await emitTenantEvent(tx, run.tenantId, {
      type: 'conversation.tags',
      conversationId: run.conversationId,
      assignedMembershipId,
    });
  }
  return null;
}

/**
 * Creates the CRM task a step asks for (ADR-244) about the run's contact, as the automation, and
 * puts it on the contact's CRM timeline; returns a note for the step log when it was skipped. A
 * member who left or can no longer use the CRM gets no task, nor does an erased contact, and a title
 * whose placeholders filled in nothing creates none. The contact is held for key share, as for the
 * contact's tags, so an erasure waits for the task (and deletes it) or comes first.
 */
async function applyTaskEffect(
  tx: Tx,
  deps: AutomationRunnerDeps,
  run: AutomationRun,
  effect: Extract<RunEffect, { kind: 'create_task' }>,
  now: Date,
): Promise<string | null> {
  // A plan without the CRM takes away writing it (ADR-051), from automations too (ADR-249).
  if (!(await loadEntitlements(tx, run.tenantId)).modules.has('crm')) return 'crm_not_in_plan';
  if (!effect.title) return 'task_title_empty';
  const [contact] = await tx
    .select({ erasedAt: contacts.erasedAt })
    .from(contacts)
    .where(and(eq(contacts.tenantId, run.tenantId), eq(contacts.id, run.contactId)))
    .for('key share');
  if (!contact || contact.erasedAt) return 'contact_erased';
  const assignee = (await memberRefs(tx, run.tenantId, [effect.assigneeMembershipId])).get(
    effect.assigneeMembershipId,
  );
  if (!assignee?.active) return 'task_assignee_unavailable';
  const id = uuidv7();
  const dueAt =
    effect.dueInHours === null ? null : new Date(now.getTime() + effect.dueInHours * 3_600_000);
  // A reminder is emailed when the task is due (ADR-246), as for a member's task with a reminder.
  const remindAt = effect.remind ? dueAt : null;
  await tx.insert(crmTasks).values({
    id,
    tenantId: run.tenantId,
    title: effect.title,
    contactId: run.contactId,
    assigneeMembershipId: effect.assigneeMembershipId,
    dueAt,
    remindAt,
    reminderState: remindAt ? 'pending' : 'none',
    createdByAutomationId: run.automationId,
  });
  if (remindAt) {
    await scheduleTaskReminder(deps, tx, { tenantId: run.tenantId, taskId: id, remindAt });
  }
  await addActivity(tx, {
    tenantId: run.tenantId,
    contactId: run.contactId,
    taskId: id,
    actorMembershipId: null,
    kind: 'task_created',
    data: { automationId: run.automationId, runId: run.id },
    at: now,
  });
  return null;
}

/**
 * Creates the CRM deal a step asks for (ADR-245) for the run's contact and conversation, as the
 * automation, and puts it on the contact's CRM timeline. Nothing is created (`skipped`, with a note
 * for the step log) for an erased contact, a pipeline or stage that is archived or gone, a contact
 * who already has an open deal in the pipeline, or a title whose placeholders filled in nothing. An
 * owner who can no longer use the CRM, or a value that is not an amount in the pipeline's currency,
 * is left out of the deal with a note. The contact is held for no key update, so two runs of the
 * same contact (in two conversations) create one deal, one after the other.
 */
async function applyDealEffect(
  tx: Tx,
  run: AutomationRun,
  effect: Extract<RunEffect, { kind: 'create_deal' }>,
  now: Date,
): Promise<{ skipped: boolean; notes: string[] }> {
  const skip = (note: string) => ({ skipped: true, notes: [note] });
  // As for task steps (ADR-249).
  if (!(await loadEntitlements(tx, run.tenantId)).modules.has('crm'))
    return skip('crm_not_in_plan');
  if (!effect.title) return skip('deal_title_empty');
  const [contact] = await tx
    .select({ erasedAt: contacts.erasedAt })
    .from(contacts)
    .where(and(eq(contacts.tenantId, run.tenantId), eq(contacts.id, run.contactId)))
    .for('no key update');
  if (!contact || contact.erasedAt) return skip('contact_erased');
  const [pipeline] = await tx
    .select({ archivedAt: crmPipelines.archivedAt, currency: crmPipelines.currency })
    .from(crmPipelines)
    .where(and(eq(crmPipelines.tenantId, run.tenantId), eq(crmPipelines.id, effect.pipelineId)))
    .for('share');
  const [stage] = await tx
    .select({ archivedAt: crmStages.archivedAt })
    .from(crmStages)
    .where(
      and(
        eq(crmStages.tenantId, run.tenantId),
        eq(crmStages.id, effect.stageId),
        eq(crmStages.pipelineId, effect.pipelineId),
      ),
    );
  if (!pipeline || pipeline.archivedAt || !stage || stage.archivedAt) {
    return skip('deal_stage_unavailable');
  }
  const [open] = await tx
    .select({ id: crmDeals.id })
    .from(crmDeals)
    .where(
      and(
        eq(crmDeals.tenantId, run.tenantId),
        eq(crmDeals.contactId, run.contactId),
        eq(crmDeals.pipelineId, effect.pipelineId),
        eq(crmDeals.status, 'open'),
      ),
    )
    .limit(1);
  if (open) return skip('deal_already_open');
  const notes: string[] = [];
  let owner = effect.ownerMembershipId;
  if (owner && !(await memberRefs(tx, run.tenantId, [owner])).get(owner)?.active) {
    owner = null;
    notes.push('deal_owner_unavailable');
  }
  let valueMinor = dealValueMinor(effect.value, pipeline.currency);
  if (valueMinor === undefined) {
    valueMinor = null;
    notes.push('deal_value_invalid');
  }
  // The expected close date is a date on the company's calendar (ADR-247).
  let expectedCloseOn: string | null = null;
  if (effect.closeInDays !== null) {
    const [company] = await tx
      .select({ timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, run.tenantId));
    if (company) expectedCloseOn = localDateAfter(now, company.timezone, effect.closeInDays);
  }
  const id = uuidv7();
  await tx.insert(crmDeals).values({
    id,
    tenantId: run.tenantId,
    pipelineId: effect.pipelineId,
    stageId: effect.stageId,
    contactId: run.contactId,
    conversationId: run.conversationId,
    title: effect.title,
    valueMinor,
    ownerMembershipId: owner,
    expectedCloseOn,
    stageEnteredAt: now,
    createdByAutomationId: run.automationId,
  });
  await addActivity(tx, {
    tenantId: run.tenantId,
    contactId: run.contactId,
    dealId: id,
    actorMembershipId: null,
    kind: 'deal_created',
    data: { stageId: effect.stageId, valueMinor, automationId: run.automationId, runId: run.id },
    at: now,
  });
  return { skipped: false, notes };
}

/**
 * Moves the run's contact's open deal in the step's pipeline to the step's stage (ADR-250), as the
 * automation, and puts the move on the deal's timeline as a member's move is. Nothing moves (a note
 * for the step log, which says `skipped`) when the plan leaves out the CRM, the contact was erased,
 * the stage or its pipeline is archived or gone, the contact has no open deal in the pipeline or more
 * than one (which one is meant is not known), or the deal is already in the stage. Locks are taken
 * in the CRM's order: the contact (against erasure), the pipeline (against archiving), the deals.
 */
async function applyMoveDealEffect(
  tx: Tx,
  run: AutomationRun,
  effect: Extract<RunEffect, { kind: 'move_deal' }>,
  now: Date,
): Promise<string | null> {
  if (!(await loadEntitlements(tx, run.tenantId)).modules.has('crm')) return 'crm_not_in_plan';
  const [contact] = await tx
    .select({ erasedAt: contacts.erasedAt })
    .from(contacts)
    .where(and(eq(contacts.tenantId, run.tenantId), eq(contacts.id, run.contactId)))
    .for('key share');
  if (!contact || contact.erasedAt) return 'contact_erased';
  const [pipeline] = await tx
    .select({ archivedAt: crmPipelines.archivedAt })
    .from(crmPipelines)
    .where(and(eq(crmPipelines.tenantId, run.tenantId), eq(crmPipelines.id, effect.pipelineId)))
    .for('share');
  const [stage] = await tx
    .select({ archivedAt: crmStages.archivedAt })
    .from(crmStages)
    .where(
      and(
        eq(crmStages.tenantId, run.tenantId),
        eq(crmStages.id, effect.stageId),
        eq(crmStages.pipelineId, effect.pipelineId),
      ),
    );
  if (!pipeline || pipeline.archivedAt || !stage || stage.archivedAt) {
    return 'deal_stage_unavailable';
  }
  const open = await tx
    .select({ id: crmDeals.id, stageId: crmDeals.stageId, version: crmDeals.version })
    .from(crmDeals)
    .where(
      and(
        eq(crmDeals.tenantId, run.tenantId),
        eq(crmDeals.contactId, run.contactId),
        eq(crmDeals.pipelineId, effect.pipelineId),
        eq(crmDeals.status, 'open'),
      ),
    )
    .orderBy(asc(crmDeals.id))
    .limit(2)
    .for('update');
  const [deal] = open;
  if (!deal) return 'deal_not_open';
  if (open.length > 1) return 'deal_ambiguous';
  if (deal.stageId === effect.stageId) return 'deal_in_stage';
  await tx
    .update(crmDeals)
    .set({ stageId: effect.stageId, stageEnteredAt: now, version: deal.version + 1 })
    .where(and(eq(crmDeals.tenantId, run.tenantId), eq(crmDeals.id, deal.id)));
  await addActivity(tx, {
    tenantId: run.tenantId,
    contactId: run.contactId,
    dealId: deal.id,
    actorMembershipId: null,
    kind: 'stage_changed',
    data: {
      fromStageId: deal.stageId,
      toStageId: effect.stageId,
      automationId: run.automationId,
      runId: run.id,
    },
    at: now,
  });
  return null;
}

type StepOutcome =
  | { kind: 'progress' }
  | { kind: 'waiting' }
  | { kind: 'sending' }
  | { kind: 'ended' }
  | { kind: 'not_due' }
  | { kind: 'idle' };

/**
 * The first message of the run that will never reach the customer: failed (at the send, or
 * reported by Meta later), cancelled, or sent with an unknown outcome. Returns the step-log code.
 */
async function undeliveredBotMessage(
  tx: Tx,
  tenantId: string,
  run: AutomationRun,
): Promise<string | null> {
  const [row] = await tx
    .select({ status: messages.status, errorCode: messages.errorCode })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, tenantId),
        eq(messages.conversationId, run.conversationId),
        eq(messages.senderType, 'bot'),
        // Bounds the scan to the run's lifetime (with a margin for clock differences).
        gte(messages.createdAt, new Date(run.startedAt.getTime() - 5 * 60_000)),
        sql`${messages.content}->>'automationRunId' = ${run.id}`,
        inArray(messages.status, ['failed', 'canceled', 'unknown_outcome']),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(1);
  if (!row) return null;
  if (row.status === 'failed') return row.errorCode ? `failed:${row.errorCode}` : 'failed';
  return row.status;
}

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
        resolvedAt: conversations.resolvedAt,
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
      reason: 'expired' | 'error' | 'send_failed' | 'conversation_resolved' | 'assigned',
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

    // The hand-off lock and the run's limits, checked on every step. A run started by order messages
    // or through the API runs in its conversation while that stays resolved as it was when the run
    // started (until the customer replies); one resolved after the run started stops it.
    const closedSinceStart =
      (run.triggerType === 'store_event' || run.triggerType === 'api') &&
      conv.resolvedAt !== null &&
      conv.resolvedAt.getTime() <= run.startedAt.getTime();
    if (conv.status === 'resolved' && !closedSinceStart)
      return end('stopped', 'conversation_resolved', null);
    if (conv.assignedMembershipId && conv.assignedMembershipId !== run.startedByMembershipId)
      return end('taken_over', 'assigned', null);
    if (now.getTime() - run.startedAt.getTime() > RUN_BUDGETS.maxRunMs)
      return end('failed', 'expired', null);
    // A test run acts for the member who started it, so it stops once they may no longer test
    // (the job's actor check already stops it when they leave the company).
    if (run.mode === 'test' && !(await testerMayContinue(tx, tenantId, run.startedByMembershipId)))
      return end('failed', 'error', 'tester_not_permitted');

    // Sends. A message of this run the customer will not get ends the run (the conversation goes
    // to people); a message still in flight holds the run until Meta accepts it.
    const undelivered = await undeliveredBotMessage(tx, tenantId, run);
    if (undelivered) return end('failed', 'send_failed', undelivered);
    if (run.pendingMessageId) {
      const [pending] = await tx
        .select({ status: messages.status, createdAt: messages.createdAt })
        .from(messages)
        .where(and(eq(messages.tenantId, tenantId), eq(messages.id, run.pendingMessageId)));
      if (pending && (pending.status === 'queued' || pending.status === 'sending')) {
        if (now.getTime() - pending.createdAt.getTime() >= SEND_WAIT_MS) {
          // Not sent in time: it is cancelled if no send worker has claimed it yet.
          await cancelQueuedBotMessages(tx, tenantId, run.conversationId, now);
          return end('failed', 'send_failed', 'send_timeout');
        }
        await tx
          .update(automationRuns)
          .set({ nextStepAt: new Date(now.getTime() + PENDING_RECHECK_MS) })
          .where(and(eq(automationRuns.tenantId, tenantId), eq(automationRuns.id, run.id)));
        return { kind: 'not_due' };
      }
      // Accepted by Meta: the run continues from its stored position.
      const nextStepAt =
        run.status === 'waiting' && !run.inputMessageId ? (run.waitUntil ?? now) : now;
      await tx
        .update(automationRuns)
        .set({ pendingMessageId: null, nextStepAt })
        .where(and(eq(automationRuns.tenantId, tenantId), eq(automationRuns.id, run.id)));
      run.pendingMessageId = null;
      run.nextStepAt = nextStepAt;
      if (run.status === 'waiting') {
        // Live views showed the run as sending; it now waits for the customer or its timer.
        await emitTenantEvent(tx, tenantId, {
          type: 'automation.waiting',
          conversationId: conv.id,
          payload: { runId: run.id },
        });
      }
      if (run.status === 'running' && run.currentNodeId === null) {
        // The last step sent a message; now that it is accepted the run is complete.
        await endRun(tx, run, { status: 'completed', reason: 'no_next', now });
        return { kind: 'ended' };
      }
    }

    let event: RunEvent;
    if (run.status === 'waiting') {
      if (run.waitingFor === 'http') {
        // The result of the call the run waits for, or its absence at the deadline (the call is
        // locked, so a result cannot arrive between the two checks).
        const call = await httpCallOfRun(tx, run);
        if (call && FINISHED_HTTP_STATES.has(call.state)) {
          event = {
            kind: 'http_result',
            ok: call.state === 'succeeded',
            values: call.state === 'succeeded' ? call.savedValues : {},
            detail: httpCallDetail(call),
          };
        } else if (run.waitUntil && run.waitUntil <= now) {
          const detail = call
            ? await settleOverdueHttpCall(tx, tenantId, call.id, now)
            : 'missing_call';
          event = { kind: 'http_result', ok: false, values: {}, detail };
        } else {
          return { kind: 'not_due' };
        }
      } else if (run.inputMessageId) {
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
    // A task or deal step that created nothing (ADR-244, ADR-245): the step log says so and why.
    let skipped = false;
    let handoff: { teamId: string | null } | null = null;
    for (const effect of result.effects) {
      if (
        effect.kind === 'send_text' ||
        effect.kind === 'send_buttons' ||
        effect.kind === 'send_flow'
      ) {
        const sent = await queueBotMessage(tx, deps, { run, conversation: conv, effect, now });
        if (!sent.ok) {
          blocked = sent.code;
          break;
        }
        messageId = sent.messageId;
      } else if (effect.kind === 'send_template') {
        const sent = await queueBotTemplate(tx, deps, { run, conversation: conv, effect, now });
        if (!sent.ok && sent.code === 'busy') {
          // The campaign runner holds the company lock: the step (a template step's only effect,
          // so nothing of it was applied) runs again shortly from the same position.
          const retryAt = new Date(now.getTime() + COMPANY_LOCK_RETRY_MS);
          await tx
            .update(automationRuns)
            .set({ nextStepAt: retryAt })
            .where(and(eq(automationRuns.tenantId, tenantId), eq(automationRuns.id, run.id)));
          await signalAutomationRun(deps, tx, {
            tenantId,
            runId: run.id,
            actorUserId: run.startedByUserId,
            key: `l:${retryAt.getTime()}`,
            at: retryAt,
          });
          return { kind: 'not_due' };
        }
        if (!sent.ok) {
          blocked = sent.code;
          break;
        }
        messageId = sent.messageId;
      } else if (effect.kind === 'handoff') {
        handoff = { teamId: effect.teamId };
      } else if (effect.kind === 'http_request') {
        await queueHttpCall(tx, deps, {
          run,
          nodeId: result.log.nodeId ?? run.currentNodeId ?? '',
          visit: result.state.visit,
          effect,
          now,
        });
      } else if (
        effect.kind === 'add_conversation_tag' ||
        effect.kind === 'remove_conversation_tag'
      ) {
        const note = await applyConversationEffect(tx, run, conv.assignedMembershipId, effect);
        if (note) notes.push(note);
      } else if (effect.kind === 'create_task') {
        const note = await applyTaskEffect(tx, deps, run, effect, now);
        if (note) {
          notes.push(note);
          skipped = true;
        }
      } else if (effect.kind === 'create_deal') {
        const deal = await applyDealEffect(tx, run, effect, now);
        notes.push(...deal.notes);
        skipped = deal.skipped;
      } else if (effect.kind === 'move_deal') {
        const note = await applyMoveDealEffect(tx, run, effect, now);
        if (note) {
          notes.push(note);
          skipped = true;
        }
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
      httpCallCount: state.httpCalls,
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
      outcome: skipped ? 'skipped' : result.log.outcome,
      branch: result.log.branch,
      messageId,
      detail: [result.log.detail, ...notes].filter(Boolean).join(', ') || null,
    });

    // A queued message holds the run until Meta accepts it (see the send checks above).
    const holdUntil = new Date(now.getTime() + PENDING_RECHECK_MS);
    if (messageId && result.status === 'completed') {
      // The last step sent a message: the run completes once Meta accepts it.
      await tx
        .update(automationRuns)
        .set({
          ...stored,
          currentNodeId: null,
          status: 'running',
          waitingFor: null,
          waitUntil: null,
          inputMessageId: null,
          pendingMessageId: messageId,
          nextStepAt: holdUntil,
          failures: 0,
        })
        .where(and(eq(automationRuns.tenantId, tenantId), eq(automationRuns.id, run.id)));
      return { kind: 'sending' };
    }
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
          pendingMessageId: messageId,
          nextStepAt: messageId ? holdUntil : (waiting?.until ?? now),
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
      return { kind: messageId ? 'sending' : 'progress' };
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
            : (reason as
                'budget_steps' | 'budget_loop' | 'budget_messages' | 'budget_http' | 'error'),
      detail: result.log.detail,
      now,
      teamId: handoff?.teamId ?? null,
      state: stored,
    });
    return { kind: 'ended' };
  });
}

/** `sending`: a message was queued and the run continues once Meta accepts it. */
export type RunTickOutcome = 'ended' | 'waiting' | 'sending' | 'yielded' | 'not_due' | 'idle';

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
