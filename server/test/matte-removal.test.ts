import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, test } from "vitest";
import { removeSolidMatte } from "../jobs.js";

test("removes an edge-connected black extraction matte without clearing the subject", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "asset-studio-matte-"));
  const imagePath = join(rootDir, "sprite.png");
  const pixels = Buffer.from([
    0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 220, 150, 30, 255,
    0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255,
  ]);
  await sharp(pixels, { raw: { width: 3, height: 3, channels: 4 } })
    .png()
    .toFile(imagePath);

  try {
    await removeSolidMatte(imagePath, "black");
    const { data } = await sharp(imagePath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0);
    expect(data[4 * 4 + 3]).toBe(255);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

const pixelsOf = async (path: string) => sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

test("clears enclosed matte pockets but keeps shaded white details and tiny highlights", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "asset-studio-matte-pocket-"));
  const imagePath = join(rootDir, "grass.png");
  const size = 40;
  const data = Buffer.alloc(size * size * 4, 255); // white matte everywhere, opaque
  const paint = (x0: number, y0: number, w: number, h: number, rgb: [number, number, number]) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) data.set([...rgb, 255], (y * size + x) * 4);
  };
  // A dark green ring (x 5..34) enclosing three regions the edge flood can't reach.
  paint(5, 5, 30, 30, [30, 70, 40]);
  paint(8, 8, 10, 10, [255, 255, 255]); // a gap between blades: pure matte, 100 px
  paint(22, 8, 10, 10, [236, 232, 222]); // a painted off-white patch: must stay
  paint(10, 25, 1, 1, [255, 255, 255]); // a 1 px highlight: too small to be a pocket
  await sharp(data, { raw: { width: size, height: size, channels: 4 } }).png().toFile(imagePath);
  try {
    await removeSolidMatte(imagePath, "white");
    const { data: out } = await pixelsOf(imagePath);
    const alphaAt = (x: number, y: number) => out[(y * size + x) * 4 + 3];
    expect(alphaAt(0, 0)).toBe(0); // outer matte
    expect(alphaAt(12, 12)).toBe(0); // enclosed pocket
    expect(alphaAt(26, 12)).toBe(255); // off-white paint
    expect(alphaAt(10, 25)).toBe(255); // highlight
    expect(alphaAt(6, 20)).toBe(255); // subject
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("turns a matte-blended edge into partial alpha instead of a light halo", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "asset-studio-matte-edge-"));
  const imagePath = join(rootDir, "edge.png");
  // One row: matte, 50% blend of matte and dark green, dark green subject.
  const green = [30, 70, 40];
  const blend = green.map((channel) => Math.round((channel + 255) / 2));
  const row = [[255, 255, 255], [255, 255, 255], blend, green, green, green];
  const data = Buffer.from(row.flatMap((rgb) => [...rgb, 255]));
  await sharp(data, { raw: { width: row.length, height: 1, channels: 4 } }).png().toFile(imagePath);
  try {
    await removeSolidMatte(imagePath, "white");
    const { data: out } = await pixelsOf(imagePath);
    const edge = 2 * 4;
    expect(out[edge + 3]).toBeGreaterThan(90);
    expect(out[edge + 3]).toBeLessThan(170);
    // The matte is taken back out of the colour, so the edge reads as green, not pale.
    expect(Math.abs(out[edge + 1]! - green[1]!)).toBeLessThan(20);
    expect(out[3 * 4 + 3]).toBe(255);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
