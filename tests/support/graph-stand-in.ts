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
}

export interface GraphStandIn {
  baseUrl: string;
  state: StandInState;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
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
      if (req.method === 'POST' && first && second === 'register') {
        if (state.registerError) {
          const e = state.registerError;
          return graphError(res, e.status, e.code, e.message);
        }
        return json(res, 200, { success: true });
      }
      if (req.method === 'POST' && first && second === 'messages') {
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
