import { expect, test } from '@playwright/test';
import { apiGet, createPage, editor, expectSaved, login, treeLink, unique } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('rapid typing followed by immediate navigation is saved', async ({ page }) => {
  const a = await createPage(page, unique('Rapid A'));
  await page.keyboard.press('Enter');
  const b = await (async () => {
    await page.getByTestId('new-page').click();
    await page.waitForURL((url) => !url.pathname.endsWith(a));
    return page.url().split('/p/')[1];
  })();
  await treeLink(page, a).click();
  await expect(page).toHaveURL(new RegExp(a));
  await editor(page).click();
  const text = 'The quick brown fox jumps over the lazy dog 0123456789';
  await page.keyboard.type(text, { delay: 5 });
  // Navigate away before the debounce fires.
  await treeLink(page, b).click();
  await expect(page).toHaveURL(new RegExp(b));
  await expect
    .poll(async () =>
      JSON.stringify(
        (await apiGet<{ contentJson: unknown }>(page.request, `/api/pages/${a}`)).contentJson,
      ),
    )
    .toContain(text);
  await treeLink(page, a).click();
  await expect(editor(page)).toContainText(text);
  await expectSaved(page);
});

test('failed saves are shown, retried and never reported as saved', async ({ page }) => {
  const id = await createPage(page, unique('Failing'));
  await page.keyboard.press('Enter');
  await page.route(`**/api/pages/${id}/content`, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'unavailable', message: 'Service unavailable' } }),
    }),
  );
  await editor(page).pressSequentially('survives failures');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'error');
  await expect(page.getByTestId('save-error-banner')).toBeVisible();
  await page.unroute(`**/api/pages/${id}/content`);
  await page.getByTestId('save-error-banner').getByRole('button', { name: 'Retry now' }).click();
  await expectSaved(page);
  await page.reload();
  await expect(editor(page)).toContainText('survives failures');
});

test('unsaved edits survive a hard reload via the recovery draft', async ({ page }) => {
  const id = await createPage(page, unique('Reload'));
  await page.keyboard.press('Enter');
  await expectSaved(page);
  await page.route(`**/api/pages/${id}/content`, (route) => route.abort('connectionfailed'));
  await editor(page).pressSequentially('typed while offline');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'error');
  page.on('dialog', (d) => void d.accept());
  await page.unroute(`**/api/pages/${id}/content`);
  await page.reload();
  await expect(editor(page)).toContainText('typed while offline');
  await expectSaved(page);
  const detail = await apiGet<{ contentJson: unknown }>(page.request, `/api/pages/${id}`);
  expect(JSON.stringify(detail.contentJson)).toContain('typed while offline');
});

test('two tabs editing the same page get a conflict instead of clobbering', async ({
  page,
  context,
}) => {
  const id = await createPage(page, unique('Conflict'));
  await page.keyboard.press('Enter');
  await editor(page).pressSequentially('base');
  await expectSaved(page);

  const other = await context.newPage();
  await other.goto(`/p/${id}`);
  await expect(editor(other)).toContainText('base');

  // Tab 1 saves a change first.
  await editor(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' from tab one');
  await expectSaved(page);

  // Tab 2 still has the old revision: its save must conflict.
  await editor(other).click();
  await other.keyboard.press('End');
  await other.keyboard.type(' from tab two');
  await expect(other.getByTestId('save-status')).toHaveAttribute('data-status', 'conflict');
  await expect(other.getByTestId('conflict-banner')).toBeVisible();

  // The server still has tab one's version.
  const server = await apiGet<{ contentJson: unknown }>(page.request, `/api/pages/${id}`);
  expect(JSON.stringify(server.contentJson)).toContain('from tab one');
  expect(JSON.stringify(server.contentJson)).not.toContain('from tab two');

  // Resolve by explicitly keeping tab two's version.
  await other.getByTestId('conflict-keep-mine').click();
  await other.getByTestId('confirm-ok').click();
  await expectSaved(other);
  const after = await apiGet<{ contentJson: unknown }>(page.request, `/api/pages/${id}`);
  expect(JSON.stringify(after.contentJson)).toContain('from tab two');

  // Tab one is now behind: loading the latest after confirmation shows tab two's text.
  await editor(page).click();
  await page.keyboard.type('!');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'conflict');
  await page.getByTestId('conflict-load-latest').click();
  await page.getByTestId('confirm-ok').click();
  await expect(editor(page)).toContainText('from tab two');
  await expectSaved(page);
});
