'use client';
import { useId, useState } from 'react';
import { Input, Label, Select } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import { bulkSetFieldAction } from '@/app/actions/contacts';
import { ClientButton, ClientForm } from '@/components/client-form';
import type { ContactFieldDef } from '@/components/contacts/contact-form';
import { FormError, FormSuccess } from '@/components/form-status';

/**
 * Sets one custom field to one value, or clears it, on every contact the page's filters match
 * (ADR-238), once the member confirms: each contact's own value is replaced. The count the member
 * sees goes with the request, so an edit is refused if the matches changed meanwhile.
 */
export function BulkFieldForm({
  slug,
  filter,
  count,
  fields,
}: {
  slug: string;
  filter: { q?: string | undefined; tag?: string | undefined; consent?: string | undefined };
  count: number;
  fields: ContactFieldDef[];
}) {
  const fieldId = useId();
  const valueId = useId();
  const [key, setKey] = useState(fields[0]?.key ?? '');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The first field when the chosen one is gone (deleted meanwhile, then the page refreshed).
  const field = fields.find((f) => f.key === key) ?? fields[0];
  const contacts = `${count.toLocaleString('en-IN')} ${count === 1 ? 'contact' : 'contacts'}`;

  async function run(clear: boolean) {
    if (!field) return;
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await bulkSetFieldAction(slug, {
      filter,
      key: field.key,
      value: clear ? '' : value,
      expectedCount: count,
    });
    setBusy(false);
    if (!result.ok) setError(result.message);
    else {
      setDone(result.data.message);
      setValue('');
    }
  }

  if (!field) return null;
  return (
    <div className="grid gap-2">
      {/* Both edits go through their confirmation, so pressing Enter submits nothing. */}
      <ClientForm
        onSubmit={(event) => event.preventDefault()}
        className="flex flex-wrap items-end gap-2"
        aria-label="Set a custom field on the contacts these filters match"
      >
        <div className="grid gap-1">
          <Label htmlFor={fieldId}>Custom field</Label>
          <Select
            id={fieldId}
            value={field.key}
            className="w-48"
            onChange={(event) => {
              setKey(event.target.value);
              setValue('');
            }}
          >
            {fields.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={valueId}>Value for the {contacts} shown by these filters</Label>
          {field.type === 'boolean' ? (
            <Select
              id={valueId}
              value={value}
              className="w-40"
              onChange={(event) => setValue(event.target.value)}
            >
              <option value="">Choose</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </Select>
          ) : (
            <Input
              id={valueId}
              type={field.type === 'date' ? 'date' : 'text'}
              inputMode={field.type === 'number' ? 'decimal' : undefined}
              maxLength={500}
              value={value}
              className="w-64"
              onChange={(event) => setValue(event.target.value)}
            />
          )}
        </div>
        <ConfirmDialog
          title={`Set “${field.label}” on ${contacts}?`}
          description={`Each of them gets “${value.trim()}” for ${field.label}, replacing a different value one already has. This cannot be undone.`}
          confirmLabel={`Set on ${contacts}`}
          onConfirm={() => void run(false)}
          trigger={
            <ClientButton type="button" variant="outline" disabled={busy || !value.trim()}>
              Set on {contacts}
            </ClientButton>
          }
        />
        <ConfirmDialog
          destructive
          title={`Clear “${field.label}” on ${contacts}?`}
          description={`The value each of them has for ${field.label} is deleted. This cannot be undone.`}
          confirmLabel={`Clear on ${contacts}`}
          onConfirm={() => void run(true)}
          trigger={
            <ClientButton type="button" variant="outline" disabled={busy}>
              Clear on {contacts}
            </ClientButton>
          }
        />
      </ClientForm>
      <FormError message={error} />
      <FormSuccess message={done} />
    </div>
  );
}
