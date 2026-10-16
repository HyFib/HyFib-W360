/**
 * Minimal typed client for the Meta Graph API endpoints we use (docs/research/meta-whatsapp.md).
 * - Version pinned by configuration (e.g. v26.0).
 * - Tokens travel in the Authorization header, except where Meta documents query parameters
 *   (OAuth code exchange, debug_token). URLs are never logged.
 * - Every call has a timeout and returns a classified result instead of throwing:
 *   `retryable`   the request was rejected in a way that is safe to retry (rate limits, 5xx, or
 *                 a connection that failed before the request could be sent);
 *   `permanent`   do not retry (validation, policy, closed service window...);
 *   `auth`        the token is invalid or revoked (reconnect required);
 *   `unknown`     the request may have reached Meta but no response was received (timeouts,
 *                 resets). Callers must NOT blindly retry sends in this case.
 */
import { clipText, parseExternalJson } from '@w360/core';
import type { FlowValidationError } from '@w360/db';

export type GraphFailureKind = 'retryable' | 'permanent' | 'auth' | 'unknown';

export type GraphResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      kind: GraphFailureKind;
      httpStatus?: number;
      code?: number;
      subcode?: number;
      title: string;
      detail?: string;
    };

export interface RemoteTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: unknown[];
  rejectedReason: string | null;
  qualityScore: string | null;
}

export interface GraphClientOptions {
  baseUrl: string;
  version: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80007, 130429, 131056]);
const TRANSIENT_CODES = new Set([1, 2, 131000]);
const AUTH_CODES = new Set([190, 102, 10]);

/** Errors raised before any bytes reached the server: safe to retry. */
const PRE_SEND_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function causeCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let i = 0; i < 4 && current; i += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function classifyGraphError(
  httpStatus: number,
  body: unknown,
): Extract<GraphResult<never>, { ok: false }> {
  const err = (body as { error?: Record<string, unknown> } | null)?.error ?? {};
  const code = typeof err.code === 'number' ? err.code : undefined;
  const subcode = typeof err.error_subcode === 'number' ? err.error_subcode : undefined;
  const title =
    typeof err.error_user_title === 'string'
      ? err.error_user_title
      : typeof err.type === 'string'
        ? err.type
        : `HTTP ${httpStatus}`;
  const detail = typeof err.message === 'string' ? err.message.slice(0, 500) : undefined;
  let kind: GraphFailureKind;
  if ((code !== undefined && AUTH_CODES.has(code)) || httpStatus === 401) kind = 'auth';
  else if (httpStatus === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code)))
    kind = 'retryable';
  else if (httpStatus >= 500 || (code !== undefined && TRANSIENT_CODES.has(code)))
    kind = 'retryable';
  else kind = 'permanent';
  return {
    ok: false,
    kind,
    httpStatus,
    ...(code !== undefined ? { code } : {}),
    ...(subcode !== undefined ? { subcode } : {}),
    title,
    ...(detail ? { detail } : {}),
  };
}

/** A file part of a multipart request: text (Flow JSON) or bytes (an uploaded file, ADR-218). */
export interface FormFile {
  filename: string;
  contentType: string;
  content: string | Uint8Array<ArrayBuffer>;
}

/** A flow as `GET /{flow-id}` describes it (research M-163). */
export interface RemoteFlow {
  id: string;
  name: string | null;
  status: string | null;
  categories: string[];
  validationErrors: FlowValidationError[];
  jsonVersion: string | null;
  dataApiVersion: string | null;
  health: Record<string, unknown> | null;
  previewUrl: string | null;
  previewExpiresAt: Date | null;
}

/** A catalog connected to a WhatsApp account (research M-172). */
export interface RemoteCatalog {
  id: string;
  name: string | null;
  productCount: number | null;
}

