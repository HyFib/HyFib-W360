import {
  and,
  channelAccounts,
  contacts,
  eq,
  gt,
  invitations,
  isNull,
  memberships,
  messageTemplates,
  messagingSettings,
  ne,
  sql,
  type Database,
} from '@w360/db';
import type { Clock } from '@w360/core';
import { assertCan, can, type TenantContext } from '../authz/context';

/**
 * The company's setup checklist (W-026, ADR-233): the steps a company takes before engaging
 * customers on WhatsApp, each worked out from the company's own data. A member sees only the steps
 * whose data they can read, linked to a page where they can act; whether Meta verified the
 * business is not a step, because HyFib cannot read it.
 */
export type SetupStepKey =
  'two_factor' | 'number' | 'template' | 'contacts' | 'team' | 'response_target';

export interface SetupStep {
  key: SetupStepKey;
  label: string;
  done: boolean;
  /** Where the member takes the step. */
  href: string;
  note: string | null;
}

/** What the steps are worked out from; a fact the member cannot read is left out. */
export interface SetupFacts {
  twoFactorEnabled: boolean;
  /** Numbers connected and active, and those that need reconnecting or failed to connect. */
  numbers?: { active: number; needAttention: number };
  approvedTemplate?: boolean;
  anyContact?: boolean;
  /** Whether anyone besides the member is in the team or invited to it. */
  teammates?: boolean;
  responseTargetMinutes?: number | null;
}

/**
 * The steps a member sees, in order. `numbersConnectable` says whether this deployment can connect
 * numbers (Meta's Embedded Signup set up).
 */
export function setupSteps(
  ctx: TenantContext,
  facts: SetupFacts,
  numbersConnectable: boolean,
): SetupStep[] {
  const base = `/c/${ctx.tenant.slug}`;
  const steps: SetupStep[] = [
    {
      key: 'two_factor',
      label: 'Enable two-factor authentication',
      done: facts.twoFactorEnabled,
      href: '/account#security',
      note: null,
    },
  ];
  if (facts.numbers) {
    const { active, needAttention } = facts.numbers;
    steps.push({
      key: 'number',
      label: 'Connect a WhatsApp Business number',
      done: active > 0,
      href: `${base}/settings/channels`,
      note:
        needAttention > 0
          ? needAttention === 1
            ? 'A number needs reconnecting: see Settings → Channels.'
            : `${needAttention} numbers need reconnecting: see Settings → Channels.`
          : active === 0 && !numbersConnectable
            ? 'Connecting a number needs Meta’s Embedded Signup set up for this HyFib deployment.'
            : null,
    });
  }
  if (facts.approvedTemplate !== undefined) {
    const write = can(ctx, 'templates.write');
    steps.push({
      key: 'template',
      label: 'Get a message template approved by Meta',
      done: facts.approvedTemplate,
      href: write ? `${base}/templates/new` : `${base}/templates`,
      note: write
        ? 'Templates message customers who have not written in the last 24 hours. Start from one of HyFib’s starters.'
        : null,
    });
  }
  if (facts.anyContact !== undefined) {
    steps.push({
      key: 'contacts',
      label: 'Add your contacts',
      done: facts.anyContact,
      href: `${base}/contacts`,
      note: can(ctx, 'contacts.import')
        ? 'Import them from a CSV file or add them one by one.'
        : null,
    });
  }
  if (facts.teammates !== undefined) {
    steps.push({
      key: 'team',
      label: 'Invite your team',
      done: facts.teammates,
      href: `${base}/settings/members`,
      note: null,
    });
  }
  if (facts.responseTargetMinutes !== undefined) {
    steps.push({
      key: 'response_target',
      label: 'Set a first-response target',
      done: facts.responseTargetMinutes !== null,
      href: `${base}/settings/inbox`,
      note: 'The inbox shows when each reply is due, and members are emailed when one is overdue.',
    });
  }
  return steps;
}

/** Whether a query limited to one row found one. */
const found = async (query: Promise<unknown[]>): Promise<boolean> => (await query).length > 0;

export function createSetupChecklistService(deps: { db: Database; clock: Clock }) {
  const { db, clock } = deps;
  return {
    /** The member's view of the company's setup checklist. */
    async checklist(ctx: TenantContext, opts: { numbersConnectable: boolean }) {
      assertCan(ctx, 'tenant.read');
      const facts = await db.run(
        ctx.scope,
        async (tx): Promise<SetupFacts> => {
          const tenantId = ctx.tenant.id;
          const facts: SetupFacts = { twoFactorEnabled: ctx.user.twoFactorEnabled };
          if (can(ctx, 'channels.read')) {
            const rows = await tx
              .select({ status: channelAccounts.status, count: sql<number>`count(*)::int` })
              .from(channelAccounts)
              .where(eq(channelAccounts.tenantId, tenantId))
              .groupBy(channelAccounts.status);
            const count = (statuses: string[]) =>
              rows.filter((r) => statuses.includes(r.status)).reduce((n, r) => n + r.count, 0);
            facts.numbers = {
              active: count(['active']),
              needAttention: count(['needs_reconnect', 'failed']),
            };
          }
          if (can(ctx, 'templates.read')) {
            facts.approvedTemplate = await found(
              tx
                .select({ id: messageTemplates.id })
                .from(messageTemplates)
                .where(
                  and(
                    eq(messageTemplates.tenantId, tenantId),
                    eq(messageTemplates.status, 'approved'),
                  ),
                )
                .limit(1),
            );
          }
          if (can(ctx, 'contacts.read')) {
            facts.anyContact = await found(
              tx
                .select({ id: contacts.id })
                .from(contacts)
                .where(and(eq(contacts.tenantId, tenantId), isNull(contacts.erasedAt)))
                .limit(1),
            );
          }
          if (can(ctx, 'members.read')) {
            const others = await found(
              tx
                .select({ id: memberships.id })
                .from(memberships)
                .where(
                  and(
                    eq(memberships.tenantId, tenantId),
                    eq(memberships.status, 'active'),
                    ne(memberships.id, ctx.membership.id),
                  ),
                )
                .limit(1),
            );
            facts.teammates =
              others ||
              (await found(
                tx
                  .select({ id: invitations.id })
                  .from(invitations)
                  .where(
                    and(
                      eq(invitations.tenantId, tenantId),
                      eq(invitations.status, 'pending'),
                      gt(invitations.expiresAt, clock.now()),
                    ),
                  )
                  .limit(1),
              ));
          }
          if (can(ctx, 'tenant.settings.manage')) {
            const [row] = await tx
              .select({ minutes: messagingSettings.firstResponseTargetMinutes })
              .from(messagingSettings)
              .where(eq(messagingSettings.tenantId, tenantId));
            facts.responseTargetMinutes = row?.minutes ?? null;
          }
          return facts;
        },
        { accessMode: 'read only' },
      );
      return setupSteps(ctx, facts, opts.numbersConnectable);
    },
  };
}

export type SetupChecklistService = ReturnType<typeof createSetupChecklistService>;
