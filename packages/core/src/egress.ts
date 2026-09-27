import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction, type TcpNetConnectOpts } from 'node:net';

/**
 * The egress client: the only way HyFib makes HTTP requests to addresses chosen by a company (the
 * automation HTTP step). It defends against server-side request forgery:
 * - https only, no credentials in the URL, port 443 or an unprivileged port;
 * - every address the name resolves to must be public (private, loopback, link-local and cloud
 *   metadata ranges, CGNAT, multicast, reserved and documentation ranges and their IPv6
 *   equivalents, including IPv4-mapped, NAT64, 6to4 and Teredo forms, are refused);
 * - the connection goes to an address that was checked (the resolver runs once and the socket is
 *   pinned to its answers, trying them in turn until one connects), so a name cannot be re-pointed
 *   at an internal address between the check and the connection (DNS rebinding); TLS still
 *   verifies the certificate for the name;
 * - redirects are never followed (a 3xx is returned as the response);
 * - requests and responses are size-limited and the whole exchange, name resolution included, has
 *   a deadline; system lookups (which cannot be cancelled) are limited in number, so slow names
 *   cannot occupy the process's thread pool.
 * Errors say whether the request may have reached the server (`sent`), so callers never retry a
 * request whose outcome is unknown.
 */

export interface EgressPolicy {
  /**
   * Allows http: and loopback addresses, for local test targets only. Configuration refuses it
   * outside APP_ENV=local|test.
   */
  allowLoopbackForTests: boolean;
  /** Deadline for the whole exchange, name resolution to last byte. */
  timeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  /**
   * System DNS lookups in progress at once, per client. They run in libuv's thread pool and cannot
   * be cancelled, so a lookup that outlives its request's deadline keeps its slot until it ends.
   */
  maxConcurrentLookups: number;
}

export const DEFAULT_EGRESS_POLICY: EgressPolicy = {
  allowLoopbackForTests: false,
  timeoutMs: 10_000,
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 256 * 1024,
  maxConcurrentLookups: 2,
};

/** How long a connection attempt to one address may take before the next address is tried. */
const CONNECT_ATTEMPT_MS = 2_000;

export type EgressErrorCode =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'credentials_in_url'
  | 'port_not_allowed'
  | 'header_not_allowed'
  | 'request_too_large'
  | 'dns_failed'
  | 'address_blocked'
  | 'connect_failed'
  | 'timeout'
  | 'response_too_large'
  | 'network_error';

export class EgressError extends Error {
  constructor(
    readonly code: EgressErrorCode,
    message: string,
    /** Whether the request may have reached the server (its outcome is then unknown). */
    readonly sent: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EgressError';
  }
}

export const EGRESS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type EgressMethod = (typeof EGRESS_METHODS)[number];

export interface EgressRequest {
  method: EgressMethod;
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string | null;
}

export interface EgressResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** The address the request was sent to. */
  address: string;
  durationMs: number;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type EgressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

const systemResolver: EgressResolver = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

// Address ranges ----------------------------------------------------------------------------------

const BLOCKED_V4: readonly [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation (TEST-NET-1)
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation (TEST-NET-2)
  ['203.0.113.0', 24], // documentation (TEST-NET-3)
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including broadcast
];

const BLOCKED_V6: readonly [string, number][] = [
  ['::', 96], // unspecified, loopback and IPv4-compatible addresses
  ['::ffff:0:0', 96], // IPv4-mapped (also checked against the IPv4 ranges)
  ['64:ff9b::', 96], // NAT64 (reaches IPv4 through a gateway)
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo tunnelling
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4 address)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];

// Separate lists per family: a BlockList also checks IPv4 addresses against IPv6 rules in their
// mapped form, so one list with the ::ffff:0:0/96 rule would refuse every IPv4 address.
const blockedV4 = new BlockList();
for (const [address, prefix] of BLOCKED_V4) blockedV4.addSubnet(address, prefix, 'ipv4');
const blockedV6 = new BlockList();
for (const [address, prefix] of BLOCKED_V6) blockedV6.addSubnet(address, prefix, 'ipv6');

const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

/** Whether HyFib may connect to `address` under `policy` (the address must be an IP literal). */
export function isAllowedAddress(
  address: string,
  policy: Pick<EgressPolicy, 'allowLoopbackForTests'>,
) {
  const family = isIP(address);
  if (family === 0) return false;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (policy.allowLoopbackForTests && loopback.check(address, type)) return true;
  return family === 4 ? !blockedV4.check(address, 'ipv4') : !blockedV6.check(address, 'ipv6');
}

// Requests ----------------------------------------------------------------------------------------

