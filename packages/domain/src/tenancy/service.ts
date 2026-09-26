import type { z } from 'zod';
import {
  AppError,
  isAppError,
  conflict,
  forbidden,
  maskEmail,
  notFound,
  randomToken,
  sha256Hex,
  uuidv7,
  type Clock,
} from '@w360/core';
import {
  and,
  authenticatedUserScope,
  desc,
  eq,
  gt,
  auditEvents,
  invitations,
  lt,
  memberships,
  or,
  sql,
  tenants,
  userPreferences,
  users,
  type Database,
  type TenantRole,
} from '@w360/db';
import {
  auditQuerySchema,
  changeMemberRolesSchema,
  createCompanySchema,
  inviteMemberSchema,
  invitationIdSchema,
  invitationTokenSchema,
  memberStatusSchema,
  updateCompanySecuritySchema,
  updateCompanySettingsSchema,
  type CreateCompanyInput,
} from '@w360/contracts';
import { assertCan, type TenantContext } from '../authz/context';
import { canAssignRoles, ROLE_LABELS } from '../authz/permissions';
import { recordAudit, type RequestMeta } from '../audit';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';

export interface TenancyDeps extends OutboxDeps {
  db: Database;
  clock: Clock;
  appBaseUrl: string;
  invitationTtlHours: number;
}

export interface MyCompany {
  id: string;
  slug: string;
  name: string;
  status: string;
  roles: TenantRole[];
}

export interface MemberView {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  roles: TenantRole[];
  status: 'active' | 'suspended' | 'removed';
  twoFactorEnabled: boolean;
  joinedAt: Date;
}

export interface InvitationView {
  id: string;
  email: string;
  roles: TenantRole[];
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: Date;
  createdAt: Date;
  sendCount: number;
}

