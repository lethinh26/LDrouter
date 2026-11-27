#!/usr/bin/env node
// Local, operator-started quota reporter. Codex owns its authentication.
// Never read auth files, request login/refresh, or send provider credentials.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const TOKEN_ENV = 'LDROUTER_QUOTA_SYNC_TOKEN';
const TOKEN = /^ldq-[A-Za-z0-9_-]{43}$/;
const ACCOUNT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_RPC_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_BYTES = 32 * 1024;
const RPC_TIMEOUT = 30_000;

class SyncError extends Error {}
type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyncError('Invalid Codex quota response');
  return value as Json;
}

function label(value: unknown, max: number): string | null {
  if (value == null) return null;
  // Only identifier-like provider metadata. Never copy arbitrary text fields.
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9_. -]+$/.test(value) || !value.trim()) {
    throw new SyncError('Unsupported Codex quota label');
  }
  return value;
}

function pickWindow(value: unknown) {
  if (value == null) return null;
  const w = object(value);
  const used = w.usedPercent, duration = w.windowDurationMins, reset = w.resetsAt;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100 ||
      (duration != null && (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 1 || duration > 525600)) ||
      (reset != null && (typeof reset !== 'number' || !Number.isInteger(reset) || reset < 1 || reset > 253402300799))) {
    throw new SyncError('Invalid Codex quota window');
  }
  return { usedPercent: used, windowDurationMins: duration ?? null, resetsAt: reset ?? null };
}

function pickBucket(value: unknown) {
  const b = object(value);
  return { limitId: label(b.limitId, 80), planType: label(b.planType, 64),
    primary: pickWindow(b.primary), secondary: pickWindow(b.secondary) };
}

/** Select only quota fields, hashing the provider account ID locally. */
export function buildQuotaReport(value: unknown, observedAt = new Date().toISOString()) {
  const r = object(value);
  if (typeof r.accountId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(r.accountId)) {
    throw new SyncError('Codex did not report an account identifier; update Codex or import the quota manually');
  }
  if (r.ordinaryUsageAllowed != null && typeof r.ordinaryUsageAllowed !== 'boolean') throw new SyncError('Invalid quota usage state');
  const entries = r.rateLimitsByLimitId == null ? [] : Object.entries(object(r.rateLimitsByLimitId));
  if (entries.length > 16) throw new SyncError('Too many quota buckets');
  const buckets = entries.map(([key, bucket]) => {
    if (!label(key, 80) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new SyncError('Invalid quota bucket identifier');
    return [key, pickBucket(bucket)] as const;
  });
  return {
    observedAt,
    accountFingerprint: createHash('sha256').update(r.accountId, 'utf8').digest('hex'),
    result: { ordinaryUsageAllowed: r.ordinaryUsageAllowed ?? null, rateLimits: pickBucket(r.rateLimits),
      rateLimitsByLimitId: buckets.length ? Object.fromEntries(buckets) : null },
  };
}

export type QuotaReport = ReturnType<typeof buildQuotaReport>;

/** One bounded stdio session: initialize, check auth type, read rate limits.
 * No turn creation, login, token refresh RPC, or server-request responses. */
export function readCodexQuota(executable: string, args: string[] = ['app-server', '--listen', 'stdio://'], signal?: AbortSignal, timeout = RPC_TIMEOUT): Promise<QuotaReport> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new SyncError('Quota sync stopped')); return; }
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === TOKEN_ENV) delete env[key];
    }
    const child = spawn(executable, args, { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let pending = '', bytes = 0, phase = 1, settled = false;
    let report: QuotaReport | undefined, failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => finish(new SyncError('Codex quota request timed out')), timeout);
    const abort = () => finish(new SyncError('Quota sync stopped'));
    signal?.addEventListener('abort', abort, { once: true });
    function finish(error?: Error, value?: QuotaReport) {
      if (settled) return;
      settled = true; failure = error; report = value;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.stdin.end();
      // Let a stdio app-server shut down at EOF before terminating it.
      killTimer = setTimeout(() => { child.kill('SIGKILL'); }, 1000);
    }
    child.once('error', () => finish(new SyncError('Could not start the installed Codex executable')));
    child.stdin.on('error', () => finish(new SyncError('Codex app-server closed its input')));
    child.once('close', () => {
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      settled = true;
      if (report && !failure) resolve(report);
      else reject(failure ?? new SyncError('Codex app-server closed before returning quota'));
    });
    function send(message: Json) {
      if (!settled) child.stdin.write(JSON.stringify(message) + '\n');
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_RPC_BYTES) { finish(new SyncError('Codex response exceeded the size limit')); return; }
      pending += chunk;
      let newline: number;
      while (!settled && (newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
        if (!line) continue;
        try {
          const message = object(JSON.parse(line));
          if (typeof message.method === 'string') {
            if ('id' in message) throw new SyncError('Codex requested an unsupported host action');
            continue; // Notifications are not quota snapshots.
          }
          if (message.id !== phase || 'error' in message || !('result' in message)) throw new SyncError('Codex rejected the quota request or returned an unexpected response');
          if (phase === 1) {
            phase = 2;
            send({ method: 'initialized' });
            send({ id: 2, method: 'account/read', params: { refreshToken: false } });
          } else if (phase === 2) {
            const account = object(message.result).account;
            if (account == null || object(account).type !== 'chatgpt') throw new SyncError('Sign in to an eligible ChatGPT account in the official Codex client first');
            phase = 3;
            send({ id: 3, method: 'account/rateLimits/read' });
          } else {
            finish(undefined, buildQuotaReport(message.result));
          }
        } catch (err) { finish(err instanceof SyncError ? err : new SyncError('Invalid Codex app-server response')); }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ldrouter_quota_sync', title: 'LDrouter Quota Sync', version: '1.0.0' } } });
  });
}

