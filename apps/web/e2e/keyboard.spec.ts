import { expect, test } from '@playwright/test';
import { PASSWORD, USERNAME, editor, expectSaved, treeLink } from './helpers';

test('core flows work without a mouse', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByTestId('login-username')).toBeFocused();
  await page.keyboard.type(USERNAME);
  await page.keyboard.press('Tab');
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('sidebar')).toBeVisible();

  // Command palette: create a page.
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('search-input').press('ArrowDown');
  const create = page.getByTestId('search-result').filter({ hasText: 'Create a new page' });
  await expect(create).toBeVisible();
  while ((await create.getAttribute('aria-selected')) !== 'true') {
    await page.keyboard.press('ArrowDown');
  }
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
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Keyboard renamed');
  await page.keyboard.press('Enter');
  await expect(treeLink(page, id)).toContainText('Keyboard renamed');
  await expect(treeLink(page, id)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Actions for Keyboard renamed' })).toBeFocused();
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
