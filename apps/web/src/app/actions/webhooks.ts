'use server';
import { refresh } from 'next/cache';
import {
  webhookHost,
  type WebhookContactFieldValue,
  type WebhookOAuthClientAuth,
  type WebhookOAuthNextKeyAction,
  type WebhookReplayPeriod,
} from '@w360/domain/webhook-model';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { requestMeta } from '@/server/session';
import { tenantForAction } from '@/server/tenant-action';

/**
 * Company webhook endpoints (Settings → Webhooks). A new signing secret goes to the browser once,
 * here, when an endpoint is created or its secret rotated.
 */

/** An endpoint's OAuth client as the form gives it (ADR-173, ADR-357, ADR-367, ADR-368). */
interface WebhookOAuthActionInput {
  tokenUrl: string;
  clientId: string;
  /** Left out, a change keeps the stored secret; a client signing with a key pair has none. */
  clientSecret?: string;
  scope: string;
  clientAuthentication: WebhookOAuthClientAuth;
  /** A client that signs with HyFib's key pair gets a new one (ADR-367). */
  replaceKey?: boolean;
  /** What becomes of that client's next key pair (ADR-368). */
  nextKey?: WebhookOAuthNextKeyAction;
  /** The next key shown, which using or dropping it names (ADR-368). */
  nextKeyId?: string;
}
export async function createWebhookEndpointAction(
  slug: string,
  input: {
    url: string;
    description: string;
    eventTypes: string[];
    headers: { name: string; value: string }[];
    /** The message.status statuses the endpoint takes; null takes every status. */
    messageStatuses: string[] | null;
    /** Who sent the messages whose statuses it takes (ADR-172); null takes every sender. */
    messageSenders: string[] | null;
    /** The API keys whose sent messages' statuses it takes (ADR-320); null: every message. */
    messageApiKeyIds: string[] | null;
    /** The contact parts it takes as contact.updated; null takes every change. */
    contactParts: string[] | null;
    /** The custom fields whose changes it takes (ADR-184); null takes every field's. */
    contactFieldKeys: string[] | null;
    /** The automations whose runs it takes (ADR-145); null takes every automation. */
    automationIds: string[] | null;
    /** The campaign statuses it takes (ADR-146); null takes every status. */
    campaignStatuses: string[] | null;
    /** The order statuses it takes (ADR-147); null takes every status. */
    orderStatuses: string[] | null;
    /** The Payment Link statuses it takes (ADR-308); null takes every status. */
    paymentLinkStatuses: string[] | null;
    /** The cash on delivery answers it takes (ADR-349); null takes every answer. */
    codAnswers: string[] | null;
    /**
     * The stores whose cash on delivery answers (ADR-349), order messages (ADR-352, ADR-353) and
     * cart reminders (ADR-355) it takes; null takes every one's.
     */
    storeIds: string[] | null;
    /** The order messages whose skips and sends it takes (ADR-352, ADR-353); null takes every message's. */
    orderMessageEvents: string[] | null;
    /** The reasons whose order message skips it takes (ADR-354); null takes every reason. */
    orderMessageSkipReasons: string[] | null;
    /** The cart reminders whose skips and sends it takes (ADR-361); null takes both. */
    cartReminders: string[] | null;
    /** The reasons whose cart reminder skips it takes (ADR-356); null takes every reason. */
    cartReminderSkipReasons: string[] | null;
    /** The reasons whose campaign recipient skips it takes (ADR-359); null takes every reason. */
    campaignSkipReasons: string[] | null;
    /** The outcomes of the run steps it takes (ADR-327); null takes every step. */
    runStepOutcomes: string[] | null;
    /** The kinds of node whose run steps it takes (ADR-328); null takes every step. */
    runStepNodeTypes: string[] | null;
    /** Who made the order status changes it takes (ADR-322); null takes every change. */
    orderChangeMakers: string[] | null;
    /** The API keys whose order status changes it leaves out (ADR-323); null: none. */
    orderExcludedApiKeyIds: string[] | null;
    /** The API keys whose Payment Links' changes it takes (ADR-324); null: every link's. */
    paymentLinkApiKeyIds: string[] | null;
    /** The deal statuses it takes (ADR-309); null takes every status. */
    dealStatuses: string[] | null;
    /** The task statuses it takes (ADR-309); null takes every status. */
    taskStatuses: string[] | null;
    /** The deal details whose changes it takes (ADR-310); null takes every change. */
    dealDetails: string[] | null;
    /** The task details whose changes it takes (ADR-310); null takes every change. */
    taskDetails: string[] | null;
    /** The template statuses it takes (ADR-148); null takes every status. */
    templateStatuses: string[] | null;
    /** The conversation statuses it takes (ADR-149); null takes every status. */
    conversationStatuses: string[] | null;
    /** How the runs it takes as `automation.run_ended` ended (ADR-151); null takes every end. */
    runEndStatuses: string[] | null;
    /** What started the runs whose events it takes (ADR-183); null takes every run's. */
    runTriggers: string[] | null;
    /** The API keys whose runs it takes (ADR-319); null takes every run. */
    runApiKeyIds: string[] | null;
    /** The consent changes it takes as `consent.changed` (ADR-189); null takes every change. */
    consentChanges: string[] | null;
    /** Where the contacts whose `contact.created` it takes came from (ADR-190); null: every one. */
    contactSources: string[] | null;
    /** The types of the received messages it takes (ADR-191); null takes every type. */
    messageTypes: string[] | null;
    /** The words of the received messages it takes (ADR-337); null takes every message. */
    messageWords: string[] | null;
    /** Why the runs it takes as `automation.run_ended` ended (ADR-192); null: every reason. */
    runEndReasons: string[] | null;
    /** The WhatsApp numbers whose events it takes (ADR-170); null takes every number. */
    channelIds: string[] | null;
    /** The teams whose conversations' events it takes (ADR-174); null takes every one's. */
    teamIds: string[] | null;
    /** The templates whose statuses and changes it takes (ADR-175); null takes every one's. */
    templateIds: string[] | null;
    /** The campaigns whose messages' statuses and changes it takes (ADR-185); null: every one's. */
    campaignIds: string[] | null;
    /** The CRM pipelines whose deals' events it takes (ADR-263); null takes every one's. */
    pipelineIds: string[] | null;
    /** The CRM stages whose deals' events it takes (ADR-264); null takes every one's. */
    stageIds: string[] | null;
    /** The members whose deals' events it takes (ADR-265); null takes every deal's. */
    ownerIds: string[] | null;
    /** The members whose tasks' events it takes (ADR-266); null takes every task's. */
    taskAssigneeIds: string[] | null;
    /** The CRM pipelines whose deals' tasks' events it takes (ADR-303); null: every task's. */
    taskPipelineIds: string[] | null;
    /** The CRM stages whose deals' tasks' events it takes (ADR-304); null: every task's. */
    taskStageIds: string[] | null;
    /** The members whose deals' tasks' events it takes (ADR-304); null: every task's. */
    taskDealOwnerIds: string[] | null;
    /** The CRM pipelines whose deals' notes' events it takes (ADR-305); null: every note's. */
    notePipelineIds: string[] | null;
    /** The CRM stages whose deals' notes' events it takes (ADR-305); null: every note's. */
    noteStageIds: string[] | null;
    /** The members whose deals' notes' events it takes (ADR-305); null: every note's. */
    noteDealOwnerIds: string[] | null;
    /** Who made the changes whose deal, task and note events it takes (ADR-306); null: all. */
    crmChangeMakers: string[] | null;
    /** The API keys whose deal, task and note changes it leaves out (ADR-321); null: none. */
    crmExcludedApiKeyIds: string[] | null;
    /** The scores of the satisfaction survey answers it takes (ADR-307); null: every answer. */
    surveyScores: number[] | null;
    /** The members credited with the survey answers it takes (ADR-311); null: every answer. */
    surveyAssigneeIds: string[] | null;
    /** The teams of the survey answers it takes (ADR-311); null: every answer. */
    surveyTeamIds: string[] | null;
    /** The contact tags of the survey answers it takes (ADR-312); null: every answer. */
    surveyContactTags: string[] | null;
    /** The conversation tags of the survey answers it takes (ADR-312); null: every answer. */
    surveyConversationTags: string[] | null;
    contactEventTags: string[] | null;
    /** The field values of the added and changed contacts it takes (ADR-332); null: every one. */
    contactEventFieldValues: WebhookContactFieldValue[] | null;
    /** The members whose assigned conversations' events it takes (ADR-181); null: every one's. */
    assigneeIds: string[] | null;
    /** The contact tags whose conversations' events it takes (ADR-267); null: every one's. */
    contactTags: string[] | null;
    /** The conversation tags whose events it takes (ADR-273); null: every conversation's. */
    conversationTags: string[] | null;
    /** Its OAuth client (ADR-173); null: none. */
    oauth: WebhookOAuthActionInput | null;
  },
): Promise<ActionResult<{ endpointId: string; secret: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { webhooks } = await getRuntime();
    const created = await webhooks.create(ctx, input, await requestMeta());
    refresh();
    return { endpointId: created.id, secret: created.secret };
  });
}

