'use client';
import { useId, useState } from 'react';
import type { DealImportResult } from '@w360/domain';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { importDealsAction, previewDealImportAction } from '@/app/actions/crm';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError } from '@/components/form-status';

interface Preview {
  fileName: string;
  headers: string[];
  sample: string[][];
  totalRows: number;
  fields: { key: string; label: string; type: string }[];
  suggested: {
    phone: number | null;
    title: number | null;
    stage: number | null;
    value: number | null;
    owner: number | null;
    expectedCloseOn: number | null;
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
 * Deal import in two steps (ADR-374), as contacts are imported: a preview of the file's columns
 * and first rows, then the import into a pipeline with an explicit column mapping. The file is
 * sent again for the import; nothing is stored between the steps.
 */
export function DealImportWizard({
  slug,
  pipelines,
}: {
  slug: string;
  pipelines: { id: string; name: string; currency: string }[];
}) {
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<DealImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pipelineId, setPipelineId] = useState(pipelines[0]?.id ?? '');
  const [mapping, setMapping] = useState<{
    phone: Column;
    title: Column;
    stage: Column;
    value: Column;
    owner: Column;
    expectedCloseOn: Column;
    fields: Record<string, Column>;
  }>({
    phone: null,
    title: null,
    stage: null,
    value: null,
    owner: null,
    expectedCloseOn: null,
    fields: {},
  });
  const [phoneFormat, setPhoneFormat] = useState<'international' | 'national'>('international');
  const [callingCode, setCallingCode] = useState('91');
  const pipeline = pipelines.find((p) => p.id === pipelineId);

  async function loadPreview(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const form = new FormData();
    form.set('file', file);
    const res = await previewDealImportAction(slug, form);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setPreview(res.data);
    setMapping({ ...res.data.suggested, fields: res.data.suggested.fields });
  }

  async function runImport(event: React.FormEvent) {
    event.preventDefault();
    if (!file || !preview || mapping.phone === null || mapping.title === null) return;
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
        pipelineId,
        mapping: { ...mapping, fields },
        phoneFormat,
        ...(phoneFormat === 'national' ? { callingCode } : {}),
      }),
    );
    const res = await importDealsAction(slug, form);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setResult(res.data);
    setPreview(null);
    setFile(null);
  }

  if (pipelines.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Deals need a pipeline. An owner or administrator can create one in Settings → Pipelines.
      </p>
    );
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
              {result.created} deals added, {result.errorCount} rows with errors (of{' '}
              {result.totalRows}).
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
                      <TD className="text-destructive">Not imported: {m.message}</TD>
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
                description="Up to 1,000 rows and just under 1 MB. The first row must hold column names. Comma, semicolon and tab separators are recognised."
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
              <Field id="import-pipeline" label="Pipeline" className="sm:max-w-sm">
                {(aria) => (
                  <Select
                    {...aria}
                    value={pipelineId}
                    onChange={(e) => setPipelineId(e.target.value)}
                  >
                    {pipelines.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.currency})
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <ColumnSelect
                  id="map-phone"
                  label="Contact's phone number"
                  description="Each deal is for the contact with this number; add or import contacts first."
                  required
                  headers={preview.headers}
                  value={mapping.phone}
                  onChange={(v) => setMapping({ ...mapping, phone: v })}
                />
                <ColumnSelect
                  id="map-title"
                  label="Deal title"
                  required
                  headers={preview.headers}
                  value={mapping.title}
                  onChange={(v) => setMapping({ ...mapping, title: v })}
                />
                <ColumnSelect
                  id="map-stage"
                  label="Stage"
                  description="A stage name of the pipeline; without one, the first stage."
                  headers={preview.headers}
                  value={mapping.stage}
                  onChange={(v) => setMapping({ ...mapping, stage: v })}
                />
                <ColumnSelect
                  id="map-value"
                  label={`Value (${pipeline?.currency ?? ''})`}
                  headers={preview.headers}
                  value={mapping.value}
                  onChange={(v) => setMapping({ ...mapping, value: v })}
                />
                <ColumnSelect
                  id="map-owner"
                  label="Owner"
                  description="The email of an active member who can use the CRM."
                  headers={preview.headers}
                  value={mapping.owner}
                  onChange={(v) => setMapping({ ...mapping, owner: v })}
                />
                <ColumnSelect
                  id="map-close"
                  label="Expected close date"
                  description="Written as YYYY-MM-DD."
                  headers={preview.headers}
                  value={mapping.expectedCloseOn}
                  onChange={(v) => setMapping({ ...mapping, expectedCloseOn: v })}
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
              <p className="text-sm text-muted-foreground">
                Every row adds a new deal, even when the contact already has one: importing the same
                file again adds its deals again.
              </p>
              <div className="flex gap-2">
                <Button
                  type="submit"
                  disabled={busy || mapping.phone === null || mapping.title === null}
                >
                  {busy ? 'Importing…' : `Import ${preview.totalRows} rows`}
                </Button>
                <ClientButton type="button" variant="outline" onClick={() => setPreview(null)}>
                  Choose another file
                </ClientButton>
              </div>
            </ClientForm>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
