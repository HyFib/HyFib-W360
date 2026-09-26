import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { can } from '@w360/domain';
import {
  Alert,
  Badge,
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
import { ConsentForm } from '@/components/contacts/consent-form';
import { ContactForm } from '@/components/contacts/contact-form';
import { EraseContact } from '@/components/contacts/erase-contact';
import { TagEditor } from '@/components/contacts/tag-editor';
import { PageHeader } from '@/components/page-header';
import { TemplateSender } from '@/components/templates/template-sender';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';
import { sendableTemplates } from '@/server/templates';

export const metadata: Metadata = { title: 'Contact' };
export const dynamic = 'force-dynamic';

const SOURCE_LABEL: Record<string, string> = {
  keyword: 'Keyword message',
  agent: 'Recorded by a member',
  import: 'CSV import',
  provider: 'Reported by WhatsApp',
  api: 'API',
  erasure: 'Contact erased',
};

const SUPPRESSION_REASON: Record<string, string> = {
  manual: 'added manually',
  complaint: 'after a complaint',
  legal: 'for a legal reason',
  erased: 'when a contact was erased',
};

function attributeText(value: unknown): string {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return value === undefined || value === null ? '' : String(value);
}

export default async function ContactPage({
  params,
}: {
  params: Promise<{ slug: string; contactId: string }>;
}) {
  const { slug, contactId } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'contacts.read')) notFound();
  const { contacts, consent, templates } = await getRuntime();
  let detail: Awaited<ReturnType<typeof contacts.getContact>>;
  try {
    detail = await contacts.getContact(ctx, contactId);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const { contact } = detail;
  const tz = ctx.tenant.timezone;
  const base = `/c/${ctx.tenant.slug}`;
  const title = contact.displayName ?? contact.phoneE164 ?? 'Unnamed contact';

  if (contact.erasedAt) {
    return (
      <>
        <Link
          href={`${base}/contacts`}
          className="mb-2 inline-block text-sm text-primary underline-offset-4 hover:underline"
        >
          ← Contacts
        </Link>
        <PageHeader title="Erased contact" />
        <Alert
          tone="info"
          title={`Erased on ${formatDateTime(contact.erasedAt.toISOString(), tz)}`}
        >
          Personal data was removed and messages were redacted. Consent history is kept as proof of
          what the company was allowed to send.
        </Alert>
      </>
    );
  }

  const [consentView, suppressed, channels, sendable] = await Promise.all([
    consent.consentForContact(ctx, contact.id),
    consent.suppressionsFor(ctx, [
      ...(contact.phoneE164 ? [contact.phoneE164] : []),
      ...detail.identities.flatMap((i) => (i.waId ? [`+${i.waId}`] : [])),
    ]),
    templates.sendChannels(ctx),
    sendableTemplates(ctx),
  ]);
  const canWrite = can(ctx, 'contacts.write');

  return (
    <>
      <Link
        href={`${base}/contacts`}
        className="mb-2 inline-block text-sm text-primary underline-offset-4 hover:underline"
      >
        ← Contacts
      </Link>
      <PageHeader
        title={title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="tabular-nums">{contact.phoneE164 ?? 'No phone number'}</span>
            <ConsentBadge purpose="marketing" status={consentView.marketing?.status ?? null} />
            <ConsentBadge purpose="utility" status={consentView.utility?.status ?? null} />
          </span>
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="grid content-start gap-6">
          {suppressed.length > 0 ? (
            <Alert tone="warning" title="This number is on the suppression list">
              Added {SUPPRESSION_REASON[suppressed[0]?.reason ?? 'manual']} on{' '}
              {formatDateTime(suppressed[0]?.createdAt.toISOString() ?? null, tz)}. Templates are
              not sent to it.
            </Alert>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
            </CardHeader>
            <CardContent>
              <ContactForm
                slug={ctx.tenant.slug}
                contactId={contact.id}
                initial={{
                  displayName: contact.displayName ?? '',
                  phone: contact.phoneE164 ?? '',
                  email: contact.email ?? '',
                  attributes: Object.fromEntries(
                    detail.fields.map((f) => [f.key, attributeText(contact.attributes[f.key])]),
                  ),
                }}
                fields={detail.fields}
                phoneEditable={detail.identities.length === 0}
                canEdit={canWrite}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Tags</CardTitle>
            </CardHeader>
            <CardContent>
              <TagEditor
                slug={ctx.tenant.slug}
                contactId={contact.id}
                tags={detail.tags}
                canEdit={canWrite}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>WhatsApp</CardTitle>
              <CardDescription>
                Accounts this person has written to, and their conversations.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              {detail.identities.length === 0 ? (
                <p className="text-muted-foreground">
                  This person has not written to your WhatsApp numbers yet.
                </p>
              ) : (
                <ul className="grid gap-1">
                  {detail.identities.map((i) => (
                    <li key={i.id}>
                      {i.whatsappAccountName ?? 'WhatsApp account'}:{' '}
                      {i.waId ? `+${i.waId}` : 'user id only'}
                      {i.profileName ? ` · “${i.profileName}”` : ''}
                    </li>
                  ))}
                </ul>
              )}
              {detail.conversations.length > 0 ? (
                <ul className="grid gap-1">
                  {detail.conversations.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-2">
                      {c.canOpen &&
                      (can(ctx, 'inbox.read_all') || can(ctx, 'inbox.read_assigned')) ? (
                        <Link
                          href={`${base}/inbox/${c.id}`}
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          Conversation via {c.channelName ?? 'WhatsApp'}
                        </Link>
                      ) : (
                        <span>Conversation via {c.channelName ?? 'WhatsApp'}</span>
                      )}
                      {c.windowOpen ? (
                        <Badge tone="success">Window open</Badge>
                      ) : (
                        <Badge>Window closed</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardContent>
          </Card>
        </div>
        <div className="grid content-start gap-6">
          {channels.length > 0 && can(ctx, 'templates.read') ? (
            <Card>
              <CardHeader>
                <CardTitle>Send a template</CardTitle>
                <CardDescription>
                  Approved templates can be sent at any time. Marketing templates need the contact’s
                  opt-in.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TemplateSender
                  slug={ctx.tenant.slug}
                  contactId={contact.id}
                  channels={channels}
                  templates={sendable}
                />
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Consent</CardTitle>
              <CardDescription>
                Keyword replies such as STOP and START are recorded automatically. Record what the
                customer told you directly here.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {canWrite ? <ConsentForm slug={ctx.tenant.slug} contactId={contact.id} /> : null}
              {consentView.history.length === 0 ? (
                <p className="text-sm text-muted-foreground">No consent recorded yet.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>When</TH>
                      <TH>Change</TH>
                      <TH>Source</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {consentView.history.map((e) => (
                      <TR key={e.id}>
                        <TD className="whitespace-nowrap text-sm">
                          {formatDateTime(e.occurredAt.toISOString(), tz)}
                        </TD>
                        <TD className="text-sm">
                          {e.purpose === 'marketing' ? 'Marketing' : 'Utility'}:{' '}
                          {e.action === 'opt_in' ? 'opted in' : 'opted out'}
                          {typeof e.evidence.keyword === 'string'
                            ? ` (“${e.evidence.keyword}”)`
                            : ''}
                        </TD>
                        <TD className="text-sm text-muted-foreground">
                          {SOURCE_LABEL[e.source] ?? e.source}
                          {e.actorName ? ` · ${e.actorName}` : ''}
                          {typeof e.evidence.note === 'string' ? (
                            <span className="block">{e.evidence.note}</span>
                          ) : null}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>
          {can(ctx, 'contacts.delete') ? (
            <Card className="border-destructive/40">
              <CardHeader>
                <CardTitle>Erase personal data</CardTitle>
                <CardDescription>For deletion requests. Consent history is kept.</CardDescription>
              </CardHeader>
              <CardContent>
                <EraseContact slug={ctx.tenant.slug} contactId={contact.id} />
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
