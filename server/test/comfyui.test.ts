import { expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkflow, pickCheckpoint, pickControlnet, readFrameSize, sharedBox } from "../comfyui.js";

test("every link in the API-format workflow points at a node that exists", () => {
  const graph = buildWorkflow({ image: "frame.png", checkpoint: "dreamshaper_8.safetensors", controlnet: "control_v11p_sd15_openpose_fp16.safetensors", matte: "black", seed: 7 });
  const ids = new Set(Object.keys(graph));
  for (const node of Object.values(graph))
    for (const value of Object.values(node.inputs))
      if (Array.isArray(value)) expect(ids.has(String(value[0]))).toBe(true);
  expect(graph[5].inputs.text).toContain("plain solid black background");
  expect(graph[10].inputs.seed).toBe(7);
});

test("picks the SD 1.5 models the workflow needs and ignores SDXL checkpoints", () => {
  expect(pickCheckpoint(["photopediaXL_45.safetensors", "dreamshaper_8.safetensors"])).toBe("dreamshaper_8.safetensors");
  expect(pickCheckpoint(["photopediaXL_45.safetensors", "other15.safetensors"])).toBe("other15.safetensors");
  expect(pickCheckpoint(["sdxl_base.safetensors"])).toBeUndefined();
  expect(pickControlnet(["control_v11p_sd15_canny.safetensors"])).toBeUndefined();
  expect(pickControlnet(["control_v11p_sd15_openpose_fp16.safetensors"])).toBe("control_v11p_sd15_openpose_fp16.safetensors");
});

const models = { image: "frame.png", checkpoint: "dreamshaper_8.safetensors", controlnet: "control_v11p_sd15_openpose_fp16.safetensors", matte: "white" as const, seed: 1 };

test("a frame is 256px unless the size is overridden, and the size reaches every scaling node", () => {
  const small = buildWorkflow(models);
  expect([small[2].inputs.width, small[3].inputs.resolution, small[12].inputs.width]).toEqual([256, 256, 256]);
  const large = buildWorkflow({ ...models, tuning: { size: 384 } });
  expect([large[2].inputs.height, large[3].inputs.resolution, large[12].inputs.height]).toEqual([384, 384, 384]);
});

test("one box covers every cell, so uneven cells can't scale frames differently", () => {
  // Real cuts from a 4×4 sheet: the outer columns carry the margins, so they are ~17% wider.
  const rows = [
    [{ width: 282, height: 267 }, { width: 241, height: 267 }, { width: 240, height: 267 }, { width: 261, height: 267 }],
    [{ width: 282, height: 247 }, { width: 241, height: 247 }, { width: 240, height: 247 }, { width: 261, height: 247 }],
  ];
  const box = sharedBox(rows);
  expect(box).toBe(282);
  // Every cell fits, so each is padded rather than resized, and one scale covers the sheet.
  for (const rect of rows.flat()) expect(Math.max(rect.width, rect.height)).toBeLessThanOrEqual(box);
  // The bug this replaced: squaring each cell on its own scaled frames 14% differently (the widest
  // cell is 282 across, the narrowest squares to 247), which was visible as a resizing character.
  const perCell = rows.flat().map((rect) => 256 / Math.max(rect.width, rect.height));
  expect(Math.max(...perCell) / Math.min(...perCell)).toBeCloseTo(1.14, 2);
});

test("the saved frame size is 256 by default and ignores sizes that aren't offered", async () => {
  const root = await mkdtemp(join(tmpdir(), "comfy-"));
  expect(await readFrameSize(root)).toBe(256);
  const { updateAppSettings } = await import("../app-settings.js");
  await updateAppSettings(root, { comfyuiFrameSize: 384 });
  expect(await readFrameSize(root)).toBe(384);
  await updateAppSettings(root, { comfyuiFrameSize: 999 });
  expect(await readFrameSize(root)).toBe(256);
});
