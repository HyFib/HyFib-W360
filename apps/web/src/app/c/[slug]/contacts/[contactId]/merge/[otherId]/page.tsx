import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import {
  can,
  mergeRefusalMessage,
  type ConsentOutcome,
  type MergeCounts,
  type MergeSide,
} from '@w360/domain';
import {
  Alert,
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
import { ConsentBadge } from '@/components/contacts/consent-badge';
import { MergeContacts } from '@/components/contacts/merge-contacts';
import { PageHeader } from '@/components/page-header';
import { formatDate } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Review merge' };
export const dynamic = 'force-dynamic';

const SOURCE_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  manual: 'Added by a member',
  import: 'CSV import',
  api: 'API',
  store: 'Store',
};

const COUNT_LABELS: [keyof MergeCounts, string][] = [
  ['consentEvents', 'Consent history entries'],
  ['deals', 'Deals'],
  ['tasks', 'Tasks'],
  ['notes', 'CRM timeline entries'],
  ['orders', 'Orders'],
  ['storeMessages', 'Store messages'],
  ['campaignSends', 'Campaign rows'],
  ['automationRuns', 'Automation runs'],
  ['flowAnswers', 'Form answers'],
];

const nameOf = (side: MergeSide) => side.displayName ?? side.phoneE164 ?? 'Unnamed contact';

function identityText(i: MergeSide['identities'][number]) {
  return `${i.whatsappAccountName ?? 'WhatsApp account'}: ${i.waId ? `+${i.waId}` : 'user id only'}${
    i.profileName ? ` · “${i.profileName}”` : ''
  }`;
}

function consentNote(purpose: 'marketing' | 'utility', outcome: ConsentOutcome): string | null {
  const noun = purpose === 'marketing' ? 'marketing' : 'utility';
  if (outcome.carriedOptOut) {
    return `The other contact opted out of ${noun} messages, so the merged contact is opted out too.`;
  }
  if (outcome.optInNotCarried) {
    return `The other contact opted in to ${noun} messages and this one has no record. A merge does not carry an opt-in over: record it again on the contact if the customer agreed.`;
  }
  return null;
}

function SideCell({ children }: { children: ReactNode }) {
  return <TD className="align-top text-sm">{children}</TD>;
}