/** A catalog product, with the fields members need to pick it for a message (research M-172). */
export interface RemoteProduct {
  id: string | null;
  retailerId: string;
  name: string;
  description: string | null;
  /** Meta's display text (format not documented). */
  price: string | null;
  currency: string | null;
  availability: string | null;
  reviewStatus: string | null;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Meta's Flow JSON validation errors (research M-162), bounded. */
export function mapFlowValidationErrors(value: unknown): FlowValidationError[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((raw) => {
    if (typeof raw !== 'object' || raw === null) return [];
    const e = raw as Record<string, unknown>;
    const message = str(e.message);
    if (!message) return [];
    return [
      {
        error: (str(e.error) ?? 'ERROR').slice(0, 100),
        errorType: str(e.error_type)?.slice(0, 100) ?? null,
        message: message.slice(0, 1000),
        lineStart: num(e.line_start),
        lineEnd: num(e.line_end),
        columnStart: num(e.column_start),
        columnEnd: num(e.column_end),
      },
    ];
  });
}

function mapRemoteFlow(json: Record<string, unknown>): RemoteFlow | null {
  const id = str(json.id);
  if (!id) return null;
  const preview = (json.preview ?? null) as Record<string, unknown> | null;
  const expires = str(preview?.expires_at);
  const previewUrl = str(preview?.preview_url);
  const health = json.health_status;
  return {
    id,
    name: str(json.name),
    status: str(json.status),
    categories: Array.isArray(json.categories)
      ? json.categories.filter((c): c is string => typeof c === 'string')
      : [],
    validationErrors: mapFlowValidationErrors(json.validation_errors),
    jsonVersion: str(json.json_version),
    dataApiVersion: str(json.data_api_version),
    health:
      typeof health === 'object' && health !== null ? (health as Record<string, unknown>) : null,
    previewUrl: previewUrl && /^https:\/\//.test(previewUrl) ? previewUrl : null,
    previewExpiresAt: expires && !Number.isNaN(Date.parse(expires)) ? new Date(expires) : null,
  };
}

/** Where a file a customer sent can be downloaded for 5 minutes, and what Meta says it is. */
export interface MediaLocation {
  url: string;
  mimeType: string | null;
  fileSize: number | null;
}

/**
 * How long a whole download may take, however slowly the member's browser reads it: Meta's files
 * are at most 100 MB (research M-049).
 */
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 300_000;

/** How long an upload of a file a member sends may take (at most 16 MB, ADR-218). */
export const MEDIA_UPLOAD_TIMEOUT_MS = 120_000;

/** A product token in the form of the User-Agent pattern in Meta's OpenAPI description. */
const MEDIA_USER_AGENT = 'HyFib-W360/1.0.0';

export type MediaDownload =
  | {
      ok: true;
      body: ReadableStream<Uint8Array>;
      /** The length Meta gives for the bytes of `body`: none for a compressed response. */
      contentLength: number | null;
    }
  | { ok: false; kind: GraphFailureKind; httpStatus?: number; title: string };

export class GraphClient {
  private readonly base: string;
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GraphClientOptions) {
    if (!/^v\d+\.\d+$/.test(options.version)) throw new Error('Invalid Graph API version');
    this.base = `${options.baseUrl.replace(/\/$/, '')}/${options.version}`;
    this.origin = new URL(options.baseUrl).origin;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: {
      token?: string;
      query?: Record<string, string>;
      body?: unknown;
      /** Multipart form data (Flows endpoints take form fields and files, research M-161). */
      form?: Record<string, string | FormFile>;
      /** A longer limit than the client's, for an upload. */
      timeoutMs?: number;
    },
    map: (json: Record<string, unknown>) => T | null,
  ): Promise<GraphResult<T>> {
    const url = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    let body: string | FormData | undefined;
    if (options.form) {
      // fetch sets the multipart content type with its boundary.
      const form = new FormData();
      for (const [k, v] of Object.entries(options.form)) {
        if (typeof v === 'string') form.append(k, v);
        else form.append(k, new Blob([v.content], { type: v.contentType }), v.filename);
      }
      body = form;
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const code = causeCode(error);
      if (code && PRE_SEND_ERROR_CODES.has(code)) {
        return { ok: false, kind: 'retryable', title: 'connection_failed', detail: code };
      }
      return {
        ok: false,
        kind: 'unknown',
        title: 'no_response',
        ...(code ? { detail: code } : {}),
      };
    }
    let json: unknown;
    try {
      json = parseExternalJson(await response.text());
    } catch {
      if (response.ok)
        return {
          ok: false,
          kind: 'unknown',
          httpStatus: response.status,
          title: 'unreadable_response',
        };
      return classifyGraphError(response.status, null);
    }
    if (!response.ok) return classifyGraphError(response.status, json);
    const mapped =
      typeof json === 'object' && json !== null ? map(json as Record<string, unknown>) : null;
    if (mapped === null)
      return {
        ok: false,
        kind: 'unknown',
        httpStatus: response.status,
        title: 'unexpected_response_shape',
      };
    return { ok: true, data: mapped };
  }

