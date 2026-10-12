import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { PASSWORD, USERNAME, editor, expectSaved } from './helpers';

const PORT = 8091;
const BASE = `http://127.0.0.1:${PORT}`;

async function startServer(dataDir: string): Promise<ChildProcess> {
  const child = spawn('node', [join(__dirname, 'serve.mjs')], {
    env: { ...process.env, E2E_PORT: String(PORT), E2E_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) {
        return child;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill('SIGTERM');
  throw new Error('server did not start');
}

async function stopServer(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

test('content persists across an application restart', async ({ page }) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'notatnik-restart-'));
  let server = await startServer(dataDir);
  try {
    await page.goto(`${BASE}/login`);
    await page.getByTestId('login-username').fill(USERNAME);
    await page.getByTestId('login-password').fill(PASSWORD);
    await page.getByTestId('login-submit').click();
    await page.getByTestId('new-page').click();
    await page.waitForURL(/\/p\//);
    const url = page.url();
    await page.getByTestId('page-title').fill('Survives restart');
    await page.keyboard.press('Enter');
    await editor(page).pressSequentially('persisted across restart');
    await expectSaved(page);

    await stopServer(server);
    server = await startServer(dataDir);

    // Sessions are stored server-side, so the browser stays signed in after a restart.
    await page.goto(url);
    await expect(page.getByTestId('page-title')).toHaveValue('Survives restart');
    await expect(editor(page)).toContainText('persisted across restart');
  } finally {
    await stopServer(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
