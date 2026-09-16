// Qoder COSY request signing: AES-128-CBC user blob + RSA-wrapped key + MD5 signature
// over payload || cosyKey || timestamp || body || sigPath, plus the Cosy-* header set.
// Pure: reads no env, touches no DB, logs nothing. The signed material is a credential —
// callers must never log the returned headers.
import { createCipheriv, createHash, publicEncrypt, randomUUID, constants as cryptoConstants } from 'node:crypto';
import {
  QODER_CLIENT_TYPE, QODER_DATA_POLICY, QODER_IDE_VERSION, QODER_LOGIN_VERSION,
  QODER_MACHINE_OS, QODER_MACHINE_TYPE, QODER_RSA_PUBLIC_KEY,
} from './constants';

export interface CosyCredentials {
  userId: string;
  authToken: string;
  name?: string;
  email?: string;
  machineId?: string;
}

export function generateMachineId(): string {
  return randomUUID();
}

/** Strip the leading `/algo`; matches the client convention the upstream validates against. */
export function computeSigPath(requestUrl: string): string {
  let pathname: string;
  try { pathname = new URL(requestUrl).pathname; } catch { return ''; }
  return pathname.startsWith('/algo') ? pathname.slice('/algo'.length) : pathname;
}

function pkcs7Pad(data: Buffer, blockSize: number): Buffer {
  const padding = blockSize - (data.length % blockSize);
  const padded = Buffer.alloc(data.length + padding, padding);
  data.copy(padded, 0);
  return padded;
}

function aesEncryptCbcBase64(plaintext: string, key: string): string {
  const keyBytes = Buffer.from(key, 'utf8');
  if (keyBytes.length !== 16) throw new Error(`qoder cosy: aes key must be 16 bytes, got ${keyBytes.length}`);
  const cipher = createCipheriv('aes-128-cbc', keyBytes, keyBytes);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(pkcs7Pad(Buffer.from(plaintext, 'utf8'), 16)), cipher.final()]).toString('base64');
}

const md5 = (input: Buffer | string): string => createHash('md5').update(input).digest('hex');

/**
 * Build the full Cosy-* header map for one request.
 * `body` must be the exact bytes that will be sent (the obfuscated body for chat,
 * an empty buffer for GETs).
 */
export function buildCosyHeaders(body: Buffer | Uint8Array | string, requestUrl: string, creds: CosyCredentials): Record<string, string> {
  if (!creds?.userId) throw new Error('qoder cosy: user id is empty');
  if (!creds?.authToken) throw new Error('qoder cosy: auth token is empty');

  const bodyBuf = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body, 'latin1') : Buffer.from(body ?? []);

  // Fresh AES key per request: first 16 chars of a uuid4, which also becomes the IV.
  const aesKey = randomUUID().slice(0, 16);
  const info = aesEncryptCbcBase64(JSON.stringify({
    uid: creds.userId, security_oauth_token: creds.authToken, name: creds.name ?? '', aid: '', email: creds.email ?? '',
  }), aesKey);
  const cosyKey = publicEncrypt(
    { key: QODER_RSA_PUBLIC_KEY, padding: cryptoConstants.RSA_PKCS1_PADDING },
    Buffer.from(aesKey, 'utf8'),
  ).toString('base64');

  const timestamp = String(Math.floor(Date.now() / 1000));
  const payloadB64 = Buffer.from(JSON.stringify({
    version: 'v1', requestId: randomUUID(), info, cosyVersion: QODER_IDE_VERSION, ideVersion: '',
  }), 'utf8').toString('base64');

  const sigPath = computeSigPath(requestUrl);
  const sig = md5(Buffer.from(`${payloadB64}\n${cosyKey}\n${timestamp}\n${bodyBuf.toString('latin1')}\n${sigPath}`, 'latin1'));

  const machineId = creds.machineId || generateMachineId();
  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': creds.userId,
    'Cosy-Date': timestamp,
    'Cosy-Version': QODER_IDE_VERSION,
    'Cosy-Machineid': machineId,
    'Cosy-Machinetoken': machineId,
    'Cosy-Machinetype': QODER_MACHINE_TYPE,
    'Cosy-Machineos': QODER_MACHINE_OS,
    'Cosy-Clienttype': QODER_CLIENT_TYPE,
    'Cosy-Clientip': '127.0.0.1',
    'Cosy-Bodyhash': md5(bodyBuf),
    'Cosy-Bodylength': String(bodyBuf.length),
    'Cosy-Sigpath': sigPath,
    'Cosy-Data-Policy': QODER_DATA_POLICY,
    'Cosy-Organization-Id': '',
    'Cosy-Organization-Tags': '',
    'Login-Version': QODER_LOGIN_VERSION,
    'X-Request-Id': randomUUID(),
  };
}
