import { expect, test } from "vitest";
import sharp from "sharp";
import {
  DEFAULT_PIXEL_STYLE, derivePalette, hardenAlpha, hexToRgb, nearestIndex, oklab,
  outline, pixelize, quantise, removeOrphans, rgbToHex, type Raw,
} from "../pixelize.js";

test("converts between hex and rgb", () => {
  expect(hexToRgb("#ff8000")).toEqual([255, 128, 0]);
  expect(rgbToHex(255, 128, 0)).toBe("#ff8000");
  expect(rgbToHex(0, 0, 0)).toBe("#000000");
});

// Raw-RGB distance famously confuses saturated navy with dark brown, because it
// weighs the three channels equally. OKLab is perceptual and keeps them apart.
test("matches colours perceptually, not by raw rgb distance", () => {
  const palette = [oklab(0, 0, 139), oklab(101, 67, 33)]; // navy, brown
  expect(nearestIndex(palette, oklab(25, 25, 160))).toBe(0);
  expect(nearestIndex(palette, oklab(120, 80, 40))).toBe(1);
});

test("finds the exact colour when the palette contains it", () => {
  const palette = [oklab(255, 0, 0), oklab(0, 255, 0), oklab(0, 0, 255)];
  expect(nearestIndex(palette, oklab(0, 255, 0))).toBe(1);
});

/** Builds an RGBA canvas from a character map, so fixtures read as pictures. */
function raw(rows: string[], key: Record<string, [number, number, number, number]>): Raw {
  const height = rows.length;
  const width = rows[0]!.length;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = key[rows[y]![x]!]!;
      data.set([r, g, b, a], (y * width + x) * 4);
    }
  return { data, width, height };
}

const alphaAt = (image: Raw, x: number, y: number) => image.data[(y * image.width + x) * 4 + 3];
const rgbAt = (image: Raw, x: number, y: number) =>
  [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];

test("alpha becomes fully on or fully off", () => {
  const image = raw(["ab", "cd"], {
    a: [255, 0, 0, 255], b: [255, 0, 0, 200], c: [255, 0, 0, 100], d: [255, 0, 0, 0],
  });
  hardenAlpha(image);
  expect([alphaAt(image, 0, 0), alphaAt(image, 1, 0)]).toEqual([255, 255]);
  expect([alphaAt(image, 0, 1), alphaAt(image, 1, 1)]).toEqual([0, 0]);
});

test("quantising snaps colours to the palette and leaves transparent pixels alone", () => {
  const image = raw(["ab"], { a: [250, 10, 10, 255], b: [9, 200, 9, 0] });
  quantise(image, ["#ff0000", "#0000ff"]);
  expect(rgbAt(image, 0, 0)).toEqual([255, 0, 0]);
  // Transparent pixels keep their bytes; they are never drawn.
  expect(rgbAt(image, 1, 0)).toEqual([9, 200, 9]);
});

test("an isolated pixel with no matching neighbour is removed", () => {
  const image = raw([
    "...",
    ".x.",
    "...",
  ], { ".": [0, 0, 0, 0], x: [255, 0, 0, 255] });
  removeOrphans(image);
  expect(alphaAt(image, 1, 1)).toBe(0);
});

test("a pixel that has a same-colour neighbour is kept", () => {
  const image = raw([
    "...",
    ".xx",
    "...",
  ], { ".": [0, 0, 0, 0], x: [255, 0, 0, 255] });
  removeOrphans(image);
  expect(alphaAt(image, 1, 1)).toBe(255);
  expect(alphaAt(image, 2, 1)).toBe(255);
});

// An orphan is a pixel isolated in space, not in colour. Requiring an exactly equal
// neighbour ate most of a quantised sprite, because neighbouring pixels rarely match
// exactly once colours have been snapped to a palette.
test("a pixel with a differently coloured neighbour is kept", () => {
  const image = raw([
    "...",
    ".xy",
    "...",
  ], { ".": [0, 0, 0, 0], x: [255, 0, 0, 255], y: [0, 0, 255, 255] });
  removeOrphans(image);
  expect(alphaAt(image, 1, 1)).toBe(255);
  expect(alphaAt(image, 2, 1)).toBe(255);
});

