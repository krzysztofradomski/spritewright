import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { inspectImage } from "./image-inspector.js";
import {
  resolveAssetRelativePath,
  resolveGameAssetsDir,
  versionedFilename,
} from "./paths.js";
import type { AssetRecord, AssetState, GameId } from "./types.js";
import { createSerialQueue } from "./serial.js";

type Manifest = { version: 1; assets: AssetRecord[] };
const states: AssetState[] = ["source", "candidates", "approved"];

export class AssetStore {
  /** Every manifest mutation goes through here; see createSerialQueue. */
  private readonly serial = createSerialQueue();
  constructor(private readonly rootDir: string) {}
  private manifestPath(gameId: GameId, family: string) {
    return join(
      resolveGameAssetsDir(this.rootDir, gameId),
      "manifests",
      `${family}.json`,
    );
  }
  private async readManifest(
    gameId: GameId,
    family: string,
  ): Promise<Manifest> {
    try {
      const manifest = JSON.parse(
        await readFile(this.manifestPath(gameId, family), "utf8"),
      ) as Partial<Manifest>;
      // Remixes and repairs of a sprite map were once saved without the tag the Animation
      // Lab looks for; backfill it on read so those records need no migration.
      return Array.isArray(manifest.assets)
        ? {
            version: 1,
            assets: manifest.assets.map((asset) =>
              isSpriteMapFilename(asset.filename) && !asset.tags.includes("animation-spritemap")
                ? { ...asset, tags: [...asset.tags, "animation-spritemap"].sort() }
                : asset,
            ),
          }
        : { version: 1, assets: [] };
    } catch {
      return { version: 1, assets: [] };
    }
  }
  private async writeManifest(
    gameId: GameId,
    family: string,
    manifest: Manifest,
  ) {
    const path = this.manifestPath(gameId, family);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(manifest, null, 2));
    await rename(temporary, path);
  }
  async listAssets(gameId: GameId): Promise<AssetRecord[]> {
    const manifestsDir = join(
      resolveGameAssetsDir(this.rootDir, gameId),
      "manifests",
    );
    let files: string[] = [];
    try {
      files = await readdir(manifestsDir);
    } catch {
      return [];
    }
    const families = await Promise.all(
      files
        .filter(
          (file) => file.endsWith(".json") && file !== "studio-settings.json",
        )
        .map((file) =>
          this.readManifest(gameId, file.slice(0, -".json".length)),
        ),
    );
    return families.flatMap((manifest) => manifest.assets);
  }
  importAsset(input: Parameters<AssetStore["importAssetNow"]>[0]) {
    return this.serial(() => this.importAssetNow(input));
  }
  moveAsset(gameId: GameId, assetId: string, state: AssetState) {
    return this.serial(() => this.moveAssetNow(gameId, assetId, state));
  }
  transferAsset(gameId: GameId, assetId: string, targetGameId: GameId) {
    return this.serial(() => this.transferAssetNow(gameId, assetId, targetGameId));
  }
  removeAsset(gameId: GameId, assetId: string) {
    return this.serial(() => this.removeAssetNow(gameId, assetId));
  }
  restoreTrashed(gameId: GameId, trashPath: string) {
    return this.serial(() => this.restoreTrashedNow(gameId, trashPath));
  }
  /** Permanently deletes trashed files (and their saved records). Nothing outside .trash is touched. */
  deleteTrashed(gameId: GameId, trashPaths: string[]) {
    return this.serial(async () => {
      const deleted: string[] = [];
      for (const trashPath of trashPaths) {
        if (!TRASHED_ASSET.test(trashPath)) throw new Error(`Not a trashed asset: ${trashPath}`);
        const file = resolveAssetRelativePath(this.rootDir, gameId, trashPath);
        if (!(await exists(file))) continue;
        await rm(file);
        await rm(`${file}.json`, { force: true });
        deleted.push(trashPath);
      }
      return deleted;
    });
  }
  /** Files in the project's .trash, with the record saved beside each one when there is one. */
  async listTrash(gameId: GameId): Promise<TrashedAsset[]> {
    const trashDir = join(resolveGameAssetsDir(this.rootDir, gameId), ".trash");
    const families = await readdir(trashDir, { withFileTypes: true }).catch(() => []);
    const items = await Promise.all(
      families.filter((entry) => entry.isDirectory()).map(async (family) => {
        const files = await readdir(join(trashDir, family.name)).catch(() => [] as string[]);
        return Promise.all(
          files.filter((file) => /\.(png|webp|jpe?g)$/i.test(file)).map(async (file) => {
            const path = `.trash/${family.name}/${file}`;
            const absolute = join(trashDir, family.name, file);
            const saved = await readFile(`${absolute}.json`, "utf8").then((text) => JSON.parse(text) as TrashRecord).catch(() => null);
            return {
              path,
              family: family.name,
              filename: saved?.record.filename ?? file,
              removedAt: saved?.removedAt ?? (await stat(absolute)).mtime.toISOString(),
              ...(saved ? { record: saved.record } : {}),
            };
          }),
        );
      }),
    );
    return items.flat().sort((a, b) => b.removedAt.localeCompare(a.removedAt));
  }
  private async importAssetNow(input: {
    gameId: GameId;
    family: string;
    sourcePath: string;
    filename: string;
    state?: AssetState;
    tags?: string[];
    provenance: AssetRecord["provenance"];
    pixel?: { palette: string[] };
  }): Promise<AssetRecord> {
    const state = input.state ?? "candidates";
    if (!states.includes(state)) throw new Error("Invalid asset state.");
    const manifest = await this.readManifest(input.gameId, input.family);
    const version =
      manifest.assets.filter(
        (asset) =>
          asset.filename.replace(/-v\d+(?=\.[^.]+$)/, "") === input.filename,
      ).length + 1;
    const filename = versionedFilename(input.filename, version);
    const relativePath = `${state}/${input.family}/${filename}`;
    const target = resolveAssetRelativePath(
      this.rootDir,
      input.gameId,
      relativePath,
    );
    await mkdir(dirname(target), { recursive: true });
    await copyFile(input.sourcePath, target);
    const now = new Date().toISOString();
    const inspection = await inspectImage(target, { pixel: Boolean(input.pixel) });
    const tags = [
      ...new Set([
        ...autoTags(input.family, filename, inspection),
        ...(input.tags ?? []),
      ]),
    ].sort();
    const asset: AssetRecord = {
      id: randomUUID(),
      gameId: input.gameId,
      family: input.family,
      state,
      filename,
      relativePath,
      version,
      createdAt: now,
      updatedAt: now,
      provenance: input.provenance,
      inspection,
      tags,
      ...(input.pixel ? { pixel: input.pixel } : {}),
    };
    manifest.assets.push(asset);
    await this.writeManifest(input.gameId, input.family, manifest);
    return asset;
  }
  private async moveAssetNow(gameId: GameId, assetId: string, state: AssetState) {
    const assets = await this.listAssets(gameId);
    const asset = assets.find((candidate) => candidate.id === assetId);
    if (!asset) throw new Error("Asset not found.");
    if (!states.includes(state)) throw new Error("Invalid asset state.");
    const manifest = await this.readManifest(gameId, asset.family);
    const record = manifest.assets.find(
      (candidate) => candidate.id === assetId,
    );
    if (!record) throw new Error("Asset not found.");
    const nextRelative = `${state}/${asset.family}/${asset.filename}`;
    const previousRelative = record.relativePath;
    const from = resolveAssetRelativePath(
      this.rootDir,
      gameId,
      previousRelative,
    );
    const to = resolveAssetRelativePath(this.rootDir, gameId, nextRelative);
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    record.state = state;
    record.relativePath = nextRelative;
    record.updatedAt = new Date().toISOString();
    try {
      await this.writeManifest(gameId, asset.family, manifest);
    } catch (error) {
      await rename(to, from).catch(() => undefined);
      record.relativePath = previousRelative;
      throw error;
    }
    return record;
  }
  /** Moves a file and its record into another project, keeping id, state, family and history. */
  private async transferAssetNow(gameId: GameId, assetId: string, targetGameId: GameId) {
    if (gameId === targetGameId) throw new Error("The asset is already in that project.");
    const source = await this.getAsset(gameId, assetId);
    if (!source) throw new Error("Asset not found.");
    const sourceManifest = await this.readManifest(gameId, source.family);
    const targetManifest = await this.readManifest(targetGameId, source.family);
    const baseName = source.filename.replace(/-v\d+(?=\.[^.]+$)/, "");
    const version = targetManifest.assets.filter((asset) => asset.filename.replace(/-v\d+(?=\.[^.]+$)/, "") === baseName).length + 1;
    const filename = versionedFilename(baseName, version);
    const relativePath = `${source.state}/${source.family}/${filename}`;
    const from = resolveAssetRelativePath(this.rootDir, gameId, source.relativePath);
    const to = resolveAssetRelativePath(this.rootDir, targetGameId, relativePath);
    const moved: AssetRecord = { ...source, gameId: targetGameId, filename, relativePath, version, updatedAt: new Date().toISOString() };
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    try {
      await this.writeManifest(targetGameId, source.family, { ...targetManifest, assets: [...targetManifest.assets, moved] });
    } catch (error) {
      await rename(to, from).catch(() => undefined);
      throw error;
    }
    // ponytail: two manifest writes aren't atomic; if this one fails the asset shows in both
    // projects (file lives in the target), which the user can fix by removing the stale card.
    await this.writeManifest(gameId, source.family, { ...sourceManifest, assets: sourceManifest.assets.filter((asset) => asset.id !== assetId) });
    return moved;
  }
  async getAsset(gameId: GameId, assetId: string) {
    return (
      (await this.listAssets(gameId)).find((asset) => asset.id === assetId) ??
      null
    );
  }
  private async removeAssetNow(gameId: GameId, assetId: string) {
    const asset = await this.getAsset(gameId, assetId);
    if (!asset) throw new Error("Asset not found.");
    const manifest = await this.readManifest(gameId, asset.family);
    const recordIndex = manifest.assets.findIndex(
      (candidate) => candidate.id === assetId,
    );
    if (recordIndex < 0) throw new Error("Asset not found.");
    const from = resolveAssetRelativePath(
      this.rootDir,
      gameId,
      asset.relativePath,
    );
    // A second removal of the same filename gets its own name instead of overwriting the first.
    let trashRelative = `.trash/${asset.family}/${asset.filename}`;
    if (await exists(resolveAssetRelativePath(this.rootDir, gameId, trashRelative)))
      trashRelative = `.trash/${asset.family}/${basename(asset.filename, extname(asset.filename))}-${Date.now()}${extname(asset.filename)}`;
    const to = resolveAssetRelativePath(this.rootDir, gameId, trashRelative);
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    // Keep the record beside the file, so a restore brings back tags, prompt and history.
    const trashRecord: TrashRecord = { removedAt: new Date().toISOString(), record: asset };
    await writeFile(`${to}.json`, JSON.stringify(trashRecord, null, 2));
    const removed = manifest.assets.splice(recordIndex, 1)[0]!;
    try {
      await this.writeManifest(gameId, asset.family, manifest);
    } catch (error) {
      await rename(to, from).catch(() => undefined);
      manifest.assets.splice(recordIndex, 0, removed);
      throw error;
    }
    return { ...removed, trashedPath: trashRelative };
  }
  private async restoreTrashedNow(gameId: GameId, trashPath: string) {
    if (!TRASHED_ASSET.test(trashPath)) throw new Error("Not a trashed asset.");
    const from = resolveAssetRelativePath(this.rootDir, gameId, trashPath);
    if (!(await exists(from))) throw new Error("That file is no longer in the trash.");
    const family = trashPath.split("/")[1]!;
    const saved = await readFile(`${from}.json`, "utf8").then((text) => JSON.parse(text) as TrashRecord).catch(() => null);
    if (!saved) {
      // Removed before records were kept: bring it back as a fresh candidate.
      const restored = await this.importAssetNow({ gameId, family, sourcePath: from, filename: basename(trashPath).replace(/-\d{13}(?=\.[^.]+$)/, ""), provenance: { provider: "restored-from-trash" } });
      await rm(from);
      return restored;
    }
    const manifest = await this.readManifest(gameId, saved.record.family);
    const taken = new Set(manifest.assets.map((asset) => asset.filename));
    let version = saved.record.version;
    let filename = saved.record.filename;
    const baseName = filename.replace(/-v\d+(?=\.[^.]+$)/, "");
    // Another asset may have taken the old name since; take the next free version instead.
    while (taken.has(filename) || (await exists(resolveAssetRelativePath(this.rootDir, gameId, `${saved.record.state}/${saved.record.family}/${filename}`))))
      filename = versionedFilename(baseName, ++version);
    const relativePath = `${saved.record.state}/${saved.record.family}/${filename}`;
    const to = resolveAssetRelativePath(this.rootDir, gameId, relativePath);
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    const record: AssetRecord = { ...saved.record, gameId, filename, relativePath, version, updatedAt: new Date().toISOString() };
    try {
      await this.writeManifest(gameId, record.family, { ...manifest, assets: [...manifest.assets.filter((asset) => asset.id !== record.id), record] });
    } catch (error) {
      await rename(to, from).catch(() => undefined);
      throw error;
    }
    await rm(`${from}.json`, { force: true });
    return record;
  }
}

