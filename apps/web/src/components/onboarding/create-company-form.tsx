'use client';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { createCompanySchema, slugify } from '@w360/contracts';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
} from '@w360/ui';
import { createCompanyAction } from '@/app/actions/tenancy';
import { FormError } from '@/components/form-status';

type Values = z.input<typeof createCompanySchema>;

export function CreateCompanyForm({
  timezones,
  defaultTimezone,
}: {
  timezones: string[];
  defaultTimezone: string;
}) {
  const [error, setError] = useState<{ message: string; reference?: string } | null>(null);
  const [slugTouched, setSlugTouched] = useState(false);
  const form = useForm<Values>({
    resolver: zodResolver(createCompanySchema),
    defaultValues: { name: '', slug: '', timezone: defaultTimezone },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const result = await createCompanyAction(values);
    if (!result.ok) {
      setError({
        message: result.message,
        ...(result.reference ? { reference: result.reference } : {}),
      });
      for (const issue of result.issues ?? []) {
        if (issue.path === 'slug' || issue.path === 'name' || issue.path === 'timezone') {
          form.setError(issue.path, { message: issue.message });
        }
      }
      return;
    }
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full load deliberately drops all client state when the company/identity context changes
    window.location.assign(`/c/${result.data.slug}`);
  });

  const nameField = form.register('name', {
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!slugTouched) form.setValue('slug', slugify(e.target.value), { shouldValidate: false });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="text-xl">Create your company</span>
        </CardTitle>
        <CardDescription>
          Each company has its own team, WhatsApp numbers, contacts and billing. You can belong to
          several.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <FormError message={error?.message} reference={error?.reference} />
          <Field id="name" label="Company name" error={form.formState.errors.name?.message}>
            {(aria) => <Input autoComplete="organization" {...aria} {...nameField} />}
          </Field>
          <Field
            id="slug"
            label="Company address"
            description="Used in your workspace URL: /c/your-address"
            error={form.formState.errors.slug?.message}
          >
            {(aria) => (
              <Input
                {...aria}
                {...form.register('slug', { onChange: () => setSlugTouched(true) })}
                autoCapitalize="none"
                spellCheck={false}
              />
            )}
          </Field>
          <Field id="timezone" label="Time zone" error={form.formState.errors.timezone?.message}>
            {(aria) => (
              <Select {...aria} {...form.register('timezone')}>
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Creating…' : 'Create company'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
