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

/** Schedules a company's deletion for HyFib (platform owners, ADR-090). */
export async function scheduleTenantDeletionAction(
  input: unknown,
): Promise<ActionResult<{ dueAt: string }>> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    const { dueAt } = await runtime.platform.scheduleTenantDeletion(actor, input);
    refresh();
    return { dueAt: dueAt.toISOString() };
  });
}

/** Cancels a deletion HyFib scheduled, before it starts (platform owners, ADR-090). */
export async function cancelTenantDeletionAction(
  input: unknown,
): Promise<ActionResult<{ status: string }>> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    const result = await runtime.platform.cancelTenantDeletion(actor, input);
    refresh();
    return result;
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

/** Refunds unused service credit from a paid top-up (platform owners, ADR-058). */
export async function requestCreditRefundAction(
  input: unknown,
): Promise<ActionResult<{ refundId: string }>> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    const result = await runtime.platformBilling.requestRefund(actor, input);
    refresh();
    return result;
  });
}

/** Approves or declines a company's refund request (platform owners, ADR-073). */
export async function decideRefundRequestAction(
  input: unknown,
): Promise<ActionResult<{ refundId: string | null }>> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    const result = await runtime.platformBilling.decideRefundRequest(actor, input);
    refresh();
    return result;
  });
}

export async function decidePlanRefundRequestAction(
  input: unknown,
): Promise<ActionResult<{ refundId: string | null }>> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    const result = await runtime.platformBilling.decidePlanRefundRequest(actor, input);
    refresh();
    return result;
  });
}

export async function requestSettlementReconAction(
  input: unknown,
): Promise<ActionResult<{ runId: string }>> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    const result = await runtime.platformReconciliation.requestDay(actor, input);
    refresh();
    return result;
  });
}

export async function resolveSettlementItemAction(input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    await runtime.platformReconciliation.resolveItem(actor, input);
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

/** The tax added to plan prices when companies pay for their plan (ADR-063; owners only). */
export async function setPlanTaxAction(input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    await runtime.planAdmin.setPlanTax(actor, input);
    refresh();
    return null;
  });
}

/** Refunds part or all of a plan payment (platform owners, ADR-103). */
export async function requestPlanPaymentRefundAction(
  input: unknown,
): Promise<ActionResult<{ refundId: string }>> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    const result = await runtime.planAdmin.requestPlanPaymentRefund(actor, input);
    refresh();
    return result;
  });
}

/** Cancels a company's plan subscription at Razorpay at once (ADR-063; owners only, audited). */
export async function cancelTenantSubscriptionAction(input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const { actor, runtime } = await actorForAction();
    await runtime.planAdmin.cancelTenantSubscription(actor, input);
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
