import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, test } from "vitest";
import { AssetStore } from "../asset-store.js";
import { createGame, listGames, trashGame } from "../paths.js";

test("creates, moves assets between and trashes projects", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "asset-studio-projects-"));
  await mkdir(join(rootDir, "games"));
  try {
    expect(createGame(rootDir, "Pocket River").id).toBe("pocket-river");
    createGame(rootDir, "Moss Town");
    expect(() => createGame(rootDir, "pocket  river")).toThrow("already exists");
    expect(() => createGame(rootDir, "../escape")).toThrow();

    const store = new AssetStore(rootDir);
    const image = join(rootDir, "duck.png");
    await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toFile(image);
    await store.importAsset({ gameId: "moss-town", family: "animals", sourcePath: image, filename: "duck.png", provenance: { provider: "test" } });
    const original = await store.importAsset({ gameId: "pocket-river", family: "animals", sourcePath: image, filename: "duck.png", provenance: { provider: "test" } });

    const moved = await store.transferAsset("pocket-river", original.id, "moss-town");
    // A same-named file already lives in the target, so the moved one gets the next version.
    expect(moved).toMatchObject({ id: original.id, gameId: "moss-town", filename: "duck-v2.png", relativePath: "candidates/animals/duck-v2.png" });
    expect(await store.listAssets("pocket-river")).toEqual([]);
    expect((await store.listAssets("moss-town")).map((asset) => asset.filename)).toEqual(["duck.png", "duck-v2.png"]);

    trashGame(rootDir, "pocket-river");
    expect(listGames(rootDir).map((game) => game.id)).toEqual(["moss-town"]);
    expect(await readdir(join(rootDir, "games", ".trash"))).toHaveLength(1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
