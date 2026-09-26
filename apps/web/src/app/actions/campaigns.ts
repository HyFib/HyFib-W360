'use server';
import { refresh } from 'next/cache';
import type { SegmentPreview } from '@w360/domain';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { requestMeta } from '@/server/session';
import { tenantForAction } from '@/server/tenant-action';

/** Campaign and segment actions: thin wrappers; the domain services authorise and validate. */
export async function createCampaignAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { campaigns } = await getRuntime();
    return campaigns.createDraft(ctx, input, await requestMeta());
  });
}

export async function updateCampaignAction(
  slug: string,
  campaignId: string,
  input: unknown,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { campaigns } = await getRuntime();
    await campaigns.updateDraft(ctx, String(campaignId), input, await requestMeta());
    refresh();
    return null;
  });
}

export async function submitCampaignAction(
  slug: string,
  campaignId: string,
  input: unknown,
): Promise<ActionResult<{ status: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { campaigns } = await getRuntime();
    const result = await campaigns.submitCampaign(
      ctx,
      String(campaignId),
      input,
      await requestMeta(),
    );
    refresh();
    return { status: result.status };
  });
}

type Transition = 'approve' | 'reject' | 'withdraw' | 'pause' | 'resume' | 'cancel';

export async function campaignTransitionAction(
  slug: string,
  campaignId: string,
  transition: Transition,
  input: unknown = {},
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { campaigns } = await getRuntime();
    const id = String(campaignId);
    const meta = await requestMeta();
    switch (transition) {
      case 'approve':
        await campaigns.approveCampaign(ctx, id, input, meta);
        break;
      case 'reject':
        await campaigns.rejectCampaign(ctx, id, input, meta);
        break;
      case 'withdraw':
        await campaigns.withdrawCampaign(ctx, id, meta);
        break;
      case 'pause':
        await campaigns.pauseCampaign(ctx, id, meta);
        break;
      case 'resume':
        await campaigns.resumeCampaign(ctx, id, meta);
        break;
      case 'cancel':
        await campaigns.cancelCampaign(ctx, id, meta);
        break;
    }
    refresh();
    return null;
  });
}

export async function updateGuardrailsAction(
  slug: string,
  campaignId: string,
  input: unknown,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { campaigns } = await getRuntime();
    await campaigns.updateGuardrails(ctx, String(campaignId), input, await requestMeta());
    refresh();
    return null;
  });
}

export async function sendCampaignTestAction(
  slug: string,
  campaignId: string,
  input: unknown,
): Promise<ActionResult<{ phone: string; ok: boolean; message: string }[]>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { campaigns } = await getRuntime();
    const results = await campaigns.sendTest(ctx, String(campaignId), input, await requestMeta());
    refresh();
    return results;
  });
}

export async function updateCampaignSettingsAction(
  slug: string,
  input: unknown,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { campaigns } = await getRuntime();
    await campaigns.updateSettings(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

export async function previewSegmentAction(
  slug: string,
  definition: unknown,
): Promise<ActionResult<SegmentPreview>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { segments } = await getRuntime();
    return segments.previewDefinition(ctx, definition);
  });
}

export async function createSegmentAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { segments } = await getRuntime();
    const result = await segments.createSegment(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function updateSegmentAction(
  slug: string,
  segmentId: string,
  input: unknown,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { segments } = await getRuntime();
    await segments.updateSegment(ctx, String(segmentId), input, await requestMeta());
    refresh();
    return null;
  });
}

export async function archiveSegmentAction(slug: string, segmentId: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { segments } = await getRuntime();
    await segments.archiveSegment(ctx, String(segmentId), await requestMeta());
    refresh();
    return null;
  });
}
