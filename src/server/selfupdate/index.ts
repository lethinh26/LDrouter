// Self-update: check the npm registry for newer versions and update the
// globally installed package in place. Docker deployments are excluded —
// their version comes from the image tag and updates happen by pulling a new
// image, never by installing over the running container.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import semver from 'semver';
import { getLogger } from '../logging/logger';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface PackageManager {
  pm: 'npm' | 'pnpm' | 'yarn' | 'bun';
  /** args that install <pkg>@latest globally */
  installArgs: (pkg: string) => string[];
}

// Pure: compare two semver versions. Returns null when either side is not a
// valid semver string (e.g. dev builds), which callers treat as "no update".
export function compareUpdate(currentVersion: string, latestVersion: string): boolean | null {
  const cur = semver.valid(semver.coerce(currentVersion));
  const latest = semver.valid(semver.coerce(latestVersion));
  if (!cur || !latest) return null;
  return semver.gt(latest, cur);
}

// Pure: derive the global-install command from where npm resolves its own
// executable. When the gateway was installed globally with pnpm/yarn/bun,
// those tools still run `npm exec`/npx under the hood, so
// process.env.npm_execpath carries the invoking package manager's script.
export function resolvePackageManager(npmExecPath: string | undefined): PackageManager {
  const pm = npmExecPath ? path.basename(npmExecPath).toLowerCase() : '';
  if (pm.startsWith('pnpm')) return { pm: 'pnpm', installArgs: (pkg) => ['add', '-g', pkg] };
  if (pm.startsWith('yarn')) return { pm: 'yarn', installArgs: (pkg) => ['global', 'add', pkg] };
  if (pm.startsWith('bun')) return { pm: 'bun', installArgs: (pkg) => ['add', '-g', pkg] };
  return { pm: 'npm', installArgs: (pkg) => ['install', '-g', pkg] };
}

interface RegistryMeta {
  version?: string;
  dist?: { tarball?: string };
}

interface CheckResult {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  changelogUrl: string | null;
  checkedAt: string;
}

export class SelfUpdater {
  private packageName: string;
  private currentVersion: string;
  private inDocker = fs.existsSync('/.dockerenv');
  private cached: CheckResult | null = null;
  private updating = false;

  constructor(packageName: string, currentVersion: string) {
    this.packageName = packageName;
    this.currentVersion = currentVersion;
  }

  status(): { available: boolean; reason: string | null; updating: boolean; docker: boolean } {
    if (this.inDocker) {
      return { available: false, reason: 'Docker deployment — update by pulling the new image tag', updating: this.updating, docker: true };
    }
    if (this.updating) return { available: false, reason: 'Update already running', updating: true, docker: false };
    return { available: true, reason: null, updating: false, docker: false };
  }

  // Checks the npm registry (10s timeout). Cached for 15 minutes; a failed
  // check never raises — it just reports no update.
  async check(force = false): Promise<CheckResult> {
    const fresh =
      !force &&
      this.cached &&
      Date.now() - new Date(this.cached.checkedAt).getTime() < 15 * 60 * 1000;
    if (fresh) return this.cached!;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(`https://registry.npmjs.org/${this.packageName}/latest`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      clearTimeout(timer);
      const meta = (res.ok ? ((await res.json()) as RegistryMeta) : {}) as RegistryMeta;
      const coerced = typeof meta.version === 'string' ? semver.coerce(meta.version) : null;
      const latest = coerced && semver.valid(coerced) ? coerced.version : null;
      const tarball = meta.dist?.tarball ?? null;
      const result: CheckResult = {
        currentVersion: this.currentVersion,
        latestVersion: latest,
        hasUpdate: latest ? compareUpdate(this.currentVersion, latest) === true : false,
        // registry.npmjs.org serves package files (including CHANGELOG.md)
        // straight from the tarball URL.
        changelogUrl: tarball ? tarball.replace(/\/-\/.+$/, '/-/CHANGELOG.md') : null,
        checkedAt: new Date().toISOString(),
      };
      this.cached = result;
      return result;
    } catch (e) {
      getLogger().warn({ err: (e as Error).message }, 'update check failed');
      return {
        currentVersion: this.currentVersion,
        latestVersion: null,
        hasUpdate: false,
        changelogUrl: null,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  // Installs the latest version globally with the detected package manager,
  // then terminates the process so the supervisor (systemd, pm2, Docker
  // restart policy…) restarts us on the new version.
  async run(): Promise<{ ok: true; message: string }> {
    const st = this.status();
    if (!st.available) throw new Error(st.reason ?? 'Update not available');
    const check = await this.check(true);
    if (!check.latestVersion || !check.hasUpdate) throw new Error('No update available');
    this.updating = true;
    const log = getLogger();
    try {
      const { pm, installArgs } = resolvePackageManager(process.env.npm_execpath);
      log.info({ pm, pkg: this.packageName, to: check.latestVersion }, 'self-update: installing new version');
      await execa(pm, installArgs(`${this.packageName}@${check.latestVersion}`), {
        stdio: 'inherit',
        timeout: 5 * 60 * 1000,
      });
      log.info({ from: this.currentVersion, to: check.latestVersion }, 'self-update: installed, restarting');
      // Graceful exit: Fastify/supervisor restart policies bring the new
      // version up. (When there is no supervisor the process simply stops —
      // the install already succeeded.)
      setTimeout(() => process.exit(0), 500).unref();
      return { ok: true, message: `Updated ${this.currentVersion} → ${check.latestVersion}. Restarting…` };
    } finally {
      // If the install failed, allow retries.
      setTimeout(() => { this.updating = false; }, 2000).unref();
    }
  }
}

// The running version: walk up from this file to the first package.json
// (works from dist/server/selfupdate AND the source tree, and in Docker
// where npm_package_version is unset) and fall back to the npm-injected
// env var.
function readInstalledVersion(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    try {
      const v = (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: string }).version;
      if (v) return v;
    } catch { /* keep climbing */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.env.npm_package_version ?? '0.0.0';
}

let updater: SelfUpdater | null = null;
export function getSelfUpdater(): SelfUpdater {
  if (!updater) updater = new SelfUpdater('ldrouter', readInstalledVersion());
  return updater;
}
