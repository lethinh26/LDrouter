// Remove generated server artifacts before tsc so deleted source modules cannot
// survive a local rebuild or be included in a subsequent npm package.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
for (const entry of ['server', 'shared', 'cli.js', 'migrations']) {
  fs.rmSync(path.join(dist, entry), { recursive: true, force: true });
}
