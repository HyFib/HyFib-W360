import { z } from 'zod';
import { and, eq, memberships, sql, type Database } from '@w360/db';
import { assertCan, can, type TenantContext } from '../authz/context';
import { recordAudit, type RequestMeta } from '../audit';
import { parseInput } from '../validation';

/**
 * Which notice emails a member gets in a company (ADR-215; overdue replies since ADR-230). Every
 * kind is on until the member turns it off; a notice skips a member who turned its kind off.
 * Security, sign-in and billing emails are not listed: they cannot be turned off.
 */
export const EMAIL_NOTICE_KINDS = [
  'mentions',
  'reply_overdue',
  'campaign_approvals',
  'campaign_reviews',
  'campaign_pauses',
  'campaign_completions',
] as const;
export type EmailNoticeKind = (typeof EMAIL_NOTICE_KINDS)[number];

export const EMAIL_NOTICES: Record<
  EmailNoticeKind,
  { label: string; description: string; applies: (ctx: TenantContext) => boolean }
> = {
  mentions: {
    label: 'Mentions in notes',
    description:
      'Someone mentioned you in a conversation note, and you had not opened the conversation 10 minutes later.',
    applies: (ctx) => can(ctx, 'inbox.read_all') || can(ctx, 'inbox.read_assigned'),
  },
  reply_overdue: {
    label: 'Customers waiting past the reply target',
    description:
      'A customer waited longer than the company’s first-response target in a conversation assigned to you, one for your team that nobody has taken, or (if you assign conversations) one nobody who can reply has taken.',
    applies: (ctx) => can(ctx, 'inbox.reply'),
  },
  campaign_approvals: {
    label: 'Campaigns waiting for approval',
    description: 'A campaign someone else submitted waits for a member’s approval.',
    applies: (ctx) => can(ctx, 'campaigns.approve'),
  },
  campaign_reviews: {
    label: 'Your campaigns reviewed',
    description: 'Someone approved a campaign you submitted, sent it back or took it back.',
    applies: (ctx) => can(ctx, 'campaigns.write'),
  },
  campaign_pauses: {
    label: 'Campaigns HyFib paused',
    description:
      'HyFib paused a campaign that sends under your authority, or one that only a member like you can resume.',
    applies: (ctx) => can(ctx, 'campaigns.send'),
  },
  campaign_completions: {
    label: 'Your campaigns finished',
    description: 'A campaign that sent under your authority finished, or its sending period ended.',
    applies: (ctx) => can(ctx, 'campaigns.send'),
  },
};

/** Whether a member whose turned-off kinds are `optOuts` gets an email of this kind. */
export function wantsEmail(optOuts: readonly string[], kind: EmailNoticeKind): boolean {
  return !optOuts.includes(kind);
}

export const emailPreferencesSchema = z.object({
  /** The kinds the member turns off, among those shown to them. */
  off: z.array(z.enum(EMAIL_NOTICE_KINDS)).max(EMAIL_NOTICE_KINDS.length),
});

export interface EmailPreference {
  kind: EmailNoticeKind;
  label: string;
  description: string;
  email: boolean;
}

export function createEmailPreferencesService(deps: { db: Database }) {
  const { db } = deps;

  async function stored(ctx: TenantContext): Promise<string[]> {
    const [row] = await db.run(
      ctx.scope,
      (tx) =>
        tx
          .select({ optOuts: memberships.emailOptOuts })
          .from(memberships)
          .where(
            and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.id, ctx.membership.id)),
          ),
      { accessMode: 'read only' },
    );
    return row?.optOuts ?? [];
  }

  return {
    /** The notice emails that concern the member, and whether each is on. */
    async getEmailPreferences(ctx: TenantContext): Promise<EmailPreference[]> {
      assertCan(ctx, 'tenant.read');
      const optOuts = await stored(ctx);
      return EMAIL_NOTICE_KINDS.filter((kind) => EMAIL_NOTICES[kind].applies(ctx)).map((kind) => ({
        kind,
        label: EMAIL_NOTICES[kind].label,
        description: EMAIL_NOTICES[kind].description,
        email: wantsEmail(optOuts, kind),
      }));
    },

    /**
     * Sets which of the kinds shown to the member are off; kinds not shown keep their setting. Only
     * the member's own membership changes (app.set_own_email_opt_outs reads it from the scope).
     */
    async updateEmailPreferences(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<string[]> {
      assertCan(ctx, 'tenant.read');
      const data = parseInput(emailPreferencesSchema, input);
      const shown = new Set(EMAIL_NOTICE_KINDS.filter((kind) => EMAIL_NOTICES[kind].applies(ctx)));
      return db.run(ctx.scope, async (tx) => {
        const [row] = await tx
          .select({ optOuts: memberships.emailOptOuts })
          .from(memberships)
          .where(
            and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.id, ctx.membership.id)),
          );
        const next = [
          ...(row?.optOuts ?? []).filter((kind) => !shown.has(kind as EmailNoticeKind)),
          ...data.off.filter((kind) => shown.has(kind)),
        ];
        const res = await tx.execute<{ opt_outs: string[] }>(
          sql`select app.set_own_email_opt_outs(${sql.param(next)}::text[]) as opt_outs`,
        );
        const optOuts = res.rows[0]?.opt_outs ?? [];
        await recordAudit(
          tx,
          ctx,
          {
            action: 'membership.email_preferences_updated',
            subjectType: 'membership',
            subjectId: ctx.membership.id,
            metadata: { off: optOuts },
          },
          meta,
        );
        return optOuts;
      });
    },
  };
}

export type EmailPreferencesService = ReturnType<typeof createEmailPreferencesService>;
