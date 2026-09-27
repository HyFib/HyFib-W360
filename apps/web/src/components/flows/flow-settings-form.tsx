'use client';
import { useId, useState } from 'react';
import { Button, Field, Input, Select } from '@w360/ui';
import { updateFlowSettingsAction } from '@/app/actions/flows';
import { ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

/**
 * Where a completed flow's answers go on the contact, and (for flows that fetch data) the company
 * endpoint HyFib forwards decrypted requests to. These are HyFib settings: they can change at any
 * time, also for published flows.
 */
export function FlowSettingsForm({
  slug,
  flow,
  fields,
  secrets,
  canEdit,
}: {
  slug: string;
  flow: {
    id: string;
    version: number;
    answerKeys: string[];
    mapping: { key: string; target: string }[];
    usesEndpoint: boolean;
    endpointUrl: string | null;
    endpointSecretName: string | null;
  };
  fields: { key: string; label: string }[];
  secrets: { name: string; domain: string }[];
  canEdit: boolean;
}) {
  const p = useId();
  const keys = [...new Set([...flow.answerKeys, ...flow.mapping.map((m) => m.key)])];
  const [targets, setTargets] = useState<Record<string, string>>(
    Object.fromEntries(flow.mapping.map((m) => [m.key, m.target])),
  );
  const [endpointUrl, setEndpointUrl] = useState(flow.endpointUrl ?? '');
  const [secret, setSecret] = useState(flow.endpointSecretName ?? '');
  // The page passes the current version after each change; a save made here may be newer still.
  const [savedVersion, setSavedVersion] = useState(0);
  const version = Math.max(flow.version, savedVersion);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setSaved(null);
        const mapping = keys.flatMap((k) => {
          const target = targets[k];
          return target ? [{ key: k, target }] : [];
        });
        void updateFlowSettingsAction(slug, {
          id: flow.id,
          expectedVersion: version,
          mapping,
          endpointUrl: flow.usesEndpoint ? endpointUrl : '',
          endpointSecretName: flow.usesEndpoint ? secret : '',
        }).then((r) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else {
            setSavedVersion(r.data.version);
            setSaved('Settings saved.');
          }
        });
      }}
    >
      <FormError message={error} />
      <FormSuccess message={saved} />
      {keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This flow returns no named answers (add a payload to its “complete” action).
        </p>
      ) : (
        <div className="grid gap-3">
          {keys.map((key) => (
            <Field key={key} id={`${p}-${key}`} label={`Answer “${key}”`}>
              {(aria) => (
                <Select
                  {...aria}
                  disabled={!canEdit}
                  value={targets[key] ?? ''}
                  onChange={(e) => setTargets((t) => ({ ...t, [key]: e.target.value }))}
                >
                  <option value="">Keep with the answers only</option>
                  <option value="name">Save as the contact’s name</option>
                  <option value="email">Save as the contact’s email</option>
                  {fields.map((f) => (
                    <option key={f.key} value={`field:${f.key}`}>
                      Save in “{f.label}”
                    </option>
                  ))}
                  {targets[key]?.startsWith('field:') &&
                  !fields.some((f) => `field:${f.key}` === targets[key]) ? (
                    <option value={targets[key]}>
                      Save in “{targets[key].slice(6)}” (no longer a contact field)
                    </option>
                  ) : null}
                </Select>
              )}
            </Field>
          ))}
        </div>
      )}
      {flow.usesEndpoint ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id={`${p}-endpoint`}
            label="Your endpoint address"
            description="HyFib forwards the decrypted requests of this flow here (an allowed domain from Settings → Web requests)."
          >
            {(aria) => (
              <Input
                {...aria}
                disabled={!canEdit}
                inputMode="url"
                placeholder="https://api.example.com/whatsapp-flows"
                value={endpointUrl}
                onChange={(e) => setEndpointUrl(e.target.value)}
              />
            )}
          </Field>
          <Field
            id={`${p}-secret`}
            label="Secret sent as a bearer token (optional)"
            description="Sent only to the secret’s own domain."
          >
            {(aria) => (
              <Select
                {...aria}
                disabled={!canEdit}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              >
                <option value="">No secret</option>
                {secrets.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name} ({s.domain})
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      ) : null}
      {canEdit ? (
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </Button>
        </div>
      ) : null}
    </ClientForm>
  );
}