export async function updateWebhookEndpointAction(
  slug: string,
  input: {
    endpointId: string;
    url: string;
    description: string;
    eventTypes: string[];
    /** Given, the endpoint's headers become these; left out, they stay. */
    headers?: { name: string; value: string }[];
    /** The message.status statuses the endpoint takes; null takes every status. */
    messageStatuses: string[] | null;
    /** Who sent the messages whose statuses it takes (ADR-172); null takes every sender. */
    messageSenders: string[] | null;
    /** The API keys whose sent messages' statuses it takes (ADR-320); null: every message. */
    messageApiKeyIds: string[] | null;
    /** The contact parts it takes as contact.updated; null takes every change. */
    contactParts: string[] | null;
    /** The custom fields whose changes it takes (ADR-184); null takes every field's. */
    contactFieldKeys: string[] | null;
    /** The automations whose runs it takes (ADR-145); null takes every automation. */
    automationIds: string[] | null;
    /** The campaign statuses it takes (ADR-146); null takes every status. */
    campaignStatuses: string[] | null;
    /** The order statuses it takes (ADR-147); null takes every status. */
    orderStatuses: string[] | null;
    /** The Payment Link statuses it takes (ADR-308); null takes every status. */
    paymentLinkStatuses: string[] | null;
    /** The cash on delivery answers it takes (ADR-349); null takes every answer. */
    codAnswers: string[] | null;
    /**
     * The stores whose cash on delivery answers (ADR-349), order messages (ADR-352, ADR-353) and
     * cart reminders (ADR-355) it takes; null takes every one's.
     */
    storeIds: string[] | null;
    /** The order messages whose skips and sends it takes (ADR-352, ADR-353); null takes every message's. */
    orderMessageEvents: string[] | null;
    /** The reasons whose order message skips it takes (ADR-354); null takes every reason. */
    orderMessageSkipReasons: string[] | null;
    /** The cart reminders whose skips and sends it takes (ADR-361); null takes both. */
    cartReminders: string[] | null;
    /** The reasons whose cart reminder skips it takes (ADR-356); null takes every reason. */
    cartReminderSkipReasons: string[] | null;
    /** The reasons whose campaign recipient skips it takes (ADR-359); null takes every reason. */
    campaignSkipReasons: string[] | null;
    /** The outcomes of the run steps it takes (ADR-327); null takes every step. */
    runStepOutcomes: string[] | null;
    /** The kinds of node whose run steps it takes (ADR-328); null takes every step. */
    runStepNodeTypes: string[] | null;
    /** Who made the order status changes it takes (ADR-322); null takes every change. */
    orderChangeMakers: string[] | null;
    /** The API keys whose order status changes it leaves out (ADR-323); null: none. */
    orderExcludedApiKeyIds: string[] | null;
    /** The API keys whose Payment Links' changes it takes (ADR-324); null: every link's. */
    paymentLinkApiKeyIds: string[] | null;
    /** The deal statuses it takes (ADR-309); null takes every status. */
    dealStatuses: string[] | null;
    /** The task statuses it takes (ADR-309); null takes every status. */
    taskStatuses: string[] | null;
    /** The deal details whose changes it takes (ADR-310); null takes every change. */
    dealDetails: string[] | null;
    /** The task details whose changes it takes (ADR-310); null takes every change. */
    taskDetails: string[] | null;
    /** The template statuses it takes (ADR-148); null takes every status. */
    templateStatuses: string[] | null;
    /** The conversation statuses it takes (ADR-149); null takes every status. */
    conversationStatuses: string[] | null;
    /** How the runs it takes as `automation.run_ended` ended (ADR-151); null takes every end. */
    runEndStatuses: string[] | null;
    /** What started the runs whose events it takes (ADR-183); null takes every run's. */
    runTriggers: string[] | null;
    /** The API keys whose runs it takes (ADR-319); null takes every run. */
    runApiKeyIds: string[] | null;
    /** The consent changes it takes as `consent.changed` (ADR-189); null takes every change. */
    consentChanges: string[] | null;
    /** Where the contacts whose `contact.created` it takes came from (ADR-190); null: every one. */
    contactSources: string[] | null;
    /** The types of the received messages it takes (ADR-191); null takes every type. */
    messageTypes: string[] | null;
    /** The words of the received messages it takes (ADR-337); null takes every message. */
    messageWords: string[] | null;
    /** Why the runs it takes as `automation.run_ended` ended (ADR-192); null: every reason. */
    runEndReasons: string[] | null;
    /** The WhatsApp numbers whose events it takes (ADR-170); null takes every number. */
    channelIds: string[] | null;
    /** The teams whose conversations' events it takes (ADR-174); null takes every one's. */
    teamIds: string[] | null;
    /** The templates whose statuses and changes it takes (ADR-175); null takes every one's. */
    templateIds: string[] | null;
    /** The campaigns whose messages' statuses and changes it takes (ADR-185); null: every one's. */
    campaignIds: string[] | null;
    /** The CRM pipelines whose deals' events it takes (ADR-263); null takes every one's. */
    pipelineIds: string[] | null;
    /** The CRM stages whose deals' events it takes (ADR-264); null takes every one's. */
    stageIds: string[] | null;
    /** The members whose deals' events it takes (ADR-265); null takes every deal's. */
    ownerIds: string[] | null;
    /** The members whose tasks' events it takes (ADR-266); null takes every task's. */
    taskAssigneeIds: string[] | null;
    /** The CRM pipelines whose deals' tasks' events it takes (ADR-303); null: every task's. */
    taskPipelineIds: string[] | null;
    /** The CRM stages whose deals' tasks' events it takes (ADR-304); null: every task's. */
    taskStageIds: string[] | null;
    /** The members whose deals' tasks' events it takes (ADR-304); null: every task's. */
    taskDealOwnerIds: string[] | null;
    /** The CRM pipelines whose deals' notes' events it takes (ADR-305); null: every note's. */
    notePipelineIds: string[] | null;
    /** The CRM stages whose deals' notes' events it takes (ADR-305); null: every note's. */
    noteStageIds: string[] | null;
    /** The members whose deals' notes' events it takes (ADR-305); null: every note's. */
    noteDealOwnerIds: string[] | null;
    /** Who made the changes whose deal, task and note events it takes (ADR-306); null: all. */
    crmChangeMakers: string[] | null;
    /** The API keys whose deal, task and note changes it leaves out (ADR-321); null: none. */
    crmExcludedApiKeyIds: string[] | null;
    /** The scores of the satisfaction survey answers it takes (ADR-307); null: every answer. */
    surveyScores: number[] | null;
    /** The members credited with the survey answers it takes (ADR-311); null: every answer. */
    surveyAssigneeIds: string[] | null;
    /** The teams of the survey answers it takes (ADR-311); null: every answer. */
    surveyTeamIds: string[] | null;
    /** The contact tags of the survey answers it takes (ADR-312); null: every answer. */
    surveyContactTags: string[] | null;
    /** The conversation tags of the survey answers it takes (ADR-312); null: every answer. */
    surveyConversationTags: string[] | null;
    contactEventTags: string[] | null;
    /** The field values of the added and changed contacts it takes (ADR-332); null: every one. */
    contactEventFieldValues: WebhookContactFieldValue[] | null;
    /** The members whose assigned conversations' events it takes (ADR-181); null: every one's. */
    assigneeIds: string[] | null;
    /** The contact tags whose conversations' events it takes (ADR-267); null: every one's. */
    contactTags: string[] | null;
    /** The conversation tags whose events it takes (ADR-273); null: every conversation's. */
    conversationTags: string[] | null;
    /**
     * Given, its OAuth client (null removes it, ADR-173): a secret left out keeps the stored one
     * while the token URL stays the same. Left out, it stays.
     */
    oauth?: WebhookOAuthActionInput | null;
  },
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { webhooks } = await getRuntime();
    await webhooks.update(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

export async function setWebhookEndpointEnabledAction(
  slug: string,
  input: { endpointId: string; enabled: boolean },
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { webhooks } = await getRuntime();
    await webhooks.setEnabled(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

export async function rotateWebhookSecretAction(
  slug: string,
  endpointId: string,
): Promise<ActionResult<{ secret: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { webhooks } = await getRuntime();
    const rotated = await webhooks.rotateSecret(ctx, { endpointId }, await requestMeta());
    refresh();
    return { secret: rotated.secret };
  });
}

export async function deleteWebhookEndpointAction(
  slug: string,
  endpointId: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { webhooks } = await getRuntime();
    await webhooks.remove(ctx, { endpointId }, await requestMeta());
    refresh();
    return null;
  });
}

