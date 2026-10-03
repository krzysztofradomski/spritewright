import sharp from "sharp";
import type { GridLayout } from "../src/sprite-layout.js";
import { readAppSettings, updateAppSettings } from "./app-settings.js";
import { PIXEL_TIMEOUT_MS, readTextModel, runText } from "./text.js";

/**
 * Pixel art drawn as SVG by a text model, then rasterised. Any text provider can do it, so this
 * generator still works when every image provider is out of quota.
 * Cells on the short side. More cells means more detail and a longer reply — roughly a rect per
 * run of same-coloured cells — so the ceiling is whatever the chosen model will emit in one go
 * before it truncates. 96 suits a model with a large output budget; drop it for a smaller one.
 * ponytail: one global value, overridable with PIXEL_GRID. Put it on the brief if it ever needs
 * to differ per asset (16 for an icon, 96 for a character).
 */
export const PIXEL_GRID = Number(process.env.PIXEL_GRID ?? 64);
/**
 * Cells for a provider whose single reply has room for the thousands of rects a finer grid costs.
 * Measured, not guessed: gemini-3.8-flash-high draws 64 cleanly and truncates mid-tag at 96.
 */
const PROVIDER_GRID: Partial<Record<string, number>> = { anthropic: 96, "claude-cli": 96 };
export const gridForProvider = (provider: string) => PROVIDER_GRID[provider] ?? PIXEL_GRID;

/** Below this a sprite has too few cells to read as the subject at all, so stop backing off. */
export const MIN_GRID = 32;
/** The next grid to try after a truncated drawing: a quarter off, rounded, never below the floor. */
export const smallerGrid = (cells: number, floor = MIN_GRID) => Math.max(floor, Math.round((cells * 0.75) / 4) * 4);

/** A reply that ran out of room, as opposed to a model that refused or drew nothing. */
const TRUNCATED = /cut off|wouldn't render|without an SVG document/i;

const gridKey = (choice: { provider: string; model: string }) => `${choice.provider}:${choice.model}`;

/** The grid this model has been shown to finish, or the optimistic default for its provider. */
async function learnedGrid(rootDir: string, choice: { provider: string; model: string }, fallback: number, floor: number) {
  const saved = (await readAppSettings(rootDir)).pixelGrids?.[gridKey(choice)];
  return typeof saved === "number" && saved >= floor ? saved : fallback;
}

async function rememberGrid(rootDir: string, choice: { provider: string; model: string }, cells: number) {
  const settings = await readAppSettings(rootDir);
  if (settings.pixelGrids?.[gridKey(choice)] === cells) return;
  await updateAppSettings(rootDir, { pixelGrids: { ...settings.pixelGrids, [gridKey(choice)]: cells } });
}
/**
 * Cells per frame on a sprite sheet. The whole sheet is one reply, so sixteen frames share the
 * output a single drawing gets — frames are coarser than a standalone asset.
 */
export const SHEET_FRAME_GRID = 24;
/** Cells per frame for a provider with room for a finer sheet in one reply. */
const SHEET_FRAME_GRID_BY_PROVIDER: Partial<Record<string, number>> = { anthropic: 48, "claude-cli": 48 };
/** Sixteen frames at 16 cells collapsed into two or three repeated poses, so sheets stop above it. */
export const MIN_FRAME_GRID = 24;
export const sheetGridForProvider = (provider: string) => SHEET_FRAME_GRID_BY_PROVIDER[provider] ?? SHEET_FRAME_GRID;
/** A model that ignores the size rules shouldn't get to rasterise a huge canvas. */
const MAX_GRID = 512;

/**
 * Cells across and down. A sprite sheet gets an exact multiple of its frame grid so every cell
 * boundary lands on a frame boundary; anything else matches the requested canvas's aspect, since
 * a square drawing stretched onto a 4:3 canvas is what letterboxes a sheet into one small tile.
 */
export function pixelGrid(width: number, height: number, layout?: GridLayout | null, cells = PIXEL_GRID, frameCells = SHEET_FRAME_GRID) {
  if (layout) return { width: layout.columns * frameCells, height: layout.rows * frameCells };
  const short = Math.max(1, Math.min(width, height));
  return {
    width: Math.min(MAX_GRID, Math.max(1, Math.round((cells * width) / short))),
    height: Math.min(MAX_GRID, Math.max(1, Math.round((cells * height) / short))),
  };
}

