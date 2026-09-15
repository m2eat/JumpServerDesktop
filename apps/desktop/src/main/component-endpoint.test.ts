import { describe, expect, it } from 'vitest';
import { resolveComponentEndpoint } from './component-endpoint';

describe('Core smart endpoint routing', () => {
  it('inherits port zero and preserves the gateway prefix only on its own origin', () => {
    const site = 'https://gateway.example:8443/jumpserver/';
    expect(resolveComponentEndpoint(site, { host: '', https_port: 0 })).toBe('https://gateway.example:8443/jumpserver');
    expect(resolveComponentEndpoint(site, { host: 'koko.example', https_port: '0' })).toBe('https://koko.example:8443');
    expect(resolveComponentEndpoint(site, { host: 'gateway.example', https_port: 9443 })).toBe('https://gateway.example:9443');
  });

  it('uses the explicit HTTPS entry without replacing it with the current site', () => {
    expect(resolveComponentEndpoint('https://gateway.example/base', { value: 'https://chen.example:9443', host: 'ignored.example', https_port: 0 })).toBe('https://chen.example:9443');
    expect(resolveComponentEndpoint('https://gateway.example:8443', { host: '2001:db8::1', https_port: 9443 })).toBe('https://[2001:db8::1]:9443');
  });

  it('rejects downgrades, credential-bearing addresses and malformed authorities', () => {
    for (const endpoint of [
      { value: 'http://chen.example' },
      { value: 'https://user:secret@chen.example' },
      { value: 'https://chen.example/?token=secret' },
      { host: 'safe.example/../other', https_port: 443 },
      { host: 'user@chen.example', https_port: 443 },
      { host: 'chen.example:9443', https_port: 443 },
      { host: 'chen.example', https_port: '443x' },
      { host: 'chen.example', https_port: 65_536 },
      { host: 'chen.example', is_active: false }
    ]) expect(() => resolveComponentEndpoint('https://gateway.example', endpoint)).toThrow();
  });
});
