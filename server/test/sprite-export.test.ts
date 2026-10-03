import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, test } from "vitest";
import { exportAnimation, playbackOrder, sheetLayout } from "../sprite-export.js";

test("lays frames out in a square-ish grid and plays ping-pong back and forth", () => {
  expect(sheetLayout(8)).toEqual({ columns: 3, rows: 3 });
  expect(sheetLayout(4)).toEqual({ columns: 2, rows: 2 });
  expect(playbackOrder(3, "ping-pong")).toEqual([0, 1, 2, 1, 0]);
  expect(playbackOrder(3, "loop")).toEqual([0, 1, 2]);
});

test("exports an even sheet, a hash atlas and an animated preview from uneven cells", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asset-studio-export-"));
  try {
    // Three 8x8 squares in cells of different sizes, like a poorly generated sprite map. Each has
    // its own colour: WebP merges identical consecutive frames, which would hide the page count.
    const width = 60;
    const height = 20;
    const data = Buffer.alloc(width * height * 4);
    for (const [x0, y0, red] of [[2, 2, 255], [26, 8, 160], [48, 4, 90]] as const)
      for (let y = y0; y < y0 + 8; y++) for (let x = x0; x < x0 + 8; x++) data.set([red, 40, 40, 255], (y * width + x) * 4);
    const source = join(directory, "sheet.png");
    await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(source);
    const box = { width: 12, height: 12 };
    const frame = (rect: { x: number; y: number; width: number; height: number }, offset: { x: number; y: number }) =>
      ({ sourcePath: "sheet.png", durationMs: 0, rect, anchorOffset: offset, anchorScale: 1, box });
    const files = await exportAnimation(
      {
        id: "a1", gameId: "pocket-river", name: "hop", loop: "ping-pong", fps: 10, source: "sheet",
        frames: [frame({ x: 0, y: 0, width: 20, height: 20 }, { x: 0, y: 0 }), frame({ x: 20, y: 0, width: 24, height: 20 }, { x: -4, y: -6 }), frame({ x: 44, y: 0, width: 16, height: 20 }, { x: -2, y: -2 })],
      },
      () => source,
      join(directory, "out"),
    );
    expect(files.map((file) => file.filename)).toEqual(["hop.png", "hop.json", "hop.webp"]);
    const atlas = JSON.parse(await readFile(join(directory, "out", "hop.json"), "utf8"));
    const { w: cellW, h: cellH } = atlas.frames["hop-000"].frame;
    expect(atlas.meta.grid).toMatchObject({ columns: 2, rows: 2, padding: 2 });
    expect(atlas.frames["hop-001"].frame).toMatchObject({ x: cellW + 2, y: 0, w: cellW, h: cellH });
    expect(atlas.frames["hop-000"].duration).toBe(100);
    expect(atlas.animations.hop).toEqual(["hop-000", "hop-001", "hop-002", "hop-001", "hop-000"]);
    const sheet = await sharp(join(directory, "out", "hop.png")).metadata();
    expect([sheet.width, sheet.height]).toEqual([atlas.meta.size.w, atlas.meta.size.h]);
    const preview = await sharp(join(directory, "out", "hop.webp"), { animated: true }).metadata();
    expect(preview.pages).toBe(5);
    expect(preview.loop).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("exporting at a scale enlarges the sheet in whole pixels and keeps the atlas in step", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asset-studio-export-scale-"));
  try {
    // Two 4x4 blocks on a tiny sheet: native pixel art sizes, where smoothing would be obvious.
    const width = 16;
    const height = 8;
    const data = Buffer.alloc(width * height * 4);
    for (const [x0, red] of [[1, 255], [9, 120]] as const)
      for (let y = 2; y < 6; y++) for (let x = x0; x < x0 + 4; x++) data.set([red, 40, 40, 255], (y * width + x) * 4);
    const source = join(directory, "sheet.png");
    await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(source);
    const box = { width: 8, height: 8 };
    const frame = (x: number) =>
      ({ sourcePath: "sheet.png", durationMs: 0, rect: { x, y: 0, width: 8, height: 8 }, anchorOffset: { x: 0, y: 0 }, anchorScale: 1, box });
    const record = {
      id: "a2", gameId: "pocket-river", name: "blink", loop: "loop" as const, fps: 10, source: "sheet" as const,
      frames: [frame(0), frame(8)],
    };

    await exportAnimation(record, () => source, join(directory, "one"));
    await exportAnimation(record, () => source, join(directory, "four"), { scale: 4 });

    const one = await sharp(join(directory, "one", "blink.png")).metadata();
    const four = await sharp(join(directory, "four", "blink.png")).metadata();
    expect(four.width).toBe(one.width! * 4);
    expect(four.height).toBe(one.height! * 4);

    // The atlas must describe the image it ships with, so its coordinates scale too.
    const plainAtlas = JSON.parse(await readFile(join(directory, "one", "blink.json"), "utf8"));
    const scaledAtlas = JSON.parse(await readFile(join(directory, "four", "blink.json"), "utf8"));
    expect(scaledAtlas.frames["blink-000"].frame.w).toBe(plainAtlas.frames["blink-000"].frame.w * 4);
    expect(scaledAtlas.frames["blink-001"].frame.x).toBe(plainAtlas.frames["blink-001"].frame.x * 4);
    expect(scaledAtlas.meta.size.w).toBe(four.width);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a fractional export scale is refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asset-studio-export-bad-"));
  try {
    const source = join(directory, "sheet.png");
    await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } } }).png().toFile(source);
    // Two frames: a single-frame animation cannot build the animated preview at all,
    // which would mask the scale check behind an unrelated error.
    const cell = { sourcePath: "sheet.png", durationMs: 0, rect: { x: 0, y: 0, width: 8, height: 8 }, anchorOffset: { x: 0, y: 0 }, anchorScale: 1, box: { width: 8, height: 8 } };
    const record = {
      id: "a3", gameId: "pocket-river", name: "one", loop: "loop" as const, fps: 10, source: "sheet" as const,
      frames: [cell, { ...cell }],
    };
    await expect(exportAnimation(record, () => source, join(directory, "out"), { scale: 1.5 })).rejects.toThrow(/whole number/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
