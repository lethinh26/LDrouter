// Unit: operator documentation covers the v2 compact/full backup contract.
// Reads the real doc files from disk so the assertions fail if the wording is dropped.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

function expectPhrases(file: string, phrases: string[]): void {
  const body = read(file).toLowerCase();
  for (const phrase of phrases) {
    expect(body, `${file} must mention "${phrase}"`).toContain(phrase.toLowerCase());
  }
}

describe('backup documentation', () => {
  it('docs/07 documents the v2 .ldb container, compact/full profiles, and exclusions', () => {
    expectPhrases('docs/07-SECURITY-ADMIN-AND-BACKUP.md', [
      '.ldb',
      'manifest',
      'compact',
      'full',
      'requests',
      'attempts',
      'audit',
      'response cache',
      'admin sessions',
      'csrf',
      'daily statistics',
      'legacy',
      'v1',
      'json',
    ]);
  });

  it('docs/07 documents the streamed restore lifecycle, limits, and rollback guarantee', () => {
    expectPhrases('docs/07-SECURITY-ADMIN-AND-BACKUP.md', [
      'multipart',
      'stream',
      'checksum',
      'integrity',
      'schema',
      'key envelope',
      'atomic',
      'rollback',
      'pre-restore',
      'LATEDEV_MAX_BACKUP_UPLOAD_BYTES',
      '/api/admin/backup/capabilities',
      'progress',
      'cancel',
      'resumable',
    ]);
  });

  it('docs/07 states a compact backup cannot restore individual request/attempt/audit history', () => {
    expectPhrases('docs/07-SECURITY-ADMIN-AND-BACKUP.md', [
      'cannot restore',
    ]);
  });

  it('docs/11 states compact backups exclude the gateway response cache', () => {
    expectPhrases('docs/11-CACHING.md', [
      'compact',
      'full',
      'response cache',
      'exclude',
    ]);
  });

  it('docs/10 names the acceptance coverage and the proving test files', () => {
    expectPhrases('docs/10-TESTING-AND-ACCEPTANCE.md', [
      'compact',
      'full',
      'tests/integration/backup-export.test.ts',
      'tests/integration/backup-restore-upload.test.ts',
      'tests/integration/statistics-fix.test.ts',
      'tests/integration/backup-restore.test.ts',
      'percentile',
      'p95',
      '413',
      'legacy',
      'progress',
      'cancel',
    ]);
  });

  it('README documents the operator backup/restore contract', () => {
    expectPhrases('README.md', [
      'compact',
      'full',
      '.ldb',
      'passphrase',
      'LATEDEV_MAX_BACKUP_UPLOAD_BYTES',
      'percentile',
    ]);
  });
});
