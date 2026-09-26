'use client';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { emailSchema } from '@w360/contracts';
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

const schema = z.object({ email: emailSchema });

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.input<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
  });

  const onSubmit = form.handleSubmit(async ({ email }) => {
    setError(null);
    const result = await authClient.requestPasswordReset({ email, redirectTo: '/reset-password' });
    if (result.error?.status === 429) {
      setError('Too many requests. Try again later.');
      return;
    }
    // Same response whether or not the account exists.
    setSent(true);
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="text-xl">Reset your password</span>
        </CardTitle>
        <CardDescription>
          Enter your account email and we will send a reset link if the account exists.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sent ? (
          <FormSuccess message="If an account exists for that address, a reset link is on its way. It expires in 1 hour." />
        ) : (
          <form onSubmit={onSubmit} className="grid gap-4" noValidate>
            <FormError message={error} />
            <Field id="email" label="Email" error={form.formState.errors.email?.message}>
              {(aria) => (
                <Input type="email" autoComplete="email" {...aria} {...form.register('email')} />
              )}
            </Field>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              Send reset link
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
