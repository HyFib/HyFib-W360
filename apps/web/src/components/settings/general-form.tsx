'use client';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { updateCompanySettingsSchema } from '@w360/contracts';
import {
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
} from '@w360/ui';
import { updateCompanySettingsAction } from '@/app/actions/tenancy';
import { FormError, FormSuccess } from '@/components/form-status';
import { ClientForm } from '@/components/client-form';

type Values = z.input<typeof updateCompanySettingsSchema>;

export function GeneralSettingsForm({
  slug,
  initial,
  timezones,
  canEdit,
}: {
  slug: string;
  initial: Values;
  timezones: string[];
  canEdit: boolean;
}) {
  const [error, setError] = useState<{ message: string; reference?: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const form = useForm<Values>({
    resolver: zodResolver(updateCompanySettingsSchema),
    defaultValues: initial,
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    setSaved(false);
    const result = await updateCompanySettingsAction(slug, values);
    if (!result.ok) {
      setError({
        message: result.message,
        ...(result.reference ? { reference: result.reference } : {}),
      });
      return;
    }
    setSaved(true);
  });

  return (
    <Card>
      <ClientForm onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle>Company profile</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:max-w-lg">
          <FormError message={error?.message} reference={error?.reference} />
          <FormSuccess message={saved ? 'Settings saved.' : null} />
          <Field id="name" label="Company name" error={form.formState.errors.name?.message}>
            {(aria) => <Input disabled={!canEdit} {...aria} {...form.register('name')} />}
          </Field>
          <Field
            id="timezone"
            label="Time zone"
            description="Used for schedules, business hours and reports."
            error={form.formState.errors.timezone?.message}
          >
            {(aria) => (
              <Select disabled={!canEdit} {...aria} {...form.register('timezone')}>
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            id="locale"
            label="Language"
            description="Interface language for company-wide content."
            error={form.formState.errors.locale?.message}
          >
            {(aria) => (
              <Select disabled={!canEdit} {...aria} {...form.register('locale')}>
                <option value="en">English</option>
              </Select>
            )}
          </Field>
        </CardContent>
        {canEdit ? (
          <CardFooter>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              Save changes
            </Button>
          </CardFooter>
        ) : null}
      </ClientForm>
    </Card>
  );
}
