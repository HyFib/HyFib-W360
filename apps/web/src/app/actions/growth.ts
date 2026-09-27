'use server';
import { refresh } from 'next/cache';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { requestMeta } from '@/server/session';
import { tenantForAction } from '@/server/tenant-action';

/** Click-to-chat links and website widgets (Growth). */
export async function createChatLinkAction(
  slug: string,
  input: { name: string; channelAccountId: string; message: string; includeRef: boolean },
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { growth } = await getRuntime();
    const result = await growth.createLink(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function updateChatLinkAction(
  slug: string,
  input: {
    id: string;
    expectedVersion: number;
    name: string;
    channelAccountId: string;
    message: string;
    includeRef: boolean;
  },
): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { growth } = await getRuntime();
    const result = await growth.updateLink(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function setChatLinkArchivedAction(
  slug: string,
  input: { id: string; expectedVersion: number },
  archived: boolean,
): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { growth } = await getRuntime();
    const result = await growth.setLinkArchived(ctx, input, archived, await requestMeta());
    refresh();
    return result;
  });
}

export interface WidgetInput {
  linkId: string;
  label: string;
  greeting: string;
  side: 'left' | 'right';
  color: string;
  enabled: boolean;
}

export async function createChatWidgetAction(
  slug: string,
  input: WidgetInput,
): Promise<ActionResult<{ id: string; publicId: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { growth } = await getRuntime();
    const result = await growth.createWidget(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function updateChatWidgetAction(
  slug: string,
  input: WidgetInput & { id: string; expectedVersion: number },
): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { growth } = await getRuntime();
    const result = await growth.updateWidget(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function deleteChatWidgetAction(
  slug: string,
  input: { id: string; expectedVersion: number },
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { growth } = await getRuntime();
    await growth.deleteWidget(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}
