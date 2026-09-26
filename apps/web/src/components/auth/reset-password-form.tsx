'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { passwordSchema } from '@w360/contracts';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
} from '@w360/ui';
import { authClient } from '@/lib/auth-client';
import { FormError, FormSuccess } from '@/components/form-status';
import { ClientForm } from '@/components/client-form';

const schema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, {
    path: ['confirm'],
    message: 'Passwords do not match',
  });

export function ResetPasswordForm({ token, invalid }: { token: string | null; invalid: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const form = useForm<z.input<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirm: '' },
  });

  const onSubmit = form.handleSubmit(async ({ password }) => {
    if (!token) return;
    setError(null);
    const result = await authClient.resetPassword({ newPassword: password, token });
    if (result.error) {
      setError('This reset link is invalid or has expired. Request a new one.');
      return;
    }
    setDone(true);
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="text-xl">Choose a new password</span>
        </CardTitle>
        <CardDescription>Your other sessions will be signed out.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {invalid || !token ? (
          <FormError message="This reset link is invalid or has expired." />
        ) : done ? (
          <>
            <FormSuccess message="Password updated. You can now sign in." />
            <Link href="/sign-in" className="text-primary underline-offset-4 hover:underline">
              Go to sign in
            </Link>
          </>
        ) : (
          <ClientForm onSubmit={onSubmit} className="grid gap-4">
            <FormError message={error} />
            <Field
              id="password"
              label="New password"
              description="At least 12 characters."
              error={form.formState.errors.password?.message}
            >
              {(aria) => (
                <Input
                  type="password"
                  autoComplete="new-password"
                  {...aria}
                  {...form.register('password')}
                />
              )}
            </Field>
            <Field
              id="confirm"
              label="Confirm password"
              error={form.formState.errors.confirm?.message}
            >
              {(aria) => (
                <Input
                  type="password"
                  autoComplete="new-password"
                  {...aria}
                  {...form.register('confirm')}
                />
              )}
            </Field>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              Update password
            </Button>
          </ClientForm>
        )}
      </CardContent>
    </Card>
  );
}
