'use server';
import { refresh } from 'next/cache';
import type { StoreVariables } from '@w360/domain/store-messages-model';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { requestMeta } from '@/server/session';
import { tenantForAction } from '@/server/tenant-action';

/** Order messages: a store's message settings and the rule for each event. */

async function storeMessagesFor(slug: string) {
  const ctx = await tenantForAction(slug);
  const { storeMessages } = await getRuntime();
  return { ctx, storeMessages };
}

export async function saveStoreMessageSettingsAction(
  slug: string,
  input: {
    storeId: string;
    optIn: boolean;
    windowStart: string;
    windowEnd: string;
    testOrders: boolean;
  },
): Promise<ActionResult<{ ok: true }>> {
  return runAction(async () => {
    const { ctx, storeMessages } = await storeMessagesFor(slug);
    const result = await storeMessages.saveMessageSettings(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function saveStoreMessageRuleAction(
  slug: string,
  input: {
    storeId: string;
    event: string;
    enabled: boolean;
    channelAccountId: string | null;
    templateId: string | null;
    variables: StoreVariables;
    delayMinutes: number;
    confirmButton: number | null;
    cancelButton: number | null;
    version: number;
  },
): Promise<ActionResult<{ ok: true }>> {
  return runAction(async () => {
    const { ctx, storeMessages } = await storeMessagesFor(slug);
    const result = await storeMessages.saveMessageRule(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}
