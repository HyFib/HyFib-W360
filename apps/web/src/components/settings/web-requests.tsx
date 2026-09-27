'use client';
import { useId, useState } from 'react';
import { Button, Field, Input, Select } from '@w360/ui';
import {
  addHttpDomainAction,
  deleteHttpSecretAction,
  removeHttpDomainAction,
  saveHttpSecretAction,
} from '@/app/actions/web-requests';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

/** Adds a domain that automation HTTP steps may call. */
export function AddDomainForm({ slug }: { slug: string }) {
  const id = useId();
  const [domain, setDomain] = useState('');
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
        void addHttpDomainAction(slug, { domain }).then((r) => {
          setBusy(false);
          if (!r.ok) setError(r.message);
          else {
            setSaved(`${domain.trim().toLowerCase().replace(/\.$/, '')} is allowed.`);
            setDomain('');
          }
        });
      }}
    >
      <FormError message={error} />
      <FormSuccess message={saved} />
      <Field
        id={id}
        label="Domain"
        description="A host name such as api.example.com, or *.example.com for all its subdomains (not example.com itself)."
      >
        {(aria) => (
          <Input
            {...aria}
            required
            maxLength={253}
            autoComplete="off"
            spellCheck={false}
            placeholder="api.example.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={busy || !domain.trim()}>
          {busy ? 'Adding…' : 'Allow domain'}
        </Button>
      </div>
    </ClientForm>
  );
}

export function RemoveDomainButton({
  slug,
  id,
  domain,
}: {
  slug: string;
  id: string;
  domain: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-2">
      <div>
        <ClientButton
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void removeHttpDomainAction(slug, id).then((r) => {
              setBusy(false);
              if (!r.ok) setError(r.message);
            });
          }}
        >
          Remove<span className="sr-only"> {domain}</span>
        </ClientButton>
      </div>
      <FormError message={error} />
    </div>
  );
}

/**
 * Creates a secret, or replaces the value of an existing one (same name). The value is sent once
 * and never shown again; the field is cleared after saving.
 */
export function SecretForm({
  slug,
  domains,
  secret,
}: {
  slug: string;
  domains: string[];
  secret?: { name: string; domain: string };
}) {
  const prefix = useId();
  const [name, setName] = useState(secret?.name ?? '');
  const [domain, setDomain] = useState(secret?.domain ?? '');
  // The list can change after the form mounted (a domain added or removed): fall back to the first.
  const selected = domains.includes(domain) ? domain : (domains[0] ?? '');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (domains.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Allow a domain first: a secret is only ever sent to the domain it is saved for.
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
        setSaved(null);
        void saveHttpSecretAction(slug, { name, domain: selected, value }).then((r) => {
          setBusy(false);
          setValue('');
          if (!r.ok) setError(r.message);
          else {
            setSaved(r.data.created ? `Secret “${name}” saved.` : `Secret “${name}” replaced.`);
            if (!secret) setName('');
          }
        });
      }}
    >
      <FormError message={error} />
      <FormSuccess message={saved} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${prefix}-name`}
          label="Name"
          description="Lower-case letters, digits and _. Steps use it as {{secret.name}} in a header."
        >
          {(aria) => (
            <Input
              {...aria}
              required
              maxLength={40}
              autoComplete="off"
              spellCheck={false}
              readOnly={Boolean(secret)}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field
          id={`${prefix}-domain`}
          label="Send only to"
          description="Steps can send the secret to this domain only."
        >
          {(aria) => (
            <Select {...aria} value={selected} onChange={(e) => setDomain(e.target.value)}>
              {domains.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Field
        id={`${prefix}-value`}
        label={secret ? 'New value' : 'Value'}
        description="Stored encrypted. It is never shown again, to anyone."
      >
        {(aria) => (
          <Input
            {...aria}
            type="password"
            required
            maxLength={2000}
            autoComplete="new-password"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={busy || !name.trim() || !value || !selected}>
          {busy ? 'Saving…' : secret ? 'Replace value' : 'Save secret'}
        </Button>
      </div>
    </ClientForm>
  );
}

export function DeleteSecretButton({ slug, id, name }: { slug: string; id: string; name: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-2">
      <div>
        <ClientButton
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void deleteHttpSecretAction(slug, id).then((r) => {
              setBusy(false);
              if (!r.ok) setError(r.message);
            });
          }}
        >
          Delete<span className="sr-only"> secret {name}</span>
        </ClientButton>
      </div>
      <FormError message={error} />
    </div>
  );
}
