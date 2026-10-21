import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { can } from '@w360/domain';
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { PageHeader } from '@/components/page-header';
import { END_REASONS, RUN_STATUS, TRIGGER_TYPE_LABELS } from '@/lib/automation-labels';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Automation runs' };
export const dynamic = 'force-dynamic';

const STATUS_FILTERS = [
  ['', 'All'],
  ['active', 'In progress'],
  ['completed', 'Completed'],
  ['handed_off', 'Handed off'],
  ['taken_over', 'Taken over'],
  ['stopped', 'Stopped'],
  ['failed', 'Failed'],
] as const;

export default async function AutomationRunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ automation?: string; status?: string; cursor?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'automations.read')) notFound();
  const { automations } = await getRuntime();
  const filters = {
    ...(typeof query.automation === 'string' && query.automation
      ? { automationId: query.automation }
      : {}),
    ...(typeof query.status === 'string' && query.status ? { status: query.status } : {}),
  };
  let page: Awaited<ReturnType<typeof automations.listRuns>>;
  try {
    page = await automations.listRuns(ctx, {
      ...filters,
      ...(typeof query.cursor === 'string' ? { cursor: query.cursor } : {}),
    });
  } catch (error) {
    if (!isAppError(error) || error.code !== 'validation_failed') throw error;
    page = await automations.listRuns(ctx, {});
  }
  const base = `/c/${ctx.tenant.slug}/automations`;
  const tz = ctx.tenant.timezone;
  const link = (params: Record<string, string>) => {
    const search = new URLSearchParams({
      ...(filters.automationId ? { automation: filters.automationId } : {}),
      ...params,
    });
    return `${base}/runs${search.size ? `?${search}` : ''}`;
  };
  const exportSearch = new URLSearchParams({
    ...(filters.automationId ? { automation: filters.automationId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  });
  const exportHref = `${base}/runs/export${exportSearch.size ? `?${exportSearch}` : ''}`;
  return (
    <>
      <PageHeader
        title="Automation runs"
        description="Each run executes one version in one conversation. Runs end when the automation finishes, hands off, or a member takes over."
        actions={
          <>
            <Button asChild size="sm" variant="outline">
              {/* The runs this list shows, as CSV (ADR-237). */}
              <a href={exportHref} download>
                Export CSV
              </a>
            </Button>
            <Link href={base} className="text-sm text-primary underline-offset-4 hover:underline">
              All automations
            </Link>
          </>
        }
      />
      <nav aria-label="Filter runs" className="mb-4 flex flex-wrap gap-2">
        {STATUS_FILTERS.map(([value, label]) => {
          const current = (query.status ?? '') === value;
          return (
            <Button key={value} asChild size="sm" variant={current ? 'primary' : 'outline'}>
              <Link
                href={link(value ? { status: value } : {})}
                aria-current={current ? 'page' : undefined}
              >
                {label}
              </Link>
            </Button>
          );
        })}
      </nav>
      <Card>
        <CardContent className="p-0">
          {page.runs.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="No runs"
                description="Runs appear when customers start a published automation, or when a member starts a test."
              />
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Started</TH>
                  <TH>Automation</TH>
                  <TH>Status</TH>
                  <TH>Started by</TH>
                  <TH>Steps</TH>
                  <TH>Conversation</TH>
                </TR>
              </THead>
              <TBody>
                {page.runs.map((r) => {
                  const status = RUN_STATUS[r.status] ?? {
                    label: r.status,
                    tone: 'neutral' as const,
                  };
                  return (
                    <TR key={r.id}>
                      <TD className="text-sm">
                        <Link
                          href={`${base}/runs/${r.id}`}
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          {formatDateTime(r.startedAt, tz)}
                        </Link>
                      </TD>
                      <TD className="text-sm">
                        {r.automationName}
                        <span className="block text-xs text-muted-foreground">
                          {r.mode === 'test'
                            ? 'Test of the draft'
                            : `Version ${r.versionNumber ?? '—'}`}
                        </span>
                      </TD>
                      <TD>
                        <Badge tone={status.tone}>{status.label}</Badge>
                        {r.endReason ? (
                          <span className="block text-xs text-muted-foreground">
                            {END_REASONS[r.endReason] ?? r.endReason}
                          </span>
                        ) : null}
                      </TD>
                      <TD className="text-sm">
                        {r.enrollmentId
                          ? 'Enrolment'
                          : (TRIGGER_TYPE_LABELS[r.triggerType] ?? r.triggerType)}
                      </TD>
                      <TD className="text-sm">
                        {r.steps}
                        <span className="block text-xs text-muted-foreground">
                          {r.messages} message{r.messages === 1 ? '' : 's'}
                        </span>
                      </TD>
                      <TD className="text-sm">
                        {r.conversationId ? (
                          <Link
                            href={`/c/${ctx.tenant.slug}/inbox/${r.conversationId}`}
                            className="text-primary underline-offset-4 hover:underline"
                          >
                            Open
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {page.nextCursor ? (
        <div className="mt-4">
          <Button asChild variant="outline">
            <Link
              href={link({
                ...(query.status ? { status: query.status } : {}),
                cursor: page.nextCursor,
              })}
            >
              Older runs
            </Link>
          </Button>
        </div>
      ) : null}
    </>
  );
}
