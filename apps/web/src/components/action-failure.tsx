'use client';
import { FormError } from '@/components/form-status';
import { SignInAgain } from '@/components/sign-in-again';

/** A failed action's result as the form shows it (the fields a server action returns). */
export interface ActionFailureState {
  code: string;
  message: string;
  reference?: string | undefined;
}

/**
 * Shows a failed action: a sign-in-again prompt when the action needs a recent sign-in
 * (`step_up_required`, ADR-056), otherwise the error message.
 */
export function ActionFailure({ failure }: { failure: ActionFailureState | null }) {
  if (!failure) return null;
  if (failure.code === 'step_up_required') return <SignInAgain reason={failure.message} />;
  return <FormError message={failure.message} reference={failure.reference} />;
}
