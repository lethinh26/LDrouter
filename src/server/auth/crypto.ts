// Master-key encryption utilities (AES-256-GCM).
// Provider API keys and sensitive custom headers are encrypted at rest.

import crypto from 'node:crypto';
import { loadConfig } from '../config/index';

export interface EncryptedPayload {
  ciphertext: string; // base64
  nonce: string; // base64
  version: number;
}

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterKeyError';
  }
}

let cachedKey: Buffer | null = null;
let cachedKeyVersion = 1;

export function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const cfg = loadConfig();
  if (!cfg.masterKey) {
    throw new MasterKeyError('LATEDEV_MASTER_KEY is not configured');
  }
  let key: Buffer;
  try {
    key = Buffer.from(cfg.masterKey, 'base64');
  } catch {
    key = Buffer.alloc(0);
  }
  if (key.length !== 32) {
    // Accept a plain 32-char string too; otherwise error.
    if (cfg.masterKey.length === 32) {
      key = Buffer.from(cfg.masterKey, 'utf8');
    } else {
      throw new MasterKeyError('LATEDEV_MASTER_KEY must be 32 bytes base64 or a 32-char string');
    }
  }
  cachedKey = key;
  return key;
}

export function isMasterKeyConfigured(): boolean {
  return Boolean(loadConfig().masterKey);
}

export function masterKeyVersion(): number {
  return cachedKeyVersion;
}

/** Encrypt a UTF-8 string. Returns { ciphertext (base64), nonce (base64), version }. */
export function encryptSecret(plain: string): EncryptedPayload {
  const key = getMasterKey();
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([ct, tag]).toString('base64'),
    nonce: nonce.toString('base64'),
    version: masterKeyVersion(),
  };
}

/** Decrypt an EncryptedPayload. Throws MasterKeyError on failure. */
export function decryptSecret(payload: EncryptedPayload): string {
  try {
    const key = getMasterKey();
    const nonce = Buffer.from(payload.nonce, 'base64');
    const full = Buffer.from(payload.ciphertext, 'base64');
    const ct = full.subarray(0, full.length - 16);
    const tag = full.subarray(full.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(ct), decipher.final()]);
    return out.toString('utf8');
  } catch (e) {
    throw new MasterKeyError(`Failed to decrypt secret: ${(e as Error).message}`);
  }
}

export function encryptJson(value: unknown): EncryptedPayload {
  return encryptSecret(JSON.stringify(value));
}

export function decryptJson<T>(payload: EncryptedPayload): T {
  return JSON.parse(decryptSecret(payload)) as T;
}

/** Encrypt custom headers map preserving header names. */
export function encryptCustomHeaders(headers: Record<string, string>): EncryptedPayload | null {
  if (!headers || Object.keys(headers).length === 0) return null;
  return encryptJson(headers);
}

export function decryptCustomHeaders(payload: EncryptedPayload | null): Record<string, string> {
  if (!payload) return {};
  return decryptJson<Record<string, string>>(payload);
}

// --- Hashing helpers ------------------------------------------------------

export { sha256Hex, timingSafeEqualHex } from './ids';
