import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { detectSpriteGrid, type GridLayout } from "./animation.js";
import { readAppSettings } from "./app-settings.js";

/** A ComfyUI on this machine. No key, no billing, nothing leaves the box. */
export const COMFYUI_HOST = process.env.COMFYUI_HOST ?? "http://127.0.0.1:8188";
/** One frame is this many pixels square unless Settings raises it: SD 1.5 is slow and drifts more per frame the larger it draws. */
export const DEFAULT_FRAME_SIZE = 256;
export const FRAME_SIZES = [256, 384, 512] as const;

export async function readFrameSize(rootDir: string) {
  const saved = (await readAppSettings(rootDir)).comfyuiFrameSize;
  return FRAME_SIZES.find((size) => size === saved) ?? DEFAULT_FRAME_SIZE;
}

const POSITIVE = "16-bit pixel art sprite of the same character, limited color palette, hard pixel edges, dark outline, no anti-aliasing, retro platformer game sprite, full body, plain solid MATTE background";
const NEGATIVE = "photorealistic, 3d render, blurry, soft focus, detailed background, text, watermark, logo, multiple characters, cropped, out of frame, deformed, extra limbs, bad anatomy";

async function comfy(path: string, init: RequestInit = {}) {
  const response = await fetch(`${COMFYUI_HOST}${path}`, init);
  if (!response.ok) throw new Error(`ComfyUI ${path} failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
  return response;
}

/** What the server has for the sd15-openpose-game-asset workflow: its two models and the OpenPose node. */
export async function inspectComfyUI() {
  const info = async (node: string) => ((await (await comfy(`/object_info/${node}`, { signal: AbortSignal.timeout(10_000) })).json()) as Record<string, { input: { required: Record<string, [unknown]> } }>)[node];
  const [checkpoint, controlnet, openpose] = await Promise.all([
    info("CheckpointLoaderSimple"), info("ControlNetLoader"), info("OpenposePreprocessor").catch(() => undefined),
  ]);
  return {
    checkpoints: (checkpoint?.input.required.ckpt_name?.[0] as string[] | undefined) ?? [],
    controlnets: (controlnet?.input.required.control_net_name?.[0] as string[] | undefined) ?? [],
    hasOpenposeNode: Boolean(openpose),
  };
}

/** The workflow's own checkpoint when present, else any SD 1.5 one: SDXL checkpoints break the SD 1.5 ControlNet. */
export const pickCheckpoint = (names: string[]) =>
  names.find((name) => name.startsWith("dreamshaper_8")) ?? names.find((name) => !/xl/i.test(name));
export const pickControlnet = (names: string[]) => names.find((name) => /openpose/i.test(name) && /sd15|v11p/i.test(name));

const exists = (path: string) => access(path).then(() => true, () => false);

/**
 * Where a ComfyUI install lives, if one does: COMFYUI_DIR, then the usual spots. `root` is the
 * folder with main.py (its models/ is where downloads go); `start` is how to launch it. The API
 * host is still what the studio actually talks to.
 */
export async function findComfyDir() {
  const candidates = [process.env.COMFYUI_DIR, join(homedir(), "code/comfy"), join(homedir(), "comfy"), join(homedir(), "ComfyUI"), join(homedir(), "Documents/ComfyUI")];
  for (const dir of candidates) {
    if (!dir) continue;
    for (const root of [join(dir, "ComfyUI"), dir]) {
      if (!(await exists(join(root, "main.py")))) continue;
      const launcher = join(dir, "start-comfyui.command");
      return { root, start: (await exists(launcher)) ? launcher : `cd "${root}" && python main.py --listen 127.0.0.1 --port 8188` };
    }
  }
  return null;
}

export type Tuning = { size: number; steps: number; denoise: number; sampler: string; scheduler: string; strength: number; cfg: number };
/**
 * Tuned on a pixel-art walk sheet against the saved workflow's 512px / 16 steps / denoise 0.55 /
 * openpose 0.85, which took ~45s a frame and drew a different character in every one. Fewer
 * steps at 256px is ~5s a frame, and a low denoise with a light pose hint keeps each frame the
 * character it was given. Denoise is the restyle strength: raise it to change a sheet's look more.
 */
export const DEFAULT_TUNING: Tuning = { size: DEFAULT_FRAME_SIZE, steps: 8, denoise: 0.25, sampler: "dpmpp_2m", scheduler: "karras", strength: 0.6, cfg: 5.5 };

/**
 * The sd15-openpose-game-asset workflow in ComfyUI's API format (the saved file is the editor's
 * layout format, which /prompt won't take). Same nodes and wiring as that file: the source image
 * feeds both OpenPose and the img2img latent, so the pose and colours carry through.
 */
export function buildWorkflow(input: { image: string; checkpoint: string; controlnet: string; matte: "white" | "black"; seed: number; tuning?: Partial<Tuning>; prompt?: string }) {
  const t = { ...DEFAULT_TUNING, ...input.tuning };
  return {
    1: { class_type: "LoadImage", inputs: { image: input.image } },
    2: { class_type: "ImageScale", inputs: { image: ["1", 0], upscale_method: "nearest-exact", width: t.size, height: t.size, crop: "center" } },
    3: { class_type: "OpenposePreprocessor", inputs: { image: ["2", 0], detect_hand: "disable", detect_body: "enable", detect_face: "disable", resolution: t.size, scale_stick_for_xinsr_cn: "disable" } },
    4: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: input.checkpoint } },
    5: { class_type: "CLIPTextEncode", inputs: { clip: ["4", 1], text: (input.prompt ?? POSITIVE).replace("MATTE", input.matte) } },
    6: { class_type: "CLIPTextEncode", inputs: { clip: ["4", 1], text: NEGATIVE } },
    7: { class_type: "ControlNetLoader", inputs: { control_net_name: input.controlnet } },
    8: { class_type: "VAEEncode", inputs: { pixels: ["2", 0], vae: ["4", 2] } },
    9: { class_type: "ControlNetApplyAdvanced", inputs: { positive: ["5", 0], negative: ["6", 0], control_net: ["7", 0], image: ["3", 0], strength: t.strength, start_percent: 0, end_percent: 1 } },
    10: { class_type: "KSampler", inputs: { model: ["4", 0], positive: ["9", 0], negative: ["9", 1], latent_image: ["8", 0], seed: input.seed, steps: t.steps, cfg: t.cfg, sampler_name: t.sampler, scheduler: t.scheduler, denoise: t.denoise } },
    11: { class_type: "VAEDecode", inputs: { samples: ["10", 0], vae: ["4", 2] } },
    12: { class_type: "ImageScale", inputs: { image: ["11", 0], upscale_method: "nearest-exact", width: t.size, height: t.size, crop: "center" } },
    13: { class_type: "SaveImage", inputs: { images: ["12", 0], filename_prefix: "spritewright" } },
  };
}

/** Uploads one frame, runs the workflow on it, and waits for the picture. */
export async function drawFrame(frame: Buffer, workflow: (image: string) => object, name: string, signal: AbortSignal) {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(frame)], { type: "image/png" }), name);
  form.append("overwrite", "true");
  const uploaded = (await (await comfy("/upload/image", { method: "POST", body: form, signal })).json()) as { name: string };
  const queued = (await (await comfy("/prompt", {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ prompt: workflow(uploaded.name), client_id: "spritewright" }),
  })).json()) as { prompt_id: string };
  // ponytail: polling /history every 750ms; switch to the /ws socket if that ever shows up as load.
  for (;;) {
    signal.throwIfAborted();
    const entry = ((await (await comfy(`/history/${queued.prompt_id}`, { signal })).json()) as Record<string, {
      outputs: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
      status?: { status_str?: string; messages?: Array<[string, { exception_message?: string }]> };
    }>)[queued.prompt_id];
    if (entry?.status?.status_str === "error") {
      const failure = entry.status.messages?.find(([kind]) => kind === "execution_error")?.[1]?.exception_message;
      throw new Error(`ComfyUI could not draw the frame: ${failure ?? "execution error"}`);
    }
    const image = entry && Object.values(entry.outputs).flatMap((output) => output.images ?? [])[0];
    if (image) return Buffer.from(await (await comfy(`/view?${new URLSearchParams(image)}`, { signal })).arrayBuffer());
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
}

/** Cell rectangles of a sprite map, row by row; a plain image is one cell. */
export async function frameRects(path: string, sheet: boolean, layout: GridLayout | null) {
  if (!sheet) {
    const { width, height } = await sharp(path).metadata();
    return { rows: [[{ x: 0, y: 0, width: width!, height: height! }]] };
  }
  const grid = await detectSpriteGrid(path, layout);
  return {
    rows: grid.xCuts.map((cuts, row) => cuts.slice(0, -1).map((left, column) => ({
      x: left, y: grid.yCuts[row]!, width: cuts[column + 1]! - left, height: grid.yCuts[row + 1]! - grid.yCuts[row]!,
    }))),
  };
}

/**
 * One square box every frame is padded onto, so the whole sheet is scaled by a single factor.
 * Detected cells differ in width by over 10% — the outer columns carry the sheet's margins — and
 * squaring each cell on its own scaled each frame differently, so the character in a wide cell came
 * out visibly smaller than its neighbours: a sprite that changes size mid-walk.
 */
export const sharedBox = (rows: Array<Array<{ width: number; height: number }>>) =>
  Math.max(...rows.flat().map((rect) => Math.max(rect.width, rect.height)));

/**
 * Redraws every frame of `reference` through the workflow and lays the results out on the same
 * grid. The workflow follows the pose it is given, so this restyles a sheet's frames rather than
 * inventing new poses: the animation's movement comes from the source.
 * Frames sit on a flat matte, which the job removes afterwards like any other raster generator's.
 */
export async function runComfyUI(
  input: { reference: string; sheet: boolean; layout: GridLayout | null; matte: "white" | "black"; size: number },
  output: string,
  signal: AbortSignal,
) {
  let models: Awaited<ReturnType<typeof inspectComfyUI>>;
  try {
    models = await inspectComfyUI();
  } catch (error) {
    throw new Error(`ComfyUI isn't reachable at ${COMFYUI_HOST}. Start it, or see Settings → Image providers. ${error instanceof Error ? error.message : String(error)}`);
  }
  const checkpoint = pickCheckpoint(models.checkpoints);
  const controlnet = pickControlnet(models.controlnets);
  if (!models.hasOpenposeNode || !checkpoint || !controlnet)
    throw new Error("ComfyUI is missing something the sd15-openpose-game-asset workflow needs; Settings → Image providers lists what.");
  const { rows } = await frameRects(input.reference, input.sheet, input.layout);
  const columns = Math.max(...rows.map((row) => row.length));
  const background = input.matte === "white" ? { r: 255, g: 255, b: 255, alpha: 1 } : { r: 0, g: 0, b: 0, alpha: 1 };
  const seed = Math.floor(Math.random() * 2 ** 32); // one seed per sheet, so every frame is drawn in the same hand
  const workflow = (image: string) => buildWorkflow({ image, checkpoint, controlnet, matte: input.matte, seed, tuning: { size: input.size } });
  const drawn: sharp.OverlayOptions[] = [];
  signal.addEventListener("abort", () => void fetch(`${COMFYUI_HOST}/interrupt`, { method: "POST" }).catch(() => undefined), { once: true });
  const box = sharedBox(rows);
  for (const [row, cells] of rows.entries()) for (const [column, rect] of cells.entries()) {
    const cell = sharp(input.reference).extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height });
    // An empty cell stays empty: the model would otherwise invent a character for it.
    if ((await cell.clone().ensureAlpha().extractChannel(3).stats()).channels[0]!.max === 0) continue;
    // Padded (never rescaled) onto the shared box, then scaled once: the workflow needs a square,
    // and padding is what keeps every frame's character at one size.
    const left = Math.floor((box - rect.width) / 2);
    const top = Math.floor((box - rect.height) / 2);
    const frame = await cell.flatten({ background })
      .extend({ left, top, right: box - rect.width - left, bottom: box - rect.height - top, background })
      .resize(input.size, input.size, { kernel: "nearest" })
      .png().toBuffer();
    drawn.push({ input: await drawFrame(frame, workflow, `spritewright-${row}-${column}.png`, signal), left: column * input.size, top: row * input.size });
  }
  if (!drawn.length) throw new Error("The source image has no frames to redraw.");
  const sheet = await sharp({ create: { width: columns * input.size, height: rows.length * input.size, channels: 4, background } })
    .composite(drawn).png().toBuffer();
  // SD draws soft, blended edges even when asked for pixel art: measured against a pixel-art sheet,
  // only 41% of neighbouring pixels matched, against 71% in the source. Nearest-neighbour down to a
  // quarter scale and straight back up gives every pixel a hard 4×4 block. A quarter is an integer
  // factor at every offered frame size (64/96/128), which matters: a fractional one makes blocks of
  // uneven width, which is what fake pixel art looks like.
  // ponytail: fixed at a quarter; expose it in Settings if a sheet ever wants finer or coarser blocks.
  const grid = input.size / 4;
  const blocks = await sharp(sheet).resize({ width: columns * grid, height: rows.length * grid, kernel: "nearest" }).png().toBuffer();
  // A second .resize() in the same pipeline replaces the first instead of chaining, so this is its own.
  await sharp(blocks).resize({ width: columns * input.size, height: rows.length * input.size, kernel: "nearest" }).png().toFile(output);
}
