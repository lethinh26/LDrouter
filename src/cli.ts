#!/usr/bin/env node
// LateDev Router CLI entry point. The package's "bin" field points here.

import process from 'node:process';

async function main(): Promise<void> {
  // Ensure dist/server is importable
  process.env.LATEDEV_CLI_ENTRY = '1';
  const { startApp } = await import('./server/app.js');
  await startApp();
}

main().catch((err) => {
   
  console.error('Fatal:', err);
  process.exit(1);
});
