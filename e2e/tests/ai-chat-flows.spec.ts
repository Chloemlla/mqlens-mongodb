import type { Locator, Page } from '@playwright/test';
import { test, expect, type App } from '../fixtures';
import type { AiReplySeed, Seed } from '../harness/seed';
import { callFrom, loadSample, openCollection, view } from '../helpers';

/** Settings with OpenAI as the default provider, so the picker starts on it. */
const OPENAI_DEFAULT = { ai_provider: 'openai', openai_model: 'gpt-4.1' };

const PREMIUM_QUERY = { explanation: 'Customers on the Premium tier.', queryType: 'find', filter: { tier: 'Premium' } };
const PREMIUM: AiReplySeed = { query: PREMIUM_QUERY };

/** A 1x1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const png = (name: string, buffer = PNG) => ({ name, mimeType: 'image/png', buffer });

async function choose(page: Page, trigger: Locator, option: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole('option', { name: option }).click();
}

/** Open the AI helper on sales_db.customers of the sample server. */
async function openHelper(app: App, page: Page, seed: Seed = {}): Promise<Locator> {
  await app.open({ ...seed, settings: { ...OPENAI_DEFAULT, ...seed.settings } });
  await loadSample(page);
  await openCollection(page, 'sales_db', 'customers');
  await expect(view(page)).toContainText('Alice Smith');
  await view(page).getByTestId('toggle-ai-helper').click();
  const panel = view(page).getByTestId('ai-helper-panel');
  await expect(panel).toBeVisible();
  return panel;
}

async function ask(panel: Locator, prompt: string): Promise<void> {
  await panel.getByTestId('chat-input').fill(prompt);
  await panel.getByTestId('chat-send-btn').click();
}

/**
 * Hold the next generation until `releaseReply` is called, so a test can move
 * the panel on while the reply is still coming.
 */
async function holdNextReply(page: Page): Promise<void> {
  await page.evaluate((reply) => {
    const held = window as unknown as { releaseReply?: () => void };
    window.__MQLENS_E2E__!.register({
      generate_mql_query: () =>
        new Promise((resolve) => {
          held.releaseReply = () => resolve({ query: JSON.stringify(reply) });
        }),
    });
  }, PREMIUM_QUERY);
}

const releaseReply = (page: Page) =>
  page.evaluate(() => (window as unknown as { releaseReply?: () => void }).releaseReply?.());

test.describe('AI helper providers and models', () => {
  test('sends with Enter, on the model and provider picked in the panel', async ({ app, page }) => {
    const panel = await openHelper(app, page, { aiModels: ['gpt-4.1', 'gpt-4o-mini'], aiReplies: [PREMIUM, PREMIUM] });

    await choose(page, panel.getByTestId('ai-chat-model-select'), 'gpt-4o-mini');
    await panel.getByTestId('chat-input').fill('premium customers');
    const sent = await callFrom(app, 'generate_mql_query', () => panel.getByTestId('chat-input').press('Enter'));
    expect(sent).toMatchObject({ providerId: 'openai', model: 'gpt-4o-mini' });
    await expect(panel.getByTestId('chat-query-card')).toBeVisible();

    // Shift+Enter starts a new line instead of sending.
    await panel.getByTestId('chat-input').fill('first line');
    await panel.getByTestId('chat-input').press('Shift+Enter');
    expect(await app.calls('generate_mql_query')).toHaveLength(1);

    await choose(page, panel.getByTestId('ai-chat-provider-select'), 'Anthropic (Claude)');
    const anthropic = await callFrom(app, 'generate_mql_query', () => ask(panel, 'premium customers'));
    expect(anthropic.providerId).toBe('anthropic');

    await choose(page, panel.getByTestId('ai-chat-provider-select'), 'OpenAI (ChatGPT)');
    await choose(page, panel.getByTestId('ai-chat-model-select'), /Type a model name/);
    await expect(panel.getByTestId('ai-chat-model-input')).toBeVisible();
  });

  test("loads a local command's models, and says when it cannot", async ({ app, page }) => {
    const ollama = { id: 'ollama', name: 'Ollama', kind: 'local-cli', command: 'ollama run {model} {prompt}', models_command: 'ollama list' };
    const panel = await openHelper(app, page, { settings: { ai_provider: 'ollama', ai_providers: [ollama] }, aiModels: ['llama3', 'mistral'] });

    await app.failNext('list_ai_models_for', 'ollama: command not found');
    await panel.getByTestId('ai-chat-models-load').click();
    await expect(panel.getByTestId('ai-chat-models-failed')).toBeVisible();

    await panel.getByTestId('ai-chat-models-load').click();
    await choose(page, panel.getByTestId('ai-chat-model-select'), 'mistral');
    await expect(panel.getByTestId('ai-chat-model-select')).toContainText('mistral');
  });

  test('falls back to the default provider when the one picked is removed in Settings', async ({ app, page }) => {
    const ollama = { id: 'ollama', name: 'Ollama', kind: 'local-cli', command: 'ollama run {prompt}' };
    const panel = await openHelper(app, page, { settings: { ai_providers: [ollama] } });
    await choose(page, panel.getByTestId('ai-chat-provider-select'), 'Ollama');
    await expect(panel.getByTestId('ai-chat-provider-select')).toContainText('Ollama');

    await page.getByRole('button', { name: 'Open Settings' }).click();
    const settings = page.getByTestId('settings-view');
    await settings.getByTestId('settings-tab-ai').click();
    await callFrom(app, 'patch_app_settings', () => settings.getByTestId('ai-provider-remove-ollama').click());

    await expect(page.getByTestId('ai-chat-provider-select')).toContainText('OpenAI (ChatGPT)');
  });
});

