import { describe, expect, it } from 'vitest';
import {
  NODE_TYPES,
  NODE_TYPE_LABELS,
  PRODUCT_PICKER_LIMIT,
  RUN_BUDGETS,
  SESSION_MESSAGE_NODE_TYPES,
  checkGraph,
  edgesOf,
  parseGraph,
  productsOf,
  type AutomationGraph,
} from './graph';
import { advance, initialRunState, type RunFacts, type RunState } from './interpreter';
import { PRODUCT_MESSAGE_LIMITS } from './model';

/** Steps that send products from the company's catalogs (ADR-383). */

const RUN = '0190a3e4-1111-7000-8000-000000000001';
const MUG = '0190a3e4-2222-7000-8000-000000000002';
const CUP = '0190a3e4-2222-7000-8000-000000000003';
const TEE = '0190a3e4-2222-7000-8000-000000000004';
const CATALOG = '0190a3e4-3333-7000-8000-000000000005';
const OTHER_CATALOG = '0190a3e4-3333-7000-8000-000000000006';
const WABA = '0190a3e4-4444-7000-8000-000000000007';
const OTHER_WABA = '0190a3e4-4444-7000-8000-000000000008';
const NOW = new Date('2026-10-16T10:00:00Z');
const facts: RunFacts = {
  contactName: 'Asha Rao',
  companyName: 'Acme',
  tags: new Set(),
  conversationTags: new Set(),
  fields: {},
  businessOpen: true,
};

const graphInput = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  start: 'offer',
  nodes: [
    {
      id: 'offer',
      type: 'send_products',
      kind: 'product_list',
      productIds: [MUG, CUP],
      sectionTitle: 'Mugs',
      header: 'Our mugs',
      body: 'Hi {{name}}, these are back in stock.',
      footer: 'Free delivery',
      next: 'bye',
      ...overrides,
    },
    { id: 'bye', type: 'send_text', text: 'Thanks!', next: null },
  ],
});

