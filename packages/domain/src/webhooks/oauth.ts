import {
  constants,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from 'node:crypto';
import { EgressError, type EgressClient, type EgressRequest } from '@w360/core/egress';
import type { WebhookOAuthClientAuth, WebhookOAuthKeyAlgorithm } from '@w360/db';
import { randomToken, TOKEN_ALPHABET } from '../growth/model';
import { WEBHOOK_LIMITS, type WebhookOAuthCertificate, type WebhookOAuthPublicKey } from './model';
import { readWebhookOAuthCertificate } from './x509';

/**
 * OAuth 2.0 client credentials for webhook endpoints (ADR-173). An endpoint may get an access token
 * from its receiver's authorization server and send it as a bearer token with every delivery: the
 * token request of RFC 6749 section 4.4 (`grant_type=client_credentials`, the client authenticated
 * as section 2.3.1 says, with HTTP Basic or, for a server that wants them there, its credentials in
 * the request body, ADR-357, or with a JWT signed with its secret, RFC 7523, ADR-366, or with a
 * private key HyFib keeps, ADR-367) and the bearer usage of RFC 6750 section 2.1. Only what a client
 * needs is here: the request, reading the answer of section 5.1 or the refusal of 5.2, and the
 * tokens a worker keeps in memory.
 */

/** Binds an endpoint's OAuth client secret to its company and the endpoint. */
export const webhookOAuthSecretAad = (tenantId: string, endpointId: string) =>
  `webhook-oauth-secret:${tenantId}:${endpointId}`;

/** Binds an endpoint's OAuth client private key to its company and the endpoint (ADR-367). */
export const webhookOAuthKeyAad = (tenantId: string, endpointId: string) =>
  `webhook-oauth-key:${tenantId}:${endpointId}`;

/**
 * Binds an endpoint's OAuth client's next private key to its company and the endpoint (ADR-368):
 * another binding than the key in use's, so neither ciphertext opens as the other.
 */
export const webhookOAuthNextKeyAad = (tenantId: string, endpointId: string) =>
  `webhook-oauth-next-key:${tenantId}:${endpointId}`;

/** The ways a client authenticates with a secret it shares with its server. */
export type WebhookOAuthSecretAuthentication = Exclude<WebhookOAuthClientAuth, 'private_key_jwt'>;

/**
 * An endpoint's OAuth client, its secret or private key opened. How it authenticates (ADR-357): its
 * identifier and secret in an HTTP Basic header (`client_secret_basic`, the default) or as form
 * parameters in the request body (`client_secret_post`), as RFC 7591 names them; or a JWT signed
 * with its secret (`client_secret_jwt`, ADR-366) or with a private key HyFib keeps
 * (`private_key_jwt`, ADR-367), as OpenID Connect Core 1.0 section 9 names them, nothing secret
 * sent. A client signing with a key pair has no secret, and the others have no key.
 */
export type WebhookOAuthClient = {
  tokenUrl: string;
  clientId: string;
  /** The scope to ask for (space-separated scope tokens), or none. */
  scope: string | null;
  /**
   * The audience a client that signs JWTs names in them instead of its token URL (ADR-369), such as
   * its server's issuer identifier; null names the token URL, and any other client has none.
   */
  assertionAudience: string | null;
} & (
  | { clientAuthentication: WebhookOAuthSecretAuthentication; clientSecret: string }
  | {
      clientAuthentication: 'private_key_jwt';
      /** The private key, PKCS#8 PEM: RSA, or EC on P-256 for ES256 (ADR-371). */
      privateKey: string;
      /** Its public key's id (RFC 7638 thumbprint), named in each assertion's `kid` header. */
      keyId: string;
      /** The algorithm it signs with, chosen when the pair was made (ADR-371). */
      keyAlgorithm: WebhookOAuthKeyAlgorithm;
      /**
       * The thumbprints of the certificate made for the pair, named in each assertion's `x5t` and
       * `x5t#S256` headers, or null: the pair has none (ADR-372).
       */
      certificate: Pick<WebhookOAuthCertificate, 'x5t' | 'x5tS256'> | null;
    }
);

/** An access token from the authorization server. */
export interface WebhookOAuthToken {
  accessToken: string;
  /**
   * Until when HyFib uses it for later deliveries: a minute before it expires, and at most a day
   * after it was obtained. Null when the answer gave no lifetime, or one of two minutes or less:
   * then it serves only the deliveries being sent with it.
   */
  usableUntil: Date | null;
}

export type WebhookOAuthTokenResult =
  { ok: true; token: WebhookOAuthToken } | { ok: false; error: string };

/**
 * A client identifier or secret: visible ASCII and space (RFC 6749 A.1, A.2). The schemas refuse an
 * empty one with their own message.
 */
export const WEBHOOK_OAUTH_CLIENT_RE = /^[\x20-\x7e]*$/;
/** A scope: scope tokens separated by single spaces (RFC 6749 section 3.3). */
export const WEBHOOK_OAUTH_SCOPE_RE = /^[\x21\x23-\x5b\x5d-\x7e]+( [\x21\x23-\x5b\x5d-\x7e]+)*$/;
/** A token a bearer header can carry: RFC 6750's b64token. */
const BEARER_TOKEN_RE = /^[A-Za-z0-9\-._~+/]+=*$/;

/** Kept at most this long, and dropped this long before it expires. */
const MAX_KEPT_SECONDS = 86_400;
const EXPIRY_MARGIN_SECONDS = 60;

/** `application/x-www-form-urlencoded`, as RFC 6749 Appendix B encodes a name or a value. */
const formEncode = (value: string) => new URLSearchParams([['', value]]).toString().slice(1);

/** A client assertion's type: a JWT that authenticates the client (RFC 7523 section 2.2). */
export const WEBHOOK_OAUTH_ASSERTION_TYPE =
  'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
/** How long a client assertion is good for, from when it is made (ADR-366). */
export const WEBHOOK_OAUTH_ASSERTION_SECONDS = 300;
/**
 * The fewest bytes of a secret that signs client assertions: HMAC SHA-256 takes a key at least as
 * long as its hash (RFC 7518 section 3.2).
 */
export const WEBHOOK_OAUTH_JWT_SECRET_BYTES = 32;

/** Whether a client's secret can sign its client assertions (ADR-366). */
export const webhookOAuthSecretSignsJwt = (secret: string) =>
  Buffer.byteLength(secret, 'utf8') >= WEBHOOK_OAUTH_JWT_SECRET_BYTES;

/**
 * Whether a value can be the audience a client's JWTs name (ADR-369): an https URL, such as an
 * authorization server's issuer identifier, of visible ASCII, without credentials or a fragment. It
 * is kept as given, never fetched, since a server compares it as a string.
 */
export function webhookOAuthAudienceValid(value: string): boolean {
  if (!/^[\x21-\x7e]+$/.test(value) || !value.startsWith('https://') || value.includes('#')) {
    return false;
  }
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.hostname !== '' && url.username === '' && url.password === '';
}

/** A JWKS URL's public id (ADR-370): 16 base32 characters (80 random bits), like widget ids. */
export const WEBHOOK_OAUTH_JWKS_ID_RE = /^[a-z2-7]{16}$/;
export const newWebhookOAuthJwksId = () => randomToken(TOKEN_ALPHABET, 16);

/** Where HyFib serves a client's public keys as a JWK Set (ADR-370), under the app's base URL. */
export const webhookOAuthJwksUrl = (appBaseUrl: string, jwksId: string) =>
  `${appBaseUrl.replace(/\/$/, '')}/api/webhook-oauth/jwks/${jwksId}`;

/** The size of the RSA keys HyFib makes for clients that sign with a key pair (ADR-367). */
export const WEBHOOK_OAUTH_KEY_BITS = 2048;

/**
 * The algorithm a key pair made before migration 0291 signs with, which stores none (ADR-371), and
 * that of a client's first key pair when none is chosen.
 */
export const WEBHOOK_OAUTH_DEFAULT_KEY_ALGORITHM: WebhookOAuthKeyAlgorithm = 'RS256';

/** Whether an algorithm signs with an elliptic-curve key on P-256 rather than an RSA key. */
const signsWithEc = (algorithm: WebhookOAuthKeyAlgorithm) => algorithm === 'ES256';

/** A key pair HyFib made for a `private_key_jwt` client (ADR-367), both halves as PEM. */
export interface WebhookOAuthKeyPair {
  /** PKCS#8; stored only sealed with the keyring, never shown or sent. */
  privateKey: string;
  /** SPKI; shown, for the company to register with its authorization server. */
  publicKey: string;
}

/**
 * A new key pair for a client that signs with one: an RSA key of 2048 bits, exponent 65537, for
 * RS256 (ADR-367) or PS256, or an elliptic-curve key on P-256 for ES256 (ADR-371).
 */
export function generateWebhookOAuthKeyPair(
  algorithm: WebhookOAuthKeyAlgorithm = WEBHOOK_OAUTH_DEFAULT_KEY_ALGORITHM,
): WebhookOAuthKeyPair {
  const { privateKey, publicKey } = signsWithEc(algorithm)
    ? generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      })
    : generateKeyPairSync('rsa', {
        modulusLength: WEBHOOK_OAUTH_KEY_BITS,
        publicExponent: 0x10001,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
  return { privateKey, publicKey };
}

/**
 * A client's public key as shown and registered (ADR-367): the JWK of its modulus and exponent
 * (RFC 7518 section 6.3.1) or, for ES256, of its curve and point (section 6.2.1, ADR-371), with its
 * key id, the JWK thumbprint of RFC 7638 (SHA-256 of the required members in lexicographic order
 * without whitespace, base64url), and the algorithm it signs with; and the PEM it was read from.
 * With the certificate made for the pair (ADR-372), the JWK names it too (`x5c`, `x5t`,
 * `x5t#S256`), and it is shown beside the key. Throws for a key of another kind than the algorithm
 * takes, and for a certificate of another key.
 */
export function webhookOAuthPublicKey(
  pem: string,
  algorithm: WebhookOAuthKeyAlgorithm = WEBHOOK_OAUTH_DEFAULT_KEY_ALGORITHM,
  certificatePem: string | null = null,
): WebhookOAuthPublicKey {
  const key = createPublicKey(pem);
  const jwk = key.export({ format: 'jwk' });
  const thumbprint = (members: object) =>
    createHash('sha256').update(JSON.stringify(members)).digest('base64url');
  const read = certificatePem === null ? null : readWebhookOAuthCertificate(certificatePem, key);
  const named = read
    ? {
        x5c: [read.x5c] as [string],
        x5t: read.certificate.x5t,
        'x5t#S256': read.certificate.x5tS256,
      }
    : {};
  const certificate = read?.certificate ?? null;
  if (algorithm === 'ES256') {
    if (
      jwk.kty !== 'EC' ||
      jwk.crv !== 'P-256' ||
      typeof jwk.x !== 'string' ||
      typeof jwk.y !== 'string'
    ) {
      throw new Error('A webhook OAuth client public key for ES256 is not an EC key on P-256');
    }
    const { x, y } = jwk;
    const keyId = thumbprint({ crv: 'P-256', kty: 'EC', x, y });
    return {
      keyId,
      jwk: { kty: 'EC', crv: 'P-256', x, y, kid: keyId, use: 'sig', alg: algorithm, ...named },
      pem,
      certificate,
    };
  }
  if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
    throw new Error(`A webhook OAuth client public key for ${algorithm} is not an RSA key`);
  }
  const { n, e } = jwk;
  const keyId = thumbprint({ e, kty: 'RSA', n });
  return {
    keyId,
    jwk: { kty: 'RSA', n, e, kid: keyId, use: 'sig', alg: algorithm, ...named },
    pem,
    certificate,
  };
}

