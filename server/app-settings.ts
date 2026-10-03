import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createSerialQueue } from "./serial.js";

/** Machine-wide settings, as opposed to the per-game studio settings. */
export type AppSettings = {
  /** The single limit from before limits were per provider; still read as OpenRouter's. */
  openRouterDailyLimitUsd?: number;
  dailyLimitsUsd?: Record<string, number>;
  textModel?: { provider: string; model: string };
  /** The model that draws pixel art as SVG; separate so prompt help can stay on a cheap model. */
  pixelModel?: { provider: string; model: string };
  /**
   * Largest pixel grid each model has actually finished, keyed "provider:model". Learned by
   * backing off when a drawing comes back truncated, so a model gets asked for the detail it can
   * deliver rather than a number guessed for it.
   */
  pixelGrids?: Record<string, number>;
  /** Image model per paid provider; a missing entry uses that provider's default. */
  imageModels?: Partial<Record<string, string>>;
  /** Side of one ComfyUI frame in pixels; missing means the default (256). */
  comfyuiFrameSize?: number;
  /** Configured animation motions mapping motion identifier to key pose description. */
  motions?: Record<string, string>;
};


const settingsPath = (rootDir: string) => join(rootDir, "data/app-settings.json");
const serial = createSerialQueue();

export async function readAppSettings(rootDir: string): Promise<AppSettings> {
  try {
    return JSON.parse(await readFile(settingsPath(rootDir), "utf8")) as AppSettings;
  } catch {
    return {};
  }
}

/** Merges into the saved file, so saving one setting never wipes another. */
export function updateAppSettings(rootDir: string, patch: Partial<AppSettings>) {
  return serial(async () => {
    const path = settingsPath(rootDir);
    const next = { ...(await readAppSettings(rootDir)), ...patch };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, JSON.stringify(next, null, 2));
    await rename(`${path}.tmp`, path);
    return next;
  });
}
