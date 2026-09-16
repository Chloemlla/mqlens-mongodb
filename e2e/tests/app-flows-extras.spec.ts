import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { callFrom, connectStaging, dismissHoverCards, openCollection, view } from '../helpers';

const sidebar = (page: Page) => page.getByRole('complementary').first();
const strip = (page: Page) => page.getByTestId('workspace-tab-strip');

async function connectionMenu(page: Page, item: string): Promise<void> {
  await page.getByRole('button', { name: 'Connection Staging' }).click({ button: 'right' });
  await page.getByTestId(item).click();
  await dismissHoverCards(page);
}

test.describe('Workspace tabs', () => {
  test('opening a view that is already open brings its tab forward instead of adding another', async ({ app, page }) => {
    await connectStaging(app, page);

    for (let i = 0; i < 2; i += 1) await connectionMenu(page, 'ctx-monitor');
    await expect(page.getByTestId('monitoring-view')).toHaveCount(1);

    for (let i = 0; i < 2; i += 1) await connectionMenu(page, 'ctx-users');
    await expect(page.getByTestId('user-management-view')).toHaveCount(1);

    for (let i = 0; i < 2; i += 1) await page.getByRole('button', { name: 'Open Settings' }).click();
    await expect(page.getByTestId('settings-view')).toHaveCount(1);
    await expect(page.getByTestId('settings-view')).toBeVisible();
  });
});

test.describe('Renames with tabs open', () => {
  test('a renamed collection takes its export, watch and index tabs with it', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'sales_db', 'customers');
    await expect(view(page).getByText('Alice Smith').first()).toBeVisible();

    await view(page).getByTestId('export-btn').click();
    await expect(page.getByTestId('export-view')).toBeVisible();

    await sidebar(page).getByText('customers', { exact: true }).first().click({ button: 'right' });
    await page.getByTestId('ctx-watch-collection').click();
    await dismissHoverCards(page);
    await expect(page.getByTestId('watch-status')).toHaveText('live');

    await sidebar(page).getByText('indexes', { exact: true }).click();
    await dismissHoverCards(page);
    await sidebar(page).getByText('email_1', { exact: true }).click();
    await dismissHoverCards(page);
    await expect(view(page).getByTestId('index-viewer')).toBeVisible();

    await sidebar(page).getByText('customers', { exact: true }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename Collection', exact: true }).click();
    await page.getByTestId('dialog-input').fill('clients');
    await callFrom(app, 'rename_collection', () => page.getByTestId('dialog-confirm').click());

    await expect(strip(page).getByText(/clients/).first()).toBeVisible();
    await expect(strip(page).getByText(/customers/)).toHaveCount(0);
  });

  test('a renamed database takes its collection and export tabs with it', async ({ app, page }) => {
    await connectStaging(app, page);
    await openCollection(page, 'user_analytics', 'events');
    await view(page).getByTestId('export-btn').click();
    await expect(page.getByTestId('export-view')).toBeVisible();

    await sidebar(page).getByRole('button', { name: 'Database user_analytics' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename Database', exact: true }).click();
    await page.getByTestId('dialog-input').fill('analytics');
    await page.getByTestId('dialog-confirm').click();
    await callFrom(app, 'rename_database', () => page.getByTestId('dialog-confirm').click());

    await expect(sidebar(page).getByRole('button', { name: 'Database analytics' })).toBeVisible();
    await expect(strip(page).getByText(/events/).first()).toBeVisible();
    await expect(strip(page).getByText(/user_analytics/)).toHaveCount(0);
  });
});

test.describe('Zoom', () => {
  test('zooms in, out and back with the keyboard, and saves the level', async ({ app, page }) => {
    await app.open();
    await expect(page.getByTestId('quickstart-tab')).toBeVisible();
    const saved = async () => JSON.stringify((await app.calls('patch_app_settings')).map((call) => call.args));

    await page.keyboard.press('Control+=');
    await page.keyboard.press('Control+=');
    await expect.poll(saved).toContain('zoom');

    const patches = (await app.calls('patch_app_settings')).length;
    await page.keyboard.press('Control+-');
    await page.keyboard.press('Control+0');
    await expect.poll(async () => (await app.calls('patch_app_settings')).length).toBeGreaterThan(patches);
  });
});