/**
 * A private key opened for signing (ADR-367): of the kind its algorithm takes, as HyFib makes them
 * (an RSA key, or an EC key on P-256 for ES256, ADR-371), else an error, so that a key of another
 * kind never signs an assertion labelled with that algorithm.
 */
export function checkedWebhookOAuthPrivateKey(
  pem: string,
  algorithm: WebhookOAuthKeyAlgorithm = WEBHOOK_OAUTH_DEFAULT_KEY_ALGORITHM,
): string {
  const key = createPrivateKey(pem);
  if (signsWithEc(algorithm)) {
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('A webhook OAuth client private key for ES256 is not an EC key on P-256');
    }
  } else if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`A webhook OAuth client private key for ${algorithm} is not an RSA key`);
  }
  return pem;
}

/**
 * A signature with a client's private key (RFC 7518 section 3): RS256 is RSASSA-PKCS1-v1_5 with
 * SHA-256; PS256 is RSASSA-PSS with SHA-256, MGF1 with SHA-256 and a salt as long as the hash (32
 * bytes); ES256 is ECDSA on P-256 with SHA-256, the signature the 64 bytes of R and S, not DER.
 */
function keySignature(
  client: Extract<WebhookOAuthClient, { clientAuthentication: 'private_key_jwt' }>,
  data: Buffer,
): Buffer {
  switch (client.keyAlgorithm) {
    case 'RS256':
      return sign('sha256', data, client.privateKey);
    case 'PS256':
      return sign('sha256', data, {
        key: client.privateKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      });
    case 'ES256':
      return sign('sha256', data, { key: client.privateKey, dsaEncoding: 'ieee-p1363' });
  }
}

