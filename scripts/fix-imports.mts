#!/usr/bin/env node
// Fix relative import paths in compiled .js files to include .js extension.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../dist');

function walkDir(dir: string): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      fixFile(full);
    }
  }
}

function fixFile(filePath: string): void {
  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;

  // Match import/export statements with relative paths that lack .js extension.
  // This catches:
  //   from './foo' -> from './foo.js'
  //   from '../foo' -> from '../foo.js'
  //   import('./foo') -> import('./foo.js')
  // Also catches require()? but we use import.
  // We also need to avoid matching node_modules or absolute paths.
  const regex = /(from\s+['"])(\.\.?\/[^'"]+?)(['"])/g;
  const dynamicRegex = /(import\s*\(\s*['"])(\.\.?\/[^'"]+?)(['"]\s*\))/g;

  content = content.replace(regex, (match, p1, p2, p3) => {
    if (p2.endsWith('.js')) return match;
    // Avoid double .js
    return `${p1}${p2}.js${p3}`;
  });
  content = content.replace(dynamicRegex, (match, p1, p2, p3) => {
    if (p2.endsWith('.js')) return match;
    return `${p1}${p2}.js${p3}`;
  });

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Fixed imports in ${filePath}`);
  }
}

console.log('Fixing relative imports in dist/...');
walkDir(distDir);
console.log('Done.');