const MAX_INVITES_PER_DAY = 100;
const MAX_RESENDS = 5;

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError('validation_failed', 'Please correct the highlighted fields.', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

export function createTenancyService(deps: TenancyDeps) {
  const { db, clock } = deps;

  async function sendInvitationEmail(
    tx: Parameters<Parameters<Database['run']>[1]>[0],
    ctx: TenantContext,
    invitation: { id: string; email: string; roles: TenantRole[]; expiresAt: Date },
    token: string,
  ) {
    await enqueueEmail(deps, tx, {
      to: invitation.email,
      tenantId: ctx.tenant.id,
      dedupeKey: `invitation:${invitation.id}:${sha256Hex(token).slice(0, 16)}`,
      payload: {
        kind: 'tenant.invitation',
        companyName: ctx.tenant.name,
        inviterName: ctx.user.name,
        roles: invitation.roles.map((r) => ROLE_LABELS[r].label),
        url: `${deps.appBaseUrl}/invite/${token}`,
        expiresAt: invitation.expiresAt.toUTCString(),
      },
    });
  }

  return {
    /** Creates a company with the caller as owner. Requires a verified email (enforced in SQL). */
    async createCompany(
      userId: string,
      input: CreateCompanyInput | unknown,
    ): Promise<{ tenantId: string; slug: string }> {
      const data = parse(createCompanySchema, input);
      const tenantId = uuidv7();
      const membershipId = uuidv7();
      try {
        await db.run(authenticatedUserScope(userId), async (tx) => {
          await tx.execute(
            sql`select app.create_tenant(${tenantId}::uuid, ${membershipId}::uuid, ${data.name}, ${data.slug}, ${data.timezone}, 'en')`,
          );
          await tx
            .insert(userPreferences)
            .values({ userId, lastTenantId: tenantId })
            .onConflictDoUpdate({
              target: userPreferences.userId,
              set: { lastTenantId: tenantId },
            });
        });
      } catch (error) {
        if (isAppError(error) && error.code === 'conflict') {
          throw new AppError('conflict', 'That company address is already taken. Choose another.', {
            issues: [{ path: 'slug', message: 'Already taken' }],
          });
        }
        throw error;
      }
      return { tenantId, slug: data.slug };
    },

    async listMyCompanies(userId: string): Promise<MyCompany[]> {
      return db.run(
        authenticatedUserScope(userId),
        async (tx) =>
          tx
            .select({
              id: tenants.id,
              slug: tenants.slug,
              name: tenants.name,
              status: tenants.status,
              roles: memberships.roles,
            })
            .from(memberships)
            .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
            .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')))
            .orderBy(tenants.name),
        { accessMode: 'read only' },
      );
    },

    /** Slug of the company to open after sign-in: last used if still accessible, else the first. */
    async defaultCompanySlug(userId: string): Promise<string | null> {
      return db.run(
        authenticatedUserScope(userId),
        async (tx) => {
          const pref = await tx
            .select({ lastTenantId: userPreferences.lastTenantId })
            .from(userPreferences)
            .where(eq(userPreferences.userId, userId));
          const companies = await tx
            .select({ id: tenants.id, slug: tenants.slug })
            .from(memberships)
            .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
            .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')))
            .orderBy(tenants.name);
          const last = companies.find((c) => c.id === pref[0]?.lastTenantId);
          return (last ?? companies[0])?.slug ?? null;
        },
        { accessMode: 'read only' },
      );
    },

    async rememberCompany(ctx: TenantContext): Promise<void> {
      await db.run(authenticatedUserScope(ctx.user.id), async (tx) => {
        await tx
          .insert(userPreferences)
          .values({ userId: ctx.user.id, lastTenantId: ctx.tenant.id })
          .onConflictDoUpdate({
            target: userPreferences.userId,
            set: { lastTenantId: ctx.tenant.id },
          });
      });
    },

    async updateSettings(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<void> {
      assertCan(ctx, 'tenant.settings.manage');
      const data = parse(updateCompanySettingsSchema, input);
      await db.run(ctx.scope, async (tx) => {
        const changed = await tx
          .update(tenants)
          .set({ name: data.name, timezone: data.timezone, locale: data.locale })
          .where(eq(tenants.id, ctx.tenant.id))
          .returning({ id: tenants.id });
        if (changed.length !== 1) throw notFound('Company');
        await recordAudit(
          tx,
          ctx,
          {
            action: 'tenant.settings_updated',
            subjectType: 'tenant',
            subjectId: ctx.tenant.id,
            metadata: {
              changed: Object.entries(data)
                .filter(([k, v]) => (ctx.tenant as Record<string, unknown>)[k] !== v)
                .map(([k]) => k),
            },
          },
          meta,
        );
      });
    },

    async updateSecurity(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<void> {
      assertCan(ctx, 'tenant.security.manage');
      const data = parse(updateCompanySecuritySchema, input);
      await db.run(ctx.scope, async (tx) => {
        await tx
          .update(tenants)
          .set({ requireMfaAllMembers: data.requireMfaAllMembers })
          .where(eq(tenants.id, ctx.tenant.id));
        await recordAudit(
          tx,
          ctx,
          {
            action: 'tenant.security_updated',
            subjectType: 'tenant',
            subjectId: ctx.tenant.id,
            metadata: { requireMfaAllMembers: data.requireMfaAllMembers },
          },
          meta,
        );
      });
    },

    async listMembers(ctx: TenantContext): Promise<MemberView[]> {
      assertCan(ctx, 'members.read');
      return db.run(
        ctx.scope,
        async (tx) =>
          tx
            .select({
              membershipId: memberships.id,
              userId: memberships.userId,
              name: users.name,
              email: users.email,
              roles: memberships.roles,
              status: memberships.status,
              twoFactorEnabled: users.twoFactorEnabled,
              joinedAt: memberships.joinedAt,
            })
            .from(memberships)
            .innerJoin(users, eq(users.id, memberships.userId))
            .where(eq(memberships.tenantId, ctx.tenant.id))
            .orderBy(memberships.status, users.name),
        { accessMode: 'read only' },
      );
    },

    async changeMemberRoles(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<void> {
      assertCan(ctx, 'members.manage');
      const data = parse(changeMemberRolesSchema, input);
      await db.run(ctx.scope, async (tx) => {
        const [target] = await tx
          .select({
            id: memberships.id,
            userId: memberships.userId,
            roles: memberships.roles,
            status: memberships.status,
          })
          .from(memberships)
          .where(
            and(eq(memberships.id, data.membershipId), eq(memberships.tenantId, ctx.tenant.id)),
          )
          .for('update');
        if (!target || target.status === 'removed') throw notFound('Member');
        const touchesOwner = target.roles.includes('owner') || data.roles.includes('owner');
        if (touchesOwner && !ctx.permissions.has('members.manage_owners')) {
          throw forbidden('Only owners can grant, change or remove the owner role.');
        }
        if (!canAssignRoles(ctx.membership.roles, data.roles)) throw forbidden();
        if (target.userId === ctx.user.id && !target.roles.includes('owner')) {
          throw forbidden('You cannot change your own roles.');
        }
        await tx
          .update(memberships)
          .set({ roles: data.roles })
          .where(eq(memberships.id, target.id));
        await recordAudit(
          tx,
          ctx,
          {
            action: 'member.roles_changed',
            subjectType: 'membership',
            subjectId: target.id,
            metadata: { from: target.roles, to: data.roles },
          },
          meta,
        );
      });
    },

    async setMemberStatus(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<void> {
      assertCan(ctx, 'members.manage');
      const data = parse(memberStatusSchema, input);
      await db.run(ctx.scope, async (tx) => {
        const [target] = await tx
          .select({
            id: memberships.id,
            userId: memberships.userId,
            roles: memberships.roles,
            status: memberships.status,
          })
          .from(memberships)
          .where(
            and(eq(memberships.id, data.membershipId), eq(memberships.tenantId, ctx.tenant.id)),
          )
          .for('update');
        if (!target) throw notFound('Member');
        if (target.userId === ctx.user.id)
          throw forbidden('Use “Leave company” to remove yourself.');
        if (target.roles.includes('owner') && !ctx.permissions.has('members.manage_owners')) {
          throw forbidden('Only owners can suspend or remove another owner.');
        }
        if (target.status === 'removed' && data.status !== 'removed') {
          throw new AppError('precondition_failed', 'Removed members must be invited again.');
        }
        if (target.status === data.status) return;
        await tx
          .update(memberships)
          .set({ status: data.status, statusChangedAt: clock.now(), statusChangedBy: ctx.user.id })
          .where(eq(memberships.id, target.id));
        await recordAudit(
          tx,
          ctx,
          {
            action:
              data.status === 'active'
                ? 'member.restored'
                : data.status === 'suspended'
                  ? 'member.suspended'
                  : 'member.removed',
            subjectType: 'membership',
            subjectId: target.id,
            metadata: { previous: target.status },
          },
          meta,
        );
      });
    },

    async leaveCompany(ctx: TenantContext, meta: RequestMeta = {}): Promise<void> {
      await db.run(ctx.scope, async (tx) => {
        await tx
          .update(memberships)
          .set({ status: 'removed', statusChangedAt: clock.now(), statusChangedBy: ctx.user.id })
          .where(
            and(eq(memberships.id, ctx.membership.id), eq(memberships.tenantId, ctx.tenant.id)),
          );
        await recordAudit(
          tx,
          ctx,
          { action: 'member.left', subjectType: 'membership', subjectId: ctx.membership.id },
          meta,
        );
      });
    },

    async listInvitations(ctx: TenantContext): Promise<InvitationView[]> {
      assertCan(ctx, 'members.read');
      const now = clock.now();
      const rows = await db.run(
        ctx.scope,
        async (tx) =>
          tx
            .select({
              id: invitations.id,
              email: invitations.email,
              roles: invitations.roles,
              status: invitations.status,
              expiresAt: invitations.expiresAt,
              createdAt: invitations.createdAt,
              sendCount: invitations.sendCount,
            })
            .from(invitations)
            .where(eq(invitations.tenantId, ctx.tenant.id))
            .orderBy(desc(invitations.createdAt))
            .limit(200),
        { accessMode: 'read only' },
      );
      return rows.map((r) => ({
        ...r,
        status: r.status === 'pending' && r.expiresAt <= now ? 'expired' : r.status,
      }));
    },

    async createInvitation(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<{ invitationId: string }> {
      assertCan(ctx, 'members.invite');
      const data = parse(inviteMemberSchema, input);
      if (!canAssignRoles(ctx.membership.roles, data.roles)) {
        throw forbidden('Only owners can invite other owners.');
      }
      const token = randomToken();
      const invitationId = uuidv7();
      const now = clock.now();
      const expiresAt = new Date(now.getTime() + deps.invitationTtlHours * 3600_000);
      await db.run(ctx.scope, async (tx) => {
        // Serialise issuance per company: otherwise concurrent requests could all count the same
        // number of recent invitations, below the daily quota, before any of their inserts commit.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`w360:invitations:${ctx.tenant.id}`}, 0))`,
        );
        const existingMember = await tx
          .select({ id: memberships.id, status: memberships.status })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.tenantId, ctx.tenant.id),
              sql`lower(${users.email}) = ${data.email}`,
            ),
          );
        if (existingMember.some((m) => m.status === 'active' || m.status === 'suspended')) {
          throw conflict('This person is already a member of the company.');
        }
        const [{ recent } = { recent: 0 }] = await tx
          .select({ recent: sql<number>`count(*)::int` })
          .from(invitations)
          .where(
            and(
              eq(invitations.tenantId, ctx.tenant.id),
              gt(invitations.createdAt, new Date(now.getTime() - 86400_000)),
            ),
          );
        if (recent >= MAX_INVITES_PER_DAY)
          throw new AppError('rate_limited', 'Daily invitation limit reached.');

        // Lazily retire an expired pending invitation for the same address so a new one can be issued.
        await tx
          .update(invitations)
          .set({ status: 'expired' })
          .where(
            and(
              eq(invitations.tenantId, ctx.tenant.id),
              eq(invitations.email, data.email),
              eq(invitations.status, 'pending'),
              lt(invitations.expiresAt, now),
            ),
          );
        const pending = await tx
          .select({ id: invitations.id })
          .from(invitations)
          .where(
            and(
              eq(invitations.tenantId, ctx.tenant.id),
              eq(invitations.email, data.email),
              eq(invitations.status, 'pending'),
            ),
          );
        if (pending.length > 0)
          throw conflict('An invitation is already pending for this address. Resend it instead.');

        await tx.insert(invitations).values({
          id: invitationId,
          tenantId: ctx.tenant.id,
          email: data.email,
          roles: data.roles,
          tokenHash: sha256Hex(token),
          expiresAt,
          invitedByUserId: ctx.user.id,
        });
        await sendInvitationEmail(
          tx,
          ctx,
          { id: invitationId, email: data.email, roles: data.roles, expiresAt },
          token,
        );
        await recordAudit(
          tx,
          ctx,
          {
            action: 'member.invited',
            subjectType: 'invitation',
            subjectId: invitationId,
            metadata: { email: maskEmail(data.email), roles: data.roles },
          },
          meta,
        );
      });
      return { invitationId };
    },

    /** Issues a fresh token (invalidating the old link) and extends the expiry. */
    async resendInvitation(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<void> {
      assertCan(ctx, 'members.invite');
      const { invitationId } = parse(invitationIdSchema, input);
      const token = randomToken();
      const now = clock.now();
      const expiresAt = new Date(now.getTime() + deps.invitationTtlHours * 3600_000);
      await db.run(ctx.scope, async (tx) => {
        const [inv] = await tx
          .select()
          .from(invitations)
          .where(and(eq(invitations.id, invitationId), eq(invitations.tenantId, ctx.tenant.id)))
          .for('update');
        if (!inv) throw notFound('Invitation');
        if (inv.status !== 'pending')
          throw new AppError('precondition_failed', 'Only pending invitations can be resent.');
        if (!canAssignRoles(ctx.membership.roles, inv.roles)) throw forbidden();
        if (inv.sendCount > MAX_RESENDS)
          throw new AppError('rate_limited', 'This invitation has been resent too many times.');
        await tx
          .update(invitations)
          .set({
            tokenHash: sha256Hex(token),
            expiresAt,
            sendCount: inv.sendCount + 1,
            lastSentAt: now,
          })
          .where(eq(invitations.id, inv.id));
        await sendInvitationEmail(
          tx,
          ctx,
          { id: inv.id, email: inv.email, roles: inv.roles, expiresAt },
          token,
        );
        await recordAudit(
          tx,
          ctx,
          { action: 'member.invitation_resent', subjectType: 'invitation', subjectId: inv.id },
          meta,
        );
      });
    },

    async revokeInvitation(
      ctx: TenantContext,
      input: unknown,
      meta: RequestMeta = {},
    ): Promise<void> {
      assertCan(ctx, 'members.invite');
      const { invitationId } = parse(invitationIdSchema, input);
      await db.run(ctx.scope, async (tx) => {
        const updated = await tx
          .update(invitations)
          .set({ status: 'revoked', revokedAt: clock.now(), revokedByUserId: ctx.user.id })
          .where(
            and(
              eq(invitations.id, invitationId),
              eq(invitations.tenantId, ctx.tenant.id),
              eq(invitations.status, 'pending'),
            ),
          )
          .returning({ id: invitations.id });
        if (updated.length === 0) throw notFound('Pending invitation');
        await recordAudit(
          tx,
          ctx,
          {
            action: 'member.invitation_revoked',
            subjectType: 'invitation',
            subjectId: invitationId,
          },
          meta,
        );
      });
    },

    async previewInvitation(token: string) {
      const parsed = invitationTokenSchema.safeParse(token);
      if (!parsed.success) return null;
      return db.run(
        { kind: 'system' },
        async (tx) => {
          const res = await tx.execute<{
            invitation_id: string;
            tenant_name: string;
            email: string;
            roles: TenantRole[];
            expires_at: Date;
            status: string;
            inviter_name: string;
          }>(sql`select * from app.invitation_preview(${sha256Hex(parsed.data)})`);
          const row = res.rows[0];
          if (!row) return null;
          return {
            invitationId: row.invitation_id,
            companyName: row.tenant_name,
            email: row.email,
            roles: row.roles,
            expiresAt: new Date(row.expires_at),
            status: row.status as 'pending' | 'accepted' | 'revoked' | 'expired' | 'unavailable',
            inviterName: row.inviter_name,
          };
        },
        { accessMode: 'read only' },
      );
    },

    async acceptInvitation(
      userId: string,
      token: string,
    ): Promise<{ tenantId: string; slug: string }> {
      const parsed = invitationTokenSchema.safeParse(token);
      if (!parsed.success) throw notFound('Invitation');
      return db.run(authenticatedUserScope(userId), async (tx) => {
        const res = await tx.execute<{ tenant_id: string }>(
          sql`select app.accept_invitation(${sha256Hex(parsed.data)}, ${uuidv7()}::uuid) as tenant_id`,
        );
        const tenantId = res.rows[0]?.tenant_id;
        if (!tenantId) throw notFound('Invitation');
        const [company] = await tx
          .select({ slug: tenants.slug })
          .from(tenants)
          .where(eq(tenants.id, tenantId));
        if (!company) throw notFound('Company');
        await tx
          .insert(userPreferences)
          .values({ userId, lastTenantId: tenantId })
          .onConflictDoUpdate({ target: userPreferences.userId, set: { lastTenantId: tenantId } });
        return { tenantId, slug: company.slug };
      });
    },

    async listAuditEvents(ctx: TenantContext, input: unknown) {
      assertCan(ctx, 'audit.read');
      const query = parse(auditQuerySchema, input ?? {});
      const cursor = decodeCursor(query.cursor);
      const rows = await db.run(
        ctx.scope,
        async (tx) =>
          tx
            .select({
              id: auditEvents.id,
              occurredAt: auditEvents.occurredAt,
              actorType: auditEvents.actorType,
              actorId: auditEvents.actorId,
              actorName: users.name,
              action: auditEvents.action,
              subjectType: auditEvents.subjectType,
              subjectId: auditEvents.subjectId,
              result: auditEvents.result,
              metadata: auditEvents.metadata,
            })
            .from(auditEvents)
            .leftJoin(users, eq(users.id, auditEvents.actorId))
            .where(
              and(
                eq(auditEvents.tenantId, ctx.tenant.id),
                query.action ? eq(auditEvents.action, query.action) : undefined,
                cursor
                  ? or(
                      lt(auditEvents.occurredAt, cursor.at),
                      and(eq(auditEvents.occurredAt, cursor.at), lt(auditEvents.id, cursor.id)),
                    )
                  : undefined,
              ),
            )
            .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
            .limit(query.limit + 1),
        { accessMode: 'read only' },
      );
      const hasMore = rows.length > query.limit;
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      return {
        events: page,
        nextCursor: hasMore && last ? encodeCursor(last.occurredAt, last.id) : null,
      };
    },
  };
}

export type TenancyService = ReturnType<typeof createTenancyService>;

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const date = at ? new Date(at) : null;
  if (!date || Number.isNaN(date.getTime()) || !id || !/^[0-9a-f-]{36}$/.test(id)) {
    throw new AppError('validation_failed', 'Invalid cursor.');
  }
  return { at: date, id };
}
