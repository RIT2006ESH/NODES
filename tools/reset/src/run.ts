/**
 * Clears the persisted Line and reconnect sessions for local development.
 *
 * Usage: npm run state:reset
 *
 * Stop the server first; it rewrites the files when it exits.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir =
  process.env.DATA_DIR ?? fileURLToPath(new URL('../../../data', import.meta.url));

for (const file of ['line.json', 'line.sessions.json', 'sessions.json']) {
  rmSync(join(dataDir, file), { force: true });
}

console.log(`Cleared persisted Line and sessions in ${dataDir}`);