test.describe('AI helper images', () => {
  test('drops pending images when a local command is picked, which cannot take them', async ({ app, page }) => {
    const panel = await openHelper(app, page);
    await panel.getByTestId('chat-attach-input').setInputFiles(png('screenshot.png'));
    await expect(panel.getByTestId('chat-pending-images')).toBeVisible();

    await choose(page, panel.getByTestId('ai-chat-provider-select'), 'Claude Code (local)');
    await expect(panel.getByTestId('chat-pending-images')).toHaveCount(0);
    await expect(panel.getByTestId('chat-image-note')).toContainText('local command');
    await expect(panel.getByTestId('chat-attach-btn')).toBeDisabled();

    await panel.getByTestId('chat-attach-input').setInputFiles(png('another.png'));
    await expect(panel.getByTestId('chat-pending-images')).toHaveCount(0);
    await expect(panel.getByTestId('chat-image-note')).toContainText('local command');
  });

  test('keeps four images per message, and shows each size once sent', async ({ app, page }) => {
    const panel = await openHelper(app, page, { aiReplies: [PREMIUM, PREMIUM] });
    await panel.getByTestId('chat-attach-input').setInputFiles([1, 2, 3, 4, 5].map((n) => png(`shot-${n}.png`)));
    await expect(panel.getByTestId('chat-image-note')).toContainText('Up to 4 images per message.');
    await expect(panel.getByTestId('chat-pending-images').locator('img')).toHaveCount(4);
    const sent = await callFrom(app, 'generate_mql_query', () => ask(panel, 'customers like these'));
    expect(sent.images as unknown[]).toHaveLength(4);
    await expect(panel.getByTestId('chat-attachments').first()).toContainText(`${PNG.length} B`);

    await panel
      .getByTestId('chat-attach-input')
      .setInputFiles([png('medium.png', Buffer.alloc(2048)), png('large.png', Buffer.alloc(1536 * 1024))]);
    await callFrom(app, 'generate_mql_query', () => ask(panel, 'and these'));
    await expect(panel.getByTestId('chat-attachments').last()).toContainText('KB');
    await expect(panel.getByTestId('chat-attachments').last()).toContainText('MB');
  });

  test('takes a pasted image and refuses a pasted SVG', async ({ app, page, browserName }) => {
    test.skip(browserName === 'webkit', 'WebKit ignores clipboardData on a synthetic paste event');
    const panel = await openHelper(app, page);
    const paste = (name: string, type: string) =>
      panel.getByTestId('chat-input').evaluate(
        (input, file) => {
          const data = new DataTransfer();
          data.items.add(new File([new Uint8Array([137, 80, 78, 71])], file.name, { type: file.type }));
          input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        },
        { name, type },
      );

    await paste('drawing.svg', 'image/svg+xml');
    await expect(panel.getByTestId('chat-image-note')).toContainText('Only PNG, JPEG, WebP and GIF images can be sent.');

    await paste('screenshot.png', 'image/png');
    await expect(panel.getByTestId('chat-pending-images').locator('img')).toHaveCount(1);
  });
});

