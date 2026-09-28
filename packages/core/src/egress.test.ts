import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_EGRESS_POLICY,
  EGRESS_USER_AGENT,
  EgressError,
  createEgressClient,
  isAllowedAddress,
  parseEgressUrl,
  type EgressPolicy,
  type EgressResolver,
} from './egress';

const STRICT = { allowLoopbackForTests: false };
const LOCAL: EgressPolicy = {
  ...DEFAULT_EGRESS_POLICY,
  allowLoopbackForTests: true,
  timeoutMs: 2_000,
  maxResponseBytes: 1_024,
};

async function errorOf(promise: Promise<unknown>): Promise<EgressError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EgressError) return error;
    throw error;
  }
  throw new Error('expected an EgressError');
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    return error instanceof EgressError ? error.code : 'other';
  }
  return null;
}

describe('egress addresses', () => {
  it('refuses private, loopback, link-local, metadata and special-purpose ranges', () => {
    for (const address of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '127.1.2.3',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.8',
      '192.0.2.1',
      '192.88.99.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.51.100.7',
      '203.0.113.9',
      '224.0.0.1',
      '239.255.255.250',
      '240.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:8.8.8.8',
      '::127.0.0.1',
      '64:ff9b::a00:1',
      '64:ff9b:1::1',
      '100::1',
      '2001::1',
      '2001:db8::1',
      '2002:a00:1::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'fec0::1',
      'ff02::1',
    ]) {
      expect(isAllowedAddress(address, STRICT), address).toBe(false);
    }
  });

  it('allows public addresses', () => {
    for (const address of [
      '1.1.1.1',
      '8.8.8.8',
      '93.184.216.34',
      '172.32.0.1',
      '100.128.0.1',
      '2606:4700:4700::1111',
      '2a00:1450:4001::200e',
    ]) {
      expect(isAllowedAddress(address, STRICT), address).toBe(true);
    }
  });

  it('allows loopback, and nothing else, for local test targets only', () => {
    expect(isAllowedAddress('127.0.0.1', { allowLoopbackForTests: true })).toBe(true);
    expect(isAllowedAddress('::1', { allowLoopbackForTests: true })).toBe(true);
    expect(isAllowedAddress('10.0.0.1', { allowLoopbackForTests: true })).toBe(false);
    expect(isAllowedAddress('169.254.169.254', { allowLoopbackForTests: true })).toBe(false);
    expect(isAllowedAddress('localhost', STRICT)).toBe(false);
  });
});

describe('egress URLs', () => {
  it('require https, no credentials, and port 443 or an unprivileged port', () => {
    expect(codeOf(() => parseEgressUrl('http://api.example.com/x', STRICT))).toBe(
      'scheme_not_allowed',
    );
    expect(codeOf(() => parseEgressUrl('ftp://api.example.com/x', STRICT))).toBe(
      'scheme_not_allowed',
    );
    expect(codeOf(() => parseEgressUrl('https://user:pw@api.example.com/x', STRICT))).toBe(
      'credentials_in_url',
    );
    expect(codeOf(() => parseEgressUrl('https://api.example.com:22/x', STRICT))).toBe(
      'port_not_allowed',
    );
    expect(codeOf(() => parseEgressUrl('not a url', STRICT))).toBe('invalid_url');
    expect(parseEgressUrl('https://api.example.com:8443/v1?a=1', STRICT)).toMatchObject({
      hostname: 'api.example.com',
      port: 8443,
      secure: true,
    });
    expect(parseEgressUrl('https://API.Example.com./x', STRICT).hostname).toBe('api.example.com');
    expect(parseEgressUrl('https://[2606:4700::1]/x', STRICT).hostname).toBe('2606:4700::1');
  });
});

