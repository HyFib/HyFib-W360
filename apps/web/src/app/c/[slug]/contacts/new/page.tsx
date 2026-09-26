import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import { Card, CardContent } from '@w360/ui';
import { ContactForm } from '@/components/contacts/contact-form';
import { PageHeader } from '@/components/page-header';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Add contact' };
export const dynamic = 'force-dynamic';

export default async function NewContactPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'contacts.write')) notFound();
  const { contacts } = await getRuntime();
  const fields = await contacts.listFields(ctx);
  return (
    <>
      <Link
        href={`/c/${ctx.tenant.slug}/contacts`}
        className="mb-2 inline-block text-sm text-primary underline-offset-4 hover:underline"
      >
        ← Contacts
      </Link>
      <PageHeader
        title="Add contact"
        description="Adding a contact does not record consent. Record opt-in on the contact page when the person has agreed to hear from you."
      />
      <Card>
        <CardContent className="pt-6">
          <ContactForm
            slug={ctx.tenant.slug}
            initial={{ displayName: '', phone: '', email: '', attributes: {} }}
            fields={fields}
            phoneEditable
            canEdit
          />
        </CardContent>
      </Card>
    </>
  );
}
