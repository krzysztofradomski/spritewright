import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, test } from "vitest";
import { AssetStore } from "../asset-store.js";
import { createGame, deleteTrashedGame, listGames, listTrashedGames, restoreGame, trashGame } from "../paths.js";

const setup = async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "asset-studio-trash-"));
  await mkdir(join(rootDir, "games"));
  createGame(rootDir, "pocket-river");
  const image = join(rootDir, "duck.png");
  await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toFile(image);
  return { rootDir, image, store: new AssetStore(rootDir) };
};

test("restores a removed asset with its id, tags and prompt, even after its name was reused", async () => {
  const { rootDir, image, store } = await setup();
  try {
    const original = await store.importAsset({ gameId: "pocket-river", family: "animals", sourcePath: image, filename: "duck.png", tags: ["hero"], provenance: { provider: "test", prompt: "a duck" } });
    await store.removeAsset("pocket-river", original.id);
    // Same name removed twice: both copies stay in the trash.
    const again = await store.importAsset({ gameId: "pocket-river", family: "animals", sourcePath: image, filename: "duck.png", provenance: { provider: "test" } });
    await store.removeAsset("pocket-river", again.id);
    const trash = await store.listTrash("pocket-river");
    expect(trash).toHaveLength(2);
    // A third duck takes the original filename before the restore.
    await store.importAsset({ gameId: "pocket-river", family: "animals", sourcePath: image, filename: "duck.png", provenance: { provider: "test" } });
    const entry = trash.find((item) => item.record?.id === original.id)!;
    const restored = await store.restoreTrashed("pocket-river", entry.path);
    expect(restored).toMatchObject({ id: original.id, provenance: { prompt: "a duck" } });
    expect(restored.tags).toContain("hero");
    expect(restored.filename).not.toBe("duck.png");
    expect((await store.listAssets("pocket-river")).map((asset) => asset.id)).toContain(original.id);
    expect(await store.listTrash("pocket-river")).toHaveLength(1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("restores files trashed before records were kept, and whole projects", async () => {
  const { rootDir, image, store } = await setup();
  try {
    const legacyDir = join(rootDir, "games", "pocket-river", "assets", ".trash", "plants");
    await mkdir(legacyDir, { recursive: true });
    await sharp(image).toFile(join(legacyDir, "reed.png"));
    const [legacy] = await store.listTrash("pocket-river");
    expect(legacy).toMatchObject({ path: ".trash/plants/reed.png", filename: "reed.png" });
    expect(legacy!.record).toBeUndefined();
    const restored = await store.restoreTrashed("pocket-river", legacy!.path);
    expect(restored).toMatchObject({ family: "plants", state: "candidates", filename: "reed.png" });
    expect(await readdir(legacyDir)).toEqual([]);

    trashGame(rootDir, "pocket-river");
    const [project] = listTrashedGames(rootDir);
    expect(project).toMatchObject({ directory: "pocket-river" });
    createGame(rootDir, "pocket-river");
    expect(() => restoreGame(rootDir, project!.name)).toThrow("already exists");
    trashGame(rootDir, "pocket-river");
    restoreGame(rootDir, project!.name);
    expect(listGames(rootDir).map((game) => game.id)).toEqual(["pocket-river"]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("permanently deletes only trashed files and trashed projects", async () => {
  const { rootDir, image, store } = await setup();
  try {
    const kept = await store.importAsset({ gameId: "pocket-river", family: "animals", sourcePath: image, filename: "heron.png", provenance: { provider: "test" } });
    const doomed = await store.importAsset({ gameId: "pocket-river", family: "animals", sourcePath: image, filename: "duck.png", provenance: { provider: "test" } });
    await store.removeAsset("pocket-river", doomed.id);
    const [entry] = await store.listTrash("pocket-river");
    // Paths outside .trash, or trying to climb out of it, are refused before anything is deleted.
    await expect(store.deleteTrashed("pocket-river", [kept.relativePath])).rejects.toThrow("Not a trashed asset");
    await expect(store.deleteTrashed("pocket-river", [".trash/animals/../../candidates/animals/heron.png"])).rejects.toThrow("Not a trashed asset");
    expect(await store.deleteTrashed("pocket-river", [entry!.path])).toEqual([entry!.path]);
    expect(await store.listTrash("pocket-river")).toEqual([]);
    const trashDir = join(rootDir, "games", "pocket-river", "assets", ".trash", "animals");
    expect(await readdir(trashDir)).toEqual([]); // the saved record went too
    expect((await store.listAssets("pocket-river")).map((asset) => asset.id)).toEqual([kept.id]);

    createGame(rootDir, "moss-town");
    trashGame(rootDir, "moss-town");
    const [project] = listTrashedGames(rootDir);
    expect(() => deleteTrashedGame(rootDir, "../pocket-river")).toThrow("no longer in the trash");
    deleteTrashedGame(rootDir, project!.name);
    expect(listTrashedGames(rootDir)).toEqual([]);
    expect(listGames(rootDir).map((game) => game.id)).toEqual(["pocket-river"]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
