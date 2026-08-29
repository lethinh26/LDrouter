import { z } from 'zod';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const EnvSchema = z.object({
  LATEDEV_HOST: z.string().default('0.0.0.0'),
  // Port 0 is valid: it means "OS-assigned random port" (used by tests and dev).
  LATEDEV_PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  LATEDEV_DATA_DIR: z.string().optional(),
  LATEDEV_MASTER_KEY: z.string().optional(),
  LATEDEV_TRUST_PROXY: z.coerce.number().int().min(0).max(8).default(0),
  LATEDEV_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LATEDEV_DB_URL: z.string().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export interface RuntimeConfig {
  host: string;
  port: number;
  dataDir: string;
  dbFile: string;
  masterKey: string | null;
  trustProxyHops: number;
  logLevel: string;
  env: 'development' | 'production' | 'test';
  isContainer: boolean;
  appVersion: string;
}

let cached: RuntimeConfig | null = null;

/** Empty-string env vars (e.g. `LATEDEV_MASTER_KEY:` in docker-compose) must not
 *  shadow real defaults — treat them as unset. */
function normalizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of Object.keys(out)) {
    if (out[k] === '') delete out[k];
  }
  return out;
}

function readMasterKeyFile(dataDir: string): string | null {
  try {
    const p = path.join(dataDir, 'master.key');
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf8').trim();
    }
  } catch {
    /* ignore unreadable file — treat as absent */
  }
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): RuntimeConfig {
  if (cached) return cached;

  const parsed = EnvSchema.parse(normalizeEnv(env));
  const cliArgs = parseArgs(argv);
  const dataDir =
    cliArgs.dataDir ??
    parsed.LATEDEV_DATA_DIR ??
    (parsed.NODE_ENV === 'test' ? path.resolve('../.tmp/test-data') : path.resolve(os.homedir(), '.latedev-router'));

  const isContainer = Boolean(env.LATEDEV_DATA_DIR?.startsWith('/data') || process.env.CONTAINER === '1');
  const dbFile = parsed.LATEDEV_DB_URL ?? path.join(dataDir, 'data.sqlite');

  cached = {
    host: cliArgs.host ?? parsed.LATEDEV_HOST,
    port: cliArgs.port ?? parsed.LATEDEV_PORT,
    dataDir,
    dbFile,
    masterKey: parsed.LATEDEV_MASTER_KEY ?? readMasterKeyFile(dataDir),
    trustProxyHops: parsed.LATEDEV_TRUST_PROXY,
    logLevel: parsed.LATEDEV_LOG_LEVEL,
    env: parsed.NODE_ENV,
    isContainer,
    appVersion: process.env.npm_package_version ?? '0.1.0',
  };
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}

export function setConfigMasterKey(key: string): void {
  process.env.LATEDEV_MASTER_KEY = key; // future loadConfig reads pick it up
  if (cached) {
    cached.masterKey = key;
  }
}

function parseArgs(argv: string[]): { host?: string; port?: number; dataDir?: string } {
  const out: { host?: string; port?: number; dataDir?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host' && argv[i + 1]) {
      out.host = argv[++i];
    } else if (a?.startsWith('--host=')) {
      out.host = a.split('=')[1];
    } else if (a === '--port' && argv[i + 1]) {
      out.port = Number(argv[++i]);
    } else if (a?.startsWith('--port=')) {
      out.port = Number(a.split('=')[1]);
    } else if (a === '--data-dir' && argv[i + 1]) {
      out.dataDir = argv[++i];
    } else if (a?.startsWith('--data-dir=')) {
      out.dataDir = a.split('=')[1];
    }
  }
  return out;
}
