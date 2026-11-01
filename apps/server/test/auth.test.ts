import { describe, expect, it } from 'vitest';
import { clientKey } from '../src/auth.js';

const req = (ip: string, cf?: string) => ({ ip, get: (name: string) => (name === 'cf-connecting-ip' ? cf : undefined) });

describe('clientKey', () => {
  it('tells visitors apart behind the tunnel, where every request comes from loopback', () => {
    expect(clientKey(req('127.0.0.1', '203.0.113.7'), true)).toBe('203.0.113.7');
    expect(clientKey(req('127.0.0.1', '203.0.113.8'), true)).not.toBe(clientKey(req('127.0.0.1', '203.0.113.7'), true));
  });
  it('ignores the header when not behind the proxy, so a client cannot pick its own bucket', () => {
    expect(clientKey(req('198.51.100.4', '203.0.113.7'), false)).toBe('198.51.100.4');
  });
  it('groups an IPv6 host by prefix so it cannot rotate addresses', () => {
    expect(clientKey(req('::1', '2001:db8:1:2::a'), true)).toBe(clientKey(req('::1', '2001:db8:1:2::b'), true));
  });
});
