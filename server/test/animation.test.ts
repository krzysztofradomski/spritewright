import { expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { buildGridFrames, detectFrameAnchors, detectSpriteGrid, normalizeTimeline, renderSpriteFrame, requestedGridLayout, validateSpriteGrid } from '../animation.js';

test('turns a uniform sprite grid into non-overlapping frames', () => {
  expect(buildGridFrames({ frameWidth: 16, frameHeight: 16, columns: 4, rows: 2, spacing: 0, margin: 0 })).toHaveLength(8);
  expect(buildGridFrames({ frameWidth: 16, frameHeight: 16, columns: 4, rows: 2, spacing: 0, margin: 0 })[7]).toEqual({ x: 48, y: 16, width: 16, height: 16 });
  expect(() => validateSpriteGrid({ frameWidth: 16, frameHeight: 16, columns: 4, rows: 2, spacing: 0, margin: 0 }, { width: 63, height: 32 })).toThrow('outside');
});

test('normalizes a ping-pong timeline without changing source frames', () => {
  const frames = [{ sourcePath: 'a.png', durationMs: 0 }, { sourcePath: 'b.png', durationMs: 50 }, { sourcePath: 'c.png', durationMs: 100, hidden: true }];
  expect(normalizeTimeline(frames, 'ping-pong', 12).map((frame) => frame.sourcePath)).toEqual(['a.png', 'b.png', 'a.png']);
  expect(frames).toHaveLength(3);
});

test('detects transparent gutters as editable sprite-map guides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asset-studio-grid-'));
  const image = join(directory, 'sheet.png');
  const data = Buffer.alloc(80 * 40 * 4);
  for (const originX of [4, 44]) for (const originY of [2, 22]) {
    for (let y = originY; y < originY + 16; y++) for (let x = originX; x < originX + 32; x++) data[(y * 80 + x) * 4 + 3] = 255;
  }
  await sharp(data, { raw: { width: 80, height: 40, channels: 4 } }).png().toFile(image);
  const detected = await detectSpriteGrid(image);
  expect(detected.xCuts.every((row) => row.includes(40))).toBe(true);
  expect(detected.yCuts).toContain(20);
  await rm(directory, { recursive: true, force: true });
});

test('keeps a pixel-art sprite its palette instead of flood-filling from the outline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asset-studio-pixel-'));
  const image = join(directory, 'sheet.png');
  // A transparent sheet holding one sprite drawn in a dark, tightly clustered pixel-art palette:
  // an outline (#1a1b26) wrapped around a surcoat green (#284835) that sits inside the backdrop
  // tolerance of it, plus a lighter helm grey that does not. The outline touches transparency all
  // the way round, so backdrop removal starts along the whole silhouette and, unless it is skipped
  // on a sheet this transparent, floods through the green as well — big enough to clear the
  // quarter-of-the-sheet guard while the helm grey survives to clear the "leaves a sprite" guard.
  const [W, H] = [64, 64];
  const data = Buffer.alloc(W * H * 4);
  const paint = (x: number, y: number, [r, g, b]: number[]) => {
    const i = (y * W + x) * 4;
    data[i] = r!; data[i + 1] = g!; data[i + 2] = b!; data[i + 3] = 255;
  };
  for (let y = 16; y < 48; y++) for (let x = 12; x < 52; x++) paint(x, y, [0x1a, 0x1b, 0x26]);
  for (let y = 24; y < 40; y++) for (let x = 20; x < 40; x++) paint(x, y, [0x28, 0x48, 0x35]);
  for (let y = 20; y < 28; y++) for (let x = 44; x < 50; x++) paint(x, y, [0x73, 0x82, 0x94]);
  await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toFile(image);
  const frame = await renderSpriteFrame(image, { x: 20, y: 24, width: 20, height: 16 });
  const { data: out } = await sharp(frame).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const centre = (8 * 20 + 10) * 4;
  expect([out[centre], out[centre + 1], out[centre + 2], out[centre + 3]]).toEqual([0x28, 0x48, 0x35, 255]);
  await rm(directory, { recursive: true, force: true });
});

