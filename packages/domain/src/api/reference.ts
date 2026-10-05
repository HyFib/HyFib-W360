/**
 * The API reference page (ADR-152): the OpenAPI document of `buildOpenApiDocument` turned into
 * what the page shows, each operation, webhook event and schema once, so the page can never describe
 * more or less than the document. Pure: it reads the document only, never company data.
 */

/** A run of text: plain, or code (written between backticks in the document). */
export interface ReferenceSpan {
  text: string;
  code: boolean;
}

/** Text in paragraphs of spans. */
export type ReferenceText = ReferenceSpan[][];

/**
 * What a value is: `ref` names a schema the reference lists, `shapes` stands for several objects
 * whose fields follow it, one shape after another.
 */
export type ReferenceType =
  | { kind: 'scalar'; name: string; format?: string }
  | { kind: 'value'; value: string }
  | { kind: 'ref'; name: string }
  | { kind: 'array'; items: ReferenceType }
  | { kind: 'object' }
  | { kind: 'shapes'; count: number }
  | { kind: 'map'; values: ReferenceType }
  | { kind: 'oneOf'; options: ReferenceType[] }
  | { kind: 'any' };

export interface ReferenceField {
  /** The field's name, or the shape a group of fields belongs to (`type = tag`). */
  name: string;
  /** 0 for a body's or a schema's own fields, 1 for the fields of an object inside one, and so on. */
  depth: number;
  /** A shape's heading row rather than a field. */
  shape: boolean;
  type: ReferenceType;
  required: boolean;
  description: ReferenceText;
  /** Limits, allowed values and defaults, a line each. */
  notes: ReferenceSpan[][];
}

export interface ReferenceParameter {
  name: string;
  in: string;
  required: boolean;
  type: ReferenceType;
  description: ReferenceText;
  notes: ReferenceSpan[][];
}

export interface ReferenceBody {
  type: ReferenceType;
  fields: ReferenceField[];
}

export interface ReferenceResponse {
  status: string;
  description: ReferenceText;
  body: ReferenceBody | null;
}

export interface ReferenceOperation {
  /** The document's operation id, unique in it: the page's anchor. */
  id: string;
  method: string;
  path: string;
  summary: string;
  description: ReferenceText;
  parameters: ReferenceParameter[];
  requestBody: (ReferenceBody & { required: boolean }) | null;
  responses: ReferenceResponse[];
}

export interface ReferenceGroup {
  /** The first segment of its operations' paths (`contacts`, `webhook-endpoints`). */
  id: string;
  title: string;
  operations: ReferenceOperation[];
}

export interface ReferenceEvent {
  /** The event type, as the body's `type` and the `W360-Event-Type` header name it. */
  type: string;
  id: string;
  summary: string;
  description: ReferenceText;
  /** The headers each delivery carries. */
  headers: ReferenceParameter[];
  body: ReferenceBody | null;
  responses: ReferenceResponse[];
}

export interface ReferenceSchema {
  name: string;
  description: ReferenceText;
  type: ReferenceType;
  notes: ReferenceSpan[][];
  fields: ReferenceField[];
}

export interface ApiReference {
  title: string;
  version: string;
  serverUrl: string;
  introduction: ReferenceText;
  groups: ReferenceGroup[];
  events: ReferenceEvent[];
  schemas: ReferenceSchema[];
}

type Json = Record<string, unknown>;

const SCHEMA_REF = '#/components/schemas/';
const PARAMETER_REF = '#/components/parameters/';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

const record = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const count = (value: unknown) => (typeof value === 'number' ? value : undefined);
const span = (value: string, code = false): ReferenceSpan => ({ text: value, code });
/** A value as the page shows it: a string as written, anything else as JSON. */
const shown = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

function refName(ref: string, prefix: string): string {
  if (!ref.startsWith(prefix)) throw new Error(`The reference cannot follow ${ref}.`);
  return ref.slice(prefix.length);
}

