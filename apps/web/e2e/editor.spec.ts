import { expect, test } from '@playwright/test';
import { apiGet, createPage, editor, expectSaved, login, unique } from './helpers';

interface Node {
  type: string;
  content?: Node[];
  attrs?: Record<string, unknown>;
}

function types(node: Node, out = new Set<string>()): Set<string> {
  out.add(node.type);
  node.content?.forEach((c) => types(c, out));
  return out;
}

test('rich content round-trips through save and reload', async ({ page }) => {
  await login(page);
  const id = await createPage(page, unique('Rich'));
  await page.keyboard.press('Enter');
  const kb = page.keyboard;

  // Slash menu: filter and insert a heading.
  await kb.type('/head');
  const menu = page.getByTestId('slash-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('option').first()).toContainText('Heading 1');
  await kb.press('ArrowDown');
  await kb.press('Enter');
  await expect(menu).toBeHidden();
  await kb.type('Section two');
  await kb.press('Enter');

  // Markdown-style input rules and shortcuts.
  await kb.type('Some ');
  await kb.press('ControlOrMeta+b');
  await kb.type('bold');
  await kb.press('ControlOrMeta+b');
  await kb.type(' and `code` text');
  await kb.press('Enter');
  await kb.type('- bullet one');
  await kb.press('Enter');
  await kb.type('bullet two');
  await kb.press('Enter');
  await kb.press('Enter');
  await kb.type('1. numbered');
  await kb.press('Enter');
  await kb.press('Enter');
  await kb.type('[ ] a task');
  await kb.press('Enter');
  await kb.press('Enter');
  await kb.type('> quoted');
  await kb.press('Enter');
  await kb.press('Enter');
  await kb.type('/code');
  await kb.press('Enter');
  await kb.type('const x = 1;');
  await kb.press('ArrowDown');
  await kb.type('/divider');
  await kb.press('Enter');
  await kb.type('/table');
  await kb.press('Enter');
  await kb.type('cell A');

  // Escape closes the slash menu without inserting anything.
  await kb.press('Tab');
  await kb.type('/xyz');
  await expect(menu).toContainText('No matching blocks');
  await kb.press('Escape');
  await expect(menu).toBeHidden();

  await expectSaved(page);
  await page.reload();

  const ed = editor(page);
  await expect(ed.locator('h2')).toHaveText('Section two');
  await expect(ed.locator('strong')).toHaveText('bold');
  await expect(ed.locator('p code')).toHaveText('code');
  await expect(ed.locator('ul:not([data-type]) li')).toHaveCount(2);
  await expect(ed.locator('ol li')).toHaveText('numbered');
  await expect(ed.locator('ul[data-type="taskList"] li')).toContainText('a task');
  await expect(ed.locator('blockquote')).toContainText('quoted');
  await expect(ed.locator('pre code')).toHaveText('const x = 1;');
  await expect(ed.locator('hr')).toHaveCount(1);
  await expect(ed.locator('table th').first()).toHaveText('cell A');

  const detail = await apiGet<{ contentJson: Node }>(page.request, `/api/pages/${id}`);
  const found = types(detail.contentJson);
  for (const t of [
    'heading',
    'bulletList',
    'orderedList',
    'taskList',
    'taskItem',
    'blockquote',
    'codeBlock',
    'horizontalRule',
    'table',
    'tableHeader',
  ]) {
    expect(found, `missing ${t}`).toContain(t);
  }
});

test('selection toolbar applies formatting and safe links', async ({ page }) => {
  await login(page);
  await createPage(page, unique('Toolbar'));
  await page.keyboard.press('Enter');
  await page.keyboard.type('link me');
  await page.keyboard.press('Shift+Home');
  const toolbar = page.getByRole('toolbar', { name: 'Text formatting' });
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole('button', { name: 'Italic' }).click();
  await expect(editor(page).locator('em')).toHaveText('link me');
  await toolbar.getByRole('button', { name: 'Link' }).click();
  await page.getByLabel('Link URL').fill('example.org/docs');
  await page.getByLabel('Link URL').press('Enter');
  await expect(editor(page).locator('a')).toHaveAttribute('href', 'https://example.org/docs');
  await expectSaved(page);
});
