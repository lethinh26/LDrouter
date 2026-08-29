// Shared helpers for E2E tests. Radix Select is portal-rendered: the option
// lives in <body> so we must scope queries to the portal, not the page.
import type { Page } from '@playwright/test';
import fs from 'node:fs';

export const ADMIN_USERNAME = 'admin';
export const ADMIN_PASSWORD = 'super-secret-password-1234';
export const MASTER_KEY = 'a'.repeat(32);

export async function setupAdmin(page: Page): Promise<void> {
  await page.goto('/');
  // First run shows the Welcome card.
  const welcome = page.locator('text=Welcome to LateDev Router');
  if (await welcome.isVisible()) {
    const inputs = page.locator('main input, form input, body input');
    await inputs.nth(0).fill(ADMIN_USERNAME);
    await inputs.nth(1).fill(ADMIN_PASSWORD);
    await inputs.nth(2).fill(MASTER_KEY);
    await page.getByRole('button', { name: 'Create admin' }).click();
  }
  await page.waitForURL(/\/login/, { timeout: 8000 });
}

export async function login(page: Page): Promise<void> {
  await page.goto('/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(ADMIN_USERNAME);
  await inputs.nth(1).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/^\/(?!login)/, { timeout: 8000 });
  await page.waitForSelector('main', { timeout: 8000 });
}

export async function ensureLoggedIn(page: Page): Promise<void> {
  await page.goto('/');
  if (await page.locator('text=Sign in').isVisible()) {
    await login(page);
  }
  await page.waitForSelector('text=Dashboard', { timeout: 8000 });
}

/** Pick a Radix select option by its visible text. `trigger` names the dialog/select to open. */
export async function pickSelect(page: Page, trigger: string, optionText: string): Promise<void> {
  await page.click(trigger);
  await page.waitForSelector('[role="option"]', { timeout: 5000 });
  // The option list is portaled; find by exact text.
  await page.getByRole('option', { name: optionText }).click();
}

export async function createOpenAIProvider(page: Page): Promise<void> {
  await page.goto('/providers');
  await page.getByRole('button', { name: 'Add provider' }).click();
  await page.locator('main text=New provider').waitFor();
  const dialog = page.locator('[role="dialog"]');
  const inputs = dialog.locator('input');
  await inputs.nth(0).fill('OpenAI');
  // Base URL is 3rd input in dialog (name, slug, baseUrl, apiKey… slug is optional 2nd).
  await inputs.nth(2).fill('https://mock-proxy.local');
  await inputs.nth(3).fill('sk-test-1234');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await page.waitForSelector('text=OpenAI', { timeout: 6000 });
}

export async function fetchAndImportModels(page: Page, providerName: string, models: string[]): Promise<void> {
  await page.goto('/models');
  await page.getByRole('button', { name: 'Fetch models' }).click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.getByRole('button', { name: 'Choose provider' }).click();
  await page.getByRole('option', { name: providerName }).click();
  await dialog.getByRole('button', { name: 'Fetch' }).click();
  // Wait for discovered list.
  await page.waitForSelector('text=discovered', { timeout: 10000 });
  for (const m of models) {
    await dialog.locator(`[data-testid="model-${m}"]`).check();
  }
  await dialog.getByRole('button', { name: /Import/ }).click();
  await page.waitForSelector('text=Imported', { timeout: 10000 });
}

export async function createCombo(page: Page, name: string, mode: 'fallback' | 'weighted_round_robin', modelIds: string[], slug?: string, _maxAttempts = 3): Promise<void> {
  await page.goto('/combos');
  await page.getByRole('button', { name: 'New combo' }).click();
  const dialog = page.locator('[role="dialog"]');
  const inputs = dialog.locator('input');
  await inputs.nth(0).fill(name);
  if (slug) await inputs.nth(1).fill(slug);
  // Mode select.
  await dialog.getByRole('button').filter({ hasText: mode === 'fallback' ? 'Fallback' : 'Weighted' }).click();
  await page.getByRole('option', { name: mode === 'fallback' ? 'Fallback (ordered)' : 'Weighted round-robin' }).click();
  // Add members.
  for (const id of modelIds) {
    await dialog.locator('[data-testid="member-add"]').click();
    await page.getByRole('option', { name: id }).click();
  }
  await dialog.getByRole('button', { name: 'Create' }).click();
  await page.waitForSelector(`text=${name}`, { timeout: 6000 });
}

export async function createApiKey(
  page: Page,
  name: string,
  opts: { allowAll?: boolean; modelIds?: string[]; rpm?: string; expires?: boolean } = {}
): Promise<{ name: string; secret: string }> {
  await page.goto('/api-keys');
  await page.getByRole('button', { name: 'New key' }).click();
  const dialog = page.locator('[role="dialog"]');
  const inputs = dialog.locator('input');
  await inputs.nth(0).fill(name);
  if (opts.rpm) {
    await inputs.filter({ has: page.locator('input[type="number"]') }).first().fill(opts.rpm);
  }
  if (opts.allowAll === false) {
    // toggle the switch off: find switch labeled "Allow all current and future models"
    await dialog.locator('button[role="switch"]').click();
    for (const mid of opts.modelIds ?? []) {
      await dialog.locator(`[data-testid="perm-${mid}"]`).check();
    }
  }
  await dialog.getByRole('button', { name: 'Create' }).click();
  await page.waitForSelector('text=API key created', { timeout: 6000 });
  const secret = (await dialog.locator('.font-mono.text-xs.break-all').textContent()) || '';
  await dialog.getByRole('button', { name: 'I have saved it' }).click();
  return { name, secret };
}

export async function enableTotp(page: Page): Promise<{ secret: string }> {
  await page.goto('/settings');
  await page.click('text=TOTP 2FA');
  await page.getByRole('button', { name: 'Enable' }).click();
  await page.waitForSelector('text=Scan this QR code', { timeout: 10000 });
  const secret = (await page.locator('.font-mono').textContent()) || '';
  return { secret };
}

export async function downloadBackup(page: Page): Promise<Buffer> {
  await page.goto('/settings');
  await page.click('text=Backup');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download' }).click(),
  ]);
  const p = (await download.path())!;
  return fs.readFileSync(p);
}