  /** POST /{phone-number-id}/messages */
  sendMessage(phoneNumberId: string, token: string, body: Record<string, unknown>) {
    return this.request(
      'POST',
      `/${encodeURIComponent(phoneNumberId)}/messages`,
      { token, body },
      (json) => {
        const messages = json.messages as { id?: unknown }[] | undefined;
        const id = messages?.[0]?.id;
        if (typeof id !== 'string' || id.length === 0) return null;
        // The WhatsApp id Meta resolved the recipient to (it can differ from the number sent).
        const waId = (json.contacts as { wa_id?: unknown }[] | undefined)?.[0]?.wa_id;
        return {
          messageId: id,
          waId: typeof waId === 'string' && /^[0-9]{6,20}$/.test(waId) ? waId : null,
        };
      },
    );
  }

  /**
   * POST /{phone-number-id}/messages with `status: read` (research M-045): marks the customer's
   * message read and, with `typing`, shows the customer a typing indicator. Meta answers
   * `success: true`.
   */
  markRead(phoneNumberId: string, token: string, input: { messageId: string; typing: boolean }) {
    return this.request(
      'POST',
      `/${encodeURIComponent(phoneNumberId)}/messages`,
      {
        token,
        body: {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: input.messageId,
          ...(input.typing ? { typing_indicator: { type: 'text' } } : {}),
        },
      },
      (json) => (json.success === true ? { read: true as const } : null),
    );
  }

  /** POST /{waba-id}/message_templates (response: id, status, category). */
  createTemplate(wabaId: string, token: string, body: Record<string, unknown>) {
    return this.request(
      'POST',
      `/${encodeURIComponent(wabaId)}/message_templates`,
      { token, body },
      (json) =>
        typeof json.id === 'string' && json.id.length > 0
          ? {
              id: json.id,
              status: typeof json.status === 'string' ? json.status : null,
              category: typeof json.category === 'string' ? json.category : null,
            }
          : null,
    );
  }

  /**
   * GET /{waba-id}/message_templates, one page (Graph cursor pagination: `after`, `limit`).
   * `fields` null requests Meta's default fields.
   */
  listTemplates(
    wabaId: string,
    token: string,
    options: { after?: string | null; fields?: string | null; limit?: number } = {},
  ) {
    const query: Record<string, string> = { limit: String(options.limit ?? 100) };
    if (options.fields) query.fields = options.fields;
    if (options.after) query.after = options.after;
    return this.request(
      'GET',
      `/${encodeURIComponent(wabaId)}/message_templates`,
      { token, query },
      (json) => {
        if (!Array.isArray(json.data)) return null;
        const templates: RemoteTemplate[] = [];
        for (const raw of json.data as Record<string, unknown>[]) {
          if (
            typeof raw.id !== 'string' ||
            typeof raw.name !== 'string' ||
            typeof raw.language !== 'string' ||
            typeof raw.status !== 'string' ||
            typeof raw.category !== 'string'
          ) {
            continue;
          }
          const quality = raw.quality_score as { score?: unknown } | string | undefined;
          templates.push({
            id: raw.id,
            name: raw.name,
            language: raw.language,
            status: raw.status,
            category: raw.category,
            components: Array.isArray(raw.components) ? raw.components : [],
            rejectedReason: typeof raw.rejected_reason === 'string' ? raw.rejected_reason : null,
            qualityScore:
              typeof quality === 'string'
                ? quality
                : typeof quality?.score === 'string'
                  ? quality.score
                  : null,
          });
        }
        const paging = json.paging as { next?: unknown; cursors?: { after?: unknown } } | undefined;
        const after = paging?.cursors?.after;
        return {
          templates,
          skipped: (json.data as unknown[]).length - templates.length,
          after: typeof paging?.next === 'string' && typeof after === 'string' ? after : null,
        };
      },
    );
  }

  /** DELETE /{waba-id}/message_templates?name=&hsm_id= (one language version of a template). */
  deleteTemplate(wabaId: string, token: string, template: { name: string; hsmId: string }) {
    return this.request(
      'DELETE',
      `/${encodeURIComponent(wabaId)}/message_templates`,
      { token, query: { name: template.name, hsm_id: template.hsmId } },
      (json) => (json.success === true ? { deleted: true } : null),
    );
  }

  // WhatsApp Flows (research M-097, M-161 to M-164) ------------------------------------------------