test('aligns uneven cells on a shared centroid and one frame box', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asset-studio-anchor-'));
  const image = join(directory, 'sheet.png');
  // Two cells of different widths (24 and 16), each holding the same 8x12 subject at a
  // different position — the shape a poorly generated sprite map takes.
  const data = Buffer.alloc(40 * 20 * 4);
  for (let y = 4; y < 16; y++) for (let x = 4; x < 12; x++) data[(y * 40 + x) * 4 + 3] = 255;
  for (let y = 2; y < 14; y++) for (let x = 26; x < 34; x++) data[(y * 40 + x) * 4 + 3] = 255;
  await sharp(data, { raw: { width: 40, height: 20, channels: 4 } }).png().toFile(image);
  const rects = [
    { x: 0, y: 0, width: 24, height: 20 },
    { x: 24, y: 0, width: 16, height: 20 },
  ];
  const result = await detectFrameAnchors(image, rects);
  // The box hugs the art, so both frames render at the same size instead of their cells'.
  expect(result.box).toEqual({ width: 10, height: 14 });
  expect(result.scales).toEqual([1, 1]);
  // Each subject lands on the same pixel of that box.
  const rendered = await Promise.all(rects.map((rect, index) =>
    renderSpriteFrame(image, rect, result.offsets[index], result.scales[index], result.box)));
  const [first, second] = await Promise.all(rendered.map((frame) => sharp(frame).raw().toBuffer()));
  expect(Buffer.compare(first!, second!)).toBe(0);
  await rm(directory, { recursive: true, force: true });
});

test('anchors on covered area, so a lifted foot does not bob the body', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asset-studio-bob-'));
  const image = join(directory, 'sheet.png');
  // Identical bodies; the second frame lifts a one-pixel-wide leg by 4px. Bounding-box
  // anchoring would shift the whole body to match the foot.
  const data = Buffer.alloc(40 * 20 * 4);
  for (const originX of [4, 24]) {
    for (let y = 2; y < 12; y++) for (let x = originX; x < originX + 10; x++) data[(y * 40 + x) * 4 + 3] = 255;
  }
  for (let y = 12; y < 18; y++) data[(y * 40 + 8) * 4 + 3] = 255;
  for (let y = 12; y < 14; y++) data[(y * 40 + 28) * 4 + 3] = 255;
  await sharp(data, { raw: { width: 40, height: 20, channels: 4 } }).png().toFile(image);
  const result = await detectFrameAnchors(image, [
    { x: 0, y: 0, width: 20, height: 20 },
    { x: 20, y: 0, width: 20, height: 20 },
  ]);
  expect(Math.abs(result.offsets[0]!.y - result.offsets[1]!.y)).toBeLessThanOrEqual(1);
  expect(result.scales.every((scale) => Math.abs(scale - 1) < 0.05)).toBe(true);
  await rm(directory, { recursive: true, force: true });
});

test('renders an aligned frame without leaking pixels from neighbouring cells', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asset-studio-preview-'));
  const image = join(directory, 'sheet.png');
  const data = Buffer.alloc(20 * 10 * 4);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) { data[(y * 20 + x) * 4] = 255; data[(y * 20 + x) * 4 + 3] = 255; }
  for (let y = 0; y < 10; y++) for (let x = 10; x < 20; x++) { data[(y * 20 + x) * 4 + 1] = 255; data[(y * 20 + x) * 4 + 3] = 255; }
  await sharp(data, { raw: { width: 20, height: 10, channels: 4 } }).png().toFile(image);
  const output = await renderSpriteFrame(image, { x: 10, y: 0, width: 10, height: 10 }, { x: 3, y: 0 });
  const pixels = await sharp(output).raw().toBuffer();
  expect(pixels[0]).toBe(0);
  expect(pixels[1]).toBe(0);
  expect(pixels[3]).toBe(0);
  await rm(directory, { recursive: true, force: true });
});

test('reads the requested layout from the studio draft prompt, or infers square cells from a count', async () => {
  const { animationDraft } = await import('../../src/animation-draft.js');
  const draft = animationDraft({ filename: 'duck.png', family: 'animals', relativePath: 'a/duck.png' });
  expect(requestedGridLayout(draft.prompt, draft.width, draft.height)).toEqual({ columns: 4, rows: 4 });
  // A model asked for one row of 8 on a square-ish canvas still returns a grid.
  expect(requestedGridLayout('exactly 8 frames', 1024, 512)).toEqual({ columns: 4, rows: 2 });
  expect(requestedGridLayout('a duck walking', 1024, 512)).toBeNull();
});

