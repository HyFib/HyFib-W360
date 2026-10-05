import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@w360/ui';
import { Brand } from '@/components/brand';
import {
  EventSection,
  OperationSection,
  Paragraphs,
  SchemaSection,
  eventAnchor,
  operationAnchor,
  schemaAnchor,
} from '@/components/developers/reference';
import { publicApiDocs } from '@/server/api-docs';

export const metadata: Metadata = {
  title: 'API reference',
  description:
    'The HyFib W360 API and its webhook events: every operation, its parameters and answers, and every body.',
};
export const dynamic = 'force-dynamic';

/**
 * The API reference (ADR-152), for anyone, signed in or not: the OpenAPI document the API serves at
 * /api/v1/openapi.json, shown as a page. Built from the same document, so it never describes more
 * or less; it needs the configured address only, never the database or a company's data.
 */
export default function DevelopersPage() {
  const { reference } = publicApiDocs();
  return (
    <div className="flex min-h-dvh flex-col bg-muted/40">
      <header className="flex flex-wrap items-center justify-between gap-3 px-6 py-5">
        <Brand />
        <nav aria-label="Account" className="flex flex-wrap items-center gap-2">
          <Button asChild variant="ghost">
            <Link href="/sign-in">Sign in</Link>
          </Button>
        </nav>
      </header>
      <main
        id="main"
        className="mx-auto grid w-full max-w-5xl flex-1 content-start gap-8 px-4 pb-16 pt-2"
      >
        <div className="grid gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">API reference</h1>
          <p className="text-sm text-muted-foreground">
            {reference.title}, version {reference.version}. Base URL{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] break-all">
              {reference.serverUrl}
            </code>
            . The same reference as an{' '}
            <a
              className="font-medium underline underline-offset-4"
              href="/api/v1/openapi.json"
              target="_blank"
              rel="noreferrer"
            >
              OpenAPI document
            </a>{' '}
            can be imported into Postman and similar tools.
          </p>
          <Paragraphs text={reference.introduction} className="text-sm" />
        </div>

        <nav
          aria-label="Contents"
          className="grid gap-3 rounded-lg border border-border bg-card p-4"
        >
          <h2 className="text-lg font-semibold">Contents</h2>
          <ul className="grid gap-3 text-sm sm:grid-cols-2">
            {reference.groups.map((group) => (
              <li key={group.id} className="grid gap-1">
                <a className="font-medium underline underline-offset-4" href={`#group-${group.id}`}>
                  {group.title}
                </a>
                <ul className="grid gap-0.5">
                  {group.operations.map((operation) => (
                    <li key={operation.id}>
                      <a
                        className="font-mono text-xs underline-offset-4 hover:underline"
                        href={`#${operationAnchor(operation.id)}`}
                      >
                        {operation.method.toUpperCase()} {operation.path}
                      </a>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
            <li className="grid gap-1">
              <a className="font-medium underline underline-offset-4" href="#webhook-events">
                Webhook events
              </a>
              <ul className="grid gap-0.5">
                {reference.events.map((event) => (
                  <li key={event.type}>
                    <a
                      className="font-mono text-xs underline-offset-4 hover:underline"
                      href={`#${eventAnchor(event.type)}`}
                    >
                      {event.type}
                    </a>
                  </li>
                ))}
              </ul>
            </li>
            <li className="grid gap-1">
              <a className="font-medium underline underline-offset-4" href="#schemas">
                Schemas
              </a>
              <ul className="grid gap-0.5">
                {reference.schemas.map((schema) => (
                  <li key={schema.name}>
                    <a
                      className="font-mono text-xs underline-offset-4 hover:underline"
                      href={`#${schemaAnchor(schema.name)}`}
                    >
                      {schema.name}
                    </a>
                  </li>
                ))}
              </ul>
            </li>
          </ul>
        </nav>

        {reference.groups.map((group) => (
          <section
            key={group.id}
            id={`group-${group.id}`}
            aria-labelledby={`group-${group.id}-title`}
            className="grid scroll-mt-4 gap-4"
          >
            <h2 id={`group-${group.id}-title`} className="text-xl font-semibold">
              {group.title}
            </h2>
            {group.operations.map((operation) => (
              <OperationSection key={operation.id} operation={operation} />
            ))}
          </section>
        ))}

        <section
          id="webhook-events"
          aria-labelledby="webhook-events-title"
          className="grid scroll-mt-4 gap-4"
        >
          <h2 id="webhook-events-title" className="text-xl font-semibold">
            Webhook events
          </h2>
          <p className="text-sm text-muted-foreground">
            Each event is a signed POST to the endpoints that take it, added in Settings → Webhooks
            or through the API.
          </p>
          {reference.events.map((event) => (
            <EventSection key={event.type} event={event} />
          ))}
        </section>

        <section id="schemas" aria-labelledby="schemas-title" className="grid scroll-mt-4 gap-4">
          <h2 id="schemas-title" className="text-xl font-semibold">
            Schemas
          </h2>
          {reference.schemas.map((schema) => (
            <SchemaSection key={schema.name} schema={schema} />
          ))}
        </section>
      </main>
      <footer className="px-6 py-4 text-center text-xs text-muted-foreground">
        Uses the official WhatsApp Business Platform. WhatsApp is a trademark of its owner; HyFib
        W360 is an independent product.
      </footer>
    </div>
  );
}
