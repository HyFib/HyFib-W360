import Link from 'next/link';
import type { ReactNode } from 'react';
import { can } from '@w360/domain';
import { Alert, Button } from '@w360/ui';
import { AppNav } from '@/components/app-nav';
import { Brand } from '@/components/brand';
import { CompanySwitcher } from '@/components/company-switcher';
import { UserMenu } from '@/components/user-menu';
import { formatDateTime } from '@/lib/format';
import { visibleModules } from '@/lib/modules';
import { getRuntime } from '@/server/runtime';
import { correlationId, requireTenant } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function TenantLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // Layout chrome only; every page re-checks access itself (layouts are not re-run on client navigation).
  const ctx = await requireTenant(slug);
  const runtime = await getRuntime();
  const [companies, platformActor] = await Promise.all([
    runtime.tenancy.listMyCompanies(ctx.user.id),
    runtime.platform.resolveActor(ctx.user.id, await correlationId()),
  ]);
  const base = `/c/${ctx.tenant.slug}`;
  const nav = visibleModules(ctx.permissions);
  const deletion =
    ctx.tenant.status === 'pending_deletion' ? await runtime.companyDeletion.status(ctx) : null;

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="border-b border-border bg-sidebar md:w-64 md:shrink-0 md:border-b-0 md:border-r print:hidden">
        <div className="md:sticky md:top-0 md:flex md:h-dvh md:flex-col">
          <div className="flex items-center justify-between gap-2 px-4 py-4">
            <Link
              href="/"
              className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Brand />
            </Link>
            <div className="md:hidden">
              <UserMenu
                name={ctx.user.name}
                email={ctx.user.email}
                isPlatformAdmin={Boolean(platformActor)}
              />
            </div>
          </div>
          <div className="px-3 pb-3">
            <CompanySwitcher
              current={{ slug: ctx.tenant.slug, name: ctx.tenant.name, status: ctx.tenant.status }}
              companies={companies.map((c) => ({ slug: c.slug, name: c.name, status: c.status }))}
            />
          </div>
          <div className="overflow-x-auto px-3 pb-3 md:flex-1 md:overflow-y-auto">
            <AppNav
              base={base}
              items={nav.map((m) => ({ key: m.key, label: m.label, path: m.path }))}
            />
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="hidden items-center justify-end gap-3 border-b border-border px-6 py-3 md:flex print:hidden">
          <UserMenu
            name={ctx.user.name}
            email={ctx.user.email}
            isPlatformAdmin={Boolean(platformActor)}
          />
        </header>
        <div className="grid gap-3 px-4 pt-4 md:px-8">
          {ctx.tenant.status === 'pending_deletion' ? (
            <Alert
              tone="danger"
              title="This company is being deleted"
              action={
                can(ctx, 'tenant.export') || can(ctx, 'tenant.delete') ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/c/${ctx.tenant.slug}/settings/data`}>Company data</Link>
                  </Button>
                ) : undefined
              }
            >
              {deletion?.started
                ? 'The deletion has started and can no longer be cancelled.'
                : deletion?.requestedBy === 'platform'
                  ? `It will be deleted on ${formatDateTime(deletion.dueAt, ctx.tenant.timezone)}: HyFib scheduled the deletion. Until then nothing is sent; members can still review its data, and an owner can export it. Only HyFib can cancel the deletion. HyFib’s reason: ${deletion.reason ?? ''}`
                  : `It will be deleted on ${deletion ? formatDateTime(deletion.dueAt, ctx.tenant.timezone) : 'the date its owners were emailed'}. Until then nothing is sent; members can still review its data, and an owner can export it or cancel the deletion.`}
            </Alert>
          ) : ctx.tenant.status === 'restricted' ? (
            <Alert
              tone="warning"
              title="This company's plan has ended"
              action={
                can(ctx, 'billing.read') ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/c/${ctx.tenant.slug}/billing`}>See the plan</Link>
                  </Button>
                ) : undefined
              }
            >
              Sending messages, campaigns and automations is paused until HyFib renews the plan. You
              can still review data, export it and manage members and billing.
            </Alert>
          ) : ctx.tenant.status !== 'active' ? (
            <Alert tone="warning" title="This company is suspended">
              Outbound messaging and changes that send data are paused. You can still review data,
              export it and manage billing.
            </Alert>
          ) : ctx.plan.status === 'past_due' && can(ctx, 'billing.read') ? (
            <Alert
              tone="warning"
              title="The paid period of your plan has ended"
              action={
                <Button asChild size="sm" variant="outline">
                  <Link href={`/c/${ctx.tenant.slug}/billing`}>See the plan</Link>
                </Button>
              }
            >
              Everything keeps working for a few days. Ask HyFib to renew the plan.
            </Alert>
          ) : null}
          {ctx.mfa.required && !ctx.mfa.satisfied ? (
            <Alert
              tone={ctx.mfa.blocking ? 'danger' : 'warning'}
              title={
                ctx.mfa.blocking
                  ? 'Two-factor authentication required'
                  : 'Set up two-factor authentication'
              }
              action={
                <Button asChild size="sm" variant="outline">
                  <Link href="/account#security">Set up now</Link>
                </Button>
              }
            >
              {ctx.mfa.blocking
                ? 'Your role requires two-factor authentication. Most features are locked until you enable it.'
                : `Your role requires two-factor authentication. Enable it before ${ctx.mfa.graceEndsAt?.toUTCString() ?? 'the deadline'}.`}
            </Alert>
          ) : null}
        </div>
        <main id="main" className="flex-1 px-4 py-6 md:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
