'use client';
import { useId, useState } from 'react';
import { Alert, Button, Checkbox, Field, Input, Label, Select, Textarea } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import {
  API_KEY_EXPIRY_DAYS,
  API_KEY_LIMITS,
  API_SCOPE_INFO,
  API_SCOPE_KEYS,
  formatAllowedNetwork,
  type ApiScope,
} from '@w360/domain/api-model';
import {
  createApiKeyAction,
  revokeApiKeyAction,
  rotateApiKeyAction,
  setApiKeyNetworksAction,
} from '@/app/actions/api-keys';
import { ActionFailure, type ActionFailureState } from '@/components/action-failure';
import { ClientButton, ClientForm } from '@/components/client-form';
import { CopyField } from '@/components/growth/copy-field';

const EXPIRY_LABELS: Record<(typeof API_KEY_EXPIRY_DAYS)[number], string> = {
  30: '30 days',
  90: '90 days',
  365: '1 year',
  0: 'Never',
};

/** How long the old key keeps working after a rotation. */
const OVERLAP_OPTIONS = [
  { hours: 0, label: 'Stop the old key now' },
  { hours: 1, label: '1 hour' },
  { hours: 24, label: '24 hours' },
  { hours: API_KEY_LIMITS.rotationOverlapHours, label: '72 hours' },
] as const;

const NETWORKS_HELP =
  'One IPv4 or IPv6 address or network per line, such as 203.0.113.7 or 203.0.113.0/24. Requests from any other address are refused. Leave it empty to accept any address.';

