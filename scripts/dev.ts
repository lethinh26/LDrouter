// Development entry: runs the server with TS source directly.

import process from 'node:process';

async function main(): Promise<void> {
  const { startApp } = await import('../src/server/app');
  await startApp();
}

main().catch((err) => {
   
  console.error('Fatal:', err);
  process.exit(1);
});
