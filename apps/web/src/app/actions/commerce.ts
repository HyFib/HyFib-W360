'use server';
import { refresh } from 'next/cache';
import type { ProductMessageInput } from '@w360/domain';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { requestMeta } from '@/server/session';
import { tenantForAction } from '@/server/tenant-action';

/** Commerce: catalog reads, product messages, order statuses, Payment Links and Razorpay keys. */

type Versioned = { id: string; expectedVersion: number };

async function commerceFor(slug: string) {
  const ctx = await tenantForAction(slug);
  const { commerce } = await getRuntime();
  return { ctx, commerce };
}

export async function requestCatalogSyncAction(
  slug: string,
  input: { whatsappAccountId: string },
): Promise<ActionResult<{ ok: true }>> {
  return runAction(async () => {
    const { ctx, commerce } = await commerceFor(slug);
    const result = await commerce.requestSync(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function sendProductsAction(
  slug: string,
  input: { conversationId: string; clientKey: string; message: ProductMessageInput },
): Promise<ActionResult<{ messageId: string; duplicate: boolean }>> {
  return runAction(async () => {
    const { ctx, commerce } = await commerceFor(slug);
    const result = await commerce.sendProducts(ctx, input);
    refresh();
    return result;
  });
}

export async function setOrderStatusAction(
  slug: string,
  input: Versioned & { status: 'confirmed' | 'fulfilled' | 'cancelled' },
): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const { ctx, commerce } = await commerceFor(slug);
    const result = await commerce.setOrderStatus(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function requestPaymentAction(
  slug: string,
  input: Versioned,
): Promise<ActionResult<{ linkId: string; version: number }>> {
  return runAction(async () => {
    const { ctx, commerce } = await commerceFor(slug);
    const result = await commerce.requestPayment(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function cancelPaymentLinkAction(
  slug: string,
  input: { orderId: string },
): Promise<ActionResult<{ ok: true }>> {
  return runAction(async () => {
    const { ctx, commerce } = await commerceFor(slug);
    const result = await commerce.cancelPaymentLink(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function savePaymentAccountAction(
  slug: string,
  input: { keyId: string; keySecret: string; webhookSecret: string },
): Promise<ActionResult<{ ok: true }>> {
  return runAction(async () => {
    const { ctx, commerce } = await commerceFor(slug);
    const result = await commerce.savePaymentAccount(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function removePaymentAccountAction(
  slug: string,
): Promise<ActionResult<{ ok: true }>> {
  return runAction(async () => {
    const { ctx, commerce } = await commerceFor(slug);
    const result = await commerce.removePaymentAccount(ctx, await requestMeta());
    refresh();
    return result;
  });
}
