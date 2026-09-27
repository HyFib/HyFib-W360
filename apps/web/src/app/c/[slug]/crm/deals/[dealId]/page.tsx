import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { can } from '@w360/domain';
import { formatMinor, minorToInput } from '@w360/domain/crm-money';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { DealEditForm, DealOutcomeActions, StageSelect } from '@/components/crm/deal-forms';
import { NoteForm, TaskForm, TaskStatusActions } from '@/components/crm/task-forms';
import { Timeline } from '@/components/crm/timeline';
import { PageHeader } from '@/components/page-header';
import { contactLabel, DEAL_STATUS } from '@/lib/crm-labels';
import { formatDateTime } from '@/lib/format';
import { crmLookups } from '@/server/crm';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Deal' };
export const dynamic = 'force-dynamic';

export default async function DealPage({
  params,
}: {
  params: Promise<{ slug: string; dealId: string }>;
}) {
  const { slug, dealId } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'crm.read')) notFound();
  const { crm } = await getRuntime();
  let deal: Awaited<ReturnType<typeof crm.getDeal>>;
  try {
    deal = await crm.getDeal(ctx, dealId);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const lookups = await crmLookups(ctx);
  const tz = ctx.tenant.timezone;
  const canWrite = can(ctx, 'crm.write');
  const editable = canWrite && !deal.contact.erased;
  const status = DEAL_STATUS[deal.status] ?? { label: deal.status, tone: 'neutral' as const };
  const pipeline = lookups.options.find((p) => p.id === deal.pipelineId);
  const me = ctx.membership.id;
  const canAssign = lookups.memberOptions.some((m) => m.membershipId === me);
  const contactHref = can(ctx, 'contacts.read')
    ? `/c/${ctx.tenant.slug}/contacts/${deal.contact.id}`
    : null;
  return (
    <>
      <PageHeader
        title={deal.title}
        description={`${deal.pipelineName} · ${deal.valueMinor !== null ? formatMinor(deal.valueMinor, deal.currency) : 'No value'}`}
        actions={
          <Link
            href={`/c/${ctx.tenant.slug}/crm`}
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            All deals
          </Link>
        }
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                Status <Badge tone={status.tone}>{status.label}</Badge>
              </CardTitle>
              <CardDescription>
                {deal.status === 'open'
                  ? `In ${deal.stageName} since ${formatDateTime(deal.stageEnteredAt, tz)}.`
                  : `${status.label} ${deal.closedAt ? formatDateTime(deal.closedAt, tz) : ''}${deal.closedBy ? ` by ${deal.closedBy.name}` : ''}, in ${deal.stageName}.`}
                {deal.lostReason ? ` Reason: ${deal.lostReason}` : ''}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {canWrite && deal.status === 'open' && pipeline ? (
                <div className="grid gap-1 sm:max-w-xs">
                  <span className="text-sm font-medium">Stage</span>
                  <StageSelect
                    slug={ctx.tenant.slug}
                    dealId={deal.id}
                    dealTitle={deal.title}
                    version={deal.version}
                    stageId={deal.stageId}
                    stages={pipeline.stages}
                  />
                </div>
              ) : null}
              {canWrite ? (
                <DealOutcomeActions
                  slug={ctx.tenant.slug}
                  dealId={deal.id}
                  version={deal.version}
                  status={deal.status}
                />
              ) : null}
            </CardContent>
          </Card>
          {editable ? (
            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent>
                <DealEditForm
                  key={deal.version}
                  slug={ctx.tenant.slug}
                  deal={{
                    id: deal.id,
                    version: deal.version,
                    title: deal.title,
                    value:
                      deal.valueMinor !== null ? minorToInput(deal.valueMinor, deal.currency) : '',
                    currency: deal.currency,
                    ownerMembershipId: deal.owner?.membershipId ?? null,
                    expectedCloseOn: deal.expectedCloseOn,
                  }}
                  members={lookups.memberOptions}
                />
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Tasks</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              {deal.tasks.open.length === 0 ? (
                <p className="text-sm text-muted-foreground">No open tasks.</p>
              ) : (
                <ul className="grid gap-3">
                  {deal.tasks.open.map((t) => (
                    <li key={t.id} className="grid gap-1 text-sm">
                      <span className="break-words font-medium">{t.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {t.assignee ? t.assignee.name : 'Unassigned'}
                        {t.dueAt ? ` · due ${formatDateTime(t.dueAt, tz)}` : ''}
                      </span>
                      {canWrite ? (
                        <TaskStatusActions
                          slug={ctx.tenant.slug}
                          taskId={t.id}
                          taskTitle={t.title}
                          version={t.version}
                          status={t.status}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {editable && lookups.memberOptions.length > 0 ? (
                <details className="rounded-md border border-border p-3">
                  <summary className="cursor-pointer text-sm font-medium">New task</summary>
                  <div className="mt-3">
                    <TaskForm
                      slug={ctx.tenant.slug}
                      members={lookups.memberOptions}
                      timeZone={tz}
                      defaultAssigneeId={
                        canAssign ? me : (lookups.memberOptions[0]?.membershipId ?? '')
                      }
                      dealId={deal.id}
                    />
                  </div>
                </details>
              ) : null}
              {deal.tasks.done.length > 0 ? (
                <details>
                  <summary className="cursor-pointer text-sm text-muted-foreground">
                    {deal.tasks.done.length} closed task{deal.tasks.done.length === 1 ? '' : 's'}
                  </summary>
                  <ul className="mt-2 grid gap-2">
                    {deal.tasks.done.map((t) => (
                      <li key={t.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="break-words line-through">{t.title}</span>
                        {canWrite ? (
                          <TaskStatusActions
                            slug={ctx.tenant.slug}
                            taskId={t.id}
                            taskTitle={t.title}
                            version={t.version}
                            status={t.status}
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </CardContent>
          </Card>
        </div>
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Contact</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {contactHref && !deal.contact.erased ? (
                <Link
                  href={contactHref}
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  {contactLabel(deal.contact)}
                </Link>
              ) : (
                <span className="font-medium">{contactLabel(deal.contact)}</span>
              )}
              {deal.contact.phone ? (
                <span className="text-muted-foreground">{deal.contact.phone}</span>
              ) : null}
              {deal.conversationId ? (
                <Link
                  href={`/c/${ctx.tenant.slug}/inbox/${deal.conversationId}`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Open the conversation
                </Link>
              ) : null}
              <span className="text-xs text-muted-foreground">
                Created {formatDateTime(deal.createdAt, tz)}
                {deal.createdBy ? ` by ${deal.createdBy.name}` : ''}
                {deal.owner ? ` · owner ${deal.owner.name}` : ' · no owner'}
                {deal.expectedCloseOn ? ` · expected to close ${deal.expectedCloseOn}` : ''}
              </span>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              {editable ? <NoteForm slug={ctx.tenant.slug} dealId={deal.id} /> : null}
              <Timeline
                items={deal.timeline}
                slug={ctx.tenant.slug}
                timeZone={tz}
                stageNames={lookups.stageNames}
                memberNames={lookups.memberNames}
                currency={deal.currency}
                showDeal={false}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
