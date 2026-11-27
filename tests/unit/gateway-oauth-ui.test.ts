// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@web/lib/api';
import { GatewayOAuthConsent } from '@web/app/pages/gateway-oauth-authorize';
import { GatewayOAuthGrants, type GatewayOAuthGrant } from '@web/app/pages/gateway-oauth-grants';
import { codexGatewayOAuthConfiguration, builtinClientConfiguration } from '@web/app/pages/builtin-providers';
import {
  adminLoginReturnPath, parseGatewayAuthorization, validatedGatewayCallback,
  GATEWAY_OAUTH_REDIRECT_URI, type GatewayConsentKey,
} from '@web/lib/gateway-oauth';

const request = {
  client_id: 'ldrouter-codex', response_type: 'code', redirect_uri: GATEWAY_OAUTH_REDIRECT_URI,
  code_challenge_method: 'S256', code_challenge: 'A'.repeat(43), state: 'fixture-state-123456789',
};
const search = '?' + new URLSearchParams(request).toString();
const callback = GATEWAY_OAUTH_REDIRECT_URI + '?code=ldo-c-' + 'B'.repeat(42) + 'A&state=' + request.state;
const key: GatewayConsentKey = {
  id: 'key-1', name: 'Codex scoped key', keyPrefix: 'ld-fixture', enabled: true, expiresAt: null,
  allowAllModels: false, modelCount: 1, tpmLimit: null, dailyTokenLimit: null, monthlyTokenLimit: null,
  totalTokenLimit: null, maxOutputTokensPerRequest: null,
};

describe('gateway OAuth contract', () => {
  it('validates the fixed client, redirect, PKCE and state before requesting consent', () => {
    expect(parseGatewayAuthorization(search)).toEqual(request);
    const invalidPatches: Record<string, string>[] = [
      { client_id: 'foreign-client' }, { response_type: 'token' }, { redirect_uri: 'https://evil.example/callback' },
      { redirect_uri: 'http://localhost:43127/callback' }, { redirect_uri: GATEWAY_OAUTH_REDIRECT_URI + '/' },
      { code_challenge_method: 'plain' }, { code_challenge: 'too-short' }, { code_challenge: 'A'.repeat(42) + 'B' }, { state: '' }, { state: 'invalid state with spaces' },
      { scope: 'admin' },
    ];
    for (const patch of invalidPatches) expect(parseGatewayAuthorization('?' + new URLSearchParams({ ...request, ...patch }))).toBeNull();
    expect(parseGatewayAuthorization(search + '&state=other-state-123456789')).toBeNull();
    expect(parseGatewayAuthorization(search + '&redirect_uri=https%3A%2F%2Fevil.example')).toBeNull();
    expect(parseGatewayAuthorization('')).toBeNull();
  });

  it('rejects unsafe callback destinations, state mismatches and ambiguous parameters', () => {
    expect(validatedGatewayCallback(callback, request.state)).toBe(callback);
    for (const value of [
      callback.replace('127.0.0.1', 'localhost'), callback.replace('43127', '43128'),
      callback.replace('/callback?', '/other?'), callback.replace('http:', 'https:'),
      'https://evil.example/?code=fixture&state=' + request.state,
      callback + '#fragment', callback + '&code=duplicate', callback + '&state=' + request.state,
      callback + '&access_token=unexpected', callback.replace(request.state, 'different-state'),
      callback.replace('ldo-c-', 'ldo-a-'), callback.replace('BA&state=', 'BB&state='),
      GATEWAY_OAUTH_REDIRECT_URI + '?state=' + request.state,
    ]) expect(validatedGatewayCallback(value, request.state)).toBeNull();
  });

  it('preserves only the OAuth route search after admin login', () => {
    expect(adminLoginReturnPath({ from: { pathname: '/oauth/authorize', search, hash: '#discard' } })).toBe('/oauth/authorize' + search);
    expect(adminLoginReturnPath({ from: { pathname: '/providers', search: '?ignored=1' } })).toBe('/providers');
    expect(adminLoginReturnPath({ from: { pathname: '//evil.example', search } })).toBe('/');
    expect(adminLoginReturnPath({ from: { pathname: '/\\evil.example' } })).toBe('/');
    expect(adminLoginReturnPath(null)).toBe('/');
  });

  it('builds a separate official gateway OAuth configuration and preserves native upstream auth', () => {
    const config = codexGatewayOAuthConfiguration('cx', 'https://gateway.example');
    expect(config).toContain('model = "cx/YOUR_IMPORTED_MODEL"');
    expect(config).toContain('requires_openai_auth = true');
    expect(config).toContain('[model_providers.latedev-codex.gateway_oauth]');
    expect(config).toContain('client_id = "ldrouter-codex"');
    expect(config).toContain('authorization_url = "https://gateway.example/oauth/authorize"');
    expect(config).toContain('token_url = "https://gateway.example/api/oauth/token"');
    expect(config).toContain('redirect_port = 43127');
    expect(config).toContain('delivery = { kind = "header", name = "X-Gateway-Token", scheme = "Bearer" }');
    expect(config).not.toContain('X-API-Key');
    expect(builtinClientConfiguration('codex', 'legacy', 'https://gateway.example')).toContain('X-API-Key');
    expect(builtinClientConfiguration('claude_code', 'cc', 'https://gateway.example')).not.toContain('gateway_oauth');
  });
});

