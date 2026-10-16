'use client';
import { useState } from 'react';
import { Button, Field, Input, Select, TBody, TD, TH, THead, TR, Table, Textarea } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import {
  createDealFieldAction,
  deleteDealFieldAction,
  renameDealFieldAction,
  setDealFieldOptionsAction,
} from '@/app/actions/crm';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';
import { optionLines } from '@/lib/deal-fields';

/**
 * Settings → Pipelines' custom deal fields (ADR-373), as Settings → Messaging lists contact fields:
 * owners and administrators add, rename and delete them, and change a choice field's options
 * (ADR-385), typed one per line; others see them.
 */
export function DealFieldsManager({
  slug,
  fields,
  canEdit,
}: {
  slug: string;
  fields: { id: string; key: string; label: string; type: string; options: string[] | null }[];
  canEdit: boolean;
}) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState('text');
  // A new choice field's options, one per line.
  const [optionsText, setOptionsText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The field being renamed (ADR-262) and its new label.
  const [renaming, setRenaming] = useState<{ id: string; key: string } | null>(null);
  const [newLabel, setNewLabel] = useState('');
  // The choice field whose options are being changed, and its options as typed.
  const [editingOptions, setEditingOptions] = useState<{ id: string } | null>(null);
  const [optionsDraft, setOptionsDraft] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(null);
    const result = await createDealFieldAction(
      slug,
      type === 'choice' ? { label, type, options: optionLines(optionsText) } : { label, type },
    );
    setBusy(false);
    if (!result.ok) setError(result.message);
    else {
      setLabel('');
      setOptionsText('');
    }
  }

  async function saveOptions(event: React.FormEvent) {
    event.preventDefault();
    if (!editingOptions) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    const result = await setDealFieldOptionsAction(
      slug,
      editingOptions.id,
      optionLines(optionsDraft),
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSaved('Options saved.');
    setEditingOptions(null);
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
                <TD className="text-sm">
                  {f.type}
                  {editingOptions?.id === f.id ? (
                    <ClientForm onSubmit={saveOptions} className="mt-2 grid gap-2">
                      <Field
                        id={`deal-field-options-${f.id}`}
                        label="Options, one per line"
                        description="Options deals have chosen must stay as they are written."
                      >
                        {(aria) => (
                          <Textarea
                            {...aria}
                            rows={5}
                            value={optionsDraft}
                            required
                            onChange={(e) => setOptionsDraft(e.target.value)}
                          />
                        )}
                      </Field>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="submit"
                          size="sm"
                          disabled={busy || optionLines(optionsDraft).length === 0}
                        >
                          Save options
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingOptions(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </ClientForm>
                  ) : f.options ? (
                    <ul
                      aria-label={`Options of “${f.label}”`}
                      className="mt-1 text-xs text-muted-foreground"
                    >
                      {f.options.map((option) => (
                        <li key={option}>{option}</li>
                      ))}
                    </ul>
                  ) : null}
                </TD>
                {canEdit ? (
                  <TD className="text-right">
                    {f.options ? (
                      <ClientButton
                        size="sm"
                        variant="ghost"
                        aria-label={`Edit options of the deal field “${f.label}”`}
                        onClick={() => {
                          setEditingOptions({ id: f.id });
                          setOptionsDraft((f.options ?? []).join('\n'));
                          setError(null);
                          setSaved(null);
                        }}
                      >
                        Edit options
                      </ClientButton>
                    ) : null}
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
                <option value="choice">Choice</option>
              </Select>
            )}
          </Field>
          {type === 'choice' ? (
            <Field
              id="deal-field-options"
              label="Options, one per line"
              description="Up to 50, each at most 80 characters, none twice."
            >
              {(aria) => (
                <Textarea
                  {...aria}
                  rows={4}
                  value={optionsText}
                  required
                  onChange={(e) => setOptionsText(e.target.value)}
                />
              )}
            </Field>
          ) : null}
          <Button
            type="submit"
            variant="outline"
            disabled={
              busy || !label.trim() || (type === 'choice' && optionLines(optionsText).length === 0)
            }
          >
            Add deal field
          </Button>
        </ClientForm>
      ) : null}
    </div>
  );
}
