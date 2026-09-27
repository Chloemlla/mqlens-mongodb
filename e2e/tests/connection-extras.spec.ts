import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { SAMPLE_SERVER } from '../harness/seed';
import { callFrom } from '../helpers';

const STAGING_URI = 'mongodb://staging.example:27017';
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const editorTab = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

/** Quick Start → Connection Manager. */
async function openManager(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New connection', exact: true }).first().click();
  await expect(button(page, 'New...')).toBeVisible();
}

async function newConnection(page: Page, name: string, host: string): Promise<void> {
  await button(page, 'New...').click();
  await page.getByLabel('Display Name').fill(name);
  await page.getByTestId('host-list').fill(host);
}

test.describe('Connection editor checks', () => {
  test('explains a host it cannot find and a server that hangs up', async ({ app, page }) => {
    await app.open({ servers: { [STAGING_URI]: SAMPLE_SERVER } });
    await openManager(page);
    await newConnection(page, 'Staging', 'staging.example:27017');

    for (const [failure, summary] of [
      ['failed to lookup address information: nodename nor servname provided', 'Host not found'],
      ['unexpected end of file', 'closed the connection'],
    ]) {
      await app.failNext('test_connection_uri', failure);
      await button(page, 'Test Connection').click();
      await expect(page.getByTestId('test-result-summary')).toContainText(summary);
      await page.getByTestId('test-dismiss').click();
    }
  });

  test('saves a proxy with the profile', async ({ app, page }) => {
    await app.open();
    await openManager(page);
    await newConnection(page, 'Behind a proxy', 'internal.example:27017');

    await editorTab(page, 'Proxy').click();
    await page.locator('#proxy-enable').check();
    await page.getByPlaceholder('proxy.internal').fill('proxy.corp.example');
    await page.getByPlaceholder('username').fill('relay');
    await page.getByPlaceholder('••••••••').fill('relay-pass');
    const saved = await callFrom(app, 'save_connection_profile', () => button(page, 'Save').click());
    const uri = (saved.profile as { uri: string }).uri;
    expect(uri).toContain('proxyHost=proxy.corp.example');
    expect(uri).toContain('proxyUsername=relay');
    expect(uri).toContain('proxyPassword=');
  });

  test('shows the whole URI with its password hidden until the field is focused', async ({ app, page }) => {
    await app.open({ profiles: [{ id: 'p-reporting', name: 'Reporting', uri: 'mongodb://reporter:hunter2@reporting.example:27017/?authSource=admin' }] });
    await openManager(page);
    await button(page, 'Edit').click();

    await page.getByTestId('topology-select').click();
    await page.getByRole('option', { name: 'Full URI String Only' }).click();
    const uri = page.locator('#connection-uri');
    await expect(uri).not.toHaveValue(/hunter2/);
    await uri.focus();
    await expect(uri).toHaveValue(/hunter2/);
  });

  test('needs a display name, and keeps the editor open when the save fails', async ({ app, page }) => {
    await app.open({ profiles: [{ id: 'p-reporting', name: 'Reporting', uri: 'mongodb://reporting.example:27017' }] });
    await openManager(page);
    await button(page, 'Edit').click();

    await page.getByLabel('Display Name').fill('');
    await button(page, 'Save').click();
    await expect(page.getByTestId('editor-error')).toContainText('Display Name is required');

    await page.getByLabel('Display Name').fill('Reporting EU');
    await app.failNext('save_connection_profile', 'the vault is read-only');
    await button(page, 'Save').click();
    await expect(page.getByTestId('editor-error')).toContainText('the vault is read-only');
    await expect(page.getByRole('heading', { name: 'Edit Connection' })).toBeVisible();
  });

  test('Escape closes the editor and the manager, or the manager on its own', async ({ app, page }) => {
    await app.open();
    await openManager(page);
    await button(page, 'New...').click();
    await expect(page.getByRole('heading', { name: 'New Connection' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'New Connection' })).toHaveCount(0);
    await expect(button(page, 'New...')).toHaveCount(0);

    await openManager(page);
    await page.keyboard.press('Escape');
    await expect(button(page, 'New...')).toHaveCount(0);
  });
});

test.describe('Connection Manager actions', () => {
  test('keeps a profile whose delete is cancelled, and saves an exported URI to a file', async ({ app, page }) => {
    await app.open({
      profiles: [{ id: 'p-reporting', name: 'Reporting', uri: 'mongodb://reporting.example:27017' }],
      dialog: { save: '/exports/reporting.txt' },
    });
    await openManager(page);

    await button(page, 'Delete').click();
    await page.getByTestId('dialog-cancel').click();
    expect(await app.calls('delete_connection_profile')).toHaveLength(0);

    await page.getByTestId('export-uri-btn').click();
    const dialog = page.getByTestId('export-uri-dialog');
    await expect(dialog).toContainText('Export connection URI');
    await callFrom(app, 'plugin:fs|write_text_file', () => dialog.getByTestId('export-save-btn').click());
    await expect(dialog).toHaveCount(0);
  });

  test('names pasted connections that share a name, and says when an import file has nothing to use', async ({ app, page }) => {
    await app.open({
      profiles: [{ id: 'p-production', name: 'Production', uri: 'mongodb://prod.example:27017' }],
      dialog: { open: '/exports/empty.txt' },
      files: { '/exports/empty.txt': '' },
    });
    await openManager(page);
    await button(page, 'New...').click();

    await page.getByTestId('import-uri-btn').click();
    await page.getByTestId('import-paste-manually').click();
    await page.getByTestId('dialog-input').fill('# Production\nmongodb://prod-a.example:27017\n\n# Production\nmongodb://prod-b.example:27017');
    await page.getByTestId('dialog-confirm').click();
    await page.getByTestId('dialog-confirm').click();
    await expect.poll(async () => (await app.calls('save_connection_profile')).length).toBe(2);
    const names = (await app.calls('save_connection_profile')).map((call) => (call.args as { profile: { name: string } }).profile.name);
    expect(names).toEqual(['Production (2)', 'Production (3)']);

    await button(page, 'New...').click();
    await page.getByTestId('import-uri-btn').click();
    await page.getByTestId('import-from-file').click();
    await expect(page.getByTestId('import-uri-error')).toContainText('File is empty');
  });
});
