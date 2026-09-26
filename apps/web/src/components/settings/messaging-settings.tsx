'use client';
import { useState } from 'react';
import {
  Button,
  Checkbox,
  Field,
  Input,
  Select,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  Textarea,
} from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import {
  addSuppressionAction,
  createFieldAction,
  deleteFieldAction,
  removeSuppressionAction,
  updateMessagingSettingsAction,
} from '@/app/actions/contacts';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

export function ConsentKeywordsForm({
  slug,
  initial,
  canEdit,
}: {
  slug: string;
  initial: {
    optOutKeywords: readonly string[];
    marketingOptOutKeywords: readonly string[];
    optInKeywords: readonly string[];
    requireMarketingOptIn: boolean;
  };
  canEdit: boolean;
}) {
  const [optOut, setOptOut] = useState(initial.optOutKeywords.join(', '));
  const [marketingOptOut, setMarketingOptOut] = useState(
    initial.marketingOptOutKeywords.join(', '),
  );
  const [optIn, setOptIn] = useState(initial.optInKeywords.join(', '));
  const [requireOptIn, setRequireOptIn] = useState(initial.requireMarketingOptIn);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const result = await updateMessagingSettingsAction(slug, {
      optOutKeywords: optOut,
      marketingOptOutKeywords: marketingOptOut,
      optInKeywords: optIn,
      requireMarketingOptIn: requireOptIn,
    });
    setBusy(false);
    if (!result.ok) setError(result.message);
    else setSaved(true);
  }

  return (
    <ClientForm onSubmit={submit} className="grid gap-4 sm:max-w-xl">
      <FormError message={error} />
      <FormSuccess message={saved ? 'Consent settings saved.' : null} />
      <Field
        id="kw-opt-out"
        label="Stop all messages"
        description="A customer who sends one of these words is opted out of marketing and utility templates."
      >
        {(aria) => (
          <Textarea
            {...aria}
            rows={2}
            disabled={!canEdit}
            value={optOut}
            onChange={(e) => setOptOut(e.target.value)}
          />
        )}
      </Field>
      <Field id="kw-marketing" label="Stop marketing only">
        {(aria) => (
          <Textarea
            {...aria}
            rows={2}
            disabled={!canEdit}
            value={marketingOptOut}
            onChange={(e) => setMarketingOptOut(e.target.value)}
          />
        )}
      </Field>
      <Field
        id="kw-opt-in"
        label="Opt in again"
        description="Records an opt-in for marketing and utility templates."
      >
        {(aria) => (
          <Textarea
            {...aria}
            rows={2}
            disabled={!canEdit}
            value={optIn}
            onChange={(e) => setOptIn(e.target.value)}
          />
        )}
      </Field>
      <p className="text-xs text-muted-foreground">
        Separate keywords with commas. A keyword counts only when it is the whole message (case,
        spaces and punctuation around it are ignored).
      </p>
      <div className="flex items-start gap-2">
        <Checkbox
          id="require-opt-in"
          disabled={!canEdit}
          checked={requireOptIn}
          onChange={(e) => setRequireOptIn(e.target.checked)}
        />
        <label htmlFor="require-opt-in" className="text-sm">
          Send marketing templates only to contacts with a recorded opt-in (recommended; see Meta’s
          guidance on getting opt-in for WhatsApp)
        </label>
      </div>
      {canEdit ? (
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save consent settings'}
          </Button>
        </div>
      ) : null}
    </ClientForm>
  );
}

export function ContactFieldsManager({
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
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await createFieldAction(slug, { label, type });
    setBusy(false);
    if (!result.ok) setError(result.message);
    else setLabel('');
  }

  return (
    <div className="grid gap-4">
      <FormError message={error} />
      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">No custom fields yet.</p>
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
                <TD className="font-medium">{f.label}</TD>
                <TD className="font-mono text-xs">{f.key}</TD>
                <TD className="text-sm">{f.type}</TD>
                {canEdit ? (
                  <TD className="text-right">
                    <ConfirmDialog
                      destructive
                      title={`Delete the field “${f.label}”?`}
                      description="Its value is removed from every contact. This cannot be undone."
                      confirmLabel="Delete field"
                      onConfirm={() =>
                        void deleteFieldAction(slug, f.id).then((r) => {
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
          <Field id="field-label" label="New field">
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
          <Field id="field-type" label="Type">
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
            Add field
          </Button>
        </ClientForm>
      ) : null}
    </div>
  );
}

export function SuppressionManager({
  slug,
  items,
  canAdd,
  canRemove,
}: {
  slug: string;
  items: {
    id: string;
    phoneE164: string;
    reason: string;
    note: string | null;
    createdByName: string | null;
    createdAt: string;
  }[];
  canAdd: boolean;
  canRemove: boolean;
}) {
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('manual');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await addSuppressionAction(slug, { phone, reason, note });
    setBusy(false);
    if (!result.ok) setError(result.message);
    else {
      setPhone('');
      setNote('');
    }
  }

  return (
    <div className="grid gap-4">
      <FormError message={error} />
      {canAdd ? (
        <ClientForm onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_12rem] sm:items-end">
          <Field
            id="sup-phone"
            label="Phone number"
            description="With country code, for example +91 98765 43210."
          >
            {(aria) => (
              <Input
                {...aria}
                inputMode="tel"
                value={phone}
                required
                onChange={(e) => setPhone(e.target.value)}
              />
            )}
          </Field>
          <Field id="sup-reason" label="Reason">
            {(aria) => (
              <Select {...aria} value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="manual">Asked not to be contacted</option>
                <option value="complaint">Complaint</option>
                <option value="legal">Legal requirement</option>
              </Select>
            )}
          </Field>
          <Field id="sup-note" label="Note (optional)" className="sm:col-span-2">
            {(aria) => (
              <Input
                {...aria}
                value={note}
                maxLength={500}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </Field>
          <div>
            <Button type="submit" variant="outline" disabled={busy || !phone.trim()}>
              Add to suppression list
            </Button>
          </div>
        </ClientForm>
      ) : null}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No numbers are suppressed.</p>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Number</TH>
              <TH>Reason</TH>
              <TH>Added</TH>
              {canRemove ? (
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              ) : null}
            </TR>
          </THead>
          <TBody>
            {items.map((s) => (
              <TR key={s.id}>
                <TD className="tabular-nums">{s.phoneE164}</TD>
                <TD className="text-sm">
                  {s.reason}
                  {s.note ? (
                    <span className="block text-xs text-muted-foreground">{s.note}</span>
                  ) : null}
                </TD>
                <TD className="text-sm text-muted-foreground">
                  {s.createdAt}
                  {s.createdByName ? ` · ${s.createdByName}` : ''}
                </TD>
                {canRemove ? (
                  <TD className="text-right">
                    <ConfirmDialog
                      title={`Remove ${s.phoneE164} from the suppression list?`}
                      description="Templates can be sent to this number again (consent rules still apply)."
                      confirmLabel="Remove"
                      onConfirm={() =>
                        void removeSuppressionAction(slug, s.id).then((r) => {
                          if (!r.ok) setError(r.message);
                        })
                      }
                      trigger={
                        <ClientButton size="sm" variant="ghost">
                          Remove
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
    </div>
  );
}
