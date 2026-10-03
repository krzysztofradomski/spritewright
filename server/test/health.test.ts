import { buildServer } from '../index.js';
import { expect, test } from 'vitest';

test('reports that the local studio server is healthy', async () => {
  const app = await buildServer({ rootDir: process.cwd() });
  const response = await app.inject({ method: 'GET', url: '/api/health' });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true });

  await app.close();
});
