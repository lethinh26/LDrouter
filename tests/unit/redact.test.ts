// Unit tests: secret redaction.
import { describe, expect, it } from 'vitest';
import { redactValue, redactString } from '../../src/server/security/redact';

describe('redactValue', () => {
  it('redacts ld- API keys in strings', () => {
    const out = redactValue('key is ld-AbCdEfGh1234567890AbCdEfGh1234567890AbCdEfGh1234');
    expect(out).not.toContain('ld-AbCd');
    expect(String(out)).toContain('[REDACTED]');
  });

  it('redacts Authorization headers', () => {
    const out = redactValue({ authorization: 'Bearer sk-secret12345', x: 1 });
    expect(out).toEqual({ authorization: '[REDACTED]', x: 1 });
  });

  it('redacts nested api keys', () => {
    const out = redactValue({ provider: { apiKey: 'sk-real-secret' } });
    expect((out as Record<string, unknown>).provider).toEqual({ apiKey: '[REDACTED]' });
  });

  it('redacts explicit secret values anywhere', () => {
    const out = redactString('error at host 1.2.3.4 key=my-super-secret-token', { secrets: ['my-super-secret-token'] });
    expect(out).not.toContain('my-super-secret-token');
  });

  it('redacts cookies and session tokens', () => {
    const out = redactValue({ cookie: 'ld_session=abc123; foo=bar' });
    expect(out).toEqual({ cookie: '[REDACTED]' });
  });

  it('does not touch innocent objects', () => {
    const out = redactValue({ name: 'provider-1', baseUrl: 'https://api.example.com' });
    expect(out).toEqual({ name: 'provider-1', baseUrl: 'https://api.example.com' });
  });
});