test('falls back to the requested layout when an opaque sheet has no gutters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asset-studio-opaque-'));
  const image = join(directory, 'sheet.png');
  await sharp({ create: { width: 80, height: 40, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toFile(image);
  expect((await detectSpriteGrid(image)).xCuts).toEqual([[0, 80]]);
  const detected = await detectSpriteGrid(image, { columns: 4, rows: 2 });
  expect(detected.xCuts).toEqual([[0, 20, 40, 60, 80], [0, 20, 40, 60, 80]]);
  expect(detected.yCuts).toEqual([0, 20, 40]);
  expect(detected.reason).toContain('4×2');
  await rm(directory, { recursive: true, force: true });
});

test('pin-base mode keeps a sway that centroid locking would cancel', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asset-studio-sway-'));
  const image = join(directory, 'sheet.png');
  // The same 4px-wide stem rooted at x 8..12, bent 6px right at the top in the second cell.
  const data = Buffer.alloc(40 * 20 * 4);
  for (let y = 2; y < 18; y++) for (let x = 8; x < 12; x++) data[(y * 40 + x) * 4 + 3] = 255;
  for (let y = 2; y < 18; y++) for (let x = 28; x < 32; x++) data[(y * 40 + x + (y < 10 ? 6 : 0)) * 4 + 3] = 255;
  await sharp(data, { raw: { width: 40, height: 20, channels: 4 } }).png().toFile(image);
  const rects = [{ x: 0, y: 0, width: 20, height: 20 }, { x: 20, y: 0, width: 20, height: 20 }];
  const frames = async (mode: 'subject' | 'base') => {
    const result = await detectFrameAnchors(image, rects, mode);
    return Promise.all(rects.map(async (rect, index) =>
      sharp(await renderSpriteFrame(image, rect, result.offsets[index], result.scales[index], result.box)).raw().toBuffer({ resolveWithObject: true })));
  };
  // Column of the stem on the bottom row of each rendered frame.
  const rootColumn = ({ data: pixels, info }: { data: Buffer; info: sharp.OutputInfo }) => {
    const y = [...Array(info.height).keys()].reverse().find((row) => [...Array(info.width).keys()].some((x) => pixels[(row * info.width + x) * 4 + 3]! > 0))!;
    return [...Array(info.width).keys()].find((x) => pixels[(y * info.width + x) * 4 + 3]! > 0);
  };
  const pinned = await frames('base');
  expect(rootColumn(pinned[0]!)).toBe(rootColumn(pinned[1]!));
  const locked = await frames('subject');
  expect(rootColumn(locked[0]!)).not.toBe(rootColumn(locked[1]!));
  await rm(directory, { recursive: true, force: true });
});

test('ignores a leftover opaque backdrop and cuts each row around its own sprites', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asset-studio-backdrop-'));
  const image = join(directory, 'sheet.png');
  // A white slab with transparent margins, like a sheet whose matte was never removed.
  // Row one's 8px sprites sit at x 12/52; row two's drift right to x 28/66, so no single
  // set of column cuts fits both rows.
  const width = 100; const height = 40;
  const data = Buffer.alloc(width * height * 4);
  const paint = (x0: number, y0: number, w: number, h: number, rgb: number[]) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) data.set([...rgb, 255], (y * width + x) * 4);
  };
  paint(6, 0, 88, 40, [255, 255, 255]);
  for (const x of [12, 52]) paint(x, 6, 8, 8, [40, 90, 60]);
  for (const x of [28, 66]) paint(x, 26, 8, 8, [40, 90, 60]);
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(image);
  const grid = await detectSpriteGrid(image, { columns: 2, rows: 2 });
  expect(grid.confidence).toBe('high');
  const [first, second] = grid.xCuts as [number[], number[]];
  expect(first[1]).toBeGreaterThan(20);
  expect(first[1]).toBeLessThanOrEqual(52);
  expect(second[1]).toBeGreaterThan(36);
  expect(second[1]).toBeLessThanOrEqual(66);
  expect(first[1]).not.toBe(second[1]);
  // The rendered frame drops the white slab but keeps the sprite.
  const frame = await sharp(await renderSpriteFrame(image, { x: 0, y: 0, width: first[1]!, height: grid.yCuts[1]! })).raw().toBuffer();
  const opaque = [...Array(frame.length / 4).keys()].filter((i) => frame[i * 4 + 3]! > 0).length;
  expect(opaque).toBe(64);
  await rm(directory, { recursive: true, force: true });
});
