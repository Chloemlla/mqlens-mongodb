import type { Locator, Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import { connectStaging, dismissHoverCards, loadSample, openCollection, setEditorText, view } from '../helpers';

const suggestions = (page: Page) => page.locator('.suggest-widget.visible');

/** Empty the Monaco editor inside `container`, click into it, type as a person would, and ask for suggestions. */
async function typeInto(page: Page, container: Locator, text: string): Promise<void> {
  await setEditorText(page, container, '');
  await container.locator('.monaco-editor').first().click();
  await page.keyboard.type(text, { delay: 40 });
  await page.keyboard.press('Control+Space');
}

/** The suggestions include `label`, once the collection's schema has arrived. */
async function expectSuggestion(app: App, page: Page, label: string): Promise<void> {
  try {
    await expect(async () => {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+Space');
      await expect(suggestions(page)).toContainText(label, { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
  } catch (error) {
    const schema = (await app.calls('analyze_schema')).map((call) => ({ args: call.args, error: call.error }));
    throw new Error(`${String(error)}\nanalyze_schema calls: ${JSON.stringify(schema)}`);
  }
  await page.keyboard.press('Escape');
}

async function openSales(app: App, page: Page, collection: string): Promise<void> {
  await app.open();
  await loadSample(page);
  await openCollection(page, 'sales_db', collection);
  await expect(view(page).locator('[data-json-line]').first()).toBeVisible();
}

test.describe('Completions for values and operators', () => {
  test("suggest a field's values, quoted or not, and operators nested in others", async ({ app, page }) => {
    await openSales(app, page, 'customers');
    const filter = view(page).getByTestId('query-filter-input');

    await typeInto(page, filter, '{ tier: ');
    await expectSuggestion(app, page, 'Premium');
    await typeInto(page, filter, '{ tier: "');
    await expectSuggestion(app, page, 'Standard');
    await typeInto(page, filter, '{ tier: { $not: { $r');
    await expectSuggestion(app, page, '$regex');
    await typeInto(page, filter, '{ name: "A\\"B", tier: { $e');
    await expectSuggestion(app, page, '$eq');
  });

  test('suggest numbers for a numeric field, and projection and sort operators', async ({ app, page }) => {
    await openSales(app, page, 'transactions');
    await typeInto(page, view(page).getByTestId('query-filter-input'), '{ amount: ');
    await expectSuggestion(app, page, '199.99');

    await view(page).getByTestId('query-options-toggle').click();
    const projection = view(page).getByTestId('projection-query-input');
    await typeInto(page, projection, '{ items: { $sl');
    await expectSuggestion(app, page, '$slice');
    await typeInto(page, projection, '{ _id: ');
    await expectSuggestion(app, page, '$slice');

    const sort = view(page).getByTestId('sort-query-input');
    await typeInto(page, sort, '{ timestamp: ');
    await expectSuggestion(app, page, '-1');
    await typeInto(page, sort, '{ timestamp: { $m');
    await expectSuggestion(app, page, '$meta');
  });

  test('suggest field paths in $group, $unwind and $lookup stages', async ({ app, page }) => {
    await openSales(app, page, 'customers');
    await view(page).getByTestId('mode-aggregate-tab').click();
    const stage = view(page).getByTestId('aggregation-pipeline-editor').getByTestId('pipeline-stage-0');

    await stage.locator('select').selectOption('$group');
    await typeInto(page, stage, '{ _id: $ti');
    await expectSuggestion(app, page, '$tier');

    await stage.locator('select').selectOption('$unwind');
    await typeInto(page, stage, '"$ti');
    await expectSuggestion(app, page, '$tier');

    await stage.locator('select').selectOption('$lookup');
    await typeInto(page, stage, '{ localField: ti');
    await expectSuggestion(app, page, 'tier');
  });

  test('suggest collection methods in the shell', async ({ app, page }) => {
    await connectStaging(app, page);
    await page.getByRole('complementary').getByRole('button', { name: 'Database sales_db' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open mongosh Shell' }).click();
    await dismissHoverCards(page);
    const shell = page.getByTestId('mongo-shell');
    await expect(shell.getByTestId('shell-transcript')).toContainText('transactions');

    await typeInto(page, shell, 'db.customers.fi');
    await expectSuggestion(app, page, 'find');
  });
});
