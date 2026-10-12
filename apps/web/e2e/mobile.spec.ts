import { expect, test } from '@playwright/test';
import { createPage, login, treeLink, unique } from './helpers';

test.use({ viewport: { width: 390, height: 780 } });

test('narrow screens use an overlay sidebar', async ({ page }) => {
  await login(page);
  // The sidebar starts closed on narrow screens.
  await expect(page.getByTestId('sidebar')).toBeHidden();
  await page.getByTestId('open-sidebar').click();
  await expect(page.getByTestId('sidebar')).toBeVisible();
  const title = unique('Mobile');
  const id = await createPage(page, title);
  // Creating a page closes the overlay.
  await expect(page.getByTestId('sidebar')).toBeHidden();
  await page.getByTestId('open-sidebar').click();
  await expect(treeLink(page, id)).toContainText(title);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sidebar')).toBeHidden();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
});
