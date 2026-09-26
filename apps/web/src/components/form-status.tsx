import { Alert } from '@w360/ui';

export function FormError({ message, reference }: { message: string | null | undefined; reference?: string | undefined }) {
  if (!message) return null;
  return (
    <Alert tone="danger">
      {message}
      {reference ? <span className="mt-1 block text-xs">Reference: {reference}</span> : null}
    </Alert>
  );
}

export function FormSuccess({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return <Alert tone="success">{message}</Alert>;
}
