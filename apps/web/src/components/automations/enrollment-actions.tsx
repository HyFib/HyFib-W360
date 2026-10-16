'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input } from '@w360/ui';
import { ConfirmDialog } from '@w360/ui/client';
import { AUTOMATION_LIMITS } from '@w360/domain/automation-model';
import { startEnrollmentAction, stopEnrollmentAction } from '@/app/actions/automations';
import { ClientButton, ClientForm } from '@/components/client-form';
import { FormError, FormSuccess } from '@/components/form-status';

type Audience =
  | { kind: 'contacts'; filter: { q?: string; tag?: string; consent?: string } }
  | { kind: 'segment'; segmentId: string };

/**
 * Confirms an enrolment (ADR-401): the trigger's inputs, given once for everyone, and the count the
 * member was shown, which goes with the request so a changed audience is refused.
 */
export function EnrollmentForm({
  slug,
  automationId,
  audience,
  count,
  inputs,
}: {
  slug: string;
  automationId: string;
  audience: Audience;
  count: number;
  inputs: string[];
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const contacts = `${count.toLocaleString('en-IN')} ${count === 1 ? 'contact' : 'contacts'}`;
  return (
    <ClientForm
      className="grid gap-3"
      aria-label="Enrol the contacts"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void startEnrollmentAction(slug, {
          automationId,
          audience,
          inputs: Object.fromEntries(inputs.map((i) => [i, values[i] ?? ''])),
          expectedCount: count,
        }).then((r) => {
          if (!r.ok) {
            setBusy(false);
            setError(r.message);
            return;
          }
          router.push(`/c/${slug}/automations/${automationId}/enrollments/${r.data.id}`);
        });
      }}
    >
      <FormError message={error} />
      {inputs.map((input) => (
        <Field
          key={input}
          id={`enrol-input-${input}`}
          label={`Input “${input}”`}
          description={`The same for everyone enrolled; steps read it as {{input.${input}}}.`}
        >
          {(aria) => (
            <Input
              {...aria}
              value={values[input] ?? ''}
              maxLength={AUTOMATION_LIMITS.apiInputLength}
              onChange={(e) => setValues({ ...values, [input]: e.target.value })}
            />
          )}
        </Field>
      ))}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Enrolling…' : `Enrol ${contacts}`}
        </Button>
      </div>
    </ClientForm>
  );
}

/** Stops a running enrolment: contacts not handled yet are not started; runs already started go on. */
export function StopEnrollmentButton({
  slug,
  enrollmentId,
}: {
  slug: string;
  enrollmentId: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-2">
      <FormError message={error} />
      <FormSuccess message={notice} />
      <ConfirmDialog
        title="Stop this enrolment?"
        description="Contacts not started yet are not started. Runs already started go on; stop one from its page if needed."
        confirmLabel="Stop enrolment"
        destructive
        onConfirm={() => {
          setBusy(true);
          setError(null);
          void stopEnrollmentAction(slug, enrollmentId).then((r) => {
            setBusy(false);
            if (!r.ok) setError(r.message);
            else
              setNotice(
                `Enrolment stopped; ${r.data.cancelled.toLocaleString('en-IN')} contacts were not started.`,
              );
          });
        }}
        trigger={
          <ClientButton variant="outline" className="text-destructive" disabled={busy}>
            Stop enrolment
          </ClientButton>
        }
      />
    </div>
  );
}
