import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AssetStore } from "../asset-store.js";

test("lists assets from every manifest family discovered for a game", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "asset-studio-store-"));
  const manifestsDir = join(
    rootDir,
    "games",
    "pocket-river",
    "assets",
    "manifests",
  );
  await mkdir(manifestsDir, { recursive: true });
  await writeFile(
    join(manifestsDir, "animals.json"),
    JSON.stringify({
      version: 1,
      assets: [
        {
          id: "duck",
          gameId: "pocket-river",
          family: "animals",
          state: "candidates",
          filename: "duck.png",
          relativePath: "candidates/animals/duck.png",
          version: 1,
          createdAt: "2026-08-30T00:00:00.000Z",
          updatedAt: "2026-08-30T00:00:00.000Z",
          provenance: { provider: "test" },
          tags: ["animals"],
        },
      ],
    }),
  );

  try {
    expect(
      (await new AssetStore(rootDir).listAssets("pocket-river")).map(
        (asset) => asset.id,
      ),
    ).toEqual(["duck"]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("treats any copy of a sprite map as an animation sprite map, including old records", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "asset-studio-spritemap-"));
  const manifestsDir = join(rootDir, "games", "pocket-river", "assets", "manifests");
  await mkdir(manifestsDir, { recursive: true });
  const record = (id: string, filename: string) => ({
    id, gameId: "pocket-river", family: "animals", state: "candidates", filename,
    relativePath: `candidates/animals/${filename}`, version: 1,
    createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z",
    provenance: { provider: "test" }, tags: ["animals", "variation"],
  });
  await writeFile(join(manifestsDir, "animals.json"), JSON.stringify({ version: 1, assets: [
    // Saved by a remix before the tag was carried over.
    record("remix", "kingfisher-sway-spritemap-variation.png"),
    record("plain", "kingfisher-variation.png"),
  ] }));
  try {
    const store = new AssetStore(rootDir);
    const tagged = (await store.listAssets("pocket-river")).filter((asset) => asset.tags.includes("animation-spritemap"));
    expect(tagged.map((asset) => asset.id)).toEqual(["remix"]);
    expect((await store.getAsset("pocket-river", "remix"))?.tags).toContain("animation-spritemap");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
