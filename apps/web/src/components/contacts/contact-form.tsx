'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, Select } from '@w360/ui';
import { createContactAction, updateContactAction } from '@/app/actions/contacts';
import { ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';
import { choiceOptions } from '@/lib/contact-fields';

export interface ContactFieldDef {
  id: string;
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'boolean' | 'choice';
  /** A choice field's options, in order; null for every other type (ADR-407). */
  options: string[] | null;
}

interface Values {
  displayName: string;
  phone: string;
  email: string;
  tags: string;
  attributes: Record<string, string>;
}

/** Create or edit a contact. Custom field inputs follow each field's type. */
export function ContactForm({
  slug,
  contactId,
  initial,
  fields,
  phoneEditable,
  canEdit,
}: {
  slug: string;
  contactId?: string;
  initial: Omit<Values, 'tags'>;
  fields: ContactFieldDef[];
  phoneEditable: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Values>({ ...initial, tags: '' });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Values>) => {
    setSaved(false);
    setValues((v) => ({ ...v, ...patch }));
  };
  const setAttr = (key: string, value: string) =>
    set({ attributes: { ...values.attributes, [key]: value } });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (contactId) {
        const result = await updateContactAction(slug, contactId, {
          displayName: values.displayName,
          email: values.email,
          ...(phoneEditable ? { phone: values.phone } : {}),
          attributes: values.attributes,
        });
        if (!result.ok) setError(result.message);
        else setSaved(true);
      } else {
        const result = await createContactAction(slug, {
          displayName: values.displayName,
          phone: values.phone,
          email: values.email,
          attributes: Object.fromEntries(
            Object.entries(values.attributes).filter(([, v]) => v !== ''),
          ),
          tags: values.tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        });
        if (!result.ok) setError(result.message);
        else router.push(`/c/${slug}/contacts/${result.data.id}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <ClientForm onSubmit={submit} className="grid gap-4 sm:max-w-lg">
      <FormError message={error} />
      <FormSuccess message={saved ? 'Contact saved.' : null} />
      <Field id="displayName" label="Name">
        {(aria) => (
          <Input
            {...aria}
            value={values.displayName}
            maxLength={200}
            disabled={!canEdit}
            onChange={(e) => set({ displayName: e.target.value })}
          />
        )}
      </Field>
      <Field
        id="phone"
        label="Phone number"
        description={
          phoneEditable
            ? 'International format with country code, for example +91 98765 43210.'
            : 'This number comes from WhatsApp and cannot be changed.'
        }
      >
        {(aria) => (
          <Input
            {...aria}
            value={values.phone}
            inputMode="tel"
            autoComplete="off"
            required
            disabled={!canEdit || !phoneEditable}
            onChange={(e) => set({ phone: e.target.value })}
          />
        )}
      </Field>
      <Field id="email" label="Email (optional)">
        {(aria) => (
          <Input
            {...aria}
            type="email"
            value={values.email}
            maxLength={254}
            disabled={!canEdit}
            onChange={(e) => set({ email: e.target.value })}
          />
        )}
      </Field>
      {!contactId ? (
        <Field id="tags" label="Tags (optional)" description="Separate tags with commas.">
          {(aria) => (
            <Input {...aria} value={values.tags} onChange={(e) => set({ tags: e.target.value })} />
          )}
        </Field>
      ) : null}
      {fields.map((f) => {
        const id = `attr-${f.key}`;
        const value = values.attributes[f.key] ?? '';
        return (
          <Field key={f.key} id={id} label={f.label}>
            {(aria) =>
              f.type === 'boolean' ? (
                <Select
                  {...aria}
                  value={value}
                  disabled={!canEdit}
                  onChange={(e) => setAttr(f.key, e.target.value)}
                >
                  <option value="">Not set</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </Select>
              ) : f.type === 'choice' ? (
                <Select
                  {...aria}
                  value={value}
                  disabled={!canEdit}
                  onChange={(e) => setAttr(f.key, e.target.value)}
                >
                  <option value="">Not set</option>
                  {choiceOptions(f.options, value).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  {...aria}
                  type={f.type === 'date' ? 'date' : 'text'}
                  inputMode={f.type === 'number' ? 'decimal' : undefined}
                  value={value}
                  disabled={!canEdit}
                  onChange={(e) => setAttr(f.key, e.target.value)}
                />
              )
            }
          </Field>
        );
      })}
      {canEdit ? (
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : contactId ? 'Save contact' : 'Add contact'}
          </Button>
        </div>
      ) : null}
    </ClientForm>
  );
}
