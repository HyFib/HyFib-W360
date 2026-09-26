import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { ImportWizard } from '@/components/contacts/import-wizard';
import { PageHeader } from '@/components/page-header';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Import contacts' };
export const dynamic = 'force-dynamic';

export default async function ImportContactsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'contacts.import')) notFound();
  const { contacts } = await getRuntime();
  const imports = await contacts.listImports(ctx);
  const tz = ctx.tenant.timezone;
  return (
    <>
      <Link
        href={`/c/${ctx.tenant.slug}/contacts`}
        className="mb-2 inline-block text-sm text-primary underline-offset-4 hover:underline"
      >
        ← Contacts
      </Link>
      <PageHeader
        title="Import contacts"
        description="Rows are matched to existing contacts by phone number. Rows with errors are skipped and listed by row number."
      />
      <div className="grid gap-6">
        <ImportWizard slug={ctx.tenant.slug} />
        {imports.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Recent imports</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <THead>
                  <TR>
                    <TH>When</TH>
                    <TH>File</TH>
                    <TH>Created</TH>
                    <TH>Updated</TH>
                    <TH>Unchanged</TH>
                    <TH>Errors</TH>
                    <TH>Consent</TH>
                  </TR>
                </THead>
                <TBody>
                  {imports.map((i) => (
                    <TR key={i.id}>
                      <TD className="whitespace-nowrap text-sm">
                        {formatDateTime(i.createdAt.toISOString(), tz)}
                      </TD>
                      <TD className="text-sm">{i.fileName}</TD>
                      <TD className="tabular-nums">{i.createdCount}</TD>
                      <TD className="tabular-nums">{i.updatedCount}</TD>
                      <TD className="tabular-nums">{i.skippedCount}</TD>
                      <TD className="tabular-nums">{i.errorCount}</TD>
                      <TD className="tabular-nums">{i.consentRecordedCount}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
