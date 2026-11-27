// Private pre-0022 recovery copy. It is not part of the active database,
// publicly served files, or the ordinary backup export. Keep the existing
// master key separately; the snapshot does not contain it.
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function snapshotBeforeIntegrationRemoval(raw: Database.Database): void {
  if (raw.name === ':memory:' || !raw.name) return;
  const directory = path.resolve(raw.name) + '.pre-0022';
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw new Error('Pre-rollback snapshot directory is not private');
  }
  const destination = path.join(directory, 'data.sqlite');
  if (fs.existsSync(destination)) {
    const existing = fs.lstatSync(destination);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Invalid pre-rollback snapshot destination');
  }
  const temporaryDirectory = fs.mkdtempSync(path.join(directory, 'snapshot-'));
  const temporaryFile = path.join(temporaryDirectory, 'data.sqlite');
  try {
    // VACUUM INTO makes a consistent SQLite copy including committed WAL data.
    // Do not proceed with the destructive migration if the copy fails.
    raw.prepare('VACUUM INTO ?').run(temporaryFile);
    fs.chmodSync(temporaryFile, 0o600);
    // Keep a single copy, replacing only after a complete new snapshot exists.
    fs.renameSync(temporaryFile, destination);
  } finally {
    fs.rmSync(temporaryFile, { force: true });
    fs.rmdirSync(temporaryDirectory);
  }
}
