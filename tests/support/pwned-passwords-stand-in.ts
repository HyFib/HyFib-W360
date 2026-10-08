import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * TEST-ONLY local stand-in for the Pwned Passwords range API (ADR-317): `GET /range/{the first five
 * characters of a SHA-1 hash}` answers the suffixes of the breached passwords it was given, with
 * their counts, one `SUFFIX:COUNT` per line, and padding suffixes with a count of 0 when asked for
 * them (`Add-Padding: true`). It lives under tests/ and is never shipped: production configuration
 * refuses any origin other than https://api.pwnedpasswords.com outside APP_ENV=local|test. Shapes
 * follow docs/research/pwned-passwords.md; they are fixtures, not a claim about the service.
 */

/** A password the end-to-end stand-in lists as breached. */
export const E2E_BREACHED_PASSWORD = 'breached in the e2e stand-in';

export interface PwnedPasswordsStandIn {
  url: string;
  /** Each request's path and padding header, in order. */
  requests: { path: string; padding: string | undefined }[];
  close(): Promise<void>;
}

export async function startPwnedPasswordsStandIn(options: {
  /** Breached passwords and how many breaches list each. */
  breached: Record<string, number>;
  port?: number;
}): Promise<PwnedPasswordsStandIn> {
  const ranges = new Map<string, string[]>();
  for (const [password, count] of Object.entries(options.breached)) {
    const hash = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = hash.slice(0, 5);
    ranges.set(prefix, [...(ranges.get(prefix) ?? []), `${hash.slice(5)}:${count}`]);
  }
  const requests: PwnedPasswordsStandIn['requests'] = [];
  const server: Server = createServer((req, res) => {
    const padding = req.headers['add-padding'];
    requests.push({ path: req.url ?? '', padding: Array.isArray(padding) ? padding[0] : padding });
    const match = /^\/range\/([0-9A-F]{5})$/.exec(req.url ?? '');
    if (req.method !== 'GET' || !match?.[1]) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    const lines = [...(ranges.get(match[1]) ?? [])];
    if (padding === 'true') {
      for (let i = 0; i < 3; i += 1) {
        lines.push(`${randomBytes(18).toString('hex').slice(0, 35).toUpperCase()}:0`);
      }
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end(lines.join('\r\n'));
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