/** Header names callers may not set: the client owns framing, routing and the connection. */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'proxy-authorization',
  'proxy-connection',
  'accept-encoding',
]);
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
// Printable characters and tabs only: no CR or LF (header injection).
const HEADER_VALUE_RE = /^[\t\x20-\x7e\x80-\xff]{0,4096}$/;

export const EGRESS_USER_AGENT = 'HyFib-W360-Automations/1';

interface Target {
  url: URL;
  hostname: string;
  port: number;
  secure: boolean;
}

/** Validates a URL for egress; throws `EgressError` (never sent) when it is not allowed. */
export function parseEgressUrl(
  raw: string,
  policy: Pick<EgressPolicy, 'allowLoopbackForTests'>,
): Target {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new EgressError('invalid_url', 'Enter a valid URL.', false, { cause });
  }
  const secure = url.protocol === 'https:';
  if (!secure && !(policy.allowLoopbackForTests && url.protocol === 'http:')) {
    throw new EgressError('scheme_not_allowed', 'Only https:// addresses can be called.', false);
  }
  if (url.username || url.password) {
    throw new EgressError(
      'credentials_in_url',
      'Put credentials in a header, not in the address.',
      false,
    );
  }
  const port = url.port ? Number(url.port) : secure ? 443 : 80;
  if (!policy.allowLoopbackForTests && port !== 443 && port < 1024) {
    throw new EgressError('port_not_allowed', 'Use port 443 or a port from 1024 up.', false);
  }
  // Brackets around IPv6 literals and a trailing dot are not part of the name to resolve.
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (!hostname || hostname.length > 253) {
    throw new EgressError('invalid_url', 'Enter a valid host name.', false);
  }
  return { url, hostname, port, secure };
}

function checkHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME_RE.test(name) || RESERVED_HEADERS.has(lower) || lower.startsWith('proxy-')) {
      throw new EgressError('header_not_allowed', `The header “${name}” cannot be set.`, false);
    }
    if (!HEADER_VALUE_RE.test(value)) {
      throw new EgressError(
        'header_not_allowed',
        `The header “${name}” has characters that are not allowed.`,
        false,
      );
    }
    out[lower] = value;
  }
  return out;
}

class LookupDeadline extends Error {}

/**
 * Runs lookups through `resolve`, at most `max` at a time. A lookup that is still waiting for a
 * slot, or still running, when `ms` pass is abandoned by its caller (`LookupDeadline`); a running
 * one keeps its slot until it ends, because system lookups cannot be cancelled.
 */
function limitLookups(resolve: EgressResolver, max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };
  return (hostname: string, ms: number): Promise<ResolvedAddress[]> =>
    new Promise((resolvePromise, reject) => {
      let settled = false;
      const start = () => {
        active += 1;
        Promise.resolve()
          .then(() => resolve(hostname))
          .then(
            (answers) => {
              release();
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolvePromise(answers);
            },
            (error: unknown) => {
              release();
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              reject(error instanceof Error ? error : new Error(String(error)));
            },
          );
      };
      const timer = setTimeout(
        () => {
          if (settled) return;
          settled = true;
          const queued = waiting.indexOf(start);
          if (queued >= 0) waiting.splice(queued, 1);
          reject(new LookupDeadline());
        },
        Math.max(0, ms),
      );
      if (active < Math.max(1, max)) start();
      else waiting.push(start);
    });
}

async function resolveTarget(
  target: Target,
  policy: EgressPolicy,
  lookup: (hostname: string, ms: number) => Promise<ResolvedAddress[]>,
  ms: number,
): Promise<ResolvedAddress[]> {
  const literal = isIP(target.hostname);
  const answers = literal
    ? [{ address: target.hostname, family: literal as 4 | 6 }]
    : await lookup(target.hostname, ms).catch((cause: unknown) => {
        throw new EgressError(
          'dns_failed',
          cause instanceof LookupDeadline
            ? `The name ${target.hostname} did not resolve within ${policy.timeoutMs / 1000} seconds.`
            : `The name ${target.hostname} did not resolve.`,
          false,
          { cause },
        );
      });
  if (answers.length === 0) {
    throw new EgressError('dns_failed', `The name ${target.hostname} did not resolve.`, false);
  }
  // Every answer must be allowed: a name that also points inside the network is refused.
  for (const answer of answers) {
    if (!isAllowedAddress(answer.address, policy)) {
      throw new EgressError(
        'address_blocked',
        `${target.hostname} points to an address that cannot be called.`,
        false,
      );
    }
  }
  return answers;
}

export interface EgressClient {
  request(input: EgressRequest): Promise<EgressResponse>;
}

