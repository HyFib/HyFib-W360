import { Fragment, type ReactNode } from 'react';
import type {
  ReferenceBody,
  ReferenceEvent,
  ReferenceField,
  ReferenceOperation,
  ReferenceParameter,
  ReferenceResponse,
  ReferenceSchema,
  ReferenceSpan,
  ReferenceText,
  ReferenceType,
} from '@w360/domain';
import { Badge, Table, TBody, TD, TH, THead, TR } from '@w360/ui';

/**
 * The parts of the API reference page (ADR-152). They show what `apiReference` made of the OpenAPI
 * document and decide nothing: every text is rendered as text, never as HTML.
 */

const CODE = 'rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]';

export const operationAnchor = (id: string) => `op-${id}`;
export const eventAnchor = (type: string) => `event-${type}`;
export const schemaAnchor = (name: string) => `schema-${name}`;

function Spans({ spans }: { spans: ReferenceSpan[] }) {
  return (
    <>
      {spans.map((s, i) =>
        s.code ? (
          <code key={i} className={CODE}>
            {s.text}
          </code>
        ) : (
          <Fragment key={i}>{s.text}</Fragment>
        ),
      )}
    </>
  );
}

export function Paragraphs({ text, className }: { text: ReferenceText; className?: string }) {
  return (
    <>
      {text.map((paragraph, i) => (
        <p key={i} className={className}>
          <Spans spans={paragraph} />
        </p>
      ))}
    </>
  );
}

export function TypeName({ type }: { type: ReferenceType }): ReactNode {
  switch (type.kind) {
    case 'scalar':
      return (
        <code className={CODE}>{type.format ? `${type.name} (${type.format})` : type.name}</code>
      );
    case 'value':
      return <code className={CODE}>{type.value}</code>;
    case 'ref':
      return (
        <a className="font-mono underline underline-offset-4" href={`#${schemaAnchor(type.name)}`}>
          {type.name}
        </a>
      );
    case 'array':
      return (
        <>
          array of <TypeName type={type.items} />
        </>
      );
    case 'object':
      return <code className={CODE}>object</code>;
    case 'shapes':
      return <>one of {type.count} objects</>;
    case 'map':
      return (
        <>
          map of <TypeName type={type.values} />
        </>
      );
    case 'oneOf':
      return (
        <>
          {type.options.map((option, i) => (
            <Fragment key={i}>
              {i === 0 ? null : i === type.options.length - 1 ? ' or ' : ', '}
              <TypeName type={option} />
            </Fragment>
          ))}
        </>
      );
    case 'any':
      return <>any value</>;
  }
}

function Notes({ notes }: { notes: ReferenceSpan[][] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="grid gap-0.5 text-xs text-muted-foreground">
      {notes.map((note, i) => (
        <li key={i}>
          <Spans spans={note} />
        </li>
      ))}
    </ul>
  );
}

const INDENT = ['pl-3', 'pl-7', 'pl-11', 'pl-15', 'pl-19', 'pl-23'] as const;
const indent = (depth: number) => INDENT[Math.min(depth, INDENT.length - 1)];

export function FieldsTable({ fields, label }: { fields: ReferenceField[]; label: string }) {
  return (
    <Table aria-label={label}>
      <THead>
        <TR>
          <TH>Field</TH>
          <TH>Type</TH>
          <TH>Description</TH>
        </TR>
      </THead>
      <TBody>
        {fields.map((field, i) =>
          field.shape ? (
            <TR key={i}>
              <TD className={`${indent(field.depth)} align-top`} colSpan={3}>
                <span className="text-xs text-muted-foreground">One shape: </span>
                <code className={CODE}>{field.name}</code>
                <Paragraphs text={field.description} className="text-sm" />
              </TD>
            </TR>
          ) : (
            <TR key={i}>
              <TD className={`${indent(field.depth)} align-top`}>
                <code className="font-mono text-xs break-all">{field.name}</code>
                {field.required ? (
                  <span className="block text-xs text-muted-foreground">required</span>
                ) : null}
              </TD>
              <TD className="align-top text-xs">
                <TypeName type={field.type} />
              </TD>
              <TD className="align-top text-sm">
                <div className="grid gap-1">
                  <Paragraphs text={field.description} />
                  <Notes notes={field.notes} />
                </div>
              </TD>
            </TR>
          ),
        )}
      </TBody>
    </Table>
  );
}

