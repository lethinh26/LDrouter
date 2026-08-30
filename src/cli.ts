#!/usr/bin/env node
// LateDev Router CLI entry point. The package's "bin" field points here.

import process from 'node:process';

async function main(): Promise<void> {
  // Auto-detect TUI mode — defaults to TUI when stdout is interactive
  const hasNoTuiFlag = process.argv.includes('--no-tui');
  const isTuiMode = !hasNoTuiFlag && process.stdin.isTTY && process.stdout.isTTY;

  if (isTuiMode) {
    // Launch TUI mode (zero-dependency console UI)
    const { runCliTui } = await import('./server/cli/tui/noise.js');
    await runCliTui();
    return;
  }

  // Normal server mode (no terminal, or explicitly disabled via --no-tui)
  process.env.LATEDEV_CLI_ENTRY = '1';
  const { startApp } = await import('./server/app.js');
  await startApp();
}

main().catch((err) => {

  console.error('Fatal:', err);
  process.exit(1);
});
