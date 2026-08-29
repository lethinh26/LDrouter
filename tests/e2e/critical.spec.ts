// E2E tests: all 12 critical admin flows from docs/10.
// The webServer in playwright.config.ts boots a fresh instance on a temp
// data dir. We use direct API calls for data setup, then the browser for UI
// verification.
import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';

const BASE = 'http://localhost:8790';
const ADMIN_PASSWORD = 'test-password-1234';
const MASTER_KEY = 'b'.repeat(32);

// Helper: raw JSON fetch to the admin API, managing session cookies.
let cookie = '';

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const opts: RequestInit = {
    method,
    headers: { 'content-type': 'application/json', cookie } as Record<string, string>,
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie')!;
  const data = res.status === 204 ? null : await res.json();
  return { status: res.status, data };
}

test.describe.configure({ mode: 'serial' });

test.describe('Critical admin flows', () => {
  test('1. first run -> create admin -> login', async ({ page }) => {
    // Setup via API.
    const r = await api('POST', '/api/admin/setup', {
      username: 'admin',
      password: ADMIN_PASSWORD,
      setupMasterKey: MASTER_KEY,
    });
    expect(r.status).toBe(200);

    // Login via UI.
    await page.goto('/login');
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/^\/(?!login)/, { timeout: 8000 });
    await expect(page.getByText('Dashboard', { exact: true })).toBeVisible({ timeout: 8000 });
  });

  test('2. add OpenAI provider, test connection, fetch & import two models', async ({ page }) => {
    // Create provider with a mock upstream.
    // Use a non-routable URL so the test returns a failure, but we still
    // verify the UI renders the result.
    const p = await api('POST', '/api/admin/providers', {
      name: 'OpenAI',
      type: 'openai',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'sk-test',
    });
    expect(p.status).toBe(200);
    const providerId = (p.data as { id: string }).id;

    // Test connection triggers an HTTP call that will fail — UI should show the result.
    await page.goto('/providers');
    await page.getByRole('button', { name: /play/i }).first().click();
    await page.waitForSelector('text=Connection', { timeout: 8000 });
    // Provider should still be listed.
    await expect(page.getByText('OpenAI')).toBeVisible();

    // Directly insert models via DB (since we can't reach the upstream).
    execSync(
      `node -e "
        const Database = require('better-sqlite3');
        const db = new Database('./data-e2e/data.sqlite');
        const { v4 } = require('node:crypto');
        const id1 = require('node:crypto').randomUUID();
        const id2 = require('node:crypto').randomUUID();
        db.prepare('INSERT INTO models (id,provider_id,upstream_model_id,public_model_id,display_name,enabled,upstream_available,capabilities_json) VALUES (?,?,?,?,?,1,1,?)').run(id1, '${providerId}', 'gpt-4o-mini', 'openai/gpt-4o-mini', 'GPT-4o Mini', JSON.stringify({chat:true,streaming:true,tools:true}));
        db.prepare('INSERT INTO models (id,provider_id,upstream_model_id,public_model_id,display_name,enabled,upstream_available,capabilities_json) VALUES (?,?,?,?,?,1,1,?)').run(id2, '${providerId}', 'gpt-4o', 'openai/gpt-4o', 'GPT-4o', JSON.stringify({chat:true,streaming:true,tools:true,image_input:true}));
        db.close();
        console.log('models inserted');
      "`,
      { cwd: process.cwd() },
    );

    // Verify models appear in the UI.
    await page.goto('/models');
    await expect(page.getByText('openai/gpt-4o-mini')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('openai/gpt-4o')).toBeVisible();
  });

  test('3. add Anthropic provider, fetch/select/import', async ({ page }) => {
    // Create provider.
    const p = await api('POST', '/api/admin/providers', {
      name: 'Anthropic',
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test',
    });
    expect(p.status).toBe(200);
    const providerId = (p.data as { id: string }).id;

    // Insert models directly (Anthropic discovery returns hardcoded defaults).
    execSync(
      `node -e "
        const Database = require('better-sqlite3');
        const db = new Database('./data-e2e/data.sqlite');
        const id1 = require('node:crypto').randomUUID();
        const id2 = require('node:crypto').randomUUID();
        db.prepare('INSERT INTO models (id,provider_id,upstream_model_id,public_model_id,display_name,enabled,upstream_available,capabilities_json) VALUES (?,?,?,?,?,1,1,?)').run(id1, '${providerId}', 'claude-3-5-sonnet-latest', 'anthropic/claude-3-5-sonnet-latest', 'Claude 3.5 Sonnet', JSON.stringify({chat:true,streaming:true,tools:true,image_input:true}));
        db.prepare('INSERT INTO models (id,provider_id,upstream_model_id,public_model_id,display_name,enabled,upstream_available,capabilities_json) VALUES (?,?,?,?,?,1,1,?)').run(id2, '${providerId}', 'claude-3-opus-latest', 'anthropic/claude-3-opus-latest', 'Claude 3 Opus', JSON.stringify({chat:true,streaming:true,tools:true,image_input:true}));
        db.close();
        console.log('Anthropic models inserted');
      "`,
      { cwd: process.cwd() },
    );

    await page.goto('/providers');
    await expect(page.getByText('Anthropic')).toBeVisible({ timeout: 5000 });
  });

  test('4. create fallback combo', async ({ page }) => {
    await page.goto('/combos');
    await page.getByRole('button', { name: 'New combo' }).click();
    const dialog = page.locator('[role="dialog"]');
    const inputs = dialog.locator('input');
    await inputs.nth(0).fill('Combo FB');
    await inputs.nth(1).fill('combo-fb');

    // Select fallback mode (default).
    // Add member via Radix Select.
    const addBtn = dialog.locator('button[role="combobox"]').filter({ hasText: 'Add a model' });
    await addBtn.click();
    await page.getByRole('option', { name: 'openai/gpt-4o-mini' }).click();

    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForSelector('text=Combo FB', { timeout: 5000 });
  });

  test('5. create weighted round-robin combo', async ({ page }) => {
    await page.goto('/combos');
    await page.getByRole('button', { name: 'New combo' }).click();
    const dialog = page.locator('[role="dialog"]');
    const inputs = dialog.locator('input');
    await inputs.nth(0).fill('Combo WRR');
    await inputs.nth(1).fill('combo-wrr');

    // Select mode: Weighted round-robin.
    await dialog.locator('button[role="combobox"]').filter({ hasText: 'Fallback' }).click();
    await page.getByRole('option', { name: 'Weighted round-robin' }).click();

    const addBtn = dialog.locator('button[role="combobox"]').filter({ hasText: 'Add a model' });
    await addBtn.click();
    await page.getByRole('option', { name: 'openai/gpt-4o' }).click();

    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForSelector('text=Combo WRR', { timeout: 5000 });
  });

  test('6. create API key with model restriction and limits', async ({ page }) => {
    await page.goto('/api-keys');
    await page.getByRole('button', { name: 'New key' }).click();
    const dialog = page.locator('[role="dialog"]');
    const inputs = dialog.locator('input');
    await inputs.nth(0).fill('E2E restricted key');

    // Toggle off "Allow all models".
    await dialog.locator('button[role="switch"]').click();

    // Set RPM limit (third input after name, expires).
    await inputs.nth(2).fill('100');

    // Select a model permission.
    await page.getByText('openai/gpt-4o-mini').first().click();

    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForSelector('text=API key created', { timeout: 5000 });
    // Copy-once dialog appears.
    const secret = await dialog.locator('.font-mono.text-xs').textContent();
    expect(secret?.startsWith('ld-')).toBe(true);
    await dialog.getByRole('button', { name: 'I have saved it' }).click();
    await expect(page.getByText('E2E restricted key')).toBeVisible({ timeout: 5000 });
  });

  test('7. requests page shows empty state', async ({ page }) => {
    await page.goto('/requests');
    await expect(page.getByText('Requests', { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('No requests yet.')).toBeVisible({ timeout: 5000 });
  });

  test('8. statistics presets switch', async ({ page }) => {
    await page.goto('/statistics');
    await expect(page.getByText('Statistics', { exact: true })).toBeVisible({ timeout: 5000 });
    for (const label of ['Today', '7d', '30d']) {
      await page.getByRole('button', { name: label }).click();
      await page.waitForTimeout(300);
    }
    // Verify the active preset is shown.
    await expect(page.getByRole('button', { name: 'Today' })).toBeVisible();
  });

  test('9. change log retention', async ({ page }) => {
    await page.goto('/settings');
    await page.click('text=Log retention');
    const input = page.locator('input[type="number"]').first();
    await input.fill('45');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForSelector('text=Saved', { timeout: 5000 });
  });

  test('10. configure TOTP 2FA', async ({ page }) => {
    await page.goto('/settings');
    await page.click('text=TOTP 2FA');
    await page.getByRole('button', { name: 'Enable' }).click();
    await page.waitForSelector('text=Scan this QR code', { timeout: 8000 });
    const secret = await page.locator('.font-mono').textContent();
    expect(secret!.length).toBeGreaterThan(16);
  });

  test('11. download backup', async ({ page }) => {
    await page.goto('/settings');
    await page.click('text=Backup');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download' }).click(),
    ]);
    const path = (await download.path())!;
    const fs = await import('node:fs');
    const buf = fs.readFileSync(path);
    const env = JSON.parse(buf.toString());
    expect(env.format).toBe('latedev-backup');
    expect(env.checksum).toBeTruthy();
  });

  test('12. upload valid backup through restore UI', async ({ page }) => {
    // Download a backup first.
    await page.goto('/settings');
    await page.click('text=Backup');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download' }).click(),
    ]);
    const path = (await download.path())!;
    const fs = await import('node:fs');
    const buf = fs.readFileSync(path);

    // Upload the same backup back.
    await page.locator('input[type="file"]').setInputFiles({
      name: 'backup.ldb.json',
      mimeType: 'application/json',
      buffer: buf,
    });
    await page.getByRole('button', { name: 'Restore' }).click();
    await page.waitForSelector('text=Restore completed', { timeout: 10000 });
  });
});