export function ParametersTable({
  parameters,
  label,
}: {
  parameters: ReferenceParameter[];
  label: string;
}) {
  return (
    <Table aria-label={label}>
      <THead>
        <TR>
          <TH>Name</TH>
          <TH>In</TH>
          <TH>Type</TH>
          <TH>Description</TH>
        </TR>
      </THead>
      <TBody>
        {parameters.map((parameter) => (
          <TR key={`${parameter.in}:${parameter.name}`}>
            <TD className="align-top">
              <code className="font-mono text-xs break-all">{parameter.name}</code>
              {parameter.required ? (
                <span className="block text-xs text-muted-foreground">required</span>
              ) : null}
            </TD>
            <TD className="align-top text-xs">{parameter.in}</TD>
            <TD className="align-top text-xs">
              <TypeName type={parameter.type} />
            </TD>
            <TD className="align-top text-sm">
              <div className="grid gap-1">
                <Paragraphs text={parameter.description} />
                <Notes notes={parameter.notes} />
              </div>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function Body({ body, label }: { body: ReferenceBody; label: string }) {
  return (
    <div className="grid gap-2">
      <p className="text-sm">
        <TypeName type={body.type} />
      </p>
      {body.fields.length > 0 ? <FieldsTable fields={body.fields} label={label} /> : null}
    </div>
  );
}

function Responses({ responses, label }: { responses: ReferenceResponse[]; label: string }) {
  return (
    <ul className="grid gap-3" aria-label={label}>
      {responses.map((response) => (
        <li key={response.status} className="grid gap-1">
          <p className="flex flex-wrap items-baseline gap-2 text-sm">
            <Badge tone={response.status.startsWith('2') ? 'success' : 'neutral'}>
              {response.status}
            </Badge>
            {response.body ? <TypeName type={response.body.type} /> : null}
          </p>
          <Paragraphs text={response.description} className="text-sm text-muted-foreground" />
          {response.body && response.body.fields.length > 0 ? (
            <FieldsTable fields={response.body.fields} label={`${label}: ${response.status}`} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

const METHOD_TONE = {
  get: 'info',
  post: 'success',
  put: 'warning',
  patch: 'warning',
  delete: 'danger',
} as const;

export function OperationSection({ operation }: { operation: ReferenceOperation }) {
  const anchor = operationAnchor(operation.id);
  const name = `${operation.method.toUpperCase()} ${operation.path}`;
  const tone = METHOD_TONE[operation.method as keyof typeof METHOD_TONE] ?? 'neutral';
  return (
    <section
      id={anchor}
      aria-labelledby={`${anchor}-title`}
      className="grid scroll-mt-4 gap-3 border-t border-border pt-6"
    >
      <h3 id={`${anchor}-title`} className="flex flex-wrap items-center gap-2 text-base">
        <Badge tone={tone}>{operation.method.toUpperCase()}</Badge>{' '}
        <code className="font-mono text-sm font-semibold break-all">{operation.path}</code>
      </h3>
      <p className="font-medium">{operation.summary}</p>
      <Paragraphs text={operation.description} className="text-sm" />
      {operation.parameters.length > 0 ? (
        <div className="grid gap-2">
          <h4 className="text-sm font-semibold">Parameters</h4>
          <ParametersTable parameters={operation.parameters} label={`Parameters of ${name}`} />
        </div>
      ) : null}
      {operation.requestBody ? (
        <div className="grid gap-2">
          <h4 className="text-sm font-semibold">
            Request body{operation.requestBody.required ? '' : ' (optional)'}
          </h4>
          <Body body={operation.requestBody} label={`Request body of ${name}`} />
        </div>
      ) : null}
      <div className="grid gap-2">
        <h4 className="text-sm font-semibold">Responses</h4>
        <Responses responses={operation.responses} label={`Responses of ${name}`} />
      </div>
    </section>
  );
}

export function EventSection({ event }: { event: ReferenceEvent }) {
  const anchor = eventAnchor(event.type);
  return (
    <section
      id={anchor}
      aria-labelledby={`${anchor}-title`}
      className="grid scroll-mt-4 gap-3 border-t border-border pt-6"
    >
      <h3 id={`${anchor}-title`} className="text-base">
        <code className="font-mono text-sm font-semibold">{event.type}</code>
      </h3>
      <p className="font-medium">{event.summary}</p>
      <Paragraphs text={event.description} className="text-sm" />
      {event.headers.length > 0 ? (
        <div className="grid gap-2">
          <h4 className="text-sm font-semibold">Headers</h4>
          <ParametersTable parameters={event.headers} label={`Headers of ${event.type}`} />
        </div>
      ) : null}
      {event.body ? (
        <div className="grid gap-2">
          <h4 className="text-sm font-semibold">Body</h4>
          <Body body={event.body} label={`Body of ${event.type}`} />
        </div>
      ) : null}
      <div className="grid gap-2">
        <h4 className="text-sm font-semibold">Your answer</h4>
        <Responses responses={event.responses} label={`Answers to ${event.type}`} />
      </div>
    </section>
  );
}

export function SchemaSection({ schema }: { schema: ReferenceSchema }) {
  const anchor = schemaAnchor(schema.name);
  return (
    <section
      id={anchor}
      aria-labelledby={`${anchor}-title`}
      className="grid scroll-mt-4 gap-3 border-t border-border pt-6"
    >
      <h3 id={`${anchor}-title`} className="text-base">
        <code className="font-mono text-sm font-semibold">{schema.name}</code>
      </h3>
      <Paragraphs text={schema.description} className="text-sm" />
      {schema.fields.length > 0 ? (
        <FieldsTable fields={schema.fields} label={`Fields of ${schema.name}`} />
      ) : (
        <div className="grid gap-1 text-sm">
          <p>
            <TypeName type={schema.type} />
          </p>
          <Notes notes={schema.notes} />
        </div>
      )}
    </section>
  );
}
