import { describe, expect, it } from 'vitest';
import { API_ROUTES, buildOpenApiDocument } from './openapi';
import {
  apiReference,
  referenceFields,
  referenceNotes,
  referenceText,
  referenceType,
  type ReferenceSpan,
  type ReferenceType,
} from './reference';

const doc = buildOpenApiDocument('https://app.example.com/api/v1');
const reference = apiReference(doc);
const flat = (spans: ReferenceSpan[]) => spans.map((s) => s.text).join('');
const notes = (schema: Record<string, unknown>) => referenceNotes(schema).map(flat);
const operation = (method: string, path: string) =>
  reference.groups.flatMap((g) => g.operations).find((o) => o.method === method && o.path === path);
/** Every schema a type names, for checking that the reference lists each one it links to. */
const referenceTypeNames = (type: ReferenceType): string[] =>
  type.kind === 'ref'
    ? [type.name]
    : type.kind === 'array'
      ? referenceTypeNames(type.items)
      : type.kind === 'map'
        ? referenceTypeNames(type.values)
        : type.kind === 'oneOf'
          ? type.options.flatMap(referenceTypeNames)
          : [];

describe('API reference (ADR-152)', () => {
  it('lists each operation of the document once, grouped by the first segment of its path in the document’s order', () => {
    const operations = reference.groups.flatMap((g) => g.operations);
    expect(operations.map((o) => `${o.method} ${o.path}`).sort()).toEqual(
      API_ROUTES.map(([method, path]) => `${method} ${path}`).sort(),
    );
    expect(new Set(operations.map((o) => o.id)).size).toBe(operations.length);
    expect(operations.every((o) => o.id && o.summary)).toBe(true);
    expect(reference.groups.map((g) => g.id)).toEqual([
      ...new Set(Object.keys(doc.paths).map((path) => path.split('/')[1])),
    ]);
    for (const group of reference.groups) {
      expect(group.operations.every((o) => o.path.split('/')[1] === group.id)).toBe(true);
    }
    expect(reference.groups.find((g) => g.id === 'webhook-endpoints')?.title).toBe(
      'Webhook endpoints',
    );
    expect(reference.title).toBe('HyFib W360 API');
    expect(reference.serverUrl).toBe('https://app.example.com/api/v1');
    expect(reference.introduction.length).toBeGreaterThan(1);
  });

  it('lists each webhook event and schema once, and every schema a type names', () => {
    expect(reference.events.map((e) => e.type)).toEqual(Object.keys(doc.webhooks));
    expect(reference.schemas.map((s) => s.name)).toEqual(Object.keys(doc.components.schemas));
    const listed = new Set(reference.schemas.map((s) => s.name));
    const types: ReferenceType[] = [];
    for (const o of reference.groups.flatMap((g) => g.operations)) {
      types.push(...o.parameters.map((p) => p.type));
      if (o.requestBody) types.push(o.requestBody.type, ...o.requestBody.fields.map((f) => f.type));
      for (const r of o.responses)
        if (r.body) types.push(r.body.type, ...r.body.fields.map((f) => f.type));
    }
    for (const e of reference.events) {
      types.push(...e.headers.map((h) => h.type));
      if (e.body) types.push(e.body.type);
    }
    for (const s of reference.schemas) types.push(s.type, ...s.fields.map((f) => f.type));
    const named = types.flatMap(referenceTypeNames);
    expect(named.length).toBeGreaterThan(100);
    expect(named.filter((name) => !listed.has(name))).toEqual([]);
    // Every value has a type the page can name.
    const kinds = (t: ReferenceType): string[] =>
      t.kind === 'array'
        ? [t.kind, ...kinds(t.items)]
        : t.kind === 'map'
          ? [t.kind, ...kinds(t.values)]
          : t.kind === 'oneOf'
            ? [t.kind, ...t.options.flatMap(kinds)]
            : [t.kind];
    expect(types.flatMap(kinds)).not.toContain('any');
  });

  it('turns descriptions into paragraphs, with code between backticks', () => {
    expect(referenceText('Use `limit`, at most 100.\n\nThen `nextCursor`')).toEqual([
      [
        { text: 'Use ', code: false },
        { text: 'limit', code: true },
        { text: ', at most 100.', code: false },
      ],
      [
        { text: 'Then ', code: false },
        { text: 'nextCursor', code: true },
      ],
    ]);
    expect(referenceText('An `unpaired backtick')).toEqual([
      [
        { text: 'An ', code: false },
        { text: '`unpaired backtick', code: false },
      ],
    ]);
    expect(referenceText('')).toEqual([]);
    // Angle brackets stay text for the page to escape.
    expect(flat(referenceText('`Authorization: Bearer <API key>`')[0] ?? [])).toBe(
      'Authorization: Bearer <API key>',
    );
  });

  it('names types: schemas, nullable values, unions, arrays, maps, constants and formats', () => {
    expect(referenceType({ $ref: '#/components/schemas/Message' })).toEqual({
      kind: 'ref',
      name: 'Message',
    });
    expect(
      referenceType({ anyOf: [{ type: 'string', maxLength: 200 }, { type: 'null' }] }),
    ).toEqual({
      kind: 'oneOf',
      options: [
        { kind: 'scalar', name: 'string' },
        { kind: 'scalar', name: 'null' },
      ],
    });
    expect(referenceType({ type: ['string', 'null'], format: 'uuid' })).toEqual({
      kind: 'oneOf',
      options: [
        { kind: 'scalar', name: 'string', format: 'uuid' },
        { kind: 'scalar', name: 'null' },
      ],
    });
    expect(referenceType({ type: 'array', items: { $ref: '#/components/schemas/Team' } })).toEqual({
      kind: 'array',
      items: { kind: 'ref', name: 'Team' },
    });
    expect(referenceType({ type: 'object', additionalProperties: { type: 'boolean' } })).toEqual({
      kind: 'map',
      values: { kind: 'scalar', name: 'boolean' },
    });
    expect(referenceType({ type: 'object', properties: {}, additionalProperties: false })).toEqual({
      kind: 'object',
    });
    expect(referenceType({ type: 'string', const: 'template' })).toEqual({
      kind: 'value',
      value: 'template',
    });
    const shapes = {
      oneOf: [
        { type: 'object', properties: { type: { const: 'a' } } },
        { type: 'object', properties: { type: { const: 'b' } } },
      ],
    };
    expect(referenceType(shapes)).toEqual({ kind: 'shapes', count: 2 });
    expect(() => referenceType({ $ref: 'https://example.com/schema.json' })).toThrow(
      'The reference cannot follow',
    );
  });

  it('notes limits, allowed values and defaults, leaving out the patterns formats imply', () => {
    expect(notes({ type: 'string', enum: ['asc', 'desc'], default: 'desc' })).toEqual([
      'One of asc or desc',
      'Default desc',
    ]);
    expect(notes({ type: 'string', enum: ['a', 'b', 'c'] })).toEqual(['One of a, b or c']);
    expect(notes({ type: 'integer', minimum: 1, maximum: 100 })).toEqual(['1 to 100']);
    expect(notes({ type: 'integer', minimum: 0 })).toEqual(['At least 0']);
    expect(notes({ type: 'string', minLength: 1, maxLength: 1 })).toEqual(['Exactly 1 character']);
    expect(notes({ type: 'string', maxLength: 1000 })).toEqual(['At most 1,000 characters']);
    expect(notes({ type: 'string', format: 'uuid', pattern: '^[0-9a-f-]+$' })).toEqual([]);
    expect(notes({ type: 'string', pattern: '^[a-z]+$' })).toEqual(['Matches ^[a-z]+$']);
    expect(
      notes({ type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', maxLength: 40 } }),
    ).toEqual(['1 to 20 items', 'Each item: at most 40 characters']);
    expect(
      notes({
        type: 'object',
        maxProperties: 5,
        propertyNames: { type: 'string', maxLength: 40 },
        additionalProperties: { type: 'string', maxLength: 500 },
      }),
    ).toEqual([
      'At most 5 entries',
      'Each key: at most 40 characters',
      'Each value: at most 500 characters',
    ]);
    expect(notes({ anyOf: [{ type: 'string', maxLength: 254 }, { type: 'null' }] })).toEqual([
      'At most 254 characters',
    ]);
    expect(notes({ anyOf: [{ type: 'string' }, { type: 'null' }], default: null })).toEqual([
      'Default null',
    ]);
    expect(notes({ type: 'object', default: { header: [] }, properties: {} })).toEqual([
      'Default {"header":[]}',
    ]);
    const enumNote = referenceNotes({ type: 'string', enum: ['asc', 'desc'] })[0];
    expect(enumNote?.filter((s) => s.code).map((s) => s.text)).toEqual(['asc', 'desc']);
  });

  it('lists the fields inside fields, arrays and unions, naming each shape by its constant', () => {
    const error = reference.schemas.find((s) => s.name === 'Error');
    expect(error?.fields.map((f) => [f.name, f.depth, f.required])).toEqual([
      ['error', 0, true],
      ['code', 1, true],
      ['message', 1, true],
      ['reason', 1, false],
      ['issues', 1, false],
      ['path', 2, true],
      ['message', 2, true],
      ['requestId', 0, true],
    ]);
    const search = reference.schemas.find((s) => s.name === 'ContactSearch')?.fields ?? [];
    const conditions = search.findIndex((f) => f.name === 'conditions');
    expect(search[conditions]?.type).toEqual({
      kind: 'array',
      items: { kind: 'shapes', count: 10 },
    });
    const conditionShapes = [
      'type = field',
      'type = name',
      'type = tag',
      'type = consent',
      'type = created',
      'type = source',
      'type = calling_code',
      'type = last_message',
      'type = campaign',
    ];
    const shapes = search.filter((f) => f.shape);
    expect(shapes.filter((f) => f.depth === 1).map((f) => f.name)).toEqual([
      ...conditionShapes,
      'type = group',
    ]);
    // A group's conditions (ADR-164) are listed inside it, a level deeper.
    expect(shapes.filter((f) => f.depth === 3).map((f) => f.name)).toEqual(conditionShapes);
    expect(shapes.every((f) => f.depth === 1 || f.depth === 3)).toBe(true);
    const groupConditions = search.findIndex(
      (f, i) => f.name === 'conditions' && f.depth === 2 && i > conditions,
    );
    expect(search[groupConditions]?.type).toEqual({
      kind: 'array',
      items: { kind: 'shapes', count: 9 },
    });
    const tag = search.findIndex((f) => f.name === 'type = tag');
    expect(search.slice(tag + 1, tag + 4).map((f) => [f.name, f.depth])).toEqual([
      ['type', 2],
      ['op', 2],
      ['tag', 2],
    ]);
    // A shape without one constant is named by its place; a nullable object lists its fields.
    expect(
      referenceFields({
        type: 'object',
        properties: {
          either: {
            anyOf: [
              { type: 'object', properties: { a: { type: 'string' } } },
              { type: 'object', properties: { b: { const: 'x' }, c: { const: 'y' } } },
            ],
          },
          maybe: {
            anyOf: [{ type: 'object', properties: { c: { type: 'integer' } } }, { type: 'null' }],
          },
          byKey: {
            type: 'object',
            additionalProperties: { type: 'object', properties: { d: { type: 'boolean' } } },
          },
        },
      }).map((f) => [f.name, f.depth, f.shape]),
    ).toEqual([
      ['either', 0, false],
      ['shape 1', 1, true],
      ['a', 2, false],
      ['shape 2', 1, true],
      ['b', 2, false],
      ['c', 2, false],
      ['maybe', 0, false],
      ['c', 1, false],
      ['byKey', 0, false],
      ['d', 1, false],
    ]);
  });

  it('describes parameters, request bodies and responses, resolving shared parameters', () => {
    const send = operation('post', '/messages');
    expect(send?.requestBody?.required).toBe(true);
    expect(send?.requestBody?.type).toMatchObject({ kind: 'oneOf' });
    expect(referenceTypeNames(send?.requestBody?.type ?? { kind: 'any' })).toEqual(
      expect.arrayContaining(['SendTemplate', 'SendText', 'SendReaction']),
    );
    expect(send?.parameters.map((p) => [p.name, p.in, p.required])).toEqual([
      ['Idempotency-Key', 'header', true],
    ]);
    expect(send?.responses.find((r) => r.status === '422')?.body?.type).toEqual({
      kind: 'ref',
      name: 'Error',
    });
    const contacts = operation('get', '/contacts');
    const limit = contacts?.parameters.find((p) => p.name === 'limit');
    expect(limit && [limit.in, limit.required, limit.type, limit.notes.map(flat)]).toEqual([
      'query',
      false,
      { kind: 'scalar', name: 'integer' },
      ['1 to 100', 'Default 50'],
    ]);
    const page = contacts?.responses.find((r) => r.status === '200');
    expect(page?.body?.fields.map((f) => f.name)).toEqual(['data', 'nextCursor']);
    expect(page?.body?.fields[0]?.type).toEqual({
      kind: 'array',
      items: { kind: 'ref', name: 'Contact' },
    });
    expect(operation('get', '/contacts/{id}')?.parameters[0]).toMatchObject({
      name: 'id',
      in: 'path',
      required: true,
    });
  });

  it('gives each webhook event its headers, body and the answer it expects', () => {
    const received = reference.events.find((e) => e.type === 'message.received');
    expect(received?.headers.map((h) => h.name)).toEqual(
      expect.arrayContaining(['W360-Signature', 'W360-Event-Id', 'W360-Event-Type']),
    );
    expect(received?.body?.type).toEqual({ kind: 'ref', name: 'WebhookMessageReceived' });
    expect(received?.responses.map((r) => r.status)).toEqual(['2XX']);
    expect(flat(received?.description[0] ?? [])).toContain('W360-Signature');
  });

  it('refuses a document whose shared parameter is missing rather than leaving it out', () => {
    const parameters: Record<string, unknown> = doc.components.parameters;
    const [name] = Object.keys(parameters);
    expect(name).toBeDefined();
    const broken = {
      ...doc,
      components: {
        ...doc.components,
        parameters: Object.fromEntries(Object.entries(parameters).filter(([key]) => key !== name)),
      },
    };
    expect(() => apiReference(broken)).toThrow(`The parameter ${name} is not in the document.`);
  });
});