/**
 * A client assertion (RFC 7523 section 3): a JWT whose issuer and subject are the client's
 * identifier and whose audience is the token URL, or the audience the client names (ADR-369), with
 * a unique id, the time it was made, which is also when it starts being valid (`nbf`, ADR-372), and
 * an expiry five minutes later. For `client_secret_jwt` (ADR-366) signed with HMAC SHA-256 keyed by
 * the client's secret (`HS256`), so the server checks the secret without receiving it; for
 * `private_key_jwt` (ADR-367) signed with the client's private key with the algorithm its pair was
 * made for (RS256 unless another was chosen, ADR-371), its header naming the key and the algorithm,
 * and the certificate made for the pair by its thumbprints when it has one (ADR-372), so the server
 * checks it with the public key or certificate registered.
 */
export function webhookOAuthClientAssertion(
  client: WebhookOAuthClient,
  at: Date,
  jti: string,
): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const issuedAt = Math.floor(at.getTime() / 1000);
  const header =
    client.clientAuthentication === 'private_key_jwt'
      ? {
          alg: client.keyAlgorithm,
          kid: client.keyId,
          typ: 'JWT',
          ...(client.certificate
            ? { x5t: client.certificate.x5t, 'x5t#S256': client.certificate.x5tS256 }
            : {}),
        }
      : { alg: 'HS256', typ: 'JWT' };
  const signed = `${part(header)}.${part({
    iss: client.clientId,
    sub: client.clientId,
    aud: client.assertionAudience ?? client.tokenUrl,
    jti,
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + WEBHOOK_OAUTH_ASSERTION_SECONDS,
  })}`;
  const signature =
    client.clientAuthentication === 'private_key_jwt'
      ? keySignature(client, Buffer.from(signed, 'utf8')).toString('base64url')
      : createHmac('sha256', Buffer.from(client.clientSecret, 'utf8'))
          .update(signed)
          .digest('base64url');
  return `${signed}.${signature}`;
}

