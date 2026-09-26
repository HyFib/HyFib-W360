import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckCircle2, Circle } from 'lucide-react';
import { can } from '@w360/domain';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { PageHeader } from '@/components/page-header';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Overview' };
export const dynamic = 'force-dynamic';

export default async function OverviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  const { tenancy } = await getRuntime();
  const [members, invitations, audit] = await Promise.all([
    can(ctx, 'members.read') ? tenancy.listMembers(ctx) : Promise.resolve([]),
    can(ctx, 'members.read') ? tenancy.listInvitations(ctx) : Promise.resolve([]),
    can(ctx, 'audit.read') ? tenancy.listAuditEvents(ctx, { limit: 8 }) : Promise.resolve(null),
  ]);
  const activeMembers = members.filter((m) => m.status === 'active');
  const pendingInvites = invitations.filter((i) => i.status === 'pending');
  const base = `/c/${ctx.tenant.slug}`;

  const checklist = [
    { done: true, label: 'Verify your email address' },
    {
      done: ctx.user.twoFactorEnabled,
      label: 'Enable two-factor authentication',
      href: '/account#security',
    },
    {
      done: activeMembers.length + pendingInvites.length > 1,
      label: 'Invite your team',
      href: `${base}/settings/members`,
    },
    {
      done: false,
      label: 'Connect a WhatsApp Business number',
      note: 'Available once Meta Embedded Signup is configured for this deployment (phase 2).',
    },
  ];

  return (
    <>
      <PageHeader title={ctx.tenant.name} description={`Time zone: ${ctx.tenant.timezone}`} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Get started</CardTitle>
            <CardDescription>
              Complete these steps to start engaging customers on WhatsApp.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-3">
              {checklist.map((item) => (
                <li key={item.label} className="flex items-start gap-3">
                  {item.done ? (
                    <CheckCircle2 aria-hidden="true" className="mt-0.5 size-5 text-success" />
                  ) : (
                    <Circle aria-hidden="true" className="mt-0.5 size-5 text-muted-foreground" />
                  )}
                  <div className="grid gap-0.5">
                    <span
                      className={item.done ? 'text-muted-foreground line-through' : 'font-medium'}
                    >
                      {item.href && !item.done ? (
                        <Link href={item.href} className="underline-offset-4 hover:underline">
                          {item.label}
                        </Link>
                      ) : (
                        item.label
                      )}
                      <span className="sr-only">{item.done ? ' (done)' : ' (to do)'}</span>
                    </span>
                    {item.note ? (
                      <span className="text-xs text-muted-foreground">{item.note}</span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Team</CardTitle>
            <CardDescription>Your roles: {ctx.membership.roles.join(', ')}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Active members</span>
              <span className="font-medium">{activeMembers.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Pending invitations</span>
              <span className="font-medium">{pendingInvites.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Company status</span>
              <Badge tone={ctx.tenant.status === 'active' ? 'success' : 'warning'}>
                {ctx.tenant.status}
              </Badge>
            </div>
          </CardContent>
        </Card>
        {audit ? (
          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle>Recent activity</CardTitle>
              <CardDescription>
                From the audit log.{' '}
                <Link
                  href={`${base}/settings/audit`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  View all
                </Link>
              </CardDescription>
            </CardHeader>
            <CardContent>
              {audit.events.length === 0 ? (
                <p className="text-sm text-muted-foreground">No activity yet.</p>
              ) : (
                <ul className="grid gap-2 text-sm">
                  {audit.events.map((e) => (
                    <li key={e.id} className="flex flex-wrap justify-between gap-2">
                      <span>
                        <span className="font-medium">{e.actorName ?? e.actorType}</span> ·{' '}
                        <code className="text-xs">{e.action}</code>
                      </span>
                      <time dateTime={e.occurredAt.toISOString()} className="text-muted-foreground">
                        {e.occurredAt.toUTCString()}
                      </time>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
