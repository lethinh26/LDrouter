import crypto from 'node:crypto';

export interface BackupMasterKeyEnvelope {
  algorithm: 'scrypt-aes-256-gcm';
  salt: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

function passphraseKey(passphrase: string, salt: Buffer): Buffer {
  if (!/^\d{6}$/.test(passphrase)) throw new Error('Backup passphrase must contain exactly six digits');
  return crypto.scryptSync(passphrase, salt, 32, { N: 16_384, r: 8, p: 1 });
}

export function encryptBackupMasterKey(masterKey: Buffer, passphrase: string): BackupMasterKeyEnvelope {
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', passphraseKey(passphrase, salt), nonce);
  const ciphertext = Buffer.concat([cipher.update(masterKey), cipher.final()]);
  return {
    algorithm: 'scrypt-aes-256-gcm',
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptBackupMasterKey(envelope: BackupMasterKeyEnvelope, passphrase: string): Buffer {
  if (envelope.algorithm !== 'scrypt-aes-256-gcm') throw new Error('Unsupported backup key encryption');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', passphraseKey(passphrase, Buffer.from(envelope.salt, 'base64')), Buffer.from(envelope.nonce, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
  } catch {
    throw new Error('Invalid backup passphrase');
  }
}
