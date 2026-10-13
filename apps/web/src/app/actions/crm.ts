'use server';
import { refresh } from 'next/cache';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { localToIso } from '@/server/crm-time';
import { requestMeta } from '@/server/session';
import { tenantForAction } from '@/server/tenant-action';

/** CRM actions: thin wrappers; the domain service authorises and validates. */

/** Task times come from the form as wall-clock readings in the company's time zone. */
function withTaskTimes(input: unknown, timeZone: string): unknown {
  if (!input || typeof input !== 'object') return input;
  const { dueLocal, remindLocal, ...rest } = input as Record<string, unknown>;
  return {
    ...rest,
    dueAt: localToIso(dueLocal, timeZone),
    remindAt: localToIso(remindLocal, timeZone),
  };
}

export async function createPipelineAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { crm } = await getRuntime();
    const result = await crm.createPipeline(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function updatePipelineAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { crm } = await getRuntime();
    const result = await crm.updatePipeline(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function archivePipelineAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { crm } = await getRuntime();
    const result = await crm.archivePipeline(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function restorePipelineAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { crm } = await getRuntime();
    const result = await crm.restorePipeline(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function createDealAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { crm } = await getRuntime();
    const result = await crm.createDeal(ctx, input);
    refresh();
    return result;
  });
}

export async function updateDealAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { crm } = await getRuntime();
    const result = await crm.updateDeal(ctx, input);
    refresh();
    return result;
  });
}

export async function moveDealAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { crm } = await getRuntime();
    const result = await crm.moveDeal(ctx, input);
    refresh();
    return result;
  });
}

export async function closeDealAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { crm } = await getRuntime();
    const result = await crm.closeDeal(ctx, input);
    refresh();
    return result;
  });
}

export async function reopenDealAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { crm } = await getRuntime();
    const result = await crm.reopenDeal(ctx, input);
    refresh();
    return result;
  });
}

export async function addNoteAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { crm } = await getRuntime();
    const result = await crm.addNote(ctx, input);
    refresh();
    return result;
  });
}

export async function createTaskAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { crm } = await getRuntime();
    const result = await crm.createTask(ctx, withTaskTimes(input, ctx.tenant.timezone));
    refresh();
    return result;
  });
}

export async function updateTaskAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { crm } = await getRuntime();
    const result = await crm.updateTask(ctx, withTaskTimes(input, ctx.tenant.timezone));
    refresh();
    return result;
  });
}

export async function setTaskStatusAction(
  slug: string,
  input: { id: string; expectedVersion: number; status: 'done' | 'cancelled' | 'open' },
): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { crm } = await getRuntime();
    const target = { id: input.id, expectedVersion: input.expectedVersion };
    const result =
      input.status === 'done'
        ? await crm.completeTask(ctx, target)
        : input.status === 'cancelled'
          ? await crm.cancelTask(ctx, target)
          : await crm.reopenTask(ctx, target);
    refresh();
    return result;
  });
}

/** Contacts for the deal form's picker (needs contacts.read, like the contacts page). */
export async function searchContactsAction(
  slug: string,
  query: string,
): Promise<ActionResult<{ id: string; name: string | null; phone: string | null }[]>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { contacts } = await getRuntime();
    const page = await contacts.listContacts(ctx, { q: query, limit: 10 });
    return page.items.map((c) => ({ id: c.id, name: c.displayName, phone: c.phoneE164 }));
  });
}

/** Custom deal fields (ADR-373): company settings, as pipelines are. */
export async function createDealFieldAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ id: string; key: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { crm } = await getRuntime();
    const result = await crm.createDealField(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function renameDealFieldAction(
  slug: string,
  fieldId: string,
  label: string,
): Promise<ActionResult<void>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { crm } = await getRuntime();
    await crm.renameDealField(ctx, fieldId, label, await requestMeta());
    refresh();
  });
}

export async function deleteDealFieldAction(
  slug: string,
  fieldId: string,
): Promise<ActionResult<void>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { crm } = await getRuntime();
    await crm.deleteDealField(ctx, fieldId, await requestMeta());
    refresh();
  });
}