/** Paragraphs at line breaks; code between backticks (an unpaired backtick stays text). */
export function referenceText(source: string): ReferenceText {
  return source
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split('`');
      const paired = parts.length % 2 === 1;
      const spans: ReferenceSpan[] = [];
      parts.forEach((part, index) => {
        const unpaired = !paired && index === parts.length - 1;
        if (unpaired) spans.push(span(`\`${part}`));
        else if (part.length > 0) spans.push(span(part, index % 2 === 1));
      });
      return spans;
    });
}

/** The options of a union (`anyOf`, `oneOf`), or null for any other schema. */
function unionOf(schema: Json): Json[] | null {
  const options = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null;
  return options ? options.map(record) : null;
}

const isNull = (schema: Json) => schema.type === 'null';
const isInlineObject = (schema: Json) =>
  typeof schema.$ref !== 'string' && schema.type === 'object' && schema.properties !== undefined;

/** A nullable value's other option, or the value itself. */
function soleOption(schema: Json): Json {
  const options = unionOf(schema);
  if (!options) return schema;
  const others = options.filter((option) => !isNull(option));
  return others.length === 1 && others[0] ? others[0] : schema;
}

function oneOf(options: ReferenceType[]): ReferenceType {
  const flat = options.flatMap((option) => (option.kind === 'oneOf' ? option.options : [option]));
  const [only] = flat;
  return flat.length === 1 && only ? only : { kind: 'oneOf', options: flat };
}

export function referenceType(schema: Json): ReferenceType {
  if (typeof schema.$ref === 'string') {
    return { kind: 'ref', name: refName(schema.$ref, SCHEMA_REF) };
  }
  if ('const' in schema) return { kind: 'value', value: shown(schema.const) };
  const options = unionOf(schema);
  if (options) {
    const shapes = options.filter(isInlineObject);
    const rest = options.filter((option) => !isInlineObject(option)).map(referenceType);
    return shapes.length > 1
      ? oneOf([{ kind: 'shapes', count: shapes.length }, ...rest])
      : oneOf(options.map(referenceType));
  }
  if (Array.isArray(schema.type)) {
    return oneOf(schema.type.map((name) => referenceType({ ...schema, type: name })));
  }
  switch (schema.type) {
    case 'array':
      return { kind: 'array', items: referenceType(record(schema.items)) };
    case 'object': {
      const values = schema.additionalProperties;
      return schema.properties === undefined && values !== null && typeof values === 'object'
        ? { kind: 'map', values: referenceType(record(values)) }
        : { kind: 'object' };
    }
    case 'string':
      return typeof schema.format === 'string'
        ? { kind: 'scalar', name: 'string', format: schema.format }
        : { kind: 'scalar', name: 'string' };
    case 'integer':
    case 'number':
    case 'boolean':
    case 'null':
      return { kind: 'scalar', name: schema.type };
    default:
      return { kind: 'any' };
  }
}

function plural(n: number, unit: readonly [string, string] | null) {
  const value = n.toLocaleString('en-US');
  return unit ? `${value} ${n === 1 ? unit[0] : unit[1]}` : value;
}

function bounds(
  min: number | undefined,
  max: number | undefined,
  unit: readonly [string, string] | null,
): string | null {
  if (min !== undefined && max !== undefined) {
    return min === max
      ? `Exactly ${plural(max, unit)}`
      : `${min.toLocaleString('en-US')} to ${plural(max, unit)}`;
  }
  if (min !== undefined) return `At least ${plural(min, unit)}`;
  if (max !== undefined) return `At most ${plural(max, unit)}`;
  return null;
}

/** Values as `a`, `b` or `c`. */
function choices(values: unknown[]): ReferenceSpan[] {
  return values.flatMap((value, index) => [
    ...(index === 0 ? [] : [span(index === values.length - 1 ? ' or ' : ', ')]),
    span(shown(value), true),
  ]);
}

