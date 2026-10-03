import { expect, test } from "vitest";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { AssetStore } from "../asset-store.js";
import { inspectImage } from "../image-inspector.js";
import { SettingsStore } from "../settings-store.js";

/** Fills its canvas edge to edge, which is what trips the crop-edge warning. */
async function edgeToEdgeSprite(path: string) {
  await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } } })
    .png().toFile(path);
}

/** A studio root with one game on disk: paths resolve a gameId by listing `games/`. */
async function studioRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, "games", "test-game", "assets"), { recursive: true });
  return root;
}

test("a pixel asset is not warned about touching the crop edge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pixel-inspect-"));
  const file = join(dir, "sprite.png");
  await edgeToEdgeSprite(file);
  const plain = await inspectImage(file);
  expect(plain.warnings.join(" ")).toMatch(/crop edge/);
  const pixel = await inspectImage(file, { pixel: true });
  expect(pixel.warnings.join(" ")).not.toMatch(/crop edge/);
});

test("the palette is stored on the asset record", async () => {
  const root = await studioRoot("pixel-store-");
  const file = join(root, "sprite.png");
  await edgeToEdgeSprite(file);
  const store = new AssetStore(root);
  const asset = await store.importAsset({
    gameId: "test-game",
    family: "characters",
    sourcePath: file,
    filename: "hero.png",
    provenance: { provider: "pixelize" },
    pixel: { palette: ["#ff0000", "#0000ff"] },
  });
  expect(asset.pixel).toEqual({ palette: ["#ff0000", "#0000ff"] });
  const reloaded = await store.getAsset("test-game", asset.id);
  expect(reloaded?.pixel?.palette).toEqual(["#ff0000", "#0000ff"]);
});

test("project palette and pixel style round-trip through settings", async () => {
  const root = await studioRoot("pixel-settings-");
  const settings = new SettingsStore(root);
  await settings.set("test-game", { palette: ["#112233"], pixelStyle: { grid: 32, colors: 8, outline: false } });
  const saved = await settings.get("test-game");
  expect(saved.palette).toEqual(["#112233"]);
  expect(saved.pixelStyle).toEqual({ grid: 32, colors: 8, outline: false });
  // Merging must not wipe a sibling setting.
  await settings.set("test-game", { globalPrompt: "cosy" });
  expect((await settings.get("test-game")).palette).toEqual(["#112233"]);
});
