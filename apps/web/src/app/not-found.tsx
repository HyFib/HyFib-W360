import Link from 'next/link';

export default function NotFound() {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground">
        The page does not exist, or you do not have access to it.
      </p>
      <Link href="/" className="text-primary underline-offset-4 hover:underline">
        Go to your workspace
      </Link>
    </main>
  );
}
