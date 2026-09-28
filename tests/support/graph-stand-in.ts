import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * TEST-ONLY local stand-in for the handful of Meta Graph API endpoints our client calls, so the
 * integration suite can drive success, rejection, rate limiting and "no response" paths
 * deterministically. It lives under tests/ and is never shipped: production configuration refuses
 * any Graph origin other than https://graph.facebook.com outside APP_ENV=local|test.
 *
 * Response shapes follow docs/research/meta-whatsapp.md; they are fixtures, not a claim about
 * every field Meta returns.
 */
export type SendBehaviour =
  | { kind: 'accept'; wamid?: string }
  | { kind: 'error'; status: number; code: number; title?: string; message?: string }
  | { kind: 'drop_connection' }
  | { kind: 'hang'; ms: number };

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | null;
  body: unknown;
  /** Message id returned for accepted sends. */
  wamid?: string;
}

export interface TemplateFixture {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: unknown[];
  rejected_reason?: string;
  quality_score?: { score: string; date: number };
}

export type TemplateCreateBehaviour =
  | { kind: 'accept'; status?: string }
  | { kind: 'error'; status: number; code: number; message: string }
  /** Creates the template, then drops the connection before answering (lost response). */
  | { kind: 'create_then_drop' }
  /** Refuses the connection-level request without creating anything. */
  | { kind: 'drop_connection' };

/** A WhatsApp flow as the stand-in keeps it (research M-161 to M-163). */
export interface FlowFixture {
  id: string;
  wabaId: string;
  name: string;
  categories: string[];
  status: 'DRAFT' | 'PUBLISHED' | 'DEPRECATED' | 'BLOCKED' | 'THROTTLED';
  json: string | null;
  endpointUri: string | null;
  validationErrors: Record<string, unknown>[];
}

export type FlowCreateBehaviour =
  | { kind: 'accept' }
  | { kind: 'error'; status: number; code: number; message: string }
  /** Creates the flow, then drops the connection before answering (lost response). */
  | { kind: 'create_then_drop' }
  | { kind: 'drop_connection' };

export interface StandInState {
  appId: string;
  appSecret: string;
  codes: Map<string, string>;
  tokens: Map<
    string,
    {
      appId: string;
      valid: boolean;
      scopes: string[];
      granular?: { scope: string; target_ids?: string[] }[];
    }
  >;
  wabaNumbers: Map<string, string[]>;
  numbers: Map<string, { display_phone_number: string; verified_name: string }>;
  sendQueue: SendBehaviour[];
  registerError: { status: number; code: number; message: string } | null;
  requests: RecordedRequest[];
  wamidCounter: number;
  /** Templates per WABA id, in listing order. */
  templates: Map<string, TemplateFixture[]>;
  templateCreateQueue: TemplateCreateBehaviour[];
  /** When true, listing with fields beyond the defaults fails with code 100. */
  rejectExtraTemplateFields: boolean;
  /** Recipient -> WhatsApp id returned in send responses (defaults to the recipient). */
  waIdFor: Map<string, string>;
  templateCounter: number;
  flows: Map<string, FlowFixture>;
  flowCounter: number;
  flowCreateQueue: FlowCreateBehaviour[];
  /** Validation errors returned by the next Flow JSON uploads (one entry per upload). */
  flowUploadErrors: Record<string, unknown>[][];
  /** Business public keys per phone number id (research M-164). */
  businessKeys: Map<string, { pem: string; status: 'VALID' | 'MISMATCH' }>;
  /** Signature status reported for keys uploaded from now on. */
  keySignatureStatus: 'VALID' | 'MISMATCH';
  /** Catalogs connected to each WABA, and each catalog's products (research M-172). */
  catalogs: Map<string, { id: string; name: string; product_count: number }[]>;
  catalogProducts: Map<string, Record<string, unknown>[]>;
  /** When set, catalog reads fail with this Graph error (for example a missing permission). */
  catalogError: { status: number; code: number; message: string } | null;
}