/**
 * The token request (RFC 6749 section 4.4.2): `grant_type=client_credentials`, with the scope when
 * one is set, the client authenticated as section 2.3.1 says: with HTTP Basic (its identifier and
 * secret each form-encoded, joined by a colon, base64-encoded) or, for `client_secret_post`, with
 * `client_id` and `client_secret` among the form's parameters and no Authorization header (ADR-357);
 * or, for `client_secret_jwt` and `private_key_jwt`, with `client_id` and a client assertion made
 * `at`, with the unique `jti` (RFC 7521 section 4.2, RFC 7523 section 2.2), and no Authorization
 * header (ADR-366, ADR-367). Sent through the egress client, like deliveries, so the authorization
 * server is held to the same address rules.
 */
export function webhookOAuthTokenRequest(
  client: WebhookOAuthClient,
  userAgent: string,
  at: Date = new Date(),
  jti: string = randomUUID(),
): EgressRequest {
  const form = new URLSearchParams([['grant_type', 'client_credentials']]);
  if (client.scope) form.append('scope', client.scope);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
    'user-agent': userAgent,
  };
  if (
    client.clientAuthentication === 'client_secret_jwt' ||
    client.clientAuthentication === 'private_key_jwt'
  ) {
    form.append('client_id', client.clientId);
    form.append('client_assertion_type', WEBHOOK_OAUTH_ASSERTION_TYPE);
    form.append('client_assertion', webhookOAuthClientAssertion(client, at, jti));
  } else if (client.clientAuthentication === 'client_secret_post') {
    form.append('client_id', client.clientId);
    form.append('client_secret', client.clientSecret);
  } else {
    const basic = Buffer.from(
      `${formEncode(client.clientId)}:${formEncode(client.clientSecret)}`,
      'utf8',
    ).toString('base64');
    headers.authorization = `Basic ${basic}`;
  }
  return { method: 'POST', url: client.tokenUrl, headers, body: form.toString() };
}

