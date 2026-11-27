// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@web/lib/api';
import { Providers } from '@web/app/pages/providers';
import { builtinClientConfiguration, builtinModelPrefix, canCreateBuiltinConnection, type BuiltinConnection, type BuiltinProvider } from '@web/app/pages/builtin-providers';

const legacy: BuiltinConnection = {
  id: 'legacy-id', name: 'Legacy Codex profile', slug: 'old-coding', namespaceMode: 'legacy',
  enabled: false, health: 'healthy', authMode: 'client_oauth', modelCount: 2,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', usage: { requests: 42, totalTokens: 1234 },
};
const codex: BuiltinProvider = {
  kind: 'codex', name: 'Codex', slug: 'cx', authMode: 'client_oauth', namespaceAvailable: true, conflicts: [], connections: [legacy],
};
const claude: BuiltinProvider = {
  kind: 'claude_code', name: 'Claude Code', slug: 'cc', authMode: 'api_key', namespaceAvailable: true, conflicts: [], connections: [],
};

describe('built-in provider client settings', () => {
  it('uses the canonical prefix only for canonical connections', () => {
    expect(builtinModelPrefix(codex, legacy)).toBe('old-coding');
    expect(builtinModelPrefix(codex, { ...legacy, namespaceMode: 'canonical' })).toBe('cx');
    expect(builtinModelPrefix(claude, { ...legacy, namespaceMode: 'canonical' })).toBe('cc');
    const config = builtinClientConfiguration('codex', 'old-coding', 'https://gateway.example');
    expect(config).toContain('model = "old-coding/YOUR_IMPORTED_MODEL"');
    expect(config).toContain('requires_openai_auth = true');
    expect(config).toContain('env_http_headers = { "X-API-Key" = "LATEDEV_API_KEY" }');
    expect(builtinClientConfiguration('claude_code', 'cc', 'https://gateway.example')).toContain('ANTHROPIC_MODEL=cc/YOUR_IMPORTED_MODEL');
  });

  it('blocks creation for an occupied namespace or a disabled existing canonical Codex profile', () => {
    expect(canCreateBuiltinConnection({ ...codex, connections: [] })).toBe(true);
    expect(canCreateBuiltinConnection(codex)).toBe(true);
    expect(canCreateBuiltinConnection({ ...codex, connections: [{ ...legacy, namespaceMode: 'canonical' }] })).toBe(false);
    expect(canCreateBuiltinConnection({ ...claude, connections: [legacy] })).toBe(true);
    expect(canCreateBuiltinConnection({ ...claude, namespaceAvailable: false, conflicts: ['Provider: cc'] })).toBe(false);
  });
});

