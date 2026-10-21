import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import {
  ENROLLED_OUTCOME_LABELS,
  ENROLLMENT_END_REASON_LABELS,
  can,
  enrolledContactLabel,
  enrolledContactsCursorSchema,
} from '@w360/domain';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { StopEnrollmentButton } from '@/components/automations/enrollment-actions';
import { AutoRefresh } from '@/components/campaigns/campaign-actions';
import { PageHeader } from '@/components/page-header';
import { ENROLLMENT_STATUS } from '@/lib/automation-labels';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Enrolment' };
export const dynamic = 'force-dynamic';

/** The contacts list's filters by outcome (ADR-408), in the words of the counts above it. */
const OUTCOME_FILTERS: readonly (readonly [string, string])[] = [
  ['all', 'All'],
  ...(['started', 'refused', 'cancelled', 'pending'] as const).map(
    (o) => [o, ENROLLED_OUTCOME_LABELS[o]] as const,
  ),
];

/**
 * One enrolment of contacts in an automation (ADR-401), a member's or an API key's (ADR-403): its progress, how many started and were
 * refused (by reason) or not started, who started or stopped it, and Stop while it runs; to members
 * who also read contacts, its contacts in position order with their outcomes, 50 per page, by
 * outcome (ADR-408). The page re-checks the member's permissions itself and re-renders every 15
 * seconds while it runs.
 */
