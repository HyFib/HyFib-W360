import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EgressError, type EgressClient, type EgressRequest } from '@w360/core/egress';
import { WEBHOOK_LIMITS } from './model';
import {
  fetchWebhookOAuthToken,
  readWebhookOAuthTokenAnswer,
  webhookOAuthClientAssertion,
  webhookOAuthEgressError,
  webhookOAuthSecretAad,
  webhookOAuthSecretSignsJwt,
  webhookOAuthTokenRequest,
  WebhookOAuthTokenCache,
  WEBHOOK_OAUTH_ASSERTION_TYPE,
  WEBHOOK_OAUTH_CLIENT_RE,
  WEBHOOK_OAUTH_JWT_SECRET_BYTES,
  WEBHOOK_OAUTH_SCOPE_RE,
  type WebhookOAuthTokenResult,
} from './oauth';

const client = {
  tokenUrl: 'https://auth.example.com/oauth2/token',
  clientId: 'hyfib-webhooks',
  clientSecret: 's3cret',
  scope: null,
  clientAuthentication: 'client_secret_basic' as const,
};
const at = new Date('2026-10-05T10:00:00Z');
const answer = (status: number, body: unknown) => ({
  status,
  body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'),
});

describe('OAuth client credentials for webhook endpoints (ADR-173)', () => {
  it('ask for a token as RFC 6749 section 4.4.2 says: the client in a Basic header, the grant and scope in a form', () => {
    const request = webhookOAuthTokenRequest(client, 'HyFib-W360-Webhooks/1');
    expect(request).toEqual({
      method: 'POST',
      url: 'https://auth.example.com/oauth2/token',
      headers: {
        authorization: `Basic ${Buffer.from('hyfib-webhooks:s3cret').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': 'HyFib-W360-Webhooks/1',
      },
      body: 'grant_type=client_credentials',
    });
    // The identifier and secret are each form-encoded before they are joined (section 2.3.1), and
    // the scope goes in the form.
    const encoded = webhookOAuthTokenRequest(
      {
        ...client,
        clientId: 'id with:colon',
        clientSecret: 'p@ss+w/rd',
        scope: 'events.write read',
      },
      'ua',
    );
    expect(Buffer.from(encoded.headers.authorization!.slice(6), 'base64').toString('utf8')).toBe(
      'id+with%3Acolon:p%40ss%2Bw%2Frd',
    );
    expect(encoded.body).toBe('grant_type=client_credentials&scope=events.write+read');
    // The longest identifier and secret, all characters that encode to three, stay within the
    // header length the egress client sends (4,096).
    const longest = webhookOAuthTokenRequest(
      {
        ...client,
        clientId: '%'.repeat(WEBHOOK_LIMITS.oauthClientIdLength),
        clientSecret: '%'.repeat(WEBHOOK_LIMITS.oauthClientSecretLength),
      },
      'ua',
    );
    expect(longest.headers.authorization!.length).toBeLessThanOrEqual(4096);
  });

  it('send the client in the form instead, without an Authorization header, for client_secret_post (ADR-357)', () => {
    const post = { ...client, clientAuthentication: 'client_secret_post' as const };
    expect(webhookOAuthTokenRequest(post, 'HyFib-W360-Webhooks/1')).toEqual({
      method: 'POST',
      url: 'https://auth.example.com/oauth2/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': 'HyFib-W360-Webhooks/1',
      },
      body: 'grant_type=client_credentials&client_id=hyfib-webhooks&client_secret=s3cret',
    });
    // Form-encoded like every parameter, after the scope.
    expect(
      webhookOAuthTokenRequest(
        {
          ...post,
          clientId: 'id with:colon',
          clientSecret: 'p@ss+w/rd',
          scope: 'events.write read',
        },
        'ua',
      ).body,
    ).toBe(
      'grant_type=client_credentials&scope=events.write+read&client_id=id+with%3Acolon&client_secret=p%40ss%2Bw%2Frd',
    );
  });

  it('prove the client holds its secret with a JWT signed with it, the secret never sent, for client_secret_jwt (ADR-366)', () => {
    const secret = 'jwt-signing-secret:of/forty+bytes-long!!';
    const jwt = {
      ...client,
      clientSecret: secret,
      scope: 'events.write',
      clientAuthentication: 'client_secret_jwt' as const,
    };
    const jti = '0192f0e4-7a3b-7c1d-9e2f-3a4b5c6d7e8f';
    // The assertion as RFC 7523 section 3 has it, computed apart from this code (Python's hmac).
    const expected =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJpc3MiOiJoeWZpYi13ZWJob29rcyIsInN1YiI6Imh5ZmliLXdlYmhvb2tzIiwiYXVkIjoiaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tL29hdXRoMi90b2tlbiIsImp0aSI6IjAxOTJmMGU0LTdhM2ItN2MxZC05ZTJmLTNhNGI1YzZkN2U4ZiIsImlhdCI6MTc5MTE5NDQwMCwiZXhwIjoxNzkxMTk0NzAwfQ.' +
      'qWD98MfudC2gpm00IDcRnGd5VruaSapM41yFFkkclrc';
    expect(webhookOAuthClientAssertion(jwt, at, jti)).toBe(expected);
    const [header, payload, signature] = expected.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString('utf8'))).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'))).toEqual({
      iss: 'hyfib-webhooks',
      sub: 'hyfib-webhooks',
      aud: 'https://auth.example.com/oauth2/token',
      jti,
      iat: at.getTime() / 1000,
      exp: at.getTime() / 1000 + 300,
    });
    expect(signature).toBe(
      createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url'),
    );
    // The request: the client ID and the assertion in the form, no Authorization header.
    const request = webhookOAuthTokenRequest(jwt, 'HyFib-W360-Webhooks/1', at, jti);
    expect(request).toEqual({
      method: 'POST',
      url: 'https://auth.example.com/oauth2/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': 'HyFib-W360-Webhooks/1',
      },
      body: new URLSearchParams([
        ['grant_type', 'client_credentials'],
        ['scope', 'events.write'],
        ['client_id', 'hyfib-webhooks'],
        ['client_assertion_type', WEBHOOK_OAUTH_ASSERTION_TYPE],
        ['client_assertion', expected],
      ]).toString(),
    });
    expect(WEBHOOK_OAUTH_ASSERTION_TYPE).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    );
    // The secret is nowhere in the form, read as the server reads it.
    expect([...new URLSearchParams(request.body ?? '').values()].join('\n')).not.toContain(secret);
    // Each request makes its own: a new id, and the time it is made.
    const fresh = new URLSearchParams(webhookOAuthTokenRequest(jwt, 'ua').body ?? '').get(
      'client_assertion',
    );
    const claims = JSON.parse(
      Buffer.from(fresh!.split('.')[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(claims.jti).not.toBe(jti);
    expect(claims.jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(claims.exp).toBe((claims.iat as number) + 300);
  });

  it('sign JWTs only with a secret of at least 32 bytes, as HMAC SHA-256 takes (ADR-366)', () => {
    expect(WEBHOOK_OAUTH_JWT_SECRET_BYTES).toBe(32);
    expect(webhookOAuthSecretSignsJwt('a'.repeat(31))).toBe(false);
    expect(webhookOAuthSecretSignsJwt('a'.repeat(32))).toBe(true);
    // Bytes, not characters: 16 letters of two bytes each.
    expect(webhookOAuthSecretSignsJwt('é'.repeat(16))).toBe(true);
    expect(webhookOAuthSecretSignsJwt('é'.repeat(15))).toBe(false);
  });

  it('take a 200 with a bearer token, kept until a minute before it expires and at most a day', () => {
    expect(
      readWebhookOAuthTokenAnswer(
        answer(200, { access_token: 'eyJ.abc-_~+/=', token_type: 'Bearer', expires_in: 3600 }),
        at,
      ),
    ).toEqual({
      ok: true,
      token: { accessToken: 'eyJ.abc-_~+/=', usableUntil: new Date('2026-10-05T10:59:00Z') },
    });
    // The type in any case; a lifetime given as a string of digits.
    expect(
      readWebhookOAuthTokenAnswer(
        answer(200, { access_token: 't', token_type: 'bearer', expires_in: '600' }),
        at,
      ),
    ).toEqual({
      ok: true,
      token: { accessToken: 't', usableUntil: new Date('2026-10-05T10:09:00Z') },
    });
    // A year's lifetime is kept a day; none, or one of two minutes or less, serves only the
    // deliveries sent with it.
    const until = (expiresIn: unknown) => {
      const read = readWebhookOAuthTokenAnswer(
        answer(200, { access_token: 't', token_type: 'Bearer', expires_in: expiresIn }),
        at,
      );
      return read.ok ? read.token.usableUntil : 'refused';
    };
    expect(until(31_536_000)).toEqual(new Date('2026-10-06T09:59:00Z'));
    for (const short of [undefined, 120, 60, 0, -5, 1.5, '1h', null, 'abc']) {
      expect(until(short), String(short)).toBeNull();
    }
    expect(until(121)).toEqual(new Date('2026-10-05T10:01:01Z'));
  });

  it('refuse any other answer, saying whether the server refused or answered without a usable token', () => {
    const error = (status: number, body: unknown) => {
      const read = readWebhookOAuthTokenAnswer(answer(status, body), at);
      return read.ok ? 'token' : read.error;
    };
    const token = { access_token: 'abc', token_type: 'Bearer', expires_in: 3600 };
    expect(error(401, { error: 'invalid_client' })).toBe('oauth_token_refused_401');
    expect(error(400, { error: 'invalid_scope' })).toBe('oauth_token_refused_400');
    expect(error(503, 'Service Unavailable')).toBe('oauth_token_refused_503');
    // Section 5.1 answers 200 only, so another 2xx is no token either.
    expect(error(201, token)).toBe('oauth_token_refused_201');
    expect(error(0, token)).toBe('oauth_token_refused');
    for (const body of [
      'not json',
      [],
      null,
      'null',
      {},
      { access_token: 'abc' },
      { access_token: 'abc', token_type: 'mac' },
      { access_token: '', token_type: 'Bearer' },
      { access_token: 'has space', token_type: 'Bearer' },
      { access_token: 'line\nbreak', token_type: 'Bearer' },
      { access_token: 42, token_type: 'Bearer' },
      { access_token: 'abc', token_type: 7 },
      { access_token: 'a'.repeat(WEBHOOK_LIMITS.oauthTokenLength + 1), token_type: 'Bearer' },
    ]) {
      expect(error(200, body), JSON.stringify(body)).toBe('oauth_token_invalid');
    }
    expect(
      error(200, { ...token, access_token: 'a'.repeat(WEBHOOK_LIMITS.oauthTokenLength) }),
    ).toBe('token');
    expect(webhookOAuthEgressError('timeout')).toBe('oauth_token_timeout');
    // Every code fits the 64 characters a delivery's error holds.
    expect(webhookOAuthEgressError('response_too_large').length).toBeLessThanOrEqual(64);
  });

  it('take visible identifiers, secrets and scope tokens, and bind sealed values to the endpoint', () => {
    for (const ok of ['hyfib', 'id with spaces', 'a~!@#$%^&*()']) {
      expect(WEBHOOK_OAUTH_CLIENT_RE.test(ok), ok).toBe(true);
    }
    for (const bad of ['tab\there', 'é', 'line\n']) {
      expect(WEBHOOK_OAUTH_CLIENT_RE.test(bad), bad).toBe(false);
    }
    for (const ok of ['read', 'events.write read', 'https://graph.example.com/.default']) {
      expect(WEBHOOK_OAUTH_SCOPE_RE.test(ok), ok).toBe(true);
    }
    for (const bad of ['', ' read', 'read ', 'a  b', 'quote"d', 'back\\slash', 'é']) {
      expect(WEBHOOK_OAUTH_SCOPE_RE.test(bad), bad).toBe(false);
    }
    expect(webhookOAuthSecretAad('t', 'e')).toBe('webhook-oauth-secret:t:e');
  });

  it('ask through the egress client, timing the lifetime from the request and naming its failures', async () => {
    const sent: EgressRequest[] = [];
    let time = at.getTime();
    const egress = (answer: () => Promise<{ status: number; body: Buffer }>): EgressClient => ({
      async request(input) {
        sent.push(input);
        // The answer comes 30 seconds after the request.
        time += 30_000;
        return { ...(await answer()), headers: {}, address: '203.0.113.7', durationMs: 30_000 };
      },
    });
    const now = () => new Date(time);
    const token = { access_token: 'abc', token_type: 'Bearer', expires_in: 3600 };
    expect(
      await fetchWebhookOAuthToken(
        egress(async () => answer(200, token)),
        client,
        'HyFib-W360-Webhooks/1',
        now,
      ),
    ).toEqual({
      ok: true,
      token: { accessToken: 'abc', usableUntil: new Date('2026-10-05T10:59:00Z') },
    });
    expect(sent).toEqual([webhookOAuthTokenRequest(client, 'HyFib-W360-Webhooks/1')]);
    const failing = (error: Error) => egress(() => Promise.reject(error));
    expect(
      await fetchWebhookOAuthToken(
        failing(new EgressError('address_blocked', 'blocked', false)),
        client,
        'ua',
        now,
      ),
    ).toEqual({ ok: false, error: 'oauth_token_address_blocked' });
    // Anything but the egress client's own errors is a bug, and is thrown.
    await expect(
      fetchWebhookOAuthToken(failing(new TypeError('bug')), client, 'ua', now),
    ).rejects.toThrow('bug');
    // A client that signs JWTs with a secret too short to sign them asks nothing (ADR-366).
    sent.length = 0;
    expect(
      await fetchWebhookOAuthToken(
        egress(async () => answer(200, token)),
        { ...client, clientAuthentication: 'client_secret_jwt' },
        'ua',
        now,
      ),
    ).toEqual({ ok: false, error: 'oauth_token_secret_too_short' });
    expect(sent).toEqual([]);
    // One with a long enough secret signs its assertion at the time it asks.
    const signing = {
      ...client,
      clientSecret: 'x'.repeat(40),
      clientAuthentication: 'client_secret_jwt' as const,
    };
    const askedAt = time;
    expect(
      await fetchWebhookOAuthToken(
        egress(async () => answer(200, token)),
        signing,
        'ua',
        now,
      ),
    ).toMatchObject({ ok: true });
    const assertion = new URLSearchParams(sent[0]?.body ?? '').get('client_assertion');
    expect(
      JSON.parse(Buffer.from(assertion!.split('.')[1]!, 'base64url').toString('utf8')),
    ).toMatchObject({ iat: askedAt / 1000, exp: askedAt / 1000 + 300 });
  });
});

describe('the access tokens a worker keeps (ADR-173)', () => {
  const owner = { tenantId: 't1', endpointId: 'e1' };
  const issued = (accessToken: string, usableUntil: Date | null): WebhookOAuthTokenResult => ({
    ok: true,
    token: { accessToken, usableUntil },
  });
  /** An authorization server that counts the requests and answers each with the next token. */
  const server = (answers: WebhookOAuthTokenResult[]) => {
    const asked = { count: 0 };
    const ask = () => {
      const next = answers[asked.count] ?? answers.at(-1)!;
      asked.count += 1;
      return Promise.resolve(next);
    };
    return { asked, ask };
  };
  const minutes = (n: number) => new Date(at.getTime() + n * 60_000);

  it('keep a token until it stops being usable, for its endpoint and client only', async () => {
    const tokens = new WebhookOAuthTokenCache();
    const { asked, ask } = server([issued('one', minutes(10)), issued('two', minutes(30))]);
    expect(await tokens.token(owner, client, at, ask)).toEqual(issued('one', minutes(10)));
    expect(await tokens.token(owner, client, minutes(9), ask)).toEqual(issued('one', minutes(10)));
    expect(asked.count).toBe(1);
    // Usable until, not at, its time.
    expect(await tokens.token(owner, client, minutes(10), ask)).toEqual(issued('two', minutes(30)));
    expect(asked.count).toBe(2);
    // Another endpoint asks.
    await tokens.token({ ...owner, endpointId: 'e2' }, client, minutes(11), ask);
    await tokens.token({ ...owner, tenantId: 't2' }, client, minutes(11), ask);
    expect(asked.count).toBe(4);
    // So does the same one with a new secret, scope or token URL, or another way of sending its
    // credentials (ADR-357), each while the client as it was has a token kept.
    for (const changed of [
      { ...client, clientSecret: 'rotated' },
      { ...client, scope: 'read' },
      { ...client, tokenUrl: 'https://auth2.example.com/t' },
      { ...client, clientAuthentication: 'client_secret_post' as const },
    ]) {
      await tokens.token(owner, client, minutes(11), ask);
      const before = asked.count;
      await tokens.token(owner, client, minutes(11), ask);
      expect(asked.count).toBe(before);
      await tokens.token(owner, changed, minutes(11), ask);
      expect(asked.count, JSON.stringify(changed)).toBe(before + 1);
    }
  });

  it('share one request among the deliveries that need a token at once, keeping no failure', async () => {
    const tokens = new WebhookOAuthTokenCache();
    let release: (result: WebhookOAuthTokenResult) => void = () => {};
    let asked = 0;
    const ask = () => {
      asked += 1;
      return new Promise<WebhookOAuthTokenResult>((resolve) => (release = resolve));
    };
    const waiting = [1, 2, 3].map(() => tokens.token(owner, client, at, ask));
    expect(asked).toBe(1);
    // A token without a lifetime serves the deliveries waiting for it, and no later one.
    release(issued('once', null));
    expect(await Promise.all(waiting)).toEqual([1, 2, 3].map(() => issued('once', null)));
    const next = tokens.token(owner, client, at, ask);
    expect(asked).toBe(2);
    release({ ok: false, error: 'oauth_token_refused_401' });
    expect(await next).toEqual({ ok: false, error: 'oauth_token_refused_401' });
    // A failure is not kept either; nor is a request that threw.
    const thrown = tokens.token(owner, client, at, () => Promise.reject(new Error('bug')));
    await expect(thrown).rejects.toThrow('bug');
    const after = tokens.token(owner, client, at, ask);
    expect(asked).toBe(3);
    release(issued('kept', minutes(5)));
    expect(await after).toEqual(issued('kept', minutes(5)));
  });

  it('drop a token its receiver refused, unless a newer one replaced it', async () => {
    const tokens = new WebhookOAuthTokenCache();
    const { asked, ask } = server([issued('old', minutes(10)), issued('new', minutes(10))]);
    await tokens.token(owner, client, at, ask);
    tokens.drop(owner, 'something else');
    expect(await tokens.token(owner, client, at, ask)).toEqual(issued('old', minutes(10)));
    tokens.drop(owner, 'old');
    expect(await tokens.token(owner, client, at, ask)).toEqual(issued('new', minutes(10)));
    expect(asked.count).toBe(2);
  });

  it('keep the most recently used endpoints when it holds as many as it may', async () => {
    const tokens = new WebhookOAuthTokenCache(2);
    const { asked, ask } = server([issued('t', minutes(10))]);
    const e = (endpointId: string) => ({ tenantId: 't1', endpointId });
    await tokens.token(e('a'), client, at, ask);
    await tokens.token(e('b'), client, at, ask);
    // Using a makes b the least recently used, so c's token replaces b's.
    await tokens.token(e('a'), client, at, ask);
    await tokens.token(e('c'), client, at, ask);
    expect(asked.count).toBe(3);
    await tokens.token(e('a'), client, at, ask);
    await tokens.token(e('c'), client, at, ask);
    expect(asked.count).toBe(3);
    await tokens.token(e('b'), client, at, ask);
    expect(asked.count).toBe(4);
  });
});
