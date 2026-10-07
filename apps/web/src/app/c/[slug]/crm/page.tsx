import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { can } from '@w360/domain';
import { formatMinor } from '@w360/domain/crm-money';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { NewDealForm, StageSelect } from '@/components/crm/deal-forms';
import { CrmTabs } from '@/components/crm/crm-tabs';
import { PageHeader } from '@/components/page-header';
import { ModuleNotInPlan } from '@/components/plan-limit';
import { contactLabel, DEAL_STATUS } from '@/lib/crm-labels';
import { formatDate, formatDateTime } from '@/lib/format';
import { crmLookups } from '@/server/crm';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'CRM' };
export const dynamic = 'force-dynamic';

const OWNER_FILTERS = [
  { key: 'all', label: 'Everyone' },
  { key: 'mine', label: 'Mine' },
  { key: 'none', label: 'No owner' },
] as const;

export default async function CrmPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ pipeline?: string; owner?: string; view?: string; cursor?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'crm.read')) notFound();
  const { crm } = await getRuntime();
  const base = `/c/${ctx.tenant.slug}/crm`;
  const tz = ctx.tenant.timezone;
  const canWrite = can(ctx, 'crm.write');
  const view = query.view === 'won' || query.view === 'lost' ? query.view : 'board';
  const owner = OWNER_FILTERS.find((f) => f.key === query.owner)?.key ?? 'all';
  const lookups = await crmLookups(ctx);
  const pipelineId = lookups.options.find((p) => p.id === query.pipeline)?.id ?? null;
  const board = view === 'board' ? await crm.board(ctx, { pipelineId, owner }) : null;
  const cursor = view === 'board' ? null : (query.cursor ?? null);
  let closed: Awaited<ReturnType<typeof crm.listDeals>> | null = null;
  if (view !== 'board') {
    try {
      closed = await crm.listDeals(ctx, { status: view, cursor });
    } catch (error) {
      // A cursor from an old or edited link: show the newest page instead.
      if (!isAppError(error) || error.code !== 'validation_failed' || !cursor) throw error;
      closed = await crm.listDeals(ctx, { status: view });
    }
  }
  const href = (extra: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const merged = { pipeline: board?.pipeline.id ?? null, owner, view, ...extra };
    for (const [k, v] of Object.entries(merged)) {
      if (v && !(k === 'owner' && v === 'all') && !(k === 'view' && v === 'board')) p.set(k, v);
    }
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };
  const me = ctx.membership.id;
  // The deals this view shows, all of them (ADR-239): deals carry customers' names and numbers.
  const exportHref =
    can(ctx, 'contacts.export') && (view !== 'board' || board !== null)
      ? `${base}/export?${new URLSearchParams(
          view === 'board' && board
            ? {
                status: 'open',
                pipeline: board.pipeline.id,
                ...(owner === 'all' ? {} : { owner }),
              }
            : { status: view },
        ).toString()}`
      : null;
  const settings = can(ctx, 'tenant.settings.manage');
  return (
    <>
      <PageHeader
        title="CRM"
        description="Deals by stage, and the tasks that move them forward."
        actions={
          exportHref || settings ? (
            <>
              {exportHref ? (
                <Button asChild variant="outline">
                  <a href={exportHref} download>
                    Export CSV
                  </a>
                </Button>
              ) : null}
              {settings ? (
                <Link
                  href={`/c/${ctx.tenant.slug}/settings/pipelines`}
                  className="self-center text-sm text-primary underline-offset-4 hover:underline"
                >
                  Pipelines
                </Link>
              ) : null}
            </>
          ) : null
        }
      />
      <ModuleNotInPlan ctx={ctx} module="crm" />
      <CrmTabs slug={ctx.tenant.slug} active="deals" />
      <nav aria-label="Deal views" className="mt-4 flex flex-wrap gap-2 text-sm">
        {(['board', 'won', 'lost'] as const).map((v) => (
          <Link
            key={v}
            href={href({ view: v })}
            aria-current={view === v ? 'page' : undefined}
            className={
              view === v
                ? 'rounded-md bg-primary/10 px-3 py-1 font-medium'
                : 'rounded-md px-3 py-1 text-muted-foreground hover:text-foreground'
            }
          >
            {v === 'board' ? 'Open deals' : v === 'won' ? 'Won' : 'Lost'}
          </Link>
        ))}
      </nav>

      <div className="mt-6 grid grid-cols-1 gap-6">
        {view === 'board' ? (
          board === null ? (
            <Card>
              <CardHeader>
                <CardTitle>No pipeline yet</CardTitle>
                <CardDescription>
                  {can(ctx, 'tenant.settings.manage')
                    ? 'Create a pipeline with the stages your deals go through.'
                    : 'An owner or administrator creates pipelines in Settings → Pipelines.'}
                </CardDescription>
              </CardHeader>
              {can(ctx, 'tenant.settings.manage') ? (
                <CardContent>
                  <Link
                    href={`/c/${ctx.tenant.slug}/settings/pipelines`}
                    className="text-sm text-primary underline-offset-4 hover:underline"
                  >
                    Create a pipeline
                  </Link>
                </CardContent>
              ) : null}
            </Card>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                {board.pipelines.length > 1 ? (
                  <nav aria-label="Pipelines" className="flex flex-wrap gap-2">
                    {board.pipelines.map((p) => (
                      <Link
                        key={p.id}
                        href={href({ pipeline: p.id })}
                        aria-current={p.id === board.pipeline.id ? 'page' : undefined}
                        className={
                          p.id === board.pipeline.id
                            ? 'font-medium'
                            : 'text-muted-foreground hover:text-foreground'
                        }
                      >
                        {p.name}
                      </Link>
                    ))}
                  </nav>
                ) : (
                  <span className="font-medium">{board.pipeline.name}</span>
                )}
                <nav aria-label="Owner" className="flex flex-wrap gap-2">
                  {OWNER_FILTERS.map((f) => (
                    <Link
                      key={f.key}
                      href={href({ owner: f.key })}
                      aria-current={owner === f.key ? 'page' : undefined}
                      className={
                        owner === f.key
                          ? 'font-medium'
                          : 'text-muted-foreground hover:text-foreground'
                      }
                    >
                      {f.label}
                    </Link>
                  ))}
                </nav>
                <span className="text-muted-foreground">Values in {board.pipeline.currency}</span>
              </div>
              {board.forecast.hasChances ? (
                // Weighted by each stage's chance of winning (ADR-242). The month's end is a
                // calendar date in the company's time already, so it is shown as written (UTC).
                <p className="text-sm">
                  <span className="font-medium">Weighted pipeline</span>{' '}
                  {formatMinor(board.forecast.weightedMinor, board.pipeline.currency)}
                  <span className="text-muted-foreground">
                    {` · expected to close by ${formatDate(board.forecast.monthEnd, 'UTC')}: `}
                  </span>
                  {formatMinor(board.forecast.weightedMonthMinor, board.pipeline.currency)}
                  {board.forecast.stagesWithoutChance > 0 ? (
                    <span className="text-muted-foreground">
                      {` · ${board.forecast.stagesWithoutChance} ${board.forecast.stagesWithoutChance === 1 ? 'stage' : 'stages'} with deals but no chance of winning left out`}
                    </span>
                  ) : null}
                </p>
              ) : null}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                {board.columns.map((col) => (
                  <section
                    key={col.stage.id}
                    aria-labelledby={`stage-${col.stage.id}`}
                    className="grid min-w-0 content-start gap-3 rounded-lg border border-border bg-muted/30 p-3"
                  >
                    <header className="grid gap-0.5">
                      <h2 id={`stage-${col.stage.id}`} className="text-sm font-semibold">
                        {col.stage.name}
                      </h2>
                      <p className="text-xs text-muted-foreground">
                        {col.count} deal{col.count === 1 ? '' : 's'}
                        {col.valueMinor > 0
                          ? ` · ${formatMinor(col.valueMinor, board.pipeline.currency)}`
                          : ''}
                        {col.deals.length < col.count ? ` · showing ${col.deals.length}` : ''}
                      </p>
                      {col.stage.winPercent !== null ? (
                        <p className="text-xs text-muted-foreground">
                          {col.stage.winPercent}% chance
                          {col.weightedMinor
                            ? ` · weighted ${formatMinor(col.weightedMinor, board.pipeline.currency)}`
                            : ''}
                        </p>
                      ) : null}
                    </header>
                    {col.deals.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No deals.</p>
                    ) : (
                      <ul className="grid gap-2">
                        {col.deals.map((d) => (
                          <li
                            key={d.id}
                            className="grid min-w-0 gap-2 rounded-md border border-border bg-background p-3 text-sm"
                          >
                            <Link
                              href={`${base}/deals/${d.id}`}
                              className="break-words font-medium text-primary underline-offset-4 hover:underline"
                            >
                              {d.title}
                            </Link>
                            <span className="break-words text-xs text-muted-foreground">
                              {contactLabel(d.contact)}
                              {d.valueMinor !== null
                                ? ` · ${formatMinor(d.valueMinor, d.currency)}`
                                : ''}
                              {d.owner ? ` · ${d.owner.name}` : ''}
                              {d.openTasks > 0
                                ? ` · ${d.openTasks} open task${d.openTasks === 1 ? '' : 's'}`
                                : ''}
                            </span>
                            {canWrite ? (
                              <StageSelect
                                slug={ctx.tenant.slug}
                                dealId={d.id}
                                dealTitle={d.title}
                                version={d.version}
                                stageId={d.stageId}
                                stages={board.columns.map((c) => ({
                                  id: c.stage.id,
                                  name: c.stage.name,
                                }))}
                              />
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                ))}
              </div>
            </>
          )
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{view === 'won' ? 'Won deals' : 'Lost deals'}</CardTitle>
              <CardDescription>Most recently changed first, 50 at a time.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {closed && closed.deals.length > 0 ? (
                <ul className="grid gap-3">
                  {closed.deals.map((d) => {
                    const status = DEAL_STATUS[d.status] ?? {
                      label: d.status,
                      tone: 'neutral' as const,
                    };
                    return (
                      <li key={d.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <Link
                          href={`${base}/deals/${d.id}`}
                          className="min-w-0 break-words font-medium text-primary underline-offset-4 hover:underline"
                        >
                          {d.title}
                        </Link>
                        <Badge tone={status.tone}>{status.label}</Badge>
                        <span className="text-muted-foreground">
                          {contactLabel(d.contact)}
                          {d.valueMinor !== null
                            ? ` · ${formatMinor(d.valueMinor, d.currency)}`
                            : ''}
                          {d.closedAt ? ` · ${formatDateTime(d.closedAt, tz)}` : ''}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">None yet.</p>
              )}
              {cursor || closed?.nextCursor ? (
                <nav aria-label="More deals" className="flex flex-wrap gap-4 text-sm">
                  {cursor ? (
                    <Link
                      href={href({ view })}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      Newest
                    </Link>
                  ) : null}
                  {closed?.nextCursor ? (
                    <Link
                      href={href({ view, cursor: closed.nextCursor })}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      Older deals
                    </Link>
                  ) : null}
                </nav>
              ) : null}
            </CardContent>
          </Card>
        )}

        {canWrite && lookups.options.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>New deal</CardTitle>
              <CardDescription>
                Deals belong to a contact. You can also add one from a contact or a conversation.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <NewDealForm
                slug={ctx.tenant.slug}
                pipelines={lookups.options}
                members={lookups.memberOptions}
                defaultOwnerId={
                  lookups.memberOptions.some((m) => m.membershipId === me) ? me : null
                }
              />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
