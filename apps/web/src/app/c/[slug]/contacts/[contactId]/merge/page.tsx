import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { can } from '@w360/domain';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { PageHeader } from '@/components/page-header';
import { formatShort } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Merge a duplicate' };
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

const SOURCE_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  manual: 'Added by a member',
  import: 'CSV import',
  api: 'API',
  store: 'Store',
};

/** Finding the other record of the same person, to merge it into this contact (ADR-224). */
export default async function MergeSearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; contactId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { slug, contactId } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'contacts.write') || !can(ctx, 'contacts.delete')) notFound();
  const { contacts } = await getRuntime();
  let detail: Awaited<ReturnType<typeof contacts.getContact>>;
  try {
    detail = await contacts.getContact(ctx, contactId);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const { contact } = detail;
  if (contact.erasedAt) notFound();
  const q = one(sp.q)?.trim().slice(0, 100) || undefined;
  const found = q ? await contacts.listContacts(ctx, { q, limit: 11 }) : null;
  const matches = (found?.items ?? []).filter((c) => c.id !== contact.id).slice(0, 10);
  const base = `/c/${ctx.tenant.slug}/contacts`;
  const title = contact.displayName ?? contact.phoneE164 ?? 'Unnamed contact';
  const tz = ctx.tenant.timezone;

  return (
    <>
      <Link
        href={`${base}/${contact.id}`}
        className="mb-2 inline-block text-sm text-primary underline-offset-4 hover:underline"
      >
        ← {title}
      </Link>
      <PageHeader
        title="Merge a duplicate"
        description={`Find the other record of the same person to merge into ${title}. You review what moves before anything changes.`}
      />
      {/* One column at most as wide as the page: the results table scrolls inside its card. */}
      <div className="grid grid-cols-1 gap-4">
        <form
          method="get"
          className="flex flex-wrap items-end gap-3"
          role="search"
          aria-label="Find the duplicate"
        >
          <div className="grid gap-1">
            <Label htmlFor="q">Search</Label>
            <Input
              id="q"
              name="q"
              defaultValue={q ?? ''}
              placeholder="Name, email or number"
              className="w-64"
            />
          </div>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        {!q ? (
          <p className="text-sm text-muted-foreground">Search by name, email or phone number.</p>
        ) : matches.length === 0 ? (
          <EmptyState
            title="No other contact matches"
            description="Try part of the name, the email address or the number's last digits."
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Contacts found</CardTitle>
              <CardDescription>
                Up to 10 matches, newest first. Erased contacts are not listed.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Phone</TH>
                    <TH>Email</TH>
                    <TH>Source</TH>
                    <TH>Added</TH>
                    <TH>
                      <span className="sr-only">Review</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {matches.map((c) => (
                    <TR key={c.id}>
                      <TD className="font-medium">{c.displayName ?? 'Unnamed contact'}</TD>
                      <TD className="tabular-nums">{c.phoneE164 ?? '—'}</TD>
                      <TD>{c.email ?? '—'}</TD>
                      <TD>{SOURCE_LABEL[c.source] ?? c.source}</TD>
                      <TD className="whitespace-nowrap">
                        {formatShort(c.createdAt.toISOString(), tz)}
                      </TD>
                      <TD>
                        <Link
                          href={`${base}/${contact.id}/merge/${c.id}`}
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          Review merge
                        </Link>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
