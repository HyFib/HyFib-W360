import { BlockList, isIP } from 'node:net';

/**
 * Client addresses for audit and security metadata. Values are validated with Node's IP parser
 * (never with loose patterns), so anything stored is accepted by PostgreSQL `inet`; malformed input
 * becomes `null` instead of failing the business transaction that records it.
 */
export function normalizeIpAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  let candidate = value.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(candidate);
  if (bracketed) {
    candidate = bracketed[1] ?? '';
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(candidate)) {
    candidate = candidate.slice(0, candidate.lastIndexOf(':'));
  }
  // Zone identifiers (fe80::1%eth0) are not valid inet values.
  if (candidate.includes('%')) return null;
  const mapped = /^::ffff:(.+)$/i.exec(candidate);
  if (mapped && isIP(mapped[1] ?? '') === 4) candidate = mapped[1] ?? '';
  return isIP(candidate) ? candidate : null;
}

/**
 * Parses TRUSTED_PROXIES (comma-separated addresses or CIDR ranges of our own load balancers).
 * Throws on malformed entries so a typo cannot silently widen trust.
 */
export function parseTrustedProxies(value: string | null | undefined): BlockList | null {
  const entries = (value ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.length === 0) return null;
  const list = new BlockList();
  for (const entry of entries) {
    const [address = '', prefix] = entry.split('/');
    const family = isIP(address);
    if (!family) throw new Error(`TRUSTED_PROXIES: "${entry}" is not an IP address or CIDR range`);
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) {
      list.addAddress(address, type);
      continue;
    }
    const bits = Number(prefix);
    if (!/^\d{1,3}$/.test(prefix) || bits > (family === 4 ? 32 : 128)) {
      throw new Error(`TRUSTED_PROXIES: "${entry}" has an invalid prefix length`);
    }
    list.addSubnet(address, bits, type);
  }
  return list;
}

/**
 * Resolves the client address from forwarding headers. Hops are read from the nearest (right-most)
 * outwards, skipping our own trusted proxies; the first other address is the client as seen by our
 * edge. Entries further left are client-supplied and ignored. A malformed hop stops resolution
 * (returns `null`) rather than guessing. Without a trusted-proxy list the nearest hop is used, which
 * is only correct when the edge proxy overwrites or appends X-Forwarded-For (see DEPLOYMENT.md).
 */
export function resolveClientIp(
  forwardedFor: string | null | undefined,
  realIp: string | null | undefined,
  trustedProxies: BlockList | null,
): string | null {
  const hops = (forwardedFor ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  if (hops.length === 0) return normalizeIpAddress(realIp);
  for (let i = hops.length - 1; i >= 0; i--) {
    const ip = normalizeIpAddress(hops[i]);
    if (!ip) return null;
    if (trustedProxies?.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6')) continue;
    return ip;
  }
  return null;
}