export interface GraphStandIn {
  baseUrl: string;
  state: StandInState;
  close(): Promise<void>;
}

/** The stored Flow JSON as an object, or null when there is none or it does not parse. */
function parseFlowJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks);
  const type = req.headers['content-type'] ?? '';
  if (type.startsWith('multipart/form-data')) {
    // Flows endpoints take multipart form data (research M-161): fields as strings, files as text.
    const form = await new Response(raw, { headers: { 'content-type': type } }).formData();
    const out: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) {
      out[key] =
        typeof value === 'string'
          ? value
          : { filename: value.name, type: value.type, content: await value.text() };
    }
    return out;
  }
  const text = raw.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function graphError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  title?: string,
) {
  json(res, status, {
    error: { message, type: 'OAuthException', code, ...(title ? { error_user_title: title } : {}) },
  });
}

/**
 * Checks an interactive reply-button message against the limits in Meta's OpenAPI spec (research
 * M-157): 1 to 3 buttons of type "reply", unique non-empty titles of at most 20 characters, ids of
 * at most 256 characters without surrounding spaces, and a body of at most 1024 characters.
 */
function interactiveProblem(body: unknown): string | null {
  const b = body as { type?: unknown; interactive?: Record<string, unknown> } | undefined;
  if (b?.type !== 'interactive') return null;
  const interactive = b.interactive;
  if (!interactive || interactive.type !== 'button') return 'interactive.type';
  const text = (interactive.body as { text?: unknown } | undefined)?.text;
  if (typeof text !== 'string' || text.length === 0 || text.length > 1024) return 'body.text';
  // Optional text header and footer (HeaderObject / FooterObject: at most 60 characters).
  const header = interactive.header as { type?: unknown; text?: unknown } | undefined;
  if (
    header !== undefined &&
    (header.type !== 'text' ||
      typeof header.text !== 'string' ||
      !header.text ||
      header.text.length > 60)
  )
    return 'header';
  const footer = interactive.footer as { text?: unknown } | undefined;
  if (
    footer !== undefined &&
    (typeof footer.text !== 'string' || !footer.text || footer.text.length > 60)
  )
    return 'footer.text';
  const buttons = (interactive.action as { buttons?: unknown } | undefined)?.buttons;
  if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > 3) return 'action.buttons';
  const titles = new Set<string>();
  for (const button of buttons as { type?: unknown; reply?: { id?: unknown; title?: unknown } }[]) {
    const id = button.reply?.id;
    const title = button.reply?.title;
    if (button.type !== 'reply') return 'buttons.type';
    if (typeof id !== 'string' || !id || id.length > 256 || id.trim() !== id) return 'reply.id';
    if (typeof title !== 'string' || !title || title.length > 20 || titles.has(title))
      return 'reply.title';
    titles.add(title);
  }
  return null;
}

const PRODUCT_TYPES = new Set(['product', 'product_list', 'catalog_message']);

