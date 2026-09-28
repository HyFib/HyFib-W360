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

export async function grantSupportAccessAction(
  input: unknown,
): Promise<ActionResult<{ expiresAt: string }>> {
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

export async function createRateCardAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    const result = await runtime.rateCards.createRateCard(actor, input);
    refresh();
    return result;
  });
}

export async function publishRateCardAction(id: string): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    await runtime.rateCards.publishRateCard(actor, String(id));
    refresh();
    return null;
  });
}

export async function withdrawRateCardAction(id: string, input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    await runtime.rateCards.withdrawRateCard(actor, String(id), input);
    refresh();
    return null;
  });
}

export async function createPlanAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    const result = await runtime.planAdmin.createPlan(actor, input);
    refresh();
    return result;
  });
}

export async function updatePlanDraftAction(id: string, input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    await runtime.planAdmin.updateDraft(actor, String(id), input);
    refresh();
    return null;
  });
}

export async function createPlanVersionAction(
  fromPlanId: string,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    const result = await runtime.planAdmin.createVersion(actor, String(fromPlanId));
    refresh();
    return result;
  });
}

export async function publishPlanAction(id: string): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    await runtime.planAdmin.publishPlan(actor, String(id));
    refresh();
    return null;
  });
}

export async function retirePlanAction(id: string, input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    await runtime.planAdmin.retirePlan(actor, String(id), input);
    refresh();
    return null;
  });
}

export async function setDefaultTrialAction(input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    await runtime.planAdmin.setDefaultTrial(actor, input);
    refresh();
    return null;
  });
}

export async function setTenantPlanAction(input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    await runtime.planAdmin.setTenantPlan(actor, input);
    refresh();
    return null;
  });
}

/** Sends a failed or quarantined Meta or Razorpay webhook receipt back to processing (audited). */
export async function retryWebhookReceiptAction(
  input: unknown,
): Promise<ActionResult<{ previousStatus: string }>> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    const result = await runtime.platformOps.retryReceipt(actor, input);
    refresh();
    return result;
  });
}

/** Records how a quarantined webhook event was resolved (audited). */
export async function resolveQuarantineAction(input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    await runtime.platformOps.resolveQuarantine(actor, input);
    refresh();
    return null;
  });
}
