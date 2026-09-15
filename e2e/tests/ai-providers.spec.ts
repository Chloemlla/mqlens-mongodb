import type { Locator, Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { Seed } from '../harness/seed';
import { callFrom } from '../helpers';

async function choose(page: Page, trigger: Locator, option: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole('option', { name: option }).click();
}

/** Open Settings on its AI tab, and return the provider manager. */
async function openProviders(app: App, page: Page, seed: Seed = {}): Promise<Locator> {
  await app.open(seed);
  await page.getByRole('button', { name: 'Open Settings' }).click();
  const settings = page.getByTestId('settings-view');
  await settings.getByTestId('settings-tab-ai').click();
  return settings.getByTestId('ai-provider-manager');
}

test.describe('AI provider form', () => {
  test('fills a preset, needs its key, then lists and picks its models', async ({ app, page }) => {
    const manager = await openProviders(app, page, { aiModels: ['deepseek-chat', 'deepseek-reasoner'] });
    await manager.getByTestId('ai-provider-add').click();
    const form = manager.getByTestId('ai-provider-form');

    await choose(page, form.getByTestId('ai-provider-preset-select'), 'DeepSeek');
    await expect(form.getByTestId('ai-provider-url-input')).toHaveValue('https://api.deepseek.com/v1');
    await form.getByTestId('ai-provider-save').click();
    await expect(form.getByTestId('ai-provider-error')).toContainText('DeepSeek needs an API key');
    expect(await app.calls('validate_ai_provider')).toHaveLength(0);

    // A key loads the endpoint's models by itself.
    await callFrom(app, 'list_ai_models', () => form.getByTestId('ai-provider-key-input').fill('sk-test'));
    await expect(form.getByTestId('ai-provider-models-status')).toContainText('2 models available');
    await choose(page, form.getByTestId('ai-provider-model-select'), 'deepseek-reasoner');
    await expect(form.getByTestId('ai-provider-model-select')).toContainText('deepseek-reasoner');

    await form.getByTestId('ai-provider-model-select').click();
    await page.getByTestId('ai-provider-model-type-own').click();
    await expect(form.getByTestId('ai-provider-model-input')).toBeVisible();

    // A failed load leaves nothing to pick from, so the name is typed.
    await app.failNext('list_ai_models', 'HTTP 401');
    await form.getByTestId('ai-provider-models-load').click();
    await expect(form.getByTestId('ai-provider-models-status')).toContainText('Could not load models: HTTP 401');
    await expect(form.getByTestId('ai-provider-model-input')).toBeVisible();
  });

  test('switches to a local command, refuses a URL it cannot reach, and cancels', async ({ app, page }) => {
    const manager = await openProviders(app, page);
    await manager.getByTestId('ai-provider-add').click();
    const form = manager.getByTestId('ai-provider-form');

    await form.getByTestId('ai-provider-name-input').fill('Proxy');
    await form.getByTestId('ai-provider-url-input').fill('ftp://proxy.internal/v1');
    await form.getByTestId('ai-provider-model-input').fill('gpt-4.1');
    await form.getByTestId('ai-provider-save').click();
    await expect(form.getByTestId('ai-provider-error')).toContainText('must be an http:// or https:// address with a host');

    await choose(page, form.getByTestId('ai-provider-kind-select'), 'Local command');
    await expect(form.getByTestId('ai-provider-command-input')).toBeVisible();

    await form.getByTestId('ai-provider-cancel').click();
    await expect(manager.getByTestId('ai-provider-form')).toHaveCount(0);
    await expect(manager.getByTestId('ai-provider-add')).toBeVisible();
  });

  test('gives a provider named like a built-in its own id', async ({ app, page }) => {
    const manager = await openProviders(app, page);
    await manager.getByTestId('ai-provider-add').click();
    const form = manager.getByTestId('ai-provider-form');
    await form.getByTestId('ai-provider-name-input').fill('OpenAI');
    await form.getByTestId('ai-provider-url-input').fill('http://localhost:11434/v1');
    await form.getByTestId('ai-provider-model-input').fill('llama3');
    await callFrom(app, 'patch_app_settings', () => form.getByTestId('ai-provider-save').click());
    await expect(manager.getByTestId('ai-provider-row-openai-2')).toBeVisible();
  });

  test('removing the provider being edited closes its form', async ({ app, page }) => {
    const local = { id: 'local-llama', name: 'Local Llama', kind: 'openai-compatible', base_url: 'http://localhost:11434/v1', model: 'llama3' };
    const manager = await openProviders(app, page, { settings: { ai_providers: [local] } });
    await manager.getByTestId('ai-provider-edit-local-llama').click();
    await expect(manager.getByTestId('ai-provider-form')).toBeVisible();

    await callFrom(app, 'patch_app_settings', () => manager.getByTestId('ai-provider-remove-local-llama').click());
    await expect(manager.getByTestId('ai-provider-form')).toHaveCount(0);
    await expect(manager.getByTestId('ai-provider-row-local-llama')).toHaveCount(0);
  });
});
