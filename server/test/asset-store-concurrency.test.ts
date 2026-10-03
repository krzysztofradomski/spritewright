import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, test } from "vitest";
import { AssetStore } from "../asset-store.js";

test("concurrent imports into one family keep every record", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "asset-studio-race-"));
  try {
    await mkdir(join(rootDir, "games", "pocket-river", "assets"), { recursive: true });
    const image = join(rootDir, "duck.png");
    await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toFile(image);
    const store = new AssetStore(rootDir);
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        store.importAsset({ gameId: "pocket-river", family: "animals", sourcePath: image, filename: `duck-${index}.png`, provenance: { provider: "test" } }),
      ),
    );
    expect((await store.listAssets("pocket-river")).map((asset) => asset.filename).sort()).toEqual(
      ["duck-0.png", "duck-1.png", "duck-2.png", "duck-3.png", "duck-4.png", "duck-5.png"],
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