describe('Providers UI', () => {
  let mount: HTMLDivElement;
  let root: Root;
  let catalog: BuiltinProvider[];

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mount = document.createElement('div');
    document.body.append(mount);
    root = createRoot(mount);
    catalog = [{ ...codex, connections: [{ ...legacy }] }, { ...claude, namespaceAvailable: false, conflicts: ['Provider: cc'] }];
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/api/admin/builtin-providers') return { providers: catalog } as never;
      if (url === '/api/admin/providers') return { providers: [
        { ...legacy, providerKind: 'codex', type: 'openai', baseUrl: 'https://chatgpt.com' },
        { id: 'custom-id', name: 'Compatible fixture', slug: 'codex', providerKind: 'compatible', type: 'openai', enabled: true, health: 'healthy', modelCount: 0, baseUrl: 'https://example.test' },
      ] } as never;
      if (url.startsWith('/api/admin/models?providerId=')) return { models: [] } as never;
      throw new Error('Unexpected GET ' + url);
    });
    vi.spyOn(api, 'patch').mockImplementation(async (_url, body) => {
      const change = body as { id: string; enabled?: boolean };
      catalog = catalog.map(p => ({ ...p, connections: p.connections.map(c => c.id === change.id ? { ...c, enabled: change.enabled ?? c.enabled } : c) }));
      return {} as never;
    });
    vi.spyOn(api, 'post').mockRejectedValue(new Error('Unexpected POST'));
    vi.spyOn(api, 'del').mockRejectedValue(new Error('Unexpected DELETE'));
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
  async function click(label: string) {
    await act(async () => button(label).click());
  }

  it('separates custom rows from native connections and manages a legacy profile without OAuth or delete', async () => {
    await act(async () => root.render(createElement(MemoryRouter, null, createElement(Providers))));
    const custom = mount.querySelector('[aria-label="Custom Providers"]')!;
    expect(custom.textContent).toContain('Compatible fixture');
    expect(custom.textContent).not.toContain(legacy.name);
    expect(mount.textContent).toContain('Provider: cc');
    await click('Manage Codex');
    await click('Manage connection ' + legacy.name);
    expect(mount.querySelector('pre')?.textContent).toContain('old-coding/YOUR_IMPORTED_MODEL');
    expect(button('Test connection').disabled).toBe(true);
    expect(mount.textContent).toContain('Gateway attempts');
    expect(mount.textContent).toContain('42');
    expect(mount.querySelector('a[href="/models"]')).not.toBeNull();
    await click('Enable connection');
    expect(api.patch).toHaveBeenCalledWith('/api/admin/providers', { id: legacy.id, enabled: true });
    expect(button('Disable connection')).toBeDefined();
    expect(button('Test connection').disabled).toBe(true);
    await click('Disable connection');
    await click('Disable');
    expect(api.patch).toHaveBeenCalledWith('/api/admin/providers', { id: legacy.id, enabled: false });
    expect(button('Enable connection')).toBeDefined();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.del).not.toHaveBeenCalled();
  });

  it('fetches Claude discovery only when requested and excludes models pinned to another connection', async () => {
    const cc: BuiltinConnection = { ...legacy, id: 'claude-id', name: 'Claude fixture', slug: 'cc', namespaceMode: 'canonical', authMode: 'api_key', enabled: true };
    catalog = [codex, { ...claude, connections: [cc] }];
    vi.mocked(api.post).mockImplementation(async (url) => {
      if (url === '/api/admin/providers/claude-id/discover') return { models: [
        { upstreamId: 'bound-model', displayName: 'Bound', alreadyImported: false, boundElsewhere: true, boundConnectionName: 'Other Claude connection' },
        { upstreamId: 'own-model', displayName: 'Own', alreadyImported: true, boundElsewhere: false },
        { upstreamId: 'new-model', displayName: 'New', alreadyImported: false, boundElsewhere: false },
      ] } as never;
      if (url === '/api/admin/models/import') return { imported: 1, requested: 1 } as never;
      throw new Error('Unexpected POST ' + url);
    });
    await act(async () => root.render(createElement(MemoryRouter, null, createElement(Providers))));
    await click('Manage Claude Code');
    await click('Manage connection Claude fixture');
    expect(api.get).toHaveBeenCalledWith('/api/admin/models?providerId=claude-id');
    expect(api.post).not.toHaveBeenCalled();
    expect(mount.querySelector('pre')?.textContent).toContain('ANTHROPIC_MODEL=cc/YOUR_IMPORTED_MODEL');
    await click('Fetch models');
    expect(api.post).toHaveBeenCalledWith('/api/admin/providers/claude-id/discover');
    expect(button('Import bound-model').disabled).toBe(true);
    expect(button('Import own-model').disabled).toBe(true);
    expect(button('Import new-model').disabled).toBe(false);
    expect(mount.textContent).toContain('Bound to Other Claude connection');
    await click('Select all new');
    await click('Import models (1)');
    expect(api.post).toHaveBeenCalledWith('/api/admin/models/import', { providerId: cc.id, modelIds: ['new-model'] });
    expect(api.del).not.toHaveBeenCalled();
  });
});