  /** POST /{waba-id}/flows (multipart: name, categories as a JSON array, endpoint_uri). */
  createFlow(
    wabaId: string,
    token: string,
    flow: { name: string; categories: string[]; endpointUri: string | null },
  ) {
    return this.request(
      'POST',
      `/${encodeURIComponent(wabaId)}/flows`,
      {
        token,
        form: {
          name: flow.name,
          categories: JSON.stringify(flow.categories),
          ...(flow.endpointUri ? { endpoint_uri: flow.endpointUri } : {}),
        },
      },
      (json) => (typeof json.id === 'string' && json.id.length > 0 ? { id: json.id } : null),
    );
  }

  /** GET /{waba-id}/flows, one page (id, name, status). */
  listFlows(wabaId: string, token: string, page: { after?: string | null } = {}) {
    return this.request(
      'GET',
      `/${encodeURIComponent(wabaId)}/flows`,
      {
        token,
        query: {
          fields: 'id,name,status',
          limit: '100',
          ...(page.after ? { after: page.after } : {}),
        },
      },
      (json) => {
        if (!Array.isArray(json.data)) return null;
        const flows = (json.data as Record<string, unknown>[]).flatMap((f) =>
          typeof f?.id === 'string' ? [{ id: f.id, name: str(f.name), status: str(f.status) }] : [],
        );
        const paging = (json.paging ?? {}) as { cursors?: { after?: unknown }; next?: unknown };
        const after = typeof paging.next === 'string' ? str(paging.cursors?.after) : null;
        return { flows, after };
      },
    );
  }

  /** GET /{waba-id}/product_catalogs: the catalogs connected to the WhatsApp account (M-172). */
  listProductCatalogs(wabaId: string, token: string, page: { after?: string | null } = {}) {
    return this.request(
      'GET',
      `/${encodeURIComponent(wabaId)}/product_catalogs`,
      {
        token,
        query: {
          fields: 'id,name,product_count',
          limit: '25',
          ...(page.after ? { after: page.after } : {}),
        },
      },
      (json) => {
        if (!Array.isArray(json.data)) return null;
        const catalogs = (json.data as Record<string, unknown>[]).flatMap((c): RemoteCatalog[] => {
          const id = str(c?.id);
          if (!id || !/^[0-9]{1,32}$/.test(id)) return [];
          const name = str(c.name);
          return [
            {
              id,
              name: name === null ? null : clipText(name, 200),
              productCount: num(c.product_count),
            },
          ];
        });
        const paging = (json.paging ?? {}) as { cursors?: { after?: unknown }; next?: unknown };
        const after = typeof paging.next === 'string' ? str(paging.cursors?.after) : null;
        return { catalogs, after };
      },
    );
  }

  /** GET /{catalog-id}/products, one page (M-172). */
  listCatalogProducts(catalogId: string, token: string, page: { after?: string | null } = {}) {
    return this.request(
      'GET',
      `/${encodeURIComponent(catalogId)}/products`,
      {
        token,
        query: {
          fields: 'id,retailer_id,name,description,price,currency,availability,review_status',
          limit: '100',
          ...(page.after ? { after: page.after } : {}),
        },
      },
      (json) => {
        if (!Array.isArray(json.data)) return null;
        const clip = (v: unknown, max: number) => {
          const t = str(v)?.trim();
          return t ? clipText(t, max) : null;
        };
        const products = (json.data as Record<string, unknown>[]).flatMap((p): RemoteProduct[] => {
          const retailerId = str(p?.retailer_id);
          const name = clip(p?.name, 200);
          if (!retailerId || retailerId.length > 100 || !name) return [];
          const id = str(p.id);
          const currency = str(p.currency);
          return [
            {
              id: id && /^[0-9]{1,32}$/.test(id) ? id : null,
              retailerId,
              name,
              description: clip(p.description, 1000),
              price: clip(p.price, 64),
              currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
              availability: clip(p.availability, 40),
              reviewStatus: clip(p.review_status, 40),
            },
          ];
        });
        const paging = (json.paging ?? {}) as { cursors?: { after?: unknown }; next?: unknown };
        const after = typeof paging.next === 'string' ? str(paging.cursors?.after) : null;
        return { products, after };
      },
    );
  }

