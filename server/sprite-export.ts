import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { renderSpriteFrame } from "./animation.js";
import type { AnimationFrame, AnimationRecord } from "./types.js";

/** Gap between cells, so texture filtering in an engine never samples a neighbouring frame. */
const CELL_PADDING = 2;

export type ExportedFile = { kind: "sheet" | "atlas" | "preview"; filename: string };

/** Square-ish grid for `count` frames: as many columns as the square root, rounded up. */
export function sheetLayout(count: number) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  return { columns, rows: Math.max(1, Math.ceil(count / columns)) };
}

/** Frame order a player shows; ping-pong plays forward then back, like the lab's normalizeTimeline. */
export function playbackOrder(count: number, loop: AnimationRecord["loop"]) {
  const forward = [...Array(count).keys()];
  return loop === "ping-pong" && count > 1 ? [...forward, ...forward.slice(0, -1).reverse()] : forward;
}

/**
 * Renders every visible frame aligned on its shared box, packs them into an evenly spaced sheet,
 * and writes the sheet PNG, a TexturePacker/Phaser "hash" JSON atlas and an animated WebP preview.
 */
export async function exportAnimation(
  record: AnimationRecord,
  resolveSource: (frame: AnimationFrame) => string,
  outputDir: string,
  options: { scale?: number } = {},
): Promise<ExportedFile[]> {
  const scale = options.scale ?? 1;
  // Checked before any work, so a bad scale fails cleanly rather than part-way through.
  if (!Number.isInteger(scale) || scale < 1) throw new Error("Export scale must be a whole number of pixels, 1 or more.");
  const visible = record.frames.filter((frame) => !frame.hidden);
  if (!visible.length) throw new Error("This animation has no visible frames to export.");
  const rendered = await Promise.all(
    visible.map(async (frame) => {
      const source = resolveSource(frame);
      const image = frame.rect
        ? await renderSpriteFrame(source, frame.rect, frame.anchorOffset, frame.anchorScale ?? 1, frame.box)
        : await sharp(source).png().toBuffer();
      const { width = 1, height = 1 } = await sharp(image).metadata();
      return { image, width, height };
    }),
  );
  const sourceCellWidth = Math.max(...rendered.map((frame) => frame.width));
  const sourceCellHeight = Math.max(...rendered.map((frame) => frame.height));
  // Frames smaller than the cell (sequence frames of mixed sizes) are centred in it.
  const fitted = await Promise.all(
    rendered.map(({ image, width, height }) =>
      width === sourceCellWidth && height === sourceCellHeight
        ? image
        : sharp(image)
            .extend({
              left: Math.floor((sourceCellWidth - width) / 2),
              right: Math.ceil((sourceCellWidth - width) / 2),
              top: Math.floor((sourceCellHeight - height) / 2),
              bottom: Math.ceil((sourceCellHeight - height) / 2),
              background: { r: 0, g: 0, b: 0, alpha: 0 },
            })
            .png()
            .toBuffer(),
    ),
  );

  // Cells are enlarged before anything is laid out, so the sheet, the atlas and the preview
  // all agree without any of them being rescaled afterwards. Nearest-neighbour, because
  // native pixel art must grow in whole blocks; any interpolation destroys it.
  const cellWidth = sourceCellWidth * scale;
  const cellHeight = sourceCellHeight * scale;
  const padding = CELL_PADDING * scale;
  const cells = scale === 1
    ? fitted
    : await Promise.all(fitted.map((image) =>
        sharp(image).resize({ width: cellWidth, height: cellHeight, kernel: "nearest" }).png().toBuffer()));

  const { columns, rows } = sheetLayout(cells.length);
  const sheetWidth = columns * cellWidth + (columns - 1) * padding;
  const sheetHeight = rows * cellHeight + (rows - 1) * padding;
  const positions = cells.map((_, index) => ({
    x: (index % columns) * (cellWidth + padding),
    y: Math.floor(index / columns) * (cellHeight + padding),
  }));
  const sheet = await sharp({ create: { width: sheetWidth, height: sheetHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(cells.map((input, index) => ({ input, left: positions[index]!.x, top: positions[index]!.y })))
    .png()
    .toBuffer();

  const fallbackDuration = Math.max(1, Math.round(1000 / Math.max(1, record.fps)));
  const durations = visible.map((frame) => (frame.durationMs > 0 ? frame.durationMs : fallbackDuration));
  const keys = visible.map((_, index) => `${record.name}-${String(index).padStart(3, "0")}`);
  const order = playbackOrder(visible.length, record.loop);
  const atlas = {
    frames: Object.fromEntries(
      keys.map((key, index) => [
        key,
        {
          frame: { x: positions[index]!.x, y: positions[index]!.y, w: cellWidth, h: cellHeight },
          rotated: false,
          trimmed: false,
          spriteSourceSize: { x: 0, y: 0, w: cellWidth, h: cellHeight },
          sourceSize: { w: cellWidth, h: cellHeight },
          duration: durations[index],
        },
      ]),
    ),
    // Playback order, so an engine can build the clip (ping-pong included) without extra logic.
    animations: { [record.name]: order.map((index) => keys[index]) },
    meta: {
      app: "Diorama Asset Studio",
      image: `${record.name}.png`,
      format: "RGBA8888",
      size: { w: sheetWidth, h: sheetHeight },
      scale: String(scale),
      fps: record.fps,
      loop: record.loop,
      grid: { columns, rows, cellWidth, cellHeight, padding },
    },
  };

  const preview = await sharp(order.map((index) => cells[index]!), { join: { animated: true } })
    .webp({ loop: record.loop === "once" ? 1 : 0, delay: order.map((index) => durations[index]!), lossless: true })
    .toBuffer();

  await mkdir(outputDir, { recursive: true });
  const files: Array<[ExportedFile, Buffer | string]> = [
    [{ kind: "sheet", filename: `${record.name}.png` }, sheet],
    [{ kind: "atlas", filename: `${record.name}.json` }, `${JSON.stringify(atlas, null, 2)}\n`],
    [{ kind: "preview", filename: `${record.name}.webp` }, preview],
  ];
  await Promise.all(files.map(([file, contents]) => writeFile(join(outputDir, file.filename), contents)));
  return files.map(([file]) => file);
}
