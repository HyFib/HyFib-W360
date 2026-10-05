import { clipText, type Clock, type Keyring } from '@w360/core';
import { EgressError, type EgressClient } from '@w360/core/egress';
import {
  and,
  authorizedTenantScope,
  contacts,
  eq,
  flowKeys,
  flowSends,
  flows,
  httpAllowedDomains,
  httpSecrets,
  inArray,
  sql,
  systemScope,
  type Database,
} from '@w360/db';
import { hostAllowed } from '../automations/graph';
import { httpSecretAad } from '../automations/http';
import { verifyMetaSignature } from '../messaging/signature';
import {
  FlowDecryptError,
  decryptFlowRequest,
  encryptFlowResponse,
  isEncryptedFlowRequest,
  privateKeyFromPem,
} from './crypto';
import { FLOW_PUBLIC_ID_RE, FLOW_TOKEN_RE, flowKeyAad } from './model';

/**
 * HyFib's data endpoint for WhatsApp Flows (/api/flows/endpoint/<public id>), the flow's
 * endpoint_uri at Meta. WhatsApp signs each request with the app secret and encrypts it with the
 * WhatsApp account's public key (research M-100 to M-103, M-167). HyFib checks the signature (432),
 * decrypts with the account's current or previous key (421 when neither works), answers health
 * checks and error notifications itself, checks that the flow token is one HyFib issued for this
 * flow and has not expired (427 with a message otherwise), and forwards the request as plain JSON to
 * the company's endpoint on an allowed domain through the egress guard. The company's answer is
 * encrypted and returned. Requests are forwarded at least once: WhatsApp may repeat them.
 */

export interface FlowEndpointDeps {
  db: Database;
  keyring: Keyring;
  clock: Clock;
  /** Current and previous app secrets (webhook signature secrets). */
  appSecrets: string[];
  /** An egress client whose time limit leaves room within WhatsApp's wait for the answer. */
  egress: EgressClient;
}

export interface FlowEndpointResult {
  status: number;
  /** Base64 text of the encrypted answer, or null for an empty body. */
  body: string | null;
  /** For the log line (codes and ids only, never answers or contact details). */
  log: { outcome: string; tenantId?: string; flowId?: string; action?: string; detail?: string };
}

/** HyFib's limit on a company endpoint's answer. */
export const MAX_ENDPOINT_ANSWER_BYTES = 64 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The lower-case host of a stored endpoint address, or null when it does not parse. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const empty = (status: number, log: FlowEndpointResult['log']): FlowEndpointResult => ({
  status,
  body: null,
  log,
});

