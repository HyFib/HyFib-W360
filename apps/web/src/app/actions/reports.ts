'use server';
import { refresh } from 'next/cache';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { requestMeta } from '@/server/session';
import { tenantForAction } from '@/server/tenant-action';

/** Turns the member's own weekly and monthly report emails on or off (ADR-376). */
export async function updateReportEmailsAction(
  slug: string,
  input: unknown,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { reportEmails } = await getRuntime();
    await reportEmails.updateReportEmails(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}
