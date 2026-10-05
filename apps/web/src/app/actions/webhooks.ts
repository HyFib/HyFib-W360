'use server';
import { refresh } from 'next/cache';
import { webhookHost, type WebhookReplayPeriod } from '@w360/domain/webhook-model';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { requestMeta } from '@/server/session';
import { tenantForAction } from '@/server/tenant-action';

/**
 * Company webhook endpoints (Settings → Webhooks). A new signing secret goes to the browser once,
 * here, when an endpoint is created or its secret rotated.
 */

/** An endpoint's OAuth client as the form gives it (ADR-173). */
interface WebhookOAuthActionInput {
  tokenUrl: string;
  clientId: string;
  /** Left out, a change keeps the stored secret. */
  clientSecret?: string;
  scope: string;
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
    /** The template statuses it takes (ADR-148); null takes every status. */
    templateStatuses: string[] | null;
    /** The conversation statuses it takes (ADR-149); null takes every status. */
    conversationStatuses: string[] | null;
    /** How the runs it takes as `automation.run_ended` ended (ADR-151); null takes every end. */
    runEndStatuses: string[] | null;
    /** What started the runs whose events it takes (ADR-183); null takes every run's. */
    runTriggers: string[] | null;
    /** The consent changes it takes as `consent.changed` (ADR-189); null takes every change. */
    consentChanges: string[] | null;
    /** The WhatsApp numbers whose events it takes (ADR-170); null takes every number. */
    channelIds: string[] | null;
    /** The teams whose conversations' events it takes (ADR-174); null takes every one's. */
    teamIds: string[] | null;
    /** The templates whose statuses and changes it takes (ADR-175); null takes every one's. */
    templateIds: string[] | null;
    /** The campaigns whose messages' statuses and changes it takes (ADR-185); null: every one's. */
    campaignIds: string[] | null;
    /** The members whose assigned conversations' events it takes (ADR-181); null: every one's. */
    assigneeIds: string[] | null;
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
    /** The template statuses it takes (ADR-148); null takes every status. */
    templateStatuses: string[] | null;
    /** The conversation statuses it takes (ADR-149); null takes every status. */
    conversationStatuses: string[] | null;
    /** How the runs it takes as `automation.run_ended` ended (ADR-151); null takes every end. */
    runEndStatuses: string[] | null;
    /** What started the runs whose events it takes (ADR-183); null takes every run's. */
    runTriggers: string[] | null;
    /** The consent changes it takes as `consent.changed` (ADR-189); null takes every change. */
    consentChanges: string[] | null;
    /** The WhatsApp numbers whose events it takes (ADR-170); null takes every number. */
    channelIds: string[] | null;
    /** The teams whose conversations' events it takes (ADR-174); null takes every one's. */
    teamIds: string[] | null;
    /** The templates whose statuses and changes it takes (ADR-175); null takes every one's. */
    templateIds: string[] | null;
    /** The campaigns whose messages' statuses and changes it takes (ADR-185); null: every one's. */
    campaignIds: string[] | null;
    /** The members whose assigned conversations' events it takes (ADR-181); null: every one's. */
    assigneeIds: string[] | null;
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
