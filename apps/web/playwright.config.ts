import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env['E2E_PORT'] ?? 8090);

/**
 * End-to-end tests run against the real Rust API serving the production Angular build.
 * Run `npm run build` first; the API binary is built automatically if missing.
 */
export default defineConfig({
  testDir: './e2e',
  // One private account and one database: keep tests sequential and independent by using
  // unique page titles.
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node e2e/serve.mjs',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'pipe',
    env: { E2E_PORT: String(port) },
  },
});