describe('egress requests', () => {
  let server: Server;
  let port: number;
  const seen: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        if (req.url === '/redirect') {
          res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
          res.end();
        } else if (req.url === '/big') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('x'.repeat(4_096));
        } else if (req.url === '/slow') {
          // Never answers: the client's deadline ends the exchange.
        } else {
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const loopbackResolver = (calls: string[]): EgressResolver => {
    return async (name) => {
      calls.push(name);
      return [{ address: '127.0.0.1', family: 4 }];
    };
  };

  it('connects to the address it checked and sends the name as Host', async () => {
    const calls: string[] = [];
    const client = createEgressClient(LOCAL, { resolve: loopbackResolver(calls) });
    const before = seen.length;
    const res = await client.request({
      method: 'POST',
      url: `http://api.test:${port}/orders?ref=7`,
      headers: { Authorization: 'Bearer secret-token', 'X-Request-Id': 'r1' },
      body: '{"total":1250}',
    });
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ ok: true });
    expect(res.address).toBe('127.0.0.1');
    // Resolved once: the socket used that answer (no second lookup to re-point).
    expect(calls).toEqual(['api.test']);
    const request = seen[before];
    expect(request).toMatchObject({ method: 'POST', url: '/orders?ref=7', body: '{"total":1250}' });
    expect(request?.headers).toMatchObject({
      host: `api.test:${port}`,
      authorization: 'Bearer secret-token',
      'x-request-id': 'r1',
      'content-type': 'application/json',
      'user-agent': EGRESS_USER_AGENT,
    });
  });

  it('refuses names that resolve to a blocked address, before connecting', async () => {
    const before = seen.length;
    const privateOnly = createEgressClient(LOCAL, {
      resolve: async () => [{ address: '10.0.0.5', family: 4 }],
    });
    const blocked = await errorOf(
      privateOnly.request({
        method: 'GET',
        url: `http://api.test:${port}/`,
        headers: {},
        body: null,
      }),
    );
    expect(blocked).toMatchObject({ code: 'address_blocked', sent: false });
    // One blocked answer is enough, even next to an allowed one.
    const mixed = createEgressClient(LOCAL, {
      resolve: async () => [
        { address: '127.0.0.1', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
    });
    expect(
      await errorOf(
        mixed.request({ method: 'GET', url: `http://api.test:${port}/`, headers: {}, body: null }),
      ),
    ).toMatchObject({ code: 'address_blocked', sent: false });
    expect(seen.length).toBe(before);
  });

  it('refuses blocked IP literals, however they are written', async () => {
    const client = createEgressClient(DEFAULT_EGRESS_POLICY, {
      resolve: async () => {
        throw new Error('IP literals are not resolved');
      },
    });
    for (const url of [
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://169.254.169.254/latest/meta-data/',
      'https://2130706433/',
      'https://0x7f.1/',
      'https://[::ffff:7f00:1]/',
      'https://10.0.0.1:8443/',
    ]) {
      expect(
        await errorOf(client.request({ method: 'GET', url, headers: {}, body: null })),
        url,
      ).toMatchObject({ code: 'address_blocked', sent: false });
    }
  });

  it('does not follow redirects', async () => {
    const client = createEgressClient(LOCAL, { resolve: loopbackResolver([]) });
    const before = seen.length;
    const res = await client.request({
      method: 'GET',
      url: `http://api.test:${port}/redirect`,
      headers: {},
      body: null,
    });
    expect(res.status).toBe(302);
    expect(seen.length).toBe(before + 1);
  });

  it('limits sizes and time, and says when the request may have been received', async () => {
    const client = createEgressClient(LOCAL, { resolve: loopbackResolver([]) });
    expect(
      await errorOf(
        client.request({
          method: 'GET',
          url: `http://api.test:${port}/big`,
          headers: {},
          body: null,
        }),
      ),
    ).toMatchObject({ code: 'response_too_large', sent: true });
    expect(
      await errorOf(
        client.request({
          method: 'POST',
          url: `http://api.test:${port}/`,
          headers: {},
          body: 'x'.repeat(LOCAL.maxRequestBytes + 1),
        }),
      ),
    ).toMatchObject({ code: 'request_too_large', sent: false });
    const quick = createEgressClient(
      { ...LOCAL, timeoutMs: 300 },
      { resolve: loopbackResolver([]) },
    );
    expect(
      await errorOf(
        quick.request({
          method: 'GET',
          url: `http://api.test:${port}/slow`,
          headers: {},
          body: null,
        }),
      ),
    ).toMatchObject({ code: 'timeout', sent: true });
  });

  it('refuses reserved headers and header injection', async () => {
    const client = createEgressClient(LOCAL, { resolve: loopbackResolver([]) });
    const cases: Record<string, string>[] = [
      { Host: 'internal.example' },
      { 'Transfer-Encoding': 'chunked' },
      { 'Proxy-Authorization': 'x' },
      { 'X-Note': 'a\r\nX-Injected: 1' },
      { 'Bad Name': 'x' },
    ];
    for (const headers of cases) {
      expect(
        await errorOf(
          client.request({ method: 'GET', url: `http://api.test:${port}/`, headers, body: null }),
        ),
        JSON.stringify(headers),
      ).toMatchObject({ code: 'header_not_allowed', sent: false });
    }
  });

  it('falls back to the next checked address when one cannot be reached', async () => {
    const calls: string[] = [];
    // ::1 is loopback too (allowed for test targets), but the server listens on 127.0.0.1 only, so
    // connecting to it fails at once: refused, or unavailable where IPv6 is off. Not 127.0.0.2:
    // macOS has only 127.0.0.1 on loopback, so a connection to 127.0.0.2 waits out the deadline.
    const client = createEgressClient(LOCAL, {
      resolve: async (name) => {
        calls.push(name);
        return [
          { address: '::1', family: 6 },
          { address: '127.0.0.1', family: 4 },
        ];
      },
    });
    // Node's address selection reports each failed attempt on the socket: the response alone would
    // not show that ::1 was tried first.
    const failed: string[] = [];
    const onSocket = (message: unknown) => {
      const { socket } = message as { socket: Socket };
      socket.on('connectionAttemptFailed', (address) => failed.push(address));
    };
    subscribe('net.client.socket', onSocket);
    const res = await client
      .request({
        method: 'GET',
        url: `http://api.test:${port}/`,
        headers: {},
        body: null,
      })
      .finally(() => unsubscribe('net.client.socket', onSocket));
    expect(res.status).toBe(201);
    expect(res.address).toBe('127.0.0.1');
    expect(failed).toEqual(['::1']);
    expect(calls).toEqual(['api.test']);
  });

  it('counts name resolution against the deadline and limits lookups in progress', async () => {
    const hung = () => new Promise<never>(() => undefined);
    const slow = createEgressClient({ ...LOCAL, timeoutMs: 300 }, { resolve: hung });
    const started = Date.now();
    expect(
      await errorOf(
        slow.request({ method: 'GET', url: 'http://hung.test/', headers: {}, body: null }),
      ),
    ).toMatchObject({ code: 'dns_failed', sent: false });
    expect(Date.now() - started).toBeLessThan(2_000);

    // A lookup that never ends keeps its slot (system lookups cannot be cancelled): with one slot,
    // the next name waits for it and gives up at its own deadline instead of starting a lookup.
    const resolved: string[] = [];
    const capped = createEgressClient(
      { ...LOCAL, timeoutMs: 300, maxConcurrentLookups: 1 },
      {
        resolve: async (name) => {
          resolved.push(name);
          if (name === 'hung.test') return hung();
          return [{ address: '127.0.0.1', family: 4 }];
        },
      },
    );
    const first = errorOf(
      capped.request({ method: 'GET', url: 'http://hung.test/', headers: {}, body: null }),
    );
    const second = errorOf(
      capped.request({ method: 'GET', url: `http://api.test:${port}/`, headers: {}, body: null }),
    );
    expect(await first).toMatchObject({ code: 'dns_failed', sent: false });
    expect(await second).toMatchObject({ code: 'dns_failed', sent: false });
    expect(resolved).toEqual(['hung.test']);
  });

  it('reports names that do not resolve and refused connections as not sent', async () => {
    const nowhere = createEgressClient(LOCAL, {
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(
      await errorOf(
        nowhere.request({ method: 'GET', url: 'http://missing.test/', headers: {}, body: null }),
      ),
    ).toMatchObject({ code: 'dns_failed', sent: false });

    const closed = createServer();
    closed.listen(0, '127.0.0.1');
    await once(closed, 'listening');
    const closedPort = (closed.address() as AddressInfo).port;
    closed.close();
    await once(closed, 'close');
    const client = createEgressClient(LOCAL, { resolve: loopbackResolver([]) });
    expect(
      await errorOf(
        client.request({
          method: 'GET',
          url: `http://api.test:${closedPort}/`,
          headers: {},
          body: null,
        }),
      ),
    ).toMatchObject({ code: 'connect_failed', sent: false });
  });
});