test("outline draws a border on transparent pixels touching the silhouette", () => {
  const image = raw([
    "...",
    ".x.",
    "...",
  ], { ".": [0, 0, 0, 0], x: [255, 0, 0, 255] });
  outline(image, "#101010");
  expect(rgbAt(image, 1, 0)).toEqual([16, 16, 16]);
  expect(alphaAt(image, 1, 0)).toBe(255);
  // The subject itself is untouched.
  expect(rgbAt(image, 1, 1)).toEqual([255, 0, 0]);
  // Diagonals are not outlined: 4-neighbour only, or the sprite gains fat corners.
  expect(alphaAt(image, 0, 0)).toBe(0);
});

/** A solid square of `size`, centred on a transparent canvas of `canvas`. */
async function square(canvas: number, size: number, colour: { r: number; g: number; b: number }) {
  const offset = Math.floor((canvas - size) / 2);
  return sharp({ create: { width: canvas, height: canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{
      input: await sharp({ create: { width: size, height: size, channels: 4, background: { ...colour, alpha: 1 } } }).png().toBuffer(),
      left: offset, top: offset,
    }])
    .png().toBuffer();
}

test("the default style is a 64px grid, 16 colours, outlined", () => {
  expect(DEFAULT_PIXEL_STYLE).toEqual({ grid: 64, colors: 16, outline: true });
});

test("output is exactly the requested grid", async () => {
  const { image } = await pixelize(await square(512, 300, { r: 200, g: 40, b: 40 }), { grid: 32, colors: 8, outline: false });
  const meta = await sharp(image).metadata();
  expect([meta.width, meta.height]).toEqual([32, 32]);
});

test("a locked palette is respected and reported back", async () => {
  const { image, palette } = await pixelize(
    await square(256, 128, { r: 10, g: 220, b: 10 }),
    { grid: 16, colors: 4, outline: false },
    ["#ff0000", "#0000ff"],
  );
  expect(palette).toEqual(["#ff0000", "#0000ff"]);
  const { data } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const drawn = new Set<string>();
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]) drawn.add(`#${Buffer.from(data.subarray(i, i + 3)).toString("hex")}`);
  for (const colour of drawn) expect(["#ff0000", "#0000ff"]).toContain(colour);
});

test("with no palette given, one is derived and returned", async () => {
  const { palette } = await pixelize(await square(256, 128, { r: 10, g: 220, b: 10 }), { grid: 16, colors: 4, outline: false });
  expect(palette.length).toBeGreaterThan(0);
  expect(palette.length).toBeLessThanOrEqual(4);
  for (const colour of palette) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
});

// The size-drift regression: two sources whose subjects differ in size must come
// out the same size, because the fit normalises them. This is what stopped a
// character changing size mid-walk.
test("differently sized subjects produce identically sized output subjects", async () => {
  const style = { grid: 32, colors: 4, outline: false };
  const measure = async (canvas: number, size: number) => {
    const { image } = await pixelize(await square(canvas, size, { r: 200, g: 40, b: 40 }), style);
    const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let top = info.height, bottom = -1;
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++)
        if (data[(y * info.width + x) * 4 + 3]) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
    return bottom - top + 1;
  };
  expect(await measure(512, 400)).toBe(await measure(512, 120));
});

test("the subject keeps at least a one-pixel margin", async () => {
  const { image } = await pixelize(await square(256, 250, { r: 200, g: 40, b: 40 }), { grid: 16, colors: 4, outline: false });
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const opaque = (x: number, y: number) => data[(y * info.width + x) * 4 + 3] !== 0;
  for (let i = 0; i < info.width; i++) {
    expect(opaque(i, 0)).toBe(false);
    expect(opaque(i, info.height - 1)).toBe(false);
    expect(opaque(0, i)).toBe(false);
    expect(opaque(info.width - 1, i)).toBe(false);
  }
});

test("an image with no transparency is refused with an actionable message", async () => {
  const flat = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toBuffer();
  await expect(pixelize(flat, DEFAULT_PIXEL_STYLE)).rejects.toThrow(/background/i);
});

test("a fully transparent image is refused rather than producing an empty sprite", async () => {
  const empty = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  await expect(pixelize(empty, DEFAULT_PIXEL_STYLE)).rejects.toThrow(/no visible pixels/i);
});

test("derivePalette returns at most the requested number of colours", async () => {
  const palette = await derivePalette(await square(64, 32, { r: 10, g: 220, b: 10 }), 8);
  expect(palette.length).toBeGreaterThan(0);
  expect(palette.length).toBeLessThanOrEqual(8);
});