/** The same note in the middle of a sentence. */
function lowered(note: ReferenceSpan[]): ReferenceSpan[] {
  const [first, ...rest] = note;
  if (!first || first.code) return note;
  return [span(first.text.charAt(0).toLowerCase() + first.text.slice(1)), ...rest];
}

/** A value's limits, allowed values and default, a line each. */
export function referenceNotes(schema: Json): ReferenceSpan[][] {
  const options = unionOf(schema);
  if (options) {
    // A nullable value's limits are those of its other option.
    const sole = soleOption(schema);
    const notes = sole === schema ? [] : referenceNotes(sole);
    return 'default' in schema
      ? [...notes, [span('Default '), span(shown(schema.default), true)]]
      : notes;
  }
  const notes: ReferenceSpan[][] = [];
  if (Array.isArray(schema.enum)) notes.push([span('One of '), ...choices(schema.enum)]);
  const limits = [
    bounds(count(schema.minimum), count(schema.maximum), null),
    bounds(count(schema.minLength), count(schema.maxLength), ['character', 'characters']),
    bounds(count(schema.minItems), count(schema.maxItems), ['item', 'items']),
    bounds(undefined, count(schema.maxProperties), ['entry', 'entries']),
  ];
  for (const limit of limits) if (limit) notes.push([span(limit)]);
  // A format (uuid, date-time) says what its generated pattern would.
  if (typeof schema.pattern === 'string' && typeof schema.format !== 'string') {
    notes.push([span('Matches '), span(schema.pattern, true)]);
  }
  if (schema.propertyNames !== undefined) {
    for (const note of referenceNotes(record(schema.propertyNames))) {
      notes.push([span('Each key: '), ...lowered(note)]);
    }
  }
  if (schema.type === 'array') {
    const items = soleOption(record(schema.items));
    if (!isInlineObject(items)) {
      for (const note of referenceNotes(record(schema.items))) {
        notes.push([span('Each item: '), ...lowered(note)]);
      }
    }
  }
  const values = schema.additionalProperties;
  if (schema.properties === undefined && values !== null && typeof values === 'object') {
    if (!isInlineObject(soleOption(record(values)))) {
      for (const note of referenceNotes(record(values))) {
        notes.push([span('Each value: '), ...lowered(note)]);
      }
    }
  }
  if ('default' in schema) notes.push([span('Default '), span(shown(schema.default), true)]);
  return notes;
}

/** The name of a shape: its one constant field (`type = tag`), or its place. */
function shapeName(shape: Json, index: number): string {
  const constants = Object.entries(record(shape.properties)).filter(([, value]) => {
    return 'const' in record(value);
  });
  const [only] = constants;
  return constants.length === 1 && only
    ? `${only[0]} = ${shown(record(only[1]).const)}`
    : `shape ${index + 1}`;
}

/** The rows inside a value: an object's fields, the shapes of a union, an array's or a map's. */
function innerFields(schema: Json, depth: number): ReferenceField[] {
  const inner = soleOption(schema);
  if (typeof inner.$ref === 'string') return [];
  if (isInlineObject(inner)) return referenceFields(inner, depth);
  const options = unionOf(inner);
  if (options) {
    const shapes = options.filter(isInlineObject);
    if (shapes.length < 2) return [];
    return shapes.flatMap((shape, index) => [
      {
        name: shapeName(shape, index),
        depth,
        shape: true,
        type: { kind: 'object' } as const,
        required: false,
        description: referenceText(text(shape.description)),
        notes: [],
      },
      ...referenceFields(shape, depth + 1),
    ]);
  }
  if (inner.type === 'array') return innerFields(record(inner.items), depth);
  const values = inner.additionalProperties;
  if (inner.properties === undefined && values !== null && typeof values === 'object') {
    return innerFields(record(values), depth);
  }
  return [];
}

