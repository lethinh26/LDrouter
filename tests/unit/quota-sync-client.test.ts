import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { buildQuotaReport, quotaEndpoint, readCodexQuota, uploadQuota } from '../../src/quota-sync';

const id = '9fbb71f8-8c54-4cbc-8385-af3b15021e89';
const result = {
  accountId: 'fixture-account', ordinaryUsageAllowed: false,
  rateLimits: { limitId: 'codex', planType: 'plus', primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 2000000000 } },
  rateLimitsByLimitId: { codex: { planType: 'plus', secondary: { usedPercent: 17, windowDurationMins: 10080 } } },
  email: 'private-fixture@example.invalid', accessToken: 'never-upload-this',
};

// A local JSONL fixture that enforces the exact documented, read-only sequence.
// No actual client profile, upstream service, auth file or sign-in is used.
const fixture = `
const readline = require('node:readline');
const r = readline.createInterface({input:process.stdin});
let phase = 0;
const expected = ['initialize','initialized','account/read','account/rateLimits/read'];
r.on('line', line => {
  const msg = JSON.parse(line);
  if (process.env.LDROUTER_QUOTA_SYNC_TOKEN || msg.method !== expected[phase++]) process.exit(12);
  if (msg.method === 'initialized') return;
  let result = {};
  if (msg.method === 'account/read') {
    if (msg.params.refreshToken !== false) process.exit(13);
    result = {account:{type:process.argv[1] || 'chatgpt'}};
  }
  if (msg.method === 'account/rateLimits/read') result = ${JSON.stringify(result)};
  process.stdout.write(JSON.stringify({id:msg.id,result})+'\\n');
});
`;

describe('local Codex quota reporting', () => {
  it('sends only normalized observations and a local identity fingerprint', () => {
    const report = buildQuotaReport(result);
    expect(report.accountFingerprint).toBe(createHash('sha256').update(result.accountId).digest('hex'));
    expect(report.result.ordinaryUsageAllowed).toBe(false);
    expect(report.result.rateLimits.primary?.usedPercent).toBe(42);
    expect(report.result.rateLimitsByLimitId?.codex?.secondary?.usedPercent).toBe(17);
    const serialized = JSON.stringify(report);
    for (const sensitive of [result.accountId, result.email, result.accessToken, 'accessToken', 'email']) expect(serialized).not.toContain(sensitive);
    expect(() => buildQuotaReport({ ...result, accountId: null })).toThrow(/identifier/);
    expect(() => buildQuotaReport({ ...result, rateLimits: { primary: { usedPercent: 101 } } })).toThrow(/window/);
  });

  it('uses the stdio handshake and rejects API-key-only clients', async () => {
    const old = process.env.LDROUTER_QUOTA_SYNC_TOKEN;
    process.env.LDROUTER_QUOTA_SYNC_TOKEN = 'fixture-secret';
    try {
      const report = await readCodexQuota(process.execPath, ['-e', fixture], undefined, 5000);
      expect(report.result.rateLimits.primary?.usedPercent).toBe(42);
      await expect(readCodexQuota(process.execPath, ['-e', fixture, 'apiKey'], undefined, 5000)).rejects.toThrow(/Sign in/);
    } finally {
      if (old === undefined) delete process.env.LDROUTER_QUOTA_SYNC_TOKEN;
      else process.env.LDROUTER_QUOTA_SYNC_TOKEN = old;
    }
  });

  it('terminates a stalled subprocess and refuses host requests', async () => {
    await expect(readCodexQuota(process.execPath, ['-e', 'process.stdin.resume()'], undefined, 100)).rejects.toThrow(/timed out/);
    const ask = `process.stdin.once('data',()=>console.log(JSON.stringify({method:'account/chatgptAuthTokens/refresh',id:9})));process.stdin.resume()`;
    await expect(readCodexQuota(process.execPath, ['-e', ask], undefined, 5000)).rejects.toThrow(/unsupported host action/);
  });

  it('validates the explicit gateway origin and never follows redirects', async () => {
    expect(quotaEndpoint('https://router.example', id).pathname).toBe('/api/quota-sync/' + id);
    for (const url of ['http://router.example', 'https://user:pass@router.example', 'https://router.example/path', 'https://router.example?token=abc']) {
      expect(() => quotaEndpoint(url, id)).toThrow();
    }
    let received = 0;
    const token = 'ldq-' + 'x'.repeat(43);
    const report = buildQuotaReport(result);
    const server = createServer(async (req, res) => {
      received++;
      if (req.url === '/unexpected') { res.writeHead(500).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.headers.authorization !== 'Bearer ' + token || JSON.stringify(body) !== JSON.stringify(report)) { res.writeHead(400).end(); return; }
      if (received === 1) res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      else res.writeHead(307, { location: '/unexpected' }).end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('No fixture address');
      const endpoint = quotaEndpoint('http://127.0.0.1:' + addr.port, id);
      await uploadQuota(endpoint, token, report);
      await expect(uploadQuota(endpoint, token, report)).rejects.toThrow();
      expect(received).toBe(2);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
