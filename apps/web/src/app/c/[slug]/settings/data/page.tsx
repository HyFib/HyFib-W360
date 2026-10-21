import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  can,
  DELETION_GRACE_DAYS,
  formatByteSize,
  hasRecentSignIn,
  RECENT_SIGN_IN_MINUTES,
  STORED_EXPORT_FAILURE_LABELS,
  STORED_EXPORT_RETENTION_DAYS,
  STORED_EXPORT_STATUS_LABELS,
} from '@w360/domain';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import {
  CancelDeletionButton,
  RequestDeletionForm,
  RequestStoredExportButton,
} from '@/components/settings/company-data';
import { SignInAgain } from '@/components/sign-in-again';
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
  const { companyDeletion, storedExports, clock } = await getRuntime();
  const deletion = await companyDeletion.status(ctx);
  // Re-checked here: the layout is not re-run on navigation; listing needs tenant.export too.
  const stored = canExport ? await storedExports.list(ctx) : [];
  const storedPending = stored.some((e) => e.status === 'queued' || e.status === 'running');
  // Both need a recent sign-in (ADR-056); cancelling a deletion does not.
  const recent = hasRecentSignIn(ctx, clock.now());
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
              are never included. Owners and administrators are emailed whenever an export starts or
              a stored export is downloaded.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <p>
              The last line of a complete file reads <code>{'{"end":true,…}'}</code>; a file without
              it was cut short and should be downloaded again.
            </p>
            {recent ? (
              <div>
                <a
                  href={`/c/${ctx.tenant.slug}/settings/data/export`}
                  download
                  className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Download the export
                </a>
              </div>
            ) : (
              <SignInAgain
                reason={`Downloading the export needs a sign-in within the last ${RECENT_SIGN_IN_MINUTES} minutes.`}
              />
            )}
            <section aria-labelledby="stored-exports" className="grid gap-3 border-t pt-4">
              <h2 id="stored-exports" className="font-medium">
                Stored exports
              </h2>
              <p className="text-muted-foreground">
                For a large company, HyFib can prepare the same file in the background and keep it,
                encrypted, for {STORED_EXPORT_RETENTION_DAYS} days, so it can be downloaded again
                without waiting. Owners and administrators are emailed when it is asked for, when it
                is ready and whenever it is downloaded; the email links to this page, never to the
                file.
              </p>
              {recent ? (
                <RequestStoredExportButton slug={ctx.tenant.slug} pending={storedPending} />
              ) : null}
              {storedPending ? (
                <p className="text-muted-foreground">
                  A stored export is being prepared. Downloading the export above waits until it is
                  ready.
                </p>
              ) : null}
              {stored.length > 0 ? (
                <ul className="grid gap-2">
                  {stored.map((item) => (
                    <li
                      key={item.id}
                      className="grid gap-1 rounded-md border p-3 break-words"
                      data-testid="stored-export"
                    >
                      <p>
                        <span className="font-medium">
                          {item.replaced
                            ? 'Replaced by a newer export'
                            : STORED_EXPORT_STATUS_LABELS[item.status]}
                        </span>
                        {' · '}asked for {formatDateTime(item.requestedAt, tz)}
                        {item.requestedByName ? ` by ${item.requestedByName}` : ''}
                      </p>
                      {item.status === 'ready' && item.byteSize !== null && item.expiresAt ? (
                        <>
                          <p className="text-muted-foreground">
                            {formatByteSize(item.byteSize)},{' '}
                            {item.replaced ? 'deleted at' : 'kept until'}{' '}
                            {formatDateTime(item.expiresAt, tz)}
                          </p>
                          {item.sha256 ? (
                            <p className="text-muted-foreground">
                              SHA-256 <code className="break-all">{item.sha256}</code>
                            </p>
                          ) : null}
                          {recent && !item.replaced ? (
                            <div>
                              <a
                                href={`/c/${ctx.tenant.slug}/settings/data/exports/${item.id}`}
                                rel="noopener noreferrer"
                                className="inline-flex h-10 items-center rounded-md border border-border bg-background px-4 text-sm font-medium hover:bg-muted"
                              >
                                Download the stored export
                              </a>
                            </div>
                          ) : null}
                        </>
                      ) : null}
                      {item.status === 'failed' && item.failureReason ? (
                        <p className="text-muted-foreground">
                          {STORED_EXPORT_FAILURE_LABELS[item.failureReason]}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          </CardContent>
        </Card>
      ) : null}

      {canDelete ? (
        <Card>
          <CardHeader>
            <CardTitle>Delete the company</CardTitle>
            <CardDescription>
              The company is deleted {DELETION_GRACE_DAYS} days after an owner asks; until then it
              works as if suspended and any owner can cancel. HyFib can also schedule a deletion,
              which only HyFib can cancel.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            {deletion ? (
              deletion.started ? (
                <Alert tone="danger">
                  The deletion started and can no longer be cancelled. The owners and administrators
                  are emailed when it is finished.
                </Alert>
              ) : deletion.requestedBy === 'platform' ? (
                <>
                  <Alert tone="warning">
                    This company will be deleted on {formatDateTime(deletion.dueAt, tz)}, as HyFib
                    scheduled on {formatDateTime(deletion.requestedAt, tz)}. Export its data before
                    then if you need a copy.
                  </Alert>
                  <p className="whitespace-pre-line break-words">
                    <span className="font-medium">HyFib’s reason:</span> {deletion.reason}
                  </p>
                  <p className="text-muted-foreground">
                    Only HyFib can cancel this deletion. Contact HyFib support to discuss it.
                  </p>
                </>
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
                {recent ? (
                  <RequestDeletionForm slug={ctx.tenant.slug} />
                ) : (
                  <SignInAgain
                    reason={`Asking for the deletion needs a sign-in within the last ${RECENT_SIGN_IN_MINUTES} minutes.`}
                  />
                )}
              </>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
