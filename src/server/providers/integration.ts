import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db';
import type { Provider } from '../db/schema';
import { GatewayError } from '../errors';

export type ProviderIntegration =
  | { providerKind: 'compatible'; authMode: 'api_key' }
  | { providerKind: 'codex'; authMode: 'client_oauth' }
  | { providerKind: 'claude_code'; authMode: 'api_key' };

export const CODEX_ORIGIN = 'https://chatgpt.com';
export const CODEX_API_PATH = '/backend-api/codex';
export const CLAUDE_CODE_ORIGIN = 'https://api.anthropic.com';

/** Validate the actual credential boundary, not a provider's display name. */
export function providerIntegration(provider: Provider): ProviderIntegration {
  const row = getDb().select().from(schema.providerIntegrations).where(eq(schema.providerIntegrations.providerId, provider.id)).get();
  if (!row) return { providerKind: 'compatible', authMode: 'api_key' };
  if (row.providerKind === 'codex' && row.authMode === 'client_oauth' && provider.type === 'openai' &&
      provider.baseUrl === CODEX_ORIGIN && provider.encryptedApiKey === null && provider.apiKeyNonce === null &&
      provider.customHeadersEncrypted === null && provider.customHeadersNonce === null) {
    return { providerKind: 'codex', authMode: 'client_oauth' };
  }
  if (row.providerKind === 'claude_code' && row.authMode === 'api_key' && provider.type === 'anthropic' && provider.baseUrl === CLAUDE_CODE_ORIGIN && provider.encryptedApiKey && provider.apiKeyNonce && provider.customHeadersEncrypted === null && provider.customHeadersNonce === null) {
    return { providerKind: 'claude_code', authMode: 'api_key' };
  }
  throw new GatewayError('gateway_error', 'Invalid provider integration configuration', { status: 500, code: 'invalid_provider_integration' });
}
