// Starts an isolated API + static frontend instance for end-to-end tests.
//
// Environment:
//   E2E_PORT        port to bind on 127.0.0.1 (default 8090)
//   E2E_DATA_DIR    data directory (default: fresh temporary directory)
//   E2E_USERNAME / E2E_PASSWORD  account provisioned before start (test-only values)
//   NOTES_API_BIN   prebuilt API binary (default: target/debug/notes-api, built with cargo if missing)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '..');
const repoRoot = resolve(webDir, '..', '..');
const staticDir = join(webDir, 'dist', 'web', 'browser');
const port = process.env.E2E_PORT ?? '8090';
const dataDir = process.env.E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'notatnik-e2e-'));
const username = process.env.E2E_USERNAME ?? 'e2e';
const password = process.env.E2E_PASSWORD ?? 'e2e-password-not-secret';
const exe = process.platform === 'win32' ? 'notes-api.exe' : 'notes-api';
const bin = process.env.NOTES_API_BIN ?? join(repoRoot, 'target', 'debug', exe);

if (!existsSync(join(staticDir, 'index.html'))) {
  console.error(`Frontend build not found in ${staticDir}. Run "npm run build" first.`);
  process.exit(1);
}
if (!process.env.NOTES_API_BIN && !existsSync(bin)) {
  const build = spawnSync('cargo', ['build', '-p', 'notes-api'], { cwd: repoRoot, stdio: 'inherit' });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

const env = {
  ...process.env,
  NOTES_DATA_DIR: dataDir,
  NOTES_BIND: `127.0.0.1:${port}`,
  NOTES_STATIC_DIR: staticDir,
  RUST_LOG: process.env.RUST_LOG ?? 'warn',
};

// Provision the account only for a fresh data directory, so restarting on existing data
// keeps sessions valid (like a real restart).
if (!existsSync(join(dataDir, 'notes.db'))) {
  const create = spawnSync(bin, ['create-user', '--username', username, '--password-stdin'], {
    env,
    input: `${password}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (create.status !== 0) {
    process.exit(create.status ?? 1);
  }
}

console.log(`E2E server on http://127.0.0.1:${port} (data: ${dataDir})`);
const server = spawn(bin, ['serve'], { env, stdio: 'inherit' });
const stop = () => server.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => process.exit(code ?? 0));
