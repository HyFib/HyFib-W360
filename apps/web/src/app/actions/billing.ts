'use server';
import { refresh } from 'next/cache';
import { AppError, parseMajorUnits } from '@w360/core';
import type { CheckoutStart, SubscriptionCheckoutStart } from '@w360/domain';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { requestMeta } from '@/server/session';
import { tenantForAction } from '@/server/tenant-action';

/** Parses a rupee amount typed in a form ("1500" or "1500.50") into paise without floating point. */
function rupeesToPaise(value: unknown, field: string): number {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError('validation_failed', 'Enter an amount.', {
      issues: [{ path: field, message: 'Enter an amount' }],
    });
  }
  let paise: bigint;
  try {
    paise = parseMajorUnits(value.replace(/[,\s₹]/g, ''), 'INR');
  } catch {
    throw new AppError('validation_failed', 'Enter an amount in rupees, like 1500 or 1500.50.', {
      issues: [{ path: field, message: 'Invalid amount' }],
    });
  }
  if (paise < 0n || paise > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError('validation_failed', 'Amount is out of range.', {
      issues: [{ path: field, message: 'Out of range' }],
    });
  }
  return Number(paise);
}

export async function startTopupAction(
  slug: string,
  input: { amount: string },
): Promise<ActionResult<CheckoutStart & { topupId: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { billing } = await getRuntime();
    return billing.startTopup(
      ctx,
      { amountMinor: rupeesToPaise(input.amount, 'amount') },
      await requestMeta(),
    );
  });
}

export async function confirmTopupAction(
  slug: string,
  input: { topupId: string; paymentId: string; signature: string },
): Promise<ActionResult<{ status: 'credited' | 'processing' | 'failed' }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { billing } = await getRuntime();
    const result = await billing.confirmTopupCheckout(ctx, input);
    refresh();
    return result;
  });
}

export async function startMandateSetupAction(
  slug: string,
  input: { maxAmount: string; email: string; contact: string },
): Promise<ActionResult<CheckoutStart & { mandateId: string; customerId: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { billing } = await getRuntime();
    return billing.startMandateSetup(
      ctx,
      {
        maxAmountMinor: rupeesToPaise(input.maxAmount, 'maxAmount'),
        email: String(input.email ?? ''),
        contact: String(input.contact ?? ''),
      },
      await requestMeta(),
    );
  });
}

export async function confirmMandateAction(
  slug: string,
  input: { mandateId: string; paymentId: string; signature: string },
): Promise<ActionResult<{ status: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { billing } = await getRuntime();
    const result = await billing.confirmMandateCheckout(ctx, input);
    refresh();
    return result;
  });
}

export async function cancelMandateAction(slug: string, mandateId: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { billing } = await getRuntime();
    await billing.cancelMandate(ctx, { mandateId }, await requestMeta());
    refresh();
    return null;
  });
}

export async function updateAutoRechargeAction(
  slug: string,
  input: {
    enabled: boolean;
    threshold: string;
    amount: string;
    dailyCap: string;
    monthlyCap: string;
  },
): Promise<ActionResult<{ enabled: boolean }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { billing } = await getRuntime();
    const result = await billing.updateAutoRecharge(
      ctx,
      {
        enabled: input.enabled === true,
        thresholdMinor: rupeesToPaise(input.threshold, 'threshold'),
        amountMinor: rupeesToPaise(input.amount, 'amount'),
        dailyCapMinor: rupeesToPaise(input.dailyCap, 'dailyCap'),
        monthlyCapMinor: rupeesToPaise(input.monthlyCap, 'monthlyCap'),
      },
      await requestMeta(),
    );
    refresh();
    return result;
  });
}

/** Starts paying for the plan (ADR-063): the browser then opens Checkout for the subscription. */
export async function startPlanSubscriptionAction(
  slug: string,
): Promise<ActionResult<SubscriptionCheckoutStart>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { planPayments } = await getRuntime();
    return planPayments.start(ctx, await requestMeta());
  });
}

export async function confirmPlanSubscriptionAction(
  slug: string,
  input: { subscriptionId: string; paymentId: string; signature: string },
): Promise<ActionResult<{ status: 'active' | 'processing' | 'failed' }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { planPayments } = await getRuntime();
    const result = await planPayments.confirmCheckout(ctx, {
      subscriptionId: String(input.subscriptionId ?? ''),
      paymentId: String(input.paymentId ?? ''),
      signature: String(input.signature ?? ''),
    });
    refresh();
    return result;
  });
}

export async function cancelPlanSubscriptionAction(
  slug: string,
): Promise<ActionResult<{ atPeriodEnd: boolean }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { planPayments } = await getRuntime();
    const result = await planPayments.cancel(ctx, await requestMeta());
    refresh();
    return { atPeriodEnd: result.atPeriodEnd };
  });
}
