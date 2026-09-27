'use server';
import { refresh } from 'next/cache';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { requestMeta } from '@/server/session';
import { tenantForAction } from '@/server/tenant-action';

/** WhatsApp Flows: drafts, their settings, the Meta lifecycle, keys and sending forms. */

type Versioned = { id: string; expectedVersion: number };

async function flowsFor(slug: string) {
  const ctx = await tenantForAction(slug);
  const { flows } = await getRuntime();
  return { ctx, flows };
}

export async function createFlowAction(
  slug: string,
  input: { whatsappAccountId: string; name: string; categories: string[]; json: string },
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const { ctx, flows } = await flowsFor(slug);
    return flows.create(ctx, input, await requestMeta());
  });
}

export async function updateFlowDraftAction(
  slug: string,
  input: Versioned & { name: string; categories: string[]; json: string },
): Promise<ActionResult<{ version: number; syncing: boolean }>> {
  return runAction(async () => {
    const { ctx, flows } = await flowsFor(slug);
    const result = await flows.updateDraft(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function updateFlowSettingsAction(
  slug: string,
  input: Versioned & {
    mapping: { key: string; target: string }[];
    endpointUrl: string;
    endpointSecretName: string;
  },
): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const { ctx, flows } = await flowsFor(slug);
    const result = await flows.updateSettings(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export type FlowLifecycleAction =
  'publish' | 'deprecate' | 'remove' | 'refresh' | 'retry' | 'archive' | 'restore';

export async function flowLifecycleAction(
  slug: string,
  action: FlowLifecycleAction,
  input: Versioned,
): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const { ctx, flows } = await flowsFor(slug);
    const meta = await requestMeta();
    let result: { version: number };
    switch (action) {
      case 'publish':
        result = await flows.publish(ctx, input, meta);
        break;
      case 'deprecate':
        result = await flows.deprecate(ctx, input, meta);
        break;
      case 'remove':
        result = await flows.remove(ctx, input, meta);
        break;
      case 'refresh':
        result = await flows.refresh(ctx, input);
        break;
      case 'retry':
        result = await flows.retry(ctx, input);
        break;
      case 'archive':
        result = await flows.setArchived(ctx, input, true, meta);
        break;
      case 'restore':
        result = await flows.setArchived(ctx, input, false, meta);
        break;
    }
    refresh();
    return result;
  });
}

export async function duplicateFlowAction(
  slug: string,
  input: { id: string },
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const { ctx, flows } = await flowsFor(slug);
    return flows.duplicate(ctx, input, await requestMeta());
  });
}

export async function flowKeysAction(
  slug: string,
  action: 'setup' | 'rotate',
  input: { whatsappAccountId: string },
): Promise<ActionResult<{ ok: true }>> {
  return runAction(async () => {
    const { ctx, flows } = await flowsFor(slug);
    const meta = await requestMeta();
    const result =
      action === 'setup'
        ? await flows.setupKeys(ctx, input, meta)
        : await flows.rotateKey(ctx, input, meta);
    refresh();
    return result;
  });
}

export async function sendFlowAction(
  slug: string,
  input: {
    conversationId: string;
    flowId: string;
    mode: 'published' | 'draft';
    header: string;
    body: string;
    footer: string;
    cta: string;
    clientKey: string;
  },
): Promise<ActionResult<{ messageId: string; duplicate: boolean }>> {
  return runAction(async () => {
    const { ctx, flows } = await flowsFor(slug);
    const result = await flows.send(ctx, input);
    refresh();
    return result;
  });
}
