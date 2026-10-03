import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveGameAssetsDir } from './paths.js';
import type { PixelStyle } from './pixelize.js';
import type { GameId } from './types.js';
import { createSerialQueue } from './serial.js';

export type StudioSettings = {
  globalPrompt: string;
  briefs?: Record<string, string>;
  motions?: Record<string, string>;
  /** Locked project palette; every pixel asset quantises to it so frames share colours. */
  palette?: string[];
  pixelStyle?: PixelStyle;
};

export class SettingsStore {
  private readonly serial = createSerialQueue();
  constructor(private readonly rootDir: string) {}
  private path(gameId: GameId) { return join(resolveGameAssetsDir(this.rootDir, gameId), 'manifests', 'studio-settings.json'); }
  async get(gameId: GameId): Promise<StudioSettings> {
    try { return { globalPrompt: '', ...JSON.parse(await readFile(this.path(gameId), 'utf8')) as Partial<StudioSettings> }; } catch { return { globalPrompt: '' }; }
  }
  /** Merges into the saved file, so saving the art direction never wipes the briefs (or the reverse). */
  set(gameId: GameId, patch: Partial<StudioSettings>) {
    return this.serial(() => this.setNow(gameId, patch));
  }
  private async setNow(gameId: GameId, patch: Partial<StudioSettings>) {
    const next = { ...(await this.get(gameId)), ...patch };
    const path = this.path(gameId);
    await mkdir(join(resolveGameAssetsDir(this.rootDir, gameId), 'manifests'), { recursive: true });
    const temp = `${path}.tmp`;
    await writeFile(temp, JSON.stringify(next, null, 2));
    await rename(temp, path);
    return next;
  }
}
