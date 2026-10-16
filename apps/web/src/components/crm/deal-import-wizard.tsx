'use client';
import { useId, useState } from 'react';
import type { DealImportCheck, DealImportResult, DealImportRow } from '@w360/domain';
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
import {
  checkDealImportAction,
  importCheckedDealsAction,
  previewDealImportAction,
} from '@/app/actions/crm';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError } from '@/components/form-status';

interface Preview {
  fileName: string;
  headers: string[];
  sample: string[][];
  totalRows: number;
  fields: { key: string; label: string; type: string }[];
  suggested: Mapping;
}

type Column = number | null;

interface Mapping {
  dealId: Column;
  phone: Column;
  title: Column;
  stage: Column;
  value: Column;
  currency: Column;
  owner: Column;
  expectedCloseOn: Column;
  status: Column;
  lostReason: Column;
  fields: Record<string, Column>;
}

const EMPTY_MAPPING: Mapping = {
  dealId: null,
  phone: null,
  title: null,
  stage: null,
  value: null,
  currency: null,
  owner: null,
  expectedCloseOn: null,
  status: null,
  lostReason: null,
  fields: {},
};

/** What a checked row will do, in words (ADR-387). */
function rowAction(row: DealImportRow): string {
  switch (row.action) {
    case 'create':
      return row.close ? `Adds a deal closed as ${row.close}` : 'Adds a deal';
    case 'update':
      return row.close ? `Changes the deal and closes it as ${row.close}` : 'Changes the deal';
    case 'unchanged':
      return 'No change';
    case 'skip':
      return `Not imported: ${row.message ?? ''}`;
  }
}

function countsText(c: {
  created: number;
  updated: number;
  closed: number;
  unchanged: number;
  errorCount: number;
}) {
  return `${c.created} deals added, ${c.updated} changed, ${c.closed} closed, ${c.unchanged} unchanged, ${c.errorCount} rows with errors`;
}

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
 * Deal import in three steps (ADR-374, ADR-387): a preview of the file's columns and first rows; a
 * check of every row against the pipeline with an explicit column mapping, saying what each row
 * will do (add a deal, change one, close it, nothing, or skip it and why) before anything is
 * written; then the import, with the versions of the deals the check read. The file is sent again
 * at each step; nothing is stored between them.
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
  const [check, setCheck] = useState<DealImportCheck | null>(null);
  const [result, setResult] = useState<DealImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pipelineId, setPipelineId] = useState(pipelines[0]?.id ?? '');
  const [mapping, setMapping] = useState<Mapping>(EMPTY_MAPPING);
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
    setCheck(null);
    setMapping({ ...EMPTY_MAPPING, ...res.data.suggested });
  }

  // Without deal ids, every row adds a deal: its contact's number and a title are needed.
  const mappingReady =
    mapping.dealId !== null || (mapping.phone !== null && mapping.title !== null);

  function importForm(extra: Record<string, unknown>): FormData | null {
    if (!file) return null;
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
        ...extra,
      }),
    );
    return form;
  }

  async function checkRows(event: React.FormEvent) {
    event.preventDefault();
    const form = preview && mappingReady ? importForm({}) : null;
    if (!form) return;
    setBusy(true);
    setError(null);
    const res = await checkDealImportAction(slug, form);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setCheck(res.data);
  }

  async function runImport(event: React.FormEvent) {
    event.preventDefault();
    const form = check ? importForm({ expectedVersions: check.expectedVersions }) : null;
    if (!form) return;
    setBusy(true);
    setError(null);
    const res = await importCheckedDealsAction(slug, form);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setResult(res.data);
    setCheck(null);
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
              {countsText(result)} (of {result.totalRows}).
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
      ) : check ? (
        <Card>
          <CardHeader>
            <CardTitle>3. Check the rows — {preview.fileName}</CardTitle>
          </CardHeader>
          <CardContent>
            <ClientForm onSubmit={runImport} className="grid gap-4">
              <Alert tone={check.errorCount > 0 ? 'warning' : 'info'}>
                Importing will give: {countsText(check)} (of {check.totalRows}). Nothing has been
                written yet.
              </Alert>
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>Row</TH>
                      <TH>Deal</TH>
                      <TH>What importing does</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {check.rows.map((row) => (
                      <TR key={row.row}>
                        <TD className="tabular-nums">{row.row}</TD>
                        <TD className="max-w-64 truncate text-sm">{row.title ?? ''}</TD>
                        <TD className={row.action === 'skip' ? 'text-destructive' : undefined}>
                          {rowAction(row)}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
              <p className="text-sm text-muted-foreground">
                A deal someone changes after this check is skipped: check the rows again to include
                it.
              </p>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy || check.created + check.updated === 0}>
                  {busy ? 'Importing…' : `Import ${check.totalRows} rows`}
                </Button>
                <ClientButton type="button" variant="outline" onClick={() => setCheck(null)}>
                  Change columns
                </ClientButton>
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
            <ClientForm onSubmit={checkRows} className="grid gap-6">
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
                  id="map-deal-id"
                  label="Deal id"
                  description="The deal_id column of a deals export: a row with an id changes that open deal of the pipeline, and blank cells keep its values. Rows without one add deals."
                  headers={preview.headers}
                  value={mapping.dealId}
                  onChange={(v) => setMapping({ ...mapping, dealId: v })}
                />
                <ColumnSelect
                  id="map-phone"
                  label="Contact's phone number"
                  description="Each new deal is for the contact with this number; add or import contacts first. Not read for rows with a deal id: a deal's contact never changes."
                  required={mapping.dealId === null}
                  headers={preview.headers}
                  value={mapping.phone}
                  onChange={(v) => setMapping({ ...mapping, phone: v })}
                />
                <ColumnSelect
                  id="map-title"
                  label="Deal title"
                  required={mapping.dealId === null}
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
                  id="map-currency"
                  label="Currency"
                  description="Optional: a row in another currency than the pipeline's is skipped."
                  headers={preview.headers}
                  value={mapping.currency}
                  onChange={(v) => setMapping({ ...mapping, currency: v })}
                />
                <ColumnSelect
                  id="map-owner"
                  label="Owner"
                  description="The email of an active member who can use the CRM, or their name when no other member has it."
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
                <ColumnSelect
                  id="map-status"
                  label="Status"
                  description="open, won or lost. A won or lost row closes its deal now, as Won or Lost on the deal page does: reports count it today, whatever the file's closed_at. A deal already closed changes only after it is reopened on its page."
                  headers={preview.headers}
                  value={mapping.status}
                  onChange={(v) => setMapping({ ...mapping, status: v })}
                />
                <ColumnSelect
                  id="map-lost-reason"
                  label="Lost reason"
                  description="Only for lost rows; up to 200 characters."
                  headers={preview.headers}
                  value={mapping.lostReason}
                  onChange={(v) => setMapping({ ...mapping, lostReason: v })}
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
                Every row without a deal id adds a new deal, even when the contact already has one:
                importing the same file again adds its deals again. The product columns of a deals
                export are not imported, and a blank cell never clears a value: clear it on the deal
                page.
              </p>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy || !mappingReady}>
                  {busy ? 'Checking…' : `Check ${preview.totalRows} rows`}
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