export function buildPixelPrompt(subject: string, options: { width: number; height: number; layout?: GridLayout | null; sourceSvg?: string; cells?: number; frameCells?: number } = { width: 1024, height: 1024 }) {
  const grid = pixelGrid(options.width, options.height, options.layout, options.cells, options.frameCells);
  const layout = options.layout;
  const frame = options.frameCells ?? SHEET_FRAME_GRID;
  const sheet = layout
    ? `
- This is a sprite sheet: ${layout.columns} columns x ${layout.rows} rows of ${frame}x${frame} frames, read left to right, top row first. Frame (col, row) occupies cells x from ${frame}*col to ${frame}*col+${frame - 1}, y from ${frame}*row to ${frame}*row+${frame - 1}. Never let a rect cross a frame boundary.
- Draw the same subject in every frame at the same scale, on the same baseline, differing only by the pose that frame calls for. Draw no grid lines, borders or frame numbers.
- Build it the way a sprite artist reuses parts, or it will not fit in your reply: inside <defs>, draw each part that stays the same across frames (head, torso, shield, props) once as <g id="...">, and each distinct limb or wing pose once too. Then draw every frame as <use href="#part" x="..." y="..."/> placements plus rects only for what is unique to that frame. Place parts with whole-cell x/y or transform="translate(dx,dy)"; mirror with scale(-1,1). Never rotate, skew or scale otherwise.
- Draw all ${layout.columns * layout.rows} frames; a sheet with an empty cell is unfinished. Every one of them is a different drawing. Before you write a frame, check the pose it is meant to hold against the frame before it: a limb has to move by at least two cells, and a frame that would repeat an earlier one exactly means you have drawn the pose wrong, not that the pose repeats. Work through the frames in order and give each one the pose its number calls for.`
    : "";
  // The source drawing goes in verbatim: it is the only way this model can see the reference.
  const source = options.sourceSvg
    ? `\n\nThis is the exact subject to redraw, as the SVG it was drawn from. Keep its palette, proportions, costume and facing; change only what the request asks to change. Its pose is only the resting stance: when the request describes motion, move the limbs and body by a visible amount (a tenth of the figure or more) instead of copying this pose with a pixel nudged.\n${options.sourceSvg}`
    : "";
  return `Draw this as pixel art and reply with one SVG document only: no prose, no markdown, no code fences.

Request: ${subject}${source}

Drawing rules, which override any canvas, size, resolution or format the request above asks for:
- Canvas is exactly ${grid.width}x${grid.height} cells: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${grid.width} ${grid.height}" width="${grid.width}" height="${grid.height}" shape-rendering="crispEdges">
- One cell is one pixel of pixel art. Ignore any pixel dimensions in the request; they describe the finished file, not this drawing.
- Every mark is an axis-aligned <rect> with integer x, y, width and height in cell units. Merge runs of same-coloured cells into one rect.
- Fill the space: the subject spans ${layout ? "its frame" : "the canvas"} edge to edge apart from a cell or two of padding.
- Leave the background transparent: draw no background rect, no frame, no shadow, no checkerboard.
- The silhouette is solid. Never leave a stray transparent cell inside the subject.
- Flat hex fills only. No gradients, strokes, opacity, filters, text, or images.

Craft, the way a hand-pixelled game sprite is built:
- Work in palette ramps, not flat colours: give every material 4 or 5 tones (deep shadow, shadow, base, light, highlight) and shade with them. 24 to 40 colours over the whole drawing is right; a drawing with one tone per material reads as a flat blob and is wrong.
- Ramps shift hue as they go: shadows lean cooler and more saturated, highlights lean warmer. Never darken a colour by only dropping its brightness.
- Outline selectively, in a darker, more saturated shade of the colour it wraps — never pure black, and never a uniform outline all the way round. Let the lit edge lose its outline entirely.
- Light comes from the upper left: a bright rim along upper-left facing edges, core shadow on the lower right of each form, and a darker contact edge where forms meet.
- Separate materials by value, not just hue, so the shapes still read when squinted at: metal gets tight, high-contrast specular steps; cloth gets soft, broad, low-contrast shading; leather sits between them.
- Pick out detail that earns its cells — a visor slit, a belt buckle, a rivet line, a trim edge — and leave the large forms calm. Clustered, deliberate shapes only: no single scattered pixels, no noise, no banding, no evenly spaced dotting.
- Anti-alias by hand where a curve or diagonal steps: one intermediate tone in the corner of the step, on interior edges only, never on the outer silhouette.${sheet}`;
}

