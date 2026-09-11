import { describe, expect, it } from 'vitest';
import { decryptBackupMasterKey, encryptBackupMasterKey } from '../../src/server/auth/backup-crypto';

describe('backup master-key encryption', () => {
  it('round-trips a master key with a six-digit passphrase', () => {
    const masterKey = Buffer.from('master-key-bytes-32-abcdefghijkl').subarray(0, 32);
    const envelope = encryptBackupMasterKey(masterKey, '123456');

    expect(decryptBackupMasterKey(envelope, '123456')).toEqual(masterKey);
  });

  it('rejects an incorrect six-digit passphrase', () => {
    const envelope = encryptBackupMasterKey(Buffer.alloc(32, 7), '123456');

    expect(() => decryptBackupMasterKey(envelope, '654321')).toThrow();
  });

  it.each(['12345', '1234567', 'abcdef'])('rejects invalid passphrase %s', (passphrase) => {
    expect(() => encryptBackupMasterKey(Buffer.alloc(32), passphrase)).toThrow(/six digits/);
  });
});
