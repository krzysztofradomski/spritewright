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

test("uploads accept images larger than Fastify's 1 MB default body limit", async () => {
  const { app } = await studio();
  // Random pixels don't compress, so this PNG is about 1.2 MB, 1.6 MB as base64.
  const noise = await sharp(Buffer.from(Array.from({ length: 640 * 640 * 3 }, () => Math.floor(Math.random() * 256))), { raw: { width: 640, height: 640, channels: 3 } }).png().toBuffer();
  const response = await app.inject({
    method: "POST", url: "/api/uploads",
    payload: { gameId: "test-game", filename: "big.png", contentBase64: noise.toString("base64") },
  });
  expect(response.statusCode).toBe(201);
});
