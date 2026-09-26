'use client';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground">
        The request could not be completed. If this keeps happening, contact support with the
        reference below.
      </p>
      {error.digest ? (
        <code className="rounded bg-muted px-2 py-1 text-xs">{error.digest}</code>
      ) : null}
      <button
        type="button"
        onClick={reset}
        className="text-primary underline-offset-4 hover:underline"
      >
        Try again
      </button>
    </main>
  );
}
