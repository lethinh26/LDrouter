// Single source of truth for the running app version.
//
// Precedence:
// 1. LATEDEV_APP_VERSION env (set explicitly, or baked into Docker images via
//    `ENV LATEDEV_APP_VERSION=${APP_VERSION}`).
// 2. The package.json found by walking up from this module — works from
//    dist/server (npm install + Docker) AND the source tree (dev/test), where
//    npm_package_version is unset.
// 3. npm_package_version (npm-run scripts).
// 4. '0.0.0'.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getAppVersion(): string {
  // '0.0.0' is the Dockerfile ARG default (local builds pass no arg) — treat
  // it as unset so the package.json walk yields the real version.
  if (process.env.LATEDEV_APP_VERSION && process.env.LATEDEV_APP_VERSION !== '0.0.0') return process.env.LATEDEV_APP_VERSION;
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