export async function sendWebhookTestAction(
  slug: string,
  endpointId: string,
): Promise<ActionResult<{ deliveryId: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { webhooks } = await getRuntime();
    const sent = await webhooks.sendTest(ctx, { endpointId });
    refresh();
    return sent;
  });
}

export async function replayFailedWebhookDeliveriesAction(
  slug: string,
  endpointId: string,
  period: WebhookReplayPeriod,
  event: string | null,
  failure: string | null,
): Promise<ActionResult<{ queued: number; more: boolean }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { webhooks } = await getRuntime();
    const replayed = await webhooks.replayFailed(
      ctx,
      {
        endpointId,
        period,
        ...(event ? { events: [event] } : {}),
        ...(failure ? { failures: [failure] } : {}),
      },
      await requestMeta(),
    );
    refresh();
    return replayed;
  });
}

/**
 * Replays the failed deliveries of every endpoint that is on (ADR-160). Each endpoint goes back to
 * the browser by its host only, with what it queued.
 */
export async function replayAllFailedWebhookDeliveriesAction(
  slug: string,
  period: WebhookReplayPeriod,
  event: string | null,
  failure: string | null,
): Promise<
  ActionResult<{
    queued: number;
    more: boolean;
    endpoints: { host: string | null; queued: number }[];
  }>
> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { webhooks } = await getRuntime();
    const replayed = await webhooks.replayAllFailed(
      ctx,
      {
        period,
        ...(event ? { events: [event] } : {}),
        ...(failure ? { failures: [failure] } : {}),
      },
      await requestMeta(),
    );
    refresh();
    return {
      queued: replayed.queued,
      more: replayed.more,
      endpoints: replayed.endpoints.map((e) => ({ host: webhookHost(e.url), queued: e.queued })),
    };
  });
}

export async function replayWebhookDeliveryAction(
  slug: string,
  deliveryId: string,
): Promise<ActionResult<{ deliveryId: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { webhooks } = await getRuntime();
    const replayed = await webhooks.replay(ctx, { deliveryId }, await requestMeta());
    refresh();
    return replayed;
  });
}
