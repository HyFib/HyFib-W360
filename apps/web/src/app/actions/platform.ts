'use server';
import { refresh } from 'next/cache';
import { AppError } from '@w360/core';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { correlationId } from '@/server/session';
import { sessionForAction } from '@/server/tenant-action';

async function actorForAction() {
  const session = await sessionForAction();
  const runtime = await getRuntime();
  const actor = await runtime.platform.resolveActor(session.user.id, await correlationId());
  if (!actor) throw new AppError('forbidden', 'Platform administrator access required.');
  return { actor, runtime };
}

export async function setTenantStatusAction(input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    await runtime.platform.setTenantStatus(actor, input);
    refresh();
    return null;
  });
}

export async function grantSupportAccessAction(input: unknown): Promise<ActionResult<{ expiresAt: string }>> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    const result = await runtime.platform.grantSupportAccess(actor, input);
    refresh();
    return { expiresAt: result.expiresAt.toISOString() };
  });
}

export async function revokeSupportAccessAction(grantId: string): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    await runtime.platform.revokeSupportAccess(actor, grantId);
    refresh();
    return null;
  });
}

export async function resetUserMfaAction(input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    await runtime.platform.resetUserMfa(actor, input);
    refresh();
    return null;
  });
}
