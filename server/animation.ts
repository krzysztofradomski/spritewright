import type { AnimationFrame, AnimationRecord } from './types.js';
import sharp from 'sharp';
import { stat } from 'node:fs/promises';
import type { GridLayout } from '../src/sprite-layout.js';

export { requestedGridLayout, type GridLayout } from '../src/sprite-layout.js';

export type SpriteGrid = { frameWidth: number; frameHeight: number; columns: number; rows: number; spacing: number; margin: number };
export type DetectedSpriteGrid = {
  width: number;
  height: number;
  /** Horizontal cuts shared by the whole sheet. */
  yCuts: number[];
  /** Vertical cuts per row: generated sheets rarely line their columns up across rows. */
  xCuts: number[][];
  confidence: 'high' | 'medium' | 'low';
  reason?: string;
};
export type AnchorMode = 'subject' | 'base';
export type SpriteRect = { x: number; y: number; width: number; height: number };
export type FrameBox = { width: number; height: number };
export type FrameAnchorResult = { offsets: Array<{ x: number; y: number }>; scales: number[]; box: FrameBox };

type Sheet = { data: Buffer; width: number; height: number; content: Uint8Array };
let cachedSheet: { key: string; sheet: Sheet } | null = null;

/**
 * Decodes a sprite map and marks which pixels belong to a sprite. Transparent pixels never
 * do. Generators also often leave a flat opaque backdrop behind (a white or black slab
 * the matte step never removed), and treating it as sprite makes every cell look full.
 * So a flat colour that dominates the outer edge of the opaque area is flood-filled from
 * that edge and marked empty. Filling from the edge keeps same-coloured detail inside a
 * sprite. A fill is ignored when it covers under a quarter of the sheet (a pixel-art
 * outline) or leaves no sprite behind (a flat-coloured sprite on a transparent sheet).
 */
async function loadSheet(filePath: string): Promise<Sheet> {
  const { mtimeMs } = await stat(filePath);
  const key = `${filePath}:${mtimeMs}`;
  // ponytail: one cached sheet — the lab works on one map at a time; use an LRU if that changes.
  if (cachedSheet?.key === key) return cachedSheet.sheet;
  const raw = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = raw.info;
  if (!width || !height) throw new Error('The sprite map has no readable dimensions.');
  const data = channels === 4 ? raw.data : Buffer.from(raw.data);
  const total = width * height;
  const content = new Uint8Array(total);
  for (let i = 0; i < total; i++) content[i] = data[i * 4 + 3]! > 12 ? 1 : 0;
  const onEdge = (i: number) => {
    const x = i % width; const y = (i - x) / width;
    return x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
      !content[i - 1] || !content[i + 1] || !content[i - width] || !content[i + width];
  };
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  let edges = 0;
  for (let i = 0; i < total; i++) {
    if (!content[i] || !onEdge(i)) continue;
    edges++;
    const r = data[i * 4]!; const g = data[i * 4 + 1]!; const b = data[i * 4 + 2]!;
    const bucket = buckets.get((r >> 4) << 8 | (g >> 4) << 4 | (b >> 4)) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count++; bucket.r += r; bucket.g += g; bucket.b += b;
    buckets.set((r >> 4) << 8 | (g >> 4) << 4 | (b >> 4), bucket);
  }
  const top = [...buckets.values()].sort((first, second) => second.count - first.count)[0];
  // A slab backdrop is what makes a sheet look full, so it leaves almost no transparency. A sheet
  // that is already largely transparent has nothing to strip, and running the fill on one is
  // actively harmful: on pixel art every outline pixel touches transparency, so the fill starts
  // along the whole silhouette and bleeds through any palette colour within tolerance of the
  // outline — eating the surcoat, belt and legs with it.
  const opaqueShare = content.reduce((count: number, value) => count + value, 0) / total;
  if (opaqueShare >= 0.85 && top && top.count >= edges * 0.5) {
    const backdrop = [top.r / top.count, top.g / top.count, top.b / top.count];
    // 18% of the RGB diagonal: wide enough for anti-aliased fringe, narrow enough to stop at the art.
    const tolerance = (0.18 * Math.sqrt(3) * 255) ** 2;
    const matches = (i: number) =>
      (data[i * 4]! - backdrop[0]!) ** 2 + (data[i * 4 + 1]! - backdrop[1]!) ** 2 + (data[i * 4 + 2]! - backdrop[2]!) ** 2 <= tolerance;
    const filled = new Uint8Array(total);
    const queue = new Int32Array(total);
    let head = 0; let tail = 0;
    for (let i = 0; i < total; i++) if (content[i] && onEdge(i) && matches(i)) { filled[i] = 1; queue[tail++] = i; }
    while (head < tail) {
      const i = queue[head++]!; const x = i % width;
      for (const next of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width]) {
        if (next < 0 || next >= total || filled[next] || !content[next] || !matches(next)) continue;
        filled[next] = 1; queue[tail++] = next;
      }
    }
    // A real backdrop surrounds sprites that survive its removal. Filling a flat-coloured
    // sprite on a transparent sheet instead leaves almost nothing, so that fill is dropped.
    // ponytail: area thresholds; a sheet of tiny sprites under 1% coverage would be missed.
    let remaining = 0;
    for (let i = 0; i < total; i++) if (content[i] && !filled[i]) remaining++;
    if (tail >= total * 0.25 && remaining >= total * 0.01) for (let i = 0; i < total; i++) if (filled[i]) content[i] = 0;
  }
  const sheet = { data, width, height, content };
  cachedSheet = { key, sheet };
  return sheet;
}

