// Unit: self-update version comparison, package-manager detection, status
// modes, and the shared version resolver.
import { describe, it, expect, afterEach } from 'vitest';
import { compareUpdate, resolvePackageManager, SelfUpdater } from '@server/selfupdate/index';
import { getAppVersion } from '@server/version';

describe('compareUpdate', () => {
  it('detects a newer version', () => {
    expect(compareUpdate('1.4.2', '1.5.0')).toBe(true);
    expect(compareUpdate('1.4.2', '2.0.0')).toBe(true);
    expect(compareUpdate('1.4.2', '1.4.3')).toBe(true);
  });

  it('reports no update for same or older versions', () => {
    expect(compareUpdate('1.5.0', '1.5.0')).toBe(false);
    expect(compareUpdate('1.5.0', '1.4.9')).toBe(false);
  });

  it('coerces loose version strings', () => {
    expect(compareUpdate('v1.4.2', '1.5.0')).toBe(true);
    expect(compareUpdate('1.4', '1.5')).toBe(true);
  });

  it('returns null for unparseable versions', () => {
    expect(compareUpdate('dev-build', '1.5.0')).toBeNull();
    expect(compareUpdate('1.4.2', '')).toBeNull();
  });
});

describe('resolvePackageManager', () => {
  it('maps npm_execpath basenames to install commands', () => {
    expect(resolvePackageManager('/usr/lib/node_modules/pnpm/dist/pnpm.cjs')).toEqual({ pm: 'pnpm', installArgs: expect.any(Function) });
    expect(resolvePackageManager('/usr/lib/node_modules/pnpm/dist/pnpm.cjs')!.installArgs('ldrouter@latest')).toEqual(['add', '-g', 'ldrouter@latest']);
    expect(resolvePackageManager('/usr/lib/node_modules/yarn/bin/yarn.js')!.installArgs('ldrouter@latest')).toEqual(['global', 'add', 'ldrouter@latest']);
    expect(resolvePackageManager('/home/u/.bun/install/global/node_modules/bun/bin/bun.js')!.installArgs('ldrouter@latest')).toEqual(['add', '-g', 'ldrouter@latest']);
    expect(resolvePackageManager('/usr/lib/node_modules/npm/bin/npm-cli.js')!.installArgs('ldrouter@latest')).toEqual(['install', '-g', 'ldrouter@latest']);
  });

  it('defaults to npm when npm_execpath is absent', () => {
    const r = resolvePackageManager(undefined);
    expect(r.pm).toBe('npm');
    expect(r.installArgs('ldrouter@latest')).toEqual(['install', '-g', 'ldrouter@latest']);
  });
});

describe('SelfUpdater.status modes', () => {
  afterEach(() => { delete process.env.LATEDEV_WATCHTOWER_URL; });

  it('non-docker: available', () => {
    const u = new SelfUpdater('ldrouter', '1.5.1', false);
    expect(u.status()).toEqual({ available: true, reason: null, updating: false, docker: false, watchtower: false });
  });

  it('docker without Watchtower: unavailable with guidance', () => {
    const u = new SelfUpdater('ldrouter', '1.5.1', true);
    const st = u.status();
    expect(st.available).toBe(false);
    expect(st.docker).toBe(true);
    expect(st.watchtower).toBe(false);
    expect(st.reason).toContain('Watchtower');
  });

  it('docker with Watchtower configured: available', () => {
    process.env.LATEDEV_WATCHTOWER_URL = 'http://watchtower:8080';
    const u = new SelfUpdater('ldrouter', '1.5.1', true);
    const st = u.status();
    expect(st.available).toBe(true);
    expect(st.docker).toBe(true);
    expect(st.watchtower).toBe(true);
  });

  it('run() refuses when no update is available (offline registry)', async () => {
    const u = new SelfUpdater('this-package-must-not-exist-zz9', '999.0.0', false);
    await expect(u.run()).rejects.toThrow(/No update available|not available/i);
  });
});

describe('getAppVersion', () => {
  afterEach(() => { delete process.env.LATEDEV_APP_VERSION; });

  it('resolves the version from package.json in this repo', () => {
    const v = getAppVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
    expect(v).not.toBe('0.1.0');
    expect(v).not.toBe('0.0.0');
  });

  it('honors LATEDEV_APP_VERSION but ignores the 0.0.0 placeholder', () => {
    process.env.LATEDEV_APP_VERSION = '9.9.9';
    expect(getAppVersion()).toBe('9.9.9');
    process.env.LATEDEV_APP_VERSION = '0.0.0';
    expect(getAppVersion()).not.toBe('0.0.0');
  });
});
