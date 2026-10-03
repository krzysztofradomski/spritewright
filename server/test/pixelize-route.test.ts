import { expect, test } from "vitest";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import sharp from "sharp";
import { AssetStore } from "../asset-store.js";
import { registerRoutes } from "../routes.js";

async function studio() {
  const root = await mkdtemp(join(tmpdir(), "pixelize-route-"));
  await mkdir(join(root, "games", "test-game", "assets"), { recursive: true });
  const app = Fastify();
  await registerRoutes(app, root);
  return { app, root };
}

/** A red disc on transparency: a subject with a real silhouette. */
async function sprite(path: string) {
  const circle = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><circle cx="128" cy="128" r="90" fill="#c82828"/></svg>');
  await sharp(circle).png().toFile(path);
}

test("pixelizing an asset saves a native-resolution version with a palette", async () => {
  const { app, root } = await studio();
  const file = join(root, "hero.png");
  await sprite(file);
  const store = new AssetStore(root);
  const asset = await store.importAsset({
    gameId: "test-game", family: "characters", sourcePath: file, filename: "hero.png",
    provenance: { provider: "test" },
  });

  const response = await app.inject({
    method: "POST", url: `/api/assets/${asset.id}/pixelize`,
    payload: { gameId: "test-game", grid: 32, colors: 8, outline: true },
  });

  expect(response.statusCode).toBe(201);
  const created = response.json();
  expect(created.pixel.palette.length).toBeGreaterThan(0);
  expect([created.inspection.width, created.inspection.height]).toEqual([32, 32]);
  expect(created.provenance.parentId).toBe(asset.id);
  // The original is untouched.
  const original = await store.getAsset("test-game", asset.id);
  expect(original?.inspection?.width).toBe(256);
});

test("pixelizing a missing asset is a 404", async () => {
  const { app } = await studio();
  const response = await app.inject({
    method: "POST", url: "/api/assets/does-not-exist/pixelize",
    payload: { gameId: "test-game" },
  });
  expect(response.statusCode).toBe(404);
});

test("an out-of-range grid is rejected", async () => {
  const { app } = await studio();
  const response = await app.inject({
    method: "POST", url: "/api/assets/any/pixelize",
    payload: { gameId: "test-game", grid: 4096 },
  });
  expect(response.statusCode).toBe(400);
});