export function createEgressClient(
  policy: EgressPolicy = DEFAULT_EGRESS_POLICY,
  deps: { resolve?: EgressResolver; now?: () => number } = {},
): EgressClient {
  const lookup = limitLookups(deps.resolve ?? systemResolver, policy.maxConcurrentLookups);
  const now = deps.now ?? Date.now;
  return {
    async request(input) {
      const started = now();
      // One deadline for the whole exchange, name resolution included.
      const deadline = started + policy.timeoutMs;
      const target = parseEgressUrl(input.url, policy);
      if (!EGRESS_METHODS.includes(input.method)) {
        throw new EgressError('invalid_url', 'Choose GET, POST, PUT, PATCH or DELETE.', false);
      }
      const headers = checkHeaders(input.headers);
      const body = input.body === null ? null : Buffer.from(input.body, 'utf8');
      if (body && body.length > policy.maxRequestBytes) {
        throw new EgressError(
          'request_too_large',
          `The request body is larger than ${policy.maxRequestBytes} bytes.`,
          false,
        );
      }
      const pinned = await resolveTarget(target, policy, lookup, deadline - now());
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new EgressError(
          'timeout',
          `No complete response within ${policy.timeoutMs / 1000} seconds.`,
          false,
        );
      }
      // The socket connects to a checked address, trying each in turn until one connects (Node's
      // address selection); the name only goes into SNI and Host.
      const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
        if (options.all) callback(null, pinned);
        else callback(null, pinned[0]?.address ?? '', pinned[0]?.family ?? 4);
      };
      const requestHeaders: Record<string, string> = {
        'user-agent': EGRESS_USER_AGENT,
        accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
        ...headers,
        ...(body
          ? {
              'content-type': headers['content-type'] ?? 'application/json',
              'content-length': String(body.length),
            }
          : {}),
      };
      const transport = target.secure ? https : http;
      const signal = AbortSignal.timeout(remaining);

      return new Promise<EgressResponse>((resolvePromise, reject) => {
        let connected = false;
        let settled = false;
        const fail = (error: EgressError) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        // Node passes the socket options on to net.connect; its typings for request options omit
        // the address-selection ones, so they are declared here.
        const options: https.RequestOptions &
          Pick<TcpNetConnectOpts, 'autoSelectFamily' | 'autoSelectFamilyAttemptTimeout'> = {
          host: target.hostname,
          port: target.port,
          path: `${target.url.pathname}${target.url.search}`,
          method: input.method,
          headers: requestHeaders,
          lookup: pinnedLookup,
          // Try every checked address in turn (whatever the process default), not only the first.
          autoSelectFamily: true,
          autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_MS,
          // A fresh connection per request: no keep-alive pool shared between companies.
          agent: false,
          signal,
          ...(target.secure
            ? { servername: isIP(target.hostname) ? undefined : target.hostname }
            : {}),
        };
        const req = transport.request(options);
        req.on('socket', (socket) => {
          socket.once(target.secure ? 'secureConnect' : 'connect', () => {
            connected = true;
          });
        });
        req.on('response', (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > policy.maxResponseBytes) {
              res.destroy();
              req.destroy();
              fail(
                new EgressError(
                  'response_too_large',
                  `The response is larger than ${policy.maxResponseBytes} bytes.`,
                  true,
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (settled) return;
            settled = true;
            const responseHeaders: Record<string, string> = {};
            for (const [name, value] of Object.entries(res.headers)) {
              if (typeof value === 'string') responseHeaders[name] = value;
              else if (Array.isArray(value)) responseHeaders[name] = value.join(', ');
            }
            resolvePromise({
              status: res.statusCode ?? 0,
              headers: responseHeaders,
              body: Buffer.concat(chunks),
              address: res.socket?.remoteAddress ?? pinned[0]?.address ?? '',
              durationMs: now() - started,
            });
          });
          res.on('error', (cause) => {
            fail(new EgressError('network_error', 'The response was cut off.', true, { cause }));
          });
        });
        req.on('error', (cause: NodeJS.ErrnoException) => {
          if (signal.aborted) {
            fail(
              new EgressError(
                'timeout',
                `No complete response within ${policy.timeoutMs / 1000} seconds.`,
                connected,
                { cause },
              ),
            );
            return;
          }
          fail(
            connected
              ? new EgressError(
                  'network_error',
                  'The connection failed during the request.',
                  true,
                  {
                    cause,
                  },
                )
              : new EgressError(
                  'connect_failed',
                  `Could not connect to ${target.hostname}.`,
                  false,
                  { cause },
                ),
          );
        });
        if (body) req.write(body);
        req.end();
      });
    },
  };
}