function graphOf(input: unknown): AutomationGraph {
  const parsed = parseGraph(input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.graph;
}

const run = (graph: AutomationGraph, state: Partial<RunState> = {}) =>
  advance({
    graph,
    state: { ...initialRunState(graph), ...state },
    event: { kind: 'continue' },
    facts,
    runId: RUN,
    now: NOW,
  });

const messages = (overrides: Record<string, unknown>) =>
  checkGraph(graphOf(graphInput(overrides))).map((i) => i.message);

const catalogProducts = new Map([
  [MUG, { catalogId: CATALOG, whatsappAccountId: WABA }],
  [CUP, { catalogId: CATALOG, whatsappAccountId: WABA }],
  [TEE, { catalogId: OTHER_CATALOG, whatsappAccountId: OTHER_WABA }],
]);

describe('steps that send products (ADR-383)', () => {
  it('is a session message step with one way on', () => {
    const graph = graphOf(graphInput());
    expect(NODE_TYPES).toContain('send_products');
    expect(NODE_TYPE_LABELS.send_products).toBe('Send products');
    expect(SESSION_MESSAGE_NODE_TYPES.has('send_products')).toBe(true);
    expect(edgesOf(graph.nodes[0]!)).toEqual([{ label: 'next', target: 'bye' }]);
    expect(productsOf(graph)).toEqual([MUG, CUP]);
    // Each product once, across steps.
    const twice = graphOf({
      ...graphInput({ next: 'again' }),
      nodes: [
        ...graphInput({ next: 'again' }).nodes.slice(0, 1),
        {
          id: 'again',
          type: 'send_products',
          kind: 'product',
          productIds: [MUG],
          sectionTitle: null,
          header: null,
          body: '',
          footer: null,
          next: null,
        },
      ],
    });
    expect(productsOf(twice)).toEqual([MUG, CUP]);
  });

  it('takes the limits of a product message; empty texts are none', () => {
    expect(
      graphOf(graphInput({ sectionTitle: ' ', header: '', footer: null })).nodes[0],
    ).toMatchObject({ sectionTitle: null, header: null, footer: null });
    expect(PRODUCT_MESSAGE_LIMITS).toMatchObject({
      productsPerMessage: 30,
      headerLength: 60,
      bodyLength: 1024,
      footerLength: 60,
      sectionTitleLength: 24,
    });
    // The builder lists as many products of each catalog as the inbox lists.
    expect(PRODUCT_PICKER_LIMIT).toBe(500);
    const thirty = Array.from(
      { length: 30 },
      (_, i) => `0190a3e4-5555-7000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(parseGraph(graphInput({ productIds: thirty })).ok).toBe(true);
    for (const bad of [
      { kind: 'products' },
      { kind: undefined },
      { productIds: undefined },
      { productIds: ['mug'] },
      { productIds: [...thirty, MUG] },
      { header: 'x'.repeat(61) },
      { sectionTitle: 'x'.repeat(25) },
      { body: 'x'.repeat(1025) },
      { footer: 'x'.repeat(61) },
    ]) {
      expect(parseGraph(graphInput(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('needs what each kind of message needs', () => {
    expect(messages({})).toEqual([]);
    expect(messages({ productIds: [] })).toEqual(['Choose the products to send.']);
    expect(messages({ productIds: [MUG, MUG] })).toEqual(['Each product can appear only once.']);
    expect(messages({ header: null, body: '' })).toEqual([
      'Write a heading.',
      'Write the message.',
    ]);
    // One product: the message may be left out.
    expect(messages({ kind: 'product', productIds: [MUG], header: null, body: '' })).toEqual([]);
    expect(messages({ kind: 'product', productIds: [] })).toEqual(['Choose a product.']);
    expect(messages({ kind: 'product', productIds: [MUG, CUP] })).toEqual(['Choose one product.']);
    // The catalog: one product shows on the message, and the message is needed.
    expect(messages({ kind: 'catalog', productIds: [MUG] })).toEqual([]);
    expect(messages({ kind: 'catalog', productIds: [], body: '' })).toEqual([
      'Choose the product shown on the message.',
      'Write the message.',
    ]);
    // A message of placeholders alone may come out empty: a list or the catalog is then not sent,
    // while one product is sent without it.
    const onlyPlaceholders =
      'This text is only placeholders; if they are empty the message cannot be sent.';
    expect(messages({ body: '{{name}}' })).toEqual([onlyPlaceholders]);
    expect(messages({ kind: 'catalog', productIds: [MUG], body: '{{name}}' })).toEqual([
      onlyPlaceholders,
    ]);
    expect(messages({ kind: 'product', productIds: [MUG], body: '{{name}}' })).toEqual([]);
  });

  it('sends products of one connected catalog, of the automation’s WhatsApp account', () => {
    const issues = (productIds: string[], account: string | null) =>
      checkGraph(graphOf(graphInput({ productIds })), {
        products: catalogProducts,
        channelWhatsappAccountId: account,
      }).map((i) => i.message);
    expect(issues([MUG, CUP], WABA)).toEqual([]);
    // Any number: the run checks the number's account when it sends.
    expect(issues([TEE], null)).toEqual([]);
    expect(issues([MUG, '0190a3e4-9999-7000-8000-000000000009'], WABA)).toEqual([
      'A product of this step is no longer in a connected catalog.',
    ]);
    expect(issues([MUG, TEE], null)).toEqual(['Choose products from one catalog.']);
    expect(issues([TEE], WABA)).toEqual([
      'Choose products from a catalog of the WhatsApp account of the automation’s number.',
    ]);
    // Without the company's products (a member who cannot see them), nothing to check here.
    expect(checkGraph(graphOf(graphInput({ productIds: [TEE] })))).toEqual([]);
  });

  it('follows the rules of a message: answers saved first, a customer reply first after an order', () => {
    expect(messages({ body: 'Your size: {{answer.size}}' })).toEqual([
      '{{answer.size}} is not saved by any question or web request.',
    ]);
    expect(
      checkGraph(graphOf(graphInput()), { storeEvent: true }).some(
        (i) => i.level === 'error' && i.nodeId === 'offer',
      ),
    ).toBe(true);
  });

  it('sends the products with the message filled in, counts it as a message and moves on', () => {
    expect(run(graphOf(graphInput()))).toMatchObject({
      effects: [
        {
          kind: 'send_products',
          productKind: 'product_list',
          productIds: [MUG, CUP],
          sectionTitle: 'Mugs',
          header: 'Our mugs',
          body: 'Hi Asha Rao, these are back in stock.',
          footer: 'Free delivery',
        },
      ],
      status: 'running',
      state: { nodeId: 'bye', messages: 1 },
      log: { nodeId: 'offer', nodeType: 'send_products', outcome: 'sent' },
    });
    // One product and the catalog go without the heading and section title a list had.
    for (const kind of ['product', 'catalog']) {
      expect(run(graphOf(graphInput({ kind, productIds: [MUG] }))), kind).toMatchObject({
        effects: [
          {
            kind: 'send_products',
            productKind: kind,
            productIds: [MUG],
            sectionTitle: null,
            header: null,
            body: 'Hi Asha Rao, these are back in stock.',
            footer: 'Free delivery',
          },
        ],
        status: 'running',
      });
    }
    // One product goes without a message; a list or the catalog does not.
    expect(
      run(graphOf(graphInput({ kind: 'product', productIds: [MUG], body: '{{answer.size}}' }))),
    ).toMatchObject({
      effects: [{ kind: 'send_products', productKind: 'product', productIds: [MUG], body: '' }],
      status: 'running',
    });
    for (const overrides of [
      { body: '{{answer.size}}' },
      { kind: 'catalog', productIds: [MUG], body: '{{answer.size}}' },
      { header: null },
    ]) {
      expect(run(graphOf(graphInput(overrides))), JSON.stringify(overrides)).toMatchObject({
        effects: [],
        status: 'failed',
        log: { detail: 'empty_message' },
      });
    }
    // Filled in past the limit of a product message, the message is cut to it.
    const long = run(graphOf(graphInput({ body: `${'x'.repeat(1000)} {{answer.size}}` })), {
      variables: { size: 'y'.repeat(50) },
    });
    const sent = long.effects[0] as { body: string } | undefined;
    expect(sent?.body).toHaveLength(PRODUCT_MESSAGE_LIMITS.bodyLength);
    expect(sent?.body.endsWith('…')).toBe(true);
    expect(run(graphOf(graphInput()), { messages: RUN_BUDGETS.maxMessages })).toMatchObject({
      effects: [],
      status: 'failed',
      endReason: 'budget_messages',
    });
  });
});