/**
 * Aligns frames on a shared anchor and reports one frame box that fits them all.
 * Sprite maps generated by an image model rarely have even gutters, so cells come
 * out different sizes with the subject sitting anywhere inside them. The anchor is
 * the alpha centroid, not the alpha bounding box: a walk cycle's lowest pixel is a
 * lifting foot and its widest pixel is a swinging leg, so bbox anchoring makes the
 * body bob. This only returns preview placement; it never rewrites the source image.
 *
 * `base` pins where a rooted subject meets the ground instead: the centre of the bottom
 * tenth of its silhouette, on its lowest row. A swaying plant's centroid follows its tips,
 * so centroid locking would cancel the sway; its base is the one part that must not move.
 */
export async function detectFrameAnchors(filePath: string, rects: SpriteRect[], mode: AnchorMode = 'subject'): Promise<FrameAnchorResult> {
  const { width, content } = await loadSheet(filePath);
  const anchors = rects.map((rect) => {
    let left = rect.width; let top = rect.height; let right = 0; let bottom = 0;
    let sumX = 0; let sumY = 0; let count = 0;
    const rowSumX = new Float64Array(rect.height); const rowCount = new Uint32Array(rect.height);
    for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
      if (content[y * width + x]) {
        const localX = x - rect.x; const localY = y - rect.y;
        left = Math.min(left, localX); top = Math.min(top, localY);
        right = Math.max(right, localX + 1); bottom = Math.max(bottom, localY + 1);
        sumX += localX + 0.5; sumY += localY + 0.5; count++;
        rowSumX[localY]! += localX + 0.5; rowCount[localY]!++;
      }
    }
    if (!count) return null;
    if (mode === 'subject') return { x: sumX / count, y: sumY / count, left, top, right, bottom, count };
    let baseSum = 0; let baseCount = 0;
    for (let row = Math.max(top, bottom - Math.max(2, Math.round((bottom - top) * 0.1))); row < bottom; row++) {
      baseSum += rowSumX[row]!; baseCount += rowCount[row]!;
    }
    return { x: baseSum / baseCount, y: bottom, left, top, right, bottom, count };
  });
  type Anchor = NonNullable<(typeof anchors)[number]>;
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  };
  const visible = anchors.filter((anchor): anchor is Anchor => Boolean(anchor));
  const widest = Math.max(...rects.map((rect) => rect.width));
  const tallest = Math.max(...rects.map((rect) => rect.height));
  if (!visible.length) return { offsets: rects.map(() => ({ x: 0, y: 0 })), scales: rects.map(() => 1), box: { width: widest, height: tallest } };
  // Covered area is a far steadier size cue than bounding-box height, which grows and
  // shrinks with the pose. A conservative clamp removes generator drift without
  // flattening an intentional pose change.
  const targetCount = median(visible.map((anchor) => anchor.count));
  const scales = anchors.map((anchor) => anchor ? Math.round(Math.max(0.8, Math.min(1.25, Math.sqrt(targetCount / anchor.count))) * 1000) / 1000 : 1);
  // One box that fits every frame's art around the shared anchor, so uneven cells stop
  // changing the preview's size and letterboxing between frames.
  const reach = (measure: (anchor: Anchor) => number) =>
    Math.ceil(Math.max(0, ...anchors.map((anchor, index) => anchor ? measure(anchor) * scales[index]! : 0)));
  // One pixel of slack on each side, so rounding an offset can never shave an edge column.
  const target = { x: reach((anchor) => anchor.x - anchor.left) + 1, y: reach((anchor) => anchor.y - anchor.top) + 1 };
  const box = {
    width: target.x + reach((anchor) => anchor.right - anchor.x) + 1,
    height: target.y + reach((anchor) => anchor.bottom - anchor.y) + 1,
  };
  return {
    box,
    scales,
    offsets: anchors.map((anchor, index) => anchor
      ? { x: Math.round(target.x - anchor.x * scales[index]!), y: Math.round(target.y - anchor.y * scales[index]!) }
      : { x: Math.round((box.width - rects[index]!.width) / 2), y: Math.round((box.height - rects[index]!.height) / 2) }),
  };
}

