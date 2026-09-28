import type { Metadata } from 'next';
import { ROLE_LABELS, assertCan, can, canAssignRoles } from '@w360/domain';
import { TENANT_ROLES } from '@w360/db';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { PlanLimitHint } from '@/components/plan-limit';
import { InviteForm } from '@/components/settings/invite-form';
import { InvitationActions, MemberActions } from '@/components/settings/member-actions';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Members' };
export const dynamic = 'force-dynamic';

const statusTone = { active: 'success', suspended: 'warning', removed: 'neutral' } as const;

export default async function MembersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  assertCan(ctx, 'members.read');
  const { tenancy, plans } = await getRuntime();
  const [members, invitations, usage] = await Promise.all([
    tenancy.listMembers(ctx),
    tenancy.listInvitations(ctx),
    plans.usage(ctx),
  ]);
  const canManage = can(ctx, 'members.manage');
  const roleOptions = TENANT_ROLES.map((r) => ({
    value: r,
    label: ROLE_LABELS[r].label,
    description: ROLE_LABELS[r].description,
    disabled: !canAssignRoles(ctx.membership.roles, [r]),
  }));
  const pending = invitations.filter((i) => i.status === 'pending');

  return (
    <div className="grid grid-cols-1 gap-6">
      <PlanLimitHint
        ctx={ctx}
        one="seat"
        what="seats"
        used={usage.seats.members + usage.seats.invitations}
        limit={usage.limits.seats}
        detail={
          usage.seats.invitations > 0
            ? `waiting invitations hold ${usage.seats.invitations === 1 ? 'a seat' : 'seats'}`
            : undefined
        }
      />
      {can(ctx, 'members.invite') ? (
        <InviteForm slug={ctx.tenant.slug} roleOptions={roleOptions} />
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Members ({members.filter((m) => m.status !== 'removed').length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Roles</TH>
                <TH>Status</TH>
                <TH>2FA</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {members.map((m) => (
                <TR key={m.membershipId}>
                  <TD>
                    <div className="font-medium">
                      {m.name}
                      {m.userId === ctx.user.id ? (
                        <span className="text-muted-foreground"> (you)</span>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted-foreground">{m.email}</div>
                  </TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      {m.roles.map((r) => (
                        <Badge key={r} tone={r === 'owner' ? 'info' : 'neutral'}>
                          {ROLE_LABELS[r].label}
                        </Badge>
                      ))}
                    </div>
                  </TD>
                  <TD>
                    <Badge tone={statusTone[m.status]}>{m.status}</Badge>
                  </TD>
                  <TD>
                    {m.twoFactorEnabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
                  </TD>
                  <TD className="text-right">
                    <MemberActions
                      slug={ctx.tenant.slug}
                      membershipId={m.membershipId}
                      name={m.name}
                      roles={m.roles}
                      status={m.status}
                      roleOptions={roleOptions}
                      canManage={
                        canManage &&
                        (!m.roles.includes('owner') || can(ctx, 'members.manage_owners'))
                      }
                      isSelf={m.userId === ctx.user.id}
                    />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Pending invitations ({pending.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {pending.length === 0 ? (
            <EmptyState
              title="No pending invitations"
              description="Invitations you send appear here until they are accepted, revoked or expire."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Email</TH>
                  <TH>Roles</TH>
                  <TH>Expires</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {pending.map((i) => (
                  <TR key={i.id}>
                    <TD>{i.email}</TD>
                    <TD>{i.roles.map((r) => ROLE_LABELS[r].label).join(', ')}</TD>
                    <TD>
                      <time dateTime={i.expiresAt.toISOString()}>{i.expiresAt.toUTCString()}</time>
                    </TD>
                    <TD className="text-right">
                      {can(ctx, 'members.invite') ? (
                        <InvitationActions
                          slug={ctx.tenant.slug}
                          invitationId={i.id}
                          email={i.email}
                        />
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
