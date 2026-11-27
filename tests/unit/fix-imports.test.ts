import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('resolves emitted file and directory imports to loadable Node ESM', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ldrouter-esm-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'dist', 'db'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    const script = path.join(root, 'scripts', 'fix-imports.mts');
    fs.copyFileSync(path.resolve('scripts/fix-imports.mts'), script);
    fs.writeFileSync(path.join(root, 'dist', 'db', 'index.js'), 'export const value = 40;\n');
    fs.writeFileSync(path.join(root, 'dist', 'number.js'), 'export const number = 2;\n');
    fs.writeFileSync(path.join(root, 'dist', 'entry.js'), [
      "import { value } from './db';",
      "import { number } from './number';",
      "const dynamic = await import('./db');",
      "if (value + number !== 42 || dynamic.value !== value) throw new Error('Invalid fixture');",
    ].join('\n'));
    execFileSync(process.execPath, ['--import', 'tsx/esm', script], { cwd: process.cwd(), timeout: 15000 });
    const entry = path.join(root, 'dist', 'entry.js');
    const content = fs.readFileSync(entry, 'utf8');
    expect(content).toContain("from './db/index.js'");
    expect(content).toContain("from './number.js'");
    expect(content).toContain("import('./db/index.js')");
    expect(() => execFileSync(process.execPath, [entry], { timeout: 15000 })).not.toThrow();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
