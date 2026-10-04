'use server';
import { refresh } from 'next/cache';
import type { WebhookReplayPeriod } from '@w360/domain/webhook-model';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { requestMeta } from '@/server/session';
import { tenantForAction } from '@/server/tenant-action';

/**
 * Company webhook endpoints (Settings → Webhooks). A new signing secret goes to the browser once,
 * here, when an endpoint is created or its secret rotated.
 */
export async function createWebhookEndpointAction(
  slug: string,
  input: {
    url: string;
    description: string;
    eventTypes: string[];
    headers: { name: string; value: string }[];
    /** The message.status statuses the endpoint takes; null takes every status. */
    messageStatuses: string[] | null;
    /** The contact parts it takes as contact.updated; null takes every change. */
    contactParts: string[] | null;
    /** The automations whose runs it takes (ADR-145); null takes every automation. */
    automationIds: string[] | null;
    /** The campaign statuses it takes (ADR-146); null takes every status. */
    campaignStatuses: string[] | null;
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
    /** The contact parts it takes as contact.updated; null takes every change. */
    contactParts: string[] | null;
    /** The automations whose runs it takes (ADR-145); null takes every automation. */
    automationIds: string[] | null;
    /** The campaign statuses it takes (ADR-146); null takes every status. */
    campaignStatuses: string[] | null;
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
): Promise<ActionResult<{ queued: number; more: boolean }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { webhooks } = await getRuntime();
    const replayed = await webhooks.replayFailed(ctx, { endpointId, period }, await requestMeta());
    refresh();
    return replayed;
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
