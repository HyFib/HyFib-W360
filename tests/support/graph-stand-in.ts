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
        return json(res, 200, {
          messaging_product: 'whatsapp',
          contacts: [{ input: 'x', wa_id: 'x' }],
          messages: [{ id: wamid }],
        });
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
