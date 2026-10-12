import { expect, test } from '@playwright/test';
import { apiGet, createPage, editor, expectSaved, login, unique } from './helpers';

interface Summary {
  id: string;
  parentId: string | null;
  title: string;
  deletedAt: string | null;
}

test('workspace export can be imported again (merge) with hierarchy and content', async ({
  page,
}) => {
  await login(page);
  const parentTitle = unique('Export parent');
  const parentId = await createPage(page, parentTitle);
  await page.keyboard.press('Enter');
  await editor(page).pressSequentially('exported body');
  await expectSaved(page);
  const childRes = await page.request.post('/api/pages', {
    headers: { 'X-Requested-With': 'notatnik', Origin: new URL(page.url()).origin },
    data: { parentId, title: `${parentTitle} child` },
  });
  expect(childRes.ok()).toBeTruthy();

  const exportRes = await page.request.get('/api/export');
  expect(exportRes.headers()['content-disposition']).toContain('attachment');
  const dump = await exportRes.json();
  expect(dump.format).toBe('notatnik-workspace');

  const importRes = await page.request.post('/api/import?mode=merge', {
    headers: { 'X-Requested-With': 'notatnik', Origin: new URL(page.url()).origin },
    data: dump,
  });
  expect(importRes.ok()).toBeTruthy();

  const { pages } = await apiGet<{ pages: Summary[] }>(page.request, '/api/pages');
  const parents = pages.filter((p) => p.title === parentTitle);
  expect(parents).toHaveLength(2);
  const copy = parents.find((p) => p.id !== parentId)!;
  expect(pages.some((p) => p.parentId === copy.id && p.title === `${parentTitle} child`)).toBe(
    true,
  );
  const detail = await apiGet<{ contentJson: unknown }>(page.request, `/api/pages/${copy.id}`);
  expect(JSON.stringify(detail.contentJson)).toContain('exported body');
});

test('settings can create a database backup', async ({ page }) => {
  await login(page);
  await page.goto('/settings');
  await page.getByTestId('backup-button').click();
  await expect(page.getByText(/Saved to .*\.db/)).toBeVisible();
});