/** What merging one contact into another moves and keeps, before it is done (ADR-224). */
export default async function MergeReviewPage({
  params,
}: {
  params: Promise<{ slug: string; contactId: string; otherId: string }>;
}) {
  const { slug, contactId, otherId } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'contacts.write') || !can(ctx, 'contacts.delete')) notFound();
  const { contactMerges, contacts } = await getRuntime();
  let preview: Awaited<ReturnType<typeof contactMerges.previewMerge>>;
  try {
    preview = await contactMerges.previewMerge(ctx, contactId, otherId);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const { keep, merge, plan } = preview;
  const fields = await contacts.listFields(ctx);
  const labelOf = (key: string) => fields.find((f) => f.key === key)?.label ?? key;
  const base = `/c/${ctx.tenant.slug}/contacts`;
  const tz = ctx.tenant.timezone;
  const fieldKeys = [
    ...new Set([...Object.keys(keep.attributes), ...Object.keys(merge.attributes)]),
  ]
    .filter((key) => fields.some((f) => f.key === key))
    .sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
  const valueText = (value: unknown) =>
    value === undefined ? '—' : value === true ? 'yes' : value === false ? 'no' : String(value);

  return (
    <>
      <Link
        href={`${base}/${keep.id}/merge`}
        className="mb-2 inline-block text-sm text-primary underline-offset-4 hover:underline"
      >
        ← Find another contact
      </Link>
      <PageHeader
        title="Review merge"
        description={`${nameOf(merge)} merges into ${nameOf(keep)}: its WhatsApp identities, conversations, consent history, tags, field values, CRM records, orders and campaign rows move, then it is deleted.`}
      />
      <div className="grid gap-6">
        {plan.refusals.length > 0 ? (
          <Alert tone="warning" title="These contacts cannot be merged">
            <ul className="list-disc pl-5">
              {plan.refusals.map((r, i) => (
                <li key={i}>{mergeRefusalMessage(r)}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>The two contacts</CardTitle>
            <CardDescription>
              <Link
                href={`${base}/${merge.id}/merge/${keep.id}`}
                className="text-primary underline-offset-4 hover:underline"
              >
                Keep {nameOf(merge)} instead
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <THead>
                <TR>
                  <TH>
                    <span className="sr-only">Detail</span>
                  </TH>
                  <TH>Kept: {nameOf(keep)}</TH>
                  <TH>Merged and deleted: {nameOf(merge)}</TH>
                </TR>
              </THead>
              <TBody>
                <TR>
                  <TH scope="row">Name</TH>
                  <SideCell>{keep.displayName ?? '—'}</SideCell>
                  <SideCell>{merge.displayName ?? '—'}</SideCell>
                </TR>
                <TR>
                  <TH scope="row">Phone</TH>
                  <SideCell>{keep.phoneE164 ?? '—'}</SideCell>
                  <SideCell>{merge.phoneE164 ?? '—'}</SideCell>
                </TR>
                <TR>
                  <TH scope="row">Email</TH>
                  <SideCell>{keep.email ?? '—'}</SideCell>
                  <SideCell>{merge.email ?? '—'}</SideCell>
                </TR>
                <TR>
                  <TH scope="row">Added</TH>
                  <SideCell>
                    {formatDate(keep.createdAt, tz)} · {SOURCE_LABEL[keep.source] ?? keep.source}
                  </SideCell>
                  <SideCell>
                    {formatDate(merge.createdAt, tz)} · {SOURCE_LABEL[merge.source] ?? merge.source}
                  </SideCell>
                </TR>
                <TR>
                  <TH scope="row">WhatsApp</TH>
                  <SideCell>
                    {keep.identities.length === 0
                      ? 'None'
                      : keep.identities.map((i, n) => <div key={n}>{identityText(i)}</div>)}
                  </SideCell>
                  <SideCell>
                    {merge.identities.length === 0
                      ? 'None'
                      : merge.identities.map((i, n) => <div key={n}>{identityText(i)}</div>)}
                  </SideCell>
                </TR>
                <TR>
                  <TH scope="row">Conversations</TH>
                  <SideCell>
                    {keep.conversations.length === 0
                      ? 'None'
                      : keep.conversations.map((c) => (
                          <div key={c.channelAccountId}>Via {c.channelName ?? 'WhatsApp'}</div>
                        ))}
                  </SideCell>
                  <SideCell>
                    {merge.conversations.length === 0
                      ? 'None'
                      : merge.conversations.map((c) => (
                          <div key={c.channelAccountId}>Via {c.channelName ?? 'WhatsApp'}</div>
                        ))}
                  </SideCell>
                </TR>
                <TR>
                  <TH scope="row">Consent</TH>
                  <SideCell>
                    <span className="flex flex-wrap gap-1">
                      <ConsentBadge purpose="marketing" status={keep.consent.marketing} />
                      <ConsentBadge purpose="utility" status={keep.consent.utility} />
                    </span>
                  </SideCell>
                  <SideCell>
                    <span className="flex flex-wrap gap-1">
                      <ConsentBadge purpose="marketing" status={merge.consent.marketing} />
                      <ConsentBadge purpose="utility" status={merge.consent.utility} />
                    </span>
                  </SideCell>
                </TR>
                <TR>
                  <TH scope="row">Tags</TH>
                  <SideCell>{keep.tags.length === 0 ? 'None' : keep.tags.join(', ')}</SideCell>
                  <SideCell>{merge.tags.length === 0 ? 'None' : merge.tags.join(', ')}</SideCell>
                </TR>
                {fieldKeys.map((key) => (
                  <TR key={key}>
                    <TH scope="row">{labelOf(key)}</TH>
                    <SideCell>{valueText(keep.attributes[key])}</SideCell>
                    <SideCell>{valueText(merge.attributes[key])}</SideCell>
                  </TR>
                ))}
                {COUNT_LABELS.map(([key, label]) => (
                  <TR key={key}>
                    <TH scope="row">{label}</TH>
                    <SideCell>{keep.counts[key]}</SideCell>
                    <SideCell>{merge.counts[key]}</SideCell>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>After the merge</CardTitle>
            <CardDescription>
              The kept contact keeps its own details and takes the other’s where it has none.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2">
              <dt className="text-muted-foreground">Name</dt>
              <dd>{plan.displayName ?? '—'}</dd>
              <dt className="text-muted-foreground">Phone</dt>
              <dd>{plan.phoneE164 ?? '—'}</dd>
              <dt className="text-muted-foreground">Email</dt>
              <dd>{plan.email ?? '—'}</dd>
              <dt className="text-muted-foreground">Tags</dt>
              <dd>{plan.tags.length === 0 ? 'None' : plan.tags.join(', ')}</dd>
              <dt className="text-muted-foreground">Consent</dt>
              <dd className="flex flex-wrap gap-1">
                <ConsentBadge purpose="marketing" status={plan.consent.marketing.result} />
                <ConsentBadge purpose="utility" status={plan.consent.utility.result} />
              </dd>
            </dl>
            {(['marketing', 'utility'] as const).map((purpose) => {
              const note = consentNote(purpose, plan.consent[purpose]);
              return note ? <p key={purpose}>{note}</p> : null;
            })}
            {plan.droppedName || plan.droppedEmail || plan.droppedAttributes.length > 0 ? (
              <p className="text-muted-foreground">
                Not kept, because the kept contact has its own:{' '}
                {[
                  ...(plan.droppedName ? [`the name “${plan.droppedName}”`] : []),
                  ...(plan.droppedEmail ? [`the email ${plan.droppedEmail}`] : []),
                  ...plan.droppedAttributes
                    .filter((key) => fields.some((f) => f.key === key))
                    .map((key) => `${labelOf(key)} “${valueText(merge.attributes[key])}”`),
                ].join(', ')}
                .
              </p>
            ) : null}
          </CardContent>
        </Card>
        {plan.refusals.length === 0 ? (
          <MergeContacts
            slug={ctx.tenant.slug}
            keepContactId={keep.id}
            mergeContactId={merge.id}
            mergeName={nameOf(merge)}
          />
        ) : null}
      </div>
    </>
  );
}
