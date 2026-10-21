import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { ENROLLMENT_LIMITS, can, type EnrollmentAudience } from '@w360/domain';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Label,
  Select,
} from '@w360/ui';
import { EnrollmentForm } from '@/components/automations/enrollment-actions';
import { PageHeader } from '@/components/page-header';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Enrol contacts' };
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

const CONSENT_LABELS: Record<string, string> = {
  marketing_opted_in: 'marketing opted in',
  marketing_opted_out: 'marketing opted out',
  marketing_unknown: 'marketing consent not recorded',
};

/**
 * Enrolling contacts in an automation started by a member or through the API (ADR-401): choose the
 * automation and whom (the contacts the contacts page's filters match, or a saved segment), see how
 * many, give the inputs once and confirm. The page re-checks the member's permissions itself; the
 * domain service checks them again with everything else.
 */
export default async function EnrollPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'automations.publish') || !can(ctx, 'contacts.read')) notFound();
  const { automationEnrollments, segments } = await getRuntime();
  const automations = await automationEnrollments.enrollableAutomations(ctx);
  const segmentList = can(ctx, 'campaigns.read') ? await segments.listSegments(ctx) : [];
  const automationId = one(sp.automation) ?? '';
  const source = one(sp.source) === 'segment' ? 'segment' : 'contacts';
  const segmentId = one(sp.segment) ?? '';
  const consent = one(sp.consent) ?? 'any';
  const filter = {
    q: one(sp.q)?.slice(0, 100) || undefined,
    tag: one(sp.tag)?.slice(0, 40) || undefined,
    consent: CONSENT_LABELS[consent] ? consent : 'any',
  };
  const audience: EnrollmentAudience | null =
    source === 'segment'
      ? segmentId
        ? { kind: 'segment', segmentId }
        : null
      : {
          kind: 'contacts',
          filter: filter as Extract<EnrollmentAudience, { kind: 'contacts' }>['filter'],
        };
  let preview: Awaited<ReturnType<typeof automationEnrollments.previewEnrollment>> | null = null;
  let problem: string | null = null;
  if (automationId && audience) {
    try {
      preview = await automationEnrollments.previewEnrollment(ctx, { automationId, audience });
    } catch (error) {
      if (!isAppError(error)) throw error;
      problem = error.publicMessage;
    }
  }
  const described = [
    filter.q ? `search “${filter.q}”` : null,
    filter.tag ? `tag “${filter.tag}”` : null,
    filter.consent && filter.consent !== 'any' ? CONSENT_LABELS[filter.consent] : null,
  ].filter((x): x is string => x !== null);
  const base = `/c/${ctx.tenant.slug}`;
  const limit = ENROLLMENT_LIMITS.contacts;

  return (
    <>
      <PageHeader
        title="Enrol contacts in an automation"
        description="Start an automation for contacts you choose, without waiting for them to write. Runs start in the background, a batch at a time."
        actions={
          <Link
            href={`${base}/automations`}
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            All automations
          </Link>
        }
      />
      {automations.length === 0 ? (
        <EmptyState
          title="No automation can be started by a member"
          description="Publish an automation whose trigger is “A member’s enrolment, or a call from your systems through the HyFib W360 API”, limited to one WhatsApp number, and keep it active."
        />
      ) : (
        <div className="grid max-w-3xl gap-6">
          <form method="get" className="grid gap-4" aria-label="Choose the automation and whom">
            <div className="grid gap-1">
              <Label htmlFor="automation">Automation</Label>
              <Select id="automation" name="automation" defaultValue={automationId}>
                <option value="">Choose an automation</option>
                {automations.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.phoneNumber ? ` (${a.phoneNumber})` : ''}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="source">Whom</Label>
              <Select id="source" name="source" defaultValue={source}>
                <option value="contacts">
                  {described.length > 0
                    ? `Contacts matching ${described.join(', ')}`
                    : 'All contacts (filter them on the Contacts page first)'}
                </option>
                {segmentList.length > 0 ? <option value="segment">A saved segment</option> : null}
              </Select>
            </div>
            {segmentList.length > 0 ? (
              <div className="grid gap-1">
                <Label htmlFor="segment">Segment (when enrolling a segment)</Label>
                <Select id="segment" name="segment" defaultValue={segmentId}>
                  <option value="">Choose a segment</option>
                  {segmentList.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
            {filter.q ? <input type="hidden" name="q" value={filter.q} /> : null}
            {filter.tag ? <input type="hidden" name="tag" value={filter.tag} /> : null}
            {filter.consent !== 'any' ? (
              <input type="hidden" name="consent" value={filter.consent} />
            ) : null}
            <div>
              <Button type="submit" variant="outline">
                Count contacts
              </Button>
            </div>
          </form>
          {problem ? <Alert tone="warning">{problem}</Alert> : null}
          {preview && audience ? (
            <Card>
              <CardHeader>
                <CardTitle>
                  {preview.count > limit
                    ? `More than ${limit.toLocaleString('en-IN')} contacts`
                    : `${preview.count.toLocaleString('en-IN')} ${preview.count === 1 ? 'contact' : 'contacts'}`}
                </CardTitle>
                <CardDescription>
                  {preview.segmentName
                    ? `Members of the segment “${preview.segmentName}” now`
                    : 'Contacts these filters match now'}
                  , enrolled in “{preview.automation.name}”. Each is started as a run through the
                  API would be: contacts who are erased, suppressed or opted out, whose conversation
                  a member or another automation holds, or who reached the hourly limit, are refused
                  with the reason, and every run counts against the plan’s monthly runs.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {preview.count === 0 ? (
                  <p className="text-sm text-muted-foreground">Nobody to enrol.</p>
                ) : preview.count > limit ? (
                  <p className="text-sm text-muted-foreground">
                    At most {limit.toLocaleString('en-IN')} contacts are enrolled at once. Narrow
                    the filters or the segment, or send a campaign.
                  </p>
                ) : (
                  <EnrollmentForm
                    slug={ctx.tenant.slug}
                    automationId={preview.automation.id}
                    audience={audience}
                    count={preview.count}
                    inputs={preview.automation.inputs}
                  />
                )}
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}
    </>
  );
}
