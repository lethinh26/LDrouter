// Unit tests: Qoder COSY request signing (headers, signature shape, body digest).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildCosyHeaders, computeSigPath, generateMachineId } from '../../src/server/providers/qoder/cosy';
import { QODER_CHAT_URL } from '../../src/server/providers/qoder/constants';

const creds = { userId: 'u-1', authToken: 'jt-test-token', name: 'Dev', email: 'dev@example.com', machineId: 'machine-1' };

describe('Qoder COSY signing', () => {
  it('produces the full Cosy header set with the machine fingerprint', () => {
    const headers = buildCosyHeaders(Buffer.from('{}'), QODER_CHAT_URL, creds);
    expect(Object.keys(headers).sort()).toEqual([
      'Authorization', 'Cosy-Bodyhash', 'Cosy-Bodylength', 'Cosy-Clientip', 'Cosy-Clienttype',
      'Cosy-Data-Policy', 'Cosy-Date', 'Cosy-Key', 'Cosy-Machineid', 'Cosy-Machineos',
      'Cosy-Machinetoken', 'Cosy-Machinetype', 'Cosy-Organization-Id', 'Cosy-Organization-Tags',
      'Cosy-Sigpath', 'Cosy-User', 'Cosy-Version', 'Login-Version', 'X-Request-Id',
    ].sort());
    expect(headers['Cosy-User']).toBe('u-1');
    expect(headers['Cosy-Machineid']).toBe('machine-1');
    expect(headers['Cosy-Machinetoken']).toBe('machine-1');
    expect(headers['Cosy-Version']).toBe('1.0.0');
    expect(headers['Cosy-Clienttype']).toBe('5');
    expect(headers['Login-Version']).toBe('v2');
  });

  it('shapes Authorization as a COSY bearer with payload and signature', () => {
    const headers = buildCosyHeaders(Buffer.from('{}'), QODER_CHAT_URL, creds);
    expect(headers.Authorization).toMatch(/^Bearer COSY\.[A-Za-z0-9+/=]+\.[0-9a-f]{32}$/);
    const payloadB64 = headers.Authorization!.split('.')[1]!;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8')) as Record<string, unknown>;
    expect(payload).toMatchObject({ version: 'v1', cosyVersion: '1.0.0', ideVersion: '' });
    expect(typeof payload.requestId).toBe('string');
    expect(typeof payload.info).toBe('string');
  });

  it('strips the leading /algo from the signed path', () => {
    expect(computeSigPath(QODER_CHAT_URL)).toBe('/api/v2/service/pro/sse/agent_chat_generation');
    expect(computeSigPath('not a url')).toBe('');
  });

  it('hashes and measures the exact body bytes that will be sent', () => {
    const body = Buffer.from('{"a":1}', 'latin1');
    const headers = buildCosyHeaders(body, QODER_CHAT_URL, creds);
    expect(headers['Cosy-Bodyhash']).toBe(createHash('md5').update(body).digest('hex'));
    expect(headers['Cosy-Bodylength']).toBe(String(body.length));
  });

  it('hashes an empty body to the canonical empty MD5', () => {
    expect(buildCosyHeaders(Buffer.alloc(0), QODER_CHAT_URL, creds)['Cosy-Bodyhash']).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('generates a machine id when the account has none', () => {
    const headers = buildCosyHeaders(Buffer.alloc(0), QODER_CHAT_URL, { userId: 'u-1', authToken: 'jt-test-token' });
    expect(headers['Cosy-Machineid']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('refuses to sign without a user id or token', () => {
    expect(() => buildCosyHeaders(Buffer.alloc(0), QODER_CHAT_URL, { userId: '', authToken: 'jt-test-token' })).toThrow('user id is empty');
    expect(() => buildCosyHeaders(Buffer.alloc(0), QODER_CHAT_URL, { userId: 'u-1', authToken: '' })).toThrow('auth token is empty');
  });

  it('varies per request while keeping the body digest stable', () => {
    const first = buildCosyHeaders(Buffer.from('{}'), QODER_CHAT_URL, creds);
    const second = buildCosyHeaders(Buffer.from('{}'), QODER_CHAT_URL, creds);
    expect(first['Cosy-Key']).not.toBe(second['Cosy-Key']);
    expect(first['X-Request-Id']).not.toBe(second['X-Request-Id']);
    expect(first['Cosy-Bodyhash']).toBe(second['Cosy-Bodyhash']);
  });

  it('generates a uuid machine id on demand', () => {
    expect(generateMachineId()).not.toBe(generateMachineId());
  });
});