  /** POST /{flow-id} (multipart: name, categories, endpoint_uri). */
  updateFlowMetadata(
    flowId: string,
    token: string,
    metadata: { name: string; categories: string[]; endpointUri: string | null },
  ) {
    return this.request(
      'POST',
      `/${encodeURIComponent(flowId)}`,
      {
        token,
        form: {
          name: metadata.name,
          categories: JSON.stringify(metadata.categories),
          ...(metadata.endpointUri ? { endpoint_uri: metadata.endpointUri } : {}),
        },
      },
      (json) => (json.success === true ? { updated: true } : null),
    );
  }

  /** POST /{flow-id}/assets: uploads the Flow JSON and returns Meta's validation errors. */
  uploadFlowJson(flowId: string, token: string, json: string) {
    return this.request(
      'POST',
      `/${encodeURIComponent(flowId)}/assets`,
      {
        token,
        form: {
          asset_type: 'FLOW_JSON',
          name: 'flow.json',
          file: { filename: 'flow.json', contentType: 'application/json', content: json },
        },
      },
      (res) =>
        res.success === true
          ? { validationErrors: mapFlowValidationErrors(res.validation_errors) }
          : null,
    );
  }

  /** POST /{flow-id}/publish (irreversible). */
  publishFlow(flowId: string, token: string) {
    return this.request('POST', `/${encodeURIComponent(flowId)}/publish`, { token }, (json) =>
      json.success === true ? { published: true } : null,
    );
  }

  /** POST /{flow-id}/deprecate (published flows only; irreversible). */
  deprecateFlow(flowId: string, token: string) {
    return this.request('POST', `/${encodeURIComponent(flowId)}/deprecate`, { token }, (json) =>
      json.success === true ? { deprecated: true } : null,
    );
  }

  /** DELETE /{flow-id} (DRAFT flows only). */
  deleteFlow(flowId: string, token: string) {
    return this.request('DELETE', `/${encodeURIComponent(flowId)}`, { token }, (json) =>
      json.success === true ? { deleted: true } : null,
    );
  }

  /** GET /{flow-id} with the fields HyFib shows. */
  getFlow(flowId: string, token: string) {
    return this.request(
      'GET',
      `/${encodeURIComponent(flowId)}`,
      {
        token,
        query: {
          fields:
            'id,name,status,categories,validation_errors,json_version,data_api_version,health_status,preview',
        },
      },
      mapRemoteFlow,
    );
  }

  /** POST /{phone-number-id}/whatsapp_business_encryption (replaces the number's key, M-164). */
  setBusinessPublicKey(phoneNumberId: string, token: string, publicKeyPem: string) {
    return this.request(
      'POST',
      `/${encodeURIComponent(phoneNumberId)}/whatsapp_business_encryption`,
      { token, form: { business_public_key: publicKeyPem } },
      (json) => (json.success === true ? { uploaded: true } : null),
    );
  }

  /** GET /{phone-number-id}/whatsapp_business_encryption: the key Meta has and its signature status. */
  getBusinessPublicKey(phoneNumberId: string, token: string) {
    return this.request(
      'GET',
      `/${encodeURIComponent(phoneNumberId)}/whatsapp_business_encryption`,
      { token },
      (json) => {
        if (!Array.isArray(json.data)) return null;
        const first = (json.data[0] ?? {}) as Record<string, unknown>;
        const status = str(first.business_public_key_signature_status);
        const signatureStatus: 'VALID' | 'MISMATCH' | null =
          status === 'VALID' || status === 'MISMATCH' ? status : null;
        return { publicKeyPem: str(first.business_public_key)?.trim() || null, signatureStatus };
      },
    );
  }

  /** GET /oauth/access_token (Embedded Signup code exchange; the code is valid for 30 seconds). */
  exchangeCode(appId: string, appSecret: string, code: string) {
    return this.request(
      'GET',
      '/oauth/access_token',
      { query: { client_id: appId, client_secret: appSecret, code } },
      (json) => (typeof json.access_token === 'string' ? { accessToken: json.access_token } : null),
    );
  }

