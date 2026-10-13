'use client';
import { useState } from 'react';
import { Button, Field, Input, Select, TBody, TD, TH, THead, TR, Table } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import {
  createDealFieldAction,
  deleteDealFieldAction,
  renameDealFieldAction,
} from '@/app/actions/crm';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

/**
 * Settings → Pipelines' custom deal fields (ADR-373), as Settings → Messaging lists contact fields:
 * owners and administrators add, rename and delete them; others see them.
 */
export function DealFieldsManager({
  slug,
  fields,
  canEdit,
}: {
  slug: string;
  fields: { id: string; key: string; label: string; type: string }[];
  canEdit: boolean;
}) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState('text');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The field being renamed (ADR-262) and its new label.
  const [renaming, setRenaming] = useState<{ id: string; key: string } | null>(null);
  const [newLabel, setNewLabel] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(null);
    const result = await createDealFieldAction(slug, { label, type });
    setBusy(false);
    if (!result.ok) setError(result.message);
    else setLabel('');
  }

  async function rename(event: React.FormEvent) {
    event.preventDefault();
    if (!renaming) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    const result = await renameDealFieldAction(slug, renaming.id, newLabel);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSaved(
      `Renamed. Its key stays ${renaming.key}, so deals keep their values and exports and the API keep using it.`,
    );
    setRenaming(null);
  }

  return (
    <div className="grid gap-4">
      <FormError message={error} />
      <FormSuccess message={saved} />
      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">No deal fields yet.</p>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Label</TH>
              <TH>Key (CSV column)</TH>
              <TH>Type</TH>
              {canEdit ? (
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              ) : null}
            </TR>
          </THead>
          <TBody>
            {fields.map((f) => (
              <TR key={f.id}>
                <TD className="font-medium">
                  {renaming?.id === f.id ? (
                    <ClientForm onSubmit={rename} className="flex flex-wrap items-end gap-2">
                      <Field id={`deal-field-rename-${f.id}`} label="New label">
                        {(aria) => (
                          <Input
                            {...aria}
                            value={newLabel}
                            maxLength={80}
                            required
                            onChange={(e) => setNewLabel(e.target.value)}
                          />
                        )}
                      </Field>
                      <Button type="submit" size="sm" disabled={busy || !newLabel.trim()}>
                        Save label
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setRenaming(null)}
                      >
                        Cancel
                      </Button>
                    </ClientForm>
                  ) : (
                    f.label
                  )}
                </TD>
                <TD className="font-mono text-xs">{f.key}</TD>
                <TD className="text-sm">{f.type}</TD>
                {canEdit ? (
                  <TD className="text-right">
                    <ClientButton
                      size="sm"
                      variant="ghost"
                      aria-label={`Rename the deal field “${f.label}”`}
                      onClick={() => {
                        setRenaming({ id: f.id, key: f.key });
                        setNewLabel(f.label);
                        setError(null);
                        setSaved(null);
                      }}
                    >
                      Rename
                    </ClientButton>
                    <ConfirmDialog
                      destructive
                      title={`Delete the deal field “${f.label}”?`}
                      description="Its value is removed from every deal. This cannot be undone."
                      confirmLabel="Delete field"
                      onConfirm={() =>
                        void deleteDealFieldAction(slug, f.id).then((r) => {
                          if (!r.ok) setError(r.message);
                        })
                      }
                      trigger={
                        <ClientButton size="sm" variant="ghost" className="text-destructive">
                          Delete
                        </ClientButton>
                      }
                    />
                  </TD>
                ) : null}
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {canEdit ? (
        <ClientForm onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <Field id="deal-field-label" label="New deal field">
            {(aria) => (
              <Input
                {...aria}
                value={label}
                maxLength={80}
                required
                onChange={(e) => setLabel(e.target.value)}
              />
            )}
          </Field>
          <Field id="deal-field-type" label="Type">
            {(aria) => (
              <Select {...aria} value={type} onChange={(e) => setType(e.target.value)}>
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="date">Date</option>
                <option value="boolean">Yes / no</option>
              </Select>
            )}
          </Field>
          <Button type="submit" variant="outline" disabled={busy || !label.trim()}>
            Add deal field
          </Button>
        </ClientForm>
      ) : null}
    </div>
  );
}
