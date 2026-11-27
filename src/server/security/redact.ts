// Recursive structured redaction + defensive string redaction.
// Never let secrets reach logs, audit metadata, or error responses.

export interface RedactionOptions {
  /** Additional literal secrets to redact (e.g. current provider key). */
  secrets?: string[];
  /** Replace known secret-bearing keys with this marker even if value looks innocuous. */
  keyMarker?: string;
  /** Include key names that hold secrets. */
  secretKeys?: string[];
}

const DEFAULT_SECRET_KEYS = [
  'authorization',
  'authorizationheader',
  'x-api-key',
  'xapikey',
  'api-key',
  'apikey',
  'api_key',
  'apiKey',
  'api_key_plain',
  'apiKeyPlain',
  'cookie',
  'set-cookie',
  'setcookie',
  'session',
  'sessiontoken',
  'token',
  'accesstoken',
  'refresh_token',
  'password',
  'passwd',
  'currentpassword',
  'newpassword',
  'masterkey',
  'master_key',
  'encrypted_api_key',
  'apiKeyNonce',
  'api_key_nonce',
  'totpsecret',
  'totp_secret',
  'recoverycode',
  'recoverycodes',
  'secret',
  'client_secret',
  'privatekey',
  'x-goog-api-key',
];

const SECRET_KEY_REGEX = /(authorization|api[-_]?key|api[-_]?secret|password|passwd|secret|token|cookie|master[-_]?key|totp|recovery|private[-_]?key|session)/i;

const PLAINTEXT_PATTERNS: RegExp[] = [
  /\bld-[A-Za-z0-9_-]{20,}\b/g, // auto-generated gateway api keys (custom keys are covered by the Bearer/x-api-key patterns below)
  /(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /sk-[A-Za-z0-9_-]{12,}/g, // OpenAI-style
  /anthropic[_-]?[A-Za-z0-9_-]{20,}/gi,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /x-api-key[":= ]+[A-Za-z0-9._~+/=-]{8,}/gi,
  /Authorization[":= ]+[A-Za-z0-9._~+/=-]{8,}/gi,
];

const REDACTED = '[REDACTED]';

export function redactValue(value: unknown, opts: RedactionOptions = {}): unknown {
  const { secrets = [], keyMarker = REDACTED, secretKeys = DEFAULT_SECRET_KEYS } = opts;
  const allSecrets = new Set(secrets.filter((s) => s && s.length >= 6));
  return redactInternal(value, allSecrets, keyMarker, secretKeys);
}

function redactInternal(value: unknown, secrets: Set<string>, marker: string, secretKeys: string[]): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    let out = value;
    for (const s of secrets) {
      if (s && out.includes(s)) out = out.split(s).join(marker);
    }
    for (const re of PLAINTEXT_PATTERNS) {
      out = out.replace(re, marker);
    }
    return out;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => redactInternal(v, secrets, marker, secretKeys));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (secretKeys.includes(k) || SECRET_KEY_REGEX.test(k)) {
        out[k] = v === null || v === undefined ? v : marker;
      } else {
        out[k] = redactInternal(v, secrets, marker, secretKeys);
      }
    }
    return out;
  }
  return value;
}

/** Redact any known secrets from a string (for error messages). */
export function redactString(input: string, opts: RedactionOptions = {}): string {
  const { secrets = [] } = opts;
  let out = input;
  for (const s of secrets) {
    if (s && out.includes(s)) out = out.split(s).join(REDACTED);
  }
  for (const re of PLAINTEXT_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

export function redactJsonString(json: string | null | undefined, opts?: RedactionOptions): string | null {
  if (!json) return json ?? null;
  try {
    const parsed = JSON.parse(json);
    return JSON.stringify(redactValue(parsed, opts));
  } catch {
    return redactString(json, opts);
  }
}
