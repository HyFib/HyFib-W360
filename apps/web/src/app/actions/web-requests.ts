'use server';
import { refresh } from 'next/cache';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { requestMeta } from '@/server/session';
import { tenantForAction } from '@/server/tenant-action';

/** Allowed domains and secrets for the automation HTTP step (Settings → Web requests). */
export async function addHttpDomainAction(
  slug: string,
  input: { domain: string },
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { webRequests } = await getRuntime();
    const result = await webRequests.addDomain(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function removeHttpDomainAction(slug: string, id: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { webRequests } = await getRuntime();
    await webRequests.removeDomain(ctx, { id }, await requestMeta());
    refresh();
    return null;
  });
}

/** The value goes to the server once and is never sent back to a browser. */
export async function saveHttpSecretAction(
  slug: string,
  input: { name: string; domain: string; value: string },
): Promise<ActionResult<{ created: boolean }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { webRequests } = await getRuntime();
    const result = await webRequests.saveSecret(ctx, input, await requestMeta());
    refresh();
    return { created: result.created };
  });
}

export async function deleteHttpSecretAction(slug: string, id: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { webRequests } = await getRuntime();
    await webRequests.deleteSecret(ctx, { id }, await requestMeta());
    refresh();
    return null;
  });
}
