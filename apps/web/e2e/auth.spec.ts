import { expect, test } from '@playwright/test';
import { PASSWORD, USERNAME, login } from './helpers';

test.describe('authentication', () => {
  test('unauthenticated visitors are sent to the login page', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login\?returnUrl=%2Fsettings/);
  });

  test('wrong password shows an error, correct password signs in and returns', async ({ page }) => {
    await page.goto('/settings');
    await page.getByTestId('login-username').fill(USERNAME);
    await page.getByTestId('login-password').fill('definitely-wrong');
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-error')).toContainText('Invalid username or password');
    await page.getByTestId('login-password').fill(PASSWORD);
    await page.getByTestId('login-submit').click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  test('sign out ends the session', async ({ page }) => {
    await login(page);
    await page.goto('/settings');
    await page.getByTestId('logout').click();
    await expect(page).toHaveURL(/\/login/);
    const res = await page.request.get('/api/pages');
    expect(res.status()).toBe(401);
  });

  test('unauthorized requests cannot read, mutate, export or import notes', async ({ request }) => {
    const headers = { 'X-Requested-With': 'notatnik', Origin: 'http://127.0.0.1:8090' };
    expect((await request.get('/api/pages')).status()).toBe(401);
    expect((await request.get('/api/export')).status()).toBe(401);
    expect((await request.get('/api/search?q=a')).status()).toBe(401);
    expect((await request.post('/api/pages', { headers, data: {} })).status()).toBe(401);
    expect(
      (await request.post('/api/import?mode=merge', { headers, data: { format: 'x' } })).status(),
    ).toBe(401);
  });
});