export function quotaEndpoint(gateway: string, account: string): URL {
  let url: URL;
  try { url = new URL(gateway); } catch { throw new SyncError('Specify an LDrouter HTTPS origin'); }
  const local = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || !ACCOUNT.test(account)) throw new SyncError('Use an HTTPS origin (or literal loopback HTTP) and a quota account UUID');
  return new URL('/api/quota-sync/' + account, url.origin);
}

export async function uploadQuota(endpoint: URL, token: string, report: QuotaReport, signal?: AbortSignal): Promise<void> {
  if (!TOKEN.test(token)) throw new SyncError('Invalid quota pairing token');
  const body = JSON.stringify(report);
  if (Buffer.byteLength(body) > MAX_REPORT_BYTES) throw new SyncError('Quota report exceeded the size limit');
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', credentials: 'omit',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new SyncError('LDrouter rejected quota sync (HTTP ' + response.status + '); check pairing, identity and access policy');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SyncError('LDrouter did not acknowledge the quota report');
  let data = Buffer.alloc(0);
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (data.length + part.value.length > 1024) throw new SyncError('Invalid LDrouter acknowledgement');
      data = Buffer.concat([data, Buffer.from(part.value)]);
    }
    if (object(JSON.parse(data.toString('utf8'))).ok !== true) throw new SyncError('LDrouter did not acknowledge the quota report');
  } finally { await reader.cancel(); }
}

function fileExists(file: string): boolean {
  try { return existsSync(file) && statSync(file).isFile(); } catch { return false; }
}

function codexExecutable(explicit?: string): string {
  if (explicit) {
    if (!path.isAbsolute(explicit) || !fileExists(explicit) || (process.platform === 'win32' && !explicit.toLowerCase().endsWith('.exe'))) {
      throw new SyncError('Supply an absolute path to the installed Codex executable, not a shell shim');
    }
    return explicit;
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute)) {
    const direct = path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (fileExists(direct)) return direct;
    // Windows npm installations have a .cmd shim. Resolve the native binary
    // instead of invoking cmd.exe or a shell with user-provided arguments.
    if (process.platform === 'win32' && ['x64', 'arm64'].includes(process.arch)) {
      const triplet = (process.arch === 'x64' ? 'x86_64' : 'aarch64') + '-pc-windows-msvc';
      const pkg = path.join(dir, 'node_modules', '@openai', 'codex');
      const platformPackage = 'codex-win32-' + process.arch;
      for (const root of [pkg, path.join(pkg, 'node_modules', '@openai', platformPackage), path.join(dir, 'node_modules', '@openai', platformPackage)]) {
        const native = path.join(root, 'vendor', triplet, 'codex', 'codex.exe');
        if (fileExists(native)) return native;
      }
    }
  }
  throw new SyncError('Installed Codex executable not found; supply --codex with its absolute path');
}

async function readToken(): Promise<string> {
  if (process.env[TOKEN_ENV]) return process.env[TOKEN_ENV]!;
  if (!process.stdin.isTTY) throw new SyncError('Set ' + TOKEN_ENV + ' for non-interactive use');
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stderr.write('Paste LDrouter quota pairing token (hidden): ');
  try { return (await rl.question('')).trim(); }
  finally { rl.close(); process.stderr.write('\n'); }
}

async function main() {
  const { values } = parseArgs({ options: {
    gateway: { type: 'string' }, account: { type: 'string' }, codex: { type: 'string' },
    interval: { type: 'string' }, help: { type: 'boolean' },
  }, strict: true, allowPositionals: false });
  if (values.help) {
    console.log('ldrouter-quota-sync --gateway HTTPS_ORIGIN --account UUID [--interval 300] [--codex ABSOLUTE_PATH]');
    console.log('Reads quota locally via the signed-in official Codex client. Default: one observation. Optional interval: 300–3600 seconds. Ctrl+C stops.');
    return;
  }
  const endpoint = quotaEndpoint(values.gateway ?? '', values.account ?? '');
  const interval = values.interval === undefined ? null : Number(values.interval);
  if (interval !== null && (!Number.isInteger(interval) || interval < 300 || interval > 3600)) throw new SyncError('Interval must be 300–3600 seconds');
  const executable = codexExecutable(values.codex);
  const token = await readToken();
  if (!TOKEN.test(token)) throw new SyncError('Invalid quota pairing token');
  const stop = new AbortController();
  const cancel = () => stop.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    do {
      const report = await readCodexQuota(executable, undefined, stop.signal);
      await uploadQuota(endpoint, token, report, stop.signal);
      console.log('Quota observation synchronized at ' + report.observedAt);
      if (interval !== null) await sleep(interval * 1000, undefined, { signal: stop.signal });
    } while (interval !== null && !stop.signal.aborted);
  } catch (err) { if (!stop.signal.aborted) throw err; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}

// When imported by tests, do not start a client or contact any network.
if (process.argv[1] && fileExists(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(err => {
    // Never print raw RPC data, user args, fetch errors, or credentials.
    console.error(err instanceof SyncError ? err.message : 'Quota sync failed; check the local Codex client and gateway connection');
    process.exitCode = 1;
  });
}
