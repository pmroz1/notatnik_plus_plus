import { APIRequestContext, Page, expect } from '@playwright/test';

export const USERNAME = process.env['E2E_USERNAME'] ?? 'e2e';
export const PASSWORD = process.env['E2E_PASSWORD'] ?? 'e2e-password-not-secret';

export function unique(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
}

export async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-username').fill(USERNAME);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sidebar').or(page.getByTestId('open-sidebar'))).toBeVisible();
}

/** Creates a page through the UI, sets its title and returns its id. */
export async function createPage(page: Page, title: string): Promise<string> {
  const before = page.url();
  await page.getByTestId('new-page').click();
  await page.waitForURL((url) => /\/p\/[0-9a-f-]+$/.test(url.pathname) && url.href !== before);
  const id = page.url().split('/p/')[1];
  const titleBox = page.getByTestId('page-title');
  await expect(titleBox).toBeFocused();
  await titleBox.fill(title);
  if (await page.getByTestId('sidebar').isVisible()) {
    await expect(treeLink(page, id)).toContainText(title);
  }
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(title);
  return id;
}

export function treeLink(page: Page, id: string) {
  return page.locator(`[data-tree-link="${id}"]`);
}

export function editor(page: Page) {
  return page.locator('.notes-editor .ProseMirror');
}

export async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved', {
    timeout: 15_000,
  });
}

/** Authenticated API helper sharing the browser's session cookie. */
export async function apiGet<T>(request: APIRequestContext, path: string): Promise<T> {
  const res = await request.get(path);
  expect(res.ok(), `${path} -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as T;
}
