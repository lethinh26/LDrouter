// Unit: self-update version comparison and package-manager detection.
import { describe, it, expect } from 'vitest';
import { compareUpdate, resolvePackageManager } from '@server/selfupdate/index';

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