export default async function EnrollmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; automationId: string; enrollmentId: string }>;
  searchParams: Promise<{ outcome?: string; cursor?: string }>;
}) {
  const { slug, automationId, enrollmentId } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'automations.read')) notFound();
  const { automationEnrollments } = await getRuntime();
  let enrollment: Awaited<ReturnType<typeof automationEnrollments.getEnrollment>>;
  try {
    enrollment = await automationEnrollments.getEnrollment(ctx, enrollmentId);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  if (enrollment.automationId !== automationId) notFound();
  // The contacts one by one (ADR-408) only to members who may also read contacts.
  const outcome = OUTCOME_FILTERS.some(([v]) => v === sp.outcome) ? (sp.outcome as string) : 'all';
  // A cursor the service would refuse starts from the first page instead.
  const cursor = enrolledContactsCursorSchema.safeParse(sp.cursor).success ? sp.cursor : null;
  let enrolled: Awaited<ReturnType<typeof automationEnrollments.listEnrolledContacts>> | null =
    null;
  if (can(ctx, 'contacts.read')) {
    try {
      enrolled = await automationEnrollments.listEnrolledContacts(
        ctx,
        automationId,
        enrollment.id,
        {
          ...(outcome === 'all' ? {} : { outcome }),
          ...(cursor ? { cursor } : {}),
        },
      );
    } catch (error) {
      // The service checks the permissions again: a refusal shows the counts without the list.
      if (!isAppError(error) || error.code !== 'forbidden') throw error;
    }
  }
  const tz = ctx.tenant.timezone;
  const status = ENROLLMENT_STATUS[enrollment.status] ?? {
    label: enrollment.status,
    tone: 'neutral' as const,
  };
  const running = enrollment.status === 'running';
  const base = `/c/${ctx.tenant.slug}/automations/${automationId}`;
  const pageUrl = `${base}/enrollments/${enrollment.id}`;
  const n = (v: number) => v.toLocaleString('en-IN');
  return (
    <>
      <AutoRefresh active={running} />
      <PageHeader
        title={`Enrolment in ${enrollment.automationName}`}
        description={`${
          enrollment.source === 'segment'
            ? `Members of the segment “${enrollment.segmentName ?? 'a segment'}”`
            : enrollment.startedBy === 'api'
              ? 'Contacts chosen by a tag and marketing consent'
              : 'Contacts chosen on the Contacts page'
        }, started ${formatDateTime(enrollment.createdAt.toISOString(), tz)} ${
          enrollment.startedBy === 'api'
            ? `through the API with key “${enrollment.createdByKeyName ?? 'a key'}”`
            : `by ${enrollment.createdByName ?? 'a member'}`
        }.`}
        actions={
          <Link href={base} className="text-sm text-primary underline-offset-4 hover:underline">
            Open the automation
          </Link>
        }
      />
      <div className="grid max-w-3xl gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Progress <Badge tone={status.tone}>{status.label}</Badge>
            </CardTitle>
            <CardDescription>
              {running
                ? 'Runs start in the background, at most 50 at a time. This page updates itself.'
                : enrollment.endReason
                  ? `${
                      // The raw code when a label is missing (a release that rolled back, ADR-403).
                      ENROLLMENT_END_REASON_LABELS[enrollment.endReason] ?? enrollment.endReason
                    }${
                      enrollment.stoppedByName
                        ? ` (${enrollment.stoppedByName})`
                        : enrollment.stoppedByKeyName
                          ? ` (key “${enrollment.stoppedByKeyName}”)`
                          : ''
                    } Ended ${formatDateTime(enrollment.endedAt?.toISOString() ?? null, tz)}.`
                  : `Every contact was handled. Ended ${formatDateTime(
                      enrollment.endedAt?.toISOString() ?? null,
                      tz,
                    )}.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {enrollment.stalledSince ? (
              <Alert tone="warning">
                No progress since {formatDateTime(enrollment.stalledSince.toISOString(), tz)}. HyFib
                tries the next batch again, every 10 minutes; after three tries without progress the
                enrolment ends as failed. You can stop it meanwhile.
              </Alert>
            ) : null}
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
              {[
                ['Contacts', enrollment.total],
                ['Started', enrollment.started],
                ['Refused', enrollment.refused],
                ['Not started', enrollment.cancelled],
                ['Waiting', enrollment.pending],
              ].map(([label, value]) => (
                <div key={label} className="grid">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{n(Number(value))}</dd>
                </div>
              ))}
            </dl>
            {running && can(ctx, 'automations.publish') ? (
              <StopEnrollmentButton slug={ctx.tenant.slug} enrollmentId={enrollment.id} />
            ) : null}
            <p className="text-xs text-muted-foreground">
              Stopping leaves runs already started going; stop one from its page. Runs started by
              this enrolment are listed with the automation’s runs.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Refused</CardTitle>
            <CardDescription>
              Contacts the automation was not started for, by reason. The others went on.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {enrollment.refusals.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">None.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Reason</TH>
                    <TH className="text-right">Contacts</TH>
                  </TR>
                </THead>
                <TBody>
                  {enrollment.refusals.map((r) => (
                    <TR key={r.reason}>
                      <TD>{r.label}</TD>
                      <TD className="text-right tabular-nums">{n(r.count)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
        {enrolled ? (
          <Card>
            <CardHeader>
              <CardTitle>Contacts</CardTitle>
              <CardDescription>
                Each contact enrolled, in order, with what happened to it and when.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 p-0">
              <nav aria-label="Filter contacts by outcome" className="flex flex-wrap gap-2 px-4">
                {OUTCOME_FILTERS.map(([value, label]) => (
                  <Button
                    key={value}
                    asChild
                    size="sm"
                    variant={value === outcome ? 'primary' : 'outline'}
                  >
                    <Link
                      href={`${pageUrl}?outcome=${value}`}
                      aria-current={value === outcome ? 'page' : undefined}
                    >
                      {label}
                    </Link>
                  </Button>
                ))}
              </nav>
              {enrolled.items.length === 0 ? (
                <p className="px-4 pb-4 text-sm text-muted-foreground">
                  No contact with this outcome.
                </p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH className="text-right">#</TH>
                      <TH>Contact</TH>
                      <TH>Outcome</TH>
                      <TH>Handled</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {enrolled.items.map((c) => (
                      <TR key={c.position}>
                        <TD className="text-right tabular-nums text-muted-foreground">
                          {n(c.position)}
                        </TD>
                        <TD>
                          {c.contactId ? (
                            <Link
                              href={`/c/${ctx.tenant.slug}/contacts/${c.contactId}`}
                              className="text-primary underline-offset-4 hover:underline"
                            >
                              {enrolledContactLabel(c)}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">{enrolledContactLabel(c)}</span>
                          )}
                        </TD>
                        <TD className="text-sm">
                          {c.outcome === 'refused'
                            ? `Refused: ${c.reasonLabel ?? 'no reason recorded'}`
                            : ENROLLED_OUTCOME_LABELS[c.outcome]}
                          {c.runId ? (
                            <Link
                              href={`/c/${ctx.tenant.slug}/automations/runs/${c.runId}`}
                              className="ml-2 text-primary underline-offset-4 hover:underline"
                            >
                              Open the run
                            </Link>
                          ) : null}
                        </TD>
                        <TD className="text-sm text-muted-foreground">
                          {c.processedAt ? formatDateTime(c.processedAt.toISOString(), tz) : '—'}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
              {enrolled.nextCursor ? (
                <div className="px-4 pb-4">
                  <Button asChild variant="outline">
                    <Link href={`${pageUrl}?outcome=${outcome}&cursor=${enrolled.nextCursor}`}>
                      Next page
                    </Link>
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
        <Link
          href={`/c/${ctx.tenant.slug}/automations/runs?automation=${automationId}`}
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          Runs of this automation
        </Link>
      </div>
    </>
  );
}