/** Checks a product, multi-product or catalog message (research M-169) against known catalogs. */
function productMessageProblem(
  body: unknown,
  products: Map<string, Record<string, unknown>[]>,
): string | null {
  const b = body as { type?: unknown; interactive?: Record<string, unknown> } | undefined;
  const interactive = b?.interactive;
  if (b?.type !== 'interactive' || !interactive || !PRODUCT_TYPES.has(String(interactive.type))) {
    return null;
  }
  const action = (interactive.action ?? {}) as Record<string, unknown>;
  const has = (catalogId: unknown, retailerId: unknown) =>
    typeof catalogId === 'string' &&
    typeof retailerId === 'string' &&
    (products.get(catalogId) ?? []).some((p) => p.retailer_id === retailerId);
  const bodyText = (interactive.body as { text?: unknown } | undefined)?.text;
  if (interactive.type === 'product') {
    if (interactive.header !== undefined) return 'header';
    if (!has(action.catalog_id, action.product_retailer_id)) return 'action.product_retailer_id';
    return null;
  }
  if (typeof bodyText !== 'string' || !bodyText || bodyText.length > 1024) return 'body.text';
  if (interactive.type === 'catalog_message') {
    const parameters = (action.parameters ?? {}) as Record<string, unknown>;
    if (action.name !== 'catalog_message') return 'action.name';
    if (typeof parameters.thumbnail_product_retailer_id !== 'string')
      return 'thumbnail_product_retailer_id';
    return null;
  }
  const header = interactive.header as { type?: unknown; text?: unknown } | undefined;
  if (header?.type !== 'text' || typeof header.text !== 'string' || !header.text) return 'header';
  const sections = Array.isArray(action.sections)
    ? (action.sections as Record<string, unknown>[])
    : [];
  if (sections.length < 1 || sections.length > 10) return 'action.sections';
  let total = 0;
  for (const section of sections) {
    const items = Array.isArray(section.product_items)
      ? (section.product_items as Record<string, unknown>[])
      : [];
    if (items.length < 1 || items.length > 30) return 'product_items';
    if (sections.length > 1 && (typeof section.title !== 'string' || !section.title))
      return 'title';
    for (const item of items) {
      if (!has(action.catalog_id, item.product_retailer_id)) return 'product_retailer_id';
    }
    total += items.length;
  }
  return total > 30 ? 'product_items' : null;
}

/** Checks an interactive flow message (research M-165) against the flows the stand-in has. */
function flowMessageProblem(body: unknown, flows: Map<string, FlowFixture>): string | null {
  const b = body as { type?: unknown; interactive?: Record<string, unknown> } | undefined;
  if (b?.type !== 'interactive' || b.interactive?.type !== 'flow') return null;
  const interactive = b.interactive;
  const text = (interactive.body as { text?: unknown } | undefined)?.text;
  if (typeof text !== 'string' || text.length === 0 || text.length > 1024) return 'body.text';
  const action = interactive.action as { name?: unknown; parameters?: Record<string, unknown> };
  if (action?.name !== 'flow' || !action.parameters) return 'action';
  const p = action.parameters;
  if (p.flow_message_version !== '3') return 'flow_message_version';
  if (typeof p.flow_cta !== 'string' || !p.flow_cta || p.flow_cta.length > 30) return 'flow_cta';
  if (typeof p.flow_token !== 'string' || !p.flow_token) return 'flow_token';
  if (
    p.flow_action !== undefined &&
    p.flow_action !== 'navigate' &&
    p.flow_action !== 'data_exchange'
  )
    return 'flow_action';
  const flow = typeof p.flow_id === 'string' ? flows.get(p.flow_id) : undefined;
  if (!flow) return 'flow_id';
  const mode = p.mode ?? 'published';
  if (
    mode === 'draft'
      ? flow.status !== 'DRAFT'
      : flow.status !== 'PUBLISHED' && flow.status !== 'THROTTLED'
  )
    return 'mode';
  return null;
}

