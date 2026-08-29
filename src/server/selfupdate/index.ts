// Self-update: check the npm registry for newer versions and apply them.
//
// Two deployment modes:
// - npm global install: `run()` installs <pkg>@latest globally with the
//   detected package manager, then signals SIGTERM to itself so the regular
//   graceful-shutdown path (app.close + closeDb) runs and the supervisor
//   (systemd/pm2/…) restarts the new version.
// - Docker: `run()` asks a Watchtower sidecar (HTTP API, label-enable mode)
//   to pull the new image and recreate this container. The registry is the
//   source of truth for "latest" in both modes — npm and the GHCR image are
//   published together from the same release.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execa } from 'execa';
import semver from 'semver';
import { getLogger } from '../logging/logger';
import { getAppVersion } from '../version';

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

export interface CheckResult {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  changelogUrl: string | null;
  checkedAt: string;
  /** Docker only: whether the configured Watchtower sidecar is reachable */
  watchtowerReachable: boolean | null;
}

export interface UpdateStatus {
  available: boolean;
  reason: string | null;
  updating: boolean;
  docker: boolean;
  /** Docker only: a reachable Watchtower API would make updates one-click */
  watchtower: boolean;
}

export class SelfUpdater {
  private packageName: string;
  private currentVersion: string;
  private inDocker: boolean;
  private cached: CheckResult | null = null;
  private updating = false;

  constructor(packageName: string, currentVersion: string, inDocker: boolean = fs.existsSync('/.dockerenv')) {
    this.packageName = packageName;
    this.currentVersion = currentVersion;
    this.inDocker = inDocker;
  }

  private watchtowerEnabled(): boolean {
    return Boolean(process.env.LATEDEV_WATCHTOWER_URL);
  }

  status(): UpdateStatus {
    const docker = this.inDocker;
    const watchtower = docker && this.watchtowerEnabled();
    if (this.updating) return { available: false, reason: 'Update already running', updating: true, docker, watchtower };
    if (docker && !watchtower) {
      return {
        available: false,
        reason:
          'Docker deployment without a Watchtower updater — enable the watchtower compose service, or run `docker compose pull && docker compose up -d` on the host',
        updating: false,
        docker: true,
        watchtower: false,
      };
    }
    return { available: true, reason: null, updating: false, docker, watchtower };
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
        watchtowerReachable: null,
      };
      result.watchtowerReachable = this.inDocker && this.watchtowerEnabled() ? await this.probeWatchtower() : null;
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
        watchtowerReachable: null,
      };
    }
  }

  // Cheap reachability probe (3s): any HTTP answer means the Watchtower API
  // is up; a connection error means the sidecar service is not running.
  private async probeWatchtower(): Promise<boolean> {
    const url = process.env.LATEDEV_WATCHTOWER_URL;
    if (!url) return false;
    const headers: Record<string, string> = {};
    if (process.env.LATEDEV_WATCHTOWER_TOKEN) headers.authorization = `Bearer ${process.env.LATEDEV_WATCHTOWER_TOKEN}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      // GET on the update endpoint: 404/405 is fine — it proves the API listens.
      await fetch(`${url.replace(/\/$/, '')}/v1/update`, { headers, signal: controller.signal });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async run(): Promise<{ ok: true; message: string }> {
    const st = this.status();
    if (!st.available) throw new Error(st.reason ?? 'Update not available');
    const check = await this.check(true);
    if (!check.latestVersion || !check.hasUpdate) throw new Error('No update available');
    this.updating = true;
    const log = getLogger();
    try {
      if (this.inDocker) {
        await this.runWatchtower(check.latestVersion);
        return { ok: true, message: `Watchtower is pulling version ${check.latestVersion} — the container will restart automatically.` };
      }
      const { pm, installArgs } = resolvePackageManager(process.env.npm_execpath);
      log.info({ pm, pkg: this.packageName, to: check.latestVersion }, 'self-update: installing new version');
      await execa(pm, installArgs(`${this.packageName}@${check.latestVersion}`), {
        stdio: 'inherit',
        timeout: 5 * 60 * 1000,
      });
      log.info({ from: this.currentVersion, to: check.latestVersion }, 'self-update: installed, restarting');
      // Signal SIGTERM to ourselves: startApp's handler runs the graceful
      // shutdown (app.close + closeDb), then the supervisor restarts the new
      // version. With no supervisor the process simply stops — the install
      // already succeeded.
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500).unref();
      return { ok: true, message: `Updated ${this.currentVersion} → ${check.latestVersion}. Restarting…` };
    } finally {
      // If the update failed, allow retries.
      setTimeout(() => { this.updating = false; }, 2000).unref();
    }
  }

  // Ask the Watchtower sidecar (HTTP API, label-enable mode) to update the
  // containers that carry the com.centurylinklabs.watchtower.enable=true
  // label — which includes this one. Watchtower pulls the new image and
  // recreates the container; /data survives via the named volume.
  private async runWatchtower(latestVersion: string): Promise<void> {
    const url = process.env.LATEDEV_WATCHTOWER_URL;
    if (!url) throw new Error('LATEDEV_WATCHTOWER_URL is not configured');
    const headers: Record<string, string> = {};
    if (process.env.LATEDEV_WATCHTOWER_TOKEN) headers.authorization = `Bearer ${process.env.LATEDEV_WATCHTOWER_TOKEN}`;
    getLogger().info({ to: latestVersion }, 'self-update: requesting Watchtower update');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let res: Response;
    try {
      res = await fetch(`${url.replace(/\/$/, '')}/v1/update`, { method: 'POST', headers, signal: controller.signal });
    } catch (e) {
      clearTimeout(timer);
      throw new Error(`Watchtower is unreachable at ${url}: ${(e as Error).message}. Start the watchtower compose service first.`, { cause: e });
    }
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Watchtower rejected the update (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
  }
}

let updater: SelfUpdater | null = null;
export function getSelfUpdater(): SelfUpdater {
  if (!updater) updater = new SelfUpdater('ldrouter', getAppVersion());
  return updater;
}