/** A lifetime in seconds as RFC 6749 section 5.1 gives it (a few servers send it as a string). */
function lifetimeSeconds(value: unknown): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d{1,10}$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Reads the authorization server's answer: a 200 with a JSON object holding a bearer
 * `access_token` (RFC 6749 section 5.1, RFC 6750) is a token; any other status is a refusal
 * (`oauth_token_refused_<status>`), and a 200 without a usable bearer token is
 * `oauth_token_invalid`. Nothing of the answer but the token is kept.
 */
export function readWebhookOAuthTokenAnswer(
  answer: { status: number; body: Buffer },
  obtainedAt: Date,
): WebhookOAuthTokenResult {
  if (answer.status !== 200) {
    const known = Number.isInteger(answer.status) && answer.status >= 100 && answer.status <= 599;
    return {
      ok: false,
      error: known ? `oauth_token_refused_${answer.status}` : 'oauth_token_refused',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body.toString('utf8'));
  } catch {
    return { ok: false, error: 'oauth_token_invalid' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'oauth_token_invalid' };
  }
  const fields = parsed as Record<string, unknown>;
  const accessToken = fields.access_token;
  if (
    typeof accessToken !== 'string' ||
    accessToken.length > WEBHOOK_LIMITS.oauthTokenLength ||
    !BEARER_TOKEN_RE.test(accessToken) ||
    typeof fields.token_type !== 'string' ||
    fields.token_type.toLowerCase() !== 'bearer'
  ) {
    return { ok: false, error: 'oauth_token_invalid' };
  }
  const lifetime = lifetimeSeconds(fields.expires_in);
  const kept = lifetime === null ? 0 : Math.min(lifetime, MAX_KEPT_SECONDS) - EXPIRY_MARGIN_SECONDS;
  return {
    ok: true,
    token: {
      accessToken,
      usableUntil:
        kept > EXPIRY_MARGIN_SECONDS ? new Date(obtainedAt.getTime() + kept * 1000) : null,
    },
  };
}

/** The error a token request that failed in the egress client records (`oauth_token_timeout`). */
export const webhookOAuthEgressError = (code: string) => `oauth_token_${code}`;

/** The error of a client whose secret is too short to sign its client assertions (ADR-366). */
export const WEBHOOK_OAUTH_SECRET_TOO_SHORT = 'oauth_token_secret_too_short';

/**
 * Asks the endpoint's authorization server for a token through the egress client, which holds it to
 * the same address rules as deliveries; the token's lifetime counts from when it was asked for. A
 * request the egress client refused, or that failed, is `oauth_token_<its code>`. A secret too short
 * to sign a client assertion asks nothing: `oauth_token_secret_too_short`. The services refuse one
 * (ADR-366), but a web server from before it, still serving during a rollout, can rotate the
 * secret of a client that signs JWTs without that check.
 */
export async function fetchWebhookOAuthToken(
  egress: EgressClient,
  client: WebhookOAuthClient,
  userAgent: string,
  now: () => Date,
): Promise<WebhookOAuthTokenResult> {
  if (
    client.clientAuthentication === 'client_secret_jwt' &&
    !webhookOAuthSecretSignsJwt(client.clientSecret)
  ) {
    return { ok: false, error: WEBHOOK_OAUTH_SECRET_TOO_SHORT };
  }
  const askedAt = now();
  try {
    return readWebhookOAuthTokenAnswer(
      await egress.request(webhookOAuthTokenRequest(client, userAgent, askedAt)),
      askedAt,
    );
  } catch (error) {
    if (!(error instanceof EgressError)) throw error;
    return { ok: false, error: webhookOAuthEgressError(error.code) };
  }
}