/** The addresses field of the create form and the edit dialog. */
function NetworksField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field id={id} label="Allowed addresses (optional)" description={NETWORKS_HELP}>
      {(aria) => (
        <Textarea
          {...aria}
          rows={3}
          maxLength={API_KEY_LIMITS.allowedNetworksText}
          spellCheck={false}
          autoComplete="off"
          className="font-mono text-xs"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/**
 * A key's token, right after it was created. It lives only in this component's memory: it is not
 * stored anywhere in the browser and cannot be shown again once dismissed.
 */
function NewToken({
  token,
  heading,
  onDone,
}: {
  token: string;
  heading: string;
  onDone: () => void;
}) {
  return (
    <div className="grid gap-3 rounded-md border border-border bg-muted/30 p-3">
      <Alert tone="warning" title={heading}>
        Copy the key now and store it in your integration’s secret store. It is not shown again, to
        anyone; if it is lost, rotate the key.
      </Alert>
      <CopyField label="API key" value={token} />
      <div>
        <ClientButton size="sm" variant="outline" onClick={onDone}>
          I have stored the key
        </ClientButton>
      </div>
    </div>
  );
}

/**
 * Creates a key with a name, scopes and an expiry. Scopes the member cannot grant, and scopes the
 * company's plan leaves out (ADR-092), are disabled.
 */
export function CreateApiKeyForm({
  slug,
  grantable,
  notInPlan,
  atLimit,
}: {
  slug: string;
  grantable: ApiScope[];
  notInPlan: ApiScope[];
  atLimit: boolean;
}) {
  const prefix = useId();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  const [expiresInDays, setExpiresInDays] = useState<number>(90);
  const [networks, setNetworks] = useState('');
  const [error, setError] = useState<ActionFailureState | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);

  // The new token stays on screen even when this key reaches the limit of active keys.
  if (created) {
    return (
      <NewToken
        token={created.token}
        heading={`API key “${created.name}” created`}
        onDone={() => setCreated(null)}
      />
    );
  }
  if (atLimit) {
    return (
      <p className="text-sm text-muted-foreground">
        The company has {API_KEY_LIMITS.activeKeys} active API keys, the most it can have. Revoke a
        key you no longer use to create another.
      </p>
    );
  }
  return (
    <ClientForm
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void createApiKeyAction(slug, {
          name,
          scopes,
          expiresInDays,
          allowedNetworks: networks,
        }).then((r) => {
          setBusy(false);
          if (!r.ok) setError(r);
          else {
            setCreated({ token: r.data.token, name: name.trim() });
            setName('');
            setScopes([]);
            setNetworks('');
          }
        });
      }}
    >
      <ActionFailure failure={error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${prefix}-name`}
          label="Name"
          description="What uses the key, such as “Order system”. Shown in the list and the audit log."
        >
          {(aria) => (
            <Input
              {...aria}
              required
              maxLength={API_KEY_LIMITS.nameLength}
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field
          id={`${prefix}-expiry`}
          label="Expires after"
          description="The key stops working then. Rotating keeps the same period."
        >
          {(aria) => (
            <Select
              {...aria}
              value={String(expiresInDays)}
              onChange={(e) => setExpiresInDays(Number(e.target.value))}
            >
              {API_KEY_EXPIRY_DAYS.map((d) => (
                <option key={d} value={d}>
                  {EXPIRY_LABELS[d]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Scopes</legend>
        {API_SCOPE_KEYS.map((scope) => {
          const id = `${prefix}-scope-${scope}`;
          const allowed = grantable.includes(scope);
          const info = API_SCOPE_INFO[scope];
          return (
            <div key={scope} className="flex items-start gap-2">
              <Checkbox
                id={id}
                className="mt-0.5"
                checked={scopes.includes(scope)}
                disabled={!allowed}
                onChange={(e) =>
                  setScopes(
                    e.target.checked ? [...scopes, scope] : scopes.filter((s) => s !== scope),
                  )
                }
              />
              <Label htmlFor={id} className="grid gap-0.5 font-normal">
                <span className="font-medium">
                  {info.label} <span className="font-mono text-xs">({scope})</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {allowed
                    ? info.description
                    : notInPlan.includes(scope)
                      ? `${info.description} Your company’s plan does not include it.`
                      : `${info.description} You cannot grant it: it needs a permission you do not have.`}
                </span>
              </Label>
            </div>
          );
        })}
      </fieldset>
      <NetworksField id={`${prefix}-networks`} value={networks} onChange={setNetworks} />
      <div>
        <Button type="submit" disabled={busy || !name.trim() || scopes.length === 0}>
          {busy ? 'Creating…' : 'Create API key'}
        </Button>
      </div>
    </ClientForm>
  );
}

/**
 * Rotation, revocation and the allowed addresses of one key. A rotation shows the new key here,
 * and it stays on screen after the list updates (the old key may then be revoked or rotated).
 */
export function ApiKeyActions({
  slug,
  keyId,
  name,
  rotatable,
  revocable,
  allowedNetworks,
}: {
  slug: string;
  keyId: string;
  name: string;
  rotatable: boolean;
  revocable: boolean;
  /** The key's networks when they can be changed (an active key), else undefined. */
  allowedNetworks?: string[] | null;
}) {
  const prefix = useId();
  const current = (allowedNetworks ?? []).map(formatAllowedNetwork).join('\n');
  const [networks, setNetworks] = useState(current);
  const [overlapHours, setOverlapHours] = useState<number>(24);
  const [error, setError] = useState<ActionFailureState | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  return (
    <div className="grid gap-2">
      {token ? (
        <NewToken token={token} heading={`New key for “${name}”`} onDone={() => setToken(null)} />
      ) : null}
      {rotatable || revocable || allowedNetworks !== undefined ? (
        <div className="flex flex-wrap gap-2">
          {allowedNetworks !== undefined ? (
            <ConfirmDialog
              trigger={
                <ClientButton
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setNetworks(current)}
                >
                  Addresses<span className="sr-only"> for {name}</span>
                </ClientButton>
              }
              title={`Addresses for “${name}”`}
              description="The key accepts requests only from these addresses. Changes apply to the next request."
              confirmLabel="Save addresses"
              onConfirm={() => {
                setBusy(true);
                setError(null);
                void setApiKeyNetworksAction(slug, { keyId, allowedNetworks: networks }).then(
                  (r) => {
                    setBusy(false);
                    if (!r.ok) setError(r);
                  },
                );
              }}
            >
              <NetworksField id={`${prefix}-networks`} value={networks} onChange={setNetworks} />
            </ConfirmDialog>
          ) : null}
          {rotatable ? (
            <ConfirmDialog
              trigger={
                <ClientButton size="sm" variant="outline" disabled={busy}>
                  Rotate<span className="sr-only"> {name}</span>
                </ClientButton>
              }
              title={`Rotate “${name}”?`}
              description="A new key with the same scopes is created and shown once. Switch your integration to it before the old key stops working."
              confirmLabel="Rotate key"
              onConfirm={() => {
                setBusy(true);
                setError(null);
                void rotateApiKeyAction(slug, { keyId, overlapHours }).then((r) => {
                  setBusy(false);
                  if (!r.ok) setError(r);
                  else setToken(r.data.token);
                });
              }}
            >
              <Field id={`${prefix}-overlap`} label="The old key keeps working for">
                {(aria) => (
                  <Select
                    {...aria}
                    value={String(overlapHours)}
                    onChange={(e) => setOverlapHours(Number(e.target.value))}
                  >
                    {OVERLAP_OPTIONS.map((o) => (
                      <option key={o.hours} value={o.hours}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </ConfirmDialog>
          ) : null}
          {revocable ? (
            <ConfirmDialog
              trigger={
                <ClientButton
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={busy}
                >
                  Revoke<span className="sr-only"> {name}</span>
                </ClientButton>
              }
              title={`Revoke “${name}”?`}
              description="The key stops working immediately and cannot be restored. Requests using it are refused."
              confirmLabel="Revoke key"
              destructive
              onConfirm={() => {
                setBusy(true);
                setError(null);
                void revokeApiKeyAction(slug, keyId).then((r) => {
                  setBusy(false);
                  if (!r.ok) setError(r);
                });
              }}
            />
          ) : null}
        </div>
      ) : null}
      <ActionFailure failure={error} />
    </div>
  );
}
