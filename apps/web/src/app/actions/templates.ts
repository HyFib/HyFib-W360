'use server';
import { refresh } from 'next/cache';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { requestMeta } from '@/server/session';
import { tenantForAction } from '@/server/tenant-action';

export async function createTemplateDraftAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { templates } = await getRuntime();
    const result = await templates.createDraft(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function updateTemplateDraftAction(
  slug: string,
  templateId: string,
  input: unknown,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { templates } = await getRuntime();
    await templates.updateDraft(ctx, String(templateId), input);
    refresh();
    return null;
  });
}

/** Sends Meta an edit of a template it has (ADR-404). */
export async function editTemplateAction(
  slug: string,
  templateId: string,
  input: unknown,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { templates } = await getRuntime();
    await templates.editTemplate(ctx, String(templateId), input, await requestMeta());
    refresh();
    return null;
  });
}

export async function submitTemplateAction(
  slug: string,
  templateId: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { templates } = await getRuntime();
    await templates.submitTemplate(ctx, String(templateId), await requestMeta());
    refresh();
    return null;
  });
}

export async function deleteTemplateAction(
  slug: string,
  templateId: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { templates } = await getRuntime();
    await templates.deleteTemplate(ctx, String(templateId), await requestMeta());
    refresh();
    return null;
  });
}

export async function syncTemplatesAction(
  slug: string,
  whatsappAccountId: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { templates } = await getRuntime();
    await templates.requestSync(ctx, String(whatsappAccountId));
    refresh();
    return null;
  });
}