  /** GET /debug_token with an app access token ("app_id|app_secret"). */
  debugToken(inputToken: string, appId: string, appSecret: string) {
    return this.request(
      'GET',
      '/debug_token',
      { query: { input_token: inputToken, access_token: `${appId}|${appSecret}` } },
      (json) => {
        const data = json.data as Record<string, unknown> | undefined;
        if (!data) return null;
        const granular = Array.isArray(data.granular_scopes)
          ? (data.granular_scopes as { scope?: unknown; target_ids?: unknown }[]).map((g) => ({
              scope: String(g.scope ?? ''),
              targetIds: Array.isArray(g.target_ids) ? g.target_ids.map(String) : [],
            }))
          : [];
        // `error`: what a request with the token would get (research M-187); its code only.
        const error = data.error as { code?: unknown } | undefined;
        return {
          appId: typeof data.app_id === 'string' ? data.app_id : String(data.app_id ?? ''),
          isValid: data.is_valid === true,
          scopes: Array.isArray(data.scopes) ? data.scopes.map(String) : [],
          granularScopes: granular,
          expiresAt:
            typeof data.expires_at === 'number' && data.expires_at > 0
              ? new Date(data.expires_at * 1000)
              : null,
          errorCode: num(error?.code),
        };
      },
    );
  }

  /** GET /{waba-id}/phone_numbers */
  listPhoneNumbers(wabaId: string, token: string) {
    return this.request('GET', `/${encodeURIComponent(wabaId)}/phone_numbers`, { token }, (json) =>
      Array.isArray(json.data)
        ? { ids: (json.data as { id?: unknown }[]).map((p) => String(p.id ?? '')) }
        : null,
    );
  }

  /** GET /{phone-number-id}?fields=... */
  getPhoneNumber(phoneNumberId: string, token: string) {
    return this.request(
      'GET',
      `/${encodeURIComponent(phoneNumberId)}`,
      {
        token,
        query: {
          fields:
            'display_phone_number,verified_name,quality_rating,name_status,code_verification_status',
        },
      },
      (json) => ({
        displayPhoneNumber:
          typeof json.display_phone_number === 'string' ? json.display_phone_number : null,
        verifiedName: typeof json.verified_name === 'string' ? json.verified_name : null,
        qualityRating: typeof json.quality_rating === 'string' ? json.quality_rating : null,
        nameStatus: typeof json.name_status === 'string' ? json.name_status : null,
        codeVerificationStatus:
          typeof json.code_verification_status === 'string' ? json.code_verification_status : null,
      }),
    );
  }

  /** POST /{waba-id}/subscribed_apps */
  subscribeApp(wabaId: string, token: string) {
    return this.request(
      'POST',
      `/${encodeURIComponent(wabaId)}/subscribed_apps`,
      { token, body: {} },
      (json) => (json.success === true ? { subscribed: true } : null),
    );
  }

  /**
   * GET /{waba-id}/subscribed_apps: the ids of the apps subscribed to the account's webhooks
   * (operation `getAllSubscriptionsForAWaba` in Meta's official OpenAPI description, research
   * M-190). Its examples put each app under `whatsapp_business_api_data` while its schema puts `id`
   * in the item itself, so both are read; an answer without a `data` list is not understood. The
   * list is not `complete` when an app's id cannot be read or Meta says another page follows: such
   * a list cannot tell that an app is missing from it.
   */
  listSubscribedApps(wabaId: string, token: string) {
    return this.request(
      'GET',
      `/${encodeURIComponent(wabaId)}/subscribed_apps`,
      { token },
      (json) => {
        if (!Array.isArray(json.data)) return null;
        const appIds: string[] = [];
        let complete = true;
        for (const item of json.data as unknown[]) {
          const entry = (typeof item === 'object' && item !== null ? item : {}) as {
            id?: unknown;
            whatsapp_business_api_data?: { id?: unknown } | null;
          };
          const id = entry.whatsapp_business_api_data?.id ?? entry.id;
          if (typeof id === 'string' && id.length > 0) appIds.push(id);
          else if (Number.isSafeInteger(id)) appIds.push(String(id));
          else complete = false;
        }
        if (typeof (json.paging as { next?: unknown } | null | undefined)?.next === 'string') {
          complete = false;
        }
        return { appIds, complete };
      },
    );
  }

  /**
   * DELETE /{waba-id}/subscribed_apps: stops this app's webhooks for the account (operation
   * `unsubscribeFromWabaWebhooks` in Meta's official OpenAPI description). Used when a company is
   * deleted (ADR-055).
   */
  unsubscribeApp(wabaId: string, token: string) {
    return this.request(
      'DELETE',
      `/${encodeURIComponent(wabaId)}/subscribed_apps`,
      { token },
      (json) => (json.success === true ? { unsubscribed: true } : null),
    );
  }

