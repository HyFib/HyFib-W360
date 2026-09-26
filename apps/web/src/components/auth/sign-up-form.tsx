'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { signUpSchema } from '@w360/contracts';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from '@w360/ui';
import { authClient, safeNextPath } from '@/lib/auth-client';
import { FormError, FormSuccess } from '@/components/form-status';

type Values = z.input<typeof signUpSchema>;

export function SignUpForm({ next }: { next: string | null }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const form = useForm<Values>({ resolver: zodResolver(signUpSchema), defaultValues: { name: '', email: '', password: '' } });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const callbackURL = safeNextPath(next, '/onboarding');
    const result = await authClient.signUp.email({ ...values, callbackURL });
    if (result.error) {
      setError(result.error.status === 429 ? 'Too many attempts. Try again later.' : 'We could not create the account. Check the details and try again.');
      return;
    }
    setDone(true);
  });

  if (done) {
    return (
      <Card>
        <CardHeader>
          <CardTitle><span className="text-xl">Check your email</span></CardTitle>
          <CardDescription>
            If this address can be registered, we have sent a confirmation link. Open it to finish creating your account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormSuccess message="The link expires in 24 hours." />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle><span className="text-xl">Create your account</span></CardTitle>
        <CardDescription>Set up HyFib W360 for your company. You can invite your team afterwards.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <FormError message={error} />
          <Field id="name" label="Your name" error={form.formState.errors.name?.message}>
            {(aria) => <Input autoComplete="name" {...aria} {...form.register('name')} />}
          </Field>
          <Field id="email" label="Work email" error={form.formState.errors.email?.message}>
            {(aria) => <Input type="email" autoComplete="email" {...aria} {...form.register('email')} />}
          </Field>
          <Field id="password" label="Password" description="At least 12 characters. A passphrase works well." error={form.formState.errors.password?.message}>
            {(aria) => <Input type="password" autoComplete="new-password" {...aria} {...form.register('password')} />}
          </Field>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Creating account…' : 'Create account'}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{' '}
            <Link href={next ? `/sign-in?next=${encodeURIComponent(next)}` : '/sign-in'} className="text-primary underline-offset-4 hover:underline">
              Sign in
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
