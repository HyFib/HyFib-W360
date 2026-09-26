'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { signInSchema } from '@w360/contracts';
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
import { authClient, safeNextPath } from '@/lib/auth-client';
import { FormError, FormSuccess } from '@/components/form-status';
import { ClientForm } from '@/components/client-form';

type Values = z.input<typeof signInSchema>;

export function SignInForm({ next }: { next: string | null }) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    setNotice(null);
    const result = await authClient.signIn.email({
      email: values.email,
      password: values.password,
    });
    if (result.error) {
      if (result.error.code === 'EMAIL_NOT_VERIFIED') {
        setNotice('Verify your email address first. We have sent you a new confirmation link.');
      } else if (result.error.status === 429) {
        setError('Too many attempts. Wait a minute and try again.');
      } else {
        setError('The email or password is incorrect.');
      }
      return;
    }
    const data = result.data as { twoFactorRedirect?: boolean } | null;
    if (data?.twoFactorRedirect) return; // handled by the two-factor client plugin
    window.location.assign(safeNextPath(next));
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="text-xl">Sign in</span>
        </CardTitle>
        <CardDescription>Welcome back. Sign in to your HyFib W360 workspace.</CardDescription>
      </CardHeader>
      <CardContent>
        <ClientForm onSubmit={onSubmit} className="grid gap-4">
          <FormError message={error} />
          <FormSuccess message={notice} />
          <Field id="email" label="Email" error={form.formState.errors.email?.message}>
            {(aria) => (
              <Input type="email" autoComplete="email" {...aria} {...form.register('email')} />
            )}
          </Field>
          <Field id="password" label="Password" error={form.formState.errors.password?.message}>
            {(aria) => (
              <Input
                type="password"
                autoComplete="current-password"
                {...aria}
                {...form.register('password')}
              />
            )}
          </Field>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
          </Button>
          <div className="flex justify-between text-sm">
            <Link
              href="/forgot-password"
              className="text-primary underline-offset-4 hover:underline"
            >
              Forgot password?
            </Link>
            <Link
              href={next ? `/sign-up?next=${encodeURIComponent(next)}` : '/sign-up'}
              className="text-primary underline-offset-4 hover:underline"
            >
              Create account
            </Link>
          </div>
        </ClientForm>
      </CardContent>
    </Card>
  );
}
