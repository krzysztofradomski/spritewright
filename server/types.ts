export type GameId = string;
export const ASSET_STATES = ['source', 'candidates', 'approved'] as const;
export type AssetState = (typeof ASSET_STATES)[number];

export type ImageInspection = {
  format: string;
  width: number;
  height: number;
  byteSize: number;
  hasAlpha: boolean;
  alphaCoverage: number;
  opaqueBounds: { left: number; top: number; width: number; height: number } | null;
  sha256: string;
  warnings: string[];
};

export type AssetRecord = {
  id: string;
  gameId: GameId;
  family: string;
  state: AssetState;
  filename: string;
  relativePath: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  provenance: { provider: string; model?: string; prompt?: string; referencePaths?: string[]; parentId?: string };
  tags: string[];
  inspection?: ImageInspection;
  /** Present only on native pixel art; the palette that was actually applied. */
  pixel?: { palette: string[] };
  notes?: string;
};

export type AnimationFrame = { assetId?: string; sourcePath: string; durationMs: number; hidden?: boolean; rect?: { x: number; y: number; width: number; height: number }; anchorOffset?: { x: number; y: number }; anchorScale?: number; box?: { width: number; height: number } };
export type AnimationRecord = { id: string; gameId: GameId; name: string; loop: 'loop' | 'once' | 'ping-pong'; fps: number; frames: AnimationFrame[]; source: 'sequence' | 'sheet' };
