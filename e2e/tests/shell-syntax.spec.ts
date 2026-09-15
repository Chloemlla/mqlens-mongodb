import type { Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { Doc } from '../harness/seed';
import { STAGING_URI, connectStaging, getEditorText, loadSample, openCollection, setEditorText, view } from '../helpers';

// The shell syntax the query bar and the document editor read (#396): escapes,
// stray characters people paste, comments, and the shell's own type helpers.

const runButton = (page: Page) => view(page).getByRole('button', { name: 'Run', exact: true });
const filterInput = (page: Page) => view(page).getByTestId('query-filter-input');
const lastFilter = async (app: App) => String(((await app.calls('execute_mql_query')).at(-1)!.args as { filter: string }).filter);

async function openCustomers(app: App, page: Page): Promise<void> {
  await app.open();
  await loadSample(page);
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page).getByText('Alice Smith').first()).toBeVisible();
}

async function runFilter(app: App, page: Page, text: string): Promise<string> {
  const before = (await app.calls('execute_mql_query')).length;
  await setEditorText(page, filterInput(page), text);
  await runButton(page).click();
  await expect.poll(async () => (await app.calls('execute_mql_query')).length).toBeGreaterThan(before);
  return lastFilter(app);
}

test.describe('Shell syntax in the query bar', () => {
  test('reads escapes, pasted characters, smart quotes, comments and large numbers', async ({ app, page }) => {
    await openCustomers(app, page);

    expect(JSON.parse(await runFilter(app, page, '{ name: "Alice\\u0020Smith" };'))).toEqual({ name: 'Alice Smith' });
    // A zero-width space pasted in front of a key.
    expect(JSON.parse(await runFilter(app, page, '{ ​tier: "Premium" }'))).toEqual({ tier: 'Premium' });
    expect(JSON.parse(await runFilter(app, page, '{ name: “Alice\\u0020Smith” }'))).toEqual({ name: 'Alice Smith' });
    expect(await runFilter(app, page, '{ email: /alice@example\\.com/ }')).toContain('alice@example');
    expect(await runFilter(app, page, '{ visits: -9007199254740993 }')).toContain('-9007199254740993');
    expect(await runFilter(app, page, '{ visits: 9007199254740993 /* all time */ }')).toContain('9007199254740993');
  });

  test('marks text it cannot read, a line comment, and a regex flag MongoDB does not have', async ({ app, page }) => {
    await openCustomers(app, page);
    for (const text of ['{ tier: “Premium }', '{ email: /alice }', '{ tier: "Premium" // premium only\n}', 'name: /Alice/y']) {
      await setEditorText(page, filterInput(page), text);
      await expect(view(page).getByTestId('query-invalid-badge')).toBeVisible();
      await expect(runButton(page)).toBeDisabled();
    }
  });
});

test.describe('Shell types in the document editor', () => {
  test('shows Extended JSON values as shell types, and saves shell types as Extended JSON', async ({ app, page }) => {
    const typed: Doc = {
      _id: 1,
      list: [],
      at: { $date: '2024-01-02T03:04:05.000Z' },
      before: { $date: { $numberLong: '-1000' } },
      big: { $numberLong: '9007199254740993' },
      price: { $numberDecimal: '1.50' },
      small: { $numberInt: '3' },
      ratio: { $numberDouble: '2.5' },
    };
    await connectStaging(app, page, { servers: { [STAGING_URI]: { databases: { shop: { things: { docs: [typed] } } } } } });
    await openCollection(page, 'shop', 'things');
    await expect(view(page).locator('[data-json-line]').first()).toBeVisible();

    await view(page).getByTestId('edit-doc-btn').first().click();
    const modal = page.getByTestId('document-edit-modal');
    await expect(modal).toBeVisible();
    await expect.poll(() => getEditorText(page, modal)).toContain('ISODate("2024-01-02T03:04:05.000Z")');
    const shown = await getEditorText(page, modal);
    expect(shown).toContain('NumberLong("9007199254740993")');
    expect(shown).toContain('NumberDecimal("1.50")');
    expect(shown).toContain('NumberInt(3)');
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);

    await view(page).getByTestId('insert-doc-btn').click();
    await expect(modal).toBeVisible();
    await setEditorText(
      page,
      modal,
      '{ "at": Date("2024-01-02T03:04:05Z"), "n": Long(7), "i": NumberInt(3), "d": NumberDecimal("1.5"), "f": NumberDouble(2.5) }',
    );
    await modal.getByTestId('document-save-btn').click();
    await expect(modal).toHaveCount(0);
    const inserted = String(((await app.calls('insert_document')).at(-1)!.args as { document: string }).document);
    for (const wrapper of ['$date', '$numberLong', '$numberInt', '$numberDecimal']) expect(inserted).toContain(wrapper);
    // A double needs no wrapper: it is an ordinary JSON number.
    expect(inserted).toContain('"f": 2.5');
  });
});