export async function startGraphStandIn(options: {
  appId: string;
  appSecret: string;
  /** Business tokens accepted from the start (end-to-end runs register a fixed token). */
  acceptTokens?: string[];
  port?: number;
}): Promise<GraphStandIn> {
  const state: StandInState = {
    appId: options.appId,
    appSecret: options.appSecret,
    codes: new Map(),
    tokens: new Map(),
    wabaNumbers: new Map(),
    numbers: new Map(),
    sendQueue: [],
    registerError: null,
    requests: [],
    wamidCounter: 0,
    templates: new Map(),
    templateCreateQueue: [],
    rejectExtraTemplateFields: false,
    waIdFor: new Map(),
    templateCounter: 0,
    flows: new Map(),
    flowCounter: 0,
    catalogs: new Map(),
    catalogProducts: new Map(),
    catalogError: null,
    flowCreateQueue: [],
    flowUploadErrors: [],
    businessKeys: new Map(),
    keySignatureStatus: 'VALID',
  };
  for (const token of options.acceptTokens ?? []) {
    state.tokens.set(token, {
      appId: options.appId,
      valid: true,
      scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
    });
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://stand-in');
      const body = await readBody(req);
      const authorization = req.headers.authorization ?? null;
      if (req.method === 'GET' && url.pathname === '/__stand-in/requests') {
        return json(res, 200, state.requests);
      }
      // Test control: the catalog connected to a WhatsApp account and its products, as Commerce
      // Manager would hold them.
      if (req.method === 'POST' && url.pathname === '/__stand-in/catalog') {
        const b = (body ?? {}) as {
          wabaId?: string;
          catalog?: { id: string; name: string; product_count: number };
          products?: Record<string, unknown>[];
        };
        if (!b.wabaId || !b.catalog || !Array.isArray(b.products))
          return json(res, 400, { ok: false });
        state.catalogs.set(String(b.wabaId), [b.catalog]);
        state.catalogProducts.set(b.catalog.id, b.products);
        return json(res, 200, { ok: true });
      }
      // Test control: set a template's review status, as Meta's review would.
      if (req.method === 'POST' && url.pathname === '/__stand-in/template-status') {
        const b = (body ?? {}) as { wabaId?: string; name?: string; status?: string };
        const template = state.templates.get(String(b.wabaId))?.find((t) => t.name === b.name);
        if (!template || typeof b.status !== 'string') return json(res, 404, { ok: false });
        template.status = b.status;
        return json(res, 200, { ok: true });
      }
      const segments = url.pathname.split('/').filter(Boolean);
      const [version, first, second] = segments;
      const entry: RecordedRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        authorization,
        body,
      };
      state.requests.push(entry);
      if (!version || !/^v\d+\.\d+$/.test(version))
        return graphError(res, 400, 2500, 'Unknown path');
      const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
      const tokenValid = (t: string | null) => Boolean(t && state.tokens.get(t)?.valid);

      if (req.method === 'GET' && first === 'oauth' && second === 'access_token') {
        const token = state.codes.get(url.searchParams.get('code') ?? '');
        if (
          !token ||
          url.searchParams.get('client_id') !== state.appId ||
          url.searchParams.get('client_secret') !== state.appSecret
        ) {
          return graphError(res, 400, 100, 'Invalid verification code format.');
        }
        state.codes.delete(url.searchParams.get('code') ?? '');
        return json(res, 200, { access_token: token, token_type: 'bearer' });
      }
      if (req.method === 'GET' && first === 'debug_token') {
        if (url.searchParams.get('access_token') !== `${state.appId}|${state.appSecret}`) {
          return graphError(res, 400, 190, 'Invalid app access token');
        }
        const info = state.tokens.get(url.searchParams.get('input_token') ?? '');
        if (!info) return json(res, 200, { data: { is_valid: false, scopes: [] } });
        return json(res, 200, {
          data: {
            app_id: info.appId,
            is_valid: info.valid,
            scopes: info.scopes,
            ...(info.granular ? { granular_scopes: info.granular } : {}),
            expires_at: 0,
          },
        });
      }
      if (!tokenValid(bearer)) return graphError(res, 401, 190, 'Error validating access token');

      if (req.method === 'GET' && first && second === 'phone_numbers') {
        const numbers = state.wabaNumbers.get(first);
        if (!numbers) return graphError(res, 400, 100, 'Unsupported get request.');
        return json(res, 200, { data: numbers.map((id) => ({ id })) });
      }
      if (req.method === 'POST' && first && second === 'subscribed_apps') {
        return json(res, 200, { success: true });
      }
      if (req.method === 'DELETE' && first && second === 'subscribed_apps') {
        return json(res, 200, { success: true });
      }
      if (req.method === 'POST' && first && second === 'register') {
        if (state.registerError) {
          const e = state.registerError;
          return graphError(res, e.status, e.code, e.message);
        }
        return json(res, 200, { success: true });
      }
      if (req.method === 'POST' && first && second === 'messages') {
        const flowInvalid = flowMessageProblem(body, state.flows);
        if (flowInvalid)
          return graphError(res, 400, 100, `(#100) Invalid parameter: ${flowInvalid}`);
        const productInvalid = productMessageProblem(body, state.catalogProducts);
        if (productInvalid)
          return graphError(res, 400, 100, `(#100) Invalid parameter: ${productInvalid}`);
        const interactiveType = String(
          (body as { interactive?: { type?: unknown } } | undefined)?.interactive?.type ?? '',
        );
        const invalid =
          interactiveType === 'flow' || PRODUCT_TYPES.has(interactiveType)
            ? null
            : interactiveProblem(body);
        if (invalid) return graphError(res, 400, 100, `(#100) Invalid parameter: ${invalid}`);
        const behaviour = state.sendQueue.shift() ?? { kind: 'accept' };
        if (behaviour.kind === 'drop_connection') {
          req.socket.destroy();
          return;
        }
        if (behaviour.kind === 'hang') {
          await new Promise((r) => setTimeout(r, behaviour.ms));
          if (!res.writableEnded) json(res, 200, { messages: [{ id: 'wamid.late' }] });
          return;
        }
        if (behaviour.kind === 'error') {
          return graphError(
            res,
            behaviour.status,
            behaviour.code,
            behaviour.message ?? 'Error',
            behaviour.title,
          );
        }
        state.wamidCounter += 1;
        const wamid = behaviour.wamid ?? `wamid.test.${Date.now()}.${state.wamidCounter}`;
        entry.wamid = wamid;
        const to = String((body as { to?: unknown } | undefined)?.to ?? '');
        return json(res, 200, {
          messaging_product: 'whatsapp',
          contacts: [{ input: to, wa_id: state.waIdFor.get(to) ?? to }],
          messages: [{ id: wamid }],
        });
      }
      if (first && second === 'message_templates') {
        const list = state.templates.get(first) ?? [];
        state.templates.set(first, list);
        if (req.method === 'POST') {
          const b = (body ?? {}) as Record<string, unknown>;
          if (
            typeof b.name !== 'string' ||
            typeof b.language !== 'string' ||
            typeof b.category !== 'string' ||
            !Array.isArray(b.components)
          ) {
            return graphError(res, 400, 100, 'Invalid parameter');
          }
          const behaviour = state.templateCreateQueue.shift() ?? { kind: 'accept' };
          if (behaviour.kind === 'drop_connection') {
            req.socket.destroy();
            return;
          }
          if (behaviour.kind === 'error') {
            return graphError(res, behaviour.status, behaviour.code, behaviour.message);
          }
          if (list.some((t) => t.name === b.name && t.language === b.language)) {
            return graphError(res, 400, 100, 'Content in this language already exists');
          }
          state.templateCounter += 1;
          const created: TemplateFixture = {
            id: String(9_000_000_000 + state.templateCounter),
            name: b.name,
            language: b.language,
            status: behaviour.kind === 'accept' ? (behaviour.status ?? 'PENDING') : 'PENDING',
            category: b.category,
            components: b.components,
          };
          list.push(created);
          if (behaviour.kind === 'create_then_drop') {
            req.socket.destroy();
            return;
          }
          return json(res, 200, {
            id: created.id,
            status: created.status,
            category: created.category,
          });
        }
        if (req.method === 'GET') {
          const fields = url.searchParams.get('fields');
          if (
            state.rejectExtraTemplateFields &&
            fields &&
            /rejected_reason|quality_score/.test(fields)
          ) {
            return graphError(res, 400, 100, 'Tried accessing nonexisting field');
          }
          const limit = Math.min(Number(url.searchParams.get('limit') ?? '25') || 25, 100);
          const after = url.searchParams.get('after');
          const offset = after ? Number(Buffer.from(after, 'base64url').toString('utf8')) : 0;
          const page = list.slice(offset, offset + limit);
          const nextOffset = offset + page.length;
          const cursor = (n: number) => Buffer.from(String(n)).toString('base64url');
          return json(res, 200, {
            data: page,
            paging: {
              cursors: { before: cursor(offset), after: cursor(nextOffset) },
              ...(nextOffset < list.length
                ? { next: `https://graph.example/next?after=${cursor(nextOffset)}` }
                : {}),
            },
          });
        }
        if (req.method === 'DELETE') {
          const name = url.searchParams.get('name');
          const hsmId = url.searchParams.get('hsm_id');
          const index = list.findIndex((t) => t.name === name && (!hsmId || t.id === hsmId));
          if (index < 0) return graphError(res, 400, 100, 'Template not found');
          list.splice(index, 1);
          return json(res, 200, { success: true });
        }
      }
      // Catalogs (research M-172) ---------------------------------------------------------------
      if (
        req.method === 'GET' &&
        first &&
        (second === 'product_catalogs' || second === 'products')
      ) {
        if (state.catalogError) {
          return graphError(
            res,
            state.catalogError.status,
            state.catalogError.code,
            state.catalogError.message,
          );
        }
        const all =
          second === 'product_catalogs'
            ? (state.catalogs.get(first) ?? [])
            : (state.catalogProducts.get(first) ?? []);
        const limit = Math.min(Number(url.searchParams.get('limit') ?? '25') || 25, 100);
        const start = Number(url.searchParams.get('after') ?? '0') || 0;
        const data = all.slice(start, start + limit);
        const nextStart = start + data.length;
        return json(res, 200, {
          data,
          paging:
            nextStart < all.length
              ? {
                  cursors: { before: String(start), after: String(nextStart) },
                  next: 'https://graph.stand-in/next',
                }
              : { cursors: { before: String(start), after: String(nextStart) } },
        });
      }
      // WhatsApp Flows (research M-161 to M-164) ------------------------------------------------
      if (first && second === 'flows') {
        if (req.method === 'POST') {
          const b = (body ?? {}) as Record<string, unknown>;
          let categories: unknown;
          try {
            categories = JSON.parse(String(b.categories));
          } catch {
            categories = null;
          }
          if (typeof b.name !== 'string' || !b.name || !Array.isArray(categories)) {
            return graphError(res, 400, 100, 'Invalid parameter');
          }
          const behaviour = state.flowCreateQueue.shift() ?? { kind: 'accept' };
          if (behaviour.kind === 'drop_connection') {
            req.socket.destroy();
            return;
          }
          if (behaviour.kind === 'error') {
            return graphError(res, behaviour.status, behaviour.code, behaviour.message);
          }
          state.flowCounter += 1;
          const flow: FlowFixture = {
            id: String(7_000_000_000 + state.flowCounter),
            wabaId: first,
            name: b.name,
            categories: categories as string[],
            status: 'DRAFT',
            json: null,
            endpointUri: typeof b.endpoint_uri === 'string' ? b.endpoint_uri : null,
            validationErrors: [],
          };
          state.flows.set(flow.id, flow);
          if (behaviour.kind === 'create_then_drop') {
            req.socket.destroy();
            return;
          }
          return json(res, 200, { id: flow.id });
        }
        if (req.method === 'GET') {
          const list = [...state.flows.values()].filter((f) => f.wabaId === first);
          return json(res, 200, {
            data: list.map((f) => ({
              id: f.id,
              name: f.name,
              status: f.status,
              categories: f.categories,
              validation_errors: f.validationErrors,
            })),
            paging: { cursors: { before: 'MA', after: 'MA' } },
          });
        }
      }
      const flow = first ? state.flows.get(first) : undefined;
      if (flow && !second) {
        if (req.method === 'GET') {
          const parsed = parseFlowJson(flow.json);
          const jsonVersion = typeof parsed?.version === 'string' ? parsed.version : null;
          const dataApi =
            typeof parsed?.data_api_version === 'string' ? parsed.data_api_version : null;
          return json(res, 200, {
            id: flow.id,
            name: flow.name,
            status: flow.status,
            categories: flow.categories,
            validation_errors: flow.validationErrors,
            json_version: jsonVersion,
            data_api_version: dataApi,
            data_channel_uri: flow.endpointUri,
            health_status: {
              can_send_message: flow.status === 'BLOCKED' ? 'BLOCKED' : 'AVAILABLE',
              entities: [{ entity_type: 'FLOW', id: flow.id, can_send_message: 'AVAILABLE' }],
            },
            preview: {
              preview_url: `https://business.facebook.com/wa/manage/flows/${flow.id}/preview/?token=stand-in`,
              expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
            },
          });
        }
        if (req.method === 'POST') {
          const b = (body ?? {}) as Record<string, unknown>;
          if (typeof b.name === 'string') flow.name = b.name;
          if (typeof b.categories === 'string')
            flow.categories = JSON.parse(b.categories) as string[];
          flow.endpointUri = typeof b.endpoint_uri === 'string' ? b.endpoint_uri : flow.endpointUri;
          return json(res, 200, { success: true });
        }
        if (req.method === 'DELETE') {
          if (flow.status !== 'DRAFT')
            return graphError(res, 400, 100, 'Only draft flows can be deleted');
          state.flows.delete(flow.id);
          return json(res, 200, { success: true });
        }
      }
      if (flow && second === 'assets' && req.method === 'POST') {
        const b = (body ?? {}) as Record<string, unknown>;
        const file = b.file as { content?: unknown } | undefined;
        if (b.asset_type !== 'FLOW_JSON' || typeof file?.content !== 'string') {
          return graphError(res, 400, 100, 'Invalid parameter');
        }
        if (flow.status !== 'DRAFT') return graphError(res, 400, 100, 'The flow is not a draft');
        flow.json = file.content;
        let errors = state.flowUploadErrors.shift() ?? [];
        try {
          JSON.parse(file.content);
        } catch {
          errors = [
            {
              error: 'INVALID_JSON',
              error_type: 'JSON_SCHEMA_ERROR',
              message: 'Invalid JSON',
              line_start: 1,
              line_end: 1,
              column_start: 1,
              column_end: 1,
            },
          ];
        }
        flow.validationErrors = errors;
        return json(res, 200, { success: true, validation_errors: errors });
      }
      if (flow && second === 'publish' && req.method === 'POST') {
        if (flow.status !== 'DRAFT' || !flow.json || flow.validationErrors.length > 0) {
          return graphError(res, 400, 100, 'The flow cannot be published');
        }
        flow.status = 'PUBLISHED';
        return json(res, 200, { success: true });
      }
      if (flow && second === 'deprecate' && req.method === 'POST') {
        if (flow.status !== 'PUBLISHED')
          return graphError(res, 400, 100, 'Only published flows can be deprecated');
        flow.status = 'DEPRECATED';
        return json(res, 200, { success: true });
      }
      if (first && second === 'whatsapp_business_encryption') {
        if (req.method === 'POST') {
          const pem = (body as Record<string, unknown> | undefined)?.business_public_key;
          if (typeof pem !== 'string' || !pem.includes('BEGIN PUBLIC KEY')) {
            return graphError(res, 400, 100, 'Business public key is invalid');
          }
          state.businessKeys.set(first, { pem, status: state.keySignatureStatus });
          return json(res, 200, { success: true });
        }
        if (req.method === 'GET') {
          const key = state.businessKeys.get(first);
          return json(res, 200, {
            data: key
              ? [{ business_public_key: key.pem, business_public_key_signature_status: key.status }]
              : [],
          });
        }
      }
      if (req.method === 'GET' && first && !second) {
        const number = state.numbers.get(first);
        if (!number) return graphError(res, 400, 100, 'Unsupported get request.');
        return json(res, 200, {
          ...number,
          quality_rating: 'GREEN',
          name_status: 'APPROVED',
          code_verification_status: 'VERIFIED',
          id: first,
        });
      }
      return graphError(res, 400, 2500, 'Unknown path');
    })().catch(() => {
      if (!res.headersSent) json(res, 500, { error: { message: 'stand-in failure', code: 1 } });
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