  /** POST /{phone-number-id}/register with a six-digit two-step verification PIN. */
  registerNumber(phoneNumberId: string, token: string, pin: string) {
    if (!/^\d{6}$/.test(pin)) throw new Error('PIN must be six digits');
    return this.request(
      'POST',
      `/${encodeURIComponent(phoneNumberId)}/register`,
      { token, body: { messaging_product: 'whatsapp', pin } },
      (json) => (json.success === true ? { registered: true } : null),
    );
  }

  /**
   * POST /{phone-number-id}/media: uploads a file for the number to send, as multipart form data
   * with `messaging_product` and `file`, whose part carries the file's type (operation
   * `uploadImage` in Meta's official OpenAPI description, research M-046, M-197). Meta answers the
   * media's `id`, which a message names in place of a link. An upload that times out may have
   * reached Meta: the media it left is never sent and Meta deletes it (M-046).
   */
  uploadMedia(
    phoneNumberId: string,
    token: string,
    file: { filename: string; contentType: string; bytes: Uint8Array<ArrayBuffer> },
  ) {
    return this.request(
      'POST',
      `/${encodeURIComponent(phoneNumberId)}/media`,
      {
        token,
        form: {
          messaging_product: 'whatsapp',
          file: { filename: file.filename, contentType: file.contentType, content: file.bytes },
        },
        timeoutMs: MEDIA_UPLOAD_TIMEOUT_MS,
      },
      (json) => (typeof json.id === 'string' && json.id.length > 0 ? { mediaId: json.id } : null),
    );
  }

  /**
   * GET /{media-id}: where a file a customer sent can be downloaded, for 5 minutes (operation
   * `retrieveMediaUrl` in Meta's official OpenAPI description, research M-047). Its example gives
   * `file_size` as text; a number is read too.
   */
  getMedia(mediaId: string, token: string) {
    return this.request(
      'GET',
      `/${encodeURIComponent(mediaId)}`,
      { token },
      (json): MediaLocation | null => {
        const url = str(json.url);
        if (!url) return null;
        const size = json.file_size;
        const fileSize =
          typeof size === 'number' && Number.isSafeInteger(size) && size >= 0
            ? size
            : typeof size === 'string' && /^\d{1,15}$/.test(size)
              ? Number(size)
              : null;
        return { url, mimeType: str(json.mime_type), fileSize };
      },
    );
  }

  /**
   * Downloads a file from the address `getMedia` gave, with the account's token in the
   * Authorization header (operation `downloadMedia`, research M-047, M-196). The token goes only to
   * an https address, or to the configured Graph origin itself (the test stand-in), and redirects
   * are refused, so it reaches no other host. The caller reads or cancels the body.
   */
  async downloadMedia(url: string, token: string): Promise<MediaDownload> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return { ok: false, kind: 'permanent', title: 'unusable_media_url' };
    }
    if (
      target.username !== '' ||
      target.password !== '' ||
      (target.protocol !== 'https:' && target.origin !== this.origin)
    ) {
      return { ok: false, kind: 'permanent', title: 'unusable_media_url' };
    }
    let response: Response;
    try {
      response = await this.fetchImpl(target, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, 'user-agent': MEDIA_USER_AGENT },
        signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (error) {
      const code = causeCode(error);
      return {
        ok: false,
        kind: code && PRE_SEND_ERROR_CODES.has(code) ? 'retryable' : 'unknown',
        title: code && PRE_SEND_ERROR_CODES.has(code) ? 'connection_failed' : 'no_response',
      };
    }
    const type = (response.headers.get('content-type') ?? '')
      .split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    // An error page instead of the file (the description says the file comes with its own type).
    if (response.status !== 200 || !response.body || type === 'text/html') {
      await response.body?.cancel();
      return {
        ok: false,
        kind:
          response.status === 401
            ? 'auth'
            : response.status === 429 || response.status >= 500
              ? 'retryable'
              : 'permanent',
        httpStatus: response.status,
        title: response.status === 200 ? 'not_a_file' : `HTTP ${response.status}`,
      };
    }
    const length = response.headers.get('content-length');
    // fetch decompresses a compressed response, whose length is then not that of the bytes read.
    const encoding = (response.headers.get('content-encoding') ?? '').trim().toLowerCase();
    return {
      ok: true,
      body: response.body,
      contentLength:
        (encoding === '' || encoding === 'identity') && length && /^\d{1,15}$/.test(length)
          ? Number(length)
          : null,
    };
  }
}
