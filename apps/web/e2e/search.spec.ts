import { expect, test } from '@playwright/test';
import { createPage, editor, expectSaved, login, unique } from './helpers';

test('search finds titles and body text and navigates with the keyboard', async ({ page }) => {
  await login(page);
  const word = `zebra${Date.now().toString(36)}`;
  const titleId = await createPage(page, `${word} in title`);
  const bodyTitle = unique('Body match');
  const bodyId = await createPage(page, bodyTitle);
  await page.keyboard.press('Enter');
  await editor(page).pressSequentially(`the hidden word is ${word} here`);
  await expectSaved(page);

  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.getByTestId('search-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('search-input').fill(word);
  const results = dialog.getByTestId('search-result');
  await expect(results).toHaveCount(2);
  // Title matches rank first.
  await expect(results.first()).toContainText(`${word} in title`);
  await expect(results.nth(1)).toContainText(bodyTitle);
  await expect(results.nth(1).locator('mark')).toHaveText(word);

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(bodyId));
  await expect(dialog).toBeHidden();

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('search-input').fill(word.slice(0, 6));
  await expect(dialog.getByTestId('search-result').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(titleId).toBeTruthy();
});