/** Produces an isolated frame on the shared frame box, without sampling adjacent cells. */
export async function renderSpriteFrame(
  filePath: string,
  rect: SpriteRect,
  offset: { x: number; y: number } = { x: 0, y: 0 },
  scale = 1,
  box: FrameBox = { width: rect.width, height: rect.height },
) {
  const left = Math.max(0, offset.x);
  const top = Math.max(0, offset.y);
  const cropLeft = Math.max(0, -offset.x);
  const cropTop = Math.max(0, -offset.y);
  const sheet = await loadSheet(filePath);
  const cell = Buffer.alloc(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
    const source = (rect.y + y) * sheet.width + rect.x + x;
    if (!sheet.content[source]) continue;
    sheet.data.copy(cell, (y * rect.width + x) * 4, source * 4, source * 4 + 4);
  }
  const isolated = await sharp(cell, { raw: { width: rect.width, height: rect.height, channels: 4 } }).png().toBuffer();
  const scaled = scale === 1
    ? isolated
    : await sharp(isolated).resize({ width: Math.round(rect.width * scale), height: Math.round(rect.height * scale), fit: 'fill' }).png().toBuffer();
  const scaledMetadata = await sharp(scaled).metadata();
  const scaledWidth = scaledMetadata.width ?? rect.width;
  const scaledHeight = scaledMetadata.height ?? rect.height;
  const right = Math.max(0, cropLeft + box.width - (left + scaledWidth));
  const bottom = Math.max(0, cropTop + box.height - (top + scaledHeight));
  const padded = await sharp(scaled)
    .extend({
      top,
      bottom,
      left,
      right,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  return sharp(padded)
    .extract({ left: cropLeft, top: cropTop, width: box.width, height: box.height })
    .png()
    .toBuffer();
}

/**
 * Finds the frame grid without using a model. Rows are found first; then each row gets
 * its own column cuts, because a generated sheet's second row is rarely aligned with its
 * first. A cut goes in the emptiest valley near where an even split would put it, so a
 * sheet whose sprites touch or drift still gets usable cells; clean transparent gutters
 * are simply the deepest valleys. The count per axis comes from the requested layout
 * when there is one, otherwise from the number of clean gutters.
 */
export async function detectSpriteGrid(filePath: string, requested?: GridLayout | null): Promise<DetectedSpriteGrid> {
  const { width, height, content } = await loadSheet(filePath);
  const projection = (axis: 'x' | 'y', top = 0, bottom = height) => {
    const counts = new Float64Array(axis === 'x' ? width : height);
    for (let y = top; y < bottom; y++) for (let x = 0; x < width; x++) if (content[y * width + x]) counts[axis === 'x' ? x : y]!++;
    return counts;
  };
  const rowProjection = projection('y');
  const rows = requested?.rows ?? cleanGutters(rowProjection, width) + 1;
  const yCuts = valleyCuts(rowProjection, rows);
  let crossings = rows > 1 ? countCrossings(rowProjection, yCuts, width) : 0;
  const xCuts = yCuts.slice(0, -1).map((top, row) => {
    const columnProjection = projection('x', top, yCuts[row + 1]);
    const crossAxis = yCuts[row + 1]! - top;
    const cuts = valleyCuts(columnProjection, requested?.columns ?? cleanGutters(columnProjection, crossAxis) + 1);
    crossings += countCrossings(columnProjection, cuts, crossAxis);
    return cuts;
  });
  const cells = xCuts.reduce((sum, cuts) => sum + cuts.length - 1, 0);
  const notes = [
    requested && `${requested.columns}×${requested.rows} layout from the generation prompt`,
    crossings && `${crossings} cut${crossings === 1 ? '' : 's'} cross a sprite — check those guides`,
  ].filter(Boolean);
  return {
    width,
    height,
    yCuts,
    xCuts,
    confidence: cells < 2 ? 'low' : crossings ? 'medium' : 'high',
    ...(notes.length ? { reason: notes.join(' · ') } : {}),
  };
}

const quietLevel = (crossAxis: number) => Math.max(1, crossAxis * 0.012);

/** Interior runs of near-empty lines wide enough to be a deliberate gutter. */
function cleanGutters(projection: Float64Array, crossAxis: number) {
  const minimum = Math.max(2, Math.round(projection.length * 0.006));
  let gutters = 0; let run = 0;
  for (let index = 0; index < projection.length; index++) {
    if (projection[index]! <= quietLevel(crossAxis)) { run++; continue; }
    if (run >= minimum && index - run > 0) gutters++;
    run = 0;
  }
  return gutters;
}

function countCrossings(projection: Float64Array, cuts: number[], crossAxis: number) {
  return cuts.slice(1, -1).filter((cut) => projection[cut]! > quietLevel(crossAxis)).length;
}

/**
 * Splits an axis into `count` spans with each cut at the emptiest point of its own window
 * around the even position. Positions are spread over the sprites' extent, not the whole
 * sheet, so an off-centre block of frames with wide empty margins still splits evenly.
 */
export function valleyCuts(projection: ArrayLike<number>, count: number) {
  const length = projection.length;
  let first = 0; while (first < length && !projection[first]) first++;
  let last = length - 1; while (last > first && !projection[last]) last--;
  if (first >= length) { first = 0; last = length - 1; }
  const span = last + 1 - first;
  const radius = Math.max(1, Math.round(length * 0.004));
  const prefix = new Float64Array(length + 1);
  for (let index = 0; index < length; index++) prefix[index + 1] = prefix[index]! + projection[index]!;
  const smoothed = (index: number) => prefix[Math.min(length, index + radius + 1)]! - prefix[Math.max(0, index - radius)]!;
  const cuts = [0];
  for (let step = 1; step < count; step++) {
    const even = first + (step * span) / count;
    const half = span / (2 * count);
    let best = Math.round(even);
    for (let index = Math.max(cuts.at(-1)! + 1, Math.ceil(even - half)); index <= Math.min(length - 1, Math.floor(even + half)); index++) {
      const score = smoothed(index); const bestScore = smoothed(best);
      if (score < bestScore || (score === bestScore && Math.abs(index - even) < Math.abs(best - even))) best = index;
    }
    cuts.push(Math.max(cuts.at(-1)! + 1, best));
  }
  cuts.push(length);
  return cuts;
}

export function buildGridFrames(grid: SpriteGrid) {
  return Array.from({ length: grid.columns * grid.rows }, (_, index) => {
    const column = index % grid.columns;
    const row = Math.floor(index / grid.columns);
    return {
      x: grid.margin + column * (grid.frameWidth + grid.spacing),
      y: grid.margin + row * (grid.frameHeight + grid.spacing),
      width: grid.frameWidth,
      height: grid.frameHeight,
    };
  });
}

export function validateSpriteGrid(grid: SpriteGrid, image: { width: number; height: number }) {
  if ([grid.frameWidth, grid.frameHeight, grid.columns, grid.rows].some((value) => !Number.isInteger(value) || value <= 0) || grid.spacing < 0 || grid.margin < 0) {
    throw new Error('Sprite grid values must be positive integers (spacing and margin may be zero).');
  }
  const width = grid.margin * 2 + grid.columns * grid.frameWidth + (grid.columns - 1) * grid.spacing;
  const height = grid.margin * 2 + grid.rows * grid.frameHeight + (grid.rows - 1) * grid.spacing;
  if (width > image.width || height > image.height) throw new Error('Sprite grid extends outside the image.');
}

export function normalizeTimeline(frames: AnimationFrame[], loop: AnimationRecord['loop'], fps: number): AnimationFrame[] {
  const duration = Math.max(1, Math.round(1000 / Math.max(1, fps)));
  const visible = frames.filter((frame) => !frame.hidden).map((frame) => ({ ...frame, durationMs: frame.durationMs > 0 ? frame.durationMs : duration }));
  if (loop !== 'ping-pong' || visible.length < 2) return visible;
  return [...visible, ...visible.slice(0, -1).reverse()];
}
