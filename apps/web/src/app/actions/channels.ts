'use server';
import { refresh } from 'next/cache';
import { AppError } from '@w360/core';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { requestMeta } from '@/server/session';
import { tenantForAction } from '@/server/tenant-action';

async function onboardingService() {
  const { onboarding } = await getRuntime();
  if (!onboarding) {
    throw new AppError(
      'provider_unavailable',
      'WhatsApp connection is not configured on this platform yet.',
    );
  }
  return onboarding;
}

export async function startWhatsAppSignupAction(slug: string): Promise<
  ActionResult<{
    state: string;
    appId: string;
    configId: string;
    graphApiVersion: string;
    expiresAt: string;
  }>
> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const service = await onboardingService();
    const started = await service.start(ctx, await requestMeta());
    return { ...started, configId: started.configId ?? '' };
  });
}

export async function completeWhatsAppSignupAction(
  slug: string,
  input: {
    state: string;
    code: string;
    wabaId: string;
    phoneNumberId: string;
    businessId?: string;
  },
): Promise<ActionResult<{ channelAccountId: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const service = await onboardingService();
    const { channelAccountId } = await service.complete(ctx, input, await requestMeta());
    refresh();
    return { channelAccountId };
  });
}

export async function retryChannelSetupAction(
  slug: string,
  channelAccountId: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const service = await onboardingService();
    await service.retrySetup(ctx, channelAccountId, await requestMeta());
    refresh();
    return null;
  });
}

export async function disconnectChannelAction(
  slug: string,
  channelAccountId: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const service = await onboardingService();
    await service.disconnect(ctx, channelAccountId, await requestMeta());
    refresh();
    return null;
  });
}