/** An object's fields in the document's order, each followed by the rows inside it. */
export function referenceFields(schema: Json, depth = 0): ReferenceField[] {
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : [],
  );
  return Object.entries(record(schema.properties)).flatMap(([name, value]) => {
    const property = record(value);
    return [
      {
        name,
        depth,
        shape: false,
        type: referenceType(property),
        required: required.has(name),
        description: referenceText(text(property.description)),
        notes: referenceNotes(property),
      },
      ...innerFields(property, depth + 1),
    ];
  });
}

function bodyOf(content: unknown): ReferenceBody | null {
  const json = record(record(content)['application/json']);
  if (json.schema === undefined) return null;
  const schema = record(json.schema);
  return { type: referenceType(schema), fields: innerFields(schema, 0) };
}

function parameterOf(value: unknown, components: Json): ReferenceParameter {
  let parameter = record(value);
  if (typeof parameter.$ref === 'string') {
    const name = refName(parameter.$ref, PARAMETER_REF);
    const found = record(components.parameters)[name];
    if (found === undefined) throw new Error(`The parameter ${name} is not in the document.`);
    parameter = record(found);
  }
  const schema = record(parameter.schema);
  return {
    name: text(parameter.name),
    in: text(parameter.in),
    required: parameter.required === true,
    type: referenceType(schema),
    description: referenceText(text(parameter.description)),
    notes: referenceNotes(schema),
  };
}

function responsesOf(value: unknown): ReferenceResponse[] {
  return Object.entries(record(value)).map(([status, response]) => {
    const entry = record(response);
    return {
      status,
      description: referenceText(text(entry.description)),
      body: bodyOf(entry.content),
    };
  });
}

const groupTitle = (id: string) => {
  const words = id.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The reference of an OpenAPI document as `buildOpenApiDocument` builds it. */
export function apiReference(document: unknown): ApiReference {
  const doc = record(document);
  const info = record(doc.info);
  const components = record(doc.components);
  const [server] = Array.isArray(doc.servers) ? doc.servers.map(record) : [];

  const groups: ReferenceGroup[] = [];
  for (const [path, item] of Object.entries(record(doc.paths))) {
    const id = path.split('/')[1] ?? '';
    let group = groups.find((g) => g.id === id);
    if (!group) {
      group = { id, title: groupTitle(id), operations: [] };
      groups.push(group);
    }
    for (const method of METHODS) {
      const operation = record(record(item)[method]);
      if (Object.keys(operation).length === 0) continue;
      const body = record(operation.requestBody);
      const requestBody = bodyOf(body.content);
      group.operations.push({
        id: text(operation.operationId),
        method,
        path,
        summary: text(operation.summary),
        description: referenceText(text(operation.description)),
        parameters: (Array.isArray(operation.parameters) ? operation.parameters : []).map(
          (parameter) => parameterOf(parameter, components),
        ),
        requestBody: requestBody ? { ...requestBody, required: body.required === true } : null,
        responses: responsesOf(operation.responses),
      });
    }
  }

  const events: ReferenceEvent[] = Object.entries(record(doc.webhooks)).map(([type, item]) => {
    const operation = record(record(item).post);
    return {
      type,
      id: text(operation.operationId),
      summary: text(operation.summary),
      description: referenceText(text(operation.description)),
      headers: (Array.isArray(operation.parameters) ? operation.parameters : []).map((parameter) =>
        parameterOf(parameter, components),
      ),
      body: bodyOf(record(operation.requestBody).content),
      responses: responsesOf(operation.responses),
    };
  });

  const schemas: ReferenceSchema[] = Object.entries(record(components.schemas)).map(
    ([name, value]) => {
      const schema = record(value);
      return {
        name,
        description: referenceText(text(schema.description)),
        type: referenceType(schema),
        notes: referenceNotes(schema),
        fields: innerFields(schema, 0),
      };
    },
  );

  return {
    title: text(info.title),
    version: text(info.version),
    serverUrl: text(server?.url),
    introduction: referenceText(text(info.description)),
    groups,
    events,
    schemas,
  };
}