type TrashRecord = { removedAt: string; record: AssetRecord };
/** A file directly inside .trash/<family>/; no nested paths, so ".." can never slip through. */
const TRASHED_ASSET = /^\.trash\/[a-z0-9-]+\/[^/\\]+\.(png|webp|jpe?g)$/i;
export type TrashedAsset = { path: string; family: string; filename: string; removedAt: string; record?: AssetRecord };
const exists = (path: string) => access(path).then(() => true, () => false);

/** Every copy of a sprite map (a remix, a repair) keeps "spritemap" in its name. */
const isSpriteMapFilename = (filename: string) =>
  filename.replace(/\.[^.]+$/, "").split(/[-_]/).includes("spritemap");

function autoTags(
  family: string,
  filename: string,
  inspection: NonNullable<AssetRecord["inspection"]>,
) {
  const tags = new Set([
    family,
    ...filename
      .replace(/\.[^.]+$/, "")
      .split(/[-_]/)
      .filter((part) => part.length > 2),
  ]);
  if (isSpriteMapFilename(filename)) tags.add("animation-spritemap");
  tags.add(inspection.hasAlpha ? "transparent" : "opaque");
  if (inspection.warnings.some((warning) => warning.includes("crop edge")))
    tags.add("crop-edge");
  if (inspection.warnings.some((warning) => warning.includes("No alpha")))
    tags.add("needs-alpha");
  return [...tags].sort();
}
