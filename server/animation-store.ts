import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveGameAssetsDir } from './paths.js';
import type { AnimationRecord, GameId } from './types.js';
import { createSerialQueue } from './serial.js';

export class AnimationStore {
  private readonly serial = createSerialQueue();
  constructor(private readonly rootDir: string) {}
  private path(gameId: GameId) { return join(resolveGameAssetsDir(this.rootDir, gameId), 'animations', 'manifest.json'); }
  async list(gameId: GameId) {
    try {
      // Records saved before ids existed get a stable one derived from their name.
      return (JSON.parse(await readFile(this.path(gameId), 'utf8')) as AnimationRecord[]).map((record) => (record.id ? record : { ...record, id: `legacy-${record.name}` }));
    } catch {
      return [];
    }
  }
  /** Rewrites a project's whole animation list under the store's write queue. */
  update(gameId: GameId, change: (records: AnimationRecord[]) => AnimationRecord[]) {
    return this.serial(async () => {
      const next = change(await this.list(gameId));
      await mkdir(join(resolveGameAssetsDir(this.rootDir, gameId), 'animations'), { recursive: true });
      const path = this.path(gameId);
      await writeFile(`${path}.tmp`, JSON.stringify(next, null, 2));
      await rename(`${path}.tmp`, path);
      return next;
    });
  }
  save(input: Omit<AnimationRecord, 'id'>) { return this.serial(() => this.saveNow(input)); }
  private async saveNow(input: Omit<AnimationRecord, 'id'>) { const path = this.path(input.gameId); const records = await this.list(input.gameId); const record = { ...input, id: randomUUID() }; await mkdir(join(resolveGameAssetsDir(this.rootDir, input.gameId), 'animations'), { recursive: true }); const temporary = `${path}.tmp`; await writeFile(temporary, JSON.stringify([...records, record], null, 2)); await rename(temporary, path); return record; }
}

const usesAsset = (record: AnimationRecord, assetId: string) => record.frames.some((frame) => frame.assetId === assetId);

/** Points every frame cut from `assetId` at its new file, so saved manifests stay usable after a move. */
export function retargetFrames(records: AnimationRecord[], assetId: string, relativePath: string) {
  return records.map((record) =>
    usesAsset(record, assetId)
      ? { ...record, frames: record.frames.map((frame) => (frame.assetId === assetId ? { ...frame, sourcePath: relativePath } : frame)) }
      : record,
  );
}

/**
 * Sorts a project's animations for an asset moving to another project: ones built only from that
 * asset travel with it; ones that also use other assets stay behind and lose those frames' source.
 */
export function splitForTransfer(records: AnimationRecord[], assetId: string) {
  const travelling = records.filter((record) => record.frames.length > 0 && record.frames.every((frame) => frame.assetId === assetId));
  const broken = records.filter((record) => !travelling.includes(record) && usesAsset(record, assetId));
  return { travelling, staying: records.filter((record) => !travelling.includes(record)), broken };
}
