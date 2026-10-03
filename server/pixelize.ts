import sharp from "sharp";

/** Perceptual colour space. Nearest-colour matching in raw RGB swaps dark blues and browns. */
export type Oklab = [number, number, number];

/** sRGB (0-255) to OKLab, via linear RGB. Coefficients from Björn Ottosson's definition. */
export function oklab(r: number, g: number, b: number): Oklab {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function nearestIndex(palette: Oklab[], colour: Oklab): number {
  let best = 0;
  let bestDistance = Infinity;
  for (const [index, entry] of palette.entries()) {
    const distance = (entry[0] - colour[0]) ** 2 + (entry[1] - colour[1]) ** 2 + (entry[2] - colour[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

export function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export const rgbToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

/** An RGBA image, 4 bytes per pixel, row-major. */
export type Raw = { data: Buffer; width: number; height: number };

/** Pixel art has no semi-transparent fringe: every pixel is fully drawn or absent. */
export function hardenAlpha(raw: Raw, threshold = 128) {
  for (let i = 3; i < raw.data.length; i += 4) raw.data[i] = raw.data[i]! >= threshold ? 255 : 0;
}

export function quantise(raw: Raw, palette: string[]) {
  if (!palette.length) throw new Error("Cannot quantise to an empty palette.");
  const rgb = palette.map(hexToRgb);
  const lab = rgb.map(([r, g, b]) => oklab(r, g, b));
  // One cache entry per distinct source colour; sprites repeat colours heavily.
  const cache = new Map<number, number>();
  for (let i = 0; i < raw.data.length; i += 4) {
    if (!raw.data[i + 3]) continue;
    const key = (raw.data[i]! << 16) | (raw.data[i + 1]! << 8) | raw.data[i + 2]!;
    let index = cache.get(key);
    if (index === undefined) {
      index = nearestIndex(lab, oklab(raw.data[i]!, raw.data[i + 1]!, raw.data[i + 2]!));
      cache.set(key, index);
    }
    raw.data.set(rgb[index]!, i);
  }
}

/** The four orthogonal neighbours of a pixel offset, skipping those off the edge. */
const neighbours = (raw: Raw, x: number, y: number, i: number) =>
  [
    x > 0 ? i - 4 : -1,
    x < raw.width - 1 ? i + 4 : -1,
    y > 0 ? i - raw.width * 4 : -1,
    y < raw.height - 1 ? i + raw.width * 4 : -1,
  ].filter((offset) => offset >= 0);

/**
 * A pixel floating alone in transparency reads as dirt at native scale. Isolation is
 * spatial, never chromatic: after quantising, neighbouring pixels rarely share an exact
 * colour, so requiring one would erase most of the artwork rather than its specks.
 */
export function removeOrphans(raw: Raw) {
  const doomed: number[] = [];
  for (let y = 0; y < raw.height; y++)
    for (let x = 0; x < raw.width; x++) {
      const i = (y * raw.width + x) * 4;
      if (!raw.data[i + 3]) continue;
      if (!neighbours(raw, x, y, i).some((n) => raw.data[n + 3] !== 0)) doomed.push(i);
    }
  // Collected first, so removing one orphan cannot orphan its neighbour mid-pass.
  for (const i of doomed) raw.data[i + 3] = 0;
}

/** A one-pixel border on the transparent side of the silhouette, 4-neighbour only. */
export function outline(raw: Raw, colour: string) {
  const [r, g, b] = hexToRgb(colour);
  const edges: number[] = [];
  for (let y = 0; y < raw.height; y++)
    for (let x = 0; x < raw.width; x++) {
      const i = (y * raw.width + x) * 4;
      if (raw.data[i + 3]) continue;
      if (neighbours(raw, x, y, i).some((n) => raw.data[n + 3] !== 0)) edges.push(i);
    }
  for (const i of edges) raw.data.set([r, g, b, 255], i);
}

export type PixelStyle = { grid: number; colors: number; outline: boolean };
export const DEFAULT_PIXEL_STYLE: PixelStyle = { grid: 64, colors: 16, outline: true };
/** Dark, neutral, and not pure black, so it reads as ink rather than a hole. */
const OUTLINE_COLOUR = "#141414";

/**
 * True when the image is effectively opaque everywhere, meaning its subject was never
 * separated from its background. Measured as a share rather than an absolute, because a
 * baked-in background leaves a handful of soft pixels at the image border and an
 * all-or-nothing test lets it through — which produced a sprite outlined around the
 * whole canvas instead of around the character.
 */
const OPAQUE_SHARE_WITHOUT_BACKGROUND = 0.99;

async function isFlat(source: Buffer) {
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let opaque = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] === 255) opaque++;
  return opaque / (info.width * info.height) >= OPAQUE_SHARE_WITHOUT_BACKGROUND;
}

/** Median-cut via sharp's own palette encoder, then read back the colours it chose. */
export async function derivePalette(image: Buffer, colors: number): Promise<string[]> {
  const quantised = await sharp(image).png({ palette: true, colors: Math.max(2, colors), dither: 0 }).toBuffer();
  const { data } = await sharp(quantised).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const seen = new Set<string>();
  for (let i = 0; i < data.length; i += 4)
    if (data[i + 3]) seen.add(rgbToHex(data[i]!, data[i + 1]!, data[i + 2]!));
  return [...seen].sort().slice(0, Math.max(2, colors));
}

/**
 * A rendered image to native pixel art. The subject is fitted to the grid so every
 * asset comes out the same size regardless of how large it was drawn, which is what
 * keeps an animation's frames from changing size.
 */
export async function pixelize(
  source: Buffer,
  style: PixelStyle,
  palette?: string[],
): Promise<{ image: Buffer; palette: string[] }> {
  if (await isFlat(source))
    throw new Error("This asset has no transparency, so its subject cannot be separated from its background. Remove the background first.");
  const trimmed = await sharp(source).trim({ threshold: 0 }).toBuffer().catch(() => null);
  if (!trimmed) throw new Error("This asset has no visible pixels to pixelize.");

  // One pixel of margin on every side, so an outline has somewhere to go.
  const inner = Math.max(1, style.grid - 2);
  const fitted = await sharp(trimmed)
    .resize({ width: inner, height: inner, fit: "inside", kernel: "mitchell" })
    .toBuffer();
  const centred = await sharp({
    create: { width: style.grid, height: style.grid, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: fitted, gravity: "centre" }])
    .png()
    .toBuffer();

  const decoded = await sharp(centred).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const raw: Raw = { data: Buffer.from(decoded.data), width: decoded.info.width, height: decoded.info.height };
  hardenAlpha(raw);
  let visible = false;
  for (let i = 3; i < raw.data.length && !visible; i += 4) if (raw.data[i]) visible = true;
  if (!visible) throw new Error("This asset has no visible pixels to pixelize.");

  const chosen = palette?.length
    ? palette
    : await derivePalette(await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } }).png().toBuffer(), style.colors);
  quantise(raw, chosen);
  removeOrphans(raw);
  if (style.outline) outline(raw, OUTLINE_COLOUR);

  return {
    image: await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } }).png().toBuffer(),
    palette: chosen,
  };
}
