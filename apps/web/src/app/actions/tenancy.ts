'use server';
import { refresh } from 'next/cache';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { requestMeta } from '@/server/session';
import { sessionForAction, tenantForAction } from '@/server/tenant-action';

export async function createCompanyAction(input: unknown): Promise<ActionResult<{ slug: string }>> {
  return runAction(async () => {
    const session = await sessionForAction();
    const { tenancy } = await getRuntime();
    const { slug } = await tenancy.createCompany(session.user.id, input);
    return { slug };
  });
}

export async function updateCompanySettingsAction(
  slug: string,
  input: unknown,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { tenancy } = await getRuntime();
    await tenancy.updateSettings(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

export async function updateCompanySecurityAction(
  slug: string,
  input: unknown,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { tenancy } = await getRuntime();
    await tenancy.updateSecurity(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

/** Sets which notice emails the member gets from this company (ADR-215). */
export async function updateEmailPreferencesAction(
  slug: string,
  input: unknown,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { emailPreferences } = await getRuntime();
    await emailPreferences.updateEmailPreferences(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

export async function inviteMemberAction(slug: string, input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { tenancy } = await getRuntime();
    await tenancy.createInvitation(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

export async function resendInvitationAction(
  slug: string,
  invitationId: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { tenancy } = await getRuntime();
    await tenancy.resendInvitation(ctx, { invitationId }, await requestMeta());
    refresh();
    return null;
  });
}

export async function revokeInvitationAction(
  slug: string,
  invitationId: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { tenancy } = await getRuntime();
    await tenancy.revokeInvitation(ctx, { invitationId }, await requestMeta());
    refresh();
    return null;
  });
}

export async function changeMemberRolesAction(slug: string, input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { tenancy } = await getRuntime();
    await tenancy.changeMemberRoles(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

export async function setMemberStatusAction(slug: string, input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { tenancy } = await getRuntime();
    await tenancy.setMemberStatus(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

export async function leaveCompanyAction(slug: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { tenancy } = await getRuntime();
    await tenancy.leaveCompany(ctx, await requestMeta());
    return null;
  });
}

export async function acceptInvitationAction(
  token: string,
): Promise<ActionResult<{ slug: string }>> {
  return runAction(async () => {
    const session = await sessionForAction();
    const { tenancy } = await getRuntime();
    const { slug } = await tenancy.acceptInvitation(session.user.id, token);
    return { slug };
  });
}

export async function rememberCompanyAction(slug: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { tenancy } = await getRuntime();
    await tenancy.rememberCompany(ctx);
    return null;
  });
}

/** Schedules the company's deletion (owners; the company address is typed to confirm). */
export async function requestCompanyDeletionAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ dueAt: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { companyDeletion } = await getRuntime();
    const { dueAt } = await companyDeletion.request(ctx, input, await requestMeta());
    refresh();
    return { dueAt: dueAt.toISOString() };
  });
}

/** Cancels a scheduled deletion that has not started (owners). */
export async function cancelCompanyDeletionAction(slug: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { companyDeletion } = await getRuntime();
    await companyDeletion.cancel(ctx, await requestMeta());
    refresh();
    return null;
  });
}
