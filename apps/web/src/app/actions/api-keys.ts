'use server';
import { refresh } from 'next/cache';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { requestMeta } from '@/server/session';
import { tenantForAction } from '@/server/tenant-action';

/** Company API keys (Settings → API keys). A new token goes to the browser once, here. */
export async function createApiKeyAction(
  slug: string,
  input: {
    name: string;
    scopes: string[];
    expiresInDays: number;
    allowedNetworks: string;
    monthlyRequestLimit: string;
  },
): Promise<ActionResult<{ token: string; keyPrefix: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { apiKeys } = await getRuntime();
    const created = await apiKeys.create(ctx, input, await requestMeta());
    refresh();
    return { token: created.token, keyPrefix: created.keyPrefix };
  });
}

export async function rotateApiKeyAction(
  slug: string,
  input: { keyId: string; overlapHours: number },
): Promise<ActionResult<{ token: string; keyPrefix: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { apiKeys } = await getRuntime();
    const created = await apiKeys.rotate(ctx, input, await requestMeta());
    refresh();
    return { token: created.token, keyPrefix: created.keyPrefix };
  });
}

/** The addresses a key accepts requests from (ADR-076); empty text accepts any address. */
export async function setApiKeyNetworksAction(
  slug: string,
  input: { keyId: string; allowedNetworks: string },
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { apiKeys } = await getRuntime();
    await apiKeys.setAllowedNetworks(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

/** The addresses every key of the company accepts requests from (ADR-099); empty accepts any. */
export async function setCompanyApiNetworksAction(
  slug: string,
  input: { allowedNetworks: string },
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { apiKeys } = await getRuntime();
    await apiKeys.setCompanyNetworks(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

/** A key's own monthly request limit (ADR-097); empty text removes it. */
export async function setApiKeyLimitAction(
  slug: string,
  input: { keyId: string; monthlyRequestLimit: string },
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { apiKeys } = await getRuntime();
    await apiKeys.setMonthlyLimit(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

export async function revokeApiKeyAction(slug: string, keyId: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { apiKeys } = await getRuntime();
    await apiKeys.revoke(ctx, { keyId }, await requestMeta());
    refresh();
    return null;
  });
}
