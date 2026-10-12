import { expect, test } from '@playwright/test';
import { PASSWORD, USERNAME, editor, expectSaved, treeLink } from './helpers';

test('core flows work without a mouse', async ({ page }) => {
  const renamed = `Keyboard renamed ${Date.now()}`;
  await page.goto('/login');
  await expect(page.getByTestId('login-username')).toBeFocused();
  await page.keyboard.type(USERNAME);
  await page.keyboard.press('Tab');
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('sidebar')).toBeVisible();

  // Command palette: create a page.
  await page.keyboard.press('ControlOrMeta+k');
  const create = page.getByTestId('search-result').filter({ hasText: 'Create a new page' });
  await expect(create).toBeVisible();
  const selected = page.locator('[data-testid="search-result"][aria-selected="true"]');
  for (let i = 0; i < 20 && (await create.getAttribute('aria-selected')) !== 'true'; i++) {
    const before = await selected.getAttribute('id');
    await page.keyboard.press('ArrowDown');
    // Wait for the re-render so the next check sees the new selection.
    await expect(selected).not.toHaveAttribute('id', before ?? '');
  }
  await expect(create).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/p\//);
  const id = page.url().split('/p/')[1];
  await expect(page.getByTestId('page-title')).toBeFocused();
  await page.keyboard.type('Keyboard page');
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type('typed with keys');
  await expectSaved(page);

  // Tree: focus the row, rename with F2, open the actions menu with Enter.
  await treeLink(page, id).focus();
  await page.keyboard.press('F2');
  await expect(page.getByTestId('rename-input')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(renamed);
  await page.keyboard.press('Enter');
  await expect(treeLink(page, id)).toContainText(renamed);
  await expect(treeLink(page, id)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: `Actions for ${renamed}` })).toBeFocused();
  await page.keyboard.press('Enter');
  const menu = page.getByTestId('row-menu-panel');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // Ctrl/Cmd+\ toggles the sidebar.
  await page.keyboard.press('ControlOrMeta+\\');
  await expect(page.getByTestId('sidebar')).toBeHidden();
  await page.keyboard.press('ControlOrMeta+\\');
  await expect(page.getByTestId('sidebar')).toBeVisible();
});
