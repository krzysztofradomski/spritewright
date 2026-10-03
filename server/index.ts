import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { registerRoutes } from './routes.js';

export type ServerOptions = { rootDir: string };

export async function buildServer(options: ServerOptions) {
  void options;
  const app = Fastify({ logger: false });

  app.get('/api/health', async () => ({ ok: true }));
  await registerRoutes(app, options.rootDir);

  return app;
}

async function start() {
  const here = dirname(fileURLToPath(import.meta.url));
  const app = await buildServer({ rootDir: resolve(here, '..') });
  await app.listen({ host: '127.0.0.1', port: 4174 });
}

if (process.argv[1]?.endsWith('/server/index.ts')) {
  void start();
}