/** Pulls the SVG out of a reply that may still carry fences or chatter around it. */
export function extractSvg(reply: string) {
  const found = reply.match(/<svg[\s\S]*<\/svg>/i);
  // Quote what came back instead: a truncated drawing and a model refusing the task look
  // identical without it, and the reply is the only evidence of which one happened.
  if (!found)
    throw new Error(
      `the model replied without an SVG document (${reply.length} chars${/<svg/i.test(reply) ? ", opened an <svg> but never closed it — the reply was cut off" : ""}): ${JSON.stringify(reply.slice(0, 200))}`,
    );
  return found[0];
}

// Model output is untrusted input to the rasteriser: allow only what flat pixel art needs.
// Model output is untrusted input to the rasteriser: allow only what flat pixel art needs. Reuse
// (<defs>, <use>) is allowed because a sheet redrawn from scratch in every frame costs more reply
// than a model has; <use> may only point at an id in this same document.
const ALLOWED_TAGS = new Set(["svg", "g", "rect", "polygon", "polyline", "path", "title", "desc", "defs", "symbol", "use"]);
const UNSAFE_ELEMENTS = /<(script|style|foreignObject|iframe|image|a|animate\w*|set)\b[\s\S]*?<\/\1\s*>|<(?:script|style|foreignObject|iframe|image|animate\w*|set)\b[^>]*?\/?>/gi;
const UNSAFE_ATTRIBUTES = /\s(?:on\w+|src|style|filter|mask|clip-path)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const LINKS = /\s(?:xlink:)?href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const LOCAL_LINK = /^#[\w-]+$/;
const TRANSFORMS = /\stransform\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
// Whole-cell moves and mirrors keep pixels square; rotate, skew and other scales smear them.
const PIXEL_TRANSFORM = /^\s*(?:(?:translate\(\s*-?\d+(?:[\s,]+-?\d+)?\s*\)|scale\(\s*-?1(?:[\s,]+-?1)?\s*\))\s*)+$/;
const PAINT_REFERENCE = /\s(?:fill|stroke)\s*=\s*(?:"[^"]*url\([^"]*"|'[^']*url\([^']*')/gi;
const unquote = (value: string) => value.replace(/^["']|["']$/g, "");

/** Strips anything that could fetch, script, or style its way out of a flat drawing. */
export function sanitizeSvg(svg: string) {
  return svg
    .replace(UNSAFE_ELEMENTS, "")
    .replace(/<\/?([a-zA-Z][\w:-]*)\b[^>]*>/g, (tag, name: string) => (ALLOWED_TAGS.has(name.toLowerCase()) ? tag : ""))
    .replace(UNSAFE_ATTRIBUTES, "")
    .replace(PAINT_REFERENCE, "")
    .replace(LINKS, (attribute, value: string) => (LOCAL_LINK.test(unquote(value)) ? attribute : ""))
    .replace(TRANSFORMS, (attribute, value: string) => (PIXEL_TRANSFORM.test(unquote(value)) ? attribute : ""));
}

/**
 * Sanitised SVG plus the size to rasterise it at: the model's own viewBox when it kept one, so a
 * 16x16 drawing stays 16 cells instead of being stretched onto the grid we asked for.
 */
export function prepareSvg(reply: string, fallback: { width: number; height: number } = { width: PIXEL_GRID, height: PIXEL_GRID }) {
  const svg = sanitizeSvg(extractSvg(reply));
  const box = svg.match(/viewBox\s*=\s*["']([^"']+)["']/i)?.[1]?.trim().split(/[\s,]+/).map(Number);
  const valid = box?.length === 4 && box.every((value) => Number.isFinite(value)) && box[2]! > 0 && box[3]! > 0;
  const width = Math.min(valid ? Math.round(box[2]!) : fallback.width, MAX_GRID);
  const height = Math.min(valid ? Math.round(box[3]!) : fallback.height, MAX_GRID);
  const viewBox = valid ? box.join(" ") : `0 0 ${fallback.width} ${fallback.height}`;
  const root = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}" shape-rendering="crispEdges">`;
  const body = svg.replace(/<svg\b[^>]*>/i, "");
  if (!/<(rect|path|polygon|polyline)\b/i.test(body)) throw new Error("the model's SVG had nothing to draw");
  return { svg: `${root}${body}`, width, height };
}

/**
 * Rasterises at the drawing's own cell size, then blows it up with hard pixel edges. A sheet is
 * stretched rather than letterboxed: every frame has to stay on its cell boundary, and padding
 * bars would shift each frame off the grid the sprite editor slices on.
 */
export async function renderPixelSvg(svg: string, output: string, width: number, height: number, sheet = false) {
  try {
    await sharp(Buffer.from(svg))
      .resize(width, height, { kernel: "nearest", fit: sheet ? "fill" : "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(output);
  } catch (error) {
    // A model that ran out of output room stops mid-tag, and the renderer only says "corrupt
    // header" — which reads like a bug here rather than a drawing too big for the model.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `the drawing wouldn't render (${svg.length} chars, ${(svg.match(/<rect/g) ?? []).length} rects): ${detail}. A model that hit its output limit stops mid-tag; try a smaller PIXEL_GRID or a model with more output room.`,
    );
  }
}

/**
 * Where an asset's SVG source lives: beside the PNG, the same way asset records are stored. The
 * PNG stays the delivered asset because the library, sprite export, animation lab and the games
 * all read raster; the SVG is kept so a drawing can be rescaled, recoloured, or redrawn later.
 */
export const svgSidecarPath = (assetPath: string) => `${assetPath}.svg`;

/**
 * How many of a sheet's frames are actually different drawings. A model that repeats a pose
 * produces a sheet that looks right and animates as a stutter, so this is worth checking: the
 * frames are pixel-identical when it happens, not merely similar.
 */
export async function distinctFrames(file: string, layout: GridLayout) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const cellWidth = Math.floor(info.width / layout.columns);
  const cellHeight = Math.floor(info.height / layout.rows);
  const seen = new Set<string>();
  for (let row = 0; row < layout.rows; row++)
    for (let column = 0; column < layout.columns; column++) {
      const bytes: number[] = [];
      for (let y = 0; y < cellHeight; y++) {
        const start = ((row * cellHeight + y) * info.width + column * cellWidth) * 4;
        for (let i = 0; i < cellWidth * 4; i++) bytes.push(data[start + i]!);
      }
      seen.add(bytes.join(","));
    }
  return seen.size;
}

/**
 * How a sheet's frames differ from each other. Frames are compared with their subjects lined up
 * on the bottom-centre of the drawn area, so a figure that drifts inside its cell doesn't count
 * as motion — only a changed pose does. Returns the median change between neighbours (as a
 * percentage of a frame) and how many frames are empty.
 */
export async function frameMotion(file: string, layout: GridLayout) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const cellWidth = Math.floor(info.width / layout.columns);
  const cellHeight = Math.floor(info.height / layout.rows);
  const frames = layout.columns * layout.rows;
  const pixel = (index: number, x: number, y: number) =>
    ((Math.floor(index / layout.columns) * cellHeight + y) * info.width + (index % layout.columns) * cellWidth + x) * 4;
  // Where each frame's drawing sits: its bottom-centre is the anchor the comparison lines up on.
  const anchors = Array.from({ length: frames }, (_, index) => {
    let [left, right, bottom] = [cellWidth, -1, -1];
    for (let y = 0; y < cellHeight; y++)
      for (let x = 0; x < cellWidth; x++)
        if (data[pixel(index, x, y) + 3]! > 128) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
    return right < 0 ? null : { x: Math.round((left + right) / 2), y: bottom };
  });
  const empty = anchors.filter((anchor) => !anchor).length;
  const changes: number[] = [];
  for (let index = 1; index < frames; index++) {
    const [a, b] = [anchors[index - 1], anchors[index]];
    if (!a || !b) {
      changes.push(a === b ? 0 : 100);
      continue;
    }
    let differing = 0;
    for (let y = 0; y < cellHeight; y++)
      for (let x = 0; x < cellWidth; x++) {
        const [bx, by] = [x - a.x + b.x, y - a.y + b.y];
        const p = pixel(index - 1, x, y);
        const inside = bx >= 0 && by >= 0 && bx < cellWidth && by < cellHeight;
        const q = inside ? pixel(index, bx, by) : -1;
        const opaqueA = data[p + 3]! > 128;
        const opaqueB = q >= 0 && data[q + 3]! > 128;
        if (opaqueA !== opaqueB || (opaqueA && (data[p] !== data[q] || data[p + 1] !== data[q + 1] || data[p + 2] !== data[q + 2]))) differing++;
      }
    changes.push((100 * differing) / (cellWidth * cellHeight));
  }
  return { motion: changes.sort((first, second) => first - second)[Math.floor(changes.length / 2)] ?? 0, empty };
}

/** Below this the frames read as one still image with a pixel or two moving. */
const MIN_FRAME_MOTION = 2;

export type PixelRequest = {
  subject: string;
  width: number;
  height: number;
  /** Set for a sprite sheet, so frames land on cell boundaries. */
  layout?: GridLayout | null;
  /** The source drawing to redraw, for a job that referenced an asset this generator made. */
  sourceSvg?: string;
};

/** Asks the pixel-art model for a drawing and writes it to output as a transparent PNG. */
export async function runSvgPixel(rootDir: string, request: PixelRequest, output: string) {
  const choice = await readTextModel(rootDir, "pixel");
  const layout = request.layout ?? null;
  // A sheet spends one reply on every frame, so it has its own ceiling, learned separately from
  // the one for single drawings: backing off a sheet must not shrink standalone art.
  const key = layout ? { provider: choice.provider, model: `${choice.model}:sheet` } : choice;
  const floor = layout ? MIN_FRAME_GRID : MIN_GRID;
  // Start at whatever this model last finished, and step down when a drawing comes back truncated.
  let cells = await learnedGrid(rootDir, key, layout ? sheetGridForProvider(choice.provider) : gridForProvider(choice.provider), floor);
  const sizes = () => (layout ? { cells: PIXEL_GRID, frameCells: cells } : { cells, frameCells: SHEET_FRAME_GRID });
  let svg = "";
  for (;;) {
    try {
      const reply = await runText(choice, buildPixelPrompt(request.subject, { ...request, ...sizes() }), PIXEL_TIMEOUT_MS);
      ({ svg } = prepareSvg(reply, pixelGrid(request.width, request.height, layout, sizes().cells, sizes().frameCells)));
      await renderPixelSvg(svg, output, request.width, request.height, Boolean(layout));
      break;
    } catch (error) {
      const next = smallerGrid(cells, floor);
      if (next === cells || !TRUNCATED.test(error instanceof Error ? error.message : String(error))) throw error;
      await rememberGrid(rootDir, key, next);
      cells = next;
    }
  }
  // Only a truncation writes a ceiling. Recording successes too would pin a model at whatever
  // default it first ran under and stop it ever trying the finer grid it can manage.
  if (layout) {
    // A sheet that repeats its frames, or barely moves between them, animates as a stutter or a
    // still image. Better to fail here than to hand over a broken animation.
    const frames = layout.columns * layout.rows;
    const distinct = await distinctFrames(output, layout);
    if (distinct * 2 < frames)
      throw new Error(`the model drew only ${distinct} different poses across ${frames} frames, so this would animate as a stutter rather than a cycle. Retry, or ask for fewer frames.`);
    const { motion, empty } = await frameMotion(output, layout);
    if (empty)
      throw new Error(`the model left ${empty} of ${frames} frames empty, so the sheet is unfinished. Retry, or use a model with more output room.`);
    if (motion < MIN_FRAME_MOTION)
      throw new Error(`the frames barely move — only ${motion.toFixed(1)}% of a frame changes between poses, so this would animate as a still image. Retry, or describe the motion in larger movements.`);
  }
  return { model: choice.model ? `${choice.provider}:${choice.model}` : choice.provider, svg };
}
