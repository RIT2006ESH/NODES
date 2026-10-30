/**
 * Runs the load test against a throwaway server with its own temp data dir.
 *
 * Usage: npm run loadtest:isolated
 *
 * This exists so a benchmark can never leave bot nodes and bot-created edges
 * in the demo Line. The normal `npm run loadtest` is still available for
 * testing an already-deployed host (and does mutate that host).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const dataDir = mkdtempSync(join(tmpdir(), 'mng-loadtest-'));

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function stop(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

async function waitForHealth(base: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch {
      // server is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become healthy at ${base}`);
}

function run(script: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, script], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
console.log(`[isolated] server on ${base}, data ${dataDir}`);

const server = spawn(process.execPath, [tsxCli, 'apps/server/src/main.ts'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    ADMIN_SECRET: 'isolated-loadtest',
  },
  stdio: 'inherit',
});

try {
  await waitForHealth(base);
  process.exitCode = await run('tools/loadtest/src/run.ts', { BASE_URL: base });
} finally {
  stop(server);
  rmSync(dataDir, { recursive: true, force: true });
}