export async function handleFlowEndpoint(
  deps: FlowEndpointDeps,
  input: { publicId: string; rawBody: Buffer; signature: string | null },
): Promise<FlowEndpointResult> {
  if (!verifyMetaSignature(input.rawBody, input.signature, deps.appSecrets)) {
    return empty(432, { outcome: 'bad_signature' });
  }
  if (!FLOW_PUBLIC_ID_RE.test(input.publicId)) return empty(404, { outcome: 'unknown_flow' });
  let envelope: unknown;
  try {
    envelope = JSON.parse(input.rawBody.toString('utf8'));
  } catch {
    return empty(400, { outcome: 'malformed' });
  }
  if (!isEncryptedFlowRequest(envelope)) return empty(400, { outcome: 'malformed' });

  const targetRes = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ tenant_id: string; flow_id: string; tenant_status: string }>(
        sql`select tenant_id, flow_id, tenant_status from ops.flow_endpoint_target(${input.publicId})`,
      ),
    { accessMode: 'read only' },
  );
  const target = targetRes.rows[0];
  if (!target) return empty(404, { outcome: 'unknown_flow' });
  // The signature proves the request comes from WhatsApp, and the public id names this company's
  // flow: a verified provider mapping, so the rest runs in the company's scope.
  const scope = authorizedTenantScope(target.tenant_id, null);
  const ids = { tenantId: target.tenant_id, flowId: target.flow_id };

  const loaded = await deps.db.run(
    scope,
    async (tx) => {
      const [flow] = await tx
        .select({
          id: flows.id,
          name: flows.name,
          whatsappAccountId: flows.whatsappAccountId,
          endpointUrl: flows.endpointUrl,
          endpointSecretName: flows.endpointSecretName,
        })
        .from(flows)
        .where(and(eq(flows.tenantId, scope.tenantId), eq(flows.id, target.flow_id)));
      if (!flow) return null;
      const keys = await tx
        .select({
          id: flowKeys.id,
          ciphertext: flowKeys.privateKeyCiphertext,
          state: flowKeys.state,
        })
        .from(flowKeys)
        .where(
          and(
            eq(flowKeys.tenantId, scope.tenantId),
            eq(flowKeys.whatsappAccountId, flow.whatsappAccountId),
            inArray(flowKeys.state, ['active', 'previous']),
          ),
        );
      return { flow, keys };
    },
    { accessMode: 'read only' },
  );
  if (!loaded) return empty(404, { ...ids, outcome: 'unknown_flow' });
  const privateKeys = loaded.keys
    .sort((a, b) => (a.state === 'active' ? -1 : b.state === 'active' ? 1 : 0))
    .flatMap((k) =>
      k.ciphertext
        ? [
            privateKeyFromPem(
              deps.keyring.decryptString(k.ciphertext, flowKeyAad(scope.tenantId, k.id)),
            ),
          ]
        : [],
    );

  let request;
  try {
    request = decryptFlowRequest(envelope, privateKeys);
  } catch (error) {
    if (error instanceof FlowDecryptError) return empty(421, { ...ids, outcome: 'decrypt_failed' });
    throw error;
  }
  const answer = (status: number, response: unknown, log: FlowEndpointResult['log']) => ({
    status,
    body: encryptFlowResponse(response, request.aesKey, request.iv),
    log,
  });
  const body = isObject(request.body) ? request.body : {};
  const action = typeof body.action === 'string' ? body.action.slice(0, 32) : 'unknown';
  const logBase = { ...ids, action };

  // Health check (research M-103): answered by HyFib, it shows the endpoint and key work.
  if (action === 'ping')
    return answer(200, { data: { status: 'active' } }, { ...logBase, outcome: 'ping' });
  const data = isObject(body.data) ? body.data : {};
  // A client error notification is acknowledged (it is logged with its code only).
  if (data.error !== undefined) {
    const code = typeof data.error === 'string' ? data.error.slice(0, 64) : 'error';
    return answer(
      200,
      { data: { acknowledged: true } },
      { ...logBase, outcome: 'error_notice', detail: code },
    );
  }

  const token = typeof body.flow_token === 'string' ? body.flow_token : '';
  const unavailable = (message: string, outcome: string) =>
    answer(427, { error_msg: message }, { ...logBase, outcome });
  if (target.tenant_status !== 'active') {
    return unavailable('This form is not available right now.', 'company_suspended');
  }
  if (!FLOW_TOKEN_RE.test(token))
    return unavailable('This form is no longer available.', 'token_invalid');

  const context = await deps.db.run(
    scope,
    async (tx) => {
      const [send] = await tx
        .select({
          id: flowSends.id,
          expiresAt: flowSends.expiresAt,
          contactId: contacts.id,
          name: contacts.displayName,
          phone: contacts.phoneE164,
        })
        .from(flowSends)
        .innerJoin(
          contacts,
          and(eq(contacts.tenantId, flowSends.tenantId), eq(contacts.id, flowSends.contactId)),
        )
        .where(
          and(
            eq(flowSends.tenantId, scope.tenantId),
            eq(flowSends.flowId, loaded.flow.id),
            eq(flowSends.token, token),
          ),
        );
      if (!send || send.expiresAt <= deps.clock.now())
        return { send: null, domains: [], secret: null };
      const domains = await tx
        .select({ domain: httpAllowedDomains.domain })
        .from(httpAllowedDomains)
        .where(eq(httpAllowedDomains.tenantId, scope.tenantId));
      const [secret] = loaded.flow.endpointSecretName
        ? await tx
            .select({
              id: httpSecrets.id,
              domain: httpSecrets.domain,
              ciphertext: httpSecrets.valueCiphertext,
            })
            .from(httpSecrets)
            .where(
              and(
                eq(httpSecrets.tenantId, scope.tenantId),
                eq(httpSecrets.name, loaded.flow.endpointSecretName),
              ),
            )
        : [];
      return { send, domains: domains.map((d) => d.domain), secret: secret ?? null };
    },
    { accessMode: 'read only' },
  );
  if (!context.send) return unavailable('This form is no longer available.', 'token_invalid');

  // The company's endpoint, checked against the current settings on every request.
  const endpoint = loaded.flow.endpointUrl;
  const host = endpoint ? hostOf(endpoint) : null;
  if (!endpoint || !host) return empty(500, { ...logBase, outcome: 'endpoint_not_set' });
  if (!hostAllowed(host, context.domains)) {
    return empty(500, { ...logBase, outcome: 'endpoint_domain_not_allowed' });
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (loaded.flow.endpointSecretName) {
    if (!context.secret) return empty(500, { ...logBase, outcome: 'endpoint_secret_missing' });
    if (!hostAllowed(host, [context.secret.domain])) {
      return empty(500, { ...logBase, outcome: 'endpoint_secret_domain_mismatch' });
    }
    const value = deps.keyring.decryptString(
      context.secret.ciphertext,
      httpSecretAad(scope.tenantId, context.secret.id),
    );
    headers.authorization = `Bearer ${value}`;
  }

  const forwarded = JSON.stringify({
    version: typeof body.version === 'string' ? body.version : null,
    action,
    screen: typeof body.screen === 'string' ? body.screen : null,
    data,
    flow_token: token,
    flow: { id: loaded.flow.id, name: loaded.flow.name },
    contact: {
      id: context.send.contactId,
      name: context.send.name,
      phone: context.send.phone,
    },
  });
  let res;
  try {
    res = await deps.egress.request({ method: 'POST', url: endpoint, headers, body: forwarded });
  } catch (error) {
    const code = error instanceof EgressError ? error.code : 'egress_failed';
    return empty(500, { ...logBase, outcome: 'endpoint_failed', detail: code });
  }
  if (res.body.length > MAX_ENDPOINT_ANSWER_BYTES) {
    return empty(500, { ...logBase, outcome: 'endpoint_answer_too_large' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body.toString('utf8'));
  } catch {
    return empty(500, {
      ...logBase,
      outcome: 'endpoint_answer_not_json',
      detail: String(res.status),
    });
  }
  // The company may refuse the token itself (an order already handled, a session expired).
  if (res.status === 427 && isObject(parsed) && typeof parsed.error_msg === 'string') {
    return unavailable(clipText(parsed.error_msg, 500), 'endpoint_token_refused');
  }
  if (res.status < 200 || res.status > 299 || !isObject(parsed)) {
    return empty(500, { ...logBase, outcome: 'endpoint_failed', detail: String(res.status) });
  }
  return answer(200, parsed, { ...logBase, outcome: 'forwarded', detail: String(res.status) });
}
