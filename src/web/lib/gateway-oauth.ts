// Fixed public-client contract for LDrouter's own gateway authorization.
// This does not authorize an OpenAI/ChatGPT account.
export const GATEWAY_OAUTH_PATH = '/oauth/authorize';
export const GATEWAY_OAUTH_CLIENT_ID = 'ldrouter-codex';
export const GATEWAY_OAUTH_REDIRECT_PORT = 43127;
export const GATEWAY_OAUTH_REDIRECT_URI = 'http://127.0.0.1:43127/callback';

export interface GatewayAuthorizationRequest {
  client_id: typeof GATEWAY_OAUTH_CLIENT_ID;
  response_type: 'code';
  redirect_uri: typeof GATEWAY_OAUTH_REDIRECT_URI;
  code_challenge: string;
  code_challenge_method: 'S256';
  state: string;
}

/** The query belongs to this one registered client, never an arbitrary redirect. */
export function parseGatewayAuthorization(search: string): GatewayAuthorizationRequest | null {
  const params = new URLSearchParams(search);
  const single = (name: string) => params.getAll(name).length === 1 ? params.get(name) : null;
  const challenge = single('code_challenge');
  const state = single('state');
  if (single('client_id') !== GATEWAY_OAUTH_CLIENT_ID || single('response_type') !== 'code'
    || single('redirect_uri') !== GATEWAY_OAUTH_REDIRECT_URI || single('code_challenge_method') !== 'S256'
    // An S256 challenge encodes 32 bytes as canonical unpadded base64url.
    || !challenge || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(challenge)
    || !state || !/^[A-Za-z0-9._~-]{16,512}$/.test(state)) return null;
  // There are no independently requested scopes. The selected key is the
  // authorization boundary. Do not silently accept requests for other scopes.
  if (params.getAll('scope').length > 1 || (params.get('scope') ?? '') !== '') return null;
  return {
    client_id: GATEWAY_OAUTH_CLIENT_ID, response_type: 'code',
    redirect_uri: GATEWAY_OAUTH_REDIRECT_URI, code_challenge: challenge,
    code_challenge_method: 'S256', state,
  };
}

/** Validate the server response before ever handing a code to a browser URL. */
export function validatedGatewayCallback(value: unknown, state: string): string | null {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith(GATEWAY_OAUTH_REDIRECT_URI + '?')) return null;
  try {
    const url = new URL(value);
    const code = url.searchParams.get('code');
    if (url.origin !== 'http://127.0.0.1:43127' || url.pathname !== '/callback'
      || url.username || url.password || url.hash
      || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state
      || url.searchParams.getAll('code').length !== 1 || !code || !/^ldo-c-[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(code)
      || [...url.searchParams.keys()].some(key => key !== 'state' && key !== 'code')) return null;
    return url.href;
  } catch { return null; }
}

/** Preserve only the OAuth query across the existing admin-login transition. */
export function adminLoginReturnPath(locationState: unknown): string {
  const from = (locationState as { from?: { pathname?: unknown; search?: unknown } } | null)?.from;
  const pathname = from?.pathname;
  const containsUnsafeWhitespace = (value: string) => Array.from(value).some(character => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127;
  });
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')
    || /[\\?#]/.test(pathname) || containsUnsafeWhitespace(pathname)) return '/';
  if (pathname === GATEWAY_OAUTH_PATH && typeof from?.search === 'string'
    && from.search.startsWith('?') && !from.search.includes('#') && !containsUnsafeWhitespace(from.search)
    && from.search.length <= 4096) return pathname + from.search;
  return pathname;
}

export interface GatewayConsentKey {
  id: string;
  name: string;
  keyPrefix: string;
  enabled: boolean;
  expiresAt: string | null;
  allowAllModels: boolean;
  modelCount: number;
  tpmLimit: number | null;
  dailyTokenLimit: number | null;
  monthlyTokenLimit: number | null;
  totalTokenLimit: number | null;
  maxOutputTokensPerRequest: number | null;
}

/** Native Codex cannot enforce token caps; disabled/expired keys are unusable. */
export function gatewayConsentKeyReason(key: GatewayConsentKey, now = Date.now()): string | null {
  if (!key.enabled) return 'Disabled';
  if (key.expiresAt !== null && !(Date.parse(key.expiresAt) > now)) return 'Expired';
  if ([key.tpmLimit, key.dailyTokenLimit, key.monthlyTokenLimit, key.totalTokenLimit, key.maxOutputTokensPerRequest].some(value => value != null)) return 'Token caps are unsupported by native Codex';
  if (!key.allowAllModels && key.modelCount === 0) return 'No model permissions';
  return null;
}