describe('gateway OAuth UI', () => {
  let mount: HTMLDivElement;
  let root: Root;
  let redirect: ReturnType<typeof vi.fn>;
  const grant: GatewayOAuthGrant = {
    id: 'grant-fixture', apiKeyId: key.id, apiKeyName: key.name, createdAt: '2026-01-01T00:00:00Z',
    accessExpiresAt: '2026-01-01T00:15:00Z', refreshExpiresAt: '2026-01-31T00:00:00Z',
    absoluteExpiresAt: '2026-04-01T00:00:00Z', lastRefreshedAt: null, status: 'active',
  };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mount = document.createElement('div');
    document.body.append(mount);
    root = createRoot(mount);
    redirect = vi.fn();
    vi.spyOn(api, 'get').mockImplementation(async url => {
      if (url === '/api/admin/gateway-oauth/keys') return { keys: [
        { ...key, secret: 'UNEXPECTED_SECRET_DO_NOT_RENDER' },
        { ...key, id: 'disabled', name: 'Disabled key', enabled: false },
        { ...key, id: 'expired', name: 'Expired key', expiresAt: '2000-01-01T00:00:00Z' },
        { ...key, id: 'capped', name: 'Capped key', tpmLimit: 100 },
        { ...key, id: 'no-scope', name: 'No permissions', modelCount: 0 },
      ] } as never;
      if (url === '/api/admin/gateway-oauth/grants') return { grants: [grant] } as never;
      throw new Error('Unexpected GET ' + url);
    });
    vi.spyOn(api, 'post').mockResolvedValue({ redirectUrl: callback });
    vi.spyOn(api, 'del').mockResolvedValue({});
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    mount.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function button(label: string) {
    const item = Array.from(document.body.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === label);
    expect(item, 'Button ' + label).toBeDefined();
    return item!;
  }

  async function renderConsent(query = search) {
    await act(async () => root.render(createElement(MemoryRouter, null,
      createElement(GatewayOAuthConsent, { search: query, onRedirect: redirect }))));
  }

  async function selectKey() {
    const input = mount.querySelector<HTMLInputElement>('input[value="key-1"]');
    expect(input).not.toBeNull();
    await act(async () => input!.click());
  }

  it('never loads keys or posts consent for invalid OAuth input', async () => {
    await renderConsent(search + '&state=duplicate');
    expect(mount.textContent).toContain('Invalid authorization request');
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('requires explicit eligible key selection and approval, then redirects exactly once', async () => {
    await renderConsent();
    expect(api.get).toHaveBeenCalledWith('/api/admin/gateway-oauth/keys');
    expect(api.get).not.toHaveBeenCalledWith('/api/admin/api-keys');
    expect(mount.textContent).not.toContain('UNEXPECTED_SECRET_DO_NOT_RENDER');
    expect(button('Authorize gateway access').disabled).toBe(true);
    for (const id of ['disabled', 'expired', 'capped', 'no-scope']) {
      expect(mount.querySelector<HTMLInputElement>('input[value="' + id + '"]')?.disabled).toBe(true);
    }
    await selectKey();
    expect(api.post).not.toHaveBeenCalled();
    const approve = button('Authorize gateway access');
    expect(approve.disabled).toBe(false);
    await act(async () => { approve.click(); approve.click(); });
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/api/admin/gateway-oauth/authorize', { ...request, apiKeyId: key.id });
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith(callback);
  });

  it('fails closed on an unsafe server response and never retries the consent', async () => {
    vi.mocked(api.post).mockResolvedValue({ redirectUrl: callback + '&state=duplicate' });
    await renderConsent();
    await selectKey();
    await act(async () => button('Authorize gateway access').click());
    expect(redirect).not.toHaveBeenCalled();
    expect(mount.textContent).toContain('authorization response could not be verified');
    expect(button('Authorize gateway access').disabled).toBe(true);
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('lists metadata and revokes only the selected OAuth grant after confirmation', async () => {
    await act(async () => root.render(createElement(GatewayOAuthGrants)));
    expect(mount.textContent).toContain(key.name);
    await act(async () => button('Revoke grant ' + grant.id).click());
    expect(api.del).not.toHaveBeenCalled();
    vi.mocked(api.get).mockResolvedValue({ grants: [{ ...grant, status: 'revoked' }] });
    await act(async () => button('Revoke grant').click());
    expect(api.del).toHaveBeenCalledTimes(1);
    expect(api.del).toHaveBeenCalledWith('/api/admin/gateway-oauth/grants/' + grant.id);
    expect(button('Revoke grant ' + grant.id).disabled).toBe(true);
    expect(mount.textContent).toContain('revoked');
  });
});
