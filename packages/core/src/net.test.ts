import { describe, expect, it } from 'vitest';
import { normalizeIpAddress, parseTrustedProxies, resolveClientIp } from './net';

describe('normalizeIpAddress', () => {
  it('accepts valid IPv4 and IPv6 addresses', () => {
    expect(normalizeIpAddress('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIpAddress(' 2001:db8::1 ')).toBe('2001:db8::1');
    expect(normalizeIpAddress('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIpAddress('203.0.113.7:51234')).toBe('203.0.113.7');
    expect(normalizeIpAddress('[2001:db8::1]:443')).toBe('2001:db8::1');
  });

  it('rejects strings that only look like addresses', () => {
    for (const bad of [
      '999.999.999.999',
      '::::',
      '1.2.3',
      '01.2.3.4',
      'fe80::1%eth0',
      '203.0.113.7, 10.0.0.1',
      'localhost',
      '',
      null,
      undefined,
    ]) {
      expect(normalizeIpAddress(bad)).toBeNull();
    }
  });
});

describe('resolveClientIp', () => {
  const trusted = parseTrustedProxies('10.0.0.0/8, 2001:db8:ffff::/48, 192.0.2.10');

  it('takes the nearest hop that is not one of our proxies', () => {
    expect(resolveClientIp('198.51.100.4, 10.1.2.3', null, trusted)).toBe('198.51.100.4');
    expect(resolveClientIp('198.51.100.4, 192.0.2.10, 10.9.9.9', null, trusted)).toBe(
      '198.51.100.4',
    );
  });

  it('ignores client-supplied entries to the left of the first untrusted hop', () => {
    expect(resolveClientIp('6.6.6.6, 198.51.100.4, 10.1.2.3', null, trusted)).toBe('198.51.100.4');
  });

  it('returns null for malformed hops instead of storing them', () => {
    expect(resolveClientIp('999.999.999.999', null, trusted)).toBeNull();
    expect(resolveClientIp('198.51.100.4, ::::', null, null)).toBeNull();
  });

  it('uses the nearest hop without a trusted list and falls back to X-Real-IP', () => {
    expect(resolveClientIp('6.6.6.6, 198.51.100.4', null, null)).toBe('198.51.100.4');
    expect(resolveClientIp(null, '198.51.100.9', null)).toBe('198.51.100.9');
    expect(resolveClientIp('', 'not-an-ip', null)).toBeNull();
  });

  it('returns null when every hop is a trusted proxy', () => {
    expect(resolveClientIp('10.0.0.1, 10.0.0.2', null, trusted)).toBeNull();
  });
});

describe('parseTrustedProxies', () => {
  it('returns null when unset and rejects malformed entries', () => {
    expect(parseTrustedProxies(undefined)).toBeNull();
    expect(parseTrustedProxies(' , ')).toBeNull();
    expect(() => parseTrustedProxies('10.0.0.0/33')).toThrow(/prefix/);
    expect(() => parseTrustedProxies('proxy.internal')).toThrow(/not an IP/);
  });
});
