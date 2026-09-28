import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can, DELETION_GRACE_DAYS } from '@w360/domain';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { CancelDeletionButton, RequestDeletionForm } from '@/components/settings/company-data';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Company data' };
export const dynamic = 'force-dynamic';

export default async function CompanyDataPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  const canExport = can(ctx, 'tenant.export');
  const canDelete = can(ctx, 'tenant.delete');
  if (!canExport && !canDelete) notFound();
  const { companyDeletion } = await getRuntime();
  const deletion = await companyDeletion.status(ctx);
  const tz = ctx.tenant.timezone;
  return (
    <div className="grid grid-cols-1 gap-6">
      {canExport ? (
        <Card>
          <CardHeader>
            <CardTitle>Export the company&apos;s data</CardTitle>
            <CardDescription>
              A full copy as one gzip-compressed JSON Lines file: members, settings, contacts and
              consent history, conversations and messages, templates, campaigns, automations, CRM,
              growth, Flows, commerce, stores, billing and the audit log. Credentials and secrets
              are never included. Owners and administrators are emailed whenever an export starts.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <p>
              The last line of a complete file reads <code>{'{"end":true,…}'}</code>; a file without
              it was cut short and should be downloaded again.
            </p>
            <div>
              <a
                href={`/c/${ctx.tenant.slug}/settings/data/export`}
                download
                className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Download the export
              </a>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {canDelete ? (
        <Card>
          <CardHeader>
            <CardTitle>Delete the company</CardTitle>
            <CardDescription>
              The company is deleted {DELETION_GRACE_DAYS} days after an owner asks; until then it
              works as if suspended and any owner can cancel.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            {deletion ? (
              deletion.started ? (
                <Alert tone="danger">
                  The deletion started and can no longer be cancelled. The owners and administrators
                  are emailed when it is finished.
                </Alert>
              ) : (
                <>
                  <Alert tone="warning">
                    This company will be deleted on {formatDateTime(deletion.dueAt, tz)}
                    {deletion.requestedByName
                      ? `, as ${deletion.requestedByName} asked on ${formatDateTime(deletion.requestedAt, tz)}`
                      : ''}
                    . Export its data before then if you need a copy.
                  </Alert>
                  <CancelDeletionButton slug={ctx.tenant.slug} />
                </>
              )
            ) : (
              <>
                <ul className="grid list-disc gap-1 pl-5">
                  <li>
                    Deleted: members&apos; access, contacts and consent history, conversations and
                    messages, templates, campaigns, automations, CRM, growth links, Flows, commerce
                    and store data, API keys, webhooks and the audit log.
                  </li>
                  <li>
                    Kept, as the law requires: billing records (wallet, top-ups, card mandates with
                    only the card&apos;s brand and last four digits) and the plan history.
                  </li>
                  <li>
                    HyFib stops receiving the WhatsApp accounts&apos; messages and removes itself
                    from connected Shopify stores; the numbers stay in your WhatsApp Business
                    Account. WooCommerce keys must be revoked in the store.
                  </li>
                  <li>
                    Copies in encrypted backups disappear when those backups expire. People&apos;s
                    own HyFib accounts are not deleted.
                  </li>
                </ul>
                <RequestDeletionForm slug={ctx.tenant.slug} />
              </>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
