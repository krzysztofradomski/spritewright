import { fillBrief, type BriefTemplates } from "./brief-templates.js";
import { requestedGridLayout } from "./sprite-layout.js";

export function variationDraft(asset: {
  filename: string;
  family: string;
  relativePath: string;
  tags?: string[];
  inspection?: { width: number; height: number };
  provenance?: { prompt?: string };
}, briefs?: BriefTemplates) {
  const width = asset.inspection?.width ?? 1024;
  const height = asset.inspection?.height ?? 1024;
  const isSpriteMap = asset.tags?.includes("animation-spritemap") ?? false;
  const layout = isSpriteMap ? requestedGridLayout(asset.provenance?.prompt, width, height) : null;
  return {
    name: `${asset.filename.replace(/\.[^.]+$/, "")}-variation`,
    family: asset.family,
    references: [asset.relativePath],
    // Same canvas as the source, clamped to what the generator accepts.
    width: Math.max(256, Math.min(2048, width)),
    height: Math.max(256, Math.min(2048, height)),
    tags: isSpriteMap ? ["animation-spritemap"] : [],
    // An unknown layout falls back to the studio's own 4×2 sheet, which Animate produces.
    brief: isSpriteMap
      ? fillBrief("spriteMapVariation", briefs, { columns: layout?.columns ?? 4, rows: layout?.rows ?? 2, width, height })
      : fillBrief("variation", briefs, {}),
  };
}
