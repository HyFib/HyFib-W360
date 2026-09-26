'use server';
import { refresh } from 'next/cache';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { requestMeta } from '@/server/session';
import { tenantForAction } from '@/server/tenant-action';

/** Business hours, closed days, CSAT, teams, availability and saved replies (Settings → Inbox). */
export async function updateBusinessHoursAction(
  slug: string,
  input: { enabled: boolean; days: string[] },
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { businessHours } = await getRuntime();
    await businessHours.updateBusinessHours(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

export async function addClosedDayAction(
  slug: string,
  input: { day: string; name: string },
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { businessHours } = await getRuntime();
    await businessHours.addHoliday(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

export async function removeClosedDayAction(slug: string, id: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { businessHours } = await getRuntime();
    await businessHours.removeHoliday(ctx, id, await requestMeta());
    refresh();
    return null;
  });
}

export async function updateCsatSettingsAction(
  slug: string,
  input: { enabled: boolean; question: string; labels: string[] },
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { csat } = await getRuntime();
    await csat.updateCsatSettings(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

export interface TeamFormInput {
  name: string;
  description: string;
  assignment: 'manual' | 'round_robin';
  maxOpenPerMember: string;
  routingKeywords: string;
  memberIds: string[];
  channelIds: string[];
}

export async function createTeamAction(
  slug: string,
  input: TeamFormInput,
): Promise<ActionResult<{ teamId: string; routed: number }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { teams } = await getRuntime();
    const result = await teams.createTeam(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function updateTeamAction(
  slug: string,
  teamId: string,
  input: TeamFormInput,
): Promise<ActionResult<{ routed: number }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { teams } = await getRuntime();
    const result = await teams.updateTeam(ctx, teamId, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function deleteTeamAction(slug: string, teamId: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { teams } = await getRuntime();
    await teams.deleteTeam(ctx, teamId, await requestMeta());
    refresh();
    return null;
  });
}

export async function setAvailabilityAction(
  slug: string,
  input: { available: boolean; membershipId?: string },
): Promise<ActionResult<{ routed: number }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { teams } = await getRuntime();
    const result = await teams.setAvailability(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function createSavedReplyAction(
  slug: string,
  input: { shortcut: string; title: string; body: string },
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { savedReplies } = await getRuntime();
    const result = await savedReplies.createSavedReply(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function updateSavedReplyAction(
  slug: string,
  id: string,
  input: { shortcut: string; title: string; body: string },
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { savedReplies } = await getRuntime();
    await savedReplies.updateSavedReply(ctx, id, input, await requestMeta());
    refresh();
    return null;
  });
}

export async function deleteSavedReplyAction(slug: string, id: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { savedReplies } = await getRuntime();
    await savedReplies.deleteSavedReply(ctx, id, await requestMeta());
    refresh();
    return null;
  });
}
