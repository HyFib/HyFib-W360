'use client';
import { useId, useState } from 'react';
import type { ImportResult } from '@w360/domain';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
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
import { importContactsAction, previewImportAction } from '@/app/actions/contacts';
import { ClientForm } from '@/components/client-form';
import { FormError } from '@/components/form-status';

interface Preview {
  fileName: string;
  headers: string[];
  sample: string[][];
  totalRows: number;
  fields: { key: string; label: string; type: string }[];
  suggested: {
    phone: number | null;
    name: number | null;
    email: number | null;
    tags: number | null;
    marketingConsent: number | null;
    fields: Record<string, number>;
  };
}

type Column = number | null;

function ColumnSelect({
  id,
  label,
  headers,
  value,
  onChange,
  required,
  description,
}: {
  id: string;
  label: string;
  headers: string[];
  value: Column;
  onChange: (value: Column) => void;
  required?: boolean;
  description?: string;
}) {
  return (
    <Field id={id} label={label} description={description}>
      {(aria) => (
        <Select
          {...aria}
          value={value === null ? '' : String(value)}
          required={required}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        >
          <option value="">{required ? 'Choose a column' : 'Not in this file'}</option>
          {headers.map((h, i) => (
            <option key={i} value={i}>
              {h || `Column ${i + 1}`}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

/**
 * CSV import in two steps: preview (columns and first rows) and import with an explicit column
 * mapping. The file is sent again for the import; nothing is stored between the steps.
 */
export function ImportWizard({ slug }: { slug: string }) {
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mapping, setMapping] = useState<{
    phone: Column;
    name: Column;
    email: Column;
    tags: Column;
    marketingConsent: Column;
    fields: Record<string, Column>;
  }>({ phone: null, name: null, email: null, tags: null, marketingConsent: null, fields: {} });
  const [phoneFormat, setPhoneFormat] = useState<'international' | 'national'>('international');
  const [callingCode, setCallingCode] = useState('91');
  const [updateExisting, setUpdateExisting] = useState(false);
  const [tags, setTags] = useState('');
  const [consentMode, setConsentMode] = useState<'none' | 'all_opted_in' | 'column'>('none');
  const [attestation, setAttestation] = useState('');

  async function loadPreview(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const form = new FormData();
    form.set('file', file);
    const res = await previewImportAction(slug, form);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setPreview(res.data);
    setMapping({ ...res.data.suggested, fields: res.data.suggested.fields });
    setConsentMode(res.data.suggested.marketingConsent !== null ? 'column' : 'none');
  }

  async function runImport(event: React.FormEvent) {
    event.preventDefault();
    if (!file || !preview || mapping.phone === null) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set('file', file);
    const fields = Object.fromEntries(
      Object.entries(mapping.fields).filter((e): e is [string, number] => e[1] !== null),
    );
    form.set(
      'options',
      JSON.stringify({
        mapping: { ...mapping, fields },
        phoneFormat,
        ...(phoneFormat === 'national' ? { callingCode } : {}),
        updateExisting,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        consent:
          consentMode === 'none'
            ? { mode: 'none' }
            : consentMode === 'all_opted_in'
              ? { mode: 'all_opted_in', attestation }
              : { mode: 'column', ...(attestation.trim() ? { attestation } : {}) },
      }),
    );
    const res = await importContactsAction(slug, form);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setResult(res.data);
    setPreview(null);
    setFile(null);
  }

  return (
    <div className="grid gap-6">
      <FormError message={error} />
      {result ? (
        <Card>
          <CardHeader>
            <CardTitle>Import finished</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Alert tone={result.errorCount > 0 ? 'warning' : 'success'}>
              {result.created} created, {result.updated} updated, {result.skipped} left unchanged,{' '}
              {result.errorCount} rows with errors (of {result.totalRows}). Consent recorded for{' '}
              {result.consentRecorded} contacts.
            </Alert>
            {result.messages.length > 0 ? (
              <Table>
                <THead>
                  <TR>
                    <TH>Row</TH>
                    <TH>Result</TH>
                  </TR>
                </THead>
                <TBody>
                  {result.messages.map((m, i) => (
                    <TR key={i}>
                      <TD className="tabular-nums">{m.row}</TD>
                      <TD
                        className={
                          m.level === 'error' ? 'text-destructive' : 'text-muted-foreground'
                        }
                      >
                        {m.level === 'error' ? 'Not imported: ' : ''}
                        {m.message}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {!preview ? (
        <Card>
          <CardHeader>
            <CardTitle>1. Choose a CSV file</CardTitle>
          </CardHeader>
          <CardContent>
            <ClientForm onSubmit={loadPreview} className="grid gap-3 sm:max-w-lg">
              <Field
                id={fileId}
                label="CSV file"
                description="Up to 5,000 rows and just under 1 MB. The first row must hold column names. Comma, semicolon and tab separators are recognised."
              >
                {(aria) => (
                  <Input
                    {...aria}
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                )}
              </Field>
              <div>
                <Button type="submit" disabled={!file || busy}>
                  {busy ? 'Reading…' : 'Preview'}
                </Button>
              </div>
            </ClientForm>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>2. Map columns — {preview.fileName}</CardTitle>
          </CardHeader>
          <CardContent>
            <ClientForm onSubmit={runImport} className="grid gap-6">
              <p className="text-sm text-muted-foreground">
                {preview.totalRows} data rows. First rows:
              </p>
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <TR>
                      {preview.headers.map((h, i) => (
                        <TH key={i}>{h || `Column ${i + 1}`}</TH>
                      ))}
                    </TR>
                  </THead>
                  <TBody>
                    {preview.sample.map((row, r) => (
                      <TR key={r}>
                        {row.map((cell, c) => (
                          <TD key={c} className="max-w-48 truncate text-sm">
                            {cell}
                          </TD>
                        ))}
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <ColumnSelect
                  id="map-phone"
                  label="Phone number"
                  required
                  headers={preview.headers}
                  value={mapping.phone}
                  onChange={(v) => setMapping({ ...mapping, phone: v })}
                />
                <ColumnSelect
                  id="map-name"
                  label="Name"
                  headers={preview.headers}
                  value={mapping.name}
                  onChange={(v) => setMapping({ ...mapping, name: v })}
                />
                <ColumnSelect
                  id="map-email"
                  label="Email"
                  headers={preview.headers}
                  value={mapping.email}
                  onChange={(v) => setMapping({ ...mapping, email: v })}
                />
                <ColumnSelect
                  id="map-tags"
                  label="Tags"
                  description="Several tags can be separated by ; , or |"
                  headers={preview.headers}
                  value={mapping.tags}
                  onChange={(v) => setMapping({ ...mapping, tags: v })}
                />
                {preview.fields.map((f) => (
                  <ColumnSelect
                    key={f.key}
                    id={`map-field-${f.key}`}
                    label={f.label}
                    headers={preview.headers}
                    value={mapping.fields[f.key] ?? null}
                    onChange={(v) =>
                      setMapping({ ...mapping, fields: { ...mapping.fields, [f.key]: v } })
                    }
                  />
                ))}
              </div>
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">Numbers without a leading + or 00</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="phoneFormat"
                    checked={phoneFormat === 'international'}
                    onChange={() => setPhoneFormat('international')}
                  />
                  Already include the country code (for example 919876543210)
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="phoneFormat"
                    checked={phoneFormat === 'national'}
                    onChange={() => setPhoneFormat('national')}
                  />
                  Are national numbers for country code
                </label>
                {phoneFormat === 'national' ? (
                  <Field id="calling-code" label="Country calling code" className="sm:max-w-40">
                    {(aria) => (
                      <Input
                        {...aria}
                        inputMode="numeric"
                        value={callingCode}
                        onChange={(e) => setCallingCode(e.target.value)}
                      />
                    )}
                  </Field>
                ) : null}
              </fieldset>
              <div className="flex items-start gap-2">
                <Checkbox
                  id="update-existing"
                  checked={updateExisting}
                  onChange={(e) => setUpdateExisting(e.target.checked)}
                />
                <label htmlFor="update-existing" className="text-sm">
                  Update contacts that already exist (empty cells never erase existing values)
                </label>
              </div>
              <Field
                id="import-tags"
                label="Tag every imported contact with (optional)"
                description="Separate tags with commas."
              >
                {(aria) => (
                  <Input {...aria} value={tags} onChange={(e) => setTags(e.target.value)} />
                )}
              </Field>
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">Marketing consent</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="consentMode"
                    checked={consentMode === 'none'}
                    onChange={() => setConsentMode('none')}
                  />
                  Do not record consent from this file
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="consentMode"
                    checked={consentMode === 'column'}
                    onChange={() => setConsentMode('column')}
                  />
                  Read it from a column (yes/no, opted in/opted out)
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="consentMode"
                    checked={consentMode === 'all_opted_in'}
                    onChange={() => setConsentMode('all_opted_in')}
                  />
                  Everyone in this file opted in to marketing messages
                </label>
                {consentMode === 'column' ? (
                  <ColumnSelect
                    id="map-consent"
                    label="Consent column"
                    required
                    headers={preview.headers}
                    value={mapping.marketingConsent}
                    onChange={(v) => setMapping({ ...mapping, marketingConsent: v })}
                  />
                ) : null}
                {consentMode !== 'none' ? (
                  <Field
                    id="attestation"
                    label="How did these people opt in?"
                    description="Required to record opt-ins: for example the form, checkbox wording and date range. It is kept as evidence. Opt-outs in the file are recorded without it, and an import never overrides an existing opt-out."
                  >
                    {(aria) => (
                      <Textarea
                        {...aria}
                        value={attestation}
                        maxLength={1000}
                        rows={3}
                        onChange={(e) => setAttestation(e.target.value)}
                      />
                    )}
                  </Field>
                ) : null}
              </fieldset>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy || mapping.phone === null}>
                  {busy ? 'Importing…' : `Import ${preview.totalRows} rows`}
                </Button>
                <Button type="button" variant="outline" onClick={() => setPreview(null)}>
                  Choose another file
                </Button>
              </div>
            </ClientForm>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