/** An endpoint whose tokens are kept: its company and id. */
export interface WebhookOAuthTokenOwner {
  tenantId: string;
  endpointId: string;
}

/** The endpoints whose tokens a process keeps at most; the least recently used goes first. */
const MAX_KEPT_TOKENS = 1_000;

/**
 * Tells clients apart without keeping their secrets or keys: a hash of everything a token request
 * is made from.
 */
const clientFingerprint = (client: WebhookOAuthClient) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        client.tokenUrl,
        client.clientId,
        client.clientAuthentication === 'private_key_jwt' ? client.privateKey : client.clientSecret,
        client.scope,
        client.clientAuthentication,
        client.assertionAudience,
        client.clientAuthentication === 'private_key_jwt' ? client.keyAlgorithm : null,
        client.clientAuthentication === 'private_key_jwt'
          ? (client.certificate?.x5tS256 ?? null)
          : null,
      ]),
    )
    .digest('base64url');

/**
 * The access tokens a worker keeps for webhook endpoints (ADR-173), in its memory only: never
 * stored, logged or shown. A token is kept for its endpoint and client, so a changed token URL,
 * identifier, secret or key, scope, way of authenticating, audience, key algorithm or certificate
 * gets a new one, and until a minute before it expires (at most a day).
 * The deliveries of an endpoint that need a token at the same time share one request; a token
 * without a lifetime serves only them, and a failure is never kept: the next attempt asks again.
 */
export class WebhookOAuthTokenCache {
  readonly #kept = new Map<string, { client: string; token: WebhookOAuthToken }>();
  readonly #asking = new Map<
    string,
    { client: string; result: Promise<WebhookOAuthTokenResult> }
  >();

  constructor(private readonly maxKept: number = MAX_KEPT_TOKENS) {}

  /**
   * A token for the endpoint's client: the one kept, if usable at `now`; the one being asked for;
   * or one asked for now with `ask`.
   */
  token(
    owner: WebhookOAuthTokenOwner,
    client: WebhookOAuthClient,
    now: Date,
    ask: () => Promise<WebhookOAuthTokenResult>,
  ): Promise<WebhookOAuthTokenResult> {
    const key = `${owner.tenantId}:${owner.endpointId}`;
    const fingerprint = clientFingerprint(client);
    const kept = this.#kept.get(key);
    if (kept?.client === fingerprint && kept.token.usableUntil && kept.token.usableUntil > now) {
      // The most recently used last.
      this.#kept.delete(key);
      this.#kept.set(key, kept);
      return Promise.resolve({ ok: true, token: kept.token });
    }
    const asking = this.#asking.get(key);
    if (asking?.client === fingerprint) return asking.result;
    const entry = { client: fingerprint, result: ask() };
    this.#asking.set(key, entry);
    // Runs before the callers' own reactions, so a later call finds the token kept. Only the
    // request still current for the endpoint keeps what it got.
    const settle = (result: WebhookOAuthTokenResult | null) => {
      if (this.#asking.get(key) !== entry) return;
      this.#asking.delete(key);
      if (result?.ok && result.token.usableUntil) this.#keep(key, fingerprint, result.token);
    };
    entry.result.then(settle, () => settle(null));
    return entry.result;
  }

  /** Forgets the endpoint's token if it is still `accessToken`: its receiver refused it. */
  drop(owner: WebhookOAuthTokenOwner, accessToken: string): void {
    const key = `${owner.tenantId}:${owner.endpointId}`;
    if (this.#kept.get(key)?.token.accessToken === accessToken) this.#kept.delete(key);
  }

  #keep(key: string, client: string, token: WebhookOAuthToken): void {
    this.#kept.delete(key);
    if (this.#kept.size >= this.maxKept) {
      const oldest = this.#kept.keys().next();
      if (!oldest.done) this.#kept.delete(oldest.value);
    }
    this.#kept.set(key, { client, token });
  }
}
