import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, test } from 'vitest';
import { referenceMatte, selectMatteBackground } from '../jobs.js';

test('picks the matte a reference cutout has the fewest pixels near', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matte-'));
  try {
    // A dark subject on transparency must not be generated on black, and a pale one not on white.
    const cutout = async (name: string, colour: { r: number; g: number; b: number }) => {
      const path = join(dir, name);
      await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: { create: { width: 32, height: 32, channels: 4, background: { ...colour, alpha: 1 } } }, top: 16, left: 16 }])
        .png()
        .toFile(path);
      return path;
    };
    expect(await referenceMatte(await cutout('knight.png', { r: 30, g: 32, b: 40 }))).toBe('white');
    expect(await referenceMatte(await cutout('ghost.png', { r: 240, g: 240, b: 235 }))).toBe('black');
    expect(await referenceMatte(await cutout('frog.png', { r: 90, g: 160, b: 70 }))).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('uses a white matte for ordinary dark or colorful sprites', () => {
  expect(selectMatteBackground('Painterly brown cattail reeds with olive leaves')).toBe('white');
});

test('uses a black matte when pale or translucent details need contrast', () => {
  expect(selectMatteBackground('A white orchid with pale petals and translucent dew')).toBe('black');
});