test.describe('AI helper replies and history', () => {
  test('says so when the model returns no query', async ({ app, page }) => {
    const panel = await openHelper(app, page, { aiReplies: [{ query: { explanation: 'Not sure what you mean.' } } as AiReplySeed] });
    await ask(panel, 'hmm');
    await expect(panel.getByTestId('chat-msg-assistant').last()).toContainText('The model returned no query.');
  });

  test("lists every collection's conversations when unscoped, and clears them", async ({ app, page }) => {
    const panel = await openHelper(app, page, { aiReplies: [PREMIUM] });
    await ask(panel, 'premium customers');
    await expect(panel.getByTestId('chat-query-card')).toBeVisible();

    await panel.getByTestId('ai-chat-new-btn').click();
    await panel.getByTestId('ai-chat-history-btn').click();
    const history = page.getByTestId('ai-chat-history-dropdown');
    await expect(history.getByTestId('ai-chat-history-item-0')).toBeVisible();

    const listed = await callFrom(app, 'list_chats', () => history.getByTestId('ai-chat-history-scope-toggle').click());
    expect(listed.scope).toBeNull();
    if (!(await history.isVisible())) await panel.getByTestId('ai-chat-history-btn').click();
    await expect(history.getByTestId('ai-chat-history-item-0')).toContainText('sales_db.customers');

    await callFrom(app, 'clear_chats', () => history.getByTestId('ai-chat-history-clear').click());
    if (!(await history.isVisible())) await panel.getByTestId('ai-chat-history-btn').click();
    await expect(history.getByTestId('ai-chat-history-item-0')).toHaveCount(0);
  });

  test('will not open a conversation another tab holds', async ({ app, page }) => {
    const panel = await openHelper(app, page, { aiReplies: [PREMIUM] });
    await ask(panel, 'premium customers');
    await expect(panel.getByTestId('chat-query-card')).toBeVisible();
    await panel.getByTestId('ai-chat-new-btn').click();
    await expect(panel.getByTestId('chat-msg-user')).toHaveCount(0);

    await page.evaluate(() => window.__MQLENS_E2E__!.register({ claim_chat: () => false }));
    await panel.getByTestId('ai-chat-history-btn').click();
    const history = page.getByTestId('ai-chat-history-dropdown');
    await history.getByTestId('ai-chat-history-item-0').click();
    await expect(panel.getByTestId('chat-msg-user')).toHaveCount(0);
    // Picking a conversation closes the menu; it says why when opened again.
    await panel.getByTestId('ai-chat-history-btn').click();
    await expect(history.getByTestId('ai-chat-history-busy')).toBeVisible();
  });
});

test.describe('AI helper replies that arrive later', () => {
  test('a reply still coming shows when the panel is opened again, and then arrives', async ({ app, page }) => {
    let panel = await openHelper(app, page);
    await holdNextReply(page);
    await ask(panel, 'premium customers');
    await expect(panel.getByTestId('chat-thinking')).toBeVisible();

    await panel.getByTestId('ai-helper-close-btn').click();
    await view(page).getByTestId('toggle-ai-helper').click();
    panel = view(page).getByTestId('ai-helper-panel');
    await expect(panel.getByTestId('chat-thinking')).toBeVisible();

    await releaseReply(page);
    await expect(panel.getByTestId('chat-query-card')).toContainText('Premium');
  });

  test('a reply that arrives while the panel is closed is there when it opens', async ({ app, page }) => {
    const panel = await openHelper(app, page);
    await holdNextReply(page);
    await ask(panel, 'premium customers');
    await expect(panel.getByTestId('chat-thinking')).toBeVisible();

    await panel.getByTestId('ai-helper-close-btn').click();
    await expect(view(page).getByTestId('ai-helper-panel')).toHaveCount(0);
    await releaseReply(page);
    await expect.poll(async () => (await app.calls('append_chat_message')).length + (await app.calls('save_chat')).length).toBeGreaterThan(0);

    await view(page).getByTestId('toggle-ai-helper').click();
    await expect(view(page).getByTestId('ai-helper-panel').getByTestId('chat-query-card')).toContainText('Premium');
  });

  test('a reply for a conversation left for a new one lands in the old one', async ({ app, page }) => {
    const panel = await openHelper(app, page);
    await holdNextReply(page);
    await ask(panel, 'premium customers');
    await expect(panel.getByTestId('chat-thinking')).toBeVisible();

    await panel.getByTestId('ai-chat-new-btn').click();
    await releaseReply(page);
    await expect.poll(async () => (await app.calls('append_chat_message')).length + (await app.calls('save_chat')).length).toBeGreaterThan(0);
    await expect(panel.getByTestId('chat-msg-user')).toHaveCount(0);

    await panel.getByTestId('ai-chat-history-btn').click();
    await page.getByTestId('ai-chat-history-dropdown').getByTestId('ai-chat-history-item-0').click();
    await expect(panel.getByTestId('chat-query-card')).toContainText('Premium');
  });

  test("asks before an agent writes on this conversation's behalf", async ({ app, page }) => {
    const panel = await openHelper(app, page, { aiReplies: [PREMIUM] });
    await ask(panel, 'premium customers');
    await expect(panel.getByTestId('chat-query-card')).toBeVisible();
    const chatId = ((await app.calls('claim_chat')).at(-1)!.args as { chatId: string }).chatId;

    await page.evaluate(
      (requester) =>
        window.__MQLENS_E2E__!.emit('mcp-write-request', {
          id: 'w1',
          tool: 'delete_many',
          summary: 'Delete 3 documents from sales_db.customers',
          requester,
        }),
      chatId,
    );
    await expect(panel.getByTestId('chat-write-request')).toBeVisible();
    const resolved = await callFrom(app, 'mcp_resolve_write', () => panel.getByTestId('chat-write-allow').click());
    expect(resolved).toMatchObject({ id: 'w1', approved: true });
  });
});
