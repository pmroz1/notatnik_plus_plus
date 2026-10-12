import { expect, test } from '@playwright/test';
import { createPage, editor, expectSaved, login, treeLink, unique } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('create, rename, nest, move, trash, restore and delete forever', async ({ page }) => {
  const parentTitle = unique('Parent');
  const parentId = await createPage(page, parentTitle);

  // Add a subpage from the tree row.
  await treeLink(page, parentId).hover();
  await page.getByRole('button', { name: `Add subpage to ${parentTitle}` }).click();
  await page.waitForURL((url) => !url.pathname.endsWith(parentId));
  const childId = page.url().split('/p/')[1];
  const childTitle = unique('Child');
  await page.getByTestId('page-title').fill(childTitle);
  await expect(treeLink(page, childId)).toContainText(childTitle);
  await expect(treeLink(page, childId)).toHaveAttribute('aria-level', '2');
  // Breadcrumb shows the parent.
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(parentTitle);

  // Rename inline in the sidebar with F2.
  await treeLink(page, childId).focus();
  await page.keyboard.press('F2');
  const renamed = unique('Renamed child');
  await page.getByTestId('rename-input').fill(renamed);
  await page.keyboard.press('Enter');
  await expect(treeLink(page, childId)).toContainText(renamed);
  await page.reload();
  await expect(treeLink(page, childId)).toContainText(renamed);

  // Move the child out one level via the context menu.
  await treeLink(page, childId).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move out one level' }).click();
  await expect(treeLink(page, childId)).toHaveAttribute('aria-level', '1');

  // ... and nest it back under the parent with drag and drop.
  await treeLink(page, childId).dragTo(treeLink(page, parentId));
  await expect(treeLink(page, childId)).toHaveAttribute('aria-level', '2');

  // Trash the parent: the child goes with it.
  await page.goto(`/p/${parentId}`);
  await page.getByTestId('page-menu').click();
  await page.getByRole('menuitem', { name: 'Move to trash' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(treeLink(page, parentId)).toHaveCount(0);
  await expect(treeLink(page, childId)).toHaveCount(0);

  // Restore from the trash.
  await page.getByTestId('trash-link').click();
  const row = page.getByTestId('trash-list').locator('li', { hasText: parentTitle });
  await expect(row).toContainText('+1 subpage');
  await row.getByTestId('trash-restore').click();
  await expect(treeLink(page, parentId)).toBeVisible();
  await expect(treeLink(page, childId)).toBeVisible();

  // Trash again and delete forever (with confirmation).
  await treeLink(page, parentId).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to trash' }).click();
  await page.getByTestId('trash-link').click();
  await page
    .getByTestId('trash-list')
    .locator('li', { hasText: parentTitle })
    .getByTestId('trash-delete')
    .click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('trash-list').locator('li', { hasText: parentTitle })).toHaveCount(
    0,
  );
  const res = await page.request.get(`/api/pages/${childId}`);
  expect(res.status()).toBe(404);
});

test('favorites, duplicate and tags', async ({ page }) => {
  const title = unique('Fav');
  const id = await createPage(page, title);
  await page.keyboard.press('Enter');
  await editor(page).pressSequentially('duplicated body');
  await expectSaved(page);

  await page.getByTestId('favorite-toggle').click();
  await expect(
    page
      .getByRole('region', { name: 'Favorites' })
      .or(page.locator('section[aria-labelledby="fav-heading"]')),
  ).toContainText(title);

  const tag = `tag${Date.now().toString(36)}`;
  await page.getByTestId('tag-input').fill(tag);
  await page.getByTestId('tag-input').press('Enter');
  await page
    .getByRole('button', { name: new RegExp(`#${tag}`) })
    .first()
    .click();
  await expect(page.getByTestId('tag-results')).toContainText(title);

  await page.getByTestId('page-menu').click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await page.waitForURL((url) => !url.pathname.endsWith(id));
  await expect(page.getByTestId('page-title')).toHaveValue(`${title} (copy)`);
  await expect(editor(page)).toContainText('duplicated body');
});
