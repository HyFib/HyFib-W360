'use server';
import { refresh } from 'next/cache';
import type { GraphIssue } from '@w360/domain';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { requestMeta } from '@/server/session';
import { tenantForAction } from '@/server/tenant-action';

/** Automation actions: thin wrappers; the domain service authorises and validates. */
export async function createAutomationAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { automations } = await getRuntime();
    return automations.createAutomation(ctx, input, await requestMeta());
  });
}

export async function saveAutomationAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ version: number; issues: GraphIssue[] }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { automations } = await getRuntime();
    const result = await automations.updateAutomation(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function publishAutomationAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ versionNumber: number; version: number }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { automations } = await getRuntime();
    const result = await automations.publishAutomation(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function setAutomationStatusAction(
  slug: string,
  input: unknown,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { automations } = await getRuntime();
    await automations.setAutomationStatus(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

export async function archiveAutomationAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ stopped: number }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { automations } = await getRuntime();
    const result = await automations.archiveAutomation(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function restoreAutomationAction(slug: string, input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { automations } = await getRuntime();
    await automations.restoreAutomation(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

export async function deleteAutomationAction(slug: string, input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { automations } = await getRuntime();
    await automations.deleteAutomation(ctx, input, await requestMeta());
    return null;
  });
}

export async function startTestRunAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ runId: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { automations } = await getRuntime();
    const result = await automations.startTestRun(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function stopRunAction(slug: string, runId: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { automations } = await getRuntime();
    await automations.stopRun(ctx, String(runId), await requestMeta());
    refresh();
    return null;
  });
}

export async function takeOverAction(slug: string, conversationId: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { automations } = await getRuntime();
    await automations.takeOver(ctx, String(conversationId), await requestMeta());
    refresh();
    return null;
  });
}
