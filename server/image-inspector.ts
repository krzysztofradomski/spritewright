import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';
import type { ImageInspection } from './types.js';

export async function inspectImage(filePath: string, options: { pixel?: boolean } = {}): Promise<ImageInspection> {
  const [metadata, bytes, fileStats] = await Promise.all([sharp(filePath).metadata(), readFile(filePath), stat(filePath)]);
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height || !metadata.format) throw new Error('The file is not a readable image.');
  const hasAlpha = Boolean(metadata.hasAlpha);
  let alphaCoverage = 1;
  let opaqueBounds: ImageInspection['opaqueBounds'] = { left: 0, top: 0, width, height };
  if (hasAlpha) {
    const raw = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let count = 0; let minX = width; let minY = height; let maxX = -1; let maxY = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (raw.data[(y * width + x) * raw.info.channels + 3]! > 0) { count++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    }
    alphaCoverage = count / (width * height);
    opaqueBounds = count ? { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;
  }
  const warnings: string[] = [];
  if (!hasAlpha) warnings.push('No alpha channel: unsuitable for a transparent sprite or cutout.');
  // A native pixel sprite legitimately fills its grid, so touching the edge is not a fault.
  if (!options.pixel && opaqueBounds && (opaqueBounds.left === 0 || opaqueBounds.top === 0 || opaqueBounds.left + opaqueBounds.width === width || opaqueBounds.top + opaqueBounds.height === height)) warnings.push('Opaque pixels touch the crop edge. Review the silhouette and padding.');
  return { format: metadata.format, width, height, byteSize: fileStats.size, hasAlpha, alphaCoverage, opaqueBounds, sha256: createHash('sha256').update(bytes).digest('hex'), warnings };
}
