import { loadEnvFile } from 'node:process';

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const { createGameServer } = await import('./app.js');

let server: Awaited<ReturnType<typeof createGameServer>>;
try {
  server = await createGameServer();
} catch (error) {
  const code = (error as { code?: string }).code;
  if (code === 'EADDRINUSE') {
    const port = process.env.PORT ?? 10000;
    console.error(`Port ${port} is already in use.`);
    console.error('Stop the other process, or start with a different port: PORT=8081 npm start');
    console.error('(dev:web proxies /ws to :8080, so Vite needs PORT=8080 or a matching proxy target.)');
    process.exit(1);
  }
  throw error;
}

const url = `http://localhost:${server.port}`;

console.log(`Mumbai Network Garden listening on ${url}`);
console.log(`  player   ${url}/`);
console.log(`  screen   ${url}/screen`);
console.log(`  health   ${url}/healthz`);
console.log(`  metrics  ${url}/metrics`);
if (!process.env.ADMIN_SECRET) {
  console.log('  admin    disabled (set ADMIN_SECRET to enable /admin/*)');
}
